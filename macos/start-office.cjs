'use strict';
const fs = require('node:fs/promises');
const {createHash} = require('node:crypto');
const {spawn, execFile} = require('node:child_process');
const {promisify, parseEnv} = require('node:util');
const {homedir} = require('node:os');
const path = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');
const run = promisify(execFile);
const build = require('./build.json');

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return false;
  }
}

async function materialize(support) {
  const dir = path.join(support, 'Runtime');
  await fs.mkdir(dir, {recursive: true, mode: 0o700});
  const dest = path.join(dir, build.runtimeSHA256);
  if (await exists(path.join(dest, 'ready'))) return dest;
  const zip = path.join(__dirname, 'runtime.zip');
  const digest = createHash('sha256')
    .update(await fs.readFile(zip))
    .digest('hex');
  if (digest !== build.runtimeSHA256) throw Error('应用内的运行包校验失败，请重新下载。');
  const work = await fs.mkdtemp(path.join(dir, 'install-'));
  try {
    await run('/usr/bin/ditto', ['-x', '-k', zip, work], {timeout: 20000});
    await fs.writeFile(path.join(work, 'ready'), build.runtimeSHA256, {mode: 0o600});
    try {
      await fs.rename(work, dest);
    } catch (e) {
      if (!['ENOTEMPTY', 'EEXIST'].includes(e.code) || !(await exists(path.join(dest, 'ready')))) throw e;
    }
  } finally {
    await fs.rm(work, {recursive: true, force: true});
  }
  return dest;
}

async function health(base, identity) {
  let r;
  try {
    r = await fetch(base + '/api/local-mode', {redirect: 'manual', signal: AbortSignal.timeout(1000)});
  } catch {
    return false;
  }
  const info = await r.json().catch(() => null);
  if (!r.ok || info?.mode !== 'local' || info?.studio !== true || info?.fileTools !== true)
    throw Error('工作台端口已被其他服务占用，请检查 OFFICE_PORT。');
  if (info.desktopRuntime !== identity)
    throw Error('这个端口已有另一个办公室或版本在运行。请等当前任务完成，停止原办公室服务，再点「重试」。');
  return true;
}

async function launchOffice({
  project = build.configuredProject,
  support = path.join(homedir(), 'Library', 'Application Support', 'Agent Office')
} = {}) {
  if (project && !(await exists(project)))
    throw Error('找不到原来的办公室项目：' + project + '。请恢复该目录，或重新打包选择新的办公室。');
  const configRoot = project || support;
  const conf = path.join(configRoot, '.env.local');
  const fileSettings = (await exists(conf)) ? parseEnv(await fs.readFile(conf, 'utf8')) : {};
  const env = {...process.env};
  for (const [k, v] of Object.entries(fileSettings))
    if ((k.startsWith('OFFICE_') || k === 'CHROMIUM_EXECUTABLE_PATH') && !(k in env)) env[k] = v;
  for (const k of ['AGENT_OFFICE_TOKEN', 'HERMES_SITE_ACCESS_TOKEN', 'OFFICE_REMOTE_ORIGIN']) delete env[k];
  const port = Number(env.OFFICE_PORT || 3080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('本机 OFFICE_PORT 需要是有效的固定端口。');
  const base = 'http://127.0.0.1:' + port;
  env.OFFICE_PORT = String(port);
  env.OFFICE_DATA_DIR = env.OFFICE_DATA_DIR
    ? path.resolve(configRoot, env.OFFICE_DATA_DIR)
    : project
      ? path.join(project, '.office-local', 'pi', 'office')
      : path.join(support, 'Office');
  await fs.mkdir(env.OFFICE_DATA_DIR, {recursive: true, mode: 0o700});
  const identity = createHash('sha256')
    .update(build.runtimeSHA256)
    .update('\0')
    .update(await fs.realpath(env.OFFICE_DATA_DIR))
    .digest('hex');
  env.OFFICE_DESKTOP_RUNTIME = identity;
  if (await health(base, identity)) return {url: base + '/'};
  await fs.mkdir(support, {recursive: true, mode: 0o700});
  const runtime = await materialize(support);
  if (env.OFFICE_MODEL_FILE) env.OFFICE_MODEL_FILE = path.resolve(configRoot, env.OFFICE_MODEL_FILE);
  for (const key of ['OFFICE_PI_BIN', 'OFFICE_LLAMA_BIN', 'CHROMIUM_EXECUTABLE_PATH']) {
    if (env[key]?.includes('/')) env[key] = path.resolve(configRoot, env[key]);
  }
  const pi = path.join(configRoot, '.office-local', 'pi-runtime', 'node_modules', '.bin', 'pi');
  if (!env.OFFICE_PI_BIN && (await exists(pi))) env.OFFICE_PI_BIN = pi;
  env.PATH = [path.dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', env.PATH || '/usr/bin:/bin'].join(
    ':'
  );
  env.OFFICE_OPEN = '0';
  const log = await fs.open(path.join(support, 'office.log'), 'a', 0o600);
  let child;
  try {
    child = spawn(process.execPath, [path.join(runtime, 'scripts', 'local.mjs')], {
      cwd: runtime,
      env,
      detached: true,
      stdio: ['ignore', log.fd, log.fd]
    });
  } finally {
    await log.close();
  }
  let failed = false;
  child.on('error', () => {
    failed = true;
  });
  child.unref();
  const end = Date.now() + 30000;
  try {
    do {
      if (await health(base, identity)) return {url: base + '/', startedPid: child.pid};
      if (failed || child.exitCode !== null || child.signalCode !== null) break;
      await delay(300);
    } while (Date.now() < end);
    throw Error('办公室未能启动。详情见 ~/Library/Application Support/Agent Office/office.log。');
  } catch (error) {
    child.kill('SIGTERM');
    throw error;
  }
}
module.exports = {launchOffice};
if (require.main === module)
  launchOffice().then(
    v => console.log(v.url),
    e => {
      console.error(e.message);
      process.exitCode = 1;
    }
  );
