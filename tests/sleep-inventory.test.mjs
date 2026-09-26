import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * DDM-P1-T09 e (M5). The launch prompt reads "no non-tile sleep remains" as
 * a Tier 1 rule. Read literally it is unachievable: most `waitForTimeout`
 * sites in tests/*.spec.ts are an absence window after releasing stale or
 * aborted work, a pacing gap between synthetic input events, a known
 * app-side debounce, an animation or repaint settle, a sampling loop over a
 * continuous signal, or a window deliberately nested inside a fetch this
 * test wants to keep pending. `whenQuiescent` (src/state/boot-idle.ts, read
 * through `window.__ddm`) cannot stand in for any of those: it resolves on
 * an ABSENCE of pending layers and shared transports, which says nothing
 * about a stale response, a keyboard repeat, a CSS transition, a raster
 * pixel, or a fetch this test is holding open on purpose.
 *
 * What the seam CAN prove: whether a specific named shared transport (for
 * example `us-states-geojson`, `US_STATES_SHARED_KEY` in src/util/fetch.ts)
 * is still in flight. A sleep that exists only to give such a transport time
 * to finish is "seam-observable-non-tile" and belongs on `awaitQuiescence`
 * (tests/helpers.ts) instead of a fixed wait. This inventory enumerates
 * every current site against a declared reason class so:
 *   - a NEW waitForTimeout site with no entry here fails the gate instead of
 *     quietly joining an unread list;
 *   - a declared site whose call text has vanished from its file is caught
 *     rather than silently going stale;
 *   - the seam-observable-non-tile class is asserted EMPTY: every sleep this
 *     run found in that class has already been migrated onto the seam, and
 *     none may be re-added without failing here first.
 *
 * A site is keyed by file, the trimmed and whitespace-normalised source text
 * of its `waitForTimeout` line, and that text's occurrence index within the
 * file (first, second, ...), NOT by line number. An unrelated edit that
 * shifts lines (inserting a blank line, reflowing a neighbouring block)
 * leaves every key unchanged. `line` is kept per entry only as an
 * informational hint for a human reading the table; nothing here enforces
 * it, and it may drift without failing this test.
 *
 * tile-dependent sites (fire3d-mode.spec.ts: a live scene and its terrain
 * tiles, which fire3d.ts reports through no registry status the seam can
 * read) are deferred to microtask M7 and stay classified, not migrated,
 * here.
 */

/**
 * @typedef {'absence-window'|'input-pacing'|'debounce'|'animation-settle'|'sampling-window'|'held-fetch-window'|'tile-dependent'|'seam-observable-non-tile'} ReasonClass
 */

/** @type {ReadonlyArray<{file: string, line: number, text: string, occurrence: number, class: ReasonClass, reason: string}>} */
const SITES = [
  {
    file: 'cluster-controller-integration.spec.ts',
    line: 183,
    text: 'await page.waitForTimeout(500);',
    occurrence: 1,
    class: 'absence-window',
    reason:
      'post-release settle so a stale, superseded generation cannot (wrongly) land before the assertion.'
  },
  // deployment-subpath.spec.ts:65 was seam-observable-non-tile; migrated
  // onto `awaitQuiescence` (tests/deployment-subpath.spec.ts) and so no
  // longer contains a `waitForTimeout` call to declare here.
  {
    file: 'fire3d-mode.spec.ts',
    line: 1665,
    text: 'await page.waitForTimeout(4_000);',
    occurrence: 1,
    class: 'tile-dependent',
    reason:
      'terrain-tile settle before the pitched-scene screenshot; fire3d writes no registry status a seam could read (deferred to M7).'
  },
  {
    file: 'fire3d-mode.spec.ts',
    line: 1870,
    text: 'await page.waitForTimeout(2_000);',
    occurrence: 1,
    class: 'tile-dependent',
    reason:
      'live basemap and camera-driven tile settle before the panel-reveal actionability check (deferred to M7).'
  },
  {
    file: 'fire3d-mode.spec.ts',
    line: 2023,
    text: 'await page.waitForTimeout(4_000);',
    occurrence: 2,
    class: 'tile-dependent',
    reason:
      'scene-tile settle after the camera-fly stamp reaches active, before the evidence capture (deferred to M7).'
  },
  {
    file: 'fire3d-mode.spec.ts',
    line: 2135,
    text: 'await page.waitForTimeout(3_000);',
    occurrence: 1,
    class: 'tile-dependent',
    reason:
      'settle window proving an embed without the flag never activates the scene or its tiles (deferred to M7).'
  },
  {
    file: 'fire3d-mode.spec.ts',
    line: 2161,
    text: 'await page.waitForTimeout(3_000);',
    occurrence: 2,
    class: 'tile-dependent',
    reason:
      'mobile-viewport settle proving no scene chunk request fires (deferred to M7).'
  },
  {
    file: 'fire3d-mode.spec.ts',
    line: 2182,
    text: 'await page.waitForTimeout(3_000);',
    occurrence: 3,
    class: 'tile-dependent',
    reason:
      'short-viewport settle proving the scene withdraws rather than mounting tiles (deferred to M7).'
  },
  {
    file: 'heat-h0-integrity.spec.ts',
    line: 432,
    text: 'await page.waitForTimeout(150);',
    occurrence: 1,
    class: 'debounce',
    reason:
      "past the visibility-driven refresh scheduler's own interval with no clock advance; proves no early second fetch."
  },
  {
    file: 'heat-h0-integrity.spec.ts',
    line: 448,
    text: 'await page.waitForTimeout(150);',
    occurrence: 2,
    class: 'debounce',
    reason:
      "past the refresh scheduler's window after a repeat visibilitychange with no clock advance; proves no duplicate refetch."
  },
  {
    file: 'heat-h2-point-heat.spec.ts',
    line: 747,
    text: 'await page.waitForTimeout(100);',
    occurrence: 1,
    class: 'absence-window',
    reason:
      'post-release settle so the superseded station response cannot overwrite the new selection before the assertion.'
  },
  {
    file: 'heat-h2-point-heat.spec.ts',
    line: 781,
    text: 'await page.waitForTimeout(100);',
    occurrence: 2,
    class: 'absence-window',
    reason:
      'settle window after reopening a completed briefing, proving the cached NWS responses are reused with no new request.'
  },
  {
    file: 'heat-h2-point-heat.spec.ts',
    line: 1054,
    text: 'await page.waitForTimeout(700);',
    occurrence: 1,
    class: 'absence-window',
    reason:
      "settle window past the fallback's own roughly 500 ms interval, proving no request follows."
  },
  {
    file: 'heat-h2-point-heat.spec.ts',
    line: 1083,
    text: 'await page.waitForTimeout(800);',
    occurrence: 1,
    class: 'absence-window',
    reason:
      "settle window past the deactivation fallback's catalog-and-identify interval before reading the claim."
  },
  {
    file: 'heat-h2-point-heat.spec.ts',
    line: 1209,
    text: 'await page.waitForTimeout(200);',
    occurrence: 1,
    class: 'absence-window',
    reason:
      'post-release settle so the superseded outlook response cannot add a stale claim before the assertion.'
  },
  {
    file: 'hover-inspector.spec.ts',
    line: 40,
    text: 'await page.waitForTimeout(120);',
    occurrence: 1,
    class: 'debounce',
    reason:
      "poll-loop interval inside a hover retry loop, past the inspector's own hover debounce."
  },
  {
    file: 'interaction-coordinator.spec.ts',
    line: 340,
    text: 'await page.waitForTimeout(300);',
    occurrence: 1,
    class: 'animation-settle',
    reason:
      'lets the overlapping Tribal and reservation fills finish their style repaint before the disclosure is read.'
  },
  {
    file: 'layer-cancellation.spec.ts',
    line: 240,
    text: 'await page.waitForTimeout(STALE_SETTLE_MS);',
    occurrence: 1,
    class: 'absence-window',
    reason:
      'STALE_SETTLE_MS after releasing aborted aiannh responses; proves nothing resurrects the removed layer.'
  },
  {
    file: 'layer-cancellation.spec.ts',
    line: 290,
    text: 'await page.waitForTimeout(STALE_SETTLE_MS);',
    occurrence: 2,
    class: 'absence-window',
    reason:
      'STALE_SETTLE_MS after releasing aborted hydrography responses; proves nothing resurrects the removed layer.'
  },
  {
    file: 'layer-cancellation.spec.ts',
    line: 323,
    text: 'await page.waitForTimeout(STALE_SETTLE_MS);',
    occurrence: 3,
    class: 'absence-window',
    reason:
      'STALE_SETTLE_MS after releasing aborted hms-smoke responses; proves nothing resurrects the removed layer.'
  },
  {
    file: 'layer-cancellation.spec.ts',
    line: 376,
    text: 'await page.waitForTimeout(STALE_SETTLE_MS);',
    occurrence: 4,
    class: 'absence-window',
    reason:
      'STALE_SETTLE_MS after releasing aborted ecoregions responses; proves nothing resurrects the removed layer.'
  },
  {
    file: 'layer-cancellation.spec.ts',
    line: 493,
    text: 'await page.waitForTimeout(STALE_SETTLE_MS);',
    occurrence: 5,
    class: 'absence-window',
    reason:
      'STALE_SETTLE_MS after an uncheck-then-release race on aiannh; proves nothing from the stale response reaches the map.'
  },
  {
    file: 'layer-cancellation.spec.ts',
    line: 499,
    text: 'await page.waitForTimeout(STALE_SETTLE_MS);',
    occurrence: 6,
    class: 'absence-window',
    reason:
      'a second STALE_SETTLE_MS proving no deferred render arrives even later than the first window.'
  },
  {
    file: 'm-breadth-bc-drought.spec.ts',
    line: 272,
    text: 'await page.waitForTimeout(500);',
    occurrence: 1,
    class: 'absence-window',
    reason:
      'post-release settle after a held BC request, before reading the recovered region and legend state.'
  },
  {
    file: 'm-breadth-bc-drought.spec.ts',
    line: 302,
    text: 'await page.waitForTimeout(120);',
    occurrence: 1,
    class: 'input-pacing',
    reason:
      'poll-loop click-retry interval waiting for the popup to paint after each synthetic click.'
  },
  {
    file: 'm-breadth-bc-drought.spec.ts',
    line: 366,
    text: 'await page.waitForTimeout(250);',
    occurrence: 1,
    class: 'absence-window',
    reason:
      "settle window establishing a stable 'before' briefing-resource-request count ahead of the region switch."
  },
  {
    file: 'm-breadth-bc-drought.spec.ts',
    line: 372,
    text: 'await page.waitForTimeout(500);',
    occurrence: 2,
    class: 'absence-window',
    reason:
      'settle window after the region switch, proving no extra briefing resource request fired.'
  },
  {
    file: 'm-breadth-heatrisk-days.spec.ts',
    line: 354,
    text: 'await page.waitForTimeout(750);',
    occurrence: 1,
    class: 'absence-window',
    reason:
      "post-release settle so the superseded day-1 raster cannot repaint over day-2's already-live pixels."
  },
  {
    file: 'mobile-sheet.spec.ts',
    line: 199,
    text: 'await page.waitForTimeout(350);',
    occurrence: 1,
    class: 'animation-settle',
    reason:
      "lets the sheet detent's CSS transition finish before re-measuring the map's south edge."
  },
  {
    file: 'nifc-query-scope.spec.ts',
    line: 244,
    text: 'await page.waitForTimeout(900);',
    occurrence: 1,
    class: 'debounce',
    reason:
      "past the map's own 400 ms re-query debounce plus moveend and inertial settle."
  },
  {
    file: 'nifc-query-scope.spec.ts',
    line: 287,
    text: 'await page.waitForTimeout(50);',
    occurrence: 1,
    class: 'sampling-window',
    reason:
      '50 ms sampling loop over a fixed 5 s window, collecting every pill class the layer passes through.'
  },
  {
    file: 'nifc-query-scope.spec.ts',
    line: 427,
    text: 'await page.waitForTimeout(1_500);',
    occurrence: 1,
    class: 'absence-window',
    reason:
      "past the reset's fitBounds settle and re-query debounce, proving the cached envelope served with no third request."
  },
  {
    file: 'nifc-query-scope.spec.ts',
    line: 439,
    text: 'await page.waitForTimeout(1_000);',
    occurrence: 1,
    class: 'absence-window',
    reason:
      "after releasing a superseded response, bounds only that it cannot paint over the newer one within this window (the request-count and popup-identity assertions right after carry the unconditional proof)."
  },
  {
    file: 'place-studio.spec.ts',
    line: 611,
    text: 'await page.waitForTimeout(1_000);',
    occurrence: 1,
    class: 'absence-window',
    reason:
      'a deliberate fixed wait after releasing a stale response; bounded proof only, by the file’s own comment.'
  },
  {
    file: 'popup-viewport.spec.ts',
    line: 369,
    text: 'await page.waitForTimeout(30);',
    occurrence: 1,
    class: 'input-pacing',
    reason:
      '30 ms spacing between synthetic CDP touchMove steps inside a swipe gesture.'
  },
  {
    file: 'popup-viewport.spec.ts',
    line: 894,
    text: 'await page.waitForTimeout(250);',
    occurrence: 1,
    class: 'debounce',
    reason:
      "250 ms poll interval inside waitForStableMarker, waiting for the marker's DOM position to stop moving between reads."
  },
  {
    file: 'popup-viewport.spec.ts',
    line: 1068,
    text: 'await page.waitForTimeout(150);',
    occurrence: 1,
    class: 'animation-settle',
    reason:
      "150 ms settle after a click for the popup's synchronous paint before reading the title."
  },
  // popup-viewport.spec.ts:1387 was seam-observable-non-tile; migrated onto
  // `awaitQuiescence` (see the case above, line 1387) and so no longer
  // contains a `waitForTimeout` call to declare here.
  {
    file: 's4-shell.spec.ts',
    line: 786,
    text: 'await page.waitForTimeout(500);',
    occurrence: 1,
    class: 'absence-window',
    reason:
      'post-release settle proving the withdrawn drought surface is not resurrected by the late stale monthly response.'
  },
  {
    file: 's4-shell.spec.ts',
    line: 919,
    text: 'await page.waitForTimeout(500);',
    occurrence: 2,
    class: 'absence-window',
    reason:
      'post-release settle proving the withdrawn studio drought checkbox state is not resurrected by the late stale response.'
  },
  {
    file: 'search-fit.spec.ts',
    line: 46,
    text: 'await page.waitForTimeout(150);',
    occurrence: 1,
    class: 'input-pacing',
    reason:
      'settle after two small mouse moves, before reading the hover-inspector item under the probe point.'
  },
  {
    file: 'search-fit.spec.ts',
    line: 88,
    text: 'await page.waitForTimeout(600);',
    occurrence: 1,
    class: 'animation-settle',
    reason:
      'the 600 ms gap between two samples so a still-flying camera cannot read as landed (mid-fly the sampled pixel is still moving).'
  },
  {
    file: 'slim-entry.spec.ts',
    line: 172,
    text: 'await page.waitForTimeout(500);',
    occurrence: 1,
    class: 'absence-window',
    reason:
      'post-response settle after the deferred runtime chunk resolves, before checking the panel never opened.'
  },
  {
    file: 'temporal-axis.spec.ts',
    line: 517,
    text: 'await page.waitForTimeout(700);',
    occurrence: 1,
    class: 'held-fetch-window',
    reason:
      "day 2's tiles are deliberately held for this whole window while the continuity sampler runs; whenQuiescent would hang until release, so it cannot substitute."
  },
  {
    file: 'temporal-axis.spec.ts',
    line: 615,
    text: 'await page.waitForTimeout(700);',
    occurrence: 2,
    class: 'held-fetch-window',
    reason:
      'the season-ahead response is deliberately held for this whole window for the same continuity-sampling reason as line 517.'
  },
  {
    file: 'tribal-live-layers.spec.ts',
    line: 135,
    text: 'await page.waitForTimeout(750);',
    occurrence: 1,
    class: 'absence-window',
    reason:
      'post-click settle proving no stale boundary popup remains clickable; the shared helper runs after many different layer-toggle scenarios, not one guaranteed transport.'
  },
  {
    file: 'umbrella.spec.ts',
    line: 185,
    text: 'await page.waitForTimeout(750);',
    occurrence: 1,
    class: 'absence-window',
    reason:
      "settle window after the CTA click, proving a would-be regression's extra live request never fires."
  },
  {
    file: 'url-state.spec.ts',
    line: 140,
    text: 'await page.waitForTimeout(200);',
    occurrence: 1,
    class: 'sampling-window',
    reason:
      'a 5-iteration, 200 ms-spaced sampling loop proving the boot-window layer set never degrades to empty or partial.'
  },
  {
    file: 'view-contracts.spec.ts',
    line: 185,
    text: 'await page.waitForTimeout(350);',
    occurrence: 1,
    class: 'input-pacing',
    reason:
      'settle between successive keyboard zoom-out presses so each keystroke registers before the next.'
  },
  {
    file: 'view-mode.spec.ts',
    line: 40,
    text: 'await page.waitForTimeout(2_000);',
    occurrence: 1,
    class: 'absence-window',
    reason:
      'settle window with no explicit selection and no deep link, proving the impact panel never auto-opens.'
  },
  {
    file: 'view-mode.spec.ts',
    line: 215,
    text: 'await page.waitForTimeout(1_500);',
    occurrence: 1,
    class: 'absence-window',
    reason:
      'settle window giving the retained minimap analysis fetch a real chance to have started, before asserting it never did.'
  }
];

function normalizeCallText(lineText) {
  return lineText.trim().replace(/\s+/g, ' ');
}

function scanSites() {
  const testsDir = __dirname;
  const files = readdirSync(testsDir).filter((name) => name.endsWith('.spec.ts'));
  /** @type {{file: string, line: number, text: string, occurrence: number}[]} */
  const found = [];
  for (const file of files) {
    const contents = readFileSync(path.join(testsDir, file), 'utf8');
    const lines = contents.split(/\r?\n/);
    /** @type {Map<string, number>} */
    const occurrenceCounts = new Map();
    lines.forEach((lineText, idx) => {
      if (/\bwaitForTimeout\(/.test(lineText)) {
        const text = normalizeCallText(lineText);
        const occurrence = (occurrenceCounts.get(text) ?? 0) + 1;
        occurrenceCounts.set(text, occurrence);
        found.push({ file, line: idx + 1, text, occurrence });
      }
    });
  }
  return found;
}

function key(site) {
  return `${site.file}::${site.text}::${site.occurrence}`;
}

test('every waitForTimeout site in tests/*.spec.ts is declared with a reason class', () => {
  const actual = scanSites();
  const declaredKeys = new Set(SITES.map(key));

  const unclassified = actual.filter((site) => !declaredKeys.has(key(site)));
  assert.deepEqual(
    unclassified.map((site) => `${site.file}:${site.line}`),
    [],
    `unclassified waitForTimeout site(s), add a SITES entry: ${unclassified
      .map((site) => `${site.file}:${site.line}`)
      .join(', ')}`
  );
});

test('every declared site still exists (by call text and occurrence) in its file', () => {
  const actualKeys = new Set(scanSites().map(key));

  const missing = SITES.filter((site) => !actualKeys.has(key(site)));
  assert.deepEqual(
    missing.map((site) => `${site.file}:${site.line}`),
    [],
    `declared site(s) no longer exist there, update or remove the SITES entry: ${missing
      .map((site) => `${site.file}:${site.line}`)
      .join(', ')}`
  );
});

test('every declared site carries a non-empty one-line reason', () => {
  const bad = SITES.filter(
    (site) => typeof site.reason !== 'string' || site.reason.trim().length === 0 || site.reason.includes('\n')
  );
  assert.deepEqual(
    bad.map((site) => `${site.file}:${site.line}`),
    [],
    `site(s) missing a one-line reason: ${bad.map((site) => `${site.file}:${site.line}`).join(', ')}`
  );
});

test('the seam-observable-non-tile class is empty: every such sleep has moved onto whenQuiescent', () => {
  const stillSeamObservable = SITES.filter((site) => site.class === 'seam-observable-non-tile');
  assert.deepEqual(
    stillSeamObservable.map((site) => `${site.file}:${site.line}`),
    [],
    `seam-observable-non-tile site(s) not yet migrated onto awaitQuiescence: ${stillSeamObservable
      .map((site) => `${site.file}:${site.line}`)
      .join(', ')}`
  );
});
