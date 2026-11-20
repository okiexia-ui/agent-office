import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {createPiComputer} from '../../scripts/pi-computer.mjs';

test('Pi operates a workspace HTML form in a fresh browser and saves the observed page as PNG', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-computer-'));
  const root = path.join(dir, 'workspace');
  await fs.mkdir(root);
  await fs.writeFile(
    path.join(root, '表单.html'),
    `<!doctype html><meta charset="utf-8">
    <label>项目 <input></label>
    <label>类型 <select><option>文档</option><option>表格</option></select></label>
    <button>保存</button><p id="result">草稿</p><script src="form.js"></script>
    <canvas style="position:fixed;left:400px;top:300px;width:80px;height:80px"
      onclick="document.querySelector('#result').textContent='已选画布'"></canvas>`
  );
  await fs.writeFile(
    path.join(root, 'form.js'),
    "document.querySelector('button').onclick=()=>document.querySelector('#result').textContent=document.querySelector('input').value+' · '+document.querySelector('select').value"
  );
  const computer = createPiComputer({root});
  t.after(async () => {
    await computer.close();
    await fs.rm(dir, {recursive: true, force: true});
  });
  const readRef = (snapshot, label) => {
    const line = snapshot.text.split('\n').find(line => line.includes(label));
    assert.ok(line, label + ' missing from snapshot: ' + snapshot.text);
    const match = /\[ref=(\w+)\]/.exec(line);
    assert.ok(match, 'no ref for ' + label);
    return match[1];
  };
  await assert.rejects(computer.run({action: 'snapshot'}), /open/);
  await assert.rejects(computer.run({action: 'open', path: 'http://localhost/index.html'}), /允许/);
  let view = await computer.run({action: 'open', path: '表单.html'});
  view = await computer.run({action: 'fill', ref: readRef(view, 'textbox "项目"'), text: '版本说明'});
  view = await computer.run({action: 'select', ref: readRef(view, 'combobox "类型"'), text: '表格'});
  view = await computer.run({action: 'click', ref: readRef(view, 'button "保存"')});
  assert.match(view.text, /版本说明 · 表格/);
  await computer.run({action: 'press', key: 'Tab'});
  assert.match((await computer.run({action: 'scroll', direction: 'down'})).text, /版本说明 · 表格/);
  await assert.rejects(computer.run({action: 'click', ref: 'unseen'}), /引用/);
  const shot = await computer.run({action: 'screenshot', path: '结果.png'});
  assert.equal(shot.path, '结果.png');
  const file = await fs.readFile(path.join(root, shot.path));
  assert.equal(file.subarray(1, 4).toString(), 'PNG');
  assert.equal(file.toString('base64'), shot.image.data);
  assert.match((await computer.run({action: 'click', x: 430, y: 330})).text, /已选画布/);
  await assert.rejects(computer.run({action: 'click', x: 5000, y: 0}), /坐标/);
  await assert.rejects(computer.run({action: 'screenshot', path: '结果.png'}));
  await computer.close();
  await assert.rejects(computer.run({action: 'snapshot'}), /关闭/);
});

test('Pi browser opens only an explicitly allowed application and isolates it from workspace pages', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-computer-origin-'));
  const closeServer = server =>
    new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    });
  const otherCalls = [];
  const other = http.createServer((req, res) => {
    otherCalls.push(req.url);
    res.end('other service');
  });
  other.listen(0, '127.0.0.1');
  await once(other, 'listening');
  const blocked = 'http://127.0.0.1:' + other.address().port;
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push([req.method, req.url]);
    if (req.url === '/go-away') {
      res.writeHead(302, {Location: blocked + '/home'});
      return res.end();
    }
    if (req.url === '/start') {
      res.writeHead(302, {Location: '/home', 'Set-Cookie': 'session=fixture-only; HttpOnly; SameSite=Strict; Path=/'});
      return res.end();
    }
    if (req.url === '/save-draft') {
      res.writeHead(303, {Location: '/receipt'});
      return res.end();
    }
    if (req.url === '/receipt') {
      res.writeHead(200, {'Content-Type': 'text/plain'});
      return res.end(req.method === 'GET' && !req.headers['content-type'] ? 'Draft saved' : 'Unexpected request');
    }
    if (req.url === '/save') {
      if (!req.headers.cookie?.includes('session=fixture-only')) {
        res.writeHead(401);
        return res.end('The private session cookie is missing.');
      }
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
      return res.end('<h1>Changes saved</h1>');
    }
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
    res.end(
      '<button id="draft">Save draft</button><output id="receipt"></output>' +
        '<script>draft.onclick=async()=>{const result=await fetch("/save-draft",{method:"POST",body:"some changes"});receipt.textContent=await result.text()}</script>' +
        '<form method="post" action="/save"><button>Save changes</button></form><img src="' +
        blocked +
        '/logo.png">'
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = 'http://127.0.0.1:' + server.address().port;
  const computer = createPiComputer({root, allowedOrigins: [address]});
  t.after(async () => {
    await computer.close();
    await Promise.all([closeServer(server), closeServer(other)]);
    await fs.rm(root, {recursive: true, force: true});
  });
  await assert.rejects(computer.run({action: 'open', path: blocked}), /允许/);
  const opened = await computer.run({action: 'open', path: address + '/start'});
  const draft = opened.text.match(/button "Save draft" \[ref=(\w+)\]/)?.[1];
  assert.ok(draft, opened.text);
  let updated = await computer.run({action: 'click', ref: draft});
  const deadline = Date.now() + 3000;
  while (!updated.text.includes('Draft saved') && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
    updated = await computer.run({action: 'snapshot'});
  }
  assert.match(updated.text, /Draft saved/);
  assert.deepEqual(
    calls.filter(([, url]) => ['/save-draft', '/receipt'].includes(url)),
    [
      ['POST', '/save-draft'],
      ['GET', '/receipt']
    ]
  );
  const ref = updated.text.match(/button "Save changes" \[ref=(\w+)\]/)?.[1];
  assert.ok(ref, updated.text);
  await computer.run({action: 'click', ref});
  assert.match((await computer.run({action: 'snapshot'})).text, /Changes saved/);
  assert.ok(calls.some(([method, url]) => method === 'POST' && url === '/save'));
  await assert.rejects(computer.run({action: 'open', path: address + '/go-away'}));
  assert.deepEqual(otherCalls, []);
  await fs.writeFile(path.join(root, 'local.html'), '<h1>Local workspace</h1>');
  assert.match((await computer.run({action: 'open', path: 'local.html'})).text, /Local workspace/);
});
