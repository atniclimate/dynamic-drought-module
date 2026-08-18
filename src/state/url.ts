import { REGIONS, DEFAULT_REGION } from '../config/regions';
import type { RegionKey } from '../config/regions';
import { DEFAULT_ON_KEYS, resolveExclusiveSurface } from '../config/layers';
import type { FramingSelection } from '../config/framings';
import { HAZARD_CLUSTERS } from '../config/clusters';
import type { HazardClusterKey } from '../config/clusters';
import type { OceanKey } from '../config/oceans';
import { deriveViewMode } from './view-mode';
import type { ViewMode } from './view-mode';
import { parseBasemapParam } from './basemap-store';
import type { BasemapMode } from './basemap-store';
import { parseFramingParam } from './framing-store';
import { parseClusterParam, parseOceanParam } from './cluster-store';
import { composeClusterIntent } from './cluster-service';
import {
  parseUsdmMode,
  parseUsdmWeek,
  parseSstDate,
  parseOutlookRange,
  parseHorizonParam,
  type UsdmViewMode,
  type OutlookRange
} from './timeline';
import type { TemporalHorizonKey } from '../config/clusters';

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
 *   heatday  one-based HeatRisk frame position; the layer resolves that
 *            position only against the service's advertised granule list
 *
 * plus the region-shell trio (S2, the additive URL migration;
 * D-0.7.0-039/041/042/044/053; the precedence rules are exercised by
 * tests/s2-url-migration.spec.ts):
 *
 *   framing  one of the nine editorial keys, or `all` for the explicit
 *            North American minimap camera; absence leaves the legacy
 *            `region=` camera in control
 *   cluster  wildfire | heat | enso; Drought, the default display, is
 *            absence (D-0.7.0-044); `layers=` outranks it on parse
 *   ocean    pacific | arctic | atlantic; valid only beside
 *            cluster=enso (D-0.7.0-042/053), ignored otherwise
 *   studio   layers or place opens the matching lazy studio over the
 *            mounted map; it composes with every other durable state
 *            parameter
 *
 * This module is a direct port of the vanilla `app.js` parseUrlParams and
 * syncUrl functions (~lines 342-378 of the v0.1.x baseline). The named
 * exports are a frozen cross-module contract; do not rename them.
 */

export interface ParsedUrlParams {
  readonly region: RegionKey;
  readonly layers: Set<string>;
  readonly embed: boolean;
  /** Brief/console mode from `view=`, or derived by the legacy-URL rule
   * (D-0.7.0-017; see `deriveViewMode` in `./view-mode`). */
  readonly view: ViewMode;
  /** Whether the INBOUND URL carried an explicit, valid `view=` token
   * (U-UX-FIX-1 DEF-2). This is raw parse-time truth, captured BEFORE the
   * first canonical `syncUrl` write stamps `view=` onto every URL: it is
   * the only signal that distinguishes a shared `?view=brief` link (the
   * sharer asked for the Brief surface) from a bare boot whose mode was
   * merely derived (the map-first closed state, D-0.7.0-041). */
  readonly explicitView: boolean;
  /** USDM valid-Tuesday (YYYYMMDD) from `week=`, or null for current. */
  readonly usdmWeek: string | null;
  /** USDM view mode from `dmode=`; 'absolute' when absent or invalid. */
  readonly usdmMode: UsdmViewMode;
  /** SST anomaly frame (YYYY-MM-DD) from `sst=`, or null for latest. */
  readonly sstDate: string | null;
  /** Outlook register from `outlook=`; 'seasonal' when absent or invalid. */
  readonly outlookRange: OutlookRange;
  /** Committed temporal horizon from `horizon=`; 'current' when absent
   * or invalid. A cluster boot composes its recipe at this horizon. */
  readonly horizon: TemporalHorizonKey;
  /** One-based HeatRisk frame position from `heatday=`, or null for the
   * first currently advertised frame. */
  readonly heatRiskDay: number | null;
  /** Desktop 3D Fire mode preference from `fire3d=`; only the exact token
   * `true` turns it on. Presentation-only: it never changes which layers
   * are displayed or what any surface claims. */
  readonly fire3d: boolean;
  /** Basemap mode from `basemap=`; `default` turns the default-on satellite
   * context off, while absence selects satellite. */
  readonly basemap: BasemapMode;
  /** Minimap camera from `framing=`; null leaves `region=` in control. */
  readonly framing: FramingSelection;
  /** Hazard cluster from `cluster=`; 'drought' (absence) when missing,
   * unknown, or outranked by an explicit `layers=` (D-0.7.0-044). */
  readonly cluster: HazardClusterKey;
  /** Ocean framing from `ocean=`; non-null only beside cluster=enso
   * (D-0.7.0-042/053). */
  readonly ocean: OceanKey | null;
  /** Lazy full-viewport studio route. Only the exact tokens `layers` and
   * `place` are recognized; absence or any other value leaves the map open. */
  readonly studio: 'layers' | 'place' | null;
}

/** Parse the additive `studio=` route token. */
export function parseStudioParam(raw: string | null): 'layers' | 'place' | null {
  return raw === 'layers' || raw === 'place' ? raw : null;
}

/** Parse the additive HeatRisk day position. Unknown or duplicate input is ignored. */
export function parseHeatRiskDayParam(params = new URLSearchParams(window.location.search)): number | null {
  const values = params.getAll('heatday');
  if (values.length !== 1 || !/^[1-9]\d*$/.test(values[0] ?? '')) return null;
  const day = Number(values[0]);
  return Number.isSafeInteger(day) ? day : null;
}

/**
 * Replace only the HeatRisk day parameter while preserving every other
 * current URL field, including `embed=true`.
 */
export function syncHeatRiskDayParam(day: number | null): void {
  const params = new URLSearchParams(window.location.search);
  if (day !== null && Number.isSafeInteger(day) && day > 1) {
    params.set('heatday', String(day));
  } else {
    params.delete('heatday');
  }
  const query = params.toString();
  const url = window.location.pathname + (query === '' ? '' : `?${query}`);
  window.history.replaceState(window.history.state, '', url);
}

/**
 * Parse the additive 3D Fire mode flag (`fire3d=`). Only the exact single
 * token `true` turns the mode preference on; absence, any other value, and
 * a duplicated parameter all read as off (the heatday malformed-input
 * discipline: ambiguity is rejected, not resolved by position).
 */
export function parseFire3dParam(params = new URLSearchParams(window.location.search)): boolean {
  const values = params.getAll('fire3d');
  return values.length === 1 && values[0] === 'true';
}

/**
 * Replace only the 3D Fire mode parameter while preserving every other
 * current URL field, including `embed=true` (the syncHeatRiskDayParam
 * idiom). Off is absence: the default URL stays clean.
 */
export function syncFire3dParam(enabled: boolean): void {
  const params = new URLSearchParams(window.location.search);
  if (enabled) {
    params.set('fire3d', 'true');
  } else {
    params.delete('fire3d');
  }
  const query = params.toString();
  const url = window.location.pathname + (query === '' ? '' : `?${query}`);
  window.history.replaceState(window.history.state, '', url);
}

/**
 * The region-shell slice of the URL, parsed with its ruled precedence
 * (S2). Pure over the given params so the precedence table is testable
 * in Node (the `deriveViewMode` pattern):
 *
 *   - `layers=` OUTRANKS `cluster=` (D-0.7.0-044: the granular list is
 *     the more specific intent); when both appear, the cluster parses
 *     to 'drought' (absence) and is therefore dropped by the next
 *     canonical write.
 *   - `ocean=` is valid ONLY beside a surviving `cluster=enso`
 *     (D-0.7.0-042/053); otherwise it parses to null and is dropped on
 *     the next sync.
 *   - `framing=` is independent of both (camera-only context); unknown
 *     tokens read as no explicit minimap camera.
 */
export function parseShellParams(params: URLSearchParams): {
  framing: FramingSelection;
  cluster: HazardClusterKey;
  ocean: OceanKey | null;
} {
  const framing = parseFramingParam(params.get('framing'));
  const cluster = params.has('layers')
    ? 'drought'
    : parseClusterParam(params.get('cluster'));
  const ocean = cluster === 'enso' ? parseOceanParam(params.get('ocean')) : null;
  return { framing, cluster, ocean };
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

  // The `region=national` legacy alias needs no special handling here:
  // it resolves through REGIONS exactly as every other legacy region value
  // (honored forever, D-0.7.0-039). It does not produce a `framing=` token;
  // the distinct minimap ALL camera uses the explicit `framing=all` token.
  const rawRegion = params.get('region');
  const region: RegionKey =
    rawRegion !== null && Object.prototype.hasOwnProperty.call(REGIONS, rawRegion)
      ? (rawRegion as RegionKey)
      : DEFAULT_REGION;

  const shell = parseShellParams(params);
  const horizon = parseHorizonParam(params.get('horizon'));

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
  } else if (shell.cluster !== 'drought') {
    // A cluster boot resolves to the reference default-on set plus the
    // cluster's recipe at the URL's committed horizon. Composing at the
    // shared horizon makes a cluster share reproduce the displayed recipe
    // instead of silently returning to the current-horizon composition.
    layers = new Set(composeClusterIntent(shell.cluster, horizon));
  } else {
    layers = new Set(DEFAULT_ON_KEYS);
  }

  const rawEmbed = params.get('embed');
  const embed = rawEmbed === 'true' || rawEmbed === '1';

  // Raw explicitness (DEF-2): only the two valid tokens count. An invalid
  // `view=` value falls through the legacy-URL derivation and is NOT an
  // explicit ask.
  const rawView = params.get('view');
  const explicitView = rawView === 'brief' || rawView === 'console';

  return {
    region,
    layers,
    embed,
    view: deriveViewMode(params),
    explicitView,
    usdmWeek: parseUsdmWeek(params.get('week')),
    usdmMode: parseUsdmMode(params.get('dmode')),
    sstDate: parseSstDate(params.get('sst')),
    outlookRange: parseOutlookRange(params.get('outlook')),
    horizon,
    heatRiskDay: parseHeatRiskDayParam(params),
    fire3d: parseFire3dParam(params),
    // A DUPLICATED basemap parameter is malformed input and pins to the
    // product default in BOTH orders (D-0.7.0-031 edge-case rule; the stage-5
    // adversarial major 5 caught a first-wins drift here): ambiguity is
    // rejected, not resolved by position.
    basemap:
      params.getAll('basemap').length > 1
        ? 'satellite'
        : parseBasemapParam(params.get('basemap')),
    framing: shell.framing,
    cluster: shell.cluster,
    ocean: shell.ocean,
    studio:
      params.getAll('studio').length === 1
        ? parseStudioParam(params.get('studio'))
        : null
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
  /** Brief/console mode; always emitted so a shared URL restores the
   * exact door the sharer was looking through (the legacy-URL rule
   * derives a mode only for URLs authored before `view=` existed). */
  readonly view: ViewMode;
  /** Selected USDM week; emitted as `week=` only when non-null. */
  readonly usdmWeek?: string | null;
  /** USDM view mode; emitted as `dmode=` only when not 'absolute'. */
  readonly usdmMode?: UsdmViewMode;
  /** Selected SST frame; emitted as `sst=` only when non-null. */
  readonly sstDate?: string | null;
  /** Outlook register; emitted as `outlook=` only when 'monthly'. */
  readonly outlookRange?: OutlookRange;
  /** Committed temporal horizon; omitted for the current horizon. */
  readonly horizon?: TemporalHorizonKey;
  /** Basemap mode; emitted as `basemap=default` only when satellite is off,
   * so the product-default URL stays clean. */
  readonly basemap?: BasemapMode;
  /** Minimap camera; emitted only when non-null. Callers pass `region: null`
   * while a minimap camera is active so the URL claims one camera. */
  readonly framing?: FramingSelection;
  /** Hazard cluster; while non-'drought' it REPLACES `layers=` in the
   * emitted URL (the durable-truth model, D-0.7.0-044: the clean
   * cluster is the one-word claim; the granular list returns the moment
   * the display stops being that cluster). */
  readonly cluster?: HazardClusterKey;
  /** Ocean framing; emitted as `ocean=` only beside cluster=enso
   * (D-0.7.0-042/053). */
  readonly ocean?: OceanKey | null;
  /** Lazy studio route; emitted only while one exclusive studio is open. */
  readonly studio?: 'layers' | 'place' | null;
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
  // HeatRisk owns its additive day position. Preserve it across every
  // ordinary state write so layer toggles and embed changes cannot erase
  // the selected frame.
  const heatRiskDay = parseHeatRiskDayParam(
    new URLSearchParams(window.location.search)
  );
  // The 3D Fire mode likewise owns its additive flag (its store writes it
  // through syncFire3dParam); read it fresh here so ordinary state writes
  // preserve an active mode instead of erasing it.
  const fire3d = parseFire3dParam(new URLSearchParams(window.location.search));
  const params = new URLSearchParams();

  if (state.region) {
    params.set('region', state.region);
  }

  if (state.framing) {
    params.set('framing', state.framing);
  }

  // The durable-truth handoff (D-0.7.0-044): a clean non-default cluster
  // is serialized as the one-word token INSTEAD of the granular list;
  // everything else emits `layers=` exactly as before (including the
  // explicit-empty all-off form). The caller (the sidebar's pushUrl)
  // clears the cluster the moment the layer intent diverges from the
  // cluster's composition, so the two branches can never both be true
  // of the display.
  const cluster = state.cluster ?? 'drought';
  const clusterToken = HAZARD_CLUSTERS[cluster].urlToken;
  if (clusterToken !== null) {
    params.set('cluster', clusterToken);
    if (cluster === 'enso' && state.ocean) {
      params.set('ocean', state.ocean);
    }
  } else if (state.layers.size > 0) {
    params.set('layers', Array.from(state.layers).join(','));
  } else {
    params.set('layers', '');
  }

  if (state.embed) {
    params.set('embed', 'true');
  }

  params.set('view', state.view);

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
  if (state.outlookRange === 'monthly') {
    params.set('outlook', state.outlookRange);
  }
  if (state.horizon === 'weeks-ahead' || state.horizon === 'season-ahead') {
    params.set('horizon', state.horizon);
  }
  if (heatRiskDay !== null && heatRiskDay > 1) {
    params.set('heatday', String(heatRiskDay));
  }
  if (fire3d) {
    params.set('fire3d', 'true');
  }
  if (state.basemap === 'default') {
    params.set('basemap', state.basemap);
  }
  if (state.studio === 'layers' || state.studio === 'place') {
    params.set('studio', state.studio);
  }

  const url = window.location.pathname + '?' + params.toString();
  // Preserve the existing history.state: the studio route stamps a
  // marker on studio entries (src/state/studio-route.ts), and replacing
  // it with null here would make a reload inside a studio look like a
  // direct boot and re-synthesize history.
  window.history.replaceState(window.history.state, '', url);
}
