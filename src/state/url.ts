import { REGIONS, DEFAULT_REGION } from '../config/regions';
import type { RegionKey } from '../config/regions';
import { DEFAULT_ON_KEYS, resolveExclusiveSurface } from '../config/layers';
import {
  parseUsdmMode,
  parseUsdmWeek,
  parseSstDate,
  type UsdmViewMode
} from './timeline';

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
 * plus three temporal parameters (0.5.0b, the temporal axis), emitted only
 * when they differ from "now" so the default URL stays clean:
 *
 *   week     YYYYMMDD USDM valid-Tuesday the scrubber sits on
 *   dmode    'chg1' | 'chg4', the USDM change-map view mode
 *   sst      YYYY-MM-DD selected SST anomaly frame (always paused on load;
 *            playback state is deliberately never serialized)
 *
 * This module is a direct port of the vanilla `app.js` parseUrlParams and
 * syncUrl functions (~lines 342-378 of the v0.1.x baseline). See CLAUDE.md
 * section 8 for the named-export contract.
 */

export interface ParsedUrlParams {
  readonly region: RegionKey;
  readonly layers: Set<string>;
  readonly embed: boolean;
  /** USDM valid-Tuesday (YYYYMMDD) from `week=`, or null for current. */
  readonly usdmWeek: string | null;
  /** USDM view mode from `dmode=`; 'absolute' when absent or invalid. */
  readonly usdmMode: UsdmViewMode;
  /** SST anomaly frame (YYYY-MM-DD) from `sst=`, or null for latest. */
  readonly sstDate: string | null;
}

/**
 * Read the current `window.location.search` and resolve the application's
 * restorable view. Unknown region keys silently fall back to
 * `DEFAULT_REGION`. Unknown layer keys are passed through unfiltered: the
 * calling code (the LayerRegistry, on activation) is responsible for
 * rejecting them, mirroring the vanilla baseline behavior.
 *
 * One-surface-at-a-time (UX-1): an inbound `?layers=` naming several
 * condition surfaces (an old shared link from before surfaces became
 * mutually exclusive) resolves deterministically via
 * `resolveExclusiveSurface`: the first surface named in the list is kept,
 * later surfaces are dropped. The default-on set already conforms (exactly
 * one surface), so the no-parameter path needs no resolution.
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
      const keys = raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      layers = new Set(resolveExclusiveSurface(keys));
    }
  } else {
    layers = new Set(DEFAULT_ON_KEYS);
  }

  const rawEmbed = params.get('embed');
  const embed = rawEmbed === 'true' || rawEmbed === '1';

  return {
    region,
    layers,
    embed,
    usdmWeek: parseUsdmWeek(params.get('week')),
    usdmMode: parseUsdmMode(params.get('dmode')),
    sstDate: parseSstDate(params.get('sst'))
  };
}

/**
 * A parsed `select` deep-link parameter (E2 embed deep-linking). Format is
 * `select=<kind>:<id>`; the only kind wired so far is `state` with a
 * two-letter postal code (`select=state:WA`). The parameter is applied once
 * at boot (zoom to the boundary and open the impact briefing) and is
 * deliberately NOT re-emitted by `syncUrl`: the URL must never keep claiming
 * a briefing the user has since closed. An embedding site keeps the
 * parameter in its iframe `src`, which re-applies it on every load; that is
 * the deep-link use case.
 */
export interface SelectParam {
  readonly kind: 'state';
  readonly id: string;
}

/** Parse the `select` parameter, or null when absent or malformed. */
export function parseSelectParam(): SelectParam | null {
  const raw = new URLSearchParams(window.location.search).get('select');
  if (!raw) return null;
  const idx = raw.indexOf(':');
  if (idx <= 0) return null;
  const kind = raw.slice(0, idx).trim().toLowerCase();
  const id = raw.slice(idx + 1).trim();
  if (kind !== 'state' || id === '') return null;
  return { kind: 'state', id };
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
  /** Selected USDM week; emitted as `week=` only when non-null. */
  readonly usdmWeek?: string | null;
  /** USDM view mode; emitted as `dmode=` only when not 'absolute'. */
  readonly usdmMode?: UsdmViewMode;
  /** Selected SST frame; emitted as `sst=` only when non-null. */
  readonly sstDate?: string | null;
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

  // Temporal parameters (0.5.0b): only non-default values are emitted, so
  // a view of "now" keeps the clean three-parameter URL. The embed flag
  // above is already serialized regardless, preserving invariant 2's
  // embed-across-syncUrl guarantee for temporal-state changes too.
  if (state.usdmWeek) {
    params.set('week', state.usdmWeek);
  }
  if (state.usdmMode && state.usdmMode !== 'absolute') {
    params.set('dmode', state.usdmMode);
  }
  if (state.sstDate) {
    params.set('sst', state.sstDate);
  }

  const url = window.location.pathname + '?' + params.toString();
  window.history.replaceState(null, '', url);
}
