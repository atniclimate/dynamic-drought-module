/**
 * Fire-in-context composition (0.4.0 unit B1).
 *
 * Clicking a current mapped NIFC fire perimeter composes existing reads for the
 * clicked location into a short "Fire in context" block appended to the
 * perimeter popup: the US Drought Monitor (USDM) class beneath the point, and
 * the nearest telemetry stations from the station registry inside a fixed
 * radius.
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
import * as maplibregl from 'maplibre-gl';
import type { GeoJsonProperties } from 'geojson';
import { USDM_CATEGORIES } from '../config/palette';
import { STATIC_TELEMETRY_STATION_REGISTRY, distanceMeters } from '../config/station-registry';
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

/**
 * Build the "Fire in context" HTML block for a clicked perimeter. `point` is
 * the click position in screen pixels (for the point-precise USDM query);
 * `lngLat` is the geographic click position (for the nearest-station distances).
 */
export function buildFireContextHtml(
  map: maplibregl.Map,
  point: maplibregl.PointLike,
  lngLat: maplibregl.LngLat
): string {
  // vocab-allow: honesty disclaimer, denies being a forecast
  return `
    <div class="fire-context">
      <div class="fire-context-heading">Fire in context</div>
      ${droughtBeneathRow(map, point)}
      ${fuelsRow(map)}
      ${nearestStationsBlock(lngLat)}
      <p class="fire-context-note">A read of separate current and long-term sources around this perimeter, not a fire forecast or a combined fire-risk class.</p>
    </div>`;
}

/** The USDM class beneath the clicked point, or an honest off/none state. */
function droughtBeneathRow(map: maplibregl.Map, point: maplibregl.PointLike): string {
  const presentFills = USDM_FILLS.filter((id) => map.getLayer(id));
  if (presentFills.length === 0) {
    return contextRow(
      'Drought beneath',
      'Turn on the US Drought Monitor to read the drought class here.'
    );
  }

  const feats = map.queryRenderedFeatures(point, { layers: [...presentFills] });
  let maxDm = -1;
  for (const f of feats) {
    const dm = readDm(f.properties);
    if (dm !== null && dm > maxDm) maxDm = dm;
  }

  if (maxDm < 0) {
    return contextRow(
      'Drought beneath',
      'No D0-D4 polygon rendered here. This client has no analyzed-area mask here, so this does not confirm no drought.'
    );
  }

  const cat = maxDm < USDM_CATEGORIES.length ? USDM_CATEGORIES[maxDm] : undefined;
  return contextRow('Drought beneath', cat ? `${cat.code} ${cat.label}` : 'Unknown');
}

/**
 * The fuels / hazard read. Wildfire Hazard Potential is a raster surface, so
 * its class cannot be read at a point in-browser without a verified identify
 * endpoint. This is an honest pointer: it reflects whether the WHP surface is
 * on and directs the eye to it, and never fakes a hazard class.
 */
function fuelsRow(map: maplibregl.Map): string {
  return map.getLayer(WHP_LAYER)
    ? contextRow(
        'Fuels and hazard',
        'Wildfire Hazard Potential is on; read the class from the shaded surface beneath this perimeter.'
      )
    : contextRow(
        'Fuels and hazard',
        'Turn on Wildfire Hazard Potential to see the fuels hazard here.'
      );
}

/**
 * The nearest curated telemetry stations to the clicked point, inside
 * NEAREST_STATION_MAX_MILES and never beyond it.
 *
 * Distances read US customary first with the metric secondary (owner
 * decision 2026-08-31, PR 53), through the same formatter the point-heat
 * read uses so the two surfaces cannot drift; the raw metres the ranking
 * actually compared stay one hover away in the title.
 */
function nearestStationsBlock(lngLat: maplibregl.LngLat): string {
  const here: readonly [number, number] = [lngLat.lat, lngLat.lng];
  const ranked = STATIC_TELEMETRY_STATION_REGISTRY.map((entry) => ({
    name: entry.station.name,
    meters: distanceMeters(here, entry.station.coords)
  }))
    .filter((s) => s.meters <= NEAREST_STATION_MAX_METERS)
    .sort((a, b) => a.meters - b.meters)
    .slice(0, NEAREST_STATION_COUNT);

  if (ranked.length === 0) {
    return contextRow(
      'Nearest monitoring stations',
      `No station in the curated Pacific Northwest station registry is within ` +
        `${NEAREST_STATION_MAX_MILES} miles (${NEAREST_STATION_MAX_KM} km) of ` +
        `this perimeter. Other networks may operate nearer; this reports the ` +
        `registry, not the field.`
    );
  }

  const items = ranked
    .map(
      (s) =>
        `<li>${escapeHtml(s.name)} <span class="fire-context-distance" title="${escapeHtml(`${Math.round(s.meters)} m from the clicked point`)}">${escapeHtml(formatDistanceKm(s.meters / 1000))}</span></li>`
    )
    .join('');
  return `
    <div class="fire-context-block">
      <div class="fire-context-label">Nearest monitoring stations</div>
      <ul class="fire-context-stations">${items}</ul>
    </div>`;
}

function contextRow(label: string, value: string): string {
  return `
    <div class="fire-context-block">
      <span class="fire-context-label">${escapeHtml(label)}</span>
      <span class="fire-context-value">${escapeHtml(value)}</span>
    </div>`;
}

/** USDM drought category index (0 = D0 through 4 = D4) from feature properties. */
function readDm(props: GeoJsonProperties): number | null {
  if (!props) return null;
  const raw = props['DM'] ?? props['dm'];
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isInteger(n) ? n : null;
}

