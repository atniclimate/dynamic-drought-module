/**
 * Shared helpers and canonical constants for the DDM smoke suite.
 *
 * The constants below mirror the application's config tables and the pill
 * vocabulary so the specs read as assertions about behavior rather than
 * about magic strings. If a config table changes (a preset is renamed, a
 * role group relabeled), these mirrors are the single place to update, and
 * the mismatch surfaces as a failing spec rather than silent drift.
 */

import { expect, type Page, type Locator } from '@playwright/test';

const TEST_GROUND_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);
const groundStubbedPages = new WeakSet<Page>();

export async function stubHistoricalGround(page: Page): Promise<void> {
  if (groundStubbedPages.has(page)) return;
  groundStubbedPages.add(page);
  await page.route('**/wmts/1.0.0/s2cloudless_3857/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: TEST_GROUND_PNG
    })
  );
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
 * default carries the two present-day layers. The changes are recorded in
 * docs/URL_SCHEMA_POLICY.md. Hillshade joined 2026-07-16 (E1 deliverable 4,
 * D-0.7.0-043 part 3: terrain shading is part of the calm default
 * composition). */
export const DEFAULT_ON = ['usdm', 'aiannh', 'bia-reservations', 'states', 'hillshade'] as const;

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

/** The region radio button for a region key. */
export function regionButton(page: Page, key: string): Locator {
  return page.locator(`.region-btn[data-region-key="${key}"]`);
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
export async function gotoApp(page: Page, query = ''): Promise<void> {
  // The historical EOX ground is production-vetted separately. Routine
  // deterministic browser tests use one local image for both its probe and
  // viewport tiles so the full suite neither depends on nor floods the public
  // service. Ground-specific specs call page.goto directly and own their route.
  await stubHistoricalGround(page);
  await page.goto(query, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#preset-chips .preset-chip')).toHaveCount(PRESET_LABELS.length);
  await expect(page.locator('#region-buttons .region-btn')).not.toHaveCount(0);
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
