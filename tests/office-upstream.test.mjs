import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {openAgentStudio} from '../scripts/agent-studio.mjs';
import {createOfficeUpstream, localBackend, localRequest} from '../scripts/office-upstream.mjs';
import {createWorker} from '../worker/index.js';
import {MemoryBucket} from './memory-bucket.mjs';

const env = {OFFICE_REMOTE_ORIGIN: 'https://shared.example', AGENT_OFFICE_TOKEN: 'fixture-key'};
const get = (path, headers) => new Request('http://localhost:3080' + path, {headers});
const write = (path, body, headers = {}, method = 'POST') =>
  new Request('http://localhost:3080' + path, {
    method,
    body: JSON.stringify(body),
    headers: {'Content-Type': 'application/json', ...headers}
  });

function sharedOffice({legacy = false} = {}) {
  const worker = createWorker();
  const bindings = {BUCKET: new MemoryBucket()};
  const calls = [];
  const proxy = createOfficeUpstream(env, async (url, init) => {
    const req = new Request(url, init);
    const path = new URL(url).pathname;
    calls.push({path, headers: req.headers, redirect: init.redirect});
    assert.equal(new URL(url).origin, env.OFFICE_REMOTE_ORIGIN);
    assert.equal(req.headers.get('oai-sites-authorization'), 'Bearer fixture-key');
    if (legacy && path === '/api/sync') return Response.json({error: 'Not found.'}, {status: 404});
    return worker.fetch(req, bindings);
  });
  return {proxy, calls};
}

test('Loopback host and browser origin are validated, including localhost browser writes', () => {
  const req = (host, origin, url = '/api/state') =>
    localRequest({url, method: 'GET', headers: {host, ...(origin ? {origin} : {})}}, 3080);
  assert.equal(req('attacker.test:3080'), null);
  assert.equal(req('localhost:3081'), null);
  assert.equal(req('localhost:3080', 'null'), null);
  assert.equal(req('localhost:3080', 'http://localhost:8000'), null);
  assert.equal(req('localhost:3080', undefined, '//attacker.test/api/state'), null);
  assert.equal(req('localhost:3080', 'http://localhost:3080').url, 'http://localhost:3080/api/state');
});

test('Remote data mode keeps credentials in Node and exposes only the selected office origin', async () => {
  assert.equal(createOfficeUpstream({AGENT_OFFICE_TOKEN: 'unused'}), null);
  assert.throws(() => createOfficeUpstream({OFFICE_REMOTE_ORIGIN: env.OFFICE_REMOTE_ORIGIN}), /AGENT_OFFICE_TOKEN/);
  for (const url of ['http://example.org', 'https://name:pass@example.org', 'https://example.org/api']) {
    assert.throws(() => createOfficeUpstream({...env, OFFICE_REMOTE_ORIGIN: url}), /HTTPS site origin/);
  }
  const api = await localBackend(createWorker(), undefined, env);
  assert.deepEqual(await (await api.fetch(get('/api/local-mode'))).json(), {
    mode: 'remote',
    remoteOrigin: env.OFFICE_REMOTE_ORIGIN
  });
});

test('Browser chat and agent MCP share state and preserve sync ETags without forwarding browser headers', async () => {
  const {proxy, calls} = sharedOffice();
  const saved = await proxy.fetch(
    write(
      '/api/chat',
      {agentId: 'hermes', requestId: 'msg01', content: '你好'},
      {
        Origin: 'http://localhost:3080',
        Cookie: 'private=yes',
        'oai-authenticated-user-id': 'spoof',
        'OAI-Sites-Authorization': 'wrong'
      }
    )
  );
  assert.equal(saved.status, 201);
  assert.equal(calls[0].headers.get('cookie'), null);
  assert.equal(calls[0].headers.get('origin'), null);
  assert.equal(calls[0].headers.get('oai-authenticated-user-id'), null);
  assert.equal(calls[0].redirect, 'manual');
  const response = await proxy.fetch(
    write('/mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {name: 'office_get_messages', arguments: {agent_id: 'hermes', pending_only: true}}
    })
  );
  assert.equal((await response.json()).result.structuredContent.messages[0].content, '你好');
  assert.equal(calls.at(-1).path, '/api/hermes/mcp');
  const state = await (await proxy.fetch(get('/api/state'))).json();
  const conflict = await proxy.fetch(write('/api/state', {...state, revision: state.revision - 1}, {}, 'PUT'));
  assert.equal(conflict.status, 409);
  const sync = await proxy.fetch(get('/api/sync?scope=hermes'));
  assert.equal((await sync.json()).conversation.messages.length, 1);
  const cached = await proxy.fetch(get('/api/sync?scope=hermes', {'If-None-Match': sync.headers.get('etag')}));
  assert.equal(cached.status, 304);
  assert.equal(await cached.text(), '');
});

test('Credentials and other routes, cross-site traffic, redirects and HTML remain outside the local data API', async () => {
  const {proxy, calls} = sharedOffice();
  assert.equal((await proxy.fetch(get('/api/hermes/credentials', {'oai-authenticated-user-id': 'spoof'}))).status, 404);
  assert.equal((await proxy.fetch(get('/mcp'))).status, 405);
  assert.equal((await proxy.fetch(get('/api/sync', {'sec-fetch-site': 'cross-site'}))).status, 403);
  assert.equal((await proxy.fetch(write('/api/channel', {}, {Origin: 'http://malicious.test'}))).status, 403);
  assert.equal((await proxy.fetch(write('/api/chat', {}, {'Content-Type': 'text/plain'}))).status, 415);
  assert.equal(calls.length, 0);
  for (const remote of [
    Response.redirect('https://elsewhere.example/'),
    new Response('<html>Login</html>', {status: 401, headers: {'Content-Type': 'text/html', 'set-cookie': 'auth=bad'}})
  ]) {
    const relay = createOfficeUpstream(env, async () => remote);
    const res = await relay.fetch(get('/api/state'));
    assert.equal(res.status, remote.status === 401 ? 401 : 502);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.equal(res.headers.get('location'), null);
    assert.equal(res.headers.get('set-cookie'), null);
  }
});

test('A pre-2.4 remote office can serve the current group and private workspace without changing its Worker', async () => {
  const {proxy, calls} = sharedOffice({legacy: true});
  await proxy.fetch(write('/api/channel', {requestId: 'msg02', content: '给小组的留言'}));
  const first = await proxy.fetch(get('/api/sync'));
  assert.equal((await first.json()).conversation.messages[0].content, '给小组的留言');
  const cached = await proxy.fetch(get('/api/sync', {'If-None-Match': first.headers.get('etag')}));
  assert.equal(cached.status, 304);
  assert.equal(calls.at(-1).path, '/api/state');
  const chat = await (await proxy.fetch(get('/api/sync?scope=hermes'))).json();
  assert.deepEqual(chat.conversation.messages, []);
  assert.deepEqual(chat.visuals, []);
  assert.deepEqual(chat.steps, []);
  const gone = await (await proxy.fetch(get('/api/sync?scope=former'))).json();
  assert.equal(gone.conversation.missing, true);
  assert.equal(calls.filter(c => c.path === '/api/sync').length, 1);
  assert.equal((await proxy.fetch(get('/api/sync?scope=a%2Fb'))).status, 400);
});

test('studio disable and re-enable reconcile browser state, roster, chat, tasks and MCP ownership', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-managed-test-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  let studio, backend;
  const rpc = async (name, args) => {
    const r = await backend.fetch(
      write('/mcp', {jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name, arguments: args}})
    );
    const {result} = await r.json();
    if (result.isError) throw new Error(result.content[0].text);
    return result.structuredContent;
  };
  const state = () => backend.fetch(get('/api/state')).then(r => r.json());
  const change = async (route, fields, method = 'POST') => {
    const r = await backend.fetch(write('/api/studio' + route, fields, {}, method));
    assert.ok(r.ok);
    return r.json();
  };
  studio = await openAgentStudio({
    dir: path.join(dir, 'studio'),
    localAvailable: () => true,
    startAgent: async (profile, connection) => {
      await backend.setAgentEnabled(profile.id, true);
      await rpc('office_register_agent', {
        agent_id: profile.id,
        name: profile.name,
        role: profile.role,
        model: connection ? 'API' : 'Pi'
      });
      return async () => {};
    },
    markOffline: (id, p) =>
      backend.setAgentEnabled(id, false, {name: p.name, role: p.role, model: p.connectionId === 'local' ? 'Pi' : 'API'})
  });
  t.after(() => studio.close());
  backend = await localBackend(createWorker(), dir, {OFFICE_PI_LOCAL: '1'}, req => studio.fetch(req));
  const profile = {name: '编辑', role: '编辑初稿', instructions: '略', connectionId: 'local'};
  const {
    agent: {id}
  } = await change('/agents', profile);
  const before = await state();
  assert.ok(before.agents[0].lastSeen);
  const {task} = await rpc('office_create_task', {
    agent_id: id,
    request_id: 'draft',
    title: '文稿',
    priority: 'normal'
  });
  await rpc('office_claim_task', {agent_id: id, task_id: task.id});
  await rpc('office_update_task', {agent_id: id, task_id: task.id, status: 'active', progress: 35});
  await backend.fetch(write('/api/chat', {agentId: id, requestId: 'text', content: '保留这条草稿'}));
  const toggle = enabled => change('/agents/' + id + '/enabled', {enabled});
  const disabled = await toggle(false);
  assert.equal(disabled.agent.status, 'disabled');
  const stopped = await state();
  assert.equal(stopped.agents[0].managedDisabled, true);
  assert.equal(stopped.agents[0].lastSeen, null);
  assert.equal(stopped.agents[0].status, 'resting');
  assert.equal(stopped.tasks[0].status, 'paused');
  assert.equal(stopped.tasks[0].progress, 35);
  const actions = stopped.activities.length;
  const access = group => rpc(group, {agent_id: id});
  for (const tool of ['office_heartbeat', 'office_claim_task', 'office_register_agent'])
    await assert.rejects(access(tool), /停用/);
  assert.equal(
    (
      await backend.fetch(
        write('/api/state', {...stopped, tasks: [{...stopped.tasks[0], status: 'active'}]}, {}, 'PUT')
      )
    ).status,
    409
  );
  assert.equal((await backend.fetch(write('/api/state', {...stopped, tasks: [], agents: []}, {}, 'PUT'))).status, 409);
  await backend.setAgentEnabled(id, false, {name: profile.name, role: profile.role, model: 'Pi'});
  assert.equal((await state()).revision, stopped.revision);
  const canonical = await backend.fetch(
    write(
      '/api/state',
      {...stopped, agents: [{...stopped.agents[0], managedDisabled: false, status: 'working', lastSeen: Date.now()}]},
      {},
      'PUT'
    )
  );
  assert.equal(canonical.status, 200);
  assert.equal((await canonical.json()).agents[0].managedDisabled, true);
  const {connection} = await change('/connections', {
    name: 'API',
    baseUrl: 'https://model.example/v1',
    model: 'fixture'
  });
  await change('/agents/' + id, {...profile, connectionId: connection.id, name: '校对', role: '复核'}, 'PUT');
  const revised = await state();
  assert.equal(revised.agents[0].name, '校对');
  assert.equal(revised.agents[0].role, '复核');
  assert.equal(revised.agents[0].model, 'API');
  assert.equal(revised.agents[0].seatId, stopped.agents[0].seatId);
  assert.equal(revised.agents[0].lastSeen, null);
  assert.equal(revised.activities.length, actions);
  assert.equal((await access('office_get_messages')).messages[0].content, '保留这条草稿');
  assert.equal((await toggle(true)).agent.status, 'running');
  const resumed = await state();
  assert.equal(resumed.agents[0].managedDisabled, undefined);
  assert.ok(resumed.agents[0].lastSeen);
  assert.equal(resumed.tasks[0].status, 'paused');
  assert.equal((await rpc('office_claim_task', {agent_id: id, task_id: task.id})).task.status, 'active');
  assert.equal(
    (await rpc('office_update_task', {agent_id: id, task_id: task.id, status: 'done', result: '已复核'})).task.status,
    'done'
  );
});

test('local member settings persist, guide external MCP reconnects and keep Pi instructions private', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-member-settings-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  let backend, studio;
  const stopped = [];
  const reopen = async () => {
    await studio?.close();
    studio = await openAgentStudio({
      dir: path.join(dir, 'studio'),
      localAvailable: () => false,
      updateMember: (id, fields) => backend.setMemberProfile(id, fields),
      stopProjects: id => stopped.push(id)
    });
    backend = await localBackend(createWorker(), dir, {OFFICE_PI_LOCAL: '1'}, req => studio.fetch(req), undefined, {
      briefForTask: (task, member) =>
        task === 'task_plan' && member === 'claude' ? {request: 'Inspect project'} : null
    });
  };
  t.after(() => studio?.close());
  await reopen();
  const change = (id, fields) => backend.fetch(write('/api/studio/members/' + id, fields, {}, 'PUT'));
  const rpc = async (name, args) => {
    const res = await (
      await backend.fetch(write('/mcp', {jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name, arguments: args}}))
    ).json();
    if (res.result.isError) throw Error(res.result.content[0].text);
    return res.result.structuredContent;
  };
  const pi = {name: '助手', role: '处理项目', instructions: 'private-pi-policy'};
  assert.equal((await change('pi-local', pi)).status, 200);
  await reopen();
  assert.equal(studio.projectAgent('pi-local').instructions, pi.instructions);
  await studio.syncBuiltin();
  const state = () => rpc('office_get_state', {});
  assert.ok(!JSON.stringify(await state()).includes(pi.instructions));
  assert.equal((await state()).agents[0].name, pi.name);
  const reg = {agent_id: 'claude', name: 'CLI', role: 'remote role', model: 'Claude'};
  await rpc('office_register_agent', reg);
  const form = {
    name: '评审',
    role: '复核改动',
    color: '#778899',
    seatId: 'desk-11',
    enabled: true,
    officeNotes: '注明验证依据'
  };
  assert.equal((await change('claude', {...form, seatId: 'desk-01'})).status, 409);
  assert.equal((await change('claude', {...form, model: 'Gemini'})).status, 400);
  assert.equal((await change('claude', form)).status, 200);
  await reopen();
  const {agent} = await rpc('office_register_agent', reg);
  for (const key of ['name', 'role', 'color', 'seatId', 'officeNotes']) assert.equal(agent[key], form[key]);
  assert.equal((await rpc('office_heartbeat', {agent_id: 'claude'})).agent.officeNotes, form.officeNotes);
  const before = await state();
  const stale = {
    ...before,
    agents: before.agents.map(a =>
      a.id === 'claude' ? {...a, name: 'Old Name', seatId: 'desk-14', officeNotes: 'ignored'} : a
    )
  };
  assert.equal((await backend.fetch(write('/api/state', stale, {}, 'PUT'))).status, 200);
  const {task} = await rpc('office_create_task', {agent_id: 'claude', title: '协作任务', request_id: 'plan'});
  const claim = await rpc('office_claim_task', {agent_id: 'claude'});
  assert.equal(claim.task.id, task.id);
  assert.equal(claim.project.request, 'Inspect project');
  await rpc('office_create_task', {agent_id: 'claude', title: '待认领任务', request_id: 'queued'});
  assert.equal((await change('claude', {...form, enabled: false})).status, 200);
  assert.deepEqual(stopped, ['claude']);
  await reopen();
  const after = await state();
  assert.equal(after.agents.find(a => a.id === 'claude').name, form.name);
  assert.equal(after.agents.find(a => a.id === 'claude').seatId, form.seatId);
  assert.deepEqual(
    after.tasks.map(t => t.status),
    ['paused', 'paused']
  );
  for (const tool of ['office_claim_task', 'office_heartbeat', 'office_register_agent'])
    await assert.rejects(rpc(tool, {agent_id: 'claude'}), /停用/);
  assert.equal((await change('claude', form)).status, 200);
  assert.equal((await rpc('office_register_agent', reg)).agent.name, form.name);
});

test('any member can move to a free desk, and the desk survives a restart', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-member-seat-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  let backend, studio;
  const reopen = async () => {
    await studio?.close();
    studio = await openAgentStudio({
      dir: path.join(dir, 'studio'),
      localAvailable: () => false,
      updateMember: (id, fields) => backend.setMemberProfile(id, fields),
      moveMember: (id, seatId) => backend.setMemberSeat(id, seatId)
    });
    backend = await localBackend(createWorker(), dir, {OFFICE_PI_LOCAL: '1'}, req => studio.fetch(req));
  };
  t.after(() => studio?.close());
  await reopen();
  const rpc = async (name, args) =>
    (
      await (
        await backend.fetch(
          write('/mcp', {jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name, arguments: args}})
        )
      ).json()
    ).result.structuredContent;
  const move = (id, seatId, method = 'PUT') =>
    backend.fetch(write('/api/studio/members/' + id + '/seat', {seatId}, {}, method));
  const seats = async () => Object.fromEntries((await rpc('office_get_state', {})).agents.map(a => [a.id, a.seatId]));
  await studio.syncBuiltin();
  await rpc('office_register_agent', {agent_id: 'agent-writer', name: '编辑', model: 'API'});
  await rpc('office_register_agent', {agent_id: 'claude', name: 'CLI', model: 'Claude'});
  const before = await seats();

  assert.equal((await move('pi-local', 'desk-07')).status, 200);
  assert.equal((await move('agent-writer', 'desk-09')).status, 200);
  assert.equal((await move('claude', 'desk-07')).status, 409, 'a taken desk is refused');
  assert.equal((await move('claude', 'desk-99')).status, 400);
  assert.equal((await move('nobody', 'desk-12')).status, 404);
  assert.equal((await move('pi-local', 'desk-12', 'POST')).status, 405);
  assert.deepEqual(await seats(), {...before, 'pi-local': 'desk-07', 'agent-writer': 'desk-09'});

  // Reconnecting members keep the desk they were moved to.
  await reopen();
  await studio.syncBuiltin();
  await rpc('office_register_agent', {agent_id: 'agent-writer', name: '编辑', model: 'API'});
  assert.deepEqual(await seats(), {...before, 'pi-local': 'desk-07', 'agent-writer': 'desk-09'});
});
