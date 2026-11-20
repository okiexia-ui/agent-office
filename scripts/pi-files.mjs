import fs from 'node:fs/promises';
import path from 'node:path';
import {documentTool, readDocumentFile, writeDocumentFile, workspaceFileLimit as limit} from './pi-documents.mjs';

const json = (value, status = 200) =>
  Response.json(value, {status, headers: {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}});

async function privateDirectory(dir) {
  await fs.mkdir(dir, {mode: 0o700}).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
  if (!(await fs.lstat(dir)).isDirectory()) throw new Error('成员文件目录不可用。');
  return fs.realpath(dir);
}

export function createPiFiles(stateDir, ownsPi) {
  async function rootFor(id) {
    if (!/^[\w-]{1,64}$/.test(id) || !ownsPi(id)) throw new Error('找不到这位本机 Pi 成员。');
    const base = await privateDirectory(path.join(stateDir, 'files'));
    return privateDirectory(path.join(base, id));
  }
  return {
    rootFor,
    ownsPi,
    async fetch(req) {
      const url = new URL(req.url);
      if (
        !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        ![null, 'none', 'same-origin'].includes(req.headers.get('sec-fetch-site')) ||
        (req.headers.has('origin') && req.headers.get('origin') !== url.origin)
      )
        return json({error: '文件区只接受本机同源请求。'}, 403);
      const id = /^\/api\/studio\/files\/([\w-]{1,64})$/.exec(url.pathname)?.[1];
      if (!id || !ownsPi(id)) return json({error: '找不到这位本机 Pi 成员。'}, 404);
      const relative = url.searchParams.get('path') || '';
      try {
        const root = await rootFor(id);
        if (req.method === 'GET') {
          if (url.searchParams.get('download') !== '1')
            return json(await documentTool({root, operation: 'list', path: relative}, {signal: req.signal}));
          const buffer = await readDocumentFile(root, relative, {signal: req.signal});
          const filename = encodeURIComponent(path.basename(relative)).replace(
            /['()*]/g,
            c => '%' + c.charCodeAt(0).toString(16)
          );
          return new Response(buffer, {
            headers: {
              'Content-Type': 'application/octet-stream',
              'Content-Disposition': "attachment; filename*=UTF-8''" + filename,
              'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff',
              'Content-Security-Policy': "default-src 'none'"
            }
          });
        }
        if (req.method !== 'POST') return json({error: '不支持此文件操作。'}, 405);
        if (req.headers.get('content-type')?.split(';')[0] !== 'application/octet-stream')
          return json({error: '请选择要上传的文件。'}, 415);
        if (Number(req.headers.get('content-length')) > limit) return json({error: '每个文件最大 16 MiB。'}, 413);
        let bytes = 0;
        const chunks = [];
        for await (const chunk of req.body ?? []) {
          bytes += chunk.byteLength;
          if (bytes > limit) return json({error: '每个文件最大 16 MiB。'}, 413);
          chunks.push(chunk);
        }
        const result = await writeDocumentFile(root, relative, Buffer.concat(chunks), {
          signal: req.signal,
          createParents: false
        });
        return json(result, 201);
      } catch (error) {
        if (error.code === 'FILE_EXISTS') return json({error: '同名文件已存在，请更名后上传。'}, 409);
        if (error.code === 'NOT_FOUND') return json({error: '文件或目录不存在。'}, 404);
        if (error.code === 'FILE_TOO_LARGE') return json({error: '每个文件最大 16 MiB。'}, 413);
        if (error.code === 'NO_PYTHON') return json({error: error.message}, 503);
        return json({error: '无法访问此文件。请检查相对路径、文件大小和目录权限。'}, 400);
      }
    }
  };
}
