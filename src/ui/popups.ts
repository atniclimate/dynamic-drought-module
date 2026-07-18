import type { GeoJsonProperties } from 'geojson';
import { pickTreatyEntry } from '../config/palette';
import { stationCustody } from '../config/station-registry';
import type { TelemetryStation, TelemetryFreshness } from '../types/station';
import {
  fetchAwdbDailySeries,
  toStationValue,
  elementsForAwdbStationTriplet
} from '../util/awdb';
import type { AwdbElementSeries } from '../util/awdb';
import { fetchCwmsLatest, cwmsStationValue } from '../util/cwms';
import type { CwmsLatest } from '../util/cwms';
import { fetchHydrometDaily, hydrometStationValue } from '../util/hydromet';
import type { HydrometSeries } from '../util/hydromet';
import { escapeHtml } from '../util/escape';
import {
  fetchUsgsIV,
  extractTimeSeries,
  readVariableCode,
  readUnitCode,
  readVariableName,
  readValueArray
} from '../util/usgs';
import type { UsgsSeries } from '../util/usgs';
import { sparklineSvg } from './charts';

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
// Impact-briefing trigger
// =============================================================================

/**
 * The "Drought impact briefing" button appended to every boundary popup. The
 * `data-ddm-impact-trigger` attribute is the hook the InteractionCoordinator
 * wires to (src/map/interaction-coordinator.ts), keeping the popup a
 * lightweight identity card while the rich briefing lives in the slide-in
 * panel. Static markup, no interpolation, so it is safe to inline.
 */
export const IMPACT_TRIGGER_BUTTON_HTML =
  '<button type="button" class="popup-impact-btn" data-ddm-impact-trigger>Drought impact briefing</button>';


/**
 * Format a raw acres value (string or number) as a thousands-separated whole
 * number, or '' when it is empty or not finite. Shared by the Tribal and BIA
 * reservation popups, which carry the identical parse-and-format idiom.
 */
function formatAcres(raw: unknown): string {
  if (raw === '' || raw === null || raw === undefined) return '';
  const n = Number(raw);
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '';
}

// =============================================================================
// M3: static popup factories
// =============================================================================

/**
 * Popup for an EPA Omernik ecoregion feature. `opts.level` selects the Level III
 * or Level IV framing; for Level IV, `opts.parentL3` names the containing Level
 * III ecoregion (Level IV is a finer subdivision of Level III). Ecoregions are a
 * landscape representation, not a jurisdiction, so no sovereignty caveat applies.
 */
export function buildEcoregionPopupHtml(
  name: string,
  opts?: { level?: 'III' | 'IV'; parentL3?: string }
): string {
  const level = opts?.level ?? 'III';
  const agency = level === 'IV' ? 'EPA · Level IV Ecoregion' : 'EPA · Level III Ecoregion';
  const withinHtml =
    level === 'IV' && opts?.parentL3
      ? `<div class="popup-treaty-meta">Within: ${escapeHtml(opts.parentL3)} (Level III)</div>`
      : '';
  return `
    <div class="popup-title">${escapeHtml(name)}</div>
    <div class="popup-agency">${agency}</div>
    ${withinHtml}
    <div class="popup-description">Ecoregions denote areas of general similarity in ecosystems and in the type, quality, and quantity of environmental resources.</div>
    ${IMPACT_TRIGGER_BUTTON_HTML}
    <div class="popup-links">
      <a href="https://www.epa.gov/eco-research/level-iii-and-iv-ecoregions-continental-united-states" target="_blank" rel="noopener">EPA Ecoregions</a>
    </div>
  `;
}

/**
 * Popup for the DEPLOYER-provided Tribal Lands slot (`tribal`, the bundled
 * `public/data/tribal-lands.geojson` a deployer populates under its own
 * authorization; empty placeholder by default).
 *
 * Provenance honesty (Unit-H adjacent recommendation 5, 2026-07-15): this
 * layer renders whatever data THIS deployment's operator supplied. The popup
 * must say exactly that, and must not imply Bureau of Indian Affairs (BIA)
 * or any other agency custody for arbitrary deployer data; the hardcoded
 * BIA/Washington links the old popup carried are removed. The LIVE federal
 * representations have their own layers and popups (aiannh,
 * bia-reservations), each naming its actual agency.
 */
export function buildTribalPopupHtml(props: GeoJsonProperties): string {
  const p = props ?? {};
  const name = p.LARName || p.LARNAME || p.NAME || p.name || p.TRIBE || p.RESERV_NAM || 'Tribal Land Area';
  const govt = p.LARGovernment || p.GOVT || p.tribe || '';
  const type = p.LARType || p.TYPE || '';
  const acresStr = formatAcres(p.GISAcres || p.ACRES || '');

  return `
    <div class="popup-title">${escapeHtml(String(name))}</div>
    <div class="popup-agency">Tribal Lands (deployer data)</div>
    ${govt ? `<div class="popup-description"><strong>Government:</strong> ${escapeHtml(String(govt))}</div>` : ''}
    ${type ? `<div class="popup-treaty-meta">Type: ${escapeHtml(String(type))}</div>` : ''}
    ${acresStr ? `<div class="popup-treaty-meta">Acres: ${escapeHtml(acresStr)}</div>` : ''}
    <div class="popup-description">This boundary comes from data supplied by this deployment's operator under its own authorization (see data/README.md in the deployed module). It is a representation, not a definitive depiction of Tribal jurisdiction; Tribal sovereignty and a Tribe's own understanding of its territory are matters of sovereign authority.</div>
    ${IMPACT_TRIGGER_BUTTON_HTML}
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
  const acresStr = formatAcres(p.GISACRES ?? p.GISAcres ?? p.ACRES ?? '');

  return `
    <div class="popup-title">${escapeHtml(String(name))}</div>
    <div class="popup-agency">BIA · AIAN Land Area Representation</div>
    ${classification ? `<div class="popup-treaty-meta">Classification: ${escapeHtml(String(classification))}</div>` : ''}
    ${region ? `<div class="popup-treaty-meta">BIA region: ${escapeHtml(String(region))}</div>` : ''}
    ${acresStr ? `<div class="popup-treaty-meta">Acres: ${escapeHtml(acresStr)}</div>` : ''}
    <div class="popup-description">This boundary is the Bureau of Indian Affairs (BIA) administrative representation of reservation and trust land extent (the AIAN-LAR; the BIA publishes no fixed vintage and describes the dataset as continuously updated; service verified live July 15, 2026). It is requested live from the BIA service when the layer needs it, held only in this browser session's memory, and not bundled by this module, for general spatial reference. It is a representation, not a definitive depiction of Tribal jurisdiction; Tribal sovereignty and a Tribe's own understanding of its territory are matters of sovereign authority. No federal dataset maps every Tribal Nation; absence from this layer is not absence of a Nation or of its rights.</div>
    ${IMPACT_TRIGGER_BUTTON_HTML}
    <div class="popup-links">
      <a href="https://biamaps.geoplatform.gov/" target="_blank" rel="noopener">BIA GeoPlatform</a>
      <a href="https://onemap-bia-geospatial.hub.arcgis.com/" target="_blank" rel="noopener">BIA OneMap</a>
    </div>
  `;
}

/**
 * Resolve the US Census AIANNH subtype from `AIANNHCC`, distinguishing legal
 * reservation/trust-land geographies from statistical geographies. This is the
 * load-bearing stewardship distinction (D-0.7.0-033, the plan-attack HIGH
 * constraint): a statistical area is a Census tabulation geography, not land
 * ownership or jurisdiction, and must never be labeled as one. `isLegal` drives
 * the caveat wording; an unknown code falls back to the neutral, non-committal
 * "Census AIANNH area", never to a jurisdiction claim.
 */
function resolveAiannhSubtype(code: string): { label: string; isLegal: boolean } {
  switch (code.toUpperCase()) {
    case 'D1':
    case 'D2':
      return { label: 'Federal reservation', isLegal: true };
    case 'D3':
      return { label: 'Off-reservation trust land', isLegal: true };
    case 'D4':
      return { label: 'State-recognized reservation', isLegal: true };
    case 'D6':
      return { label: 'Oklahoma Tribal Statistical Area (statistical)', isLegal: false };
    case 'D0':
      return { label: 'Tribal joint-use area (statistical)', isLegal: false };
    case 'E1':
      return { label: 'Alaska Native Village Statistical Area (statistical)', isLegal: false };
    case 'F1':
      return { label: 'Hawaiian Home Land', isLegal: true };
    default:
      return { label: 'Census AIANNH area', isLegal: false };
  }
}

/**
 * Popup for a US Census American Indian, Alaska Native, and Native Hawaiian
 * Areas (AIANNH) feature (the live `aiannh` layer). Reads `NAME`, `AIANNHCC`
 * (subtype), and `BASENAME`, all interpolated through `escapeHtml`.
 *
 * Stewardship (D-0.7.0-033; CLAUDE.md section 2): AIANNH is a US Census
 * Bureau product, fetched live at activation time, not bundled by DDM. It
 * spans both legal reservation/trust-land geographies and statistical
 * geographies (Oklahoma Tribal Statistical Areas and the like). A statistical
 * area is a Census tabulation geography, explicitly NOT a depiction of Tribal
 * jurisdiction or land ownership; that is stated in the description below and
 * the subtype is never softened into a jurisdiction claim. This layer is a
 * distinct, separately labeled representation and is never blended with the
 * BIA AIAN-LAR layer (the architectural-review HIGH constraint).
 */
export function buildAiannhPopupHtml(props: GeoJsonProperties): string {
  const p = props ?? {};
  const name = p.NAME || p.BASENAME || p.name || 'Tribal land area';
  const code = String(p.AIANNHCC || p.aiannhcc || '');
  const subtype = resolveAiannhSubtype(code);
  // The user-visible provenance sentence (umbrella build Unit D): publisher,
  // fetched-live-not-bundled, vintage, and the jurisdiction caveat, on the
  // one surface that survives desktop, mobile, and embed.
  // "Requested live ... when the layer needs it" and the session-memory
  // clause are the accurate description of the fetch-plus-transient-cache
  // behavior (Codex Unit D finding 3: a session-cache reactivation performs
  // no network call, so "fetched at activation time" overclaimed).
  // D-0.7.0-059 (maintainer-approved, research 4c): the caveat is
  // two-directional. The generic wording guards against OVERSTATING a
  // federal polygon; the Oklahoma Tribal Statistical Area case risks
  // UNDERSTATING affirmed reservations (McGirt v. Oklahoma, 2020), so
  // D6 carries its own wording, and every branch ends with the
  // absence-is-not-absence line.
  const isOtsa = code.toUpperCase() === 'D6';
  const caveat = isOtsa
    ? "This boundary is the US Census Bureau's statistical delineation (vintage January 1, 2025) of a reservation as it existed before Oklahoma statehood (1907), requested live from the Census TIGERweb service when the layer needs it, held only in this browser session's memory, and not bundled by this module. 'Statistical area' describes the Census dataset, not the land's status: in McGirt v. Oklahoma (2020) and later rulings, courts affirmed that several of these reservations were never disestablished and remain Indian country. Boundaries and legal status are matters of each Nation's sovereign authority; consult the Nation for any authoritative statement. No federal dataset maps every Tribal Nation; absence from this layer is not absence of a Nation or of its rights."
    : subtype.isLegal
      ? "This is a US Census Bureau representation of Tribal land (vintage January 1, 2025), requested live from the Census TIGERweb service when the layer needs it, held only in this browser session's memory, and not bundled by this module, for general spatial reference. It is a representation, not a definitive depiction of Tribal jurisdiction; Tribal sovereignty and a Tribe's own understanding of its territory are matters of sovereign authority. No federal dataset maps every Tribal Nation; absence from this layer is not absence of a Nation or of its rights."
      : "This is a US Census Bureau statistical geography (vintage January 1, 2025), requested live from the Census TIGERweb service when the layer needs it, held only in this browser session's memory, and not bundled by this module, for tabulation and general spatial reference. A statistical area is not a reservation, not trust land, and not a depiction of Tribal jurisdiction or land ownership; Tribal sovereignty and a Tribe's own understanding of its territory are matters of sovereign authority. No federal dataset maps every Tribal Nation; absence from this layer is not absence of a Nation or of its rights.";

  return `
    <div class="popup-title">${escapeHtml(String(name))}</div>
    <div class="popup-agency">US Census Bureau · AIANNH (live)</div>
    <div class="popup-treaty-meta">Type: ${escapeHtml(subtype.label)}</div>
    <div class="popup-description">${caveat}</div>
    ${IMPACT_TRIGGER_BUTTON_HTML}
    <div class="popup-links">
      <a href="https://www.census.gov/programs-surveys/geography.html" target="_blank" rel="noopener">US Census geography</a>
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
    ${IMPACT_TRIGGER_BUTTON_HTML}
    <div class="popup-links">
      <a href="https://wisaard.dahp.wa.gov/" target="_blank" rel="noopener">WA DAHP WISAARD</a>
      <a href="https://native-land.ca/" target="_blank" rel="noopener">Native Land Digital</a>
    </div>
  `;
}

/**
 * Popup for a National Weather Service (NWS) heat or fire-weather alert
 * polygon from the NOAA Watch/Warning/Advisory MapServer. The valid window is
 * always shown (an alert without its window would read as a permanent
 * condition), and the link routes to the NWS active-alerts page rather than
 * the raw Common Alerting Protocol JSON the feature's `url` attribute carries.
 */
export function buildNwsAlertPopupHtml(props: GeoJsonProperties): string {
  const p = props ?? {};
  const event = p.prod_type || 'Weather alert';
  const onset = p.onset || '';
  const ends = p.ends || p.expiration || '';
  const wfo = p.wfo || '';

  return `
    <div class="popup-title">${escapeHtml(String(event))}</div>
    <div class="popup-agency">NOAA NWS · Active Alert</div>
    ${onset ? `<div class="popup-treaty-meta">From: ${escapeHtml(formatAlertTime(onset))}</div>` : ''}
    ${ends ? `<div class="popup-treaty-meta">Until: ${escapeHtml(formatAlertTime(ends))}</div>` : ''}
    ${wfo ? `<div class="popup-treaty-meta">Issued by: NWS office ${escapeHtml(String(wfo).replace(/^K/, ''))}</div>` : ''}
    <div class="popup-description">Active National Weather Service watch, warning, or advisory for extreme heat or fire weather. Polygons are NWS forecast-zone shapes, updated about every five minutes.</div>
    <div class="popup-links">
      <a href="https://alerts.weather.gov/" target="_blank" rel="noopener">NWS Active Alerts</a>
      <a href="https://www.weather.gov/safety/heat" target="_blank" rel="noopener">NWS Heat Safety</a>
    </div>
  `;
}

/**
 * Format an alert timestamp (ISO 8601 with offset, from the WWA MapServer)
 * as a readable local date and time. Falls back to the raw string when the
 * value does not parse, rather than hiding the window.
 */
function formatAlertTime(value: unknown): string {
  if (typeof value !== 'string' || value === '') return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

/**
 * Popup for a Storm Prediction Center (SPC) Fire Weather Outlook polygon.
 * The category label is resolved from the integer `dn` field by the caller
 * (the palette owns the mapping); the description carries the mandatory
 * honest framing: this is a forecast of fire-WEATHER threat (wind, humidity,
 * fuel dryness), not the NFDRS fire danger rating and not an active fire.
 */
export function buildSpcFireWeatherPopupHtml(
  categoryLabel: string,
  props: GeoJsonProperties
): string {
  const p = props ?? {};
  const valid = formatSpcTime(p.valid);
  const expire = formatSpcTime(p.expire);

  return `
    <div class="popup-title">Fire Weather Outlook: ${escapeHtml(categoryLabel)}</div>
    <div class="popup-agency">NOAA SPC · Day 1 Outlook</div>
    ${valid ? `<div class="popup-treaty-meta">From: ${escapeHtml(valid)}</div>` : ''}
    ${expire ? `<div class="popup-treaty-meta">Until: ${escapeHtml(expire)}</div>` : ''}
    <div class="popup-description">Storm Prediction Center forecast of fire-weather threat: pre-existing fuel dryness combined with forecast wind, relative humidity, and dry lightning. An outlook of conditions favorable for fire, not a fire danger rating and not an active fire.</div>
    <div class="popup-links">
      <a href="https://www.spc.noaa.gov/products/fire_wx/" target="_blank" rel="noopener">SPC Fire Weather Outlooks</a>
    </div>
  `;
}

/**
 * Format the SPC `valid` / `expire` field (`YYYYMMDDHHMM`, UTC) as a
 * readable local date and time. Returns the raw string when it does not
 * parse, rather than hiding the window.
 */
function formatSpcTime(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{12}$/.test(value)) {
    return typeof value === 'string' ? value : '';
  }
  const ms = Date.UTC(
    Number(value.slice(0, 4)),
    Number(value.slice(4, 6)) - 1,
    Number(value.slice(6, 8)),
    Number(value.slice(8, 10)),
    Number(value.slice(10, 12))
  );
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

/**
 * Popup for a United States state boundary from the bundled Census Bureau
 * cartographic boundary file. States are public administrative reference
 * boundaries (no sovereignty caveat applies); the generalization note keeps
 * the coarse 1:20,000,000 source honest.
 */
export function buildStatePopupHtml(props: GeoJsonProperties): string {
  const p = props ?? {};
  const name = p.NAME || p.name || 'State';
  const postal = p.STUSPS || '';

  return `
    <div class="popup-title">${escapeHtml(String(name))}</div>
    <div class="popup-agency">US Census Bureau · State Boundary</div>
    ${postal ? `<div class="popup-treaty-meta">Postal code: ${escapeHtml(String(postal))}</div>` : ''}
    <div class="popup-description">State boundary from the United States Census Bureau cartographic boundary file (1:20,000,000 generalization); a reference frame for conditions and resources, not a survey-grade line.</div>
    ${IMPACT_TRIGGER_BUTTON_HTML}
    <div class="popup-links">
      <a href="https://www.census.gov/geographies/mapping-files/time-series/geo/cartographic-boundary.html" target="_blank" rel="noopener">Census cartographic boundary files</a>
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

  // A station hydrates in-browser if it carries one of the four wired live
  // sources. The discovered networks without a hydration path (RAWS, NOAA
  // CO-OPS, AgriMet, CoCoRaHS) instead show an honest custody block: the
  // update cadence plus a pointer to the source link, never a faked reading.
  const hydrates =
    station.usgsSite || station.awdbStation || station.hydrometParams || station.cwms;
  const custody = hydrates ? null : stationCustody(station);
  const dataBlockHtml = hydrates
    ? `<div class="popup-data" data-station-data="${escapeHtml(station.id)}">
         <div class="popup-data-loading skeleton-shimmer">Fetching live data...</div>
       </div>`
    : custody
      ? `<div class="popup-data">
           <div class="popup-data-row">
             <span class="popup-data-label">Updates</span>
             <span class="popup-data-value">${escapeHtml(custody.cadence)}</span>
           </div>
           <div class="popup-data-note">Live readings open at the source link below.</div>
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
 * skeleton) and fetches whichever live source the station carries: USGS
 * Instantaneous Values (`usgsSite`), NRCS SNOTEL daily series
 * (`awdbStation`), USBR Hydromet/AgriMet daily arcs (`hydrometParams`),
 * or the USACE CWMS timeseries (`cwms`). Failure renders the honest
 * "open the source link" fallback.
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
      // NRCS AWDB REST, direct fetch with the Worker as the resilience
      // path (both routes verified 2026-07-01; see src/util/awdb.ts and
      // URLS.nrcsAwdbRest).
      const series = await fetchAwdbDailySeries(
        station.awdbStation,
        elementsForAwdbStationTriplet(station.awdbStation),
        7,
        signal
      );
      if (signal.aborted) return;
      slot.innerHTML = renderAwdbRows(station, series);
    } else if (station.hydrometParams && station.hydrometParams.length > 0) {
      // USBR Hydromet/AgriMet daily arc through the Worker (verified
      // 2026-07-01; see src/util/hydromet.ts and URLS.usbrHydrometArcCsv).
      const series = await fetchHydrometDaily(station.hydrometParams, 7, signal);
      if (signal.aborted) return;
      slot.innerHTML = renderHydrometRows(station, series);
    } else if (station.cwms) {
      // USACE CWMS Data API, direct fetch (wildcard CORS verified
      // 2026-07-01; see src/util/cwms.ts and URLS.usaceCwmsData).
      const latest = await fetchCwmsLatest(station.cwms, signal);
      if (signal.aborted) return;
      slot.innerHTML = renderCwmsRow(station, latest);
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
// Internal: shared popup rows
// =============================================================================

/**
 * The shared "As of" row for a telemetry popup (0.4.0 A4 popup consistency).
 * One freshness vocabulary across every source: the timestamp as the source
 * reported it, with " (stale)" appended only when the reading is past its
 * network's freshness window. USGS parses no window, so it passes no freshness
 * and the row shows the timestamp plain. Every render function routes its
 * timestamp through here so the wording never drifts between sources.
 */
function asOfRow(display: string, freshness?: TelemetryFreshness): string {
  if (!display) return '';
  const staleNote = freshness === 'stale' ? ' (stale)' : '';
  return `
    <div class="popup-data-row" style="margin-top:4px;">
      <span class="popup-data-label">As of</span>
      <span class="popup-data-value">${escapeHtml(display)}${staleNote}</span>
    </div>`;
}

// =============================================================================
// Internal: NRCS AWDB render
// =============================================================================

/**
 * Render popup-data rows for a SNOTEL station from AWDB daily series:
 * latest value per element, an "As of" date, a staleness note when the
 * latest daily reading is older than yesterday, and a 7-day Snow Water
 * Equivalent sparkline. A reading of 0 renders as 0 (a real summer
 * observation), never as missing.
 */
function renderAwdbRows(
  station: TelemetryStation,
  series: AwdbElementSeries[]
): string {
  const values = series
    .map((s) => toStationValue(station.id, s))
    .filter((v): v is NonNullable<typeof v> => v !== null && v.value !== null);

  if (values.length === 0) {
    return '<div class="popup-data-error">No recent NRCS values for this station.</div>';
  }

  const rows = values.map(
    (v) => `
      <div class="popup-data-row">
        <span class="popup-data-label">${escapeHtml(v.label)}</span>
        <span class="popup-data-value">${escapeHtml(String(v.value))} ${escapeHtml(v.unit)}</span>
      </div>
    `
  );

  const latest = values[0];
  const asOf = asOfRow(latest?.timestamp ?? '', latest?.freshness);

  const swe = series.find((s) => s.element === 'WTEQ');
  const sweNums = swe ? swe.readings.map((r) => r.value) : [];
  const spark =
    sweNums.length >= 2
      ? sparklineSvg(sweNums, {
          title: 'Snow water equivalent over the past 7 days (NRCS SNOTEL)',
          unit: swe?.unit ?? 'in',
          source: 'NRCS AWDB, past 7 days'
        })
      : '';

  return rows.join('') + asOf + spark;
}

// =============================================================================
// Internal: USBR Hydromet and USACE CWMS render
// =============================================================================

/**
 * Render popup-data rows for a USBR Hydromet/AgriMet station: one row per
 * configured parameter (latest value), an "As of" date with a staleness
 * note, and a 7-day sparkline of the primary parameter.
 */
function renderHydrometRows(
  station: TelemetryStation,
  series: HydrometSeries[]
): string {
  const values = series
    .map((s) => hydrometStationValue(station.id, s))
    .filter((v): v is NonNullable<typeof v> => v !== null && v.value !== null);

  if (values.length === 0) {
    return '<div class="popup-data-error">No recent USBR values for this station.</div>';
  }

  const rows = values.map((v) => {
    const num =
      v.parameter === 'reservoir_storage_acft' && v.value !== null
        ? v.value.toLocaleString('en-US', { maximumFractionDigits: 0 })
        : String(v.value);
    return `
      <div class="popup-data-row">
        <span class="popup-data-label">${escapeHtml(v.label)}</span>
        <span class="popup-data-value">${escapeHtml(num)} ${escapeHtml(v.unit)}</span>
      </div>
    `;
  });

  const latest = values[0];
  const asOf = asOfRow(latest?.timestamp ?? '', latest?.freshness);

  const primary = series[0];
  const nums = primary ? primary.readings.map((r) => r.value) : [];
  const spark =
    primary && latest && nums.length >= 2
      ? sparklineSvg(nums, {
          title: `${latest.label} over the past 7 days (USBR Hydromet)`,
          unit: latest.unit,
          source: 'USBR Hydromet, past 7 days'
        })
      : '';

  return rows.join('') + asOf + spark;
}

/**
 * Render the popup-data row for a USACE CWMS reading: the labeled latest
 * value with its unit as the API reported it, plus an "As of" timestamp.
 */
function renderCwmsRow(station: TelemetryStation, latest: CwmsLatest | null): string {
  const cwms = station.cwms;
  if (!cwms) return '';
  const value = cwmsStationValue(station.id, cwms.label, latest);
  if (value.value === null) {
    return '<div class="popup-data-error">No recent USACE values for this station.</div>';
  }
  const ts = new Date(value.timestamp);
  const tsStr = Number.isNaN(ts.getTime()) ? value.timestamp : ts.toLocaleString();
  return `
    <div class="popup-data-row">
      <span class="popup-data-label">${escapeHtml(value.label)}</span>
      <span class="popup-data-value">${escapeHtml(String(value.value))} ${escapeHtml(value.unit)}</span>
    </div>
    ${asOfRow(tsStr, value.freshness)}
  `;
}

// =============================================================================
// Internal: USGS IV render (fetch and parse guards live in src/util/usgs.ts)
// =============================================================================

/**
 * Build a 7-day sparkline from the richest USGS series (discharge preferred,
 * then gage height). Returns an empty string when no series has enough points.
 * The reading values are downsampled to keep the inline SVG light.
 */
function buildUsgsSparkline(series: UsgsSeries[]): string {
  const chosen =
    series.find((s) => readVariableCode(s) === '00060') ??
    series.find((s) => readVariableCode(s) === '00065') ??
    series[0];
  if (!chosen) return '';

  const code = readVariableCode(chosen);
  const unit = readUnitCode(chosen) ?? '';
  const label = code === '00060' ? 'Discharge' : code === '00065' ? 'Gage height' : readVariableName(chosen) || 'Value';

  const nums: number[] = [];
  for (const r of readValueArray(chosen)) {
    if (r.value === '-999999') continue;
    const n = Number(r.value);
    if (Number.isFinite(n)) nums.push(n);
  }
  if (nums.length < 2) return '';

  // Downsample to at most ~120 points so the polyline stays light.
  const maxPoints = 120;
  const step = Math.max(1, Math.ceil(nums.length / maxPoints));
  const sampled = nums.filter((_, i) => i % step === 0 || i === nums.length - 1);

  return sparklineSvg(sampled, {
    title: `${label} over the past 7 days (USGS)`,
    unit,
    source: 'USGS Water Services, past 7 days'
  });
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

  return rows.join('') + asOfRow(tsStr) + buildUsgsSparkline(series);
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
