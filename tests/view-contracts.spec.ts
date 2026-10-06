import { readFileSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';
import { parse } from 'yaml';

import {
  gotoApp,
  layerCheckbox,
  layerPill,
  search,
  waitForLayerSettled
} from './helpers';
import { stubDeepTerrainArchive, stubWildfireFeeds } from './wildfire-fixtures';

/**
 * The cross-view contract net.
 *
 * Every other spec in this suite asks whether ONE view behaves. This one
 * asks whether a person moving BETWEEN views keeps a coherent, shareable,
 * honest claim: the committed cluster, the URL, the 3D scene stamps, and
 * the catalog rows have to agree at every stop of the walk, not just at
 * the destination.
 *
 * The matrix lives in `tests/view-contracts.yaml` so a later change extends
 * the contract by adding a row rather than by writing another spec file,
 * and so the contract is readable by someone who does not read Playwright.
 * The vocabulary is deliberately small: if a row needs an action this file
 * cannot express, add the action here as a named step rather than reaching
 * into the page from the data.
 *
 * Assertion discipline: everything asserted here is production-observable
 * (URL parameters, aria-pressed, the document-element data stamps written
 * by src/map/fire3d.ts, catalog checkbox state, chrome presence). Nothing
 * reads a dev handle, so these rows hold against the deployed artifact.
 */

const CLUSTER_KEYS = ['drought', 'wildfire', 'heat', 'enso'] as const;
const FIRE3D_TOGGLE = '.shell-fire3d-btn';

/** Terrain build plus a DEM fan-out on the software renderer is slow. */
const FIRE3D_STAMP_TIMEOUT_MS = 60_000;

/**
 * URL writes are synchronous in the application, but the gesture that
 * triggers them competes with terrain tile work on the software renderer.
 * The default 10 s expect budget is tight enough that a starved frame, not
 * a broken contract, decides the result; 20 s keeps the assertion strict
 * about the VALUE while staying honest about the machine.
 */
const URL_POLL_TIMEOUT_MS = 20_000;

type Step =
  | { click_cluster: string }
  | { fire3d: 'on' | 'off' }
  | { select_region: string }
  | { set_layer: { key: string; on: boolean } }
  | { wait_settled: string }
  | { wait_fire3d: 'active' | 'inactive' }
  | { settle_scene: true }
  | { hold_first_power_probe: number }
  | { zoom_out: number }
  | { reload: true };

interface Expectations {
  cluster_pressed?: string;
  url_params?: Record<string, string | null>;
  url_layers_include?: string[];
  url_layers_exclude?: string[];
  fire3d_stamp?: 'active' | 'inactive' | 'absent';
  fire3d_context_includes?: string[];
  fire3d_context_excludes?: string[];
  fire3d_toggle?: 'pressed' | 'unpressed' | 'absent';
  layers_checked?: string[];
  layers_unchecked?: string[];
  /** Raw LayerStatus class on the catalog pill, keyed by layer key. */
  layer_status?: Record<string, string>;
  selector_counts?: Record<string, number>;
}

interface Row {
  id: string;
  description: string;
  url: string;
  stub_wildfire?: boolean;
  /** Run the row with `prefers-reduced-motion: reduce` (S30D B3 CI3). */
  reduced_motion?: boolean;
  timeout_ms?: number;
  steps: Step[];
  expect: Expectations;
}

const MATRIX_URL = new URL('./view-contracts.yaml', import.meta.url);
const matrix = parse(readFileSync(MATRIX_URL, 'utf8')) as { rows: Row[] };

if (!Array.isArray(matrix?.rows) || matrix.rows.length === 0) {
  throw new Error('view-contracts.yaml carries no rows');
}

const seen = new Set<string>();
for (const row of matrix.rows) {
  if (seen.has(row.id)) {
    throw new Error(`view-contracts.yaml has a duplicate row id: ${row.id}`);
  }
  seen.add(row.id);
}

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

function fire3dStamp(page: Page): Promise<string | undefined> {
  return page.evaluate(() => document.documentElement.dataset['ddmFire3d']);
}

function fire3dContextStamp(page: Page): Promise<string | undefined> {
  return page.evaluate(
    () => document.documentElement.dataset['ddmFire3dContext']
  );
}

async function urlParam(page: Page, name: string): Promise<string | null> {
  return new URLSearchParams(await search(page)).get(name);
}

// ---------------------------------------------------------------------------
// The power layer's reads (S30D P2-CI2)
// ---------------------------------------------------------------------------

/** The ArcGIS service name the layer's live plants query carries (src/config/urls.ts). */
const POWER_PLANTS_SERVICE = 'Power_Plants_in_the_US';
/** The bundled transmission-line archive the layer probes first, same origin. */
const POWER_LINES_ARCHIVE = 'power-lines-pnw.pmtiles';

/**
 * What the power layer asked for during one case. `unanswered` is the point:
 * the layer's status is `ready` only when BOTH its reads succeed
 * (src/layers/power-3d.ts syncForZoom), so a plants request that reached the
 * network instead of a fixture would decide the status by a live service.
 * The rest is evidence for a red: which half degraded, and when.
 */
interface PowerReads {
  /** Plants requests no stub answered (the context backstop below caught them). */
  readonly unanswered: string[];
  /** Every response or failure on the bundled line archive and the plants service, with elapsed ms and Range. */
  readonly archive: string[];
  /** The layer's own console warnings, which name the read that failed. */
  readonly warnings: string[];
  /** The power pill's raw status word each time it changed, with elapsed ms. */
  readonly timeline: string[];
}

/**
 * Register BEFORE the first boot. A page route outranks a context route
 * (tests/helpers.ts GotoAppOptions), so this context route is reached only by
 * a plants request that `stubWildfireFeeds` (or any page route) did not
 * answer: it is recorded and refused, so a missing or shadowed stub fails as
 * a named, deterministic failure instead of a live read that a runner's
 * network decides.
 */
async function watchPowerLayerReads(page: Page): Promise<PowerReads> {
  const reads: PowerReads = { unanswered: [], archive: [], warnings: [], timeline: [] };
  await page.context().route(
    (url) => url.href.includes(POWER_PLANTS_SERVICE),
    (route) => {
      reads.unanswered.push(route.request().url());
      return route.abort('failed');
    }
  );
  const began = Date.now();
  const stamp = (): string => `+${Date.now() - began}ms`;
  const readName = (url: string): string | null =>
    url.includes(POWER_LINES_ARCHIVE) ? 'line archive' : url.includes(POWER_PLANTS_SERVICE) ? 'plants' : null;
  page.on('response', (response) => {
    const name = readName(response.url());
    if (name === null) return;
    const range = response.request().headers()['range'] ?? 'no range';
    reads.archive.push(`${stamp()} ${name} ${response.status()} ${range}`);
  });
  page.on('requestfailed', (request) => {
    const name = readName(request.url());
    if (name === null) return;
    reads.archive.push(`${stamp()} ${name} failed ${request.failure()?.errorText ?? 'unknown'}`);
  });
  page.on('console', (message) => {
    if (message.text().includes('[power-3d]')) {
      reads.warnings.push(`${stamp()} ${message.text().slice(0, 300)}`);
    }
  });
  return reads;
}

// ---------------------------------------------------------------------------
// The 3D scene's startup stall (S30D B3 CI3)
// ---------------------------------------------------------------------------

/**
 * The page's own requests, counted on the Node side: a frozen page cannot
 * report its own traffic, but the browser process can. Same shape as the
 * helper of the same name in tests/fire3d-mode.spec.ts (each spec stays
 * self-contained; tests/helpers.ts is not this unit's).
 */
interface SceneTraffic {
  /** Requests started and not yet finished or failed. */
  open: number;
  /** Date.now() of the last request start, finish or failure. */
  lastActivityAt: number;
}

/** Register BEFORE the first boot. */
function trackSceneTraffic(page: Page): SceneTraffic {
  const traffic: SceneTraffic = { open: 0, lastActivityAt: Date.now() };
  const tracked = new Set<unknown>();
  const end = (request: unknown): void => {
    if (!tracked.delete(request)) return;
    traffic.open -= 1;
    traffic.lastActivityAt = Date.now();
  };
  page.on('request', (request) => {
    tracked.add(request);
    traffic.open += 1;
    traffic.lastActivityAt = Date.now();
  });
  page.on('requestfinished', end);
  page.on('requestfailed', end);
  return traffic;
}

/** One 1x1 readback on the map's own context: it returns only when the
 * software renderer has drawn every frame queued before it. Returns how long
 * the page was blocked, on the page's clock. */
function drainDrawQueue(page: Page): Promise<number> {
  return page.evaluate(() => {
    const started = performance.now();
    const canvas = document.querySelector('canvas.maplibregl-canvas') as HTMLCanvasElement | null;
    const gl = (canvas?.getContext('webgl2') ?? canvas?.getContext('webgl')) as WebGLRenderingContext | null;
    gl?.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    return Math.round(performance.now() - started);
  });
}

/** A drain faster than this found the queue empty (measured 2026-10-05,
 * reduced motion: 1, 13 and 244 ms once quiet; 1.7 to 2.3 s while the pulse
 * kept refilling it). */
const SCENE_DRAIN_EMPTY_MS = 300;
/** No request started or ended for this long counts as quiet traffic. */
const SCENE_QUIET_MS = 1500;
/** Rounds of drain then quiet before the scene is called busy for good
 * (measured: 2 to 4 rounds under reduced motion at 1x, 4x and 6x CPU). */
const SCENE_SETTLE_ROUNDS = 8;

/**
 * Wait until the 3D scene has stopped using the page: drain the draw queue
 * (the readback returns when the queue is empty, however long that takes),
 * wait for the network to go quiet, drain again, until a drain finds the
 * queue empty and nothing was requested since before it began. It decides
 * from what it can measure and has no wall-clock deadline a slow runner could
 * decide; it does not read the scene's `transport` stamp (see the
 * `set_layer` step for why, and tests/fire3d-mode.spec.ts for the same
 * helper with the measurements).
 */
async function waitForSceneToSettle(page: Page, traffic: SceneTraffic): Promise<void> {
  const rounds: string[] = [];
  for (let round = 0; round < SCENE_SETTLE_ROUNDS; round += 1) {
    const startedAt = Date.now();
    const drainMs = await drainDrawQueue(page);
    await expect
      .poll(() => traffic.open <= 0 && Date.now() - traffic.lastActivityAt >= SCENE_QUIET_MS, {
        message: 'the 3D scene kept requesting tiles',
        timeout: 30_000,
        intervals: [250]
      })
      .toBe(true);
    const quietSinceBefore = traffic.lastActivityAt < startedAt;
    rounds.push(`drain ${drainMs} ms, ${quietSinceBefore ? 'no traffic' : 'traffic'}`);
    if (drainMs < SCENE_DRAIN_EMPTY_MS && quietSinceBefore) return;
  }
  throw new Error(`the 3D scene never went quiet: ${rounds.join('; ')}`);
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function runStep(
  page: Page,
  step: Step,
  traffic: SceneTraffic,
  power: PowerReads
): Promise<void> {
  if ('click_cluster' in step) {
    const key = step.click_cluster;
    await page.locator(`.shell-cluster-btn[data-cluster="${key}"]`).click();
    await expect(
      page.locator(`.shell-cluster-btn[data-cluster="${key}"]`)
    ).toHaveAttribute('aria-pressed', 'true');
    return;
  }

  if ('fire3d' in step) {
    const wanted = step.fire3d === 'on';
    const toggle = page.locator(FIRE3D_TOGGLE);
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute(
      'aria-pressed',
      wanted ? 'false' : 'true'
    );
    await toggle.click();
    await expect(toggle).toHaveAttribute(
      'aria-pressed',
      wanted ? 'true' : 'false'
    );
    return;
  }

  if ('select_region' in step) {
    await page
      .locator('#region-select')
      .selectOption(`region:${step.select_region}`, { force: true });
    return;
  }

  if ('set_layer' in step) {
    // A layer switched on while the 3D scene is up starts its first read
    // inside the scene's own startup stall, ON PURPOSE (S30D B6-POWER,
    // found-125). The scene publishes 'active' while terrain, the drape and
    // the structures are still streaming, and on the software renderer the
    // draw queue then blocks the page for up to about 12 s
    // (tests/fire3d-mode.spec.ts, the RAWS marker case, measured 5.8 to
    // 11.9 s), long enough for the power layer's 10 s archive probe
    // (src/util/pmtiles-probe.ts PROBE_TIMEOUT_MS) to expire. Until B6-POWER
    // that left the layer `degraded` for good, so P2-CI2 and then B3 CI3 made
    // this step wait for the scene to settle first; on GitHub that wait was
    // itself the red (run 37317297848: "the 3D scene kept requesting tiles",
    // found-093). The layer now reads its missing half again after a slow
    // first read (src/layers/power-3d.ts RETRY_DELAYS_MS), so the step
    // switches the layer on at once and the row's `layer_status` asserts the
    // recovery a person sees. The scene's transport stamp at that moment is
    // recorded beside the power evidence, so a red says whether the switch
    // really landed inside the streaming window.
    if (step.set_layer.on && (await fire3dStamp(page)) === 'active') {
      const transport = await page.evaluate(
        () => document.documentElement.dataset['ddmFire3dTransport'] ?? 'unset'
      );
      power.timeline.push(`switched on in 3D, scene transport ${transport}`);
    }
    const box = layerCheckbox(page, step.set_layer.key);
    if (step.set_layer.on) await box.check();
    else await box.uncheck();
    return;
  }

  if ('wait_settled' in step) {
    await waitForLayerSettled(page, step.wait_settled);
    return;
  }

  if ('wait_fire3d' in step) {
    await expect
      .poll(() => fire3dStamp(page), { timeout: FIRE3D_STAMP_TIMEOUT_MS })
      .toBe(step.wait_fire3d);
    return;
  }

  if ('settle_scene' in step) {
    // Ride out the scene's startup stall before the reads that follow: every
    // page read blocks while the software renderer drains its queue, so a
    // 20 s URL poll or a 10 s attribute read can expire inside it (GitHub
    // runs 37276902844 and 37282168792: the reloaded-share row's first attempt
    // failed its 20 s URL poll in both, with page reads blocked 10 to 32 s in
    // the same shard). The row that uses this step runs reduced motion.
    await waitForSceneToSettle(page, traffic);
    return;
  }

  if ('hold_first_power_probe' in step) {
    // The startup stall made deterministic (found-125): the FIRST header read
    // of the bundled line archive (the probe's exact 127-byte Range) is held
    // for longer than the probe's 10 s budget, then handed on to the preview
    // server. The probe has given up by then, so its first read fails exactly
    // as a starved page makes it fail, on any machine; every later read,
    // including MapLibre's own tile reads, passes untouched.
    const holdMs = step.hold_first_power_probe;
    let held = false;
    await page.route(
      (url) => url.href.includes(POWER_LINES_ARCHIVE),
      async (route) => {
        const range = route.request().headers()['range'];
        if (held || range !== 'bytes=0-126') return route.fallback();
        held = true;
        power.timeline.push(`holding the first line archive probe ${holdMs} ms`);
        await new Promise((resolve) => setTimeout(resolve, holdMs));
        // The page aborted the request when its budget ran out; Playwright
        // then refuses the hand-off, which is the expected outcome here.
        await route.fallback().catch(() => undefined);
      }
    );
    return;
  }

  if ('zoom_out' in step) {
    // The production build carries no dev map handle, so the camera moves
    // through the real control surface: MapLibre gives its canvas
    // tabIndex 0, and the minus key is its own zoom-out binding.
    const canvas = page.locator('#map canvas').first();
    await canvas.focus();
    for (let i = 0; i < step.zoom_out; i += 1) {
      await page.keyboard.press('Minus');
      await page.waitForTimeout(350);
    }
    return;
  }

  if ('reload' in step) {
    await page.reload({ waitUntil: 'domcontentloaded' });
    // Boot is finished when the sidebar has rebuilt, the same
    // network-independent signal `gotoApp` waits on.
    await expect(page.locator('#preset-chips .preset-chip')).not.toHaveCount(0);
    await expect(page.locator('#region-select option')).not.toHaveCount(0);
    return;
  }

  throw new Error(`unknown view-contract step: ${JSON.stringify(step)}`);
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

async function assertExpectations(
  page: Page,
  wanted: Expectations,
  power: PowerReads
): Promise<void> {
  if (wanted.cluster_pressed) {
    if (
      wanted.cluster_pressed !== 'none' &&
      !CLUSTER_KEYS.includes(wanted.cluster_pressed as never)
    ) {
      throw new Error(`unknown cluster key: ${wanted.cluster_pressed}`);
    }
    // `none` matches no key, so every button is asserted unpressed: the
    // honest chrome for a custom (granular `layers=`) display.
    for (const key of CLUSTER_KEYS) {
      await expect(
        page.locator(`.shell-cluster-btn[data-cluster="${key}"]`),
        `cluster button ${key}`
      ).toHaveAttribute(
        'aria-pressed',
        key === wanted.cluster_pressed ? 'true' : 'false'
      );
    }
  }

  for (const [name, value] of Object.entries(wanted.url_params ?? {})) {
    await expect
      .poll(() => urlParam(page, name), {
        message: `URL parameter ${name}`,
        timeout: URL_POLL_TIMEOUT_MS
      })
      .toBe(value);
  }

  if (wanted.url_layers_include || wanted.url_layers_exclude) {
    const tokens = new URLSearchParams(await search(page)).get('layers');
    const set = new Set(
      (tokens ?? '').split(',').map((token) => token.trim()).filter(Boolean)
    );
    for (const key of wanted.url_layers_include ?? []) {
      expect(set, `layers= should include ${key}`).toContain(key);
    }
    for (const key of wanted.url_layers_exclude ?? []) {
      expect(set, `layers= should not include ${key}`).not.toContain(key);
    }
  }

  if (wanted.fire3d_stamp) {
    if (wanted.fire3d_stamp === 'absent') {
      expect(await fire3dStamp(page)).toBeUndefined();
    } else {
      await expect
        .poll(() => fire3dStamp(page), { timeout: FIRE3D_STAMP_TIMEOUT_MS })
        .toBe(wanted.fire3d_stamp);
    }
  }

  if (wanted.fire3d_context_includes || wanted.fire3d_context_excludes) {
    const stamp = (await fire3dContextStamp(page)) ?? '';
    const tokens = new Set(stamp.split(/\s+/).filter(Boolean));
    for (const key of wanted.fire3d_context_includes ?? []) {
      expect(tokens, `3D context should include ${key}`).toContain(key);
    }
    for (const key of wanted.fire3d_context_excludes ?? []) {
      expect(tokens, `3D context should not include ${key}`).not.toContain(key);
    }
  }

  if (wanted.fire3d_toggle) {
    const toggle = page.locator(FIRE3D_TOGGLE);
    if (wanted.fire3d_toggle === 'absent') {
      await expect(toggle).toHaveCount(0);
    } else {
      await expect(toggle).toHaveAttribute(
        'aria-pressed',
        wanted.fire3d_toggle === 'pressed' ? 'true' : 'false'
      );
    }
  }

  for (const key of wanted.layers_checked ?? []) {
    await expect(layerCheckbox(page, key), `layer ${key}`).toBeChecked();
  }
  for (const key of wanted.layers_unchecked ?? []) {
    await expect(layerCheckbox(page, key), `layer ${key}`).not.toBeChecked();
  }

  for (const [key, status] of Object.entries(wanted.layer_status ?? {})) {
    // The RAW status word rides the pill as a CSS class, which is the
    // stable contract now that the displayed text varies per layer.
    const polledSince = Date.now();
    let lastWord = '';
    await expect
      .poll(
        async () => {
          const cls = (await layerPill(page, key).getAttribute('class')) ?? '';
          const tokens = cls.split(/\s+/);
          const word = tokens.filter((token) => token !== 'layer-toggle-status').join(' ');
          if (key === 'power-infrastructure' && word !== lastWord) {
            lastWord = word;
            power.timeline.push(`+${Date.now() - polledSince}ms ${word || 'no status class'}`);
          }
          return tokens;
        },
        { message: `layer ${key} status`, timeout: FIRE3D_STAMP_TIMEOUT_MS }
      )
      .toContain(status);
  }

  for (const [selector, count] of Object.entries(
    wanted.selector_counts ?? {}
  )) {
    await expect(page.locator(selector), selector).toHaveCount(count);
  }
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

test.describe('view contracts', () => {
  for (const row of matrix.rows) {
    test(row.id, async ({ page }) => {
      if (row.timeout_ms) test.setTimeout(row.timeout_ms);
      test.info().annotations.push({
        type: 'contract',
        description: row.description
      });

      // Before any stub and any boot (see watchPowerLayerReads).
      const power = await watchPowerLayerReads(page);
      const traffic = trackSceneTraffic(page);
      if (row.reduced_motion) await page.emulateMedia({ reducedMotion: 'reduce' });

      if (row.stub_wildfire) {
        await stubWildfireFeeds(page);
        // Every `stub_wildfire: true` row either enters the 3D scene or
        // shares its boot with rows that do (tests/view-contracts.yaml); the
        // deep terrain host went LIVE 2026-09-10, so a row that omits this
        // would otherwise stream a real archive from Cloudflare instead of
        // the deterministic bundled fixture (see stubDeepTerrainArchive's
        // own comment in wildfire-fixtures.ts).
        await stubDeepTerrainArchive(page);
      }
      try {
        await gotoApp(page, row.url);

        for (const step of row.steps ?? []) await runStep(page, step, traffic, power);

        await assertExpectations(page, row.expect, power);
      } finally {
        // The evidence for WHICH power read degraded and when. Rows that never
        // touch the power layer record nothing and attach nothing.
        const evidence = [
          ...power.timeline.map((entry) => `status ${entry}`),
          ...power.archive.map((entry) => `request ${entry}`),
          ...power.warnings
        ];
        if (evidence.length > 0) {
          // The list reporter prints stdout, the annotation rides the JSON report.
          console.log(`[${row.id}] power-layer-reads: ${evidence.join(' | ')}`);
          test.info().annotations.push({
            type: 'power-layer-reads',
            description: evidence.join(' | ')
          });
        }
        expect
          .soft(
            power.unanswered,
            'a power plants request reached the network: no stub answered it, so a live service decided the layer status'
          )
          .toEqual([]);
      }
    });
  }
});
