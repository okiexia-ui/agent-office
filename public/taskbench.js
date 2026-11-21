import {escapeHTML as esc, markdown} from './visual-renderer.js';
import {mountProjectChecks} from './project-checks.js';

const icons = {
  terminal: '<path d="m4 6 6 6-6 6m9 0h7"/>',
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
  failed: '本机 Pi 没能启动，请检查本地模型配置后重开办公室。',
  stopped: '本机模型已经停止。重新打开 Agent Office 后可以继续。',
  off: '这位成员使用本机 Pi，请配置本地模型后继续。'
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
const operation = {
  list: '查看目录',
  read: '读取',
  search: '搜索',
  write: '写入',
  edit: '编辑',
  test: '测试',
  report: '汇报'
};
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
    '</span><b>' +
    esc(turn.agentName || 'Pi') +
    '</b>' +
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
              : turn.kind === 'external'
                ? turn.dispatchStatus === 'active'
                  ? '成员已领取'
                  : '等待成员领取'
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
    (running && (turn.kind || 'pi') === 'pi' && turn.startedAt
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
// A single project controller is shared by the member panel. Every async result
// is bound to its original member and selection, including a native picker reply.
export function mountMemberProjects(mount) {
  mount.innerHTML = `
    <div class="tb-project-tools"><button id="tb-new" type="button">＋ 新任务</button>
      <details id="tb-recent"><summary>历史任务</summary><div class="tb-history-pop">
        <input type="search" id="tb-search" placeholder="搜索任务或项目" aria-label="搜索任务或项目"><nav id="tb-history" aria-label="项目任务列表"></nav>
      </div></details><span id="tb-model" role="status"></span></div>
    <p id="tb-notice" class="tb-notice"></p>
    <div id="tb-scroll"><h3 id="tb-title" hidden></h3><div id="tb-turns" aria-label="项目任务对话"></div><div id="tb-checks" hidden></div></div>
    <div id="tb-composer-wrap"><p id="tb-error" role="alert" hidden></p>
      <form id="tb-form"><label class="sr-only" for="tb-prompt">项目任务指令</label>
        <textarea id="tb-prompt" rows="3" maxlength="12000" placeholder="描述这个项目里要完成的事…"></textarea>
        <div class="tb-controls"><button type="button" id="tb-folder" aria-label="选择项目文件夹"></button>
          <button type="button" id="tb-stop" hidden>停止任务</button><button type="submit" id="tb-send" aria-label="发送任务">发送任务</button></div>
      </form></div>
    <dialog id="tb-path-dialog" class="tb-dialog" aria-labelledby="tb-path-title"><form id="tb-path-form">
      <h3 id="tb-path-title">选择项目文件夹</h3><label for="tb-path">本机文件夹路径</label>
      <input id="tb-path" required maxlength="4096" spellcheck="false" autocomplete="off" placeholder="/Users/…/Projects/my-app">
      <div id="tb-list-projects"></div><footer><button id="tb-path-cancel" type="button">取消</button><button id="tb-confirm-path" type="submit">使用此文件夹</button></footer>
    </form></dialog>`;
  mountProjectChecks(byId('checks'));
  const prompt = byId('prompt'),
    dialog = byId('path-dialog');
  let agent = null,
    capability = null,
    activeId = null,
    session = null,
    folder = '',
    rows = [],
    revision = 0,
    timer,
    busy = false,
    fetching = false,
    pendingDetail = false,
    retryNetwork = false,
    checkStatus = '';
  const signature = new Map();
  const memberKey = () => agent?.id || '';
  const draftKey = () => 'draft-' + (activeId || (memberKey() === 'pi-local' ? 'new' : memberKey() + '-new'));
  const folderKey = () => (memberKey() === 'pi-local' ? 'folder' : 'folder-' + memberKey());
  const list = () => api('?agentId=' + encodeURIComponent(memberKey()));
  const changed = () => document.dispatchEvent(new Event('office-project-change'));
  function message(text, network = false) {
    byId('error').textContent = text || '';
    byId('error').hidden = !text;
    retryNetwork = network;
  }
  function setUrl() {
    const url = new URL(location.href);
    if (activeId) url.searchParams.set('task', activeId);
    else url.searchParams.delete('task');
    history.replaceState(null, '', url);
  }
  function signalChecks() {
    const status = activeId ? session?.status || 'loading' : 'idle';
    const key = (activeId || '') + ':' + status;
    if (checkStatus !== key)
      document.dispatchEvent(new CustomEvent('taskbench:session', {detail: {id: activeId, status}}));
    checkStatus = key;
  }
  function controls() {
    const running = session?.status === 'running';
    const available = capability?.available === true;
    byId('send').hidden = !!running;
    byId('send').disabled = !available || !prompt.value.trim() || busy || pendingDetail;
    byId('stop').hidden = !running;
    byId('stop').disabled = busy;
    byId('folder').disabled = !!activeId || busy;
    byId('folder').textContent = folder ? '▱ ' + basename(folder) : '▱ 选择文件夹';
    byId('folder').title = folder ? shortPath(folder) : '选择项目文件夹';
    byId('new').disabled = busy;
    byId('search').disabled = busy;
    prompt.placeholder = activeId ? '继续这个任务，或说明下一步想改什么…' : '描述这个项目里要完成的事…';
    byId('turns')
      .querySelectorAll('[data-retry]')
      .forEach(b => {
        b.disabled = busy || !available || running;
      });
    const kind = capability?.kind,
      state = capability?.localStatus?.state;
    byId('model').textContent = !capability
      ? '正在连接…'
      : !capability.enabled
        ? '成员已停用'
        : kind === 'pi'
          ? MODEL_CHIP[state] || (available ? MODEL_CHIP.ready : MODEL_CHIP.off)
          : kind === 'api'
            ? capability.modelLabel || '模型 API'
            : '外部 MCP';
    byId('notice').textContent = !capability
      ? ''
      : kind === 'external'
        ? '任务和目录路径将交给该成员的 MCP 客户端。执行步骤由客户端汇报，本面板展示客户端汇报的步骤和结果。'
        : kind === 'api'
          ? '此成员会将任务及本轮工具读取的文件内容发送到所选模型连接。'
          : !available
            ? MODEL_NOTE[state] || '本机模型暂不可用。'
            : '';
    byId('notice').hidden = !byId('notice').textContent;
    byId('title').textContent = session?.title || '';
    byId('title').hidden = !session;
    signalChecks();
  }
  function historyList() {
    const q = byId('search').value.trim().toLowerCase(),
      host = byId('history');
    const items = rows.filter(r => (r.title + ' ' + r.projectPath).toLowerCase().includes(q));
    const html =
      items
        .map(
          r =>
            '<button type="button" data-session="' +
            esc(r.id) +
            '" aria-current="' +
            (r.id === activeId) +
            '">' +
            esc(r.title) +
            '<small>' +
            esc(basename(r.projectPath)) +
            (r.status === 'running' ? ' · 执行中' : '') +
            '</small></button>'
        )
        .join('') || '<p>没有匹配的任务</p>';
    if (host.dataset.content !== html) {
      host.innerHTML = html;
      host.dataset.content = html;
    }
  }
  function render(next) {
    if (!agent || !next || next.id !== activeId || next.agentId !== memberKey()) return;
    const scroll = byId('scroll'),
      near = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 120;
    const last = session?.turns.at(-1);
    const current = next.turns.at(-1);
    let didChange = false;
    session = next;
    folder = next.projectPath;
    pendingDetail = false;
    for (const turn of next.turns) {
      const serial = JSON.stringify(turn);
      if (signature.get(turn.id) === serial) continue;
      didChange = true;
      signature.set(turn.id, serial);
      let el = byId('turn-' + turn.id);
      if (!el) {
        el = document.createElement('article');
        el.className = 'tb-turn';
        el.id = 'tb-turn-' + turn.id;
        byId('turns').append(el);
      }
      const open = [...el.querySelectorAll('details')].map(d => d.open);
      el.innerHTML = turnBody(turn);
      el.querySelectorAll('details').forEach((d, i) => {
        d.open = !!open[i];
      });
    }
    byId('turns')
      .querySelectorAll('.tb-review')
      .forEach((r, i, all) => {
        r.id = i === all.length - 1 ? 'tb-review' : '';
      });
    controls();
    for (const el of byId('turns').querySelectorAll('[data-since]')) {
      const since = Date.parse(el.dataset.since);
      if (Number.isFinite(since)) el.textContent = duration(Date.now() - since);
    }
    for (const el of byId('turns').querySelectorAll('[data-slow-since]'))
      el.hidden = Date.now() - Date.parse(el.dataset.slowSince) < SLOW_AFTER;
    if (near && didChange)
      requestAnimationFrame(() => {
        scroll.scrollTop = scroll.scrollHeight;
      });
    if (last?.status !== current?.status || last?.activity?.length !== current?.activity?.length) changed();
  }
  function choose(id, value = null, savedPrompt) {
    revision++;
    activeId = id || null;
    session = null;
    pendingDetail = !!id && !value;
    clearTimeout(timer);
    signature.clear();
    byId('turns').replaceChildren();
    folder =
      value?.projectPath || (id ? rows.find(r => r.id === id)?.projectPath || '' : storage.read(folderKey()) || '');
    prompt.value = savedPrompt ?? storage.read(draftKey()) ?? '';
    if (savedPrompt !== undefined) storage.write(draftKey(), savedPrompt || null);
    storage.write('last-task-' + memberKey(), activeId);
    setUrl();
    message('');
    controls();
    historyList();
    if (value) render(value);
  }
  async function sync() {
    clearTimeout(timer);
    if (!agent || mount.hidden) return;
    const version = revision;
    if (!fetching && !busy && !document.hidden) {
      fetching = true;
      try {
        const [catalog, detail] = await Promise.all([list(), activeId ? api('/' + activeId) : null]);
        if (version !== revision || !agent || busy) return;
        capability = catalog.member && {...catalog.member, localStatus: catalog.localStatus};
        rows = catalog.sessions;
        historyList();
        if (retryNetwork) message('');
        if (detail?.session?.agentId === memberKey()) render(detail.session);
        else if (detail) choose(null);
        else controls();
      } catch (e) {
        if (version === revision && agent) {
          if (e.status === 404) choose(null);
          message(e.message, true);
        }
      } finally {
        fetching = false;
        if (agent && !mount.hidden) {
          clearTimeout(timer);
          timer = setTimeout(sync, session?.status === 'running' ? 850 : 2500);
        }
      }
    } else timer = setTimeout(sync, 1000);
  }
  function hide() {
    revision++;
    agent = null;
    busy = false;
    clearTimeout(timer);
    activeId = null;
    session = null;
    if (dialog.open) dialog.close('');
    signalChecks();
  }
  function selectFolder(path) {
    folder = path;
    storage.write(folderKey(), path);
    message('');
    controls();
    prompt.focus({preventScroll: true});
  }
  async function pick() {
    const version = revision;
    let path;
    const native = window.webkit?.messageHandlers?.chooseProjectFolder;
    if (native) {
      try {
        path = await native.postMessage(null);
      } catch {}
    }
    if (version !== revision || !agent) return;
    if (path === undefined) {
      const recent = [...new Set(rows.map(r => r.projectPath))].slice(0, 4);
      byId('list-projects').innerHTML = recent
        .map(p => '<button data-path="' + esc(p) + '" type="button">' + esc(shortPath(p)) + '</button>')
        .join('');
      byId('path').value = folder;
      byId('path').setCustomValidity('');
      dialog.returnValue = '';
      const closed = new Promise(resolve =>
        dialog.addEventListener('close', () => resolve(dialog.returnValue), {once: true})
      );
      dialog.showModal();
      byId('path').focus();
      path = await closed;
    }
    if (version !== revision || typeof path !== 'string' || !path) return;
    selectFolder(path);
    return path;
  }
  function idFor(key, value) {
    const saved = storage.read(key);
    if (saved?.value === value) return saved.id;
    const id = crypto.randomUUID();
    storage.write(key, {value, id});
    return id;
  }
  async function send(text = prompt.value, retry = false) {
    const content = text.trim();
    if (!agent || busy || pendingDetail || !content || !capability?.available || session?.status === 'running') return;
    const agentId = memberKey();
    if (!folder && !(await pick())) return;
    if (agentId !== memberKey() || busy) return;
    busy = true;
    let ticket = ++revision;
    message('');
    controls();
    try {
      let targetId = activeId;
      if (!targetId) {
        const title = content.split('\n')[0].slice(0, 80),
          key = 'pending-new-' + agentId,
          oldDraft = draftKey();
        const data = await api('', {agentId, title, projectPath: folder, requestId: idFor(key, folder + '\n' + title)});
        targetId = data.session.id;
        if (ticket === revision) {
          choose(targetId, data.session, prompt.value);
          ticket = revision;
          storage.write(oldDraft, null);
        }
        storage.write(key, null);
      }
      const key = 'pending-' + targetId;
      const data = await api('/' + targetId + '/messages', {requestId: idFor(key, content), content});
      storage.write(key, null);
      changed();
      if (ticket !== revision) return;
      if (!retry && prompt.value.trim() === content) {
        prompt.value = '';
        storage.write(draftKey(), null);
      }
      render(data.session);
    } catch (e) {
      if (ticket === revision) message(e.message);
    } finally {
      if (ticket === revision) {
        busy = false;
        controls();
        void sync();
      }
    }
  }
  async function stop() {
    if (!activeId || busy) return;
    const ticket = ++revision;
    busy = true;
    controls();
    try {
      const data = await api('/' + activeId + '/stop', {});
      changed();
      if (ticket === revision) render(data.session);
    } catch (e) {
      if (ticket === revision) message(e.message);
    } finally {
      if (ticket === revision) {
        busy = false;
        controls();
        void sync();
      }
    }
  }
  async function open(member, {taskId, newTask = false, pickFolder = false} = {}) {
    hide();
    agent = member;
    mount.hidden = false;
    rows = [];
    capability = null;
    byId('search').value = '';
    byId('recent').open = false;
    const saved = storage.read('last-task-' + member.id);
    choose(newTask ? null : taskId || saved || null);
    await sync();
    if (agent?.id !== member.id) return;
    if (pickFolder && !activeId) await pick();
  }
  byId('new').onclick = () => {
    if (!busy) {
      choose(null);
      void sync();
      prompt.focus();
    }
  };
  byId('folder').onclick = pick;
  byId('path-cancel').onclick = () => dialog.close('');
  byId('list-projects').onclick = e => {
    const p = e.target.closest('[data-path]')?.dataset.path;
    if (p) dialog.close(p);
  };
  byId('path').oninput = () => byId('path').setCustomValidity('');
  byId('path-form').onsubmit = e => {
    e.preventDefault();
    const path = byId('path').value.trim();
    if (!/^(?:\/|[a-z]:[\\/]|\\\\\\\\)/i.test(path)) {
      byId('path').setCustomValidity('请输入本机文件夹的绝对路径。');
      byId('path').reportValidity();
      return;
    }
    dialog.close(path);
  };
  byId('history').onclick = e => {
    const id = e.target.closest('[data-session]')?.dataset.session;
    if (!id || busy) return;
    byId('recent').open = false;
    choose(id);
    void sync();
  };
  byId('search').oninput = historyList;
  byId('form').onsubmit = e => {
    e.preventDefault();
    void send();
  };
  byId('stop').onclick = stop;
  prompt.oninput = () => {
    storage.write(draftKey(), prompt.value || null);
    controls();
  };
  prompt.onkeydown = e => {
    if (!e.isComposing && (e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void send();
    }
  };
  byId('turns').onclick = e => {
    const id = e.target.closest('[data-retry]')?.dataset.retry;
    const turn = id && session?.turns.find(t => t.id === id);
    if (turn) void send(turn.prompt, true);
  };
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && agent) void sync();
  });
  return {open, hide};
}
