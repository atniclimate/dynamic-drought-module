/**
 * United States state-boundary layer (E1, national framing).
 *
 * Renders the bundled Census Bureau cartographic boundary file
 * (public/data/us-states.geojson, baked by scripts/build-states.mjs at
 * 1:20,000,000 generalization) as a quiet slate outline with a fully
 * transparent fill that serves as the click target. States are the fourth
 * selectable space alongside the Tribal, Treaty / BIA, and ecoregion
 * boundaries: clicking a state opens the impact briefing with the resource
 * routing resolved to that state.
 *
 * Stewardship: state boundaries are public administrative reference data, not
 * sovereign-jurisdiction polygons, so bundling them is consistent with
 * CLAUDE.md hard rule 1. A state selection never carries the representation
 * caveat and never displaces a Tribal selection; the stewardship-ordered
 * resource list (Tribe's-own slot first) applies to every briefing.
 *
 * Cancellation (CLAUDE.md section 6 invariant 5): the bundled-file fetch goes
 * through `fetchWithBudget` with a per-call timeout and a master abort signal
 * that fires on `deactivate` or a superseding `activate`, matching the
 * hardened usdm / nifc-fires / bia-reservations pattern.
 */

import maplibregl from 'maplibre-gl';
import type { FeatureCollection, GeoJsonProperties } from 'geojson';

import { URLS } from '../config/urls';
import { STATE_OUTLINE_COLOR } from '../config/palette';
import { buildStatePopupHtml } from '../ui/popups';
import { attachImpactTrigger } from '../ui/impact-panel';
import { buildBoundaryContext } from '../impact/context';
import { emphasizePlace } from '../state/place-emphasis';
import { fetchWithBudget } from '../util/fetch';
import { registry } from '../state/registry';

const LAYER_KEY = 'states';
const SOURCE_ID = 'us-states';
const FILL_LAYER_ID = 'us-states-fill';
const OUTLINE_LAYER_ID = 'us-states-outline';

/** Fade targets for the sidebar's toggle transitions (LayerModule contract). */
export const fadeLayerIds = [FILL_LAYER_ID, OUTLINE_LAYER_ID] as const;

/**
 * Symbol layer ID used as the `beforeId` anchor so the boundary stacks below
 * the basemap label glyphs, matching every other reference-polygon module.
 */
const BEFORE_ID = 'first-symbol';

/** Per-call budget for the bundled-file fetch (same-origin, normally fast). */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * E1 chrome targets (D-0.7.0-041 part 2, review E1.3): starting values for
 * the stewardship visual review at unit close. A 0.4 px hairline at roughly
 * 0.50 opacity at the national framing, easing to the regional weight by
 * zoom 8; the selected boosts stay constant so the chosen reference frame
 * reads at any zoom.
 */
const OUTLINE_WIDTH_NATIONAL = 0.4;
const OUTLINE_WIDTH_REGIONAL = 1.5;
const OUTLINE_WIDTH_SELECTED = 2.4;
const OUTLINE_OPACITY_NATIONAL = 0.5;
const OUTLINE_OPACITY_REGIONAL = 0.7;

type Status = 'loading' | 'ready' | 'error' | 'no-data';

/**
 * Master cancellation controller for the in-flight fetch. Aborted on
 * `deactivate` and replaced on each `activate` so a superseded request can
 * never render into a torn-down layer.
 */
let masterController: AbortController | null = null;

function reportStatus(state: Status): void {
  registry.setStatus(LAYER_KEY, state);
}

function resolveBeforeId(map: maplibregl.Map): string | undefined {
  return map.getLayer(BEFORE_ID) ? BEFORE_ID : undefined;
}

/**
 * Fetch the bundled state boundaries and add the source, the transparent hit
 * fill, and the outline. Idempotent: if the source already exists the call is
 * a no-op. A missing or malformed bundle surfaces as `'error'` (the artifact
 * is committed; its absence is a deployment defect, unlike the deliberately
 * empty placeholder files).
 */
export async function activate(map: maplibregl.Map): Promise<void> {
  if (map.getSource(SOURCE_ID)) {
    return;
  }

  // Supersede any prior in-flight fetch before starting a new one.
  if (masterController) masterController.abort();
  masterController = new AbortController();
  const signal = masterController.signal;

  reportStatus('loading');

  let geojson: FeatureCollection;
  try {
    const response = await fetchWithBudget(
      URLS.usStatesLocal,
      null,
      signal,
      FETCH_TIMEOUT_MS
    );
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    geojson = (await response.json()) as FeatureCollection;
  } catch (err) {
    // Aborted means superseded or deactivated; drop silently per invariant 5.
    if (signal.aborted) return;
    console.warn('[states] bundled state boundaries fetch failed.', err);
    reportStatus('error');
    return;
  }

  // A late response to a torn-down activation must not render.
  if (signal.aborted) return;

  const features = geojson?.features ?? [];

  map.addSource(SOURCE_ID, {
    type: 'geojson',
    data: geojson,
    attribution: 'US Census Bureau',
    // Stable per-feature ids for the selected-place emphasis (U3h).
    generateId: true
  });

  if (features.length === 0) {
    reportStatus('no-data');
    return;
  }

  const beforeId = resolveBeforeId(map);

  // Transparent hit area: MapLibre hit-tests fill layers regardless of paint
  // opacity, so this carries the click-to-briefing affordance without adding
  // any visual weight over the thematic layers.
  map.addLayer(
    {
      id: FILL_LAYER_ID,
      type: 'fill',
      source: SOURCE_ID,
      paint: {
        // Transparent hit area by default; the selected state (U3h) takes a
        // faint slate tint so the chosen reference frame reads under an open
        // briefing without competing with the thematic surface.
        'fill-color': STATE_OUTLINE_COLOR,
        'fill-opacity': [
          'case',
          ['boolean', ['feature-state', 'selected'], false],
          0.08,
          0
        ]
      }
    },
    beforeId
  );

  map.addLayer(
    {
      id: OUTLINE_LAYER_ID,
      type: 'line',
      source: SOURCE_ID,
      paint: {
        'line-color': STATE_OUTLINE_COLOR,
        // U4c chrome weights (headroom A5): with states default-on, the
        // outline must stay a quiet reference frame at EVERY zoom: hairline
        // at the whole-US framing, a touch heavier once a region fills the
        // view. The selected boost stays a constant that reads against the
        // interpolated base at any zoom. STRUCTURE MATTERS: MapLibre only
        // accepts ["zoom"] as input to a TOP-LEVEL step/interpolate, so the
        // zoom curve wraps the feature-state case, not the other way around
        // (the inverted form validates but logs a style error and falls
        // back to the default width; caught by the 2026-07-12 console
        // inspection).
        'line-width': [
          'interpolate',
          ['linear'],
          ['zoom'],
          3,
          [
            'case',
            ['boolean', ['feature-state', 'selected'], false],
            OUTLINE_WIDTH_SELECTED,
            OUTLINE_WIDTH_NATIONAL
          ],
          8,
          [
            'case',
            ['boolean', ['feature-state', 'selected'], false],
            OUTLINE_WIDTH_SELECTED,
            OUTLINE_WIDTH_REGIONAL
          ]
        ],
        // Same zoom-curve-wraps-the-case structure as the width above (the
        // inverted form logs a style error; see the width comment). E1 quiets
        // the hairline to roughly half strength at the national framing.
        'line-opacity': [
          'interpolate',
          ['linear'],
          ['zoom'],
          3,
          [
            'case',
            ['boolean', ['feature-state', 'selected'], false],
            1,
            OUTLINE_OPACITY_NATIONAL
          ],
          8,
          [
            'case',
            ['boolean', ['feature-state', 'selected'], false],
            1,
            OUTLINE_OPACITY_REGIONAL
          ]
        ]
      }
    },
    beforeId
  );

  reportStatus('ready');
}

/**
 * Abort any in-flight fetch and remove the fill, outline, and source. All
 * guards are defensive so callers can invoke `deactivate` without first
 * verifying activation state.
 */
export function deactivate(map: maplibregl.Map): void {
  if (masterController) {
    masterController.abort();
    masterController = null;
  }
  if (map.getLayer(FILL_LAYER_ID)) map.removeLayer(FILL_LAYER_ID);
  if (map.getLayer(OUTLINE_LAYER_ID)) map.removeLayer(OUTLINE_LAYER_ID);
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
}

/**
 * Wire the click-to-popup handler and the hover cursor affordance on the hit
 * fill. Bound once at boot, independent of activation; MapLibre tolerates a
 * handler bound to a not-yet-existing layer ID.
 */
export function bindPopups(map: maplibregl.Map): void {
  map.on('click', FILL_LAYER_ID, (e) => {
    const feature = e.features?.[0];
    if (!feature) return;
    emphasizePlace(map, SOURCE_ID, feature.id);
    const props: GeoJsonProperties = feature.properties ?? null;
    const popup = new maplibregl.Popup({ closeButton: true, closeOnClick: true })
      .setLngLat(e.lngLat)
      .setHTML(buildStatePopupHtml(props))
      .addTo(map);
    attachImpactTrigger(
      popup,
      buildBoundaryContext('state', props, feature.geometry, e.lngLat)
    );
  });

  map.on('mouseenter', FILL_LAYER_ID, () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', FILL_LAYER_ID, () => {
    map.getCanvas().style.cursor = '';
  });
}
