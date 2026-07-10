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
import {
  isCurrentBriefingIntent,
  nextBriefingIntent,
  openImpactPanel
} from '../ui/impact-panel';
import { getSheetDetent, isSheetActive } from '../ui/mobile-sheet';
import { showToast } from '../ui/overlay';
import type { SelectParam } from './url';

/** Per-call budget for the bundled boundaries fetch (same-origin). */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Panel-aware camera padding (U1, headroom A2; extended to the U2
 * three-detent model): a briefing fit always precedes the panel opening
 * over the map, so the framed boundary must not end up hidden under it.
 *
 * Three cases:
 * - Desktop: the panel overlays the right 440px; a transient right pad,
 *   clamped to half the viewport so a small window can never be asked
 *   for more padding than it has pixels (MapLibre rejects that).
 * - Mobile with the U2 sheet active: the sheet's LIVE height is already
 *   the map's persistent transform padding (the one shared authority,
 *   written by the sheet on every detent settle; MapLibre's
 *   `cameraForBounds` composes transform padding with this option
 *   padding), so the fit passes only its aesthetic margins. Reading the
 *   sheet height here as well would double-count it.
 * - Mobile without the sheet (embed keeps today's hidden-chrome
 *   semantics; the no-JavaScript fallback stacks): the briefing overlay
 *   still covers the lower viewport, so the pre-U2 transient bottom pad
 *   stays.
 */
function briefingCameraPadding(): maplibregl.PaddingOptions {
  const mobile = window.matchMedia('(max-width: 720px)').matches;
  if (mobile && isSheetActive()) {
    return { top: 24, left: 24, right: 24, bottom: 24 };
  }
  if (mobile) {
    return {
      top: 24,
      left: 24,
      right: 24,
      bottom: Math.min(Math.round(window.innerHeight * 0.45), 420)
    };
  }
  return {
    top: 40,
    left: 40,
    bottom: 40,
    right: Math.min(480, Math.round(window.innerWidth * 0.5))
  };
}

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
  // A fresh deep link frames the state (fit: true); the shared helper below is
  // also called by the keyboard region-briefing trigger with fit: false so it
  // preserves the user's current framing (#9). The deep link is boot-time
  // intent, so it carries the standard yield guard (U1 adversarial-review
  // fix): a briefing the user opens or closes while this boundary fetch is
  // in flight is NEWER intent and wins; the late deep link then yields
  // instead of stomping it.
  const intent = nextBriefingIntent();
  await openStateBriefing(map, select.id, {
    fit: true,
    guard: () => isCurrentBriefingIntent(intent)
  });
}

/**
 * Open the drought impact briefing for a state by its two-letter USPS code.
 * Shared by the `select` deep link and the sidebar region-briefing trigger
 * (critical-review #9, the keyboard-reachable path to the briefing). Fetches
 * the bundled state boundary, optionally frames it, and opens the panel with
 * the same boundary context a map click would build. Failures surface as a
 * toast and a console warning, never a silent no-op.
 */
export async function openStateBriefing(
  map: maplibregl.Map,
  stusps: string,
  opts: {
    fit?: boolean;
    /**
     * Evaluated after the boundary fetch, immediately before the panel
     * opens; returning false yields silently (no toast). The U1
     * answer-first boot passes a guard so its late-resolving open never
     * overrides a briefing the user has interacted with meanwhile.
     */
    guard?: () => boolean;
  } = {}
): Promise<void> {
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
    const wanted = stusps.toUpperCase();
    feature = fc.features.find((f) => {
      const code = f.properties?.STUSPS;
      return typeof code === 'string' && code.toUpperCase() === wanted;
    });
  } catch (err) {
    console.warn('[briefing] state boundaries fetch failed.', err);
    showToast('The drought impact briefing could not load the state boundaries.');
    return;
  }

  if (!feature) {
    console.warn(`[briefing] unknown state code "${stusps}".`);
    showToast(`No boundary found for state code ${stusps}.`);
    return;
  }

  if (opts.guard && !opts.guard()) return;

  const bbox = geometryBbox(feature.geometry);
  // At the sheet's full detent the map has receded entirely; no camera
  // call fires against a covered canvas (cartography lens). The report
  // close restores the prior detent, whose settle re-pads the camera.
  const mapCovered = getSheetDetent() === 'full';
  if (opts.fit && bbox && !mapCovered) {
    map.fitBounds(bbox, { padding: briefingCameraPadding() });
  }

  const lngLat = bbox
    ? { lng: (bbox[0] + bbox[2]) / 2, lat: (bbox[1] + bbox[3]) / 2 }
    : { lng: 0, lat: 0 };

  openImpactPanel(
    buildBoundaryContext('state', feature.properties ?? null, feature.geometry, lngLat)
  );
}
