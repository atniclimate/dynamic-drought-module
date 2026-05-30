import type { GeoJsonProperties } from 'geojson';
import { pickTreatyEntry } from '../config/palette';
import { URLS } from '../config/urls';
import type { TelemetryStation } from '../types/station';
import { fetchWithBudget } from '../util/fetch';
import { escapeHtml } from '../util/escape';

/**
 * Popup HTML factories. Each takes either a pre-extracted name (where the
 * caller has already done property fallback) or the raw GeoJSON properties
 * object and returns a self-contained HTML string. Every interpolated value
 * passes through `escapeHtml`.
 *
 * Telemetry helpers (M5) live alongside the M3 factories. The skeleton is
 * pure HTML; the hydrate function fills in the live data slot once the popup
 * has opened, threading a per-popup AbortSignal so a quick close-and-reopen
 * does not race two fetches into a re-created slot.
 */

// =============================================================================
// M3: static popup factories
// =============================================================================

export function buildEcoregionPopupHtml(name: string): string {
  return `
    <div class="popup-title">${escapeHtml(name)}</div>
    <div class="popup-agency">EPA · Level III Ecoregion</div>
    <div class="popup-description">Ecoregions denote areas of general similarity in ecosystems and in the type, quality, and quantity of environmental resources.</div>
    <div class="popup-links">
      <a href="https://www.epa.gov/eco-research/level-iii-and-iv-ecoregions-continental-united-states" target="_blank" rel="noopener">EPA Ecoregions</a>
    </div>
  `;
}

export function buildTribalPopupHtml(props: GeoJsonProperties): string {
  const p = props ?? {};
  const name = p.LARName || p.LARNAME || p.NAME || p.name || p.TRIBE || p.RESERV_NAM || 'Tribal Land Area';
  const govt = p.LARGovernment || p.GOVT || p.tribe || '';
  const type = p.LARType || p.TYPE || '';
  const acresRaw = p.GISAcres || p.ACRES || '';

  const acresNumber = acresRaw === '' || acresRaw === null || acresRaw === undefined
    ? null
    : Number(acresRaw);
  const acresStr = acresNumber !== null && Number.isFinite(acresNumber)
    ? acresNumber.toLocaleString(undefined, { maximumFractionDigits: 0 })
    : '';

  return `
    <div class="popup-title">${escapeHtml(String(name))}</div>
    <div class="popup-agency">Tribal Land</div>
    ${govt ? `<div class="popup-description"><strong>Government:</strong> ${escapeHtml(String(govt))}</div>` : ''}
    ${type ? `<div class="popup-treaty-meta">Type: ${escapeHtml(String(type))}</div>` : ''}
    ${acresStr ? `<div class="popup-treaty-meta">Acres: ${escapeHtml(acresStr)}</div>` : ''}
    <div class="popup-links">
      <a href="https://catalog.data.gov/dataset/american-indian-and-alaska-native-areas" target="_blank" rel="noopener">BIA AIAN-LAR (data.gov)</a>
      <a href="https://geo.wa.gov/" target="_blank" rel="noopener">WA Geospatial Open Data</a>
    </div>
  `;
}

/**
 * Popup for a Bureau of Indian Affairs (BIA) reservation-boundary feature from
 * the American Indian and Alaska Native Land Area Representation (AIAN-LAR).
 * Reads `LARNAME`, `CLASSIFICATION`, `REGION`, and `GISACRES`, all interpolated
 * through `escapeHtml`.
 *
 * Stewardship (CLAUDE.md sections 2 and 4; ddm-tribal-boundary-mapping #11):
 * the AIAN-LAR is the federal administrative depiction for general spatial
 * reference. It is a representation, not a definitive depiction of Tribal
 * jurisdiction; Tribal sovereignty and a Tribe's own understanding of its
 * territory are matters of sovereign authority. That caveat is mandatory and
 * lives in the description below.
 */
export function buildBiaReservationPopupHtml(props: GeoJsonProperties): string {
  const p = props ?? {};
  const name = p.LARNAME || p.LARName || p.NAME || p.name || 'Reservation land area';
  const classification = p.CLASSIFICATION || p.Classification || '';
  const region = p.REGION || p.Region || '';
  const acresRaw = p.GISACRES ?? p.GISAcres ?? p.ACRES ?? '';

  const acresNumber =
    acresRaw === '' || acresRaw === null || acresRaw === undefined
      ? null
      : Number(acresRaw);
  const acresStr =
    acresNumber !== null && Number.isFinite(acresNumber)
      ? acresNumber.toLocaleString(undefined, { maximumFractionDigits: 0 })
      : '';

  return `
    <div class="popup-title">${escapeHtml(String(name))}</div>
    <div class="popup-agency">BIA · AIAN Land Area Representation</div>
    ${classification ? `<div class="popup-treaty-meta">Classification: ${escapeHtml(String(classification))}</div>` : ''}
    ${region ? `<div class="popup-treaty-meta">BIA region: ${escapeHtml(String(region))}</div>` : ''}
    ${acresStr ? `<div class="popup-treaty-meta">Acres: ${escapeHtml(acresStr)}</div>` : ''}
    <div class="popup-description">This boundary is the Bureau of Indian Affairs (BIA) administrative representation of reservation and trust land extent, published for general spatial reference. It is a representation, not a definitive depiction of Tribal jurisdiction; Tribal sovereignty and a Tribe's own understanding of its territory are matters of sovereign authority.</div>
    <div class="popup-links">
      <a href="https://biamaps.geoplatform.gov/" target="_blank" rel="noopener">BIA GeoPlatform</a>
      <a href="https://onemap-bia-geospatial.hub.arcgis.com/" target="_blank" rel="noopener">BIA OneMap</a>
    </div>
  `;
}

export function buildTreatyPopupHtml(props: GeoJsonProperties, featureName: string): string {
  const p = props ?? {};
  const year = p.treaty_year || p.TREATY_DAT || p.TREATY_DATE || p.SIGNED_DAT || p.YEAR_SIGNED || p.year || '';
  const dataTribe = p.tribe || p.TRIBE_NAME || p.TRIBE || '';
  const entry = pickTreatyEntry(featureName);
  // Prefer the formal Tribe name from TREATY_COLORS over the (possibly
  // abbreviated) value in the source GeoJSON; fall back to the source value
  // for Treaty-location keys signed by multiple Tribes.
  const tribe: string = (entry && entry.tribe) || String(dataTribe || '');

  return `
    <div class="popup-title">${escapeHtml(featureName)}</div>
    <div class="popup-agency">Historical Treaty Area</div>
    ${year ? `<div class="popup-treaty-meta">Signed: ${escapeHtml(String(year))}</div>` : ''}
    ${tribe ? `<div class="popup-treaty-meta">Tribe: ${escapeHtml(tribe)}</div>` : ''}
    <div class="popup-description">Agency polygons are a representation of Treaty cession areas, not a definitive depiction of Tribal jurisdiction. Treaty rights and Tribal sovereignty are matters of sovereign authority.</div>
    <div class="popup-links">
      <a href="https://wisaard.dahp.wa.gov/" target="_blank" rel="noopener">WA DAHP WISAARD</a>
      <a href="https://native-land.ca/" target="_blank" rel="noopener">Native Land Digital</a>
    </div>
  `;
}

// =============================================================================
// M5: telemetry popup skeleton + live data hydration
// =============================================================================

/**
 * Build the static popup HTML for a telemetry station. The skeleton is
 * everything except the live values: title, agency, description, an empty
 * data slot for stations that expose live values (`usgsSite` or
 * `awdbStation`), and the deep links to the agency portals.
 *
 * Defensive filtering on links:
 *   - only `https://` URLs are emitted (HTTP, custom schemes, and javascript:
 *     are dropped silently);
 *   - both URL and label are passed through `escapeHtml` before
 *     interpolation. The links source is hardcoded today, but this guard
 *     keeps the popup safe if a future deployer config ever feeds them in
 *     dynamically.
 */
export function buildTelemetryPopupSkeleton(station: TelemetryStation): string {
  const linksHtml = station.links
    .filter((link) => typeof link.url === 'string' && link.url.startsWith('https://'))
    .map(
      (link) =>
        `<a href="${escapeHtml(link.url)}" target="_blank" rel="noopener">${escapeHtml(link.label)}</a>`
    )
    .join('');

  const dataBlockHtml =
    station.usgsSite || station.awdbStation
      ? `<div class="popup-data" data-station-data="${escapeHtml(station.id)}">
           <div class="popup-data-loading">Fetching live data…</div>
         </div>`
      : '';

  return `
    <div class="popup-title">${escapeHtml(station.name)}</div>
    <div class="popup-agency">${escapeHtml(station.agency)}</div>
    <div class="popup-description">${escapeHtml(station.description)}</div>
    ${dataBlockHtml}
    <div class="popup-links">${linksHtml}</div>
  `;
}

/**
 * Hydrate the data slot inside an open telemetry popup. Looks up the slot
 * via the `data-station-data="<id>"` attribute (escaped to match the
 * skeleton) and either:
 *
 *   - fetches the most recent United States Geological Survey (USGS)
 *     Instantaneous Values (IV) reading for `usgsSite` stations, or
 *   - surfaces an honest "live data not available in-browser" message for
 *     `awdbStation` (NRCS Snow Telemetry (SNOTEL)) stations, since the NRCS
 *     Air-Water Database (AWDB) endpoint does not respond with the
 *     Cross-Origin Resource Sharing (CORS) headers a browser fetch needs.
 *
 * The `signal` is the per-marker AbortController set up in
 * `src/layers/telemetry.ts`. It fires on popup-close so a quick close-and-
 * reopen does not race two fetches into a re-created slot. We re-check
 * `signal.aborted` immediately before each `innerHTML` write so a late-
 * arriving response cannot mutate a slot that has already been replaced.
 */
export async function hydrateTelemetryPopupData(
  station: TelemetryStation,
  container: HTMLElement,
  signal: AbortSignal
): Promise<void> {
  const slot = container.querySelector<HTMLElement>(
    `[data-station-data="${cssEscapeAttribute(station.id)}"]`
  );
  if (!slot) return;

  try {
    if (station.usgsSite) {
      const data = await fetchUsgsIV(station.usgsSite, signal);
      // Drop the response on the floor if the popup closed while the fetch
      // was in flight; the slot is detached from a popup the user has
      // already dismissed.
      if (signal.aborted) return;
      slot.innerHTML = renderUsgsRows(data);
    } else if (station.awdbStation) {
      if (signal.aborted) return;
      slot.innerHTML = `
        <div class="popup-data-error">
          Live SWE not available in-browser. Use the station link below for the current reading.
        </div>`;
    }
  } catch (_err) {
    // AbortError is the expected close path; swallow silently. Anything else
    // surfaces as the canonical "open the source link" message that the
    // baseline used.
    if (signal.aborted) return;
    slot.innerHTML = `
      <div class="popup-data-error">
        Live data unavailable in-browser. Open the source link for current values.
      </div>`;
  }
}

// =============================================================================
// Internal: USGS IV fetch + render
// =============================================================================

/**
 * Pull the most recent instantaneous values for discharge (parameter code
 * 00060) and gage height (00065) from USGS Water Services. The optional
 * `signal` is the per-marker AbortController set up by the layer module so
 * popup-close cancels the in-flight fetch. The `8000` budget is the
 * vanilla-baseline timeout (8 seconds) carried over verbatim.
 *
 * Returns the raw JSON payload as `unknown`; `renderUsgsRows` does the
 * structural validation. This keeps the parse boundary in one place.
 */
async function fetchUsgsIV(siteId: string, signal: AbortSignal | null): Promise<unknown> {
  const params = new URLSearchParams({
    format: 'json',
    sites: siteId,
    parameterCd: '00060,00065',
    siteStatus: 'all'
  });
  const resp = await fetchWithBudget(URLS.usgsIV + '?' + params.toString(), {}, signal, 8000);
  if (!resp.ok) throw new Error('USGS HTTP ' + resp.status);
  return resp.json();
}

/**
 * Render the popup-data rows for a USGS Instantaneous Values payload.
 *
 * The USGS IV JSON shape (as observed in the wild and reflected in the
 * vanilla `renderUsgsRows`) nests timeseries at:
 *
 *   payload.value.timeSeries[i].variable.variableCode[0].value
 *   payload.value.timeSeries[i].variable.unit.unitCode
 *   payload.value.timeSeries[i].variable.variableName
 *   payload.value.timeSeries[i].values[0].value[]   (array of readings)
 *
 * Every step in that walk is type-narrowed defensively because the upstream
 * JSON is `unknown` here. The output is a sequence of `popup-data-row`
 * blocks plus an "As of" timestamp from the first series.
 *
 * Sentinel value: USGS encodes "no reading" as the literal string
 * `'-999999'` on the value field; those rows are dropped.
 */
function renderUsgsRows(payload: unknown): string {
  const series = extractTimeSeries(payload);
  if (series.length === 0) {
    return '<div class="popup-data-error">No recent USGS values for this site.</div>';
  }

  const rows: string[] = [];
  for (const s of series) {
    const code = readVariableCode(s);
    const unit = readUnitCode(s);
    const values = readValueArray(s);
    if (values.length === 0) continue;

    const last = values[values.length - 1];
    if (!last || last.value === '-999999') continue;

    let label = readVariableName(s) || code || '';
    if (code === '00060') label = 'Discharge';
    else if (code === '00065') label = 'Gage height';

    rows.push(`
      <div class="popup-data-row">
        <span class="popup-data-label">${escapeHtml(label)}</span>
        <span class="popup-data-value">${escapeHtml(last.value)} ${escapeHtml(unit ?? '')}</span>
      </div>
    `);
  }

  if (rows.length === 0) {
    return '<div class="popup-data-error">No active sensors at this site.</div>';
  }

  // Surface the timestamp from the first series we found.
  const firstSeriesValues = readValueArray(series[0]);
  const firstLast = firstSeriesValues[firstSeriesValues.length - 1];
  const ts = firstLast && typeof firstLast.dateTime === 'string' ? firstLast.dateTime : '';
  const tsStr = ts ? new Date(ts).toLocaleString() : '';

  return (
    rows.join('') +
    (tsStr
      ? `
    <div class="popup-data-row" style="margin-top:4px;">
      <span class="popup-data-label">As of</span>
      <span class="popup-data-value">${escapeHtml(tsStr)}</span>
    </div>`
      : '')
  );
}

/* ---------------------------------------------------------------------------
 * Defensive type guards over the USGS IV JSON shape. Each helper takes the
 * `unknown` payload (or a node from it) and returns either a typed value or
 * a sensible empty default. These keep `renderUsgsRows` readable without
 * sprinkling `as` casts through it.
 * ------------------------------------------------------------------------- */

interface UsgsReading {
  readonly value: string;
  readonly dateTime?: string;
}

type UsgsSeries = Record<string, unknown>;

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object';
}

function extractTimeSeries(payload: unknown): UsgsSeries[] {
  if (!isObject(payload)) return [];
  const value = payload.value;
  if (!isObject(value)) return [];
  const ts = value.timeSeries;
  if (!Array.isArray(ts)) return [];
  return ts.filter(isObject) as UsgsSeries[];
}

function readVariableCode(series: UsgsSeries): string | null {
  const variable = series.variable;
  if (!isObject(variable)) return null;
  const codes = variable.variableCode;
  if (!Array.isArray(codes) || codes.length === 0) return null;
  const first = codes[0];
  if (!isObject(first)) return null;
  const v = first.value;
  return typeof v === 'string' ? v : null;
}

function readUnitCode(series: UsgsSeries): string | null {
  const variable = series.variable;
  if (!isObject(variable)) return null;
  const unit = variable.unit;
  if (!isObject(unit)) return null;
  const code = unit.unitCode;
  return typeof code === 'string' ? code : null;
}

function readVariableName(series: UsgsSeries): string | null {
  const variable = series.variable;
  if (!isObject(variable)) return null;
  const name = variable.variableName;
  return typeof name === 'string' ? name : null;
}

function readValueArray(series: UsgsSeries): UsgsReading[] {
  const values = series.values;
  if (!Array.isArray(values) || values.length === 0) return [];
  const first = values[0];
  if (!isObject(first)) return [];
  const arr = first.value;
  if (!Array.isArray(arr)) return [];

  const out: UsgsReading[] = [];
  for (const r of arr) {
    if (!isObject(r)) continue;
    const v = r.value;
    if (typeof v !== 'string') continue;
    const dt = r.dateTime;
    if (typeof dt === 'string') {
      out.push({ value: v, dateTime: dt });
    } else {
      out.push({ value: v });
    }
  }
  return out;
}

/**
 * Escape characters that have special meaning inside a CSS attribute-value
 * selector (used to look up the popup-data slot by station id). Station ids
 * are short alphanumeric strings today (for example, `'snotel_791'`,
 * `'modo3'`); this guard exists so a future deployer who adds a station
 * with a colon, dash, quote, or backslash does not break the selector.
 */
function cssEscapeAttribute(s: string): string {
  return s.replace(/(["\\])/g, '\\$1');
}
