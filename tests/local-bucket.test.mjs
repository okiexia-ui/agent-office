import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {localBucket} from '../scripts/local-bucket.mjs';
import {createWorker, seedState} from '../worker/index.js';
import {STATE_KEY} from './memory-bucket.mjs';

async function directory(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-office-storage-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  return dir;
}

test('Concurrent local channel posts each receive a distinct revision and survive a restart', async t => {
  const dir = await directory(t);
  const worker = createWorker();
  const env = {BUCKET: await localBucket(dir)};
  const send = requestId =>
    worker.fetch(
      new Request('http://office.test/api/channel', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({requestId, content: requestId})
      }),
      env
    );
  await send('initial');
  const responses = await Promise.all(['one', 'two'].map(send));
  assert.deepEqual(
    responses.map(r => r.status),
    [201, 201]
  );
  const posts = await Promise.all(responses.map(r => r.json()));
  assert.deepEqual(posts.map(p => p.revision).sort(), [2, 3]);
  const saved = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'));
  assert.deepEqual(saved.channelMessages.map(m => m.requestId).sort(), ['initial', 'one', 'two']);
  const reopened = await localBucket(dir);
  assert.deepEqual(await (await reopened.get(STATE_KEY)).json(), saved);
  assert.deepEqual(await reopened.head(STATE_KEY), await env.BUCKET.head(STATE_KEY));
});

test('Separate preview processes compare against the same on-disk version of a legacy state file', async t => {
  const dir = await directory(t);
  const legacy = JSON.stringify(seedState());
  await writeFile(path.join(dir, 'state.json'), legacy);
  const observer = await localBucket(dir);
  const original = await observer.get(STATE_KEY);
  assert.equal(await original.text(), legacy);
  const child = `
    import {localBucket} from './scripts/local-bucket.mjs';
    const [dir, key, etag, body] = process.argv.slice(1);
    const bucket = await localBucket(dir);
    console.log(JSON.stringify(await bucket.put(key, body, {onlyIf: {etagMatches: etag}})));
  `;
  const bodies = [1, 2].map(revision => JSON.stringify({...seedState(), revision}));
  const writes = await Promise.all(
    bodies.map(body =>
      promisify(execFile)(process.execPath, ['--input-type=module', '-e', child, dir, STATE_KEY, original.etag, body], {
        cwd: new URL('..', import.meta.url)
      })
    )
  );
  const results = writes.map(({stdout}) => JSON.parse(stdout));
  assert.equal(results.filter(Boolean).length, 1);
  const winner = results.findIndex(Boolean);
  const current = await observer.get(STATE_KEY);
  assert.equal(current.etag, results[winner].etag);
  assert.equal(await current.text(), bodies[winner]);
  assert.equal((await observer.head(STATE_KEY)).etag, current.etag);
  assert.equal(await observer.put(STATE_KEY, legacy, {onlyIf: {etagMatches: original.etag}}), null);
  const second = await localBucket(dir);
  await second.delete(STATE_KEY);
  assert.equal(await observer.head(STATE_KEY), null);
  const created = await Promise.all(
    [observer, second].map(bucket => bucket.put(STATE_KEY, legacy, {onlyIf: {etagDoesNotMatch: '*'}}))
  );
  assert.equal(created.filter(Boolean).length, 1);
});
