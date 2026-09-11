/**
 * DDM-P1-T04: src/util/chunk-retry.ts pins the retry-under-a-new-URL logic
 * a lazy chunk loader needs, since a failed dynamic `import()` is cached in
 * the browser's module map and a second `import()` of the identical URL
 * rejects with no new request (director, Chromium 149.0.7827.55).
 *
 * Runs under `node --test`, importing the TypeScript source directly (node
 * strips types), same pattern as tests/fetch-budget.test.mjs.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chunkPathFromImporter,
  failedChunkUrl,
  withRetryQuery,
  createChunkLoader
} from '../src/util/chunk-retry.ts';

test('chunkPathFromImporter reads a minified built importer using backticks', () => {
  const importer = new Function('return import(`./island-Cv_ZPl0o.js`)');
  assert.equal(chunkPathFromImporter(importer), './island-Cv_ZPl0o.js');
});

test('chunkPathFromImporter reads a single-quoted importer', () => {
  const importer = () => import('./search-controller');
  assert.equal(chunkPathFromImporter(importer), './search-controller');
});

test('chunkPathFromImporter reads a double-quoted importer', () => {
  const importer = new Function('return import("./island/layers-studio")');
  assert.equal(chunkPathFromImporter(importer), './island/layers-studio');
});

test('chunkPathFromImporter returns null when the source holds no import(...)', () => {
  const importer = () => Promise.resolve(null);
  assert.equal(chunkPathFromImporter(importer), null);
});

test('failedChunkUrl reads Chromium\'s dynamic-import failure message', () => {
  const err = new Error(
    'TypeError: Failed to fetch dynamically imported module: https://example.com/assets/island-abc123.js'
  );
  assert.equal(failedChunkUrl(err), 'https://example.com/assets/island-abc123.js');
});

test('failedChunkUrl reads Firefox\'s dynamic-import failure message', () => {
  const err = new Error(
    'error loading dynamically imported module: https://example.com/assets/search-controller-xyz.js'
  );
  assert.equal(failedChunkUrl(err), 'https://example.com/assets/search-controller-xyz.js');
});

test('failedChunkUrl returns null for a Safari-style message naming no URL', () => {
  const err = new Error('Importing a module script failed.');
  assert.equal(failedChunkUrl(err), null);
});

test('failedChunkUrl strips an existing query string from the named URL', () => {
  const err = new Error(
    'Failed to fetch dynamically imported module: https://example.com/assets/island-abc123.js?retry=1'
  );
  assert.equal(failedChunkUrl(err), 'https://example.com/assets/island-abc123.js');
});

test('withRetryQuery sets retry on a URL with no existing query', () => {
  assert.equal(
    withRetryQuery('https://example.com/assets/island-abc123.js', 1),
    'https://example.com/assets/island-abc123.js?retry=1'
  );
});

test('withRetryQuery replaces an existing retry value and keeps other params', () => {
  const url = 'https://example.com/assets/island-abc123.js?retry=1&keep=me';
  const next = withRetryQuery(url, 2);
  const parsed = new URL(next);
  assert.equal(parsed.searchParams.get('retry'), '2');
  assert.equal(parsed.searchParams.get('keep'), 'me');
});

test('createChunkLoader calls the importer first, then retries under a new URL per rejection', async () => {
  const importerCalls = [];
  const importUrlCalls = [];

  // No literal import(...) in this importer's own source, so the loader
  // must fall back to reading the URL out of the engine's own error
  // message (failedChunkUrl) instead of chunkPathFromImporter.
  let failuresLeft = 2;
  const loader = createChunkLoader(
    () => {
      importerCalls.push(true);
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        return Promise.reject(
          new Error(
            'Failed to fetch dynamically imported module: https://example.com/assets/island-abc123.js'
          )
        );
      }
      return Promise.resolve({ ok: true });
    },
    'https://example.com/assets/sidebar.js',
    (url) => {
      importUrlCalls.push(url);
      if (importUrlCalls.length === 1) {
        return Promise.reject(new Error('retry 1 failed'));
      }
      return Promise.resolve({ ok: true, url });
    }
  );

  await assert.rejects(
    loader(),
    /Failed to fetch dynamically imported module/
  );
  assert.equal(importerCalls.length, 1);

  await assert.rejects(loader(), /retry 1 failed/);
  assert.equal(importUrlCalls.length, 1);
  assert.equal(importUrlCalls[0], 'https://example.com/assets/island-abc123.js?retry=1');

  const result = await loader();
  assert.equal(importUrlCalls.length, 2);
  assert.equal(importUrlCalls[1], 'https://example.com/assets/island-abc123.js?retry=2');
  assert.deepEqual(result, { ok: true, url: 'https://example.com/assets/island-abc123.js?retry=2' });
});

test('createChunkLoader records the URL from the importer source, resolved against base', async () => {
  const importUrlCalls = [];
  // A plain (non-bound) arrow function so Function.prototype.toString
  // returns real source text. The import(...) branch is never reached
  // (the loader never evaluates it), matching the production case where a
  // failed first attempt never evaluated the chunk it names.
  let shouldFail = true;
  const realImporter = () => {
    if (shouldFail) {
      shouldFail = false;
      return Promise.reject(new Error('boom'));
    }
    return import('./search-controller.js');
  };

  const loader = createChunkLoader(
    realImporter,
    'https://example.com/assets/sidebar.js',
    (url) => {
      importUrlCalls.push(url);
      return Promise.resolve({ ok: true });
    }
  );

  await assert.rejects(loader(), /boom/);
  await loader();
  assert.equal(importUrlCalls.length, 1);
  assert.equal(importUrlCalls[0], 'https://example.com/assets/search-controller.js?retry=1');
});

test('createChunkLoader falls back to the importer again when no URL can be derived', async () => {
  let calls = 0;
  const importer = () => {
    calls += 1;
    if (calls === 1) return Promise.reject(new Error('no url in this message'));
    return Promise.resolve({ ok: true, calls });
  };
  const loader = createChunkLoader(importer, 'https://example.com/assets/sidebar.js', () => {
    throw new Error('importUrl should never be called when no URL was recorded');
  });

  await assert.rejects(loader(), /no url in this message/);
  const result = await loader();
  assert.equal(calls, 2);
  assert.deepEqual(result, { ok: true, calls: 2 });
});
