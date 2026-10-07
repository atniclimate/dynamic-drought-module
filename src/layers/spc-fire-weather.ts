/**
 * Storm Prediction Center (SPC) Fire Weather Outlook, Day 1 (E2).
 *
 * Renders the SPC's categorical fire-weather threat forecast for today:
 * areas where pre-existing fuel dryness combines with forecast wind,
 * relative humidity, and dry lightning to favor fire spread. Categories are
 * Elevated, Critical, and Extreme, carried by the MapServer's integer `dn`
 * field (5, 8, 10) with no string sibling; the palette owns the value-to-
 * label mapping (`SPC_FIREWX_CATEGORIES`).
 *
 * Honest framing (verified source doctrine): this is fire-WEATHER threat,
 * not the National Fire Danger Rating System (NFDRS) fuel-dryness fire
 * danger rating, and not an active-fire product (that is `nifc-fires`). The
 * popup carries that framing verbatim.
 *
 * Source: `URLS.spcFireWeatherOutlookMapServer` layer 1 ("Day 1 Outlook");
 * verified 2026-07-01 (see urls.ts). An empty FeatureCollection is the
 * common good-news case (no elevated fire weather anywhere today) and
 * renders as `'no-data'`, never as an error; so does the issuer's own
 * "no area outlined" answer, one null-geometry feature with `dn` 0
 * (`readNoAreaAnswer`, D1 M5). Updated up to five times daily.
 *
 * Cancellation (the cancellation invariant): master abort controller
 * superseded on each `activate`, aborted on `deactivate`, fetch through
 * `fetchJsonWithBudget`, late responses dropped.
 */

import type * as maplibregl from 'maplibre-gl';
import type { FeatureCollection, GeoJsonProperties } from 'geojson';

import { URLS } from '../config/urls';
import { registerClickTarget } from '../map/interaction-coordinator';
import {
  SPC_FIREWX_CATEGORIES,
  SPC_FIREWX_DEFAULT_COLOR
} from '../config/palette';
import { matchExpression } from '../config/style-expressions';
import { parseArcGisPolygonFeatureCollection } from '../config/wildfire-presentation';
import type { IssuerSwatch } from '../ui/popup-frame';
import { buildSpcFireWeatherPopupModel } from '../ui/popups';
import { clearTimeBar, setTimeBar } from '../ui/time-bar';
import { fetchJsonWithBudget } from '../util/fetch';
import { registry } from '../state/registry';

const LAYER_KEY = 'spc-fire-weather';
const SOURCE_ID = 'spc-fire-weather';
const FILL_LAYER_ID = 'spc-fire-weather-fill';
const OUTLINE_LAYER_ID = 'spc-fire-weather-outline';

/** Fade targets for the sidebar's toggle transitions (LayerModule contract). */
export const fadeLayerIds = [FILL_LAYER_ID, OUTLINE_LAYER_ID] as const;

/** Day 1 categorical outlook layer ID on the MapServer (4 would be Day 2). */
const DAY1_LAYER_ID = 1;

/**
 * Symbol layer ID used as the `beforeId` anchor so outlook polygons stack
 * below the basemap label glyphs, matching the other polygon overlays.
 */
const BEFORE_ID = 'first-symbol';

/** Per-call network budget for the outlook query. */
const FETCH_TIMEOUT_MS = 15_000;

type Status = 'loading' | 'ready' | 'degraded' | 'error' | 'no-data';

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
 * The category's swatch, as the map draws it (SPC_FIREWX_CATEGORIES), or
 * null for a `dn` outside the outlook's categories (its label says so).
 */
function categorySwatch(dn: unknown): IssuerSwatch | null {
  const n = typeof dn === 'number' ? dn : Number(dn);
  const entry = SPC_FIREWX_CATEGORIES.find((c) => c.dn === n);
  return entry ? { table: 'SPC_FIREWX_CATEGORIES', classKey: String(entry.dn), color: entry.color } : null;
}

/** Resolve the display label for a `dn` category value. */
function categoryLabel(dn: unknown): string {
  const n = typeof dn === 'number' ? dn : Number(dn);
  const entry = SPC_FIREWX_CATEGORIES.find((c) => c.dn === n);
  // Surface an unknown value honestly rather than guessing a severity.
  return entry ? entry.label : `Category ${String(dn)}`;
}

function buildQueryUrl(): string {
  const params = new URLSearchParams({
    where: '1=1',
    outFields: 'dn,valid,expire',
    outSR: '4326',
    f: 'geojson'
  });
  return `${URLS.spcFireWeatherOutlookMapServer}/${DAY1_LAYER_ID}/query?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// The time statement (DDM-P8-T02)
// ---------------------------------------------------------------------------

/**
 * "Sep 8, 2026, 12:00 UTC" from the SPC `valid` / `expire` field
 * (`YYYYMMDDHHMM`, UTC). Pinned to UTC, unlike the popup's local-time
 * rendering, so the stamp reads the same for every viewer and matches the
 * other UTC-pinned stamps. Null when the field does not parse: the stamp
 * then says the period is not stated rather than printing a raw string.
 */
function spcMomentUtc(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{12}$/.test(value)) return null;
  const ms = Date.UTC(
    Number(value.slice(0, 4)),
    Number(value.slice(4, 6)) - 1,
    Number(value.slice(6, 8)),
    Number(value.slice(8, 10)),
    Number(value.slice(10, 12))
  );
  if (Number.isNaN(ms)) return null;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
    timeZoneName: 'short'
  }).format(new Date(ms));
}

/**
 * The issuer's "no area outlined" answer (D1 M5, 2026-09-27; found-002,
 * DDM-P1-T11). The SPC MapServer answers an issuance with no fire-weather
 * area as a FeatureCollection whose ONLY feature has a null geometry and
 * `dn` 0 (recorded 2026-09-26, REGISTER found-002), while still stating the
 * issuance's `valid` and `expire`. `dn` 0 is none of the outlook categories
 * (`SPC_FIREWX_CATEGORIES` holds 5, 8 and 10), so this is a verified
 * absence, `no-data`, not a failed read.
 *
 * Exactly that shape and nothing wider: no ArcGIS error envelope, no
 * transfer-limit flag, one feature, a `Feature` whose geometry is `null`
 * and whose properties carry the number 0 as `dn`. Anything else (a second
 * feature, a category with no geometry, an empty geometry object) returns
 * null here and goes to the shared parser, which reads it as unavailable.
 * Returns the answer's properties, whose `valid` and `expire` the stamp
 * then states.
 */
function readNoAreaAnswer(value: unknown): Readonly<Record<string, unknown>> | null {
  if (!isRecord(value) || Object.hasOwn(value, 'error')) return null;
  if (value['type'] !== 'FeatureCollection') return null;
  const flag = value['exceededTransferLimit'];
  if (flag !== undefined && flag !== false) return null;
  const collectionProperties = isRecord(value['properties']) ? value['properties'] : null;
  const nestedFlag = collectionProperties?.['exceededTransferLimit'];
  if (nestedFlag !== undefined && nestedFlag !== false) return null;
  const features = value['features'];
  if (!Array.isArray(features) || features.length !== 1) return null;
  const feature: unknown = features[0];
  if (!isRecord(feature) || feature['type'] !== 'Feature') return null;
  if (!Object.hasOwn(feature, 'geometry') || feature['geometry'] !== null) return null;
  const properties = feature['properties'];
  if (!isRecord(properties) || properties['dn'] !== 0) return null;
  return properties;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The Day 1 outlook stamp, the Wildfire screen's time statement at the
 * near-term horizon. The period is the issuer's own `valid` and `expire`
 * on the outlined areas (clause 3). An issuance with no outlined area is
 * the common good-news case: when the response is the issuer's no-area
 * answer (`readNoAreaAnswer`) the stamp states the period that answer
 * carries, and its detail borrows SPC's own phrase for that state, "No
 * Risk Areas Forecast" (from the Day 1 Fire Weather Outlook product page,
 * not from the MapServer's undocumented dn=0), rather than presenting the
 * service itself as defining that value (2026-09-27, found-079); when it
 * is a genuinely empty collection it carries no window, so the stamp says
 * the period is not stated (clause 4) and its detail says only that the
 * response carries no outlook area, not the no-area answer's own words.
 * The register is outlook, and the text says so in the issuer's product
 * name.
 */
function installTimeBar(
  features: FeatureCollection['features'],
  noArea: Readonly<Record<string, unknown>> | null
): void {
  const first = features[0]?.properties ?? noArea ?? null;
  const from = spcMomentUtc(first?.['valid']);
  const until = spcMomentUtc(first?.['expire']);
  const headline =
    from !== null && until !== null
      ? `Outlook valid ${from} to ${until}`
      : from !== null
        ? `Outlook valid from ${from}`
        : 'Outlook · valid period not stated by the response';
  const detail =
    features.length > 0
      ? 'NOAA SPC Day 1 Fire Weather Outlook · an outlook of fire-weather conditions favorable for fire spread, not a fire danger rating and not an active fire'
      : noArea !== null
        ? // vocab-allow: verbatim SPC term for this state, from its Day 1 Fire Weather Outlook product page (2026-09-27, found-079)
          'NOAA SPC Day 1 Fire Weather Outlook · No Risk Areas Forecast (DDM\'s reading of the service\'s no-area response, using SPC\'s own term for this state from its Day 1 Fire Weather Outlook page)'
        : 'NOAA SPC Day 1 Fire Weather Outlook · the response contains no outlook area';
  setTimeBar(LAYER_KEY, {
    ariaLabel: 'SPC Day 1 Fire Weather Outlook valid period',
    stamp: {
      horizon: 'nearTerm',
      headline,
      detail,
      register: 'outlook'
    }
  });
}

/**
 * Fetch today's outlook and add the source plus fill and outline layers.
 * Idempotent. Empty FeatureCollection renders as `'no-data'` (no elevated
 * fire weather anywhere today; common and legitimate), and so does the
 * issuer's no-area answer (`readNoAreaAnswer`), which draws nothing.
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
  let truncated = false;
  let noArea: Readonly<Record<string, unknown>> | null = null;
  try {
    const body = await fetchJsonWithBudget(
      buildQueryUrl(),
      null,
      signal,
      FETCH_TIMEOUT_MS
    );
    // The issuer's own "no area outlined" answer is read here, at the call
    // site, before the shared parser (which keeps rejecting every null
    // geometry for NIFC, HMS, and every other SPC body).
    noArea = readNoAreaAnswer(body);
    if (noArea !== null) {
      geojson = { type: 'FeatureCollection', features: [] };
    } else {
      const parsed = parseArcGisPolygonFeatureCollection(
        body,
        'NOAA SPC fire-weather outlook'
      );
      geojson = parsed.collection;
      truncated = parsed.truncated;
    }
  } catch (err) {
    // Aborted means superseded or deactivated; drop silently per invariant 5.
    if (signal.aborted) return;
    console.warn('[spc-fire-weather] outlook fetch failed.', err);
    reportStatus('error');
    return;
  }

  // A late response to a torn-down activation must not render.
  if (signal.aborted) return;

  const features = geojson?.features ?? [];

  map.addSource(SOURCE_ID, {
    type: 'geojson',
    data: geojson,
    attribution: 'NOAA SPC'
  });

  // The outlook is the displayed surface from here on, outlined areas or
  // none; its time statement stands for both.
  installTimeBar(features, noArea);

  if (features.length === 0) {
    reportStatus(truncated ? 'degraded' : 'no-data');
    return;
  }

  const beforeId = resolveBeforeId(map);

  // Color by category via a `match` expression on the integer `dn` field.
  // `matchExpression` does the head-pair/tail split the Style Spec tuple type
  // requires. For every non-empty palette, and so for SPC_FIREWX_CATEGORIES as
  // shipped, the emitted array is the same one the older cast-and-spread form
  // produced; for an empty palette the two disagree and both are invalid, so
  // the helper throws instead of emitting either.
  const colorExpression = matchExpression(
    ['get', 'dn'],
    SPC_FIREWX_CATEGORIES.map((c) => [c.dn, c.color] as const),
    SPC_FIREWX_DEFAULT_COLOR,
    'SPC_FIREWX_CATEGORIES'
  );

  map.addLayer(
    {
      id: FILL_LAYER_ID,
      type: 'fill',
      source: SOURCE_ID,
      paint: {
        'fill-color': colorExpression,
        'fill-opacity': 0.3
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
        'line-color': colorExpression,
        'line-width': 1.2,
        'line-opacity': 0.9
      }
    },
    beforeId
  );

  if (truncated) {
    console.warn(
      '[spc-fire-weather] outlook response reached the ArcGIS transfer limit; rendering available categories as live (partial).'
    );
  }
  reportStatus(truncated ? 'degraded' : 'ready');
}

/**
 * Abort any in-flight fetch and remove the fill, outline, and source. All
 * guards are defensive so callers can invoke `deactivate` without first
 * verifying activation state.
 */
export function cancelActivation(): void {
  masterController?.abort();
}

export function deactivate(map: maplibregl.Map): void {
  cancelActivation();
  masterController = null;
  if (map.getLayer(FILL_LAYER_ID)) map.removeLayer(FILL_LAYER_ID);
  if (map.getLayer(OUTLINE_LAYER_ID)) map.removeLayer(OUTLINE_LAYER_ID);
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
  clearTimeBar(LAYER_KEY);
}

/**
 * Register the fill layer's click target with the InteractionCoordinator
 * (one response per click; D-0.7.0-058 ruling 5) and wire the hover
 * cursor affordance. Bound once on first activation.
 */
export function bindPopups(map: maplibregl.Map): void {
  registerClickTarget({
    // A Day 1 outlook polygon is a broad condition surface (LAYER_DEFS
    // role: 'surface'), not a direct point target: ranked last so it
    // never blankets sovereign geography (the precedence table's stated
    // rationale; corrected from 'point-event' at the 2026-07-17
    // adversarial pass, finding 4).
    kind: 'condition-surface',
    layerIds: [FILL_LAYER_ID],
    label: (feature) => `${categoryLabel(feature.properties?.['dn'])} fire weather`,
    // The outlook polygon's frame model (S30D D1 M26b), painted by the
    // coordinator.
    respond: (feature) => {
      const props: GeoJsonProperties = feature.properties ?? null;
      return {
        model: buildSpcFireWeatherPopupModel(categoryLabel(props?.dn), props, categorySwatch(props?.dn))
      };
    }
  });

  map.on('mouseenter', FILL_LAYER_ID, () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', FILL_LAYER_ID, () => {
    map.getCanvas().style.cursor = '';
  });
}
