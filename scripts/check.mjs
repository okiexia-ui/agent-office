// npm run check: JavaScript syntax in every source folder, then formatting (Prettier,
// configured in .prettierrc.json; `npm run format` fixes what this reports).
import {readdirSync, existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

for (const dir of ['public', 'worker', 'scripts', 'tests']) {
  for (const file of readdirSync(new URL(`../${dir}/`, import.meta.url))) {
    if (!/\.(m?js)$/.test(file)) continue;
    const result = spawnSync(process.execPath, ['--check', `${dir}/${file}`], {stdio: 'inherit'});
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
console.log('JavaScript syntax checks passed.');

// fileURLToPath, not URL.pathname: the project folder name may contain non-ASCII characters.
const prettier = fileURLToPath(new URL('../node_modules/.bin/prettier', import.meta.url));
if (!existsSync(prettier)) {
  console.error('Formatting is checked with Prettier. Run `npm install` first.');
  process.exit(1);
}
const format = spawnSync(prettier, ['--check', '--log-level', 'warn', '.'], {
  stdio: 'inherit',
  cwd: fileURLToPath(new URL('..', import.meta.url))
});
if (format.error) throw format.error;
if (format.status !== 0) {
  console.error('Some files are not formatted. Run `npm run format`.');
  process.exit(format.status || 1);
}
console.log('Formatting checks passed.');
