import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {generateApi, listApiModels, ModelServiceError, validateBaseUrl} from './studio-provider.mjs';

export class StudioError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function textField(value, label, max, optional = false) {
  if (optional && value == null) return '';
  if (typeof value !== 'string' || value.length > max || (!optional && !value.trim()))
    throw new StudioError(`${label}请填写${optional ? '不超过' : '1 至'} ${max} 个字符。`);
  return value.trim();
}

export async function readForm(request, limit = 32768) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json')
    throw new StudioError('请使用 JSON 提交配置。', 415);
  const reader = request.body?.getReader();
  if (!reader) throw new StudioError('请求中缺少配置。');
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new StudioError('提交的内容超过 ' + limit / 1024 + ' KB。', 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const fields = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (fields && typeof fields === 'object' && !Array.isArray(fields)) return fields;
  } catch {}
  throw new StudioError('需要一个 JSON 配置对象。');
}

const json = (value, status = 200) =>
  Response.json(value, {status, headers: {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}});

function endpointInput(data) {
  let baseUrl;
  try {
    baseUrl = validateBaseUrl(textField(data.baseUrl, '服务地址', 2048));
  } catch {
    throw new StudioError('请输入 HTTPS 或本机 HTTP 服务的基础 URL，地址中请勿包含凭证、查询参数或片段。');
  }
  const key = textField(data.apiKey, 'API Key', 4096, true);
  if (/[^\x21-\x7e]/.test(key)) throw new StudioError('API Key 含有无效字符。');
  return {baseUrl, apiKey: key};
}

function connectionInput(data, previous) {
  const name = textField(data.name, '连接名称', 80);
  const model = textField(data.model, '模型 ID', 256);
  const {baseUrl, apiKey} = endpointInput(data);
  if (data.clearKey !== undefined && typeof data.clearKey !== 'boolean')
    throw new StudioError('移除密钥选项需要使用布尔值。');
  if (apiKey && data.clearKey) throw new StudioError('请在填写新密钥与移除旧密钥之间选择一项。');
  const sameOrigin = previous && new URL(previous.baseUrl).origin === new URL(baseUrl).origin;
  if (previous?.apiKey && !data.clearKey && !apiKey && !sameOrigin)
    throw new StudioError('服务地址已更换主机，请重新填写该服务的 API Key。');
  return {
    id: previous?.id ?? randomUUID(),
    name,
    baseUrl,
    model,
    apiKey: data.clearKey ? '' : apiKey || previous?.apiKey || ''
  };
}

function visibleConnection({id, name, baseUrl, model, apiKey}) {
  return {id, name, baseUrl, model, hasKey: !!apiKey};
}

function findRecord(records, id, label) {
  const found = records.find(item => item.id === id);
  if (!found) throw new StudioError(`${label}不存在。`, 404);
  return found;
}

function defaultTest(connection, {signal}) {
  return generateApi(connection, '请只回复 OK。', {signal});
}

// dir is a dedicated private directory, separate from Worker state, static assets and MCP.
export async function openAgentStudio({
  dir,
  startAgent,
  markOffline,
  localAvailable,
  testConnection = defaultTest,
  listModels = listApiModels
}) {
  await fs.mkdir(dir, {recursive: true, mode: 0o700});
  await fs.chmod(dir, 0o700);
  const file = path.join(dir, 'profiles.json');
  let data;
  try {
    data = JSON.parse(await fs.readFile(file, 'utf8'));
    if (data.version !== 1 || !Array.isArray(data.agents) || !Array.isArray(data.connections)) throw new Error();
    await fs.chmod(file, 0o600);
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('无法读取 Agent 工作室的本机配置。');
    data = {version: 1, connections: [], agents: []};
  }

  // A mutation includes saving the config and switching its runners. A later
  // request cannot race the previous one and end up running an older profile.
  let tail = Promise.resolve(),
    closed = false;
  const shutdown = new AbortController();
  function enqueue(fn) {
    const next = tail.then(fn);
    tail = next.catch(() => {});
    return next;
  }
  async function persist(next) {
    const temp = file + '.' + randomUUID() + '.tmp';
    try {
      await fs.writeFile(temp, JSON.stringify(next), {mode: 0o600, flag: 'wx'});
      await fs.rename(temp, file);
      data = next;
    } finally {
      await fs.rm(temp, {force: true});
    }
  }

  // Version 1 files predating the enabled flag contained only active profiles.
  if (data.agents.some(a => a.enabled === undefined))
    await persist({...data, agents: data.agents.map(a => ({enabled: true, ...a}))});

  function save(group, record) {
    const exists = data[group].some(item => item.id === record.id);
    const rows = exists ? data[group].map(item => (item.id === record.id ? record : item)) : [...data[group], record];
    return persist({...data, [group]: rows});
  }

  const runners = new Map();
  function visibleAgent(agent) {
    const {id, name, role, instructions, connectionId, enabled} = agent;
    const {status = enabled ? 'starting' : 'disabled', error} = runners.get(id) ?? {};
    return {id, name, role, instructions, connectionId, enabled, status, ...(error ? {error} : {})};
  }

  async function reconcile(agent) {
    const previous = runners.get(agent.id);
    if (previous?.stop) {
      try {
        await previous.stop();
      } catch {
        previous.status = 'error';
        previous.error = '先前的 Agent 尚未停止，请稍后重新保存。';
        return;
      }
    }
    if (!agent.enabled) {
      try {
        await markOffline?.(agent.id, agent);
        runners.set(agent.id, {status: 'disabled'});
      } catch {
        runners.set(agent.id, {status: 'error', error: '运行已停止，尚未同步办公室状态。请重试停用。'});
      }
      return;
    }
    const run = {status: 'starting'};
    runners.set(agent.id, run);
    if (agent.connectionId === 'local' && !localAvailable()) {
      run.status = 'error';
      run.error = '本机模型尚未就绪。可启动本机模型或为这个 Agent 选择 API 连接。';
      return;
    }
    const stopped = () => {
      run.status = 'error';
      run.error = 'Agent 未能运行。请检查模型配置、办公室工位和服务状态，再重新保存。';
    };
    try {
      const connection =
        agent.connectionId === 'local' ? null : findRecord(data.connections, agent.connectionId, 'API 连接');
      run.stop = await startAgent(agent, connection, stopped);
      if (run.status === 'starting') run.status = 'running';
    } catch {
      stopped();
    }
  }

  async function mutation(request, group, id, action) {
    const remove = request.method === 'DELETE';
    const fields = remove ? null : await readForm(request);
    return enqueue(async () => {
      if (closed) throw new StudioError('办公室正在关闭。', 503);
      const previous = id ? findRecord(data[group], id, group === 'connections' ? 'API 连接' : 'Agent') : null;
      if (remove) {
        if (data.agents.some(a => a.connectionId === id))
          throw new StudioError('仍有 Agent 使用这个连接。请先为这些成员选择其他连接。', 409);
        await persist({...data, connections: data.connections.filter(c => c.id !== id)});
        return json({ok: true});
      }
      if (action === 'enabled') {
        if (typeof fields.enabled !== 'boolean') throw new StudioError('请指定 enabled 为 true 或 false。');
        const agent = {...previous, enabled: fields.enabled};
        if (previous.enabled !== agent.enabled) await save('agents', agent);
        if (runners.get(id)?.status !== (agent.enabled ? 'running' : 'disabled')) await reconcile(agent);
        return json({agent: visibleAgent(agent)});
      }
      if (group === 'connections') {
        const connection = connectionInput(fields, previous);
        await save(group, connection);
        for (const agent of data.agents.filter(a => a.enabled && a.connectionId === connection.id))
          await reconcile(agent);
        return json({connection: visibleConnection(connection)}, previous ? 200 : 201);
      }
      if (!previous && data.agents.length >= 16)
        throw new StudioError('工作室已保存 16 个 Agent，已达到上限。可以编辑已有 Agent 的职责和模型。', 409);
      const connectionId = textField(fields.connectionId, '模型连接', 64);
      if (connectionId !== 'local') findRecord(data.connections, connectionId, 'API 连接');
      const agent = {
        id: previous?.id ?? 'agent-' + randomUUID(),
        name: textField(fields.name, 'Agent 名称', 24),
        role: textField(fields.role, '职责', 80),
        instructions: textField(fields.instructions, '工作指令', 6000, true),
        enabled: previous?.enabled ?? true,
        connectionId
      };
      await save(group, agent);
      await reconcile(agent);
      return json({agent: visibleAgent(agent)}, previous ? 200 : 201);
    });
  }

  return {
    isLocalPi(id) {
      return data.agents.some(a => a.id === id && a.connectionId === 'local');
    },
    async fetch(request) {
      try {
        const url = new URL(request.url);
        if (
          !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
          request.headers.get('sec-fetch-site') === 'cross-site' ||
          (request.headers.has('origin') && request.headers.get('origin') !== url.origin)
        )
          throw new StudioError('工作室配置仅接受本机同源请求。', 403);
        if (closed) throw new StudioError('办公室正在关闭。', 503);
        if (url.pathname === '/api/studio' && request.method === 'GET') {
          return json({
            localAvailable: localAvailable(),
            connections: data.connections.map(visibleConnection),
            agents: data.agents.map(visibleAgent)
          });
        }
        const route = /^\/api\/studio\/(connections|agents)(?:\/([\w-]+))?(?:\/(test|models|enabled))?$/.exec(
          url.pathname
        );
        if (!route) throw new StudioError('工作室接口不存在。', 404);
        const [, group, id, action] = route;
        const draftModels = group === 'connections' && id === 'models' && !action;
        if (draftModels || action === 'test' || action === 'models') {
          if (group !== 'connections') throw new StudioError('工作室接口不存在。', 404);
          if (request.method !== 'POST') throw new StudioError('请使用 POST 调用该操作。', 405);
          const form = await readForm(request);
          const connection = draftModels ? endpointInput(form) : findRecord(data.connections, id, 'API 连接');
          const signal = AbortSignal.any([request.signal, shutdown.signal, AbortSignal.timeout(30000)]);
          try {
            if (draftModels || action === 'models') return json({models: await listModels(connection, {signal})});
            await testConnection(connection, {signal});
            return json({ok: true});
          } catch (error) {
            if (error instanceof ModelServiceError) throw new StudioError(error.message, 502);
            if (draftModels || action === 'models')
              throw new StudioError('读取模型列表失败。可以手动填写模型 ID。', 502);
            throw new StudioError('模型调用未成功。请核对服务地址、模型 ID、API Key、额度和网络后重试。', 502);
          }
        }
        if (action === 'enabled' && group !== 'agents') throw new StudioError('工作室接口不存在。', 404);
        const remove = group === 'connections' && id && request.method === 'DELETE';
        if (!remove && request.method !== (id && !action ? 'PUT' : 'POST'))
          throw new StudioError('不支持该请求方法。', 405);
        return await mutation(request, group, id, action);
      } catch (error) {
        return error instanceof StudioError
          ? json({error: error.message}, error.status)
          : json({error: '本机配置保存失败，请检查磁盘空间和目录权限。'}, 500);
      }
    },
    restore({deferLocal = false} = {}) {
      return enqueue(async () => {
        if (closed) return;
        for (const agent of data.agents) {
          if (deferLocal && agent.enabled && agent.connectionId === 'local') continue;
          if (runners.get(agent.id)?.status !== (agent.enabled ? 'running' : 'disabled')) await reconcile(agent);
        }
      });
    },
    close() {
      closed = true;
      shutdown.abort();
      return enqueue(async () => {
        try {
          await Promise.all([...runners.values()].map(run => run.stop?.()));
        } finally {
          runners.clear();
        }
      });
    }
  };
}
