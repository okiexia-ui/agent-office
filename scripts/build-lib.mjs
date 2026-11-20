// Production build: bundles and minifies the browser code, gives every script and
// stylesheet a content-hashed name under /assets/ (cached for a year), rewrites the
// pages to use them, generates the service worker, and embeds it all in one Worker file.
import * as esbuild from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const publicDir = path.join(root, 'public');
const OUT = 'bundle'; // esbuild's virtual output folder; nothing is written there

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png'
};
const BINARY = new Set(['.png']);
// Each page and the script that drives it. Their imports are bundled and split into chunks.
const PAGES = {'index.html': 'start-workspace.js', 'office.html': 'app.js', 'embed.html': 'embed.js'};
// Pages that register the service worker (the embed lives inside the workspace).
const APP_PAGES = new Set(['index.html', 'office.html']);

const hash = body => createHash('sha256').update(body).digest('hex');
const webPath = output => '/' + path.relative(OUT, output).split(path.sep).join('/');

async function files(dir) {
  const found = [];
  for (const entry of await fs.readdir(dir, {withFileTypes: true})) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await files(file)));
    else found.push(file);
  }
  return found;
}

async function bundleScripts() {
  const result = await esbuild.build({
    absWorkingDir: root,
    entryPoints: Object.values(PAGES).map(script => path.join('public', script)),
    outdir: OUT,
    entryNames: 'assets/[name]-[hash]',
    chunkNames: 'assets/[name]-[hash]',
    bundle: true,
    splitting: true,
    format: 'esm',
    target: 'es2022',
    minify: true,
    legalComments: 'eof',
    alias: {three: './public/vendor/three.module.js'},
    metafile: true,
    write: false,
    logLevel: 'silent'
  });
  const entries = {},
    preloads = {},
    outputs = new Map();
  for (const file of result.outputFiles) outputs.set(webPath(path.relative(root, file.path)), file.text);
  for (const [output, meta] of Object.entries(result.metafile.outputs)) {
    if (!meta.entryPoint) continue;
    entries[path.basename(meta.entryPoint)] = webPath(output);
    preloads[webPath(output)] = meta.imports.filter(i => i.kind === 'import-statement').map(i => webPath(i.path));
  }
  return {entries, preloads, outputs};
}

async function bundleStyles(sheets) {
  const result = await esbuild.build({
    absWorkingDir: root,
    entryPoints: sheets.map(sheet => path.join('public', sheet)),
    outdir: OUT,
    entryNames: 'assets/[name]-[hash]',
    bundle: true,
    minify: true,
    target: ['chrome110', 'safari16', 'firefox115'],
    metafile: true,
    write: false,
    logLevel: 'silent'
  });
  const entries = {},
    outputs = new Map();
  for (const file of result.outputFiles) outputs.set(webPath(path.relative(root, file.path)), file.text);
  for (const [output, meta] of Object.entries(result.metafile.outputs))
    if (meta.entryPoint) entries[path.basename(meta.entryPoint)] = webPath(output);
  return {entries, outputs};
}

function rewritePage(name, html, scripts, styles) {
  html = html.replace(/\s*<script type="importmap">[\s\S]*?<\/script>/, '');
  html = html.replace(/href="\.\/([\w-]+\.css)"/g, (match, sheet) => {
    if (!styles.entries[sheet]) throw new Error(`${name}: unknown stylesheet ${sheet}`);
    return `href=".${styles.entries[sheet]}"`;
  });
  const entry = scripts.entries[PAGES[name]];
  html = html.replace(`<script type="module" src="./${PAGES[name]}"></script>`, () => {
    const preload = scripts.preloads[entry].map(chunk => `<link rel="modulepreload" href=".${chunk}">`).join('');
    return `${preload}<script type="module" src=".${entry}"></script>`;
  });
  if (!html.includes(`src=".${entry}"`)) throw new Error(`${name}: entry script tag not found`);
  if (APP_PAGES.has(name))
    html = html.replace(
      '</head>',
      `  <script>if('serviceWorker'in navigator)addEventListener('load',function(){navigator.serviceWorker.register('./sw.js').catch(function(){})})</script>\n</head>`
    );
  return html;
}

async function bundleWorker() {
  const result = await esbuild.build({
    absWorkingDir: root,
    entryPoints: ['worker/index.js'],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    write: false,
    logLevel: 'silent'
  });
  return result.outputFiles[0].text;
}

export async function build({outDir = path.join(root, 'dist')} = {}) {
  const sources = await files(publicDir);
  const relative = file => path.relative(publicDir, file).split(path.sep).join('/');
  const sheets = sources.map(relative).filter(file => /^[\w-]+\.css$/.test(file));
  const [scripts, styles] = await Promise.all([bundleScripts(), bundleStyles(sheets)]);

  const assets = new Map();
  const add = (pathname, body, ext) => assets.set(pathname, {body, type: TYPES[ext] || 'text/plain; charset=utf-8'});
  for (const [pathname, body] of [...scripts.outputs, ...styles.outputs]) add(pathname, body, path.extname(pathname));
  for (const file of sources) {
    const name = relative(file),
      ext = path.extname(file);
    // Scripts and stylesheets now live in the bundles; vendor code is bundled too.
    if (ext === '.js' || ext === '.css') continue;
    if (PAGES[name]) add('/' + name, rewritePage(name, await fs.readFile(file, 'utf8'), scripts, styles), ext);
    else add('/' + name, BINARY.has(ext) ? await fs.readFile(file) : await fs.readFile(file, 'utf8'), ext);
  }

  // The service worker precaches everything the app pages need to start offline.
  const precache = [...assets.keys()]
    .filter(
      p =>
        p.startsWith('/assets/') ||
        p.startsWith('/icons/') ||
        ['/offline.html', '/manifest.webmanifest', '/favicon.svg'].includes(p)
    )
    .sort()
    .map(p => '.' + p);
  const template = await fs.readFile(path.join(root, 'scripts/service-worker.js'), 'utf8');
  const versionedFiles = [...precache, ...Object.keys(PAGES).map(name => './' + name)];
  const version = hash([template, ...versionedFiles.map(p => p + hash(assets.get(p.slice(1)).body))].join('\n')).slice(
    0,
    12
  );
  add(
    '/sw.js',
    template
      .replace("'__VERSION__'", JSON.stringify(version))
      .replace('__PRECACHE__', JSON.stringify(precache, null, 2)),
    '.js'
  );

  const embedded = {};
  for (const [pathname, {body, type}] of [...assets].sort(([a], [b]) => a.localeCompare(b))) {
    const binary = Buffer.isBuffer(body);
    embedded[pathname] = {
      type,
      etag: `"${hash(body).slice(0, 20)}"`,
      ...(binary ? {base64: body.toString('base64')} : {body})
    };
  }

  const worker = await bundleWorker();
  const serverDir = path.join(outDir, 'server');
  await fs.mkdir(serverDir, {recursive: true});
  const target = path.join(serverDir, 'index.js');
  await fs.writeFile(
    target,
    `${worker}\nconst ASSETS = ${JSON.stringify(embedded)};\nexport default createWorker(ASSETS);\n`
  );
  const syntax = spawnSync(process.execPath, ['--check', target], {stdio: 'inherit'});
  if (syntax.status !== 0) throw new Error('Built Worker failed syntax validation.');
  await fs.mkdir(path.join(outDir, '.openai'), {recursive: true});
  await fs.copyFile(path.join(root, '.openai/hosting.json'), path.join(outDir, '.openai/hosting.json'));

  const size = body => ({bytes: Buffer.byteLength(body), gzip: zlib.gzipSync(body).length});
  return {
    version,
    worker: target,
    workerBytes: (await fs.stat(target)).size,
    assets: [...assets].map(([pathname, {body}]) => ({path: pathname, ...size(body)})),
    pages: Object.fromEntries(
      Object.entries(PAGES).map(([page, script]) => [
        page,
        {script: scripts.entries[script], preloads: scripts.preloads[scripts.entries[script]]}
      ])
    )
  };
}
