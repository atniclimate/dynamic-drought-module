import { REGIONS, DEFAULT_REGION } from '../config/regions';
import type { RegionKey } from '../config/regions';

/**
 * URL parameterization for the Dynamic Drought Module (DDM).
 *
 * The application encodes its restorable view in three query parameters:
 *
 *   region   active region key (validated against REGIONS, falls back
 *            to DEFAULT_REGION on unknown or missing values)
 *   layers   comma-separated active layer keys; an explicit empty value
 *            (`?layers=`) yields the empty set, while a missing parameter
 *            yields the default-on set
 *   embed    presence of `embed=true` or `embed=1` enables embed mode
 *
 * This module is a direct port of the vanilla `app.js` parseUrlParams and
 * syncUrl functions (~lines 342-378 of the v0.1.x baseline). See CLAUDE.md
 * section 8 for the named-export contract.
 */

/**
 * Default-on layer keys used when the `layers` URL parameter is missing.
 *
 * TODO(M8): replace this hard-coded set with a derivation from
 * `LAYER_DEFS.filter(l => l.defaultOn).map(l => l.key)` once
 * `src/config/layers.ts` lands. Keeping the values in lockstep with the
 * vanilla baseline (Tribal Lands as the single default-on layer; the M2-M4
 * tranche additionally pre-activated Drought, Hydrography, and Telemetry
 * for tranche review) until then.
 */
const DEFAULT_ON_LAYER_KEYS: ReadonlySet<string> = new Set([
  'hydrography',
  'tribal',
  'telemetry'
]);

export interface ParsedUrlParams {
  readonly region: RegionKey;
  readonly layers: Set<string>;
  readonly embed: boolean;
}

/**
 * Read the current `window.location.search` and resolve the application's
 * restorable view. Unknown region keys silently fall back to
 * `DEFAULT_REGION`. Layer keys are passed through unfiltered: the calling
 * code (the LayerRegistry, on activation) is responsible for rejecting
 * unknown keys, mirroring the vanilla baseline behavior.
 */
export function parseUrlParams(): ParsedUrlParams {
  const params = new URLSearchParams(window.location.search);

  const rawRegion = params.get('region');
  const region: RegionKey =
    rawRegion !== null && Object.prototype.hasOwnProperty.call(REGIONS, rawRegion)
      ? (rawRegion as RegionKey)
      : DEFAULT_REGION;

  let layers: Set<string>;
  if (params.has('layers')) {
    const raw = params.get('layers') ?? '';
    if (raw.trim() === '') {
      // `?layers=` (explicit empty value) means the user has toggled
      // every layer off; preserve that intent across reloads.
      layers = new Set<string>();
    } else {
      layers = new Set(
        raw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      );
    }
  } else {
    layers = new Set(DEFAULT_ON_LAYER_KEYS);
  }

  const rawEmbed = params.get('embed');
  const embed = rawEmbed === 'true' || rawEmbed === '1';

  return { region, layers, embed };
}

/**
 * Snapshot of the application state that drives the URL. Mirrors the
 * subset of fields written by the vanilla syncUrl: the active region,
 * the active layer set, and the sticky embed flag.
 */
export interface UrlSyncState {
  readonly region: RegionKey | null;
  readonly layers: ReadonlySet<string>;
  readonly embed: boolean;
}

/**
 * Replace the current history entry with a URL that encodes `state`.
 *
 *   region   only emitted when non-null
 *   layers   always emitted, even when the active set is empty
 *            (preserves the explicit-empty signal across reloads)
 *   embed    only emitted when truthy, as `embed=true`
 *
 * Uses `history.replaceState` (not pushState) so the back button is not
 * polluted by every layer toggle.
 */
export function syncUrl(state: UrlSyncState): void {
  const params = new URLSearchParams();

  if (state.region) {
    params.set('region', state.region);
  }

  if (state.layers.size > 0) {
    params.set('layers', Array.from(state.layers).join(','));
  } else {
    params.set('layers', '');
  }

  if (state.embed) {
    params.set('embed', 'true');
  }

  const url = window.location.pathname + '?' + params.toString();
  window.history.replaceState(null, '', url);
}
