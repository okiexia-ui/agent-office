// Each mount edits exactly one selected office member. The parent controls navigation.
import {DESKS, assignSeats} from './layout.js';
import {MODELS} from './data.js';
import {connectionForm, mountConnectionEditor} from './connection-editor.js';
import {mountPiModelSetup} from './pi-model-setup.js';

const mounts = new WeakMap();
let pendingSave = Promise.resolve();
function request(path = '', method = 'GET', body) {
  const response = fetchStudio(path, method, body);
  // A newly selected member waits only for mutations to finish. A slow model probe can run independently.
  if (method !== 'GET' && !/\/(models|test)$/.test(path)) pendingSave = response.catch(() => {});
  return response;
}
async function fetchStudio(path, method, body) {
  const res = await fetch('/api/studio' + path, {
    method,
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(120000),
    ...(body && {headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)})
  });
  const data = await res.json();
  if (!res.ok) throw Error(data.error || '无法读取或保存设置，请重试。');
  return data;
}

const panel = `
<div class="member-settings">
  <fieldset id="studio-controls" disabled>
    <div class="member-type-line"><span id="studio-type"></span><span id="studio-agent-status"></span></div>
    <form id="studio-agent-form" autocomplete="off">
      <label>显示名称<input id="studio-agent-name" maxlength="24" required placeholder="例如：产品编辑"></label>
      <label>职责<input id="studio-agent-role" maxlength="80" required placeholder="例如：维护产品文档"></label>
      <label id="studio-instruction-label">工作指令<textarea id="studio-agent-instructions" rows="3" maxlength="6000" placeholder="写下工作方式、输出格式和约定"></textarea></label>
      <div id="studio-source">
        <label for="studio-agent-connection">模型</label>
        <div class="member-model-row"><select id="studio-agent-connection" required></select><button type="button" id="studio-add-connection">＋ 新连接</button></div>
        <p class="member-hint" id="studio-model-hint"></p>
        <p class="member-hint" id="studio-usage" hidden></p>
        <button type="button" id="studio-edit-connection" hidden>编辑所选连接</button>
      </div>
      <label id="studio-seat-label" hidden>工位<select id="studio-seat"></select></label>
      <div id="studio-runtime" hidden><span class="member-field-title">模型</span><p id="studio-runtime-description"></p></div>
      <div id="studio-local-model" class="pi-model" hidden></div>
      <div id="studio-external-controls" hidden>
        <label>办公室说明<textarea id="studio-office-notes" rows="3" maxlength="4000" aria-describedby="studio-notes-hint"></textarea></label>
        <p id="studio-notes-hint" class="member-hint">客户端通过 MCP 读取这段说明，自行决定如何采用。</p>
        <div class="member-color"><label>成员颜色<input id="studio-color" type="color"></label><button type="button" id="studio-reset-color">使用默认颜色</button></div>
        <label class="member-check"><input id="studio-enabled" type="checkbox">在办公室启用此成员</label>
      </div>
    </form>
    ${connectionForm}
    <p id="studio-feedback" role="status" aria-live="polite" hidden></p>
    <div class="member-actions"><button type="submit" form="studio-agent-form" class="member-primary" id="studio-save-agent">保存设置</button><button type="button" id="studio-toggle-agent" hidden></button></div>
  </fieldset>
  <button type="button" class="member-mcp" id="studio-external" hidden>通过 MCP 接入外部成员 ↗</button>
</div>`;

export function unmountMemberSettings(root) {
  mounts.delete(root);
  root.replaceChildren();
}

export async function mountMemberSettings(root, {agent = null, template, onAgent, onChanged, onConnect} = {}) {
  const key = Symbol();
  mounts.set(root, key);
  const active = () => mounts.get(root) === key;
  root.innerHTML = panel;
  const field = id => root.querySelector('#studio-' + id);
  const controls = field('controls');
  const feedback = (text = '', error = false) => {
    const el = field('feedback');
    el.textContent = text;
    el.hidden = !text;
    el.classList.toggle('studio-error', error);
  };
  feedback('正在读取成员设置…');
  let catalog;
  try {
    await pendingSave;
    if (!active()) return;
    catalog = await request();
    if (!active()) return;
  } catch {
    if (active()) {
      feedback('无法读取本机成员设置。', true);
      const retry = document.createElement('button');
      retry.textContent = '重新读取';
      retry.onclick = () => mountMemberSettings(root, {agent, template, onAgent, onChanged, onConnect});
      // This action remains usable even while the form is unavailable.
      controls.after(retry);
    }
    return;
  }

  const managedId = catalog.agents.find(a => a.id === agent?.id)?.id;
  const builtin = agent?.id === 'pi-local';
  const external = Boolean(agent && !managedId && !builtin);
  let profile = managedId ? catalog.agents.find(a => a.id === managedId) : builtin ? catalog.builtin || agent : agent;
  let customColor = null;
  const source = field('agent-connection');
  async function work(label, action) {
    if (!active() || controls.disabled) return;
    controls.disabled = true;
    controls.setAttribute('aria-busy', 'true');
    feedback(label);
    try {
      await action();
    } catch (error) {
      if (active()) feedback(error.message || '设置操作失败，请重试。', true);
    } finally {
      if (active()) {
        controls.disabled = false;
        controls.removeAttribute('aria-busy');
      }
    }
  }
  function describeSource() {
    const connection = catalog.connections.find(c => c.id === source.value);
    const hint = field('model-hint');
    if (connection) {
      hint.textContent = '消息和任务内容会发送至 ' + new URL(connection.baseUrl).host + '。';
    } else {
      hint.textContent =
        source.value === 'local'
          ? catalog.localAvailable
            ? '由这台电脑上的 Pi 运行。'
            : '本机模型当前离线。'
          : '添加模型连接后即可创建成员。';
    }
    field('edit-connection').hidden = !connection;
    field('save-agent').disabled =
      !external &&
      !builtin &&
      (!source.value || (source.value === 'local' && !catalog.localAvailable && profile?.enabled !== false));
  }
  function renderSources(selected) {
    const options = catalog.connections.map(c => new Option(c.name + ' · ' + c.model, c.id));
    if (catalog.localAvailable || selected === 'local') {
      const local = new Option(catalog.localAvailable ? 'Pi · 本机模型' : 'Pi · 本机模型暂不可用', 'local');
      local.disabled = !catalog.localAvailable;
      options.unshift(local);
    }
    source.replaceChildren(...(options.length ? options : [new Option('请先添加模型连接', '')]));
    if (options.some(o => o.value === selected)) source.value = selected;
    describeSource();
  }
  function renderManagedStatus() {
    const states = {running: '运行中', starting: '正在启动', disabled: '已停用', error: '待修复'};
    field('agent-status').textContent = states[profile.status] || '';
    const used = profile.usage;
    const count = n => n.toLocaleString('zh-CN');
    field('usage').hidden = !used;
    if (used)
      field('usage').textContent =
        `累计用量：${count(used.calls)} 次请求 · 输入 ${count(used.input)} · 输出 ${count(used.output)} tokens` +
        `（自 ${new Date(used.since).toLocaleDateString('zh-CN', {month: 'long', day: 'numeric'})}起，以服务商返回为准）`;
    field('toggle-agent').textContent = profile.enabled === false ? '启用成员' : '停用成员';
  }
  field('type').textContent = builtin ? '本机 Pi' : external ? '外部 MCP 成员' : agent ? '工作室成员' : '创建成员';
  field('agent-name').value = profile?.name || template?.name || '';
  field('agent-role').value = profile?.role || template?.role || '';
  field('agent-instructions').value = profile?.instructions || template?.instructions || '';
  field('source').hidden = external || builtin;
  // Hidden controls are still validated by HTML unless disabled.
  source.disabled = external || builtin;
  field('instruction-label').hidden = external;
  field('external-controls').hidden = !external;
  field('runtime').hidden = !external && !builtin;
  field('external').hidden = !!agent || !onConnect;
  field('external').onclick = () => onConnect?.();
  field('save-agent').textContent = agent ? '保存设置' : '创建并开始对话';
  if (external) {
    field('runtime-description').textContent = (profile.model || '外部 Agent') + ' · 模型和系统指令在客户端中配置。';
    field('office-notes').value = profile.officeNotes || '';
    field('enabled').checked = !profile.managedDisabled;
    const defaultColor = MODELS[profile.model]?.color || '#59756a';
    customColor = profile.color || null;
    field('color').value = customColor || defaultColor;
    field('color').oninput = e => {
      customColor = e.target.value;
    };
    field('reset-color').onclick = () => {
      customColor = null;
      field('color').value = defaultColor;
    };
  } else if (builtin) {
    field('runtime').hidden = true;
    field('agent-status').textContent = catalog.localAvailable ? '已就绪' : '模型离线';
    mountPiModelSetup(field('local-model'), {active, onChanged});
  } else {
    renderSources(profile?.connectionId);
    const editor = mountConnectionEditor({field, catalog, request, work, feedback, active, onSources: renderSources});
    source.onchange = () => {
      editor.close(false);
      describeSource();
    };
    field('add-connection').onclick = () => editor.open('');
    field('edit-connection').onclick = () => editor.open(source.value);
    if (managedId) {
      field('toggle-agent').hidden = false;
      renderManagedStatus();
      field('toggle-agent').onclick = () =>
        work('正在更新运行状态…', async () => {
          const {agent: saved} = await request('/agents/' + managedId + '/enabled', 'POST', {
            enabled: profile.enabled === false
          });
          if (!active()) return;
          profile = saved;
          renderManagedStatus();
          describeSource();
          feedback(saved.error || (saved.enabled ? '成员已启用。' : '成员已停用。'), Boolean(saved.error));
          await onChanged?.();
        });
    }
  }
  // Every existing member has a desk in the scene; only free desks can be chosen.
  let savedSeat = '';
  if (agent) {
    field('seat-label').hidden = false;
    let seats;
    try {
      const response = await fetch('/api/state', {
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(8000)
      });
      if (!response.ok) throw Error();
      const state = await response.json();
      seats = assignSeats(state.agents);
    } catch {
      seats = [profile];
    }
    if (!active()) return;
    // A member that has not connected yet has no desk to move.
    field('seat-label').hidden = !seats.some(a => a.id === profile.id);
    const seatId = seats.find(a => a.id === profile.id)?.seatId || profile.seatId;
    const options = DESKS.map(d => {
      const occupant = seats.find(a => a.id !== profile.id && a.seatId === d.id);
      const option = new Option(d.label + (occupant ? ' · ' + occupant.name : ''), d.id);
      option.disabled = !!occupant;
      return option;
    });
    field('seat').replaceChildren(...options);
    if (seatId) field('seat').value = seatId;
    savedSeat = field('seat').value;
  }
  field('agent-form').onsubmit = e => {
    e.preventDefault();
    work(agent ? '正在保存设置…' : '正在创建成员…', async () => {
      const body = {name: field('agent-name').value.trim(), role: field('agent-role').value.trim()};
      if (external)
        Object.assign(body, {
          officeNotes: field('office-notes').value.trim(),
          seatId: field('seat').value,
          color: customColor,
          enabled: field('enabled').checked
        });
      else {
        body.instructions = field('agent-instructions').value.trim();
        if (!builtin) body.connectionId = source.value;
      }
      const route =
        external || builtin
          ? '/members/' + encodeURIComponent(agent.id)
          : managedId
            ? '/agents/' + managedId
            : '/agents';
      const {agent: saved} = await request(route, agent ? 'PUT' : 'POST', body);
      if (!active()) return;
      // External members save their desk with the profile; Pi and studio members move separately.
      if (agent && !external && field('seat').value && field('seat').value !== savedSeat) {
        await request('/members/' + encodeURIComponent(agent.id) + '/seat', 'PUT', {seatId: field('seat').value});
        if (!active()) return;
        savedSeat = field('seat').value;
      }
      if (managedId) {
        profile = saved;
        catalog.agents = catalog.agents.map(a => (a.id === saved.id ? saved : a));
        renderManagedStatus();
      }
      feedback(saved.error || (agent ? '已保存设置。' : '成员已创建。'), Boolean(saved.error));
      if (!agent && onAgent) await onAgent(saved);
      else await onChanged?.();
    });
  };
  controls.disabled = false;
  feedback(profile?.error, Boolean(profile?.error));
}
