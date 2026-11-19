import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright-core';
import {startOfficeServer} from '../../scripts/dev.mjs';
import {localBucket} from '../../scripts/local-bucket.mjs';
import {callTool} from '../../worker/index.js';

test('workspace downloads a saved HTML visual that still runs inside an isolated frame on disk', async t => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'office-download-'));
  const server = await startOfficeServer({stateDir, env: {OFFICE_PORT: '0'}});
  let browser;
  t.after(async () => {
    await browser?.close();
    await server.close();
    await fs.rm(stateDir, {recursive: true, force: true});
  });
  const env = {BUCKET: await localBucket(stateDir), OFFICE_LOCAL: true};
  const {visual} = await callTool(
    'office_publish_visual',
    {
      agent_id: 'hermes',
      request_id: 'example',
      title: '交互计数',
      kind: 'html',
      content: '<button id="count" onclick="this.textContent=2">1</button>'
    },
    env
  );
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
    args: ['--enable-unsafe-swiftshader']
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(6000);
  await page.goto(server.url + '/?visual=' + visual.id);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', {name: '下载交互 HTML'}).click()
  ]);
  assert.equal(download.suggestedFilename(), '交互计数.html');
  const file = path.join(stateDir, download.suggestedFilename());
  await download.saveAs(file);
  await page.goto(pathToFileURL(file).href);
  assert.equal(await page.locator('iframe').getAttribute('sandbox'), 'allow-scripts');
  const frame = page.frameLocator('iframe');
  assert.match(await frame.locator('meta[http-equiv]').getAttribute('content'), /connect-src 'none'/);
  const button = frame.locator('#count');
  await button.click();
  assert.equal(await button.textContent(), '2');
});
