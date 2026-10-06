import type { GeoJsonProperties } from 'geojson';
import { pickTreatyEntry } from '../config/palette';
import { stationCustody, fetchRawsStationConditions } from '../config/station-registry';
import type { RawsStationConditions } from '../config/station-registry';
import type { TelemetryStation } from '../types/station';
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
import type { PlaceConditions } from './popup-conditions';
import type {
  ChartDetail,
  ClockValue,
  DoorSpec,
  IssuedModel,
  IssuerSwatch,
  PopupClock,
  PopupDetail,
  PopupLink,
  PopupModel,
  ValueRow
} from './popup-frame';
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
 * The telemetry station model (D1 M26c) lives alongside the place builders:
 * a first model painted at once, and a hydrated model from the live read,
 * which threads the per-open AbortSignal so a quick close-and-reopen never
 * paints a stale read.
 */

// =============================================================================
// Impact-briefing trigger
// =============================================================================

/**
 * The Impact Briefing door appended to a place-bearing popup's frozen head
 * (and, since DR-042 (session-ruled 2026-09-09), to a condition-surface or
 * point-event popup that the InteractionCoordinator resolved to a place
 * through the location-identity stack; src/map/interaction-coordinator.ts
 * `attachConditionDoor`). The `data-ddm-impact-trigger` attribute is the
 * hook the InteractionCoordinator wires to. Since the 2026-09-10 owner
 * amendment the popup itself now carries a Conditions block above this
 * door (src/ui/popup-conditions.ts); the door still opens the fuller,
 * rich briefing in the slide-in panel.
 *
 * The label is PLACE-SPECIFIC: the visible text and the accessible name
 * are the identical string (no separate `aria-label`, so there is nothing
 * for the two to diverge on), naming the place the door opens a briefing
 * for rather than repeating the same bare noun on every boundary popup.
 * `placeTitle` runs through `escapeHtml`: never inline it unescaped.
 *
 * `opts.pulse` plus `opts.warningLabel` (director ruling, 2026-09-10,
 * "Emphasis must be ethical"): set ONLY when `src/ui/popup-conditions.ts`
 * found a REAL issuer-published warning-class condition at this place (an
 * NWS product ending "Warning", or a currently mapped NIFC WFIGS wildfire
 * perimeter) -- never for a DDM-computed judgement, a raster
 * hazard-potential surface, or an outlook. `warningLabel` is that
 * condition's own verbatim product name (or, for a fire perimeter, the
 * plain "Mapped wildfire perimeter" legend phrase): the surface-vocabulary
 * doctrine (scripts/check-surface-vocabulary.mjs) holds that DDM never
 * calls its own read "a warning" in its own voice, only the issuer's own
 * product name earns that word, so the button names the actual product
 * rather than a generic badge. That text is part of the SAME string as the
 * place name (still no separate `aria-label`), so colour is never the only
 * carrier of the warning (accessibility clause d). `pulse` only takes
 * effect when a `warningLabel` is also given (a pulse with nothing to name
 * would be colour alone); the motion itself is added by CSS
 * (`.popup-impact-btn--pulse`) and is fully retired under
 * `prefers-reduced-motion: reduce`, where the class still renders its
 * static red/orange edge treatment (clause b).
 */
export function buildImpactTriggerButtonHtml(
  placeTitle: string,
  opts?: { pulse?: boolean; warningLabel?: string | null }
): string {
  const warningLabel = opts?.warningLabel ?? null;
  const pulse = opts?.pulse === true && warningLabel !== null;
  const cls = pulse ? 'popup-impact-btn popup-impact-btn--pulse' : 'popup-impact-btn';
  const label =
    pulse && warningLabel !== null
      ? `${escapeHtml(warningLabel)} - Open the Impact Briefing for ${escapeHtml(placeTitle)}`
      : `Open the Impact Briefing for ${escapeHtml(placeTitle)}`;
  return `<button type="button" class="${cls}" data-ddm-impact-trigger>${label}</button>`;
}


/**
 * Format a raw acres value (string or number) as a thousands-separated whole
 * number, or '' when it is empty or not finite. Shared by the Tribal and BIA
 * reservation popups, which carry the identical parse-and-format idiom.
 */
function formatAcres(raw: unknown): string {
  const text = featureText(raw);
  if (text === undefined || text.trim() === '') return '';
  const n = Number(text);
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '';
}

/**
 * A feature property as display text: a string as given, a finite number in
 * its plain form, and anything else (an object, a boolean, NaN) absent.
 * Never `String()` on an arbitrary issuer value, which throws for one whose
 * `toString` is not callable, `{ toString: null }` (the Codex diff review of
 * D1 M24; rule C1: a builder never throws because of a feature's data).
 */
function featureText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** The first candidate that is present, non-blank text (the `||` chain's precedence), else ''. */
function firstText(candidates: readonly unknown[]): string {
  for (const candidate of candidates) {
    const text = featureText(candidate);
    if (text !== undefined && text.trim() !== '') return text;
  }
  return '';
}

// =============================================================================
// D1 M24: the place builders render through the popup frame
// =============================================================================

/*
 * S30D D1 M24 (DDM-P11-T04; DR-139; interface-chrome-popups-text.md 3.5 rows
 * 1 to 6; the Codex Tier 2 review's PF1, PF3 and PF4). Each place builder
 * returns the frame's typed MODEL, and its layer answers `model:` (S30D
 * P1-FRAME, draft DR-178): the InteractionCoordinator is the frame's one
 * caller and serializes it, so this module imports only the frame's types.
 * One frame root, no wrapping markup, every string escaped once at the
 * frame's boundary. The head is the title, the boundary issuer with its role
 * ("Boundary from" or "Supplied by this deployment"), ONE value line naming
 * the conditions present (or the block's sentence), the boundary's own clock,
 * its source and the briefing door; the body carries the condition rows
 * first (each naming its own issuer, so the boundary issuer never reads as
 * the source of a condition), then the detail rows, the representation
 * caveat (verbatim, one note) and the source again. A builder never throws
 * because of a feature's data: a blank title falls to the builder's fallback, a blank detail is left out,
 * and a date the data supplies that does not validate is shown as supplied.
 * Only a constant this module owns (a link, a caveat) can make the frame
 * refuse a model.
 */

/**
 * The explanation the owner approved on 2026-10-01 for a time the issuer or
 * the layer supplied that DDM does not read as a full date.
 */
export const SUPPLIED_TIME_EXPLANATION = 'As the issuer states it; DDM does not read it as a full date.';

/** The first present, non-blank candidate as given (the `||` chain's precedence), else the fallback. */
function placeTitle(candidates: readonly unknown[], fallback: string): string {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const value = featureText(candidate);
    if (value === undefined) continue;
    if (value.trim() !== '') return value;
  }
  return fallback;
}

/** One detail row, or none when the value is absent, blank or not text (the old `${x ? ... : ''}` rows). */
function detailRow(label: string, value: unknown): PopupDetail[] {
  if (!value) return [];
  const text = featureText(value);
  return text === undefined || text.trim() === '' ? [] : [{ kind: 'row', label, text }];
}

/** The briefing door: one label in every mode; the pulse only when a real warning earned it. */
function placeDoor(place: string, conditions: PlaceConditions): readonly [DoorSpec] {
  return [
    conditions.hasWarning && conditions.warningLabel !== null
      ? { kind: 'briefing', place, warningLabel: conditions.warningLabel }
      : { kind: 'briefing', place }
  ];
}

/** A YYYY-MM-DD calendar date (month 1 to 12, day within its month, leap years respected), or null. */
function calendarDate(text: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return days !== undefined && day >= 1 && day <= days ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

/** The not-stated edition of deployer-supplied data (owner-approved wording, 2026-10-01). */
const DEPLOYER_EDITION: PopupClock = {
  kind: 'not-stated',
  label: 'Edition',
  reason: "This deployment's own data states no edition."
};

// =============================================================================
// M3: static popup factories
// =============================================================================

/**
 * Popup for an EPA Omernik ecoregion feature. `opts.level` selects the Level III
 * or Level IV framing; for Level IV, `opts.parentL3` names the containing Level
 * III ecoregion (Level IV is a finer subdivision of Level III). Ecoregions are a
 * landscape representation, not a jurisdiction, so no sovereignty caveat applies.
 */
export function buildEcoregionPopupModel(
  name: string,
  conditions: PlaceConditions,
  opts?: { level?: 'III' | 'IV'; parentL3?: string }
): PopupModel {
  const level = opts?.level ?? 'III';
  const title = placeTitle([name], 'Ecoregion');
  return {
    kind: 'place',
    title,
    issuer: {
      role: 'boundary-from',
      name: level === 'IV' ? 'U.S. EPA (Omernik Level IV)' : 'U.S. EPA (Omernik Level III)',
      productKey: 'ecoregions'
    },
    value: conditions.head,
    conditions: conditions.rows,
    // The 2012 delineation (src/layers/ecoregions.ts LEVEL_NOTE).
    clocks: [{ kind: 'point', meaning: 'edition', label: 'Delineation', at: { precision: 'year', year: '2012' } }],
    source: {
      link: {
        label: 'EPA Ecoregions',
        href: 'https://www.epa.gov/eco-research/level-iii-and-iv-ecoregions-continental-united-states'
      }
    },
    details: level === 'IV' && opts?.parentL3 ? detailRow('Within', `${opts.parentL3} (Level III)`) : [],
    qualifications: [
      'Ecoregions denote areas of general similarity in ecosystems and in the type, quality, and quantity of environmental resources.'
    ],
    actions: placeDoor(title, conditions)
  };
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
export function buildTribalPopupModel(props: GeoJsonProperties, conditions: PlaceConditions): PopupModel {
  const p = props ?? {};
  const name = placeTitle([p.LARName, p.LARNAME, p.NAME, p.name, p.TRIBE, p.RESERV_NAM], 'Tribal Land Area');
  const govt = firstText([p.LARGovernment, p.GOVT, p.tribe]);
  const type = firstText([p.LARType, p.TYPE]);
  const acresStr = formatAcres(p.GISAcres || p.ACRES || '');

  // The deployer slot (PF4; plan_rules 7): its source is its stated reason,
  // and no slot links anywhere, least of all to the polygons.
  return {
    kind: 'place',
    title: name,
    issuer: { role: 'supplied-by-deployment', productKey: 'tribal' },
    value: conditions.head,
    conditions: conditions.rows,
    clocks: [DEPLOYER_EDITION],
    source: { none: "No public source page: this layer is supplied by this deployment's operator." },
    details: [...detailRow('Government', govt), ...detailRow('Type', type), ...detailRow('Acres', acresStr)],
    representation: {
      product: 'tribal',
      variant: 'deployer',
      text: "This boundary comes from data supplied by this deployment's operator under its own authorization (see data/README.md in the deployed module). It is a representation, not a definitive depiction of Tribal jurisdiction; Tribal sovereignty and a Tribe's own understanding of its territory are matters of sovereign authority."
    },
    actions: placeDoor(name, conditions)
  };
}

/**
 * Popup for a Bureau of Indian Affairs (BIA) reservation-boundary feature from
 * the American Indian and Alaska Native Land Area Representation (AIAN-LAR).
 * Reads `LARNAME`, `CLASSIFICATION`, `REGION`, and `GISACRES`, all interpolated
 * through `escapeHtml`.
 *
 * Stewardship (a project hard rule; D-0.8.0-052): LAR definition
 * publication, continuing service updates, browser retrieval date, and
 * BIA-mission authority are separate facts. The representation is never
 * legal, survey, or jurisdictional truth. Tribal sovereignty and a Tribe's
 * own understanding of its territory are matters of sovereign authority.
 */
export function buildBiaReservationPopupModel(props: GeoJsonProperties, conditions: PlaceConditions): PopupModel {
  const p = props ?? {};
  const name = placeTitle([p.LARNAME, p.LARName, p.NAME, p.name], 'Reservation land area');
  const classification = firstText([p.CLASSIFICATION, p.Classification]);
  const region = firstText([p.REGION, p.Region]);
  const acresStr = formatAcres(p.GISACRES ?? p.GISAcres ?? p.ACRES ?? '');
  // The layer's own browser retrieval stamp (src/layers/bia-reservations.ts,
  // a UTC YYYY-MM-DD); missing, blank or not text reads 'not recorded', as before.
  const retrievedRaw: unknown = p.__DDM_RETRIEVED_ON;
  const retrievedText = retrievedRaw ? featureText(retrievedRaw) : undefined;
  const retrievedOn = retrievedText === undefined || retrievedText.trim() === '' ? 'not recorded' : retrievedText;
  const retrievedDate = retrievedOn === 'not recorded' ? null : calendarDate(retrievedOn);
  const retrieved: PopupClock =
    retrievedOn === 'not recorded'
      ? { kind: 'not-stated', label: 'Retrieved on', reason: 'not recorded' }
      : {
          kind: 'point',
          meaning: 'retrieved',
          label: 'Retrieved on',
          at:
            retrievedDate === null
              ? { precision: 'supplied', text: retrievedOn, explanation: SUPPLIED_TIME_EXPLANATION }
              : { precision: 'date', date: retrievedDate }
        };

  return {
    kind: 'place',
    title: name,
    issuer: { role: 'boundary-from', name: 'BIA (AIAN Land Area Representation)', productKey: 'bia-reservations' },
    value: conditions.head,
    conditions: conditions.rows,
    clocks: [
      { kind: 'point', meaning: 'published', label: 'LAR definitions published', at: { precision: 'year', year: '2019' } },
      retrieved
    ],
    source: { link: { label: 'BIA GeoPlatform', href: 'https://biamaps.geoplatform.gov/' } },
    moreLinks: [{ label: 'BIA OneMap', href: 'https://onemap-bia-geospatial.hub.arcgis.com/' }],
    details: [
      ...detailRow('Classification', classification),
      ...detailRow('BIA region', region),
      ...detailRow('Acres', acresStr)
    ],
    // ONE note, verbatim (the Codex Tier 2 review :176: "caveat as short
    // notes" means lossless segmentation, never shortening).
    representation: {
      product: 'bia-reservations',
      variant: 'lar',
      text: `This boundary is from the Bureau of Indian Affairs (BIA) American Indian and Alaska Native Land Area Representation (AIAN-LAR). Land Area Representation (LAR) feature definitions were last published in 2019. The live BIA service separately reports continuing spatial-accuracy and attribute updates. Retrieved on ${retrievedOn}. The layer is BIA-authoritative for BIA mission use only. This representation is for illustrative, reference, and statistical use, not legal, survey, or jurisdictional truth. It is requested live from the BIA service when the layer needs it, held only in this browser session's memory, and not bundled by this module. Tribal sovereignty and a Tribe's own understanding of its territory are matters of sovereign authority. No federal dataset maps every Tribal Nation; absence from this layer is not absence of a Nation or of its rights.`
    },
    actions: placeDoor(name, conditions)
  };
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
 * Stewardship (D-0.7.0-033; a project hard rule): AIANNH is a US Census
 * Bureau product, fetched live at activation time, not bundled by DDM. It
 * spans both legal reservation/trust-land geographies and statistical
 * geographies (Oklahoma Tribal Statistical Areas and the like). A statistical
 * area is a Census tabulation geography, explicitly NOT a depiction of Tribal
 * jurisdiction or land ownership; that is stated in the description below and
 * the subtype is never softened into a jurisdiction claim. This layer is a
 * distinct, separately labeled representation and is never blended with the
 * BIA AIAN-LAR layer (the architectural-review HIGH constraint).
 */
export function buildAiannhPopupModel(props: GeoJsonProperties, conditions: PlaceConditions): PopupModel {
  const p = props ?? {};
  const name = placeTitle([p.NAME, p.BASENAME, p.name], 'Tribal land area');
  const code = firstText([p.AIANNHCC, p.aiannhcc]);
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

  return {
    kind: 'place',
    title: name,
    issuer: { role: 'boundary-from', name: 'U.S. Census Bureau (AIANNH)', productKey: 'aiannh' },
    value: conditions.head,
    conditions: conditions.rows,
    // The vintage every caveat branch states.
    clocks: [{ kind: 'point', meaning: 'edition', label: 'Vintage', at: { precision: 'date', date: '2025-01-01' } }],
    source: { link: { label: 'US Census geography', href: 'https://www.census.gov/programs-surveys/geography.html' } },
    details: detailRow('Type', subtype.label),
    // The branch's own approved variant, verbatim (PF4: AIANNH's distinct branches).
    representation: { product: 'aiannh', variant: isOtsa ? 'otsa' : subtype.isLegal ? 'legal' : 'statistical', text: caveat },
    actions: placeDoor(name, conditions)
  };
}

export function buildTreatyPopupModel(
  props: GeoJsonProperties,
  featureName: string,
  conditions: PlaceConditions
): PopupModel {
  const p = props ?? {};
  const title = placeTitle([featureName], 'Treaty Area');
  const year = firstText([p.treaty_year, p.TREATY_DAT, p.TREATY_DATE, p.SIGNED_DAT, p.YEAR_SIGNED, p.year]);
  const dataTribe = firstText([p.tribe, p.TRIBE_NAME, p.TRIBE]);
  const entry = pickTreatyEntry(title);
  // Prefer the formal Tribe name from TREATY_COLORS over the (possibly
  // abbreviated) value in the source GeoJSON; fall back to the source value
  // for Treaty-location keys signed by multiple Tribes.
  const tribe: string = (entry && entry.tribe) || dataTribe;

  // As designed (interface-chrome-popups-text.md 3.5 row 5; the owner's
  // "As designed (Recommended)", 2026-10-01): the issuer is the publisher
  // the product catalog names (src/config/products.ts treaty), the Treaty
  // year is a row and never a clock, and the caveat is carried verbatim.
  return {
    kind: 'place',
    title,
    issuer: { role: 'boundary-from', name: 'deployer · bundled GeoJSON', productKey: 'treaty' },
    value: conditions.head,
    conditions: conditions.rows,
    clocks: [DEPLOYER_EDITION],
    source: { link: { label: 'WA DAHP WISAARD', href: 'https://wisaard.dahp.wa.gov/' } },
    moreLinks: [{ label: 'Native Land Digital', href: 'https://native-land.ca/' }],
    details: [...detailRow('Signed', year), ...detailRow('Tribe', tribe)],
    representation: {
      product: 'treaty',
      variant: 'agency-representation',
      text: 'Agency polygons are a representation of Treaty cession areas, not a definitive depiction of Tribal jurisdiction. Treaty rights and Tribal sovereignty are matters of sovereign authority.'
    },
    actions: placeDoor(title, conditions)
  };
}

/**
 * One SPC period field (`valid` or `expire`, `YYYYMMDDHHMM` in UTC) as a
 * UTC instant, the zone named (the layer's time bar states the same period
 * in UTC; the legacy popup showed local time with no zone): the calendar
 * checked (month 1 to 12, the day within its month, leap years respected,
 * 00:00 to 23:59, a year of at least 1000). Other text, or a finite
 * number, is shown as the issuer supplied it (the legacy popup printed the
 * raw string); a missing, blank or other value is absent (null).
 */
function spcClock(label: 'From' | 'Until', value: unknown): PopupClock | null {
  const text = typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
  if (text === null || text.trim() === '') return null;
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(text);
  if (m) {
    const [year, month, day, hour, minute] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
    if (year >= 1000 && days !== undefined && day >= 1 && day <= days && hour <= 23 && minute <= 59) {
      return {
        kind: 'point',
        meaning: 'valid',
        label,
        at: { precision: 'instant', at: Date.UTC(year, month - 1, day, hour, minute), zone: 'UTC' }
      };
    }
  }
  return { kind: 'point', meaning: 'valid', label, at: { precision: 'supplied', text, explanation: SUPPLIED_TIME_EXPLANATION } };
}

/**
 * The Day 1 Fire Weather Outlook polygon's popup model (S30D D1 M26b;
 * DDM-P11-T04; interface-chrome-popups-text.md 3.5 row 9). The category
 * label is resolved from the integer `dn` field by the layer (the palette
 * owns the mapping), with the swatch the map draws it in, or none for a
 * value outside the outlook's categories (the label then says so). The
 * head: "SPC Fire Weather Outlook, Day 1"; "Issued by: NOAA Storm
 * Prediction Center"; the category; the first present clock of From and
 * Until (the frame moves Until under the head, DR-179's note for M26's
 * builders); SPC Fire Weather Outlooks. The body carries the mandatory
 * honest framing: this is a forecast of fire-WEATHER threat (wind,
 * humidity, fuel dryness), not the NFDRS fire danger rating and not an
 * active fire.
 */
export function buildSpcFireWeatherPopupModel(
  categoryLabel: string,
  props: GeoJsonProperties,
  swatch: IssuerSwatch | null
): IssuedModel {
  const p = props ?? {};
  const present = [spcClock('From', p['valid']), spcClock('Until', p['expire'])].filter(
    (clock): clock is PopupClock => clock !== null
  );
  const [first, ...later] = present;
  return {
    kind: 'surface',
    title: 'SPC Fire Weather Outlook, Day 1',
    issuer: { role: 'issued-by', name: 'NOAA Storm Prediction Center', productKey: 'spc-fire-weather' },
    value: [swatch === null ? { text: categoryLabel } : { text: categoryLabel, swatch }],
    clocks: first === undefined ? [{ kind: 'not-stated', label: 'From', reason: 'unavailable' }] : [first, ...later],
    source: { link: { label: 'SPC Fire Weather Outlooks', href: 'https://www.spc.noaa.gov/products/fire_wx/' } },
    qualifications: [
      // vocab-allow: describes the SPC Fire Weather Outlook product, upstream data
      'Storm Prediction Center forecast of fire-weather threat: pre-existing fuel dryness combined with forecast wind, relative humidity, and dry lightning. An outlook of conditions favorable for fire, not a fire danger rating and not an active fire.'
    ]
  };
}

/**
 * Popup for a United States state boundary from the bundled Census Bureau
 * cartographic boundary file. States are public administrative reference
 * boundaries (no sovereignty caveat applies); the generalization note keeps
 * the coarse 1:20,000,000 source honest.
 */
export function buildStatePopupModel(props: GeoJsonProperties, conditions: PlaceConditions): PopupModel {
  const p = props ?? {};
  const name = placeTitle([p.NAME, p.name], 'State');
  const postal = firstText([p.STUSPS]);

  return {
    kind: 'place',
    title: name,
    issuer: { role: 'boundary-from', name: 'U.S. Census Bureau (cartographic boundary)', productKey: 'states' },
    value: conditions.head,
    conditions: conditions.rows,
    // The bundled 2023 cartographic boundary file (scripts/build-states.mjs).
    clocks: [{ kind: 'point', meaning: 'edition', label: 'Edition', at: { precision: 'year', year: '2023' } }],
    source: {
      link: {
        label: 'Census cartographic boundary files',
        href: 'https://www.census.gov/geographies/mapping-files/time-series/geo/cartographic-boundary.html'
      }
    },
    details: detailRow('Postal code', postal),
    qualifications: [
      'State boundary from the United States Census Bureau cartographic boundary file (1:20,000,000 generalization); a reference frame for conditions and resources, not a survey-grade line.'
    ],
    actions: placeDoor(name, conditions)
  };
}

// =============================================================================
// D1 M26c: the telemetry station popup renders through the popup frame
// =============================================================================

/*
 * S30D D1 M26c (DDM-P11-T04; interface-chrome-popups-text.md 3.5 row 20; the
 * Codex Tier 2 review's PF1, 2026-09-27_s30d-d1-tier2-designs.md :136 and
 * :142). The station popup is a typed MODEL like every other popup:
 * src/layers/telemetry.ts hands it to the InteractionCoordinator, which has
 * adopted the marker's popup and paints the frame. The head: the station's
 * name; "Issued by" its agency; the primary reading with its unit and its own
 * source, or the six-state word until the read lands (loading, unavailable,
 * no data); the reading's own time; the station page. The body: every other
 * reading with its own source and time, the seven-day sparkline (its series
 * in the model, its drawing mounted by the hydrated paint's `mount`, PF1:
 * chart rendering stays in this lazy builder), the retrieval time, the
 * station's description and its other links. A station DDM does not read in
 * the browser states its network's update cadence and is never left loading.
 * The live read REPAINTS the whole frame (head value, clock, state word and
 * body from one model); a read the popup's close aborted returns null and
 * never paints, and the coordinator refuses a paint for an adoption that is
 * no longer current. A genuine zero is a reading like any other.
 */

/** One live reading: its label and served text (unit included), its source, and its own time. */
export interface StationReading {
  readonly label: string;
  readonly text: string;
  /** The service the reading came from (plan_rules 3: each reading names its own issuer). */
  readonly issuer: string;
  /** When the station observed it, at the source's own precision; null when the source states none. */
  readonly observed: ClockValue | null;
  /** Past its network's freshness window. */
  readonly stale?: boolean;
}

/** A seven-day series and the sparkline options it is drawn with (src/ui/charts.ts). */
export interface StationChart {
  readonly data: readonly number[];
  readonly title: string;
  readonly unit: string;
  readonly source: string;
}

/** What one live read of a station found. */
export type StationRead =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'no data'; readonly text: string }
  | {
      readonly kind: 'live';
      readonly readings: readonly [StationReading, ...StationReading[]];
      /** When DDM read it (epoch ms). */
      readonly retrievedAt: number;
      readonly chart?: StationChart;
    };

/** A hydrated station popup: its model, and the chart drawing to mount once it is painted. */
export interface StationPaint {
  readonly model: IssuedModel;
  readonly mount?: (root: HTMLElement) => void;
}

const STATION_CHART_KEY = 'station-sparkline';
// A failed read; the pointer to the source link only when the station lists
// one (a discovered SNOTEL or SCAN station lists none, the block 6 review).
const UNAVAILABLE_TEXT = 'Live data unavailable in-browser.';
const UNAVAILABLE_LINK_TEXT = `${UNAVAILABLE_TEXT} Open the source link for current values.`;
const SOURCE_LINK_NOTE = 'Live readings open at the source link below.';
// DRAFT wording (DR-177): the head value while a station's live read is in flight.
const LOADING_TEXT = 'Live data';
// DRAFT wording (DR-177): a station that lists no https page.
const NO_STATION_PAGE = 'This station lists no public page.';

/** Whether the station carries one of the five wired in-browser reads (DDM-P9-T05 added RAWS). */
function stationHydrates(station: TelemetryStation): boolean {
  return Boolean(
    station.usgsSite || station.awdbStation || (station.hydrometParams?.length ?? 0) > 0 || station.cwms || station.rawsStationId
  );
}

/**
 * The station's links the frame accepts (PF4): https, no userinfo, a label.
 * Any other is dropped, never rendered (the links are curated today; the
 * guard keeps a future deployer-fed link from reaching the page).
 */
function stationLinks(station: TelemetryStation): PopupLink[] {
  const links: PopupLink[] = [];
  for (const link of station.links) {
    if (typeof link.label !== 'string' || link.label.trim() === '' || typeof link.url !== 'string') continue;
    try {
      const url = new URL(link.url);
      if (url.protocol === 'https:' && url.username === '' && url.password === '') links.push({ label: link.label, href: link.url });
    } catch {
      // Not a URL: dropped.
    }
  }
  return links;
}

function viewerZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/**
 * A source's timestamp at its own precision: a calendar day stays a day, an
 * ISO instant is shown in the viewer's zone with the zone named, and any
 * other text is shown as the source supplied it.
 */
function observedAt(text: string | null | undefined): ClockValue | null {
  if (typeof text !== 'string' || text.trim() === '') return null;
  const date = calendarDate(text);
  if (date !== null) return { precision: 'date', date };
  const at = /^\d{4}-\d{2}-\d{2}T/.test(text.trim()) ? Date.parse(text) : Number.NaN;
  return Number.isFinite(at)
    ? { precision: 'instant', at, zone: viewerZone() }
    : { precision: 'supplied', text, explanation: SUPPLIED_TIME_EXPLANATION };
}

function observedClock(reading: StationReading): PopupClock {
  return reading.observed === null
    ? { kind: 'not-stated', label: 'As of', reason: 'not recorded' }
    : { kind: 'point', meaning: 'observed', label: 'As of', at: reading.observed };
}

/** The served text, with the shared " (stale)" note past the network's window (0.4.0 A4). */
function readingText(reading: StationReading): string {
  return reading.stale === true ? `${reading.text} (stale)` : reading.text;
}

/** The sparkline's model slot: its finite series (two points at least) and a stated unit, else none. */
function stationChart(chart: StationChart): ChartDetail[] {
  const data = chart.data.filter((v) => Number.isFinite(v));
  const unit = chart.unit.trim();
  if (data.length < 2 || unit === '') return [];
  const n = (v: number): string => `${v.toLocaleString()} ${unit}`;
  return [
    {
      kind: 'chart',
      label: chart.title,
      chartKey: STATION_CHART_KEY,
      // DRAFT wording (DR-177): the sparkline's text alternative, in the chart's own min/max words.
      summary: `min ${n(Math.min(...data))}, max ${n(Math.max(...data))}, latest ${n(data[data.length - 1]!)}`,
      data,
      options: { title: chart.title, unit, source: chart.source },
      unit
    }
  ];
}

/**
 * The station popup's model. With no `read`: the loading state for a station
 * DDM reads in the browser, else the station's custody (its network's update
 * cadence, never loading). With a read: what it found.
 */
export function buildTelemetryPopupModel(station: TelemetryStation, read?: StationRead): IssuedModel {
  const [first, ...more] = stationLinks(station);
  const state: StationRead | null = read ?? (stationHydrates(station) ? { kind: 'loading' } : null);
  let value: ValueRow;
  let clocks: readonly [PopupClock, ...PopupClock[]];
  let details: PopupDetail[] = [];
  if (state === null) {
    const custody = stationCustody(station);
    value = { text: first === undefined ? NO_STATION_PAGE : SOURCE_LINK_NOTE };
    clocks = [
      custody === null
        ? { kind: 'not-stated', label: 'As of', reason: 'no data' }
        : { kind: 'not-stated', label: 'Updates', reason: custody.cadence }
    ];
  } else if (state.kind === 'live') {
    const [primary, ...rest] = state.readings;
    value = { label: primary.label, text: readingText(primary), issuer: primary.issuer };
    clocks = [
      observedClock(primary),
      { kind: 'point', meaning: 'retrieved', label: 'Retrieved on', at: { precision: 'instant', at: state.retrievedAt, zone: viewerZone() } }
    ];
    details = [
      ...rest.map((r): PopupDetail => ({ kind: 'reading', label: r.label, text: readingText(r), issuer: r.issuer, clock: observedClock(r) })),
      ...(state.chart === undefined ? [] : stationChart(state.chart))
    ];
  } else {
    value = {
      text:
        state.kind === 'loading'
          ? LOADING_TEXT
          : state.kind === 'unavailable'
            ? first === undefined
              ? UNAVAILABLE_TEXT
              : UNAVAILABLE_LINK_TEXT
            : state.text,
      state: state.kind
    };
    clocks = [{ kind: 'not-stated', label: 'As of', reason: state.kind }];
  }
  return {
    kind: 'station',
    title: placeTitle([station.name], station.id),
    issuer: { role: 'issued-by', name: firstText([station.agency, station.type, station.id]), productKey: 'telemetry' },
    value: [value],
    clocks,
    source: first === undefined ? { none: NO_STATION_PAGE } : { link: first },
    moreLinks: more,
    details,
    qualifications: station.description.trim() === '' ? [] : [station.description]
  };
}

/**
 * Read the station's live values and return the hydrated paint: its model,
 * and the sparkline mount when a chart was drawn. Null for a station DDM does
 * not read in the browser (its first paint is final) and once `signal` (the
 * per-open AbortController of src/layers/telemetry.ts) has aborted, so a read
 * the popup's close abandoned never paints. A failure other than the abort is
 * the unavailable state, never a thrown read.
 */
export async function hydrateTelemetryPopup(station: TelemetryStation, signal: AbortSignal): Promise<StationPaint | null> {
  if (!stationHydrates(station)) return null;
  let read: StationRead;
  try {
    read = await readStation(station, signal);
  } catch {
    read = { kind: 'unavailable' };
  }
  if (signal.aborted) return null;
  const model = buildTelemetryPopupModel(station, read);
  const chart = read.kind === 'live' ? read.chart : undefined;
  return chart === undefined
    ? { model }
    : {
        model,
        mount: (root) =>
          root
            .querySelector(`[data-popup-chart="${STATION_CHART_KEY}"]`)
            ?.insertAdjacentHTML('beforeend', sparklineSvg(chart.data, { title: chart.title, unit: chart.unit, source: chart.source }))
      };
}

/** One live read through whichever source the station carries (src/util/*: each threads the signal). */
async function readStation(station: TelemetryStation, signal: AbortSignal): Promise<StationRead> {
  if (station.usgsSite) {
    const payload = await fetchUsgsIV(station.usgsSite, signal);
    return usgsRead(payload, Date.now());
  }
  if (station.awdbStation) {
    // NRCS AWDB REST, direct fetch with the Worker as the resilience path
    // (both routes verified 2026-07-01; src/util/awdb.ts, URLS.nrcsAwdbRest).
    const series = await fetchAwdbDailySeries(station.awdbStation, elementsForAwdbStationTriplet(station.awdbStation), 7, signal);
    return awdbRead(station, series, Date.now());
  }
  if (station.hydrometParams && station.hydrometParams.length > 0) {
    // USBR Hydromet/AgriMet daily arc through the Worker (verified
    // 2026-07-01; src/util/hydromet.ts, URLS.usbrHydrometArcCsv).
    const series = await fetchHydrometDaily(station.hydrometParams, 7, signal);
    return hydrometRead(station, series, Date.now());
  }
  if (station.cwms) {
    // USACE CWMS Data API, direct fetch (wildcard CORS verified 2026-07-01;
    // src/util/cwms.ts, URLS.usaceCwmsData).
    const latest = await fetchCwmsLatest(station.cwms, signal);
    return cwmsRead(station, station.cwms.label, latest, Date.now());
  }
  // NIFC RAWS FeatureServer, direct fetch (DDM-P9-T05;
  // src/config/station-registry.ts fetchRawsStationConditions).
  const conditions = await fetchRawsStationConditions(station.rawsStationId ?? '', signal);
  return rawsStationRead(conditions, Date.now());
}

/** A live read's readings as the model's non-empty list, or the source's own no-values sentence. */
function liveRead(readings: readonly StationReading[], none: string, retrievedAt: number, chart: StationChart | null): StationRead {
  const [first, ...rest] = readings;
  if (first === undefined) return { kind: 'no data', text: none };
  return chart === null ? { kind: 'live', readings: [first, ...rest], retrievedAt } : { kind: 'live', readings: [first, ...rest], retrievedAt, chart };
}

// =============================================================================
// Internal: NRCS AWDB, USBR Hydromet and USACE CWMS reads
// =============================================================================

/**
 * A SNOTEL station's AWDB daily series: the latest value per element, each
 * with its own day and staleness, and the 7-day Snow Water Equivalent
 * sparkline. A reading of 0 is a real summer observation, never missing.
 */
function awdbRead(station: TelemetryStation, series: AwdbElementSeries[], retrievedAt: number): StationRead {
  const readings = series
    .map((s) => toStationValue(station.id, s))
    .filter((v): v is NonNullable<typeof v> => v !== null && v.value !== null)
    .map((v) => ({
      label: v.label,
      text: `${String(v.value)} ${v.unit}`.trim(),
      issuer: 'NRCS AWDB',
      observed: observedAt(v.timestamp),
      stale: v.freshness === 'stale'
    }));
  const swe = series.find((s) => s.element === 'WTEQ');
  const chart: StationChart | null = swe
    ? {
        data: swe.readings.map((r) => r.value),
        title: 'Snow water equivalent over the past 7 days (NRCS SNOTEL)',
        unit: swe.unit ?? 'in',
        source: 'NRCS AWDB, past 7 days'
      }
    : null;
  return liveRead(readings, 'No recent NRCS values for this station.', retrievedAt, chart);
}

/** A USBR Hydromet/AgriMet station: one reading per configured parameter and a 7-day sparkline of the primary one. */
function hydrometRead(station: TelemetryStation, series: HydrometSeries[], retrievedAt: number): StationRead {
  const values = series
    .map((s) => hydrometStationValue(station.id, s))
    .filter((v): v is NonNullable<typeof v> => v !== null && v.value !== null);
  const readings = values.map((v) => ({
    label: v.label,
    text: `${v.parameter === 'reservoir_storage_acft' && v.value !== null ? v.value.toLocaleString('en-US', { maximumFractionDigits: 0 }) : String(v.value)} ${v.unit}`.trim(),
    issuer: 'USBR Hydromet',
    observed: observedAt(v.timestamp),
    stale: v.freshness === 'stale'
  }));
  const primary = series[0];
  const latest = values[0];
  const chart: StationChart | null =
    primary && latest
      ? {
          data: primary.readings.map((r) => r.value),
          title: `${latest.label} over the past 7 days (USBR Hydromet)`,
          unit: latest.unit,
          source: 'USBR Hydromet, past 7 days'
        }
      : null;
  return liveRead(readings, 'No recent USBR values for this station.', retrievedAt, chart);
}

/** A USACE CWMS reading: the labeled latest value with the unit the API reported. */
function cwmsRead(station: TelemetryStation, label: string, latest: CwmsLatest | null, retrievedAt: number): StationRead {
  const value = cwmsStationValue(station.id, label, latest);
  const readings =
    value.value === null
      ? []
      : [
          {
            label: value.label,
            text: `${String(value.value)} ${value.unit}`.trim(),
            issuer: 'USACE CWMS',
            observed: observedAt(value.timestamp),
            stale: value.freshness === 'stale'
          }
        ];
  return liveRead(readings, 'No recent USACE values for this station.', retrievedAt, null);
}

// =============================================================================
// Internal: NIFC RAWS read (DDM-P9-T05)
// =============================================================================

/**
 * Wind text: the served speed, plus direction when the station reports one,
 * else the WindSpeedPeak/WindDirPeak pair when the station reports THAT
 * instead. `null` only when the station reports no wind speed at all.
 *
 * DDM-P9-T06 science verdict (I:\claude-temp\ddm-s20\DDM-P9-T06\science-verdict.md):
 * NWCG PMS 426-3 defines "Peak WS"/"Peak WD" as "Maximum speed for previous
 * 60 minutes from no less than 720 samples" and "Direction at peak wind
 * speed", a 60-minute-window maximum, not an instantaneous gust in the WMO
 * or NWS sense. The prior wording invented a term that was never the
 * issuer's and is corrected here to the NWCG term; `windGustDirection`
 * (WindDirPeak) is fetched but was never rendered before this task and now
 * appears beside the peak speed when the service serves one.
 */
function rawsWindText(conditions: RawsStationConditions): string | null {
  if (conditions.windSpeed === null) return null;
  if (conditions.windDirection !== null) {
    return `${conditions.windSpeed} from ${conditions.windDirection}`;
  }
  if (conditions.windGustSpeed !== null) {
    const peakDirection =
      conditions.windGustDirection !== null
        ? ` from ${conditions.windGustDirection}`
        : '';
    return `${conditions.windSpeed}, peak ${conditions.windGustSpeed}${peakDirection} over the previous 60 minutes`;
  }
  return conditions.windSpeed;
}

/**
 * The three independent RAWS readings (relative humidity, wind, fuel
 * moisture), each the served string verbatim with its own unit ("21 %",
 * "5 mph", "7.3 (unk)") and the station's served observation time; a field
 * the service affirmatively reported as null reads "Station reported none"
 * for that reading only, never a faked value. No feature at all is the no
 * data state; a transport or parse failure never reaches here (the caller's
 * catch makes it the unavailable state).
 */
export function rawsStationRead(conditions: RawsStationConditions | null, retrievedAt: number): StationRead {
  if (!conditions) return { kind: 'no data', text: 'No recent NIFC RAWS values for this station.' };
  const observed = observedAt(conditions.observedAtIso);
  const reading = (label: string, served: string | null): StationReading => ({
    label,
    text: served === null ? 'Station reported none' : served,
    issuer: 'NIFC RAWS',
    observed
  });
  return {
    kind: 'live',
    retrievedAt,
    readings: [
      reading('Relative humidity', conditions.relativeHumidity),
      reading('Wind', rawsWindText(conditions)),
      reading('Fuel moisture', conditions.fuelMoisture)
    ]
  };
}

// =============================================================================
// Internal: USGS IV read (fetch and parse guards live in src/util/usgs.ts)
// =============================================================================

/**
 * The 7-day sparkline series from the richest USGS series (discharge
 * preferred, then gage height), downsampled to about 120 points to keep the
 * inline SVG light; null when no series has two points.
 */
function usgsChart(series: UsgsSeries[]): StationChart | null {
  const chosen =
    series.find((s) => readVariableCode(s) === '00060') ??
    series.find((s) => readVariableCode(s) === '00065') ??
    series[0];
  if (!chosen) return null;

  const code = readVariableCode(chosen);
  const unit = readUnitCode(chosen) ?? '';
  const label = code === '00060' ? 'Discharge' : code === '00065' ? 'Gage height' : readVariableName(chosen) || 'Value';

  const nums: number[] = [];
  for (const r of readValueArray(chosen)) {
    if (r.value === '-999999') continue;
    const n = Number(r.value);
    if (Number.isFinite(n)) nums.push(n);
  }
  if (nums.length < 2) return null;

  const maxPoints = 120;
  const step = Math.max(1, Math.ceil(nums.length / maxPoints));
  const sampled = nums.filter((_, i) => i % step === 0 || i === nums.length - 1);
  return { data: sampled, title: `${label} over the past 7 days (USGS)`, unit, source: 'USGS Water Services, past 7 days' };
}

/**
 * The readings of a USGS Instantaneous Values payload: per series, its
 * latest value with its unit and its own time. The IV JSON nests a series'
 * code at `variable.variableCode[0].value`, its unit at
 * `variable.unit.unitCode`, its name at `variable.variableName` and its
 * readings at `values[0].value[]`; every step is type-narrowed in
 * src/util/usgs.ts. USGS encodes "no reading" as the literal `'-999999'`;
 * those series are dropped.
 */
function usgsRead(payload: unknown, retrievedAt: number): StationRead {
  const series = extractTimeSeries(payload);
  if (series.length === 0) return { kind: 'no data', text: 'No recent USGS values for this site.' };
  const readings: StationReading[] = [];
  for (const s of series) {
    const code = readVariableCode(s);
    const values = readValueArray(s);
    const last = values[values.length - 1];
    if (!last || last.value === '-999999' || last.value.trim() === '') continue;
    const label = code === '00060' ? 'Discharge' : code === '00065' ? 'Gage height' : readVariableName(s) || code || '';
    readings.push({
      label,
      text: `${last.value} ${readUnitCode(s) ?? ''}`.trim(),
      issuer: 'USGS Water Services',
      observed: observedAt(last.dateTime)
    });
  }
  return liveRead(readings, 'No active sensors at this site.', retrievedAt, usgsChart(series));
}
