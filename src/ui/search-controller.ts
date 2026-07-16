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
 * Three result kinds:
 *   - place  a state; opens its drought briefing (openStateBriefing).
 *   - layer  a catalog layer; turns it on through the shared toggle command
 *            (which co-activates the wildfire pair, syncs the checkbox, and
 *            respects surface exclusivity, exactly like a catalog toggle).
 *   - tribal a Tribal land area (LARNAME); locates it live, frames it, lights
 *            it, and opens its briefing (locateTribalLandArea).
 *
 * Stewardship: the roster it searches is NAMES ONLY (public/data/tribal-roster
 * .json). Locations come from a LIVE AIAN-LAR query at selection time, never a
 * bundled polygon (hard rule 1). The briefing carries the representation caveat
 * through buildBoundaryContext, as a map click would.
 */

import { h, render } from 'preact';
import type maplibregl from 'maplibre-gl';
import type { Feature, FeatureCollection, Geometry } from 'geojson';

import { LAYER_DEFS } from '../config/layers';
import { URLS } from '../config/urls';
import { STATE_LABEL } from '../impact/resources';
import type { StateCode } from '../impact/resources';
import { buildBoundaryContext, geometryBbox } from '../impact/context';
import { openStateBriefing } from '../state/deep-link';
import { showLocatedBoundary } from '../state/located-boundary';
import { onPlaceSelectionChange } from '../state/place-selection';
import { fetchWithBudget } from '../util/fetch';
import { requestLayerOn } from './layer-toggle-command';
import { isCurrentBriefingIntent, nextBriefingIntent, openImpactPanel } from './impact-panel';
import { showToast } from './overlay';
import { Search } from './island/search';
import type { SearchItem } from './island/search';

const ROSTER_URL = import.meta.env.BASE_URL + 'data/tribal-roster.json';
const LOCATE_TIMEOUT_MS = 12_000;

/** The same normalization the roster build and the search component use. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Places (states) and layers are available synchronously from the config tables. */
function buildSyncItems(): SearchItem[] {
  const items: SearchItem[] = [];
  for (const [code, name] of Object.entries(STATE_LABEL) as Array<[StateCode, string]>) {
    items.push({ kind: 'place', id: code, label: name, haystack: norm(`${name} ${code}`) });
  }
  for (const def of LAYER_DEFS) {
    items.push({
      kind: 'layer',
      id: def.key,
      label: def.name,
      sublabel: def.source,
      haystack: norm(`${def.name} ${def.source}`)
    });
  }
  return items;
}

let tribalCache: SearchItem[] | null = null;
let tribalInFlight: Promise<SearchItem[]> | null = null;

/**
 * The STRUCTURAL provenance gate (D-0.7.0-026): a Tribal Nation name may
 * render ONLY from a roster row whose provenance is one of these values.
 * Any other row (including a row from an older or hand-edited roster with
 * no provenance field at all) renders the BIA land-area label verbatim.
 */
const TRUSTED_PROVENANCE = new Set(['bia-authoritative', 'safe-match']);

/**
 * Lazy-load the NAMES-ONLY Tribal land-area index (once, cached). REJECTS on
 * failure (invariant 6: a failed load must surface as "unavailable", never
 * masquerade as an empty result); the component renders the honest
 * unavailable line and a later attempt can retry.
 */
function loadTribal(): Promise<SearchItem[]> {
  if (tribalCache) return Promise.resolve(tribalCache);
  if (tribalInFlight) return tribalInFlight;
  tribalInFlight = (async () => {
    try {
      const res = await fetch(ROSTER_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as {
        areas?: Array<{ larName: string; displayName: string; provenance?: string }>;
      };
      const items: SearchItem[] = (json.areas ?? []).map((a) => {
        const trusted = TRUSTED_PROVENANCE.has(a.provenance ?? '');
        const label = trusted ? a.displayName : a.larName;
        return {
          kind: 'tribal' as const,
          id: a.larName,
          label,
          haystack: norm(`${a.larName} ${label}`),
          // exactOptionalPropertyTypes: omit sublabel rather than set undefined.
          ...(label !== a.larName ? { sublabel: `Land area: ${a.larName}` } : {})
        };
      });
      tribalCache = items;
      return items;
    } catch (err) {
      console.warn('[search] Tribal roster load failed.', err);
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      tribalInFlight = null;
    }
  })();
  return tribalInFlight;
}

/** Merge many features' Polygon / MultiPolygon rings into one MultiPolygon. */
function combineGeometry(features: readonly Feature[]): Geometry | null {
  const polys: number[][][][] = [];
  for (const f of features) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === 'Polygon') polys.push(g.coordinates as number[][][]);
    else if (g.type === 'MultiPolygon') polys.push(...(g.coordinates as number[][][][]));
  }
  if (polys.length === 0) return null;
  return { type: 'MultiPolygon', coordinates: polys };
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

/**
 * Locate a Tribal land area by LARNAME: one live AIAN-LAR query (SQL-escaped),
 * frame the merged extent, light the located geometry, turn on the BIA layer for
 * surrounding context, and open the briefing. Carries the standard briefing
 * intent guard so a newer user action wins any race, plus a master abort so a
 * superseded request is actively cancelled. Failures surface honestly as a
 * toast (invariant 6), never as a silent no-op.
 */
async function locateTribalLandArea(map: maplibregl.Map, larName: string): Promise<void> {
  const intent = nextBriefingIntent();
  locateAbort?.abort();
  const abort = new AbortController();
  locateAbort = abort;
  const escaped = larName.replace(/'/g, "''");
  const params = new URLSearchParams({
    where: `LARNAME='${escaped}'`,
    outFields: 'LARID,LARNAME,CLASSIFICATION,GISACRES,REGION',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson'
  });
  const url = `${URLS.biaLarFeatureServer}/query?${params.toString()}`;

  let fc: FeatureCollection;
  try {
    // cache: 'no-store': this response carries sovereign-boundary geometry,
    // so it must never persist in the browser HTTP cache (hard rule 1;
    // the same transport guard as the three live Tribal-geography layers).
    const res = await fetchWithBudget(url, { cache: 'no-store' }, abort.signal, LOCATE_TIMEOUT_MS);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    fc = (await res.json()) as FeatureCollection;
  } catch (err) {
    console.warn('[search] LARNAME locate failed.', err);
    // A deliberate supersede is not an error to report; anything else is
    // surfaced honestly (the BIA service failed, no result will appear).
    if (!abort.signal.aborted && isCurrentBriefingIntent(intent)) {
      showToast('Could not reach the BIA land area service. Try again in a moment.');
    }
    return;
  }

  const features = fc.features ?? [];
  if (features.length === 0) {
    if (isCurrentBriefingIntent(intent)) {
      showToast('The BIA land area service returned no boundary for this land area.');
    }
    return;
  }
  if (!isCurrentBriefingIntent(intent)) return;

  let bbox: [number, number, number, number] | null = null;
  for (const f of features) {
    const b = geometryBbox(f.geometry);
    if (!b) continue;
    bbox = bbox
      ? [Math.min(bbox[0], b[0]), Math.min(bbox[1], b[1]), Math.max(bbox[2], b[2]), Math.max(bbox[3], b[3])]
      : b;
  }
  if (bbox) {
    map.fitBounds(
      [
        [bbox[0], bbox[1]],
        [bbox[2], bbox[3]]
      ],
      { padding: 60 }
    );
  }

  // Surrounding reservations for context; the located highlight guarantees THIS
  // land area reads regardless of the BIA layer's clipped viewport.
  requestLayerOn('bia-reservations');

  const primary = features[0];
  const lngLat = bbox
    ? { lng: (bbox[0] + bbox[2]) / 2, lat: (bbox[1] + bbox[3]) / 2 }
    : { lng: 0, lat: 0 };
  // ORDER MATTERS: the briefing open replaces the place selection, and the
  // located-boundary module clears its highlight on EVERY selection change
  // (the stage-5 major 4 fix), so the panel opens first and the highlight for
  // THIS subject renders after; any prior subject's highlight is gone.
  openImpactPanel(buildBoundaryContext('bia-reservation', primary.properties ?? null, primary.geometry, lngLat));
  showLocatedBoundary(map, combineGeometry(features) ?? features[0].geometry);
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
    void openStateBriefing(map, item.id, { fit: true, guard: () => isCurrentBriefingIntent(intent) });
    return;
  }
  void locateTribalLandArea(map, item.id);
}

/** The props the search component needs, assembled and routed for a map. */
export interface SearchWiring {
  items: SearchItem[];
  loadTribal: () => Promise<SearchItem[]>;
  onSelect: (item: SearchItem) => void;
  placeholder: string;
}

/** Build the search wiring bound to a map. One brain, shared by every host. */
export function buildSearchWiring(map: maplibregl.Map): SearchWiring {
  return {
    items: buildSyncItems(),
    loadTribal,
    onSelect: (item) => selectResult(map, item),
    placeholder: 'Search places, Tribal land areas, and layers'
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
