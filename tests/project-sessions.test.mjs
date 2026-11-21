import {strict as assert} from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {openProjectSessions} from '../scripts/project-sessions.mjs';
import {projectOperation} from '../scripts/pi-documents.mjs';

async function temp(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'office-project-test-')));
  t.after(() => fs.rm(base, {recursive: true, force: true}));
  const root = path.join(base, 'project with spaces');
  await fs.mkdir(root);
  return {base, root, dir: path.join(base, 'office', 'projects')};
}
const request = (api, route, method = 'GET', value, headers = {}) =>
  api.fetch(
    new Request('http://127.0.0.1/api/studio/projects' + route, {
      method,
      headers: {'Content-Type': 'application/json', ...headers},
      ...(value !== undefined && {body: JSON.stringify(value)})
    })
  );
async function idle(api, id) {
  for (let i = 0; i < 150; i++) {
    const {session} = await (await request(api, '/' + id)).json();
    if (session.status === 'idle') return session;
    await delay(20);
  }
  throw new Error('Timed out waiting for Pi.');
}

test('project tool scopes paths, preserves permissions and derives diff from the actual pre-edit working copy', async t => {
  const {base, root} = await temp(t);
  const journal = path.join(base, 'journal');
  await fs.mkdir(journal);
  await fs.writeFile(path.join(root, 'run.sh'), '#!/bin/sh\n# preexisting working copy edit\necho old\n', {
    mode: 0o755
  });
  const tool = (operation, path, extra) => projectOperation({root, journal, operation, path, ...extra});
  assert.equal((await tool('read', 'run.sh', {startLine: 2})).text, '# preexisting working copy edit\necho old\n');
  assert.deepEqual(
    (await tool('search', '', {query: 'echo'})).matches.map(m => m.path),
    ['run.sh']
  );
  await tool('edit', 'run.sh', {oldText: 'echo old', newText: 'echo new'});
  await tool('edit', 'run.sh', {oldText: 'echo new', newText: 'echo final'});
  assert.equal((await fs.stat(path.join(root, 'run.sh'))).mode & 0o777, 0o755);
  await tool('write', 'docs/x.md', {text: 'A note\n'});
  await assert.rejects(tool('write', 'docs/x.md', {text: 'clobber'}), /已存在/);
  const {changes} = await tool('changes');
  assert.deepEqual(
    changes.map(c => [c.path, c.status]),
    [
      ['docs/x.md', 'added'],
      ['run.sh', 'modified']
    ]
  );
  assert.match(changes[1].diff, /-echo old\n\+echo final/);
  assert.doesNotMatch(changes[1].diff, /^[+-]# preexisting/m);
  await fs.writeFile(path.join(base, 'outside.txt'), 'secret');
  await fs.symlink(base, path.join(root, 'linked'));
  await fs.link(path.join(base, 'outside.txt'), path.join(root, 'hard'));
  for (const p of ['../outside.txt', '.git/config', 'linked/outside.txt', 'hard']) {
    await assert.rejects(tool('read', p));
    await assert.rejects(tool('edit', p, {oldText: 'secret', newText: 'bad'}));
  }
  assert.equal(await fs.readFile(path.join(base, 'outside.txt'), 'utf8'), 'secret');
  await assert.rejects(tool('list', '', {identity: '0:0'}), /已被更换/);
  await fs.writeFile(path.join(journal, 'closed'), '');
  await assert.rejects(tool('write', 'too-late', {text: 'late'}), /已经停止/);
});

test('local sessions are resumable, idempotent, cancellable and exclusive across overlapping project roots', async t => {
  const {base, root, dir} = await temp(t);
  const started = Promise.withResolvers();
  let calls = 0,
    generated = [];
  const generate = async (prompt, {signal, project}) => {
    generated.push(prompt);
    calls++;
    await projectOperation(
      {
        root: project.projectPath,
        journal: project.journal,
        identity: project.identity,
        operation: 'write',
        path: calls + '.txt',
        text: 'new ' + calls
      },
      {signal}
    );
    if (calls === 1) {
      started.resolve();
      await delay(10000, undefined, {signal});
    }
    return 'done';
  };
  const options = {dir, generate, localAvailable: () => true};
  const api = await openProjectSessions(options);
  t.after(() => api.close());
  assert.equal((await request(api, '', 'POST', {projectPath: root}, {Origin: 'https://remote.test'})).status, 403);
  assert.equal((await request(api, '', 'POST', {projectPath: base + '/missing'})).status, 400);
  assert.equal((await request(api, '', 'POST', {projectPath: base})).status, 400);
  const create = {projectPath: root, requestId: 'once', title: 'code'};
  const result = await request(api, '', 'POST', create);
  assert.equal(result.status, 201);
  const {
    session: {id}
  } = await result.json();
  assert.equal((await (await request(api, '', 'POST', create)).json()).session.id, id);
  const sub = path.join(root, 'sub');
  await fs.mkdir(sub);
  const {
    session: {id: subId}
  } = await (await request(api, '', 'POST', {projectPath: sub})).json();
  const first = {content: 'edit', requestId: 'msg-1'};
  assert.equal((await request(api, '/' + id + '/messages', 'POST', first)).status, 202);
  await started.promise;
  const running = (await (await request(api, '/' + id)).json()).session;
  assert.equal(running.turns[0].activity[0].operation, 'write');
  assert.equal((await request(api, '/' + id + '/messages', 'POST', first)).status, 200);
  assert.equal((await request(api, '/' + subId + '/messages', 'POST', first)).status, 409);
  assert.equal((await request(api, '/' + id + '/checks', 'POST', {command: 'npm test'})).status, 409);
  const stopped = (await (await request(api, '/' + id + '/stop', 'POST', {})).json()).session.turns[0];
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.changes[0].path, '1.txt');
  assert.equal(
    (await request(api, '/' + id + '/messages', 'POST', {content: 'follow up', requestId: 'msg-2'})).status,
    202
  );
  assert.equal((await idle(api, id)).turns[1].reply, 'done');
  assert.match(generated[1], /edit/);
  assert.match(generated[1], /1.txt/);
  assert.equal(calls, 2);
  await api.close();
  const reopened = await openProjectSessions(options);
  t.after(() => reopened.close());
  assert.equal((await (await request(reopened, '/' + id)).json()).session.turns.length, 2);
  assert.equal((await request(reopened, '/' + id + '/messages', 'POST', {...first, content: 'different'})).status, 409);
  await fs.rename(root, root + '-old');
  await fs.mkdir(root);
  assert.equal(
    (await request(reopened, '/' + id + '/messages', 'POST', {content: 'do not write', requestId: 'new'})).status,
    409
  );
});

test('restart seals an interrupted run, recovers its real changes and keeps the next Pi from replaying it', async t => {
  const {dir, root} = await temp(t);
  const opts = {
    dir,
    localAvailable: () => false,
    generate: () => {
      throw new Error('unexpected invocation');
    }
  };
  const api = await openProjectSessions(opts);
  const {
    session: {id}
  } = await (await request(api, '', 'POST', {projectPath: root})).json();
  await api.close();
  const file = path.join(dir, id + '.json');
  const s = JSON.parse(await fs.readFile(file, 'utf8'));
  const turn = {
    id: crypto.randomUUID(),
    requestId: 'interrupted',
    prompt: 'edit',
    status: 'running',
    reply: '',
    error: '',
    startedAt: s.updatedAt,
    finishedAt: null,
    activity: [],
    changes: []
  };
  const journal = path.join(dir, 'run-' + turn.id);
  await fs.mkdir(journal);
  s.status = 'running';
  s.turns = [turn];
  await fs.writeFile(file, JSON.stringify(s));
  await projectOperation({
    root,
    identity: s.identity,
    journal,
    operation: 'write',
    path: 'saved.txt',
    text: 'already saved\n'
  });
  const recovered = await openProjectSessions(opts);
  t.after(() => recovered.close());
  const {session} = await (await request(recovered, '/' + id)).json();
  assert.equal(session.status, 'idle');
  assert.equal(session.turns[0].status, 'stopped');
  assert.match(session.turns[0].changes[0].diff, /\+already saved/);
  const replay = await request(recovered, '/' + id + '/messages', 'POST', {requestId: 'interrupted', content: 'edit'});
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).session.turns.length, 1);
});
