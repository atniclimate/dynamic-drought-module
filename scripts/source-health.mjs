#!/usr/bin/env node
/**
 * Scheduled source-health probe (DDM-P0-T12): let the runtime issue its
 * own queries and record what came back.
 *
 * Boots the SERVED production build (--base, the Vite preview in CI) once
 * as a control (`?layers=states`, a bundled layer) to read the layer
 * catalog from the DOM and to record the AMBIENT requests every boot makes
 * regardless of the active layers (the conditions strip and minimap read
 * the North American Drought Monitor, for example). Then boots once per
 * catalog layer with `?layers=<key>&view=console` and records every
 * response from an upstream host that the control boot did not already
 * make: URL, HTTP status, content type, bytes, milliseconds, and record
 * count (parsed and discarded). Basemap tile hosts are answered with a
 * blank tile so the probe never taxes OpenStreetMap, OpenTopoMap, or the
 * GOES service; everything else goes where the runtime sends it, with a
 * named User-Agent. Surfaces are exclusive in the product, so one layer
 * per boot is also the honest per-source measurement, and no query string
 * is hand-copied into this monitor (FE-16 lesson, 2026-08-28).
 *
 * A breach (unavailable, stuck past the ceiling, an HTTP error, or no data
 * from a source that always has records) exits 1 after writing the
 * receipt; the workflow files one issue per source, with the ambient set
 * as its own row (`ambient-boot`). Bodies are read only to count records
 * and are never written (hard rule 1; src/layers/aiannh.ts).
 *
 * Usage: node scripts/source-health.mjs [--base <url>] [--layers a,b]
 *   [--out <json>] [--summary <markdown file to append>] [--ceiling-ms n]
 *   [--warn-seconds n] [--user-agent s]
 * Exit 0 with no breach, 1 with a breach, 2 on a usage error.
 */
import { appendFile, writeFile } from 'node:fs/promises';

import { chromium } from 'playwright';

import { TERMINAL_STATUSES } from './lib/live-receipts.mjs';
import {
  EXPECTS_RECORDS,
  STUBBED_HOSTS,
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
// How long to let response bodies that were still streaming at the pill's
// terminal state finish before the row is evaluated.
const BODY_GRACE_MS = 5_000;
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
const healthOptions = { ceilingMs: args.ceilingMs, warnSeconds: args.warnSeconds, expectsRecords: EXPECTS_RECORDS };

async function newContext(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent: args.userAgent });
  for (const host of STUBBED_HOSTS) {
    await context.route(`https://${host}/**`, (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: BLANK_PNG }),
    );
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

/** Record every upstream response on the page: URL, status, content type,
 * bytes, milliseconds, and record count. URLs in `skip` (the ambient set)
 * are counted, not recorded. */
function recordResponses(page, skip = new Set()) {
  const recorder = { responses: [], pending: [], shared: 0 };
  page.on('response', (response) => {
    const url = response.url();
    if (classifyUrl(url, previewOrigin) !== 'source') return;
    if (skip.has(url)) {
      recorder.shared += 1;
      return;
    }
    const timing = response.request().timing();
    recorder.pending.push(
      (async () => {
        let bytes = 0;
        let count = null;
        const contentType = response.headers()['content-type'] ?? null;
        try {
          const body = await response.body();
          bytes = body.length;
          if (contentType && /json/i.test(contentType)) count = countRecords(contentType, body.toString('utf8'));
        } catch {
          // A body that never completed (the runtime aborted at its budget)
          // stays at 0 bytes; the pill's terminal state carries the verdict.
        }
        recorder.responses.push({
          url,
          status: response.status(),
          contentType,
          bytes,
          ms: Math.max(0, Math.round(timing.responseEnd)),
          count,
        });
      })(),
    );
  });
  return recorder;
}

async function settle(page, recorder) {
  await Promise.race([Promise.allSettled(recorder.pending), page.waitForTimeout(BODY_GRACE_MS)]);
  recorder.responses.sort((a, b) => a.ms - b.ms);
}

/** Read the pill status for `key`, or null when the layer is off. */
function pillStatus(page, key) {
  return page.evaluate((k) => {
    const el = document.querySelector(`[data-layer-status="${k}"]`);
    return el ? ([...el.classList].find((c) => c !== 'layer-toggle-status') ?? null) : null;
  }, key);
}

async function waitForTerminal(page, key, row) {
  const t0 = Date.now();
  for (;;) {
    row.status = await pillStatus(page, key);
    row.settleMs = Date.now() - t0;
    if ((row.status && TERMINAL_STATUSES.has(row.status)) || row.settleMs >= args.ceilingMs) return;
    await page.waitForTimeout(500);
  }
}

function finish(row, verdict) {
  row.verdict = verdict.verdict;
  row.reasons = [...row.reasons, ...verdict.reasons];
  console.log(
    `${row.verdict.padEnd(7)} ${row.key.padEnd(22)} ${row.status ?? '(none)'} at ${row.settleMs ?? '?'} ms, ` +
      `${row.responses.length} upstream response(s)${row.shared ? `, ${row.shared} ambient` : ''}`,
  );
  return row;
}

/** The control boot: the catalog keys, the build stamp, and the ambient
 * request set as a row of its own. */
async function controlBoot(browser) {
  const context = await newContext(browser);
  const page = await context.newPage();
  const recorder = recordResponses(page);
  const url = new URL(`?layers=${CONTROL_LAYER}&view=console`, args.base).href;
  const row = { key: AMBIENT_KEY, url, status: null, settleMs: null, verdict: 'breach', reasons: [], responses: recorder.responses, shared: 0 };
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
    await waitForTerminal(page, CONTROL_LAYER, row);
    await settle(page, recorder);
  } catch (error) {
    row.reasons.push(String(error.message ?? error).slice(0, 160));
  } finally {
    await context.close();
  }
  // The ambient row has no pill of its own: the control layer is bundled,
  // so its `ready` stands for "the boot completed" and the verdict rests on
  // the HTTP outcomes and timings of what every boot fetches.
  finish(row, evaluateLayerHealth(row, healthOptions));
  return { stamp, keys, row, ambientUrls: new Set(recorder.responses.map((r) => r.url)) };
}

async function probeLayer(browser, key, ambientUrls) {
  const context = await newContext(browser);
  const page = await context.newPage();
  const recorder = recordResponses(page, ambientUrls);
  const url = new URL(`?layers=${encodeURIComponent(key)}&view=console`, args.base).href;
  const row = { key, url, status: null, settleMs: null, verdict: 'breach', reasons: [], responses: recorder.responses, shared: 0 };
  try {
    await page.goto(url, { waitUntil: 'load', timeout: BOOT_TIMEOUT_MS });
    await waitForBoot(page);
    await waitForTerminal(page, key, row);
    await settle(page, recorder);
  } catch (error) {
    row.reasons.push(String(error.message ?? error).slice(0, 160));
  } finally {
    await context.close();
  }
  row.shared = recorder.shared;
  return finish(row, evaluateLayerHealth(row, healthOptions));
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
  console.log(`build ${receipt.sha} nonce ${receipt.nonce}; probing ${wanted.length} of ${control.keys.length} catalog layers`);
  for (const key of wanted) receipt.rows.push(await probeLayer(browser, key, control.ambientUrls));
} finally {
  await browser.close();
}

await writeFile(args.out, JSON.stringify(receipt, null, 2));
const summary = renderHealthSummary(receipt.rows, { sha: receipt.sha, startedAt: receipt.startedAt });
if (args.summary) await appendFile(args.summary, summary);
console.log(`\n${summary}`);
console.log(`receipt written to ${args.out}`);
process.exit(receipt.rows.some((r) => r.verdict === 'breach') ? 1 : 0);
