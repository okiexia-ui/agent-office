// Pi's local model, set up in its settings: what this computer has, and which model Pi runs.
// The launcher serves /api/local/pi; the custom header keeps other sites from calling it.
const HEADERS = {'X-Agent-Office-Control': '1'};
const STATES = {
  ready: '已就绪',
  starting: '正在加载',
  failed: '未能启动',
  stopped: '已停止',
  off: '未配置'
};
const esc = value =>
  String(value ?? '').replace(
    /[&<>"']/g,
    c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]
  );
const size = bytes => (bytes >= 1e9 ? (bytes / 1e9).toFixed(1) + ' GB' : Math.max(1, Math.round(bytes / 1e6)) + ' MB');

export async function readPiSetup() {
  const response = await fetch('/api/local/pi', {
    cache: 'no-store',
    headers: HEADERS,
    signal: AbortSignal.timeout(20000)
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || '无法读取本机模型状态。');
  return data;
}

export async function savePiSetup(body) {
  const response = await fetch('/api/local/pi', {
    method: 'POST',
    headers: {...HEADERS, 'Content-Type': 'application/json'},
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000)
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || '无法保存本机模型设置。');
  return data;
}

function describeCurrent(setup) {
  const current = setup.current;
  if (!current) return '';
  return current.file ? current.file.split('/').pop() : current.model + ' · ' + new URL(current.url).host;
}

export function mountPiModelSetup(root, {active = () => true, onChanged} = {}) {
  let setup,
    watching = 0;
  root.hidden = false;
  root.innerHTML = '<p class="member-hint">正在检查本机模型…</p>';

  function render(message = '', error = false) {
    const state = setup.status?.state || 'off';
    const editable = !setup.source || setup.source === 'settings';
    const services = setup.services.flatMap(s =>
      s.models.map(model => ({label: s.name + ' · ' + model, value: JSON.stringify({url: s.baseUrl, model})}))
    );
    const current = setup.current;
    const currentService = current?.url ? JSON.stringify({url: current.url, model: current.model}) : '';
    const usingFile = Boolean(current?.file) || (!current && !services.length && setup.files.length > 0);
    const piMissing = !setup.pi.version;
    root.innerHTML = `
      <div class="pi-model-head"><span class="member-field-title">本机模型</span><span class="pi-model-state" data-state="${state}">${STATES[state] || ''}${state === 'ready' && setup.modelName ? ' · ' + esc(setup.modelName) : ''}</span></div>
      ${setup.status?.error ? `<p class="member-hint pi-model-error">${esc(setup.status.error)}</p>` : ''}
      ${
        setup.source === 'env'
          ? `<p class="member-hint">由 .env.local 配置：${esc(describeCurrent(setup))}。要更换，请修改 .env.local 后重新启动办公室。</p>`
          : setup.source === 'shared'
            ? '<p class="member-hint">共享办公室的模型由启动命令配置。</p>'
            : ''
      }
      <ul class="pi-model-checks">
        <li data-ok="${!piMissing}"><span>Pi 运行环境</span><small>${piMissing ? '未安装' : esc(setup.pi.version)}</small></li>
        ${piMissing ? '<li class="pi-model-fix">在项目目录的终端里运行 <code>npm run pi:install</code>（只需一次），再点「重新检测」。</li>' : ''}
        <li data-ok="${services.length > 0}"><span>正在运行的模型服务</span><small>${setup.services.length ? esc(setup.services.map(s => s.name + ' ' + s.models.length + ' 个模型').join('，')) : '没有检测到 Ollama 或 LM Studio'}</small></li>
        <li data-ok="${Boolean(setup.llama)}"><span>llama-server（运行 GGUF 文件用）</span><small>${setup.llama ? '已安装' : '未找到 · brew install llama.cpp'}</small></li>
      </ul>
      ${
        editable
          ? `<fieldset class="pi-model-source">
        <legend>Pi 使用哪个模型</legend>
        <label class="member-check"><input type="radio" name="pi-source" value="service" ${usingFile ? '' : 'checked'} ${services.length ? '' : 'disabled'}>本机正在运行的模型服务</label>
        <select id="pi-service" aria-label="本机模型服务中的模型" ${services.length ? '' : 'disabled'}>${
          services.length
            ? services
                .map(
                  s =>
                    `<option value="${esc(s.value)}" ${s.value === currentService ? 'selected' : ''}>${esc(s.label)}</option>`
                )
                .join('')
            : '<option>先打开 Ollama 或 LM Studio 并下载模型</option>'
        }</select>
        <label class="member-check"><input type="radio" name="pi-source" value="file" ${usingFile ? 'checked' : ''}>GGUF 模型文件</label>
        <input id="pi-file" list="pi-files" spellcheck="false" autocomplete="off" aria-label="GGUF 模型文件的完整路径" placeholder="/完整路径/model.gguf" value="${esc(current?.file || setup.files[0]?.file || '')}">
        <datalist id="pi-files">${setup.files.map(f => `<option value="${esc(f.file)}">${esc(f.name)} · ${size(f.size)}</option>`).join('')}</datalist>
        <p class="member-hint">${setup.files.length ? `在常用模型文件夹里找到 ${setup.files.length} 个 GGUF 文件，可以从列表选择。` : '填写 GGUF 文件的完整路径。'}</p>
      </fieldset>
      <div class="pi-model-actions"><button type="button" class="member-primary" id="pi-use" ${piMissing ? 'disabled' : ''}>${setup.source === 'settings' ? '切换并重新加载' : '启动 Pi'}</button>${setup.source === 'settings' ? '<button type="button" id="pi-clear">停用本机模型</button>' : ''}<button type="button" id="pi-recheck">重新检测</button></div>`
          : ''
      }
      <p class="member-hint pi-model-feedback ${error ? 'studio-error' : ''}" role="status" ${message ? '' : 'hidden'}>${esc(message)}</p>`;
    if (!editable) return;
    const choose = value => {
      const radio = root.querySelector(`input[name="pi-source"][value="${value}"]`);
      if (!radio.disabled) radio.checked = true;
    };
    root.querySelector('#pi-service').onfocus = () => choose('service');
    root.querySelector('#pi-file').onfocus = () => choose('file');
    root.querySelector('#pi-recheck').onclick = () => load('正在重新检测…');
    root.querySelector('#pi-use').onclick = () => {
      const source = root.querySelector('input[name="pi-source"]:checked')?.value;
      const body =
        source === 'service'
          ? JSON.parse(root.querySelector('#pi-service').value || '{}')
          : {file: root.querySelector('#pi-file').value.trim()};
      void apply(body, '正在启动 Pi，加载模型可能需要一两分钟…');
    };
    const clear = root.querySelector('#pi-clear');
    if (clear) clear.onclick = () => void apply({clear: true}, '正在停用本机模型…');
  }

  async function load(message) {
    if (message && setup) render(message);
    try {
      setup = await readPiSetup();
      if (active()) render();
    } catch (error) {
      if (active()) root.innerHTML = `<p class="member-hint studio-error">${esc(error.message)}</p>`;
    }
  }

  async function apply(body, message) {
    for (const button of root.querySelectorAll('button')) button.disabled = true;
    try {
      await savePiSetup(body);
      setup = await readPiSetup();
      if (!active()) return;
      render(message);
      await onChanged?.();
      // Follow the load so the result shows here without reopening the settings.
      const run = ++watching;
      for (let i = 0; i < 120 && setup.status?.state === 'starting'; i++) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        if (!active() || run !== watching) return;
        setup = await readPiSetup();
      }
      if (!active() || run !== watching) return;
      const state = setup.status?.state;
      render(
        state === 'ready' ? 'Pi 已上线，可以在「对话」里交代工作。' : state === 'off' ? '已停用本机模型。' : '',
        state === 'failed'
      );
      await onChanged?.();
    } catch (error) {
      if (active()) {
        if (setup) render(error.message, true);
        else root.innerHTML = `<p class="member-hint studio-error">${esc(error.message)}</p>`;
      }
    }
  }

  void load();
}
