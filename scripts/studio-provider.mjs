import {projectToolSpec} from './pi-project-extension.mjs';
import {projectOperation} from './pi-documents.mjs';
// The local office sends only this agent's instructions and the current conversation to its configured API.
export class ModelServiceError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export function validateBaseUrl(value) {
  const invalid = '请填写模型 API 的 HTTPS 基础地址。本机回环地址也可以使用 HTTP。';
  if (typeof value !== 'string') throw new Error(invalid);
  const base = value.trim();
  if (!/^https?:\/\//i.test(base) || /[\s\\?#]/.test(base) || !URL.canParse(base)) throw new Error(invalid);
  const url = new URL(base);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !local) || url.username || url.password) throw new Error(invalid);
  return url.origin + url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
}

function httpError(status) {
  const hint = {
    400: '请检查模型 ID 与接口兼容性。',
    401: '请检查 API Key。',
    402: '请检查服务账户余额。',
    403: '请检查凭证权限与模型访问权限。',
    404: '请检查基础地址和模型 ID。',
    429: '请检查配额或稍后重试。'
  }[status];
  return new ModelServiceError(`模型服务返回 HTTP ${status}。${hint || '请检查模型服务状态。'}`, status);
}

async function readJson(response, limit) {
  // Count decoded bytes while reading. This also bounds compressed and chunked responses.
  const chunks = [];
  let bytes = 0;
  if (!response.body) throw new ModelServiceError('模型服务返回了空响应。');
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > limit) throw new ModelServiceError(`模型服务的响应超过了 ${limit / 1024 / 1024} MiB。`);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
  } catch {
    throw new ModelServiceError('模型服务未返回可读取的 JSON。');
  }
}

async function providerRequest(connection, route, {signal, send, body, timeout, limit = 1024 * 1024}) {
  const url = validateBaseUrl(connection.baseUrl) + route;
  const deadline = AbortSignal.timeout(timeout);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  signal?.throwIfAborted();
  try {
    const response = await send(url, {
      method: body ? 'POST' : 'GET',
      headers: {
        ...(body && {'Content-Type': 'application/json'}),
        Accept: 'application/json',
        ...(connection.apiKey && {Authorization: 'Bearer ' + connection.apiKey})
      },
      ...(body && {body: JSON.stringify(body)}),
      redirect: 'manual',
      signal: requestSignal
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw httpError(response.status);
    }
    return await readJson(response, limit);
  } catch (error) {
    signal?.throwIfAborted();
    if (deadline.aborted) throw new ModelServiceError('模型服务请求超时，请稍后重试。');
    if (error instanceof ModelServiceError) throw error;
    const {hostname, host} = new URL(url);
    if (['127.0.0.1', 'localhost', '[::1]'].includes(hostname))
      throw new ModelServiceError(`连不上本机 ${host} 上的模型服务。请确认 Ollama、LM Studio 等服务已经启动。`);
    throw new ModelServiceError('连接模型服务失败，请检查 API 地址和网络。');
  }
}

// Token counts the service reports for one request (OpenAI-style or input/output names).
function reportUsage(usage, onUsage) {
  if (!onUsage || !usage || typeof usage !== 'object') return;
  const input = Math.max(0, Number(usage.prompt_tokens ?? usage.input_tokens) || 0);
  const output = Math.max(0, Number(usage.completion_tokens ?? usage.output_tokens) || 0);
  if (input || output) onUsage({input, output});
}

export async function generateApi(connection, prompt, {signal, instructions = '', send = fetch, onUsage} = {}) {
  const messages = [];
  if (instructions.trim()) messages.push({role: 'system', content: instructions});
  messages.push({role: 'user', content: prompt});
  const data = await providerRequest(connection, '/chat/completions', {
    signal,
    send,
    timeout: 120000,
    body: {model: connection.model, messages, stream: false}
  });
  reportUsage(data?.usage, onUsage);
  const reply = data?.choices?.[0]?.message?.content;
  if (typeof reply !== 'string' || !reply.trim())
    throw new ModelServiceError('模型服务未返回文本回复，请检查模型和接口格式。');
  return reply.trim();
}

// A project assignment explicitly grants this member the same scoped text tools
// as Pi. The API connection never controls the root directory or the journal.
export async function generateApiProject(
  connection,
  prompt,
  {signal, instructions = '', project, send = fetch, onUsage}
) {
  const messages = [
    {
      role: 'system',
      content: [instructions, '使用 office_project 实际读取或修改当前项目的相对路径。只报告工具证实的改动。']
        .filter(Boolean)
        .join('\n')
    },
    {role: 'user', content: prompt}
  ];
  const tools = [{type: 'function', function: {name: 'office_project', ...projectToolSpec}}];
  const deadline = AbortSignal.timeout(360000);
  const runSignal = signal ? AbortSignal.any([deadline, signal]) : deadline;
  for (let round = 0; round < 24; round++) {
    const data = await providerRequest(connection, '/chat/completions', {
      signal: runSignal,
      send,
      timeout: 120000,
      body: {model: connection.model, messages, tools, stream: false}
    });
    reportUsage(data?.usage, onUsage);
    const message = data?.choices?.[0]?.message;
    const calls = message?.tool_calls;
    if (!Array.isArray(calls) || !calls.length) {
      if (typeof message?.content === 'string' && message.content.trim()) return message.content.trim();
      throw new ModelServiceError('模型没有返回回复或项目工具调用。');
    }
    if (calls.length > 8 || calls.some(c => !c || c.function?.name !== 'office_project' || typeof c.id !== 'string'))
      throw new ModelServiceError('模型返回了不支持的项目工具调用。');
    messages.push({
      role: 'assistant',
      content: typeof message.content === 'string' ? message.content : null,
      tool_calls: calls
    });
    for (const call of calls) {
      runSignal.throwIfAborted();
      let result;
      try {
        const args = JSON.parse(call.function.arguments);
        if (!projectToolSpec.parameters.properties.operation.enum.includes(args.operation))
          throw Error('不支持的项目文件操作。');
        result = await projectOperation(
          {...args, root: project.projectPath, identity: project.identity, journal: project.journal},
          {signal: runSignal}
        );
      } catch (error) {
        runSignal.throwIfAborted();
        result = {error: error.message};
      }
      messages.push({role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, 20000)});
    }
  }
  throw new ModelServiceError('这轮已达到项目工具调用上限，可以分步继续。');
}

// Gateways such as OpenCode list embedding, image and other-protocol models next to chat
// models. Keep entries that say nothing about this, or that declare Chat Completions.
const NOT_CHAT = new Set(
  'embedding embeddings image images video audio speech tts transcription rerank moderation realtime'.split(' ')
);
function chatModel(item) {
  if (typeof item?.type === 'string' && NOT_CHAT.has(item.type.toLowerCase())) return false;
  const api = item?.api;
  const routes = api && typeof api === 'object' && !Array.isArray(api) ? Object.keys(api) : [];
  return !routes.length || routes.includes('chat-completions');
}

export async function listApiModels(connection, {signal, send = fetch} = {}) {
  let catalog;
  try {
    // OpenRouter describes several hundred models in close to 1 MiB.
    catalog = await providerRequest(connection, '/models', {signal, send, timeout: 30000, limit: 4 * 1024 * 1024});
  } catch (error) {
    if (error.status === 404 || error.status === 405)
      throw new ModelServiceError(
        `这个地址没有提供模型列表（HTTP ${error.status}）。请核对基础地址，或直接手动填写模型 ID。`
      );
    throw error;
  }
  if (!Array.isArray(catalog?.data)) throw new ModelServiceError('该服务未返回兼容的模型列表。可以手动填写模型 ID。');
  const ids = new Set();
  for (const item of catalog.data) {
    if (!chatModel(item)) continue;
    const id = item?.id;
    if (typeof id !== 'string' || !id.trim() || id.length > 256 || /[\u0000-\u001f\u007f]/.test(id)) continue;
    if (id === connection.apiKey || (connection.apiKey?.length >= 12 && id.includes(connection.apiKey))) continue;
    ids.add(id.trim());
    if (ids.size === 1000) break;
  }
  return [...ids];
}
