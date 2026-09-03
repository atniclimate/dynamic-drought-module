/**
 * Gridded drought-index raster layer.
 *
 * Renders the National Integrated Drought Information System (NIDIS)
 * current-conditions Standardized Precipitation Index (SPI) as an XYZ raster
 * overlay, on the same MapLibre raster pattern as the CPC Seasonal Drought
 * Outlook (`drought.ts`). The SPI is a precipitation-deficit index on a chosen
 * accumulation window: short windows track flash conditions, long windows
 * track hydrological drought and water supply (ddm-drought-impact-modeling).
 *
 * Product selector: the SPI is published at several windows (30, 60, 90, 180,
 * and 365 day), each a distinct verified tile slug. A small selector in the
 * legend panel swaps the window; the default is 90 day. The chosen window
 * round-trips through the URL as `spi=<days>` (`src/state/url.ts`), with the
 * 90 day default encoded by absence, so a shared link restores it. The
 * Standardized
 * Precipitation Evapotranspiration Index (SPEI) and the Evaporative Demand
 * Drought Index (EDDI) are not published under this tile prefix, so they are
 * not offered (see urls.ts); adding them is a future refinement, not a guess.
 *
 * No popups: the index color scale is baked into the tiles and they carry no
 * per-feature properties, so there is nothing to query on click. The legend
 * panel provides an orientation gradient and links the authoritative drought.gov
 * legend.
 *
 * Valid date: each product publishes `<slug>/info.json` beside its tiles,
 * carrying the valid `date` of the raster and the product's true `tilezmax`.
 * drought.gov documents it: "info.json contains the valid date in JSON
 * format". The layer reads it on activation and on every window change,
 * because the windows are NOT equally fresh (on 2026-09-01 the 90 day raster
 * was 3 days old and the 365 day raster was 62 days old) and an undated
 * raster reads as current conditions when it is not (DWH-02). When the file
 * does not answer, the legend says the date is unavailable; it never shows a
 * date the issuer did not publish, and it applies no staleness threshold of
 * its own.
 *
 * Zoom ceiling: the source `maxzoom` comes from the product's own `tilezmax`
 * once `info.json` answers, and is 6 until then (every wired SPI window
 * publishes 6; siblings on this bucket publish 7). MapLibre overzooms
 * (upscales) above the ceiling rather than requesting tiles that do not exist.
 *
 * Source: `URLS.nidisGriddedTileRoot` (verified 2026-05-30; see urls.ts).
 */

import type * as maplibregl from 'maplibre-gl';
import { URLS } from '../config/urls';
import { registry } from '../state/registry';
import { escapeHtml } from '../util/escape';
import { fetchJsonWithBudget } from '../util/fetch';
import { isObject } from '../util/guards';
import { parseSpiWindowParam, syncSpiWindowParam } from '../state/url';
import { showLegend, hideLegend, LEGEND_ORDER } from '../ui/legend-registry';
import { watchRasterTiles, type RasterTileWatch } from '../util/raster-status';

const LAYER_KEY = 'gridded-index';
const SOURCE_ID = 'gridded-index';
const LAYER_ID = 'gridded-index-raster';

/** Fade targets for the sidebar's toggle transitions (LayerModule contract). */
export const fadeLayerIds = [LAYER_ID] as const;

/** The symbol layer to insert beneath, so basemap labels stay readable. */
const BEFORE_ID = 'first-symbol';

/**
 * The zoom ceiling used until (or unless) the product's `info.json` publishes
 * its own `tilezmax`. Every wired SPI window publishes 6.
 */
const DEFAULT_MAX_ZOOM = 6;

/**
 * Budget for the `info.json` read. It is a few hundred bytes on a
 * wildcard-CORS bucket with `Cache-Control: max-age=3600`, so a request that
 * has not answered in this long is not going to; the legend then says the date
 * is unavailable rather than waiting on it.
 */
const INFO_TIMEOUT_MS = 6_000;

/**
 * Verified SPI products (slug plus label). Each slug was confirmed live
 * (HTTP 200, image/png, CORS open) on 2026-05-30. The slug is appended to
 * `URLS.nidisGriddedTileRoot` to form the tile template.
 */
interface GriddedProduct {
  readonly slug: string;
  readonly label: string;
  /** Accumulation window in days; the value carried by the `spi=` parameter. */
  readonly days: number;
}

const PRODUCTS: readonly GriddedProduct[] = [
  { slug: 'ce-ACIS_NRCC_NN-spi-30d', label: 'SPI, 30 day', days: 30 },
  { slug: 'ce-ACIS_NRCC_NN-spi-60d', label: 'SPI, 60 day', days: 60 },
  { slug: 'ce-ACIS_NRCC_NN-spi-90d', label: 'SPI, 90 day', days: 90 },
  { slug: 'ce-ACIS_NRCC_NN-spi-180d', label: 'SPI, 180 day', days: 180 },
  { slug: 'ce-ACIS_NRCC_NN-spi-365d', label: 'SPI, 365 day', days: 365 }
];

const DEFAULT_PRODUCT = 'ce-ACIS_NRCC_NN-spi-90d';

/** Source attribution, declared once (used by every source-add). */
const ATTRIBUTION = 'NOAA NIDIS / drought.gov';
/** Raster opacity: partial so the basemap and boundaries read through the tint. */
const RASTER_OPACITY = 0.72;

/** The currently selected product slug, preserved across deactivate cycles. */
let currentSlug: string = DEFAULT_PRODUCT;

/** The tile-load honesty watcher (util/raster-status.ts); null when inactive. */
let tileWatch: RasterTileWatch | null = null;

/**
 * What one product's `info.json` says. The published contract is not uniform:
 * some slugs carry `date`, `last-modified`, `tilezmin`, `tilezmax` and `bbox`,
 * some carry `date` alone, and a few publish no file at all; `date` itself
 * appears as `2026-08-29` on the ACIS family and `20260827` on others, and the
 * zoom values are published as STRINGS. Both fields are therefore optional and
 * parsed defensively: an unreadable field is null, never a guess.
 */
interface ProductInfo {
  /** The issuer's valid date, humanized, or its own string when unparseable. */
  readonly validDate: string | null;
  /** The product's top published tile zoom. */
  readonly tileMaxZoom: number | null;
}

/** What the legend can honestly say about the current product's valid date. */
type InfoState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly info: ProductInfo }
  | { readonly kind: 'unavailable' };

/** Parsed `info.json` per slug, for the session (a re-select re-uses it). */
const infoBySlug = new Map<string, ProductInfo>();

/** The current read, and the slug it describes (never shown for another). */
let infoState: InfoState = { kind: 'loading' };
let infoStateSlug = '';

/** The in-flight `info.json` read; aborted on product swap and on deactivate. */
let infoController: AbortController | null = null;

/** The `maxzoom` the currently added source was built with. */
let appliedMaxZoom = DEFAULT_MAX_ZOOM;

function resolveBeforeId(map: maplibregl.Map): string | undefined {
  return map.getLayer(BEFORE_ID) ? BEFORE_ID : undefined;
}

/** Build the XYZ tile template for a product slug. */
function tileTemplate(slug: string): string {
  return `${URLS.nidisGriddedTileRoot}/${slug}/{z}/{x}/{y}.png`;
}

function productLabel(slug: string): string {
  return PRODUCTS.find((p) => p.slug === slug)?.label ?? 'SPI';
}

/** The accumulation window a slug carries, in days; null for an unknown slug. */
function daysForSlug(slug: string): number | null {
  return PRODUCTS.find((p) => p.slug === slug)?.days ?? null;
}

/** The product slug for an accumulation window in days; null when unpublished. */
function slugForDays(days: number): string | null {
  return PRODUCTS.find((p) => p.days === days)?.slug ?? null;
}

/**
 * Restore the accumulation window a shared link asks for (`spi=`), before the
 * first source-add so the restored window is the one that is actually
 * fetched. Absence is the 90 day default AND a link that never touched the
 * selector, so it leaves the current selection alone, preserving the
 * across-deactivate-cycles contract above. A stale source (a re-activation
 * that never went through `deactivate`) would keep the previous template, so
 * it is dropped and rebuilt from the restored slug; no tile URL changes.
 */
function applyUrlWindow(map: maplibregl.Map): void {
  const days = parseSpiWindowParam();
  if (days === null) return;
  const slug = slugForDays(days);
  if (slug === null || slug === currentSlug) return;
  currentSlug = slug;
  if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
}

/**
 * The zoom ceiling for the current product: its own published `tilezmax` when
 * `info.json` has answered, else the default. Never above the published value,
 * so MapLibre cannot request a zoom the bucket does not carry.
 */
function maxZoomForCurrentProduct(): number {
  return infoBySlug.get(currentSlug)?.tileMaxZoom ?? DEFAULT_MAX_ZOOM;
}

/**
 * Add the raster source and layer for the current product. Idempotent: each
 * add is guarded so a re-activation does not stack duplicates, and a
 * post-remove call (the product swap) re-adds cleanly. The source spec and
 * paint live here once so a tile-size, zoom, opacity, or attribution change is
 * a single edit.
 */
function addRasterSourceAndLayer(map: maplibregl.Map): void {
  if (!map.getSource(SOURCE_ID)) {
    appliedMaxZoom = maxZoomForCurrentProduct();
    map.addSource(SOURCE_ID, {
      type: 'raster',
      tiles: [tileTemplate(currentSlug)],
      tileSize: 256,
      maxzoom: appliedMaxZoom,
      attribution: ATTRIBUTION
    });
  }
  if (!map.getLayer(LAYER_ID)) {
    map.addLayer(
      {
        id: LAYER_ID,
        type: 'raster',
        source: SOURCE_ID,
        paint: { 'raster-opacity': RASTER_OPACITY }
      },
      resolveBeforeId(map)
    );
  }
}

/**
 * "Aug 29, 2026" from either published `date` form (`2026-08-29` and
 * `20260827` both occur on this bucket). A string in neither form is returned
 * VERBATIM: it is still the issuer's own valid date, and echoing it is honest
 * where reformatting it would be a guess.
 */
function humanValidDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (raw === '') return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw) ?? /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
  if (!parts) return raw;
  const ms = Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
  if (!Number.isFinite(ms)) return raw;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC'
  }).format(new Date(ms));
}

/** A published zoom level (the bucket sends them as strings), else null. */
function publishedZoom(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 24 ? n : null;
}

/** Read the two fields the layer uses out of whichever shape arrived. */
function parseProductInfo(json: unknown): ProductInfo {
  if (!isObject(json)) return { validDate: null, tileMaxZoom: null };
  return {
    validDate: humanValidDate(json['date']),
    tileMaxZoom: publishedZoom(json['tilezmax'])
  };
}

/** The legend's valid-date stamp for the current product and read state. */
function validDateStamp(): string {
  const state: InfoState = infoStateSlug === currentSlug ? infoState : { kind: 'loading' };
  if (state.kind === 'loading') return 'Valid date loading';
  if (state.kind === 'unavailable') return 'Valid date unavailable';
  return state.info.validDate === null
    ? 'Valid date not published'
    : `Valid ${state.info.validDate}`;
}

/** Reflect the active product and its valid date in the legend note. */
function updateLegendLabel(): void {
  const el = document.getElementById('gridded-index-product-label');
  if (el) el.textContent = productLabel(currentSlug);
  const stamp = document.getElementById('gridded-index-valid');
  if (stamp) stamp.textContent = validDateStamp();
}

/**
 * Read `<slug>/info.json` and apply it: the valid date to the legend stamp,
 * and the published `tilezmax` to the source when it differs from the ceiling
 * the source was built with. Cancellable (a product swap or a deactivate
 * aborts the read) and time-bounded (invariant 7). A failure is reported as
 * an unavailable date, never as a date.
 *
 * The layer's own six-state status is NOT touched here: the tiles are the
 * layer, the tile watcher owns their state, and a missing sidecar file must
 * not turn a rendering raster into a failure.
 */
async function loadProductInfo(map: maplibregl.Map): Promise<void> {
  const slug = currentSlug;
  infoController?.abort();
  infoController = null;

  const cached = infoBySlug.get(slug);
  if (cached) {
    infoStateSlug = slug;
    infoState = { kind: 'ready', info: cached };
    applyProductInfo(map, slug);
    return;
  }

  const controller = new AbortController();
  infoController = controller;
  infoStateSlug = slug;
  infoState = { kind: 'loading' };
  updateLegendLabel();

  try {
    const json = await fetchJsonWithBudget(
      `${URLS.nidisGriddedTileRoot}/${slug}/info.json`,
      null,
      controller.signal,
      INFO_TIMEOUT_MS
    );
    if (controller.signal.aborted || currentSlug !== slug) return;
    const info = parseProductInfo(json);
    infoBySlug.set(slug, info);
    infoStateSlug = slug;
    infoState = { kind: 'ready', info };
    applyProductInfo(map, slug);
  } catch (err) {
    if (controller.signal.aborted || currentSlug !== slug) return;
    console.warn('[gridded-index] product info.json unavailable.', err);
    infoStateSlug = slug;
    infoState = { kind: 'unavailable' };
    updateLegendLabel();
  } finally {
    if (infoController === controller) infoController = null;
  }
}

/**
 * Show the read, and rebuild the source when the product publishes a different
 * zoom ceiling than the one it was added with. A raster source's `maxzoom`
 * cannot be mutated in place, so this is the same remove-then-re-add the
 * product swap already performs, followed by the same watcher reset (the new
 * source starts on a fresh evidence slate).
 */
function applyProductInfo(map: maplibregl.Map, slug: string): void {
  updateLegendLabel();
  const zoom = infoBySlug.get(slug)?.tileMaxZoom ?? null;
  if (zoom === null || zoom === appliedMaxZoom) return;
  if (currentSlug !== slug || !map.getSource(SOURCE_ID)) return;
  if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
  map.removeSource(SOURCE_ID);
  addRasterSourceAndLayer(map);
  tileWatch?.reset();
}

/**
 * Add the raster source and layer for the current product. Idempotent: a
 * re-activation with the source already present is a no-op (so the URL-restore
 * path cannot stack duplicates). Raster tiles load lazily through MapLibre, so
 * there is no fetch to await; status goes to `ready` and the tile watcher
 * keeps it honest afterward (degrade on repeated tile failures, heal on the
 * next successful load).
 */
export async function activate(map: maplibregl.Map): Promise<void> {
  applyUrlWindow(map);
  addRasterSourceAndLayer(map);
  // The valid date is read alongside the tiles, not before them: the raster
  // renders immediately and the legend's date stamp fills in when the sidecar
  // answers (or says it did not).
  void loadProductInfo(map);
  tileWatch?.detach();
  tileWatch = watchRasterTiles(map, SOURCE_ID, (state) => registry.setStatus(LAYER_KEY, state));
  showLegend(LAYER_KEY, {
    order: LEGEND_ORDER.surface,
    render: (body) => renderLegendSection(map, body)
  });
  registry.setStatus(LAYER_KEY, 'ready');
}

/** Remove the raster layer and source and hide the legend. Symmetric, safe. */
export function deactivate(map: maplibregl.Map): void {
  tileWatch?.detach();
  tileWatch = null;
  infoController?.abort();
  infoController = null;
  if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
  hideLegend(LAYER_KEY);
}

/**
 * Swap the active SPI window. Removes and re-adds the source with the new tile
 * template (a raster source's tiles cannot be mutated in place). No-op beyond
 * recording the slug and the URL when the layer is not currently active, so
 * the next activate uses the chosen product.
 */
function setProduct(map: maplibregl.Map, slug: string): void {
  if (slug === currentSlug && map.getSource(SOURCE_ID)) return;
  currentSlug = slug;
  // Share the chosen window: the value is the accumulation period in DAYS,
  // and the 90 day default (or an unknown slug) clears the parameter.
  syncSpiWindowParam(daysForSlug(slug));
  if (!map.getSource(SOURCE_ID)) {
    updateLegendLabel();
    return;
  }
  // Re-add the source and layer with the new template, preserving z-order. A
  // raster source's tiles cannot be mutated in place, so remove then re-add.
  if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
  addRasterSourceAndLayer(map);
  // A product swap is a fresh evidence slate; old failures must not count
  // against the new template.
  tileWatch?.reset();
  updateLegendLabel();
  // Each window has its own valid date (they are not equally fresh), so the
  // swap re-reads the sidecar and the previous read is abandoned.
  void loadProductInfo(map);
}

/**
 * Build the gridded-index legend section: the product selector, the dry-to-wet
 * orientation ramp, and the source note with the product's valid date. The
 * unified legend registry creates and destroys this section per activation, so
 * the selector is populated and its change handler bound here (each show)
 * rather than once at boot; the date stamp renders whatever the current read
 * state honestly supports and is refreshed in place by `updateLegendLabel`.
 */
function renderLegendSection(map: maplibregl.Map, body: HTMLElement): void {
  body.innerHTML =
    '<h3 class="legend-section-title">Gridded index key</h3>' +
    '<label class="legend-control">' +
    '<span class="legend-control-label">Product</span>' +
    '<select id="gridded-index-product" class="legend-select" aria-label="Gridded drought index product"></select>' +
    '</label>' +
    '<div class="gridded-index-ramp" role="img" aria-label="Standardized Precipitation Index scale: drier on the left, wetter on the right">' +
    '<span class="gridded-index-ramp-bar"></span>' +
    '<div class="gridded-index-ramp-labels"><span>Drier</span><span>Wetter</span></div>' +
    '</div>' +
    `<p class="legend-note"><span id="gridded-index-product-label">${escapeHtml(productLabel(currentSlug))}</span> · <span id="gridded-index-valid">${escapeHtml(validDateStamp())}</span> · NOAA NIDIS. The exact color scale is baked into the tiles; <a href="https://www.drought.gov/current-conditions" target="_blank" rel="noopener">see the drought.gov legend</a>.</p>`;

  const select = body.querySelector<HTMLSelectElement>('#gridded-index-product');
  if (!select) return;
  select.innerHTML = PRODUCTS.map(
    (p) =>
      `<option value="${escapeHtml(p.slug)}"${p.slug === currentSlug ? ' selected' : ''}>${escapeHtml(p.label)}</option>`
  ).join('');
  select.addEventListener('change', () => setProduct(map, select.value));
}
