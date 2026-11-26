// Office tasks in the unified office: the same model the full office page uses
// (one open task per member; queued → active → done, or paused), shown under the scene.
export const STAGES = {queued: '待领取', active: '执行中', paused: '已暂停', done: '已完成'};
const FILTERS = [
  ['all', '全部'],
  ['queued', '待领取'],
  ['active', '执行中'],
  ['paused', '已暂停'],
  ['done', '已完成']
];
const ORDER = {active: 0, queued: 1, paused: 2, done: 3};

export const openTask = (state, agentId) =>
  state.tasks.find(t => t.agentId === agentId && t.status === 'active') ||
  state.tasks.find(t => t.agentId === agentId && t.status !== 'done');

function when(t) {
  const at = t.status === 'done' && t.completedAt ? t.completedAt : t.created;
  if (!at) return '';
  const minutes = Math.round((Date.now() - at) / 60000);
  const ago =
    minutes < 1
      ? '刚刚'
      : minutes < 60
        ? minutes + ' 分钟前'
        : minutes < 1440
          ? Math.round(minutes / 60) + ' 小时前'
          : new Date(at).toLocaleDateString('zh-CN', {month: 'long', day: 'numeric'});
  return (t.status === 'done' && t.completedAt ? '完成于 ' : '派发于 ') + ago;
}

export function taskFilters(state, filter) {
  const count = key => (key === 'all' ? state.tasks.length : state.tasks.filter(t => t.status === key).length);
  return FILTERS.map(
    ([key, label]) =>
      `<button type="button" data-task-filter="${key}" aria-pressed="${filter === key}">${label} <b>${count(key)}</b></button>`
  ).join('');
}

export function taskCards(state, {filter = 'all', avatar, esc}) {
  const tasks = state.tasks
    .filter(t => filter === 'all' || t.status === filter)
    .slice()
    .sort((a, b) => ORDER[a.status] - ORDER[b.status] || (b.created || 0) - (a.created || 0));
  if (!tasks.length)
    return `<div class="visual-empty"><span aria-hidden="true">☐</span><h3>${state.tasks.length ? '这个阶段没有任务' : '还没有任务'}</h3><p>把一件具体的事交给一位成员，它会领取、执行，并在这里汇报进度和结果。</p></div>`;
  return tasks
    .map(t => {
      const a = state.agents.find(agent => agent.id === t.agentId);
      const progress = Math.round(t.progress || 0);
      const actions =
        t.status === 'done'
          ? ''
          : a?.managedDisabled
            ? '<span class="task-note">成员已停用，在它的「设置」里启用后继续。</span>'
            : `<button type="button" data-task-action="${t.status === 'paused' ? 'resume' : 'pause'}" data-task-id="${esc(t.id)}">${t.status === 'paused' ? '继续' : '暂停'}</button><button type="button" data-task-action="complete" data-task-id="${esc(t.id)}">标记完成</button>`;
      return `<article class="task-item is-${esc(t.status)}"><div class="task-item-top"><span class="task-stage">${STAGES[t.status] || esc(t.status)}</span>${t.priority === 'high' ? '<span class="task-priority">优先</span>' : ''}<time>${when(t)}</time></div><h3>${esc(t.title)}</h3>${t.description ? `<p>${esc(t.description)}</p>` : ''}${
        t.status === 'active' || t.status === 'paused'
          ? `<div class="task-progress" role="progressbar" aria-label="进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}"><i style="width:${progress}%"></i></div>`
          : ''
      }${t.result ? `<blockquote class="task-result"><strong>结果</strong>${esc(t.result)}</blockquote>` : ''}<div class="task-item-bottom">${
        a
          ? `<button type="button" class="task-owner" data-scene-agent="${esc(a.id)}" aria-label="打开 ${esc(a.name)} 的对话">${avatar(a)}<span>${esc(a.name)}</span></button>`
          : '<span class="task-owner">未分配</span>'
      }<span class="task-actions">${actions}</span></div></article>`;
    })
    .join('');
}

// Changes are made on a copy of the office state, which is then saved as a whole.
export function changeTask(state, id, action) {
  const next = structuredClone(state);
  const t = next.tasks.find(task => task.id === id);
  if (!t || t.status === 'done') return null;
  const a = next.agents.find(agent => agent.id === t.agentId);
  const log = text => {
    if (!a) return;
    next.activities = [{name: a.name, text, time: Date.now()}, ...(next.activities || [])].slice(0, 20);
  };
  if (action === 'complete') {
    t.status = 'done';
    t.progress = 100;
    if (a) {
      a.status = 'resting';
      a.completed = (a.completed || 0) + 1;
    }
    log(`完成了「${t.title}」`);
  } else if (action === 'pause') {
    t.status = 'paused';
    if (a) a.status = 'resting';
    log('暂停任务，休息一下');
  } else if (action === 'resume') {
    t.status = 'active';
    if (a) a.status = 'working';
    log('回到工位继续任务');
  } else return null;
  return next;
}

export function addTask(state, {title, description = '', agentId, priority = 'normal'}) {
  const next = structuredClone(state);
  const a = next.agents.find(agent => agent.id === agentId);
  if (!a) throw Error('请选择一位已连接的成员。');
  if (a.managedDisabled) throw Error('这位成员已停用，请先在它的「设置」里启用。');
  if (openTask(next, agentId)) throw Error('这位成员已有未完成的任务，请选择其他成员。');
  next.tasks.push({
    id: crypto.randomUUID(),
    title,
    description,
    agentId,
    priority,
    progress: 0,
    status: 'queued',
    created: Date.now()
  });
  next.activities = [
    {name: a.name, text: `收到新任务「${title}」`, time: Date.now()},
    ...(next.activities || [])
  ].slice(0, 20);
  return next;
}
