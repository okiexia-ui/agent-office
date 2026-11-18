// npm run package: makes a fresh production build and writes the archive that is
// published through Sites (in Codex), plus checksums:
//   release/agent-office-<version>-sites.tar.gz  → dist/.openai/hosting.json + dist/server/index.js
//   release/SHA256SUMS.txt
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {build} from './build-lib.mjs';

const root = path.resolve(import.meta.dirname, '..');
const {version} = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const result = await build();
const releaseDir = path.join(root, 'release');
await fs.mkdir(releaseDir, {recursive: true});

const name = `agent-office-${version}-sites.tar.gz`,
  archive = path.join(releaseDir, name);
// COPYFILE_DISABLE keeps macOS metadata files (._*) out of the archive.
const tar = spawnSync('tar', ['-czf', archive, '-C', root, 'dist/.openai/hosting.json', 'dist/server/index.js'], {
  stdio: 'inherit',
  env: {...process.env, COPYFILE_DISABLE: '1'}
});
if (tar.status !== 0) throw new Error('Could not create the release archive (is `tar` installed?).');

const sha = async file =>
  createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex');
const sums = [
  `${await sha(archive)}  ${name}`,
  `${await sha(result.worker)}  dist/server/index.js`,
  `${await sha(path.join(root, 'dist/.openai/hosting.json'))}  dist/.openai/hosting.json`
];
await fs.writeFile(path.join(releaseDir, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
const {size} = await fs.stat(archive);
console.log(`Agent Office ${version} (build ${result.version})`);
console.log(`${path.relative(root, archive)}  ${(size / 1024).toFixed(1)} KB`);
console.log(`${path.relative(root, path.join(releaseDir, 'SHA256SUMS.txt'))}`);
console.log('Publish it through Sites in Codex to the project in .openai/hosting.json; see docs/DEPLOYMENT.md.');
