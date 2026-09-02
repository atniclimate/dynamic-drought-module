#!/usr/bin/env node
/**
 * Post-deploy verification of the live Pages build (DDM-P0-T04, DDM-P0-T08).
 *
 * Proves, against the site at --base (default: the public Pages seat):
 *
 *   1. propagation: an entry asset index.html references contains the
 *      expected build SHA, polled up to --settle-ms because the Pages CDN
 *      can serve the previous build for a short while after deploy-pages
 *      returns;
 *   2. seat: every script, modulepreload, and stylesheet index.html
 *      references resolves 200 relative to the base (the subpath contract:
 *      the repository seat mounts the artifact beneath its name);
 *   3. range: each PMTiles archive shipped from public/data answers a
 *      16 KiB byte-range request with 206 and a Content-Range from byte 0
 *      whose TOTAL equals the size of that file in the checked-out commit,
 *      so a stale or truncated archive at the same stable path cannot pass
 *      a self-consistent range answer off as the shipped one;
 *   4. boots: root (default drought cluster), the wildfire, heat, and enso
 *      clusters, and the wildfire embed at 1280x800 and 390x844 carry the
 *      expected data-ddm-build-sha and a data-ddm-build-nonce from the
 *      accepted set, raise no page errors, and show a status pill for
 *      EVERY layer that boot's URL activates (EXPECTED_BOOT_LAYERS in
 *      ./lib/live-receipts.mjs), each reaching a terminal status inside
 *      --ceiling-ms, still terminal after a stability window, and still
 *      present at the end. An upstream `unavailable` is a warning, because
 *      the runtime enforces each layer's own budget and reports the
 *      terminal state honestly; it is a failure when EVERY active layer is
 *      unavailable, or when a layer that was `ready` in --previous (a
 *      receipt for the same base) is unavailable now. The embed boots also
 *      prove the satellite switcher is the top hit at its own center and
 *      that the map-information button, which since PR 54 (2026-08-31) is
 *      the embed's credits surface, is present and is the top hit at its
 *      own center, with the removed attribution control absent.
 *
 * Receipts hold URLs, HTTP status, bytes, milliseconds, and status words.
 * No screenshot, trace, or response body is written (hard rule 1: an
 * ordinary boot fetches live AIANNH and BIA geometry that the runtime keeps
 * in memory; see src/layers/aiannh.ts). Read-only against the site. The
 * browser is Playwright's Chromium with the software-GL flags the suite
 * uses (playwright.config.ts).
 *
 * --light runs 1, 2, and 3 plus the build stamp read straight out of the
 * shipped script, and skips the six boots. It needs no browser and no
 * node_modules, which is what makes a daily scheduled compare cheap; the
 * deep proof runs after a deploy, on dispatch, and on any scheduled light
 * mismatch. What the daily light run gives up is in the header of
 * .github/workflows/verify-live.yml.
 *
 * Usage: node scripts/verify-live.mjs --expect-sha <sha> --expect-nonce <run id[,run id...]>
 *   [--light] [--base <url>] [--out <json>] [--summary <markdown file to append>]
 *   [--previous <earlier receipt json>]
 *   [--settle-ms n] [--interval-ms n] [--ceiling-ms n]
 * Exit 0 when every check passed, 1 when any failed, 2 on a usage error.
 */
import { appendFile, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXPECTED_BOOT_LAYERS,
  TERMINAL_STATUSES,
  evaluateAssets,
  evaluateEmbedCorner,
  evaluateLayers,
  evaluateRange,
  evaluateStamp,
  extractStamp,
  parseArgs,
  receiptOk,
  renderSummary,
} from './lib/live-receipts.mjs';

// Playwright is imported inside checkBoots, not here: --light runs with no
// browser and no node_modules at all, so a scheduled compare costs an
// HTTP conversation rather than an npm install and a Chromium provision.

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DATA = join(__dirname, '..', 'public', 'data');
const FETCH_TIMEOUT_MS = 30_000;
const BOOT_TIMEOUT_MS = 60_000;
const RANGE_BYTES = 16_384;
// After every pill is terminal, how long to wait before re-reading them for
// the final state (a tile watcher can downgrade a raster layer's `ready`).
const STABILITY_MS = 4_000;
const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(String(error.message ?? error));
  process.exit(2);
}

const receipt = {
  base: args.base,
  mode: args.light ? 'light' : 'deep',
  expectSha: args.expectSha,
  expectNonce: args.expectNonce,
  expectNonces: args.expectNonces,
  startedAt: new Date().toISOString(),
  propagationMs: null,
  checks: [],
  assets: [],
  assetStamp: null,
  ranges: [],
  cache: {},
  boots: [],
};

function record(name, verdict) {
  receipt.checks.push({
    name,
    ok: verdict.ok,
    reasons: verdict.reasons,
    warnings: verdict.warnings ?? [],
    ...(verdict.matchedNonce ? { matchedNonce: verdict.matchedNonce } : {}),
  });
  const detail = verdict.reasons.length ? `: ${verdict.reasons.join('; ')}` : '';
  console.log(`${verdict.ok ? 'pass' : 'FAIL'} ${name}${detail}`);
}

/**
 * The layer statuses an earlier receipt recorded, per boot, when one was
 * supplied AND it describes the same site. A receipt from another base
 * says nothing about this one, and no receipt at all means the
 * ready-to-unavailable comparison cannot be made: both are recorded as a
 * check with a warning rather than passing silently.
 */
async function loadPreviousStatuses() {
  if (!args.previous) {
    record('layers:previous-receipt', {
      ok: true,
      reasons: [],
      warnings: ['no previous receipt was supplied, so the ready-to-unavailable comparison was skipped'],
    });
    return null;
  }
  let previous;
  try {
    previous = JSON.parse(await readFile(args.previous, 'utf8'));
  } catch (error) {
    record('layers:previous-receipt', {
      ok: true,
      reasons: [],
      warnings: [`previous receipt ${args.previous} could not be read (${String(error.message ?? error).slice(0, 120)}), so the ready-to-unavailable comparison was skipped`],
    });
    return null;
  }
  if (previous?.base !== args.base) {
    record('layers:previous-receipt', {
      ok: true,
      reasons: [],
      warnings: [`previous receipt describes ${previous?.base ?? 'no base'}, not ${args.base}, so the ready-to-unavailable comparison was skipped`],
    });
    return null;
  }
  const byBoot = new Map();
  for (const boot of previous.boots ?? []) {
    byBoot.set(boot.name, Object.fromEntries((boot.layers ?? []).map((l) => [l.key, l.status])));
  }
  record('layers:previous-receipt', {
    ok: true,
    reasons: [],
    warnings: [`comparing layer health against the receipt started ${previous.startedAt ?? 'at an unrecorded time'} for the same base`],
  });
  return byBoot;
}

async function get(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { cache: 'no-store', redirect: 'follow', signal: controller.signal, ...init });
  } finally {
    clearTimeout(timer);
  }
}

function cacheHeaders(res) {
  return {
    status: res.status,
    cacheControl: res.headers.get('cache-control'),
    etag: res.headers.get('etag'),
    age: res.headers.get('age'),
    lastModified: res.headers.get('last-modified'),
  };
}

/** Relative asset URLs index.html references: module scripts, modulepreloads, stylesheets. */
function assetUrls(html, base) {
  const urls = new Set();
  const re = /<(?:script[^>]*\ssrc|link[^>]*\shref)="([^"]+)"/g;
  for (const m of html.matchAll(re)) {
    const href = m[1];
    if (/^(https?:)?\/\//.test(href) || href.startsWith('data:')) continue;
    urls.add(new URL(href, base).href);
  }
  return [...urls];
}

/**
 * One Pages snapshot: index.html and every asset it references. A
 * JavaScript asset is downloaded (only script can carry the compile-time
 * stamp) and measured in UTF-8 bytes; every other asset is HEAD-checked.
 * The snapshot is retried as a whole until the SHA is present AND every
 * asset answers 200, or the grace period ends, so a stylesheet that is
 * still propagating cannot fail a good deploy early.
 */
async function pagesSnapshot() {
  const rows = [];
  let found = !args.expectSha;
  const stamp = { sha: null, nonce: null };
  const res = await get(args.base);
  const html = await res.text();
  receipt.cache.index = { url: args.base, ...cacheHeaders(res) };
  for (const url of assetUrls(html, args.base)) {
    if (url.endsWith('.js')) {
      const r = await get(url);
      const body = await r.text();
      rows.push({ url, status: r.status, bytes: Buffer.byteLength(body, 'utf8') });
      if (args.expectSha && body.includes(args.expectSha)) found = true;
      // The same two literals the boots read from <html>, taken straight
      // from the shipped script so the light check can name the live nonce
      // without a browser.
      const carried = extractStamp(body);
      stamp.sha = stamp.sha ?? carried.sha;
      stamp.nonce = stamp.nonce ?? carried.nonce;
      if (!receipt.cache.entry) receipt.cache.entry = { url, ...cacheHeaders(r) };
    } else {
      const r = await get(url, { method: 'HEAD' });
      rows.push({ url, status: r.status, bytes: Number(r.headers.get('content-length') ?? 0) });
    }
  }
  return { rows, found, stamp };
}

async function checkPropagationAndSeat() {
  const t0 = Date.now();
  const deadline = t0 + args.settleMs;
  let propagation = [];
  let seat = { ok: false, reasons: ['no snapshot taken'] };
  for (;;) {
    try {
      const { rows, found, stamp } = await pagesSnapshot();
      receipt.assets = rows;
      receipt.assetStamp = stamp;
      propagation = found
        ? []
        : [`no referenced script contains ${args.expectSha} (index.html etag ${receipt.cache.index.etag ?? 'absent'})`];
      seat = evaluateAssets(rows);
    } catch (error) {
      propagation = [`fetch failed: ${String(error.message ?? error).slice(0, 160)}`];
      seat = { ok: false, reasons: ['snapshot failed'] };
    }
    const settled = propagation.length === 0 && seat.ok;
    if (settled || Date.now() + args.intervalMs > deadline) break;
    console.log(`waiting for propagation (${Math.round((Date.now() - t0) / 1000)} s): ${[...propagation, ...seat.reasons].join('; ')}`);
    await new Promise((resolve) => setTimeout(resolve, args.intervalMs));
  }
  receipt.propagationMs = Date.now() - t0;
  record('propagation:sha-in-assets', { ok: propagation.length === 0, reasons: propagation });
  record('seat:assets-200', seat);
}

/**
 * The build stamp read from the shipped script rather than from a booted
 * page. Only in light mode: the six boots read the same two values from
 * <html> and prove more, so recording this in deep mode would add a second
 * verdict about the same fact whose only distinct failure mode is the
 * regex. Here it is the whole nonce evidence, so a stamp that cannot be
 * read fails and the workflow escalates to the deep proof.
 */
function checkAssetStamp() {
  const verdict = evaluateStamp(receipt.assetStamp, { sha: args.expectSha, nonces: args.expectNonces });
  verdict.reasons = verdict.reasons.map((r) =>
    r.replace('missing data-ddm-build-', 'no referenced script assigns data-ddm-build-'),
  );
  record('stamp:assets', verdict);
}

async function checkRanges() {
  const names = (await readdir(PUBLIC_DATA)).filter((n) => n.endsWith('.pmtiles')).sort();
  for (const name of names) {
    const url = new URL(`data/${name}`, args.base).href;
    // The checkout is the commit under proof (the workflow re-points it
    // before this runs), so the file beside this script is the archive that
    // build shipped and its size identifies what the site must serve.
    let localBytes = null;
    try {
      localBytes = (await stat(join(PUBLIC_DATA, name))).size;
    } catch (error) {
      console.log(`could not size ${name} in the checkout: ${String(error.message ?? error).slice(0, 120)}`);
    }
    let row;
    try {
      const res = await get(url, { headers: { Range: `bytes=0-${RANGE_BYTES - 1}` } });
      const buf = new Uint8Array(await res.arrayBuffer());
      row = {
        name,
        url,
        status: res.status,
        contentRange: res.headers.get('content-range'),
        acceptRanges: res.headers.get('accept-ranges'),
        bytes: buf.length,
        localBytes,
      };
    } catch (error) {
      row = { name, url, status: 0, contentRange: null, acceptRanges: null, bytes: 0, localBytes, error: String(error.message ?? error).slice(0, 160) };
    }
    receipt.ranges.push(row);
    record(`range:${name}`, evaluateRange(row));
  }
}

// Runs inside the page: which control is the top hit at the center of the
// satellite switcher and of the map-information button (the embed corner
// contract, FE-18). Since PR 54 (da2efab, 2026-08-31, owner direction) the
// MapLibre attribution control is gone and the map-information button is
// the embed's credits surface, so the button must be present and reachable
// rather than absent; `attribHit` stays only to catch the removed control
// coming back. `hit` returns null when the selector matches nothing, which
// is how an absent control reads.
const cornerProbe = () => {
  const hit = (selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    if (!top) return null;
    if (top.closest('.basemap-switcher-control')) return 'satellite';
    if (top.closest('.map-info-btn')) return 'map-information';
    if (top.closest('.maplibregl-ctrl-attrib')) return 'attribution';
    return (top.className || top.tagName).toString().slice(0, 40);
  };
  const info = document.querySelector('.map-info-btn');
  return {
    satHit: hit('.maplibregl-ctrl-bottom-right .basemap-switcher-btn'),
    attribHit: hit('.maplibregl-ctrl-attrib-button'),
    infoHit: hit('.map-info-btn'),
    infoBtnVisible: !!info && getComputedStyle(info).display !== 'none',
  };
};

// Runs inside the page: every catalog pill that carries a status class
// (an off layer renders the span with no status).
const pillsProbe = () =>
  [...document.querySelectorAll('[data-layer-status]')]
    .map((el) => ({
      key: el.getAttribute('data-layer-status'),
      status: [...el.classList].find((c) => c !== 'layer-toggle-status') ?? null,
    }))
    .filter((p) => p.status !== null);

/**
 * The expected layer keys for a boot. A boot with no row in the table is a
 * programming error, and the check that would silently pass with no
 * expectation is exactly the vacuous pass this table exists to prevent, so
 * it throws rather than defaulting to "expect nothing".
 */
function expectedLayerKeys(name) {
  const keys = EXPECTED_BOOT_LAYERS[name];
  if (!keys) throw new Error(`no expected layer set is declared for boot ${name}`);
  return keys;
}

async function boot(browser, name, contextOptions, query, { corner = false } = {}) {
  // Resolved before the browser context opens, so a boot with no declared
  // expectation crashes the driver instead of proving nothing quietly.
  const expectedKeys = expectedLayerKeys(name);
  const url = new URL(query, args.base).href;
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));
  const t0 = Date.now();
  const row = { name, url, bootMs: null, sha: null, nonce: null, errors, layers: [] };
  let booted = false;
  try {
    await page.goto(url, { waitUntil: 'load', timeout: BOOT_TIMEOUT_MS });
    await page.waitForFunction(
      () => (document.querySelector('#region-select')?.options.length ?? 0) > 0,
      null,
      { timeout: BOOT_TIMEOUT_MS },
    );
    booted = true;
    row.bootMs = Date.now() - t0;
    const stamp = await page.evaluate(() => ({
      sha: document.documentElement.dataset.ddmBuildSha,
      nonce: document.documentElement.dataset.ddmBuildNonce,
    }));
    row.sha = stamp.sha ?? null;
    row.nonce = stamp.nonce ?? null;
    record(`stamp:${name}`, evaluateStamp(stamp, { sha: args.expectSha, nonces: args.expectNonces }));

    // A warm boot reaches the region select in a few hundred milliseconds,
    // before the registry has activated the first layer, so wait (bounded)
    // for the catalog to carry at least one status pill before reading
    // them; a boot that never activates anything then fails honestly below.
    const settled = new Map();
    const tLayers = Date.now();
    await page
      .waitForFunction(
        () => [...document.querySelectorAll('[data-layer-status]')].some((el) => el.classList.length > 1),
        null,
        { timeout: Math.min(args.ceilingMs, 15_000) },
      )
      .catch(() => {});
    // Wait until every active pill is terminal or the ceiling passes; a pill
    // keeps the settle time of its first terminal observation.
    for (;;) {
      const pills = await page.evaluate(pillsProbe);
      const elapsed = Date.now() - tLayers;
      for (const p of pills) {
        if (TERMINAL_STATUSES.has(p.status) && !settled.has(p.key)) {
          settled.set(p.key, { key: p.key, status: p.status, settleMs: elapsed });
        }
      }
      const pending = pills.filter((p) => !settled.has(p.key));
      // "Every pill I can see is terminal" is not enough now that the
      // expected set is enforced: the registry activates layers
      // concurrently, so a slower one may not have rendered a status class
      // yet, and exiting here would read it as never activated. Wait for
      // the whole expected set as well, bounded by the same ceiling so a
      // layer that truly never arrives still fails rather than hanging.
      const awaited = expectedKeys.filter((key) => !settled.has(key));
      if ((pending.length === 0 && awaited.length === 0) || elapsed >= args.ceilingMs) {
        for (const p of pending) settled.set(p.key, { key: p.key, status: p.status, settleMs: elapsed });
        break;
      }
      await page.waitForTimeout(500);
    }
    // Stability window: raster layers report `ready` before a tile has
    // loaded and let a watcher downgrade them afterwards, so re-read every
    // pill after a pause and judge the FINAL state; the first terminal
    // observation keeps its settle time. A pill that is GONE from the final
    // read is not "still what it was": the old null-coalescing fallback
    // silently kept its earlier value, so an unmounted layer read as
    // healthy. It is recorded as disappeared and fails below.
    await page.waitForTimeout(STABILITY_MS);
    const finalPills = new Map((await page.evaluate(pillsProbe)).map((p) => [p.key, p.status]));
    const moved = [];
    for (const entry of settled.values()) {
      if (!finalPills.has(entry.key)) {
        entry.disappeared = true;
        continue;
      }
      const final = finalPills.get(entry.key);
      if (final !== entry.status) {
        moved.push(`${entry.key} moved from ${entry.status} to ${final} during the ${STABILITY_MS} ms stability window`);
        entry.firstStatus = entry.status;
        entry.status = final;
      }
    }
    // A pill that only appeared after the settle loop broke still belongs
    // to this boot: record it with the elapsed time so a late-arriving
    // layer is judged rather than missed.
    const lateMs = Date.now() - tLayers;
    for (const [key, status] of finalPills) {
      if (!settled.has(key)) settled.set(key, { key, status, settleMs: lateMs, lateAppearance: true });
    }
    row.layers = [...settled.values()];
    const layersVerdict = evaluateLayers(row.layers, args.ceilingMs, {
      expectedKeys,
      previousStatuses: previousStatuses?.get(name) ?? null,
    });
    layersVerdict.warnings = [...layersVerdict.warnings, ...moved];
    record(`layers:${name}`, layersVerdict);

    if (corner) {
      await page.waitForTimeout(3000);
      const c = await page.evaluate(cornerProbe);
      row.corner = c;
      record(`embed-corner:${name}`, evaluateEmbedCorner(c));
    }
  } catch (error) {
    const message = String(error.message ?? error).slice(0, 160);
    record(booted ? `probe:${name}` : `boot:${name}`, { ok: false, reasons: [message] });
  } finally {
    await context.close();
  }
  record(`page-errors:${name}`, { ok: errors.length === 0, reasons: errors });
  receipt.boots.push(row);
}

async function checkBoots() {
  const { chromium, devices } = await import('@playwright/test');
  const browser = await chromium.launch({ headless: true, args: CHROMIUM_ARGS });
  const desktop = { viewport: { width: 1440, height: 900 } };
  const phone = { ...devices['iPhone 14'], viewport: { width: 390, height: 844 } };
  try {
    await boot(browser, 'root', desktop, '');
    await boot(browser, 'wildfire', desktop, '?cluster=wildfire&view=console');
    await boot(browser, 'heat', desktop, '?cluster=heat');
    await boot(browser, 'enso', desktop, '?cluster=enso');
    await boot(browser, 'embed-1280', { viewport: { width: 1280, height: 800 } }, '?embed=true&cluster=wildfire', { corner: true });
    await boot(browser, 'embed-390', phone, '?embed=true&cluster=wildfire', { corner: true });
  } finally {
    await browser.close();
  }
}

let previousStatuses = null;

await checkPropagationAndSeat();
await checkRanges();
if (args.light) {
  checkAssetStamp();
} else {
  previousStatuses = await loadPreviousStatuses();
  await checkBoots();
}

receipt.failed = receipt.checks.filter((c) => !c.ok).map((c) => c.name);
// A failure that is ONLY the propagation poll is inconclusive (the CDN may
// still be catching up), not a proved divergence; the workflow words the
// issue accordingly.
receipt.inconclusive = receipt.failed.length > 0 && receipt.failed.every((n) => n.startsWith('propagation:'));
// A DIVERGENCE is a stamp, propagation, or seat finding: the live site
// serving bytes other than the ones this deploy published, or referencing an
// asset it does not serve at all. Everything else (a layer that did not
// settle, an embed corner, a page error, a PMTiles range) is a product
// finding worth an issue and worth reading, but it is not evidence that the
// deploy failed, so the workflow must not red the branch for it.
//
// `seat:` is in this set deliberately: an index.html that names an asset the
// site answers with anything but 200 is a broken publish, not a product
// regression, and both it and `propagation:` have the verifier's own settle
// window plus the workflow's 10-minute pre-poll to clear a transient edge.
const DIVERGENCE_PREFIXES = ['stamp:', 'propagation:', 'seat:'];
receipt.diverged = receipt.failed.some((n) => DIVERGENCE_PREFIXES.some((p) => n.startsWith(p)));
await writeFile(args.out, JSON.stringify(receipt, null, 2));
const summary = renderSummary(receipt);
if (args.summary) await appendFile(args.summary, summary);
console.log(`\n${summary}`);
console.log(`receipt written to ${args.out}`);
process.exit(receiptOk(receipt) ? 0 : 1);
