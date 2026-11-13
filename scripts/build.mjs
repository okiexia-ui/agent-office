import fs from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const publicDir=path.join(root,'public');
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.txt':'text/plain; charset=utf-8','.yaml':'text/plain; charset=utf-8','.json':'application/json; charset=utf-8'};
const assets={};
async function visit(dir){for(const entry of await fs.readdir(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())await visit(file);else assets['/'+path.relative(publicDir,file).split(path.sep).join('/') ]={body:await fs.readFile(file,'utf8'),type:types[path.extname(file)]||'text/plain; charset=utf-8'};}}
await visit(publicDir);
const shared=await fs.readFile(path.join(publicDir,'layout.js'),'utf8');
const core=(await fs.readFile(path.join(root,'worker/index.js'),'utf8')).replace("import {DESKS, assignSeats} from '../public/layout.js';",shared);
const out=path.join(root,'dist/server');await fs.mkdir(out,{recursive:true});
await fs.writeFile(path.join(out,'index.js'),core+'\nconst ASSETS='+JSON.stringify(assets)+';\nexport default createWorker(ASSETS);\n');
await fs.mkdir(path.join(root,'dist/.openai'),{recursive:true});await fs.copyFile(path.join(root,'.openai/hosting.json'),path.join(root,'dist/.openai/hosting.json'));
console.log(JSON.stringify({assets:Object.keys(assets).length,workerBytes:(await fs.stat(path.join(out,'index.js'))).size}));
