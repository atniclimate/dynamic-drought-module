import { readFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { Map as MlMap } from 'maplibre-gl';

import { expect, test, type Page, type Route } from './offline-test';

import {
  FIRE3D_COVERAGE_NOTE,
  FIRE3D_NON_PREDICTION_NOTE,
  FIRE3D_REFUSAL_TEXT,
  PERIMETER_RIBBON_QUALIFICATION
} from '../src/config/fire3d-presentation';
import { HMS_VOLUME_QUALIFICATION } from '../src/config/wildfire-presentation';
import { WHP_SHADE_QUALIFICATION } from '../src/config/whp-shade';
import { PERIMETER_RIBBON_LAYER_IDS } from '../src/layers/nifc-perimeter-ribbon';
import { gotoApp, layerCheckbox, search, waitForLayerSettled } from './helpers';
import {
  stubDeepTerrainArchive,
  stubWildfireFeeds
} from './wildfire-fixtures';
import { RAWS_ROUTE, RAWS_FIXTURE_MARKER_ID, rawsHappyBody } from './fixtures/raws-fixtures';

/**
 * W3/W4 desktop 3D Fire mode.
 *
 * Node-level cases drive the orchestrator against the shared fake map
 * (tests/map-harness.ts): the production build carries no dev map handle,
 * so terrain/sky/camera truth is asserted here at the module seam, and the
 * browser cases assert the production-observable stamps
 * (data-ddm-fire3d / data-ddm-fire3d-smoke on the document element, the
 * control chrome, and the URL).
 */

// ---------------------------------------------------------------------------
// Browser: the production build end to end
// ---------------------------------------------------------------------------

function fire3dStamp(page: Page): Promise<string | undefined> {
  return page.evaluate(() => document.documentElement.dataset['ddmFire3d']);
}

function fire3dSmokeStamp(page: Page): Promise<string | undefined> {
  return page.evaluate(
    () => document.documentElement.dataset['ddmFire3dSmoke']
  );
}

function fire3dContextStamp(page: Page): Promise<string | undefined> {
  return page.evaluate(
    () => document.documentElement.dataset['ddmFire3dContext']
  );
}

function fire3dRibbonStamp(page: Page): Promise<string | undefined> {
  return page.evaluate(
    () => document.documentElement.dataset['ddmFire3dRibbon']
  );
}

/** Fire3DStatus.transport's own production stamp: 'streaming' from the
 * scene's first 'active' publish until every scene source reports loaded,
 * then 'settled'; absent while inactive. See src/map/fire3d.ts,
 * `deriveSceneTransport` and the `Fire3DStatus.transport` doc comment. */
function fire3dTransportStamp(page: Page): Promise<string | undefined> {
  return page.evaluate(
    () => document.documentElement.dataset['ddmFire3dTransport']
  );
}

/**
 * How long a single read may stay unanswered before the wait stops charging
 * it. Playwright reads the page on its main thread, so a read that is still
 * out after this long was waiting on a page that could not run, not on an
 * app that ran and had not got there yet.
 *
 * Measured on GitHub's software renderer (S30D B6-3D, the retry traces of
 * runs 37238546758, 37317297848 and 37347470195, chromium-3d shard 2): one
 * stamp read took 14.9 s and a legend read 15.3 s, a click 21.3 and 37.1 s,
 * an uncheck 25.8 and 41.7 s, a locator count 21.4 and 35.2 s, while every
 * answered read around them took 10 to 600 ms. An `expect.poll` charges that
 * frozen time to its budget: its 10 and 30 s deadlines fired while a read was
 * still out, and the read that came back afterwards held the expected value
 * (the context stamp) or the page had simply not run since the gesture (the
 * ribbon stamp, read once as `on` 70 ms after a 41.7 s uncheck, then frozen
 * again for 35.6 s).
 */
const UNANSWERED_READ_CHARGE_MS = 1_000;
/** The pause between reads, charged in full. */
const ANSWERED_POLL_INTERVAL_MS = 250;

/**
 * Wait until `read` returns a value `accept` takes, with a budget the app
 * spends and a frozen page does not. Every pause between reads is charged in
 * full, and every read is charged its own duration up to
 * UNANSWERED_READ_CHARGE_MS, so on a page that answers this is the wall-clock
 * wait it replaces, budget for budget, and on a page whose main thread is
 * blocked by the software renderer the blocked time is not charged. A state
 * the app never reaches on a page that keeps answering still fails at the
 * same budget, and its message names the last value, the charged and
 * wall-clock times, and the longest read, so a failure says whether the app
 * or the renderer was slow. A page that never answers again is caught by the
 * test's own timeout.
 */
async function untilAnswered<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  budgetMs: number,
  what: string
): Promise<T> {
  const startedAt = Date.now();
  let charged = 0;
  let longestRead = 0;
  for (;;) {
    const readStartedAt = Date.now();
    const value = await read();
    const readMs = Date.now() - readStartedAt;
    longestRead = Math.max(longestRead, readMs);
    if (accept(value)) return value;
    charged += Math.min(readMs, UNANSWERED_READ_CHARGE_MS);
    if (charged >= budgetMs) {
      throw new Error(
        `${what}: still ${JSON.stringify(value)} after ${charged} ms of answered reads ` +
          `(${Date.now() - startedAt} ms on the clock; longest read ${longestRead} ms)`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, ANSWERED_POLL_INTERVAL_MS));
    charged += ANSWERED_POLL_INTERVAL_MS;
  }
}

/** A production stamp reaches `expected` (an `expect.poll(...).toBe` whose
 * budget a frozen page does not spend). */
async function stampReaches(
  page: Page,
  stamp: (page: Page) => Promise<string | undefined>,
  expected: string | undefined,
  budgetMs: number,
  what: string
): Promise<void> {
  await untilAnswered(() => stamp(page), (value) => value === expected, budgetMs, what);
}

/** An element's text comes to contain `expected` (the `expect.poll` over
 * `textContent()` this file used, on the same answered-read budget). A
 * missing element reads as null and keeps the wait going. */
async function textComesToContain(
  page: Page,
  selector: string,
  expected: string,
  budgetMs: number
): Promise<void> {
  await untilAnswered(
    () => page.evaluate((s) => document.querySelector(s)?.textContent ?? null, selector),
    (text) => text !== null && text.includes(expected),
    budgetMs,
    `${selector} never came to contain ${JSON.stringify(expected)}`
  );
}

/** The URL's query string comes to satisfy `accept`. */
async function searchSettles(
  page: Page,
  accept: (query: string) => boolean,
  budgetMs: number,
  what: string
): Promise<void> {
  await untilAnswered(() => search(page), accept, budgetMs, what);
}

/**
 * helpers.ts `waitForLayerSettled` on the answered-read budget: the layer's
 * status pill carries a terminal raw status class (anything but `loading`),
 * with the same 25 s default. Returns the pill's raw status class, so a
 * caller that needs `ready` and not merely terminal can say so.
 */
async function layerSettles(page: Page, key: string, budgetMs = 25_000): Promise<string> {
  const terminal = ['ready', 'degraded', 'error', 'no-data', 'zoom-in'];
  const tokens = await untilAnswered(
    () =>
      page.evaluate(
        (k) => (document.querySelector(`[data-layer-status="${k}"]`)?.getAttribute('class') ?? '').split(/\s+/),
        key
      ),
    (classes) => terminal.some((status) => classes.includes(status)),
    budgetMs,
    `layer "${key}" never left the loading state`
  );
  return terminal.find((status) => tokens.includes(status)) ?? '';
}

const TOGGLE = '.shell-fire3d-btn';

// The evidence captures below render the live scene, including the
// default-on AIANNH and BIA boundaries, to fire3d-evidence/ (gitignored)
// for the owner's local review. They stay local: CI keeps no screenshots
// (playwright.config.ts), and a runner must not write that geometry to
// disk at all.
//
// OPT-IN, NOT OPT-OUT (DR-051 a, ruled 2026-09-02). This constant used to be
// `!process.env['CI']`, which made every local run a capture run: three of the
// slowest boots in the suite paid live agency latency, a routine loop could
// not run offline, and four PNGs the owner reviews were overwritten by anyone
// who typed `npm run test:serial`. A routine local run must be offline-safe
// and idempotent, so capture now happens only when the developer asks for it
// with `DDM_CAPTURE_EVIDENCE=1`; every other local run uses the fixtures
// exactly as CI does. The flag is the deliberate capture pass and the gate
// for the evidence categories that come next (terrain across views,
// volumetric smoke, layer studio 3D layers).
//
// The `!process.env['CI']` half stays as a second lock, not as the switch: a
// runner that somehow carried the flag still captures nothing.
const CAPTURE_EVIDENCE =
  process.env['DDM_CAPTURE_EVIDENCE'] === '1' && !process.env['CI'];

// THE ONE PLACE THE SUITE ASKS FOR LIVE BOUNDARIES, and only when it is
// about to photograph them.
//
// DDM-P1-T08 made every boot answer the AIANNH and BIA queries from
// synthetic rectangles. That silently changed what these captures were FOR:
// the owner reviews them to judge whether real Tribal-geography cartography
// draws honestly in the 3D scene, and a picture of two invented rectangles
// cannot answer that question. Source-health request receipts prove the
// services respond; they say nothing about how the boundaries look.
//
// So the three evidence-bearing boots ask for `live` exactly when
// `CAPTURE_EVIDENCE` is true, which since DR-051 a is exactly the deliberate
// `DDM_CAPTURE_EVIDENCE=1` capture pass on a local machine, where nothing is
// retained. The live mode exists only to serve those captures, so it is gated
// on the same flag: an ordinary local run is `fixture` like every CI boot. In
// CI this is `fixture`, the capture blocks are skipped, and
// `installBoundaryStubs` would throw on `live` anyway
// (tests/tribal-fixtures.ts), so the option cannot reach a public artifact by
// any route. tests/boundary-boot-inventory.test.mjs records this file as the
// single allowance and requires the CI guard.
const EVIDENCE_BOUNDARIES = CAPTURE_EVIDENCE ? ('live' as const) : ('fixture' as const);

/** Freeze the page's main thread for `ms` (a busy loop, as a blocked GPU
 * readback does), starting `delayMs` from now, then optionally stamp
 * `data-probe="done"` `stampAfterMs` after the freeze ends. Returns at once. */
async function freezePageSoon(
  page: Page,
  options: { delayMs: number; ms: number; stampAfterMs: number | null }
): Promise<void> {
  await page.evaluate(({ delayMs, ms, stampAfterMs }) => {
    setTimeout(() => {
      const end = performance.now() + ms;
      while (performance.now() < end) {
        // the frozen main thread
      }
      if (stampAfterMs !== null) {
        setTimeout(() => {
          document.documentElement.dataset['probe'] = 'done';
        }, stampAfterMs);
      }
    }, delayMs);
  }, options);
}

function probeStamp(page: Page): Promise<string | undefined> {
  return page.evaluate(() => document.documentElement.dataset['probe']);
}

test('an answered-read wait is not charged for a page the renderer has frozen past its budget', async ({
  page
}) => {
  // The found-145 shape without the renderer: the page freezes for 8 s,
  // longer than the 3 s budget, and reaches the state 300 ms after it thaws.
  // An `expect.poll` with a 3 s timeout fails here (its deadline passes while
  // the read is still out); the answered-read wait charges the frozen read
  // 1 s and passes. A fresh page is about:blank, which already has a
  // documentElement for the stamp, so no navigation is needed.
  await freezePageSoon(page, { delayMs: 100, ms: 8_000, stampAfterMs: 300 });
  const startedAt = Date.now();
  await stampReaches(page, probeStamp, 'done', 3_000, 'the probe never stamped done');
  expect(Date.now() - startedAt).toBeGreaterThan(8_000);
});

test('an answered-read wait still fails at its budget when the state never comes, frozen or not', async ({
  page
}) => {
  // A page that answers and never gets there fails on the budget, as the
  // `expect.poll` it replaces did.
  await expect(
    stampReaches(page, probeStamp, 'done', 2_000, 'the probe never stamped done')
  ).rejects.toThrow(/the probe never stamped done: still undefined after \d+ ms of answered reads/);
  // A freeze in the middle is not charged, and the wait still fails once the
  // page has answered for the budget, naming the frozen read.
  await freezePageSoon(page, { delayMs: 100, ms: 5_000, stampAfterMs: null });
  const startedAt = Date.now();
  await expect(
    stampReaches(page, probeStamp, 'done', 2_000, 'the probe never stamped done')
  ).rejects.toThrow(/longest read [4-9]\d{3} ms/);
  expect(Date.now() - startedAt).toBeGreaterThan(5_000);
});

test.describe('W3/W4 browser truth', () => {
  test('the desktop toggle activates the 3D scene with the volume legend, then exits cleanly', async ({
    page
  }) => {
    // Terrain probe, DEM tile fan-out, and full-page screenshots on the
    // software renderer overrun the default budget; this is the one
    // evidence-bearing case, so it gets explicit room.
    test.setTimeout(180_000);
    await stubWildfireFeeds(page);
    await stubDeepTerrainArchive(page);

    // Measure the terrain archive's real transport for the activation
    // budget row (logged, not asserted; the preview serves the bundled
    // archive with ranges).
    let demBytes = 0;
    let demRequests = 0;
    let drapeBytes = 0;
    let drapeRequests = 0;
    let powerBytes = 0;
    let powerRequests = 0;
    page.on('response', (response) => {
      const url = response.url();
      const length = Number(response.headers()['content-length']);
      if (url.includes('hillshade-dem-pnw.pmtiles')) {
        demRequests += 1;
        if (Number.isFinite(length)) demBytes += length;
      } else if (url.includes('whp-2023-pnw.pmtiles')) {
        drapeRequests += 1;
        if (Number.isFinite(length)) drapeBytes += length;
      } else if (url.includes('power-lines-pnw.pmtiles')) {
        powerRequests += 1;
        if (Number.isFinite(length)) powerBytes += length;
      }
    });

    await gotoApp(page, '?region=washington_state&cluster=wildfire', { boundaries: EVIDENCE_BOUNDARIES });
    await layerSettles(page, 'hms-smoke');

    const toggle = page.locator(TOGGLE);
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    // Both honesty notes render whenever the control does: coverage, and
    // the non-prediction disclosure (never a dismissible tooltip).
    await expect(page.locator('.shell-fire3d-note')).toHaveText([
      FIRE3D_COVERAGE_NOTE,
      FIRE3D_NON_PREDICTION_NOTE
    ]);
    await expect(page.locator('[data-fire3d-disclosure]')).toHaveText(
      FIRE3D_NON_PREDICTION_NOTE
    );
    // A capable desktop is offered the control and told nothing about a
    // refusal: the sentence appears only where it is true.
    await expect(page.locator('#shell-fire3d-refused')).toHaveCount(0);

    // Every wait on a stamp, a legend text or the URL below keeps the budget
    // it had as an `expect.poll` (10 s, or the 30 s it named), on the
    // answered-read clock: this is the animated case (no reduced motion; the
    // pulse and the eased camera are what it covers), and GitHub's software
    // renderer froze it 35.2, 14.9 and 15.3 s in a row here (found-145; see
    // UNANSWERED_READ_CHARGE_MS).
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await searchSettles(page, (q) => q.includes('fire3d=true'), 10_000, 'the URL never gained fire3d=true');
    await stampReaches(page, fire3dStamp, 'active', 30_000, 'the scene never stamped active');
    await stampReaches(page, fire3dSmokeStamp, 'volume', 10_000, 'the smoke never stamped volume');
    await expect(
      page.locator('.shell-fire3d-status')
    ).toHaveAttribute('data-fire3d-status', 'active');

    // The volume legend carries the honest vertical qualification.
    const volumeLegendSelector = '.legend-section[data-legend="hms-smoke-volume"]';
    const volumeLegend = page.locator(volumeLegendSelector);
    await expect(volumeLegend).toHaveCount(1);
    await textComesToContain(page, volumeLegendSelector, HMS_VOLUME_QUALIFICATION, 10_000);

    // The context layers this mode OWNS activated, each with its issuer
    // palette or caveat qualification. Power is not among them since
    // 2026-08-19: it is a catalog layer, off unless someone asks for it,
    // and its legend must not appear while it is off.
    await stampReaches(
      page,
      fire3dContextStamp,
      'whp structures',
      30_000,
      'the context layers never stamped whp structures'
    );
    const hazardLegendSelector = '.legend-section[data-legend="whp-2023"]';
    const hazardLegend = page.locator(hazardLegendSelector);
    await expect(hazardLegend).toHaveCount(1);
    await textComesToContain(page, hazardLegendSelector, WHP_SHADE_QUALIFICATION, 10_000);
    const powerLegend = page.locator(
      '.legend-section[data-legend="power-context"]'
    );
    await expect(powerLegend).toHaveCount(0);
    // The buildings' key row shows only where a building can draw. This
    // state view sits below the archive's zoom 13 floor, so the key lists
    // none (the central Oregon case below holds the row itself).
    const structuresLegend = page.locator('.legend-section[data-legend="structures-3d"]');
    await expect(structuresLegend).toHaveCount(0);
    // The embed disclosure chip is embed-only chrome; the desktop shell
    // already carries the notes, so no chip appears here.
    await expect(page.locator('#fire3d-embed-note')).toHaveCount(0);

    // Let terrain tiles land (a bounded wait; live basemap tiles make
    // networkidle nondeterministic), then capture the pitched-scene
    // evidence.
    await page.waitForTimeout(4_000);
    if (CAPTURE_EVIDENCE) {
      await page.screenshot({
        path: 'fire3d-evidence/fire3d-active-desktop.png'
      });
      await page
        .locator('#shell-details-panel')
        .screenshot({ path: 'fire3d-evidence/fire3d-control-coverage-note.png' });
    }
    console.log(
      `[fire3d-budget] terrain archive transport: ${demBytes} bytes over ${demRequests} requests`
    );
    console.log(
      `[fire3d-budget] hazard drape archive transport: ${drapeBytes} bytes over ${drapeRequests} requests`
    );
    console.log(
      `[fire3d-budget] power-lines archive transport: ${powerBytes} bytes over ${powerRequests} requests (ZERO is the expected reading since 2026-08-19: power is a catalog layer, off by default, so the 3D scene no longer pulls it. Its own budget row lives under the power-infrastructure feature in scripts/check-activation-budget.mjs)`
    );

    // Toggle off: the flat scene returns and the flag drops.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await stampReaches(page, fire3dStamp, 'inactive', 10_000, 'the scene never stamped inactive');
    await searchSettles(page, (q) => !q.includes('fire3d'), 10_000, 'the URL kept fire3d');
    await expect(volumeLegend).toHaveCount(0);
    await expect(hazardLegend).toHaveCount(0);
    await expect(powerLegend).toHaveCount(0);
    await expect(structuresLegend).toHaveCount(0);
    expect(await fire3dContextStamp(page)).toBeUndefined();
  });

  /**
   * DDM-P9-T06 fix F1/F2 (opus-read.md), replacing the round-1 STOP test.
   * The round-1 test asserted a `.telemetry-marker`'s
   * `getBoundingClientRect()` stayed byte-identical across an 8-second wait
   * during which nothing could have moved it: `Marker._update`, the only
   * writer of the marker's inline `transform`
   * (node_modules/maplibre-gl/dist/maplibre-gl-dev.mjs:26805 in this
   * lane's installed version), is registered only on `map.on('move', ...)`
   * and `map.on('terrain', ...)` (:27004-27006), and neither fires between
   * the test's two reads, so the assertion was a tautology, not a
   * measurement. Its claim that `Map.project()` is a flat 2D projection is
   * also false for MapLibre: `Map.project` calls
   * `locationToScreenPoint(lnglat, this.style && this.terrain)`
   * (maplibre-gl-dev.mjs; the source-level location is
   * node_modules/maplibre-gl/src/ui/map.ts:2024-2026), which is
   * terrain-aware, and `Marker._update` calls exactly that
   * (src/ui/marker.ts:752-765; the class registers the terrain listener at
   * :427).
   *
   * The director measured this directly against the lane-b dev server
   * (`window.__ddmMap` present; the production build carries no such
   * handle, src/main.ts:268-273, so no in-page projection assertion is
   * possible in THIS build, hence no in-page assertion below either):
   * script and output at
   * I:\claude-temp\ddm-s20\DDM-P9-T06\terrain-measure-director.mjs and
   * .json. With fire3d active, a Stevens Pass marker's actual on-screen
   * position matched the terrain-aware `map.project()` result (444.12,
   * 321.72), not the flat `transform.locationToScreenPoint()` result
   * (444.18, 325.91), both before and after a 0.01-degree bearing nudge.
   * The acceptance's "in the scene, at terrain height" clause is therefore
   * MET by the renderer's own marker placement; this task adds no second,
   * competing surface for it (fire3d-context.md's "one issuer, one number,
   * one legend, per layer" forbids a duplicate positioning path for the
   * same station).
   *
   * What THIS test proves, in the production build's own DOM: a RAWS
   * station's marker in the ACTIVE 3D scene is the same MapLibre-managed
   * marker element as on the flat map (it carries the `maplibregl-marker`
   * class MapLibre's own `Marker` class adds,
   * `this._element.classList.add('maplibregl-marker')`, never DDM, and an
   * inline `transform` MapLibre itself writes), and it carries the same
   * wind-glyph child as on the flat map. A RAWS station is stubbed here
   * rather than reusing Stevens Pass (a SNOTEL station, which serves no
   * wind fields and so never carries a glyph).
   */
  test('a RAWS station marker in the active 3D scene is a MapLibre-managed marker and carries the same wind glyph as on the flat map', async ({
    page
  }) => {
    // A longer budget than most other browser cases in this file (mirrors
    // the perimeter-ribbon test's own 180_000 two tests down, "a terrain
    // build plus the perimeter fetch on the software renderer"): the scene
    // carries the full terrain/hazard archive load (measured at
    // 6.3 MB terrain plus 1.1 MB hazard drape in the run right above this
    // one) AND the telemetry panel's own viewport-based discovery. The
    // worst-case poll sum is 30 s to 'active', 60 s to 'settled', 25 s for
    // telemetry, 2 s fixed, and 90 s for the marker, 207 s, and the renderer
    // drain below carries no poll of its own (measured 5.8 to 11.9 s), so
    // the ceiling is 240 s. No individual wait grew; the ceiling grew to
    // cover the drain step. The case itself now runs in 36 to 56 s.
    test.setTimeout(240_000);
    // Reduced motion, and why (measured 2026-09-11, s28, scripts and logs
    // in I:\claude-temp\ddm-s28\raws\). This is the only 3D browser case
    // that puts DOM markers on the terrain map, and MapLibre's Marker checks
    // terrain occlusion with a synchronous `gl.readPixels`
    // (node_modules/maplibre-gl/src/ui/marker.ts `_updateOpacity`, through
    // src/render/terrain.ts `depthAtPoint`). On the SwiftShader renderer
    // this suite runs on, the wildfire pulse (src/layers/nifc-fires.ts,
    // a paint change every 60 ms when this was measured; since decision A
    // of 2026-09-11 it commits every 500 ms on terrain with this renderer,
    // and this case keeps reduced motion regardless) keeps queueing full
    // pitch-60 terrain frames faster than SwiftShader draws them, and nothing in the page
    // can see that queue until something reads the GPU back. A bare 1x1
    // readPixels on the settled scene, before telemetry was even on,
    // blocked the page's main thread 43 to 62 s (six probes, two workers);
    // the markers' own occlusion reads blocked it 41 to 61 s the moment
    // they appeared. During those stalls no timer, no moveend debounce, no
    // status write and no Playwright query runs, which is what failed this
    // case's 25 s telemetry wait and its 90 s marker wait on the
    // 2026-09-10/11 intermittents. With reduced motion the pulse never
    // starts (its own prefersReducedMotion gate) and the camera jumps
    // instead of easing: the worst read fell to 3 to 16 s and the click to
    // marker time from 51 to 62 s (six runs) to 1.6 and 12 s (two runs).
    // What this case asserts (a MapLibre-managed marker, at terrain height,
    // carrying the wind glyph, in the ACTIVE scene) depends on neither
    // animation, and the reduced-motion scene still has terrain, pitch and
    // the occlusion reads; the animated enter and exit are covered by the
    // desktop toggle case above, and reduced motion's own by the case
    // further down.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await stubWildfireFeeds(page);
    await stubDeepTerrainArchive(page);
    await page.route('**/api.waterdata.usgs.gov/**', (route) => route.abort('failed'));
    await page.route('**/wcc.sc.egov.usda.gov/**', (route) => route.abort('failed'));
    await page.route('**/api.tidesandcurrents.noaa.gov/**', (route) => route.abort('failed'));
    await page.route('**/mesonet.agron.iastate.edu/**', (route) => route.abort('failed'));
    await page.route('**/ddm-proxy.atniclimate.workers.dev/**', (route) => route.abort('failed'));
    await page.route(RAWS_ROUTE, (route) =>
      route.fulfill({
        contentType: 'application/geo+json',
        body: JSON.stringify(rawsHappyBody())
      })
    );
    // `cluster=` and `layers=` are mutually exclusive on the URL:
    // `layers=` OUTRANKS `cluster=` (src/state/url.ts, D-0.7.0-044) and a
    // committed `cluster` resolves to the 'drought' default whenever
    // `layers` is present, which would silently withdraw the wildfire-only
    // Fire3D control this test needs. So the boot URL carries only
    // `cluster=wildfire&fire3d=true` (mirrors the perimeter-ribbon test
    // below); telemetry is switched on afterward through the layer
    // checkbox, a separate runtime action. That action demotes the
    // committed cluster to 'custom' too (src/state/cluster-service.ts; see
    // the perimeter-ribbon test's own note two tests down), which would
    // stop a NOT-YET-ACTIVE scene from ever starting, but an ALREADY-ACTIVE
    // scene stays up regardless, so activating fire3d FIRST and only then
    // checking the telemetry box keeps the scene alive for the rest of
    // this test.
    await gotoApp(page, '?region=washington_state&cluster=wildfire&fire3d=true');
    await expect
      .poll(() => fire3dStamp(page), { timeout: 30_000 })
      .toBe('active');
    // The scene publishes 'active' as soon as its context layers activate
    // (src/map/fire3d.ts:`activateScene`, the final `publishStatus('active',
    // null)`), while the terrain DEM and the hazard drape
    // can still be streaming tiles under it; on the software
    // renderer every arriving tile re-renders the pitch-60 scene, and that
    // traffic starved telemetry's own first activation (a dynamic import,
    // six stubbed fetches, and the marker render) when it was checked
    // immediately after 'active' (recorded 2026-09-10/11, intermittent).
    // `Fire3DStatus.transport` names exactly the honest condition to wait
    // for instead of a fixed sleep: it reads 'settled' only once every
    // scene source reports loaded. Its own 25 s waitForLayerSettled budget
    // below is unchanged; this wait is a new, separate one ahead of it.
    await expect
      .poll(() => fire3dTransportStamp(page), { timeout: 60_000 })
      .toBe('settled');
    // 'settled' says every scene SOURCE has loaded. It says nothing about
    // whether SwiftShader has finished DRAWING them, and that queue is the
    // stall documented at the top of this case: the page cannot see it, and
    // the first GPU readback pays all of it at once. So drain it here, on
    // purpose, in a step with no budget of its own, rather than leave it to
    // be paid inside the 25 s telemetry wait by the markers' own occlusion
    // reads. One 1x1 `readPixels` on the map's own context is the whole
    // drain; it blocked 5.8 to 11.9 s on the settled scene (four runs, two
    // workers) and a second and third read right behind it returned in
    // 0 to 1 ms, and with the pulse gone nothing refills the queue. The
    // markers' twelve reads then cost 41 to 96 ms in total instead of the
    // 10 to 61 s that failed this wait.
    await page.evaluate(() => {
      const canvas = document.querySelector(
        'canvas.maplibregl-canvas'
      ) as HTMLCanvasElement | null;
      const gl = (canvas?.getContext('webgl2') ??
        canvas?.getContext('webgl')) as WebGLRenderingContext | null;
      gl?.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    });
    await layerCheckbox(page, 'telemetry').check();
    await waitForLayerSettled(page, 'telemetry');
    // The scene must have survived the cluster demotion the layer checkbox
    // causes; if it did not, that is a real product regression this test
    // must fail on, not silently work around.
    expect(await fire3dStamp(page)).toBe('active');

    // Let the fire3d camera's own transition settle (FIRE3D_CAMERA_TRANSITION_MS
    // above) before touching the sidebar: mid-transition camera movement
    // keeps firing `moveend`, which keeps re-running telemetry's own
    // viewport discovery and reflowing the "Conditions in view" panel,
    // which kept the panel-reveal button's position from ever reading as
    // stable to Playwright's actionability check in the first run of this
    // test (mirrors the fixed settle waits already used elsewhere in this
    // file, for example the terrain-tile wait two tests up; live basemap
    // and camera-driven tiles make networkidle nondeterministic here).
    await page.waitForTimeout(2_000);

    // Fly the (already active) scene's camera to the curated Ice Harbor
    // Dam station's OWN marker (`flyToStation`, src/layers/telemetry.ts;
    // the same mechanism tests/tribal-live-layers.spec.ts uses on the flat
    // map), which sets zoom to `Math.max(currentZoom, 9)` and centers the
    // camera on it, triggering the moveend-based viewport discovery
    // (`discoverStationsForViewport`, src/config/station-registry.ts) that
    // finds the stubbed RAWS feature at that same point. A first attempt
    // here tried to also hover the map canvas afterward (to drive an extra
    // zoom-in step, on a since-withdrawn theory that fire3d's pitch made
    // the discovery viewport too wide): that hover deadlocked, because
    // `flyToStation` centers the camera exactly on the station, so the
    // newly-created marker itself sits at the canvas's own center point and
    // permanently intercepts the hover's pointer target. No zoom
    // compensation is needed; the marker is found by the same mechanism and
    // the same zoom level as the flat-map test.
    await page.locator('#telemetry-reveal').click();

    const marker = page.locator(
      `.telemetry-marker[data-telemetry-station-id="${RAWS_FIXTURE_MARKER_ID}"]`
    );
    // The marker exists only after a viewport discovery pass finds the
    // stubbed RAWS feature, and discovery is driven by `moveend`
    // (`discoverStationsForViewport`, src/config/station-registry.ts, behind
    // telemetry's own moveend debounce). ONE click, then one wait: this
    // case used to re-click the row inside a `toPass` on the theory that a
    // fly's discovery could be superseded or aborted and never re-run. The
    // s28 instrumentation (2026-09-11, 17 runs) found no such loss: 22
    // clicks gave 22 moveends, a re-click at the station's own center and
    // zoom included (MapLibre's flyTo falls through to easeTo and still
    // ends in moveend), and 21 discovery passes (the 22nd moveend landed
    // as its test closed the page); every pass at zoom 9 under pitch 60
    // read 6.20 raw square degrees against the 25 gate, 20 of the 21
    // passes finished before their test closed the page and all 20
    // returned the RAWS record, and none took the superseded or aborted
    // exit. The failures were the renderer stalls documented at the top of
    // this case. A retry would also hide a real lost pass, which is exactly
    // the regression this wait should catch. The 90 s is the retry loop's
    // own former budget, not a longer one.
    await page.locator('.telemetry-item', { hasText: 'Ice Harbor Dam' }).click();
    await expect(marker).toHaveCount(1, { timeout: 90_000 });
    expect(await fire3dStamp(page)).toBe('active');

    await expect(marker).toHaveClass(/maplibregl-marker/);
    const transform = await marker.evaluate((el) => (el as HTMLElement).style.transform);
    // MapLibre's own `Marker._update` writes exactly this shape
    // (`translate(-50%, -50%) translate(<x>px, <y>px) ...`); DDM never sets
    // a transform on this element.
    expect(transform).toMatch(/translate\(-50%, -50%\) translate\(/);

    await expect(marker.locator('svg[data-telemetry-wind-glyph]')).toHaveCount(1);
  });

  test('the perimeter ribbon follows the perimeter layer, not the other way round', async ({
    page
  }) => {
    // A terrain build plus the perimeter fetch on the software renderer.
    test.setTimeout(180_000);
    // Reduced motion, as the RAWS marker and extra-layer cases run, and the
    // answered-read waits (UNANSWERED_READ_CHARGE_MS), both for found-145:
    // GitHub's retry traces of this case (runs 37317297848 and 37347470195)
    // have the page frozen 21.3 to 37.1 s inside each gesture, and the
    // ribbon stamp read `on` once, 70 ms after a 41.7 s uncheck, before the
    // page froze again for the rest of the 30 s poll; the off path is a
    // registry change after the layer's 250 ms fade
    // (src/state/layer-controller.ts deactivateInternal), which a page that
    // does not run cannot reach. What this case asserts (the ribbon follows
    // the perimeter layer in, out, back in and off) reads stamps and the
    // legend, never the camera path, the pulse or the fade, so it does not
    // depend on animation; the animated enter and exit are the desktop
    // toggle case's.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await stubWildfireFeeds(page);
    await stubDeepTerrainArchive(page);
    await gotoApp(page, '?region=washington_state&cluster=wildfire&fire3d=true');

    await stampReaches(page, fire3dStamp, 'active', 30_000, 'the scene never stamped active');
    await layerSettles(page, 'nifc-fires');
    // The perimeter data lands after the scene does, so the ribbon arrives
    // on the layer's status seam rather than on a toggle.
    await stampReaches(page, fire3dRibbonStamp, 'on', 30_000, 'the ribbon never stamped on');

    const ribbonLegendSelector = '.legend-section[data-legend="nifc-perimeter-ribbon"]';
    const ribbonLegend = page.locator(ribbonLegendSelector);
    await expect(ribbonLegend).toHaveCount(1);
    await textComesToContain(page, ribbonLegendSelector, PERIMETER_RIBBON_QUALIFICATION, 10_000);

    // Leaving the scene takes the ribbon and its legend with it, and the
    // flat perimeter carries on alone.
    await page.locator(TOGGLE).click();
    await stampReaches(page, fire3dStamp, 'inactive', 10_000, 'the scene never stamped inactive');
    expect(await fire3dRibbonStamp(page)).toBeUndefined();
    await expect(ribbonLegend).toHaveCount(0);
    await expect(layerCheckbox(page, 'nifc-fires')).toBeChecked();

    // Re-entering rebuilds it from the perimeters already on the map.
    await page.locator(TOGGLE).click();
    await stampReaches(page, fire3dStamp, 'active', 30_000, 'the scene never stamped active again');
    await stampReaches(page, fire3dRibbonStamp, 'on', 30_000, 'the ribbon never stamped on again');

    // Turning the perimeter layer off takes the ribbon with it while the
    // scene stays up: the ribbon is a re-presentation of that layer and has
    // no life of its own. The layer change demotes the committed cluster to
    // custom while a fire event layer keeps the scene alive.
    await layerCheckbox(page, 'nifc-fires').uncheck();
    await stampReaches(
      page,
      fire3dRibbonStamp,
      'off',
      30_000,
      'the ribbon outlived its perimeter layer'
    );
    await expect(ribbonLegend).toHaveCount(0);
    expect(await fire3dStamp(page)).toBe('active');

    // The 3D button stays while that scene is up: it is the direct way out.
    await expect(page.locator(TOGGLE)).toHaveAttribute('aria-pressed', 'true');
    await page.locator(TOGGLE).click();
    await stampReaches(page, fire3dStamp, 'inactive', 10_000, 'the 3D button did not end the custom scene');
    await expect(page.locator(TOGGLE)).toHaveCount(0);
  });

  test('unchecking perimeters removes a ribbon whose pulse is advancing', async ({ page }) => {
    test.setTimeout(180_000);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    // Observe the actual map constructor, as in flow-wire. Its methods and
    // animation loop are left intact; there is no production test handle.
    type RibbonWindow = Window & { __ribbonMaps: MlMap[] };
    await page.addInitScript(() => {
      const maps: MlMap[] = [];
      (window as unknown as RibbonWindow).__ribbonMaps = maps;
      Object.defineProperty(Object.prototype, '_onWindowOnline', {
        configurable: true,
        set(this: MlMap, value: unknown) {
          Object.defineProperty(this, '_onWindowOnline', { configurable: true, enumerable: true, writable: true, value });
          maps.push(this);
        }
      });
    });
    await stubWildfireFeeds(page);
    await stubDeepTerrainArchive(page);
    await gotoApp(page, '?region=washington_state&cluster=wildfire&fire3d=true');
    await stampReaches(page, fire3dStamp, 'active', 30_000, 'the animated scene never stamped active');
    await layerSettles(page, 'nifc-fires');
    await stampReaches(page, fire3dRibbonStamp, 'on', 30_000, 'the animated ribbon never stamped on');
    const ribbonLegend = page.locator('.legend-section[data-legend="nifc-perimeter-ribbon"]');
    await expect(ribbonLegend).toHaveCount(1);
    await expect(layerCheckbox(page, 'nifc-fires')).toBeChecked();

    const paint = (): Promise<string | null> => page.evaluate((layerId) => {
      const map = (window as unknown as RibbonWindow).__ribbonMaps.find((candidate) => candidate.getContainer().id === 'map')!;
      if (!map.getLayer(layerId)) return null;
      const color = map.getPaintProperty(layerId, 'fill-extrusion-color');
      return color === undefined ? null : JSON.stringify(color);
    }, PERIMETER_RIBBON_LAYER_IDS[0]!);
    const firstPaint = await untilAnswered(paint, (value) => value !== null, 30_000, 'the ribbon has no paint');
    await untilAnswered(paint, (value) => value !== null && value !== firstPaint, 30_000, 'the ribbon pulse did not advance');

    // The gesture is meaningful only after live animation is observed. This
    // covers functional removal, not a frame-time or responsiveness budget.
    await layerCheckbox(page, 'nifc-fires').uncheck();
    await stampReaches(page, fire3dRibbonStamp, 'off', 30_000, 'the animated ribbon outlived its perimeter layer');
    await expect(layerCheckbox(page, 'nifc-fires')).not.toBeChecked();
    await expect(ribbonLegend).toHaveCount(0);
    expect(await fire3dStamp(page)).toBe('active');
    await untilAnswered(() => page.evaluate((ids) => {
      const map = (window as unknown as RibbonWindow).__ribbonMaps.find((candidate) => candidate.getContainer().id === 'map')!;
      return ids.some((id) => map.getLayer(id) !== undefined);
    }, [...PERIMETER_RIBBON_LAYER_IDS]), (anyRibbonLayer) => !anyRibbonLayer, 30_000, 'a ribbon layer survived uncheck');
  });

  test('a shared fire3d link boots active and ordinary URL writes preserve the flag', async ({
    page
  }) => {
    // The region write moves the scene to central Oregon, where the buildings
    // draw. On the software renderer that took this case from 33 s to 52 to 66 s
    // (Validate 43374700820, 43391207193, 43398503201), past the default 60 s
    // in teardown with every assertion passing. Same budget as its neighbours.
    test.setTimeout(120_000);
    await stubWildfireFeeds(page);
    await stubDeepTerrainArchive(page);
    await gotoApp(page, '?region=washington_state&cluster=wildfire&fire3d=true', {
      boundaries: EVIDENCE_BOUNDARIES
    });

    await expect
      .poll(() => fire3dStamp(page), { timeout: 30_000 })
      .toBe('active');
    await expect(page.locator(TOGGLE)).toHaveAttribute('aria-pressed', 'true');
    expect(await search(page)).toContain('fire3d=true');

    // An unrelated ordinary region write must preserve the flag (the
    // heatday preservation idiom inside syncUrl).
    await page
      .locator('#region-select')
      .selectOption('region:central_oregon', { force: true });
    // 20 s, not the default 10: the write itself is synchronous, but the
    // gesture competes with terrain tile work on the software renderer, and
    // a starved frame should not be what decides a URL contract. The same
    // budget is used for the URL assertions in the view-contract matrix.
    await expect
      .poll(async () => new URLSearchParams(await search(page)).get('region'), {
        timeout: 20_000
      })
      .toBe('central_oregon');
    expect(await search(page)).toContain('fire3d=true');
  });

  test('reduced motion still enters and leaves the 3D scene', async ({
    page
  }) => {
    test.setTimeout(120_000);
    await stubWildfireFeeds(page);
    await stubDeepTerrainArchive(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await gotoApp(page, '?region=washington_state&cluster=wildfire&fire3d=true');

    await expect
      .poll(() => fire3dStamp(page), { timeout: 30_000 })
      .toBe('active');
    if (CAPTURE_EVIDENCE) {
      // Only the optional screenshot needs the additional terrain-tile settle.
      await page.waitForTimeout(4_000);
      await page.screenshot({
        path: 'fire3d-evidence/fire3d-reduced-motion.png'
      });
    }

    await page.locator(TOGGLE).click();
    await expect.poll(() => fire3dStamp(page)).toBe('inactive');
    await expect.poll(async () => search(page)).not.toContain('fire3d');
  });

  test('embed stays chrome-inert while a URL-named fire3d still drives the map effect', async ({
    page
  }) => {
    // Unlike every other heavy case in this block (120_000-180_000), this one
    // declared no budget and inherited the global 60_000 while doing the most
    // expensive boot in the file: an evidence-bearing boot (EVIDENCE_BOUNDARIES
    // is `live` during a `DDM_CAPTURE_EVIDENCE=1` capture pass, so it then pays
    // real agency latency; the measurement below was taken that way, back when
    // every local run was a capture run), a full 3D activation,
    // then four expect.poll chains with 30_000 ceilings of their own. That is
    // the exact shape playwright.config.ts warns about: the budget has to sit
    // above boot plus the chain, or a correctly-behaving app fails on a slow
    // upstream day. Measured 2026-09-01 on this laptop: 1.1 minutes, red
    // locally against 60_000, green in CI only because retries absorb it
    // (Validate 33452141530, 33444784737). Match the other evidence-bearing
    // case above rather than the cheaper siblings.
    test.setTimeout(180_000);
    await stubWildfireFeeds(page);
    await stubDeepTerrainArchive(page);
    await gotoApp(page, '?region=washington_state&cluster=wildfire&fire3d=true&embed=true', {
      boundaries: EVIDENCE_BOUNDARIES
    });

    await expect
      .poll(() => fire3dStamp(page), { timeout: 30_000 })
      .toBe('active');
    // The shell panel is hidden in embeds, so the toggle is inert chrome.
    await expect(page.locator(TOGGLE)).not.toBeVisible();
    expect(await search(page)).toContain('embed=true');
    expect(await search(page)).toContain('fire3d=true');

    // The honesty surfaces travel with the map in embeds: the disclosure
    // chip renders while the scene is active, carrying the non-prediction
    // statement, the coverage note, and the hazard drape's vintage line.
    const embedNote = page.locator('#fire3d-embed-note');
    await expect(embedNote).toBeVisible();
    await expect(embedNote).toContainText(FIRE3D_NON_PREDICTION_NOTE);
    await expect(embedNote).toContainText(FIRE3D_COVERAGE_NOTE);
    await expect
      .poll(() => embedNote.textContent(), { timeout: 30_000 })
      .toContain('Wildfire Hazard Potential 2023');
    // ...and it describes ONLY what rendered. Power infrastructure is a
    // catalog layer since 2026-08-19 and is off in this embed, so the chip
    // must not claim a grid the viewer cannot see.
    await expect
      .poll(() => embedNote.textContent())
      .not.toContain('HIFLD transmission lines');
    // The buildings add no line of their own: nothing about their source
    // prints on the map (owner, 2026-11-12).
    expect(await embedNote.textContent()).not.toMatch(
      /FEMA|Oak Ridge|USA Structures|structure data|pilot area/i
    );
    if (CAPTURE_EVIDENCE) {
      await page.screenshot({
        path: 'fire3d-evidence/fire3d-embed-disclosure.png'
      });
    }
  });

  test('the Buildings key row shows only where a building can draw', async ({ page }) => {
    test.setTimeout(120_000);
    // The real map, observed at its constructor (no production test handle).
    await observeW2Map(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await stubWildfireFeeds(page);
    await stubDeepTerrainArchive(page);
    await gotoApp(page, '?region=washington_state&cluster=wildfire&fire3d=true');
    await stampReaches(page, fire3dStamp, 'active', 30_000, 'the scene never stamped active');
    await stampReaches(
      page,
      fire3dContextStamp,
      'whp structures',
      30_000,
      'the context layers never stamped whp structures'
    );
    // The state view is below the archive's zoom 13 floor: no row.
    const structuresLegend = page.locator('.legend-section[data-legend="structures-3d"]');
    await expect(structuresLegend).toHaveCount(0);

    // Bend, inside the archive's box, at its first stored zoom. The key is
    // one swatch and the one word: no credit, source line or caveat on the
    // map or in its key (owner, 2026-11-12).
    await page.evaluate(() => {
      const map = (window as unknown as W2Window).__w2Maps.find((candidate) => candidate.getContainer().id === 'map')!;
      map.jumpTo({ center: [-121.31, 44.06], zoom: 13 });
    });
    await expect(structuresLegend).toHaveText('Buildings');
  });

  test('an empty smoke read says so in the 3D control instead of looking broken', async ({
  page
}) => {
  test.setTimeout(150_000);
  await stubWildfireFeeds(page);
  await stubDeepTerrainArchive(page);
  // Registered AFTER the shared stub, so it wins: HMS answers with a valid
  // but EMPTY collection, which is an ordinary and correct answer from a
  // daytime satellite analysis product.
  await page.route(
    (url) => url.href.includes('NOAA_Satellite_Smoke_Detection'),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/geo+json',
        body: JSON.stringify({ type: 'FeatureCollection', features: [] })
      })
  );
  await gotoApp(page, '?region=washington_state&cluster=wildfire&fire3d=true');

  await expect
    .poll(() => fire3dStamp(page), { timeout: 60_000 })
    .toBe('active');

  // The scene still reports the volume, because the source is there and
  // the extrusion is over it; there is simply nothing in it. Without the
  // line below, that reads as a broken feature rather than an answer.
  const empty = page.locator('[data-fire3d-empty-smoke]');
  await expect(empty).toBeHidden();
  await page.locator('.shell-fire3d-details > summary').click();
  await expect(empty).toBeVisible();
  await expect(empty).toContainText('No current smoke plumes in view');
  // The standing notes stay countable: the empty line carries its own
  // class so it cannot be mistaken for one of them.
  await expect(page.locator('.shell-fire3d-note')).toHaveCount(2);
});

test('a failed smoke read says smoke is unavailable in the 3D control, not that it stays in a flat veil', async ({
  page
}) => {
  test.setTimeout(150_000);
  await stubWildfireFeeds(page);
  await stubDeepTerrainArchive(page);
  // Registered AFTER the shared stub, so it wins: the HMS service fails, so
  // there is no volume and no flat veil either.
  await page.route(
    (url) => url.href.includes('NOAA_Satellite_Smoke_Detection'),
    (route) => route.fulfill({ status: 503, body: 'unavailable' })
  );
  await gotoApp(page, '?region=washington_state&cluster=wildfire&fire3d=true');

  await expect
    .poll(() => fire3dStamp(page), { timeout: 60_000 })
    .toBe('active');
  await page.locator('.shell-fire3d-details > summary').click();
  const line = page.locator('.shell-fire3d-status');
  await expect(line).toHaveText('Live (partial): terrain relief; smoke is unavailable.', { timeout: 30_000 });
  await expect(page.locator('.legend-section[data-legend="hms-smoke-volume"]')).toHaveCount(0);
});

test('an embed without the flag never activates and never gains it', async ({
    page
  }) => {
    await stubWildfireFeeds(page);
    await gotoApp(page, '?region=washington_state&cluster=wildfire&embed=true');

    await page.waitForTimeout(3_000);
    expect(await fire3dStamp(page)).not.toBe('active');
    expect(await search(page)).not.toContain('fire3d');
    // No scene, no chip.
    await expect(page.locator('#fire3d-embed-note')).toHaveCount(0);
  });

  test('a phone-width embed never fetches the 3D chunks', async ({ page }) => {
    await stubWildfireFeeds(page);
    // Only the 3D chunks themselves are forbidden here. The tiny
    // fire3d-presentation constants chunk legitimately rides the shell
    // island (the control needs the coverage note and breakpoint), and
    // the document URL itself carries the fire3d parameter.
    const chunkRequests: string[] = [];
    page.on('request', (request) => {
      if (
        // `fire3d-ground-layers` is the two ground switches' 0.2 kB store, which the console imports at boot.
        // `fire3d-fuel-risk` is the pure 0.3 kB fuel-risk helper the map key imports at boot.
        /assets\/(?:fire3d-(?!presentation|ground-layers|fuel-risk)|hms-smoke-volume-)/.test(
          request.url()
        )
      ) {
        chunkRequests.push(request.url());
      }
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await gotoApp(page, '?region=washington_state&cluster=wildfire&fire3d=true&embed=true');
    await page.waitForTimeout(3_000);

    expect(chunkRequests).toEqual([]);
    expect(await fire3dStamp(page)).toBeUndefined();
    // An embed has no phone shell and so no 3D chrome. Below the console width only
    // that chrome can present the scene, so a phone-width embed stays flat and fetches
    // nothing (review finding R2-10, src/main.ts fire3dPresentable). A phone outside an
    // embed does enter the scene since the sprint; see the next test.
    await expect(page.locator('#shell-fire3d-refused')).toHaveCount(0);
    // The cell is created in every shell and offered only by the phone shell (src/ui/fire3d-phone.ts).
    await expect(page.locator('#fire3d-phone-cell')).toBeHidden();
    await expect(page.locator('#app[data-fire3d-phone]')).toHaveCount(0);
  });

  test('a phone that opens a fire3d=true link enters the scene behind its card', async ({
    page
  }) => {
    test.setTimeout(150_000);
    await stubWildfireFeeds(page);
    await stubDeepTerrainArchive(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoApp(page, '?region=washington_state&cluster=wildfire&fire3d=true');
    await expect.poll(() => fire3dStamp(page), { timeout: 60_000 }).toBe('active');
    await expect(page.locator('#app[data-fire3d-phone]')).toHaveCount(1);
    await expect(page.locator('#fire3d-phone-card')).toBeVisible();
    await expect(page.locator('#fire3d-phone-cell')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#shell-fire3d-refused')).toHaveCount(0);
  });

  test('a short desktop window explains its 3D refusal and never enters the scene', async ({
    page
  }) => {
    await stubWildfireFeeds(page);
    // 844 x 390 is the same phone rotated: wider than the desktop
    // breakpoint, shorter than FIRE3D_MIN_HEIGHT_PX. The map-side gate
    // refuses the scene on height (DR-025a); the control must agree and
    // withdraw rather than offer a button whose scene cannot come. The
    // width-only control was the last place the old rule survived.
    await page.setViewportSize({ width: 844, height: 390 });
    await gotoApp(page, '?region=washington_state&cluster=wildfire&fire3d=true');
    await page.waitForTimeout(3_000);

    await expect(page.locator('#shell-fire3d')).toHaveCount(0);
    // DDM-P9-T02's first acceptance clause: a device that cannot render the
    // scene is TOLD so. Withdrawing the button silently left this reader
    // with an interface indistinguishable from one where the 3D view had
    // never been built, which is the defect this case exists to catch.
    const refusal = page.locator('#shell-fire3d-refused');
    await expect(refusal).toBeVisible();
    await expect(refusal).toHaveText(FIRE3D_REFUSAL_TEXT['short-window']);
    await expect(refusal).toHaveAttribute(
      'data-fire3d-refused',
      'short-window'
    );
    // The ask itself is kept (the preference is the user's durable request
    // and the gate, not the URL, decides); only the scene is refused.
    expect(await fire3dStamp(page)).not.toBe('active');

    // Rotating back to tall geometry restores the offer: the control
    // watches both queries, not only the width. The sentence goes with it,
    // because it has stopped being true.
    await page.setViewportSize({ width: 1024, height: 768 });
    await expect(page.locator('#shell-fire3d')).toHaveCount(1);
    await expect(refusal).toHaveCount(0);
  });

  test('a scene ended by a short window leaves no 3D refusal behind in Drought', async ({ page }) => {
    test.setTimeout(150_000);
    await stubWildfireFeeds(page);
    await stubDeepTerrainArchive(page);
    await page.setViewportSize({ width: 1024, height: 768 });
    await gotoApp(page, '?region=washington_state&cluster=wildfire&fire3d=true');
    await expect.poll(() => fire3dStamp(page), { timeout: 60_000 }).toBe('active');

    // Too short: the control hides and the map gate ends the scene. The
    // control must not keep the last 'active' it heard while hidden, or that
    // stale status would keep 3D wording in a mode that has no 3D.
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(page.locator('#shell-fire3d-refused')).toHaveAttribute('data-fire3d-refused', 'short-window');
    await stampReaches(page, fire3dStamp, 'inactive', 10_000, 'the short window did not end the scene');

    await page.locator('.shell-cluster-btn[data-cluster="drought"]').click();
    await expect(page.locator('#shell-fire3d-refused')).toHaveCount(0);
    await expect(page.locator('#shell-fire3d')).toHaveCount(0);
  });

  test.describe('landscape touch screens', () => {
    test.use({ hasTouch: true });

    test('a landscape phone shows no 3D control or refusal notice', async ({ page }) => {
      await stubWildfireFeeds(page);
      await page.setViewportSize({ width: 844, height: 390 });
      await gotoApp(page, '?region=washington_state&cluster=wildfire&fire3d=true');
      await expect(page.locator('#shell-fire3d')).toHaveCount(0);
      await expect(page.locator('#shell-fire3d-refused')).toBeHidden();
      expect(await fire3dStamp(page)).not.toBe('active');
    });
  });

  test('a corrupt archive reads unavailable in the control and drops the flag', async ({
    page
  }) => {
    await stubWildfireFeeds(page);
    // The deep archive resolves before the bundled one (DR-079): left
    // unstubbed, the probe below would succeed against the real Worker and
    // this case would never reach the corrupted BUNDLED fixture at all.
    await stubDeepTerrainArchive(page);
    // Boot against the REAL bundled archive first: the default-on
    // hillshade layer shares the archive, and corrupting it at boot would
    // fail hillshade, honestly demote the cluster to custom, and hide
    // this control before the click. Only the fire3d probe sees the
    // corruption.
    await gotoApp(page, '?region=washington_state&cluster=wildfire');
    await waitForLayerSettled(page, 'hillshade');

    // One glob covers the bundled path AND the ATNI fallback copy (both
    // end in the same file name), so the resolver honestly exhausts its
    // ladder (the u4g corrupt-archive fixture idiom).
    await page.route('**/hillshade-dem-pnw.pmtiles*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<html>not tiles</html>'
      })
    );

    const toggle = page.locator(TOGGLE);
    await toggle.click();
    // The corrupt probe fails within milliseconds, so the pressed state is
    // transient by design (the press flip itself is asserted in the
    // desktop activation case); this case asserts the terminal truths.
    await expect
      .poll(() => fire3dStamp(page), { timeout: 30_000 })
      .toBe('unavailable');
    await expect(page.locator('.shell-fire3d-status')).toContainText(
      'Unavailable'
    );
    // The honest demotion: preference off, flag gone, cluster preserved.
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(async () => search(page)).not.toContain('fire3d');
    expect(await search(page)).toContain('cluster=wildfire');
  });

  test('one extra reference layer keeps the scene; losing every fire layer or the cluster exits it', async ({
    page
  }) => {
    // The drape's tile fan-out on the software renderer pushes this
    // multi-toggle walk past the default budget; give it explicit room.
    // 120_000 was not enough room. Measured 2026-09-01 on this laptop: the
    // walk builds terrain, adds `places`, tears the smoke volume down, then
    // unchecks the last fire layer, and the budget expired around the
    // `hms-smoke` uncheck below (the call log shows the click completing)
    // at 2.1 minutes, red locally and green in CI on retry. Nothing here is
    // slower than the scene-building siblings, so carry their ceiling.
    test.setTimeout(180_000);
    // Reduced motion, as the RAWS marker case runs (its comment above carries
    // the pulse measurements; re-measured 2026-10-05, S30D B3 CI3: the
    // wildfire pulse keeps refilling the software renderer's draw queue, 1.7
    // to 2.3 s drains that never emptied in 8 rounds, and with it gone the
    // queue emptied in 2 to 4 rounds at 1x, 4x and 6x CPU). What this case
    // asserts (the scene survives an extra reference layer, the smoke volume
    // follows its layer, losing the last fire layer or the cluster exits the
    // scene) reads stamps and the URL, never the camera path or the pulse
    // colour, so it does not depend on animation; the animated enter and exit
    // are the desktop toggle case's, and reduced motion's own is the case
    // further down.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await stubWildfireFeeds(page);
    await stubDeepTerrainArchive(page);
    // found-126: the scene is held streaming while `places` comes on. Every
    // hazard drape tile read is parked (the header and root directory reads,
    // `bytes=0-...`, pass, so the drape still activates and the scene still
    // stamps active), which keeps the drape source loading and the scene's
    // own `transport` stamp at `streaming` (src/map/fire3d.ts
    // deriveSceneTransport) until the case releases them below.
    const heldDrapeReads: Route[] = [];
    let holdDrapeReads = true;
    await page.route('**/data/whp-2023-pnw.pmtiles', async (route) => {
      const range = route.request().headers()['range'] ?? '';
      if (!holdDrapeReads || range.startsWith('bytes=0-')) {
        await route.fallback();
        return;
      }
      heldDrapeReads.push(route);
    });
    const releaseDrapeReads = async (): Promise<void> => {
      holdDrapeReads = false;
      for (const route of heldDrapeReads.splice(0)) await route.fallback();
    };
    await gotoApp(page, '?region=washington_state&cluster=wildfire&view=console&fire3d=true');

    await stampReaches(page, fire3dStamp, 'active', 30_000, 'the scene never stamped active');
    await layerSettles(page, 'nifc-fires');
    await layerSettles(page, 'hms-smoke');

    // Add one bundled reference layer while the scene is still streaming:
    // the display honestly demotes to a custom layer set (cluster= leaves the
    // URL), the scene stays, and `places` reaches ready inside it.
    //
    // Why this replaced the wait for the scene to settle (found-126): GitHub
    // run 37238546758 failed `places` inside waitForLayerSettled's 25 s, and
    // the settle wait that followed would also have hidden a `places` that
    // never loads in a streaming scene. The retry trace of that run shows the
    // cause: the `places` check itself took 25.6 s (the page frozen by the
    // software renderer, the stall the RAWS marker case documents) and the
    // pill was terminal 142 ms later. `places` reads a bundled same-origin
    // file and adds one symbol layer (src/layers/places.ts activate), with no
    // dependency on the scene's sources. Locally at 6x CPU throttling
    // (2026-10-05, the pre-B6 shape: no hold, no reduced motion) the check
    // itself took 29.1 s and the pill read ready 14.3 s later with the scene
    // still streaming; with the drape held it read ready 355 ms after the
    // check. So the case asserts that, on the answered-read clock, with the
    // same 25 s budget: a frozen page is not charged, and a `places` stuck in
    // loading while the scene streams fails here.
    expect(await fire3dTransportStamp(page)).toBe('streaming');
    await layerCheckbox(page, 'places').check();
    expect(await layerSettles(page, 'places')).toBe('ready');
    expect(await fire3dTransportStamp(page)).toBe('streaming');
    expect(heldDrapeReads.length).toBeGreaterThan(0);
    await releaseDrapeReads();
    await searchSettles(page, (q) => !q.includes('cluster='), 10_000, 'the URL kept cluster=');
    expect(await fire3dStamp(page)).toBe('active');

    // Removing the smoke layer keeps terrain but honestly downgrades the
    // smoke read to (absent) flat; the volume never outlives its layer.
    await layerCheckbox(page, 'hms-smoke').uncheck();
    await stampReaches(page, fire3dSmokeStamp, 'flat', 10_000, 'the smoke never stamped flat');
    expect(await fire3dStamp(page)).toBe('active');
    await expect(
      page.locator('.legend-section[data-legend="hms-smoke-volume"]')
    ).toHaveCount(0);

    // Removing the last fire event layer exits the scene; the durable
    // preference (and its URL flag) survives for the next Fire view.
    await layerCheckbox(page, 'nifc-fires').uncheck();
    await stampReaches(page, fire3dStamp, 'inactive', 10_000, 'the scene never stamped inactive');
    expect(await search(page)).toContain('fire3d=true');
  });

  test('switching clusters exits the scene, hides the control and drops the preference (DR-122)', async ({
    page
  }) => {
    // Unlike its siblings above (120_000-180_000), this test declared no
    // explicit budget while doing two full cluster swaps on the software
    // renderer: enter the scene, exit it (a click that itself can outrun
    // the default 60_000 while the main thread is blocked tearing the
    // scene down), then re-enter and rebuild it. Measured report,
    // 2026-08-29: flaky in 12 of 21 CI runs, always green on retry 1,
    // `locator.click: Test timeout of 60000ms exceeded` on the drought
    // cluster button. Match the budget its build-twice workload calls for.
    test.setTimeout(150_000);
    await stubWildfireFeeds(page);
    await stubDeepTerrainArchive(page);
    await gotoApp(page, '?region=washington_state&cluster=wildfire&fire3d=true');
    await expect
      .poll(() => fire3dStamp(page), { timeout: 30_000 })
      .toBe('active');

    await page.locator('.shell-cluster-btn[data-cluster="drought"]').click();
    await expect.poll(() => fire3dStamp(page)).toBe('inactive');
    await expect(page.locator(TOGGLE)).toHaveCount(0);
    // fire3d= is Wildfire-scoped; terrain3d=, which would re-emit it on return, is not built.
    await expect.poll(() => search(page)).not.toContain('fire3d');

    await page.locator('.shell-cluster-btn[data-cluster="wildfire"]').click();
    await expect(page.locator(TOGGLE)).toHaveAttribute('aria-pressed', 'false');
    expect(await fire3dStamp(page)).toBe('inactive');
    expect(await search(page)).not.toContain('fire3d');
  });

  test('an old fire3d=true link outside Wildfire boots flat and drops the token (DR-122)', async ({
    page
  }) => {
    await stubWildfireFeeds(page);
    await gotoApp(page, '?region=washington_state&cluster=drought&fire3d=true');
    await expect.poll(() => search(page)).not.toContain('fire3d');
    await expect(page.locator(TOGGLE)).toHaveCount(0);

    // The dropped token does not come back as a preference in Wildfire.
    await page.locator('.shell-cluster-btn[data-cluster="wildfire"]').click();
    await expect(page.locator(TOGGLE)).toHaveAttribute('aria-pressed', 'false');
    expect(await search(page)).not.toContain('fire3d');
  });
});

// Exercise the protocols registered by the built application, through actual
// MapLibre sources. No replacement protocol, fake fetch, or shortened deadline.
type W2Window = Window & {
  __w2Maps: MlMap[];
  __w2Errors: Array<{ sourceId: string; name: string; message: string }>;
  __w2Data: string[];
  __w2Loading: string[];
};

async function observeW2Map(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const observed = window as unknown as W2Window;
    observed.__w2Maps = [];
    observed.__w2Errors = [];
    observed.__w2Data = [];
    observed.__w2Loading = [];
    Object.defineProperty(Object.prototype, '_onWindowOnline', {
      configurable: true,
      set(this: MlMap, value: unknown) {
        Object.defineProperty(this, '_onWindowOnline', {
          configurable: true, enumerable: true, writable: true, value
        });
        observed.__w2Maps.push(this);
      }
    });
  });
}

async function bootW2Consumers(page: Page): Promise<void> {
  await observeW2Map(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await stubWildfireFeeds(page);
  await stubDeepTerrainArchive(page);
  await gotoApp(page, '?region=washington_state&cluster=wildfire&fire3d=true');
  // On the answered-read clock, like the scene cases above: GitHub run
  // 38304871630 failed five of these boots at a wall-clock 30 s still reading
  // "checking" and passed every one on retry, the page frozen by the software
  // renderer with the plant-stress ground mounting.
  await stampReaches(page, fire3dStamp, 'active', 30_000, 'the scene never stamped active');
  // Fire3D registers whp-shade. Stop its scene before testing transport so its
  // rendering load does not obscure the native 15 s network deadline.
  await page.locator(TOGGLE).click();
  await stampReaches(page, fire3dStamp, 'inactive', 30_000, 'the scene never stamped inactive');
  await page.evaluate(() => {
    const observed = window as unknown as W2Window;
    const map = observed.__w2Maps.find((candidate) => candidate.getContainer().id === 'map')!;
    map.on('error', (event) => {
      const sourceId = (event as unknown as { sourceId?: string }).sourceId;
      if (sourceId?.startsWith('w2-')) observed.__w2Errors.push({
        sourceId, name: 'name' in event.error ? String(event.error.name) : '', message: event.error.message
      });
    });
    map.on('sourcedata', (event) => {
      // removeSource emits a synthetic metadata event after deleting the source.
      // Count successful source content, not that teardown notification.
      if (event.sourceId.startsWith('w2-') && event.sourceDataType === 'content') {
        observed.__w2Data.push(event.sourceId);
      }
    });
    map.on('sourcedataloading', (event) => {
      if (event.sourceId.startsWith('w2-')) observed.__w2Loading.push(event.sourceId);
    });
  });
}

async function w2ArchiveServer(
  hold: 'headers' | 'body',
  archiveName = 'whp-2023-pnw.pmtiles',
  passProbe = false
) {
  const archive = readFileSync(join(process.cwd(), 'public/data', archiveName));
  const pending: Array<{ response: ServerResponse; bytes: Buffer; sent: number }> = [];
  const tileDataOffset = Number(archive.readBigUInt64LE(56));
  const center: [number, number] = [archive.readInt32LE(119) / 1e7, archive.readInt32LE(123) / 1e7];
  const zoom = Math.max(archive[100]!, Math.min(archive[118]!, archive[101]!));
  const state = { probeReads: 0, headerReads: 0, tileReads: 0, held: 0, cancelled: 0, released: false };
  const server = createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', 'Range');
    response.setHeader('Access-Control-Expose-Headers', 'Content-Range, ETag');
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
    if (!range) { response.writeHead(400); response.end(); return; }
    const start = Number(range[1]);
    const end = Math.min(Number(range[2]), archive.length - 1);
    const bytes = archive.subarray(start, end + 1);
    response.statusCode = 206;
    response.setHeader('Content-Type', 'application/octet-stream');
    response.setHeader('Content-Range', `bytes ${start}-${end}/${archive.length}`);
    response.setHeader('Content-Length', bytes.length);
    response.setHeader('ETag', '"w2-bundled-fixture"');
    response.setHeader('Cache-Control', 'no-store');
    if (passProbe && start === 0 && end === 126) {
      state.probeReads += 1;
      response.end(bytes);
      return;
    }
    if (start === 0) state.headerReads += 1;
    if (start >= tileDataOffset) state.tileReads += 1;
    if (start !== 0 || state.released) { response.end(bytes); return; }
    state.held += 1;
    response.on('close', () => { if (!response.writableEnded) state.cancelled += 1; });
    // Native HTTP headers without a completed body distinguish fetch settlement
    // from body settlement. Playwright route.fulfill cannot express this case.
    const sent = hold === 'body' ? 1 : 0;
    if (sent) { response.flushHeaders(); response.write(bytes.subarray(0, sent)); }
    pending.push({ response, bytes, sent });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing loopback fixture port');
  return {
    url: `http://127.0.0.1:${address.port}/whp.pmtiles`, state, center, zoom,
    release() {
      state.released = true;
      for (const { response, bytes, sent } of pending.splice(0)) {
        if (!response.destroyed) response.end(bytes.subarray(sent));
      }
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

async function addW2Source(page: Page, id: string, url: string): Promise<void> {
  await page.evaluate(({ id, url }) => {
    const map = (window as unknown as W2Window).__w2Maps.find((candidate) => candidate.getContainer().id === 'map')!;
    // Match the actual WHP archive and production whp-3d source contract.
    map.addSource(id, { type: 'raster', url, tileSize: 512 });
    map.addLayer({ id, type: 'raster', source: id });
  }, { id, url });
}

async function removeW2Source(page: Page, id: string): Promise<void> {
  await page.evaluate((id) => {
    const map = (window as unknown as W2Window).__w2Maps.find((candidate) => candidate.getContainer().id === 'map')!;
    map.removeLayer(id);
    map.removeSource(id);
  }, id);
}

test.describe('W2 registered native consumers', () => {
  test.setTimeout(120_000);

  test('hillshade native deadline downgrades its real pill; checkbox Off cancels the retry', async ({ page }) => {
    await observeW2Map(page);
    const fixture = await w2ArchiveServer('body', 'hillshade-dem-pnw.pmtiles', true);
    try {
      // Preserve the application's exact archive URL and actual DEM bytes.
      // Redirect, rather than fulfill, so the browser receives a native stream.
      await page.route('**/hillshade-dem-pnw.pmtiles*', (route) => route.fulfill({
        status: 307, headers: { location: fixture.url }, body: ''
      }));
      await gotoApp(page, '?view=console&layers=hillshade&region=washington_state', { bootIdle: false });
      const pill = page.locator('[data-layer-status="hillshade"]');
      await expect.poll(() => fixture.state.probeReads).toBe(1);
      await expect.poll(() => fixture.state.held).toBe(1);
      // Existing hillshade exception: a valid probe initially reports ready.
      await expect(pill).toHaveClass(/\bready\b/);
      await expect(pill).toHaveClass(/\berror\b/, { timeout: 20_000 });
      await expect(pill).toHaveText('unavailable');
      await expect.poll(() => fixture.state.cancelled).toBe(1);
      await layerCheckbox(page, 'hillshade').uncheck();
      await layerCheckbox(page, 'hillshade').check();
      await expect.poll(() => fixture.state.held).toBe(2);
      await expect(pill).toHaveClass(/\bready\b/);
      await layerCheckbox(page, 'hillshade').uncheck();
      await expect.poll(() => fixture.state.cancelled, { timeout: 10_000 }).toBe(2);
      fixture.release();
      await expect(layerCheckbox(page, 'hillshade')).not.toBeChecked();
      expect(await page.evaluate(() => {
        const map = (window as unknown as W2Window).__w2Maps.find((candidate) => candidate.getContainer().id === 'map')!;
        return { layer: !!map.getLayer('hillshade'), source: !!map.getSource('hillshade-dem') };
      })).toEqual({ layer: false, source: false });
    } finally { await fixture.close(); }
  });

  for (const protocol of ['pmtiles', 'whp-shade'] as const) {
    for (const hold of ['headers', 'body'] as const) {
      test(`${protocol}: held ${hold} emits a deadline error`, async ({ page }) => {
        await bootW2Consumers(page);
        const fixture = await w2ArchiveServer(hold);
        try {
          await addW2Source(page, 'w2-deadline', `${protocol}://${fixture.url}`);
          await expect.poll(() => fixture.state.held).toBe(1);
          // The product deadline is 60 listening ticks of 250 ms, counted in
          // page time, not wall-clock time: a busy software-renderer page
          // stretches the ticks, so the wall-clock wait is generous. This does
          // not amend the product budget, and cannot pass by merely aborting:
          // MapLibre suppresses AbortError instead of emitting a source error.
          await expect.poll(() => page.evaluate(() =>
            (window as unknown as W2Window).__w2Errors.filter((event) => event.sourceId === 'w2-deadline')
          ), { timeout: 45_000 }).toEqual([
            expect.objectContaining({ sourceId: 'w2-deadline', message: expect.stringContaining('PMTiles read timed out') })
          ]);
          // ensureError may wrap a DOMException. Event delivery is the contract:
          // an AbortError would have been suppressed before reaching the map.
          expect(await page.evaluate(() => (window as unknown as W2Window).__w2Errors[0]?.name)).not.toBe('AbortError');
          await expect.poll(() => fixture.state.cancelled).toBe(1);
          expect(await page.evaluate(() => (window as unknown as W2Window).__w2Data)).toEqual([]);
        } finally {
          try { await removeW2Source(page, 'w2-deadline'); }
          finally { await fixture.close(); }
        }
      });
    }

    test(`${protocol}: removing the owner cancels a native body and suppresses late data`, async ({ page }) => {
      await bootW2Consumers(page);
      const fixture = await w2ArchiveServer('body');
      try {
        await addW2Source(page, 'w2-off', `${protocol}://${fixture.url}`);
        await expect.poll(() => fixture.state.held).toBe(1);
        await removeW2Source(page, 'w2-off');
        await expect.poll(() => fixture.state.cancelled, { timeout: 10_000 }).toBe(1);
        fixture.release();
        // Diagnostic absence window after confirmed native cancellation and
        // fixture release, classified in sleep-inventory.test.mjs. This does
        // not establish readiness or replace an observable setup condition.
        await page.waitForTimeout(300);
        expect(await page.evaluate(() => {
          const observed = window as unknown as W2Window;
          const map = observed.__w2Maps.find((candidate) => candidate.getContainer().id === 'map')!;
          return { data: observed.__w2Data, errors: observed.__w2Errors,
            layer: !!map.getLayer('w2-off'), source: !!map.getSource('w2-off') };
        })).toEqual({ data: [], errors: [], layer: false, source: false });
      } finally { await fixture.close(); }
    });
  }

  test('missing WHP tile 6/9/21 completes transparently and native Off removes it', async ({ page }) => {
    await bootW2Consumers(page);
    const fixture = await w2ArchiveServer('body');
    fixture.release();
    type MissingWindow = W2Window & { __w2MissingTiles: string[] };
    const framebufferPixel = (): Promise<number[]> => page.evaluate(() => {
      const map = (window as unknown as W2Window).__w2Maps.find((candidate) => candidate.getContainer().id === 'map')!;
      // Read during the actual render callback before Chromium may discard the
      // default framebuffer. No image/paint/protocol function is substituted.
      return new Promise<number[]>((resolve) => {
        map.once('render', () => {
          const gl = map.painter.context.gl;
          const pixel = new Uint8Array(4);
          gl.readPixels(Math.floor(gl.drawingBufferWidth / 2), Math.floor(gl.drawingBufferHeight / 2),
            1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
          resolve([...pixel]);
        });
        map.triggerRepaint();
      });
    });
    try {
      await page.evaluate(() => {
        const observed = window as unknown as MissingWindow;
        observed.__w2MissingTiles = [];
        const map = observed.__w2Maps.find((candidate) => candidate.getContainer().id === 'map')!;
        map.jumpTo({ center: [-124.5, 49.25], zoom: 8, pitch: 0, bearing: 0 });
        map.on('sourcedataloading', (event) => {
          if (event.sourceId === 'w2-missing' && event.coord) {
            const { z, x, y } = event.coord.canonical;
            observed.__w2MissingTiles.push(`${z}/${x}/${y}`);
          }
        });
        // Opaque reference drawn above the application's existing map content.
        map.addLayer({ id: 'w2-missing-background', type: 'background',
          paint: { 'background-color': '#123456', 'background-opacity': 1 } });
      });
      expect(await framebufferPixel()).toEqual([18, 52, 86, 255]);
      await page.evaluate((url) => {
        const map = (window as unknown as W2Window).__w2Maps.find((candidate) => candidate.getContainer().id === 'map')!;
        // A small area wholly inside known missing 6/9/21. Pin maxzoom so the
        // native consumer requests that real archive entry, not another level.
        map.addSource('w2-missing', { type: 'raster', tileSize: 512,
          tiles: [`whp-shade://${url}/{z}/{x}/{y}`], minzoom: 6, maxzoom: 6,
          bounds: [-125, 49, -124, 49.5] });
        map.addLayer({ id: 'w2-missing', type: 'raster', source: 'w2-missing',
          paint: { 'raster-opacity': 1, 'raster-fade-duration': 0 } });
      }, fixture.url);
      await expect.poll(() => page.evaluate(() =>
        [...new Set((window as unknown as MissingWindow).__w2MissingTiles)]
      )).toEqual(['6/9/21']);
      await expect.poll(() => page.evaluate(() => {
        const map = (window as unknown as W2Window).__w2Maps.find((candidate) => candidate.getContainer().id === 'map')!;
        return map.isSourceLoaded('w2-missing');
      }), { timeout: 20_000 }).toBe(true);
      // Errors first: an errored source also reads as loaded, and its message says why the reads are missing.
      expect(await page.evaluate(() => (window as unknown as W2Window).__w2Errors)).toEqual([]);
      expect(fixture.state.headerReads).toBe(1);
      expect(fixture.state.tileReads).toBe(0);
      // Completed no-data imagery must neither invent a category nor obscure
      // the known underlying color, even with raster opacity set to one.
      expect(await framebufferPixel()).toEqual([18, 52, 86, 255]);
      await removeW2Source(page, 'w2-missing');
      expect(await page.evaluate(() => {
        const map = (window as unknown as W2Window).__w2Maps.find((candidate) => candidate.getContainer().id === 'map')!;
        return { layer: !!map.getLayer('w2-missing'), source: !!map.getSource('w2-missing') };
      })).toEqual({ layer: false, source: false });
      expect(await framebufferPixel()).toEqual([18, 52, 86, 255]);
    } finally {
      try {
        await page.evaluate(() => {
          const map = (window as unknown as W2Window).__w2Maps.find((candidate) => candidate.getContainer().id === 'map')!;
          if (map.getLayer('w2-missing')) map.removeLayer('w2-missing');
          if (map.getSource('w2-missing')) map.removeSource('w2-missing');
          if (map.getLayer('w2-missing-background')) map.removeLayer('w2-missing-background');
        });
      } finally { await fixture.close(); }
    }
  });

  test('ordinary and shaded WHP coalesce; one cancelled owner preserves its survivor and warm cache', async ({ page }) => {
    await bootW2Consumers(page);
    const fixture = await w2ArchiveServer('body');
    try {
      await page.evaluate(({ center, zoom }) => {
        const map = (window as unknown as W2Window).__w2Maps.find((candidate) => candidate.getContainer().id === 'map')!;
        map.jumpTo({ center, zoom, pitch: 0, bearing: 0 });
      }, { center: fixture.center, zoom: fixture.zoom });
      await addW2Source(page, 'w2-ordinary', `pmtiles://${fixture.url}`);
      await expect.poll(() => fixture.state.held).toBe(1);
      await addW2Source(page, 'w2-shaded', `whp-shade://${fixture.url}`);
      // Both real source owners have started loading; do not infer entry from
      // an arbitrary delay. The final warm-cache assertion also catches a
      // second header request if its HTTP dispatch arrives later.
      await expect.poll(() => page.evaluate(() => (window as unknown as W2Window).__w2Loading))
        .toEqual(['w2-ordinary', 'w2-shaded']);
      expect(fixture.state.headerReads).toBe(1);
      await removeW2Source(page, 'w2-ordinary');
      expect(fixture.state.cancelled).toBe(0);
      fixture.release();
      // A source can briefly report loaded between metadata and its first
      // render-driven tile request; require real payload work before settling.
      await expect.poll(() => fixture.state.tileReads, { timeout: 20_000 }).toBeGreaterThan(0);
      await expect.poll(() => page.evaluate(() => {
        const map = (window as unknown as W2Window).__w2Maps.find((candidate) => candidate.getContainer().id === 'map')!;
        return map.isSourceLoaded('w2-shaded');
      }), { timeout: 20_000 }).toBe(true);
      expect(fixture.state.tileReads).toBeGreaterThan(0);
      // Reusing the same URL after one owner aborts must retain the survivor's
      // resolved header/root cache, including across the protocol boundary.
      await addW2Source(page, 'w2-warm', `pmtiles://${fixture.url}`);
      await expect.poll(() => page.evaluate(() => {
        const map = (window as unknown as W2Window).__w2Maps.find((candidate) => candidate.getContainer().id === 'map')!;
        return map.isSourceLoaded('w2-warm');
      }), { timeout: 20_000 }).toBe(true);
      expect(fixture.state.headerReads).toBe(1);
      expect(await page.evaluate(() => (window as unknown as W2Window).__w2Errors)).toEqual([]);
      await removeW2Source(page, 'w2-shaded');
      await removeW2Source(page, 'w2-warm');
    } finally {
      await fixture.close();
    }
  });
});
