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

test('API project runs use the selected connection and room instructions, retain ownership, and only edit scoped files', async t => {
  const {dir, root} = await temp(t);
  const {generateApiProject} = await import('../scripts/studio-provider.mjs');
  const member = {
    id: 'api-editor',
    kind: 'api',
    name: '修订员',
    instructions: '每次只改一个文件',
    enabled: true,
    available: true,
    connection: {
      baseUrl: 'https://model.example/v1',
      model: 'project-model',
      apiKey: 'fixture-local-only',
      name: '测试连接'
    }
  };
  const calls = [];
  const send = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    assert.equal(url, 'https://model.example/v1/chat/completions');
    assert.deepEqual(
      body.tools.map(t => t.function.name),
      ['office_project']
    );
    const message =
      calls.length === 1
        ? {
            role: 'assistant',
            tool_calls: [
              {
                id: 'first',
                type: 'function',
                function: {
                  name: 'office_project',
                  arguments: JSON.stringify({operation: 'write', path: 'hello.md', text: 'Hello from API'})
                }
              }
            ]
          }
        : {role: 'assistant', content: '已写入 hello.md'};
    return Response.json({choices: [{message}]});
  };
  const options = {
    dir,
    localAvailable: () => false,
    resolveMember: id => (id === member.id ? member : null),
    generate: (prompt, {member, signal, project}) =>
      generateApiProject(member.connection, prompt, {instructions: member.instructions, signal, project, send})
  };
  const api = await openProjectSessions(options);
  t.after(() => api.close());
  const {session} = await (await request(api, '', 'POST', {projectPath: root, agentId: member.id})).json();
  const sent = await request(api, '/' + session.id + '/messages', 'POST', {
    content: '写一行文字',
    requestId: 'api-turn'
  });
  assert.equal(sent.status, 202);
  const final = await idle(api, session.id);
  assert.equal(final.agentId, 'api-editor');
  assert.equal(final.turns[0].agentName, '修订员');
  assert.equal(await fs.readFile(path.join(root, 'hello.md'), 'utf8'), 'Hello from API');
  assert.match(final.turns[0].changes[0].diff, /\+Hello from API/);
  assert.equal(calls[0].model, 'project-model');
  assert.match(calls[0].messages[0].content, /每次只改一个文件/);
  assert.equal(calls[1].messages.at(-1).tool_call_id, 'first');
  const index = await (await request(api, '?agentId=api-editor')).json();
  assert.equal(index.sessions.length, 1);
  assert.equal(index.member.modelLabel, '测试连接');
  assert.ok(!JSON.stringify(index).includes('fixture-local-only'));
  const other = await (await request(api, '?agentId=pi-local')).json();
  assert.deepEqual(other.sessions, []);
  member.enabled = false;
  assert.equal(
    (await request(api, '/' + session.id + '/messages', 'POST', {content: '再改一个文件', requestId: 'disabled'}))
      .status,
    409
  );
});

test('an external project can be claimed through MCP, report a real step, survive office restart, and return its own result', async t => {
  const {dir, root} = await temp(t);
  const {MemoryBucket} = await import('./memory-bucket.mjs');
  const {callTool} = await import('../worker/index.js');
  const env = {BUCKET: new MemoryBucket(), OFFICE_LOCAL: true, PI_OFFICE: true};
  const officeCall = (tool, args) => callTool(tool, args, env);
  const agentId = 'external-editor';
  await officeCall('office_register_agent', {agent_id: agentId, name: '外部编辑', role: '编辑', model: 'Codex'});
  const options = {
    dir,
    localAvailable: () => false,
    officeCall,
    resolveMember: id =>
      id === agentId ? {id: agentId, kind: 'external', enabled: true, available: true, name: '外部编辑'} : null,
    generate: () => assert.fail('must never run the external agent as Pi')
  };
  let api = await openProjectSessions(options);
  env.OFFICE_PROJECT_BRIEF = (id, member) => api.briefForTask(id, member);
  t.after(() => api.close());
  const {session} = await (await request(api, '', 'POST', {agentId, projectPath: root, title: '外部项目'})).json();
  const prompt = '请检查这个项目的 README。'.repeat(60);
  const {session: started} = await (
    await request(api, '/' + session.id + '/messages', 'POST', {content: prompt, requestId: 'external-turn'})
  ).json();
  assert.equal(started.turns[0].dispatchStatus, 'queued');
  const {task, project} = await officeCall('office_claim_task', {agent_id: agentId});
  assert.equal(project.directory, root);
  assert.equal(project.request, prompt);
  assert.equal(api.briefForTask(task.id, 'different-agent'), null);
  await officeCall('office_report_step', {
    agent_id: agentId,
    task_id: task.id,
    request_id: 'started',
    title: '阅读 README.md',
    status: 'started'
  });
  let index = await (await request(api, '')).json();
  assert.equal(index.sessions[0].progress.path, '阅读 README.md');
  assert.equal(index.sessions[0].progress.step, 1);
  await api.close();
  api = await openProjectSessions(options);
  assert.equal((await officeCall('office_list_tasks', {agent_id: agentId})).tasks.length, 1);
  await officeCall('office_update_task', {
    agent_id: agentId,
    task_id: task.id,
    status: 'done',
    result: '检查完成，安装命令有效。'
  });
  const {session: finished} = await (await request(api, '/' + session.id)).json();
  assert.equal(finished.status, 'idle');
  assert.equal(finished.turns[0].reply, '检查完成，安装命令有效。');
  assert.deepEqual(finished.turns[0].changes, []);
  await request(api, '/' + session.id + '/messages', 'POST', {content: '下一项', requestId: 'next'});
  await api.stopAgent(agentId);
  index = await (await request(api, '')).json();
  assert.equal(index.sessions[0].progress, null);
  const {tasks} = await officeCall('office_list_tasks', {agent_id: agentId});
  assert.equal(tasks.find(t => t.status !== 'done')?.status, 'paused');
});
