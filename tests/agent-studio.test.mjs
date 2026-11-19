import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {openAgentStudio} from '../scripts/agent-studio.mjs';
import {generateApi} from '../scripts/studio-provider.mjs';

const base = 'http://127.0.0.1:3081/api/studio';
const connection = {
  name: '模型服务',
  baseUrl: 'https://api.example.test/v1/',
  model: 'text-model',
  apiKey: 'test-private-bearer'
};
const agent = {name: '图书编辑', role: '编辑', instructions: '保持简洁', connectionId: 'local'};
const send = (studio, method, route = '', body, headers = {}) =>
  studio.fetch(
    new Request(base + route, {
      method,
      headers: {'Content-Type': 'application/json', ...headers},
      ...(body === undefined ? {} : {body: JSON.stringify(body)})
    })
  );
const noopRunner = async () => async () => {};
async function fixture(t, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-studio-test-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const studio = await openAgentStudio({dir, startAgent: noopRunner, localAvailable: () => true, ...options});
  t.after(() => studio.close());
  return {dir, studio};
}

test('connection credentials persist privately, are redacted, and need reentry when origin changes', async t => {
  let tested;
  const {studio, dir} = await fixture(t, {
    testConnection: async c => {
      tested = c;
    }
  });
  const made = await send(studio, 'POST', '/connections', connection);
  assert.equal(made.status, 201);
  const view = (await made.json()).connection;
  assert.deepEqual(view, {
    id: view.id,
    name: connection.name,
    baseUrl: 'https://api.example.test/v1',
    model: connection.model,
    hasKey: true
  });
  const route = '/connections/' + view.id;
  assert.equal((await send(studio, 'PUT', route, {...connection, model: 'second', apiKey: ''})).status, 200);
  assert.equal(
    (await send(studio, 'PUT', route, {...connection, baseUrl: 'https://other.example.test', apiKey: ''})).status,
    400
  );
  assert.equal((await send(studio, 'POST', route + '/test', {})).status, 200);
  assert.equal(tested.apiKey, connection.apiKey);
  assert.equal(tested.model, 'second');
  assert.equal(tested.baseUrl, view.baseUrl);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(dir, 'profiles.json'))).mode & 0o777, 0o600);
  assert.equal(
    JSON.parse(await readFile(path.join(dir, 'profiles.json'), 'utf8')).connections[0].apiKey,
    connection.apiKey
  );
  assert.ok(!(await (await send(studio, 'GET')).text()).includes(connection.apiKey));
});

test('concurrent agents keep independent profiles, and only the affected connection restarts its agents', async t => {
  const events = [];
  const startAgent = async (a, c) => {
    events.push(['start', a.id, a.name, c?.model]);
    return async () => events.push(['stop', a.id]);
  };
  const {studio, dir} = await fixture(t, {startAgent});
  const c = (await (await send(studio, 'POST', '/connections', connection)).json()).connection;
  const [local, remote] = await Promise.all(
    [agent, {...agent, name: '校对', connectionId: c.id}].map(
      async a => (await (await send(studio, 'POST', '/agents', a)).json()).agent
    )
  );
  assert.notEqual(local.id, remote.id);
  assert.equal((await (await send(studio, 'GET')).json()).agents.length, 2);
  await send(studio, 'PUT', '/connections/' + c.id, {...connection, model: 'edited'});
  assert.deepEqual(events.slice(2), [
    ['stop', remote.id],
    ['start', remote.id, '校对', 'edited']
  ]);
  assert.equal(
    (await (await send(studio, 'PUT', '/agents/' + local.id, {...agent, name: '主编'})).json()).agent.id,
    local.id
  );
  await studio.close();
  events.length = 0;
  const reopened = await openAgentStudio({dir, startAgent, localAvailable: () => true});
  t.after(() => reopened.close());
  await reopened.restore();
  await reopened.restore();
  assert.deepEqual(new Set(events.map(e => e[1])), new Set([local.id, remote.id]));
  assert.equal(events.length, 2);
  assert.ok(events.some(e => e[2] === '主编'));
  assert.ok(events.some(e => e[3] === 'edited'));
});

test('unavailable local runner can be repaired and unexpected exits update its status', async t => {
  let available = false,
    stopNotice;
  const {studio} = await fixture(t, {
    localAvailable: () => available,
    startAgent: async (a, c, stopped) => {
      assert.equal(c, null);
      stopNotice = stopped;
      return async () => {};
    }
  });
  const made = (await (await send(studio, 'POST', '/agents', agent)).json()).agent;
  assert.equal(made.status, 'error');
  available = true;
  await studio.restore();
  assert.equal((await (await send(studio, 'GET')).json()).agents[0].status, 'running');
  stopNotice();
  assert.equal((await (await send(studio, 'GET')).json()).agents[0].status, 'error');
  const edited = (await (await send(studio, 'PUT', '/agents/' + made.id, {...agent, instructions: '仅做校对'})).json())
    .agent;
  assert.equal(edited.status, 'running');
  assert.equal(edited.instructions, '仅做校对');
});

test('validation rejects cross-origin writes, non-JSON and oversized bodies; provider errors redact secrets', async t => {
  const {studio} = await fixture(t, {
    testConnection: async c => {
      throw new Error(c.apiKey);
    }
  });
  assert.equal((await send(studio, 'GET', '', undefined, {'Sec-Fetch-Site': 'cross-site'})).status, 403);
  assert.equal((await send(studio, 'POST', '/agents', agent, {Origin: 'null'})).status, 403);
  assert.equal((await send(studio, 'POST', '/agents', agent, {'Content-Type': 'text/plain'})).status, 415);
  assert.equal((await send(studio, 'POST', '/agents', {...agent, instructions: 'a'.repeat(40000)})).status, 413);
  assert.equal((await send(studio, 'POST', '/agents', {...agent, connectionId: 'missing'})).status, 404);
  assert.equal(
    (await send(studio, 'POST', '/connections', {...connection, baseUrl: 'http://remote.test/api'})).status,
    400
  );
  const c = (await (await send(studio, 'POST', '/connections', connection)).json()).connection;
  const failure = await send(studio, 'POST', '/connections/' + c.id + '/test', {});
  assert.equal(failure.status, 502);
  assert.ok(!(await failure.text()).includes(connection.apiKey));
});

test('office profile capacity is enforced across simultaneous creates while editing stays available', async t => {
  const {studio} = await fixture(t);
  const replies = await Promise.all(
    Array.from({length: 17}, (_, i) => send(studio, 'POST', '/agents', {...agent, name: '编辑 ' + i}))
  );
  assert.equal(replies.filter(r => r.status === 201).length, 16);
  assert.equal(replies.filter(r => r.status === 409).length, 1);
  const saved = await (await send(studio, 'GET')).json();
  assert.equal(saved.agents.length, 16);
  assert.equal((await send(studio, 'PUT', '/agents/' + saved.agents[0].id, {...agent, name: '更新'})).status, 200);
});

test('test connection surfaces actionable sanitized HTTP status', async t => {
  const {studio} = await fixture(t, {
    testConnection: c =>
      generateApi(c, 'test', {send: async () => new Response('upstream echoed ' + c.apiKey, {status: 401})})
  });
  const c = (await (await send(studio, 'POST', '/connections', connection)).json()).connection;
  const failure = await send(studio, 'POST', '/connections/' + c.id + '/test', {});
  assert.equal(failure.status, 502);
  const {error} = await failure.json();
  assert.match(error, /401/);
  assert.match(error, /API Key/);
  assert.ok(!error.includes(connection.apiKey));
});

test('turning off a member stops the runner before updating office presence, persists across edits and restarts', async t => {
  const events = [];
  const options = {
    localAvailable: () => true,
    startAgent: async a => {
      events.push('start ' + a.id);
      return async () => events.push('stop ' + a.id);
    },
    markOffline: async id => events.push('offline ' + id)
  };
  const {dir, studio} = await fixture(t, options);
  const c = (await (await send(studio, 'POST', '/connections', connection)).json()).connection;
  const doc = {...agent, connectionId: c.id};
  const made = (await (await send(studio, 'POST', '/agents', doc)).json()).agent;
  const route = '/agents/' + made.id;
  const enabled = route + '/enabled';
  assert.equal(made.enabled, true);
  assert.equal((await send(studio, 'POST', enabled, {enabled: 'false'})).status, 400);
  const paused = (await (await send(studio, 'POST', enabled, {enabled: false})).json()).agent;
  assert.equal(paused.status, 'disabled');
  assert.equal(paused.enabled, false);
  assert.deepEqual(events, ['start ' + made.id, 'stop ' + made.id, 'offline ' + made.id]);
  await send(studio, 'POST', enabled, {enabled: false});
  await send(studio, 'PUT', route, {...doc, instructions: '保持事实准确', enabled: true});
  await send(studio, 'PUT', '/connections/' + c.id, {...connection, model: 'changed'});
  await studio.close();
  events.length = 0;
  const reopened = await openAgentStudio({dir, ...options});
  t.after(() => reopened.close());
  await reopened.restore();
  await reopened.restore();
  assert.deepEqual(events, ['offline ' + made.id]);
  const restored = (await (await send(reopened, 'GET')).json()).agents[0];
  assert.deepEqual([restored.status, restored.enabled, restored.instructions], ['disabled', false, '保持事实准确']);
  await Promise.all([1, 2].map(() => send(reopened, 'POST', enabled, {enabled: true})));
  assert.deepEqual(events, ['offline ' + made.id, 'start ' + made.id]);
  assert.equal((await (await send(reopened, 'GET')).json()).agents[0].status, 'running');
});

test('a failed presence update keeps the member disabled and retry repairs it without starting a runner', async t => {
  let fail = true,
    starts = 0;
  const {studio} = await fixture(t, {
    startAgent: async () => {
      starts++;
      return async () => {};
    },
    markOffline: async () => {
      if (fail) throw Error('disk');
    }
  });
  const made = (await (await send(studio, 'POST', '/agents', agent)).json()).agent;
  const enabled = '/agents/' + made.id + '/enabled';
  const failed = (await (await send(studio, 'POST', enabled, {enabled: false})).json()).agent;
  assert.equal(failed.status, 'error');
  assert.equal(failed.enabled, false);
  fail = false;
  const retry = (await (await send(studio, 'POST', enabled, {enabled: false})).json()).agent;
  assert.equal(retry.status, 'disabled');
  assert.equal(starts, 1);
});

test('migration makes legacy agents explicitly enabled on disk and restores them once', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-studio-migrate-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'profiles.json');
  await writeFile(file, JSON.stringify({version: 1, agents: [{...agent, id: 'old'}], connections: []}));
  let starts = 0;
  const studio = await openAgentStudio({
    dir,
    localAvailable: () => true,
    startAgent: async a => {
      starts++;
      assert.equal(a.enabled, true);
      return async () => {};
    }
  });
  t.after(() => studio.close());
  await studio.restore();
  await studio.restore();
  assert.equal(starts, 1);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).agents[0].enabled, true);
});

test('unused connection can be removed, referenced connections are protected, and clearing a key persists', async t => {
  const {studio, dir} = await fixture(t);
  const c = (await (await send(studio, 'POST', '/connections', connection)).json()).connection;
  const route = '/connections/' + c.id;
  assert.equal((await send(studio, 'PUT', route, {...connection, clearKey: true})).status, 400);
  assert.equal((await send(studio, 'PUT', route, {...connection, apiKey: '', clearKey: 'true'})).status, 400);
  const cleared = (
    await (
      await send(studio, 'PUT', route, {...connection, apiKey: '', clearKey: true, baseUrl: 'http://localhost:8093/v1'})
    ).json()
  ).connection;
  assert.equal(cleared.hasKey, false);
  assert.ok(!(await readFile(path.join(dir, 'profiles.json'), 'utf8')).includes(connection.apiKey));
  const profile = (await (await send(studio, 'POST', '/agents', {...agent, connectionId: c.id})).json()).agent;
  assert.equal((await send(studio, 'DELETE', route)).status, 409);
  await send(studio, 'POST', '/agents/' + profile.id + '/enabled', {enabled: false});
  assert.equal((await send(studio, 'DELETE', route)).status, 409);
  await send(studio, 'PUT', '/agents/' + profile.id, agent);
  assert.equal((await send(studio, 'DELETE', route)).status, 200);
  assert.equal((await (await send(studio, 'GET')).json()).connections.length, 0);
  assert.equal((await send(studio, 'POST', route + '/test', {})).status, 404);
  assert.equal((await send(studio, 'DELETE', route)).status, 404);
});

test('model discovery keeps saved and draft credentials separate, and leaves a manual selection intact', async t => {
  const reads = [];
  const {studio} = await fixture(t, {
    listModels: async c => {
      reads.push([c.baseUrl, c.apiKey]);
      return ['a', 'b'];
    }
  });
  const c = (await (await send(studio, 'POST', '/connections', connection)).json()).connection;
  const models = '/connections/' + c.id + '/models';
  assert.deepEqual(
    await (await send(studio, 'POST', models, {baseUrl: 'https://other.test', apiKey: 'ignore'})).json(),
    {models: ['a', 'b']}
  );
  assert.equal((await send(studio, 'GET', models)).status, 405);
  assert.equal((await send(studio, 'POST', '/connections/models', {baseUrl: 'https://other.test/v1'})).status, 200);
  assert.equal((await send(studio, 'POST', '/connections/models', {baseUrl: 'http://other.test'})).status, 400);
  assert.deepEqual(reads, [
    [c.baseUrl, connection.apiKey],
    ['https://other.test/v1', '']
  ]);
  assert.deepEqual((await (await send(studio, 'GET')).json()).connections, [c]);
});
