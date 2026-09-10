/**
 * The place-popup "Conditions" block (owner amendment, 2026-09-10,
 * superseding the 2026-07-18 maintainer directive that kept a place popup
 * an identity-only card; see the note at the top of
 * `src/map/interaction-coordinator.ts` `renderPopup`).
 *
 * A click on a boundary (state, Tribal, BIA reservation, AIANNH, treaty
 * area, ecoregion) now surfaces the critical, already-mapped conditions at
 * that point, not only its identity. This module COMPOSES existing reads
 * only, exactly as `src/impact/fire-context.ts` does for a fire-perimeter
 * click: it queries layers already rendered on the map at the clicked
 * point (`map.queryRenderedFeatures`), and issues NO network request of
 * its own. A condition whose layer is not currently active is not
 * "already-available" data, so it is left OFF THE CARD rather than
 * padded with a "turn this on" hint (unlike `fire-context.ts`'s roomier
 * supplementary block, this card is meant to read in one glance; the
 * conditions strip and the layer sidebar are where "turn on X" belongs).
 *
 * Every row names its issuer verbatim, matching the vocabulary the rest of
 * the app already uses for that source (D-0.7.0-072 family): the U.S.
 * Drought Monitor / North American Drought Monitor, NOAA NWS, and NIFC
 * WFIGS. Nothing here is a DDM-computed judgement, an outlook, or a static
 * hazard-potential raster presented as current: the NWS HeatRisk layer
 * (an ImageServer mosaic; see `src/layers/heatrisk-coverage.ts`) has no
 * verified per-point identify endpoint, so it is never read here, exactly
 * as Wildfire Hazard Potential is never read as a point value in
 * `fire-context.ts`. "Extreme heat" therefore surfaces only through a
 * REAL active NWS heat product (Extreme/Excessive Heat Warning or Watch,
 * Heat Advisory), which is the same `nws-alerts` layer and query as the
 * fire-weather products; it is not a separate row.
 *
 * REACHABILITY FINDING (2026-09-10, recorded here because it shapes the
 * `alertRows`/`fireRow` queries below): both the NWS alerts layer and the
 * NIFC fires layer register with the InteractionCoordinator as
 * `'point-event'`, the HIGHEST-precedence kind in
 * `src/config/interaction-ranks.ts` -- ABOVE every boundary kind. So
 * whenever an alert or a fire perimeter covers the EXACT clicked pixel,
 * the coordinator's own arbitration resolves THAT feature as the primary
 * response instead of the boundary beneath it; a boundary popup can only
 * ever exist at a pixel with no coincident point-event hit. Querying
 * alerts/fires at the bare click point (as drought is queried below, and
 * as `fire-context.ts` queries drought for a fire-perimeter popup) would
 * therefore almost never find one FROM a boundary popup, even when a real
 * warning covers most of the clicked place. `screenBoxForGeometry` below
 * queries the CLICKED PLACE'S OWN rendered extent instead: still "at that
 * place" (never the whole viewport, only this one feature's geometry), but
 * actually reachable. Drought is unaffected: `condition-surface` is the
 * LOWEST-ranked kind, so a boundary always wins over it regardless, and
 * the point-exact read stays consistent with `fire-context.ts`.
 */
import type * as maplibregl from 'maplibre-gl';
import type { GeoJsonProperties, Geometry } from 'geojson';

import { registry } from '../state/registry';
import { USDM_CATEGORIES, NADM_CATEGORIES } from '../config/palette';
import { classifyNifcIncidentType } from '../config/wildfire-presentation';
import { escapeHtml } from '../util/escape';

/** A `queryRenderedFeatures` region: a bare point, or a screen-space box. */
type QueryRegion = maplibregl.PointLike | [maplibregl.PointLike, maplibregl.PointLike];

// ---------------------------------------------------------------------------
// Layer and fill ids, restated (not imported) by design: these ids are
// module-private constants owned by their layer modules. The same
// restatement convention already appears in `src/impact/fire-context.ts`,
// `src/ui/hover-inspector.ts`, and `src/ui/island/strip-metrics.ts`, so this
// module stays a pure read-only observer with no new coupling to those
// modules' internals; a future id rename surfaces as a failing test here too.
// ---------------------------------------------------------------------------

const USDM_KEY = 'usdm';
const USDM_FILLS = ['usdm-frame-a-fill', 'usdm-frame-b-fill'] as const;
const NADM_KEY = 'nadm-drought';
const NADM_FILL = 'nadm-drought-fill';

const ALERTS_KEY = 'nws-alerts';
const ALERTS_FILL = 'nws-alerts-fill';

const FIRES_KEY = 'nifc-fires';
const FIRES_FILL = 'nifc-fires-fill';

/** Mirrors `strip-metrics.ts` `isLayerOn`: on the instant activation starts
 * (status flips to `loading` synchronously), not only once it resolves. */
function isLayerOn(key: string): boolean {
  return registry.getActiveKeys().has(key) || registry.getStatus(key) === 'loading';
}

/** Every [lng, lat] vertex of a Polygon or MultiPolygon's rings, flattened.
 * Any other geometry type (Point, LineString, or none) yields no points,
 * and the caller falls back to the bare click point. */
function flattenLngLat(geometry: Geometry | null | undefined): Array<[number, number]> {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') {
    return geometry.coordinates.flat(1) as Array<[number, number]>;
  }
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.flat(2) as Array<[number, number]>;
  }
  return [];
}

/**
 * The clicked boundary feature's OWN screen-space bounding box, clamped to
 * the map container -- the reachability fix in the module doc above. Every
 * corner is projected with the map's OWN live transform (`map.project`,
 * already used the same way in `src/state/location-identity.ts`), so a
 * rotated or tilted view still yields a box that fully contains the
 * feature's on-screen footprint. Returns null for a degenerate box (a
 * non-polygon geometry, or one that projects entirely outside the visible
 * container), in which case the caller queries the bare click point
 * instead.
 */
function screenBoxForGeometry(
  map: maplibregl.Map,
  geometry: Geometry | null | undefined
): [maplibregl.PointLike, maplibregl.PointLike] | null {
  const vertices = flattenLngLat(geometry);
  if (vertices.length === 0) return null;

  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [lng, lat] of vertices) {
    if (lng < west) west = lng;
    if (lng > east) east = lng;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  if (![west, south, east, north].every(Number.isFinite)) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const lng of [west, east]) {
    for (const lat of [south, north]) {
      const p = map.project([lng, lat]);
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }

  const container = map.getContainer();
  const clampedMinX = Math.max(0, Math.min(minX, container.clientWidth));
  const clampedMaxX = Math.max(0, Math.min(maxX, container.clientWidth));
  const clampedMinY = Math.max(0, Math.min(minY, container.clientHeight));
  const clampedMaxY = Math.max(0, Math.min(maxY, container.clientHeight));
  if (clampedMaxX <= clampedMinX || clampedMaxY <= clampedMinY) return null;

  return [
    [clampedMinX, clampedMinY],
    [clampedMaxX, clampedMaxY]
  ];
}

export interface PlaceConditions {
  /** The `.popup-conditions` block, always non-empty: an honest "nothing
   * mapped is active" line when every condition layer is off. */
  readonly html: string;
  /**
   * True only when a REAL issuer-published warning-class condition covers
   * the clicked point: an active NWS product whose name ends "Warning"
   * (never a Watch or Advisory), or a currently mapped WFIGS wildfire
   * perimeter. Drives the briefing-door pulse (director ruling,
   * 2026-09-10, "Emphasis must be ethical"). Never set from a
   * DDM-computed judgement, a raster hazard-potential surface, or an
   * outlook/forecast product.
   */
  readonly hasWarning: boolean;
  /**
   * The verbatim upstream product name (or, for a fire perimeter, the
   * plain "Mapped wildfire perimeter" legend phrase this app already uses
   * in `src/config/wildfire-presentation.ts`) that set `hasWarning`, or
   * null when `hasWarning` is false. `buildImpactTriggerButtonHtml` shows
   * this ON the door instead of a DDM-authored word for the condition
   * (accessibility clause d, and the surface-vocabulary doctrine: DDM
   * never calls its own read "a warning"; only the issuer's own product
   * name earns that word). The first one found when more than one
   * warning-tier condition covers the point.
   */
  readonly warningLabel: string | null;
}

function readDm(props: GeoJsonProperties): number | null {
  if (!props) return null;
  const raw = props['DM'] ?? props['dm'];
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isInteger(n) ? n : null;
}

/** The drought category beneath the clicked point, NADM preferred when its
 * layer is active (matches the conditions-strip's own precedence in
 * `src/ui/island/strip-metrics.ts` `droughtMetric`), else USDM. Omitted
 * entirely (returns null) when neither drought layer is on. */
function droughtRow(map: maplibregl.Map, point: maplibregl.PointLike): string | null {
  if (isLayerOn(NADM_KEY) && map.getLayer(NADM_FILL)) {
    const feats = map.queryRenderedFeatures(point, { layers: [NADM_FILL] });
    let maxIndex = -1;
    for (const f of feats) {
      const raw = String(f.properties?.['DROUGHTCAT'] ?? '').toUpperCase();
      const index = NADM_CATEGORIES.findIndex((c) => c.code === raw);
      if (index > maxIndex) maxIndex = index;
    }
    const category = maxIndex >= 0 ? NADM_CATEGORIES[maxIndex] : undefined;
    return category
      ? conditionRow(
          'Drought',
          `${category.code} ${category.label} (North American Drought Monitor)`
        )
      : conditionRow('Drought', 'No drought category polygon here (North American Drought Monitor).');
  }

  if (isLayerOn(USDM_KEY)) {
    const presentFills = USDM_FILLS.filter((id) => map.getLayer(id));
    if (presentFills.length === 0) return null;
    const feats = map.queryRenderedFeatures(point, { layers: [...presentFills] });
    let maxDm = -1;
    for (const f of feats) {
      const dm = readDm(f.properties);
      if (dm !== null && dm > maxDm) maxDm = dm;
    }
    if (maxDm < 0) {
      return conditionRow(
        'Drought',
        'No D0-D4 category polygon here (U.S. Drought Monitor). This client has no analyzed-area mask, so this does not confirm no drought.'
      );
    }
    const cat = maxDm < USDM_CATEGORIES.length ? USDM_CATEGORIES[maxDm] : undefined;
    return cat
      ? conditionRow('Drought', `${cat.code} ${cat.label} (U.S. Drought Monitor, NDMC/NOAA/USDA)`)
      : null;
  }

  return null;
}

/** The NWS product name this app already requests (see
 * `src/layers/nws-alerts.ts` `ALERT_EVENTS`): true only for the
 * "Warning"-tier products, never a Watch or an Advisory. */
function isNwsWarningTier(prodType: string): boolean {
  return /warning$/i.test(prodType.trim());
}

/** Every distinct active NWS alert polygon covering the clicked point
 * (fire-weather and heat share one layer, distinguished by `prod_type`),
 * each its own row so a Heat Advisory and a Red Flag Warning covering the
 * same point are never collapsed into one line. Omitted entirely when the
 * alerts layer is off; a confirmed zero (layer on, nothing here) renders
 * one honest "none" row. */
function alertRows(
  map: maplibregl.Map,
  region: QueryRegion
): { rows: string[]; hasWarning: boolean; warningLabel: string | null } {
  if (!isLayerOn(ALERTS_KEY) || !map.getLayer(ALERTS_FILL)) {
    return { rows: [], hasWarning: false, warningLabel: null };
  }

  const feats = map.queryRenderedFeatures(region, { layers: [ALERTS_FILL] });
  const seen = new Map<string, { prodType: string; ends: string | null }>();
  for (const f of feats) {
    const prodType = String(f.properties?.['prod_type'] ?? '').trim();
    if (prodType === '') continue;
    const endsRaw = f.properties?.['ends'] ?? f.properties?.['expiration'] ?? null;
    seen.set(prodType, { prodType, ends: endsRaw === null ? null : String(endsRaw) });
  }

  if (seen.size === 0) {
    return {
      // vocab-allow: names the NWS watch/warning/advisory product category (src/layers/nws-alerts.ts), matching that module's own description
      rows: [conditionRow('NWS alert', 'No active NWS watch, warning, or advisory here.')],
      hasWarning: false,
      warningLabel: null
    };
  }

  let hasWarning = false;
  let warningLabel: string | null = null;
  const rows = [...seen.values()].map(({ prodType, ends }) => {
    if (isNwsWarningTier(prodType)) {
      hasWarning = true;
      warningLabel ??= prodType;
    }
    const until = formatWhen(ends);
    const value = until ? `${prodType}, until ${until} (NOAA NWS)` : `${prodType} (NOAA NWS)`;
    // vocab-allow: names the NWS alert product category (src/layers/nws-alerts.ts); the value is the issuer's own verbatim product name
    return conditionRow('NWS alert', value);
  });
  return { rows, hasWarning, warningLabel };
}

/** The clicked point's identity for the incident-name fallback, mirroring
 * `src/layers/nifc-fires.ts` `pickIncidentName` (restated, not imported;
 * that helper is module-private). */
function pickIncidentName(props: GeoJsonProperties): string {
  const p = props ?? {};
  for (const candidate of [p.attr_IncidentName, p.poly_IncidentName, p.IncidentName, p.incidentName]) {
    if (candidate === null || candidate === undefined) continue;
    const s = String(candidate).trim();
    if (s !== '') return s;
  }
  return 'Mapped fire perimeter';
}

/** A currently mapped NIFC WFIGS wildfire perimeter covering the clicked
 * point (never a prescribed-fire perimeter; the owning fill already
 * filters to WF/CX, and `classifyNifcIncidentType` re-checks defensively,
 * exactly as `strip-metrics.ts` `firesMetric` does). Omitted entirely when
 * the fires layer is off; a confirmed zero renders one honest "none"
 * row. */
function fireRow(
  map: maplibregl.Map,
  region: QueryRegion
): { row: string; hasWarning: boolean; warningLabel: string | null } | null {
  if (!isLayerOn(FIRES_KEY) || !map.getLayer(FIRES_FILL)) return null;

  const feats = map
    .queryRenderedFeatures(region, { layers: [FIRES_FILL] })
    .filter((f) => classifyNifcIncidentType(f.properties?.['attr_IncidentTypeCategory']) === 'wildfire');

  if (feats.length === 0) {
    return {
      row: conditionRow('Wildfire', 'No mapped wildfire perimeter here (NIFC WFIGS).'),
      hasWarning: false,
      warningLabel: null
    };
  }

  const names = [...new Set(feats.map((f) => pickIncidentName(f.properties)))];
  const value = `Active mapped perimeter here: ${names.join(', ')} (NIFC WFIGS).`;
  // The plain legend phrase this app already uses for a real WF/CX
  // perimeter (src/config/wildfire-presentation.ts NIFC_INCIDENT_PRESENTATION.wildfire.legendLabel), not a DDM-authored "warning" word.
  return { row: conditionRow('Wildfire', value), hasWarning: true, warningLabel: 'Mapped wildfire perimeter' };
}

/** Format an alert `ends`/`expiration` timestamp the same readable way
 * `src/ui/popups.ts` `formatAlertTime` does for the same field (restated,
 * not imported; that helper is module-private). Falls back to the raw
 * string when it does not parse, never hides the window. */
function formatWhen(value: string | null): string {
  if (value === null || value === '') return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function conditionRow(label: string, value: string): string {
  return `
    <div class="popup-condition-row">
      <span class="popup-condition-label">${escapeHtml(label)}</span>
      <span class="popup-condition-value">${escapeHtml(value)}</span>
    </div>`;
}

/**
 * Build the `.popup-conditions` block for a boundary popup at the clicked
 * screen point. `point` is the click's screen-pixel position, used
 * point-exact for drought (matching `fire-context.ts`'s convention: a
 * boundary always outranks the lowest-ranked `condition-surface` kind, so
 * the exact pixel is always reachable there). `geometry` is the CLICKED
 * FEATURE's own GeoJSON geometry, when the caller has it; alerts and fires
 * are read against ITS screen-space bounding box instead of the bare
 * point (see the REACHABILITY FINDING in this module's header) so that a
 * real warning covering the place, not only the exact pixel, is not
 * missed. Falls back to the bare point when no geometry is given or it is
 * not a polygon.
 */
export function buildPlaceConditionsHtml(
  map: maplibregl.Map,
  point: maplibregl.PointLike,
  geometry?: Geometry | null
): PlaceConditions {
  const rows: string[] = [];
  let hasWarning = false;
  let warningLabel: string | null = null;
  const region: QueryRegion = screenBoxForGeometry(map, geometry ?? null) ?? point;

  const drought = droughtRow(map, point);
  if (drought) rows.push(drought);

  const alerts = alertRows(map, region);
  rows.push(...alerts.rows);
  if (alerts.hasWarning) {
    hasWarning = true;
    warningLabel ??= alerts.warningLabel;
  }

  const fire = fireRow(map, region);
  if (fire) {
    rows.push(fire.row);
    if (fire.hasWarning) {
      hasWarning = true;
      warningLabel ??= fire.warningLabel;
    }
  }

  const body =
    rows.length > 0
      ? rows.join('')
      : conditionRow(
          'Conditions',
          // vocab-allow: names the layer this card checked (src/layers/nws-alerts.ts), matching that layer's own name; not a DDM-computed judgement
          'No condition layer (drought, NWS alerts, or wildfire perimeters) is currently active on the map.'
        );

  return { html: `<div class="popup-conditions">${body}</div>`, hasWarning, warningLabel };
}
