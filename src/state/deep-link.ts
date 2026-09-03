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
 * Alaska selections use the compact circular geometry bbox, then unwrap it
 * into a continuous MapLibre fit. The context carries the same compact bbox
 * so briefing envelope requests split at the antimeridian.
 */

import type * as maplibregl from 'maplibre-gl';
import type { Feature, FeatureCollection } from 'geojson';
import type { BoundarySelectionContext } from '../impact/types';

// The boot slice of the URL catalog, not the catalog (DR-008a): this
// resolver runs at boot and needs one bundled file.
import { BOOT_URLS } from '../config/urls-boot';
import { bboxCenter, bboxToContinuousBounds } from '../util/bbox';
import { geometryBboxAcrossAntimeridian } from '../util/antimeridian';
import { fetchWithBudget } from '../util/fetch';
import {
  isCurrentBriefingIntent,
  nextBriefingIntent,
  openImpactPanel,
  openImpactPanelUnavailable
} from '../ui/impact-panel';
import { getSheetDetent, isSheetActive } from '../ui/mobile-sheet';
import { setPlaceSelection } from './place-selection';
import { getCurrentRegion } from './region-store';
import { getViewMode } from './view-mode';
import { showToast } from '../ui/overlay';
import type { SelectParam } from './url';

/** Per-call budget for the bundled boundaries fetch (same-origin). */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Panel-aware camera padding (U1, headroom A2; extended to the U2
 * three-detent model): a briefing fit always precedes the panel opening
 * over the map, so the framed boundary must not end up hidden under it.
 *
 * THE PAD FOLLOWS THE PANEL THAT WILL ACTUALLY RENDER (U-UX-FIX-1
 * DEF-5): `panelWillOpen` says whether THIS open will put the impact
 * panel over the map. The summary-first desktop path (a search
 * selection, D-0.7.0-070) renders in the LEFT sidebar column and never
 * opens the right-side panel, so reserving the desktop right pad there
 * shrank the effective viewport by up to 480px and computed a fit zoom
 * for a panel that never appeared (Washington at 5.71 instead of ~6.52,
 * Alberta in frame). Paths where the panel does open keep their exact
 * pre-fix padding values.
 *
 * Three cases:
 * - Desktop: the panel overlays the right 440px; a transient right pad,
 *   clamped to half the viewport so a small window can never be asked
 *   for more padding than it has pixels (MapLibre rejects that). With
 *   no panel coming, symmetric aesthetic margins only.
 * - Mobile with the U2 sheet active: the sheet's LIVE height is already
 *   the map's persistent transform padding (the one shared authority,
 *   written by the sheet on every detent settle; MapLibre's
 *   `cameraForBounds` composes transform padding with this option
 *   padding), so the fit passes only its aesthetic margins. Reading the
 *   sheet height here as well would double-count it.
 * - Mobile without the sheet (embed keeps today's hidden-chrome
 *   semantics; the no-JavaScript fallback stacks): the briefing overlay
 *   still covers the lower viewport, so the pre-U2 transient bottom pad
 *   stays; with no overlay coming, aesthetic margins only.
 */
function briefingCameraPadding(panelWillOpen: boolean): maplibregl.PaddingOptions {
  const mobile = window.matchMedia('(max-width: 720px)').matches;
  if (mobile && isSheetActive()) {
    return { top: 24, left: 24, right: 24, bottom: 24 };
  }
  if (mobile) {
    return {
      top: 24,
      left: 24,
      right: 24,
      bottom: panelWillOpen
        ? Math.min(Math.round(window.innerHeight * 0.45), 420)
        : 24
    };
  }
  return {
    top: 40,
    left: 40,
    bottom: 40,
    right: panelWillOpen ? Math.min(480, Math.round(window.innerWidth * 0.5)) : 40
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
 * would race the rewrite and lose. Boot order is load-bearing. A deferred
 * studio composition may supply a route-generation guard so a later route
 * change yields before the camera or briefing changes.
 */
export async function applyDeepLink(
  map: maplibregl.Map,
  select: SelectParam | null,
  routeGuard?: () => boolean
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
    guard: () =>
      isCurrentBriefingIntent(intent) &&
      (routeGuard ? routeGuard() : true)
  });
}

/**
 * Open the impact briefing for a state by its two-letter USPS code.
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
     * opens; returning false yields silently (no toast). Async openers
     * (the select= deep link, the region-briefing trigger) pass a guard
     * so a late-resolving open never overrides a briefing the user has
     * interacted with meanwhile.
     */
    guard?: () => boolean;
    /**
     * Summary-first (D-0.7.0-070): set the place selection and let the
     * left panel offer the one full-report link instead of opening the
     * briefing directly; on the active mobile Brief sheet the briefing
     * still opens (map-click parity: the at-hand half detent IS the
     * mobile summary). The select= deep link and the keyboard
     * region-briefing trigger stay direct: both are explicit
     * open-the-briefing requests.
     */
    summaryFirst?: boolean;
  } = {}
): Promise<void> {
  let feature: Feature | undefined;
  try {
    const response = await fetchWithBudget(
      BOOT_URLS.usStatesLocal,
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
    showToast('The impact briefing could not load the state boundaries.');
    return;
  }

  if (!feature) {
    console.warn(`[briefing] unknown state code "${stusps}".`);
    showToast(`No boundary found for state code ${stusps}.`);
    return;
  }

  if (opts.guard && !opts.guard()) return;

  const bbox = geometryBboxAcrossAntimeridian(feature.geometry);
  const lngLat = bbox ? bboxCenter(bbox) : { lng: 0, lat: 0 };
  let buildBoundaryContext: typeof import('../impact/context').buildBoundaryContext;
  try {
    ({ buildBoundaryContext } = await import('../impact/context'));
  } catch {
    if (!opts.guard || opts.guard()) {
      const name = feature.properties?.NAME;
      const context: BoundarySelectionContext = {
        kind: 'state',
        title:
          typeof name === 'string' && name.length > 0
            ? name
            : stusps.toUpperCase(),
        properties: feature.properties ?? null,
        lngLat,
        ...(bbox ? { bbox, serviceBbox: bbox } : {}),
        regionKey: getCurrentRegion()
      };
      openImpactPanelUnavailable(context);
    }
    return;
  }
  if (opts.guard && !opts.guard()) return;

  // ONE shared decision (U-UX-FIX-1 DEF-5; DG-080-REVIEW finding 3):
  // whether THIS open will put the impact panel over the map. On the
  // summary-first path the panel opens ONLY on the active mobile Brief
  // sheet (map-click parity); every direct open (deep link, the
  // region-briefing trigger) opens it unconditionally. Computed once and
  // used by BOTH the camera padding and the open branch below, so the
  // two can never drift apart. Everything between the two uses is
  // synchronous, so the single read equals the former pair of reads.
  const panelWillOpen =
    !opts.summaryFirst || (isSheetActive() && getViewMode() === 'brief');

  // At the sheet's full detent the map has receded entirely; no camera
  // call fires against a covered canvas (cartography lens). The report
  // close restores the prior detent, whose settle re-pads the camera.
  const mapCovered = getSheetDetent() === 'full';
  if (opts.fit && bbox && !mapCovered) {
    map.fitBounds(bboxToContinuousBounds(bbox), {
      padding: briefingCameraPadding(panelWillOpen)
    });
  }

  const rawContext = buildBoundaryContext(
    'state',
    feature.properties ?? null,
    feature.geometry,
    lngLat
  );
  const context = bbox ? { ...rawContext, bbox } : rawContext;
  if (opts.summaryFirst) {
    setPlaceSelection({ label: context.title, context });
    // The shared decision: on this branch `panelWillOpen` is exactly
    // "the mobile Brief sheet is active" (see its computation above).
    if (panelWillOpen) openImpactPanel(context);
    return;
  }
  openImpactPanel(context);
}
