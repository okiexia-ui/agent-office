import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import http from 'node:http';
import {chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {
  detectServices,
  findGgufFiles,
  findLlamaServer,
  piSettingsEnv,
  validatePiSettings
} from '../scripts/pi-setup.mjs';

test('Pi model settings accept a GGUF path or a model on a service on this computer only', () => {
  assert.deepEqual(validatePiSettings({file: ' /models/qwen.GGUF '}), {file: '/models/qwen.GGUF'});
  assert.deepEqual(validatePiSettings({url: 'http://localhost:11434/v1/', model: ' qwen3:8b '}), {
    url: 'http://localhost:11434/v1',
    model: 'qwen3:8b'
  });
  for (const bad of [
    {file: 'relative/model.gguf'},
    {file: '/models/model.bin'},
    {url: 'https://api.example.com/v1', model: 'x'},
    {url: 'http://user:pw@127.0.0.1:1234/v1', model: 'x'},
    {url: 'http://127.0.0.1:1234/v1', model: ''},
    {},
    null
  ])
    assert.throws(() => validatePiSettings(bad));
  assert.deepEqual(piSettingsEnv({file: '/m.gguf'}), {OFFICE_MODEL_FILE: '/m.gguf'});
  assert.deepEqual(piSettingsEnv({url: 'http://127.0.0.1:1/v1', model: 'm'}), {
    OFFICE_MODEL_URL: 'http://127.0.0.1:1/v1',
    OFFICE_MODEL_ID: 'm'
  });
  assert.deepEqual(piSettingsEnv(null), {});
});

test('setup finds GGUF files, llama-server and running services without false positives', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'office-pi-setup-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  await mkdir(path.join(dir, 'models/org/repo'), {recursive: true});
  await mkdir(path.join(dir, 'models/.hidden'), {recursive: true});
  await writeFile(path.join(dir, 'models/org/repo/chat-Q4.gguf'), 'x');
  await writeFile(path.join(dir, 'models/org/repo/mmproj-F16.gguf'), 'x');
  await writeFile(path.join(dir, 'models/.hidden/secret.gguf'), 'x');
  await writeFile(path.join(dir, 'models/readme.txt'), 'x');
  const files = await findGgufFiles([path.join(dir, 'models'), path.join(dir, 'missing')]);
  assert.deepEqual(
    files.map(f => f.name),
    ['chat-Q4.gguf']
  );

  const bin = path.join(dir, 'bin');
  await mkdir(bin);
  assert.equal(await findLlamaServer({PATH: bin, OFFICE_LLAMA_BIN: path.join(bin, 'llama-server')}), null);
  await writeFile(path.join(bin, 'llama-server'), '#!/bin/sh\n');
  await chmod(path.join(bin, 'llama-server'), 0o755);
  assert.equal(await findLlamaServer({PATH: bin}), path.join(bin, 'llama-server'));

  const services = await detectServices({
    send: async url =>
      url.startsWith('http://127.0.0.1:11434/')
        ? Response.json({data: [{id: 'qwen3:8b'}, {id: 'nomic-embed', type: 'embedding'}]})
        : Promise.reject(new TypeError('fetch failed'))
  });
  assert.deepEqual(
    services.map(s => [s.id, s.models]),
    [['ollama', ['qwen3:8b']]]
  );
});

// The launcher with a stand-in Pi CLI and model service: Pi starts from the workbench,
// keeps the model across restarts, and can be turned off again.
test('the workbench can start, keep and stop Pi on a local model service', {timeout: 60000}, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'office-pi-setup-launch-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const pi = path.join(dir, 'pi');
  await writeFile(
    pi,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "0.0.0-test"; exit 0; fi\ncat >/dev/null\necho ok\n'
  );
  await chmod(pi, 0o755);
  const service = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(request.url === '/v1/models' ? JSON.stringify({data: [{id: 'test-model'}]}) : '{}');
  });
  await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => service.close(resolve)));
  const url = `http://127.0.0.1:${service.address().port}/v1`;

  async function launch(extra = {}) {
    const child = spawn(process.execPath, ['scripts/local.mjs'], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: Object.fromEntries(
        Object.entries({
          PATH: process.env.PATH,
          HOME: dir,
          OFFICE_DATA_DIR: dir,
          OFFICE_PORT: '0',
          OFFICE_PI_BIN: pi,
          ...extra
        }).filter(([, value]) => value !== undefined)
      ),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => (output += chunk));
    const closed = once(child, 'close');
    t.after(() => child.exitCode === null && child.signalCode === null && child.kill('SIGKILL'));
    let origin;
    for (const end = Date.now() + 15000; !origin && Date.now() < end; await delay(100)) {
      assert.equal(child.exitCode, null, 'Office exited during startup: ' + output);
      origin = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    }
    assert.ok(origin, 'Office did not start: ' + output);
    const headers = {'X-Agent-Office-Control': '1'};
    const call = async (method = 'GET', body) => {
      const response = await fetch(origin + '/api/local/pi', {
        method,
        headers: body ? {...headers, 'Content-Type': 'application/json'} : headers,
        ...(body && {body: JSON.stringify(body)})
      });
      return {status: response.status, data: await response.json()};
    };
    const until = async state => {
      for (let i = 0; i < 100; i++) {
        const {data} = await call();
        if (data.status.state === state) return data;
        await delay(100);
      }
      assert.fail('Pi did not reach ' + state + ': ' + output);
    };
    const stop = async () => {
      await fetch(origin + '/api/local/shutdown', {method: 'POST', headers});
      await closed;
    };
    return {call, until, stop, origin};
  }

  let office = await launch();
  assert.equal((await fetch(office.origin + '/api/local/pi')).status, 403, 'the control header is required');
  let {data} = await office.call();
  assert.equal(data.status.state, 'off');
  assert.equal(data.source, null);
  assert.equal(data.pi.version, '0.0.0-test');
  assert.equal((await office.call('POST', {url: 'https://api.example.com/v1', model: 'x'})).status, 400);
  assert.equal((await office.call('POST', {file: path.join(dir, 'missing.gguf')})).status, 400);
  assert.equal((await office.call('POST', {url, model: 'test-model'})).status, 202);
  data = await office.until('ready');
  assert.equal(data.modelName, 'test-model');
  assert.equal(data.source, 'settings');
  const saved = path.join(dir, 'studio/pi-model.json');
  assert.deepEqual(JSON.parse(await readFile(saved, 'utf8')), {url, model: 'test-model'});
  assert.equal((await stat(saved)).mode & 0o777, 0o600);
  await office.stop();

  office = await launch();
  await office.until('ready');
  assert.equal((await office.call('POST', {clear: true})).status, 202);
  await office.until('off');
  await office.stop();

  // Without the Pi CLI, the workbench installs the pinned version into the runtime folder.
  const runtime = path.join(dir, 'pi-runtime');
  const npm = path.join(dir, 'npm');
  await writeFile(
    npm,
    `#!/bin/sh\nset -e\nprefix="$3"\n[ "$8" = "@earendil-works/pi-coding-agent@1.5.2" ] || exit 3\n` +
      `mkdir -p "$prefix/node_modules/.bin"\ncp "${pi}" "$prefix/node_modules/.bin/pi"\n`
  );
  await chmod(npm, 0o755);
  const bare = {
    OFFICE_PI_BIN: undefined,
    OFFICE_PI_RUNTIME_DIR: runtime,
    OFFICE_NPM_BIN: npm,
    PATH: path.dirname(process.execPath) + ':/usr/bin:/bin'
  };
  office = await launch(bare);
  ({data} = await office.call());
  assert.equal(data.pi.version, null);
  assert.equal(data.install.package, '@earendil-works/pi-coding-agent@1.5.2');
  const installed = await fetch(office.origin + '/api/local/pi/install', {
    method: 'POST',
    headers: {'X-Agent-Office-Control': '1'}
  });
  assert.equal(installed.status, 202);
  for (let i = 0; i < 100 && data.install.state !== 'done'; i++) {
    await delay(100);
    ({data} = await office.call());
  }
  assert.equal(data.install.state, 'done');
  assert.equal(data.pi.version, '0.0.0-test');
  await office.stop();
  // The next start finds the installed CLI on its own.
  office = await launch(bare);
  ({data} = await office.call());
  assert.equal(data.pi.version, '0.0.0-test');
  await office.stop();
  // A failed install explains itself and can be retried.
  await writeFile(npm, '#!/bin/sh\necho "npm ERR! network request failed" >&2\nexit 1\n');
  office = await launch({...bare, OFFICE_PI_RUNTIME_DIR: path.join(dir, 'other-runtime')});
  await fetch(office.origin + '/api/local/pi/install', {method: 'POST', headers: {'X-Agent-Office-Control': '1'}});
  for (let i = 0; i < 100 && data.install.state !== 'failed'; i++) {
    await delay(100);
    ({data} = await office.call());
  }
  assert.equal(data.install.state, 'failed');
  assert.match(data.install.error, /network request failed/);
  await office.stop();

  // A model from .env.local stays in charge; the workbench only shows it.
  office = await launch({OFFICE_MODEL_URL: url, OFFICE_MODEL_ID: 'test-model'});
  data = await office.until('ready');
  assert.equal(data.source, 'env');
  assert.equal((await office.call('POST', {url, model: 'test-model'})).status, 409);
  await office.stop();
});
