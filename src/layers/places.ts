/**
 * Municipal place labels (U4e, 0.7.0).
 *
 * A symbol layer over the small bundled Natural Earth place-point source
 * (public/data/us-places.json, built by scripts/build-places.mjs with the
 * build-failing glyph gate). The raster basemap's baked-in labels cannot be
 * toggled, so this bundled layer is the only honest municipal-labels
 * delivery: OFF by default, one checkbox, no third-party request.
 *
 * Density: Natural Earth's SCALERANK rides each point as `rank`; the layer
 * filter steps the admitted rank by zoom so national framings show only
 * the anchor cities and closer zooms admit progressively smaller towns
 * (the cartography-lens requirement that low zooms never place every small
 * town against the USDM outlines or the hover inspector).
 *
 * Legibility: dark slate text with a light halo (palette.ts tokens), the
 * combination that reads over BOTH the desaturated default basemap and the
 * future satellite option (the corpus both-basemaps rule). Glyphs are the
 * self-hosted Noto Sans Regular ranges (U0a); the build gate guarantees
 * every bundled name renders from the ranges that ship.
 *
 * Cancellation: the standard master-abort pattern (invariant 5), matching
 * states.ts.
 */

import type * as maplibregl from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';

import { URLS } from '../config/urls';
import { PLACE_LABEL_COLOR, PLACE_LABEL_HALO } from '../config/palette';
import { registerClickTarget } from '../map/interaction-coordinator';
import type { IssuedModel, PopupClock } from '../ui/popup-frame';
import { fetchBufferedWithBudget } from '../util/fetch';
import { registry } from '../state/registry';

const LAYER_KEY = 'places';
const SOURCE_ID = 'us-places';
const LABEL_LAYER_ID = 'us-places-labels';

/** Fade targets for the sidebar's toggle transitions (LayerModule contract). */
export const fadeLayerIds = [LABEL_LAYER_ID] as const;

/** Per-call budget for the bundled-file fetch (same-origin, normally fast). */
const FETCH_TIMEOUT_MS = 10_000;

type Status = 'loading' | 'ready' | 'error' | 'no-data';

interface PlaceRow {
  readonly name: string;
  readonly lon: number;
  readonly lat: number;
  readonly rank: number;
  /**
   * The GNIS feature id of a row the build renamed to its GNIS/BGN official
   * form (D-0.7.0-030, scripts/build-places.mjs:17-24); absent on a row that
   * keeps its Natural Earth spelling.
   */
  readonly gnis?: string;
}

/**
 * The name form's source for a renamed row, in the crosswalk's own words
 * (scripts/data/hi-gnis-crosswalk.json `_source`, the file the bundle's
 * `meta.naming` names). Natural Earth does not publish these forms, so the
 * popup never credits them to Natural Earth alone (plan_rules 3).
 */
const GNIS_NAME_SOURCE = 'USGS Geographic Names Information System (GNIS), Board on Geographic Names official forms';

interface PlacesBundle {
  readonly meta?: { readonly count?: number; readonly retrieved?: unknown };
  readonly places?: readonly PlaceRow[];
}

let masterController: AbortController | null = null;

/**
 * The date the bundle's builder retrieved the Natural Earth points
 * (`meta.retrieved`, scripts/build-places.mjs), as a UTC `YYYY-MM-DD`, or
 * null when the bundle records none. Read at activation.
 */
let bundleRetrieved: string | null = null;

function reportStatus(state: Status): void {
  registry.setStatus(LAYER_KEY, state);
}

/**
 * Fetch the bundled place points and add the source and the symbol layer.
 * Idempotent: if the source already exists the call is a no-op. Labels sit
 * on top of every layer (no beforeId): a label the user explicitly turned
 * on must not hide under a thematic surface.
 */
export async function activate(map: maplibregl.Map): Promise<void> {
  if (map.getSource(SOURCE_ID)) {
    return;
  }

  if (masterController) masterController.abort();
  masterController = new AbortController();
  const signal = masterController.signal;

  reportStatus('loading');

  let bundle: PlacesBundle;
  try {
    const response = await fetchBufferedWithBudget(URLS.usPlacesLocal, null, signal, FETCH_TIMEOUT_MS);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    bundle = (await response.json()) as PlacesBundle;
  } catch (err) {
    if (signal.aborted) return;
    console.warn('[places] bundled place labels failed to load.', err);
    reportStatus('error');
    return;
  }
  if (signal.aborted) return;

  const retrieved = bundle.meta?.retrieved;
  const ymd = typeof retrieved === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(retrieved) : null;
  bundleRetrieved =
    ymd !== null && Number(ymd[2]) >= 1 && Number(ymd[2]) <= 12 && Number(ymd[3]) >= 1 && Number(ymd[3]) <= 31 ? ymd[0] : null;

  const rows = bundle.places ?? [];
  if (rows.length === 0) {
    reportStatus('no-data');
    return;
  }

  const fc: FeatureCollection = {
    type: 'FeatureCollection',
    features: rows.map((p) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      // `gnis` rides only on a renamed row, so the popup can name the name
      // form's own source.
      properties: typeof p.gnis === 'string' && p.gnis !== '' ? { name: p.name, rank: p.rank, gnis: p.gnis } : { name: p.name, rank: p.rank }
    }))
  };

  if (map.getSource(SOURCE_ID)) return;
  map.addSource(SOURCE_ID, { type: 'geojson', data: fc });

  map.addLayer({
    id: LABEL_LAYER_ID,
    type: 'symbol',
    source: SOURCE_ID,
    // Zoom-stepped density on Natural Earth SCALERANK: anchors only at the
    // whole-US framing, smaller towns admitted as the view closes in.
    filter: ['<=', ['get', 'rank'], ['step', ['zoom'], 2, 5, 4, 7, 6, 9, 30]],
    layout: {
      'text-field': ['get', 'name'],
      // The one bundled fontstack (public/fonts/glyphs/); the build gate in
      // scripts/build-places.mjs guarantees range coverage.
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 3, 10.5, 8, 13.5],
      'text-padding': 6,
      'text-max-width': 8
    },
    paint: {
      'text-color': PLACE_LABEL_COLOR,
      // The halo carries the both-basemaps contrast (the corpus rule).
      'text-halo-color': PLACE_LABEL_HALO,
      'text-halo-width': 1.4
    }
  });

  reportStatus('ready');
}

/**
 * Abort any in-flight fetch and remove the layer and source. Defensive
 * guards so callers can invoke `deactivate` without checking state first.
 */
export function deactivate(map: maplibregl.Map): void {
  if (masterController) {
    masterController.abort();
    masterController = null;
  }
  if (map.getLayer(LABEL_LAYER_ID)) map.removeLayer(LABEL_LAYER_ID);
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
}

/**
 * The place label's popup model (S30D D1 M26a; DDM-P11-T04;
 * interface-chrome-popups-text.md 3.5 row 19): the name as bundled, the
 * label's issuer, "Populated place", the bundle's retrieval date (the
 * bundle names no Natural Earth edition) and the Natural Earth source. A name
 * label is not a claim, so the body carries nothing more (LATER.md:124 keeps
 * retiring this popup for later), except for a row the build renamed to its
 * GNIS/BGN official form (`gnis`, its GNIS feature id; the shipped bundle
 * has two, Līhuʻe and Wahiawā): Natural Earth does not publish that form, so
 * one body row names the form's own source, distinct from the point's issuer
 * (plan_rules 3; the block 4 review, R4-1).
 */
export function buildPlaceLabelModel(name: string, retrieved: string | null, gnis: string | null): IssuedModel {
  const clock: PopupClock =
    retrieved === null
      ? { kind: 'not-stated', label: 'Retrieved on', reason: 'not recorded' }
      : { kind: 'point', meaning: 'retrieved', label: 'Retrieved on', at: { precision: 'date', date: retrieved } };
  return {
    kind: 'label',
    title: name,
    issuer: { role: 'issued-by', name: 'Natural Earth (populated places)', productKey: 'places' },
    value: [{ text: 'Populated place' }],
    clocks: [clock],
    details:
      gnis === null
        ? []
        : [
            // DRAFT wording (DR-177): M26a name-source label pending owner read.
            { kind: 'row', label: 'Name from', text: GNIS_NAME_SOURCE }
          ],
    source: {
      link: { label: 'Natural Earth', href: 'https://www.naturalearthdata.com/downloads/10m-cultural-vectors/10m-populated-places/' }
    }
  };
}

/**
 * A tap or click on a place label opens a small popup carrying the
 * OFFICIAL name as real DOM text (D-0.7.0-030 condition 5, tightened by
 * the stage-5 adversarial major 3: the hover inspector is pointer-only
 * and aria-hidden, so it is not an accessible surface). The popup gives
 * touch and pointer users, and a screen reader once the popup is open, a
 * semantic rendering of the okina and macron forms (the frame writes the
 * title as escaped text). Full keyboard reachability of canvas features is
 * the 0.9.0 Section 508 audit's scope (TODO), recorded rather than
 * half-solved here.
 */
export function bindPopups(map: maplibregl.Map): void {
  registerClickTarget({
    kind: 'point-event',
    layerIds: [LABEL_LAYER_ID],
    // An unnamed label offers nothing; a null label skips the hit in
    // arbitration entirely (the old handler's early return).
    label: (feature) => {
      const name = feature.properties?.['name'];
      return typeof name === 'string' && name.trim() !== '' ? name : null;
    },
    respond: (feature) => {
      const name = feature.properties?.['name'];
      if (typeof name !== 'string' || name.trim() === '') return null;
      const gnis = feature.properties?.['gnis'];
      // The coordinator forces its own close control (D1 M23 C1).
      return {
        model: buildPlaceLabelModel(name, bundleRetrieved, typeof gnis === 'string' && gnis !== '' ? gnis : null),
        popupOptions: { offset: 10 }
      };
    }
  });
  map.on('mouseenter', LABEL_LAYER_ID, () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', LABEL_LAYER_ID, () => {
    map.getCanvas().style.cursor = '';
  });
}
