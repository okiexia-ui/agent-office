// npm run preview: serves the production build (dist/server/index.js) on this machine,
// exactly as it will be deployed: bundled assets, caching headers and service worker.
// Loopback only and without sign-in, like the development server. Run `npm run build` first.
import http from 'node:http';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {localBucket} from './local-bucket.mjs';

const root = path.resolve(import.meta.dirname, '..');
const dataDir = process.env.OFFICE_DATA_DIR
  ? path.resolve(process.env.OFFICE_DATA_DIR)
  : path.join(root, '.office-local');
const port = Number(process.env.OFFICE_PORT || 3090);
const {default: worker} = await import(pathToFileURL(path.join(root, 'dist/server/index.js')));
const env = {BUCKET: await localBucket(dataDir), OFFICE_LOCAL: true};

http
  .createServer(async (req, res) => {
    try {
      if (!['127.0.0.1', 'localhost'].includes((req.headers.host || '').split(':')[0])) {
        res.writeHead(403);
        res.end('Local preview only.');
        return;
      }
      const init = {method: req.method, headers: req.headers};
      if (!['GET', 'HEAD'].includes(req.method)) {
        init.body = req;
        init.duplex = 'half';
      }
      const response = await worker.fetch(new Request(new URL(req.url, `http://127.0.0.1:${port}`), init), env);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      console.error(error.message);
      res.writeHead(500, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({error: 'Local preview could not complete the request.'}));
    }
  })
  .listen(port, '127.0.0.1', () => console.log(`Production preview: http://127.0.0.1:${port}/`));
