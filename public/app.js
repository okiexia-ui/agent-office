import {MODELS,STATUS,initialState,validState} from './data.js';
import {DESKS,assignSeats} from './layout.js';
import {AgentChat} from './chat.js';
import {ChannelChat} from './channel.js';
import {OfficeLife} from './office-life.js';

const $ = selector => document.querySelector(selector), $$ = selector => [...document.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const STORAGE_KEY = 'agent-office-state-v1';
const DEMO = new URLSearchParams(window.location.search).get('demo') === '1';
const EMBED = new URLSearchParams(location.search).get('embed') === '1' && window.parent !== window;
if(EMBED)document.body.classList.add('embedded-office');
const LOCAL = ['localhost','127.0.0.1','[::1]'].includes(window.location.hostname);
const MCP_URL = LOCAL ? window.location.origin + '/mcp' : window.location.origin + '/api/hermes/mcp';
const AWAY_AFTER = 300000;
const SMALL = matchMedia('(max-width: 860px)');
const STAGES = {queued:'待领取', active:'执行中', paused:'已暂停', done:'已完成'};
const KINDS = {...STATUS, pending:'待连接', offline:'离线'};
const FILTERS = [['all','全部'],['working','工作中'],['thinking','思考中'],['resting','休息中'],['away','未连接']];

let cloudReady = false, syncFailures = 0, saving = false, polling = false, storageAvailable = true;
const systemDark = matchMedia('(prefers-color-scheme: dark)').matches;
let state = DEMO
  ? {...initialState(), night:systemDark}
  : {version:1,revision:0,night:systemDark,paused:false,agents:[{id:'hermes',name:'Hermes',model:'Hermes',role:'等待 Hermes 连接',status:'resting',completed:0,lastSeen:null}],tasks:[],activities:[]};
try {
  if (DEMO && !EMBED) { const saved = JSON.parse(localStorage.getItem(STORAGE_KEY)); if (validState(saved)) state = saved; }
  else { const stored = localStorage.getItem('agent-office-night'); if (stored !== null) state.night = stored === '1'; }
} catch {}
let scene = null, view = 'office', teamFilter = 'all', memberFilter = 'all', taskFilter = 'all', selectedAgent = null, lastAgent = null, selectedModel = 'ChatGPT', toastTimer;
let chat = null, channel = null, officeLife = null;
state.agents = assignSeats(state.agents);

// ---- State and sync -------------------------------------------------------

function persist() {
  if (!DEMO) { try { localStorage.setItem('agent-office-night', state.night ? '1' : '0'); } catch {} return; }
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch { if (storageAvailable) { storageAvailable = false; toast('浏览器无法保存数据，本次更改只在当前页面有效'); } }
}
function toast(message) {
  clearTimeout(toastTimer);
  $('#toast span').textContent = message;
  $('#toast').classList.add('show');
  toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 3400);
}
function taskFor(id) { return state.tasks.find(t => t.agentId === id && t.status === 'active') || state.tasks.find(t => t.agentId === id && t.status !== 'done'); }
function activeTaskFor(id) { return state.tasks.find(t => t.agentId === id && t.status === 'active'); }
function relativeTime(time) {
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
  return minutes === 0 ? '刚刚' : minutes < 60 ? `${minutes} 分钟前` : minutes < 1440 ? `${Math.floor(minutes / 60)} 小时前` : `${Math.floor(minutes / 1440)} 天前`;
}
function activity(name, text) { state.activities.unshift({name, text, time:Date.now()}); state.activities = state.activities.slice(0, 20); }
function displayState(positions = true) {
  state.agents = assignSeats(state.agents);
  render();
  if (positions && scene) { scene.updateAgents(state.agents); scene.setPaused(state.paused); }
}
function acceptCloud(data) {
  if (!validState(data) || !Number.isInteger(data.revision)) throw new Error('服务器返回了无效数据');
  state = {...data, agents:assignSeats(data.agents), night:state.night, paused:false};
  cloudReady = true; syncFailures = 0;
  displayState();
}
async function syncCloud() {
  if (DEMO || polling || saving) return;
  polling = true;
  try {
    const response = await fetch('/api/state', {headers:{Accept:'application/json'}, cache:'no-store', signal:AbortSignal.timeout(8000)});
    if (!response.ok) throw new Error('云端暂时不可用');
    const data = await response.json();
    if (!saving && (data.revision ?? -1) >= (state.revision ?? -1)) acceptCloud(data);
  } catch { cloudReady = false; syncFailures++; render(); }
  finally { polling = false; }
}
async function updateState({positions = true, localOnly = false} = {}) {
  state.agents = assignSeats(state.agents);
  persist();
  if (DEMO || localOnly) { displayState(positions); return true; }
  if (!cloudReady || saving) { toast('云端尚未就绪，请稍后重试'); return false; }
  saving = true;
  const payload = structuredClone(state);
  displayState(positions);
  try {
    const response = await fetch('/api/state', {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload), signal:AbortSignal.timeout(10000)});
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(response.status === 409 ? 'Hermes 更新了办公室，请重试刚才的操作' : error.error || '保存失败');
    }
    acceptCloud(await response.json());
    return true;
  } catch (error) { toast(error.message); saving = false; await syncCloud(); return false; }
  finally { saving = false; render(); }
}

// ---- Small view helpers ---------------------------------------------------

// Only touch the DOM when markup changed, so focus, hover and scroll survive the 4-second sync.
const lastHTML = new WeakMap();
const FOCUS_KEYS = ['data-team-filter','data-member-filter','data-task-filter','data-chat','data-task-id'];
function setHTML(element, html) {
  if (lastHTML.get(element) === html) return false;
  const active = element.contains(document.activeElement) ? document.activeElement : null;
  const key = active && FOCUS_KEYS.find(attribute => active.hasAttribute(attribute));
  const selector = key && `[${key}="${CSS.escape(active.getAttribute(key))}"]`;
  lastHTML.set(element, html);
  element.innerHTML = html;
  if (selector) element.querySelector(selector)?.focus({preventScroll:true});
  return true;
}
function playEnter(element) {
  element.classList.remove('enter'); void element.offsetWidth; element.classList.add('enter');
  clearTimeout(element.enterTimer); element.enterTimer = setTimeout(() => element.classList.remove('enter'), 800);
}
function avatar(a) {
  const model = MODELS[a.model];
  return `<span class="avatar ${model.className}" style="--avatar-bg:${model.bg};--avatar-color:${model.color}" aria-hidden="true">${model.mark}</span>`;
}
// What the person sees: live status only counts while the Agent keeps reporting in.
function kind(a) {
  if (DEMO) return a.status;
  if (!a.lastSeen) return 'pending';
  return Date.now() - a.lastSeen > AWAY_AFTER ? 'offline' : a.status;
}
function presence(a) { return KINDS[kind(a)]; }
function statusTag(a) { const k = kind(a); return `<span class="status ${k}"><i></i>${KINDS[k]}</span>`; }
function matches(a, filter) { const k = kind(a); return filter === 'all' || (filter === 'away' ? k === 'pending' || k === 'offline' : k === filter); }
function chips(current, attribute) {
  return FILTERS.map(([key, label]) => {
    const count = state.agents.filter(a => matches(a, key)).length;
    if (!count && key !== 'all' && key !== current) return '';
    return `<button class="chip" data-${attribute}="${key}" aria-pressed="${key === current}">${label}<b>${count}</b></button>`;
  }).join('');
}
// The chain every task walks: dispatched → claimed → running → done.
function chain(t, labels = true) {
  const status = t.status, percent = Math.round(t.progress), claimed = status !== 'queued', done = status === 'done';
  const summary = `派发于 ${relativeTime(t.created)}，${STAGES[status]}${claimed && !done ? ` ${percent}%` : ''}`;
  const names = labels ? `<span>派发</span><span class="${claimed ? '' : 'on'}">${claimed ? '领取' : '待领取'}</span><span class="${claimed && !done ? 'on' : ''}">${status === 'paused' ? `暂停 ${percent}%` : status === 'active' ? `执行 ${percent}%` : '执行'}</span><span class="${done ? 'on' : ''}">完成</span>` : '';
  return `<div class="chain is-${status}" style="--p:${claimed ? percent : 0}" role="img" aria-label="${esc(summary)}"><i class="chain-node done"></i><i class="chain-seg ${claimed ? 'done' : 'waiting'}"></i><i class="chain-node ${claimed ? 'done' : 'current'}"></i><i class="chain-seg ${claimed ? 'done' : ''}"></i><i class="chain-node ${done ? 'done' : claimed ? 'current' : ''}"></i><i class="chain-seg progress"><b></b></i><i class="chain-node ${done ? 'done' : ''}"></i>${names}</div>`;
}

// ---- Rendering ------------------------------------------------------------

function render() {
  renderChrome(); renderTeam(); renderActivities();
  if (view === 'tasks') renderTasks(); else if (view === 'members') renderMembers();
  officeLife?.refresh(); chat?.refresh(); channel?.refresh();
}
function renderChrome() {
  let text, tone;
  if (DEMO) { text = (state.paused ? '演示 · 已暂停' : '演示空间') + (storageAvailable ? '' : ' · 仅当前会话'); tone = 'demo'; }
  else if (saving) { text = '正在保存'; tone = 'busy'; }
  else if (cloudReady) { text = LOCAL ? '本机实时' : '实时同步'; tone = 'live'; }
  else if (syncFailures) { text = '连接中断，重试中'; tone = 'down'; }
  else { text = '正在连接'; tone = 'busy'; }
  $('#sync-pill').className = 'sync-pill ' + tone;
  $('#sync-text').textContent = text;
  $('#mode-link').textContent = DEMO ? (LOCAL ? '本机实时' : '返回实时') : '体验演示';
  $('#mode-link').href = DEMO ? './office.html' : './office.html?demo=1';
  const toggle = $('#simulation-toggle'), toggleLabel = DEMO ? (state.paused ? '继续模拟' : '暂停模拟') : '刷新状态';
  setHTML(toggle, icon(DEMO ? (state.paused ? 'play' : 'pause') : 'reset'));
  toggle.setAttribute('aria-label', toggleLabel); toggle.title = toggleLabel;
  if (DEMO) toggle.setAttribute('aria-pressed', String(state.paused));
  document.body.classList.toggle('night', state.night);
  setHTML($('#theme-btn'), icon(state.night ? 'moon' : 'sun'));
  $('#theme-btn').setAttribute('aria-label', state.night ? '切换到白天模式' : '切换到夜晚模式');
  $('meta[name="theme-color"]').content = state.night ? '#141714' : '#f0eee7';
  $('#nav-task-count').textContent = state.tasks.filter(t => t.status !== 'done').length || '';
  $('#nav-member-count').textContent = state.agents.length || '';
}
function rosterRow(a, index) {
  const t = taskFor(a.id), inbox = state.chatPending?.[a.id] || 0;
  const detail = t ? `<em>${STAGES[t.status]}</em> · ${esc(t.title)}` : esc(a.role);
  const bar = t && t.status !== 'queued' ? `<span class="mini-progress ${t.status === 'paused' ? 'paused' : ''}" style="--p:${Math.round(t.progress)}"><i></i></span>` : '';
  return `<li class="roster-row ${a.id === selectedAgent ? 'selected' : ''}" style="--i:${index}"><button class="roster-main" data-chat="${esc(a.id)}"${a.id === selectedAgent ? ' aria-current="true"' : ''} aria-label="打开 ${esc(a.name)} 的对话，${presence(a)}"><span>${avatar(a)}</span><span class="roster-text"><span class="roster-name"><span>${esc(a.name)}</span>${inbox ? `<span class="badge" title="${inbox} 条留言等待回复">${inbox}</span>` : ''}</span><span class="roster-sub">${detail}</span>${bar}</span>${statusTag(a)}</button></li>`;
}
function renderTeam() {
  $('#team-badge').textContent = state.agents.length;
  setHTML($('#team-filters'), chips(teamFilter, 'team-filter'));
  const members = state.agents.filter(a => matches(a, teamFilter));
  setHTML($('#team-list'), members.length ? members.map(rosterRow).join('')
    : state.agents.length ? '<li class="empty-state"><strong>这个状态下没有伙伴</strong>换一个筛选看看。</li>'
    : `<li class="empty-state"><strong>办公室还没有成员</strong>招募第一位伙伴，给它安排一个工位。<br><button class="button secondary compact" data-open-recruit>${icon('plus')}招募</button></li>`);
  const waiting = !DEMO && cloudReady && state.agents.length > 0 && !state.agents.some(a => a.lastSeen);
  $('#team-onboard').hidden = !waiting;
  if (waiting) setHTML($('#team-onboard'), `<strong>还没有 Agent 连上来</strong>把连接配置交给 Hermes。它登记之后会出现在名单里，并开始领取任务、回复留言。<br><button class="button secondary compact" data-open-connect>${icon('link')}查看连接步骤</button>`);
  const mentions = Object.values(state.channelPending || {}).reduce((sum, count) => sum + count, 0);
  $('#channel-entry-note').textContent = mentions ? `${mentions} 条 @ 等待伙伴处理` : '你和所有伙伴一起讨论';
}
function renderActivities() {
  const items = state.activities.slice(0, 8);
  $('#feed-note').textContent = items.length ? `最近 ${items.length} 条` : '';
  setHTML($('#activity-list'), items.length
    ? items.map(item => `<li class="activity"><time>${relativeTime(item.time)}</time><p><strong>${esc(item.name)}</strong> ${esc(item.text)}</p></li>`).join('')
    : '<li class="empty-state">还没有动态。派一个任务，这里会记下每一步。</li>');
}
function memberCard(a, index) {
  const t = taskFor(a.id), seat = DESKS.find(desk => desk.id === a.seatId);
  const bar = t && t.status !== 'queued' ? `<span class="mini-progress ${t.status === 'paused' ? 'paused' : ''}" style="--p:${Math.round(t.progress)}"><i></i></span>` : '';
  return `<button class="member-card" data-chat="${esc(a.id)}" style="--i:${index}"><span class="member-card-top">${avatar(a)}<span class="member-id"><strong>${esc(a.name)}</strong><small>${esc(a.role)}</small></span></span><span class="member-card-task">${t ? `<em>${STAGES[t.status]}</em> · ${esc(t.title)}` : '<em>空闲，等待下一个任务</em>'}${bar}</span><span class="member-card-meta">${statusTag(a)}<span>${seat ? seat.id.slice(-2) + ' 号' : '未入座'}</span><span>完成 ${a.completed || 0}</span></span></button>`;
}
function renderMembers() {
  const query = $('#member-search').value.trim().toLowerCase();
  $('#member-summary').textContent = `${state.agents.length} 位成员，${DESKS.length - state.agents.length} 个空工位。点一位成员打开对话。`;
  setHTML($('#member-filters'), chips(memberFilter, 'member-filter'));
  const agents = state.agents.filter(a => matches(a, memberFilter) && `${a.name} ${a.role} ${a.model}`.toLowerCase().includes(query));
  setHTML($('#member-grid'), agents.length ? agents.map(memberCard).join('')
    : `<div class="empty-state"><strong>没有匹配的成员</strong>换个关键词，或者招募一位新伙伴。<br><button class="button secondary compact" data-open-recruit>${icon('plus')}招募</button></div>`);
}
function taskCard(t, index) {
  const a = state.agents.find(agent => agent.id === t.agentId);
  const when = t.status === 'done' && t.completedAt ? `完成于 ${relativeTime(t.completedAt)}` : `派发于 ${relativeTime(t.created)}`;
  const actions = t.status === 'done' ? '' : `<button class="button ghost compact" data-task-action="${t.status === 'paused' ? 'resume' : 'pause'}" data-task-id="${esc(t.id)}">${t.status === 'paused' ? '继续' : '暂停'}</button><button class="button secondary compact" data-task-action="complete" data-task-id="${esc(t.id)}">${icon('check')}标记完成</button>`;
  return `<article class="task-card is-${t.status}" data-task-card="${esc(t.id)}" style="--i:${index}"><div class="task-card-top"><span class="task-stage">${STAGES[t.status]}</span>${t.priority === 'high' ? '<span class="task-priority">优先</span>' : ''}<time>${when}</time></div><h3>${esc(t.title)}</h3>${t.description ? `<p>${esc(t.description)}</p>` : ''}${chain(t)}${t.result ? `<blockquote class="task-result"><strong>结果</strong>${esc(t.result)}</blockquote>` : ''}<div class="task-card-bottom">${a ? `<button class="task-assignee" data-chat="${esc(a.id)}" aria-label="打开 ${esc(a.name)} 的对话">${avatar(a)}<span>${esc(a.name)}</span></button>` : '<span class="task-assignee">未分配</span>'}${actions}</div></article>`;
}
function renderTasks() {
  const count = status => state.tasks.filter(t => t.status === status).length;
  const stage = (key, label, extra = '') => `<button class="pipe-stage ${extra}" data-task-filter="${key}" aria-pressed="${taskFilter === key}"><b>${key === 'all' ? state.tasks.length : count(key)}</b><span>${label}</span></button>`;
  setHTML($('#task-pipeline'), stage('all', '全部', 'all') + stage('queued', '待领取') + '<i class="pipe-arrow"></i>' + stage('active', '执行中') + '<i class="pipe-arrow"></i>' + stage('done', '已完成') + stage('paused', '已暂停', 'aside'));
  const order = {active:0, queued:1, paused:2, done:3};
  const tasks = state.tasks.filter(t => taskFilter === 'all' || t.status === taskFilter).sort((a, b) => order[a.status] - order[b.status] || b.created - a.created);
  setHTML($('#task-board'), tasks.length ? tasks.map(taskCard).join('')
    : `<div class="empty-state"><strong>${state.tasks.length ? '这个阶段没有任务' : '还没有任务'}</strong>${state.tasks.length ? '换一个阶段看看，或者再派一个。' : '写下想要的结果，交给一位伙伴。'}<br><button class="button primary compact new-task-trigger">${icon('plus')}派任务</button></div>`);
}
// The member card sits on top of that member's thread: current task, actions and profile.
function renderAgentCard(a) {
  const card = $('#agent-card'), t = taskFor(a.id), seat = DESKS.find(desk => desk.id === a.seatId);
  const inbox = state.chatPending?.[a.id] || 0, mentions = state.channelPending?.[a.id] || 0;
  const notes = [inbox ? `${inbox} 条留言等待 TA 读取` : '', mentions ? `频道里 ${mentions} 条 @ 待处理` : ''].filter(Boolean).join(' · ');
  const restLabel = a.status === 'resting' ? (t ? '继续任务' : '') : '让 TA 休息';
  const html = `<div class="agent-task ${t ? '' : 'idle'}"><div class="agent-task-head"><span>${t ? STAGES[t.status] : '空闲'}</span>${t && t.status !== 'queued' ? `<span class="num">${Math.round(t.progress)}%</span>` : ''}</div><p class="agent-task-title">${t ? esc(t.title) : '现在没有任务，可以派一件事给 TA。'}</p>${t ? chain(t, false) : ''}</div>${notes ? `<p class="agent-inbox">${notes}</p>` : ''}<div class="agent-actions"><button class="button primary compact" id="detail-assign">${icon(t ? 'task' : 'plus')}${t ? '查看任务' : '派任务'}</button>${restLabel ? `<button class="button secondary compact" id="detail-rest">${icon(a.status === 'resting' ? 'bolt' : 'coffee')}${restLabel}</button>` : ''}</div><details class="agent-more"><summary>档案</summary><dl class="agent-facts"><dt>模型</dt><dd>${esc(a.model)}</dd><dt>专长</dt><dd class="skill-chips">${MODELS[a.model].skills.map(skill => `<span class="skill-chip">${skill}</span>`).join('')}</dd><dt>工位</dt><dd>${seat ? seat.id.slice(-2) + ' 号' : '未入座'} <button class="link-button" id="detail-seat">换座</button></dd><dt>已完成</dt><dd>${a.completed || 0} 项任务</dd><dt>Agent ID</dt><dd><code>${esc(a.id)}</code></dd></dl></details>`;
  const keepOpen = card.dataset.agent === a.id && card.querySelector('details')?.open;
  if (setHTML(card, html) && keepOpen) card.querySelector('details').open = true;
  card.dataset.agent = a.id;
}

// ---- Navigation and panes -------------------------------------------------

function changeView(next) {
  view = next;
  document.body.dataset.view = next;
  $('#space-panel').hidden = next !== 'office'; $('#tasks-page').hidden = next !== 'tasks'; $('#members-page').hidden = next !== 'members';
  $$('.view-link[data-view]').forEach(button => {
    const on = button.dataset.view === next;
    button.classList.toggle('active', on);
    if (on) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  $('#stage').scrollTop = 0;
  if (next === 'tasks') renderTasks(); else if (next === 'members') renderMembers();
  if (SMALL.matches) window.scrollTo(0, 0);
  if (next === 'office') requestAnimationFrame(() => scene?.resize());
  else { expand(false); playEnter(next === 'tasks' ? $('#task-board') : $('#member-grid')); }
}
function openDialog(id) { const dialog = $('#' + id); if (!dialog.open) dialog.showModal(); }
function closeDialog(id) { $('#' + id).close(); }
// Remember what opened a pane so closing it puts keyboard focus back there.
let paneOpener = null;
function rememberOpener() {
  const active = document.activeElement;
  if ($('.pane[open]') || !active || active === document.body || active.closest('.pane')) return;
  const key = FOCUS_KEYS.find(attribute => active.hasAttribute(attribute));
  paneOpener = {element:active, selector:key ? `[${key}="${CSS.escape(active.getAttribute(key))}"]` : active.id ? '#' + CSS.escape(active.id) : null};
}
function restoreOpener(fallback) {
  if ($('.pane[open]')) return;
  const target = paneOpener?.element.isConnected ? paneOpener.element : $(paneOpener?.selector || fallback);
  paneOpener = null;
  target?.focus({preventScroll:true});
}
function openChat(id) {
  if (!state.agents.some(a => a.id === id)) return;
  if(EMBED){window.parent.postMessage({type:'office-select-agent',agentId:id},location.origin);return;}
  rememberOpener();
  expand(false);
  if ($('#channel-dialog').open) $('#channel-dialog').close();
  chat.open(id);
}
function openChannel() {
  rememberOpener();
  expand(false);
  if ($('#chat-dialog').open) $('#chat-dialog').close();
  channel.open();
}
function showTask(id) {
  taskFilter = 'all'; renderTasks(); changeView('tasks');
  if (SMALL.matches && $('#chat-dialog').open) $('#chat-dialog').close();
  requestAnimationFrame(() => {
    const card = $(`[data-task-card="${CSS.escape(id)}"]`);
    if (!card) return;
    card.scrollIntoView({block:'center', behavior:'smooth'});
    card.classList.add('flash'); setTimeout(() => card.classList.remove('flash'), 1800);
  });
}
function showCameraView(preset) {
  $$('[data-camera]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.camera === preset)));
  $('#camera-view-name').textContent = ({overview:'全景',work:'工位',lounge:'休息区',top:'俯瞰'})[preset] || '自由';
}
function showZoom(value) {
  $('#zoom-value').textContent = value + '%';
  $('#zoom-slider').value = String(value);
  $('#zoom-slider').setAttribute('aria-valuetext', value + '%');
  $('#zoom-out').disabled = value <= 50; $('#zoom-in').disabled = value >= 320;
}
function setCamera(preset) { showCameraView(preset); scene?.setView(preset); }

function expand(expanded) {
  if (document.body.classList.contains('expanded-mode') === expanded) return;
  document.body.classList.toggle('expanded-mode', expanded);
  $('.topbar').inert = expanded;
  const label = expanded ? '退出展开' : '展开办公室';
  $('#expand-btn').setAttribute('aria-label', label); $('#expand-btn').title = label;
  $('#expand-btn').setAttribute('aria-expanded', String(expanded));
  $('#expand-btn').innerHTML = icon(expanded ? 'close' : 'expand');
  requestAnimationFrame(() => scene?.resize());
}

// ---- Recruiting and tasks -------------------------------------------------

function renderModelOptions() {
  const keys = ['Hermes','ChatGPT','Claude','Codex','Gemini','Kimi'];
  $('#model-options').innerHTML = keys.map(model => `<button type="button" class="model-option ${model === selectedModel ? 'selected' : ''}" data-model="${model}" aria-pressed="${model === selectedModel}">${avatar({model})}${model}</button>`).join('');
}
function suggestedName(model) { const count = state.agents.filter(a => a.model === model).length; return count ? `${model} · ${count + 1}` : model; }
function openRecruit(seatId) {
  if (!DEMO && !cloudReady) { toast('请等待云端连接'); return; }
  if (state.agents.length >= 16) { toast('办公室已满员，最多容纳 16 位伙伴'); return; }
  selectedModel = DEMO ? 'ChatGPT' : 'Hermes';
  renderModelOptions();
  $('#recruit-form').reset();
  $('#agent-name').value = suggestedName(selectedModel);
  const available = DESKS.filter(desk => !state.agents.some(a => a.seatId === desk.id));
  $('#agent-seat').innerHTML = available.map(desk => `<option value="${desk.id}">${desk.label}</option>`).join('');
  if (available.some(desk => desk.id === seatId)) $('#agent-seat').value = seatId;
  openDialog('recruit-dialog');
}
function openTask(agentId) {
  if (!DEMO && !cloudReady) { toast('请等待云端连接'); return; }
  if (state.tasks.length >= 200) { toast('办公室已达到 200 项任务上限'); return; }
  const available = state.agents.filter(a => !taskFor(a.id));
  if (!available.length) { toast('伙伴们都有待办任务，可以先完成任务或招募新成员'); return; }
  $('#task-form').reset();
  $('#task-agent').innerHTML = state.agents.map(a => `<option value="${esc(a.id)}" ${taskFor(a.id) ? 'disabled' : ''}>${esc(a.name)} · ${taskFor(a.id) ? '已有任务' : esc(a.role)}</option>`).join('');
  $('#task-agent').value = available.some(a => a.id === agentId) ? agentId : available[0].id;
  openDialog('task-dialog');
}
function completeTask(t) {
  t.status = 'done'; t.progress = 100;
  const a = state.agents.find(agent => agent.id === t.agentId);
  if (a) { a.status = 'resting'; a.completed = (a.completed || 0) + 1; activity(a.name, `完成了「${t.title}」`); }
}

// ---- Events ---------------------------------------------------------------

document.addEventListener('click', event => {
  const target = event.target;
  const chatButton = target.closest('[data-chat]'); if (chatButton) { openChat(chatButton.dataset.chat); return; }
  const nav = target.closest('button[data-view], a[data-view]'); if (nav) changeView(nav.dataset.view);
  const close = target.closest('[data-close]'); if (close) closeDialog(close.dataset.close);
  const team = target.closest('[data-team-filter]'); if (team) { teamFilter = team.dataset.teamFilter; renderTeam(); }
  const member = target.closest('[data-member-filter]'); if (member) { memberFilter = member.dataset.memberFilter; renderMembers(); }
  const stage = target.closest('[data-task-filter]'); if (stage) { taskFilter = stage.dataset.taskFilter; renderTasks(); playEnter($('#task-board')); }
  const camera = target.closest('[data-camera]'); if (camera) setCamera(camera.dataset.camera);
  if (target.closest('[data-open-connect]')) openDialog('connect-dialog');
  if (target.closest('[data-open-recruit]')) openRecruit();
  if (target.closest('.new-task-trigger')) openTask();
  const model = target.closest('[data-model]');
  if (model) {
    selectedModel = model.dataset.model; renderModelOptions();
    $('#agent-name').value = suggestedName(selectedModel);
    const roles = {Hermes:'通用助手', ChatGPT:'通用助手', Claude:'内容创作', Codex:'代码开发', Gemini:'设计创意', Kimi:'资料研究', DeepSeek:'数据分析'};
    $('#agent-role').value = roles[selectedModel];
  }
  const action = target.closest('[data-task-action]');
  if (action) {
    const t = state.tasks.find(task => task.id === action.dataset.taskId);
    if (!t || t.status === 'done') return;
    const a = state.agents.find(agent => agent.id === t.agentId);
    if (action.dataset.taskAction === 'complete') { completeTask(t); toast('任务已完成'); }
    else if (action.dataset.taskAction === 'pause') { t.status = 'paused'; if (a) { a.status = 'resting'; activity(a.name, '暂停任务，休息一下'); } toast('任务已暂停'); }
    else { t.status = 'active'; if (a) { a.status = 'working'; activity(a.name, '回到工位继续任务'); } toast('任务已继续'); }
    updateState();
  }
});

$('#agent-card').addEventListener('click', event => {
  const a = state.agents.find(agent => agent.id === chat.current); if (!a) return;
  const t = taskFor(a.id);
  if (event.target.closest('#detail-assign')) { if (t) showTask(t.id); else openTask(a.id); }
  else if (event.target.closest('#detail-seat')) officeLife.open(a.seatId);
  else if (event.target.closest('#detail-rest')) {
    if (a.status === 'resting') { if (!t) return; t.status = 'active'; a.status = 'working'; activity(a.name, '结束休息，继续任务'); updateState(); toast(`${a.name} 回到工位了`); }
    else { a.status = 'resting'; if (t) t.status = 'paused'; activity(a.name, '暂时放下工作，去休息区充充电'); updateState(); toast(`${a.name} 去休息区了`); }
  }
});

$('#recruit-btn').onclick = () => openRecruit();
$('#help-btn').onclick = () => openDialog('help-dialog');
$('.brand').onclick = event => { event.preventDefault(); changeView('office'); };
$('#member-search').addEventListener('input', renderMembers);
$('#recruit-form').addEventListener('submit', event => {
  event.preventDefault();
  const name = $('#agent-name').value.trim();
  if (!name) { $('#agent-name').setCustomValidity('请为新伙伴起个名字'); $('#agent-name').reportValidity(); return; }
  if (state.agents.length >= 16) return;
  state.agents.push({id:crypto.randomUUID(), name, model:selectedModel, role:$('#agent-role').value, seatId:$('#agent-seat').value, status:'resting', completed:0});
  activity(name, '加入办公室');
  closeDialog('recruit-dialog'); updateState(); toast(`${name} 加入了办公室`);
});
$('#agent-name').addEventListener('input', event => event.target.setCustomValidity(''));
$('#task-title').addEventListener('input', event => event.target.setCustomValidity(''));
$('#task-form').addEventListener('submit', event => {
  event.preventDefault();
  const title = $('#task-title').value.trim();
  if (!title) { $('#task-title').setCustomValidity('请填写任务名称'); $('#task-title').reportValidity(); return; }
  const a = state.agents.find(agent => agent.id === $('#task-agent').value);
  if (!a || taskFor(a.id)) { toast('这位伙伴已有任务，请选择其他成员'); return; }
  state.tasks.push({id:crypto.randomUUID(), title, description:$('#task-description').value.trim(), agentId:a.id, priority:$('#task-priority').value, progress:0, status:DEMO ? 'active' : 'queued', created:Date.now()});
  if (DEMO) a.status = 'working';
  activity(a.name, `开始了新任务「${title}」`);
  closeDialog('task-dialog'); updateState();
  toast(DEMO ? `已交给 ${a.name}` : `任务已排队，等待 ${a.name} 领取`);
});
$$('[data-orbit]').forEach(button => button.onclick = () => {
  const direction = {left:[-.22,0],right:[.22,0],up:[0,-.15],down:[0,.15]}[button.dataset.orbit];
  scene?.orbit(...direction);
});
$('#pan-toggle').onclick = () => {
  const pan = $('#pan-toggle').getAttribute('aria-pressed') !== 'true';
  $('#pan-toggle').setAttribute('aria-pressed', String(pan));
  $('#camera-help').textContent = pan ? '拖动平移 · 滚轮 / 双指缩放' : '拖动旋转 · 滚轮 / 双指缩放';
  scene?.setDragMode(pan ? 'pan' : 'rotate');
};
$('#labels-toggle').onclick = () => {
  const visible = $('#labels-toggle').getAttribute('aria-pressed') !== 'true';
  $('#labels-toggle').setAttribute('aria-pressed', String(visible));
  $('#agent-labels').hidden = !visible;
  if (visible) scene?.resize();
};
$('#zoom-slider').addEventListener('input', event => scene?.setZoom(Number(event.target.value) / 100));
$('#zoom-in').onclick = () => scene?.zoom(.15);
$('#zoom-out').onclick = () => scene?.zoom(-.15);
$('#reset-view').onclick = () => setCamera('overview');
$('#expand-btn').onclick = () => expand(!document.body.classList.contains('expanded-mode'));
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || event.isComposing || $$('dialog.dialog[open]').length) return;
  const pane = $('.pane[open]');
  if (pane) pane.close(); else expand(false);
});
$('#simulation-toggle').onclick = () => {
  if (!DEMO) { syncCloud(); return; }
  state.paused = !state.paused; scene?.setPaused(state.paused); updateState({positions:false});
  toast(state.paused ? '办公室模拟已暂停' : '模拟继续');
};
$('#theme-btn').onclick = () => {
  state.night = !state.night; scene?.setNight(state.night); updateState({positions:false, localOnly:true});
  toast(state.night ? '已切换到夜晚' : '已切换到白天');
};
// Clicking the dimmed backdrop closes a modal dialog.
$$('dialog.dialog').forEach(dialog => dialog.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
}));

// Demo only: simulated progress. Live offices show what Agents actually report.
setInterval(() => {
  if (!DEMO || EMBED || state.paused || document.hidden) return;
  let changed = false, positions = false;
  for (const t of state.tasks) {
    if (t.status !== 'active') continue;
    const a = state.agents.find(agent => agent.id === t.agentId);
    if (!a || a.status === 'resting') continue;
    t.progress = Math.min(100, t.progress + (a.status === 'thinking' ? 1 : 2)); changed = true;
    if (a.status === 'thinking' && t.progress >= 22) { a.status = 'working'; activity(a.name, '想清楚了方向，开始动手实现'); positions = true; }
    if (t.progress >= 100) { completeTask(t); positions = true; }
  }
  if (changed) updateState({positions}); else renderActivities();
}, 10000);

chat = new AgentChat({demo:DEMO, getState:() => state, avatar, presence,
  onSelect:id => { selectedAgent = id; if (id) lastAgent = id; scene?.select(id); renderTeam(); },
  onRender:renderAgentCard, onConnect:() => openDialog('connect-dialog'), onChange:syncCloud, toast});
officeLife = new OfficeLife({getState:() => state, getScene:() => scene, save:updateState, canEdit:() => DEMO || (cloudReady && !saving), recruit:openRecruit, toast});
channel = new ChannelChat({demo:DEMO, getState:() => state, avatar, presence,
  onPrivate:() => { const id = state.agents.some(a => a.id === lastAgent) ? lastAgent : state.agents[0]?.id; if (id) openChat(id); else toast('先招募一位伙伴，再开始私聊'); },
  onConnect:() => openDialog('connect-dialog'), onChange:syncCloud, toast});
$('#chat-dialog').addEventListener('close', () => restoreOpener(lastAgent ? `[data-chat="${CSS.escape(lastAgent)}"]` : '#channel-entry'));
$('#channel-dialog').addEventListener('close', () => restoreOpener('#channel-entry'));
$('#chat-nav').onclick = openChannel;
$('#channel-entry').onclick = openChannel;
render();
playEnter($('#team-list'));
if (!DEMO) await syncCloud();
try {
  const {OfficeScene} = await import('./scene.js');
  scene = new OfficeScene($('#canvas-container'), $('#agent-labels'), id => openChat(id), showZoom, id => officeLife.open(id), kind => officeLife.play(kind), showCameraView);
  scene.updateAgents(state.agents); scene.setNight(state.night); scene.setPaused(state.paused); scene.select(selectedAgent);
  $('#scene-loading').hidden = true;
} catch (error) {
  console.error('Office scene could not start:', error);
  $('#scene-loading').innerHTML = `<div class="scene-error">${icon('office')}<p>这台设备暂时打不开 3D 空间，成员和任务仍然可以正常使用。</p><button class="button secondary compact" data-view="members">查看成员 ${icon('arrow')}</button></div>`;
}

// Agent data is shared through the authenticated MCP service; ?demo=1 stays local.
if (!DEMO) setInterval(() => { if (!document.hidden) syncCloud(); }, 4000);
$('#connect-btn').onclick = () => openDialog('connect-dialog');
$('#connect-code').textContent = 'mcp_servers:\n  agent_office:\n    url: "' + MCP_URL + '"\n    headers:\n      OAI-Sites-Authorization: "Bearer ${AGENT_OFFICE_TOKEN}"\n';
$('#copy-config').onclick = async () => { try { await navigator.clipboard.writeText($('#connect-code').textContent); toast('Hermes 配置已复制'); } catch { toast('请手动选中并复制配置'); } };
if (!DEMO) {
  $('#task-dialog .form-note').textContent = '任务保存到办公室，等待 Agent 领取和执行。';
  $('#recruit-dialog .form-note').textContent = '添加成员档案后，让 Agent 用相同的 Agent ID 连接并上报状态。';
  $('.help-note').textContent = '实时办公室每 4 秒同步一次。留言保存在办公室，由 Agent 读取后回复；咖啡、小猫和庆祝不会改变任务进度。';
}
// In a live office, hold mutating clicks until the office is connected and idle.
document.addEventListener('click', event => {
  if (DEMO) return;
  const mutating = event.target.closest('#recruit-btn,[data-open-recruit],.new-task-trigger,[data-task-action],#detail-rest,#recruit-form button[type=submit],#task-form button[type=submit],#desk-save,#desk-recruit');
  if (mutating && (saving || !cloudReady)) { event.preventDefault(); event.stopImmediatePropagation(); toast(saving ? '正在保存，请稍候' : '请等待云端连接'); }
}, true);

export {state,completeTask,taskFor,activeTaskFor};

if (LOCAL) {
  $('#connect-code').textContent = 'mcp_servers:\n  agent_office_local:\n    url: "' + MCP_URL + '"\n';
  $('#connect-dialog .modal-description').textContent = '当前是本机调试。把这份配置添加到同一台电脑上的 Agent，连接后即可测试真实的消息收发。';
  $('#connect-dialog a[href="/api/hermes/credentials"]').hidden = true;
  $('#connect-dialog .help-item h3').textContent = '连接本机办公室';
  $('#connect-dialog .help-item p').textContent = '保持 npm run dev 运行。这个地址只接受本机连接，不访问线上办公室的数据，也不需要线上密钥。';
  $('#connect-dialog .form-note').textContent = '上线后使用线上地址和原有的私有访问密钥。聊天不会自动唤醒 Agent，需要它持续读取消息。';
}

if($('#workspace-link'))$('#workspace-link').href=DEMO?'./?demo=1':'./';
if(new URLSearchParams(location.search).get('connect')==='1')openDialog('connect-dialog');

if(EMBED)window.addEventListener('message',event=>{
  if(event.origin!==location.origin||event.source!==window.parent)return;
  if(event.data?.type==='office-visibility'){scene?.renderer.setAnimationLoop(event.data.visible?scene.animate:null);if(event.data.visible)scene?.resize();}
  if(event.data?.type==='office-focus-agent'&&(event.data.agentId===null||state.agents.some(a=>a.id===event.data.agentId))){selectedAgent=event.data.agentId;scene?.select(selectedAgent);}
  if(event.data?.type==='office-demo-state'&&DEMO&&validState(event.data.state)){state={...event.data.state,night:state.night,paused:false};displayState();}
  if(event.data?.type==='office-theme'&&typeof event.data.night==='boolean'){state.night=event.data.night;scene?.setNight(state.night);render();}
});
if(EMBED)window.parent.postMessage({type:'office-ready'},location.origin);
