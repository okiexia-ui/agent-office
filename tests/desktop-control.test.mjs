import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

// The Mac app asks the office what is still running and stops it (with the local model)
// when it quits. Start the real launcher, without the operator's .env.local or a model.
test('The desktop app can see running work and stop the office; web pages cannot', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'office-desktop-control-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const child = spawn(process.execPath, ['scripts/local.mjs'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {PATH: process.env.PATH, OFFICE_DATA_DIR: dir, OFFICE_PORT: '0', OFFICE_PI_BIN: path.join(dir, 'no-pi')},
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const closed = once(child, 'close');
  t.after(() => child.exitCode === null && child.signalCode === null && child.kill('SIGKILL'));
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => (output += chunk));
  let origin;
  for (const end = Date.now() + 15000; !origin && Date.now() < end; await delay(100)) {
    assert.equal(child.exitCode, null, 'Office exited during startup: ' + output);
    origin = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  }
  assert.ok(origin, 'Office did not start: ' + output);
  const send = (route, {method = 'GET', headers = {}} = {}) =>
    fetch(origin + route, {method, headers, signal: AbortSignal.timeout(5000)});
  const control = {'X-Agent-Office-Control': '1'};

  assert.equal((await send('/api/local/activity')).status, 403, 'the control header is required');
  assert.deepEqual(await (await send('/api/local/activity', {headers: control})).json(), {
    running: 0,
    sessions: 0,
    tasks: 0
  });
  const crossSite = await send('/api/local/shutdown', {
    method: 'POST',
    headers: {...control, Origin: 'https://example.com'}
  });
  assert.equal(crossSite.status, 403, 'another origin cannot stop the office');
  assert.equal(child.exitCode, null);
  assert.equal((await send('/api/local/activity', {method: 'POST', headers: control})).status, 404);

  const stop = await send('/api/local/shutdown', {method: 'POST', headers: control});
  assert.equal(stop.status, 202);
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  const [code] = await closed;
  clearTimeout(timer);
  assert.equal(code, 0, 'the office shuts down cleanly: ' + output);
});
