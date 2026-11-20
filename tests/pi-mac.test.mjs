import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {operateMac} from '../scripts/pi-mac.mjs';
import {writeDocumentFile, readDocumentFile} from '../scripts/pi-documents.mjs';

async function seat(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'office-mac-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const name = '本机工具验收.txt';
  await writeDocumentFile(root, name, Buffer.from('第一行'));
  return {root, name};
}

test('native actions target only the validated workspace file and pass text as JSON', async t => {
  const {root, name} = await seat(t);
  const calls = [];
  const run = async (command, args, input) => {
    calls.push({command, args, input});
    return '{"status":"saved"}';
  };
  const file = path.join(await fs.realpath(root), name);
  await operateMac(root, {action: 'open_text', path: name}, {platform: 'darwin', run});
  assert.deepEqual(calls.pop(), {command: '/usr/bin/open', args: ['-g', '-b', 'com.apple.TextEdit', file], input: ''});
  const text = '\n第二行 "$();"\n中文';
  assert.deepEqual(await operateMac(root, {action: 'append_text', path: name, text}, {platform: 'darwin', run}), {
    status: 'saved',
    path: name
  });
  const save = calls.pop();
  assert.equal(save.command, '/usr/bin/osascript');
  assert.deepEqual(save.args.slice(0, 2), ['-l', 'JavaScript']);
  assert.deepEqual(JSON.parse(save.input), {action: 'append_text', file, text});
  await operateMac(root, {action: 'reveal', path: name}, {platform: 'darwin', run});
  assert.deepEqual(calls.pop(), {command: '/usr/bin/open', args: ['-R', file], input: ''});
  await assert.rejects(operateMac(root, {action: 'preview', path: name}, {platform: 'darwin', run}), /PDF/);
  await assert.rejects(operateMac(root, {action: 'open_text', path: '../nope'}, {platform: 'darwin', run}));
  await assert.rejects(operateMac(root, {action: 'read_text', path: name}, {platform: 'linux', run}), /macOS/);
  assert.equal(calls.length, 0);
});

if (process.platform === 'darwin' && process.env.OFFICE_TEST_MAC_GUI === '1') {
  test('macOS GUI opens a fixture in TextEdit, saves an append and reads its exact buffer', async t => {
    const {root, name} = await seat(t);
    const cmd = (action, fields = {}) => operateMac(root, {action, path: name, ...fields});
    assert.equal((await cmd('open_text')).status, 'opened');
    const contents = await cmd('read_text');
    assert.equal(contents.text, '第一行');
    await cmd('append_line', {text: '已保存'});
    assert.equal((await cmd('read_text')).text, '第一行\n已保存');
    assert.equal((await readDocumentFile(root, name)).toString(), '第一行\n已保存');
  });
  test('macOS GUI asks Preview to open a fixture image', async t => {
    const {root} = await seat(t);
    const filename = '本机工具验收.png';
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',
      'base64'
    );
    await writeDocumentFile(root, filename, png);
    assert.equal((await operateMac(root, {action: 'preview', path: filename})).status, 'opened');
  });
  test('macOS GUI asks Finder to reveal a fixture', async t => {
    const {root, name} = await seat(t);
    assert.equal((await operateMac(root, {action: 'reveal', path: name})).status, 'opened');
  });
}
