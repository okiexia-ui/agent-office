import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createWorker, callTool, seedState} from '../worker/index.js';
import {MemoryBucket, STATE_KEY} from './memory-bucket.mjs';

const worker = createWorker(),
  origin = 'https://office.test';
const environment = () => ({BUCKET: new MemoryBucket()});
const request = (path, {body, method = body ? 'POST' : 'GET', headers = {}} = {}) =>
  new Request(origin + path, {
    method,
    headers: {'content-type': 'application/json', ...headers},
    ...(body ? {body: JSON.stringify(body)} : {})
  });
const chart = (extra = {}) => ({
  agent_id: 'hermes',
  request_id: 'chart_1',
  title: '结果',
  kind: 'chart',
  content: JSON.stringify({labels: ['A', 'B'], values: [1, 2]}),
  ...extra
});
const publish = (e, extra) => callTool('office_publish_visual', chart(extra), e);
const stateObject = e => JSON.parse(e.BUCKET.value);

test('One sync request carries state, visual and step listings and the open conversation', async () => {
  const e = environment();
  await worker.fetch(request('/api/channel', {body: {requestId: 'hello', content: '大家好', mentions: ['hermes']}}), e);
  await publish(e);
  await callTool('office_report_step', {agent_id: 'hermes', request_id: 'step_1', title: '读取', status: 'info'}, e);
  const response = await worker.fetch(request('/api/sync'), e);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('etag'), /^".+\.sync-group"$/);
  const data = await response.json();
  assert.equal(data.revision, data.state.revision);
  assert.equal(data.state.agents[0].id, 'hermes');
  assert.equal(data.state.messages, undefined, 'private chats stay out of the shared state');
  assert.equal(data.visuals.length, 1);
  assert.equal(data.visuals[0].content, undefined);
  assert.equal(data.visuals[0].requestShape, undefined);
  assert.equal(data.steps.length, 1);
  assert.equal(data.steps[0].requestShape, undefined);
  assert.equal(data.conversation.scope, 'group');
  assert.equal(data.conversation.messages[0].content, '大家好');
});

test('An unchanged office answers 304 from metadata without reading the state object', async () => {
  const e = environment();
  await callTool('office_heartbeat', {agent_id: 'hermes'}, e);
  const first = await worker.fetch(request('/api/sync'), e);
  const tag = first.headers.get('etag');
  const reads = e.BUCKET.calls.get;
  const again = await worker.fetch(request('/api/sync', {headers: {'If-None-Match': tag}}), e);
  assert.equal(again.status, 304);
  assert.equal(again.headers.get('etag'), tag);
  assert.equal(e.BUCKET.calls.get, reads, 'a 304 must not read the state body');
  // A different view of the same version is a different tag.
  assert.equal(
    (await worker.fetch(request('/api/sync?scope=hermes', {headers: {'If-None-Match': tag}}), e)).status,
    200
  );
  await worker.fetch(request('/api/channel', {body: {requestId: 'change', content: '有变化'}}), e);
  const changed = await worker.fetch(request('/api/sync', {headers: {'If-None-Match': tag}}), e);
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get('etag'), tag);
  const stateTag = (await worker.fetch(request('/api/state'), e)).headers.get('etag');
  assert.equal((await worker.fetch(request('/api/state', {headers: {'If-None-Match': stateTag}}), e)).status, 304);
});

test('Sync scopes a private conversation, reports a missing member and validates the scope', async () => {
  const e = environment();
  await worker.fetch(request('/api/chat', {body: {agentId: 'hermes', requestId: 'q1', content: '你好'}}), e);
  const own = await (await worker.fetch(request('/api/sync?scope=hermes'), e)).json();
  assert.equal(own.conversation.scope, 'hermes');
  assert.equal(own.conversation.messages.length, 1);
  assert.equal(own.conversation.pending_messages, 1);
  const gone = await (await worker.fetch(request('/api/sync?scope=nobody'), e)).json();
  assert.equal(gone.conversation.missing, true);
  assert.equal((await worker.fetch(request('/api/sync?scope=bad%2Fid'), e)).status, 400);
  assert.equal((await worker.fetch(request('/api/sync', {method: 'POST', body: {}}), e)).status, 405);
  assert.equal((await worker.fetch(request('/api/sync'), {})).status, 503);
});

test('Visual content is stored outside the office state and cleaned up on retry and retention', async () => {
  const e = environment();
  const big = 'x'.repeat(30000);
  const {visual} = await callTool(
    'office_publish_visual',
    {agent_id: 'hermes', request_id: 'doc', title: '长文档', kind: 'document', content: big},
    e
  );
  assert.ok(!e.BUCKET.value.includes(big.slice(0, 100)), 'state must not contain the content');
  assert.ok(e.BUCKET.value.length < 10000);
  assert.match(stateObject(e).visuals[0].requestShape, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(e.BUCKET.keys('office/visuals/'), [`office/visuals/${visual.id}.json`]);
  assert.equal((await callTool('office_get_visual', {visual_id: visual.id}, e)).visual.content, big);
  const [a, b] = await Promise.all([publish(e), publish(e)]);
  assert.equal(a.visual.id, b.visual.id);
  assert.equal(e.BUCKET.keys('office/visuals/').length, 2, 'a deduplicated retry leaves no orphan');
  for (let i = 0; i < 41; i++) await publish(e, {request_id: 'more_' + i});
  assert.equal(stateObject(e).visuals.length, 40);
  assert.equal(e.BUCKET.keys('office/visuals/').length, 40, 'trimmed visuals lose their content too');
  await assert.rejects(callTool('office_get_visual', {visual_id: visual.id}, e), /no longer retained/);
});

test('Visuals saved inline by older versions stay readable and move out on the next publish', async () => {
  const e = environment();
  const old = seedState();
  const legacyPayload = {
    title: '旧图表',
    kind: 'chart',
    content: chart().content,
    summary: '',
    taskId: null,
    messageId: null
  };
  old.visuals = [
    {
      id: 'legacy_visual',
      agentId: 'hermes',
      agentName: 'Hermes',
      requestId: 'legacy',
      requestShape: JSON.stringify(legacyPayload),
      ...legacyPayload,
      createdAt: 1
    }
  ];
  e.BUCKET.value = JSON.stringify(old);
  assert.equal((await callTool('office_get_visual', {visual_id: 'legacy_visual'}, e)).visual.content, chart().content);
  await publish(e, {request_id: 'new_one'});
  const moved = stateObject(e).visuals.find(v => v.id === 'legacy_visual');
  assert.equal(moved.content, undefined);
  assert.match(moved.requestShape, /^sha256:/);
  assert.ok(e.BUCKET.keys('office/visuals/').includes('office/visuals/legacy_visual.json'));
  assert.equal((await callTool('office_get_visual', {visual_id: 'legacy_visual'}, e)).visual.content, chart().content);
  const retry = await publish(e, {request_id: 'legacy', title: '旧图表'});
  assert.equal(retry.visual.id, 'legacy_visual', 'a retry of the old request is still recognised');
  assert.equal(stateObject(e).visuals.length, 2);
  assert.ok(e.BUCKET.objects.has(STATE_KEY));
});
