/**
 * Each fire agency's own record, as the popup frame lists it
 * (grouping-contract.md 12.1): the NIFC WFIGS record (moved here from
 * src/layers/nifc-fires.ts unchanged) and the BC Wildfire Service record,
 * plus the group input for one fire area where the two overlap. Pure and
 * DOM-free, so the BC layer's group popup builds NIFC records without the
 * NIFC layer's chunk, and Node tests read both. No merged name, size or
 * status is built anywhere here: a group only lists its records.
 */

import type { GeoJsonProperties } from 'geojson';

import { FIRE_PERIMETER_ISSUERS } from '../config/fire-perimeter-issuers';
import { BCWS_CATALOGUE_URL, BCWS_STATUS_PRESENTATION, bcwsStageName, bcwsStatusClass } from '../config/wildfire-presentation';
import type {
  GroupInput,
  GroupIssuerKey,
  GroupNotice,
  IssuedModel,
  PopupClock,
  PopupLink,
  RecordBlock,
  RecordSize
} from '../ui/popup-frame';

/** The frame's explanation for issuer time text DDM does not parse (PF1; the M25 builders' wording). */
const SUPPLIED_TIME_EXPLANATION = 'As the issuer states it; DDM does not read it as a full date.';

/** Hectares per acre (grouping-contract.md section 4, "Conversion shown"). */
export const HECTARES_PER_ACRE = 0.40468564224;

/** A finite number from a numeric field, or null for a missing, blank or non-numeric value. */
export function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
  const num = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(num) ? num : null;
}

/**
 * Whole units, thousands-separated (sub-acre precision exceeds typical
 * perimeter accuracy); a positive value below 1 reads "under 1", never "0".
 */
export function wholeUnits(value: number): string {
  return value > 0 && value < 1 ? 'under 1' : value.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

/** The record's text field, trimmed, or null when missing or blank. */
export function textField(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

/**
 * Resolve the most useful incident name from the WFIGS attribute schema.
 * `attr_IncidentName` is canonical, `poly_IncidentName` is the geometry
 * source's name (sometimes more specific), and `IncidentName` and
 * `incidentName` are legacy field names that the scoped query no longer
 * requests (kept for stub fixtures and older responses). Returns a neutral mapped-perimeter label if every candidate
 * is blank.
 */
export function pickIncidentName(props: GeoJsonProperties): string {
  const p = props ?? {};
  // Fall through on blank strings, not only on null/undefined: the IRWIN
  // record (`attr_*`) and the perimeter collector (`poly_*`) can disagree,
  // and a present-but-empty `attr_IncidentName` must not mask a real name
  // in `poly_IncidentName`.
  for (const candidate of [p.attr_IncidentName, p.poly_IncidentName, p.IncidentName, p.incidentName]) {
    if (candidate === null || candidate === undefined) continue;
    const s = String(candidate).trim();
    if (s !== '') return s;
  }
  return 'Mapped Fire Perimeter';
}

/**
 * A WFIGS size field in its issuer unit (acres) first, with the "about"
 * hectare conversion rounded to whole units (grouping-contract.md 12.1 slot
 * 3), under the field's own name; null when the field carries no size.
 */
function nifcSizeRow(label: string, value: unknown): RecordSize | null {
  const acres = finiteNumber(value);
  if (acres === null) return null;
  const shown = wholeUnits(acres);
  const unit = shown === '1' || shown === 'under 1' ? 'acre' : 'acres';
  const hectares = wholeUnits(acres * HECTARES_PER_ACRE);
  return { label, text: `${shown} ${unit} (${hectares === 'under 1' ? '' : 'about '}${hectares} ha)` };
}

/**
 * The discovery time as the WFIGS date field states it: epoch milliseconds
 * read as a UTC instant (the zone named; the old popup cut it to its UTC
 * date). A missing, blank or non-text, non-numeric value is absent (null);
 * other text is shown as supplied, never silently dropped (PF1).
 */
function discoveredClock(value: unknown): PopupClock | null {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
  const ms = finiteNumber(value);
  if (ms !== null && new Date(ms).getUTCFullYear() >= 1000) {
    return { kind: 'point', meaning: 'discovered', label: 'Discovered', at: { precision: 'instant', at: ms, zone: 'UTC' } };
  }
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  return { kind: 'point', meaning: 'discovered', label: 'Discovered', at: { precision: 'supplied', text: String(value), explanation: SUPPLIED_TIME_EXPLANATION } };
}

/** The layer's last successful browser check (the time bar's own words), in the viewer's zone, named. */
export function retrievedClock(retrievedAt: number | null): PopupClock | null {
  return retrievedAt === null
    ? null
    : {
        kind: 'point',
        meaning: 'retrieved',
        label: 'Last successful browser check',
        at: { precision: 'instant', at: retrievedAt, zone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }
      };
}

/**
 * The record key (grouping-contract.md section 4): the UniqueFireIdentifier
 * trimmed and uppercased; else the IRWIN id, braces removed and lowercased,
 * as `nifc:irwin:<guid>`. A record that carries neither (a stub) has no
 * key across responses: names and OBJECTIDs are never keys (item 3 and
 * section 5.1), so the stub is keyed on its feature id inside this one
 * response (section 4's "key plus OBJECTID within one response") under a
 * prefix that says it is unkeyed, `nifc:unkeyed:<id>`, or `nifc:unkeyed`
 * when the response gives the feature no id. Section 5.2's
 * `nifc:geom:<hash>` is the grouping read's key over its generalized
 * coordinates; a clicked feature carries only its tile-clipped rendering.
 */
function nifcRecordKey(ufi: string | null, irwin: string | null, featureId: string | number | undefined): string {
  if (ufi !== null) return `nifc:${ufi.toUpperCase()}`;
  if (irwin !== null) return `nifc:irwin:${irwin.replace(/[{}]/g, '').toLowerCase()}`;
  const id = typeof featureId === 'number' ? (Number.isFinite(featureId) ? String(featureId) : '') : (featureId ?? '').trim();
  return id === '' ? 'nifc:unkeyed' : `nifc:unkeyed:${id}`;
}

/** The NIFC record block: the identifier, the name, each size field, the discovery and retrieval clocks. */
export function nifcRecordBlock(
  props: GeoJsonProperties,
  retrievedAt: number | null,
  featureId?: string | number,
  links: readonly PopupLink[] = []
): RecordBlock {
  const p = props ?? {};
  const incidentName = pickIncidentName(p);
  const ufi = textField(p.attr_UniqueFireIdentifier);
  const irwin = textField(p.attr_IrwinID);
  const present = [discoveredClock(p.attr_FireDiscoveryDateTime), retrievedClock(retrievedAt)].filter(
    (c): c is PopupClock => c !== null
  );
  const [firstPresent, ...laterPresent] = present;
  return {
    key: nifcRecordKey(ufi, irwin, featureId),
    issuer: 'nifc',
    identifier: ufi ?? incidentName,
    ...(ufi === null ? {} : { name: incidentName }),
    sizes: [nifcSizeRow('Reported size', p.attr_IncidentSize), nifcSizeRow('Mapped perimeter area', p.poly_GISAcres)].filter(
      (row): row is RecordSize => row !== null
    ),
    clocks:
      firstPresent === undefined ? [{ kind: 'not-stated', label: 'Discovered', reason: 'unavailable' }] : [firstPresent, ...laterPresent],
    links
  };
}

// ---------------------------------------------------------------------------
// BC Wildfire Service
// ---------------------------------------------------------------------------

/** The issuer's name in the frame (GROUP_ISSUERS.bcws.record in src/ui/popup-frame.ts). */
const BCWS_ISSUER_NAME = 'BC Wildfire Service (British Columbia)';

/** TRACK_DATE is a date served as midnight at UTC-7 (measured 2026-11-06: every one of 319 at 07:00 UTC). */
const BCWS_DATE_OFFSET_MS = 7 * 3_600_000;
const DAY_MS = 86_400_000;

/** The issuer's Track Date at date precision when it has the served form, else as supplied (PF1). */
function bcwsTrackClock(value: unknown): PopupClock | null {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
  const ms = finiteNumber(value);
  const local = ms === null ? NaN : ms - BCWS_DATE_OFFSET_MS;
  if (Number.isFinite(local) && local % DAY_MS === 0) {
    const day = new Date(local);
    const year = day.getUTCFullYear();
    if (year >= 1000 && year <= 9999) {
      const date = `${year}-${String(day.getUTCMonth() + 1).padStart(2, '0')}-${String(day.getUTCDate()).padStart(2, '0')}`;
      return { kind: 'point', meaning: 'perimeter-date', label: 'Track Date', at: { precision: 'date', date } };
    }
  }
  return { kind: 'point', meaning: 'perimeter-date', label: 'Track Date', at: { precision: 'supplied', text: String(value), explanation: SUPPLIED_TIME_EXPLANATION } };
}

/** LOAD_DATE: when the issuer loaded the record, an instant. */
function bcwsLoadedClock(value: unknown): PopupClock | null {
  const ms = finiteNumber(value);
  if (ms === null || new Date(ms).getUTCFullYear() < 1000) return null;
  // DRAFT wording (DR-177): the frame's record-loaded clock label.
  return { kind: 'point', meaning: 'record-loaded', label: 'Record loaded', at: { precision: 'instant', at: ms, zone: 'UTC' } };
}

/** FIRE_SIZE_HECTARES in the issuer's unit as served, with the acre conversion beside it. */
export function bcwsSizeText(value: unknown): string | null {
  const hectares = finiteNumber(value);
  if (hectares === null) return null;
  const shown = hectares.toLocaleString('en-US', { maximumFractionDigits: 1 });
  if (hectares === 0) return '0 ha (0 acres)';
  const acres = wholeUnits(hectares / HECTARES_PER_ACRE);
  return `${shown} ha (${acres === 'under 1' ? 'under 1 acre' : `about ${acres} ${acres === '1' ? 'acre' : 'acres'}`})`;
}

/** The record key the grouping kernel uses (src/config/fire-perimeter-issuers.ts), or an unkeyed one. */
export function bcwsRecordKey(props: GeoJsonProperties, featureId?: string | number): string {
  const issuer = FIRE_PERIMETER_ISSUERS.find((row) => row.id === 'bcws')!;
  const id = issuer.recordId(props ?? {});
  return id === null ? `bcws:unkeyed:${featureId ?? ''}` : `bcws:${id}`;
}

/** The issuer's stage of control as the record states it, or the unknown wording. */
function bcwsStatus(value: unknown): { readonly from: 'issuer' | 'unknown'; readonly text: string } {
  const stage = bcwsStageName(value);
  if (stage !== null) return { from: 'issuer', text: stage };
  const supplied = textField(value);
  // DRAFT wording (DR-177)
  return { from: 'unknown', text: supplied ?? 'Stage of control not stated' };
}

/** The BC Wildfire Service record block: fire number and year, size, stage, Track Date, load time, the fire's own page. */
export function bcwsRecordBlock(props: GeoJsonProperties, retrievedAt: number | null, featureId?: string | number): RecordBlock {
  const p = props ?? {};
  const number = textField(p.FIRE_NUMBER);
  const year = textField(p.FIRE_YEAR);
  const size = bcwsSizeText(p.FIRE_SIZE_HECTARES);
  const present = [bcwsTrackClock(p.TRACK_DATE), bcwsLoadedClock(p.LOAD_DATE), retrievedClock(retrievedAt)].filter(
    (c): c is PopupClock => c !== null
  );
  const [first, ...later] = present;
  const url = textField(p.FIRE_URL);
  return {
    key: bcwsRecordKey(p, featureId),
    issuer: 'bcws',
    // The issuer's field names (Fire Number, Fire Year), verbatim; FIRE_YEAR is the April-March fiscal year.
    identifier: `Fire Number ${number ?? 'not stated'}${year === null ? '' : `, Fire Year ${year}`}`,
    sizes: size === null ? [] : [{ label: 'Reported size', text: size }],
    status: bcwsStatus(p.FIRE_STATUS),
    clocks: first === undefined ? [{ kind: 'not-stated', label: 'Track Date', reason: 'unavailable' }] : [first, ...later],
    // DRAFT wording (DR-177): the link label (the frame keeps only the wildfiresituation.nrs.gov.bc.ca host).
    links: url === null ? [] : [{ label: 'BC Wildfire Service record', href: url }]
  };
}

/** The value row's swatch: the class the map draws the perimeter as. */
function bcwsSwatch(value: unknown): { readonly table: string; readonly classKey: string; readonly color: string } {
  const cls = bcwsStatusClass(value);
  return { table: 'BCWS_STATUS_PRESENTATION', classKey: cls, color: BCWS_STATUS_PRESENTATION[cls].lineColor };
}

/** One BC perimeter's popup: the stage of control in the head, the record in the body, no caveat (the briefing holds it). */
export function buildBcwsPopupModel(
  props: GeoJsonProperties,
  retrievedAt: number | null,
  featureId?: string | number,
  notices: readonly GroupNotice[] = []
): IssuedModel {
  const p = props ?? {};
  const record = bcwsRecordBlock(p, retrievedAt, featureId);
  return {
    kind: 'event',
    title: `Fire Number ${textField(p.FIRE_NUMBER) ?? 'not stated'}`,
    issuer: { role: 'issued-by', name: BCWS_ISSUER_NAME, productKey: 'bcws-fires' },
    value: [{ text: record.status!.text, swatch: bcwsSwatch(p.FIRE_STATUS) }],
    clocks: [record.clocks[0]],
    records: [record],
    source: { link: { label: 'BC Data Catalogue', href: BCWS_CATALOGUE_URL } },
    ...(notices.length > 0 ? { notices } : {})
  };
}

/** A member of one fire area: the agency, the record's raw attributes, its feature id in its own answer. */
export interface FireAreaMember {
  readonly issuer: 'nifc' | 'bcws';
  readonly properties: GeoJsonProperties;
  readonly featureId?: string | number;
}

const NIFC_RECORD_LINK: PopupLink = { label: 'NIFC Open Data', href: 'https://data-nifc.opendata.arcgis.com/' };

/**
 * The group input for one fire area: each agency's own record, once per
 * record key, sorted by the frame. Null unless two records remain.
 */
export function buildFireAreaGroupInput(
  groupKey: string,
  members: readonly FireAreaMember[],
  computedAt: number,
  zone: string,
  retrieved: { readonly nifc: number | null; readonly bcws: number | null }
): GroupInput | null {
  const records = new Map<string, RecordBlock>();
  for (const member of members) {
    const record =
      member.issuer === 'nifc'
        ? nifcRecordBlock(member.properties, retrieved.nifc, member.featureId, [NIFC_RECORD_LINK])
        : bcwsRecordBlock(member.properties, retrieved.bcws, member.featureId);
    if (!records.has(record.key)) records.set(record.key, record);
  }
  const [first, second, ...rest] = [...records.values()];
  if (first === undefined || second === undefined) return null;
  const issuers: [GroupIssuerKey, ...GroupIssuerKey[]] = [first.issuer];
  for (const record of [second, ...rest]) if (!issuers.includes(record.issuer)) issuers.push(record.issuer);
  return { groupKey, computedAt, zone, issuers, records: [first, second, ...rest] };
}
