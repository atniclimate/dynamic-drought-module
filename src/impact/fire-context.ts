/**
 * Fire-in-context composition (0.4.0 unit B1).
 *
 * Clicking a current mapped NIFC fire perimeter composes existing reads for the
 * clicked location into the perimeter popup: the US Drought Monitor (USDM)
 * class beneath the point, and the nearest telemetry stations from the
 * station registry inside a fixed radius. Since S30D D1 M26a (DDM-P11-T04)
 * the reads are typed popup-frame rows (`readFireContext`): the drought class
 * is a value row with its own issuer and map date (plan_rules 3), the fuels
 * pointer a row, the stations a semantic list whose distances keep their
 * metres in a tooltip, and the closing statement a qualification.
 *
 * This unit COMPOSES only what is already on the map and in the registry. It
 * deliberately does NOT compute a conditions-based fire potential (drought plus
 * fuels plus weather into a hazard read). The sources stay separate, and the
 * fuels row is only an honest pointer to the separately labeled hazard context.
 *
 * Every branch is honest. When the USDM surface is off, the block says to turn
 * it on rather than inventing a class. When no D0 to D4 polygon covers the
 * point, the block reports that absence without inferring drought-free
 * conditions because this client has no analyzed-area mask. When no curated
 * station sits inside the station-list ceiling, the block says so rather than
 * ranking the whole registry and calling a gauge in another region
 * "nearest".
 */
import type * as maplibregl from 'maplibre-gl';
import type { GeoJsonProperties } from 'geojson';
import { USDM_CATEGORIES } from '../config/palette';
import { STATIC_TELEMETRY_STATION_REGISTRY, distanceMeters } from '../config/station-registry';
import type { ListItem, PopupClock, PopupDetail, ValueRow } from '../ui/popup-frame';
import { escapeHtml } from '../util/escape';
import { formatDistanceKm } from './point-heat-format';

/** The USDM frame-slot fill ids (0.5.0b scrubber; mirrors
 * src/ui/conditions-strip.ts). Only the visible slot matches a rendered
 * query, so the read is always the week actually on screen. */
const USDM_FILLS = ['usdm-frame-a-fill', 'usdm-frame-b-fill'] as const;

/** The USFS Wildfire Hazard Potential raster layer id (src/layers/usfs-whp.ts). */
const WHP_LAYER = 'usfs-whp';

/** How many nearest stations to name. */
const NEAREST_STATION_COUNT = 3;

/**
 * The distance ceiling for the nearest-station list.
 *
 * STATIC_TELEMETRY_STATION_REGISTRY is the curated Pacific Northwest set
 * (src/config/telemetry.ts), while the perimeter layer this block annotates
 * queries NATIONALLY (src/layers/nifc-fires.ts, `where=1=1`). Ranking with no
 * ceiling therefore handed a fire in Texas three Pacific Northwest gauges under
 * the heading "Nearest monitoring stations" (FIRE-17): a true statement about
 * the registry and a false one about the fire.
 *
 * Nothing in the registry or the layer implies a radius, so 50 miles (80 km) is
 * a DDM convention: roughly the distance within which a gauge is still
 * plausibly sampling the same weather as the perimeter. Past it the block
 * reports the absence instead of naming a station that explains nothing about
 * this fire.
 */
const NEAREST_STATION_MAX_MILES = 50;
const METERS_PER_MILE = 1609.344;
const NEAREST_STATION_MAX_METERS = NEAREST_STATION_MAX_MILES * METERS_PER_MILE;
const NEAREST_STATION_MAX_KM = Math.round(NEAREST_STATION_MAX_METERS / 1000);

/** The USDM issuer, as the U.S. Drought Monitor popup names it (src/layers/usdm.ts). */
const USDM_ISSUER = 'NDMC, NOAA, USDA';

const FIRE_CONTEXT_NOTE =
  // vocab-allow: honesty disclaimer, denies being a forecast
  'A read of separate current and long-term sources around this perimeter, not a fire forecast or a combined fire-risk class.';

/** The fire-in-context reads for one clicked perimeter, as popup-frame rows. */
export interface FireContext {
  /** The drought class beneath the click: a condition row with its own issuer and map date where a class is read. */
  readonly drought: ValueRow;
  /** The fuels pointer, then the nearest stations (a list, or the stated absence). */
  readonly details: readonly PopupDetail[];
  /** The closing statement: separate sources, no forecast, no combined class. */
  readonly note: string;
}

/**
 * Read the fire-in-context rows for a clicked perimeter. `point` is the click
 * position in screen pixels (for the point-precise USDM query); `lngLat` is
 * the geographic click position (for the nearest-station distances).
 */
export function readFireContext(
  map: maplibregl.Map,
  point: maplibregl.PointLike,
  lngLat: maplibregl.LngLat
): FireContext {
  return {
    drought: droughtBeneathRow(map, point),
    details: [fuelsRow(map), nearestStationsDetail(lngLat)],
    note: FIRE_CONTEXT_NOTE
  };
}

/**
 * The same reads as plain markup (the pre-frame "Fire in context" block),
 * kept only for tests/drought-semantics.spec.ts, which pins the drought
 * row's absence wording through it; the popup itself renders
 * `readFireContext` through the frame. No src module imports it.
 */
export function buildFireContextHtml(
  map: maplibregl.Map,
  point: maplibregl.PointLike,
  lngLat: maplibregl.LngLat
): string {
  const read = readFireContext(map, point, lngLat);
  const row = (label: string, text: string): string =>
    `<div class="fire-context-block"><span class="fire-context-label">${escapeHtml(label)}</span> <span class="fire-context-value">${escapeHtml(text)}</span></div>`;
  const details = read.details
    .map((detail) =>
      detail.kind === 'row'
        ? row(detail.label, detail.text)
        : detail.kind === 'list'
          ? `<div class="fire-context-block"><div class="fire-context-label">${escapeHtml(detail.label)}</div><ul class="fire-context-stations">${detail.items
              .map((item) => `<li>${escapeHtml(typeof item === 'string' ? item : `${item.text} ${item.qualifier?.text ?? ''}`.trim())}</li>`)
              .join('')}</ul></div>`
          : ''
    )
    .join('');
  return `<div class="fire-context">${row(read.drought.label ?? '', read.drought.text)}${details}<p class="fire-context-note">${escapeHtml(read.note)}</p></div>`;
}

/** The USDM class beneath the clicked point, or an honest off/none state. */
function droughtBeneathRow(map: maplibregl.Map, point: maplibregl.PointLike): ValueRow {
  const label = 'Drought beneath';
  const presentFills = USDM_FILLS.filter((id) => map.getLayer(id));
  if (presentFills.length === 0) {
    return { label, text: 'Turn on the US Drought Monitor to read the drought class here.' };
  }

  const feats = map.queryRenderedFeatures(point, { layers: [...presentFills] });
  let maxDm = -1;
  let maxProps: GeoJsonProperties = null;
  for (const f of feats) {
    const dm = readDm(f.properties);
    if (dm !== null && dm > maxDm) {
      maxDm = dm;
      maxProps = f.properties;
    }
  }

  if (maxDm < 0) {
    return {
      label,
      text: 'No D0-D4 polygon rendered here. This client has no analyzed-area mask here, so this does not confirm no drought.'
    };
  }

  const cat = maxDm < USDM_CATEGORIES.length ? USDM_CATEGORIES[maxDm] : undefined;
  if (!cat) return { label, text: 'Unknown', issuer: USDM_ISSUER, clock: mapDateClock(maxProps) };
  return {
    label,
    text: `${cat.code} ${cat.label}`,
    swatch: { table: 'USDM_CATEGORIES', classKey: cat.code, color: cat.color },
    issuer: USDM_ISSUER,
    clock: mapDateClock(maxProps)
  };
}

/**
 * The map date of the USDM week the class was read from (the rendered
 * feature's own `MapDate`, epoch milliseconds, read as a UTC calendar date
 * exactly as src/layers/usdm.ts reads it), or the unavailable statement.
 */
function mapDateClock(props: GeoJsonProperties): PopupClock {
  const raw: unknown = props?.['MapDate'] ?? props?.['mapDate'];
  const ms = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  const d = new Date(ms);
  if (!Number.isFinite(ms) || Number.isNaN(d.getTime()) || d.getUTCFullYear() < 1000) {
    return { kind: 'not-stated', label: 'Map date', reason: 'unavailable' };
  }
  const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  return { kind: 'point', meaning: 'map-date', label: 'Map date', at: { precision: 'date', date } };
}

/**
 * The fuels / hazard read. Wildfire Hazard Potential is a raster surface, so
 * its class cannot be read at a point in-browser without a verified identify
 * endpoint. This is an honest pointer: it reflects whether the WHP surface is
 * on and directs the eye to it, and never fakes a hazard class.
 */
function fuelsRow(map: maplibregl.Map): PopupDetail {
  return {
    kind: 'row',
    label: 'Fuels and hazard',
    text: map.getLayer(WHP_LAYER)
      ? 'Wildfire Hazard Potential is on; read the class from the shaded surface beneath this perimeter.'
      : 'Turn on Wildfire Hazard Potential to see the fuels hazard here.'
  };
}

/**
 * The nearest curated telemetry stations to the clicked point, inside
 * NEAREST_STATION_MAX_MILES and never beyond it, one list item per station.
 *
 * Distances read US customary first with the metric secondary (owner
 * decision 2026-08-31, PR 53), through the same formatter the point-heat
 * read uses so the two surfaces cannot drift; the raw metres the ranking
 * actually compared stay one hover away in the qualifier's title.
 */
function nearestStationsDetail(lngLat: maplibregl.LngLat): PopupDetail {
  const label = 'Nearest monitoring stations';
  const here: readonly [number, number] = [lngLat.lat, lngLat.lng];
  const ranked = STATIC_TELEMETRY_STATION_REGISTRY.map((entry) => ({
    name: entry.station.name,
    meters: distanceMeters(here, entry.station.coords)
  }))
    .filter((s) => s.meters <= NEAREST_STATION_MAX_METERS)
    .sort((a, b) => a.meters - b.meters)
    .slice(0, NEAREST_STATION_COUNT);

  const [first, ...rest] = ranked.map(
    (s): ListItem => ({
      text: s.name,
      qualifier: { text: formatDistanceKm(s.meters / 1000), title: `${Math.round(s.meters)} m from the clicked point` }
    })
  );
  if (first === undefined) {
    return {
      kind: 'row',
      label,
      text:
        `No station in the curated Pacific Northwest station registry is within ` +
        `${NEAREST_STATION_MAX_MILES} miles (${NEAREST_STATION_MAX_KM} km) of ` +
        `this perimeter. Other networks may operate nearer; this reports the ` +
        `registry, not the field.`
    };
  }
  return { kind: 'list', label, items: [first, ...rest] };
}

/** USDM drought category index (0 = D0 through 4 = D4) from feature properties. */
function readDm(props: GeoJsonProperties): number | null {
  if (!props) return null;
  const raw = props['DM'] ?? props['dm'];
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isInteger(n) ? n : null;
}
