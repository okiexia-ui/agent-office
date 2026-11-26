import {test} from 'node:test';
import assert from 'node:assert/strict';
import {addTask, changeTask, openTask, taskCards, taskFilters} from '../public/task-board.js';

const esc = value => String(value).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const avatar = a => `<i>${esc(a.name)}</i>`;
const office = () => ({
  revision: 3,
  agents: [
    {id: 'pi-local', name: 'Pi（本机）', status: 'resting'},
    {id: 'writer', name: '产品编辑', status: 'resting'},
    {id: 'off', name: '停用成员', status: 'resting', managedDisabled: true}
  ],
  tasks: [],
  activities: []
});

test('a task goes to one free member and leaves the original state untouched', () => {
  const state = office();
  const next = addTask(state, {title: '整理发布说明', description: '三条', agentId: 'writer', priority: 'high'});
  assert.equal(state.tasks.length, 0, 'changes are made on a copy');
  assert.equal(next.revision, 3, 'the revision is kept for the save');
  const [task] = next.tasks;
  assert.deepEqual(
    {title: task.title, agentId: task.agentId, status: task.status, progress: task.progress, priority: task.priority},
    {title: '整理发布说明', agentId: 'writer', status: 'queued', progress: 0, priority: 'high'}
  );
  assert.match(next.activities[0].text, /收到新任务/);
  assert.equal(openTask(next, 'writer'), task);
  assert.throws(() => addTask(next, {title: '再来一项', agentId: 'writer'}), /已有未完成的任务/);
  assert.throws(() => addTask(next, {title: 'x', agentId: 'off'}), /已停用/);
  assert.throws(() => addTask(next, {title: 'x', agentId: 'nobody'}), /请选择/);
});

test('pause, resume and complete follow the office page, and finished tasks stay finished', () => {
  let state = addTask(office(), {title: '整理', agentId: 'writer'});
  const id = state.tasks[0].id;
  state = changeTask(state, id, 'resume');
  assert.equal(state.tasks[0].status, 'active');
  assert.equal(state.agents[1].status, 'working');
  state = changeTask(state, id, 'pause');
  assert.equal(state.tasks[0].status, 'paused');
  assert.equal(state.agents[1].status, 'resting');
  state = changeTask(state, id, 'complete');
  assert.deepEqual([state.tasks[0].status, state.tasks[0].progress, state.agents[1].completed], ['done', 100, 1]);
  assert.equal(openTask(state, 'writer'), undefined);
  assert.equal(changeTask(state, id, 'resume'), null, 'a finished task does not reopen');
  assert.equal(changeTask(state, 'missing', 'pause'), null);
  assert.equal(changeTask(addTask(office(), {title: 'x', agentId: 'writer'}), id, 'explode'), null);
});

test('cards are ordered by stage, filtered, escaped, and offer only the actions that apply', () => {
  let state = office();
  state = addTask(state, {title: '<b>排队</b>', agentId: 'pi-local'});
  state = addTask(state, {title: '执行', agentId: 'writer'});
  state = changeTask(state, state.tasks[1].id, 'resume');
  state.tasks.push({id: 'old', title: '旧任务', agentId: 'off', status: 'paused', progress: 40, created: 1});
  const all = taskCards(state, {avatar, esc});
  assert.ok(all.indexOf('执行') < all.indexOf('&#60;b&#62;排队'), 'active before queued');
  assert.doesNotMatch(all, /<b>排队<\/b>/);
  assert.match(all, /aria-valuenow="40"/);
  assert.match(all, /成员已停用/);
  const paused = taskCards(state, {filter: 'paused', avatar, esc});
  assert.match(paused, /旧任务/);
  assert.doesNotMatch(paused, /执行/);
  assert.match(taskCards(state, {filter: 'done', avatar, esc}), /这个阶段没有任务/);
  assert.match(taskFilters(state, 'active'), /data-task-filter="active" aria-pressed="true">执行中 <b>1<\/b>/);
});
