/**
 * Locate: from a position to a place (owner direction 2026-11-09 (sprint),
 * DR-pending). The impure half of src/state/geolocate.ts: it reads the
 * bundled outlines, the map and the layer registry, and opens briefings.
 *
 * WHAT LEAVES THE DEVICE, AND WHAT DOES NOT. Read against the code named:
 *
 *   1. THE STATE is resolved from `public/data/us-states.geojson`, the
 *      bundled Census outlines the page already holds (the shared transport
 *      in src/util/fetch.ts; a same-origin file with no parameters). No
 *      coordinate is sent.
 *   2. THE STATE'S BRIEFING frames the STATE (`openStateBriefing`,
 *      src/state/deep-link.ts), the path the `select=` link and the search
 *      use. The camera never centres on the person.
 *   3. THE TRIBAL CHECK moves the camera to the half-degree grid square
 *      that contains the position (`coarseCell`), never to the position.
 *      The two live boundary layers ask their services for the map VIEW:
 *      `buildQueryEnvelope(map.getBounds())` (src/layers/aiannh.ts and
 *      src/layers/bia-reservations.ts), and the base map and imagery
 *      request tiles for the same view. The view is a function of the
 *      square, the padding and the screen, so every one of those requests
 *      says which square, and none says where in it. The interface states
 *      this before the frame (`tribalDisclosure`, src/state/geolocate.ts).
 *   4. THE TEST ITSELF runs here, against the collections the layers
 *      already hold (`GeoJSONSource.getData()` returns the object the layer
 *      set). Nothing is fetched for it: a layer that is off is reported as
 *      off, and one that failed as not tested (the stewardship rule of
 *      src/state/location-identity.ts: never fetch a national boundary
 *      layer for one point).
 *   5. A BRIEFING is opened for the PLACE. `BoundarySelectionContext.lngLat`
 *      is sent to public point services by the briefing (src/impact/
 *      sources.ts, src/impact/point-heat.ts), so it is NEVER the person's
 *      position here: the state path takes the state's own representative
 *      point inside `openStateBriefing`, and the Tribal path takes
 *      `representativePoint` of the area's geometry with
 *      `pointInsidePlace: true`, exactly as the search does
 *      (src/ui/search-controller.ts).
 *
 * EVERY FRAME USES ONE PADDING RULE: `briefingCameraPadding`
 * (src/state/deep-link.ts), which keeps a framed place clear of the half
 * sheet and of the right-edge column. `clearOfCard` only widens it by the
 * band Locate's own card takes above the sheet.
 */

import type * as maplibregl from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';

import { getLayerDef } from '../config/layers';
import { BOOT_URLS } from '../config/urls-boot';
import type { BoundarySelectionContext } from '../impact/types';
import { cameraStateUnchanged, readCameraState } from '../map/camera-fit';
import { briefingCameraPadding, openStateBriefing } from '../state/deep-link';
import {
  coarseCell,
  discInsideEnvelope,
  drawnBy,
  findStates,
  findTribalHits,
  generalizationM,
  tribalVerdict
} from '../state/geolocate';
import type {
  LocateFix,
  StateFinding,
  StateRef,
  TribalHit,
  TribalLayerReading,
  TribalSource,
  TribalVerdict
} from '../state/geolocate';
import { showLocatedBoundary } from '../state/located-boundary';
import { clearEmphasis } from '../state/place-emphasis';
import { setPlaceSelection } from '../state/place-selection';
import { registry } from '../state/registry';
import { geometryBboxAcrossAntimeridian } from '../util/antimeridian';
import { bboxToContinuousBounds } from '../util/bbox';
import { fetchSharedJsonWithBudget, sleepUnlessAborted, US_STATES_SHARED_KEY } from '../util/fetch';
import { prefersReducedMotion } from '../util/motion';
import { isCurrentBriefingIntent, nextBriefingIntent, openImpactPanel } from './impact-panel';
import { getSheetDetent, isSheetActive } from './mobile-sheet';

/** Budget for the bundled outlines (same-origin; normally already in hand). */
const STATES_BUDGET_MS = 10_000;

/**
 * The three boundary layers location identity reads, with the source each
 * one's module adds. Mirrored literals, as src/state/location-identity.ts
 * mirrors the fill layer ids.
 */
const TRIBAL_LAYERS: readonly { readonly key: string; readonly sourceId: string; readonly source: TribalSource }[] = [
  { key: 'tribal', sourceId: 'tribal-lands', source: 'tribal' },
  { key: 'aiannh', sourceId: 'aiannh', source: 'aiannh' },
  { key: 'bia-reservations', sourceId: 'bia-reservations', source: 'bia-reservation' }
];

/**
 * The live boundary layers refetch on a debounced `moveend`
 * (REFRESH_DEBOUNCE_MS, 400 ms, in both layer modules); this waits that
 * long plus a margin before asking whether they have settled.
 */
const LAYER_REFRESH_WAIT_MS = 650;
/** Their own fetch budget is 15 s; one more second for the status to land. */
const LAYER_SETTLE_BOUND_MS = 16_000;
/** The frame's own travel time, and how long the check waits for it to end. */
const FRAME_MOVE_MS = 1_200;
const MOVE_BOUND_MS = 6_000;

/**
 * The dock's seat above the sheet's top edge, in px: the map-edge inset, the
 * scale rulers' block and the rider gap (`--mobile-map-edge`,
 * `--mobile-scale-block` and `--sheet-rider-gap`; src/styles/app.css and
 * src/styles/mobile-panels.css). A mirror: tests/geolocate.test.mjs reads
 * both stylesheets and fails when the sum moves.
 */
export const DOCK_SEAT_PX = 58;
/** A fit is never squeezed below this much free height by the card's band (two touch targets). */
const MIN_FRAME_PX = 88;

/**
 * Widen the panel-aware fit padding by the band Locate's card and the dock
 * under it take above the sheet's top edge, so the framed place is not left
 * under the card. Measured from the chrome, never from the position: the
 * view stays a function of the place framed, the padding and the screen.
 */
export function clearOfCard(base: maplibregl.PaddingOptions): maplibregl.PaddingOptions {
  const card = document.getElementById('locate-card');
  const dock = document.getElementById('map-bottom-dock');
  if (!card || card.hidden || !dock || !isSheetActive()) return base;
  // The card's band pushes the place up, toward the key chip: clear that too.
  const chip = document.getElementById('map-key-details-toggle')?.getBoundingClientRect();
  const top = Math.max(base.top ?? 0, chip && chip.height > 0 && chip.top < 80 ? Math.round(chip.bottom) + 8 : 0);
  const bottom = base.bottom ?? 0;
  const free = window.innerHeight - top - bottom;
  const band = Math.min(dock.offsetHeight + DOCK_SEAT_PX, Math.max(0, free - MIN_FRAME_PX));
  return { ...base, top, bottom: bottom + band };
}

/** Resolve the state locally. `null` when the bundled outlines could not be read. */
export async function resolveStates(fix: LocateFix, signal: AbortSignal): Promise<StateFinding | null> {
  try {
    const collection = (await fetchSharedJsonWithBudget(
      US_STATES_SHARED_KEY,
      BOOT_URLS.usStatesLocal,
      null,
      signal,
      STATES_BUDGET_MS
    )) as FeatureCollection;
    return findStates(collection, fix);
  } catch (err) {
    if (!signal.aborted) console.warn('[locate] the bundled state outlines could not be read.', err);
    return null;
  }
}

/** The Tribal boundary layers as the registry reports them now. */
export function tribalLayerReadings(): TribalLayerReading[] {
  const active = registry.getActiveKeys();
  return TRIBAL_LAYERS.map(({ key }) => ({
    key,
    // An active layer with no status yet is still loading.
    status: active.has(key) ? (registry.getStatus(key) ?? 'loading') : 'off'
  }));
}

/** A layer's catalog name with its source, for "checked" and "not checked" lines. */
export function tribalLayerName(key: string): string {
  const def = getLayerDef(key);
  return def ? `${def.name} (${def.source.split(' · ')[0] ?? def.source})` : key;
}

/** Who the boundary layers that are on ask, for the line shown before the frame. */
export function agenciesAsked(): string[] {
  const on = new Set(tribalLayerReadings().filter((layer) => layer.status !== 'off').map((layer) => layer.key));
  return TRIBAL_LAYERS.filter((layer) => on.has(layer.key) && layer.source !== 'tribal').map((layer) =>
    drawnBy(layer.source)
  );
}

/** The outcome of a check. `moved`: the map moved before it finished, so nothing was tested. */
export type TribalCheck =
  | { readonly kind: 'verdict'; readonly verdict: TribalVerdict; readonly toleranceM: number }
  | { readonly kind: 'moved' };

function waitForMoveEnd(map: maplibregl.Map, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      window.clearTimeout(timer);
      map.off('moveend', done);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = window.setTimeout(done, MOVE_BOUND_MS);
    map.once('moveend', done);
    signal.addEventListener('abort', done, { once: true });
  });
}

function waitForLayers(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const settled = (): boolean => tribalLayerReadings().every((layer) => layer.status !== 'loading');
    const done = (): void => {
      window.clearTimeout(timer);
      off();
      signal.removeEventListener('abort', done);
      resolve();
    };
    const off = registry.on('status-change', () => {
      if (settled()) done();
    });
    const timer = window.setTimeout(done, LAYER_SETTLE_BOUND_MS);
    signal.addEventListener('abort', done, { once: true });
    if (settled()) done();
  });
}

/** The padding every Locate frame uses: the briefing rule, widened by the card. */
function framePadding(): maplibregl.PaddingOptions {
  const detent = getSheetDetent();
  return clearOfCard(briefingCameraPadding(detent !== null && detent !== 'closed'));
}

async function loadedCollections(
  map: maplibregl.Map,
  readings: readonly TribalLayerReading[]
): Promise<{ source: TribalSource; collection: FeatureCollection }[]> {
  const loaded: { source: TribalSource; collection: FeatureCollection }[] = [];
  for (const layer of TRIBAL_LAYERS) {
    const status = readings.find((reading) => reading.key === layer.key)?.status;
    if (status !== 'ready' && status !== 'degraded') continue;
    const source = map.getSource(layer.sourceId) as maplibregl.GeoJSONSource | undefined;
    if (!source || typeof source.getData !== 'function') continue;
    const data = await source.getData();
    if (data.type === 'FeatureCollection') loaded.push({ source: layer.source, collection: data });
  }
  return loaded;
}

/**
 * Frame the grid square, let the boundary layers that are already on load
 * it as they would for any pan, then test the position against what they
 * hold. Resolves `null` when aborted.
 */
export async function checkTribalLands(
  map: maplibregl.Map,
  fix: LocateFix,
  signal: AbortSignal
): Promise<TribalCheck | null> {
  // Nothing on means nothing to load and nothing to test: say so, and leave the camera alone.
  if (tribalLayerReadings().every((layer) => layer.status === 'off')) {
    return { kind: 'verdict', verdict: { kind: 'layers-off' }, toleranceM: 0 };
  }

  const [west, south, east, north] = coarseCell(fix.lng, fix.lat);
  const bounds: [[number, number], [number, number]] = [
    [west, south],
    [east, north]
  ];
  const padding = framePadding();
  const target = map.cameraForBounds(bounds, { padding });
  const moved = waitForMoveEnd(map, signal);
  map.fitBounds(bounds, { padding, duration: prefersReducedMotion() ? 0 : FRAME_MOVE_MS });
  await moved;
  if (signal.aborted) return null;
  // A gesture that cut the move short left some other view: the layers
  // would load that view, and the square is no longer what was framed.
  if (!target || target.zoom === undefined || Math.abs(map.getZoom() - target.zoom) > 0.01) return { kind: 'moved' };
  const frame = readCameraState(map);

  await sleepUnlessAborted(LAYER_REFRESH_WAIT_MS, signal);
  await waitForLayers(signal);
  if (signal.aborted) return null;
  // A pan or zoom since the frame means the layers now hold some other view.
  if (!cameraStateUnchanged(map, frame)) return { kind: 'moved' };

  const readings = tribalLayerReadings();
  const loaded = await loadedCollections(map, readings);
  if (signal.aborted) return null;
  const toleranceM = generalizationM(Math.floor(map.getZoom()));
  const hits = findTribalHits(loaded, fix, toleranceM);
  // Every application of a layer covers at least the view it was made for.
  const view = map.getBounds();
  const covered = discInsideEnvelope(fix.lng, fix.lat, fix.accuracy + toleranceM, [
    view.getWest(),
    view.getSouth(),
    view.getEast(),
    view.getNorth()
  ]);
  return { kind: 'verdict', verdict: tribalVerdict(readings, hits, covered), toleranceM };
}

/** How a loaded area is named on the card, and the caveat its kind carries. */
export interface TribalPlaceWords {
  /** The title a click on the area gives: the roster's gated Nation name where it has one. */
  readonly title: string;
  /** The service's own area name, when the title differs from it. */
  readonly areaLabel: string | null;
  /** The representation caveat for this kind of boundary, verbatim from src/impact/context.ts. */
  readonly caveat: string;
}

/**
 * Title a loaded area as a click on it would (the same gate and the same
 * rule as `attachConditionDoor` in src/map/interaction-coordinator.ts): a
 * legal Census area over a BIA land area takes the Nation name the land
 * area's click gives, only when the roster's gate names one.
 */
export async function tribalPlaceWords(hit: TribalHit, biaLandArea: string | null): Promise<TribalPlaceWords> {
  const { caveatFor, loadBiaNationNames, loadCensusNationNames, resolveBoundaryTitle } = await import(
    '../impact/context'
  );
  if (hit.source === 'bia-reservation') {
    await loadBiaNationNames().catch(() => {});
    const title = resolveBoundaryTitle('bia-reservation', hit.feature.properties ?? null);
    return { title, areaLabel: title !== hit.name ? `Land area: ${hit.name}` : null, caveat: caveatFor('bia-reservation') };
  }
  if (hit.source === 'aiannh') {
    await Promise.all([
      loadCensusNationNames().catch(() => {}),
      biaLandArea ? loadBiaNationNames().catch(() => {}) : null
    ]);
    const nation = biaLandArea ? resolveBoundaryTitle('bia-reservation', { LARNAME: biaLandArea }) : null;
    const title =
      nation && nation !== biaLandArea ? nation : resolveBoundaryTitle('aiannh', hit.feature.properties ?? null);
    return { title, areaLabel: title !== hit.name ? `Census area: ${hit.name}` : null, caveat: caveatFor('aiannh') };
  }
  return { title: resolveBoundaryTitle('tribal', hit.feature.properties ?? null), areaLabel: null, caveat: caveatFor('tribal') };
}

/** Open a state's briefing, framing the state. The point it reads at is the state's own. */
export function openStateBriefingFor(map: maplibregl.Map, state: StateRef, stillWanted: () => boolean): Promise<void> {
  const intent = nextBriefingIntent();
  return openStateBriefing(map, state.code, {
    fit: true,
    guard: () => isCurrentBriefingIntent(intent) && stillWanted(),
    padding: clearOfCard
  });
}

/**
 * Open a loaded Tribal land area's briefing through the search's path:
 * frame it, select it, open the panel, light the geometry. Returns false
 * when the area could not be opened.
 */
export async function openTribalBriefingFor(
  map: maplibregl.Map,
  hit: TribalHit,
  words: TribalPlaceWords,
  stillWanted: () => boolean
): Promise<boolean> {
  const intent = nextBriefingIntent();
  const geometry = hit.feature.geometry;
  const bbox = geometryBboxAcrossAntimeridian(geometry);
  // Without a box there is no point of the area's own to read at, and the
  // person's position is never the substitute.
  if (!bbox) return false;
  const [{ buildBoundaryContext }, { representativePoint }] = await Promise.all([
    import('../impact/context'),
    import('../util/point-in-polygon')
  ]);
  if (!isCurrentBriefingIntent(intent) || !stillWanted()) return false;
  const raw = buildBoundaryContext(
    hit.source,
    hit.feature.properties ?? null,
    geometry,
    representativePoint(geometry, bbox),
    words.title
  );
  const context: BoundarySelectionContext = {
    ...raw,
    bbox,
    pointInsidePlace: true,
    ...(words.areaLabel ? { areaLabel: words.areaLabel } : {})
  };
  // The briefing answers in the sheet at half: frame for it, as the state path does.
  map.fitBounds(bboxToContinuousBounds(bbox), { padding: clearOfCard(briefingCameraPadding(true)) });
  // Selection first, then the highlight for this subject (the order the search keeps).
  setPlaceSelection({ label: context.title, context });
  openImpactPanel(context);
  clearEmphasis(map);
  showLocatedBoundary(map, geometry);
  return true;
}
