import path from 'node:path';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {existingDocumentPath} from './pi-documents.mjs';

const editScript = fileURLToPath(new URL('./textedit.jxa', import.meta.url));
const applications = {
  open_text: 'com.apple.TextEdit',
  preview: 'com.apple.Preview'
};
export const macDescription =
  'Use Mac native applications with an existing file in this agent workspace. Open a text file, read its TextEdit buffer, append literal text or a new line (use append_line for 另起一行/追加一行) and save, open a PDF/image in Preview, or reveal a file in Finder. Use only when asked for a native app.';
export const macParameters = {
  type: 'object',
  properties: {
    action: {type: 'string', enum: ['open_text', 'read_text', 'append_text', 'append_line', 'preview', 'reveal']},
    path: {type: 'string', description: 'Existing relative path inside this agent workspace.'},
    text: {type: 'string', description: 'Text to append. append_line starts a new line automatically.'}
  },
  required: ['action', 'path'],
  additionalProperties: false
};

function runNative(binary, args, input, signal) {
  return new Promise((resolve, reject) => {
    const child = execFile(binary, args, {signal, timeout: 25000, maxBuffer: 128 * 1024}, (error, stdout, stderr) => {
      if (signal?.aborted) return reject(signal.reason);
      if (!error) return resolve(stdout.trimEnd());
      if (/(-1743|not authorized|not permitted|not allowed to send apple events)/i.test(stderr))
        return reject(
          new Error(
            'macOS 尚未授权控制文本编辑。请在「系统设置 → 隐私与安全性 → 自动化」中允许启动办公室的应用控制文本编辑。'
          )
        );
      if (error.killed) return reject(new Error('Mac 应用未及时响应。请检查是否有待确认的系统对话框。'));
      reject(new Error('Mac 应用没有完成操作，请确认已登录桌面并检查该文件是否可用。'));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export async function operateMac(
  root,
  {action, path: relativePath, text},
  {signal, platform = process.platform, run = runNative} = {}
) {
  if (platform !== 'darwin') throw new Error('原生应用操作需要 macOS。');
  if (!macParameters.properties.action.enum.includes(action)) throw new Error('不支持的 Mac 操作。');
  const file = await existingDocumentPath(root, relativePath, {signal});
  const extension = path.extname(file).toLowerCase();
  if (action === 'preview' && !['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.tif', '.tiff', '.webp'].includes(extension))
    throw new Error('预览支持 PDF 和图像文件。');
  if ((action.endsWith('_text') || action === 'append_line') && !['.txt', '.md', '.csv'].includes(extension))
    throw new Error('文本编辑支持 TXT、Markdown 和 CSV 文件。');
  signal?.throwIfAborted();
  if (action === 'reveal' || applications[action]) {
    await run(
      '/usr/bin/open',
      action === 'reveal' ? ['-R', file] : ['-g', '-b', applications[action], file],
      '',
      signal
    );
    return {path: relativePath, action, status: 'opened'};
  }
  if (action.startsWith('append_') && (typeof text !== 'string' || !text || text.length > 32000))
    throw new Error('请提供 1 至 32000 个字符追加到文件。');
  const output = await run(
    '/usr/bin/osascript',
    ['-l', 'JavaScript', editScript],
    JSON.stringify({action, file, text}),
    signal
  );
  return {...JSON.parse(output), path: relativePath};
}
