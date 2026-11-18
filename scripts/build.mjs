// npm run build: writes dist/server/index.js (the Worker with every asset embedded)
// and dist/.openai/hosting.json, then prints what a first visit downloads.
import {build} from './build-lib.mjs';

const result = await build();
const kb = bytes => (bytes / 1024).toFixed(1).padStart(7) + ' KB';
const byPath = new Map(result.assets.map(asset => [asset.path, asset]));
console.log(`Agent Office build ${result.version} → ${result.worker} (${kb(result.workerBytes).trim()})`);
for (const [page, {script, preloads}] of Object.entries(result.pages)) {
  const files = [script, ...preloads].map(file => byPath.get(file));
  const total = files.reduce((sum, file) => sum + file.gzip, 0);
  console.log(`${page.padEnd(12)} scripts ${kb(files.reduce((sum, file) => sum + file.bytes, 0))} · gzip ${kb(total)}`);
}
const largest = [...result.assets].sort((a, b) => b.bytes - a.bytes).slice(0, 5);
console.log('Largest assets:');
for (const asset of largest) console.log(`  ${asset.path.padEnd(42)} ${kb(asset.bytes)} · gzip ${kb(asset.gzip)}`);
