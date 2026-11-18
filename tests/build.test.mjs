import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from '../scripts/build-lib.mjs';
import {MemoryBucket} from './memory-bucket.mjs';

// One production build into a temporary folder, shared by the tests below.
let outDir, result, worker;
const origin = 'https://office.test';
const get = (pathname, headers = {}) =>
  worker.fetch(new Request(origin + pathname, {headers}), {BUCKET: new MemoryBucket()});
const kb = bytes => bytes / 1024;

before(async () => {
  outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-office-build-'));
  result = await build({outDir});
  worker = (await import(pathToFileURL(result.worker))).default;
});
after(() => fs.rm(outDir, {recursive: true, force: true}));

test('Pages load bundled, hash-named scripts and styles that the Worker actually serves', async () => {
  for (const page of ['/', '/office.html', '/embed.html']) {
    const response = await get(page);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.doesNotMatch(
      html,
      /importmap|vendor\/three|src="\.\/[\w-]+\.js"|href="\.\/[\w-]+\.css"/,
      `${page} still points at source files`
    );
    const references = [...html.matchAll(/(?:src|href)="\.(\/assets\/[^"]+)"/g)].map(match => match[1]);
    assert.ok(references.length >= 2, `${page} references its bundles`);
    for (const asset of references) assert.equal((await get(asset)).status, 200, `${asset} from ${page} is served`);
  }
  assert.match(await (await get('/')).text(), /serviceWorker/);
  assert.doesNotMatch(await (await get('/embed.html')).text(), /serviceWorker/, 'the embed does not register a worker');
});

test('Hashed assets are cached for a year; pages revalidate and may only be framed by the office', async () => {
  const asset = result.assets.find(a => a.path.startsWith('/assets/') && a.path.endsWith('.js')).path;
  assert.equal((await get(asset)).headers.get('cache-control'), 'public, max-age=31536000, immutable');
  const page = await get('/');
  assert.equal(page.headers.get('cache-control'), 'no-cache');
  assert.equal(page.headers.get('content-security-policy'), "frame-ancestors 'self'");
  assert.equal((await get('/', {'If-None-Match': page.headers.get('etag')})).status, 304);
});

test('The app manifest, icons, offline page and service worker are complete', async () => {
  const manifest = await (await get('/manifest.webmanifest')).json();
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.some(icon => icon.purpose === 'maskable'));
  for (const icon of manifest.icons) {
    const response = await get(icon.src.slice(1));
    assert.equal(response.status, 200, icon.src);
    assert.equal(response.headers.get('content-type'), icon.type);
    if (icon.type === 'image/png') {
      const bytes = new Uint8Array(await response.arrayBuffer());
      assert.deepEqual([...bytes.slice(1, 4)], [0x50, 0x4e, 0x47], `${icon.src} is a PNG`);
    }
  }
  assert.equal((await get('/icons/apple-touch-icon.png')).status, 200);
  assert.match(await (await get('/offline.html')).text(), /暂时连不上办公室/);
  const sw = await (await get('/sw.js')).text();
  assert.match(sw, new RegExp(`const VERSION = "${result.version}"`));
  const precache = JSON.parse(sw.match(/const PRECACHE = (\[[\s\S]*?\]);/)[1]);
  assert.ok(precache.includes('./offline.html'));
  for (const entry of precache)
    assert.equal((await get(entry.slice(1))).status, 200, `${entry} is precached but missing`);
});

test('The built Worker keeps every API route working', async () => {
  const bucket = new MemoryBucket(),
    env = {BUCKET: bucket};
  const send = await worker.fetch(
    new Request(origin + '/api/channel', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({requestId: 'built', content: '你好'})
    }),
    env
  );
  assert.equal(send.status, 201);
  const sync = await worker.fetch(new Request(origin + '/api/sync'), env);
  assert.equal((await sync.json()).conversation.messages[0].content, '你好');
  const again = await worker.fetch(
    new Request(origin + '/api/sync', {headers: {'If-None-Match': sync.headers.get('etag')}}),
    env
  );
  assert.equal(again.status, 304);
  const tools = await worker.fetch(
    new Request(origin + '/mcp', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list'})
    }),
    env
  );
  assert.equal((await tools.json()).result.tools.length, 17);
});

test('Download size stays within budget', () => {
  const byPath = new Map(result.assets.map(asset => [asset.path, asset]));
  const initial = page =>
    [result.pages[page].script, ...result.pages[page].preloads].reduce((sum, file) => sum + byPath.get(file).gzip, 0);
  assert.ok(kb(initial('index.html')) < 30, `workspace scripts ${kb(initial('index.html')).toFixed(1)} KB gzip`);
  assert.ok(kb(initial('embed.html')) < 12, `embed scripts ${kb(initial('embed.html')).toFixed(1)} KB gzip`);
  const scene = result.assets.find(asset => /^\/assets\/scene-/.test(asset.path));
  assert.ok(scene, 'the 3D scene is its own lazily loaded chunk');
  assert.ok(kb(scene.gzip) < 200, `3D scene ${kb(scene.gzip).toFixed(1)} KB gzip`);
  assert.ok(kb(result.workerBytes) < 1500, `Worker ${kb(result.workerBytes).toFixed(0)} KB`);
});
