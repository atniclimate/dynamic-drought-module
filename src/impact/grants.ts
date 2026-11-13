/**
 * Open Grants.gov funding opportunities that list federally recognized Tribal
 * governments among eligible applicants: one request, a pure parser, a pure
 * open filter and a hazard tag table. Not wired into any screen yet.
 *
 * Ported from ATNI's Policy Sentinel project: the request shape, the
 * field whitelist, the date rule, the forecast rule, the entity table and the
 * issuer page address come from its Worker adapter `worker/src/sources/grants.ts`
 * and `src/demo/grants-authority.ts`, and from its source review
 * `docs/source-reviews/grants-gov-api-2026-10-23.md`. Policy Sentinel calls
 * Grants.gov from its own Worker with a JSON body and no key. Here the call is
 * direct from the browser: Grants.gov answers `Access-Control-Allow-Origin: *`
 * and refuses the preflight a JSON content type would trigger (403), so the
 * body is sent as `text/plain`, which a browser sends without a preflight.
 * Measured with curl on 2026-11-13; not yet seen in a real browser.
 *
 * What a row says: Grants.gov listed the opportunity under eligibility code 07
 * when asked for it. That is the posting agency's statement of who may apply,
 * never a determination about any Nation. The search answer carries no
 * per-row eligibility, so every row read here is Tribal-listed by the request.
 *
 * Never kept: the response `token`, agency contact fields, or anything outside
 * the whitelist below. A failed, cut-short or malformed read is `unavailable`,
 * never an empty list; a cancel rejects with an AbortError and returns nothing.
 */

import type { HazardClusterKey } from '../config/clusters';
import { fetchJsonWithBudget, isFetchTimeout } from '../util/fetch';

export const GRANTS_GOV_SEARCH_URL = 'https://api.grants.gov/v1/api/search2';

/** Grants.gov's eligibility code and label, verbatim as its API returns them (Policy Sentinel, 2026-10-23). */
export const TRIBAL_GOVERNMENT_ELIGIBILITY = {
  code: '07',
  label: 'Native American tribal governments (Federally recognized)'
} as const;

/** Required by the Grants.gov API terms wherever its rows are shown (https://www.grants.gov/api/terms-conditions). */
export const GRANTS_GOV_ATTRIBUTION =
  'This product uses the Grants.gov API but is not endorsed or certified by the U.S. Department of Health and Human Services.';

/** 1000 rows returned all 426 Tribal-listed posted rows in one answer of 163 KB on 2026-11-13. */
const SEARCH_ROWS = 1000;
const TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_LISTINGS = 50;

/** Assistance Listing numbers: two digits, a dot, three characters ("15.519"). */
const ASSISTANCE_LISTING = /^\d{2}\.[0-9A-Z]{3}$/;

/** The issuer's own status, read through a whitelist; anything else stays `unknown`. */
export type GrantStatus = 'posted' | 'forecasted' | 'unknown';

/** A hazard a grant title names: a mode key, or one of two hazards no mode carries yet. */
export type GrantTopic = HazardClusterKey | 'flood' | 'water';

export interface GrantOpportunity {
  /** Grants.gov's internal id, digits only; it builds the issuer page address. */
  readonly id: string;
  /** The opportunity number the agency assigned. */
  readonly number: string;
  /** The agency's title, entities decoded, spaces collapsed, otherwise as written. */
  readonly title: string;
  readonly agency: string | null;
  readonly status: GrantStatus;
  /** ISO dates. `closes` is null when the issuer states none, and always for a forecast (its date is an estimate). */
  readonly opens: string | null;
  readonly closes: string | null;
  readonly listings: readonly string[];
  readonly url: string;
}

export interface TaggedGrant extends GrantOpportunity {
  readonly topics: readonly GrantTopic[];
}

export type GrantsUnavailableReason = 'timeout' | 'http' | 'network' | 'body' | 'envelope' | 'shape';

export type GrantsRead =
  | {
      readonly state: 'live';
      readonly readAt: string;
      /** The issuer's own count of matching rows. */
      readonly hitCount: number;
      readonly rows: readonly GrantOpportunity[];
      /** Rows refused by the whitelist (bad id, number, title or date). */
      readonly dropped: number;
      /** True when a row was refused or the page held fewer rows than `hitCount`. */
      readonly partial: boolean;
    }
  | { readonly state: 'unavailable'; readonly reason: GrantsUnavailableReason };

/**
 * The one table that tags a grant with hazards, matched on the title only.
 * Plain words; a title that names none of them gets no tag. Policy Sentinel's
 * taxonomy has no hazard terms, and the search answer carries no per-row
 * funding category, so this table is the whole rule.
 */
export const GRANT_TOPIC_RULES: readonly { readonly topic: GrantTopic; readonly pattern: RegExp }[] = [
  { topic: 'drought', pattern: /\bdrought/i },
  { topic: 'wildfire', pattern: /\bwildfires?\b|\bwildland fires?\b|\bprescribed fires?\b|\bhazardous fuels?\b/i },
  { topic: 'heat', pattern: /\bextreme heat\b|\bheat ?waves?\b|\bheat-related\b/i },
  { topic: 'flood', pattern: /\bflood/i },
  { topic: 'water', pattern: /\bwater\b|\bwatersheds?\b/i }
];

// Grants.gov titles carry HTML entities as text (seen live: "&ndash;"). Policy Sentinel's table.
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '\u2013', mdash: '\u2014', rsquo: '\u2019', lsquo: '\u2018', rdquo: '\u201d', ldquo: '\u201c', sect: '\u00a7'
};

/** HTML entities as characters; an unknown one stays as written. */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (all, name: string) => {
    if (name[0] !== '#') return NAMED_ENTITIES[name.toLowerCase()] ?? all;
    const hex = name[1] === 'x' || name[1] === 'X';
    const code = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
    return code > 31 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
  });
}

/** The search request: open and forecast rows listed for federally recognized Tribal governments. */
export function grantsSearchRequest(): RequestInit & { headers: Record<string, string>; body: string } {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ rows: SEARCH_ROWS, eligibilities: TRIBAL_GOVERNMENT_ELIGIBILITY.code, oppStatuses: 'forecasted|posted' })
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const oneLine = (value: string): string => value.replace(/\s+/g, ' ').trim();

/** Grants.gov writes MM/DD/YYYY; empty means no date stated; anything else refuses the row. */
function issuerDate(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === '') return null;
  const m = typeof value === 'string' ? /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value) : null;
  if (!m) return undefined;
  const iso = `${m[3]}-${m[1]}-${m[2]}`;
  const parsed = new Date(`${iso}T00:00:00.000Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === iso ? iso : undefined;
}

function issuerStatus(value: unknown): GrantStatus {
  return value === 'posted' || value === 'forecasted' ? value : 'unknown';
}

function listingNumbers(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.slice(0, MAX_LISTINGS).filter((n): n is string => typeof n === 'string' && ASSISTANCE_LISTING.test(n)))];
}

/** One search hit through the whitelist, or null when a required field fails. */
function parseHit(value: unknown): GrantOpportunity | null {
  if (!isRecord(value)) return null;
  const { id, number, title, agency, agencyCode } = value;
  if (typeof id !== 'string' || !/^\d{1,12}$/.test(id)) return null;
  if (typeof number !== 'string' || number === '' || number !== number.trim() || number.length > 100) return null;
  const cleanTitle = typeof title === 'string' ? oneLine(decodeEntities(title)) : '';
  if (cleanTitle === '') return null;
  const opens = issuerDate(value.openDate);
  const stated = issuerDate(value.closeDate);
  if (opens === undefined || stated === undefined) return null;
  const status = issuerStatus(value.oppStatus);
  const named = typeof agency === 'string' ? oneLine(agency) : '';
  const code = typeof agencyCode === 'string' ? oneLine(agencyCode) : '';
  return {
    id,
    number,
    title: cleanTitle,
    agency: named || code || null,
    status,
    opens,
    closes: status === 'forecasted' ? null : stated,
    listings: listingNumbers(value.cfdaList),
    url: `https://www.grants.gov/search-results-detail/${id}`
  };
}

/** A raw search2 answer to typed rows. Pure. */
export function parseGrantsSearch(raw: unknown, readAt: string): GrantsRead {
  if (!isRecord(raw) || raw.errorcode !== 0) return { state: 'unavailable', reason: 'envelope' };
  const data = raw.data;
  if (!isRecord(data) || !Array.isArray(data.oppHits)) return { state: 'unavailable', reason: 'shape' };
  const hitCount = data.hitCount;
  if (typeof hitCount !== 'number' || !Number.isSafeInteger(hitCount) || hitCount < 0) {
    return { state: 'unavailable', reason: 'shape' };
  }
  const rows: GrantOpportunity[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const value of data.oppHits) {
    const row = parseHit(value);
    if (row === null) dropped += 1;
    else if (!seen.has(row.id)) {
      seen.add(row.id);
      rows.push(row);
    }
  }
  return { state: 'live', readAt, hitCount, rows, dropped, partial: dropped > 0 || hitCount > data.oppHits.length };
}

/** The hazards a title names, in table order. */
export function grantTopics(title: string): GrantTopic[] {
  return [...new Set(GRANT_TOPIC_RULES.filter((rule) => rule.pattern.test(title)).map((rule) => rule.topic))];
}

/**
 * Rows still open on `today` (an ISO date): posted with no stated close date or
 * one on or after `today`, and forecasts. Each carries its hazard tags. Pure.
 */
export function openTribalGrants(rows: readonly GrantOpportunity[], today: string): TaggedGrant[] {
  return rows
    .filter((row) => row.status === 'forecasted' || (row.status === 'posted' && (row.closes === null || row.closes >= today)))
    .map((row) => ({ ...row, topics: grantTopics(row.title) }));
}

/** The rows tagged with one mode's hazard. */
export function grantsForMode(rows: readonly TaggedGrant[], mode: HazardClusterKey): TaggedGrant[] {
  return rows.filter((row) => row.topics.includes(mode));
}

function unavailableReason(err: unknown): GrantsUnavailableReason {
  if (isFetchTimeout(err)) return 'timeout';
  if (err instanceof SyntaxError || err instanceof RangeError) return 'body';
  if (err instanceof Error && err.message.startsWith('HTTP ')) return 'http';
  return 'network';
}

/**
 * Read open Tribal-listed opportunities once. A cancel through `signal`
 * rejects with an AbortError (the caller drops it); every other failure is
 * `unavailable` with a reason code for logs, never shown as "no grants".
 */
export async function readTribalGrants(
  signal: AbortSignal | null,
  now: Date = new Date(),
  timeoutMs: number = TIMEOUT_MS
): Promise<GrantsRead> {
  let raw: unknown;
  try {
    raw = await fetchJsonWithBudget(GRANTS_GOV_SEARCH_URL, grantsSearchRequest(), signal, timeoutMs, MAX_BODY_BYTES);
  } catch (err) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    return { state: 'unavailable', reason: unavailableReason(err) };
  }
  // A late answer to a superseded read is never returned.
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  return parseGrantsSearch(raw, now.toISOString());
}
