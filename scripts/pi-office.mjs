import {requestedVisual, visualPrompt, visualOutcome} from './visual-delivery.mjs';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

const failed = 'Agent 未能生成结果。请检查模型连接与本机服务后重试。';

// Keep the complete source ID in the digest even for older 64-character IDs.
function replyKey(agentId, queue, id) {
  return createHash('sha256')
    .update(agentId + '/' + queue + '/' + id)
    .digest('hex');
}

function bounded(text, limit) {
  if (text.length <= limit) return text;
  return text.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, '') + '…';
}

function chatPrompt(message, history, shared) {
  const context = history.map(m => ({speaker: m.authorName || m.role, text: bounded(m.content, 1000)}));
  return [
    shared ? '请在办公室公共频道回答用户对你的点名。' : '请回答用户给你的私聊。',
    '以下 JSON 是对话数据。只报告你实际执行的操作，直接回答当前用户，最多 4000 字符。',
    JSON.stringify({context, quoted: message.replyPreview?.content, message: message.content})
  ].join('\n');
}

function taskOutcome(text) {
  // Fenced JSON is also common with local models.
  const raw = text.replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1');
  try {
    const {status, result} = JSON.parse(raw);
    if (['done', 'paused'].includes(status) && typeof result === 'string' && result.trim())
      return {status, result: bounded(result.trim(), 2000)};
  } catch {
    // Preserve the model's answer for the operator without claiming completion.
  }
  return {status: 'paused', result: bounded('Agent 未给出完成状态。\n' + text, 2000)};
}

export async function runOfficePi({
  call,
  generate,
  signal = new AbortController().signal,
  agentId = 'pi-local',
  name = 'Pi（本机）',
  model = 'Pi',
  role = '本机 Pi 助手',
  guardTaskUpdates = true,
  guardVisualTasks = true,
  visualsEnabled = true,
  reportVisualSteps = true,
  pollMs = 4000,
  heartbeatMs = 45000,
  onReady,
  onError = console.error
}) {
  const office = (tool, args = {}) => call(tool, {agent_id: agentId, ...args});
  const register = () => office('office_register_agent', {name, model, role});
  // Keep one unpublished result per queue so a failed office write can be
  // retried without another model call or another run of its local tools.
  const drafts = {};
  let status = 'resting';
  const heartbeat = () => office('office_heartbeat', {status});
  // A slow heartbeat must not queue a stale "working" update after a reply.
  let sending = Promise.resolve();
  function pulse() {
    sending = sending.catch(() => {}).then(heartbeat);
    return sending;
  }

  async function answer(queue, key, prompt, kind, request) {
    signal.throwIfAborted();
    if (drafts[queue]?.key === key) return drafts[queue].value;
    const task = queue === 'task';
    status = task ? 'working' : 'thinking';
    try {
      await pulse();
    } catch (error) {
      status = 'resting';
      throw error;
    }
    try {
      const useWorkspace = !kind && queue !== 'channel';
      const text = (await generate(prompt, {signal, useWorkspace, request: useWorkspace ? request : undefined})).trim();
      signal.throwIfAborted();
      if (!text) throw new Error('模型返回了空内容。');
      const value = kind ? visualOutcome(kind, text) : task ? taskOutcome(text) : {result: bounded(text, 4000)};
      drafts[queue] = {key, value};
    } catch (error) {
      signal.throwIfAborted();
      onError(error);
      drafts[queue] = {key, value: {status: 'paused', result: failed}};
    } finally {
      status = 'resting';
    }
    return drafts[queue].value;
  }

  async function deliver(queue, id, request, prompt, kind = requestedVisual(request)) {
    if (!kind) return answer(queue, id, prompt, null, request);
    if (!visualsEnabled) return {status: 'paused', result: '此办公室尚未提供成果发布接口。'};
    const isTask = queue === 'task';
    const link = isTask ? {task_id: id} : {message_id: id};
    const request_id = replyKey(agentId, 'visual-' + queue, id);
    // These records contain observable publication outcomes only. In
    // particular a private prompt or a model diagnostic never goes in the shared log.
    const recordStep = (status, title) =>
      reportVisualSteps &&
      office('office_report_step', {
        ...link,
        request_id: replyKey(agentId, 'visual-step-' + status + '-' + queue, id),
        status,
        title,
        ...(status === 'completed' && {tool_name: 'office_publish_visual'})
      });
    const {visuals} = await office('office_list_visuals', link);
    // Recover after a publication succeeded but the reply or task write did
    // not, including across runner restarts and changes to the model profile.
    let visual = visuals.find(v => v.requestId === request_id);
    if (!visual) {
      let tasks;
      if (drafts[queue]?.key !== id && /当前.{0,4}任务|我的任务|我负责的任务|(?:current|assigned) tasks/i.test(request))
        ({tasks} = await office('office_list_tasks'));
      const outcome = await answer(queue, id, visualPrompt(kind, request, tasks), kind);
      if (isTask && !(await taskActive(id))) return null;
      if (!outcome.visual) {
        await recordStep('failed', '本次请求未生成可发布的成果');
        return outcome;
      }
      signal.throwIfAborted();
      ({visual} = await office('office_publish_visual', {
        ...outcome.visual,
        ...link,
        request_id,
        ...(isTask && guardVisualTasks && {require_active_task: true})
      }));
    }
    await recordStep('completed', '已发布《' + visual.title + '》');
    return {status: 'done', result: '已发布《' + visual.title + '》，可在成果区查看。'};
  }

  async function taskActive(id) {
    const {tasks} = await office('office_list_tasks', {status: 'active'});
    return tasks.some(t => t.id === id);
  }

  async function privateMessage() {
    const {messages} = await office('office_get_messages');
    const index = messages.findIndex(m => m.role === 'user' && !m.replyId);
    if (index < 0) return;
    const message = messages[index];
    const history = messages
      .slice(0, index)
      .filter(m => m.role === 'user')
      .slice(-4)
      .flatMap(m => [m, messages.find(reply => reply.id === m.replyId)].filter(Boolean));
    const request_id = replyKey(agentId, 'private', message.id);
    const {result: content} = await deliver(
      'private',
      message.id,
      message.content,
      chatPrompt(message, history, false)
    );
    await office('office_reply_message', {request_id, message_id: message.id, content});
    delete drafts.private;
    await pulse();
  }

  async function channelMessage() {
    // Read retained replies as well as new mentions: an earlier post can have
    // succeeded even if its acknowledgement was lost during a disconnection.
    const {messages, read_through} = await office('office_get_channel_messages', {after_sequence: 0});
    const index = messages.findIndex(m => m.sequence > read_through && m.mentions.includes(agentId));
    if (index < 0) return;
    const message = messages[index];
    const request_id = replyKey(agentId, 'channel', message.id);
    if (message.authorType === 'user' && !messages.some(m => m.authorId === agentId && m.replyTo === message.id)) {
      const history = messages.slice(Math.max(0, index - 4), index);
      const {result: content} = await deliver(
        'channel',
        message.id,
        message.content,
        chatPrompt(message, history, true)
      );
      await office('office_post_channel_message', {request_id, reply_to: message.id, content});
      await pulse();
    }
    await office('office_ack_channel', {through_sequence: message.sequence});
    delete drafts.channel;
  }

  async function workTask() {
    // Omitting task_id lets the office select high priority first, or return
    // the active task. Specifying a previously queued ID could resume a pause.
    const {task} = await office('office_claim_task');
    if (!task) return;
    const prompt = [
      '请处理分配给你的办公室任务。如果完成任务需要当前未提供的工具或材料，请说明缺少什么并返回 paused。只报告实际完成的工作。',
      '完成后输出 JSON {"status":"done","result":"实际交付结果"}。遇到阻塞请用 paused，并写明原因。result 最多 2000 字符。',
      JSON.stringify({title: task.title, description: task.description})
    ].join('\n');
    const fields = [task.title, task.description].filter(Boolean);
    const outcome = await deliver('task', task.id, fields.join('\n'), prompt, requestedVisual(...fields));
    if (outcome && (await taskActive(task.id))) {
      await office('office_update_task', {
        task_id: task.id,
        ...outcome,
        ...(guardTaskUpdates && {expected_status: 'active'})
      });
    }
    delete drafts.task;
    await pulse();
  }

  if (signal.aborted) return;
  await register();
  onReady?.();
  let timerPending = false;
  const timer = setInterval(() => {
    if (timerPending || signal.aborted) return;
    timerPending = true;
    pulse()
      .catch(onError)
      .finally(() => {
        timerPending = false;
      });
  }, heartbeatMs);
  try {
    while (!signal.aborted) {
      try {
        const state = await call('office_get_state', {});
        if (signal.aborted) break;
        if (!state.agents.some(a => a.id === agentId)) await register();
        const queues = [];
        if (state.chatPending[agentId]) queues.push(privateMessage);
        if (state.channelPending[agentId]) queues.push(channelMessage);
        if (state.tasks.some(t => t.agentId === agentId && ['active', 'queued'].includes(t.status)))
          queues.push(workTask);
        for (const processQueue of queues) {
          if (signal.aborted) break;
          try {
            await processQueue();
          } catch (error) {
            if (!signal.aborted) onError(error);
          }
        }
      } catch (error) {
        if (signal.aborted) break;
        onError(error);
      }
      await delay(pollMs, undefined, {signal});
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    clearInterval(timer);
    await sending.catch(() => {});
  }
}
