/**
 * Location identity stack (0.6.0 unit R1; pathway appendix F).
 *
 * Resolves a clicked point (or any lng/lat) into the places that contain it, so
 * a selection can be routed to state-scoped resources and its land honestly
 * named. This is the substrate the resource catalog (R2) and the front-door
 * briefing (F3) build on: `BoundarySelectionContext` gains an optional
 * `identity`, set from here.
 *
 * Resolution, per the ratified interview calls:
 *   - STATE: query the rendered `states` layer first (what the user sees); fall
 *     back to a point-in-polygon test against the bundled Census boundaries
 *     (`public/data/us-states.geojson`) so a click resolves to the correct
 *     state even when the state layer is off. This replaces the old
 *     default-to-Washington behavior for non-boundary clicks.
 *   - ECOREGION: query the rendered EPA Omernik layers (the PMTiles Level III /
 *     Level IV fills); null when the ecoregion layer is not rendered. There is
 *     no bundled ecoregion fallback (the tiles are the source).
 *   - CONTAINING TRIBAL (D-0.6.0-008, "containing" not "nearest"): resolve the
 *     Tribal / reservation land the point falls WITHIN, from active Tribal
 *     boundary layers through the subtype-aware D-0.8.0-052 matrix. Honest
 *     null otherwise. NEVER auto-fetch a national boundary layer per click
 *     (a bandwidth and stewardship cost; the empty-placeholder
 *     stewardship rule).
 *   - COUNTY: null this phase (D-0.6.0-007). A bundled/offline county source is
 *     a fast-follow, never a per-click service; `county` already allows null.
 *
 * `resolveLocationIdentity` is async only because of the state point-in-polygon
 * fallback's one-time fetch of the bundled boundaries; the rendered-feature
 * queries are synchronous. The fetch honors the caller's abort signal and its
 * result is cached for the session.
 *
 * Stewardship: no sovereign polygons are bundled or fetched here beyond the
 * public Census state boundaries; Tribal identity comes only from layers the
 * user already chose to load.
 */

import type maplibregl from 'maplibre-gl';
import type { FeatureCollection, GeoJsonProperties } from 'geojson';

import { fetchWithBudget } from '../util/fetch';
import { pointInPolygonGeometry } from '../util/point-in-polygon';

/** Two-letter postal code plus display name for the containing state. */
export interface StateIdentity {
  /** Census STUSPS, uppercased (a two-letter postal code). */
  readonly code: string;
  /** Census NAME, for example "Washington". */
  readonly name: string;
}

/**
 * County identity. Always null in 0.6.0 (D-0.6.0-007); the shape exists so a
 * bundled/offline county source can fill it later without a signature change.
 */
export interface CountyIdentity {
  readonly name: string;
  readonly fips?: string;
}

/** EPA Omernik ecoregion identity from the rendered ecoregion layer. */
export interface EcoregionIdentity {
  /** Level III name (`US_L3NAME` / `NA_L3NAME`), when available. */
  readonly level3: string | null;
  /** Level IV name (`US_L4NAME`), when available (finer). */
  readonly level4: string | null;
  /** The finest available name, for display. */
  readonly name: string;
}

/**
 * The Tribal / reservation land the point falls within, from an ACTIVE Tribal
 * boundary layer only (D-0.6.0-008). `name` is the land-area label from that
 * source, never presented as the Tribe's own name for itself.
 */
export interface ContainingTribalIdentity {
  readonly name: string;
  /**
   * Which active layer resolved it. Precedence depends on AIANNH subtype:
   * deployer data, Census AIANNH legal entity, BIA LAR, then Census AIANNH
   * statistical entity (D-0.8.0-052). A consumer must still describe the
   * result as a source representation, never jurisdictional truth.
   */
  readonly source: 'tribal' | 'bia-reservation' | 'aiannh';
}

/** The composed identity for a point. Every field degrades honestly to null. */
export interface LocationIdentity {
  readonly lngLat: { readonly lng: number; readonly lat: number };
  readonly state: StateIdentity | null;
  readonly county: CountyIdentity | null;
  readonly ecoregion: EcoregionIdentity | null;
  readonly containingTribal: ContainingTribalIdentity | null;
}

// Hit-target (fill) layer ids, mirrored from the boundary layer modules. These
// are the transparent fills those modules add as click targets; querying them
// is how we read what the user is pointing at.
const STATES_FILL = 'us-states-fill';
const ECOREGION_FILLS = ['ecoregions-l4-fill', 'ecoregions-l3-fill'] as const;
const TRIBAL_FILL = 'tribal-lands-fill';
const BIA_FILL = 'bia-reservations-fill';
const AIANNH_FILL = 'aiannh-fill';

/**
 * AIANNHCC values the Census product identifies as legal entities. Unknown or
 * missing codes take the safer statistical or unclassified rank.
 */
const LEGAL_AIANNH_CODES = new Set(['D1', 'D2', 'D3', 'D4', 'F1']);

/** Per-call budget for the bundled-boundaries fallback fetch (same-origin). */
const STATES_FETCH_TIMEOUT_MS = 10_000;

/**
 * Same-origin state-boundary path. The optional environment read preserves
 * the Vite production base while keeping the pure identity resolver importable
 * by the Playwright runner in Node.
 */
const STATES_LOCAL_URL =
  `${import.meta.env?.BASE_URL ?? '/dynamic-drought-module/'}data/us-states.geojson`;

/**
 * Session cache for the bundled state boundaries used by the point-in-polygon
 * fallback. Resolved once, reused for every later click; a failed fetch caches
 * null so the fallback degrades to "state unresolved" without re-hitting a
 * missing file each click.
 */
let statesCachePromise: Promise<FeatureCollection | null> | null = null;

/** First non-empty string among `keys` in a feature's properties, else null. */
function firstString(props: GeoJsonProperties, keys: readonly string[]): string | null {
  if (!props) return null;
  const record = props as Record<string, unknown>;
  for (const key of keys) {
    const v = record[key];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return null;
}

/**
 * Query rendered features under `point` among whichever of `layerIds`
 * currently exist on the map. Filtering to existing layers matters:
 * `queryRenderedFeatures` throws on an unknown layer id, and these layers exist
 * only while their toggle is on.
 */
function queryFeatures(
  map: maplibregl.Map,
  point: maplibregl.PointLike,
  layerIds: readonly string[]
): maplibregl.MapGeoJSONFeature[] {
  const present = layerIds.filter((id) => map.getLayer(id));
  if (present.length === 0) return [];
  return map.queryRenderedFeatures(point, { layers: present });
}

/** First rendered feature from `queryFeatures`, or null. */
function queryFirstFeature(
  map: maplibregl.Map,
  point: maplibregl.PointLike,
  layerIds: readonly string[]
): maplibregl.MapGeoJSONFeature | null {
  return queryFeatures(map, point, layerIds)[0] ?? null;
}

/** Build a StateIdentity from a feature's Census properties, or null. */
function stateFromProps(props: GeoJsonProperties): StateIdentity | null {
  const code = firstString(props, ['STUSPS']);
  const name = firstString(props, ['NAME', 'name']);
  if (!code) return null;
  return { code: code.toUpperCase(), name: name ?? code.toUpperCase() };
}

/** Load and cache the bundled state boundaries; null on any failure. */
function loadBundledStates(signal: AbortSignal): Promise<FeatureCollection | null> {
  if (statesCachePromise) return statesCachePromise;
  statesCachePromise = (async () => {
    try {
      const response = await fetchWithBudget(STATES_LOCAL_URL, null, signal, STATES_FETCH_TIMEOUT_MS);
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      return (await response.json()) as FeatureCollection;
    } catch (err) {
      // An aborted fetch is a superseded click, not a real failure: do not
      // poison the cache, so a later click can try again.
      if (signal.aborted) {
        statesCachePromise = null;
        return null;
      }
      console.warn('[location-identity] bundled state boundaries fetch failed.', err);
      return null;
    }
  })();
  return statesCachePromise;
}

/**
 * Resolve the containing state: the rendered `states` layer first (matching
 * what the user sees), then a point-in-polygon test against the bundled Census
 * boundaries so a click resolves even when the state layer is off.
 */
async function resolveState(
  map: maplibregl.Map,
  point: maplibregl.PointLike,
  lngLat: { lng: number; lat: number },
  signal: AbortSignal
): Promise<StateIdentity | null> {
  const rendered = queryFirstFeature(map, point, [STATES_FILL]);
  if (rendered) {
    const id = stateFromProps(rendered.properties);
    if (id) return id;
  }

  const fc = await loadBundledStates(signal);
  if (!fc) return null;
  for (const feature of fc.features) {
    if (pointInPolygonGeometry(lngLat.lng, lngLat.lat, feature.geometry)) {
      const id = stateFromProps(feature.properties);
      if (id) return id;
    }
  }
  return null;
}

/** Resolve the ecoregion from the rendered EPA Omernik layers, or null. */
function resolveEcoregion(map: maplibregl.Map, point: maplibregl.PointLike): EcoregionIdentity | null {
  const feature = queryFirstFeature(map, point, ECOREGION_FILLS);
  if (!feature) return null;
  const level4 = firstString(feature.properties, ['US_L4NAME']);
  const level3 = firstString(feature.properties, ['US_L3NAME', 'NA_L3NAME']);
  const name = level4 ?? level3;
  if (!name) return null;
  return { level3, level4, name };
}

/** Whether an AIANNH feature is a legal entity for the D-0.8.0-052 matrix. */
function isLegalAiannh(props: GeoJsonProperties): boolean {
  const code = firstString(props, ['AIANNHCC', 'aiannhcc']);
  return code !== null && LEGAL_AIANNH_CODES.has(code.toUpperCase());
}

/** First usable AIANNH identity matching the requested legal/statistical rank. */
function aiannhIdentity(
  features: readonly maplibregl.MapGeoJSONFeature[],
  legal: boolean
): ContainingTribalIdentity | null {
  for (const feature of features) {
    if (isLegalAiannh(feature.properties) !== legal) continue;
    const name = firstString(feature.properties, ['NAME', 'BASENAME', 'name']);
    if (name) return { name, source: 'aiannh' };
  }
  return null;
}

/**
 * Resolve the CONTAINING Tribal / reservation land from an active Tribal layer
 * only (D-0.6.0-008). D-0.8.0-052 replaces binary BIA-over-AIANNH precedence
 * with this order: deployer data, Census AIANNH legal entity, BIA LAR, then
 * Census AIANNH statistical entity. BIA authority is scoped to BIA mission
 * use, so a Census feature expressly typed as legal wins a conflict in DDM's
 * general location identity. A statistical or unknown AIANNH subtype remains
 * below BIA because it is a tabulation geography, not a land-identity claim.
 * Null when no active Tribal boundary layer contains the point.
 */
function resolveContainingTribal(
  map: maplibregl.Map,
  point: maplibregl.PointLike
): ContainingTribalIdentity | null {
  const tribal = queryFirstFeature(map, point, [TRIBAL_FILL]);
  if (tribal) {
    const name = firstString(tribal.properties, ['LARName', 'LARNAME', 'NAME', 'name', 'TRIBE', 'RESERV_NAM']);
    if (name) return { name, source: 'tribal' };
  }

  const aiannhFeatures = queryFeatures(map, point, [AIANNH_FILL]);
  const legalAiannh = aiannhIdentity(aiannhFeatures, true);
  if (legalAiannh) return legalAiannh;

  const bia = queryFirstFeature(map, point, [BIA_FILL]);
  if (bia) {
    const name = firstString(bia.properties, ['LARNAME', 'LARName', 'NAME', 'name']);
    if (name) return { name, source: 'bia-reservation' };
  }

  return aiannhIdentity(aiannhFeatures, false);
}

/**
 * Resolve the full location identity for a point. Rendered-feature queries are
 * synchronous; only the state fallback awaits (the one-time bundled-boundaries
 * fetch), so a click with the state layer on resolves without any network wait.
 */
export async function resolveLocationIdentity(
  map: maplibregl.Map,
  lngLat: { lng: number; lat: number },
  signal: AbortSignal
): Promise<LocationIdentity> {
  const point = map.project([lngLat.lng, lngLat.lat]);
  const ecoregion = resolveEcoregion(map, point);
  const containingTribal = resolveContainingTribal(map, point);
  const state = await resolveState(map, point, lngLat, signal);
  return {
    lngLat: { lng: lngLat.lng, lat: lngLat.lat },
    state,
    county: null,
    ecoregion,
    containingTribal
  };
}
