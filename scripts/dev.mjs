// Serve local UI assets with a disk-backed office or the configured shared remote office.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createWorker} from '../worker/index.js';
import {localBackend, localRequest} from './office-upstream.mjs';

const root = path.resolve(import.meta.dirname, '..');
const publicDir = path.join(root, 'public');
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png'
};
export async function startOfficeServer({
  env = process.env,
  stateDir = env.OFFICE_DATA_DIR || path.join(root, '.office-local'),
  studioFetch,
  memberFiles,
  projects,
  // Optional handler for /api/local/* (activity and shutdown for the desktop app).
  control
} = {}) {
  const port = Number(env.OFFICE_PORT || 3080);
  const backend = await localBackend(createWorker(), path.resolve(stateDir), env, studioFetch, memberFiles, projects);
  const server = http.createServer(async (req, res) => {
    try {
      const request = localRequest(req, server.address().port);
      if (!request) {
        res.writeHead(403);
        res.end('Local preview only.');
        return;
      }
      const url = new URL(request.url);
      if (!url.pathname.startsWith('/api/') && url.pathname !== '/mcp') {
        if (projects && url.pathname === '/office.html' && !url.searchParams.has('manage')) {
          res.writeHead(302, {Location: '/' + url.search, 'Cache-Control': 'no-store'});
          res.end();
          return;
        }
        const file = path.resolve(
          publicDir,
          '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
        );
        if (!file.startsWith(publicDir + path.sep) || !['GET', 'HEAD'].includes(req.method)) {
          res.writeHead(404);
          res.end();
          return;
        }
        const body = await fs.readFile(file).catch(() => null);
        res.writeHead(body ? 200 : 404, {
          'Content-Type': types[path.extname(file)] || 'application/octet-stream',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': "frame-ancestors 'self'",
          'X-Content-Type-Options': 'nosniff'
        });
        res.end(req.method === 'HEAD' ? undefined : body);
        return;
      }
      const response =
        control && url.pathname.startsWith('/api/local/') ? await control(request) : await backend.fetch(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      console.error(error.message);
      res.writeHead(500, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({error: 'Local preview could not complete the request.'}));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    setAgentEnabled: backend.setAgentEnabled,
    setMemberProfile: backend.setMemberProfile,
    close: () => new Promise(resolve => server.close(resolve))
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const {url} = await startOfficeServer();
  console.log(`Office: ${url}/\nAgent MCP: ${url}/mcp`);
}
