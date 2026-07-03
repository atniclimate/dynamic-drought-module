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
 * legend panel swaps the window; the default is 90 day. The Standardized
 * Precipitation Evapotranspiration Index (SPEI) and the Evaporative Demand
 * Drought Index (EDDI) are not published under this tile prefix, so they are
 * not offered (see urls.ts); adding them is a future refinement, not a guess.
 *
 * No popups: the index color scale is baked into the tiles and they carry no
 * per-feature properties, so there is nothing to query on click. The legend
 * panel provides an orientation gradient and links the authoritative drought.gov
 * legend.
 *
 * Zoom ceiling: tiles exist to zoom 6, so the source `maxzoom` is 6 and
 * MapLibre overzooms (upscales) above it rather than requesting tiles that do
 * not exist.
 *
 * Source: `URLS.nidisGriddedTileRoot` (verified 2026-05-30; see urls.ts).
 */

import type maplibregl from 'maplibre-gl';
import { URLS } from '../config/urls';
import { registry } from '../state/registry';
import { escapeHtml } from '../util/escape';
import { showLegend, hideLegend, LEGEND_ORDER } from '../ui/legend-registry';
import { watchRasterTiles, type RasterTileWatch } from '../util/raster-status';

const LAYER_KEY = 'gridded-index';
const SOURCE_ID = 'gridded-index';
const LAYER_ID = 'gridded-index-raster';

/** Fade targets for the sidebar's toggle transitions (LayerModule contract). */
export const fadeLayerIds = [LAYER_ID] as const;

/** The symbol layer to insert beneath, so basemap labels stay readable. */
const BEFORE_ID = 'first-symbol';

/** Tiles exist to zoom 6; MapLibre overzooms above this. */
const MAX_ZOOM = 6;

/**
 * Verified SPI products (slug plus label). Each slug was confirmed live
 * (HTTP 200, image/png, CORS open) on 2026-05-30. The slug is appended to
 * `URLS.nidisGriddedTileRoot` to form the tile template.
 */
interface GriddedProduct {
  readonly slug: string;
  readonly label: string;
}

const PRODUCTS: readonly GriddedProduct[] = [
  { slug: 'ce-ACIS_NRCC_NN-spi-30d', label: 'SPI, 30 day' },
  { slug: 'ce-ACIS_NRCC_NN-spi-60d', label: 'SPI, 60 day' },
  { slug: 'ce-ACIS_NRCC_NN-spi-90d', label: 'SPI, 90 day' },
  { slug: 'ce-ACIS_NRCC_NN-spi-180d', label: 'SPI, 180 day' },
  { slug: 'ce-ACIS_NRCC_NN-spi-365d', label: 'SPI, 365 day' }
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

/**
 * Add the raster source and layer for the current product. Idempotent: each
 * add is guarded so a re-activation does not stack duplicates, and a
 * post-remove call (the product swap) re-adds cleanly. The source spec and
 * paint live here once so a tile-size, zoom, opacity, or attribution change is
 * a single edit.
 */
function addRasterSourceAndLayer(map: maplibregl.Map): void {
  if (!map.getSource(SOURCE_ID)) {
    map.addSource(SOURCE_ID, {
      type: 'raster',
      tiles: [tileTemplate(currentSlug)],
      tileSize: 256,
      maxzoom: MAX_ZOOM,
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

/** Reflect the active product in the legend label. */
function updateLegendLabel(): void {
  const el = document.getElementById('gridded-index-product-label');
  if (el) el.textContent = productLabel(currentSlug);
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
  addRasterSourceAndLayer(map);
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
  if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
  hideLegend(LAYER_KEY);
}

/**
 * Swap the active SPI window. Removes and re-adds the source with the new tile
 * template (a raster source's tiles cannot be mutated in place). No-op beyond
 * recording the slug when the layer is not currently active, so the next
 * activate uses the chosen product.
 */
function setProduct(map: maplibregl.Map, slug: string): void {
  if (slug === currentSlug && map.getSource(SOURCE_ID)) return;
  currentSlug = slug;
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
}

/**
 * Build the gridded-index legend section: the product selector, the dry-to-wet
 * orientation ramp, and the source note. The unified legend registry creates
 * and destroys this section per activation, so the selector is populated and
 * its change handler bound here (each show) rather than once at boot.
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
    `<p class="legend-note"><span id="gridded-index-product-label">${escapeHtml(productLabel(currentSlug))}</span> · NOAA NIDIS. The exact color scale is baked into the tiles; <a href="https://www.drought.gov/current-conditions" target="_blank" rel="noopener">see the drought.gov legend</a>.</p>`;

  const select = body.querySelector<HTMLSelectElement>('#gridded-index-product');
  if (!select) return;
  select.innerHTML = PRODUCTS.map(
    (p) =>
      `<option value="${escapeHtml(p.slug)}"${p.slug === currentSlug ? ' selected' : ''}>${escapeHtml(p.label)}</option>`
  ).join('');
  select.addEventListener('change', () => setProduct(map, select.value));
}
