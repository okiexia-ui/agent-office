// Mounted below the member's model field. The controller only receives redacted connections.
import {providers, providerGroups, providerFor} from './model-providers.js';

export const connectionForm = `
<form id="studio-connection-form" class="member-connection" autocomplete="off" hidden aria-labelledby="studio-connection-title">
  <header><h3 id="studio-connection-title">新模型连接</h3><button type="button" id="studio-close-connection" aria-label="收起连接表单">收起</button></header>
  <label>服务商<select id="studio-provider"></select></label>
  <p id="studio-provider-hint" class="member-hint" hidden><span id="studio-provider-note"></span> <a id="studio-provider-docs" target="_blank" rel="noopener noreferrer">接口文档 ↗</a></p>
  <label>连接名称<input id="studio-connection-name" required maxlength="80" placeholder="例如：团队写作模型"></label>
  <label>API 基础地址<input id="studio-base-url" type="url" required maxlength="2048" autocomplete="off" spellcheck="false" placeholder="https://example.com/v1"></label>
  <label>API Key<input id="studio-api-key" type="password" autocomplete="new-password" maxlength="4096" spellcheck="false"></label>
  <label class="member-check" id="studio-clear-key-label" hidden><input id="studio-clear-key" type="checkbox">保存时清除已有密钥</label>
  <label>模型 ID<input id="studio-model" required maxlength="256" spellcheck="false" placeholder="输入服务商提供的模型 ID"></label>
  <div><button id="studio-fetch-models" type="button">获取可用模型</button></div>
  <label id="studio-model-list-label" hidden>可用模型<select id="studio-model-list"></select></label>
  <p class="member-hint">密钥保存在本机。测试连接时，会向这个服务发送一次模型请求。</p>
  <div class="member-actions"><button type="submit" id="studio-save-connection">保存连接</button><button type="button" id="studio-test-connection">测试连接</button><button type="button" id="studio-remove-connection" class="danger">移除连接…</button></div>
  <p class="member-hint" id="studio-connection-usage" hidden></p>
  <div id="studio-remove-confirm" hidden role="group" aria-labelledby="studio-remove-question"><p id="studio-remove-question"></p><button id="studio-cancel-remove" type="button">取消</button><button type="button" id="studio-confirm-remove" class="danger">确认移除</button></div>
</form>`;

export function mountConnectionEditor({field, catalog, request, work, feedback, active, onSources}) {
  let saved, dirty;
  const form = field('connection-form');
  const preset = () => providers.find(p => p.id === field('provider').value);
  field('provider').replaceChildren(
    ...providerGroups.map(([group, label]) => {
      const options = document.createElement('optgroup');
      options.label = label;
      options.append(...providers.filter(p => p.group === group).map(p => new Option(p.label, p.id)));
      return options;
    })
  );

  function clearModels() {
    field('model-list').replaceChildren();
    field('model-list-label').hidden = true;
  }
  function controls() {
    const address = field('base-url').value.trim();
    const otherOrigin =
      saved?.hasKey && URL.canParse(address) && new URL(address).origin !== new URL(saved.baseUrl).origin;
    const clear = field('clear-key').checked;
    const key = field('api-key');
    key.required = !!otherOrigin && !clear;
    key.disabled = clear;
    key.placeholder = clear
      ? '保存后清除'
      : otherOrigin
        ? '地址已更换，请重新填写密钥'
        : saved?.hasKey
          ? '已配置，留空沿用'
          : preset()?.keyless
            ? '本机服务通常无需密钥'
            : '按服务商要求填写';
    field('clear-key-label').hidden = !saved?.hasKey;
    field('test-connection').hidden = !saved;
    field('test-connection').disabled = dirty;
    field('fetch-models').disabled = !address;
    field('remove-connection').hidden = !saved;
    const users = saved ? catalog.agents.filter(a => a.connectionId === saved.id) : [];
    field('remove-connection').disabled = users.length > 0;
    const usage = field('connection-usage');
    usage.hidden = !users.length;
    usage.textContent = users.length
      ? users.map(a => a.name).join('、') + '正在使用此连接。更改会应用到这些成员；改选其他模型后可以移除。'
      : '';
    field('remove-confirm').hidden = true;
  }
  function fill(entry) {
    field('connection-name').value = entry.name;
    field('base-url').value = entry.baseUrl;
    field('model').value = entry.model || '';
    field('api-key').value = '';
    field('clear-key').checked = false;
    clearModels();
    const p = preset();
    field('provider-note').textContent = p.hint || '';
    field('provider-hint').hidden = !p.hint && !p.docs;
    field('provider-docs').hidden = !p.docs;
    if (p.docs) field('provider-docs').href = p.docs;
    controls();
  }
  function open(id) {
    saved = catalog.connections.find(c => c.id === id);
    dirty = false;
    field('provider').value = saved ? providerFor(saved.baseUrl).id : 'deepseek';
    field('connection-title').textContent = saved ? '编辑模型连接' : '新模型连接';
    form.hidden = false;
    fill(saved || preset());
    field('provider').focus();
    feedback();
  }
  function close(focus = true) {
    form.hidden = true;
    saved = null;
    field('api-key').value = '';
    if (focus) field('agent-connection').focus();
  }
  field('close-connection').onclick = () => close();
  field('provider').onchange = () => {
    dirty = true;
    fill(preset());
    feedback();
  };
  form.oninput = e => {
    if ([field('model-list'), field('provider')].includes(e.target)) return;
    if ([field('base-url'), field('api-key'), field('clear-key')].includes(e.target)) clearModels();
    if (e.target === field('clear-key') && e.target.checked) field('api-key').value = '';
    dirty = true;
    controls();
    feedback();
  };
  field('fetch-models').onclick = () => {
    if (!field('base-url').reportValidity() || !field('api-key').reportValidity()) return;
    work('正在读取服务端模型…', async () => {
      const baseUrl = field('base-url')
        .value.trim()
        .replace(/\/+$/, '')
        .replace(/\/chat\/completions$/, '');
      const apiKey = field('api-key').value;
      const keepKey = !apiKey && !field('clear-key').checked;
      const useSaved = saved?.baseUrl === baseUrl && keepKey;
      if (!useSaved && saved?.hasKey && keepKey) throw Error('请先保存地址修改，或为该地址重新填写 API Key。');
      clearModels();
      const {models} = await request(
        useSaved ? '/connections/' + saved.id + '/models' : '/connections/models',
        'POST',
        useSaved ? {} : {baseUrl, ...(apiKey && {apiKey})}
      );
      if (!active()) return;
      field('model-list').replaceChildren(new Option('请选择模型', ''), ...models.map(m => new Option(m, m)));
      field('model-list-label').hidden = !models.length;
      feedback(models.length ? '已获取 ' + models.length + ' 个模型。' : '服务未列出模型，请手动填写模型 ID。');
    });
  };
  field('model-list').onchange = e => {
    if (!e.target.value) return;
    field('model').value = e.target.value;
    dirty = true;
    controls();
    feedback();
  };
  form.onsubmit = e => {
    e.preventDefault();
    work('正在保存连接…', async () => {
      const creating = !saved;
      const payload = {
        name: field('connection-name').value.trim(),
        baseUrl: field('base-url').value.trim(),
        model: field('model').value.trim()
      };
      if (field('clear-key').checked) payload.clearKey = true;
      else if (field('api-key').value) payload.apiKey = field('api-key').value;
      const {connection} = await request(
        '/connections' + (saved ? '/' + saved.id : ''),
        saved ? 'PUT' : 'POST',
        payload
      );
      if (!active()) return;
      catalog.connections = [...catalog.connections.filter(c => c.id !== connection.id), connection];
      // Editing a shared connection preserves the unsaved model selection for this member.
      onSources(creating ? connection.id : field('agent-connection').value);
      close();
      feedback('连接已保存。');
    });
  };
  field('test-connection').onclick = () =>
    work('正在测试连接…', async () => {
      await request('/connections/' + saved.id + '/test', 'POST', {});
      if (active()) feedback('连接成功，模型已回复测试请求。');
    });
  field('remove-connection').onclick = () => {
    field('remove-question').textContent = '移除「' + saved.name + '」及其保存的密钥？';
    field('remove-confirm').hidden = false;
    field('cancel-remove').focus();
  };
  field('cancel-remove').onclick = () => {
    field('remove-confirm').hidden = true;
    field('remove-connection').focus();
  };
  field('confirm-remove').onclick = () =>
    work('正在移除连接…', async () => {
      await request('/connections/' + saved.id, 'DELETE');
      if (!active()) return;
      const selected = field('agent-connection').value;
      catalog.connections = catalog.connections.filter(c => c.id !== saved.id);
      onSources(selected);
      close();
      feedback('连接已移除。');
    });
  return {open, close};
}
