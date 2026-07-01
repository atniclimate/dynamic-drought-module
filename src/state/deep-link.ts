/**
 * Embed deep-linking (E2): apply the one-shot `select` URL parameter.
 *
 * `?select=state:WA` opens the map already focused on a boundary with its
 * impact briefing open. The flagship use case is the embed contract: a
 * partner (a Tribal Nation, a state agency) embeds the module in an iframe
 * whose `src` carries `select`, so their page loads showing their place's
 * conditions and resources with zero clicks. Recommended companion
 * parameters for that use: `layers=states` (so the selected boundary is
 * visible) and `embed=true`.
 *
 * v1 wires the `state` kind against the bundled Census boundaries. Other
 * boundary kinds (an ecoregion by code, a reservation by its AIAN-LAR name)
 * extend `SelectParam` and this module without touching the URL grammar.
 *
 * The parameter is boot-time one-shot: `syncUrl` never re-emits it (see
 * `src/state/url.ts`), so the shareable URL always reflects what the user
 * actually sees. Failures (unknown code, fetch failure) surface as a toast
 * and a console warning, never a silent no-op.
 *
 * Alaska caveat: the bbox walk is antimeridian-naive (documented in
 * `geometryBbox`), so `select=state:AK` frames the Aleutian crossing
 * poorly. Acceptable for v1; tracked with the other antimeridian notes.
 */

import type maplibregl from 'maplibre-gl';
import type { Feature, FeatureCollection } from 'geojson';

import { URLS } from '../config/urls';
import { fetchWithBudget } from '../util/fetch';
import { buildBoundaryContext, geometryBbox } from '../impact/context';
import { openImpactPanel } from '../ui/impact-panel';
import { showToast } from '../ui/overlay';
import type { SelectParam } from './url';

/** Per-call budget for the bundled boundaries fetch (same-origin). */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Apply a captured `select` parameter. Called once from boot, after the
 * sidebar has applied the region framing, so the deep link's fitBounds wins
 * over the region's (the more specific intent prevails).
 *
 * The caller captures the parameter with `parseSelectParam()` BEFORE the
 * sidebar boots: the sidebar's first `syncUrl` rewrites the URL via
 * `history.replaceState` and (deliberately) drops `select`, so parsing here
 * would race the rewrite and lose. Boot order is load-bearing.
 */
export async function applyDeepLink(
  map: maplibregl.Map,
  select: SelectParam | null
): Promise<void> {
  if (!select) return;

  let feature: Feature | undefined;
  try {
    const response = await fetchWithBudget(
      URLS.usStatesLocal,
      null,
      null,
      FETCH_TIMEOUT_MS
    );
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const fc = (await response.json()) as FeatureCollection;
    const wanted = select.id.toUpperCase();
    feature = fc.features.find((f) => {
      const code = f.properties?.STUSPS;
      return typeof code === 'string' && code.toUpperCase() === wanted;
    });
  } catch (err) {
    console.warn('[deep-link] state boundaries fetch failed.', err);
    showToast('The deep link could not load the state boundaries.');
    return;
  }

  if (!feature) {
    console.warn(`[deep-link] unknown state code "${select.id}".`);
    showToast(`The deep link names an unknown state code (${select.id}).`);
    return;
  }

  const bbox = geometryBbox(feature.geometry);
  if (bbox) {
    map.fitBounds(bbox, { padding: 40 });
  }

  const lngLat = bbox
    ? { lng: (bbox[0] + bbox[2]) / 2, lat: (bbox[1] + bbox[3]) / 2 }
    : { lng: 0, lat: 0 };

  openImpactPanel(
    buildBoundaryContext('state', feature.properties ?? null, feature.geometry, lngLat)
  );
}
