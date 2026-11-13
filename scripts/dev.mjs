// Local-only preview of the same Worker routes. No production data or credentials.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createWorker} from '../worker/index.js';

const root = path.resolve(import.meta.dirname, '..');
const publicDir = path.join(root, 'public');
const stateDir = process.env.OFFICE_DATA_DIR ? path.resolve(process.env.OFFICE_DATA_DIR) : path.join(root, '.office-local');
await fs.mkdir(stateDir, {recursive:true});
const stateFile = path.join(stateDir, 'state.json');
let stored = await fs.readFile(stateFile, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
let generation = 0, etag = stored ? 'local-0' : null;
let diskWrites = Promise.resolve();
const bucket = {
  async get() {
    if (stored === null) return null;
    const value = stored, tag = etag;
    return {etag:tag, json:async () => JSON.parse(value)};
  },
  async put(key, value, options) {
    const condition = options?.onlyIf;
    if (condition?.etagMatches && condition.etagMatches !== etag) return null;
    if (condition?.etagDoesNotMatch === '*' && stored !== null) return null;
    stored = value;
    etag = `local-${++generation}`;
    const tag = etag;
    diskWrites = diskWrites.catch(() => {}).then(async () => {
      await fs.writeFile(stateFile + '.tmp', value);
      await fs.rename(stateFile + '.tmp', stateFile);
    });
    await diskWrites;
    return {etag:tag};
  },
};
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.txt':'text/plain; charset=utf-8','.yaml':'text/plain; charset=utf-8'};
const port = Number(process.env.OFFICE_PORT || 3080);
const worker = createWorker();
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    // Bind and validate loopback only; this development server has no sign-in.
    if (!['127.0.0.1', 'localhost'].includes((req.headers.host || '').split(':')[0])) {
      res.writeHead(403); res.end('Local preview only.'); return;
    }
    if (!url.pathname.startsWith('/api/') && url.pathname !== '/mcp') {
      const file = path.resolve(publicDir, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
      if (!file.startsWith(publicDir + path.sep) || !['GET','HEAD'].includes(req.method)) { res.writeHead(404); res.end(); return; }
      const body = await fs.readFile(file).catch(() => null);
      res.writeHead(body ? 200 : 404, {'Content-Type':types[path.extname(file)] || 'application/octet-stream','Cache-Control':'no-store'});
      res.end(req.method === 'HEAD' ? undefined : body); return;
    }
    const init = {method:req.method, headers:req.headers};
    if (!['GET','HEAD'].includes(req.method)) { init.body = req; init.duplex = 'half'; }
    const response = await worker.fetch(new Request(url, init), {BUCKET:bucket, OFFICE_LOCAL:true});
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error(error.message);
    res.writeHead(500, {'Content-Type':'application/json'});
    res.end(JSON.stringify({error:'Local preview could not complete the request.'}));
  }
});
server.listen(port, '127.0.0.1', () => console.log(`Local: http://127.0.0.1:${port}/?demo=1\nLocal Agent API: http://127.0.0.1:${port}/mcp`));
