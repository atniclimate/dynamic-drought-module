/**
 * The priority view of the Impact Briefing (owner direction 2026-11-09
 * (sprint), DR-pending): the same briefing, read in a different order and
 * drawn as gauges instead of sentences. It leads with the reads that hold a
 * class in the published reading order (src/impact/priority.ts), then lists
 * everything else at its honest state, then offers the doors to the full
 * detail, which is the unchanged matrix.
 *
 * It is a VIEW, not a second briefing. Every figure here is drawn from a
 * `ClaimReading` that rides a claim the matrix already holds, and wears that
 * claim's own source, date and evidence class; nothing is fetched, computed
 * or scored here, and no claim's sentence is cut to make a label. One tap on
 * any tile opens that hazard's own cells in the matrix (the federal text as
 * the claim renderer shows it, each claim's method and source link) with the
 * doors to the technical section and the acknowledgements beside it.
 *
 * Pure string builders over the briefing model; the panel runtime
 * (src/ui/impact-panel-runtime.ts) owns the view state, the clicks and the
 * focus. Styles: src/styles/briefing-lead.css, imported here so they ride
 * the same lazy chunk as the briefing.
 */

import '../styles/briefing-lead.css';

import { NWS_ALERT_COLORS, NWS_ALERT_DEFAULT_COLOR } from '../config/palette';
import { NIFC_INCIDENT_PRESENTATION } from '../config/wildfire-presentation';
import { claimDateLine, claimRegisterTag, EVIDENCE_PRESENTATION } from '../impact/evidence';
import { HORIZON_CHROME } from '../impact/horizon-chrome';
import { HAZARD_KEYS, HAZARD_LABELS, HORIZON_KEYS } from '../impact/matrix';
import {
  PRIORITY_ORDER_NOTE,
  PRIORITY_ROWS,
  PRIORITY_RULE_STATEMENTS,
  orderBriefing,
  readingHeadline,
  signedIndex,
  sortNwsEvents
} from '../impact/priority';
import type {
  PriorityCellState,
  PriorityEntry,
  PriorityFamily,
  PriorityMember,
  PriorityOrder,
  PriorityRest,
  PriorityUnrankedRead
} from '../impact/priority';
import type {
  ClaimReading,
  HazardCell,
  HazardKey,
  HorizonKey,
  HorizonStatus,
  ImpactBriefing,
  SourcedClaim
} from '../impact/types';
import { checkPopupHref, escapeHtml } from '../util/escape';
import { chainFieldsFromClaim, renderEvidenceChain } from './evidence-chain';
import type { ChainLink } from './evidence-chain';
import {
  HEATRISK_SCALE,
  READ_STATE_WORD,
  USDM_NONE_SLOT,
  USDM_SCALE,
  classGaugeSvg,
  dayStripSvg,
  indexGaugeSvg,
  spcCategoryCell
} from './gauges';
import type { DayStripCell, GaugeState } from './gauges';

/** The two presentations of one briefing. */
export type BriefingView = 'lead' | 'matrix';

/** The most full tiles the view leads with; further ranked reads follow as rows. */
export const LEAD_TILE_MAX = 4;

/** The technical section's anchor for the rule ("one tap to the rule"). */
export const PRIORITY_RULE_ANCHOR = 'impact-technical-priority';

const SWITCH_WORDS: Readonly<Record<BriefingView, string>> = {
  lead: 'Priority',
  matrix: 'Full detail'
};

/** The two-way switch between the priority view and the full detail. */
export function renderViewSwitch(view: BriefingView): string {
  const button = (key: BriefingView): string =>
    `<button type="button" class="briefing-view-btn" data-briefing-view="${key}" data-lead-key="view:${key}" aria-pressed="${view === key}">${SWITCH_WORDS[key]}</button>`;
  return `<div class="briefing-view-switch" role="group" aria-label="Briefing view">${button('lead')}${button('matrix')}</div>`;
}

/**
 * The head of a single hazard's detail: the way back, what the reader is
 * looking at, and the doors to the method and the acknowledgements. Rendered
 * hidden; the runtime fills the hazard word and shows it when a tile opens
 * that hazard's cells.
 */
export function renderFocusHead(): string {
  const door = (action: string, words: string): string =>
    `<button type="button" class="lead-link" data-lead-action="${action}" data-lead-key="focus:${action}">${words}</button>`;
  return (
    `<section class="briefing-focus" aria-labelledby="briefing-focus-title" hidden>` +
    `<button type="button" class="briefing-back" data-lead-action="lead" data-lead-key="focus:back">Priority view</button>` +
    `<h3 class="briefing-focus-title" id="briefing-focus-title" tabindex="-1"></h3>` +
    `<p class="briefing-focus-note">The federal text at all three horizons, as the full detail holds it. Each claim names its source, date and method.</p>` +
    `<p class="lead-links">` +
    door('rule', 'Method and technical information') +
    door('acknowledgements', 'Acknowledgements') +
    door('matrix', 'All four hazards') +
    `</p>` +
    `</section>`
  );
}

// ---------------------------------------------------------------------------
// Figures: one per issuer product family
// ---------------------------------------------------------------------------

function sourceWords(claim: SourcedClaim): string {
  const date = claimDateLine(claim);
  return `${claim.source}${date ? `, ${date}` : ''}`;
}

function usdmGauge(reading: ClaimReading | null, state: GaugeState, claim: SourcedClaim | null): string {
  const read = reading?.kind === 'usdm-category' ? (reading.dm ?? 'none') : null;
  const said =
    state === 'read' && reading
      ? `Read: ${readingHeadline(reading)}. ${claim ? `Source: ${sourceWords(claim)}.` : ''}`
      : `No read: ${state}.`;
  return classGaugeSvg({
    classes: USDM_SCALE,
    none: USDM_NONE_SLOT,
    read,
    state,
    title: `U.S. Drought Monitor scale, D0 to D4. ${said}`
  });
}

function heatRiskGauge(reading: ClaimReading | null, state: GaugeState, claim: SourcedClaim | null): string {
  const value = reading?.kind === 'heatrisk-level' ? reading.value : null;
  const actual: GaugeState = state === 'read' && value === null ? 'no-data' : state;
  const said =
    actual === 'read' && reading
      ? `Read: ${readingHeadline(reading)}. ${claim ? `Source: ${sourceWords(claim)}.` : ''}`
      : actual === 'no-data'
        ? 'No data at the selected point.'
        : `No read: ${state}.`;
  return classGaugeSvg({
    classes: HEATRISK_SCALE,
    read: value,
    state: actual,
    title: `NWS HeatRisk scale, 0 to 4. ${said}`
  });
}

function spcCell(reading: Extract<ClaimReading, { kind: 'spc-fire-days' }>): DayStripCell {
  if (reading.category !== undefined) return spcCategoryCell(reading.category);
  if (reading.probability === '0.70') return { kind: 'probability', percent: 70 };
  if (reading.probability === '0.40') return { kind: 'probability', percent: 40 };
  if (reading.probability === 'Probability Too Low') {
    // The service's own label, under the group's "probability" caption.
    return { kind: 'word', word: 'too low', label: 'Probability Too Low' };
  }
  return { kind: 'none' };
}

function spcCellWords(cell: DayStripCell): string {
  switch (cell.kind) {
    case 'class':
      return cell.label;
    case 'probability':
      return `${cell.percent}% probability`;
    case 'word':
      return cell.label;
    case 'none':
      return 'no area drawn';
    default:
      return 'not read';
  }
}

/** The SPC outlook's eight days on its own clock: Days 1 and 2 by category, Days 3 to 8 by probability. */
function spcStrip(members: readonly PriorityMember[], lead: ClaimReading | null, state: GaugeState): string {
  const cells = new Map<number, DayStripCell>();
  for (const { reading } of members) {
    if (reading.kind !== 'spc-fire-days') continue;
    for (const day of reading.days) cells.set(day, spcCell(reading));
  }
  const leadDay =
    lead?.kind === 'spc-fire-days' && (lead.category !== undefined || lead.probability === '0.70' || lead.probability === '0.40')
      ? Math.min(...lead.days)
      : null;
  const day = (n: number) => ({
    tick: n === 1 ? 'Day 1' : String(n),
    cell: cells.get(n) ?? ({ kind: 'unread' } as const),
    lead: n === leadDay
  });
  const all = [1, 2, 3, 4, 5, 6, 7, 8].map(day);
  const said =
    state === 'read'
      ? all.map((d, index) => `Day ${index + 1}: ${spcCellWords(d.cell)}`).join('. ')
      : `No read: ${state}`;
  return dayStripSvg({
    groups: [
      { caption: 'category', days: all.slice(0, 2) },
      { caption: 'probability', days: all.slice(2) }
    ],
    state,
    title: `SPC Fire Weather Outlook at the selected point, Days 1 to 8. ${said}.`
  });
}

function ensoGauge(reading: ClaimReading | null, state: GaugeState): string {
  const index = reading?.kind === 'enso-index' ? reading : null;
  const said =
    state === 'read' && index
      ? `${index.index} ${signedIndex(index.value)}, ${index.season} ${index.year}${index.preliminary ? ', preliminary' : ''}: ${readingHeadline(index)}.`
      : `No read: ${state}.`;
  const threshold = index?.threshold ?? 0.5;
  return indexGaugeSvg({
    value: index ? index.value : null,
    threshold,
    below: 'La Nina',
    above: 'El Nino',
    ...(index ? { valueLabel: signedIndex(index.value) } : {}),
    state,
    title: `ENSO index against the CPC onset thresholds of minus and plus ${threshold}. ${said}`
  });
}

/**
 * NWS products in effect: each product's own map colour as a keyed flag
 * beside its name. The name is the class; the flag echoes the colour the map
 * draws the same product in.
 */
function nwsFlags(events: readonly string[]): string {
  return (
    `<span class="lead-flags">` +
    sortNwsEvents(events)
      .map(
        (event) =>
          `<span class="lead-flag"><span class="lead-swatch" style="background:${escapeHtml(NWS_ALERT_COLORS[event] ?? NWS_ALERT_DEFAULT_COLOR)}"></span>${escapeHtml(event)}</span>`
      )
      .join('') +
    `</span>`
  );
}

/** The map's own wildfire perimeter mark, beside a perimeter count. */
function perimeterMark(): string {
  return `<span class="lead-swatch lead-swatch-line" style="border-color:${escapeHtml(NIFC_INCIDENT_PRESENTATION.wildfire.lineColor)}"></span>`;
}

/** WFIGS perimeters: the counts by incident class, as the read carries them. */
function wfigsCounts(reading: Extract<ClaimReading, { kind: 'wfigs-perimeters' }>): string {
  // Only a mixed set needs the split: a wildfire-only count is the headline.
  if (reading.prescribed === 0 && reading.other === 0) return '';
  const parts: string[] = [];
  const floor = reading.lowerBound ? 'at least ' : '';
  if (reading.wildfire > 0) {
    parts.push(`<span class="lead-flag">${perimeterMark()}${floor}${reading.wildfire} wildfire</span>`);
  }
  if (reading.prescribed > 0) {
    parts.push(
      `<span class="lead-flag"><span class="lead-swatch lead-swatch-line" style="border-color:${escapeHtml(NIFC_INCIDENT_PRESENTATION.prescribed.lineColor)}"></span>${reading.prescribed} Prescribed fire</span>`
    );
  }
  if (reading.other > 0) {
    parts.push(
      `<span class="lead-flag"><span class="lead-swatch lead-swatch-line lead-swatch-dashed" style="border-color:${escapeHtml(NIFC_INCIDENT_PRESENTATION.other.lineColor)}"></span>${reading.other} other or unclassified</span>`
    );
  }
  return parts.length > 0 ? `<span class="lead-flags">${parts.join('')}</span>` : '';
}

/** The figure for a family that was read. */
function familyFigure(family: PriorityFamily, members: readonly PriorityMember[], lead: PriorityMember): string {
  switch (family) {
    case 'usdm':
      return usdmGauge(lead.reading, 'read', lead.claim);
    case 'heatrisk':
      return heatRiskGauge(lead.reading, 'read', lead.claim);
    case 'spc':
      return spcStrip(members, lead.reading, 'read');
    case 'enso':
      return ensoGauge(lead.reading, 'read');
    case 'nws':
      // The products are the headline itself (`headlineHtml`); no second figure.
      return '';
    case 'wfigs':
      return lead.reading.kind === 'wfigs-perimeters' ? wfigsCounts(lead.reading) : '';
    default:
      return '';
  }
}

/** The family whose gauge stands for a cell when that cell was not read. */
const CELL_GAUGE: Readonly<Partial<Record<`${HazardKey}:${HorizonKey}`, PriorityFamily>>> = {
  'drought:current': 'usdm',
  'heat:nearTerm': 'heatrisk',
  'fire:nearTerm': 'spc',
  'enso:current': 'enso'
};

/** The same family's figure with no read: the scale, in its honest state. */
function unreadFigure(family: PriorityFamily, state: GaugeState): string {
  switch (family) {
    case 'usdm':
      return usdmGauge(null, state, null);
    case 'heatrisk':
      return heatRiskGauge(null, state, null);
    case 'spc':
      return spcStrip([], null, state);
    case 'enso':
      return ensoGauge(null, state);
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// Tiles and rows
// ---------------------------------------------------------------------------

/**
 * Source, date and register: the line every figure carries on its surface.
 * The register word (observed or outlook) is printed only where it says
 * something the evidence badge beside it does not: a Classified HeatRisk read
 * that is an outlook, a Derived read that is observed.
 */
function sourceLine(claim: SourcedClaim): string {
  const date = claimDateLine(claim);
  const register = claimRegisterTag(claim);
  const said = EVIDENCE_PRESENTATION[claim.evidence].label.toLowerCase() === register;
  const meta =
    (date ? `<span class="lead-source-part">${escapeHtml(date)}</span>` : '') +
    (said ? '' : ` <span class="lead-source-part">(${escapeHtml(register)})</span>`);
  return (
    `<span class="lead-source"><span class="lead-source-name">${escapeHtml(claim.source)}</span>` +
    (meta ? ` <span class="lead-source-meta">${meta}</span>` : '') +
    `</span>`
  );
}

function badge(claim: SourcedClaim): string {
  return `<span class="impact-claim-badge">${escapeHtml(EVIDENCE_PRESENTATION[claim.evidence].label)}</span>`;
}

function detailLabel(hazard: HazardKey): string {
  return `Opens the ${HAZARD_LABELS[hazard]} detail: federal text, method, acknowledgements and source link.`;
}

/** The class in the issuer's words, with the issuer's own mark where it has one. */
function headlineHtml(entry: PriorityEntry): string {
  const reading = entry.lead.reading;
  if (reading.kind === 'nws-products') return nwsFlags(reading.events);
  if (reading.kind === 'wfigs-perimeters') {
    return `<span class="lead-flag">${perimeterMark()}${escapeHtml(entry.headline)}</span>`;
  }
  return escapeHtml(entry.headline);
}

/**
 * Where and for what the read holds, in one short line. It never repeats the
 * headline, and for the one read that is not about this place (the ENSO
 * index) it says so first.
 */
function scopeWords(entry: PriorityEntry): string {
  const reading = entry.lead.reading;
  switch (reading.kind) {
    case 'nws-products':
      return 'In effect at the selected point.';
    case 'wfigs-perimeters':
      return 'Current perimeters in the bounding box around this selection, which is wider than the place.';
    case 'usdm-category':
      // Not "this week's map": that is true only until the next release
      // (src/impact/sources.ts, the map date note). The tile's source line
      // carries the map's own date.
      return 'The weekly map, at the selected point.';
    case 'heatrisk-level':
      return 'One 24-hour period, at the selected point.';
    case 'spc-fire-days':
      return 'At the selected point: Days 1 and 2 by category, Days 3 to 8 by probability.';
    case 'enso-index':
      return `A tropical Pacific index, not a read of this place: ${reading.index} ${signedIndex(reading.value)}, ${reading.season} ${reading.year}${reading.preliminary ? ', preliminary' : ''}.`;
    default:
      return '';
  }
}

/**
 * One ranked entry as a tile. The whole tile is the button. Every tile is
 * built the same way and drawn the same size, first or last: the order is a
 * reading order, so nothing about a tile's weight follows from its place.
 *
 * The evidence class rides on `data-evidence`, here and on every read below,
 * never as the matrix's `impact-claim-<class>` name: that name marks a claim
 * of the full detail, which stays in the document beside this view, and the
 * browser tests find a claim by it.
 */
function renderTile(entry: PriorityEntry): string {
  const claim = entry.lead.claim;
  const pres = EVIDENCE_PRESENTATION[claim.evidence];
  const date = claimDateLine(claim);
  const name =
    `${HAZARD_LABELS[entry.hazard]}: ${entry.reason}. Source: ${claim.source}. ` +
    `${date ? `${date}. ` : ''}Evidence: ${pres.label}. ${detailLabel(entry.hazard)}`;
  const figure = familyFigure(entry.family, entry.members, entry.lead);
  return (
    `<li class="lead-tile-item">` +
    `<button type="button" class="lead-tile" data-evidence="${claim.evidence}" data-lead-action="detail" data-lead-hazard="${entry.hazard}" ` +
    `data-lead-row="${entry.row}" data-lead-key="tile:${entry.hazard}:${entry.family}" aria-label="${escapeHtml(name)}">` +
    `<span class="lead-tile-top"><span class="lead-hazard">${escapeHtml(HAZARD_LABELS[entry.hazard])}</span>${badge(claim)}</span>` +
    `<span class="lead-headline">${headlineHtml(entry)}</span>` +
    (figure ? `<span class="lead-figure">${figure}</span>` : '') +
    `<span class="lead-scope">${escapeHtml(scopeWords(entry))}</span>` +
    `<span class="lead-foot">${sourceLine(claim)}<span class="lead-open" aria-hidden="true">Federal text</span></span>` +
    `</button></li>`
  );
}

function horizonWord(horizon: HorizonKey): string {
  return HORIZON_CHROME[horizon].title;
}

function gaugeStateOf(status: Exclude<HorizonStatus, 'ready'>): GaugeState {
  return status === 'loading' ? 'loading' : 'unavailable';
}

function renderState(hazard: HazardKey, state: PriorityCellState, familiesRead: ReadonlySet<PriorityFamily>): string {
  const family = CELL_GAUGE[`${hazard}:${state.horizon}`];
  // The scale appears in its honest state only where its own family gave no
  // read; a partly read cell whose gauge is already drawn gets the words.
  const figure =
    family !== undefined && !familiesRead.has(family)
      ? `<div class="lead-figure">${unreadFigure(family, gaugeStateOf(state.status))}</div>`
      : '';
  // "No source answered" is true only of a settled cell that holds nothing
  // and was given no words. A partly read cell did get an answer (the full
  // detail shows it), and the matrix marks a cell whose lane answered with
  // nothing to say by an empty note: neither may wear that sentence.
  const note =
    state.status === 'loading'
      ? 'Reading sources.'
      : state.status === 'unavailable'
        ? (state.note ?? 'No source answered for this hazard at this horizon.')
        : (state.note ?? '');
  return (
    `<div class="lead-state" data-lead-status="${state.status}">` +
    `<p class="lead-state-line"><span class="impact-hazard-pill impact-hazard-pill-${state.status}">${escapeHtml(READ_STATE_WORD[state.status])}</span>` +
    `<span class="lead-state-horizon">${escapeHtml(horizonWord(state.horizon))}</span></p>` +
    figure +
    (note ? `<p class="lead-state-note">${escapeHtml(note)}</p>` : '') +
    `</div>`
  );
}

/** A family that was read and holds no ranked class: its figure at the read position, in the issuer's words. */
function renderUnrankedRead(read: PriorityUnrankedRead): string {
  const lead = read.members[0]!;
  const figure = familyFigure(read.family, read.members, lead);
  // Where typed data can state the read it does; otherwise the claim's own
  // short sentence stands, whole. USDM's no-polygon sentence always follows
  // its figure, because its caveat is the claim.
  const words = read.headline ?? lead.claim.text;
  const caveat =
    lead.reading.kind === 'usdm-category' && lead.reading.dm === null
      ? `<p class="lead-read-caveat">${escapeHtml(lead.claim.text)}</p>`
      : '';
  return (
    `<div class="lead-read" data-evidence="${lead.claim.evidence}">` +
    `<p class="lead-state-line"><span class="lead-read-words">${escapeHtml(words)}</span>${badge(lead.claim)}</p>` +
    (figure ? `<div class="lead-figure">${figure}</div>` : '') +
    caveat +
    `<p class="lead-read-source">${sourceLine(lead.claim)}</p>` +
    `</div>`
  );
}

/**
 * A read with no class to draw: named by its horizon, source and date, and
 * said to be in the federal text, one tap away on the row's own door. Nothing
 * of the sentence is cut here.
 */
function renderTextRead(horizon: HorizonKey, claim: SourcedClaim): string {
  return (
    `<div class="lead-text-read" data-evidence="${claim.evidence}">` +
    `<p class="lead-state-line"><span class="lead-text-read-words"><span class="lead-state-horizon">${escapeHtml(horizonWord(horizon))}</span>` +
    ` <span class="lead-text-read-where">stated in the federal text</span></span>${badge(claim)}</p>` +
    `<p class="lead-read-source">${sourceLine(claim)}</p></div>`
  );
}

/**
 * A hazard's reads that hold no ranked class, and its cells that were not
 * read, laid out by horizon (Current Conditions, then Near Term) so each sits
 * under the clock it speaks for.
 */
function renderRest(item: PriorityRest, order: PriorityOrder): string {
  const familiesRead = new Set<PriorityFamily>([
    ...item.reads.map((read) => read.family),
    ...order.ranked.filter((entry) => entry.hazard === item.hazard).map((entry) => entry.family)
  ]);
  const blocks: Array<{ readonly horizon: HorizonKey; readonly html: string }> = [
    ...item.reads.map((read) => ({ horizon: read.members[0]!.horizon, html: renderUnrankedRead(read) })),
    ...item.texts.map(({ horizon, claim }) => ({ horizon, html: renderTextRead(horizon, claim) })),
    ...item.states.map((state) => ({
      horizon: state.horizon,
      html: renderState(item.hazard, state, familiesRead)
    }))
  ];
  const body = HORIZON_KEYS.flatMap((horizon) =>
    blocks.filter((block) => block.horizon === horizon).map((block) => block.html)
  ).join('');
  return (
    `<li class="lead-rest-item" data-lead-hazard="${item.hazard}">` +
    `<button type="button" class="lead-rest-open" data-lead-action="detail" data-lead-hazard="${item.hazard}" data-lead-key="rest:${item.hazard}" ` +
    `aria-label="${escapeHtml(`${HAZARD_LABELS[item.hazard]}. ${detailLabel(item.hazard)}`)}">` +
    `<span class="lead-hazard">${escapeHtml(HAZARD_LABELS[item.hazard])}</span><span class="lead-open" aria-hidden="true">Federal text</span></button>` +
    body +
    `</li>`
  );
}

// ---------------------------------------------------------------------------
// Present together
// ---------------------------------------------------------------------------

function windowHolds(reading: ClaimReading, now: number): boolean {
  if (!('window' in reading) || reading.window === undefined) return false;
  const { from, to } = reading.window;
  return (from === undefined || from <= now) && (to === undefined || now < to) && (from !== undefined || to !== undefined);
}

/**
 * Whether a ranked entry speaks for the present moment: a current-horizon
 * read does (in effect, mapped or analyzed now); a near-term read does only
 * while the issuer's own window for it holds the moment.
 */
function presentNow(entry: PriorityEntry, now: number): boolean {
  return entry.lead.horizon === 'current' || windowHolds(entry.lead.reading, now);
}

/**
 * The hazards that hold a ranked read for the same moment, joined as
 * co-occurrence in place and time. No arrow, no order between them beyond the
 * fixed hazard order, and the caption says what the joint is not.
 */
function renderTogether(order: PriorityOrder, now: number): string {
  const present = order.ranked.filter((entry) => presentNow(entry, now));
  const hazards = HAZARD_KEYS.filter((hazard) => present.some((entry) => entry.hazard === hazard));
  if (hazards.length < 2) return '';
  const chips = hazards
    .map((hazard) => {
      const own = present.filter((entry) => entry.hazard === hazard);
      return (
        `<li class="lead-together-item"><span class="lead-hazard">${escapeHtml(HAZARD_LABELS[hazard])}</span>` +
        `<span class="lead-together-classes">${own
          .map((entry) => `<span class="lead-together-class">${escapeHtml(entry.headline)}</span>`)
          .join('')}${
          // The index is present in the same weeks, not in this place.
          hazard === 'enso' ? `<span class="lead-together-scope">tropical Pacific index, not a read of this place</span>` : ''
        }</span>` +
        `</li>`
      );
    })
    .join('');
  // A hazard that was not read cannot be counted in or out: say so.
  const unread = order.rest
    .filter((item) => !hazards.includes(item.hazard) && item.states.some((state) => state.horizon === 'current'))
    .map((item) => {
      const state = item.states.find((candidate) => candidate.horizon === 'current')!;
      return `${HAZARD_LABELS[item.hazard]} (${READ_STATE_WORD[state.status]})`;
    });
  return (
    `<section class="lead-together" aria-labelledby="lead-together-title">` +
    `<h4 class="lead-subtitle" id="lead-together-title">Present together here</h4>` +
    `<ul class="lead-together-list">${chips}</ul>` +
    `<p class="lead-caption">Each holds a ranked read in this briefing, on its own clock: the date is on each read above. They are separate issuer products, joined here only because they are present together. DDM draws no cause between them.</p>` +
    (unread.length > 0
      ? `<p class="lead-caption">Not fully read for this moment: ${escapeHtml(unread.join(', '))}. This strip joins only what was read.</p>`
      : '') +
    `</section>`
  );
}

// ---------------------------------------------------------------------------
// The ENSO link, fed from what the briefing holds
// ---------------------------------------------------------------------------

function findClaim(cell: HazardCell, test: (claim: SourcedClaim) => boolean): SourcedClaim | null {
  return cell.claims.find(test) ?? null;
}

function unreadLink(cell: HazardCell): Pick<ChainLink, 'status' | 'note'> {
  // A settled cell that holds other claims but not this one has no read for
  // this link; that is `unavailable` for the link, whatever the cell reads.
  const status: HorizonStatus = cell.status === 'ready' ? 'unavailable' : cell.status;
  return { status, ...(cell.note ? { note: cell.note } : {}) };
}

/**
 * The five links, built from claims the briefing already holds. Every
 * statement is typed data in the issuer's words; a link the briefing has no
 * source for is drawn as unavailable and says why.
 *
 * The relationship words are the repository's own, each from text it already
 * shows: "companion" is how src/impact/enso.ts names the Nino 3.4 reads beside
 * the index; "historically tends to shift" stands on the NOAA CPC ENSO FAQ
 * sentence the technical section quotes (src/ui/map-technical-information.ts,
 * the ENSO notes); "read beside" claims no relationship at all, and it is
 * all the joint after the unread jet link says: this briefing reads no
 * jet-level product, so it relates that link to nothing.
 */
export function buildEnsoChainLinks(briefing: ImpactBriefing): ChainLink[] {
  const { current, nearTerm, longRange } = briefing.horizons;
  const links: ChainLink[] = [];

  const index = findClaim(current.cells.enso, (claim) => claim.product === 'ensoIndex');
  const indexReading = index?.reading?.kind === 'enso-index' ? index.reading : null;
  links.push({
    key: 'index',
    title: 'Observed index',
    relation: 'companion measurement',
    action: 'detail:enso',
    actionLabel: 'Open the ENSO detail',
    ...(index
      ? {
          status: 'ready' as const,
          ...chainFieldsFromClaim(index),
          ...(indexReading
            ? {
                statement: `${readingHeadline(indexReading)}: ${indexReading.index} ${signedIndex(indexReading.value)} (${indexReading.season} ${indexReading.year}${indexReading.preliminary ? ', preliminary' : ''})`,
                figure: ensoGauge(indexReading, 'read')
              }
            : { note: 'The index state is stated in the ENSO detail.' })
        }
      : unreadLink(current.cells.enso))
  });

  const weekly = findClaim(nearTerm.cells.enso, (claim) => claim.product === 'ensoNino34Weekly');
  const monthly = findClaim(current.cells.enso, (claim) => claim.product === 'ensoNino34Monthly');
  const surface = weekly ?? monthly;
  links.push({
    key: 'pattern',
    title: 'Tropical Pacific surface',
    relation: 'historically tends to shift',
    action: 'detail:enso',
    actionLabel: 'Open the ENSO detail',
    ...(surface
      ? {
          status: 'ready' as const,
          ...chainFieldsFromClaim(surface),
          note: 'The sea surface temperature observation is stated in the ENSO detail.'
        }
      : unreadLink(weekly === null ? nearTerm.cells.enso : current.cells.enso))
  });

  links.push({
    key: 'jet',
    title: 'Jet and storm track (model guidance)',
    status: 'unavailable',
    note: 'This briefing reads no jet-level or storm-track product.',
    relation: 'read beside'
  });

  const outlook = findClaim(longRange.cells.heat, (claim) => claim.reading?.kind === 'cpc-tercile');
  const tercile = outlook?.reading?.kind === 'cpc-tercile' ? outlook.reading : null;
  const tercileWords: Readonly<Record<string, string>> = {
    Above: 'above-normal',
    Below: 'below-normal',
    Normal: 'near-normal'
  };
  links.push({
    key: 'tendency',
    title: 'Seasonal outlook at this point',
    relation: 'read beside',
    action: 'detail:heat',
    actionLabel: 'Open the Heat detail',
    ...(outlook && tercile
      ? {
          status: 'ready' as const,
          ...chainFieldsFromClaim(outlook),
          statement:
            tercile.cat === 'EC'
              ? `Equal Chances (no favored tercile), ${tercile.season}`
              : `${tercile.prob}% chance of ${tercileWords[tercile.cat]} temperature, ${tercile.season}`,
          // vocab-allow: honesty disclaimer denying that the CPC seasonal outlook is an ENSO forecast (DR-019, the technical section's own words)
          note: 'A NOAA Climate Prediction Center seasonal outlook that ENSO informs, not an ENSO forecast.'
        }
      : unreadLink(longRange.cells.heat))
  });

  const drought = findClaim(current.cells.drought, (claim) => claim.reading?.kind === 'usdm-category');
  const usdm = drought?.reading?.kind === 'usdm-category' ? drought.reading : null;
  links.push({
    key: 'here',
    title: 'Observed here now',
    action: 'detail:drought',
    actionLabel: 'Open the Drought detail',
    ...(drought && usdm
      ? {
          status: 'ready' as const,
          ...chainFieldsFromClaim(drought),
          statement: `${readingHeadline(usdm)} at the selected point`,
          ...(usdm.dm === null
            ? { note: 'This client has no analyzed-area mask, so this does not confirm no drought.' }
            : {})
        }
      : unreadLink(current.cells.drought))
  });
  return links;
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

function cellsOf(briefing: ImpactBriefing): HazardCell[] {
  return HORIZON_KEYS.flatMap((horizon) =>
    HAZARD_KEYS.map((hazard) => briefing.horizons[horizon].cells[hazard])
  );
}

/**
 * Render the priority view for one briefing. `now` is the moment the
 * present-together strip speaks for; the runtime passes the render time.
 */
export function renderLeadView(briefing: ImpactBriefing, now: number = Date.now()): string {
  const order = orderBriefing(cellsOf(briefing));
  const tiles = order.ranked.slice(0, LEAD_TILE_MAX);
  const more = order.ranked.slice(LEAD_TILE_MAX);
  const rule = `<button type="button" class="lead-link" data-lead-action="rule" data-lead-key="head:rule">How this is ordered</button>`;
  const lead =
    tiles.length > 0
      ? `<ol class="lead-tiles">${tiles.map(renderTile).join('')}</ol>`
      : `<p class="lead-none">No read here holds a class in the reading order yet. That is not an all-clear: each hazard is listed below at its own state.</p>`;
  // Past the first few, the order simply continues: the same tiles, under
  // their own heading, so no ranked read loses its figure or its place.
  const further =
    more.length > 0
      ? `<h4 class="lead-subtitle">Next in the reading order</h4><ol class="lead-tiles" start="${LEAD_TILE_MAX + 1}">${more.map(renderTile).join('')}</ol>`
      : '';
  const rest =
    order.rest.length > 0
      ? `<section class="lead-rest" aria-labelledby="lead-rest-title">` +
        `<h4 class="lead-subtitle" id="lead-rest-title">Other reads and gaps</h4>` +
        `<p class="lead-caption">Reads that hold no class in the reading order, in the issuer's words, and anything that was not read. Neither is an all-clear.</p>` +
        `<ul class="lead-rest-list">${order.rest.map((item) => renderRest(item, order)).join('')}</ul>` +
        `</section>`
      : '';
  const chain = renderEvidenceChain(buildEnsoChainLinks(briefing), {
    id: 'lead',
    heading: 'ENSO link: the tropical Pacific and this place',
    caption:
      'Five separate claims, each on its own clock and from its own source. The words between them name a relationship seen across past events. They are not a cause, and they do not say what will happen here.'
  });
  return (
    `<section class="briefing-lead" aria-labelledby="briefing-lead-title">` +
    `<div class="lead-head">` +
    `<div class="lead-head-row"><h3 class="impact-section-title" id="briefing-lead-title" tabindex="-1">What leads here</h3>${rule}</div>` +
    `<p class="lead-order-note">${escapeHtml(PRIORITY_ORDER_NOTE)}</p>` +
    `</div>` +
    lead +
    further +
    renderTogether(order, now) +
    rest +
    chain +
    `<div class="lead-doors">` +
    `<button type="button" class="lead-door" data-lead-action="matrix" data-lead-key="door:matrix">Full detail: every hazard at three horizons</button>` +
    `<button type="button" class="lead-door" data-lead-action="rule" data-lead-key="door:rule">Method: how this is ordered</button>` +
    `</div>` +
    `</section>`
  );
}

/**
 * The rule, rendered from the table itself for the technical section: what
 * the order is, each row with the issuer field it reads and where its inner
 * order comes from, and what the order is not.
 */
export function renderPriorityRule(): string {
  const [first, ...others] = PRIORITY_RULE_STATEMENTS;
  const rows = PRIORITY_ROWS.map((row) => {
    const href = checkPopupHref(row.basisUrl);
    const link =
      href !== null
        ? ` <a href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(row.issuer)}: issuer page</a>`
        : '';
    return (
      `<li data-priority-row="${row.key}"><strong>${escapeHtml(row.title)}.</strong> ` +
      `Read from ${escapeHtml(row.field)}. ` +
      `Inside the row: ${escapeHtml(row.orderBasis)}. ` +
      `Classes, first-read first: ${escapeHtml(row.classes.join('; '))}.${link}</li>`
    );
  }).join('');
  return (
    `<h4 id="${PRIORITY_RULE_ANCHOR}" tabindex="-1">Priority view: the reading order</h4>` +
    `<p>${escapeHtml(first ?? '')}</p>` +
    `<ol class="priority-rule-rows">${rows}</ol>` +
    others.map((line) => `<p>${escapeHtml(line)}</p>`).join('')
  );
}
