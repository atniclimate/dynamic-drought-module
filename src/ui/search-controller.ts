/**
 * Search controller (U3d): the wiring behind the one search experience.
 *
 * The search component (src/ui/island/search.tsx) is a pure view: it renders
 * grouped results and calls back. This module assembles the searchable items
 * and routes a selection, keeping the island itself free of layer / impact /
 * deep-link imports (ADR 0002). It is injected into every host that shows the
 * search (the console catalog, the Brief head, the mobile sheet), so all three
 * share ONE component and ONE routing brain.
 *
 * Four result kinds:
 *   - tribal a Tribal land area (LARNAME) or a Census AIANNH area
 *            (census:<code>) for a Tribe LAR cannot locate; locates it live,
 *            frames it, lights it, and opens its briefing (locateBoundary).
 *   - place  a state; opens its drought briefing (openStateBriefing).
 *   - city   a major city from the shipped Natural Earth points; moves the
 *            camera and opens the briefing of the State that holds it (no
 *            layer change).
 *   - layer  a catalog layer; turns it on through the shared toggle command
 *            (which syncs the checkbox and respects surface exclusivity,
 *            exactly like a catalog toggle; no layer co-activates a partner
 *            since DR-168).
 *
 * Stewardship: the roster it searches is NAMES ONLY (public/data/tribal-roster
 * .json). Locations come from a LIVE AIAN-LAR or Census AIANNH query at
 * selection time, never a bundled polygon (hard rule 1). The selection is
 * titled with the row's gated formal name, not the service's area name. The briefing carries
 * the representation caveat through buildBoundaryContext, as a map click would.
 */

import { h, render } from 'preact';
import type * as maplibregl from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';

import { LAYER_DEFS } from '../config/layers';
import { URLS } from '../config/urls';
import { STATE_LABEL } from '../impact/resources';
import type { StateCode } from '../impact/resources';
import { buildBoundaryContext } from '../impact/context';
import { escapeSql, mergeArealGeometry } from '../util/arcgis-features';
import { bboxCenter, bboxToContinuousBounds } from '../util/bbox';
import { geometryBboxAcrossAntimeridian } from '../util/antimeridian';
import { briefingCameraPadding, openStateBriefing } from '../state/deep-link';
import { showLocatedBoundary } from '../state/located-boundary';
import { clearEmphasis } from '../state/place-emphasis';
import { onPlaceSelectionChange, setPlaceSelection } from '../state/place-selection';
import {
  loadTribalRoster,
  loadTribalCensusAreas,
  gatedDisplayName,
  gatedCensusName
} from '../state/tribal-roster';
import { fetchBufferedWithBudget, fetchJsonWithBudget } from '../util/fetch';
import { isObject } from '../util/guards';
import { requestLayerOn } from './layer-toggle-command';
import { isCurrentBriefingIntent, nextBriefingIntent, openImpactPanel } from './impact-panel';
import { showToast } from './overlay';
import { Search } from './island/search';
import type { SearchItem } from './island/search';
// The same normalization the roster build and the search component use.
import { foldSearchText } from '../util/search-fold';

const LOCATE_TIMEOUT_MS = 12_000;

/** Places (states) and layers are available synchronously from the config tables. */
function buildSyncItems(
  permittedKinds: ReadonlySet<SearchItem['kind']> | null = null
): SearchItem[] {
  const items: SearchItem[] = [];
  if (!permittedKinds || permittedKinds.has('place')) {
    for (const [code, name] of Object.entries(STATE_LABEL) as Array<[StateCode, string]>) {
      items.push({ kind: 'place', id: code, label: name, haystack: foldSearchText(`${name} ${code}`) });
    }
  }
  if (!permittedKinds || permittedKinds.has('layer')) {
    for (const def of LAYER_DEFS) {
      // A ui-hidden layer (the deployer own-data slots, Unit I / D-0.7.0-038
      // part 3) is not a public-facing UI feature: no search result either.
      // The keys stay URL-reachable (?layers=tribal / ?layers=treaty).
      if (def.uiHidden) continue;
      items.push({
        kind: 'layer',
        id: def.key,
        label: def.name,
        sublabel: def.source,
        haystack: foldSearchText(
          `${def.name} ${def.source} ${(def.searchTerms ?? []).join(' ')}`
        )
      });
    }
  }
  return items;
}

let tribalCache: SearchItem[] | null = null;
let tribalInFlight: Promise<SearchItem[]> | null = null;

// shortcut: rank <= 4 keeps names unique (111 cities); a deeper cut needs a state field in us-places.json
const MAJOR_CITY_MAX_RANK = 4;
/** Coordinates of the major-city items, keyed by item id (the city name). */
const cityCoords = new Map<string, [number, number]>();

let cityCache: SearchItem[] | null = null;
let cityInFlight: Promise<SearchItem[]> | null = null;

/** Major cities from the shipped Natural Earth points (us-places.json). */
async function loadCityItems(): Promise<SearchItem[]> {
  const json = await fetchJsonWithBudget(URLS.usPlacesLocal, null, null, LOCATE_TIMEOUT_MS);
  const places = isObject(json) ? json['places'] : undefined;
  if (!Array.isArray(places)) throw new Error('City index payload has no places list');
  const items: SearchItem[] = [];
  const seen = new Set<string>();
  for (const p of places) {
    if (!isObject(p)) continue;
    const { name, lon, lat, rank } = p;
    if (typeof name !== 'string' || typeof lon !== 'number' || typeof lat !== 'number') continue;
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || typeof rank !== 'number') continue;
    if (rank > MAJOR_CITY_MAX_RANK || seen.has(name)) continue;
    seen.add(name);
    cityCoords.set(name, [lon, lat]);
    items.push({ kind: 'city', id: name, label: name, haystack: foldSearchText(name) });
  }
  return items;
}

/**
 * Lazy-load the major cities (once, cached on success). REJECTS on a failed
 * or malformed index so the component shows the city group as unavailable and
 * a later search retries; a failure is never cached as an empty result.
 */
function loadCities(): Promise<SearchItem[]> {
  if (cityCache) return Promise.resolve(cityCache);
  if (cityInFlight) return cityInFlight;
  cityInFlight = loadCityItems()
    .then((items) => (cityCache = items))
    .catch((err: unknown) => {
      console.warn('[search] City list load failed.', err);
      throw err instanceof Error ? err : new Error(String(err));
    })
    .finally(() => {
      cityInFlight = null;
    });
  return cityInFlight;
}

/**
 * Lazy-load the NAMES-ONLY Tribal land-area index (once, cached) from the
 * shared roster module (src/state/tribal-roster.ts, which owns the
 * D-0.7.0-026 structural provenance gate): the AIAN-LAR land areas, then the
 * Census areas for Tribes LAR cannot locate. REJECTS on a roster failure
 * (invariant 6: a failed load must surface as "unavailable", never masquerade
 * as an empty result); the component renders the honest unavailable line and
 * a later attempt can retry. Cities load separately (loadCities), so a slow or
 * failed city index never delays or drops the Tribal results.
 */
function loadTribal(): Promise<SearchItem[]> {
  if (tribalCache) return Promise.resolve(tribalCache);
  if (tribalInFlight) return tribalInFlight;
  tribalInFlight = (async () => {
    try {
      const [areas, census] = await Promise.all([loadTribalRoster(), loadTribalCensusAreas()]);
      const censusItems: SearchItem[] = census.map((a) => {
        const label = gatedCensusName(a);
        return {
          kind: 'tribal' as const,
          id: `census:${a.aiannh}`,
          label,
          ...(label !== a.name ? { sublabel: `Census area: ${a.name}` } : {}),
          // An OTSA is an Oklahoma Tribal Statistical Area: "of Oklahoma" finds it, never a same-named area elsewhere.
          haystack: foldSearchText(`${a.name} ${label}${a.name.endsWith(' OTSA') ? ' oklahoma' : ''}`)
        };
      });
      const items: SearchItem[] = areas.map((a) => {
        // DDM-P2-T10 / DR-094: the shared gate helper (src/state/tribal-roster.ts),
        // not an open-coded check, so this list and the place catalog's
        // Tribal Nations list gate identically.
        const label = gatedDisplayName(a);
        return {
          kind: 'tribal' as const,
          id: a.larName,
          label,
          haystack: foldSearchText(`${a.larName} ${label}`),
          // exactOptionalPropertyTypes: omit sublabel rather than set undefined.
          ...(label !== a.larName ? { sublabel: `Land area: ${a.larName}` } : {})
        };
      });
      tribalCache = [...items, ...censusItems];
      return tribalCache;
    } catch (err) {
      console.warn('[search] Tribal roster load failed.', err);
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      tribalInFlight = null;
    }
  })();
  return tribalInFlight;
}

/**
 * The master abort for the LARNAME locate (invariant 5): a newer locate
 * supersedes and CANCELS the prior in-flight request rather than only
 * dropping its late result.
 */
let locateAbort: AbortController | null = null;

// Every selection change supersedes an in-flight locate (invariant 5): the
// panel closing (selection to null) or a different briefing opening cancels
// the LARNAME request itself, not merely its late result. The locate's own
// completion also lands here, but only after its fetch has resolved, where
// the abort is a no-op.
onPlaceSelectionChange(() => {
  locateAbort?.abort();
  locateAbort = null;
});

/** One live boundary service a search selection can locate against. */
interface LocateSpec {
  readonly url: string;
  readonly kind: 'bia-reservation' | 'aiannh';
  readonly layerKey: 'bia-reservations' | 'aiannh';
  readonly failToast: string;
  readonly emptyToast: string;
  /** The row's gated label: a trusted formal Nation name is never abbreviated to the service's area name. */
  readonly title: string;
  /** The row's sublabel, the service's own area name, set only when the title differs from it. */
  readonly areaLabel?: string;
}
type LocateLabels = Pick<LocateSpec, 'title' | 'areaLabel'>;

/**
 * Locate a Tribal land area: one live boundary query (AIAN-LAR by LARNAME, or
 * Census AIANNH by code), frame the merged extent, light the located geometry,
 * turn on that service's layer for surrounding context, and open the briefing.
 * Carries the standard briefing intent guard so a newer user action wins any
 * race, plus a master abort so a superseded request is actively cancelled.
 * Failures surface honestly as a toast (invariant 6), never as a silent no-op.
 */
async function locateBoundary(map: maplibregl.Map, spec: LocateSpec): Promise<void> {
  const intent = nextBriefingIntent();
  locateAbort?.abort();
  const abort = new AbortController();
  locateAbort = abort;

  let fc: FeatureCollection;
  try {
    // cache: 'no-store': this response carries sovereign-boundary geometry,
    // so it must never persist in the browser HTTP cache (hard rule 1;
    // the same transport guard as the three live Tribal-geography layers).
    const res = await fetchBufferedWithBudget(spec.url, { cache: 'no-store' }, abort.signal, LOCATE_TIMEOUT_MS);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const json: unknown = await res.json();
    // An ArcGIS host can answer HTTP 200 with an error envelope: unavailable, not empty.
    if (isObject(json) && 'error' in json) throw new Error('ArcGIS error envelope');
    fc = json as FeatureCollection;
  } catch (err) {
    console.warn('[search] Tribal land area locate failed.', err);
    // A deliberate supersede is not an error to report; anything else is
    // surfaced honestly (the service failed, no result will appear).
    if (!abort.signal.aborted && isCurrentBriefingIntent(intent)) {
      showToast(spec.failToast);
    }
    return;
  }

  const features = fc.features ?? [];
  if (features.length === 0) {
    if (isCurrentBriefingIntent(intent)) {
      showToast(spec.emptyToast);
    }
    return;
  }
  if (!isCurrentBriefingIntent(intent)) return;

  // Use the aggregate geometry for both camera and context provenance. This
  // retains a compact Aleutian extent and lets the context's crossing evidence
  // describe the same subject the camera frames.
  const aggregateGeometry =
    mergeArealGeometry(features) ?? features[0]?.geometry ?? null;
  const bbox = geometryBboxAcrossAntimeridian(aggregateGeometry);
  if (bbox) {
    const continuous = bboxToContinuousBounds(bbox);
    map.fitBounds(
      [
        [continuous[0], continuous[1]],
        [continuous[2], continuous[3]]
      ],
      // The pick opens its briefing on every shell, so the fit keeps the band
      // it covers clear: the drawer's side on a desktop or tablet, the bottom
      // sheet or its side drawer on a phone (the shared rule every briefing fit uses).
      { padding: briefingCameraPadding(true) }
    );
  }

  // Surrounding areas for context; the located highlight guarantees THIS
  // land area reads regardless of the layer's clipped viewport.
  requestLayerOn(spec.layerKey);

  const primary = features[0]!;
  // Dynamic import: point-in-polygon is briefing-cluster code the activation
  // gate keeps out of the eager bundle. A failed chunk load falls back to the
  // box centre so the search still selects the land area.
  const lngLat = bbox
    ? await import('../util/point-in-polygon').then(
        (m) => m.representativePoint(aggregateGeometry, bbox),
        () => bboxCenter(bbox)
      )
    : { lng: 0, lat: 0 };
  // A newer selection during the lazy import wins: commit nothing stale.
  if (abort.signal.aborted || !isCurrentBriefingIntent(intent)) return;
  // ORDER MATTERS: the located-boundary highlight records the selection
  // current when it is shown and clears on a close or a different subject
  // (the stage-5 major 4 fix), so the selection is set first and the
  // highlight for THIS subject renders after; any prior subject's is gone. A
  // search pick asks for the place, so its briefing opens on every shell
  // (owner 2026-11-13), as Locate and the Place studio do; a map click keeps
  // summary-first (D-0.7.0-070) in the interaction coordinator.
  const rawContext = buildBoundaryContext(
    spec.kind,
    primary.properties ?? null,
    aggregateGeometry,
    lngLat,
    spec.title
  );
  const context = {
    ...(bbox ? { ...rawContext, bbox, pointInsidePlace: true } : rawContext),
    ...(spec.areaLabel ? { areaLabel: spec.areaLabel } : {})
  };
  setPlaceSelection({ label: context.title, context });
  openImpactPanel(context);
  // The located overlay marks this subject; a place an earlier click lit is unlit.
  clearEmphasis(map);
  showLocatedBoundary(map, aggregateGeometry);
}

/** Locate an AIAN-LAR land area by LARNAME (SQL-escaped). */
function locateTribalLandArea(map: maplibregl.Map, larName: string, labels: LocateLabels): Promise<void> {
  const params = new URLSearchParams({
    where: `LARNAME='${escapeSql(larName)}'`,
    outFields: 'LARID,LARNAME,CLASSIFICATION,GISACRES,REGION',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson'
  });
  return locateBoundary(map, {
    url: `${URLS.biaLarFeatureServer}/query?${params.toString()}`,
    kind: 'bia-reservation',
    layerKey: 'bia-reservations',
    failToast: 'Could not reach the BIA Land Area Representation (AIAN-LAR) service. Try again in a moment.',
    emptyToast: 'The BIA Land Area Representation (AIAN-LAR) service returned no boundary for this land area.',
    ...labels
  });
}

/** Locate a Census AIANNH area by its four-digit code (layer 47, the live aiannh layer's). */
function locateCensusArea(map: maplibregl.Map, code: string, labels: LocateLabels): Promise<void> {
  if (!/^\d{4}$/.test(code)) return Promise.resolve();
  const params = new URLSearchParams({
    where: `AIANNH='${code}'`,
    outFields: 'NAME,AIANNHCC,MTFCC,BASENAME,AIANNHNS,AREALAND,AREAWATER',
    returnGeometry: 'true',
    outSR: '4326',
    geometryPrecision: '5',
    maxAllowableOffset: '0.002',
    f: 'geojson'
  });
  return locateBoundary(map, {
    url: `${URLS.censusAiannhMapServer}/47/query?${params.toString()}`,
    kind: 'aiannh',
    layerKey: 'aiannh',
    failToast: 'Could not reach the Census Tribal area service. Try again in a moment.',
    emptyToast: 'The Census service returned no boundary for this area.',
    ...labels
  });
}

/**
 * A city's briefing is its State's: the State that holds the city's point
 * (the shared resolver, rendered states layer first, then the bundled Census
 * outlines) opens with its own header, and the camera stays on the city
 * (fit: false). A point no State holds opens nothing; a newer choice wins.
 */
async function openContainingStateBriefing(
  map: maplibregl.Map,
  [lng, lat]: [number, number],
  intent: number
): Promise<void> {
  const abort = new AbortController();
  locateAbort = abort;
  try {
    // Briefing-cluster code, kept out of the eager bundle as the Tribal path keeps point-in-polygon.
    const { resolveContainingState } = await import('../state/location-identity');
    if (abort.signal.aborted || !isCurrentBriefingIntent(intent)) return;
    const state = await resolveContainingState(map, { lng, lat }, abort.signal);
    if (!state || abort.signal.aborted || !isCurrentBriefingIntent(intent)) return;
    await openStateBriefing(map, state.code, { fit: false, guard: () => isCurrentBriefingIntent(intent) });
  } catch (err) {
    // A newer pick aborted this lookup on purpose: nothing failed. Any other failure is shown, never silent (invariant 6).
    if (abort.signal.aborted || !isCurrentBriefingIntent(intent)) return;
    console.warn('[search] City State lookup failed.', err);
    showToast("Could not open the briefing for this city's State. Try again in a moment.");
  }
}

/** Route a chosen search result to its action. */
function selectResult(map: maplibregl.Map, item: SearchItem): void {
  if (item.kind === 'layer') {
    requestLayerOn(item.id);
    return;
  }
  if (item.kind === 'place') {
    const intent = nextBriefingIntent();
    // The place briefing sets its selection only after its own fetch, so the
    // subscription above would fire too late; supersede the locate NOW.
    locateAbort?.abort();
    locateAbort = null;
    // A search pick opens the State's briefing on every shell (owner 2026-11-13).
    void openStateBriefing(map, item.id, {
      fit: true,
      guard: () => isCurrentBriefingIntent(intent)
    });
    return;
  }
  if (item.kind === 'city') {
    // A city moves the camera and opens its State's briefing; no layer change, so the mode stays as it is.
    const intent = nextBriefingIntent();
    locateAbort?.abort();
    locateAbort = null;
    // The earlier place no longer describes the view; a city has no outline of its own, so none is set yet.
    setPlaceSelection(null);
    const center = cityCoords.get(item.id);
    if (center) {
      // The State's briefing opens beside it, so the city lands in the part of the map the briefing leaves clear
      // (the centre of the padded view; `offset` shifts this move only, unlike a persistent `padding`).
      const pad = briefingCameraPadding(true);
      map.easeTo({
        center,
        zoom: Math.max(map.getZoom(), 8),
        offset: [((pad.left ?? 0) - (pad.right ?? 0)) / 2, ((pad.top ?? 0) - (pad.bottom ?? 0)) / 2]
      });
      // Every search host passes here; the sidebar's region menu listens (it is not imported into this chunk).
      window.dispatchEvent(new Event('ddm:city-view'));
      void openContainingStateBriefing(map, center, intent);
    }
    return;
  }
  // The row's gated label titles the selection (a formal Nation name is never abbreviated).
  const labels = { title: item.label, ...(item.sublabel ? { areaLabel: item.sublabel } : {}) };
  if (item.id.startsWith('census:')) {
    void locateCensusArea(map, item.id.slice('census:'.length), labels);
    return;
  }
  void locateTribalLandArea(map, item.id, labels);
}

/** The props the search component needs, assembled and routed for a map. */
export interface SearchWiring {
  items: SearchItem[];
  loadTribal?: () => Promise<SearchItem[]>;
  loadCities?: () => Promise<SearchItem[]>;
  onSelect: (item: SearchItem) => void;
  placeholder: string;
}

export interface SearchWiringOptions {
  readonly permittedKinds: readonly SearchItem['kind'][];
  readonly placeholder: string;
}

/** Build search wiring bound to a map, optionally scoped for a specialized host. */
export function buildSearchWiring(
  map: maplibregl.Map,
  options?: SearchWiringOptions
): SearchWiring {
  const permittedKinds = options ? new Set(options.permittedKinds) : null;
  const permitsTribal = permittedKinds?.has('tribal') ?? true;
  const permitsCity = permittedKinds?.has('city') ?? true;
  return {
    items: buildSyncItems(permittedKinds),
    ...(permitsTribal ? { loadTribal } : {}),
    ...(permitsCity ? { loadCities } : {}),
    onSelect: (item) => {
      if (!permittedKinds || permittedKinds.has(item.kind)) selectResult(map, item);
    },
    placeholder: options?.placeholder ?? 'Search Tribes, states, cities, and layers'
  };
}

/**
 * Render the search into a container (the Brief head, the mobile sheet at-hand
 * block). The console catalog mounts it through the island itself; these other
 * hosts call here. Same component, same wiring, one search experience.
 */
export function mountSearchInto(map: maplibregl.Map, container: HTMLElement): void {
  render(h(Search, buildSearchWiring(map)), container);
}
