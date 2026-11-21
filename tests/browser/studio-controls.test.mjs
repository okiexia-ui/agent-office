import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {chromium} from 'playwright-core';
import {openAgentStudio} from '../../scripts/agent-studio.mjs';
import {startOfficeServer} from '../../scripts/dev.mjs';
import {localBucket} from '../../scripts/local-bucket.mjs';
import {callTool} from '../../worker/index.js';

test(
  'studio controls manage model discovery, keys, agent runtime and unused connections',
  {timeout: 45000},
  async t => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-controls-'));
    let localAvailable = true;
    const env = {BUCKET: await localBucket(stateDir), OFFICE_LOCAL: true, PI_OFFICE: true};
    const register = (id, name, role, model) =>
      callTool('office_register_agent', {agent_id: id, name, role, model}, env);
    await register('pi-local', 'Pi（本机）', '本机编程', 'Pi');
    await register('claude-external', 'Claude', '外部编程', 'Claude');
    let server;
    const studio = await openAgentStudio({
      dir: path.join(stateDir, 'studio'),
      localAvailable: () => localAvailable,
      startAgent: async (agent, connection) => {
        await server.setAgentEnabled(agent.id, true);
        await register(agent.id, agent.name, agent.role, connection ? 'API' : 'Pi');
        return async () => {};
      },
      updateMember: (id, profile) => server.setMemberProfile(id, profile),
      markOffline: id => server.setAgentEnabled(id, false)
    });
    const providerRequests = [];
    const provider = http.createServer((req, res) => {
      providerRequests.push({path: req.url, auth: req.headers.authorization});
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(
        JSON.stringify(
          req.method === 'POST'
            ? {choices: [{message: {content: 'OK'}}]}
            : {data: [{id: 'fixture-small'}, {id: 'fixture-medium'}]}
        )
      );
    });
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    const baseUrl = 'http://127.0.0.1:' + provider.address().port + '/v1';
    server = await startOfficeServer({
      stateDir,
      env: {OFFICE_PORT: '0', OFFICE_PI_LOCAL: '1'},
      studioFetch: studio.fetch
    });
    let browser;
    t.after(async () => {
      await browser?.close();
      await server.close();
      await studio.close();
      provider.closeAllConnections();
      await new Promise(resolve => provider.close(resolve));
      await fs.rm(stateDir, {recursive: true, force: true});
    });
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
      args: ['--enable-unsafe-swiftshader']
    });
    const page = await browser.newPage({viewport: {width: 390, height: 810}});
    page.setDefaultTimeout(5000);
    const field = id => page.locator('#studio-' + id);
    const catalog = async () => (await page.request.get(server.url + '/api/studio')).json();
    async function editMember(id) {
      await page.goto(server.url + '/?agent=' + id);
      await page.locator('#tab-settings').click();
      await field('agent-name').waitFor({state: 'visible'});
      await page.waitForFunction(() => !document.querySelector('#studio-controls')?.disabled);
    }
    const saved = text =>
      page.waitForFunction(value => document.querySelector('#studio-feedback')?.textContent.includes(value), text);
    await page.goto(server.url + '/?studio=1');
    await field('agent-name').fill('编辑');
    await field('agent-role').fill('版本文案');
    await field('add-connection').click();
    await field('provider').selectOption('custom');
    await field('connection-name').fill('开发模型');
    await field('base-url').fill(baseUrl);
    await field('api-key').fill('local-fixture-key');
    await field('fetch-models').click();
    await field('model-list').selectOption('fixture-medium');
    assert.equal(await field('model').inputValue(), 'fixture-medium');
    await field('model').fill('manual-model');
    await field('save-connection').click();
    await saved('连接已保存');
    assert.equal(await field('api-key').inputValue(), '');
    const [connection] = (await catalog()).connections;
    assert.equal(connection.model, 'manual-model');
    assert.equal(connection.hasKey, true);
    assert.equal(await field('agent-name').inputValue(), '编辑');
    assert.equal(await field('agent-connection').inputValue(), connection.id);
    assert.deepEqual(providerRequests, [{path: '/v1/models', auth: 'Bearer local-fixture-key'}]);

    await field('edit-connection').click();
    await field('fetch-models').click();
    await field('model-list-label').waitFor();
    assert.deepEqual(providerRequests[1], providerRequests[0]);
    await field('test-connection').click();
    await saved('连接成功');
    await field('clear-key').check();
    await field('save-connection').click();
    await saved('连接已保存');
    assert.equal((await catalog()).connections[0].hasKey, false);
    await field('edit-connection').click();
    await field('fetch-models').click();
    await field('model-list-label').waitFor();
    assert.equal(providerRequests.at(-1).auth, undefined);
    await field('remove-connection').click();
    await field('cancel-remove').click();
    assert.equal((await catalog()).connections.length, 1);
    await field('close-connection').click();
    await field('save-agent').click();
    await page.getByRole('heading', {name: '编辑', exact: true}).waitFor();
    const [agent] = (await catalog()).agents;
    assert.equal(agent.connectionId, connection.id);
    await editMember(agent.id);
    await field('agent-name').fill('编辑的未保存草稿');
    await field('toggle-agent').click();
    await saved('成员已停用');
    assert.equal((await catalog()).agents[0].enabled, false);
    assert.equal(await field('agent-name').inputValue(), '编辑的未保存草稿');
    await field('edit-connection').click();
    assert.ok(await field('remove-connection').isDisabled());
    await field('close-connection').click();
    await field('agent-connection').selectOption('local');
    await field('save-agent').click();
    await saved('已保存设置');
    assert.equal((await catalog()).agents[0].connectionId, 'local');
    await field('toggle-agent').click();
    await saved('成员已启用');
    assert.equal((await catalog()).agents[0].enabled, true);
    // An offline Pi remains the saved model when an API connection is removed.
    localAvailable = false;
    await editMember(agent.id);
    assert.equal(await field('agent-connection').inputValue(), 'local');
    assert.ok(await field('save-agent').isDisabled());
    await field('agent-connection').selectOption(connection.id);
    await field('edit-connection').click();
    await field('remove-connection').click();
    await field('confirm-remove').click();
    await saved('连接已移除');
    assert.equal((await catalog()).connections.length, 0);
    assert.equal((await catalog()).agents[0].connectionId, 'local');

    await editMember('pi-local');
    await field('agent-name').fill('本机伙伴');
    await field('agent-role').fill('写代码');
    await field('agent-instructions').fill('先执行测试。');
    await field('save-agent').click();
    await saved('已保存设置');
    assert.equal((await catalog()).builtin.instructions, '先执行测试。');
    await editMember('pi-local');
    assert.equal(await field('agent-name').inputValue(), '本机伙伴');
    await editMember('claude-external');
    assert.equal(await field('agent-instructions').isVisible(), false);
    assert.equal(await field('agent-connection').isVisible(), false);
    await field('agent-name').fill('代码审校');
    await field('office-notes').fill('在回复中列出复现步骤。');
    await field('seat').selectOption('desk-16');
    await field('color').fill('#123456');
    await field('enabled').uncheck();
    await field('save-agent').click();
    await saved('已保存设置');
    await editMember('claude-external');
    assert.equal(await field('agent-name').inputValue(), '代码审校');
    assert.equal(await field('color').inputValue(), '#123456');
    assert.equal(await field('seat').inputValue(), 'desk-16');
    assert.equal(await field('enabled').isChecked(), false);
    await field('enabled').check();
    await field('save-agent').click();
    await saved('已保存设置');
    assert.equal(
      (await (await page.request.get(server.url + '/api/state')).json()).agents.find(a => a.id === 'claude-external')
        .managedDisabled,
      undefined
    );
    assert.ok(
      await page.locator('#member-settings').evaluate(el => el.scrollWidth <= el.clientWidth),
      'mobile settings fit the panel'
    );
  }
);
