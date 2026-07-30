/**
 * Prepare Vite's static output for the Sites deployment runtime.
 *
 * The hillshade archive is intentionally omitted from this copy because the
 * source host cannot accept that single 35 MB object. Runtime code probes the
 * local URL first and then uses the verified public ATNI archive.
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

if (!existsSync(index)) {
  console.error('Sites build: dist/index.html not found; run npm run build first');
  process.exit(1);
}

rmSync(localHillshade, { force: true });
mkdirSync(serverDirectory, { recursive: true });
mkdirSync(hostingDirectory, { recursive: true });
copyFileSync('deploy/sites-server.js', join(serverDirectory, 'index.js'));
copyFileSync('.openai/hosting.json', join(hostingDirectory, 'hosting.json'));

console.log('Sites build: static entrypoint prepared; local hillshade copy omitted');
