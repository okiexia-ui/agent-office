import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
for (const dir of ['public', 'worker', 'scripts']) {
  for (const file of readdirSync(new URL(`../${dir}/`, import.meta.url))) {
    if (!/\.(m?js)$/.test(file)) continue;
    const result = spawnSync(process.execPath, ['--check', `${dir}/${file}`], {stdio:'inherit'});
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
console.log('JavaScript syntax checks passed.');
