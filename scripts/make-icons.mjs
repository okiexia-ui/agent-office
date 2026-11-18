// Renders the app icons from their SVG sources. Run on macOS (uses the built-in `sips`)
// whenever public/icons/*.svg change; the PNGs are committed so builds need no tools.
import {execFileSync} from 'node:child_process';
import path from 'node:path';

const icons = path.resolve(import.meta.dirname, '../public/icons');
const renders = [
  ['icon.svg', 'icon-192.png', 192],
  ['icon.svg', 'icon-512.png', 512],
  ['icon-maskable.svg', 'icon-maskable-512.png', 512],
  // iOS rounds the corners itself, so the home-screen icon uses the full-bleed artwork.
  ['icon-maskable.svg', 'apple-touch-icon.png', 180]
];
for (const [source, target, size] of renders)
  execFileSync(
    'sips',
    [
      '-s',
      'format',
      'png',
      '-z',
      String(size),
      String(size),
      path.join(icons, source),
      '--out',
      path.join(icons, target)
    ],
    {stdio: 'ignore'}
  );
console.log(renders.map(([, target, size]) => `${target} ${size}px`).join('\n'));
