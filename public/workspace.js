import {MODELS, initialState, validState} from './data.js';
import {resultsForMessage, highlightedMessage} from './collaboration-view.js';
import {mentionedAgents} from './channel.js';
import {escapeHTML as esc, VISUAL_KINDS, visualBody, isolatedDocument, visualDownload} from './visual-renderer.js';
import {onLoopback, readLocalConfig} from './local-mode.js';
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
const time = value => new Date(value).toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit'});
const scopeList = items => (current === 'group' ? items : items.filter(item => item.agentId === current));
const currentMessages = () => conversations.get(current) || [];
const statusLabels = {working: '工作中', thinking: '处理中', resting: '在线待命'};
const isOnline = a => !a.managedDisabled && (demo || !!(a.lastSeen && Date.now() - a.lastSeen < 300000));
const status = a =>
  a.managedDisabled ? '已停用' : demo ? '演示伙伴' : isOnline(a) ? statusLabels[a.status] : '等待连接';
const avatar = a => {
  const m = MODELS[a?.model] || MODELS.Hermes;
  return `<span class="avatar" aria-hidden="true" style="--avatar-bg:${m.bg};--avatar-ink:${m.color}">${m.mark}</span>`;
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
  selectedVisual ? url.searchParams.set('visual', selectedVisual) : url.searchParams.delete('visual');
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
  frame.contentWindow?.postMessage({type: 'office-state', state}, location.origin);
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
  board.classList.toggle(compactScreen.matches ? 'visual-overlay' : 'results-expanded', show);
  $('#conversation').inert = compactScreen.matches && show;
  $('.office-live').inert = compactScreen.matches && show;
  $('#visual-toggle').setAttribute('aria-expanded', String(show));
  $('#expand-results').setAttribute('aria-expanded', String(show));
  $('#expand-results').textContent = show ? '恢复分屏 ↙' : '展开 ↗';
  frameVisibility();
  if (compactScreen.matches) (show ? $('#close-visual') : $('#visual-toggle')).focus({preventScroll: true});
}
function renderOfficeContext() {
  const online = state.agents.filter(isOnline).length;
  $('#office-presence').textContent = demo
    ? `${state.agents.length} 位演示伙伴`
    : hasConnected
      ? `${online} / ${state.agents.length} 在线`
      : '正在同步';
  const active = state.tasks.filter(t => t.status === 'active');
  $('#office-caption').textContent =
    current === 'group'
      ? '点办公室里的伙伴，直接开始私聊'
      : `正在与 ${state.agents.find(a => a.id === current)?.name || '伙伴'} 对话 · 点「一起群聊」返回团队`;
  setHTML(
    $('#work-strip'),
    active.length
      ? '<span>正在推进</span>' +
          active
            .slice(0, 4)
            .map(t => {
              const a = state.agents.find(a => a.id === t.agentId);
              return `<button data-scene-agent="${esc(t.agentId)}" title="${esc((a?.name || '伙伴') + ' · ' + t.title)}">${avatar(a)}<strong>${esc(t.title)}</strong><small>${Math.round(t.progress)}%</small></button>`;
            })
            .join('')
      : '<span>' +
          (!online && !demo
            ? '等待伙伴连接，收到任务后会在这里同步。'
            : '伙伴们现在没有执行中的任务，可以在群聊里讨论下一步。') +
          '</span>'
  );
}
function renderSidebar() {
  $('#agent-count').textContent = state.agents.length;
  $('#group-summary').textContent = `${state.agents.length} 位伙伴`;
  const query = $('#agent-search').value.trim().toLowerCase(),
    visible = state.agents.filter(a => (a.name + ' ' + a.role + ' ' + a.id).toLowerCase().includes(query));
  setHTML(
    $('#conversations'),
    visible
      .map(
        a =>
          `<button class="conversation-row ${current === a.id ? 'selected' : ''}" data-agent="${esc(a.id)}" title="${esc(a.role)}" ${current === a.id ? 'aria-current="true"' : ''}>${avatar(a)}<span><strong>${esc(a.name)}</strong><small><i class="online-dot ${isOnline(a) ? '' : 'away'}"></i>${esc(demo ? statusLabels[a.status] : status(a))}</small></span></button>`
      )
      .join('') || '<p class="panel-caption">没有匹配的伙伴</p>'
  );
  $('#group-chat').classList.toggle('selected', current === 'group');
  $('#group-chat').setAttribute('aria-current', String(current === 'group'));
}
function renderHeader() {
  const a = state.agents.find(a => a.id === current),
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
    ? `${state.agents.length} 位 AI 伙伴 + 你 · 同一群聊，共享上下文`
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
          : !a || !isOnline(a)
            ? '伙伴尚未连接。可以先留言，连接后由它读取并回复。'
            : '伙伴已连接，回复和执行结果会自动同步。';
  $('#composer-foot').textContent = demo
    ? '示例对话 · 未调用真实模型'
    : group
      ? '群聊共享上下文 · 真实回复由运行中的 Agent 提交'
      : '独立私聊 · 主动发布的成果对全办公室可见';
  $('#composer-input').placeholder = group ? '@伙伴分配工作，或和大家一起讨论…' : `和 ${a?.name || '伙伴'} 说点什么…`;
  $('#visual-scope').textContent = group ? '全员交付的成果，在同一处查看' : `${a?.name || '伙伴'} 的成果与执行记录`;
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
    state.agents.map(a => [a.id, a.name])
  ]);
  if (signature === messageSignature) return;
  const log = $('#message-log'),
    nearEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 100 || !messageSignature;
  messageSignature = signature;
  if (!list.length) {
    log.innerHTML = `<div class="empty-chat"><span class="empty-symbol" aria-hidden="true">✳</span><h2>一个想法，<br>和伙伴一起做出来。</h2><p>左边是伙伴们的办公室，右边一起讨论。点名分工、互相回应，完成的图表与文档直接交付到协作区。</p><div class="suggestions"><button data-kind="chart" data-prompt="请整理当前任务，并把进度发布成图表。">把当前任务变成图表 <span>↗</span></button><button data-kind="document" data-prompt="请梳理这个项目的下一步，把行动计划文档发布到成果区。">一起想清楚下一步 <span>↗</span></button><button data-kind="html" data-prompt="请做一个能交互的 HTML 小工具，发布到 Visual。">把想法变成可交互的作品 <span>↗</span></button></div></div>`;
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
  const items = scopeList(visuals);
  $('#result-tab-count').textContent = items.length || '';
  $('#mobile-result-count').textContent = items.length || '';
  $('#visual-count').textContent = items.length ? String(items.length).padStart(2, '0') : '';
  if (selectedVisual && !items.some(v => v.id === selectedVisual)) {
    selectedVisual = null;
    updateURL();
  }
  selectedVisual ??= items[0]?.id ?? null;
  setHTML(
    $('#visual-picker'),
    items
      .map(v => `<button data-visual="${esc(v.id)}" aria-pressed="${v.id === selectedVisual}">${esc(v.title)}</button>`)
      .join('')
  );
  $('#visual-picker').hidden = !items.length;
  if (!selectedVisual) {
    visualSignature = '';
    $('#visual-content').innerHTML =
      '<div class="visual-empty"><span aria-hidden="true">◫</span><div><h3>讨论之后，留下可以使用的成果。</h3><p>图表、文档、表格与交互作品，会由伙伴直接交付到这里。</p></div><button id="try-visual">请伙伴做张图表 ↗</button></div>';
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
    updateURL();
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
  renderMessages();
  renderComposer();
  renderSteps();
  renderVisuals();
}
async function selectConversation(id) {
  if (id === current) return;
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
  if (compactScreen.matches) toggleVisual(false);
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
    // Presence ages even when nothing changed (an Agent goes quiet), so refresh the scene.
    sendOfficeState();
    hasConnected = true;
    $('#sync-status').textContent =
      localMode === 'local' ? '● 本地办公室' : localMode === 'remote' ? '● 远程共享办公室' : '● 实时连接';
    errorAt('#chat-error', '');
    errorAt('#visual-error', '');
    if (current !== 'group' && !state.agents.some(a => a.id === current)) {
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
  if (compactScreen.matches) toggleVisual(true);
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
$('#full-office').href = './office.html' + (demo ? '?demo=1' : '');
$('#connection-details').href = './office.html?connect=1' + (demo ? '&demo=1' : '');
$('#mode-switch').href = demo ? './' : '?demo=1';
$('#mode-switch').textContent = demo ? '返回实时工作台' : '体验演示';
$('#mcp-address').value = location.origin + '/mcp';
if (onLoopback && !demo) {
  $('#connection-details').textContent = '本机 MCP 连接配置 ↗';
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
  if (button) selectConversation(button.dataset.sceneAgent);
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
const connectButton = $('#connect-button');
if (localConfig?.studio === true) {
  $('#connect-dialog > p').textContent = '其他 Agent 客户端可以通过本机 MCP 地址加入这个办公室。';
  $('#connect-dialog .muted').textContent =
    '通过工作室创建的 Agent 会在本机启动。外部伙伴的执行方式由各自的客户端配置。';
  connectButton.innerHTML = '<span aria-hidden="true">＋</span> 创建 Agent';
  connectButton.onclick = async () => {
    try {
      const {openAgentStudio} = await import('./agent-studio.js');
      await openAgentStudio({
        onChanged: poll,
        onAgent: async agent => {
          await selectConversation(agent.id);
          await poll();
          $('#composer-input').focus();
        },
        onConnect: () => $('#connect-dialog').showModal()
      });
    } catch {
      toast('暂时无法打开工作室，请刷新页面重试');
    }
  };
  const entry = new URL(location.href);
  if (entry.searchParams.get('studio') === '1') {
    entry.searchParams.delete('studio');
    history.replaceState(null, '', entry);
    connectButton.click();
  }
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

render();
poll();
setInterval(poll, 4000);
