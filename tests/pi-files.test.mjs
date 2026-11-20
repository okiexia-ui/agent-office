import assert from 'node:assert/strict';
import {access, mkdtemp, rename, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createPiFiles} from '../scripts/pi-files.mjs';
import {documentTool, writeDocumentFile} from '../scripts/pi-documents.mjs';

test('local file API isolates members, requires same origin, and downloads uploaded bytes as attachments', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-file-api-'));
  t.after(() => rm(dir, {force: true, recursive: true}));
  const files = createPiFiles(dir, id => ['pi-local', 'editor'].includes(id));
  const name = '新表 #01.csv';
  function request(id, queryPath = '', init = {}, download = false) {
    const url = new URL('http://127.0.0.1:3080/api/studio/files/' + id);
    url.searchParams.set('path', queryPath);
    if (download) url.searchParams.set('download', '1');
    return files.fetch(new Request(url, init));
  }
  const upload = {method: 'POST', headers: {'Content-Type': 'application/octet-stream'}, body: '数量,2'};
  assert.equal((await request('api-only', name, upload)).status, 404);
  assert.equal(
    (await request('editor', name, {...upload, headers: {...upload.headers, origin: 'http://localhost:9000'}})).status,
    403
  );
  assert.equal((await request('editor', '', {headers: {'Sec-Fetch-Site': 'same-site'}})).status, 403);
  assert.equal((await request('editor', name, upload)).status, 201);
  assert.equal((await request('editor', name, upload)).status, 409);
  const root = await files.rootFor('editor');
  await documentTool({root, operation: 'write', path: 'drafts/notes.txt', text: 'draft'});
  assert.equal((await request('editor', 'drafts')).status, 200);
  await rename(path.join(root, 'drafts'), path.join(root, 'archive'));
  assert.equal((await request('editor', 'drafts/' + name, upload)).status, 404);
  await assert.rejects(access(path.join(root, 'drafts')), {code: 'ENOENT'});
  await writeDocumentFile(root, 'new/assets/file.bin', Buffer.from('data'));
  assert.equal((await request('editor', 'new/assets/file.bin', {}, true)).status, 200);
  assert.deepEqual((await (await request('pi-local')).json()).files, []);
  const download = await request('editor', name, {}, true);
  assert.equal(await download.text(), upload.body);
  assert.match(download.headers.get('content-disposition'), /^attachment;/);
  assert.equal(download.headers.get('content-type'), 'application/octet-stream');
  assert.equal((await request('editor', 'missing.txt', {}, true)).status, 404);
  assert.equal(
    (
      await request('editor', name, {
        ...upload,
        headers: {...upload.headers, 'Content-Length': String(16 * 1024 * 1024 + 1)}
      })
    ).status,
    413
  );
});
