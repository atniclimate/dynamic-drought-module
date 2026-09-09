/**
 * Shared helpers and canonical constants for the DDM smoke suite.
 *
 * The constants below mirror the application's config tables and the pill
 * vocabulary so the specs read as assertions about behavior rather than
 * about magic strings. If a config table changes (a preset is renamed, a
 * role group relabeled), these mirrors are the single place to update, and
 * the mismatch surfaces as a failing spec rather than silent drift.
 */

import { execSync } from 'node:child_process';
import { expect, type BrowserContext, type Page, type Locator, type Route } from '@playwright/test';
import { stubRecentSatellite } from './satellite-fixture';
import { installMinimapAnalysisStubs } from './minimap-fixtures';
import { installBoundaryStubs, type BoundaryStubMode } from './tribal-fixtures';

const nadmStubbedPages = new WeakSet<Page>();

const TEST_NADM_SNAPSHOT = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { DROUGHTCAT: 'd2', YEAR_MONTH: '202606' },
      geometry: {
        type: 'Polygon',
        coordinates: [[[-140, 20], [-50, 20], [-50, 75], [-140, 75], [-140, 20]]]
      }
    }
  ]
} as const;

async function stubDefaultNadm(page: Page): Promise<void> {
  if (nadmStubbedPages.has(page)) return;
  nadmStubbedPages.add(page);
  await page.route('**/NADM-current.geojson', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: JSON.stringify(TEST_NADM_SNAPSHOT)
    })
  );
}

const coveredContexts = new WeakSet<BrowserContext>();

/**
 * Carry the PAGE-level stubs onto any Page this context opens later.
 *
 * The two stubs that matter most for a retained artifact, the sovereign
 * boundaries and the minimap's continental analysis inputs, are registered on
 * the CONTEXT, so a popup or a `context.newPage()` inherits them with no help
 * from here. The satellite and NADM stubs are still page-level, and a Page
 * this helper never navigated would reach those services live. Nothing in
 * this suite opens a second Page today (`tests/boundary-boot-inventory.test.mjs`
 * fails the gate on the first `newPage(` or popup wait that is not recorded),
 * so this hook is defense in depth for the day one appears: it closes the
 * page-level half of the same hole context routing already closed.
 */
function coverFuturePages(page: Page): void {
  const context = page.context();
  if (coveredContexts.has(context)) return;
  coveredContexts.add(context);
  context.on('page', (opened) => {
    // A popup can close before the route lands; a rejected stub must not fail
    // the test that opened it, because the guarantee that matters is already
    // held by the context-level routes above.
    void stubRecentSatellite(opened).catch(() => undefined);
    void stubDefaultNadm(opened).catch(() => undefined);
  });
}

/**
 * The six canonical status-pill strings, from `STATUS_PILL_TEXT` in
 * `src/ui/sidebar.ts`. A layer that is off (never activated, or deactivated)
 * carries the empty string instead of any of these.
 */
export const PILL = {
  loading: 'loading...',
  live: 'live',
  degraded: 'live (partial)',
  unavailable: 'unavailable',
  noData: 'no data (see data/README.md)',
  zoomIn: 'zoom in to load'
} as const;

/** The five terminal (activation-finished) pill strings; `loading...` is not terminal. */
export const TERMINAL_PILLS: readonly string[] = [
  PILL.live,
  PILL.degraded,
  PILL.unavailable,
  PILL.noData,
  PILL.zoomIn
];

/**
 * Role-group headings in sidebar order, mirroring `LAYER_ROLE_ORDER` and
 * `ROLE_GROUP_LABELS` in `src/ui/sidebar.ts` and `src/config/layers.ts`.
 */
export const ROLE_GROUPS: ReadonlyArray<{ title: string; hint: string | null }> = [
  { title: 'Conditions', hint: 'one at a time' },
  { title: 'Place', hint: 'boundaries & rivers' },
  { title: 'Events', hint: null },
  { title: 'Stations', hint: null }
];

/** Preset chip labels in order, mirroring `VIEW_PRESETS` in `src/config/presets.ts`. */
export const PRESET_LABELS: readonly string[] = [
  'Right now',
  'This week',
  'Season ahead',
  'Fire risk',
  'Whose land'
];

/** Default-on layer keys, mirroring `defaultOn: true` rows in `LAYER_DEFS`.
 * Telemetry left this set 2026-07-09 (0.7.0 H4, D-0.7.0-018 item 1);
 * states joined 2026-07-12 (U4c, boundaries as chrome). The Tribal Nations
 * umbrella build (D-0.7.0-032/033, 2026-07-15) deliberately swapped the
 * bundled `tribal` placeholder for live Tribal-geography layers. The current
 * default carries the two present-day layers. Each change was a ratified,
 * deliberate default change. Hillshade joined 2026-07-16 (E1 deliverable 4,
 * D-0.7.0-043 part 3: terrain shading is part of the calm default
 * composition). */
export const DEFAULT_ON = ['nadm-drought', 'aiannh', 'bia-reservations', 'states', 'hillshade'] as const;

/** Surface-role keys (mutually exclusive), mirroring `role: 'surface'` rows in `LAYER_DEFS`.
 * sst-anomaly joined 2026-07-10 (alignment-review catch: the mirror had
 * drifted, so exclusivity loops never asserted it off). */
export const SURFACE_KEYS = [
  'drought',
  'gridded-index',
  'usdm',
  'cdm-drought',
  'nadm-drought',
  'heatrisk',
  'spc-fire-weather',
  'usfs-whp',
  'sst-anomaly'
] as const;

// ---------------------------------------------------------------------------
// Locators
// ---------------------------------------------------------------------------

/** The checkbox input for a layer key. */
export function layerCheckbox(page: Page, key: string): Locator {
  return page.locator(`input[data-layer-key="${key}"]`);
}

/** The status-pill element for a layer key. */
export function layerPill(page: Page, key: string): Locator {
  return page.locator(`[data-layer-status="${key}"]`);
}

/** The detailed-region option for a region key. */
export function regionButton(page: Page, key: string): Locator {
  return page.locator(`#region-select option[value="region:${key}"]`);
}

/** The combined overview and detailed-region dropdown. */
export function regionSelect(page: Page): Locator {
  return page.locator('#region-select');
}

/** Choose one established detailed camera from the combined region select. */
export async function selectRegion(page: Page, key: string): Promise<void> {
  await page.locator('#region-select').selectOption(`region:${key}`);
}

/** The telemetry value slot for a station id. */
export function stationValues(page: Page, id: string): Locator {
  return page.locator(`[data-station-values="${id}"]`);
}

// ---------------------------------------------------------------------------
// Boot + URL
// ---------------------------------------------------------------------------

/**
 * Navigate to the app (optionally with a query string like
 * `?region=central_oregon&layers=usdm,tribal`) and wait for boot to finish.
 *
 * Boot completes only after the map fires `load`, at which point `buildSidebar`
 * synchronously renders the preset chips and the region radios. Waiting on
 * those two DOM facts is a network-independent boot signal: it does not depend
 * on any live agency layer succeeding, only on the map's WebGL context coming
 * up and the sidebar building. `domcontentloaded` (not `load`) avoids blocking
 * on slow external basemap tiles and fonts that boot does not wait for either.
 *
 * The catalog wait is CONDITIONAL since U1: the catalog rides the
 * lazily-mounted island, and a BRIEF EMBED never mounts it at all
 * (headroom C1), so waiting on it would hang exactly the boots the embed
 * specs exercise. Every other boot mounts the island, so the strong
 * catalog-present contract is kept for the specs that drive its rows.
 * The brief-embed detection mirrors `deriveViewMode` (src/state/
 * view-mode.ts): embed plus nothing that routes to the console.
 */
export interface GotoAppOptions {
  /**
   * How this boot answers the Census AIANNH and BIA AIAN-LAR queries.
   * Defaults to `fixture`, the synthetic bodies in `tests/tribal-fixtures.ts`.
   * `empty` serves the honest live-zero collection. `live` is the documented
   * escape hatch: it installs no stub and the request reaches the agency.
   * A spec that needs an abort, a partial, a delayed, or a geography-keyed
   * response registers its own handler with `routeBoundary` instead; the
   * suite-wide stub defers to any service a spec has claimed, whether the
   * claim was made before or after this call.
   */
  readonly boundaries?: BoundaryStubMode;
  /**
   * Wait for the boot-idle seam (`<html data-ddm-boot="idle">`, DR-052
   * follow-up): the map has loaded, every layer the URL asked for has left
   * `loading`, and no shared transport is in flight. Defaults to true, so
   * every assertion after `gotoApp` runs against a settled boot. A spec that
   * deliberately HOLDS a boot open (a routed request that never answers, a
   * layer it wants to observe mid-load) passes false and owns its own waits.
   *
   * What `false` means since the map-free sidebar (2026-09-03 launch ruling
   * section 4): the caller still gets a MAP-READY page, because `gotoApp`
   * waits unconditionally for `<html data-ddm-controls="ready">`, which
   * `buildSidebar` stamps after it has built the controller and applied the
   * synchronous URL state. It does not get a SETTLED page: layers may still
   * be loading and shared transport may still be in flight, which is the
   * point of opting out. Before this change the same two guarantees were
   * carried by one signal, the preset chips, which now appear at DOM ready
   * and prove neither.
   */
  readonly bootIdle?: boolean;
}

export async function gotoApp(
  page: Page,
  query = '',
  options: GotoAppOptions = {}
): Promise<void> {
  // Routine deterministic browser tests stub the recent-satellite service so
  // the full suite neither depends on nor floods the public endpoint.
  await stubRecentSatellite(page);
  // DDM-P1-T08: EVERY boot answers the two sovereign-boundary queries from
  // synthetic fixtures, locally and in CI alike. Stubbing only under `CI`
  // would make a local green and a CI green mean different things, and the
  // whole point of the stub is that a retained CI artifact can never carry
  // live Tribal or reservation geometry (hard rule 1; see the
  // NON-REDISTRIBUTION GUARD in `src/layers/aiannh.ts`). One code path, one
  // meaning. The live boundary path stays proven by the daily source-health
  // probe, which drives Chromium outside this suite.
  await installBoundaryStubs(page, options.boundaries ?? 'fixture');
  // The always-mounted minimap fetches NCEI's North America country base and
  // a Statistics Canada province boundary on every non-brief-embed boot.
  // Neither is sovereign geometry, but both were LIVE external geometry
  // fetches until 2026-08-29, and a retained trace would have embedded their
  // bodies. See tests/minimap-fixtures.ts for why they are stubbed rather
  // than waived.
  await installMinimapAnalysisStubs(page);
  // DDM-P7-T07: the season-ahead heat cell reads the CPC seasonal
  // temperature outlook live, independent of any map layer, on every
  // briefing whose selection falls inside the regional impact synthesis
  // capability. Stubbed unconditionally, like the three calls above, so no
  // spec that opens the briefing sends this new query to the live agency
  // (see `stubCpcSeasonalTempOutlook`'s own comment).
  await stubCpcSeasonalTempOutlook(page);
  coverFuturePages(page);
  if (!/[?&](?:layers|cluster)=/.test(query)) {
    await stubDefaultNadm(page);
  }
  await page.goto(query, { waitUntil: 'domcontentloaded' });
  // DOM READY, and no longer a proxy for a finished boot. The generated
  // sidebar controls are built from the static registry tables before the
  // renderer is probed (the 2026-09-03 launch ruling section 4), so the
  // chips and the region options now appear on every boot path, including
  // one that never gets a map. These two assertions still earn their place
  // (a boot that never runs its entry chunk fails them), but the wait that
  // used to mean "the map loaded and the sidebar built" is the
  // `data-ddm-controls` assertion below.
  await expect(page.locator('#preset-chips .preset-chip')).toHaveCount(PRESET_LABELS.length);
  await assertBuildIdentity(page);
  await expect(page.locator('#region-select option')).not.toHaveCount(0);
  // MAP READY: `buildSidebar` has created the layer controller, applied the
  // synchronous URL state, and enabled the map-dependent controls, which is
  // exactly what the preset-chip count used to prove. Asserted for every
  // caller, `bootIdle: false` included, so a spec that deliberately holds a
  // boot open still starts from a wired interface rather than a shell.
  await expect(page.locator('html')).toHaveAttribute('data-ddm-controls', 'ready');
  const isEmbed = /[?&]embed=(true|1)\b/.test(query);
  const isConsole =
    /[?&]view=console\b/.test(query) ||
    (!/[?&]view=brief\b/.test(query) &&
      !/[?&]select=/.test(query) &&
      /[?&](layers=|region=|cluster=|ocean=|framing=)/.test(query));
  const briefEmbed = isEmbed && !isConsole;
  if (!briefEmbed) {
    await expect(page.locator('#layer-toggles .layer-group')).toHaveCount(ROLE_GROUPS.length);
  }
  // The boot-idle seam (DR-052 follow-up; src/state/boot-idle.ts). The
  // assertions above prove the chrome exists; this one proves the boot has
  // SETTLED: map loaded, every URL-named layer out of `loading`, no shared
  // transport in flight. It moves the moment a spec's own assertions run,
  // and changes none of them. Derived from registry and transport state,
  // never from elapsed time, so it cannot flip early and hide a failure.
  //
  // `expect.poll` at the same default timeout `toHaveAttribute` used
  // (`playwright.config.ts`'s `expect.timeout`, 10s; never lengthened here):
  // on a miss it names which layers are still owed, read from the DOM the
  // same way `pendingBootLayers()` (src/state/boot-idle.ts:80-102) computes
  // it (checked-but-not-terminal, or a live `loading...` pill), because that
  // function's own module state is private to the running page's closure
  // and unreachable from a production bundle without a product-code change
  // outside this file. `pendingSharedTransportCount()` (src/util/fetch.ts:193)
  // is the same kind of private counter with no DOM reflection at all, so a
  // miss says plainly that it could not be read from this seam rather than
  // guess at it. The read itself is wrapped in its own try/catch: a page
  // teardown race during the evaluate must not replace the original
  // boot-idle failure with an unrelated one, so the fallback is a literal
  // clause and the original error survives as `cause`, never flattened.
  if (options.bootIdle !== false) {
    try {
      await expect.poll(() => page.locator('html').getAttribute('data-ddm-boot')).toBe('idle');
    } catch (err) {
      let diagnostic: string;
      try {
        const read = await page.evaluate(
          ({ loadingText, terminalPills }) => {
            const inputs = Array.from(
              document.querySelectorAll<HTMLInputElement>('input[data-layer-key]')
            );
            if (inputs.length === 0) return { noToggles: true as const, pending: [] };
            const pending = inputs
              .filter((input) => {
                const key = input.dataset['layerKey'];
                const pill = document.querySelector(`[data-layer-status="${key}"]`);
                const text = (pill?.textContent ?? '').trim();
                if (text === loadingText) return true;
                return input.checked && !terminalPills.includes(text);
              })
              .map((input) => input.dataset['layerKey']);
            return { noToggles: false as const, pending };
          },
          { loadingText: PILL.loading, terminalPills: TERMINAL_PILLS }
        );
        // A brief-embed boot defers the catalog island (src/ui/sidebar.ts:
        // 1702-1703), so no `input[data-layer-key]` exists yet; an empty
        // pending list there would misread as "everything settled".
        diagnostic = read.noToggles
          ? 'the layer toggles are not in the DOM (a brief-embed boot defers the catalog island, src/ui/sidebar.ts:1702-1703)'
          : `pending layers (checked and not yet terminal) = ${JSON.stringify(read.pending)}`;
      } catch (evalErr) {
        diagnostic = `the pending-layer proxy could not be read (${(evalErr as Error).message})`;
      }
      throw new Error(
        `boot-idle never reached "idle" within the default expect timeout; ${diagnostic}; ` +
          'pending shared transport count is not observable from this seam (a private counter ' +
          'in src/util/fetch.ts with no DOM reflection).',
        { cause: err }
      );
    }
  }
}

/**
 * The sha `vite.config.ts` `buildSha()` would bake into a build made NOW:
 * git HEAD, plus a `-dirty` suffix when the working tree differs. Mirrored
 * here rather than imported because the config is bundler code and this is
 * runner code; if the two ever disagree the assertion below fails loudly,
 * which is the intended failure.
 *
 * Undefined when git cannot answer (no repository, no git on PATH). The
 * caller then asserts nothing about the sha, exactly as a local run did
 * before, because an unverifiable expectation is worse than none.
 *
 * Resolved ONCE per process. Playwright's `webServer` runs `npm run build`
 * BEFORE any spec collects, so the tree state that produced the bundle is
 * the tree state at process start, and the dirty marker is stable for the
 * whole run. The one way to break that is to edit a tracked file WHILE the
 * run is in flight (a second worker in a shared tree, say): the build would
 * carry the older marker and this the newer. Caching cannot fix that, and
 * the mismatch is honest, so it reports as a build-identity failure.
 */
let localBuildShaCache: { readonly value: string | undefined } | undefined;

function localBuildSha(): string | undefined {
  if (localBuildShaCache) return localBuildShaCache.value;
  let value: string | undefined;
  try {
    const head = execSync('git rev-parse HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    const status = execSync('git status --porcelain --untracked-files=normal', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    value = status.length > 0 ? `${head}-dirty` : head;
  } catch {
    value = undefined;
  }
  localBuildShaCache = { value };
  return value;
}

/**
 * Prove the boot under test is the build this run made (FE-22, DDM-P0-T08).
 *
 * CI sets DDM_BUILD_SHA and DDM_BUILD_NONCE on the job; vite.config.ts bakes
 * them into the bundle and src/main.ts stamps them on <html>. When either
 * variable is set in the runner's environment, every boot this helper drives
 * must carry the same values, or the shard proved the wrong build (a stale
 * dist, another lane's preview, a rebuild without the variables under a
 * running preview: the 2026-08-28 qualification run caught exactly that,
 * `<sha>-dirty` against `<sha>`). It runs after the preset chips are
 * present, so a boot that never ran reads as a boot failure, not as a
 * wrong build; a missing stamp after a successful boot is named as such.
 *
 * Locally, with neither set, the helper used to assert NOTHING, so a local
 * run never proved it booted the build it had just made: the exact class of
 * error the stamp exists to catch (a stale dist under a reused preview) was
 * invisible in the loop where it is easiest to create. It now resolves the
 * expected sha itself, the same way vite.config.ts `buildSha()` does, and
 * asserts the page carries it. If git cannot answer, it keeps the old
 * posture and asserts nothing.
 */
async function assertBuildIdentity(page: Page): Promise<void> {
  const expectedSha = process.env['DDM_BUILD_SHA'] ?? localBuildSha();
  const expectedNonce = process.env['DDM_BUILD_NONCE'];
  if (!expectedSha && !expectedNonce) return;
  const stamp = await page.evaluate(() => ({
    sha: document.documentElement.dataset['ddmBuildSha'],
    nonce: document.documentElement.dataset['ddmBuildNonce']
  }));
  expect(stamp.sha, 'the booted page carries no data-ddm-build-sha stamp').toBeDefined();
  expect(stamp.nonce, 'the booted page carries no data-ddm-build-nonce stamp').toBeDefined();
  if (expectedSha) expect(stamp.sha, 'data-ddm-build-sha').toBe(expectedSha);
  if (expectedNonce) expect(stamp.nonce, 'data-ddm-build-nonce').toBe(expectedNonce);
}

/** Read `window.location.search` as a URLSearchParams-friendly string. */
export async function search(page: Page): Promise<string> {
  return page.evaluate(() => window.location.search);
}

/**
 * The five terminal RAW status classes (everything but `loading`), from the
 * `LayerStatus` union. The pill span carries the raw status word as a CSS
 * class (`layer-toggle-status ${status}`), which is the stable settlement
 * contract now that the no-data TEXT varies per layer (`noDataLabel`,
 * Unit C): classifying by raw class instead of presentation text keeps this
 * helper valid for every layer regardless of wording.
 */
const TERMINAL_STATUS_CLASSES: readonly string[] = [
  'ready',
  'degraded',
  'error',
  'no-data',
  'zoom-in'
];

/**
 * Wait until a layer's status pill reaches a terminal state (any raw status
 * class but `loading`). Used to settle a default-on layer's initial network
 * activation BEFORE driving an exclusivity or preset swap: toggling a surface
 * off while another surface is still completing its first activation is an
 * edge race (the in-flight activation can re-register the layer after the
 * toggle removed it). Settling first is the realistic precondition and makes
 * the URL assertions deterministic regardless of how slow the upstream is.
 */
export async function waitForLayerSettled(page: Page, key: string, timeout = 25_000): Promise<void> {
  await expect
    .poll(
      async () => {
        const cls = (await layerPill(page, key).getAttribute('class')) ?? '';
        const tokens = cls.split(/\s+/);
        return TERMINAL_STATUS_CLASSES.some((status) => tokens.includes(status));
      },
      { message: `layer "${key}" never left the loading state`, timeout }
    )
    .toBe(true);
}

/**
 * Reveal the Tribal Nations umbrella's granular member rows (Unit F): the
 * member checkboxes stay permanently mounted but natively `hidden` until
 * the details disclosure opens, so any spec that drives a member checkbox
 * (`.check()` needs an actionable, visible input) opens it first. Read-only
 * assertions (`toBeChecked`) resolve the hidden DOM and do not need this.
 */
export async function openTribalNationsDetails(page: Page): Promise<void> {
  const toggle = page.locator('[data-layer-group-toggle="tribal-nations"]');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  }
}

// ---------------------------------------------------------------------------
// NWS HeatRisk network stub (DDM-P7-T05 F2)
// ---------------------------------------------------------------------------

const HEATRISK_IMAGE_SERVER_PATH =
  '/experimental/rest/services/NWS_HeatRisk/ImageServer';

/** HeatRisk publishes seven daily granules, one day apart (mirrors src/layers/heatrisk.ts). */
const HEATRISK_DAY_MS = 24 * 60 * 60 * 1000;

/** A one-pixel PNG for the layer's `/exportImage` tile requests. */
const HEATRISK_ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

export interface HeatRiskCatalogReceipt {
  /** Every `/identify` request's `time` param, in call order. */
  readonly identifyCalls: number[];
  /** The seven granule times this stub advertises, day 1 first. */
  readonly frameTimes: readonly number[];
}

export interface StubHeatRiskCatalogOptions {
  /** The seven days' issuer classes, day 1 first; default has one of each and one no-data day. */
  readonly values?: readonly (number | null)[];
}

/**
 * Route the NWS HeatRisk ImageServer (service metadata, the catalog
 * `/query`, `/identify`, and `/exportImage`) to a deterministic seven-frame
 * fixture. `fetchHeatRiskClaims` (src/impact/sources.ts) reads this catalog
 * independently of whether the HeatRisk map layer is on (DR-014 a), so ANY
 * briefing boot reaches this service; without this stub, a spec that never
 * names the `heatrisk` layer still sends the metadata/query/identify
 * requests to the live agency, against playwright.config.ts's "Deterministic
 * backbone only" (lines 16-23).
 *
 * Day 1's period is built relative to THIS CALL's own clock, three hours in,
 * so it reads in force (the outlook register, DR-070 amended 2026-09-08,
 * DR-071) at the moment a caller boots the briefing right after calling
 * this. A spec that needs an ENDED period for its own assertions builds its
 * own fixture instead (see tests/heat-h2-point-heat.spec.ts's DR-014 a
 * describe block, which keeps fixed literal frame times for exactly that
 * reason and says so in its own comment).
 */
export async function stubHeatRiskCatalog(
  page: Page,
  options: StubHeatRiskCatalogOptions = {}
): Promise<HeatRiskCatalogReceipt> {
  const day1Start = Date.now() - 3 * 60 * 60 * 1000;
  const frameTimes = Array.from(
    { length: 7 },
    (_, index) => day1Start + index * HEATRISK_DAY_MS
  );
  const values: readonly (number | null)[] =
    options.values ?? [2, 1, 0, 3, 4, null, 2];
  const identifyCalls: number[] = [];

  await page.route(
    (url) => url.pathname.startsWith(HEATRISK_IMAGE_SERVER_PATH),
    async (route) => {
      const requestUrl = new URL(route.request().url());
      if (requestUrl.pathname.endsWith('/query')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            features: frameTimes.map((validTime, index) => ({
              attributes: {
                name: `HeatRisk_${index + 1}_Mercator`,
                idp_validtime: validTime
              }
            }))
          })
        });
        return;
      }
      if (requestUrl.pathname.endsWith('/identify')) {
        const time = Number(requestUrl.searchParams.get('time'));
        identifyCalls.push(time);
        const index = frameTimes.indexOf(time);
        const value = index < 0 ? undefined : values[index];
        if (value === undefined) {
          await route.fulfill({
            status: 400,
            contentType: 'application/json',
            body: JSON.stringify({ error: { message: 'unknown time' } })
          });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            value: value === null ? 'NoData' : String(value),
            catalogItems: {
              features:
                value === null
                  ? []
                  : [{ attributes: { idp_validtime: time } }]
            }
          })
        });
        return;
      }
      if (requestUrl.pathname.endsWith('/exportImage')) {
        await route.fulfill({
          status: 200,
          contentType: 'image/png',
          body: HEATRISK_ONE_PIXEL_PNG
        });
        return;
      }
      // Service metadata: reached by the map layer's own activation
      // (src/layers/heatrisk.ts) AND the briefing's independent-catalog
      // fallback (src/ui/heatrisk-sequence.ts identifyHeatRiskForBriefing);
      // neither depends on the other being present on the page.
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          timeInfo: { timeExtent: [frameTimes[0], frameTimes.at(-1)] }
        })
      });
    }
  );

  return { identifyCalls, frameTimes };
}

// ---------------------------------------------------------------------------
// CPC seasonal temperature outlook network stub (DDM-P7-T07)
// ---------------------------------------------------------------------------

const CPC_SEASONAL_TEMP_OUTLOOK_PATH =
  '/vector/rest/services/outlooks/cpc_sea_temp_outlk/MapServer';

export interface CpcSeasonalTempReading {
  /** The issuer's own `cat` string; default `'Above'`. */
  readonly cat?: string;
  /** The issuer's own `prob` value; default `50`. */
  readonly prob?: number;
  /** The issuer's own `valid_seas` label, verbatim; default `'SON 2026'`. */
  readonly validSeas?: string;
  /** The issuer's `fcst_date`, epoch ms; default a fixed 2026 literal. */
  readonly fcstDate?: number | null;
  /** Serve zero features (the empty-read case) instead of the fixture row. */
  readonly empty?: boolean;
  /** Serve an ArcGIS HTTP-200 error envelope instead of the fixture row. */
  readonly errorEnvelope?: boolean;
  /** Serve this HTTP status with a plain failure body (the 500 case). */
  readonly httpStatus?: number;
}

export interface StubCpcSeasonalTempOutlookOptions extends CpcSeasonalTempReading {
  /**
   * Per-request readings in call order, for a spec proving supersession: the
   * Nth matching request is answered from `sequence[N-1]` (the last entry
   * repeats once the sequence is exhausted). The top-level fixture fields
   * above are ignored once `sequence` is given.
   */
  readonly sequence?: readonly CpcSeasonalTempReading[];
  /**
   * Resolved externally to delay only the FIRST matching request's
   * response, so a spec can hold an old generation's read open while a
   * newer selection's read (the second matching request) answers at once.
   */
  readonly holdFirst?: Promise<void>;
}

/**
 * Route the CPC seasonal temperature outlook MapServer (`cpc_sea_temp_outlk`,
 * `src/config/urls.ts` `cpcSeasonalTempOutlookMapServer`) to a deterministic
 * fixture. `fetchCpcSeasonalTempClaims` (src/impact/sources.ts) reads this
 * service on every briefing whose selection falls inside the regional impact
 * synthesis capability (the same gate `cpcSeasonal` and `cpcExtended`
 * already read), independent of any map layer, so `gotoApp` below calls this
 * unconditionally with its defaults (S17's lesson: an unstubbed briefing
 * lane reaches the live agency).
 *
 * De-duplicated per page (mirrors `stubRecentSatellite`): a spec that needs
 * a specific reading, a failure arm, or a held-open supersession race calls
 * this itself, WITH its own options, BEFORE `gotoApp`; `gotoApp`'s own later
 * call then finds this page already stubbed and is a no-op, so the spec's
 * reading is never shadowed by the default one.
 */
export async function stubCpcSeasonalTempOutlook(
  page: Page,
  options: StubCpcSeasonalTempOutlookOptions = {}
): Promise<void> {
  if (cpcSeasonalTempOutlookStubbedPages.has(page)) return;
  cpcSeasonalTempOutlookStubbedPages.add(page);

  const fulfillReading = async (
    route: Route,
    reading: CpcSeasonalTempReading
  ): Promise<void> => {
    const {
      cat = 'Above',
      prob = 50,
      validSeas = 'SON 2026',
      fcstDate = Date.UTC(2026, 8, 1),
      empty = false,
      errorEnvelope = false,
      httpStatus = 200
    } = reading;
    if (httpStatus !== 200) {
      await route.fulfill({
        status: httpStatus,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'stubbed upstream failure' })
      });
      return;
    }
    if (errorEnvelope) {
      await route.fulfill({
        status: 200,
        contentType: 'text/plain',
        body: JSON.stringify({
          status: 'error',
          messages: ['Could not access any server machines.']
        })
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: JSON.stringify({
        type: 'FeatureCollection',
        features: empty
          ? []
          : [
              {
                type: 'Feature',
                geometry: null,
                properties: {
                  cat,
                  prob,
                  valid_seas: validSeas,
                  fcst_date: fcstDate
                }
              }
            ]
      })
    });
  };

  let requestIndex = 0;
  await page.route(
    (url) => url.pathname.startsWith(CPC_SEASONAL_TEMP_OUTLOOK_PATH),
    async (route) => {
      const index = requestIndex;
      requestIndex += 1;
      if (index === 0 && options.holdFirst) await options.holdFirst;
      const reading = options.sequence
        ? (options.sequence[Math.min(index, options.sequence.length - 1)] ?? {})
        : options;
      await fulfillReading(route, reading);
    }
  );
}

const cpcSeasonalTempOutlookStubbedPages = new WeakSet<Page>();

/**
 * The set of layer keys currently encoded in the URL's `layers=` parameter.
 * Empty set for an explicit `?layers=` (all off) or when the parameter is a
 * bare empty value.
 */
export async function urlLayers(page: Page): Promise<Set<string>> {
  const s = await search(page);
  const raw = new URLSearchParams(s).get('layers');
  if (!raw) return new Set();
  return new Set(raw.split(',').map((x) => x.trim()).filter(Boolean));
}
