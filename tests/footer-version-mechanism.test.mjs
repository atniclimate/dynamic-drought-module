import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * found-028 / DDM-P0-T14: pins the build-time-only mechanism without a
 * browser. index.html must carry no version literal in its footer (the
 * version text is written at boot by src/main.ts from the __DDM_VERSION__
 * constant vite.config.ts defines from package.json's own field), so a
 * version bump never needs a second, hand-maintained edit here.
 */

const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const viteConfig = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
const mainTs = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('index.html carries no hard-coded semver literal in the sidebar footer', () => {
  const footerMatch = indexHtml.match(/<footer class="sidebar-footer">[\s\S]*?<\/footer>/);
  assert.ok(footerMatch, 'the sidebar footer element exists');
  assert.doesNotMatch(
    footerMatch[0],
    /v\d+\.\d+\.\d+/,
    'the footer element must hold no version literal; it is written at boot from __DDM_VERSION__'
  );
  assert.match(
    footerMatch[0],
    /id="footer-version"/,
    'the footer carries the element src/main.ts fills at boot'
  );
});

test('vite.config.ts defines __DDM_VERSION__ from package.json, not a duplicated literal', () => {
  assert.match(viteConfig, /__DDM_VERSION__/, 'vite.config.ts defines the version constant');
  assert.match(
    viteConfig,
    /pkg\.version/,
    'the define reads package.json\'s own version field rather than restating it'
  );
});

test('src/main.ts stamps #footer-version from __DDM_VERSION__ at boot, never a runtime fetch', () => {
  assert.match(mainTs, /__DDM_VERSION__/, 'boot() reads the build-time version constant');
  assert.match(mainTs, /footer-version/, 'boot() targets the footer element by id');
  assert.doesNotMatch(
    mainTs,
    /fetch\(['"`][^'"`]*package\.json/,
    'the version is never fetched from package.json at runtime'
  );
});

test('package.json exposes a plain semver for the build-time define to read', () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'package.json.version is a plain semver string');
});
