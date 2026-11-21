import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {access, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {json} from 'node:stream/consumers';
import {setTimeout as wait} from 'node:timers/promises';
import test from 'node:test';
import {chromium} from 'playwright-core';

const repo = path.resolve(import.meta.dirname, '../..');
const pi = path.join(repo, '.office-local/pi-runtime/node_modules/.bin/pi');
const modelId = 'project-test-model';
const prompt = '把 greet.cjs 里的 Hello 改成 Welcome，保留其他内容。';
const answer = 'greet.cjs 的问候语已更新。';

function stream(res, delta, reason = 'stop') {
  const chunk = (delta, finish_reason) =>
    'data: ' +
    JSON.stringify({
      id: 'turn-fixture',
      object: 'chat.completion.chunk',
      model: modelId,
      choices: [{index: 0, delta, finish_reason}]
    }) +
    '\n\n';
  res.writeHead(200, {'content-type': 'text/event-stream'});
  res.end(chunk({role: 'assistant'}, null) + chunk(delta, null) + chunk({}, reason) + 'data: [DONE]\n\n');
}

test(
  'local project task edits a real file through Pi, shows the patch, tests it, and resumes after reload',
  {timeout: 90000},
  async t => {
    if (
      !(await access(pi).then(
        () => true,
        () => false
      ))
    ) {
      t.skip('requires the optional bundled Pi runtime');
      return;
    }
    const fixture = await mkdtemp(path.join(os.tmpdir(), 'office-project-ui-'));
    const project = path.join(fixture, 'demo');
    const requests = [];
    const model = http.createServer(async (req, res) => {
      if (req.url === '/v1/models')
        return res.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify({data: [{id: modelId}]}));
      if (req.url !== '/v1/chat/completions') return res.writeHead(404).end();
      const body = await json(req);
      requests.push(body);
      const last = body.messages.at(-1);
      if (last.role === 'tool') return stream(res, {content: answer});
      const input = JSON.stringify(last.content);
      if (input.includes('暂停这个测试请求')) {
        // Hold this request open until Pi is cancelled.
        res.writeHead(200, {'content-type': 'text/event-stream'}).flushHeaders();
        return;
      }
      if (input.includes('上一轮改了什么')) return stream(res, {content: '上一轮修改了 greet.cjs。'});
      return stream(
        res,
        {
          tool_calls: [
            {
              index: 0,
              id: 'call_edit',
              type: 'function',
              function: {
                name: 'office_project',
                arguments: JSON.stringify({operation: 'edit', path: 'greet.cjs', oldText: 'Hello', newText: 'Welcome'})
              }
            }
          ]
        },
        'tool_calls'
      );
    });
    let service, browser;
    t.after(async () => {
      try {
        await browser?.close();
        if (service?.exitCode === null && !service.signalCode) {
          const exit = once(service, 'exit');
          service.kill('SIGTERM');
          await exit;
        }
      } finally {
        model.closeAllConnections();
        if (model.listening) await new Promise(resolve => model.close(resolve));
        await rm(fixture, {recursive: true, force: true});
      }
    });
    await mkdir(project);
    await writeFile(path.join(project, 'greet.cjs'), "// My unsaved-to-git work\nconsole.log('Hello');\n");
    await writeFile(
      path.join(project, 'verify.cjs'),
      [
        "require('./greet.cjs');",
        "const timer = setInterval(() => { if (require('node:fs').existsSync('finish-test')) clearInterval(timer); }, 50);",
        'setTimeout(() => { clearInterval(timer); process.exitCode = 1; }, 12000).unref();'
      ].join('\n')
    );
    await writeFile(path.join(project, 'package.json'), JSON.stringify({scripts: {test: 'node verify.cjs'}}));
    model.listen(0, '127.0.0.1');
    await once(model, 'listening');
    service = spawn(process.execPath, ['scripts/local.mjs'], {
      cwd: repo,
      env: {
        PATH: process.env.PATH,
        HOME: fixture,
        OFFICE_DATA_DIR: path.join(fixture, 'office'),
        OFFICE_PORT: '0',
        OFFICE_PI_BIN: pi,
        OFFICE_MODEL_URL: 'http://127.0.0.1:' + model.address().port + '/v1',
        OFFICE_MODEL_ID: modelId
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = '';
    service.stdout.on('data', data => {
      log += data;
    });
    service.stderr.on('data', data => {
      log += data;
    });
    for (let n = 0; n < 240 && !log.includes('可以在本地工作台创建 Agent'); n++) {
      assert.equal(service.exitCode, null, log);
      await wait(50);
    }
    assert.match(log, /可以在本地工作台创建 Agent/);
    const origin = log.match(/本机工作台 (http:\/\/127\.0\.0\.1:\d+)/)[1];
    browser = await chromium.launch({executablePath: process.env.CHROMIUM_EXECUTABLE_PATH});
    const page = await browser.newPage({viewport: {width: 1240, height: 840}});
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.locator('[data-agent="pi-local"]').first().click();
    await page.locator('#open-project-task').click();
    await page.locator('#tb-folder').click();
    await page.locator('#tb-path').fill(project);
    await page.locator('#tb-confirm-path').click();
    await page.locator('#tb-prompt').fill(prompt);
    await page.locator('#tb-send').click();
    await page.getByText(answer, {exact: true}).waitFor();
    const file = page.locator('.tb-file');
    await file.locator('summary').click();
    const patch = await file.locator('.tb-diff').innerText();
    assert.match(patch, /-console.log\('Hello'\)/);
    assert.match(patch, /\+console.log\('Welcome'\)/);
    assert.equal(
      await readFile(path.join(project, 'greet.cjs'), 'utf8'),
      "// My unsaved-to-git work\nconsole.log('Welcome');\n"
    );
    assert.deepEqual(
      requests[0].tools.map(tool => tool.function.name),
      ['office_project']
    );
    await page.getByRole('button', {name: '运行 npm test', exact: true}).click();
    await page.getByRole('button', {name: '停止测试', exact: true}).waitFor();
    const activity = await (
      await fetch(origin + '/api/local/activity', {headers: {'X-Agent-Office-Control': '1'}})
    ).json();
    assert.equal(activity.sessions, 1, 'the native quit check must include the running npm test');
    await writeFile(path.join(project, 'finish-test'), 'done');
    await page.getByText('测试通过', {exact: true}).waitFor();
    assert.match(await page.locator('#tb-checks pre').innerText(), /Welcome/);
    await page.reload();
    await page.getByText(answer, {exact: true}).waitFor();
    await page.locator('#tb-prompt').fill('上一轮改了什么？');
    await page.locator('#tb-send').click();
    await page.getByText('上一轮修改了 greet.cjs。', {exact: true}).waitFor();
    assert.ok(JSON.stringify(requests.at(-1).messages).includes(answer));
    await page.locator('#tb-prompt').fill('暂停这个测试请求');
    await page.locator('#tb-send').click();
    await page.locator('#tb-stop').click();
    await page.locator('.tb-state[data-state="stopped"]').waitFor();
    await page.getByRole('button', {name: '重新运行'}).waitFor();
    await page.setViewportSize({width: 390, height: 780});
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    assert.deepEqual(errors, []);
  }
);
