import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {open, realpath} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {stripVTControlCharacters} from 'node:util';

const command = 'npm test';
const maxOutput = 24000;
const json = (data, status = 200) => Response.json(data, {status, headers: {'Cache-Control': 'no-store'}});
const normalized = p => (process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p);
function overlaps(a, b) {
  const [left, right] = [normalized(a), normalized(b)];
  return left === right || left.startsWith(right + path.sep) || right.startsWith(left + path.sep);
}

async function testScript(projectPath) {
  let file;
  try {
    if ((await realpath(projectPath)) !== projectPath) return '';
    file = await open(
      path.join(projectPath, 'package.json'),
      constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | constants.O_NONBLOCK
    );
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024) return '';
    const script = JSON.parse(await file.readFile('utf8')).scripts?.test;
    return typeof script === 'string' ? script.trim().slice(0, 400) : '';
  } catch {
    return '';
  } finally {
    await file?.close();
  }
}

async function readCommand(request) {
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json' || !request.body) return null;
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 128) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

// This runner only accepts the user's explicit test action. Pi has no tool for invoking it.
export function createProjectChecks({timeout = 120000} = {}) {
  const records = new Map();
  let closed = false;
  function isRunning(projectPath) {
    return [...records.values()].some(r => r.run.status === 'running' && overlaps(r.path, projectPath));
  }
  function start(projectPath, sessionId) {
    const run = {status: 'running', output: '', exitCode: null, startedAt: new Date().toISOString(), finishedAt: null};
    const environment = {
      PATH: [path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter),
      HOME: os.homedir(),
      TMPDIR: os.tmpdir(),
      LANG: process.env.LANG || 'en_US.UTF-8',
      CI: '1',
      NO_COLOR: '1',
      npm_config_offline: 'true',
      npm_config_update_notifier: 'false'
    };
    const windows = process.platform === 'win32';
    if (windows) {
      environment.SystemRoot = process.env.SystemRoot;
      environment.USERPROFILE = os.homedir();
    }
    const child = spawn(
      windows ? process.execPath : 'npm',
      windows ? [path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), 'test'] : ['test'],
      {
        cwd: projectPath,
        env: environment,
        detached: !windows,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      }
    );
    let reason = '',
      force;
    function append(chunk) {
      run.output = (run.output + stripVTControlCharacters(chunk)).slice(-maxOutput);
    }
    child.stdout.setEncoding('utf8').on('data', append);
    child.stderr.setEncoding('utf8').on('data', append);
    function signal(name) {
      if (!child.pid) return;
      try {
        if (windows) child.kill(name);
        else process.kill(-child.pid, name);
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
    function stop(why = 'stopped') {
      if (reason || run.status !== 'running') return;
      reason = why;
      signal('SIGTERM');
      force = setTimeout(() => signal('SIGKILL'), 1000).unref();
    }
    const timer = setTimeout(() => stop('timeout'), timeout).unref();
    const done = new Promise(resolve => {
      child.once('error', error => append('\n无法启动 npm 测试（' + error.code + '）。'));
      child.once('close', code => {
        clearTimeout(timer);
        // A test may leave descendants holding no pipes. Stop the whole group on explicit cancellation.
        if (reason) signal('SIGKILL');
        clearTimeout(force);
        if (reason === 'timeout') append('\n测试超时，已停止。');
        run.status = reason === 'stopped' ? 'stopped' : !reason && code === 0 ? 'passed' : 'failed';
        run.exitCode = code;
        run.finishedAt = new Date().toISOString();
        resolve();
      });
    });
    records.delete(sessionId);
    if (records.size >= 64) {
      const oldest = [...records].find(([, record]) => record.run.status !== 'running');
      if (oldest) records.delete(oldest[0]);
    }
    records.set(sessionId, {path: projectPath, run, stop, done});
    return run;
  }
  return {
    isRunning,
    runFor: id => records.get(id)?.run,
    async fetch(request, session) {
      const {id, projectPath, status} = session;
      const stop = new URL(request.url).pathname.endsWith('/stop');
      if (closed) return json({error: '工作台正在关闭。'}, 503);
      if (!['GET', 'POST'].includes(request.method) || (stop && request.method !== 'POST'))
        return json({error: '不支持该操作。'}, 405);
      const record = records.get(id);
      if (stop) {
        if (record?.run.status === 'running') record.stop();
        return json({available: !!record, run: record?.run ?? null});
      }
      const script = await testScript(projectPath);
      if (request.method === 'GET') return json({available: !!script, script, run: record?.run ?? null});
      const fields = await readCommand(request);
      if (fields?.command !== command) return json({error: '请选择 npm test。'}, 400);
      if (!script) return json({error: '项目的 package.json 中没有可运行的 test 脚本。'}, 409);
      if (closed || status === 'running' || isRunning(projectPath))
        return json({error: '这个项目还有工作在运行，结束后可以测试。'}, 409);
      return json({available: true, script, run: start(projectPath, id)}, 202);
    },
    async close() {
      closed = true;
      for (const r of records.values()) r.stop();
      await Promise.all([...records.values()].map(r => r.done));
    }
  };
}
