// The local launcher exposes one file workspace per Pi member.
const panel = document.querySelector('#agent-files');
const field = id => panel.querySelector('#files-' + id);
const maxUpload = 16 * 1024 * 1024;
let session;

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KiB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MiB';
}

export function closeAgentFiles() {
  session?.abort();
  session = null;
  panel.hidden = true;
}

export function openAgentFiles(agent, onPrompt, onClose) {
  session?.abort();
  const lifetime = (session = new AbortController());
  let folder = [];
  const list = field('list');
  const input = field('input');
  let busy = false;
  const active = () => session === lifetime && !lifetime.signal.aborted && !panel.hidden;

  function feedback(message = '', error = false) {
    field('status').textContent = message;
    field('status').classList.toggle('file-error', error);
  }

  function controls() {
    field('parent').disabled = busy || folder.length === 0;
    field('upload').disabled = busy;
    field('reload').disabled = busy;
    list.inert = busy;
    list.setAttribute('aria-busy', String(busy));
  }

  async function run(label, action) {
    if (busy || !active()) return;
    busy = true;
    controls();
    feedback(label);
    try {
      await action();
    } catch (error) {
      if (active()) feedback(error.message || '文件操作失败，请重试。', true);
    } finally {
      if (active()) {
        busy = false;
        controls();
      }
    }
  }

  async function request(relativePath, init = {}, download = false) {
    const url = new URL('/api/studio/files/' + encodeURIComponent(agent.id), location.origin);
    url.searchParams.set('path', relativePath);
    if (download) url.searchParams.set('download', '1');
    const response = await fetch(url, {
      ...init,
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(60000)])
    });
    if (response.ok) return response;
    if (response.status === 409) throw Error('已存在同名文件。请改名后再上传。');
    if (response.status === 413) throw Error('文件超过 16 MiB 上限。');
    const data = await response.json().catch(() => ({}));
    throw Error(data.error || '文件操作失败，请刷新目录后重试。');
  }

  async function downloadFile(name) {
    const blob = await (await request([...folder, name].join('/'), {}, true)).blob();
    if (!active()) return;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
    feedback('已开始下载「' + name + '」。');
  }

  async function load(nextFolder = folder, notice = '') {
    const {files, truncated} = await (await request(nextFolder.join('/'))).json();
    if (!active()) return;
    folder = nextFolder;
    list.replaceChildren();
    field('folder').textContent = folder.length ? folder.join(' / ') : '根目录';
    for (const {name, kind, bytes} of files) {
      if (!name || /[/\\\0]/.test(name) || name === '.' || name === '..') continue;
      const row = document.createElement('li');
      const directory = kind === 'directory';
      const item = document.createElement(directory ? 'button' : 'span');
      item.textContent = name;
      if (directory) {
        item.type = 'button';
        item.setAttribute('aria-label', '打开目录 ' + name);
        item.onclick = () => run('正在打开目录…', () => load([...folder, name]));
      }
      const meta = document.createElement('small');
      meta.textContent = directory ? '目录' : formatBytes(bytes);
      row.append(item, meta);
      if (!directory) {
        const download = document.createElement('button');
        download.type = 'button';
        download.textContent = '下载';
        download.setAttribute('aria-label', '下载 ' + name);
        download.onclick = () => run('正在读取文件…', () => downloadFile(name));
        row.append(download);
      }
      list.append(row);
    }
    feedback(
      [notice, truncated ? '当前项目过多，只显示部分文件。' : !list.childElementCount ? '当前目录为空。' : '']
        .filter(Boolean)
        .join(' ')
    );
  }

  field('title').textContent = agent.name + '的成员文件';
  field('folder').textContent = '根目录';
  list.replaceChildren();
  panel.dataset.agent = agent.id;
  field('mac-prompt').hidden = !/mac/i.test(navigator.userAgentData?.platform || navigator.platform);
  field('close').onclick = onClose;
  field('parent').onclick = () => run('正在返回上级目录…', () => load(folder.slice(0, -1)));
  field('reload').onclick = () => run('正在刷新…', () => load());
  field('upload').onclick = () => input.click();
  input.value = '';
  input.onchange = () => {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    if (file.size > maxUpload) return feedback('文件超过 16 MiB 上限。', true);
    run('正在上传「' + file.name + '」…', async () => {
      await request([...folder, file.name].join('/'), {
        method: 'POST',
        headers: {'Content-Type': 'application/octet-stream'},
        body: file
      });
      if (active()) await load(folder, '已上传「' + file.name + '」。');
    });
  };
  const prompts = panel.querySelector('.files-prompts');
  prompts.open = false;
  prompts.onclick = event => {
    const button = event.target.closest('[data-file-prompt]');
    if (button) {
      onClose();
      const prefix = folder.length ? folder.join('/') + '/' : '';
      onPrompt(button.dataset.filePrompt.replaceAll('{folder}', () => prefix));
    }
  };
  panel.hidden = false;
  run('正在读取成员文件…', () => load());
}
