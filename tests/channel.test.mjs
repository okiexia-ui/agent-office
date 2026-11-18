import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createWorker, callTool, seedState} from '../worker/index.js';
import {mentionedAgents} from '../public/channel.js';
import {MemoryBucket} from './memory-bucket.mjs';

const environment = () => ({BUCKET: new MemoryBucket()});
const worker = createWorker(),
  origin = 'https://office.test';
const request = (path, body, method = body ? 'POST' : 'GET', headers = {}) =>
  new Request(origin + path, {
    method,
    headers: {'Content-Type': 'application/json', ...headers},
    ...(body ? {body: JSON.stringify(body)} : {})
  });
const office = env => callTool('office_get_state', {}, env);
const register = (env, agent_id = 'codex') =>
  callTool('office_register_agent', {agent_id, name: agent_id, model: 'Codex'}, env);
const read = (env, agent_id = 'hermes', args = {}) => callTool('office_get_channel_messages', {agent_id, ...args}, env);
const post = (env, agent_id, request_id, extra = {}) =>
  callTool('office_post_channel_message', {agent_id, request_id, content: '一起讨论实现与验收。', ...extra}, env);
const ack = (env, agent_id, through_sequence) => callTool('office_ack_channel', {agent_id, through_sequence}, env);
const human = (env, requestId, extra = {}) =>
  worker.fetch(request('/api/channel', {requestId, content: '请一起讨论分工。', ...extra}), env);

test('Agents discuss a shared task, quote replies, notify one another, and acknowledge separately', async () => {
  const env = environment();
  await register(env);
  const {task} = await callTool('office_create_task', {agent_id: 'hermes', request_id: 'work', title: '共同验收'}, env);
  const a = await post(env, 'hermes', 'ask', {mentions: ['codex'], task_id: task.id});
  assert.equal(a.message.authorName, 'Hermes');
  assert.equal(a.message.authorType, 'agent');
  const heartbeat = await callTool('office_heartbeat', {agent_id: 'codex'}, env);
  assert.equal(heartbeat.channel_pending, 1);
  assert.deepEqual(heartbeat.channel_message_ids, [a.message.id]);
  const inbox = await read(env, 'codex', {mentions_only: true});
  assert.deepEqual(
    inbox.messages.map(m => m.id),
    [a.message.id]
  );
  assert.equal((await read(env, 'codex')).channel_pending, 1, 'reading does not acknowledge');
  const b = await post(env, 'codex', 'answer', {reply_to: a.message.id, content: '我来检查边界情况。'});
  assert.deepEqual(b.message.mentions, ['hermes']);
  assert.equal(b.message.taskId, task.id);
  assert.deepEqual(b.message.replyPreview, {authorName: 'Hermes', content: a.message.content});
  const c = await post(env, 'hermes', 'followup', {
    reply_to: b.message.id,
    content: '我负责实现，我们在这里汇总结果。'
  });
  assert.deepEqual(c.message.mentions, ['codex']);
  assert.equal((await read(env, 'codex')).channel_pending, 2);
  const handled = await ack(env, 'codex', inbox.latest_sequence);
  assert.equal(handled.channel_pending, 1, 'new messages survive an older acknowledgement');
  await ack(env, 'hermes', c.message.sequence);
  assert.equal((await read(env)).channel_pending, 0);
  await ack(env, 'codex', c.message.sequence);
  assert.equal((await read(env, 'codex')).messages.length, 0);
  const log = await (await worker.fetch(request('/api/channel'), env)).json();
  assert.equal(log.messages.length, 3);
  assert.deepEqual(
    log.messages.map(m => m.sequence),
    [1, 2, 3]
  );
  assert.equal((await read(env, 'codex', {after_sequence: 0})).messages.length, 3);
});

test('People participate in public work discussion without forging an Agent identity or leaking private chat', async () => {
  const env = environment();
  await register(env);
  await worker.fetch(request('/api/chat', {requestId: 'private', agentId: 'hermes', content: '私聊内容'}), env);
  const response = await human(env, 'public', {mentions: ['codex']});
  assert.equal(response.status, 201);
  const {message} = await response.json();
  assert.equal(message.authorType, 'user');
  assert.equal(message.authorId, null);
  assert.equal(message.authorName, '你');
  assert.equal((await office(env)).agents.find(a => a.id === 'hermes').lastSeen, null);
  assert.equal((await read(env)).messages.length, 1);
  assert.equal((await read(env)).messages[0].id, message.id);
  assert.equal((await callTool('office_get_messages', {agent_id: 'hermes'}, env)).messages.length, 1);
  const state = await office(env);
  assert.equal(state.channelPending.codex, 1);
  assert.equal(state.chatPending.hermes, 1);
  assert.equal('channelMessages' in state, false);
  assert.equal('channelReads' in state, false);
  assert.equal((await human(env, 'forged', {authorId: 'codex'})).status, 400);
  assert.equal((await human(env, 'forged-role', {authorType: 'agent'})).status, 400);
});

test('Concurrent retries are idempotent and changed authors, targets, replies, tasks or content conflict', async () => {
  const env = environment();
  await register(env);
  const results = await Promise.all([
    post(env, 'hermes', 'same', {mentions: ['codex']}),
    post(env, 'hermes', 'same', {mentions: ['codex']})
  ]);
  assert.equal(results[0].message.id, results[1].message.id);
  assert.equal((await read(env)).messages.length, 1);
  const retry = await post(env, 'hermes', 'same', {mentions: ['codex', 'codex']});
  assert.equal(retry.message.id, results[0].message.id);
  for (const extra of [
    {content: 'changed', mentions: ['codex']},
    {mentions: []},
    {mentions: ['codex'], reply_to: results[0].message.id},
    {mentions: ['codex'], task_id: 'different'}
  ]) {
    await assert.rejects(post(env, 'hermes', 'same', extra), /already belongs/);
  }
  await assert.rejects(post(env, 'codex', 'same', {mentions: ['codex']}), /already belongs/);
  assert.equal((await human(env, 'same')).status, 409);
});

test('Concurrent channel posts, private messages, and heartbeats preserve each other', async () => {
  const env = environment();
  await register(env);
  const results = await Promise.all([
    post(env, 'hermes', 'a', {mentions: ['codex']}),
    post(env, 'codex', 'b', {mentions: ['hermes']}),
    human(env, 'c'),
    callTool('office_heartbeat', {agent_id: 'hermes', status: 'thinking'}, env),
    worker.fetch(request('/api/chat', {requestId: 'd', agentId: 'codex', content: '私聊'}), env)
  ]);
  assert.equal(results[2].status, 201);
  assert.equal(results[4].status, 201);
  const log = await read(env);
  assert.deepEqual(
    log.messages.map(m => m.sequence),
    [1, 2, 3]
  );
  assert.equal(new Set(log.messages.map(m => m.id)).size, 3);
  assert.equal(log.channel_pending, 1);
  const state = await office(env);
  assert.equal(state.agents.find(a => a.id === 'hermes').status, 'thinking');
  assert.equal(state.chatPending.codex, 1);
});

test('State saves preserve channel content and cursors; historical author snapshots survive member removal', async () => {
  const env = environment();
  await register(env);
  const before = await office(env);
  const first = await post(env, 'codex', 'original', {mentions: ['hermes']});
  await ack(env, 'hermes', 1);
  assert.equal((await worker.fetch(request('/api/state', before, 'PUT'), env)).status, 409);
  const current = await office(env);
  current.channelMessages = [];
  current.channelReads = {};
  current.channelSequence = 0;
  current.agents = current.agents.filter(a => a.id !== 'codex');
  current.agents[0].seatId = 'desk-16';
  assert.equal((await worker.fetch(request('/api/state', current, 'PUT'), env)).status, 200);
  const history = await read(env, 'hermes', {after_sequence: 0});
  assert.equal(history.read_through, 1);
  assert.equal(history.messages[0].authorName, 'codex');
  assert.equal(history.messages[0].id, first.message.id);
  const answer = await post(env, 'hermes', 'after-removal', {reply_to: first.message.id});
  assert.deepEqual(answer.message.mentions, []);
});

test('Channel validation rejects invalid recipients, missing references, malformed sequences and cross-origin writes', async () => {
  const env = environment();
  await assert.rejects(post(env, 'missing', 'author'), /not found/);
  await assert.rejects(post(env, 'hermes', 'target', {mentions: ['missing']}), /not found/);
  await assert.rejects(post(env, 'hermes', 'parent', {reply_to: 'missing'}), /no longer available/);
  await assert.rejects(post(env, 'hermes', 'task', {task_id: 'missing'}), /Task not found/);
  await assert.rejects(post(env, 'hermes', 'array', {mentions: 'hermes'}), /at most 16/);
  await assert.rejects(post(env, 'hermes', 'too-many', {mentions: Array(17).fill('hermes')}), /at most 16/);
  await assert.rejects(post(env, 'hermes', 'empty', {content: ' '}), /characters/);
  await assert.rejects(post(env, 'hermes', 'long', {content: 'x'.repeat(4001)}), /characters/);
  assert.equal((await human(env, 'long', {content: 'x'.repeat(2001)})).status, 400);
  await assert.rejects(read(env, 'hermes', {mentions_only: 'true'}), /boolean/);
  for (const sequence of [-1, 0.5, '1', null]) await assert.rejects(ack(env, 'hermes', sequence), /integer/);
  await assert.rejects(ack(env, 'hermes', 1), /future/);
  await assert.rejects(read(env, 'hermes', {after_sequence: -1}), /integer/);
  const cross = await worker.fetch(
    request('/api/channel', {requestId: 'cross', content: 'x'}, 'POST', {Origin: 'https://other.test'}),
    env
  );
  assert.equal(cross.status, 403);
  assert.equal((await read(env)).messages.length, 0);
});

test('Only mentions and replies notify peers, acknowledgements are monotonic, and special IDs remain valid', async () => {
  const env = environment();
  await register(env, '__proto__');
  await register(env, 'constructor');
  await post(env, 'hermes', 'broadcast');
  assert.equal((await read(env, '__proto__')).channel_pending, 0);
  await post(env, '__proto__', 'self', {mentions: ['__proto__', 'constructor']});
  assert.equal((await read(env, '__proto__')).channel_pending, 0);
  assert.equal((await read(env, 'constructor')).channel_pending, 1);
  const result = await ack(env, 'constructor', 2);
  assert.equal(result.read_through, 2);
  assert.equal(result.channel_pending, 0);
  assert.equal((await ack(env, 'constructor', 1)).read_through, 2);
  assert.equal((await ack(env, '__proto__', 2)).read_through, 2);
  assert.equal((await read(env, '__proto__')).read_through, 2);
});

test('Retention keeps 200 messages with monotonic cursors and reports missing older history', async () => {
  const env = environment();
  let first;
  for (let n = 1; n <= 205; n++) {
    const result = await post(env, 'hermes', 'entry_' + n);
    if (n === 1) first = result.message;
  }
  const log = await read(env);
  assert.equal(log.messages.length, 200);
  assert.equal(log.first_sequence, 6);
  assert.equal(log.latest_sequence, 205);
  assert.equal(log.history_truncated, true);
  assert.equal((await read(env, 'hermes', {after_sequence: 5})).history_truncated, false);
  const recent = await read(env, 'hermes', {after_sequence: 204});
  assert.equal(recent.messages.length, 1);
  assert.equal(recent.messages[0].sequence, 205);
  await assert.rejects(post(env, 'hermes', 'expired-reply', {reply_to: first.id}), /no longer available/);
  await ack(env, 'hermes', 205);
  assert.equal((await read(env)).messages.length, 0);
});

test('Older office snapshots gain an empty public channel without changing existing members or tasks', async () => {
  const env = environment(),
    old = seedState();
  delete old.channelMessages;
  delete old.channelReads;
  delete old.channelSequence;
  env.BUCKET.value = JSON.stringify(old);
  env.BUCKET.etag = 'old';
  assert.equal((await read(env)).messages.length, 0);
  assert.equal((await read(env)).read_through, 0);
  await post(env, 'hermes', 'migrated');
  assert.equal((await read(env)).messages[0].sequence, 1);
  assert.equal((await office(env)).agents[0].id, 'hermes');
});

test('Typed mentions handle Chinese, stable IDs, punctuation and regex characters without matching name prefixes', () => {
  const agents = [
    {id: 'codex', name: '代码搭子'},
    {id: 'review', name: 'A+B (QA)'},
    {id: 'short', name: 'Code'}
  ];
  assert.deepEqual(mentionedAgents('@代码搭子，先评审。 @A+B (QA)：请验收。', agents), ['codex', 'review']);
  assert.deepEqual(mentionedAgents('请问 @codex 进展？ @Code 也看看。', agents), ['codex', 'short']);
  assert.deepEqual(mentionedAgents('请@代码搭子看看，再请@review核对。', agents), ['codex', 'review']);
  assert.deepEqual(mentionedAgents('mail@codex.com @CodeExtra @AAB (QA)', agents), []);
});
