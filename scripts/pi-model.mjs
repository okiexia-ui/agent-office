import {spawn} from 'node:child_process';
import {randomBytes, randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, rm, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

const provider = 'office-local';
const contextWindow = 16384;

function loopbackBase(value) {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('OFFICE_MODEL_URL 需要是本机回环地址，例如 http://127.0.0.1:8080/v1。');
  if (url.pathname === '/') url.pathname = '/v1';
  return url.href.replace(/\/+$/, '');
}

async function checkModel(baseUrl, model, key, signal) {
  const response = await fetch(baseUrl + '/models', {
    headers: {Authorization: 'Bearer ' + key},
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(3000)])
  });
  if (!response.ok) throw new Error(`本机模型服务返回 HTTP ${response.status}。`);
  const {data} = await response.json();
  if (!Array.isArray(data) || !data.some(entry => entry.id === model))
    throw new Error(`本机 /models 未列出模型 ${model}。`);
}

function startLlama(file, port, alias, key, env) {
  // A managed server uses its own auth, logging and network settings.
  const childEnv = Object.fromEntries(
    Object.entries(env).filter(
      ([name]) =>
        !name.startsWith('LLAMA_ARG_') &&
        !['AGENT_OFFICE_TOKEN', 'HERMES_SITE_ACCESS_TOKEN', 'OFFICE_MODEL_API_KEY'].includes(name)
    )
  );
  const child = spawn(
    env.OFFICE_LLAMA_BIN || 'llama-server',
    [
      '--model',
      file,
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--alias',
      alias,
      '--parallel',
      '1',
      '--ctx-size',
      String(contextWindow),
      '--no-ui',
      '--reasoning',
      'off',
      '--log-disable'
    ],
    {env: {...childEnv, LLAMA_API_KEY: key}, stdio: 'ignore'}
  );
  const stopped = new AbortController();
  const exited = new Promise(resolve => {
    child.once('error', error => stopped.abort(new Error(`llama-server 启动失败（${error.code}）。`)));
    child.once('close', (code, signal) => {
      stopped.abort(new Error(`llama-server 已退出（${code ?? signal}）。`));
      resolve();
    });
  });
  return {
    stopped: stopped.signal,
    async close() {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        const force = setTimeout(() => child.kill('SIGKILL'), 3000).unref();
        await exited;
        clearTimeout(force);
      } else await exited;
    }
  };
}

export async function preparePiModel({env = process.env, runtimeDir, signal = new AbortController().signal}) {
  signal.throwIfAborted();
  const file = env.OFFICE_MODEL_FILE;
  if (!!file === !!env.OFFICE_MODEL_URL)
    throw new Error('请指定 OFFICE_MODEL_FILE（本机 GGUF）或 OFFICE_MODEL_URL 与 OFFICE_MODEL_ID（本机推理服务）。');
  let baseUrl, model, modelName, server;
  const key = file ? randomBytes(32).toString('hex') : env.OFFICE_MODEL_API_KEY || 'office-local';
  if (file) {
    if (!(await stat(file)).isFile()) throw new Error('OFFICE_MODEL_FILE 必须指向模型文件。');
    const port = Number(env.OFFICE_MODEL_PORT || 8098);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('OFFICE_MODEL_PORT 端口无效。');
    baseUrl = `http://127.0.0.1:${port}/v1`;
    modelName = path.basename(file, path.extname(file));
    // Verify the process we started, even if another server already owns this port.
    model = 'office-' + randomUUID();
    server = startLlama(path.resolve(file), port, model, key, env);
  } else {
    baseUrl = loopbackBase(env.OFFICE_MODEL_URL);
    model = env.OFFICE_MODEL_ID;
    if (!model) throw new Error('请设置 OFFICE_MODEL_ID，对应本机 /models 列表中的模型 ID。');
    modelName = model;
  }
  let dir, closing;
  const onAbort = () => {
    void close().catch(console.error);
  };
  const close = () => (closing ??= cleanup());
  async function cleanup() {
    signal.removeEventListener('abort', onAbort);
    try {
      await server?.close();
    } finally {
      if (dir) await rm(dir, {recursive: true, force: true});
    }
  }
  try {
    if (server) {
      const ready = AbortSignal.any([signal, server.stopped, AbortSignal.timeout(120000)]);
      for (;;) {
        ready.throwIfAborted();
        try {
          await checkModel(baseUrl, model, key, ready);
          break;
        } catch {
          await delay(500, undefined, {signal: ready}).catch(() => ready.throwIfAborted());
        }
      }
    } else await checkModel(baseUrl, model, key, signal);
    await mkdir(runtimeDir, {recursive: true, mode: 0o700});
    dir = await mkdtemp(path.join(runtimeDir, 'pi-'));
    const config = {
      providers: {
        [provider]: {
          baseUrl,
          api: 'openai-completions',
          apiKey: !file && env.OFFICE_MODEL_API_KEY ? '$OFFICE_MODEL_API_KEY' : key,
          compat: {maxTokensField: 'max_tokens', supportsDeveloperRole: false, supportsStore: false},
          models: [{id: model, name: modelName, contextWindow, maxTokens: 1024}]
        }
      }
    };
    await writeFile(path.join(dir, 'models.json'), JSON.stringify(config), {mode: 0o600});
    await writeFile(path.join(dir, 'settings.json'), JSON.stringify({compaction: {enabled: false}}), {mode: 0o600});
    signal.throwIfAborted();
    server?.stopped.throwIfAborted();
    signal.addEventListener('abort', onAbort, {once: true});
    return {
      env: {...env, PI_CODING_AGENT_DIR: dir, OFFICE_PI_PROVIDER: provider, OFFICE_PI_MODEL: model},
      modelName,
      close,
      stopped: server?.stopped
    };
  } catch (error) {
    await close();
    throw error;
  }
}
