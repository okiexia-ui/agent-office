import {strict as assert} from 'node:assert';
import {mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {preparePiModel} from '../scripts/pi-model.mjs';

async function setup(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'pi-model-test-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  return dir;
}

test('uses an explicitly selected model on a local endpoint and cleans up isolated settings', async t => {
  const runtimeDir = await setup(t);
  t.mock.method(globalThis, 'fetch', async (url, {redirect}) => {
    assert.equal(url, 'http://127.0.0.1:16789/v1/models');
    assert.equal(redirect, 'error');
    return Response.json({data: [{id: 'my-model'}]});
  });
  const result = await preparePiModel({
    env: {OFFICE_MODEL_URL: 'http://127.0.0.1:16789', OFFICE_MODEL_ID: 'my-model'},
    runtimeDir
  });
  assert.equal(result.modelName, 'my-model');
  const dir = result.env.PI_CODING_AGENT_DIR;
  t.after(result.close);
  const {providers} = JSON.parse(await readFile(path.join(dir, 'models.json')));
  const config = providers[result.env.OFFICE_PI_PROVIDER];
  assert.equal(config.models[0].id, result.env.OFFICE_PI_MODEL);
  assert.equal(config.baseUrl, 'http://127.0.0.1:16789/v1');
  assert.equal(config.models[0].maxTokens, 1024);
  await Promise.all([result.close(), result.close()]);
  await assert.rejects(stat(dir), {code: 'ENOENT'});
});

test('rejects unexpected services and returns startup errors from the model process', async t => {
  const runtimeDir = await setup(t);
  const prepare = env => preparePiModel({runtimeDir, env});
  await assert.rejects(prepare({}), /OFFICE_MODEL_FILE/);
  await assert.rejects(prepare({OFFICE_MODEL_URL: 'https://provider.example/v1'}), /回环/);
  t.mock.method(globalThis, 'fetch', async () => Response.json({data: [{id: 'other-model'}]}));
  await assert.rejects(prepare({OFFICE_MODEL_URL: 'http://localhost/v1', OFFICE_MODEL_ID: 'missing'}), /未列出/);
  const file = path.join(runtimeDir, 'example.gguf');
  await writeFile(file, '');
  await assert.rejects(prepare({OFFICE_MODEL_FILE: file, OFFICE_LLAMA_BIN: file + '-missing'}), /ENOENT/);
});

test('managed inference authenticates Pi and readiness probes with the same private per-run key', async t => {
  const runtimeDir = await setup(t);
  const file = path.join(runtimeDir, 'test.gguf');
  const binary = path.join(runtimeDir, 'mock-llama.mjs');
  const capture = path.join(runtimeDir, 'observed.json');
  await writeFile(file, '');
  await writeFile(
    binary,
    `#!/usr/bin/env node
    import {writeFileSync} from 'node:fs';
    const args = process.argv.slice(2);
    const key = process.env.LLAMA_API_KEY;
    writeFileSync(process.env.CAPTURE, JSON.stringify({
      alias: args[args.indexOf('--alias') + 1], key,
      private: !args.includes(key) && args.includes('--log-disable') && !process.env.LLAMA_ARG_LOG_FILE
    }));
    setInterval(() => {}, 1000);`,
    {mode: 0o700}
  );
  let authenticated;
  t.mock.method(globalThis, 'fetch', async (url, {headers}) => {
    const child = JSON.parse(await readFile(capture));
    authenticated = child.private && headers.Authorization === 'Bearer ' + child.key;
    return Response.json({data: [{id: child.alias}]});
  });
  const result = await preparePiModel({
    env: {
      PATH: process.env.PATH,
      OFFICE_MODEL_FILE: file,
      OFFICE_LLAMA_BIN: binary,
      CAPTURE: capture,
      LLAMA_ARG_LOG_FILE: 'ignored'
    },
    runtimeDir
  });
  t.after(result.close);
  assert.equal(authenticated, true);
  const configPath = path.join(result.env.PI_CODING_AGENT_DIR, 'models.json');
  const {providers} = JSON.parse(await readFile(configPath));
  const {key} = JSON.parse(await readFile(capture));
  assert.match(key, /^[\da-f]{64}$/);
  assert.ok(providers[result.env.OFFICE_PI_PROVIDER].apiKey === key);
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  await result.close();
  assert.ok(result.stopped.aborted);
});
