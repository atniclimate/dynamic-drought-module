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
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// src/util/chunk-stylesheets.ts imports './chunk-retry' the bundler's way
// (no extension); resolve that to the TypeScript source, as
// tests/fire3d-phone.test.mjs does.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith('.') &&
      !/\.[a-z]+$/i.test(specifier) &&
      typeof context.parentURL === 'string' &&
      context.parentURL.endsWith('.ts') &&
      existsSync(fileURLToPath(new URL(`${specifier}.ts`, context.parentURL)))
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  }
});

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

// The sprint's lazy doors that ask again after a failure (owner direction
// 2026-11-09 (sprint), DR-pending). A plain second import() of a failed chunk
// replays the failure with no request, so each must load through
// createChunkLoader. Seen on the sprint camera: Locate and the sheet's motion
// module never recovered, and the ENSO guide never asked again. A door whose
// chunk carries stylesheets also asks for its failed stylesheets before the
// retry (the retry imports the module alone): seen on the camera, the Locate
// card, the 3D card and the ENSO guide drew unstyled after a failed stylesheet.
const DOORS = [
  { file: '../src/ui/locate-control.ts', chunk: './locate-runtime', stylesheets: true },
  { file: '../src/ui/mobile-sheet.ts', chunk: './sheet-motion', stylesheets: false },
  { file: '../src/ui/enso-chain-loader.ts', chunk: './enso-chain', stylesheets: true },
  { file: '../src/ui/fire3d-phone.ts', chunk: './fire3d-phone-scene', stylesheets: true },
  // The ENSO guide's place links promise a read the next time the panel shows (R2-3).
  { file: '../src/ui/enso-chain.ts', chunk: '../impact/sources', stylesheets: false }
];

test('the sprint lazy doors that retry load through createChunkLoader', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const { file, chunk, stylesheets } of DOORS) {
    const text = await readFile(new URL(file, import.meta.url), 'utf8');
    const path = chunk.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    const loads = text.match(new RegExp(`(?<!typeof )import\\('${path}'\\)`, 'g')) ?? [];
    const tail = stylesheets ? ',\\s*undefined,\\s*askAgainForStylesheets\\s*' : '\\s*';
    const wrapped =
      text.match(
        new RegExp(`createChunkLoader\\(\\s*\\(\\) => import\\('${path}'\\),\\s*import\\.meta\\.url${tail}\\)`, 'g')
      ) ?? [];
    assert.equal(loads.length, 1, `${file} loads ${chunk} in one place`);
    assert.equal(
      wrapped.length,
      1,
      `${file} loads ${chunk} through createChunkLoader${stylesheets ? ', asking for its stylesheets first' : ''}`
    );
  }
});

// NO STYLESHEET, NO CHROME: each door's chunk reads its stylesheet's mark
// before it draws anything, and the stylesheet sets that mark on #app.
test('each stylesheet door refuses to draw without its own stylesheet', async () => {
  const { readFile } = await import('node:fs/promises');
  const marks = [
    ['../src/ui/locate-runtime.ts', 'createLocate', '../src/styles/locate.css', '--ddm-locate-css'],
    ['../src/ui/fire3d-phone-scene.ts', 'createFire3DPhoneScene', '../src/styles/fire3d-phone.css', '--ddm-fire3d-phone-css'],
    ['../src/ui/enso-chain.ts', 'mountEnsoChain', '../src/styles/enso-chain.css', '--ddm-enso-chain-css']
  ];
  for (const [file, factory, sheet, property] of marks) {
    const text = await readFile(new URL(file, import.meta.url), 'utf8');
    const body = text.slice(text.indexOf(`export function ${factory}(`));
    const check = body.indexOf(`requireStylesheetMark(app, '${property}',`);
    assert.ok(check > 0, `${factory} checks ${property}`);
    const firstDraw = Math.min(
      ...[/createElement\(/, /\bel\(/, /appendChild\(/, /\.append\(/]
        .map((re) => body.search(re))
        .filter((index) => index >= 0)
    );
    assert.ok(check < firstDraw, `${factory} checks its stylesheet before it draws`);
    const css = await readFile(new URL(sheet, import.meta.url), 'utf8');
    assert.match(css, new RegExp(`#app \\{\\s*${property}: 1;\\s*\\}`), `${sheet} marks #app with ${property}`);
  }
});

test('createChunkLoader skips beforeRetry on the first call, and runs it before the importer when no URL was recorded', async () => {
  const order = [];
  let calls = 0;
  const loader = createChunkLoader(
    () => {
      calls += 1;
      order.push('importer');
      return calls === 1 ? Promise.reject(new Error('no url here')) : Promise.resolve({ ok: true });
    },
    'https://example.test/assets/index.js',
    () => {
      throw new Error('importUrl must not run without a recorded URL');
    },
    async (attempt) => {
      order.push(`before ${attempt}`);
    }
  );
  await assert.rejects(loader(), /no url here/);
  assert.deepEqual(order, ['importer']);
  assert.deepEqual(await loader(), { ok: true });
  assert.deepEqual(order, ['importer', 'before 1', 'importer']);
});

test('createChunkLoader asks beforeRetry before each retry under the same attempt number', async () => {
  const order = [];
  let failures = 1;
  const loader = createChunkLoader(
    new Function('return import(`./door-Ab12Cd34.js`)'),
    'https://example.test/assets/index.js',
    (url) => {
      order.push(`import ${new URL(url).search}`);
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(new Error('retry failed'));
      }
      return Promise.resolve({ ok: true });
    },
    async (attempt) => {
      order.push(`before ${attempt}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`before ${attempt} done`);
    }
  );
  await assert.rejects(loader());
  assert.deepEqual(order, [], 'the first call runs the importer alone');
  await assert.rejects(loader(), /retry failed/);
  assert.deepEqual(order, ['before 1', 'before 1 done', 'import ?retry=1']);
  assert.deepEqual(await loader(), { ok: true });
  assert.deepEqual(order.slice(3), ['before 2', 'before 2 done', 'import ?retry=2']);
});

test('createChunkLoader counts a beforeRetry rejection as a failed attempt and does not import', async () => {
  const order = [];
  let refuse = true;
  const loader = createChunkLoader(
    new Function('return import(`./door-Ab12Cd34.js`)'),
    'https://example.test/assets/index.js',
    (url) => {
      order.push(`import ${new URL(url).search}`);
      return Promise.resolve({ ok: true });
    },
    (attempt) => {
      order.push(`before ${attempt}`);
      if (refuse) {
        refuse = false;
        return Promise.reject(new Error('stylesheet failed again'));
      }
      return Promise.resolve();
    }
  );
  await assert.rejects(loader());
  await assert.rejects(loader(), /stylesheet failed again/);
  assert.deepEqual(order, ['before 1']);
  assert.deepEqual(await loader(), { ok: true });
  assert.deepEqual(order, ['before 1', 'before 2', 'import ?retry=2']);
});

test('askAgainForStylesheets re-points only failed stylesheet links and waits for them', async () => {
  const { askAgainForStylesheets } = await import('../src/util/chunk-stylesheets.ts');
  const link = (href, sheet) => {
    const listeners = { load: [], error: [] };
    return {
      href,
      sheet,
      addEventListener: (type, fn) => listeners[type].push(fn),
      removeEventListener: (type, fn) => {
        listeners[type] = listeners[type].filter((other) => other !== fn);
      },
      fire: (type) => {
        for (const fn of [...listeners[type]]) fn();
      },
      listeners
    };
  };
  const loaded = link('https://example.test/assets/index-A.css', { cssRules: { length: 40 } });
  const emptied = link('https://example.test/assets/locate-runtime-B.css', { cssRules: { length: 0 } });
  const missing = link('https://example.test/assets/enso-chain-C.css?retry=1', null);
  const hidden = { get cssRules() { throw new Error('SecurityError'); } };
  // Chromium keeps a failed sheet whose rules cannot be read (sprint camera).
  const unreadable = link('https://example.test/assets/fire3d-phone-scene-E.css', hidden);
  // A sheet from another origin hides its rules even when it loaded.
  const foreign = link('https://fonts.example.test/x.css', hidden);
  const previous = globalThis.document;
  const previousLocation = globalThis.location;
  globalThis.location = { origin: 'https://example.test', href: 'https://example.test/' };
  globalThis.document = { querySelectorAll: () => [loaded, emptied, missing, unreadable, foreign] };
  try {
    let settled = false;
    const asked = askAgainForStylesheets(2).then(() => {
      settled = true;
    });
    assert.equal(loaded.href, 'https://example.test/assets/index-A.css');
    assert.equal(foreign.href, 'https://fonts.example.test/x.css');
    assert.equal(emptied.href, 'https://example.test/assets/locate-runtime-B.css?retry=2');
    assert.equal(missing.href, 'https://example.test/assets/enso-chain-C.css?retry=2');
    assert.equal(unreadable.href, 'https://example.test/assets/fire3d-phone-scene-E.css?retry=2');
    emptied.fire('load');
    missing.fire('load');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(settled, false, 'it waits for every link it asked again');
    unreadable.fire('load');
    await asked;
    assert.equal(settled, true);
    assert.equal(emptied.listeners.load.length + emptied.listeners.error.length, 0, 'listeners removed');

    const again = link('https://example.test/assets/fire3d-phone-scene-D.css', null);
    globalThis.document = { querySelectorAll: () => [again] };
    const refused = askAgainForStylesheets(1);
    again.fire('error');
    await assert.rejects(refused, /fire3d-phone-scene-D\.css\?retry=1 did not load/);
  } finally {
    globalThis.document = previous;
    globalThis.location = previousLocation;
  }
});

test('askAgainForStylesheets resolves at once with no document', async () => {
  const { askAgainForStylesheets } = await import('../src/util/chunk-stylesheets.ts');
  const previous = globalThis.document;
  delete globalThis.document;
  try {
    await askAgainForStylesheets(1);
  } finally {
    if (previous !== undefined) globalThis.document = previous;
  }
});
