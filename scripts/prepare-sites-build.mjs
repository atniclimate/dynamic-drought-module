/**
 * Prepare Vite's static output for the Sites deployment runtime.
 *
 * Deployment source omits the hillshade archive because the source host cannot
 * accept that single 35 MB object. `build:sites` applies the same omission to a
 * local artifact. Runtime code probes locally before using the verified public
 * ATNI archive.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';

const dist = 'dist';
const index = join(dist, 'index.html');
const localHillshade = join(dist, 'data', 'hillshade-dem-pnw.pmtiles');
const serverDirectory = join(dist, 'server');
const hostingDirectory = join(dist, '.openai');
const omitLocalHillshade = process.argv.includes('--omit-local-hillshade');

if (!existsSync(index)) {
  console.error('Sites build: dist/index.html not found; run npm run build first');
  process.exit(1);
}

if (omitLocalHillshade) {
  rmSync(localHillshade, { force: true });
}
mkdirSync(serverDirectory, { recursive: true });
mkdirSync(hostingDirectory, { recursive: true });
copyFileSync('deploy/sites-server.js', join(serverDirectory, 'index.js'));
copyFileSync('.openai/hosting.json', join(hostingDirectory, 'hosting.json'));

console.log(
  `Sites build: static entrypoint prepared; local hillshade copy ${
    omitLocalHillshade ? 'omitted' : 'preserved'
  }`,
);
