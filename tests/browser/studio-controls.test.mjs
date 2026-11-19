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

test(
  'studio controls manage model discovery, keys, agent runtime and unused connections',
  {timeout: 45000},
  async t => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-controls-'));
    const studio = await openAgentStudio({
      dir: path.join(stateDir, 'studio'),
      localAvailable: () => true,
      startAgent: async () => async () => {}
    });
    const providerRequests = [];
    const provider = http.createServer((req, res) => {
      providerRequests.push({path: req.url, auth: req.headers.authorization});
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({data: [{id: 'fixture-small'}, {id: 'fixture-medium'}]}));
    });
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    const baseUrl = 'http://127.0.0.1:' + provider.address().port + '/v1';
    const server = await startOfficeServer({stateDir, env: {OFFICE_PORT: '0'}, studioFetch: studio.fetch});
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
    await page.goto(server.url + '/?studio=1');
    await field('connections').click();
    await field('provider').selectOption('custom');
    await field('connection-name').fill('开发模型');
    await field('base-url').fill(baseUrl);
    await field('api-key').fill('local-fixture-key');
    await field('fetch-models').click();
    await field('model-list').selectOption('fixture-medium');
    assert.equal(await field('model').inputValue(), 'fixture-medium');
    await field('model').fill('manual-model');
    await field('save-connection').click();
    await field('use-connection').waitFor();
    assert.equal(await field('api-key').inputValue(), '');
    const [connection] = (await catalog()).connections;
    assert.equal(connection.model, 'manual-model');
    assert.equal(connection.hasKey, true);
    assert.deepEqual(providerRequests, [{path: '/v1/models', auth: 'Bearer local-fixture-key'}]);

    await field('fetch-models').click();
    await field('model-list-label').waitFor();
    assert.deepEqual(providerRequests[1], providerRequests[0]);
    await field('clear-key').check();
    await field('save-connection').click();
    await field('clear-key-label').waitFor({state: 'hidden'});
    assert.equal((await catalog()).connections[0].hasKey, false);
    await field('fetch-models').click();
    await field('model-list-label').waitFor();
    assert.equal(providerRequests.at(-1).auth, undefined);
    await field('remove-connection').click();
    await field('cancel-remove').click();
    assert.equal((await catalog()).connections.length, 1);

    // Seed the saved profile using the HTTP management route; all later runtime
    // and profile changes use the browser controls with the real studio backend.
    const {agent} = await (
      await page.request.post(server.url + '/api/studio/agents', {
        data: {name: '编辑', role: '版本文案', instructions: '使用中文', connectionId: connection.id}
      })
    ).json();
    await field('close').click();
    await page.locator('#connect-button').click();
    await field('agent-id').selectOption(agent.id);
    await field('agent-name').fill('编辑的未保存草稿');
    await field('toggle-agent').click();
    await page.waitForFunction(() => document.querySelector('#studio-agent-status').textContent.includes('已停用'));
    assert.equal((await catalog()).agents[0].enabled, false);
    assert.equal(await field('agent-name').inputValue(), '编辑的未保存草稿');
    await field('connections').click();
    await field('connection-id').selectOption(connection.id);
    assert.ok(await field('remove-connection').isDisabled());
    await field('profiles').click();
    await field('agent-connection').selectOption('local');
    await field('save-agent').click();
    await page.waitForFunction(() => document.querySelector('#studio-feedback').textContent.includes('已保存设置'));
    assert.equal((await catalog()).agents[0].connectionId, 'local');
    await field('toggle-agent').click();
    await page.waitForFunction(() => document.querySelector('#studio-agent-status').textContent.includes('运行中'));
    assert.equal((await catalog()).agents[0].enabled, true);
    await field('connections').click();
    await field('remove-connection').click();
    await field('confirm-remove').click();
    await page.waitForFunction(() => document.querySelector('#studio-feedback').textContent.includes('连接已移除'));
    assert.equal((await catalog()).connections.length, 0);
    const fits = await page.locator('#agent-studio').evaluate(el => el.scrollWidth <= el.clientWidth);
    assert.ok(fits, 'mobile dialog should not scroll horizontally');
  }
);
