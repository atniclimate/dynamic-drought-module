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
 *
 * ATTRIBUTION FIX (2026-09-10, Codex adversarial review finding 3). The box
 * above is the right RETRIEVAL shape and the wrong ATTRIBUTION shape. A
 * rectangle drawn around a concave place also contains ground that is not
 * that place: the notch of a coastline, a hole, the gap between two
 * components of a MultiPolygon. Until this fix a Red Flag Warning lying
 * wholly OUTSIDE a boundary but inside its rectangle was reported as that
 * place's warning AND pulsed its briefing door, which is the emphasis
 * amendment A2 gates on real issuer evidence AT the clicked place. The box
 * is still what retrieves candidates, because the reachability finding
 * above has not changed; every candidate is then intersected against the
 * clicked feature's own geometry in memory (`geometriesOverlap`,
 * `src/util/polygon-overlap.ts`) and the ones that do not touch the place
 * are dropped. Nothing is persisted and no polygon is redistributed. The
 * rows say "in this area" rather than "here" so the reader knows the claim
 * is place-wide and not a reading at the clicked pixel; the bare-point
 * fallback, which cannot be place-scoped, keeps saying "here" because for
 * it that is the true scope.
 *
 * TYPED ROWS (S30D D1 M24; DDM-P11-T04; design record
 * interface-chrome-popups-text.md 3.5, "The Conditions block"). The block
 * returns value rows for the popup frame (src/ui/popup-frame.ts), one per
 * condition, each with its own words naming its own issuer, and a clock
 * only where the read feature carries the issuer's own date (NADM's
 * consensus month, USDM's map date); no date is fabricated. Which rows
 * exist is the cluster table's (`placeConditionRow`, DR-113,
 * src/config/place-condition-rows.ts): the block enumerates every
 * cluster's declared row and lists one whenever its layer is on, in table
 * order, so no mode literal and no literal layer list live here.
 */
import type * as maplibregl from 'maplibre-gl';
import type { GeoJsonProperties, Geometry } from 'geojson';

import { registry } from '../state/registry';
import { timeline } from '../state/timeline';
import { getHazardCluster } from '../state/cluster-store';
import { USDM_CATEGORIES, NADM_CATEGORIES } from '../config/palette';
import { HAZARD_CLUSTERS, HAZARD_CLUSTER_KEYS } from '../config/clusters';
import { getLayerDef } from '../config/layers';
import { PLACE_CONDITION_ROW_DEFERRED, PLACE_CONDITION_ROWS, placeConditionRowKeys } from '../config/place-condition-rows';
import type { PlaceConditionRowKey } from '../config/place-condition-rows';
import { classifyNifcIncidentType } from '../config/wildfire-presentation';
import type { LayerStatus } from '../types/layer';
import { normalizeNadmYearMonth } from '../util/nadm-collection';
import { geometriesOverlap } from '../util/polygon-overlap';
import { dateTok } from '../util/text-tokens';
import type { PopupClock, SixStateWord, ValueRow } from './popup-frame';
import { SUPPLIED_TIME_EXPLANATION } from './popups';
import { isChecked } from './island/bridge';

/** A `queryRenderedFeatures` region: a bare point, or a screen-space box. */
type QueryRegion = maplibregl.PointLike | [maplibregl.PointLike, maplibregl.PointLike];

/**
 * How far a row's claim reaches. `area` is the clicked place's own extent,
 * used whenever the caller gave a polygon and the box query ran; `point` is
 * the bare click pixel, the fallback when there is no polygon to scope to.
 * The two are never blurred: a place-wide read must not be read as a
 * measurement at the pixel, and a pixel read must not be inflated into a
 * statement about a whole place.
 */
type ClaimScope = 'area' | 'point';

/** The words each scope is allowed to use, so no row invents its own. */
function scopePhrase(scope: ClaimScope): string {
  return scope === 'area' ? 'in this area' : 'here';
}

/**
 * The candidates a box query retrieved, narrowed to those that actually touch
 * the clicked place (the ATTRIBUTION FIX in this module's header). `place` is
 * null for the bare-point fallback, where the query was already exact and
 * there is no polygon to intersect against, so nothing is dropped.
 */
function touchingPlace<T extends { geometry?: Geometry | null }>(
  feats: readonly T[],
  place: Geometry | null
): readonly T[] {
  if (place === null) return feats;
  return feats.filter((f) => geometriesOverlap(place, f.geometry ?? null));
}

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

/**
 * Whether a switched-on layer holds a COMPLETE read (draft DR-179): its
 * registry status is one of the two verified complete values, `ready` (the
 * service answered in full) or `no-data` (it answered with nothing, a verified
 * absence; AGENTS.md rule 6). Read through that whitelist: `loading`,
 * `degraded` ("live (partial)", a truncated answer), `error` (a failed read or
 * refresh, which can keep the old fill on the map) and a status not yet
 * written are all incomplete, and an incomplete read never answers for an
 * absence. Completeness is kept apart from presence: a row can report a
 * condition its partial read did find, and still not be complete.
 */
function isReadComplete(key: string): boolean {
  const status = registry.getStatus(key);
  return status === 'ready' || status === 'no-data';
}

/** The six layer-state words (popup-frame.ts SixStateWord) for each registry status, the sidebar's own mapping (src/ui/island/pill-text.ts). */
const STATE_WORD: Readonly<Record<LayerStatus, SixStateWord>> = {
  loading: 'loading',
  ready: 'live',
  degraded: 'live (partial)',
  error: 'unavailable',
  'no-data': 'no data',
  'zoom-in': 'zoom in to load'
};

/**
 * The row for a switched-on drought or wildfire layer whose read here is not
 * complete and found nothing present: the layer's own name as the sidebar
 * shows it (src/config/layers.ts) and its six-state word, never an absence
 * sentence (no such layer has a sentence of its own for this state; the NWS
 * row keeps its three). A status not yet written reads 'loading', as the
 * map key's chip reads it (src/config/chip-state.ts).
 */
function unreadRow(label: string, key: string): MarkedRow {
  const status = registry.getStatus(key);
  return {
    row: { label, text: getLayerDef(key)?.name ?? label, state: status === undefined ? 'loading' : STATE_WORD[status] },
    present: false,
    complete: false
  };
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
  /**
   * The head's ONE value line (the frame's value slot): the labels of the
   * conditions present at the place, or the block's sentence when none is
   * (the owner's "present-only head", 2026-10-01).
   */
  readonly head: readonly [ValueRow];
  /**
   * Every condition row, in table order, for the frame's body conditions
   * slot; empty when no condition layer is listed. Each row's text names its
   * own issuer.
   */
  readonly rows: readonly ValueRow[];
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
   * null when `hasWarning` is false. Since D1 M24 the door no longer
   * prints it (one label in every mode; src/ui/popup-frame.ts DoorSpec):
   * the condition's own words stand in the value row that earned it, so
   * colour is still never the only carrier (accessibility clause d). The
   * first one found when more than one warning-tier condition covers the
   * point.
   */
  readonly warningLabel: string | null;
}

/**
 * The explanation the owner approved on 2026-10-01 for a time the issuer
 * supplied that DDM does not read as a full date (one copy, in
 * src/ui/popups.ts): the text is shown as supplied, never parsed into a
 * date it might not mean.
 */
const SUPPLIED_EXPLANATION = SUPPLIED_TIME_EXPLANATION;

/**
 * A rendered feature's property as text: a string as given, a finite number
 * in its plain form, anything else ''. Never `String()` on an arbitrary
 * value, which throws for `{ toString: null }` (rule C1; the Codex diff
 * review of D1 M24).
 */
function propText(value: unknown): string {
  if (typeof value === 'string') return value;
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

/** Missing, null or blank: an absence, never a supplied value. */
function isAbsent(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

/** The issuer's own value, kept as supplied (an object is shown as its JSON). */
function suppliedText(value: unknown): string {
  if (typeof value === 'string') return value;
  return typeof value === 'object' && value !== null ? (JSON.stringify(value) ?? String(value)) : String(value);
}

/**
 * NADM's consensus month from the read feature's `YEAR_MONTH` ("YYYYMM",
 * src/util/nadm-collection.ts `normalizeNadmYearMonth`), at month
 * precision; the label is the NADM popup's own (src/layers/nadm-drought.ts
 * "Consensus month"). Absent: no clock. Present but not a valid YYYYMM:
 * shown as supplied, never parsed.
 */
function nadmMonthClock(raw: unknown): PopupClock | undefined {
  if (isAbsent(raw)) return undefined;
  const month = normalizeNadmYearMonth(raw);
  return {
    kind: 'point',
    meaning: 'month',
    label: 'Consensus month',
    at:
      month === null
        ? { precision: 'supplied', text: suppliedText(raw), explanation: SUPPLIED_EXPLANATION }
        : { precision: 'month', month }
  };
}

/**
 * USDM's `MapDate` (milliseconds since the epoch, as the FeatureServer
 * emits it; src/layers/usdm.ts `formatDate`) as a UTC calendar date, the
 * day the USDM popup itself shows under "Map date". Absent: no clock.
 * Anything that is not a finite epoch inside the four-digit years: shown
 * as supplied.
 */
function usdmMapDateClock(raw: unknown): PopupClock | undefined {
  if (isAbsent(raw)) return undefined;
  const ms =
    typeof raw === 'number' ? raw : typeof raw === 'string' && /^-?\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  const day = Number.isFinite(ms) ? new Date(ms) : null;
  const year = day === null ? NaN : day.getUTCFullYear();
  const date =
    day !== null && year >= 1000 && year <= 9999
      ? `${year}-${String(day.getUTCMonth() + 1).padStart(2, '0')}-${String(day.getUTCDate()).padStart(2, '0')}`
      : null;
  return {
    kind: 'point',
    meaning: 'map-date',
    label: 'Map date',
    at:
      date === null
        ? { precision: 'supplied', text: suppliedText(raw), explanation: SUPPLIED_EXPLANATION }
        : { precision: 'date', date }
  };
}

function readDm(props: GeoJsonProperties): number | null {
  if (!props) return null;
  const raw = props['DM'] ?? props['dm'];
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isInteger(n) ? n : null;
}

/** A row with its clock only when there is one (exact optional properties). */
function withClock(row: ValueRow, clock: PopupClock | undefined): ValueRow {
  return clock === undefined ? row : { ...row, clock };
}

/** The drought category beneath the clicked point, NADM preferred when its
 * layer is active (matches the conditions-strip's own precedence in
 * `src/ui/island/strip-metrics.ts` `droughtMetric`), else USDM. Omitted
 * entirely (returns null) when neither drought layer is on. A layer that is
 * on but has no fill yet, or whose read is not complete and found no
 * category here, gives its state row, never an absence (draft DR-179). */
function droughtRow(map: maplibregl.Map, point: maplibregl.PointLike): MarkedRow | null {
  if (isLayerOn(NADM_KEY)) {
    if (!map.getLayer(NADM_FILL)) return unreadRow('Drought', NADM_KEY);
    const complete = isReadComplete(NADM_KEY);
    const feats = map.queryRenderedFeatures(point, { layers: [NADM_FILL] });
    let maxIndex = -1;
    let maxProps: GeoJsonProperties = null;
    for (const f of feats) {
      const raw = propText(f.properties?.['DROUGHTCAT']).toUpperCase();
      const index = NADM_CATEGORIES.findIndex((c) => c.code === raw);
      if (index > maxIndex) {
        maxIndex = index;
        maxProps = f.properties ?? null;
      }
    }
    const category = maxIndex >= 0 ? NADM_CATEGORIES[maxIndex] : undefined;
    if (category) {
      return reported(
        withClock(
          {
            label: 'Drought',
            text: `${category.code} ${category.label} (North American Drought Monitor)`
          },
          nadmMonthClock(maxProps?.['YEAR_MONTH'])
        ),
        complete
      );
    }
    return complete
      ? unreported({ label: 'Drought', text: 'No drought category polygon here (North American Drought Monitor).' }, true)
      : unreadRow('Drought', NADM_KEY);
  }

  if (isLayerOn(USDM_KEY)) {
    const complete = isReadComplete(USDM_KEY);
    // The change register displays `usdm-change-fill` and HIDES both frame
    // slots (src/layers/usdm.ts, showChange), while leaving the slot layers
    // in the style. Querying the slots in that mode therefore returns nothing
    // for a place that plainly has a rendered change polygon, and the
    // absence branch below would report that as "no category here", which is
    // a statement about the ground rather than about which register is on
    // screen. Named as a register, following the mode-aware precedent in
    // src/ui/island/strip-metrics.ts: no absolute category is invented from
    // change data, and no absence is claimed from a hidden layer.
    if (timeline.usdmMode !== 'absolute') {
      // The register note establishes neither presence nor absence (the
      // card read no current category here), so it never counts as a
      // complete read: it can never select "Nothing mapped here" (the Codex
      // review of dbf5e1fa, P2 1).
      return unreported(
        {
          label: 'Drought',
          text: 'The map is showing the U.S. Drought Monitor change register, so no current category is displayed at this point.'
        },
        false
      );
    }
    const presentFills = USDM_FILLS.filter((id) => map.getLayer(id));
    if (presentFills.length === 0) return unreadRow('Drought', USDM_KEY);
    const feats = map.queryRenderedFeatures(point, { layers: [...presentFills] });
    let maxDm = -1;
    let maxProps: GeoJsonProperties = null;
    for (const f of feats) {
      const dm = readDm(f.properties);
      // Only a D0-D4 index is a category; any other DM is not one, so a
      // switched-on layer always answers a row (never the nothing-on line).
      if (dm !== null && dm < USDM_CATEGORIES.length && dm > maxDm) {
        maxDm = dm;
        maxProps = f.properties ?? null;
      }
    }
    const cat = maxDm >= 0 ? USDM_CATEGORIES[maxDm] : undefined;
    if (cat === undefined) {
      return complete
        ? unreported(
            {
              label: 'Drought',
              text: 'No D0-D4 category polygon here (U.S. Drought Monitor). This client has no analyzed-area mask, so this does not confirm no drought.'
            },
            true
          )
        : unreadRow('Drought', USDM_KEY);
    }
    return reported(
      withClock(
        { label: 'Drought', text: `${cat.code} ${cat.label} (U.S. Drought Monitor, NDMC/NOAA/USDA)` },
        usdmMapDateClock(maxProps?.['MapDate'] ?? maxProps?.['mapDate'])
      ),
      complete
    );
  }

  return null;
}

/**
 * The confirmed-zero sentence, scoped to what was actually asked for. The
 * layer requests seven products only (`ALERT_EVENTS` in
 * `src/layers/nws-alerts.ts`: the Extreme and Excessive Heat Warnings and
 * Watches, the Heat Advisory, the Red Flag Warning and the Fire Weather
 * Watch), so the older sentence, "No active NWS watch, warning, or advisory
 * here", spoke past its own evidence: a place under an active Flash Flood
 * Warning was told there was nothing. This says what was checked, in the
 * same limited sense the layer's own legend already uses ("No active
 * requested National Weather Service products", `nws-alerts.ts`).
 */
function noRequestedAlert(scope: ClaimScope): string {
  // vocab-allow: names the NWS watch/warning/advisory product category (src/layers/nws-alerts.ts), scoped to the products this layer requests
  return `No active NWS heat or fire weather watch, warning, or advisory ${scopePhrase(scope)}. Only those products are requested.`;
}

/** The NWS product name this app already requests (see
 * `src/layers/nws-alerts.ts` `ALERT_EVENTS`): true only for the
 * "Warning"-tier products, never a Watch or an Advisory. */
function isNwsWarningTier(prodType: string): boolean {
  return /warning$/i.test(prodType.trim());
}

/**
 * A row as its builder made it, with two separate marks. `present`: whether it
 * REPORTS something at the place (a drought category, an active alert, a
 * touching perimeter); an absence, a register note or a not-read state is
 * never present (the owner's "present-only head", 2026-10-01). `complete`:
 * whether the layer it read holds a complete read here (`isReadComplete`; no
 * fill in the style is never complete), apart from presence (draft DR-179).
 * The builder that writes the row marks both; nothing downstream parses a
 * row's text to decide.
 */
interface MarkedRow {
  readonly row: ValueRow;
  readonly present: boolean;
  readonly complete: boolean;
}

/** A row that reports a condition at the place. */
function reported(row: ValueRow, complete: boolean): MarkedRow {
  return { row, present: true, complete };
}

/** A row that reports no condition at the place (an absence, a register note, a not-read state). */
function unreported(row: ValueRow, complete: boolean): MarkedRow {
  return { row, present: false, complete };
}

/** One row builder's answer: its rows (possibly none) and its warning. */
interface RowResult {
  readonly rows: readonly MarkedRow[];
  readonly hasWarning: boolean;
  readonly warningLabel: string | null;
}

const NO_ROWS: RowResult = { rows: [], hasWarning: false, warningLabel: null };

/** Every distinct active NWS alert polygon covering the clicked point
 * (fire-weather and heat share one layer, distinguished by `prod_type`),
 * each its own row so a Heat Advisory and a Red Flag Warning covering the
 * same point are never collapsed into one line. Omitted entirely when the
 * alerts layer is off; a confirmed zero (layer on, nothing here) renders
 * one honest "none" row. */
function alertRows(
  map: maplibregl.Map,
  region: QueryRegion,
  place: Geometry | null,
  scope: ClaimScope
): RowResult {
  if (!isLayerOn(ALERTS_KEY)) {
    return NO_ROWS;
  }
  // Switched on with no fill in the style yet (the first read has not
  // arrived): nothing was read here, so the state sentence below answers,
  // never the nothing-on line (the Codex review of round 1, B2).
  const hasFill = Boolean(map.getLayer(ALERTS_FILL));
  const complete = hasFill && isReadComplete(ALERTS_KEY);

  // Retrieved by the place's box, kept only where the alert actually touches
  // the place: see the ATTRIBUTION FIX in this module's header.
  const feats = hasFill ? touchingPlace(map.queryRenderedFeatures(region, { layers: [ALERTS_FILL] }), place) : [];
  const seen = new Map<string, { prodType: string; ends: unknown }>();
  for (const f of feats) {
    const prodType = propText(f.properties?.['prod_type']).trim();
    if (prodType === '') continue;
    const endsRaw: unknown = f.properties?.['ends'] ?? f.properties?.['expiration'] ?? null;
    seen.set(prodType, { prodType, ends: endsRaw });
  }

  if (seen.size === 0) {
    // An empty rendered query is not evidence of absence unless the layer
    // actually holds a complete, current read. The refresh-failure path
    // clears the displayed snapshot and reports `error` while KEEPING the
    // fill layer and the active key (src/layers/nws-alerts.ts), and a
    // response that hit its transfer limit reports `degraded`; in both
    // states the old branch turned "we do not know" into "there is nothing
    // here". The six layer states are named instead, and none of them is a
    // claim about the ground.
    const status = registry.getStatus(ALERTS_KEY);
    // 'no-data' is a CONFIRMED zero: the service answered and published
    // nothing, which is exactly the state an absence sentence is for. Only
    // the states that mean "not read" (loading, live partial, unavailable)
    // withhold the claim, and so does a layer with no fill yet.
    if (!complete) {
      const where = scopePhrase(scope);
      const value =
        status === 'loading'
          ? `Still loading, so this card cannot say whether one is active ${where}.`
          : status === 'degraded'
            ? `The response was incomplete, so this card cannot rule one out ${where}.`
            : `Unavailable, so this card cannot say whether one is active ${where}.`;
      // vocab-allow: names the NWS watch/warning/advisory product category (src/layers/nws-alerts.ts), matching that module's own description
      return { rows: [unreported({ label: 'NWS alert', text: value }, false)], hasWarning: false, warningLabel: null };
    }
    return {
      // The absence must not reach further than the query did. This layer
      // asks for seven products only (ALERT_EVENTS in src/layers/nws-alerts.ts:
      // the Extreme and Excessive Heat Warnings and Watches, Heat Advisory,
      // Red Flag Warning and Fire Weather Watch), so a place under an active
      // Flash Flood Warning would have been told, wrongly, that no NWS watch,
      // warning or advisory was in force. The sentence now says what was
      // actually checked, in the same limited sense the layer's own legend
      // already uses ("No active requested National Weather Service
      // products", nws-alerts.ts).
      // vocab-allow: names the NWS watch/warning/advisory product category (src/layers/nws-alerts.ts), matching that module's own description, and scopes the absence to the products actually requested
      rows: [unreported({ label: 'NWS alert', text: noRequestedAlert(scope) }, true)],
      hasWarning: false,
      warningLabel: null
    };
  }

  let hasWarning = false;
  let warningLabel: string | null = null;
  const rows = [...seen.values()].map(({ prodType, ends }): MarkedRow => {
    if (isNwsWarningTier(prodType)) {
      hasWarning = true;
      warningLabel ??= prodType;
    }
    const until = formatWhen(ends);
    // The scope rides on the product name, so a reader is never left to assume
    // a place-wide read was taken at the pixel they clicked.
    const named = `${prodType} ${scopePhrase(scope)}`;
    const value = until.kind === 'instant' ? `${named}, until ${until.text} (NOAA NWS)` : `${named} (NOAA NWS)`;
    // vocab-allow: names the NWS alert product category (src/layers/nws-alerts.ts); the value is the issuer's own verbatim product name
    const row: ValueRow = { label: 'NWS alert', text: value };
    // A window end the issuer supplied in a form DDM does not read as a full
    // date is shown as supplied, with the approved explanation, never parsed
    // (the cover note's rule C1); the "Until" label is the NWS alert popup's
    // own (src/ui/popups.ts buildNwsAlertPopupHtml).
    // An active product at the place: a present row, from a complete read or not.
    return reported(
      until.kind === 'supplied'
        ? {
            ...row,
            clock: {
              kind: 'point',
              meaning: 'valid',
              label: 'Until',
              at: { precision: 'supplied', text: until.text, explanation: SUPPLIED_EXPLANATION }
            }
          }
        : row,
      complete
    );
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
    const s = propText(candidate).trim();
    if (s !== '') return s;
  }
  return 'Mapped fire perimeter';
}

/** A currently mapped NIFC WFIGS wildfire perimeter covering the clicked
 * point (never a prescribed-fire perimeter; the owning fill already
 * filters to WF/CX, and `classifyNifcIncidentType` re-checks defensively,
 * exactly as `strip-metrics.ts` `firesMetric` does). Omitted entirely when
 * the fires layer is off; a confirmed zero renders one honest "none"
 * row. A read that is not complete (no fill yet, still loading, a truncated
 * load reporting 'degraded' "live (partial)" at src/layers/nifc-fires.ts, or
 * unavailable) and found no perimeter here gives the layer's state row, never
 * that absence (draft DR-179). The fire names are a list, one item per name,
 * never one joined sentence (D1.md:145). */
function fireRow(
  map: maplibregl.Map,
  region: QueryRegion,
  place: Geometry | null,
  scope: ClaimScope
): RowResult {
  if (!isLayerOn(FIRES_KEY)) return NO_ROWS;
  if (!map.getLayer(FIRES_FILL)) return { rows: [unreadRow('Wildfire', FIRES_KEY)], hasWarning: false, warningLabel: null };
  const complete = isReadComplete(FIRES_KEY);

  // Retrieved by the place's box, kept only where the perimeter actually
  // touches the place: see the ATTRIBUTION FIX in this module's header.
  const feats = touchingPlace(
    map
      .queryRenderedFeatures(region, { layers: [FIRES_FILL] })
      .filter((f) => classifyNifcIncidentType(f.properties?.['attr_IncidentTypeCategory']) === 'wildfire'),
    place
  );

  if (feats.length === 0) {
    return {
      rows: [
        complete
          ? unreported({ label: 'Wildfire', text: `No mapped wildfire perimeter ${scopePhrase(scope)} (NIFC WFIGS).` }, true)
          : unreadRow('Wildfire', FIRES_KEY)
      ],
      hasWarning: false,
      warningLabel: null
    };
  }

  const names = [...new Set(feats.map((f) => pickIncidentName(f.properties)))];
  const row: ValueRow = { label: 'Wildfire', text: `Active mapped perimeter ${scopePhrase(scope)} (NIFC WFIGS)`, items: names };
  // The plain legend phrase this app already uses for a real WF/CX
  // perimeter (src/config/wildfire-presentation.ts NIFC_INCIDENT_PRESENTATION.wildfire.legendLabel), not a DDM-authored "warning" word.
  return { rows: [reported(row, complete)], hasWarning: true, warningLabel: 'Mapped wildfire perimeter' };
}

/** The days in a month of the proleptic Gregorian calendar (leap years respected). */
function daysInMonth(year: number, month: number): number {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

/** An ISO 8601 date and time WITH its zone or offset ("Z", "+hh:mm", "-hhmm"). */
const ZONED_ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * The instant an ISO 8601 timestamp with a zone or offset names, by
 * calendar validation and arithmetic (never `new Date()` on issuer text);
 * null for anything else, a zoneless timestamp included.
 */
function zonedIsoInstant(value: string): number | null {
  const match = ZONED_ISO.exec(value.trim());
  if (!match) return null;
  const [year, month, day, hour, minute] = [match[1], match[2], match[3], match[4], match[5]].map(Number) as [
    number,
    number,
    number,
    number,
    number
  ];
  const second = Number(match[6] ?? '0');
  const millis = Number((match[7] ?? '0').padEnd(3, '0').slice(0, 3));
  // A year below 1000 is not read: Date.UTC maps 0 to 99 onto 1900 to 1999,
  // so '0099-01-01T00:00:00Z' would print as 1999 (the Codex diff review). It
  // is kept as supplied text, the four-digit floor usdmMapDateClock keeps.
  if (year < 1000) return null;
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const zone = match[8] ?? 'Z';
  let offsetMinutes = 0;
  if (zone !== 'Z') {
    const hours = Number(zone.slice(1, 3));
    const minutes = Number(zone.slice(-2));
    if (hours > 23 || minutes > 59) return null;
    offsetMinutes = (zone.startsWith('-') ? -1 : 1) * (hours * 60 + minutes);
  }
  const at = Date.UTC(year, month - 1, day, hour, minute, second, millis) - offsetMinutes * 60_000;
  return Number.isFinite(at) ? at : null;
}

/**
 * An alert `ends`/`expiration` value as the card shows it. An ISO 8601
 * timestamp with its zone or offset, or the epoch milliseconds the layer
 * itself accepts as an issuer time (src/layers/nws-alerts.ts
 * `issuerTimeMs`), is an instant, written through `dateTok` with its zone
 * named; any other present value is kept as supplied (the card says so),
 * and an absent one is no window at all.
 */
function formatWhen(
  value: unknown
): { readonly kind: 'instant'; readonly text: string } | { readonly kind: 'supplied'; readonly text: string } | { readonly kind: 'none' } {
  if (isAbsent(value)) return { kind: 'none' };
  const at = typeof value === 'number' ? value : typeof value === 'string' ? zonedIsoInstant(value) : null;
  if (at !== null && isDateInstant(at)) return { kind: 'instant', text: dateTok(at) };
  return { kind: 'supplied', text: suppliedText(value) };
}

/** The largest epoch magnitude a JavaScript Date holds (ECMA-262 TimeClip), in milliseconds. */
const MAX_DATE_MS = 8.64e15;

/**
 * Whether epoch milliseconds name an instant a Date can hold. A finite number
 * outside that range (the Codex diff review's `1e20`) passes a finiteness
 * check and would make `dateTok` throw on an Invalid Date, so it is kept as
 * supplied text instead (rule C1), never formatted.
 */
function isDateInstant(ms: number): boolean {
  return Number.isFinite(ms) && Math.abs(ms) <= MAX_DATE_MS && !Number.isNaN(new Date(ms).getTime());
}

/** Where a row builder reads (see `buildPlaceConditionsHtml` below). */
interface RowContext {
  readonly map: maplibregl.Map;
  readonly point: maplibregl.PointLike;
  readonly region: QueryRegion;
  readonly place: Geometry | null;
  readonly scope: ClaimScope;
}

/** Each declared row's label, as its builder writes it (a row key with no label fails tsc). */
const ROW_LABEL: Readonly<Record<PlaceConditionRowKey, string>> = {
  drought: 'Drought',
  // vocab-allow: names the NWS alert product category (src/layers/nws-alerts.ts), the alert rows' own label
  'nws-alerts': 'NWS alert',
  'wildfire-perimeter': 'Wildfire'
};

/** One builder per declared row (a row key with no builder fails tsc). */
const ROW_BUILDERS: Readonly<Record<PlaceConditionRowKey, (context: RowContext) => RowResult>> = {
  drought: ({ map, point }) => {
    const row = droughtRow(map, point);
    return row === null ? NO_ROWS : { rows: [row], hasWarning: false, warningLabel: null };
  },
  'nws-alerts': ({ map, region, place, scope }) => alertRows(map, region, place, scope),
  'wildfire-perimeter': ({ map, region, place, scope }) => fireRow(map, region, place, scope)
};

/**
 * Build the Conditions rows for a boundary popup at the clicked screen
 * point. `point` is the click's screen-pixel position, used point-exact
 * for drought (matching `fire-context.ts`'s convention: a boundary always
 * outranks the lowest-ranked `condition-surface` kind, so the exact pixel
 * is always reachable there). `geometry` is the CLICKED FEATURE's own
 * GeoJSON geometry, when the caller has it; alerts and fires are read
 * against ITS screen-space bounding box instead of the bare point (see the
 * REACHABILITY FINDING in this module's header) so that a real warning
 * covering the place, not only the exact pixel, is not missed, and are
 * then intersected against that same geometry so that a warning inside the
 * box but outside the place is not attributed to it (see the ATTRIBUTION
 * FIX). Falls back to the bare point when no geometry is given or it is
 * not a polygon, in which case the rows say "here" because the pixel is
 * then the whole of what was read. The name is kept for its six callers;
 * the result is typed rows for the popup frame (D1 M24).
 */
export function buildPlaceConditionsHtml(
  map: maplibregl.Map,
  point: maplibregl.PointLike,
  geometry?: Geometry | null
): PlaceConditions {
  const rowsByKey: (readonly MarkedRow[])[] = [];
  let hasWarning = false;
  let warningLabel: string | null = null;
  // The box and the polygon it was drawn around travel together: the box
  // retrieves, the polygon attributes. When there is no box there is no
  // polygon to attribute against either, and the bare-point read is already
  // exact, so `place` is null and the scope is the pixel.
  const box = screenBoxForGeometry(map, geometry ?? null);
  const region: QueryRegion = box ?? point;
  const place: Geometry | null = box === null ? null : (geometry ?? null);
  const scope: ClaimScope = place === null ? 'point' : 'area';

  // Every cluster's declared row, in table order (DR-113): the block is
  // mode-agnostic, so a row is listed whenever its layer is on.
  const rowKeys = placeConditionRowKeys(HAZARD_CLUSTERS, HAZARD_CLUSTER_KEYS);
  for (const key of rowKeys) {
    const result = ROW_BUILDERS[key]({ map, point, region, place, scope });
    rowsByKey.push(result.rows);
    if (result.hasWarning) {
      hasWarning = true;
      warningLabel ??= result.warningLabel;
    }
  }

  // A condition layer that was ASKED for and then failed to activate leaves
  // no rendered fill and no active key, so a card built only from rendered
  // rows would report "no condition layer is currently active" while the
  // sidebar shows one enabled and unavailable. That is the same overstatement
  // as a false all-clear, one level up: it describes the map rather than the
  // reader's own request. Named separately here, and never merged into the
  // genuinely-nothing-on case below. The layers checked are the declared
  // rows' own (PLACE_CONDITION_ROWS), never a second list kept here.
  const enabledButUnread = rowKeys.flatMap((key) => PLACE_CONDITION_ROWS[key].layerKeys).filter((key) => {
    if (isLayerOn(key) || !isChecked(key)) return false;
    const status = registry.getStatus(key);
    return status === 'error' || status === 'degraded';
  });

  // When other rows are listed, the head below promises each layer's state
  // in the body, so a layer asked for that failed to activate states its own
  // there, in table order: its sidebar name and its six-state word (the
  // unread-row pattern; the Codex review of dbf5e1fa, P2 2). With no other
  // row the head keeps its own "could not be read" sentence and lists none.
  const listed = rowsByKey.some((own) => own.length > 0);
  const rows: MarkedRow[] = rowKeys.flatMap((key, i) => {
    const own = rowsByKey[i] ?? [];
    if (!listed || own.length > 0) return own;
    return PLACE_CONDITION_ROWS[key].layerKeys
      .filter((layerKey) => enabledButUnread.includes(layerKey))
      .map((layerKey) => unreadRow(ROW_LABEL[key], layerKey));
  });

  // The head's ONE value line (the owner's "present-only head", 2026-10-01;
  // read completeness kept apart from presence, draft DR-179). In order:
  //   (a) the existing labels of the rows that report something at the
  //       place, in table order, each once;
  //   (b) nothing present, and every switched-on condition layer holds a
  //       complete read here: DDM's owner-approved statement;
  //   (c) nothing present, and a switched-on layer's read is loading,
  //       incomplete or unavailable (a layer with no fill yet included), or a
  //       layer asked for failed to activate beside the rows listed: the
  //       not-yet-read line;
  //   (d) no row listed at all: the block's existing sentences, each in its
  //       own case (a layer asked for and unread; nothing switched on).
  // A switched-on layer always lists a row, so (d)'s nothing-on sentence
  // never shows while one is on. Every row itself goes to the body, verbatim.
  const presentLabels = [
    ...new Set(rows.filter((marked) => marked.present).flatMap((marked) => (marked.row.label === undefined ? [] : [marked.row.label])))
  ];
  const everyReadComplete = enabledButUnread.length === 0 && rows.every((marked) => marked.complete);
  // A mode whose cluster declares no place row yet (DR-113: read from the
  // cluster table through the committed mode, never a mode name).
  // The interim line is for a DEFERRED row (draft DR-180): the committed
  // mode declares none and its deferral is recorded with its reason.
  const mode = getHazardCluster();
  const modeHasNoRow = HAZARD_CLUSTERS[mode].placeConditionRow === null && Object.hasOwn(PLACE_CONDITION_ROW_DEFERRED, mode);
  const head: readonly [ValueRow] =
    presentLabels.length > 0
      ? [{ text: presentLabels.join(' · ') }]
      : rows.length > 0
        ? everyReadComplete
          ? [{ text: "Nothing mapped here on the active condition layers; each layer's reading is below." }]
          : // DRAFT wording by the director, draft DR-179, pending the owner's
            // read-back (RATIFICATION-11 row 6, "Not sure"); verbatim as drafted.
            [{ text: "Not every condition layer has been read here yet; each layer's state is below." }]
        : enabledButUnread.length > 0
          ? [
              {
                label: 'Conditions',
                text: 'A condition layer is switched on but could not be read, so this card cannot describe conditions here.'
              }
            ]
          : modeHasNoRow
            ? [
                {
                  label: 'Conditions',
                  // DRAFT wording, draft DR-180, pending the owner's read-back:
                  // the interim line until the ocean sprint gives this mode its
                  // row; exactly as recorded, no period added.
                  text: 'No condition layer for this mode is currently active'
                }
              ]
            : [
                {
                  label: 'Conditions',
                  // vocab-allow: names the layer this card checked (src/layers/nws-alerts.ts), matching that layer's own name; not a DDM-computed judgement
                  text: 'No condition layer (drought, NWS alerts, or wildfire perimeters) is currently active on the map.'
                }
              ];

  return { head, rows: rows.map((marked) => marked.row), hasWarning, warningLabel };
}
