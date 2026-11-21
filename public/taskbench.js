import {escapeHTML as esc, markdown} from './visual-renderer.js';
import {mountProjectChecks} from './project-checks.js';

const icons = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  menu: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/>',
  office: '<path d="m3 9 9-5 9 5-9 5ZM3 9v8l9 5 9-5V9M12 14v8"/>',
  settings: '<path d="M3 7h7m4 0h7M3 17h10m4 0h4"/><circle cx="12" cy="7" r="2"/><circle cx="15" cy="17" r="2"/>',
  'arrow-up-right': '<path d="M7 17 17 7M7 7h10v10"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  tree: '<path d="M5 5v12a2 2 0 0 0 2 2h3M5 9h5"/><rect x="11" y="6" width="9" height="5" rx="1.5"/><rect x="11" y="16" width="9" height="5" rx="1.5"/>',
  test: '<path d="M9 3h6m-5 0v6l-5 8a2 2 0 0 0 1.7 3h10.6a2 2 0 0 0 1.7-3l-5-8V3M8 14h8"/>',
  terminal: '<path d="m4 6 6 6-6 6m9 0h7"/>',
  chevron: '<path d="m8 10 4 4 4-4"/>',
  up: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
  file: '<path d="M6 3h8l4 4v14H6ZM14 3v5h4"/>',
  change: '<path d="M8 3v11a4 4 0 0 0 4 4h2M5 6l3-3 3 3M16 21v-9a4 4 0 0 0-4-4h-1m2 10 3 3 3-3"/>'
};
function icon(name) {
  return (
    '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">' +
    icons[name] +
    '</svg>'
  );
}
const byId = name => document.getElementById('tb-' + name);
const basename = path => path?.split(/[\\/]/).filter(Boolean).at(-1) || path;
const storage = {
  read(key) {
    try {
      return JSON.parse(localStorage.getItem('ao-project-' + key));
    } catch {
      return null;
    }
  },
  write(key, value) {
    try {
      if (value === null) localStorage.removeItem('ao-project-' + key);
      else localStorage.setItem('ao-project-' + key, JSON.stringify(value));
    } catch {}
  }
};
async function api(suffix = '', body) {
  const response = await fetch('/api/studio/projects' + suffix, {
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(12000),
    ...(body && {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)})
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const error = Error(data.error || '工作台暂时无法连接，请重试。');
    error.status = response.status;
    throw error;
  }
  return response.json();
}
const turnStatus = {running: '执行中', done: '已完成', failed: '执行失败', stopped: '已停止'};
const MODEL_CHIP = {
  ready: '本机 Pi 已就绪',
  starting: '本机 Pi 启动中…',
  failed: '本机 Pi 启动失败',
  stopped: '本机 Pi 已停止',
  off: '未配置本机 Pi',
  connecting: '正在连接 Pi'
};
const MODEL_NOTE = {
  starting: '正在加载本机模型，第一次启动通常要半分钟左右。可以先写好任务，就绪后再发送。',
  failed: '本机 Pi 没能启动，可以检查模型设置后重新打开 Agent Office。',
  stopped: '本机模型已经停止。重新打开 Agent Office 后可以继续。',
  off: '还没有配置本机模型。项目工作台需要本机 Pi，设置方法见「Agent 与模型」。'
};
// Elapsed time for a running or finished step list: 45 秒, 3 分 05 秒, 1 小时 2 分.
function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + ' 秒';
  if (s < 3600) return Math.floor(s / 60) + ' 分 ' + String(s % 60).padStart(2, '0') + ' 秒';
  return Math.floor(s / 3600) + ' 小时 ' + Math.floor((s % 3600) / 60) + ' 分';
}
// Long paths crowd the header: show ~ for the home folder and keep the start and the
// end of very long paths. The full path stays in the tooltip.
export function shortPath(full = '') {
  const path = full.replace(/^\/Users\/[^/]+(?=\/|$)/, '~');
  // Measure as displayed: CJK characters take about two columns.
  const width = [...path].reduce((sum, char) => sum + (/[⺀-￿]/.test(char) ? 2 : 1), 0);
  if (width <= 56) return path;
  const parts = path.split('/'),
    tail = parts.slice(-2).join('/');
  return parts[0] + '/' + (parts[1] || '') + '/…/' + tail;
}
// A local model can spend minutes on one task; after this long, suggest how to unblock it.
const SLOW_AFTER = 3 * 60 * 1000;
const operation = {list: '查看目录', read: '读取', search: '搜索', write: '写入', edit: '编辑', test: '测试'};
const stamp = date => {
  if (!date) return '';
  const time = new Date(date);
  return Number.isFinite(+time) ? time.toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit'}) : '';
};
function patch(file) {
  const lines = (file.diff || '').split('\n').map(line => {
    const type =
      line.startsWith('+++ ') || line.startsWith('--- ')
        ? 'meta'
        : line.startsWith('+')
          ? 'add'
          : line.startsWith('-')
            ? 'del'
            : line.startsWith('@@')
              ? 'hunk'
              : '';
    return '<span class="tb-code-' + type + '">' + (esc(line) || ' ') + '</span>';
  });
  return (
    '<details class="tb-file"><summary>' +
    icon('file') +
    '<code>' +
    esc(file.path) +
    '</code><small>' +
    ({added: '新增', modified: '修改', deleted: '删除'}[file.status] || '变更') +
    '</small></summary>' +
    (file.diff
      ? '<pre class="tb-diff" tabindex="0" aria-label="文件差异">' + lines.join('\n') + '</pre>'
      : '<p>没有可显示的文本差异。</p>') +
    (file.truncated ? '<p>此差异仅显示部分内容。</p>' : '') +
    '</details>'
  );
}
function turnBody(turn) {
  const running = turn.status === 'running';
  const activity = turn.activity || [];
  const actionLabel = action =>
    esc(operation[action.operation] || action.operation) + ' <code>' + esc(action.path) + '</code>';
  return (
    '<div class="tb-user-message"><div class="tb-sr-only">你</div>' +
    esc(turn.prompt) +
    '</div>' +
    '<div class="tb-agent-line"><span class="tb-pi-mark">' +
    icon('terminal') +
    '</span><b>Pi</b>' +
    '<span class="tb-state" data-state="' +
    esc(turn.status) +
    '">' +
    esc(turnStatus[turn.status]) +
    '</span><time>' +
    stamp(turn.finishedAt || turn.startedAt) +
    '</time></div>' +
    (activity.length || running
      ? '<details class="tb-activity"><summary>' +
        (running
          ? (activity.length
              ? '正在' + actionLabel(activity.at(-1)) + ' · 第 ' + activity.length + ' 步'
              : '正在思考') +
            ' · 已用 <span data-since="' +
            esc(turn.startedAt || '') +
            '">' +
            (turn.startedAt ? duration(Date.now() - Date.parse(turn.startedAt)) : '') +
            '</span>'
          : '执行记录 · ' +
            activity.length +
            ' 步' +
            (turn.startedAt && turn.finishedAt
              ? ' · 用时 ' + duration(Date.parse(turn.finishedAt) - Date.parse(turn.startedAt))
              : '')) +
        '</summary><ol>' +
        activity.map(a => '<li>' + actionLabel(a) + '</li>').join('') +
        '</ol></details>'
      : '') +
    (running && turn.startedAt
      ? '<p class="tb-slow" data-slow-since="' +
        esc(turn.startedAt) +
        '" hidden>本机模型处理得比较慢。如果几分钟都没有新进展，可以点「停止」，把任务说得更具体或拆小一些再试。</p>'
      : '') +
    (turn.reply ? '<div class="tb-reply">' + markdown(turn.reply) + '</div>' : '') +
    // A stop the person asked for is not an error; only failures are shown in red.
    (turn.error
      ? '<p class="' + (turn.status === 'stopped' ? 'tb-run-hint' : 'tb-run-error') + '">' + esc(turn.error) + '</p>'
      : '') +
    // Work done before a failure or stop is kept; point to it rather than only the error.
    (turn.status === 'failed' && turn.changes?.length
      ? '<p class="tb-run-hint">这一轮已经改了 ' +
        turn.changes.length +
        ' 个文件，改动保留在下方。可以先看看改动或运行测试，再决定继续还是重新运行。</p>'
      : '') +
    (turn.changes?.length
      ? '<section class="tb-review"><h3>' +
        icon('change') +
        '文件改动 <span>' +
        turn.changes.length +
        '</span></h3>' +
        turn.changes.map(patch).join('') +
        '</section>'
      : '') +
    (['failed', 'stopped'].includes(turn.status)
      ? '<button type="button" class="tb-retry" data-retry="' + esc(turn.id) + '">重新运行</button>'
      : '')
  );
}
export function openTaskbench() {
  document.body.replaceChildren(document.getElementById('taskbench-shell').content.cloneNode(true));
  document.body.className = 'taskbench';
  document.title = '项目工作台 · Agent Office';
  document.querySelectorAll('[data-tb-icon]').forEach(el => {
    el.innerHTML = icon(el.dataset.tbIcon);
  });
  mountProjectChecks(byId('checks'));
  // Running steps show a live elapsed time; after a few minutes, a hint on how to unblock.
  setInterval(() => {
    const now = Date.now();
    for (const el of document.querySelectorAll('[data-since]')) {
      const since = Date.parse(el.dataset.since);
      if (Number.isFinite(since)) el.textContent = duration(now - since);
    }
    for (const el of document.querySelectorAll('[data-slow-since]'))
      el.hidden = now - Date.parse(el.dataset.slowSince) < SLOW_AFTER;
  }, 1000);
  const prompt = byId('prompt');
  const small = matchMedia('(max-width: 760px)');
  const mac = /Mac|iPad|iPhone/.test(navigator.platform);
  byId('shortcut').textContent = mac ? '⌘ ↵' : 'Ctrl ↵';
  byId('send').title = '发送任务（' + (mac ? '⌘' : 'Ctrl') + ' + Enter）';
  let index = [],
    ready = null,
    modelStatus = null,
    session = null,
    activeId = null,
    project = '',
    busy = false,
    loading = false;
  let revision = 0,
    timer,
    polling = false,
    historySignature,
    openNav = false,
    connectionError = false;
  const turnSignatures = new Map();
  const draftKey = () => 'draft-' + (activeId || 'new');
  const route = () => '/' + encodeURIComponent(activeId);
  const newest = () => session?.turns.at(-1);
  function report(text, isNetwork = false) {
    const box = byId('error');
    box.textContent = text || '';
    box.hidden = !text;
    connectionError = isNetwork;
  }
  function nav(show, returnFocus = true) {
    openNav = show;
    const mobileOpen = small.matches && show;
    byId('sidebar').classList.toggle('tb-open', mobileOpen);
    byId('sidebar').inert = small.matches && !mobileOpen;
    byId('scrim').hidden = !mobileOpen;
    document.querySelector('.tb-main').inert = mobileOpen;
    byId('menu').setAttribute('aria-expanded', String(mobileOpen));
    if (mobileOpen) byId('new').focus();
    else if (small.matches && returnFocus) byId('menu').focus();
  }
  function writePrompt(value) {
    prompt.value = value || '';
    storage.write(draftKey(), value || null);
    refreshControls();
  }
  function renderHistory() {
    const filter = byId('search').value.trim().toLowerCase();
    const rows = index.filter(x => (x.title + ' ' + x.projectPath).toLowerCase().includes(filter));
    const signature = JSON.stringify([rows, activeId, filter]);
    if (historySignature === signature) return;
    historySignature = signature;
    const list = byId('history');
    const focused = document.activeElement?.dataset.session;
    list.innerHTML =
      rows
        .map(
          row =>
            '<button type="button" data-session="' +
            esc(row.id) +
            '" aria-current="' +
            (row.id === activeId ? 'page' : 'false') +
            '">' +
            '<span class="tb-row-title">' +
            esc(row.title || basename(row.projectPath)) +
            '</span><small>' +
            esc(basename(row.projectPath)) +
            (row.status === 'running' ? '<i>执行中</i>' : '') +
            '</small></button>'
        )
        .join('') || '<p>' + (filter ? '没有匹配的任务' : '暂无任务') + '</p>';
    if (focused)
      [...list.querySelectorAll('button')]
        .find(button => button.dataset.session === focused)
        ?.focus({preventScroll: true});
  }
  function renderProject() {
    byId('folder-name').textContent = project ? basename(project) : '选择项目';
    byId('folder').title = project || '选择本机文件夹';
    byId('folder').setAttribute('aria-label', activeId ? '当前项目：' + project : '选择项目文件夹');
    byId('project-label').textContent = shortPath(project);
    byId('project-label').title = project;
    const hasSession = Boolean(activeId);
    byId('content').classList.toggle('tb-empty', !hasSession);
    byId('intro').hidden = byId('suggestions').hidden = hasSession;
    byId('session-head').hidden = !hasSession;
    byId('title').textContent = session?.title || (loading ? '正在打开任务…' : basename(project)) || '';
    byId('breadcrumb').textContent = hasSession ? basename(project) || '任务' : '新任务';
    prompt.placeholder = hasSession ? '继续这个任务，或说明下一步想改什么…' : '描述任务，或贴一段需要排查的问题…';
  }
  function refreshControls() {
    const running = session?.status === 'running' || newest()?.status === 'running';
    byId('send').hidden = Boolean(running);
    byId('stop').hidden = !running;
    byId('shortcut').hidden = Boolean(running);
    byId('send').disabled = busy || loading || ready !== true || !prompt.value.trim();
    byId('stop').disabled = busy || loading;
    byId('folder').disabled = busy || loading || !!activeId;
    byId('new').disabled = busy;
    prompt.disabled = loading;
    // Loading a local model takes a while; say so calmly instead of looking like an error.
    const state = ready === true ? 'ready' : modelStatus?.state || (ready === false ? 'off' : 'connecting');
    const model = byId('model');
    model.classList.toggle('tb-ready', state === 'ready');
    model.dataset.state = state;
    model.querySelector('span').textContent = MODEL_CHIP[state] || MODEL_CHIP.connecting;
    const note = MODEL_NOTE[state];
    byId('model-note').hidden = !note;
    if (note) {
      byId('model-note').dataset.tone = state === 'starting' ? 'info' : 'warn';
      byId('model-note-text').textContent =
        state === 'failed' && modelStatus?.error ? note + '原因：' + modelStatus.error : note;
      byId('model-note-link').hidden = !['failed', 'off'].includes(state);
    }
    byId('turns')
      .querySelectorAll('[data-retry]')
      .forEach(b => {
        b.disabled = busy || loading || running || ready !== true;
      });
  }
  function renderTurns() {
    const container = byId('turns');
    for (const t of session?.turns || []) {
      const signature = JSON.stringify(t);
      if (turnSignatures.get(t.id) === signature) continue;
      turnSignatures.set(t.id, signature);
      let article = document.getElementById('tb-turn-' + t.id);
      if (!article) {
        article = document.createElement('article');
        article.className = 'tb-turn';
        article.id = 'tb-turn-' + t.id;
        container.append(article);
      }
      const open = [...article.querySelectorAll('details[open]')].map(el => el.querySelector('summary').textContent);
      const activityOpen = Boolean(article.querySelector('.tb-activity[open]'));
      article.innerHTML = turnBody(t);
      article.querySelectorAll('details').forEach(el => {
        el.open =
          (el.className === 'tb-activity' && activityOpen) || open.includes(el.querySelector('summary').textContent);
      });
    }
    const reviews = [...container.querySelectorAll('.tb-review')];
    for (const review of reviews) review.removeAttribute('id');
    if (reviews.length) reviews.at(-1).id = 'tb-review';
  }
  function apply(next) {
    if (!next || next.id !== activeId) return;
    const oldTurn = newest();
    const was = session?.status;
    const scroll = byId('scroll');
    const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100;
    session = next;
    project = next.projectPath;
    if (was !== next.status)
      document.dispatchEvent(new CustomEvent('taskbench:session', {detail: {id: activeId, status: next.status}}));
    const {turns, ...summary} = next;
    index = [summary, ...index.filter(x => x.id !== next.id)].sort(
      (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)
    );
    renderProject();
    renderHistory();
    renderTurns();
    refreshControls();
    const turn = newest();
    if (turn && (oldTurn?.id !== turn.id || oldTurn.status !== turn.status))
      byId('live').textContent = 'Pi ' + turnStatus[turn.status];
    if (nearBottom)
      requestAnimationFrame(() => {
        scroll.scrollTop = scroll.scrollHeight;
      });
  }
  function choose(id, value = null, {savedPrompt, focus = false} = {}) {
    ++revision;
    activeId = id || null;
    session = null;
    loading = !!id && !value;
    project =
      value?.projectPath || (id ? index.find(x => x.id === id)?.projectPath || '' : storage.read('folder') || '');
    turnSignatures.clear();
    byId('turns').replaceChildren();
    prompt.value = savedPrompt ?? storage.read(draftKey()) ?? '';
    if (savedPrompt !== undefined) storage.write(draftKey(), savedPrompt || null);
    const url = new URL(location.href);
    if (activeId) url.searchParams.set('task', activeId);
    else url.searchParams.delete('task');
    history.replaceState(null, '', url);
    storage.write('last-task', activeId);
    report('');
    renderProject();
    renderHistory();
    refreshControls();
    document.dispatchEvent(
      new CustomEvent('taskbench:session', {
        detail: {id: activeId, status: value?.status || (loading ? 'loading' : 'idle')}
      })
    );
    if (value) apply(value);
    if (focus) prompt.focus({preventScroll: true});
  }
  async function select(id) {
    if (busy) return;
    nav(false, false);
    if (activeId === id && (session || !id)) {
      prompt.focus();
      return;
    }
    choose(id, null, {focus: !id});
    if (!id) return;
    const token = revision;
    try {
      const data = await api(route());
      if (token === revision) {
        loading = false;
        apply(data.session);
      }
    } catch (error) {
      if (token !== revision) return;
      if (error.status === 404) choose(null);
      report(error.message, !error.status);
    }
  }
  async function sync() {
    clearTimeout(timer);
    if (polling) return;
    polling = true;
    const token = revision;
    try {
      if (!busy && !document.hidden) {
        const [list, detail] = await Promise.all([api(), activeId ? api(route()) : null]);
        if (token === revision && !busy) {
          index = list.sessions;
          ready = list.localAvailable;
          modelStatus = list.localStatus || null;
          if (connectionError) report('');
          if (detail) {
            loading = false;
            apply(detail.session);
          } else {
            renderHistory();
            refreshControls();
          }
        }
      }
    } catch (error) {
      if (token === revision) {
        if (error.status === 404 && activeId) choose(null);
        report(error.message, true);
      }
    } finally {
      polling = false;
      timer = setTimeout(sync, session?.status === 'running' ? 900 : ready !== true ? 2200 : 5000);
    }
  }
  function setFolder(path) {
    project = path;
    storage.write('folder', path);
    report('');
    renderProject();
    refreshControls();
    prompt.focus();
  }
  function manualFolder() {
    const paths = [...new Set([project, ...index.map(s => s.projectPath)].filter(Boolean))].slice(0, 4);
    const el = byId('list-projects');
    el.innerHTML = paths.length
      ? '<h3>最近使用</h3>' +
        paths
          .map(
            path =>
              '<button type="button" data-path="' +
              esc(path) +
              '">' +
              icon('folder') +
              '<span>' +
              esc(path) +
              '</span></button>'
          )
          .join('')
      : '';
    byId('path').value = project;
    byId('path').setCustomValidity('');
    const dialog = byId('path-dialog');
    dialog.returnValue = '';
    const result = new Promise(resolve =>
      dialog.addEventListener('close', () => resolve(dialog.returnValue), {once: true})
    );
    dialog.showModal();
    byId('path').focus();
    return result;
  }
  async function chooseFolder() {
    const picker = window.webkit?.messageHandlers?.chooseProjectFolder;
    if (picker) {
      try {
        const path = await picker.postMessage(null);
        if (typeof path === 'string' && path) setFolder(path);
        return path;
      } catch {
        /* Manual input is available when the system picker cannot open. */
      }
    }
    const path = await manualFolder();
    if (path) setFolder(path);
    return path;
  }
  // Preserve identifiers across uncertain responses, including a reload after sending.
  function requestId(key, content) {
    const saved = storage.read(key);
    if (saved?.content === content) return saved.id;
    const id = crypto.randomUUID();
    storage.write(key, {content, id});
    return id;
  }
  async function send(text = prompt.value, isRetry = false) {
    const content = text.trim();
    if (!content || busy || loading || ready !== true || session?.status === 'running') return;
    if (!project && !(await chooseFolder())) return;
    busy = true;
    ++revision;
    report('');
    refreshControls();
    try {
      if (!activeId) {
        const title = content.split('\n')[0].slice(0, 80);
        const data = await api('', {
          projectPath: project,
          title,
          requestId: requestId('pending-new', project + '\n' + title)
        });
        choose(data.session.id, data.session, {savedPrompt: prompt.value});
        storage.write('draft-new', null);
        storage.write('pending-new', null);
      }
      const key = 'pending-' + activeId;
      const data = await api(route() + '/messages', {content, requestId: requestId(key, content)});
      storage.write(key, null);
      if (!isRetry && prompt.value.trim() === content) writePrompt('');
      apply(data.session);
    } catch (error) {
      report(error.message || '发送失败，请重试。');
    } finally {
      busy = false;
      refreshControls();
      sync();
    }
  }
  async function stop() {
    if (!activeId || busy) return;
    busy = true;
    ++revision;
    report('');
    refreshControls();
    try {
      const {session: result} = await api(route() + '/stop', {});
      apply(result);
    } catch (error) {
      report(error.message);
    } finally {
      busy = false;
      refreshControls();
      sync();
    }
  }
  byId('new').onclick = () => {
    if (!activeId) {
      nav(false, false);
      prompt.focus();
    } else select(null);
  };
  byId('menu').onclick = () => nav(true);
  byId('hide-nav').onclick = byId('scrim').onclick = () => nav(false);
  byId('history').onclick = e => {
    const id = e.target.closest('[data-session]')?.dataset.session;
    if (id) select(id);
  };
  byId('search-toggle').onclick = () => {
    const search = byId('search');
    search.hidden = !search.hidden;
    byId('search-toggle').setAttribute('aria-expanded', String(!search.hidden));
    if (search.hidden) {
      search.value = '';
      renderHistory();
    } else search.focus();
  };
  byId('search').oninput = renderHistory;
  byId('folder').onclick = chooseFolder;
  byId('path-close').onclick = byId('path-cancel').onclick = () => byId('path-dialog').close();
  byId('list-projects').onclick = e => {
    const path = e.target.closest('[data-path]')?.dataset.path;
    if (path) byId('path-dialog').close(path);
  };
  byId('path').oninput = () => byId('path').setCustomValidity('');
  byId('path-form').onsubmit = e => {
    e.preventDefault();
    const input = byId('path'),
      path = input.value.trim();
    if (!/^(?:\/|[a-z]:[\\/]|\\\\)/i.test(path)) {
      input.setCustomValidity('请输入从根目录开始的完整路径。');
      input.reportValidity();
      return;
    }
    byId('path-dialog').close(path);
  };
  byId('form').onsubmit = e => {
    e.preventDefault();
    send();
  };
  byId('stop').onclick = stop;
  prompt.oninput = () => {
    storage.write(draftKey(), prompt.value || null);
    refreshControls();
  };
  prompt.onkeydown = e => {
    if (!e.isComposing && (e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      send();
    }
  };
  byId('suggestions').onclick = e => {
    const example = e.target.closest('[data-example]')?.dataset.example;
    if (example) {
      writePrompt(example);
      prompt.focus();
    }
  };
  byId('turns').onclick = e => {
    const summary = e.target.closest('.tb-file summary');
    if (summary && !summary.parentElement.open)
      requestAnimationFrame(() => {
        const file = summary.parentElement.getBoundingClientRect();
        const visibleBottom = byId('composer-wrap').getBoundingClientRect().top;
        const visibleTop = byId('scroll').getBoundingClientRect().top;
        const offset = Math.min(file.bottom - visibleBottom + 8, file.top - visibleTop - 8);
        if (offset > 0) byId('scroll').scrollTop += offset;
      });
    const id = e.target.closest('[data-retry]')?.dataset.retry;
    const turn = id && session?.turns.find(t => t.id === id);
    if (turn) send(turn.prompt, true);
  };
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && openNav) nav(false);
  });
  small.addEventListener('change', () => nav(false, false));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) sync();
  });
  nav(false, false);
  choose(new URLSearchParams(location.search).get('task') || storage.read('last-task') || null);
  sync();
}
