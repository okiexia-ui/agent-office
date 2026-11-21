import {strict as assert} from 'node:assert';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {preflightPi, generatePi} from '../scripts/pi-process.mjs';

async function fakePi(t, source) {
  const dir = await mkdtemp(path.join(tmpdir(), 'office-pi-test-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const bin = path.join(dir, 'pi executable.mjs');
  await writeFile(bin, '#!/usr/bin/env node\n' + source, {mode: 0o700});
  return {PATH: process.env.PATH, OFFICE_PI_BIN: bin};
}

test('Pi print receives office content on stdin, with remote credentials and tools excluded', async t => {
  const env = await fakePi(
    t,
    `import {text} from 'node:stream/consumers';
     if (process.argv.includes('--version')) console.log('1.5.1');
     else console.log(JSON.stringify({args: process.argv.slice(2), input: await text(process.stdin),
       hasToken: !!(process.env.AGENT_OFFICE_TOKEN || process.env.HERMES_SITE_ACCESS_TOKEN)}));`
  );
  Object.assign(env, {AGENT_OFFICE_TOKEN: 'test', HERMES_SITE_ACCESS_TOKEN: 'test', OFFICE_PI_READ_TOOLS: ''});
  const prompt = '@file --model example\n$(echo hello)';
  assert.equal(await preflightPi({env}), '1.5.1');
  const result = JSON.parse(await generatePi(prompt, {env, instructions: '/etc/passwd'}));
  const instructionIndex = result.args.indexOf('--append-system-prompt');
  assert.ok(instructionIndex >= 0);
  assert.equal(result.args[instructionIndex + 1], '办公室角色指令：\n/etc/passwd');
  assert.equal(result.input, prompt);
  assert.equal(result.hasToken, false);
  assert.ok(result.args.includes('--no-tools'));
  assert.ok(result.args.includes('--no-context-files'));
  assert.ok(result.args.includes('--no-extensions'));
  assert.ok(!result.args.includes(prompt));
  Object.assign(env, {OFFICE_PI_READ_TOOLS: '1', OFFICE_PI_PROVIDER: 'local', OFFICE_PI_MODEL: 'small'});
  const {args} = JSON.parse(await generatePi(prompt, {env}));
  assert.deepEqual(args.slice(-6), ['--tools', 'read,grep,find,ls', '--provider', 'local', '--model', 'small']);
  const restricted = JSON.parse(await generatePi(prompt, {env, allowHostRead: false}));
  assert.ok(restricted.args.includes('--no-tools'));
  assert.ok(restricted.args.includes('--no-mcp'));
  const personal = JSON.parse(
    await generatePi(prompt, {env, allowHostRead: false, workspace: '/private/tmp/pi-test', nativeApps: true})
  );
  assert.ok(personal.args.includes('--extension'));
  assert.equal(
    personal.args[personal.args.indexOf('--tools') + 1],
    'office_document,office_browser' + (process.platform === 'darwin' ? ',office_mac' : '')
  );
});

test('Pi handles missing executables, time limits and cancellation', async t => {
  const env = await fakePi(t, 'setInterval(() => {}, 1000);');
  await assert.rejects(generatePi('slow', {env, timeout: 100}), /超时/);
  const controller = new AbortController();
  const running = generatePi('slow', {env, signal: controller.signal});
  controller.abort();
  await assert.rejects(running, {name: 'AbortError'});
  await assert.rejects(preflightPi({env: {...env, OFFICE_PI_BIN: env.OFFICE_PI_BIN + '-missing'}}), /找不到 Pi/);
});

test('Office chats run Pi in an empty temporary folder, so local folder names never reach the model', async t => {
  const env = await fakePi(
    t,
    `import {readdirSync} from 'node:fs';
     console.log(JSON.stringify({cwd: process.cwd(), entries: readdirSync('.')}));`
  );
  env.OFFICE_PI_READ_TOOLS = '';
  const first = JSON.parse(await generatePi('你好', {env}));
  assert.notEqual(first.cwd, process.cwd());
  assert.match(path.basename(first.cwd), /^office-pi-/);
  assert.deepEqual(first.entries, []);
  // The opt-in host read tools resolve paths from the real working directory.
  env.OFFICE_PI_READ_TOOLS = '1';
  const reading = JSON.parse(await generatePi('你好', {env}));
  assert.equal(reading.cwd, process.cwd());
});
