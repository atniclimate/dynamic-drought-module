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
import { expect, type BrowserContext, type Page, type Locator } from '@playwright/test';
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
  if (options.bootIdle !== false) {
    await expect(page.locator('html')).toHaveAttribute('data-ddm-boot', 'idle');
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
