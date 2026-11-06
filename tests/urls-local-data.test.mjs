import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * Every same-origin data path in src/config/urls.ts names a file that ships
 * in public/data/, so no key points at an archive removed from the tree.
 * A text match (urls.ts is not imported, so Vite's BASE_URL is not needed).
 */

test("every BASE_URL + 'data/...' path in urls.ts ships under public/data", () => {
  const source = readFileSync(new URL('../src/config/urls.ts', import.meta.url), 'utf8');
  const paths = [...source.matchAll(/BASE_URL \+ '(data\/[^']+)'/g)].map((match) => match[1]);
  assert.ok(paths.length > 0, 'no local data paths found; the pattern is stale');
  const missing = paths.filter((path) => !existsSync(new URL(`../public/${path}`, import.meta.url)));
  assert.deepEqual(missing, []);
});
