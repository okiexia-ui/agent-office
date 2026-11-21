import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import {chromium} from 'playwright-core';
import {localBucket} from '../../scripts/local-bucket.mjs';
import {startOfficeServer} from '../../scripts/dev.mjs';
import {callTool} from '../../worker/index.js';

test(
  'office home links the actual scene, activity, member panel and gallery on desktop and phone',
  {timeout: 50000},
  async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unified-office-ui-'));
    const env = {BUCKET: await localBucket(dir), OFFICE_LOCAL: true, PI_OFFICE: true};
    const pi = 'pi-local';
    for (const [id, name, model] of [
      [pi, 'Pi（本机）', 'Pi'],
      ['review', '代码审校', 'Claude'],
      ['writer', '产品编辑', 'API']
    ])
      await callTool('office_register_agent', {agent_id: id, name, model}, env);
    await callTool(
      'office_publish_visual',
      {
        agent_id: 'writer',
        request_id: 'launch-note',
        title: '新版验收清单',
        kind: 'document',
        content: '检查项目变更，然后运行测试。'
      },
      env
    );
    await callTool(
      'office_post_channel_message',
      {agent_id: 'writer', request_id: 'handoff', content: '验收清单已经交付。点下面的文档，可以查看需要核对的项目。'},
      env
    );
    const progress = {step: 2, operation: 'edit', path: 'navigation.js'};
    const projects = {
      fetch: () =>
        Response.json({
          sessions: [
            {
              id: 'fixture-task',
              agentId: pi,
              title: '整理导航入口',
              projectPath: '/project/office-web',
              status: 'running',
              progress
            }
          ]
        })
    };
    const server = await startOfficeServer({
      stateDir: dir,
      env: {OFFICE_PORT: '0', OFFICE_PI_LOCAL: '1'},
      studioFetch: () => Response.json({agents: [], connections: []}),
      projects
    });
    let browser;
    t.after(async () => {
      await browser?.close();
      await server.close();
      await fs.rm(dir, {recursive: true, force: true});
    });
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
      args: ['--enable-unsafe-swiftshader']
    });
    const page = await browser.newPage({viewport: {width: 1140, height: 740}});
    page.setDefaultTimeout(12000);
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    await page.goto(server.url + '/office.html?view=office');
    await page.getByRole('heading', {name: '办公室群聊'}).waitFor();
    assert.equal(new URL(page.url()).pathname, '/');
    assert.equal(new URL(page.url()).searchParams.has('view'), false);
    const room = page.frameLocator('#office-frame');
    const badge = room.getByRole('button', {name: /与 Pi（本机） 聊天，office-web · 第 2 步 · 编辑/});
    await badge.waitFor();
    const stage = await page.locator('#office-frame').boundingBox();
    assert.ok(stage.width > 1140 * 0.6 && stage.height > 740 * 0.55, JSON.stringify(stage));
    await page.locator('#visual-picker button').filter({hasText: '新版验收清单'}).waitFor();
    if (process.env.OFFICE_DOCS_SCREENSHOT)
      await page.screenshot({path: process.env.OFFICE_DOCS_SCREENSHOT, type: 'jpeg', quality: 86});
    await badge.click();
    await page.getByRole('heading', {name: 'Pi（本机）', exact: true}).waitFor();
    await page.getByRole('tab', {name: '文件', exact: true}).click();
    await page.getByRole('heading', {name: '已交付成果'}).waitFor();
    await page.locator('#visual-picker button').filter({hasText: '新版验收清单'}).click();
    await page.locator('.artifact h3').filter({hasText: '新版验收清单'}).waitFor();
    await page.locator('#expand-results').click();
    await page.locator('#group-chat').click();
    await page.setViewportSize({width: 390, height: 800});
    const mobileStage = await page.locator('#office-frame').boundingBox();
    assert.ok(mobileStage.height > 90 && mobileStage.height < 260);
    const chat = await page.locator('#composer-input').boundingBox();
    assert.ok(chat.y + chat.height <= 800, JSON.stringify(chat));
    await page.locator('#visual-picker button').filter({hasText: '新版验收清单'}).click();
    await page.locator('#close-visual').click();
    await page.locator('#composer-input').waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
  }
);

test('a new office explains an offline Pi instead of asking for a first member', {timeout: 30000}, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unified-office-first-run-'));
  const builtin = {
    id: 'pi-local',
    kind: 'builtin',
    name: 'Pi（本机）',
    role: '本机 Pi 助手',
    instructions: '',
    enabled: true,
    connectionId: 'local',
    status: 'offline',
    local: {state: 'off'}
  };
  const server = await startOfficeServer({
    stateDir: dir,
    env: {OFFICE_PORT: '0', OFFICE_PI_LOCAL: '1'},
    studioFetch: () => Response.json({agents: [], connections: [], builtin})
  });
  let browser;
  t.after(async () => {
    await browser?.close();
    await server.close();
    await fs.rm(dir, {recursive: true, force: true});
  });
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
    args: ['--enable-unsafe-swiftshader']
  });
  const page = await browser.newPage({viewport: {width: 1140, height: 740}});
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  await page.goto(server.url + '/');
  // Pi has a profile but no model: every count agrees, and the group asks for a member that can reply.
  await page.getByRole('heading', {name: '还没有成员在线'}).waitFor();
  assert.equal(await page.locator('#office-presence').textContent(), '0 / 1 在线');
  assert.equal(await page.locator('#group-summary').textContent(), '1 位伙伴');
  assert.match(await page.locator('#conversations').textContent(), /未配置本机模型/);
  assert.match(await page.locator('#message-log').textContent(), /Ollama、LM Studio/);
  await page.locator('[data-agent="pi-local"]').click();
  await page.getByRole('heading', {name: 'Pi（本机）还没有本机模型'}).waitFor();
  assert.equal(await page.getByRole('heading', {name: '先请来第一位成员'}).count(), 0);
  assert.match(await page.getByRole('link', {name: /查看配置说明/}).getAttribute('href'), /docs\/LOCAL-PI\.md/);
  assert.match(await page.locator('#connection-note').textContent(), /配置好之前它不会回复/);
  await page.getByRole('button', {name: /在设置里配置本机模型/}).click();
  await page.getByRole('tab', {name: '设置', exact: true, selected: true}).waitFor();
  assert.deepEqual(errors, []);
});

test('the chat shows who is writing a reply, and only to messages still waiting', {timeout: 30000}, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unified-office-typing-'));
  const env = {BUCKET: await localBucket(dir), OFFICE_LOCAL: true, PI_OFFICE: true};
  await callTool('office_register_agent', {agent_id: 'writer', name: '产品编辑', model: 'API'}, env);
  await callTool('office_register_agent', {agent_id: 'review', name: '代码审校', model: 'Claude'}, env);
  const server = await startOfficeServer({
    stateDir: dir,
    env: {OFFICE_PORT: '0', OFFICE_PI_LOCAL: '1'},
    studioFetch: () => Response.json({agents: [], connections: []})
  });
  let browser;
  t.after(async () => {
    await browser?.close();
    await server.close();
    await fs.rm(dir, {recursive: true, force: true});
  });
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
    args: ['--enable-unsafe-swiftshader']
  });
  const page = await browser.newPage({viewport: {width: 1140, height: 740}});
  page.setDefaultTimeout(12000);
  await page.goto(server.url + '/?agent=writer');
  await page.getByRole('heading', {name: '产品编辑', exact: true}).waitFor();
  await page.locator('#composer-input').fill('帮我起个标题');
  await page.locator('#composer-input').press('Enter');
  await page.locator('.message.user').filter({hasText: '帮我起个标题'}).waitFor();
  // The office state the 3D scene already uses: a member reports "thinking" while it answers.
  const office = (tool, args) =>
    fetch(server.url + '/mcp', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Accept: 'application/json'},
      body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: tool, arguments: args}})
    });
  await office('office_heartbeat', {agent_id: 'review', status: 'thinking'});
  await office('office_heartbeat', {agent_id: 'writer', status: 'thinking'});
  const typing = page.locator('.typing-row');
  await typing.filter({hasText: '产品编辑 正在回复…'}).waitFor();
  assert.doesNotMatch(await typing.textContent(), /代码审校/, 'only the member of this chat');
  await office('office_heartbeat', {agent_id: 'writer', status: 'resting'});
  await typing.waitFor({state: 'detached'});
});
