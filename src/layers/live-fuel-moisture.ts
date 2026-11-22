/**
 * Live fuel moisture on the map, twice over:
 *
 * - the catalog layer `live-fuel-moisture` (off until a person turns it on in
 *   the Layers studio), drawn in the publisher's own colours; and
 * - the Wildfire 3D ground behind the console's "Live fuel moisture" switch,
 *   drawn white, whiter where living plants hold less water, in the slot the
 *   plant-stress ground uses (the two are a choice: one at a time).
 *
 * Both draw the same published map (which one, and why, is
 * `chooseLayerComposite` in src/util/live-fuel-moisture-read.ts). Tiles are
 * made in the browser from the publisher's raster by byte range, so nothing
 * is fetched that the view does not need. The source, its terms, the limits
 * and every string are in src/config/live-fuel-moisture.ts.
 *
 * Status follows the project's tile-proof rule: the layer reads live only
 * from a tile of this map that actually loaded, and a view outside the maps'
 * area reads no data.
 */

import { addProtocol, type Map as MapLibreMap, type RasterTileSource } from 'maplibre-gl';

import type { LayerActivation } from '../config/layers';
import {
  LFMC_GROUND_CLASSES,
  LFMC_ISSUER_TICKS,
  LFMC_TEXT
} from '../config/live-fuel-moisture';
import { BOTTOM_STACK_IDS, firstLayerIdAbove } from '../map/layer-order';
import { registry } from '../state/registry';
import { LEGEND_ORDER, hideLegend, renderSwatchLegend, showLegend } from '../ui/legend-registry';
import { clearTimeBar, setTimeBar } from '../ui/time-bar';
import { cogBounds } from '../util/cog';
import {
  chooseLayerComposite,
  lfmcColor,
  lfmcDateSpan,
  lfmcGrid,
  readLfmcComposites,
  renderLfmcTile,
  type LfmcComposite,
  type LfmcTileStyle
} from '../util/live-fuel-moisture-read';
import { TILE_PROOF_WATCH } from '../util/raster-proof';
import { watchRasterTiles, type RasterTileOutcome, type RasterTileWatch } from '../util/raster-status';
import type { DrynessGroundDetail } from './wildfire-dryness';

const KEY = 'live-fuel-moisture';
const PROTOCOL = 'lfmc-tile';
const TILE_SIZE = 256;
/** One raster cell is about one screen pixel at zoom 8; deeper zooms magnify these tiles. */
const MAX_ZOOM = 8;
/** Lets the basemap's relief and labels read through the colours, as the fuel-risk surface does. */
const FLAT_OPACITY = 0.7;
/** Mirrored in src/map/layer-order.ts BOTTOM_STACK_IDS. */
export const LFMC_GROUND_LAYER_ID = 'wildfire-lfmc-ground';

/** What each mounted source draws; the tile address names its mount. */
const mounts = new Map<string, { readonly url: string; readonly style: LfmcTileStyle }>();
let protocolAdded = false;
let mountCount = 0;

function ensureProtocol(): void {
  if (protocolAdded) return;
  // lfmc-tile://<mount>/<z>/<x>/<y>
  addProtocol(PROTOCOL, async (request, controller) => {
    const parsed = new URL(request.url);
    const mount = mounts.get(parsed.hostname);
    const [z, x, y] = parsed.pathname.split('/').filter(Boolean).map(Number) as [number, number, number];
    if (!mount || ![z, x, y].every(Number.isSafeInteger) || z < 0 || z > MAX_ZOOM || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) {
      throw new Error('Unknown live fuel moisture tile');
    }
    const pixels = await renderLfmcTile(mount.url, z, x, y, TILE_SIZE, mount.style, controller.signal);
    // A tile outside the maps' area is a real, empty tile, not a failure.
    const image = new ImageData(pixels ?? new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4), TILE_SIZE, TILE_SIZE);
    return { data: await createImageBitmap(image) };
  });
  protocolAdded = true;
}

interface Mounted {
  readonly composite: LfmcComposite;
  readonly bounds: readonly [number, number, number, number];
  release(): void;
}

/**
 * Read the publisher's list, choose the map, prove its raster readable, then
 * add one raster source and layer and watch its tiles. `report` receives the
 * tile verdict whenever it changes. Throws when the list or the raster cannot
 * be read; nothing is left on the map in that case.
 */
async function mount(
  map: MapLibreMap,
  sourceId: string,
  layerId: string,
  style: LfmcTileStyle,
  opacity: number,
  beforeId: () => string | undefined,
  signal: AbortSignal,
  report: (outcome: RasterTileOutcome | null) => void
): Promise<Mounted> {
  const composite = chooseLayerComposite(await readLfmcComposites(signal));
  const bounds = cogBounds(await lfmcGrid(composite.url, signal));
  signal.throwIfAborted();
  ensureProtocol();
  mountCount += 1;
  const mountId = `m${mountCount}`;
  mounts.set(mountId, { url: composite.url, style });
  let watch: RasterTileWatch | null = null;
  const release = (): void => {
    watch?.detach();
    watch = null;
    mounts.delete(mountId);
    // Each step stands alone: a map being torn down may refuse either.
    try { if (map.getLayer(layerId)) map.removeLayer(layerId); } catch { /* Removed map. */ }
    try { if (map.getSource(sourceId)) map.removeSource(sourceId); } catch { /* Removed map. */ }
  };
  try {
    map.addSource(sourceId, {
      type: 'raster',
      tiles: [`${PROTOCOL}://${mountId}/{z}/{x}/{y}`],
      tileSize: TILE_SIZE,
      minzoom: 0,
      maxzoom: MAX_ZOOM,
      bounds: [...bounds]
    });
    // Whole-percent classes: take the tile of the zoom below and magnify it, never blend two.
    map.getSource<RasterTileSource>(sourceId)!.roundZoom = false;
    // A view showing none of the maps' area settles with no tiles, which the watch reads as an
    // error: that is no verdict at all, so a later pan into the area reads loading, not unavailable.
    watch = watchRasterTiles(
      map,
      sourceId,
      (outcome) => report(outcome === 'error' && viewCoverage(map, bounds) === 'none' ? null : outcome),
      TILE_PROOF_WATCH
    );
    // The anchor is looked up now, after the reads: the layer it named may have left meanwhile.
    map.addLayer(
      {
        id: layerId,
        type: 'raster',
        source: sourceId,
        paint: { 'raster-opacity': opacity, 'raster-fade-duration': 0, 'raster-resampling': 'nearest' }
      },
      beforeId()
    );
    // MapLibre reports a refused layer as an error event, not a throw.
    if (!map.getLayer(layerId)) throw new Error('The live fuel moisture layer was not added');
  } catch (error) {
    release();
    throw error;
  }
  return { composite, bounds, release };
}

/** Whether the view shows any of the maps' area, all of it, or none. */
function viewCoverage(map: MapLibreMap, bounds: readonly [number, number, number, number]): 'all' | 'some' | 'none' {
  const view = map.getBounds();
  const [west, south, east, north] = bounds;
  if (view.getEast() <= west || view.getWest() >= east || view.getNorth() <= south || view.getSouth() >= north) return 'none';
  return view.getWest() >= west && view.getEast() <= east && view.getSouth() >= south && view.getNorth() <= north ? 'all' : 'some';
}

// ---------------------------------------------------------------------------
// The catalog layer (flat map, Layers studio)
// ---------------------------------------------------------------------------

let flat: Mounted | null = null;
let flatRelease: (() => void) | null = null;

function renderFlatLegend(body: HTMLElement): void {
  renderSwatchLegend(
    body,
    LFMC_TEXT.flatTitle,
    LFMC_ISSUER_TICKS.map(([value, label]) => {
      const [r, g, b] = lfmcColor(value, 'issuer');
      return { color: `rgb(${r},${g},${b})`, label };
    }),
    // The key names the dates of the map on screen.
    flat
      ? `Map for ${lfmcDateSpan(flat.composite.start, flat.composite.endExclusive)}. ${LFMC_TEXT.definition}`
      : LFMC_TEXT.definition
  );
}

export async function activate(map: MapLibreMap, activation?: LayerActivation): Promise<void> {
  registry.setStatus(KEY, 'loading');
  deactivate(map);
  const signal = activation?.signal ?? new AbortController().signal;
  let verdict: RasterTileOutcome | null = null;
  let mounted: Mounted | null = null;
  const sync = (): void => {
    if (!mounted || flat !== mounted) return;
    registry.setStatus(KEY, viewCoverage(map, mounted.bounds) === 'none' ? 'no-data' : (verdict ?? 'loading'));
  };
  try {
    mounted = await mount(map, KEY, KEY, 'issuer', FLAT_OPACITY, () => undefined, signal, (outcome) => {
      verdict = outcome;
      sync();
    });
  } catch (error) {
    if (signal.aborted) return;
    console.warn(`[${KEY}] activation failed.`, error);
    registry.setStatus(KEY, 'error');
    return;
  }
  if (signal.aborted) {
    mounted.release();
    return;
  }
  flat = mounted;
  map.on('moveend', sync);
  flatRelease = () => map.off('moveend', sync);
  const { start, endExclusive } = mounted.composite;
  setTimeBar(KEY, {
    ariaLabel: 'Live fuel moisture map dates',
    stamp: {
      horizon: 'current',
      asOf: lfmcDateSpan(start, endExclusive),
      headline: lfmcDateSpan(start, endExclusive),
      detail: `${LFMC_TEXT.name} · ${LFMC_TEXT.issuer} · ${LFMC_TEXT.stampDetail}`,
      // Model-borne, so never the observed register (src/impact/evidence.ts, CLAIM_REGISTER_TAG).
      register: 'outlook'
    }
  });
  showLegend(KEY, { order: LEGEND_ORDER.surface, render: renderFlatLegend });
  sync();
}

export function deactivate(_map: MapLibreMap): void {
  flatRelease?.();
  flatRelease = null;
  flat?.release();
  flat = null;
  hideLegend(KEY);
  clearTimeBar(KEY);
}

/** A raster of model estimates carries nothing to click on; the briefing reads the place instead. */
export function bindPopups(_map: MapLibreMap): void {
  // Intentionally empty.
}

export const fadeLayerIds = [KEY] as const;

// ---------------------------------------------------------------------------
// The Wildfire 3D ground (the console's switch)
// ---------------------------------------------------------------------------

/** The key's rows and the briefing's full text for the ground, in the shape the plant-stress ground publishes. */
export function describeLfmcGround(
  state: DrynessGroundDetail['state'],
  composite: LfmcComposite | null,
  coverage: 'all' | 'some' | 'none'
): DrynessGroundDetail {
  const dates = composite ? lfmcDateSpan(composite.start, composite.endExclusive) : null;
  const lines = [
    ...(dates ? [dates] : []),
    // A tight key (owner, 2026-10-11): the definition, and the coverage line only when the view is not wholly covered.
    ...(composite ? [LFMC_TEXT.definition, ...(coverage === 'all' ? [] : [LFMC_TEXT.coverage])] : []),
    ...(state === 'unavailable' ? [LFMC_TEXT.unavailable] : [])
  ];
  return {
    state,
    productKey: composite ? KEY : 'none',
    title: LFMC_TEXT.groundTitle,
    rows: composite
      ? [...LFMC_GROUND_CLASSES.map((row) => ({ alpha: row.alpha, label: row.label })), { alpha: 0, label: LFMC_TEXT.noValue }]
      : [],
    lines,
    briefing: composite
      ? {
          heading: 'Live fuel moisture ground (Wildfire 3D)',
          lines: [
            LFMC_TEXT.groundTitle, dates!, LFMC_TEXT.definition, LFMC_TEXT.coverage, LFMC_TEXT.modelNote,
            LFMC_TEXT.thresholdNote, LFMC_TEXT.accuracyNote, `Source: ${LFMC_TEXT.source}.`, LFMC_TEXT.termsNote
          ],
          disclaimerUrl: null
        }
      : null
  };
}

/**
 * Draw the ground for one Wildfire 3D visit, until `signal` aborts or
 * `stop()` is called. `publish` receives what the key and the briefing show
 * (null when the ground leaves). Never rejects: a source that cannot be read
 * is the published state "unavailable".
 */
export function activateLiveFuelMoistureGround(
  map: MapLibreMap,
  signal: AbortSignal,
  publish: (detail: DrynessGroundDetail | null) => void
): { stop(): void } {
  const own = new AbortController();
  const cancel = (): void => own.abort();
  signal.addEventListener('abort', cancel, { once: true });
  let mounted: Mounted | null = null;
  let verdict: RasterTileOutcome | null = null;
  let stopped = signal.aborted;
  const sync = (): void => {
    if (stopped || !mounted) return;
    const coverage = viewCoverage(map, mounted.bounds);
    const state: DrynessGroundDetail['state'] =
      coverage === 'none' ? 'no data'
        : verdict === null ? 'loading'
          : verdict === 'error' ? 'unavailable'
            : verdict === 'degraded' || coverage === 'some' ? 'live (partial)' : 'live';
    publish(describeLfmcGround(state, mounted.composite, coverage));
  };
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    signal.removeEventListener('abort', cancel);
    own.abort();
    try { map.off('moveend', sync); } catch { /* Removed map. */ }
    mounted?.release();
    mounted = null;
    publish(null);
  };
  if (stopped) return { stop };
  own.signal.addEventListener('abort', stop, { once: true });
  publish(describeLfmcGround('loading', null, 'all'));
  const sourceId = `${LFMC_GROUND_LAYER_ID}-source`;
  // Under the hillshade and every drape, above the basemaps (BOTTOM_STACK_IDS order).
  const beforeId = (): string | undefined =>
    firstLayerIdAbove(map, BOTTOM_STACK_IDS.slice(0, BOTTOM_STACK_IDS.indexOf(LFMC_GROUND_LAYER_ID)));
  mount(map, sourceId, LFMC_GROUND_LAYER_ID, 'ground', 1, beforeId, own.signal, (outcome) => {
    verdict = outcome;
    sync();
  }).then(
    (result) => {
      if (stopped) {
        result.release();
        return;
      }
      mounted = result;
      map.on('moveend', sync);
      sync();
    },
    (error: unknown) => {
      if (stopped) return;
      console.warn(`[${KEY}] ground failed.`, error);
      publish(describeLfmcGround('unavailable', null, 'all'));
    }
  );
  return { stop };
}
