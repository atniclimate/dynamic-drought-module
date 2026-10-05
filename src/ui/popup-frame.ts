/**
 * The popup frame (S30D D1 M23; DDM-P11-T04; DR-139; design record
 * interface-chrome-popups-text.md sections 3.1 to 3.5 as amended by the
 * Codex Tier 2 review's PF1 to PF4, D1-CODEX-TIER2-DISPOSITION.md).
 *
 * Every location popup renders through this one template: a frozen head of
 * title, issuer with its role, value, clock, source and actions, and a
 * scrolling body of rows, records, qualifications, more links and the
 * primary source again (PF3: the head may cede its height under squeeze, so
 * the body keeps the source reachable). A group of overlapping agency
 * perimeters, or a collection of groups, renders in the same frame with a
 * head derived ONLY from group facts (PF2).
 *
 * LAZY BY CONTRACT: the InteractionCoordinator is this module's one value
 * importer, by a single dynamic import warmed when the first click target
 * registers; builders hand it a model and import only types from here, and
 * main.ts never imports it (scripts/check-activation-budget.mjs holds it out
 * of the initial static set and out of every other feature's activation
 * closure). The DOM contract it emits: `article[data-popup-frame]` with
 * exactly two regions, `[data-popup-region="head"]` then
 * `[data-popup-region="body"]`.
 *
 * ONE ESCAPE BOUNDARY (PF4): `serializePopupFrame` builds the markup string
 * and passes every model string through `escapeHtml` exactly once, at the
 * point it is written; nothing else writes markup and no model field
 * carries markup. Every href goes through `checkPopupHref` (parsed, https,
 * no userinfo, the exact host where one is mandated). `renderPopupFrame` is
 * the thin DOM wrapper for a builder that wants an element.
 *
 * WORDS: the only strings this module writes are the ratified ones: the
 * four issuer role prefixes (interface-chrome-popups-text.md 3.3), the
 * group head, notices and footer (grouping-contract.md 12.1, and 3.4 of the
 * chrome record for the issuer statement, the computed clock and the
 * per-record source), the record issuer names (12.1 slot 1) and the
 * briefing door's existing label (src/ui/popups.ts
 * buildImpactTriggerButtonHtml). Every other visible string is the
 * builder's, from the issuer.
 *
 * Node-importable: no DOM at module level, no product catalog value
 * (ProductKey is a type-only import; src/config/products.ts is eager-
 * forbidden and would otherwise ride every builder chunk).
 */

import type { ProductKey } from '../config/products';
import type { SparklineOptions } from './charts';
import { escapeHtml } from '../util/escape';
import { dateTok } from '../util/text-tokens';

/** A model the renderer refuses (a caller bug, never a data condition). */
export class PopupFrameError extends Error {
  // Set in the constructor, never as a class field: the build target lowers
  // a class field through a shared defineProperty helper chunk that the
  // entry then imports (S30D D1 M24 repair, check:activation).
  constructor(message?: string) {
    super(message);
    this.name = 'PopupFrameError';
  }
}

function fail(message: string): never {
  throw new PopupFrameError(message);
}

// ---------------------------------------------------------------------------
// Clocks (PF1): each at its issuer's precision. A year never becomes a date,
// a month never gains a day, an instant always names its zone, and a time
// the issuer supplied but that does not parse is shown as supplied, with the
// builder's explanation, never as a parsed instant.
// ---------------------------------------------------------------------------

export type ClockMeaning =
  | 'observed'
  | 'issued'
  | 'valid'
  | 'map-date'
  | 'month'
  | 'perimeter-date'
  | 'discovered'
  | 'record-loaded'
  | 'retrieved'
  | 'edition'
  | 'computed'
  | 'published'
  | 'through'
  | 'data-period'
  | 'as-of';

export type ClockValue =
  | { readonly precision: 'year'; readonly year: string }
  | { readonly precision: 'month'; readonly month: string }
  | { readonly precision: 'date'; readonly date: string }
  | { readonly precision: 'instant'; readonly at: number; readonly zone: string }
  | { readonly precision: 'supplied'; readonly text: string; readonly explanation: string };

/** A window endpoint the issuer did not state, with the builder's reason. */
export interface ClockAbsent {
  readonly precision: 'absent';
  readonly reason: string;
}

export interface WindowEnd {
  readonly label: string;
  readonly at: ClockValue | ClockAbsent;
}

export type PopupClock =
  | { readonly kind: 'point'; readonly meaning: ClockMeaning; readonly label: string; readonly at: ClockValue }
  | { readonly kind: 'window'; readonly meaning: 'valid' | 'observed'; readonly from: WindowEnd; readonly until: WindowEnd }
  | { readonly kind: 'not-stated'; readonly label: string; readonly reason: string };

// ---------------------------------------------------------------------------
// Issuer, value, source, details
// ---------------------------------------------------------------------------

export type IssuerRole = 'issued-by' | 'boundary-from' | 'computed-by-ddm-from' | 'supplied-by-deployment';

const ROLE_PREFIX: Readonly<Record<IssuerRole, string>> = {
  'issued-by': 'Issued by',
  'boundary-from': 'Boundary from',
  'computed-by-ddm-from': 'Computed by DDM from',
  'supplied-by-deployment': 'Supplied by this deployment'
};

/** The six layer-state words (AGENTS.md rule 6), as a value row may carry one. */
export type SixStateWord = 'loading' | 'live' | 'live (partial)' | 'unavailable' | 'no data' | 'zoom in to load';

export interface PopupLink {
  readonly label: string;
  readonly href: string;
}

/** A stated no-source reason; never mixed with a link (PF4). */
export interface NoSource {
  readonly none: string;
  readonly link?: never;
}

/** The primary source: a validated link, or the builder's stated reason for none. */
export type PopupSource = { readonly link: PopupLink; readonly none?: never } | NoSource;

/** An issuer legend swatch, resolved by the builder from the palette tables. */
export interface IssuerSwatch {
  readonly table: string;
  readonly classKey: string;
  readonly color: string;
}

/**
 * A semantic list item: its text, or its text with a qualifier and the
 * qualifier's tooltip (the nearest-stations distance and its metres).
 */
export type ListItem =
  | string
  | { readonly text: string; readonly qualifier?: { readonly text: string; readonly title: string } };

export interface ValueRow {
  readonly label?: string;
  readonly text: string;
  /** A semantic list (for example one fire name per item), never a joined sentence. */
  readonly items?: readonly ListItem[];
  readonly swatch?: IssuerSwatch;
  readonly state?: SixStateWord;
  /** The row's own issuer, where it differs from the frame's (plan_rules 3). */
  readonly issuer?: string;
  readonly clock?: PopupClock;
}

/** The small typed detail union (PF1): no raw-HTML escape hatch. */
export type PopupDetail =
  | { readonly kind: 'row'; readonly label: string; readonly text: string }
  | {
      readonly kind: 'reading';
      readonly label: string;
      readonly text: string;
      readonly issuer: string;
      readonly clock: PopupClock;
    }
  | { readonly kind: 'list'; readonly label: string; readonly items: readonly [ListItem, ...ListItem[]] }
  | ChartDetail;

/**
 * A chart the lazy builder mounts into `[data-popup-chart]` (the builder
 * keeps chart rendering, PF1): the series and the sparkline options it
 * already passes (src/ui/charts.ts), its unit and its attribution line. The
 * frame writes the series and unit onto the mount point and the
 * attribution as text; the summary is the chart's text alternative.
 */
export interface ChartDetail {
  readonly kind: 'chart';
  readonly label: string;
  readonly chartKey: string;
  readonly summary: string;
  readonly data: readonly number[];
  readonly options: SparklineOptions;
  readonly unit: string;
  readonly attribution?: string;
}

/** The briefing door (the same button src/ui/popups.ts builds today). */
export interface DoorSpec {
  readonly kind: 'briefing';
  readonly place: string;
  readonly warningLabel?: string;
}

// ---------------------------------------------------------------------------
// Records and groups (PF2; grouping-contract.md sections 4 and 12.1)
// ---------------------------------------------------------------------------

/** The admitted grouping issuers (grouping-contract.md section 4); CWFIS M3 is not one (DR-104). */
export type GroupIssuerKey = 'nifc' | 'bcws';

const GROUP_ISSUERS: Readonly<Record<GroupIssuerKey, { readonly record: string; readonly short: string; readonly host: string | null }>> = {
  nifc: { record: 'NIFC WFIGS (United States)', short: 'NIFC WFIGS', host: null },
  bcws: { record: 'BC Wildfire Service (British Columbia)', short: 'BC Wildfire Service', host: 'wildfiresituation.nrs.gov.bc.ca' }
};

export interface RecordSize {
  /** The issuer field's own name, for example "Reported size". Sizes are never summed. */
  readonly label: string;
  readonly text: string;
}

export interface RecordBlock {
  /** The machine record key (data-record-key). */
  readonly key: string;
  readonly issuer: GroupIssuerKey;
  /** The displayed identifier, separate from the name. */
  readonly identifier: string;
  readonly name?: string;
  readonly sizes: readonly RecordSize[];
  /** The issuer's own status words, or the unknown wording; omitted while its wording is pending. */
  readonly status?: { readonly from: 'issuer' | 'unknown'; readonly text: string };
  readonly clocks: readonly [PopupClock, ...PopupClock[]];
  readonly versions?: readonly { readonly id: string; readonly clocks: readonly PopupClock[] }[];
  /** Per-record links; an unsafe one (issuer data) is dropped, never rendered. */
  readonly links: readonly PopupLink[];
  readonly outsideView?: boolean;
}

export type GroupNotice = 'grouping-unavailable' | 'bcws-layer-off';

const NOTICE_TEXT: Readonly<Record<GroupNotice, string>> = {
  'grouping-unavailable': "Grouping with other agencies' perimeters is unavailable right now",
  'bcws-layer-off': 'BC Wildfire Service layer is off; its records are not listed'
};

/** The narrow group input (PF2): the head, count, clock and footer are derived from it. */
export interface GroupInput {
  readonly groupKey: string;
  /** When DDM computed the grouping (epoch ms), and the zone it is shown in. */
  readonly computedAt: number;
  readonly zone: string;
  readonly issuers: readonly [GroupIssuerKey, ...GroupIssuerKey[]];
  readonly records: readonly [RecordBlock, RecordBlock, ...RecordBlock[]];
  /** Existing issuer or builder notes (the generalization note, the strategic-context line). */
  readonly qualifications?: readonly string[];
  readonly notices?: readonly GroupNotice[];
}

// ---------------------------------------------------------------------------
// Protected and deployer products (PF4; plan_rules 7 and 8)
// ---------------------------------------------------------------------------

/** Each sovereign-geography product with its approved caveat variants. */
export type RepresentationCaveat =
  | { readonly product: 'tribal'; readonly variant: 'deployer'; readonly text: string }
  | { readonly product: 'bia-reservations'; readonly variant: 'lar'; readonly text: string }
  | { readonly product: 'aiannh'; readonly variant: 'legal' | 'statistical' | 'otsa'; readonly text: string }
  | { readonly product: 'treaty'; readonly variant: 'agency-representation'; readonly text: string };

export type ProtectedProduct = RepresentationCaveat['product'];

const CAVEAT_VARIANTS: Readonly<Record<ProtectedProduct, readonly string[]>> = {
  tribal: ['deployer'],
  'bia-reservations': ['lar'],
  aiannh: ['legal', 'statistical', 'otsa'],
  treaty: ['agency-representation']
};

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

export type PopupKind = 'place' | 'surface' | 'event' | 'infrastructure' | 'station' | 'label';

const POPUP_KINDS: readonly string[] = ['place', 'surface', 'event', 'infrastructure', 'station', 'label'];

interface FrameCore {
  readonly title: string;
  readonly value: readonly [ValueRow, ...ValueRow[]];
  readonly clocks: readonly [PopupClock, ...PopupClock[]];
  readonly details?: readonly PopupDetail[];
  readonly qualifications?: readonly string[];
  readonly records?: readonly [RecordBlock, ...RecordBlock[]];
  readonly notices?: readonly GroupNotice[];
  readonly actions?: readonly DoorSpec[];
}

export interface IssuedModel extends FrameCore {
  readonly kind: PopupKind;
  readonly issuer: {
    readonly role: 'issued-by' | 'boundary-from' | 'computed-by-ddm-from';
    readonly name: string;
    readonly productKey: Exclude<ProductKey, ProtectedProduct>;
  };
  readonly source: PopupSource;
  readonly moreLinks?: readonly PopupLink[];
  readonly representation?: never;
}

type AgencyProtected = Exclude<ProtectedProduct, 'tribal'>;

/** A federal or agency representation of Tribal or Treaty geography: its caveat variant is required. */
export type ProtectedModel = {
  [P in AgencyProtected]: FrameCore & {
    readonly kind: 'place';
    readonly issuer: { readonly role: 'boundary-from'; readonly name: string; readonly productKey: P };
    readonly source: PopupSource;
    readonly moreLinks?: readonly PopupLink[];
    readonly representation: Extract<RepresentationCaveat, { readonly product: P }>;
  };
}[AgencyProtected];

/** The deployer-supplied Tribal Lands slot: a stated no-source reason, and no link anywhere. */
export interface DeployerModel extends FrameCore {
  readonly kind: 'place';
  readonly issuer: { readonly role: 'supplied-by-deployment'; readonly productKey: 'tribal' };
  readonly source: NoSource;
  readonly moreLinks?: never;
  readonly records?: never;
  readonly representation: Extract<RepresentationCaveat, { readonly product: 'tribal' }>;
}

export interface GroupModel {
  readonly kind: 'group';
  readonly group: GroupInput;
}

/** Two or more groups under one click: sections inside ONE frame root, ordered by group key. */
export interface CollectionModel {
  readonly kind: 'collection';
  readonly sections: readonly [GroupInput, GroupInput, ...GroupInput[]];
}

export type PopupModel = IssuedModel | ProtectedModel | DeployerModel | GroupModel | CollectionModel;

type FeatureModel = IssuedModel | ProtectedModel | DeployerModel;

// ---------------------------------------------------------------------------
// The single escape and link boundary
// ---------------------------------------------------------------------------

/** Model text, escaped once, as it is written into the markup. */
function text(value: string): string {
  if (typeof value !== 'string') fail(`expected a string, got ${typeof value}`);
  return escapeHtml(value);
}

/** A required, non-blank model string. */
function stated(value: string | undefined, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail(`${what} must be a non-empty string`);
  return value;
}

/**
 * The one runtime URL check (PF4): a parsed absolute URL, https only, no
 * userinfo, and the exact hostname when one is mandated (the BC record host,
 * grouping-contract.md:127). Returns the normalized href, or null.
 */
export function checkPopupHref(href: unknown, host?: string): string | null {
  if (typeof href !== 'string') return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (host !== undefined && url.hostname !== host) return null;
  return url.href;
}

function anchor(label: string, href: string): string {
  return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${text(label)}</a>`;
}

/** A builder-supplied link: an invalid one is a caller bug and throws. */
function requiredLink(link: PopupLink): string {
  const href = checkPopupHref(link?.href);
  if (href === null) fail(`not an https link: ${String(link?.href)}`);
  return anchor(stated(link.label, 'a link label'), href);
}

// ---------------------------------------------------------------------------
// Clock formatting: pure string work on YYYY, YYYY-MM and YYYY-MM-DD (never
// `new Date()` on a date-only value, which would shift a day west of UTC);
// instants through dateTok with their named zone.
// ---------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const NBSP = ' ';

function monthName(value: string): string {
  return MONTHS[Number(value) - 1] ?? fail(`not a month: ${value}`);
}

function formatDateOnly(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const day = match ? Number(match[3]) : 0;
  if (!match || day < 1 || day > 31) fail(`not a YYYY-MM-DD date: ${value}`);
  return `${monthName(match[2]!)}${NBSP}${day},${NBSP}${match[1]}`;
}

function checkZone(zone: string): string {
  stated(zone, 'a clock zone');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    fail(`not a time zone: ${zone}`);
  }
  return zone;
}

/** "14:05 PDT": a time of day that names its zone. */
function formatTimeOfDay(at: number, zone: string): string {
  if (!Number.isFinite(at)) fail('a computed time must be a finite epoch');
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: checkZone(zone),
    timeZoneName: 'short'
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('hour')}:${part('minute')}${NBSP}${part('timeZoneName')}`;
}

function time(datetime: string, shown: string): string {
  return `<time datetime="${escapeHtml(datetime)}">${text(shown)}</time>`;
}

/*
 * READ ONCE, NESTED TOO (the Codex r3 re-check, finding 1): every serializer
 * below reads each field of its input exactly once into a local, validates
 * the local, and writes only the local, escaped at the write. A getter that
 * answers differently on a second read is never asked twice.
 */
function clockValue(value: ClockValue | ClockAbsent): string {
  const v = value as unknown as Readonly<Record<string, unknown>>;
  const precision = v.precision;
  switch (precision) {
    case 'year': {
      const year = v.year as string;
      if (typeof year !== 'string' || !/^\d{4}$/.test(year)) fail(`not a year: ${String(year)}`);
      return time(year, year);
    }
    case 'month': {
      const month = v.month as string;
      const match = typeof month === 'string' ? /^(\d{4})-(\d{2})$/.exec(month) : null;
      if (!match) fail(`not a YYYY-MM month: ${String(month)}`);
      return time(month, `${monthName(match[2]!)}${NBSP}${match[1]}`);
    }
    case 'date': {
      const date = v.date as string;
      return time(date, formatDateOnly(date));
    }
    case 'instant': {
      const at = v.at as number;
      const zone = v.zone as string;
      if (!Number.isFinite(at)) fail('an instant must be a finite epoch');
      return time(new Date(at).toISOString(), dateTok(at, checkZone(zone)));
    }
    case 'supplied':
      return `<span data-clock-supplied>${text(stated(v.text as string, 'supplied time text'))}</span> <span data-clock-explanation>${text(stated(v.explanation as string, 'a supplied time explanation'))}</span>`;
    case 'absent':
      return `<span data-clock-reason>${text(stated(v.reason as string, 'an absence reason'))}</span>`;
    default:
      return fail('unknown clock precision');
  }
}

function clockLine(meaning: string, label: string, value: string): string {
  return `<p data-clock-meaning="${escapeHtml(meaning)}"><span class="popup-clock-label">${text(label)}</span> ${value}</p>`;
}

function windowEnd(meaning: string, end: WindowEnd): string {
  const label = end?.label;
  const at = end?.at;
  return clockLine(meaning, label, clockValue(at));
}

function clockHtml(clock: PopupClock): string {
  const c = clock as unknown as Readonly<Record<string, unknown>>;
  const kind = c.kind;
  switch (kind) {
    case 'point': {
      const meaning = c.meaning as string;
      const label = c.label as string;
      return clockLine(meaning, label, clockValue(c.at as ClockValue));
    }
    case 'window': {
      const meaning = c.meaning as string;
      const from = c.from as WindowEnd;
      const until = c.until as WindowEnd;
      return windowEnd(meaning, from) + windowEnd(meaning, until);
    }
    case 'not-stated': {
      const label = c.label as string;
      const reason = c.reason as string;
      return clockLine('not-stated', label, clockValue({ precision: 'absent', reason }));
    }
    default:
      return fail('unknown clock kind');
  }
}

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

function listItem(item: ListItem): string {
  if (typeof item === 'string') return `<li>${text(item)}</li>`;
  const itemText = item?.text;
  const qualifier = item?.qualifier;
  if (qualifier === undefined) return `<li>${text(stated(itemText, 'a list item'))}</li>`;
  const qualifierText = qualifier?.text;
  const qualifierTitle = qualifier?.title;
  return (
    `<li>${text(stated(itemText, 'a list item'))}` +
    ` <span data-list-qualifier title="${escapeHtml(stated(qualifierTitle, 'a qualifier title'))}">${text(stated(qualifierText, 'a qualifier'))}</span>` +
    `</li>`
  );
}

function listItems(items: readonly ListItem[]): string {
  return `<ul>${listOf(items, 'list items').map(listItem).join('')}</ul>`;
}

function chartHtml(chart: ChartDetail): string {
  const chartKey = chart.chartKey;
  const unit = chart.unit;
  const label = chart.label;
  const summary = chart.summary;
  const attribution = chart.attribution;
  // One copy of the series, validated and written from the copy.
  const data = listOf(chart.data, 'chart data');
  if (!data.every((v) => typeof v === 'number' && Number.isFinite(v))) fail('chart data must be finite numbers');
  return (
    `<figure data-detail="chart" data-popup-chart="${escapeHtml(chartKey)}" data-chart-values="${escapeHtml(data.join(','))}" data-chart-unit="${escapeHtml(stated(unit, 'a chart unit'))}">` +
    `<figcaption>${text(label)}</figcaption><p>${text(summary)}</p>` +
    (attribution === undefined ? '' : `<p data-chart-attribution>${text(attribution)}</p>`) +
    `</figure>`
  );
}

function swatchHtml(value: IssuerSwatch): string {
  const table = value?.table;
  const classKey = value?.classKey;
  const color = value?.color;
  if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) fail(`not a swatch colour: ${String(color)}`);
  return `<span class="popup-swatch" aria-hidden="true" data-swatch-table="${escapeHtml(table)}" data-swatch-class="${escapeHtml(classKey)}" style="--popup-swatch: ${escapeHtml(color)}"></span>`;
}

function valueRowHtml(row: ValueRow): string {
  const label = row.label;
  const swatch = row.swatch;
  const rowText = row.text;
  const items = row.items;
  const state = row.state;
  const issuer = row.issuer;
  const clock = row.clock;
  const list = items === undefined ? [] : listOf(items, 'value items');
  return (
    `<div data-value-row>` +
    (label === undefined ? '' : `<span class="popup-value-label">${text(label)}</span> `) +
    (swatch ? swatchHtml(swatch) : '') +
    `<span class="popup-value-text">${text(stated(rowText, 'a value text'))}</span>` +
    (list.length > 0 ? listItems(list) : '') +
    (state === undefined ? '' : ` <span data-state>${text(state)}</span>`) +
    (issuer === undefined ? '' : ` <span data-value-issuer>${text(issuer)}</span>`) +
    (clock === undefined ? '' : clockHtml(clock)) +
    `</div>`
  );
}

function detailHtml(detail: PopupDetail): string {
  const d = detail as unknown as Readonly<Record<string, unknown>>;
  const kind = d.kind;
  switch (kind) {
    case 'row': {
      const label = d.label as string;
      const rowText = d.text as string;
      return `<dl data-detail="row"><dt>${text(label)}</dt><dd>${text(rowText)}</dd></dl>`;
    }
    case 'reading': {
      const label = d.label as string;
      const readingText = d.text as string;
      const issuer = d.issuer as string;
      const clock = d.clock as PopupClock;
      return `<dl data-detail="reading"><dt>${text(label)}</dt><dd>${text(readingText)} <span data-reading-issuer>${text(issuer)}</span>${clockHtml(clock)}</dd></dl>`;
    }
    case 'list': {
      const label = d.label as string;
      const items = d.items as readonly ListItem[];
      return `<div data-detail="list"><p>${text(label)}</p>${listItems(items)}</div>`;
    }
    case 'chart':
      return chartHtml(detail as ChartDetail);
    default:
      return fail('unknown detail kind');
  }
}

function doorHtml(door: DoorSpec): string {
  const kind = door?.kind;
  const doorPlace = door?.place;
  const warningLabel = door?.warningLabel;
  if (kind !== 'briefing') fail('unknown door kind');
  const place = text(stated(doorPlace, 'a door place'));
  const pulse = warningLabel !== undefined;
  const label = pulse
    ? `${text(warningLabel)} - Open the Impact Briefing for ${place}`
    : `Open the Impact Briefing for ${place}`;
  return `<button type="button" class="${pulse ? 'popup-impact-btn popup-impact-btn--pulse' : 'popup-impact-btn'}" data-ddm-impact-trigger>${label}</button>`;
}

function noteHtml(note: string, attribute = ''): string {
  return `<p data-popup-slot="note"${attribute}>${text(stated(note, 'a qualification'))}</p>`;
}

function issuerName(key: GroupIssuerKey): (typeof GROUP_ISSUERS)[GroupIssuerKey] {
  return Object.prototype.hasOwnProperty.call(GROUP_ISSUERS, key) ? GROUP_ISSUERS[key] : fail(`not an admitted group issuer: ${String(key)}`);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * ONE SNAPSHOT (PF4; the Codex r2 re-check, finding 1): a model may be any
 * structurally typed object, getters and proxies included, so every field
 * the frame validates or renders is read exactly once into plain locals,
 * the snapshot is validated, and the markup is written from the snapshot
 * only. A getter that changes the model after its read changes nothing.
 */
function listOf<T>(value: readonly T[] | undefined, what: string): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(`${what} must be a list`);
  return Array.from(value);
}

/** A record as read once (see ONE SNAPSHOT). */
interface RecordSnap {
  readonly key: string;
  readonly issuer: GroupIssuerKey;
  readonly identifier: string;
  readonly name: string | undefined;
  readonly sizes: readonly RecordSize[];
  readonly status: { readonly from: string; readonly text: string } | undefined;
  readonly clocks: readonly PopupClock[];
  readonly versions: readonly { readonly id: string; readonly clocks: readonly PopupClock[] }[];
  readonly links: readonly PopupLink[];
  readonly outsideView: boolean;
}

function snapshotRecord(record: RecordBlock): RecordSnap {
  const status = record.status;
  return {
    key: record.key,
    issuer: record.issuer,
    identifier: record.identifier,
    name: record.name,
    sizes: listOf(record.sizes, 'record sizes').map((size) => ({ label: size.label, text: size.text })),
    status: status === undefined ? undefined : { from: status.from, text: status.text },
    clocks: listOf(record.clocks, 'record clocks'),
    versions: listOf(record.versions, 'record versions').map((v) => ({ id: v.id, clocks: listOf(v.clocks, 'version clocks') })),
    links: listOf(record.links, 'record links').map((link) => ({ label: link?.label, href: link?.href }) as PopupLink),
    outsideView: record.outsideView === true
  };
}

/** Records by issuer display name, then record key; never by size, date or status. */
function sortRecords(records: readonly RecordSnap[]): RecordSnap[] {
  return records
    .slice()
    .sort((a, b) => compareText(issuerName(a.issuer).record, issuerName(b.issuer).record) || compareText(a.key, b.key));
}

function recordHtml(record: RecordSnap): string {
  const issuer = issuerName(record.issuer);
  const links = record.links
    .map((link) => {
      const href = checkPopupHref(link.href, issuer.host ?? undefined);
      return href === null ? '' : anchor(link.label, href);
    })
    .join(' ');
  const versions = record.versions;
  return (
    `<li data-record-key="${escapeHtml(stated(record.key, 'a record key'))}" data-record-issuer="${escapeHtml(record.issuer)}">` +
    `<h4><span data-record-slot="issuer">${text(issuer.record)}</span> <span data-record-slot="name">` +
    (record.name === undefined ? '' : `${text(record.name)} `) +
    `<span data-record-identifier>${text(stated(record.identifier, 'a record identifier'))}</span></span></h4>` +
    (record.sizes.length > 0
      ? `<dl data-record-slot="sizes">${record.sizes.map((size) => `<dt>${text(size.label)}</dt><dd>${text(size.text)}</dd>`).join('')}</dl>`
      : '') +
    (record.status === undefined
      ? ''
      : `<p data-record-slot="status" data-status-from="${record.status.from === 'issuer' ? 'issuer' : 'unknown'}">${text(record.status.text)}</p>`) +
    `<div data-record-slot="clocks">${record.clocks.map(clockHtml).join('')}</div>` +
    (versions.length > 0
      ? `<ul data-record-slot="versions">${versions.map((v) => `<li><span data-version-id>${text(v.id)}</span>${v.clocks.map(clockHtml).join('')}</li>`).join('')}</ul>`
      : '') +
    (links === '' ? '' : `<p data-record-slot="source">${links}</p>`) +
    (record.outsideView ? `<p data-record-slot="outside-view">extends outside this view</p>` : '') +
    `</li>`
  );
}

function recordsHtml(records: readonly RecordSnap[]): string {
  return `<ol class="popup-records" data-popup-slot="records">${sortRecords(records).map(recordHtml).join('')}</ol>`;
}

function noticesHtml(notices: readonly GroupNotice[] | undefined): string {
  return (notices ?? [])
    .map((notice) =>
      Object.prototype.hasOwnProperty.call(NOTICE_TEXT, notice)
        ? noteHtml(NOTICE_TEXT[notice], ` data-notice="${escapeHtml(notice)}"`)
        : fail(`unknown notice: ${String(notice)}`)
    )
    .join('');
}

function head(slots: {
  readonly title: string;
  readonly issuer: string;
  readonly value: string;
  readonly clocks: string;
  readonly source: string;
  readonly actions: string;
}): string {
  return (
    `<div data-popup-region="head">` +
    `<h3 class="popup-title" data-popup-slot="title">${slots.title}</h3>` +
    `<p class="popup-agency" data-popup-slot="issuer">${slots.issuer}</p>` +
    `<div data-popup-slot="value">${slots.value}</div>` +
    `<div data-popup-slot="clock">${slots.clocks}</div>` +
    `<p data-popup-slot="source">${slots.source}</p>` +
    `<div data-popup-slot="actions">${slots.actions}</div>` +
    `</div>`
  );
}

// ---------------------------------------------------------------------------
// Runtime product policy (PF4: in types AND at runtime)
// ---------------------------------------------------------------------------

/** A feature model as read once (see ONE SNAPSHOT). */
interface FeatureSnap {
  readonly kind: string;
  readonly title: string;
  readonly role: string;
  readonly name: string | undefined;
  readonly product: string;
  /** The source object's own enumerable keys, and whether any `link` is reachable on it (`in`). */
  readonly sourceKeys: readonly string[];
  readonly sourceHasLink: boolean;
  /** Read only for a non-deployer; a deployer's `link` is never read. */
  readonly link: PopupLink | undefined;
  readonly none: string | undefined;
  readonly value: readonly ValueRow[];
  readonly clocks: readonly PopupClock[];
  readonly details: readonly PopupDetail[];
  readonly qualifications: readonly string[];
  readonly records: readonly RecordSnap[];
  readonly notices: readonly GroupNotice[];
  readonly actions: readonly DoorSpec[];
  readonly moreLinks: readonly PopupLink[];
  readonly caveat: { readonly product: string; readonly variant: string; readonly text: string } | null | undefined;
}

function snapshotFeature(model: FeatureModel, kind: string): FeatureSnap {
  const issuer = model.issuer as { readonly role?: string; readonly name?: string; readonly productKey?: string } | null | undefined;
  if (typeof issuer !== 'object' || issuer === null) fail('a popup names its issuer');
  const role = issuer.role as string;
  const deployer = role === 'supplied-by-deployment';
  const rep = model.representation as RepresentationCaveat | null | undefined;
  const source: unknown = model.source;
  if (typeof source !== 'object' || source === null) fail('a popup source is a link or a stated no-source reason');
  const sourceHasLink = 'link' in source;
  return {
    kind,
    title: model.title,
    role,
    name: deployer ? undefined : issuer.name,
    product: issuer.productKey as string,
    // The link-bearing lists are read before the source, so no getter on
    // the source can add to them after their one read.
    records: listOf<RecordBlock>(model.records, 'records').map(snapshotRecord),
    moreLinks: listOf<PopupLink>(model.moreLinks, 'more links'),
    sourceKeys: Object.keys(source),
    sourceHasLink,
    link: !deployer && sourceHasLink ? (source as { readonly link?: PopupLink }).link : undefined,
    none: (source as { readonly none?: string }).none,
    value: listOf(model.value, 'value rows'),
    clocks: listOf(model.clocks, 'clocks'),
    details: listOf(model.details, 'details'),
    qualifications: listOf(model.qualifications, 'qualifications'),
    notices: listOf(model.notices, 'notices'),
    actions: listOf(model.actions, 'actions'),
    caveat: rep === undefined || rep === null ? rep : { product: rep.product, variant: rep.variant, text: rep.text }
  };
}

function checkProductPolicy(model: FeatureSnap): void {
  const product = model.product;
  const variants = Object.prototype.hasOwnProperty.call(CAVEAT_VARIANTS, product)
    ? CAVEAT_VARIANTS[product as ProtectedProduct]
    : null;
  const caveat = model.caveat;
  if (variants !== null) {
    if (!caveat || caveat.product !== product || !variants.includes(caveat.variant) || typeof caveat.text !== 'string' || caveat.text.trim() === '') {
      throw new PopupFrameError(`${product} needs its approved representation caveat (plan_rules 8)`);
    }
    // Every protected product is a place (ProtectedModel, DeployerModel);
    // the agency representations' issuer supplied the boundary, and the
    // deployer's own role is checked below.
    if (model.kind !== 'place') fail(`${product} is a place`);
    if (product !== 'tribal' && model.role !== 'boundary-from') {
      fail(`${product} is a place with a boundary-from issuer`);
    }
  } else if (caveat !== undefined) {
    fail(`${product} carries a representation caveat of another product`);
  }
  const deployer = model.role === 'supplied-by-deployment';
  if (deployer !== (product === 'tribal')) fail('the deployer role belongs to the deployer Tribal Lands product only');
  if (deployer) {
    // Exactly the reason: a link (or any other key) beside `none` is refused,
    // never rendered (PF4: no link through any slot, checked at runtime).
    // `in` also sees an inherited, getter or non-enumerable link.
    const keys = model.sourceKeys;
    if (keys.length !== 1 || keys[0] !== 'none' || model.sourceHasLink || model.moreLinks.length > 0 || model.records.length > 0) {
      fail('a deployer popup states why it has no source and links nowhere (plan_rules 7)');
    }
  }
}

// ---------------------------------------------------------------------------
// The two frame shapes
// ---------------------------------------------------------------------------

function featureFrame(model: FeatureModel, kind: string): string {
  const s = snapshotFeature(model, kind);
  if (!POPUP_KINDS.includes(s.kind)) fail(`unknown popup kind: ${String(s.kind)}`);
  checkProductPolicy(s);
  if (s.value.length === 0) fail('a popup needs a value row');
  if (s.clocks.length === 0) fail('a popup needs a clock');

  const deployer = s.role === 'supplied-by-deployment';
  const prefix = Object.prototype.hasOwnProperty.call(ROLE_PREFIX, s.role) ? ROLE_PREFIX[s.role as IssuerRole] : fail(`unknown issuer role: ${String(s.role)}`);
  const issuer = deployer ? text(prefix) : `${text(prefix)}: ${text(stated(s.name, 'an issuer name'))}`;
  // A deployer's link-bearing slots are empty by construction: its source is
  // its reason (its `link` was never read), and no more links or records.
  const source = !deployer && s.link !== undefined ? requiredLink(s.link) : text(stated(s.none, 'a no-source reason'));
  const moreLinks = deployer ? '' : s.moreLinks.map(requiredLink).join(' ');
  const records = deployer ? [] : s.records;
  const caveat = s.caveat;

  return (
    `<article data-popup-frame data-popup-kind="${escapeHtml(s.kind)}" data-popup-product="${escapeHtml(s.product)}">` +
    head({
      title: text(stated(s.title, 'a title')),
      issuer,
      value: s.value.map(valueRowHtml).join(''),
      clocks: s.clocks.map(clockHtml).join(''),
      source,
      actions: s.actions.map(doorHtml).join('')
    }) +
    `<div data-popup-region="body">` +
    (s.details.length > 0 ? `<div data-popup-slot="rows">${s.details.map(detailHtml).join('')}</div>` : '') +
    (records.length > 0 ? recordsHtml(records) : '') +
    (caveat ? noteHtml(caveat.text, ` data-representation="${escapeHtml(`${caveat.product}:${caveat.variant}`)}"`) : '') +
    s.qualifications.map((note) => noteHtml(note)).join('') +
    noticesHtml(s.notices) +
    (moreLinks === '' ? '' : `<p data-popup-slot="more-links">${moreLinks}</p>`) +
    `<p data-popup-slot="source-fallback">${source}</p>` +
    `</div></article>`
  );
}

/** A group input as read once (see ONE SNAPSHOT). */
interface GroupSnap {
  readonly groupKey: string;
  readonly computedAt: number;
  readonly zone: string;
  readonly issuers: readonly GroupIssuerKey[];
  readonly records: readonly RecordSnap[];
  readonly qualifications: readonly string[];
  readonly notices: readonly GroupNotice[];
}

function snapshotGroup(group: GroupInput): GroupSnap {
  if (typeof group !== 'object' || group === null) fail('a group is an object');
  return {
    groupKey: group.groupKey,
    computedAt: group.computedAt,
    zone: group.zone,
    issuers: listOf<GroupIssuerKey>(group.issuers, 'group issuers'),
    records: listOf<RecordBlock>(group.records, 'group records').map(snapshotRecord),
    qualifications: listOf(group.qualifications, 'qualifications'),
    notices: listOf(group.notices, 'notices')
  };
}

function checkGroup(group: GroupSnap): GroupSnap {
  stated(group.groupKey, 'a group key');
  if (group.issuers.length === 0) fail('a group names its issuers');
  group.issuers.forEach(issuerName);
  if (group.records.length < 2) fail('a group holds two records at least');
  for (const record of group.records) {
    if (!group.issuers.includes(record.issuer)) fail(`record ${record.key} is not from one of the group's issuers`);
  }
  formatTimeOfDay(group.computedAt, group.zone);
  return group;
}

function groupTitle(group: GroupSnap): string {
  return `Overlapping agency fire perimeters (${group.records.length} records)`;
}

function groupFrame(input: readonly GroupInput[], kind: 'group' | 'collection'): string {
  const groups = listOf(input, 'groups').map(snapshotGroup).map(checkGroup).sort((a, b) => compareText(a.groupKey, b.groupKey));
  if (new Set(groups.map((g) => g.groupKey)).size !== groups.length) fail('one group key renders as one section');
  if (kind === 'collection' && groups.length < 2) fail('a collection holds two groups at least');

  const issuers = (Object.keys(GROUP_ISSUERS) as GroupIssuerKey[]).filter((key) => groups.some((g) => g.issuers.includes(key)));
  const times = [...new Set(groups.map((g) => formatTimeOfDay(g.computedAt, g.zone)))];
  const footer = times
    .map((at) => noteHtml(`Grouping computed by DDM from the agencies' perimeters at ${at}. DDM states no combined name, size or status.`, ' data-group-footer'))
    .join('');
  const sectionBody = (group: GroupSnap): string =>
    recordsHtml(group.records) + group.qualifications.map((note) => noteHtml(note)).join('') + noticesHtml(group.notices);

  return (
    `<article data-popup-frame data-popup-kind="${kind}">` +
    head({
      title: groups.map((g) => `<span data-group-key="${escapeHtml(g.groupKey)}">${text(groupTitle(g))}</span>`).join(' '),
      issuer: text(`${ROLE_PREFIX['computed-by-ddm-from']} ${issuers.map((key) => GROUP_ISSUERS[key].short).join(' and ')} perimeters`),
      value: `<div data-value-row><span class="popup-value-text">${text('Overlapping agency perimeters counted as one fire area.')}</span></div>`,
      clocks: times.map((at) => clockLine('computed', 'Grouping computed', text(at))).join(''),
      source: `<span data-source="per-record">${text('Source: per record')}</span>`,
      actions: ''
    }) +
    `<div data-popup-region="body">` +
    (kind === 'group'
      ? sectionBody(groups[0]!)
      : groups
          .map((g) => `<section data-popup-section data-group-key="${escapeHtml(g.groupKey)}"><h4>${text(groupTitle(g))}</h4>${sectionBody(g)}</section>`)
          .join('')) +
    footer +
    `</div></article>`
  );
}

/**
 * The frame's markup: one `article[data-popup-frame]` root holding the head
 * region and the body region, every model string escaped once. Throws a
 * PopupFrameError on a model the contract refuses.
 */
export function serializePopupFrame(model: PopupModel): string {
  // The kind is read once here; the feature path is handed it, never re-reads it.
  const kind: string = model.kind;
  if (kind === 'group') return groupFrame([(model as GroupModel).group], 'group');
  if (kind === 'collection') return groupFrame((model as CollectionModel).sections, 'collection');
  return featureFrame(model as FeatureModel, kind);
}

/** The same frame as an element, for a builder that hands the coordinator a node. */
export function renderPopupFrame(model: PopupModel): HTMLElement {
  const template = document.createElement('template');
  template.innerHTML = serializePopupFrame(model);
  const root = template.content.firstElementChild;
  if (!(root instanceof HTMLElement)) fail('the frame serialized to no element');
  return root;
}
