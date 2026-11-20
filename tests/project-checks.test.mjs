import assert from 'node:assert/strict';
import {mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as wait} from 'node:timers/promises';
import test from 'node:test';
import {createProjectChecks} from '../scripts/project-checks.mjs';

async function fixture(t, script) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'office-test-command-')));
  const session = {id: 's', projectPath: dir, status: 'idle'};
  const checks = createProjectChecks();
  t.after(async () => {
    await checks.close();
    await rm(dir, {recursive: true, force: true});
  });
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({scripts: {test: script}}));
  const request = (method = 'GET', fields = {}, suffix = '') =>
    checks.fetch(
      new Request('http://127.0.0.1/api/studio/projects/s/checks' + suffix, {
        method,
        ...(method === 'POST' && {headers: {'content-type': 'application/json'}, body: JSON.stringify(fields)})
      }),
      session
    );
  async function finished() {
    for (let i = 0; i < 150; i++) {
      const {run} = await (await request()).json();
      if (run.status !== 'running') return run;
      await wait(50);
    }
    assert.fail('test process did not settle');
  }
  return {dir, checks, session, request, finished};
}

test('npm test runs in the chosen folder, captures real output and exit code, and accepts only its fixed command', async t => {
  const {dir, session, request, finished} = await fixture(t, 'node verify.cjs');
  await writeFile(
    path.join(dir, 'verify.cjs'),
    "console.log(require('node:fs').readFileSync('marker','utf8'));process.exitCode=2"
  );
  await writeFile(path.join(dir, 'marker'), 'project-check-output');
  assert.equal((await (await request()).json()).available, true);
  assert.equal((await request('POST', {command: 'something else'})).status, 400);
  session.status = 'running';
  assert.equal((await request('POST', {command: 'npm test'})).status, 409);
  session.status = 'idle';
  assert.equal((await request('POST', {command: 'npm test'})).status, 202);
  assert.equal((await request('POST', {command: 'npm test'})).status, 409);
  const run = await finished();
  assert.equal(run.status, 'failed');
  assert.equal(run.exitCode, 2);
  assert.match(run.output, /project-check-output/);
});

test('stopping a project test releases the directory for subsequent turns', async t => {
  const {dir, checks, request, finished} = await fixture(t, 'node waiting.cjs');
  await writeFile(path.join(dir, 'waiting.cjs'), 'setInterval(()=>{},1000)');
  await request('POST', {command: 'npm test'});
  assert.equal(checks.isRunning(path.join(dir, 'lib')), true);
  await request('POST', {}, '/stop');
  assert.equal((await finished()).status, 'stopped');
  assert.equal(checks.isRunning(dir), false);
});
