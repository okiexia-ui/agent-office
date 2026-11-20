// Shared by the Pi document tool, the local file routes and the isolated browser.
import {execFile} from 'node:child_process';
import {homedir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const helper = fileURLToPath(new URL('./pi-documents.py', import.meta.url));
export const workspaceFileLimit = 16 * 1024 * 1024;
const codexPython = path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
const available = new Map();

export const documentDescription =
  '在当前 Agent 的工作区列出文件、读取文档或写入文件。DOCX、PDF、TXT、MD、HTML 和 CSS 用 text；CSV、XLSX 用 rows 二维数组；PPTX 用 slides，每张包含 title 和 body。PDF 自动分页，也可用换页符分隔页面。可读取含文字的 PDF。默认创建新文件。只有用户明确要求替换整份文件时才设 overwrite=true。';
export const documentSchema = {
  type: 'object',
  properties: {
    operation: {type: 'string', enum: ['list', 'read', 'write']},
    path: {type: 'string', description: '工作区内的相对路径，列出根目录时可省略'},
    text: {type: 'string', description: '写文档的正文，使用换行分段'},
    rows: {
      type: 'array',
      items: {type: 'array', items: {anyOf: [{type: 'string'}, {type: 'number'}, {type: 'boolean'}, {type: 'null'}]}}
    },
    slides: {
      type: 'array',
      items: {
        type: 'object',
        properties: {title: {type: 'string'}, body: {type: 'string'}},
        required: ['title', 'body'],
        additionalProperties: false
      }
    },
    overwrite: {type: 'boolean', description: '替换已有文件的全部内容，默认 false'}
  },
  required: ['operation'],
  additionalProperties: false
};

function invoke(python, request, bytes, signal) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      python,
      ['-I', helper],
      {
        encoding: 'buffer',
        maxBuffer: workspaceFileLimit + 8192,
        timeout: 30000,
        killSignal: 'SIGKILL',
        signal
      },
      (error, output, stderr) => {
        if (signal?.aborted) return reject(signal.reason);
        if (!error) {
          try {
            return resolve(request.operation === 'download' ? output : JSON.parse(output.toString('utf8')));
          } catch {
            return reject(new Error('无法读取文档工具的结果。'));
          }
        }
        if (error.code === 'ENOENT')
          return reject(
            Object.assign(new Error('未找到 Python 3。可用 OFFICE_DOCUMENT_PYTHON 指定本机解释器。'), {
              code: 'NO_PYTHON'
            })
          );
        let problem;
        try {
          problem = JSON.parse(stderr.toString('utf8').trim().split('\n').at(-1));
        } catch {}
        reject(
          Object.assign(new Error(problem?.error || (error.killed ? '文档处理超时。' : '文档处理失败。')), {
            code: problem?.code || 'DOCUMENT_ERROR'
          })
        );
      }
    );
    child.stdin.on('error', error => {
      if (error.code !== 'EPIPE') reject(error);
    });
    child.stdin.write(JSON.stringify(request) + '\n');
    child.stdin.end(bytes);
  });
}

async function run(request, {signal, bytes} = {}) {
  signal?.throwIfAborted();
  if (!path.isAbsolute(request.root ?? '')) throw new Error('工作目录须为绝对路径。');
  const explicit = process.env.OFFICE_DOCUMENT_PYTHON;
  const format = ['read', 'write'].includes(request.operation)
    ? path.extname(request.path ?? '').toLowerCase()
    : 'filesystem';
  const candidates = explicit
    ? [explicit]
    : [...new Set([available.get(format), 'python3', codexPython].filter(Boolean))];
  let missing;
  for (const candidate of candidates) {
    try {
      const result = await invoke(candidate, request, bytes, signal);
      if (!explicit) available.set(format, candidate);
      return result;
    } catch (error) {
      if (!['NO_PYTHON', 'MISSING_MODULE'].includes(error.code)) throw error;
      if (!missing || error.code === 'MISSING_MODULE') missing = error;
    }
  }
  throw missing;
}

export async function documentTool(
  {root, operation, path: relativePath = '', text, slides, rows, overwrite = false},
  {signal} = {}
) {
  if (!['list', 'read', 'write'].includes(operation)) throw new Error('请选择 list、read 或 write。');
  return run({root, operation, path: relativePath, text, slides, rows, overwrite}, {signal});
}

export function readDocumentFile(root, relativePath, {signal, maxBytes = workspaceFileLimit} = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > workspaceFileLimit)
    throw new Error('无效的文件大小限制。');
  return run({root, operation: 'download', path: relativePath, maxBytes}, {signal});
}

export function writeDocumentFile(root, relativePath, bytes, {signal, overwrite = false, createParents = true} = {}) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > workspaceFileLimit)
    throw new Error('仅可写入 16 MiB 以内的文件。');
  return run({root, operation: 'upload', path: relativePath, overwrite, createParents}, {signal, bytes});
}

// The native viewer needs a pathname. Validate the actual file at handoff.
export function existingDocumentPath(root, relativePath, {signal} = {}) {
  return run({root, operation: 'locate', path: relativePath}, {signal});
}
