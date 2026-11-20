// Exercises Pi itself: the fake server implements only the local model's HTTP stream.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {access, mkdir, mkdtemp, rm, readFile} from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {json} from 'node:stream/consumers';
import test from 'node:test';
import {preparePiModel} from '../../scripts/pi-model.mjs';
import {generatePi} from '../../scripts/pi-process.mjs';

const pi = path.resolve(import.meta.dirname, '../../.office-local/pi-runtime/node_modules/.bin/pi');
const filename = '工作记录.txt';
const contents = '工具写入并保存。';
const modelId = 'fixture-tools';
const key = 'fixture-tools-only';
const reply = '文件已写入。';

function stream(res, delta, reason) {
  res.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache'});
  const chunk = (delta, finish_reason) =>
    'data: ' +
    JSON.stringify({
      id: 'chatcmpl-fixture',
      model: modelId,
      object: 'chat.completion.chunk',
      created: 1,
      choices: [{index: 0, delta, finish_reason}]
    }) +
    '\n\n';
  res.end(chunk({role: 'assistant'}, null) + chunk(delta, null) + chunk({}, reason) + 'data: [DONE]\n\n');
}

test(
  'bundled Pi receives the office tools, writes a workspace file and returns the tool result to the model',
  {timeout: 40000},
  async t => {
    try {
      await access(pi);
    } catch (error) {
      if (error.code === 'ENOENT') {
        t.skip('bundled Pi is optional; run npm run pi:install first');
        return;
      }
      throw error;
    }
    const dir = await mkdtemp(path.join(os.tmpdir(), 'office-pi-tools-integration-'));
    const workspace = path.join(dir, 'files');
    await mkdir(workspace);
    const calls = [];
    const server = http.createServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify({data: [{id: modelId}]}));
        return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404).end();
        return;
      }
      const body = await json(req);
      calls.push({body, authorization: req.headers.authorization});
      if (calls.length === 1) {
        stream(
          res,
          {
            tool_calls: [
              {
                index: 0,
                id: 'call_office_doc',
                type: 'function',
                function: {
                  name: 'office_document',
                  arguments: JSON.stringify({operation: 'write', path: filename, text: contents})
                }
              }
            ]
          },
          'tool_calls'
        );
      } else {
        stream(res, {content: reply}, 'stop');
      }
    });
    let model;
    t.after(async () => {
      await model?.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await rm(dir, {recursive: true, force: true});
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    model = await preparePiModel({
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        OFFICE_PI_BIN: pi,
        OFFICE_MODEL_URL: 'http://127.0.0.1:' + server.address().port + '/v1',
        OFFICE_MODEL_ID: modelId,
        OFFICE_MODEL_API_KEY: key
      },
      runtimeDir: dir
    });
    const result = await generatePi('请用文档工具保存工作记录。', {env: model.env, workspace, timeout: 30000});
    assert.equal(calls.length, 2);
    assert.ok(
      calls.every(r => r.authorization === 'Bearer ' + key && r.body.model === modelId && r.body.stream === true)
    );
    assert.deepEqual(calls[0].body.tools.map(tool => tool.function.name).sort(), ['office_browser', 'office_document']);
    const event = calls[1].body.messages.find(m => m.role === 'tool');
    assert.equal(event?.tool_call_id, 'call_office_doc');
    assert.deepEqual(JSON.parse(event.content), {path: filename, bytes: Buffer.byteLength(contents)});
    assert.equal(await readFile(path.join(workspace, filename), 'utf8'), contents);
    assert.equal(result, reply);
  }
);
