import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {runOfficePi} from '../scripts/pi-office.mjs';
import {requestedVisual} from '../scripts/visual-delivery.mjs';
import {callTool, createWorker} from '../worker/index.js';
import {MemoryBucket} from './memory-bucket.mjs';

const agent_id = 'pi-local';

test('visual publishing requires a command or an explicit publication request', () => {
  assert.equal(requestedVisual('@Pi /visual chart 一月 5，二月 6'), 'chart');
  assert.equal(requestedVisual('请把这份报告发布到共享成果区'), 'document');
  for (const text of [
    '帮我写一份文档',
    '请解释“发布到成果区”如何操作，写成文档',
    '不要把表格发布到成果区',
    '如何将文档发布到 Visual？',
    '请解读发布到成果区的图表',
    '发布到成果区是否安全？这份文档是私密的',
    '请参考如下例句：把这份文档发布到成果区',
    '把文档发布到成果区，等我确认后再操作',
    '请把表格发布到成果区。\n先别发，等我确认。',
    '请将报告发布到成果区：仅供私聊。'
  ])
    assert.equal(requestedVisual(text), null);
});

async function fixture() {
  const env = {BUCKET: new MemoryBucket()};
  const office = (tool, args = {}) => callTool(tool, args, env);
  await office('office_register_agent', {agent_id});
  const human = async (path, body) => {
    const req = new Request('http://localhost/api/' + path, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body)
    });
    const response = await createWorker().fetch(req, env);
    assert.equal(response.status, 201);
    return (await response.json()).message;
  };
  return {office, human};
}

// Cancel between polling passes once the real worker state meets the condition.
async function run({office, generate, finished, intercept, heartbeatMs, model, guardTaskUpdates, pollMs = 1}) {
  const controller = new AbortController();
  const errors = [];
  const call = async (name, args) => {
    const invoke = () => office(name, args);
    const value = intercept ? await intercept(name, args, invoke) : await invoke();
    if (name === 'office_get_state' && finished(value)) controller.abort();
    return value;
  };
  const deadline = setTimeout(() => controller.abort(new Error('Test timed out')), 3000);
  try {
    await runOfficePi({
      call,
      generate,
      signal: controller.signal,
      pollMs,
      heartbeatMs,
      model,
      guardTaskUpdates,
      onError: e => errors.push(e.message)
    });
    assert.notEqual(controller.signal.reason?.message, 'Test timed out');
    return errors;
  } finally {
    clearTimeout(deadline);
  }
}

test('Pi handles only its direct messages, user mentions and assigned tasks; preserves chat context', async () => {
  const {office, human} = await fixture();
  await human('chat', {agentId: 'hermes', requestId: 'remote', content: 'only for Hermes'});
  await human('chat', {agentId: agent_id, requestId: 'one', content: 'remember lima'});
  await human('chat', {agentId: agent_id, requestId: 'two', content: 'previous word?'});
  await office('office_post_channel_message', {
    agent_id: 'hermes',
    request_id: 'mention_from_agent',
    mentions: [agent_id],
    content: 'agent chatter'
  });
  const mention = await human('channel', {requestId: 'group', content: 'public question', mentions: [agent_id]});
  const {task} = await office('office_create_task', {agent_id, request_id: 'assignment', title: 'work item'});
  await office('office_create_task', {agent_id: 'hermes', request_id: 'remote_task', title: 'unrelated task'});
  const prompts = [];
  const errors = await run({
    office,
    generate: async prompt => {
      prompts.push(prompt);
      if (prompt.includes('work item')) return JSON.stringify({status: 'done', result: 'finished the work'});
      if (prompt.includes('previous word?')) {
        assert.match(prompt, /remember lima/);
        assert.match(prompt, /recorded word/);
        return 'lima';
      }
      return prompt.includes('public question') ? 'group answer' : 'recorded word';
    },
    finished: s =>
      !s.chatPending[agent_id] && !s.channelPending[agent_id] && s.tasks.find(t => t.id === task.id).status === 'done'
  });
  assert.deepEqual(errors, []);
  assert.equal(prompts.length, 4);
  const state = await office('office_get_state');
  assert.equal(state.agents.find(a => a.id === agent_id).model, 'Pi');
  assert.equal(state.chatPending.hermes, 1);
  assert.equal(state.tasks.find(t => t.id === task.id).result, 'finished the work');
  assert.equal(state.tasks.find(t => t.agentId === 'hermes').status, 'queued');
  const channel = await office('office_get_channel_messages', {agent_id, after_sequence: 0});
  const replies = channel.messages.filter(m => m.authorId === agent_id);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].replyTo, mention.id);
});

test('Pi reuses a generated reply after a failed write and acknowledges an already committed channel reply', async () => {
  const {office, human} = await fixture();
  await human('chat', {agentId: agent_id, requestId: 'one', content: 'message'});
  await human('channel', {requestId: 'two', content: 'mention', mentions: [agent_id]});
  const generated = [],
    attempted = new Set();
  const errors = await run({
    office,
    generate: async prompt => {
      generated.push(prompt);
      return 'answer ' + generated.length;
    },
    finished: s => !s.chatPending[agent_id] && !s.channelPending[agent_id],
    intercept: async (name, args, invoke) => {
      if (!attempted.has(name)) {
        attempted.add(name);
        if (name === 'office_reply_message') throw new Error('connection interrupted');
        if (name === 'office_post_channel_message') {
          await invoke();
          throw new Error('response lost');
        }
      }
      return invoke();
    }
  });
  assert.deepEqual(errors, ['connection interrupted', 'response lost']);
  assert.equal(generated.length, 2);
  const {messages} = await office('office_get_channel_messages', {agent_id, after_sequence: 0});
  assert.equal(messages.filter(m => m.authorId === agent_id).length, 1);
});

test('Pi sends working heartbeats during generation and preserves a concurrent operator pause', async () => {
  const {office} = await fixture();
  const {task} = await office('office_create_task', {agent_id, request_id: 'pause', title: 'pause while running'});
  let beats = 0;
  await run({
    office,
    heartbeatMs: 5,
    finished: s => s.tasks[0].status === 'paused',
    generate: async () => {
      await delay(35);
      await office('office_update_task', {agent_id, task_id: task.id, status: 'paused', result: 'operator paused'});
      return '{"status":"done","result":"late result"}';
    },
    intercept: (name, args, invoke) => {
      if (name === 'office_heartbeat' && args.status === 'working') beats++;
      return invoke();
    }
  });
  assert.ok(beats >= 2);
  const {tasks} = await office('office_list_tasks', {agent_id});
  assert.equal(tasks[0].result, 'operator paused');
});

test('generation failures pause tasks without leaking diagnostics or marking work done', async () => {
  const {office} = await fixture();
  await office('office_create_task', {agent_id, request_id: 'failure', title: 'cannot run'});
  const errors = await run({
    office,
    generate: async () => {
      throw new Error('local model details');
    },
    finished: s => s.tasks[0].status === 'paused'
  });
  assert.deepEqual(errors, ['local model details']);
  const {tasks} = await office('office_list_tasks', {agent_id});
  assert.match(tasks[0].result, /未能生成结果/);
  assert.doesNotMatch(tasks[0].result, /local model details/);
  assert.equal(tasks[0].progress, 0);
});

test('legacy offices can use an available model label and omit conditional task updates', async () => {
  const {office} = await fixture();
  await office('office_create_task', {agent_id, request_id: 'remote', title: 'blocked work'});
  const errors = await run({
    office,
    model: 'DeepSeek',
    guardTaskUpdates: false,
    finished: s => s.tasks[0].status === 'paused',
    generate: async () => '{"status":"paused","result":"缺少输入文件"}',
    intercept: (name, args, invoke) => {
      if (name === 'office_update_task') assert.ok(!('expected_status' in args));
      return invoke();
    }
  });
  assert.deepEqual(errors, []);
  const state = await office('office_get_state');
  const agent = state.agents.find(a => a.id === agent_id);
  assert.equal(agent.name, 'Pi（本机）');
  assert.equal(agent.model, 'DeepSeek');
  assert.equal(state.tasks[0].result, '缺少输入文件');
});

test('an operator pause immediately before the completion write wins atomically', async () => {
  const {office} = await fixture();
  const {task} = await office('office_create_task', {agent_id, request_id: 'race', title: 'late pause'});
  const errors = await run({
    office,
    finished: s => s.tasks[0].status === 'paused',
    generate: async () => '{"status":"done","result":"late answer"}',
    intercept: async (name, args, invoke) => {
      if (name === 'office_update_task') {
        assert.equal(args.expected_status, 'active');
        await office(name, {agent_id, task_id: task.id, status: 'paused', result: 'user paused'});
      }
      return invoke();
    }
  });
  assert.equal(errors.length, 1);
  const {tasks} = await office('office_list_tasks', {agent_id});
  assert.equal(tasks[0].result, 'user paused');
  assert.equal(tasks[0].status, 'paused');
});

test('two managed agents reply independently to a shared mention under their registered names', async () => {
  const {office, human} = await fixture();
  const profiles = [
    {agentId: 'writer', name: 'Writer'},
    {agentId: 'reader', name: 'Reader'}
  ];
  for (const {agentId} of profiles) await office('office_register_agent', {agent_id: agentId});
  const original = await human('channel', {
    requestId: 'both',
    content: 'Report in',
    mentions: profiles.map(p => p.agentId)
  });
  let registrations = 0;
  await Promise.all(
    profiles.map(async profile => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error('test deadline')), 2500);
      try {
        await runOfficePi({
          ...profile,
          signal: controller.signal,
          role: 'custom role',
          pollMs: 5,
          onReady: () => registrations++,
          call: async (name, args) => {
            const result = await office(name, args);
            if (name === 'office_ack_channel') controller.abort();
            return result;
          },
          generate: async () => 'Here: ' + profile.name
        });
        assert.notEqual(controller.signal.reason?.message, 'test deadline');
      } finally {
        clearTimeout(timeout);
      }
    })
  );
  const state = await office('office_get_state');
  const {messages} = await office('office_get_channel_messages', {agent_id: 'reader', after_sequence: 0});
  assert.equal(registrations, 2);
  for (const {agentId, name} of profiles) {
    assert.equal(state.agents.find(a => a.id === agentId).name, name);
    assert.ok(messages.some(m => m.authorId === agentId && m.replyTo === original.id && m.content === 'Here: ' + name));
  }
});

test('explicit Visual requests deliver all four kinds to the addressed source; private history stays out of published prompts', async () => {
  const {office, human} = await fixture();
  const requests = [
    {
      where: 'chat',
      kind: 'document',
      title: '发布说明',
      content: '# 本周更新',
      request: '请将下方的发布说明文档发布到成果区：本周更新'
    },
    {
      where: 'channel',
      kind: 'chart',
      title: '销售图表',
      content: {labels: ['A', 'B'], values: [2, 3]},
      request: '@pi-local /visual chart A=2 B=3'
    },
    {
      where: 'task',
      kind: 'table',
      title: '任务表格',
      content: {columns: ['事项', '件数'], rows: [['审校', 2]]},
      request: '请制作表格，发布到成果区：审校 2 件'
    },
    {
      where: 'chat',
      kind: 'html',
      title: '计数器',
      content: '<button onclick="this.textContent=1">0</button>',
      request: '请做一个交互 HTML 小工具，发布到 Visual。'
    }
  ];
  await human('chat', {agentId: agent_id, requestId: 'privateHistory', content: '私密草稿甲，请写一份文档'});
  for (const [i, r] of requests.entries()) {
    if (r.where === 'task')
      r.id = (await office('office_create_task', {agent_id, request_id: 'v' + i, title: r.request})).task.id;
    else
      r.id = (
        await human(r.where, {
          ...(r.where === 'chat' ? {agentId: agent_id} : {mentions: [agent_id]}),
          requestId: 'v' + i,
          content: r.request
        })
      ).id;
  }
  const errors = await run({
    office,
    generate: async prompt => {
      if (!prompt.includes('共享成果区')) return '私密答复乙';
      assert.doesNotMatch(prompt, /私密草稿甲|私密答复乙/);
      const request = requests.find(r => prompt.includes(r.request));
      assert.ok(request);
      return JSON.stringify({
        title: request.title,
        content: request.content,
        agent_id: 'hermes',
        message_id: 'attempt-to-change-scope'
      });
    },
    finished: s => !s.chatPending[agent_id] && !s.channelPending[agent_id] && s.tasks[0].status === 'done'
  });
  assert.deepEqual(errors, []);
  const {visuals} = await office('office_list_visuals', {agent_id});
  assert.equal(visuals.length, 4);
  const {steps} = await office('office_get_steps', {agent_id});
  assert.equal(steps.length, 4);
  assert.ok(steps.every(step => step.status === 'completed' && step.toolName === 'office_publish_visual'));
  for (const r of requests) {
    const meta = visuals.find(v => v.kind === r.kind);
    assert.equal(meta.title, r.title);
    assert.equal(meta[r.where === 'task' ? 'taskId' : 'messageId'], r.id);
    assert.equal(meta.agentId, agent_id);
    const {visual} = await office('office_get_visual', {visual_id: meta.id});
    assert.deepEqual(typeof r.content === 'string' ? visual.content : JSON.parse(visual.content), r.content);
  }
});

test('a bad visual or insufficient input gives actionable feedback and does not report completion', async () => {
  const {office, human} = await fixture();
  await office('office_create_task', {agent_id, request_id: 'bad_chart', title: '/visual chart A=5'});
  await human('chat', {agentId: agent_id, requestId: 'missing', content: '/visual table 用户并未提供数据'});
  const errors = await run({
    office,
    generate: async prompt =>
      prompt.includes('A=5')
        ? '{"title":"错误数据","content":{"labels":["A"],"values":[null]}}'
        : '{"need":"请提供原始清单。"}',
    finished: s => s.tasks[0].status === 'paused' && !s.chatPending[agent_id]
  });
  assert.deepEqual(errors, []);
  const {tasks} = await office('office_list_tasks', {agent_id});
  assert.match(tasks[0].result, /格式无效/);
  const {messages} = await office('office_get_messages', {agent_id});
  assert.match(messages[1].content, /请提供原始清单/);
  const {steps} = await office('office_get_steps', {agent_id});
  assert.equal(steps.length, 2);
  assert.ok(steps.every(step => step.status === 'failed' && !step.toolName));
  assert.equal((await office('office_list_visuals', {})).visuals.length, 0);
});

test('a retained publication is reused after the runner restarts between publishing and replying', async () => {
  const {office, human} = await fixture();
  const message = await human('chat', {agentId: agent_id, requestId: 'publish', content: '/visual document 整理说明'});
  const first = new AbortController();
  let generated = 0;
  const generate = async () => {
    generated++;
    return '{"title":"说明","content":"文档正文"}';
  };
  await runOfficePi({
    signal: first.signal,
    generate,
    pollMs: 1,
    call: async (name, args) => {
      const res = await office(name, args);
      if (name === 'office_publish_visual') {
        first.abort();
        throw Error('lost response');
      }
      return res;
    }
  });
  assert.equal((await office('office_get_state', {})).chatPending[agent_id], 1);
  let dropStepAck = true;
  const errors = await run({
    office,
    generate,
    finished: s => !s.chatPending[agent_id],
    intercept: async (name, args, invoke) => {
      const res = await invoke();
      if (name === 'office_report_step' && dropStepAck) {
        dropStepAck = false;
        throw Error('lost step response');
      }
      return res;
    }
  });
  assert.deepEqual(errors, ['lost step response']);
  assert.equal((await office('office_get_steps', {agent_id})).steps.length, 1);
  assert.equal(generated, 1);
  const {visuals} = await office('office_list_visuals', {agent_id, message_id: message.id});
  assert.equal(visuals.length, 1);
  assert.match((await office('office_get_messages', {agent_id})).messages[1].content, /已发布《说明》/);
});

test('a pause concurrent with publication prevents the task visual from being committed', async () => {
  const {office} = await fixture();
  const {task} = await office('office_create_task', {
    agent_id,
    request_id: 'pause_visual',
    title: '/visual document 草稿'
  });
  const errors = await run({
    office,
    generate: async () => '{"title":"草稿","content":"内容"}',
    finished: s => s.tasks[0].status === 'paused',
    intercept: async (name, args, invoke) => {
      if (name === 'office_publish_visual') {
        assert.equal(args.require_active_task, true);
        await office('office_update_task', {agent_id, task_id: task.id, status: 'paused', result: '已由用户暂停'});
      }
      return invoke();
    }
  });
  assert.equal(errors.length, 1);
  assert.equal((await office('office_list_visuals', {})).visuals.length, 0);
  assert.equal((await office('office_list_tasks', {agent_id})).tasks[0].result, '已由用户暂停');
});
