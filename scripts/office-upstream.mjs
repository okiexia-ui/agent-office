// Local servers serve their own UI. In shared mode the Sites credential belongs to
// the Node process, and only office data requests can use it.
import {setManagedAgentEnabled} from '../worker/index.js';
import {localBucket} from './local-bucket.mjs';

const response = (data, status = 200, headers = {}) =>
  Response.json(data, {
    status,
    headers: {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers}
  });
const methods = new Map([
  ['/mcp', ['POST']],
  ['/api/health', ['GET']],
  ['/api/state', ['GET', 'PUT']],
  ['/api/sync', ['GET']],
  ['/api/chat', ['GET', 'POST']],
  ['/api/channel', ['GET', 'POST']],
  ['/api/steps', ['GET']],
  ['/api/visuals', ['GET']]
]);

export function localRequest(req, port) {
  // req.url must be an origin-relative path. Use the validated Host for same-origin
  // checks so browsers can use either localhost or 127.0.0.1.
  const host = req.headers.host;
  const suffix = port === 80 ? '' : `:${port}`;
  if (![`127.0.0.1${suffix}`, `localhost${suffix}`].includes(host)) return null;
  const base = `http://${host}`;
  if (!req.url?.startsWith('/') || new URL(req.url, base).origin !== base) return null;
  if (req.headers.origin && req.headers.origin !== base) return null;
  const method = req.method;
  return new Request(new URL(req.url, base), {
    method,
    headers: req.headers,
    ...(['GET', 'HEAD'].includes(method) ? {} : {body: req, duplex: 'half'})
  });
}

export function createOfficeUpstream(env, send = fetch) {
  if (!env.OFFICE_REMOTE_ORIGIN) return null;
  const site = URL.canParse(env.OFFICE_REMOTE_ORIGIN) ? new URL(env.OFFICE_REMOTE_ORIGIN) : null;
  if (site?.protocol !== 'https:' || site.href !== site.origin + '/')
    throw new Error('OFFICE_REMOTE_ORIGIN must be an HTTPS site origin, without credentials, path, query or fragment.');
  const token = env.AGENT_OFFICE_TOKEN?.trim();
  if (!token || /\s/.test(token)) throw new Error('Set AGENT_OFFICE_TOKEN for the shared remote office.');
  let legacySync = false;

  async function upstream(path, {method = 'GET', request} = {}) {
    const headers = new Headers({
      'OAI-Sites-Authorization': `Bearer ${token}`,
      Accept: path === '/api/hermes/mcp' ? 'application/json, text/event-stream' : 'application/json'
    });
    if (request?.headers.has('if-none-match')) headers.set('If-None-Match', request.headers.get('if-none-match'));
    let body;
    if (request?.body) {
      if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json')
        return response({error: 'Use Content-Type: application/json.'}, 415);
      headers.set('Content-Type', 'application/json');
      body = request.body;
    }
    const remote = await send(site.origin + path, {
      method,
      headers,
      ...(body ? {body, duplex: 'half'} : {}),
      redirect: 'manual',
      signal: AbortSignal.timeout(10000)
    });
    const resultHeaders = {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'};
    if (remote.headers.has('etag')) resultHeaders.ETag = remote.headers.get('etag');
    if ([202, 204, 304].includes(remote.status)) {
      await remote.body?.cancel();
      return new Response(null, {status: remote.status, headers: resultHeaders});
    }
    if (remote.status >= 300 && remote.status < 400) {
      await remote.body?.cancel();
      return response({error: 'The remote office redirected the request. Check its origin and access token.'}, 502);
    }
    if (!remote.headers.get('content-type')?.includes('application/json')) {
      await remote.body?.cancel();
      return response(
        {error: `Remote office returned HTTP ${remote.status}. Check the site and its service token.`},
        remote.ok ? 502 : remote.status
      );
    }
    // Do not return gateway cookies, authentication challenges, or executable HTML to localhost.
    return new Response(await remote.arrayBuffer(), {
      status: remote.status,
      headers: {...resultHeaders, 'Content-Type': 'application/json; charset=utf-8'}
    });
  }

  async function syncLegacy(request, url) {
    const scope = url.searchParams.get('scope') || 'group';
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(scope)) return response({error: 'Invalid conversation scope.'}, 400);
    const stateResponse = await upstream('/api/state');
    if (!stateResponse.ok) return stateResponse;
    const state = await stateResponse.json();
    const tag = `"legacy-${state.revision}-${scope}"`;
    if (request.headers.get('if-none-match') === tag)
      return new Response(null, {status: 304, headers: {ETag: tag, 'Cache-Control': 'no-store'}});
    const exists = scope === 'group' || state.agents.some(agent => agent.id === scope);
    const reads = await Promise.all([
      upstream('/api/visuals'),
      upstream('/api/steps'),
      exists
        ? upstream(scope === 'group' ? '/api/channel' : `/api/chat?agentId=${scope}`)
        : response({missing: true, messages: []})
    ]);
    const failed = reads.find(read => !read.ok);
    if (failed) return failed;
    const [visuals, steps, conversation] = await Promise.all(reads.map(read => read.json()));
    // Only cache an assembled legacy view when every read came from the same revision.
    const coherent = [visuals, steps, conversation].every(part => part.missing || part.revision === state.revision);
    return response(
      {
        revision: state.revision,
        state,
        visuals: visuals.visuals,
        steps: steps.steps,
        conversation: {...conversation, scope}
      },
      200,
      coherent ? {ETag: tag} : {}
    );
  }

  return {
    origin: site.origin,
    async fetch(request) {
      const url = new URL(request.url);
      const allowed =
        methods.get(url.pathname) || (/^\/api\/visuals\/[A-Za-z0-9_-]{1,64}$/.test(url.pathname) && ['GET']);
      if (!allowed) return response({error: 'Unknown local office route.'}, 404);
      if (!allowed.includes(request.method))
        return response({error: 'Method not allowed.'}, 405, {Allow: allowed.join(', ')});
      if (
        request.headers.get('sec-fetch-site') === 'cross-site' ||
        (request.headers.has('origin') && request.headers.get('origin') !== url.origin)
      )
        return response({error: 'Cross-origin requests are not allowed.'}, 403);
      try {
        if (url.pathname === '/api/sync' && legacySync) return await syncLegacy(request, url);
        const path = url.pathname === '/mcp' ? '/api/hermes/mcp' : url.pathname + url.search;
        const result = await upstream(path, {method: request.method, request});
        if (url.pathname !== '/api/sync' || result.status !== 404) return result;
        legacySync = true;
        return await syncLegacy(request, url);
      } catch (error) {
        return response(
          {error: 'Failed to reach the configured remote office.'},
          error.name === 'TimeoutError' ? 504 : 502
        );
      }
    }
  };
}

export async function localBackend(worker, dataDir, env = process.env, studioFetch, memberFiles) {
  const remote = createOfficeUpstream(env);
  const bindings = remote
    ? {}
    : {BUCKET: await localBucket(dataDir), OFFICE_LOCAL: true, PI_OFFICE: env.OFFICE_PI_LOCAL === '1'};
  return {
    remoteOrigin: remote?.origin,
    setAgentEnabled: (id, enabled, profile) => setManagedAgentEnabled(bindings, id, enabled, profile),
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === '/api/local-mode')
        return request.method === 'GET'
          ? response({
              mode: remote ? 'remote' : 'local',
              remoteOrigin: remote?.origin || null,
              ...(studioFetch && !remote ? {studio: true} : {}),
              ...(memberFiles && !remote ? {fileTools: true} : {})
            })
          : response({error: 'Method not allowed.'}, 405);
      if (path.startsWith('/api/studio/files/'))
        return memberFiles && !remote ? memberFiles.fetch(request) : response({error: '此办公室没有本机文件区。'}, 404);
      if (path === '/api/studio' || path.startsWith('/api/studio/'))
        return studioFetch && !remote
          ? studioFetch(request)
          : response({error: '仅本地 Agent 工作台支持此操作。'}, 404);
      if (remote && (path.startsWith('/api/') || path === '/mcp')) return remote.fetch(request);
      const result = await worker.fetch(request, bindings);
      if (path === '/api/sync' && memberFiles?.ownsPi(url.searchParams.get('scope')))
        result.headers.set('X-Office-Member-Files', '1');
      return result;
    }
  };
}
