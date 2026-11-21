import {MODELS, initialState, validState} from './data.js';
import {resultsForMessage, highlightedMessage} from './collaboration-view.js';
import {mentionedAgents} from './channel.js';
import {escapeHTML as esc, VISUAL_KINDS, visualBody, isolatedDocument, visualDownload} from './visual-renderer.js';
import {createMemberPanel} from './member-panel.js';
import {onLoopback, readLocalConfig} from './local-mode.js';
import {readPiSetup, savePiSetup} from './pi-model-setup.js';
const $ = selector => document.querySelector(selector);
const demo = new URLSearchParams(location.search).get('demo') === '1';
const localConfig = demo ? null : await readLocalConfig();
const localMode = localConfig?.mode;
const memoryKey = 'agent-office-workspace-demo-v2',
  draftKey = 'agent-office-workspace-drafts-' + (demo ? 'demo' : 'live');
let state = demo ? initialState() : {agents: [], tasks: [], activities: []},
  current = new URLSearchParams(location.search).get('agent') || 'group';
let visuals = [],
  steps = [],
  selectedVisual = new URLSearchParams(location.search).get('visual'),
  selectedTab = 'results',
  quote = null,
  polling = false,
  pollAgain = false,
  syncTag = null,
  syncScope = null,
  fileScope = null,
  visualRequest = 0,
  toastTimer;
const conversations = new Map(),
  drafts = new Map(),
  sending = new Set(),
  details = new Map();
let targets = new Set(),
  hasConnected = demo,
  visualSignature = '',
  messageSignature = '',
  demoSaved = null;
const frame = $('#office-frame');
const initialLink = new URL(location.href);
let profiles = [],
  projectRuns = [],
  projectRead = false,
  refreshAgain = false;
const people = () => [...state.agents, ...profiles.filter(p => !state.agents.some(a => a.id === p.id))];
const currentAgent = () => people().find(a => a.id === current);
const panel = createMemberPanel({
  config: localConfig,
  select: selectConversation,
  refresh: async () => {
    await loadProfiles();
    syncTag = null;
    await poll();
  },
  connect: () => $('#connect-dialog').showModal(),
  prompt: appendFilePrompt,
  openVisual: chooseVisual,
  notify: toast
});
let profileTimer;
async function loadProfiles() {
  if (!localConfig?.studio) return;
  clearTimeout(profileTimer);
  try {
    const catalog = await api('/api/studio');
    profiles = [...(catalog.agents || []), ...(catalog.builtin ? [catalog.builtin] : [])].map(p => ({
      ...p,
      model: p.connectionId === 'local' ? 'Pi' : 'API',
      managedDisabled: p.enabled === false,
      profileOnly: true
    }));
  } catch {
    /* Previously read profiles can still be selected while reconnecting. */
  }
  if (profiles.some(p => p.local?.state === 'starting'))
    profileTimer = setTimeout(async () => {
      await loadProfiles();
      render();
    }, 5000);
}
function appendFilePrompt(prompt) {
  const input = $('#composer-input');
  const text = (input.value.trimEnd() ? input.value.trimEnd() + '\n' : '') + prompt;
  if (text.length > input.maxLength) return toast('草稿已接近上限，缩短后再添加示例。');
  input.value = text;
  $('#delivery-kind').value = '';
  saveDraft();
  renderComposer();
  input.focus();
}
const operationNames = {
  thinking: '分析任务',
  queued: '等待领取',
  claimed: '已领取',
  report: '汇报进度',
  list: '查看目录',
  read: '读取文件',
  search: '搜索',
  edit: '编辑',
  write: '写入',
  test: '运行测试'
};
function activityFor(a) {
  const run = projectRuns.find(r => r.agentId === a.id);
  if (run) {
    const p = run.progress || {};
    const project = run.projectPath?.split(/[/\\]/).filter(Boolean).pop() || run.title;
    return {
      id: run.id,
      title: project,
      step: p.step || 0,
      detail: p.operation === 'report' && p.path ? p.path : operationNames[p.operation] || '处理任务',
      waiting: p.operation === 'queued'
    };
  }
  const task = state.tasks.find(t => t.agentId === a.id && t.status === 'active');
  if (!task) return null;
  const activity = steps.filter(s => s.taskId === task.id);
  return {title: task.title, step: activity.length, detail: activity.at(-1)?.title || '执行中'};
}
async function loadProjectRuns() {
  if (!localConfig?.workbench || document.hidden) return;
  if (projectRead) {
    refreshAgain = true;
    return;
  }
  projectRead = true;
  try {
    const data = await api('/api/studio/projects');
    projectRuns = data.sessions.filter(s => s.progress || s.status === 'running');
  } catch {
    projectRuns = [];
  } finally {
    projectRead = false;
    sendOfficeState();
    renderOfficeContext();
    renderSidebar();
    renderHeader();
    if (refreshAgain) {
      refreshAgain = false;
      void loadProjectRuns();
    }
  }
}

const time = value => new Date(value).toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit'});
const scopeList = items => (current === 'group' ? items : items.filter(item => item.agentId === current));
const currentMessages = () => conversations.get(current) || [];
const statusLabels = {working: '工作中', thinking: '处理中', resting: '在线待命'};
const PI_STATES = {off: '未配置本机模型', starting: '正在加载模型', failed: '模型未能启动', stopped: '模型已停止'};
const PI_SETUP = 'https://github.com/okiexia-ui/agent-office/blob/main/docs/LOCAL-PI.md#启动';
const isOnline = a => !a.managedDisabled && (demo || !!(a.lastSeen && Date.now() - a.lastSeen < 300000));
function status(a) {
  if (a.managedDisabled) return '已停用';
  if (a.profileOnly && a.local) return PI_STATES[a.local.state] || '尚未连接';
  if (a.profileOnly) return a.status === 'error' ? '需要配置' : '尚未连接';
  if (demo) return '演示伙伴';
  const activity = activityFor(a);
  if (activity) return activity.waiting ? '等待领取' : '工作中';
  return isOnline(a) ? statusLabels[a.status] : '等待连接';
}
const avatar = a => {
  const m = MODELS[a?.model] || MODELS.Hermes;
  const ink = /^#[a-f\d]{6}$/i.test(a?.color) ? a.color : m.color;
  return `<span class="avatar" aria-hidden="true" style="--avatar-bg:${m.bg};--avatar-ink:${ink}">${m.mark}</span>`;
};
const setHTML = (element, html) => {
  if (element.innerHTML !== html) element.innerHTML = html;
};
function toast(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => ($('#toast').hidden = true), 3500);
}
function errorAt(id, message) {
  $(id).textContent = message;
  $(id).hidden = !message;
}
async function api(path, body) {
  const response = await fetch(path, {
    cache: 'no-store',
    signal: AbortSignal.timeout(12000),
    ...(body ? {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)} : {})
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || '连接暂时不可用');
  return data;
}
function saveDemo() {
  try {
    localStorage.setItem(memoryKey, JSON.stringify({conversations: Object.fromEntries(conversations), visuals, steps}));
  } catch {
    toast('浏览器存储不可用，演示内容仅保留在当前页面');
  }
}
function saveDraft() {
  drafts.set(current, $('#composer-input').value);
  try {
    localStorage.setItem(draftKey, JSON.stringify(Object.fromEntries(drafts)));
  } catch {}
}
function updateURL() {
  const url = new URL(location.href);
  current === 'group' ? url.searchParams.delete('agent') : url.searchParams.set('agent', current);
  selectedVisual && $('.workbench').matches('.results-expanded,.visual-overlay')
    ? url.searchParams.set('visual', selectedVisual)
    : url.searchParams.delete('visual');
  history.replaceState(null, '', url);
}
const compactScreen = matchMedia('(max-width:760px)');
function frameVisibility() {
  const board = $('.workbench'),
    visible =
      !document.hidden &&
      !board.classList.contains('visual-overlay') &&
      (!board.classList.contains('results-expanded') || compactScreen.matches);
  frame.contentWindow?.postMessage({type: 'office-visibility', visible}, location.origin);
}
// The embedded office has no connection of its own; it shows exactly what this page has.
function sendOfficeState() {
  const agents = state.agents.map(a => {
    const activity = activityFor(a);
    return {
      ...a,
      officeActivity: activity,
      status: activity && !a.managedDisabled && !activity.waiting ? 'working' : a.status
    };
  });
  frame.contentWindow?.postMessage({type: 'office-state', state: {...state, agents}}, location.origin);
}
function syncOfficeFrame() {
  sendOfficeState();
  frame.contentWindow?.postMessage(
    {type: 'office-theme', night: document.body.classList.contains('night')},
    location.origin
  );
  frame.contentWindow?.postMessage(
    {type: 'office-focus-agent', agentId: current === 'group' ? null : current},
    location.origin
  );
  frameVisibility();
}
function toggleVisual(show) {
  const board = $('.workbench');
  const wasOpen = board.matches('.results-expanded,.visual-overlay');
  board.classList.toggle(compactScreen.matches ? 'visual-overlay' : 'results-expanded', show);
  $('#conversation').inert = compactScreen.matches && show;
  $('.office-live').inert = compactScreen.matches && show;
  $('#visual-toggle').setAttribute('aria-expanded', String(show));
  $('#expand-results').setAttribute('aria-expanded', String(show));
  $('#expand-results').textContent = show ? '返回办公室' : '查看全部';
  $('#expand-results').setAttribute('aria-label', show ? '返回办公室' : '展开成果区域');
  updateURL();
  if (show) void renderVisuals();
  frameVisibility();
  if (compactScreen.matches && (show || wasOpen))
    (show ? $('#close-visual') : $('#visual-toggle')).focus({preventScroll: true});
}
// First-run starting points for the local edition: each fills in the Agent studio, so the
// only remaining choice is a model.
const TEMPLATES = {
  editor: {
    name: '产品编辑',
    role: '整理产品文档、发布说明和交付清单',
    instructions:
      '把收到的材料整理成结构清楚的文档或表格。先给结论，再列要点；数字、名称和日期保持原样，不确定的内容标注「待确认」。需要交付时，按要求发布成共享文档或共享表格。'
  },
  reviewer: {
    name: '审校',
    role: '检查文稿的事实、表述和格式',
    instructions:
      '逐条指出问题并给出修改建议，按「问题 / 位置 / 建议」整理。保持作者原意；无法核实的事实单独列出，不要猜测。最后给一句总体评价。'
  },
  researcher: {
    name: '资料研究',
    role: '归纳资料并给出有依据的结论',
    instructions:
      '先确认问题范围，再分点归纳。区分事实、推断和建议，只依据提供的材料或可以核实的信息；资料不足时直接说明还缺什么。'
  }
};
const studioMode = () => localConfig?.studio === true;
// No members yet: the local edition invites you to create one; a remote office waits for one to connect.
const STARTERS = `<button data-kind="chart" data-prompt="请整理当前任务，并把进度发布成图表。">把当前任务变成图表 <span>↗</span></button><button data-kind="document" data-prompt="请梳理这个项目的下一步，把行动计划文档发布到成果区。">一起想清楚下一步 <span>↗</span></button><button data-kind="html" data-prompt="请做一个能交互的 HTML 小工具，发布到 Visual。">把想法变成可交互的作品 <span>↗</span></button>`;
// Ollama / LM Studio already running on this computer, read when nobody is online yet.
let localSetup = null;
async function loadLocalSetup() {
  if (!studioMode() || !localConfig?.workbench) return;
  try {
    localSetup = await readPiSetup();
  } catch {
    localSetup = null;
  }
}
const localChoices = () =>
  (localSetup?.services || [])
    .filter(s => s.models.length)
    .map(s => ({name: s.name, url: s.baseUrl, model: s.models[0], count: s.models.length}));
const localChoice = c => esc(JSON.stringify({name: c.name, url: c.url, model: c.model}));
function localMemberButtons() {
  return localChoices()
    .map(
      c =>
        `<button data-local-member="${localChoice(c)}"><span class="template-name">用本机 ${esc(c.name)} 创建成员<small>${esc(c.model)}${c.count > 1 ? ' 等 ' + c.count + ' 个模型' : ''} · 不需要 API Key</small></span><span>创建 ↗</span></button>`
    )
    .join('');
}
const MODEL_CHOICES = '本机 Pi，OpenAI、Kimi、DeepSeek、通义千问等模型服务，或本机的 Ollama、LM Studio';
function onboarding() {
  const waiting = people();
  if (studioMode())
    return `<div class="empty-chat onboarding"><span class="empty-symbol" aria-hidden="true">✳</span>${
      waiting.length
        ? `<h2>还没有成员在线</h2><p>${esc(waiting.map(a => a.name).join('、'))}还没有上线，点名单里的成员可以看原因。也可以再创建一位成员，选一个模型：${MODEL_CHOICES}。`
        : `<h2>先请来第一位成员</h2><p>给它名字、职责和工作方式，再选一个模型：${MODEL_CHOICES}。`
    }之后在群聊里点名它，或私聊交代工作。</p><div class="suggestions">${localMemberButtons()}${Object.entries(TEMPLATES)
      .map(
        ([key, t]) =>
          `<button data-template="${key}"><span class="template-name">${esc(t.name)}<small>${esc(t.role)}</small></span><span>创建 ↗</span></button>`
      )
      .join('')}</div><button class="onboarding-blank" data-template="">从空白开始创建</button></div>`;
  return `<div class="empty-chat onboarding"><span class="empty-symbol" aria-hidden="true">✳</span><h2>还没有伙伴加入</h2><p>让已经运行的 Agent 通过 MCP 连接这个办公室。它登记后会坐进左边的办公室，消息、任务和成果都在这里。</p><div class="suggestions"><button data-connect>查看连接方式 <span>↗</span></button></div></div>`;
}
// An empty private chat explains this member's state, with the next step when it cannot reply yet.
function directEmpty(a) {
  const name = esc(a?.name || '伙伴');
  const card = (title, text, actions = '') =>
    `<div class="empty-chat onboarding"><span class="empty-symbol" aria-hidden="true">✳</span><h2>${title}</h2><p>${text}</p>${actions && `<div class="suggestions">${actions}</div>`}</div>`;
  const usePi = localSetup?.pi?.version
    ? localChoices()
        .map(
          c =>
            `<button data-pi-model="${localChoice(c)}">让 Pi 使用本机 ${esc(c.name)}（${esc(c.model)}） <span>↗</span></button>`
        )
        .join('')
    : '';
  const setup =
    usePi +
    `<button data-member-settings>在设置里配置本机模型 <span>↗</span></button><a href="${PI_SETUP}" target="_blank" rel="noopener noreferrer">查看配置说明 <span>↗</span></a>`;
  const create = '<button data-template="">创建使用其他模型的成员 <span>↗</span></button>';
  if (a?.id === 'pi-local' && a.local && a.local.state !== 'ready' && !isOnline(a)) {
    if (a.local.state === 'starting')
      return card(`${name}正在加载本机模型`, '模型较大时需要一两分钟。可以先留言，加载完成后它会读取并回复。');
    if (a.local.state === 'failed')
      return card(
        `${name}的本机模型没有启动`,
        esc(a.local.error || '启动本机模型时出错。') + ' 修好后重新启动办公室即可。',
        setup + create
      );
    return card(
      `${name}还没有本机模型`,
      'Pi 在这台电脑上用 llama.cpp 运行 GGUF 模型。按步骤配置后重新启动办公室，它就会上线。也可以先创建一位使用 Ollama、LM Studio 或模型 API 的成员。',
      setup + create
    );
  }
  if (a?.profileOnly && a.status === 'error')
    return card(
      `${name}需要配置`,
      esc(a.error || '这位成员的模型连接不可用。') + ' 在「设置」里检查模型连接后保存。',
      '<button data-member-settings>打开设置 <span>↗</span></button>'
    );
  if (a?.managedDisabled)
    return card(
      `${name}已停用`,
      '可以先留言。在「设置」里重新启用后，它会继续处理。',
      '<button data-member-settings>打开设置 <span>↗</span></button>'
    );
  return card(
    `和${name}单独聊`,
    '在这里交代具体工作，或在「项目任务」里选一个文件夹让它动手。它发布的成果会出现在场景下方。',
    STARTERS
  );
}
function renderOfficeContext() {
  const members = people(),
    online = members.filter(isOnline).length;
  $('#office-presence').textContent = demo
    ? `${state.agents.length} 位演示伙伴`
    : !hasConnected
      ? '正在同步'
      : members.length
        ? `${online} / ${members.length} 在线`
        : '还没有成员';
  const active = state.agents.map(a => ({agent: a, task: activityFor(a)})).filter(r => r.task);
  $('#office-caption').textContent =
    current === 'group'
      ? '点办公室里的伙伴，直接开始私聊'
      : `正在与 ${state.agents.find(a => a.id === current)?.name || '伙伴'} 对话 · 点「一起群聊」返回团队`;
  setHTML(
    $('#work-strip'),
    active
      .slice(0, 5)
      .map(
        ({agent, task}) =>
          '<button data-scene-agent="' +
          esc(agent.id) +
          '"' +
          (task.id ? ' data-project="' + esc(task.id) + '"' : '') +
          '>' +
          avatar(agent) +
          '<strong>' +
          esc(agent.name) +
          ' · ' +
          esc(task.title) +
          '</strong><small>' +
          esc(task.step ? '第 ' + task.step + ' 步 · ' : '') +
          esc(task.detail) +
          '</small></button>'
      )
      .join('')
  );
}
function renderSidebar() {
  $('#agent-count').textContent = people().length;
  $('#group-summary').textContent = `${people().length} 位伙伴`;
  const query = $('#agent-search').value.trim().toLowerCase(),
    visible = people().filter(a => (a.name + ' ' + a.role + ' ' + a.id).toLowerCase().includes(query));
  setHTML(
    $('#conversations'),
    visible
      .map(
        a =>
          `<button class="conversation-row ${current === a.id ? 'selected' : ''}" data-agent="${esc(a.id)}" title="${esc(a.role)}" ${current === a.id ? 'aria-current="true"' : ''}>${avatar(a)}<span><strong>${esc(a.name)}</strong><small><i class="online-dot ${isOnline(a) ? '' : 'away'}"></i>${esc(demo ? statusLabels[a.status] : status(a))}</small></span></button>`
      )
      .join('') ||
      `<p class="panel-caption">${query ? '没有匹配的伙伴' : studioMode() ? '还没有成员 · 点右上角「创建 Agent」' : '还没有伙伴连接'}</p>`
  );
  $('#group-chat').classList.toggle('selected', current === 'group');
  $('#group-chat').setAttribute('aria-current', String(current === 'group'));
}
function renderHeader() {
  const a = currentAgent(),
    group = current === 'group';
  $('#conversation-title').textContent = group ? '办公室群聊' : a?.name || '伙伴对话';
  $('#conversation-kind').textContent = group ? 'TEAM CONVERSATION' : 'DIRECT MESSAGE';
  setHTML($('#room-symbol'), group ? '#' : avatar(a));
  setHTML(
    $('#room-avatars'),
    group
      ? state.agents.slice(0, 4).map(avatar).join('') +
          (state.agents.length > 4 ? `<small>+${state.agents.length - 4}</small>` : '')
      : avatar(a)
  );
  $('#conversation-subtitle').textContent = group
    ? `${people().length} 位 AI 伙伴 + 你 · 同一群聊，共享上下文`
    : a
      ? `${a.id === 'pi-local' ? a.role : a.model} · ${status(a)} · 独立私聊`
      : '正在读取伙伴信息';
  $('#connection-note').textContent = demo
    ? '演示空间 · 以下分工、发言与成果均为示例。'
    : !hasConnected
      ? '正在连接办公室，暂时保留当前记录。'
      : group
        ? '群聊中可以互相点名、引用回复，并一起查看成果。'
        : a?.managedDisabled
          ? '此伙伴已停用。可以先留言，重新启用后它会继续处理。'
          : a?.local && a.local.state !== 'ready' && !isOnline(a)
            ? a.local.state === 'starting'
              ? '本机模型正在加载。可以先留言，加载完成后它会读取并回复。'
              : '本机模型还不可用，配置好之前它不会回复。'
            : !a || !isOnline(a)
              ? '伙伴尚未连接。可以先留言，连接后由它读取并回复。'
              : '伙伴已连接，回复和执行结果会自动同步。';
  $('#composer-foot').textContent = demo
    ? '示例对话 · 未调用真实模型'
    : group
      ? '群聊共享上下文 · 真实回复由运行中的 Agent 提交'
      : '独立私聊 · 主动发布的成果对全办公室可见';
  $('#composer-input').placeholder = !group
    ? `和 ${a?.name || '伙伴'} 说点什么…`
    : demo || state.agents.length
      ? '@伙伴分配工作，或和大家一起讨论…'
      : studioMode()
        ? '先请来一位成员，再在这里分配工作…'
        : '伙伴连接后，就可以在这里分配工作…';
  $('#visual-scope').textContent = '';
}
function renderRecipients() {
  targets = new Set([...targets].filter(id => state.agents.some(a => a.id === id)));
  $('#recipients').hidden = current !== 'group' || (!targets.size && !deliveryKind());
  setHTML(
    $('#recipients'),
    `<button type="button" data-target="all" aria-pressed="${targets.size === state.agents.length && targets.size > 0}">@all</button>` +
      state.agents
        .map(
          a =>
            `<button type="button" data-target="${esc(a.id)}" aria-pressed="${targets.has(a.id)}">@${esc(a.name)}</button>`
        )
        .join('')
  );
}
function renderMessages() {
  const list = currentMessages(),
    linked = scopeList(visuals);
  const signature = JSON.stringify([
    current,
    list,
    linked.map(v => [v.id, v.messageId]),
    people().map(a => [a.id, a.name, a.status, a.local?.state, a.managedDisabled, isOnline(a)]),
    localChoices(),
    Boolean(localSetup?.pi?.version),
    hasConnected
  ]);
  if (signature === messageSignature) return;
  const log = $('#message-log'),
    nearEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 100 || !messageSignature;
  messageSignature = signature;
  if (!list.length && !demo && hasConnected && current !== 'group') {
    log.innerHTML = directEmpty(currentAgent());
    return;
  }
  if (!list.length && !demo && hasConnected && !state.agents.length) {
    log.innerHTML = onboarding();
    return;
  }
  if (!list.length) {
    log.innerHTML = `<div class="empty-chat"><span class="empty-symbol" aria-hidden="true">✳</span><h2>一个想法，<br>和伙伴一起做出来。</h2><p>左边是伙伴们的办公室，右边一起讨论。点名分工、互相回应，完成的图表与文档直接交付到协作区。</p><div class="suggestions">${STARTERS}</div></div>`;
    return;
  }
  log.innerHTML = list
    .map(m => {
      const user = (m.role || m.authorType) === 'user',
        a = state.agents.find(a => a.id === (m.agentId || m.authorId));
      const name = user ? '你' : m.authorName || a?.name || 'Agent',
        results = resultsForMessage(m, list, linked);
      const stateText =
        m.localStatus === 'sending'
          ? '正在发送'
          : m.localStatus === 'failed'
            ? '发送未确认'
            : user
              ? current === 'group'
                ? '已送达频道'
                : m.replyId
                  ? '已回复'
                  : '已保存 · 等待回复'
              : demo
                ? '演示回复'
                : 'Agent 回复';
      return `<article class="message ${user ? 'user' : 'agent'} ${current === 'group' ? 'group-message' : ''}" data-message="${esc(m.id)}"><div class="message-meta">${user ? '<strong>你</strong>' : `<button class="message-person" data-private="${esc(a?.id || m.authorId || m.agentId || '')}" aria-label="与 ${esc(name)} 私聊">${avatar(a)}<strong>${esc(name)}</strong></button><span class="speaker-role">你的伙伴</span>`}<time>${time(m.createdAt)}</time>${current === 'group' && !m.localStatus ? `<button class="message-reply" data-quote="${esc(m.id)}" aria-label="回复 ${esc(name)}">↩</button>` : ''}</div>${m.replyPreview ? `<blockquote>${esc(m.replyPreview.authorName)}：${esc(m.replyPreview.content)}</blockquote>` : ''}<div class="message-body">${highlightedMessage(m.content, state.agents)}</div>${results.map(v => `<button class="result-link" data-visual="${esc(v.id)}">${esc(v.title)}<span>查看${VISUAL_KINDS[v.kind]} ↗</span></button>`).join('')}<div class="message-state"><span>${stateText}</span>${m.localStatus === 'failed' ? `<button data-retry="${esc(m.requestId)}">重试</button>` : ''}</div></article>`;
    })
    .join('');
  if (nearEnd) log.scrollTop = log.scrollHeight;
}
const visualCommand = /^\s*(?:@\S+\s+)*\/visual\s+(document|chart|table|html)\b/i;
function deliveryKind() {
  if (!localConfig?.studio) return '';
  return $('#composer-input').value.match(visualCommand)?.[1] || $('#delivery-kind').value;
}
function outgoingContent() {
  const content = $('#composer-input').value.trim(),
    kind = deliveryKind();
  return kind && content && !visualCommand.test(content) ? `/visual ${kind} ${content}` : content;
}
function renderComposer() {
  const content = outgoingContent(),
    kind = deliveryKind();
  renderRecipients();
  const needsRecipient = kind && current === 'group' && !mentions(content).length;
  $('#delivery-kind').hidden = !localConfig?.studio;
  $('#send-button').disabled =
    !content ||
    content.length > 2000 ||
    needsRecipient ||
    sending.has(current) ||
    (!demo && !hasConnected) ||
    (current !== 'group' && !state.agents.some(a => a.id === current));
  $('#send-button').textContent = sending.has(current) ? '…' : '↑';
  $('#composer-hint').textContent =
    content.length > 1800
      ? `${content.length} / 2000`
      : needsRecipient
        ? '选一位负责交付的伙伴'
        : kind
          ? '成果对全办公室可见'
          : 'Enter 发送 · Shift + Enter 换行';
  $('#quote-draft').hidden = !quote;
  $('#quote-text').textContent = quote ? `回复 ${quote.authorName || '你'}：${quote.content}` : '';
}
function renderSteps() {
  const items = scopeList(steps);
  $('#step-tab-count').textContent = items.length || '';
  setHTML(
    $('#step-list'),
    items.length
      ? items
          .slice()
          .reverse()
          .map(
            s =>
              `<article class="step ${esc(s.status)}"><h3>${esc(s.title)}</h3>${s.detail ? `<p>${esc(s.detail)}</p>` : ''}<small>${esc(s.agentName)} · ${{started: '进行中', completed: '完成', failed: '失败', info: '记录'}[s.status]} · ${time(s.createdAt)}</small>${s.toolName ? `<br><code>${esc(s.toolName)}</code>` : ''}</article>`
          )
          .join('')
      : '<div class="visual-empty"><span aria-hidden="true">↳</span><h3>过程也值得看见</h3><p>伙伴开始工作后，这里会显示它汇报的工具使用、阶段结果和需要处理的问题。</p></div>'
  );
}
async function renderVisuals() {
  // A live link can open before the first sync has supplied the list.
  if (!demo && syncScope === null) {
    $('#visual-content').textContent = '正在同步成果…';
    return;
  }
  const items = visuals;
  $('#result-tab-count').textContent = items.length || '';
  $('#mobile-result-count').textContent = items.length || '';
  $('#visual-count').textContent = items.length ? String(items.length) : '';
  if (selectedVisual && !items.some(v => v.id === selectedVisual)) {
    selectedVisual = null;
    updateURL();
  }
  selectedVisual ??= items[0]?.id ?? null;
  setHTML(
    $('#visual-picker'),
    items
      .map(
        v =>
          `<button data-visual="${esc(v.id)}" aria-pressed="${v.id === selectedVisual}"><small>${esc(VISUAL_KINDS[v.kind] || v.kind)}</small><strong>${esc(v.title)}</strong></button>`
      )
      .join('')
  );
  $('#visual-picker').hidden = !items.length;
  $('#result-empty').hidden = !!items.length;
  if (!$('.workbench').matches('.results-expanded,.visual-overlay')) return;
  if (!selectedVisual) {
    visualSignature = '';
    // Asking for a chart only makes sense once someone is there to make it.
    $('#visual-content').innerHTML =
      '<div class="visual-empty"><span aria-hidden="true">◫</span><div><h3>讨论之后，留下可以使用的成果。</h3><p>图表、文档、表格与交互作品，会由伙伴直接交付到这里。</p></div>' +
      (demo || state.agents.length ? '<button id="try-visual">请伙伴做张图表 ↗</button>' : '') +
      '</div>';
    return;
  }
  const id = selectedVisual,
    request = ++visualRequest;
  try {
    let visual = details.get(id);
    if (!visual) {
      $('#visual-content').innerHTML = '<p class="panel-caption">正在打开成果…</p>';
      visual = (await api('/api/visuals/' + encodeURIComponent(id))).visual;
      details.set(id, visual);
    }
    if (request !== visualRequest || selectedVisual !== id) return;
    const signature = JSON.stringify(visual);
    if (signature === visualSignature) return;
    visualSignature = signature;
    const download = visualDownload(visual);
    $('#visual-content').innerHTML =
      `<article class="artifact"><header class="artifact-header"><span class="artifact-type">${VISUAL_KINDS[visual.kind]}${demo ? ' · 演示示例' : ''}</span><h3>${esc(visual.title)}</h3>${visual.summary ? `<p class="artifact-summary">${esc(visual.summary)}</p>` : ''}</header>${visual.kind === 'html' ? '<div id="html-host"></div>' : `<div class="artifact-content">${visualBody(visual)}</div>`}<footer class="artifact-footer"><span>${esc(visual.agentName)} · ${time(visual.createdAt)}</span><div class="artifact-actions"><button id="download-result" type="button">${download.label}</button><button id="copy-result">复制${visual.kind === 'html' ? '源码' : '内容'}</button></div></footer></article>`;
    if (visual.kind === 'html') {
      const preview = document.createElement('iframe');
      preview.className = 'artifact-frame';
      preview.title = visual.title;
      preview.setAttribute('sandbox', 'allow-scripts');
      preview.referrerPolicy = 'no-referrer';
      preview.srcdoc = isolatedDocument(visual.content);
      $('#html-host').append(preview);
    }
    $('#download-result').onclick = () => {
      const url = URL.createObjectURL(new Blob([download.text], {type: download.type}));
      const link = document.createElement('a');
      link.href = url;
      link.download = download.name;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    };
    $('#copy-result').onclick = () => copyText(visual.content, '已复制成果内容');
  } catch {
    if (selectedVisual === id) {
      visualSignature = '';
      $('#visual-content').innerHTML =
        '<div class="visual-empty"><h3>成果暂时无法打开</h3><p>记录可能已超出保留范围，或连接暂时中断。</p><button id="retry-visual">重新加载</button></div>';
    }
  }
}
function render() {
  renderOfficeContext();
  renderSidebar();
  renderHeader();
  panel.update(currentAgent(), people(), fileScope, visuals);
  renderMessages();
  renderComposer();
  renderSteps();
  renderVisuals();
}
async function selectConversation(id) {
  if (id === current) {
    panel.reset();
    return;
  }
  panel.reset();
  saveDraft();
  current = id;
  quote = null;
  $('#delivery-kind').value = '';
  targets.clear();
  selectedVisual = null;
  visualSignature = '';
  messageSignature = '';
  $('#composer-input').value = drafts.get(id) || '';
  errorAt('#chat-error', '');
  updateURL();
  toggleVisual(false);
  frame.contentWindow?.postMessage({type: 'office-focus-agent', agentId: id === 'group' ? null : id}, location.origin);
  render();
  if (!demo) await poll();
}
// Keep messages that are still being sent (or failed) after the server's copy arrives.
function applyConversation(conversation) {
  const {scope, messages} = conversation,
    ids = new Set(messages.map(m => m.requestId)),
    local = (conversations.get(scope) || []).filter(m => m.localStatus && !ids.has(m.requestId));
  conversations.set(scope, [...messages, ...local]);
}
// One request every few seconds brings everything the workspace shows. The server answers
// 304 while nothing has changed, so an idle office costs almost nothing to watch.
async function poll() {
  if (demo || document.hidden) return;
  if (polling) {
    pollAgain = true;
    return;
  }
  polling = true;
  const scope = current;
  try {
    const response = await fetch('/api/sync?scope=' + encodeURIComponent(scope), {
      cache: 'no-store',
      signal: AbortSignal.timeout(12000),
      headers: syncTag && syncScope === scope ? {'If-None-Match': syncTag} : {}
    });
    if (response.status !== 304) {
      const data = await response.json();
      if (!response.ok || !validState(data.state)) throw Error(data.error || '连接暂时不可用');
      syncTag = response.headers.get('etag');
      syncScope = scope;
      if ((data.revision ?? -1) >= (state.revision ?? -1)) state = data.state;
      visuals = data.visuals;
      const retained = new Set(visuals.map(v => v.id));
      for (const key of details.keys()) if (!retained.has(key)) details.delete(key);
      steps = data.steps;
      if (!data.conversation.missing) applyConversation(data.conversation);
    }
    fileScope = response.headers.get('X-Office-Member-Files') === '1' ? scope : null;
    // Presence ages even when nothing changed (an Agent goes quiet), so refresh the scene.
    sendOfficeState();
    hasConnected = true;
    $('#sync-status').textContent =
      localMode === 'local' ? '● 本地办公室' : localMode === 'remote' ? '● 远程共享办公室' : '● 实时连接';
    errorAt('#chat-error', '');
    errorAt('#visual-error', '');
    if (scope === current && current !== 'group' && !currentAgent()) {
      current = 'group';
      $('#delivery-kind').value = '';
      targets.clear();
      quote = null;
      selectedVisual = null;
      $('#composer-input').value = drafts.get(current) || '';
      updateURL();
      pollAgain = true;
    }
  } catch {
    hasConnected = false;
    $('#sync-status').textContent = '连接中断 · 正在重试';
    errorAt('#chat-error', '聊天记录暂时无法同步。当前内容仍保留，将自动重试。');
  } finally {
    polling = false;
    render();
    // The conversation changed while the request was in flight: fetch the new one now.
    if (pollAgain || current !== scope) {
      pollAgain = false;
      poll();
    }
  }
}
function mentions(content) {
  const all = /(^|\s)@all\b/i.test(content);
  return all ? state.agents.map(a => a.id) : [...new Set([...targets, ...mentionedAgents(content, state.agents)])];
}
async function send() {
  renderComposer();
  if ($('#send-button').disabled) return;
  const content = outgoingContent();
  const requestId = crypto.randomUUID(),
    scope = current;
  const message = {
    id: requestId,
    requestId,
    content,
    createdAt: Date.now(),
    localStatus: 'sending',
    ...(scope === 'group'
      ? {
          authorType: 'user',
          authorId: null,
          authorName: '你',
          mentions: mentions(content),
          replyTo: quote?.id || null,
          replyPreview: quote ? {authorName: quote.authorName, content: quote.content.slice(0, 180)} : null,
          taskId: quote?.taskId || null
        }
      : {agentId: scope, role: 'user', replyId: null})
  };
  conversations.set(scope, [...(conversations.get(scope) || []), message]);
  $('#composer-input').value = '';
  $('#delivery-kind').value = '';
  saveDraft();
  quote = null;
  targets.clear();
  await deliver(message, scope);
}
async function deliver(message, scope) {
  if (sending.has(scope)) return;
  sending.add(scope);
  message.localStatus = 'sending';
  errorAt('#chat-error', '');
  render();
  try {
    if (demo) {
      delete message.localStatus;
      demoReply(message, scope);
      saveDemo();
    } else {
      const body =
        scope === 'group'
          ? {
              requestId: message.requestId,
              content: message.content,
              mentions: message.mentions,
              replyTo: message.replyTo,
              taskId: message.taskId
            }
          : {agentId: scope, requestId: message.requestId, content: message.content};
      const data = await api(scope === 'group' ? '/api/channel' : '/api/chat', body);
      conversations.set(
        scope,
        (conversations.get(scope) || []).map(m => (m.requestId === message.requestId ? data.message : m))
      );
    }
  } catch (error) {
    const item = (conversations.get(scope) || []).find(m => m.requestId === message.requestId);
    if (item?.localStatus) {
      item.localStatus = 'failed';
      if (current === scope)
        errorAt(
          '#chat-error',
          error.message.includes('pending')
            ? '未回复的留言已满，请等待 Agent 处理后再发送。'
            : '消息发送未确认。点「重试」会复用原请求，避免重复发送。'
        );
    }
  } finally {
    sending.delete(scope);
    render();
  }
}
function selectTab(tab) {
  selectedTab = tab;
  for (const key of ['results', 'steps']) {
    const on = key === tab;
    $('#tab-' + key).setAttribute('aria-selected', String(on));
    $('#tab-' + key).tabIndex = on ? 0 : -1;
    $('#panel-' + key).hidden = !on;
  }
}
async function copyText(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    toast('无法自动复制，请在连接框中选择地址复制');
  }
}
function chooseVisual(id) {
  selectedVisual = id;
  visualSignature = '';
  toggleVisual(true);
  updateURL();
  selectTab('results');
  renderVisuals();
}
function demoReply(message, scope) {
  const agent = state.agents.find(a => a.id === (scope === 'group' ? message.mentions[0] : scope)) || state.agents[0];
  if (!agent) return;
  const id = crypto.randomUUID(),
    now = Date.now();
  const isHTML = /HTML|交互|小工具/i.test(message.content),
    isDoc = /计划|下一步|文档/.test(message.content);
  const kind = isHTML ? 'html' : isDoc ? 'document' : 'chart',
    title = isHTML ? '把协作变成可交互的作品' : isDoc ? '从网页走向应用的行动计划' : '当前任务进度';
  const content = isHTML
    ? demoHTML
    : isDoc
      ? demoDocument
      : JSON.stringify({
          labels: state.tasks.map(t => t.title),
          values: state.tasks.map(t => Math.round(t.progress)),
          unit: '%'
        });
  const visual = {
    id,
    agentId: agent.id,
    agentName: agent.name,
    title,
    summary: '演示示例，用于体验对话与 Visual 的联动。',
    kind,
    content,
    messageId: message.id,
    taskId: null,
    createdAt: now
  };
  visuals.unshift(visual);
  visuals = visuals.slice(0, 40);
  details.set(id, visual);
  selectedVisual = id;
  const reply = {
    id: crypto.randomUUID(),
    content:
      '演示成果已经放到左侧协作区。你可以打开查看，也可以继续提出修改意见。连接真实 Agent 后，这里会显示它实际生成的内容。',
    createdAt: now,
    replyTo: message.id,
    ...(scope === 'group'
      ? {
          authorType: 'agent',
          authorId: agent.id,
          authorName: agent.name,
          mentions: [],
          replyPreview: {authorName: '你', content: message.content.slice(0, 180)}
        }
      : {agentId: agent.id, role: 'agent'})
  };
  message.replyId = reply.id;
  conversations.set(scope, [...(conversations.get(scope) || []), reply].slice(-100));
  steps.push({
    id: crypto.randomUUID(),
    agentId: agent.id,
    agentName: agent.name,
    title: '演示：生成并发布 Visual',
    detail: '本地示例，用于查看消息、成果和执行记录如何关联。没有执行模型或外部工具。',
    status: 'completed',
    toolName: 'office_publish_visual',
    messageId: message.id,
    createdAt: now
  });
  steps = steps.slice(-200);
}
const demoDocument =
  '# 对话与 Visual 工作台\n\n让一个想法，从聊天走到可以查看的成果。\n\n## 已有的工作方式\n- 和单个伙伴对话，或在群聊里点名协作。\n- 在 Visual 中查看图表、表格、文档和交互 HTML。\n- 让 Agent 汇报实际执行步骤，关联到消息或任务。\n\n## 走向独立 App\n先完成网页闭环，再接常驻 Agent 运行环境与模型服务。原生应用可以复用这些接口和界面。\n\n这是交互演示文档，不代表后台已启动模型。';
const demoHTML =
  '<style>body{padding:12px;background:#f7f8f2}h2{font-weight:500;font-size:26px}p{color:#71816f;line-height:1.8}.layout{display:grid;gap:12px;margin:30px 0;grid-template-columns:1fr 1fr}.tile{padding:24px 12px;border:1px solid #dce3d5;border-radius:12px;background:white;text-align:center}button{border:0;border-radius:20px;background:#47745b;color:white;padding:12px 22px}.note{font-size:11px}</style><p class="note">自包含 HTML · 演示作品</p><h2>给想法，多一种打开方式。</h2><p>同一份内容，可以拥有不同的视角。</p><div class="layout" id="layout"><div class="tile">对话<br><small>提出问题</small></div><div class="tile">Visual<br><small>展开答案</small></div></div><button id="switch">切换为上下布局</button><p class="note">这个按钮运行在隔离预览中。</p><script>let stacked=false;document.getElementById("switch").onclick=function(){stacked=!stacked;document.getElementById("layout").style.gridTemplateColumns=stacked?"1fr":"1fr 1fr";this.textContent=stacked?"切换为左右布局":"切换为上下布局"}</script>';
function seedDemo() {
  const now = Date.now(),
    writer = state.agents.find(a => a.model === 'Claude'),
    builder = state.agents.find(a => a.model === 'Codex'),
    designer = state.agents.find(a => a.model === 'Gemini'),
    messageId = 'demo_team_user',
    resultMessage = 'demo_team_delivery';
  visuals = [
    {
      id: 'demo_visual_chart',
      agentId: builder.id,
      agentName: builder.name,
      title: '团队任务 · 一起推进',
      summary: '演示数据 · 伙伴的分工、进度和交付放在同一处。',
      kind: 'chart',
      content: JSON.stringify({
        labels: state.tasks.map(t => t.title),
        values: state.tasks.map(t => Math.round(t.progress)),
        unit: '%'
      }),
      messageId: resultMessage,
      createdAt: now - 60000
    },
    {
      id: 'demo_visual_document',
      agentId: writer.id,
      agentName: writer.name,
      title: '方案与行动计划',
      summary: '演示文档 · 从共同讨论走到清晰的分工。',
      kind: 'document',
      content: demoDocument,
      messageId: null,
      createdAt: now - 120000
    },
    {
      id: 'demo_visual_html',
      agentId: designer.id,
      agentName: designer.name,
      title: '交互作品',
      summary: '演示作品 · 点击按钮，切换内容布局。',
      kind: 'html',
      content: demoHTML,
      messageId: null,
      createdAt: now - 180000
    },
    {
      id: 'demo_visual_table',
      agentId: builder.id,
      agentName: builder.name,
      title: '协作能力清单',
      summary: '演示清单 · 对话、执行过程和成果互相关联。',
      kind: 'table',
      content: JSON.stringify({
        columns: ['能力', '作用'],
        rows: [
          ['伙伴群聊', '点名、引用、共同讨论'],
          ['共享办公室', '查看伙伴与任务状态'],
          ['可视化交付', '图表、文档、交互作品']
        ]
      }),
      messageId: null,
      createdAt: now - 240000
    }
  ];
  conversations.set('group', [
    {
      id: messageId,
      authorType: 'user',
      authorName: '你',
      content: '@all 今天把产品方案往前推进一下，大家分工，成果直接放到左边。',
      mentions: [writer.id, builder.id, designer.id],
      createdAt: now - 240000
    },
    {
      id: 'demo_team_plan',
      authorType: 'agent',
      authorId: writer.id,
      authorName: writer.name,
      content: '我整理方案，@Codex 做实现，@Gemini 补视觉。',
      mentions: [builder.id, designer.id],
      replyTo: messageId,
      createdAt: now - 180000
    },
    {
      id: resultMessage,
      authorType: 'agent',
      authorId: builder.id,
      authorName: builder.name,
      content: '@Claude 进度图已放到左边，分工和交付都能直接看。',
      mentions: [writer.id],
      replyTo: 'demo_team_plan',
      createdAt: now - 60000
    },
    {
      id: 'demo_team_design',
      authorType: 'agent',
      authorId: designer.id,
      authorName: designer.name,
      content: '交互作品也好了。@Codex 点左边作品卡片就能试。',
      mentions: [builder.id],
      replyTo: resultMessage,
      createdAt: now - 30000
    }
  ]);
  steps = [
    {
      id: 'demo_step_plan',
      agentId: writer.id,
      agentName: writer.name,
      title: '演示：整理方案与分工',
      detail: '把讨论整理成行动计划，交给伙伴继续推进。',
      status: 'completed',
      toolName: 'office_publish_visual',
      messageId: 'demo_team_plan',
      createdAt: now - 150000
    },
    {
      id: 'demo_step_chart',
      agentId: builder.id,
      agentName: builder.name,
      title: '演示：交付任务进度图表',
      detail: '将图表关联到群聊中的交付消息。',
      status: 'completed',
      toolName: 'office_publish_visual',
      messageId: resultMessage,
      createdAt: now - 60000
    },
    {
      id: 'demo_step_design',
      agentId: designer.id,
      agentName: designer.name,
      title: '演示：交付交互作品',
      detail: '一个可在隔离预览中操作的 HTML 示例。',
      status: 'completed',
      toolName: 'office_publish_visual',
      messageId: 'demo_team_design',
      createdAt: now - 30000
    }
  ];
}
try {
  const saved = JSON.parse(localStorage.getItem(draftKey) || '{}');
  for (const [key, value] of Object.entries(saved))
    if (typeof value === 'string') drafts.set(key, value.slice(0, 2000));
} catch {}
try {
  document.body.classList.toggle('night', localStorage.getItem('agent-office-night') === '1');
} catch {}
if (demo) {
  try {
    demoSaved = JSON.parse(localStorage.getItem(memoryKey) || 'null');
  } catch {}
  if (demoSaved && Array.isArray(demoSaved.visuals) && Array.isArray(demoSaved.steps) && demoSaved.conversations) {
    visuals = demoSaved.visuals;
    steps = demoSaved.steps;
    for (const [scope, list] of Object.entries(demoSaved.conversations))
      if (Array.isArray(list)) conversations.set(scope, list);
  } else seedDemo();
  for (const v of visuals) details.set(v.id, v);
  $('#sync-status').textContent = '◌ 演示模式';
}
$('#composer-input').value = drafts.get(current) || '';
$('#office-manage').href = './office.html?manage=1' + (demo ? '&demo=1' : '');
$('#connection-code').textContent = 'mcp_servers:\n  agent_office:\n    url: "' + location.origin + '/mcp"';
$('#open-connection-guide').onclick = () => {
  document.querySelector('.office-options').open = false;
  $('#connect-dialog').showModal();
};
$('#mode-switch').href = demo ? './' : '?demo=1';
$('#mode-switch').textContent = demo ? '返回实时工作台' : '体验演示';
$('#mcp-address').value = location.origin + '/mcp';
if (onLoopback && !demo) {
  $('#connect-dialog > p').textContent =
    localMode === 'remote'
      ? '本机 Pi 可以和远程 Hermes 在这个办公室收发消息、领取任务。'
      : '用 npm run local 启动 Pi。它上线后，点「Pi（本机）」私聊，或在群聊点名它。';
  $('#connect-dialog li').textContent = '同一台电脑上的其他 Agent 也可以使用上面的 MCP 地址。';
}
frame.src = './embed.html' + (demo ? '?demo=1' : '');
frame.addEventListener('load', () => {
  $('#office-loading').hidden = true;
  syncOfficeFrame();
});
$('#theme-toggle').onclick = () => {
  document.body.classList.toggle('night');
  const night = document.body.classList.contains('night');
  try {
    localStorage.setItem('agent-office-night', night ? '1' : '0');
  } catch {}
  $('meta[name="theme-color"]').content = night ? '#181d19' : '#f5f4ef';
  $('#theme-toggle').setAttribute('aria-label', night ? '切换浅色模式' : '切换深色模式');
  frame.contentWindow?.postMessage({type: 'office-theme', night}, location.origin);
};
$('#visual-toggle').onclick = () => {
  selectTab('results');
  toggleVisual(true);
};
$('#close-visual').onclick = () => toggleVisual(false);
$('#expand-results').onclick = () => toggleVisual(!$('.workbench').classList.contains('results-expanded'));
$('#start-chat').onclick = async () => {
  await selectConversation('group');
  targets = new Set(state.agents.map(a => a.id));
  renderComposer();
  $('#composer-input').focus();
};
$('#work-strip').onclick = e => {
  const button = e.target.closest('[data-scene-agent]');
  if (button)
    selectConversation(button.dataset.sceneAgent).then(() => {
      if (button.dataset.project) panel.project({taskId: button.dataset.project});
    });
};
$('#agent-search').oninput = renderSidebar;
$('#group-chat').onclick = () => selectConversation('group');
$('#conversations').onclick = e => {
  const b = e.target.closest('[data-agent]');
  if (b) selectConversation(b.dataset.agent);
};
$('#recipients').onclick = e => {
  const b = e.target.closest('[data-target]');
  if (!b) return;
  const id = b.dataset.target;
  if (id === 'all') targets = targets.size === state.agents.length ? new Set() : new Set(state.agents.map(a => a.id));
  else targets.has(id) ? targets.delete(id) : targets.add(id);
  renderComposer();
};
$('#delivery-kind').onchange = renderComposer;
$('#composer').onsubmit = e => {
  e.preventDefault();
  send();
};
$('#composer-input').oninput = () => {
  saveDraft();
  renderComposer();
};
$('#composer-input').onkeydown = e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    send();
  }
};
$('#quote-cancel').onclick = () => {
  quote = null;
  renderComposer();
};
$('#message-log').onclick = e => {
  const template = e.target.closest('[data-template]');
  if (template) {
    openStudio(TEMPLATES[template.dataset.template]);
    return;
  }
  if (e.target.closest('[data-connect]')) {
    $('#connect-dialog').showModal();
    return;
  }
  if (e.target.closest('[data-member-settings]')) {
    panel.settings();
    return;
  }
  const localMember = e.target.closest('[data-local-member]');
  if (localMember) {
    void createLocalMember(JSON.parse(localMember.dataset.localMember), localMember);
    return;
  }
  const piModel = e.target.closest('[data-pi-model]');
  if (piModel) {
    void usePiModel(JSON.parse(piModel.dataset.piModel), piModel);
    return;
  }
  const person = e.target.closest('[data-private]');
  if (person && state.agents.some(a => a.id === person.dataset.private)) {
    selectConversation(person.dataset.private);
    return;
  }
  const prompt = e.target.closest('[data-prompt]'),
    retry = e.target.closest('[data-retry]'),
    quoted = e.target.closest('[data-quote]'),
    visual = e.target.closest('[data-visual]');
  if (prompt) {
    if (localConfig?.studio) $('#delivery-kind').value = prompt.dataset.kind;
    $('#composer-input').value = prompt.dataset.prompt;
    saveDraft();
    renderComposer();
    $('#composer-input').focus();
  }
  if (retry) {
    const m = currentMessages().find(m => m.requestId === retry.dataset.retry);
    if (m) deliver(m, current);
  }
  if (quoted) {
    quote = currentMessages().find(m => m.id === quoted.dataset.quote);
    if (quote?.authorId) targets.add(quote.authorId);
    renderComposer();
    $('#composer-input').focus();
  }
  if (visual) chooseVisual(visual.dataset.visual);
};
$('#visual-picker').onclick = e => {
  const b = e.target.closest('[data-visual]');
  if (b) chooseVisual(b.dataset.visual);
};
$('#visual-content').onclick = e => {
  if (e.target.closest('#try-visual')) {
    if (localConfig?.studio) $('#delivery-kind').value = 'chart';
    $('#composer-input').value = '请把当前任务整理成图表，发布到 Visual。';
    saveDraft();
    renderComposer();
    if (compactScreen.matches) toggleVisual(false);
    $('#composer-input').focus();
  }
  if (e.target.closest('#retry-visual')) {
    visualSignature = '';
    renderVisuals();
  }
};
$('.visual-tabs').onclick = e => {
  const b = e.target.closest('[data-tab]');
  if (b) selectTab(b.dataset.tab);
};
$('.visual-tabs').onkeydown = e => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  e.preventDefault();
  const tabs = ['results', 'steps'],
    i = tabs.indexOf(selectedTab),
    next = e.key === 'Home' ? 0 : e.key === 'End' ? 1 : (i + 1) % 2;
  selectTab(tabs[next]);
  $('#tab-' + tabs[next]).focus();
};
function openStudio(template) {
  if (!studioMode()) return $('#connect-dialog').showModal();
  panel.create(template);
}
const connectButton = $('#connect-button');
if (studioMode()) {
  $('#connect-dialog > p').textContent = '其他 Agent 客户端可以通过本机 MCP 地址加入这个办公室。';
  $('#connect-dialog .muted').textContent = '外部伙伴在自己的客户端运行。连接后可在成员设置中管理它的办公室资料。';
  connectButton.innerHTML = '<span aria-hidden="true">＋</span> 创建 Agent';
  connectButton.onclick = () => openStudio();
} else connectButton.onclick = () => $('#connect-dialog').showModal();
$('#close-connect').onclick = () => $('#connect-dialog').close();
$('#copy-mcp').onclick = () => copyText($('#mcp-address').value, '已复制 MCP 地址');
window.addEventListener('message', e => {
  if (e.origin !== location.origin || e.source !== frame.contentWindow) return;
  if (e.data?.type === 'office-ready') syncOfficeFrame();
  if (e.data?.type === 'office-select-agent' && state.agents.some(a => a.id === e.data.agentId))
    selectConversation(e.data.agentId);
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') toggleVisual(false);
});
document.addEventListener('visibilitychange', () => {
  frameVisibility();
  if (!document.hidden) poll();
});
compactScreen.addEventListener('change', () => {
  $('.workbench').classList.remove('visual-overlay', 'results-expanded');
  $('#conversation').inert = false;
  $('.office-live').inert = false;
  toggleVisual(false);
});
// Installing as an app. Chromium browsers offer a prompt (beforeinstallprompt); Safari has
// none, so there the button opens a short guide. Nothing shows inside the installed app.
const installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const safari =
  /safari/i.test(navigator.userAgent) && !/chrome|chromium|crios|fxios|edg|android/i.test(navigator.userAgent);
let installPrompt = null;
$('#install-app').hidden = installed || !safari;
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  installPrompt = event;
  $('#install-app').hidden = installed;
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  $('#install-app').hidden = true;
  toast('已安装 Agent Office，可以从主屏幕、程序坞或开始菜单打开。');
});
$('#install-app').onclick = async () => {
  if (!installPrompt) return $('#install-dialog').showModal();
  installPrompt.prompt();
  const {outcome} = await installPrompt.userChoice;
  installPrompt = null;
  if (outcome === 'accepted') $('#install-app').hidden = true;
};
$('#close-install').onclick = () => $('#install-dialog').close();

// One click from a detected Ollama / LM Studio: reuse or add the connection, then add a member.
async function createLocalMember({name, url, model}, button) {
  button.disabled = true;
  try {
    const studio = (path = '', method = 'GET', body) =>
      fetch('/api/studio' + path, {
        method,
        cache: 'no-store',
        ...(body && {headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)})
      }).then(async r => {
        const data = await r.json();
        if (!r.ok) throw Error(data.error || '创建失败，请重试。');
        return data;
      });
    const catalog = await studio();
    const connection =
      catalog.connections.find(c => c.baseUrl === url && c.model === model) ||
      (await studio('/connections', 'POST', {name: name + ' · ' + model, baseUrl: url, model})).connection;
    const taken = new Set(people().map(a => a.name));
    let memberName = '本机助手';
    for (let i = 2; taken.has(memberName); i++) memberName = '本机助手 ' + i;
    const {agent} = await studio('/agents', 'POST', {
      name: memberName,
      role: '用本机 ' + name + ' 处理日常工作',
      instructions: '',
      connectionId: connection.id
    });
    await loadProfiles();
    syncTag = null;
    await poll();
    await selectConversation(agent.id);
    toast('已创建「' + agent.name + '」，使用本机 ' + name + ' · ' + model + '。');
  } catch (error) {
    toast(error.message);
    button.disabled = false;
  }
}
async function usePiModel({name, url, model}, button) {
  button.disabled = true;
  try {
    await savePiSetup({url, model});
    toast('正在让 Pi 使用本机 ' + name + ' · ' + model + '…');
    for (let i = 0; i < 60; i++) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      await loadProfiles();
      const state = profiles.find(p => p.id === 'pi-local')?.local?.state;
      if (state && state !== 'starting') break;
    }
    syncTag = null;
    await poll();
    render();
  } catch (error) {
    toast(error.message);
    button.disabled = false;
  }
}

async function enterOffice() {
  await loadLocalSetup();
  await loadProfiles();
  render();
  if (!demo) await poll();
  const query = initialLink.searchParams;
  if (query.has('visual')) chooseVisual(query.get('visual'));
  if (query.has('task') && localConfig?.workbench) {
    try {
      const {session} = await api('/api/studio/projects/' + encodeURIComponent(query.get('task')));
      const owner = session.agentId || 'pi-local';
      if (!people().some(a => a.id === owner)) throw Error();
      await selectConversation(owner);
      await panel.project({taskId: session.id});
    } catch {
      toast('这个项目会话暂时无法打开。');
    }
  } else if (query.has('create') || query.has('studio')) {
    if (currentAgent() && !query.has('create')) panel.settings();
    else openStudio();
  } else if (query.get('panel') === 'settings') panel.settings();
  else if (query.get('panel') === 'files') panel.files();
  if (query.get('connect') === '1') $('#connect-dialog').showModal();
  const url = new URL(location.href);
  url.searchParams.delete('studio');
  history.replaceState(null, '', url);
  void loadProjectRuns();
}
void enterOffice();
document.addEventListener('office-project-change', loadProjectRuns);
setInterval(loadProjectRuns, 2500);
setInterval(poll, 4000);
