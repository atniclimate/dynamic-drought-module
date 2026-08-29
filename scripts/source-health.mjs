#!/usr/bin/env node
/**
 * Scheduled source-health probe (DDM-P0-T12): let the runtime issue its
 * own queries and record what came back.
 *
 * Boots the SERVED production build (--base, the Vite preview in CI) once
 * as a control (`?layers=states`, a bundled layer) to read the layer
 * catalog from the DOM and to capture the AMBIENT requests every boot
 * makes regardless of the active layers (the conditions strip and minimap
 * read the North American Drought Monitor, for example). Those ambient
 * responses are kept in memory and REPLAYED to every later boot, so each
 * ambient upstream is contacted once per run, not once per layer. Then it
 * boots once per catalog layer with `?layers=<key>&view=console` and
 * records every request to an upstream host: URL, HTTP status, content
 * type, bytes, milliseconds, record count (parsed and discarded), cache
 * headers, and requests that failed without a response. Basemap tiles are
 * answered with a blank tile so the probe never taxes OpenStreetMap,
 * OpenTopoMap, or the GOES image service (its frame catalog query still
 * goes upstream, once, on the ambient row); everything else goes where the
 * runtime sends it, with a named User-Agent. Surfaces are exclusive in the
 * product, so one layer per boot is also the honest per-source
 * measurement, and no query string is hand-copied into this monitor
 * (FE-16 lesson, 2026-08-28).
 *
 * The measurement does not stop at the first terminal pill. Raster layers
 * report `ready` before a tile has loaded and let a tile watcher downgrade
 * them afterwards, so after the pill first goes terminal the probe keeps
 * observing until the pill and the network have been quiet for
 * STABILITY_QUIET_MS (at most STABILITY_MAX_MS) and records the FINAL pill
 * state as the verdict. What is measured is the default camera's
 * activation of each catalog row; zoom-gated layers, selection-driven
 * queries, and the stubbed GOES tiles are reported as not measured.
 *
 * A breach (unavailable, stuck past the ceiling, an HTTP or network error,
 * a partial or empty answer from a source that is always complete here, or
 * requests that never answered) exits 1 after writing the receipt; the
 * workflow files one issue per breaching row, with the ambient set as its
 * own row (`ambient-boot`). Bodies are read only to count records or to
 * replay the ambient set in memory and are never written (hard rule 1;
 * src/layers/aiannh.ts).
 *
 * Usage: node scripts/source-health.mjs [--base <url>] [--layers a,b]
 *   [--out <json>] [--summary <markdown file to append>] [--ceiling-ms n]
 *   [--warn-seconds n] [--warn-bytes n] [--user-agent s]
 * Exit 0 with no breach, 1 with a breach, 2 on a usage error.
 */
import { appendFile, writeFile } from 'node:fs/promises';

import { chromium } from '@playwright/test';

import { TERMINAL_STATUSES } from './lib/live-receipts.mjs';
import {
  CACHE_HEADERS,
  EXPECTS_RECORDS,
  STUBBED_HOSTS,
  STUBBED_TILE_GLOBS,
  classifyUrl,
  countRecords,
  evaluateLayerHealth,
  parseHealthArgs,
  renderHealthSummary,
} from './lib/source-health.mjs';

const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];
const BOOT_TIMEOUT_MS = 60_000;
// After the pill first goes terminal: keep observing until the pill and the
// upstream network have both been quiet this long, or the maximum passes.
const STABILITY_QUIET_MS = 2_500;
const STABILITY_MAX_MS = 10_000;
// How long to let response bodies still streaming at the end of the
// stability window finish before the row is evaluated.
const BODY_GRACE_MS = 5_000;
const CONTROL_BODY_GRACE_MS = 20_000;
// The control boot's layer: bundled, so it issues no upstream request of
// its own and everything it records is ambient.
const CONTROL_LAYER = 'states';
const AMBIENT_KEY = 'ambient-boot';
// A 1x1 transparent PNG for the stubbed basemap tiles.
const BLANK_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

let args;
try {
  args = parseHealthArgs(process.argv.slice(2));
} catch (error) {
  console.error(String(error.message ?? error));
  process.exit(2);
}
const previewOrigin = new URL(args.base).origin;
const healthOptions = {
  ceilingMs: args.ceilingMs,
  warnSeconds: args.warnSeconds,
  warnBytes: args.warnBytes,
  expectsRecords: EXPECTS_RECORDS,
};

/** A fresh context with basemaps stubbed and, when given, the ambient
 * capture replayed for its exact URLs. */
async function newContext(browser, ambient = null) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent: args.userAgent });
  const blank = (route) => route.fulfill({ status: 200, contentType: 'image/png', body: BLANK_PNG });
  for (const host of STUBBED_HOSTS) await context.route(`https://${host}/**`, blank);
  for (const glob of STUBBED_TILE_GLOBS) await context.route(glob, blank);
  if (ambient) {
    await context.route((url) => ambient.bodies.has(url.href), (route) => {
      const captured = ambient.bodies.get(route.request().url());
      return route.fulfill({ status: captured.status, headers: captured.headers, body: captured.body });
    });
  }
  return context;
}

async function waitForBoot(page) {
  await page.waitForFunction(
    () => (document.querySelector('#region-select')?.options.length ?? 0) > 0,
    null,
    { timeout: BOOT_TIMEOUT_MS },
  );
}

/**
 * Record every upstream request on the page. Responses carry URL, status,
 * content type, bytes, milliseconds, record count, and cache headers;
 * requests that end without a response are kept as failures. `capture`
 * keeps the body in memory for the ambient replay. Recording stops when
 * `recorder.stop()` is called (before the context closes, so the close
 * itself never manufactures failures).
 */
function recordResponses(page, { capture = false, skip = new Set() } = {}) {
  const recorder = {
    responses: [],
    failed: [],
    requests: 0,
    requestUrls: new Set(),
    shared: 0,
    pending: [],
    lastEventAt: Date.now(),
    bodies: new Map(),
    active: true,
    stop() {
      this.active = false;
    },
  };
  const isSource = (url) => classifyUrl(url, previewOrigin) === 'source';
  const isAmbient = (url) => skip.has(url);
  page.on('request', (request) => {
    if (!recorder.active || !isSource(request.url()) || isAmbient(request.url())) return;
    recorder.requests += 1;
    recorder.requestUrls.add(request.url());
    recorder.lastEventAt = Date.now();
  });
  page.on('requestfailed', (request) => {
    if (!recorder.active || !isSource(request.url()) || isAmbient(request.url())) return;
    recorder.failed.push({ url: request.url(), failure: request.failure()?.errorText ?? 'unknown' });
    recorder.lastEventAt = Date.now();
  });
  page.on('response', (response) => {
    const url = response.url();
    if (!recorder.active || !isSource(url)) return;
    if (isAmbient(url)) {
      // An ambient URL the control boot requested but could not capture
      // for replay went upstream again; it belongs to the control's row,
      // not this layer's, so it is counted as shared and left unrecorded.
      recorder.shared += 1;
      return;
    }
    recorder.lastEventAt = Date.now();
    const timing = response.request().timing();
    const headers = response.headers();
    const cache = {};
    for (const name of CACHE_HEADERS) if (headers[name]) cache[name] = headers[name];
    recorder.pending.push(
      (async () => {
        let bytes = 0;
        let count = null;
        const contentType = headers['content-type'] ?? null;
        try {
          const body = await response.body();
          bytes = body.length;
          if (contentType && /json/i.test(contentType)) count = countRecords(contentType, body.toString('utf8'));
          if (capture) {
            recorder.bodies.set(url, { status: response.status(), headers: { 'content-type': contentType ?? 'application/octet-stream' }, body });
          }
        } catch {
          // A body that never completed (the runtime aborted at its budget)
          // stays at 0 bytes; the pill's terminal state carries the verdict.
        }
        // A body that completes after the row was judged (the context is
        // closing) must not change the receipt the verdict was made from.
        if (!recorder.active) return;
        recorder.responses.push({
          url,
          status: response.status(),
          contentType,
          bytes,
          ms: Math.max(0, Math.round(timing.responseEnd)),
          count,
          cache,
        });
        recorder.lastEventAt = Date.now();
      })(),
    );
  });
  return recorder;
}

/** Read the pill status for `key`, or null when the layer is off. */
function pillStatus(page, key) {
  return page.evaluate((k) => {
    const el = document.querySelector(`[data-layer-status="${k}"]`);
    return el ? ([...el.classList].find((c) => c !== 'layer-toggle-status') ?? null) : null;
  }, key);
}

/** Wait for the first terminal pill (or the ceiling), then hold a
 * stability window and record the final pill state. */
async function observeLayer(page, key, row, recorder) {
  const t0 = Date.now();
  for (;;) {
    row.status = await pillStatus(page, key);
    row.settleMs = Date.now() - t0;
    if ((row.status && TERMINAL_STATUSES.has(row.status)) || row.settleMs >= args.ceilingMs) break;
    await page.waitForTimeout(500);
  }
  const firstTerminal = row.status;
  let lastPillChangeAt = Date.now();
  const windowStart = Date.now();
  let current = firstTerminal;
  for (;;) {
    await page.waitForTimeout(500);
    const now = await pillStatus(page, key);
    if (now !== current) {
      current = now;
      lastPillChangeAt = Date.now();
    }
    const quietFor = Date.now() - Math.max(lastPillChangeAt, recorder.lastEventAt);
    if (quietFor >= STABILITY_QUIET_MS || Date.now() - windowStart >= STABILITY_MAX_MS) break;
  }
  if (current !== firstTerminal) {
    row.finalStatus = current;
    row.status = current;
  }
  row.stabilityMs = Date.now() - windowStart;
}

async function settle(page, recorder, graceMs = BODY_GRACE_MS) {
  await Promise.race([Promise.allSettled([...recorder.pending]), page.waitForTimeout(graceMs)]);
  recorder.stop();
  recorder.responses.sort((a, b) => a.ms - b.ms);
}

function finish(row, recorder) {
  row.responses = recorder.responses;
  row.failed = recorder.failed;
  row.requests = recorder.requests;
  row.shared = recorder.shared;
  const verdict = evaluateLayerHealth(row, healthOptions);
  row.verdict = verdict.verdict;
  row.reasons = [...row.reasons, ...verdict.reasons];
  console.log(
    `${row.verdict.padEnd(7)} ${row.key.padEnd(22)} ${row.status ?? '(none)'} at ${row.settleMs ?? '?'} ms` +
      `${row.finalStatus ? ` (moved to ${row.finalStatus} during the window)` : ''}, ` +
      `${row.requests} request(s), ${row.responses.length} response(s), ${row.failed.length} failed` +
      `${row.shared ? `, ${row.shared} ambient replayed` : ''}`,
  );
  return row;
}

/** The control boot: the catalog keys, the build stamp, the ambient request
 * set as a row of its own, and the captured ambient bodies for replay. */
async function controlBoot(browser) {
  const context = await newContext(browser);
  const page = await context.newPage();
  const recorder = recordResponses(page, { capture: true });
  const url = new URL(`?layers=${CONTROL_LAYER}&view=console`, args.base).href;
  const row = { key: AMBIENT_KEY, url, status: null, settleMs: null, verdict: 'breach', reasons: [], responses: [] };
  let stamp = {};
  let keys = [];
  try {
    await page.goto(url, { waitUntil: 'load', timeout: BOOT_TIMEOUT_MS });
    await waitForBoot(page);
    await page.waitForFunction(() => document.querySelector('input[data-layer-key]') !== null, null, { timeout: BOOT_TIMEOUT_MS });
    stamp = await page.evaluate(() => ({
      sha: document.documentElement.dataset.ddmBuildSha,
      nonce: document.documentElement.dataset.ddmBuildNonce,
    }));
    keys = await page.evaluate(() =>
      [...document.querySelectorAll('input[data-layer-key]')].map((el) => el.getAttribute('data-layer-key')),
    );
    await observeLayer(page, CONTROL_LAYER, row, recorder);
    // The control boot waits longer for bodies: everything it captures is
    // replayed to every later boot, and an ambient body still streaming
    // here would otherwise be fetched upstream again by each layer boot.
    await settle(page, recorder, CONTROL_BODY_GRACE_MS);
  } catch (error) {
    row.reasons.push(String(error.message ?? error).slice(0, 160));
  } finally {
    recorder.stop();
    await context.close();
  }
  // The ambient row has no pill of its own: the control layer is bundled,
  // so its `ready` stands for "the boot completed" and the verdict rests on
  // the HTTP outcomes, timings, and failures of what every boot fetches.
  finish(row, recorder);
  return { stamp, keys, row, ambient: { urls: recorder.requestUrls, bodies: recorder.bodies } };
}

async function probeLayer(browser, key, ambient) {
  const context = await newContext(browser, ambient);
  const page = await context.newPage();
  const recorder = recordResponses(page, { skip: ambient.urls });
  const url = new URL(`?layers=${encodeURIComponent(key)}&view=console`, args.base).href;
  const row = { key, url, status: null, settleMs: null, verdict: 'breach', reasons: [], responses: [] };
  try {
    await page.goto(url, { waitUntil: 'load', timeout: BOOT_TIMEOUT_MS });
    await waitForBoot(page);
    await observeLayer(page, key, row, recorder);
    await settle(page, recorder);
  } catch (error) {
    row.reasons.push(String(error.message ?? error).slice(0, 160));
  } finally {
    recorder.stop();
    await context.close();
  }
  // Ambient responses (replayed from the capture, or fetched again when the
  // control could not capture them) were counted as shared by the recorder.
  return finish(row, recorder);
}

const browser = await chromium.launch({ headless: true, args: CHROMIUM_ARGS });
const receipt = { base: args.base, sha: null, nonce: null, startedAt: new Date().toISOString(), rows: [] };
try {
  const control = await controlBoot(browser);
  receipt.sha = control.stamp.sha ?? null;
  receipt.nonce = control.stamp.nonce ?? null;
  receipt.rows.push(control.row);
  const missing = (args.layers ?? []).filter((k) => !control.keys.includes(k));
  if (missing.length) throw new Error(`unknown layer key(s): ${missing.join(', ')}`);
  const wanted = args.layers ? control.keys.filter((k) => args.layers.includes(k)) : control.keys;
  console.log(
    `build ${receipt.sha} nonce ${receipt.nonce}; ${control.ambient.bodies.size} of ${control.ambient.urls.size} ambient request(s) captured for replay; ` +
      `probing ${wanted.length} of ${control.keys.length} catalog layers`,
  );
  await writeFile(args.out, JSON.stringify(receipt, null, 2));
  for (const key of wanted) {
    receipt.rows.push(await probeLayer(browser, key, control.ambient));
    // Written after every row so a step timeout still leaves the receipt
    // for the rows that finished.
    await writeFile(args.out, JSON.stringify(receipt, null, 2));
  }
} finally {
  await browser.close();
}

await writeFile(args.out, JSON.stringify(receipt, null, 2));
const summary = renderHealthSummary(receipt.rows, { sha: receipt.sha, startedAt: receipt.startedAt });
if (args.summary) await appendFile(args.summary, summary);
console.log(`\n${summary}`);
console.log(`receipt written to ${args.out}`);
process.exit(receipt.rows.some((r) => r.verdict === 'breach') ? 1 : 0);
