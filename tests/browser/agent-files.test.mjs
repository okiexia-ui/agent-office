import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {startOfficeServer} from '../../scripts/dev.mjs';
import {localBucket} from '../../scripts/local-bucket.mjs';
import {createPiFiles} from '../../scripts/pi-files.mjs';
import {callTool} from '../../worker/index.js';

test('a Pi member can receive and return files in a nested folder from its private chat', {timeout: 45000}, async t => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'office-files-ui-'));
  const id = 'pi-local';
  const files = createPiFiles(stateDir, agentId => agentId === id);
  const env = {BUCKET: await localBucket(stateDir), OFFICE_LOCAL: true, PI_OFFICE: true};
  await callTool('office_register_agent', {agent_id: id, name: '文档编辑', model: 'Pi'}, env);
  await callTool('office_register_agent', {agent_id: 'api-editor', name: '云端编辑', model: 'API'}, env);
  await callTool('office_register_agent', {agent_id: 'external-pi', name: '外部 Pi', model: 'Pi'}, env);
  const folder = path.join(await files.rootFor(id), '本周草稿');
  await fs.mkdir(folder);
  const moved = path.join(await files.rootFor(id), '过期目录');
  await fs.mkdir(moved);
  const server = await startOfficeServer({
    stateDir,
    env: {OFFICE_PORT: '0', OFFICE_PI_LOCAL: '1'},
    memberFiles: files
  });
  let browser;
  t.after(async () => {
    await browser?.close();
    await server.close();
    await fs.rm(stateDir, {recursive: true, force: true});
  });
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
    args: ['--enable-unsafe-swiftshader']
  });
  const page = await browser.newPage({viewport: {width: 390, height: 810}});
  // Same limit as the other browser tests. The first page of a CI run also starts Chrome and
  // the 3D scene cold, so its first wait gets longer.
  page.setDefaultTimeout(12000);
  await page.goto(server.url);
  const trigger = page.locator('#open-agent-files');
  const pi = page.locator('[data-agent="' + id + '"]');
  await pi.waitFor({timeout: 20000});
  assert.ok(await trigger.isHidden());
  await pi.click();
  await trigger.click();
  const stale = page.getByRole('button', {name: '打开目录 过期目录'});
  await stale.waitFor();
  await fs.rename(moved, moved + '已归档');
  await stale.click();
  await page.getByText('文件或目录不存在。').waitFor();
  assert.equal(await page.locator('#files-folder').textContent(), '根目录');
  await page.getByRole('button', {name: '打开目录 本周草稿'}).click();
  await page.getByText('当前目录为空。').waitFor();
  const input = page.locator('#files-input');
  const name = '复核 & 说明.txt';
  const payload = {name, mimeType: 'text/plain', buffer: Buffer.from('行一\n第二行\n')};
  await input.setInputFiles(payload);
  await page.getByText('已上传「' + name + '」。').waitFor();
  await input.setInputFiles({...payload, buffer: Buffer.from('重传不能覆盖')});
  await page.getByText('已存在同名文件。请改名后再上传。').waitFor();
  assert.deepEqual(await fs.readFile(path.join(folder, name)), payload.buffer);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', {name: '下载 ' + name}).click()
  ]);
  assert.equal(download.suggestedFilename(), name);
  assert.deepEqual(await fs.readFile(await download.path()), payload.buffer);
  await page.locator('.files-prompts summary').click();
  await page.getByRole('button', {name: '创建 Word 文档'}).click();
  assert.match(await page.locator('#composer-input').inputValue(), /本周草稿\/会议纪要\.docx/);
  assert.ok(await page.locator('#agent-files').isHidden());
  await trigger.click();
  await page.getByRole('button', {name: '打开目录 本周草稿'}).click();
  await page.getByRole('button', {name: '下载 ' + name}).waitFor();
  await page.getByRole('button', {name: '返回上一级目录'}).click();
  await page.getByRole('button', {name: '打开目录 本周草稿'}).waitFor();
  assert.ok(await page.locator('#files-parent').isDisabled());
  await page.getByRole('button', {name: '返回成员对话'}).click();
  await page.locator('[data-agent="api-editor"]').click();
  await trigger.click();
  await page.locator('#files-capability').waitFor();
  assert.ok(await page.locator('#files-upload').isHidden());
  assert.equal((await page.request.get(server.url + '/api/studio/files/api-editor')).status(), 404);
  await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/api/sync?scope=external-pi') && response.ok()),
    page.locator('[data-agent="external-pi"]').click()
  ]);
  await trigger.click();
  await page.locator('#files-capability').waitFor();
  assert.ok(await page.locator('#files-upload').isHidden());
  await page.route('**/api/local-mode', route => route.fulfill({json: {mode: 'local', fileTools: false}}));
  await page.goto(server.url + '/?agent=' + id);
  await page.getByRole('heading', {level: 1, name: '文档编辑'}).waitFor();
  await trigger.click();
  await page.locator('#files-capability').waitFor();
  assert.ok(await page.locator('#files-upload').isHidden());
});
