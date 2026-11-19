// Integration suite uses real loopback sockets, like the browser tests. No model download or external API.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {text} from 'node:stream/consumers';
import {setTimeout as delay} from 'node:timers/promises';

const secret = 'studio-integration-fixture-only';
async function until(read, label) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const result = await read();
    if (result) return result;
    await delay(100);
  }
  throw new Error('Timed out waiting for ' + label);
}

async function startOffice(t, dir) {
  // Exercise the actual npm run local entry point without loading the operator's .env.local.
  const child = spawn(process.execPath, ['scripts/local.mjs'], {
    cwd: path.resolve(import.meta.dirname, '../..'),
    env: {PATH: process.env.PATH, OFFICE_DATA_DIR: dir, OFFICE_PORT: '0', OFFICE_PI_BIN: path.join(dir, 'no-pi')},
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const closed = once(child, 'close');
  async function stop() {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    try {
      const [code] = await closed;
      assert.equal(code, 0);
    } finally {
      clearTimeout(force);
    }
  }
  t.after(stop);
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => (output += chunk.toString()));
  const origin = await until(() => {
    assert.equal(child.exitCode, null, 'Local office exited before startup: ' + output);
    return output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  }, 'office URL');
  const api = async (route, body) => {
    const response = await fetch(origin + route, {
      ...(body && {
        method: 'POST',
        headers: {'Content-Type': 'application/json', Origin: origin},
        body: JSON.stringify(body)
      }),
      signal: AbortSignal.timeout(5000)
    });
    const raw = await response.text();
    assert.ok(!raw.includes(secret), 'A user-visible endpoint exposed the key');
    assert.ok(response.ok, route + ': ' + response.status + ' ' + raw);
    return JSON.parse(raw);
  };
  // The HTTP listener comes up before MCP discovery and profile restoration.
  await until(async () => {
    const response = await fetch(origin + '/api/studio', {signal: AbortSignal.timeout(5000)});
    if (response.status === 503) {
      await response.body?.cancel();
      return false;
    }
    assert.equal(response.status, 200);
    return (await response.json()).agents.every(agent => agent.status === (agent.enabled ? 'running' : 'disabled'));
  }, 'profile restoration');
  return {api, stop};
}

test(
  'API-only office can test a provider, run a custom agent and resume its conversation after restart',
  {timeout: 60000},
  async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'office-api-integration-'));
    t.after(() => fs.rm(dir, {recursive: true, force: true}));
    const calls = [];
    const provider = http.createServer(async (req, res) => {
      const payload = JSON.parse(await text(req));
      calls.push({url: req.url, auth: req.headers.authorization, payload});
      res.writeHead(200, {'Content-Type': 'application/json'});
      const content = payload.messages.at(-1).content.includes('/visual table')
        ? JSON.stringify({title: '编辑进度', content: {columns: ['项目', '数量'], rows: [['校对', 2]]}})
        : 'fixture reply ' + calls.length;
      res.end(JSON.stringify({choices: [{message: {content}}]}));
    });
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    t.after(() => {
      provider.closeAllConnections();
      return new Promise(resolve => provider.close(resolve));
    });
    let current;
    try {
      current = await startOffice(t, dir);
      assert.equal((await current.api('/api/local-mode')).studio, true);
      assert.equal((await current.api('/api/studio')).localAvailable, false);
      const {connection} = await current.api('/api/studio/connections', {
        name: 'Fixture API',
        baseUrl: 'http://127.0.0.1:' + provider.address().port + '/v1',
        model: 'fixture-model',
        apiKey: secret
      });
      assert.equal(connection.hasKey, true);
      assert.deepEqual(await current.api('/api/studio/connections/' + connection.id + '/test', {}), {ok: true});
      const profile = {name: '编辑', role: '产品编辑', instructions: '保留稿件里的事实。', connectionId: connection.id};
      const {agent} = await current.api('/api/studio/agents', profile);
      assert.equal(agent.status, 'running');
      for (const round of [1, 2]) {
        if (round === 2) {
          await current.stop();
          current = await startOffice(t, dir);
          const catalog = await current.api('/api/studio');
          assert.equal(catalog.agents[0].id, agent.id);
          assert.equal(catalog.agents[0].status, 'running');
          assert.equal(catalog.connections[0].hasKey, true);
        }
        const content = '文本校对 ' + round;
        const {message} = await current.api('/api/chat', {agentId: agent.id, content, requestId: 'request-' + round});
        const messages = await until(async () => {
          const {messages} = await current.api('/api/chat?agentId=' + agent.id);
          return messages.find(m => m.id === message.id)?.replyId && messages;
        }, 'agent reply');
        const sent = messages.find(m => m.id === message.id);
        assert.equal(messages.find(m => m.id === sent.replyId).content, 'fixture reply ' + (round + 1));
        assert.equal(messages.length, round * 2);
        const outbound = calls[round].payload;
        assert.equal(outbound.model, 'fixture-model');
        const [system, user] = outbound.messages;
        assert.equal(system.role, 'system');
        for (const detail of [profile.name, profile.role, profile.instructions])
          assert.ok(system.content.includes(detail));
        assert.equal(user.role, 'user');
        assert.ok(user.content.includes(content));
        if (round === 2) assert.ok(user.content.includes('fixture reply 2'), 'missing prior conversation context');
        const state = await current.api('/api/state');
        assert.deepEqual(
          state.agents.map(a => a.id),
          [agent.id]
        );
        await current.api('/api/sync?scope=' + agent.id);
      }
      assert.equal(calls.length, 3);
      const toggle = '/api/studio/agents/' + agent.id + '/enabled';
      await current.api(toggle, {enabled: false});
      const {message} = await current.api('/api/chat', {
        agentId: agent.id,
        requestId: 'delivery',
        content: '/visual table 将数量 2 的校对项目发布成表格。'
      });
      await current.stop();
      current = await startOffice(t, dir);
      assert.equal((await current.api('/api/state')).agents[0].managedDisabled, true);
      assert.equal((await current.api('/api/studio')).agents[0].status, 'disabled');
      assert.equal(calls.length, 3);
      await current.api(toggle, {enabled: true});
      const sync = await until(async () => {
        const result = await current.api('/api/sync?scope=' + agent.id);
        return result.conversation.messages.some(m => m.id === message.id && m.replyId) && result;
      }, 'delivery from re-enabled API agent');
      assert.equal(sync.visuals.length, 1);
      assert.equal(sync.visuals[0].messageId, message.id);
      const {visual} = await current.api('/api/visuals/' + sync.visuals[0].id);
      assert.deepEqual(JSON.parse(visual.content).rows, [['校对', 2]]);
      assert.ok(sync.steps.some(s => s.messageId === message.id && s.status === 'completed'));
      assert.equal(calls.length, 4);
      assert.ok(!calls.at(-1).payload.messages.at(-1).content.includes('文本校对 1'));
      assert.ok(calls.every(call => call.url === '/v1/chat/completions' && call.auth === 'Bearer ' + secret));
    } finally {
      await current?.stop();
    }
  }
);
