// One foreground process owns the office server, Pi inbox loop and optional GGUF server.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {parseEnv} from 'node:util';
import lockfile from 'proper-lockfile';
import {startOfficeServer} from './dev.mjs';
import {preflightPi, generatePi} from './pi-process.mjs';
import {preparePiModel} from './pi-model.mjs';
import {runOfficePi} from './pi-office.mjs';
import {openAgentStudio} from './agent-studio.mjs';
import {openProjectSessions} from './project-sessions.mjs';
import {generateApi} from './studio-provider.mjs';
import {createPiFiles} from './pi-files.mjs';

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
if (!env.OFFICE_PI_BIN) {
  const bundled = path.join(root, '.office-local/pi-runtime/node_modules/.bin/pi');
  env.OFFICE_PI_BIN = (await fs.access(bundled).then(
    () => true,
    () => false
  ))
    ? bundled
    : 'pi';
}

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
const piConfigured = Boolean(env.OFFICE_MODEL_FILE || env.OFFICE_MODEL_URL || shared);
let piFailure = '';
const localStatus = () => {
  if (localAvailable()) return {state: 'ready'};
  if (!piConfigured) return {state: 'off'};
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
    sessions = (list.sessions || []).filter(s => s.status === 'running').length;
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
  if (url.pathname === '/api/local/shutdown' && request.method === 'POST') {
    console.log('收到停止请求，正在关闭办公室和本机模型…');
    setTimeout(() => controller.abort(), 50);
    return Response.json({stopping: true}, {status: 202});
  }
  return Response.json({error: 'Not found.'}, {status: 404});
}

async function startAgent(profile, connection, onStopped = () => {}) {
  signal.throwIfAborted();
  if (!connection && !localAvailable()) throw new Error('本机模型暂不可用。');
  if (studio && profile.id !== 'pi-local') await office.setAgentEnabled(profile.id, true);
  const lifetime = new AbortController();
  const signals = [signal, lifetime.signal];
  if (!connection && model.stopped) signals.push(model.stopped);
  const agentSignal = AbortSignal.any(signals);
  const instructions =
    profile.id === 'pi-local'
      ? ''
      : ['你是' + profile.name + '。你的职责是' + profile.role + '。', profile.instructions].filter(Boolean).join('\n');
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
        ? generateApi(connection, prompt, {signal, instructions})
        : generatePi(prompt, {
            signal,
            instructions,
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
      markOffline: (id, profile) =>
        office.setAgentEnabled(id, false, {
          name: profile.name,
          role: profile.role,
          model: profile.connectionId === 'local' ? 'Pi' : 'API'
        }),
      localAvailable
    });
  if (studio) files = createPiFiles(stateDir, id => id === 'pi-local' || studio.isLocalPi(id));
  if (!shared)
    projects = await openProjectSessions({
      dir: path.join(stateDir, 'projects'),
      localAvailable,
      localStatus,
      generate: (prompt, {signal: turnSignal, project}) =>
        generatePi(prompt, {
          signal: AbortSignal.any([turnSignal, signal, ...(model.stopped ? [model.stopped] : [])]),
          project,
          env: model.env
        })
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
  // Restore disabled seats and API runners before potentially loading a large GGUF.
  await studio?.restore({deferLocal: true});
  if (env.OFFICE_MODEL_FILE || env.OFFICE_MODEL_URL || shared) {
    try {
      const version = await preflightPi({env, signal});
      console.log('正在连接本机模型…');
      model = await preparePiModel({env, runtimeDir, signal});
      stopPi = await startAgent(
        {
          id: 'pi-local',
          name: 'Pi（本机）',
          role: ('本机 Pi · ' + model.modelName).slice(0, 80)
        },
        null,
        error => {
          console.error(error.message);
          if (shared) controller.abort();
        }
      );
      console.log(`Pi ${version} · ${model.modelName}`);
    } catch (error) {
      if (shared || signal.aborted) throw error;
      piFailure = error.message;
      console.error('本机 Pi 启动失败：' + error.message + ' 仍可使用 API 连接。');
    }
  }
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
