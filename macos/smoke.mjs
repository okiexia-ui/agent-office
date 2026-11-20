// Exercise the packaged launcher without reading the real office or starting a model.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';

if (!process.argv[2]) throw Error('Usage: node macos/smoke.mjs "/path/to/Agent Office.app"');
const resources = path.resolve(process.argv[2], 'Contents/Resources');
const {launchOffice} = createRequire(import.meta.url)(path.join(resources, 'start-office.cjs'));
for (const key of Object.keys(process.env)) if (key.startsWith('OFFICE_')) delete process.env[key];
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'office-desktop-smoke-'));
const project = path.join(scratch, 'project');
const support = path.join(scratch, 'support');
const stale = http.createServer((_request, response) => {
  response.writeHead(200, {'Content-Type': 'application/json'});
  response.end(JSON.stringify({mode: 'local', studio: true, fileTools: true}));
});
let childPid;
try {
  await fs.mkdir(project);
  await new Promise((resolve, reject) => stale.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = stale.address().port;
  await fs.writeFile(path.join(project, '.env.local'), 'OFFICE_PORT=' + port);
  await assert.rejects(launchOffice({project, support}), /另一个办公室或版本/);
  await new Promise(resolve => stale.close(resolve));
  const first = await launchOffice({project, support});
  childPid = first.startedPid;
  assert.ok(childPid);
  assert.equal(first.url, 'http://127.0.0.1:' + port + '/');
  const response = await fetch(first.url + 'api/local-mode');
  const mode = await response.json();
  assert.equal(mode.mode, 'local');
  assert.equal(mode.workbench, true);
  assert.match(mode.desktopRuntime, /^[a-f0-9]{64}$/);
  assert.deepEqual(await launchOffice({project, support}), {url: first.url});
  const other = path.join(scratch, 'other');
  await fs.mkdir(other);
  await fs.copyFile(path.join(project, '.env.local'), path.join(other, '.env.local'));
  await assert.rejects(launchOffice({project: other, support}), /另一个办公室或版本/);
  console.log('Passed: packaged launch, workbench capability, reopen, stale server and wrong office detection.');
} finally {
  if (stale.listening) await new Promise(resolve => stale.close(resolve));
  if (childPid) {
    process.kill(childPid, 'SIGTERM');
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        process.kill(childPid, 0);
      } catch (error) {
        if (error.code === 'ESRCH') break;
        throw error;
      }
      await delay(50);
    }
  }
  await fs.rm(scratch, {recursive: true, force: true});
}
