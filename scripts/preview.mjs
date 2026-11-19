// npm run preview: serves the production build (dist/server/index.js) on this machine,
// exactly as it will be deployed: bundled assets, caching headers and service worker.
// Loopback only and without sign-in, like the development server. Run `npm run build` first.
import http from 'node:http';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {localBackend, localRequest} from './office-upstream.mjs';

const root = path.resolve(import.meta.dirname, '..');
const dataDir = process.env.OFFICE_DATA_DIR
  ? path.resolve(process.env.OFFICE_DATA_DIR)
  : path.join(root, '.office-local');
const port = Number(process.env.OFFICE_PORT || 3090);
const {default: worker} = await import(pathToFileURL(path.join(root, 'dist/server/index.js')));
const backend = await localBackend(worker, dataDir);

http
  .createServer(async (req, res) => {
    try {
      const request = localRequest(req, req.socket.localPort);
      if (!request) {
        res.writeHead(403);
        res.end('Local preview only.');
        return;
      }
      const response = await backend.fetch(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      console.error(error.message);
      res.writeHead(500, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({error: 'Local preview could not complete the request.'}));
    }
  })
  .listen(port, '127.0.0.1', () => console.log(`Production preview: http://127.0.0.1:${port}/`));
