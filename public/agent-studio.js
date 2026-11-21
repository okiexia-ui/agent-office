// The local launcher serves these routes. Keys only travel in a connection save.
import {providerFor, providerGroups, providers} from './model-providers.js';

const dialog = document.querySelector('#agent-studio');
const field = id => dialog.querySelector('#studio-' + id);
const presets = Object.fromEntries(providers.map(p => [p.id, p]));
const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];

field('provider').replaceChildren(
  ...providerGroups.map(([group, label]) => {
    const list = document.createElement('optgroup');
    list.label = label;
    list.append(...providers.filter(p => p.group === group).map(p => new Option(p.label, p.id)));
    return list;
  })
);

async function request(path = '', method = 'GET', body) {
  const response = await fetch('/api/studio' + path, {
    method,
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(120000),
    ...(body && {headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)})
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || '保存失败，请重试');
  return data;
}

function options(id, items, first) {
  field(id).replaceChildren(...(first ? [first, ...items] : items).map(([value, text]) => new Option(text, value)));
}

function feedback(text = '', error = false) {
  const area = field('feedback');
  area.hidden = !text;
  area.classList.toggle('studio-error', error);
  area.textContent = text;
}

// Closing the dialog hides the pending result. A later opening waits for a save
// already in flight before reloading, so its pickers reflect the saved settings.
let pending, session;
// `template` ({name, role, instructions}) prefills a new Agent, e.g. from first-run onboarding.
export async function openAgentStudio({onAgent, onConnect, onChanged, template}) {
  if (dialog.open) return;
  const token = (session = Symbol());
  const active = () => dialog.open && token === session;
  let data, agentId, connectionId, dirty;
  const controls = field('controls');
  const connection = () => data.connections.find(c => c.id === connectionId);
  const profile = () => data.agents.find(a => a.id === agentId);

  function tab(connectionTab) {
    field('profiles').setAttribute('aria-pressed', String(!connectionTab));
    field('connections').setAttribute('aria-pressed', String(connectionTab));
    field('connection-form').hidden = !connectionTab;
    if (connectionTab && data) connectionActions();
    field('agent-form').hidden = connectionTab;
    field('remove-confirm').hidden = true;
    feedback();
  }

  function renderSources(selected) {
    const sources = data.connections.map(c => [c.id, c.name + ' · ' + c.model]);
    if (data.localAvailable) sources.unshift(['local', 'Pi · 本机模型']);
    options('agent-connection', sources, sources.length ? null : ['', '请先添加模型连接']);
    const select = field('agent-connection');
    if (selected === 'local' && !data.localAvailable) {
      const item = new Option('Pi · 本机模型暂不可用', 'local', false, true);
      item.disabled = true;
      select.add(item);
    } else if (sources.some(([id]) => id === selected)) select.value = selected;
    describeSource();
  }

  function describeSource() {
    const source = field('agent-connection').value;
    field('save-agent').disabled =
      !source || (source === 'local' && !data.localAvailable && profile()?.enabled !== false);
    const entry = data.connections.find(c => c.id === source);
    const host = entry && new URL(entry.baseUrl);
    field('model-hint').textContent = entry
      ? '处理消息和任务时，相应内容会发送到' + (LOOPBACK.includes(host.hostname) ? '本机的 ' : ' ') + host.host + '。'
      : data.localAvailable
        ? '使用本机加载的模型推理。'
        : source === 'local'
          ? '恢复本机模型，或选择可用的 API 连接。'
          : '添加一个模型连接后即可创建 Agent。';
  }

  function chooseAgent(id = '') {
    const agent = data.agents.find(a => a.id === id);
    agentId = agent?.id || '';
    field('agent-id').value = agentId;
    field('agent-name').value = agent?.name || '';
    field('agent-role').value = agent?.role || '';
    field('agent-instructions').value = agent?.instructions || '';
    renderSources(agent?.connectionId);
    renderAgentStatus();
    feedback(agent?.error, agent?.status === 'error');
  }

  function renderAgentStatus() {
    const agent = profile();
    const disabled = agent?.enabled === false;
    field('run-controls').hidden = !agent;
    const states = {running: '运行中', starting: '正在启动', disabled: '已停用', error: '待修复'};
    field('agent-status').textContent = agent ? '运行状态 · ' + (states[agent.status] || '正在同步') : '';
    field('toggle-agent').textContent = disabled ? '启用 Agent' : '停用 Agent';
    field('save-agent').textContent = disabled ? '保存设置' : agent ? '保存并打开对话' : '创建并开始对话';
    describeSource();
  }

  function clearModels() {
    field('model-list').replaceChildren();
    field('model-list-label').hidden = true;
  }

  function connectionActions() {
    const previous = connection();
    const address = field('base-url').value;
    const changedOrigin =
      previous?.hasKey && URL.canParse(address) && new URL(address).origin !== new URL(previous.baseUrl).origin;
    const keyField = field('api-key');
    const clearing = field('clear-key').checked;
    keyField.required = Boolean(changedOrigin && !clearing);
    keyField.disabled = clearing;
    field('clear-key-label').hidden = !previous?.hasKey;
    keyField.placeholder = clearing
      ? '保存后清除'
      : changedOrigin
        ? '地址已更换，请重新填写密钥'
        : previous?.hasKey
          ? '已保存，留空沿用'
          : presets[field('provider').value]?.keyless
            ? '本机服务一般不需要'
            : '按服务商要求填写';
    field('test-connection').disabled = !connectionId || dirty;
    field('use-connection').hidden = !connectionId || dirty;
    field('use-connection').textContent = agentId ? '为当前 Agent 选用此连接 →' : '使用此连接创建 Agent →';
    field('fetch-models').disabled = !address.trim();
    const usedBy = previous ? data.agents.filter(a => a.connectionId === previous.id) : [];
    field('connection-usage').hidden = usedBy.length === 0;
    field('connection-usage').textContent = usedBy.length
      ? '正在供' + usedBy.map(a => '「' + a.name + '」').join('、') + '使用。要移除连接，请先为这些成员选择其他模型。'
      : '';
    field('remove-connection').hidden = !previous;
    field('remove-connection').disabled = !!usedBy.length;
    field('remove-confirm').hidden = true;
  }

  // What to know about the chosen service, with a link to its own API docs.
  function describeProvider() {
    const preset = presets[field('provider').value];
    const link = field('provider-docs');
    field('provider-note').textContent = preset?.hint || '';
    link.hidden = !preset?.docs;
    if (preset?.docs) link.href = preset.docs;
    field('provider-hint').hidden = !preset?.hint && !preset?.docs;
  }

  function fillConnection(values) {
    field('connection-name').value = values.name;
    field('base-url').value = values.baseUrl;
    field('model').value = values.model || '';
    field('api-key').value = '';
    field('clear-key').checked = false;
    clearModels();
    describeProvider();
  }

  function chooseConnection(id = '') {
    const entry = data.connections.find(c => c.id === id);
    connectionId = entry?.id || '';
    field('connection-id').value = connectionId;
    const preset = entry ? providerFor(entry.baseUrl).id : 'deepseek';
    field('provider').value = preset;
    fillConnection(entry || presets[preset]);
    dirty = false;
    connectionActions();
    feedback();
  }

  function renderPickers() {
    options(
      'agent-id',
      data.agents.map(a => [
        a.id,
        a.name + (a.enabled === false ? ' · 已停用' : a.status === 'error' ? ' · 待修复' : '')
      ]),
      ['', '创建新 Agent']
    );
    options(
      'connection-id',
      data.connections.map(c => [c.id, c.name + ' · ' + c.model]),
      ['', '添加新连接']
    );
    field('profile-picker').hidden = !data.agents.length;
    field('connection-picker').hidden = !data.connections.length;
    field('agent-id').value = agentId || '';
    field('connection-id').value = connectionId || '';
  }

  function work(label, action) {
    if (controls.disabled) return;
    controls.disabled = true;
    controls.setAttribute('aria-busy', 'true');
    feedback(label);
    pending = (async () => {
      try {
        await action();
      } catch (error) {
        if (active()) feedback(error.message, true);
      } finally {
        if (active()) {
          controls.disabled = false;
          controls.removeAttribute('aria-busy');
        }
      }
    })();
  }

  field('close').onclick = () => dialog.close();
  dialog.onclose = () => {
    field('api-key').value = '';
    session = null;
  };
  field('external').onclick = () => {
    dialog.close();
    onConnect();
  };
  dialog.showModal();
  controls.removeAttribute('aria-busy');
  controls.disabled = true;
  tab(false);
  field('agent-form').reset();
  field('connection-form').reset();
  feedback('正在读取本机配置…');

  try {
    await pending;
    if (!active()) return;
    data = await request();
    if (!active()) return;
    renderPickers();
    chooseConnection();
    chooseAgent();
    controls.disabled = false;
    if (template) {
      field('agent-name').value = template.name;
      field('agent-role').value = template.role;
      field('agent-instructions').value = template.instructions;
      // With the role written, the next step is a model: create, or add a connection first.
      (field('save-agent').disabled ? field('add-connection') : field('save-agent')).focus();
    } else field('agent-name').focus();
  } catch (error) {
    if (active()) feedback('无法读取工作室配置。请重新打开工作室重试。', true);
    return;
  }

  field('profiles').onclick = () => tab(false);
  field('connections').onclick = () => tab(true);
  field('agent-id').onchange = e => chooseAgent(e.target.value);
  field('connection-id').onchange = e => chooseConnection(e.target.value);
  field('agent-connection').onchange = describeSource;
  field('add-connection').onclick = () => {
    tab(true);
    chooseConnection();
    field('provider').focus();
  };
  field('provider').onchange = e => {
    fillConnection(presets[e.target.value]);
    dirty = true;
    connectionActions();
    feedback();
  };
  field('connection-form').oninput = event => {
    if ([field('connection-id'), field('model-list')].includes(event.target)) return;
    if ([field('base-url'), field('api-key'), field('clear-key')].includes(event.target)) clearModels();
    if (event.target === field('clear-key') && field('clear-key').checked) field('api-key').value = '';
    dirty = true;
    connectionActions();
    feedback();
  };

  field('connection-form').onsubmit = e => {
    e.preventDefault();
    work('正在保存连接…', async () => {
      const previousId = connectionId;
      const payload = {
        name: field('connection-name').value.trim(),
        baseUrl: field('base-url').value.trim(),
        model: field('model').value.trim()
      };
      if (field('clear-key').checked) payload.clearKey = true;
      else if (field('api-key').value) payload.apiKey = field('api-key').value;
      const {connection: saved} = await request(
        '/connections' + (previousId ? '/' + previousId : ''),
        previousId ? 'PUT' : 'POST',
        payload
      );
      if (!active()) return;
      const source = field('agent-connection').value;
      data.connections = [...data.connections.filter(c => c.id !== saved.id), saved];
      renderPickers();
      chooseConnection(saved.id);
      renderSources(source);
      feedback('连接已保存。');
    });
  };
  field('fetch-models').onclick = () => {
    if (!field('base-url').reportValidity() || !field('api-key').reportValidity()) return;
    work('正在读取服务端模型…', async () => {
      const previous = connection();
      const baseUrl = field('base-url')
        .value.trim()
        .replace(/\/+$/, '')
        .replace(/\/chat\/completions$/, '');
      const apiKey = field('api-key').value;
      const saved = previous?.baseUrl === baseUrl && !apiKey && !field('clear-key').checked;
      if (!saved && previous?.hasKey && !apiKey && !field('clear-key').checked) {
        feedback('请先保存地址修改，或填写该地址的 API Key 后获取模型。', true);
        return;
      }
      clearModels();
      const {models} = await request(
        saved ? '/connections/' + connectionId + '/models' : '/connections/models',
        'POST',
        saved ? {} : {baseUrl, ...(apiKey && {apiKey})}
      );
      if (!active()) return;
      options(
        'model-list',
        models.map(model => [model, model]),
        ['', '请选择模型']
      );
      field('model-list-label').hidden = !models.length;
      feedback(models.length ? '已获取 ' + models.length + ' 个模型。' : '服务未列出模型，请手动填写模型 ID。');
    });
  };
  field('model-list').onchange = () => {
    if (!field('model-list').value) return;
    field('model').value = field('model-list').value;
    dirty = true;
    connectionActions();
    feedback();
  };
  field('remove-connection').onclick = () => {
    field('remove-question').textContent = '移除「' + connection().name + '」及其保存的密钥？';
    field('remove-confirm').hidden = false;
    field('cancel-remove').focus();
  };
  field('cancel-remove').onclick = () => {
    field('remove-confirm').hidden = true;
    field('remove-connection').focus();
  };
  field('confirm-remove').onclick = () =>
    work('正在移除连接…', async () => {
      await request('/connections/' + connectionId, 'DELETE');
      if (!active()) return;
      const selected = field('agent-connection').value;
      data.connections = data.connections.filter(c => c.id !== connectionId);
      chooseConnection();
      renderPickers();
      renderSources(selected);
      feedback('连接已移除。');
    });
  field('toggle-agent').onclick = () => {
    const enabled = profile()?.enabled === false;
    work(enabled ? '正在启动 Agent…' : '正在停用 Agent…', async () => {
      const {agent} = await request('/agents/' + agentId + '/enabled', 'POST', {enabled});
      if (!active()) return;
      data.agents = data.agents.map(a => (a.id === agent.id ? agent : a));
      renderPickers();
      renderAgentStatus();
      feedback(
        agent.error || (enabled ? 'Agent 已启用。' : 'Agent 已停用。重新启用后继续处理待办。'),
        agent.status === 'error'
      );
      await onChanged?.();
    });
  };
  field('test-connection').onclick = () =>
    work('正在请求模型回复…', async () => {
      await request('/connections/' + connectionId + '/test', 'POST', {});
      if (active()) feedback('连接成功，模型已回复测试请求。');
    });
  field('use-connection').onclick = () => {
    tab(false);
    renderSources(connectionId);
    field('agent-name').focus();
  };
  field('agent-form').onsubmit = e => {
    e.preventDefault();
    work(agentId ? '正在应用设置…' : '正在创建 Agent…', async () => {
      const {agent} = await request('/agents' + (agentId ? '/' + agentId : ''), agentId ? 'PUT' : 'POST', {
        name: field('agent-name').value.trim(),
        role: field('agent-role').value.trim(),
        instructions: field('agent-instructions').value.trim(),
        connectionId: field('agent-connection').value
      });
      if (!active()) return;
      if (agent.status === 'error' || agent.enabled === false) {
        data.agents = [...data.agents.filter(a => a.id !== agent.id), agent];
        renderPickers();
        chooseAgent(agent.id);
        feedback(agent.error || '已保存设置。启用 Agent 后即可继续对话。', agent.status === 'error');
        return;
      }
      dialog.close();
      await onAgent(agent);
    });
  };
}
