// One foreground process owns the office server, Pi inbox loop and optional GGUF server.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile, spawn} from 'node:child_process';
import {parseEnv} from 'node:util';
import lockfile from 'proper-lockfile';
import {startOfficeServer} from './dev.mjs';
import {preflightPi, generatePi} from './pi-process.mjs';
import {preparePiModel} from './pi-model.mjs';
import {runOfficePi} from './pi-office.mjs';
import {openAgentStudio} from './agent-studio.mjs';
import {openProjectSessions} from './project-sessions.mjs';
import {generateApi, generateApiProject} from './studio-provider.mjs';
import {createPiFiles} from './pi-files.mjs';
import {
  PiSetupError,
  detectServices,
  findGgufFiles,
  findLlamaServer,
  piSettingsEnv,
  readPiSettings,
  validatePiSettings,
  writePiSettings
} from './pi-setup.mjs';

const root = path.resolve(import.meta.dirname, '..');

// The local edition needs Node.js 22.19 or newer; the optional Pi CLI requires it too.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 19)) {
  console.error(
    `Agent Office 本地版需要 Node.js 22.19 或更新版本，当前是 ${process.versions.node}。\n` +
      '请从 https://nodejs.org 安装长期支持版（LTS），或在终端运行 brew install node，然后重新启动。'
  );
  process.exit(1);
}

// --env-file=<path> loads settings such as OFFICE_PORT or OFFICE_MODEL_FILE (npm run local
// passes .env.local). Variables already set in the environment take precedence.
const envFile = process.argv.find(arg => arg.startsWith('--env-file='))?.slice('--env-file='.length);
if (envFile) {
  const text = await fs.readFile(path.resolve(root, envFile), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  for (const [name, value] of Object.entries(parseEnv(text))) if (!(name in process.env)) process.env[name] = value;
}
// --open shows the workspace in the default browser once it is ready.
const openWhenReady = process.argv.includes('--open') && process.env.OFFICE_OPEN !== '0';
function openBrowser(url) {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  spawn(command, args, {stdio: 'ignore', detached: true})
    .on('error', () => console.log('请在浏览器中打开 ' + url))
    .unref();
}

const runtimeDir = path.join(root, '.office-local', 'pi');
const stateDir = path.resolve(process.env.OFFICE_DATA_DIR || path.join(runtimeDir, 'office'));
const env = {...process.env, OFFICE_PI_LOCAL: '1'};
const shared = process.argv.includes('--shared');
if (shared && !env.OFFICE_REMOTE_ORIGIN)
  throw new Error('共享模式需要设置 OFFICE_REMOTE_ORIGIN 和 AGENT_OFFICE_TOKEN。');
if (!shared) {
  delete env.OFFICE_REMOTE_ORIGIN;
  delete env.AGENT_OFFICE_TOKEN;
}
// Where `npm run pi:install` (or the workbench's install button) puts the Pi CLI. The Mac app
// points this at its configured office so an install survives app updates.
const piRuntimeDir = path.resolve(env.OFFICE_PI_RUNTIME_DIR || path.join(root, '.office-local', 'pi-runtime'));
const piRuntimeBin = path.join(piRuntimeDir, 'node_modules', '.bin', 'pi');
if (!env.OFFICE_PI_BIN) {
  const bundled = piRuntimeBin;
  env.OFFICE_PI_BIN = (await fs.access(bundled).then(
    () => true,
    () => false
  ))
    ? bundled
    : 'pi';
}

// Pi's model comes from .env.local (fixed while running) or from settings saved in the workbench.
const piSettingsFile = path.join(stateDir, 'studio', 'pi-model.json');
const envModel = Boolean(env.OFFICE_MODEL_FILE || env.OFFICE_MODEL_URL);
let piSettings = envModel || shared ? null : await readPiSettings(piSettingsFile);

const controller = new AbortController();
const {signal} = controller;
for (const name of ['SIGTERM', 'SIGINT']) process.once(name, () => controller.abort());

function mcpClient(url) {
  let requestId = 0;
  return async (method, params = {}) => {
    const id = ++requestId;
    const r = await fetch(url + '/mcp', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      headers: {'Content-Type': 'application/json', Accept: 'application/json'},
      body: JSON.stringify({jsonrpc: '2.0', id, method, params})
    });
    if (!r.ok) throw new Error('办公室 MCP 连接失败，HTTP ' + r.status);
    const data = await r.json();
    if (data.id !== id || !data.result || data.result.isError)
      throw new Error(data.error?.message || data.result?.content?.[0]?.text || '办公室 MCP 返回无效结果。');
    return data.result;
  };
}

let office,
  model,
  studio,
  projects,
  files,
  stopPi,
  unlock,
  call,
  modelTypes,
  guardTaskUpdates,
  guardVisualTasks,
  visualsEnabled,
  reportVisualSteps;
const localAvailable = () => Boolean(model && !model.stopped?.aborted && !signal.aborted);
// What the workbench shows about the local model: 'starting' while a configured model
// loads, 'ready', 'failed' (with the reason), 'stopped', or 'off' when none is configured.
const piConfigured = () => Boolean(envModel || piSettings || shared);
let piFailure = '';
const localStatus = () => {
  if (localAvailable()) return {state: 'ready'};
  if (!piConfigured()) return {state: 'off'};
  if (piFailure) return {state: 'failed', error: piFailure};
  return {state: model ? 'stopped' : 'starting'};
};

// Work that would be cut short if the office stopped now: running workbench tasks and
// office tasks in progress for members this process runs (Pi and studio agents).
async function runningWork(origin) {
  let tasks = 0,
    sessions = 0;
  if (projects) {
    const list = await (await projects.fetch(new Request(origin + '/api/studio/projects'))).json();
    sessions = (list.sessions || []).filter(s => s.status === 'running' || s.progress?.operation === 'test').length;
  }
  if (call) {
    const {tasks: active = []} = await call('office_list_tasks', {status: 'active'});
    tasks = active.filter(t => t.agentId === 'pi-local' || String(t.agentId).startsWith('agent-')).length;
  }
  return {running: sessions + tasks, sessions, tasks};
}
// /api/local/* lets the Mac app ask what is still running and stop this office (and the
// local model) when it quits. The server already rejects other origins; the custom
// header also forces a CORS preflight, so no web page can trigger these.
async function desktopControl(request) {
  const url = new URL(request.url);
  if (request.headers.get('x-agent-office-control') !== '1')
    return Response.json({error: '缺少本机控制请求头。'}, {status: 403});
  if (url.pathname === '/api/local/activity' && request.method === 'GET')
    return Response.json(await runningWork(url.origin), {headers: {'Cache-Control': 'no-store'}});
  if (url.pathname === '/api/local/pi' && request.method === 'GET')
    return Response.json(await piSetup(), {headers: {'Cache-Control': 'no-store'}});
  if (url.pathname === '/api/local/pi' && request.method === 'POST') return savePiSetup(request);
  if (url.pathname === '/api/local/pi/install' && request.method === 'POST') {
    if (shared) return Response.json({error: '共享办公室不能在这里安装。'}, {status: 409});
    installPi();
    return Response.json({install: piInstall}, {status: 202});
  }
  if (url.pathname === '/api/local/shutdown' && request.method === 'POST') {
    console.log('收到停止请求，正在关闭办公室和本机模型…');
    setTimeout(() => controller.abort(), 50);
    return Response.json({stopping: true}, {status: 202});
  }
  return Response.json({error: 'Not found.'}, {status: 404});
}

// The variables Pi runs with: .env.local first, otherwise the saved workbench settings.
async function piEnv() {
  const merged = {...env, ...(envModel ? {} : piSettingsEnv(piSettings))};
  if (merged.OFFICE_MODEL_FILE && !merged.OFFICE_LLAMA_BIN) {
    const llama = await findLlamaServer(merged);
    if (llama) merged.OFFICE_LLAMA_BIN = llama;
  }
  return merged;
}

async function bootPi() {
  piFailure = '';
  try {
    const effective = await piEnv();
    const version = await preflightPi({env: effective, signal});
    console.log('正在连接本机模型…');
    model = await preparePiModel({env: effective, runtimeDir, signal});
    await studio?.syncBuiltin();
    const builtin = studio?.builtin() || {
      id: 'pi-local',
      name: 'Pi（本机）',
      role: ('本机 Pi · ' + model.modelName).slice(0, 80)
    };
    stopPi = await startAgent(builtin, null, error => {
      console.error(error.message);
      if (shared) controller.abort();
    });
    console.log(`Pi ${version} · ${model.modelName}`);
  } catch (error) {
    if (shared || signal.aborted) throw error;
    piFailure = error.message;
    console.error('本机 Pi 启动失败：' + error.message + ' 仍可使用 API 连接。');
  }
}

// Switching models from the workbench: stop Pi and its model, then load the new settings.
let piSwitch = Promise.resolve();
function restartPi() {
  piSwitch = piSwitch.then(async () => {
    const previous = model;
    model = null;
    piFailure = '';
    await stopPi?.().catch(() => {});
    stopPi = null;
    await previous?.close().catch(error => console.error(error.message));
    if (signal.aborted) return;
    if (piConfigured()) {
      await studio?.syncBuiltin({starting: true}).catch(error => console.error(error.message));
      await bootPi();
    } else await studio?.syncBuiltin().catch(error => console.error(error.message));
    await studio?.restore();
  });
  return piSwitch;
}

// The same pinned install as `npm run pi:install`, started from Pi's settings.
let piInstall = {state: 'idle'};
async function piPackage() {
  const {scripts} = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const spec = scripts?.['pi:install']?.match(/@earendil-works\/pi-coding-agent@[\w.-]+/)?.[0];
  if (!spec) throw new Error('找不到 Pi 运行环境的版本信息。');
  return spec;
}
function installPi() {
  if (piInstall.state === 'running') return;
  piInstall = {state: 'running'};
  (async () => {
    const spec = await piPackage();
    const bundledNpm = path.join(path.dirname(process.execPath), 'npm');
    const npm =
      env.OFFICE_NPM_BIN ||
      ((await fs.access(bundledNpm).then(
        () => true,
        () => false
      ))
        ? bundledNpm
        : 'npm');
    await fs.mkdir(piRuntimeDir, {recursive: true});
    const args = [
      'install',
      '--prefix',
      piRuntimeDir,
      '--ignore-scripts',
      '--save-exact',
      '--no-audit',
      '--no-fund',
      spec
    ];
    await new Promise((resolve, reject) =>
      execFile(
        npm,
        args,
        {env: process.env, timeout: 300000, maxBuffer: 4 * 1024 * 1024, signal},
        (error, _out, err) => (error ? reject(Object.assign(error, {detail: String(err || '').trim()})) : resolve())
      )
    );
    await fs.access(piRuntimeBin);
    env.OFFICE_PI_BIN = piRuntimeBin;
    piCli = {at: 0};
    piInstall = {state: 'done'};
    console.log('已安装 Pi 运行环境：' + spec);
  })().catch(error => {
    const detail = (error.detail || '').split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 400);
    piInstall = {
      state: 'failed',
      error:
        error.code === 'ENOENT'
          ? '找不到 npm。请安装 Node.js 后重试。'
          : error.killed
            ? '安装超过 5 分钟没有完成，已停止。请检查网络后重试。'
            : '安装没有完成' + (detail ? '：' + detail : '。请检查网络后重试。')
    };
    console.error('Pi 运行环境安装失败：' + piInstall.error);
  });
}

let piCli = {at: 0};
async function piSetup() {
  if (Date.now() - piCli.at > 20000) {
    try {
      piCli = {at: Date.now(), version: await preflightPi({env, signal})};
    } catch (error) {
      piCli = {at: Date.now(), error: error.message};
    }
  }
  const current = envModel
    ? env.OFFICE_MODEL_FILE
      ? {file: env.OFFICE_MODEL_FILE}
      : {url: env.OFFICE_MODEL_URL, model: env.OFFICE_MODEL_ID || ''}
    : piSettings;
  const [llama, services, files] = await Promise.all([findLlamaServer(env), detectServices(), findGgufFiles()]);
  return {
    status: localStatus(),
    install: {...piInstall, package: await piPackage().catch(() => null), dir: piRuntimeDir},
    source: shared ? 'shared' : envModel ? 'env' : piSettings ? 'settings' : null,
    current,
    modelName: model?.modelName || null,
    pi: {version: piCli.version || null, error: piCli.error || null},
    llama,
    services,
    files
  };
}

async function savePiSetup(request) {
  if (shared || envModel)
    return Response.json(
      {error: shared ? '共享办公室不能在这里更换模型。' : '本机模型由 .env.local 配置。请在那里修改后重新启动。'},
      {status: 409}
    );
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({error: '请求格式无效。'}, {status: 400});
  }
  let next = null;
  if (!body?.clear) {
    try {
      next = validatePiSettings(body);
      if (
        next.file &&
        !(await fs.stat(next.file).then(
          s => s.isFile(),
          () => false
        ))
      )
        throw new PiSetupError('找不到这个模型文件。');
    } catch (error) {
      if (error instanceof PiSetupError) return Response.json({error: error.message}, {status: 400});
      throw error;
    }
  }
  await writePiSettings(piSettingsFile, next);
  piSettings = next;
  void restartPi();
  return Response.json({status: piConfigured() ? {state: 'starting'} : {state: 'off'}}, {status: 202});
}

async function startAgent(profile, connection, onStopped = () => {}) {
  signal.throwIfAborted();
  if (!connection && !localAvailable()) throw new Error('本机模型暂不可用。');
  if (studio && profile.id !== 'pi-local') await office.setAgentEnabled(profile.id, true);
  const lifetime = new AbortController();
  const signals = [signal, lifetime.signal];
  if (!connection && model.stopped) signals.push(model.stopped);
  const agentSignal = AbortSignal.any(signals);
  function instructions() {
    if (profile.id === 'pi-local' && !studio) return '';
    const current = profile.id === 'pi-local' ? studio.builtin() : profile;
    return ['你是' + current.name + '。你的职责是' + current.role + '。', current.instructions]
      .filter(Boolean)
      .join('\n');
  }
  const avatar = connection ? 'API' : 'Pi';
  const workspace = !connection && files ? await files.rootFor(profile.id) : undefined;
  const ready = Promise.withResolvers();
  const run = runOfficePi({
    call,
    agentId: profile.id,
    name: profile.name,
    role: profile.role,
    model: modelTypes.includes(avatar) ? avatar : modelTypes[0],
    signal: agentSignal,
    guardTaskUpdates,
    guardVisualTasks,
    visualsEnabled,
    reportVisualSteps,
    onReady: ready.resolve,
    generate: (prompt, {signal, useWorkspace, request}) =>
      connection
        ? generateApi(connection, prompt, {
            signal,
            instructions: instructions(),
            onUsage: used => studio?.recordUsage(profile.id, used)
          })
        : !model
          ? Promise.reject(new Error('本机模型正在切换，请稍后重试。'))
          : generatePi(prompt, {
              signal,
              instructions: instructions(),
              env: model.env,
              workspace: useWorkspace ? workspace : undefined,
              allowHostRead: useWorkspace,
              nativeApps: Boolean(
                useWorkspace &&
                workspace &&
                /\b(?:TextEdit|Finder|Preview|Mac|macOS)\b|访达|文本编辑|预览(?:应用|程序|中|里|打开|查看)/i.test(
                  request || ''
                )
              )
            }),
    onError: error => console.error(profile.name + '：' + error.message)
  }).then(() => {
    if (!lifetime.signal.aborted && !signal.aborted) throw new Error('Agent 运行已中断。');
  });
  // Registration/capacity errors must reach the creating form, while later
  // exits update the saved profile's runtime status.
  run.catch(error => {
    ready.reject(error);
    if (!lifetime.signal.aborted && !signal.aborted) onStopped(error);
  });
  await Promise.race([
    ready.promise,
    run.then(() => {
      throw new Error('办公室已停止。');
    })
  ]);
  return async () => {
    lifetime.abort();
    await run.catch(() => {});
  };
}

try {
  await fs.mkdir(runtimeDir, {recursive: true});
  if (!shared) await fs.mkdir(stateDir, {recursive: true});
  const lockDir = shared ? runtimeDir : stateDir;
  const target = shared ? new URL(env.OFFICE_REMOTE_ORIGIN).origin : await fs.realpath(stateDir);
  const lockId = createHash('sha256').update(target).digest('hex').slice(0, 24);
  const runnerDir = path.join(lockDir, '.pi-runner-' + lockId);
  await fs.mkdir(runnerDir, {recursive: true});
  unlock = await lockfile.lock(runnerDir).catch(error => {
    if (error.code !== 'ELOCKED') throw error;
    // Started twice (for example a second double-click): show the office already running.
    if (openWhenReady) {
      openBrowser(`http://127.0.0.1:${Number(env.OFFICE_PORT || 3080)}/`);
      console.log('Agent Office 已经在运行，已打开工作台。');
      process.exit(0);
    }
    throw new Error('这个办公室已经在运行。请打开已启动的工作台。');
  });
  if (!shared)
    studio = await openAgentStudio({
      dir: path.join(stateDir, 'studio'),
      startAgent,
      localRole: () => (model ? ('本机 Pi · ' + model.modelName).slice(0, 80) : '本机 Pi 助手'),
      stopProjects: id => projects?.stopAgent(id),
      updateMember: (id, fields) => office.setMemberProfile(id, fields),
      markOffline: (id, profile) =>
        office.setAgentEnabled(id, false, {
          name: profile.name,
          role: profile.role,
          model: profile.connectionId === 'local' ? 'Pi' : 'API'
        }),
      localAvailable,
      localStatus
    });
  if (studio) files = createPiFiles(stateDir, id => id === 'pi-local' || studio.isLocalPi(id));
  if (!shared)
    projects = await openProjectSessions({
      dir: path.join(stateDir, 'projects'),
      localAvailable,
      localStatus,
      async resolveMember(id) {
        const managed = await studio.projectAgent(id);
        if (managed) {
          const kind = managed.connectionId === 'local' ? 'pi' : 'api';
          return {
            ...managed,
            kind,
            available: managed.enabled !== false && (kind === 'pi' ? localAvailable() : Boolean(managed.connection))
          };
        }
        if (!call) return null;
        const {agents} = await call('office_get_state', {});
        const member = agents.find(a => a.id === id);
        return (
          member && {
            id,
            name: member.name,
            kind: 'external',
            enabled: !member.managedDisabled,
            available: !member.managedDisabled
          }
        );
      },
      officeCall: (name, args) => call(name, args),
      generate: (prompt, {signal: turnSignal, project, member}) => {
        const instructions = [
          member.name && '你是' + member.name + '。',
          member.role && '职责：' + member.role,
          member.instructions
        ]
          .filter(Boolean)
          .join('\n');
        if (member.kind === 'api')
          return generateApiProject(member.connection, prompt, {
            signal: AbortSignal.any([turnSignal, signal]),
            project,
            instructions,
            onUsage: used => studio?.recordUsage(member.id, used)
          });
        if (!model) return Promise.reject(new Error('本机模型暂不可用或正在切换，请稍后重试。'));
        return generatePi(prompt, {
          signal: AbortSignal.any([turnSignal, signal, ...(model.stopped ? [model.stopped] : [])]),
          project,
          instructions,
          env: model.env
        });
      }
    });
  office = await startOfficeServer({
    stateDir,
    env,
    memberFiles: files,
    projects,
    control: desktopControl,
    studioFetch:
      studio && (req => (call ? studio.fetch(req) : Response.json({error: '办公室正在启动。'}, {status: 503})))
  });
  console.log('本机工作台 ' + office.url + '/');
  if (openWhenReady) openBrowser(office.url + '/');
  const rpc = mcpClient(office.url);
  const {tools} = await rpc('tools/list');
  const schema = name => tools.find(t => t.name === name)?.inputSchema.properties;
  modelTypes = schema('office_register_agent')?.model?.enum;
  if (!modelTypes?.length) throw new Error('办公室未提供成员登记工具。');
  guardTaskUpdates = !!schema('office_update_task')?.expected_status;
  guardVisualTasks = !!schema('office_publish_visual')?.require_active_task;
  visualsEnabled = Boolean(schema('office_publish_visual') && schema('office_list_visuals'));
  reportVisualSteps = Boolean(schema('office_report_step'));
  call = async (name, args) => {
    const reply = await rpc('tools/call', {name, arguments: args});
    return reply.structuredContent ?? JSON.parse(reply.content[0].text);
  };
  if (studio && (piConfigured() || studio.hasBuiltinSettings())) {
    // A configured but still loading (or offline) model has an editable seat.
    await studio.syncBuiltin({starting: true}).catch(error => console.error(error.message));
  }
  // Restore disabled seats and API runners before potentially loading a large GGUF.
  await studio?.restore({deferLocal: true});
  if (piConfigured()) await bootPi();
  await studio?.restore();
  console.log(shared ? '正在使用远程共享办公室。' : '可以在本地工作台创建 Agent。');
  if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, {once: true}));
} catch (error) {
  if (!signal.aborted) {
    console.error(error.message);
    process.exitCode = 1;
  }
} finally {
  controller.abort();
  try {
    await Promise.allSettled([projects?.close(), studio?.close(), stopPi?.()]);
    await model?.close();
  } finally {
    try {
      await office?.close();
    } finally {
      await unlock?.();
    }
  }
}
