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
import { fetchWithBudget } from '../util/fetch';
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
}

interface PlacesBundle {
  readonly meta?: { readonly count?: number };
  readonly places?: readonly PlaceRow[];
}

let masterController: AbortController | null = null;

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
    const response = await fetchWithBudget(URLS.usPlacesLocal, null, signal, FETCH_TIMEOUT_MS);
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
      properties: { name: p.name, rank: p.rank }
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
 * A tap or click on a place label opens a small popup carrying the
 * OFFICIAL name as real DOM text (D-0.7.0-030 condition 5, tightened by
 * the stage-5 adversarial major 3: the hover inspector is pointer-only
 * and aria-hidden, so it is not an accessible surface). The popup gives
 * touch and pointer users, and a screen reader once the popup is open, a
 * semantic rendering of the okina and macron forms. Full keyboard
 * reachability of canvas features is the 0.9.0 Section 508 audit's scope
 * (TODO), recorded rather than half-solved here.
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
      const el = document.createElement('div');
      el.className = 'place-name-popup';
      el.textContent = name;
      return {
        content: el,
        popupOptions: { closeButton: false, offset: 10 }
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
