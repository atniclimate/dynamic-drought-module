/**
 * The ENSO mode's chain, as data (owner direction 2026-11-09 (sprint),
 * DR-pending): five links from the tropical Pacific to a place, each one
 * claim on its own clock, built here as `ChainLink`s for the shared
 * component (src/ui/evidence-chain.ts) that the priority briefing also
 * feeds. Pure string and object builders: no fetch, no DOM, no state, so
 * `node --test` proves every state of every link (tests/enso-chain.test.mjs).
 * The host that gathers the inputs and answers the presses is
 * src/ui/enso-chain.ts.
 *
 * THE FIVE LINKS, and where each read comes from. None is typed here:
 *   1. index     the observed index state: the `ensoIndex` claim and its
 *                typed reading, built in src/impact/enso.ts.
 *   2. pattern   the sea surface temperature anomaly surface the map is
 *                drawing: its registry state and the frame date the layer
 *                announces (src/layers/sst-anomaly.ts).
 *   3. jet       NOAA GFS 250 hPa wind as model guidance: the flow overlay's
 *                own state and its frame's two clocks
 *                (src/layers/enso-flow.ts). Off until a person asks for it.
 *   4. tendency  the NOAA CPC seasonal outlook read at the chosen place:
 *                the claim src/impact/sources.ts builds for the briefing (a
 *                temperature tercile). Its press shows the mode's seasonal
 *                horizon, which may draw another outlook layer; the host
 *                hands over what that horizon draws (`seasonDraws`) and the
 *                link then says so, in the layer's own catalog name.
 *   5. here      what is observed at the chosen place now: the U.S. Drought
 *                Monitor claim the same module builds for the briefing.
 *
 * A link with no read says which of the read states it is in and why. A link
 * whose view was never asked for (the jet overlay off, no place chosen) is
 * `idle` and says so in plain words; it is never drawn as `unavailable`,
 * never as a zero and never as an all-clear.
 *
 * THE WORDS BETWEEN LINKS name a relationship the repository can cite, or
 * say only that two reads sit side by side. None is a cause:
 *   1 to 2  the index is measured in the box the map draws
 *           (src/ui/sst-anomaly-legend.ts: "the dashed box is Nino 3.4, the
 *           region the ENSO index measures").
 *   2 to 3  "historically tends to shift" stands on the NOAA CPC ENSO FAQ
 *           sentence the technical section quotes and src/impact/enso.ts
 *           `ENSO_NESTED_TRUTH.events` carries (the briefing's chain uses the
 *           same words).
 *   3 to 4  one model instant beside a season: the flow notes say the lines
 *           show "the modeled flow at one instant"
 *           (src/ui/map-technical-information.ts FLOW_TECHNICAL_NOTES) and
 *           the outlook speaks for a three-month season. No relationship is
 *           claimed.
 *   4 to 5  "read beside" claims no relationship at all (the briefing's
 *           chain uses the same words).
 */

import { ENSO_NESTED_TRUTH } from '../impact/enso';
import { claimDateLine, EVIDENCE_PRESENTATION } from '../impact/evidence';
import { readingHeadline, signedIndex } from '../impact/priority';
import type { EvidenceClass, SourcedClaim } from '../impact/types';
import { FLOW_WORDS, dateLabel } from '../layers/enso-flow-data';
import type { LayerStatus } from '../types/layer';
import { checkPopupHref, escapeHtml } from '../util/escape';
import { chainFieldsFromClaim } from './evidence-chain';
import type { ChainLink, ChainLinkStatus } from './evidence-chain';
import { READ_STATE_WORD, USDM_NONE_SLOT, USDM_SCALE, classGaugeSvg, indexGaugeSvg } from './gauges';

/** The five link keys, in chain order. Also the tokens of a link's press. */
export const ENSO_CHAIN_KEYS = ['index', 'pattern', 'jet', 'tendency', 'here'] as const;
export type EnsoChainKey = (typeof ENSO_CHAIN_KEYS)[number];

/** What a press on a link asks the host to do (src/ui/enso-chain.ts). */
export type EnsoChainAction = EnsoChainKey | 'place';

/** The bundled index snapshot, read through src/impact/enso.ts. */
export type EnsoRead =
  | { readonly status: 'loading' }
  | { readonly status: 'unavailable'; readonly note: string }
  | { readonly status: 'ready'; readonly claims: readonly SourcedClaim[] };

/** The sea surface temperature surface: its registry state and frame date. */
export interface SurfaceRead {
  /** The layer's status, or null while the registry holds none for it. */
  readonly status: LayerStatus | null;
  /** The displayed frame's date (YYYY-MM-DD), or null when the layer has not stated one. */
  readonly date: string | null;
}

/** The flow overlay as its own panel reports it (src/layers/enso-flow.ts). */
export interface JetRead {
  /** The overlay kind on the map, `off`, or null before the panel has reported. */
  readonly kind: string | null;
  readonly status: 'inactive' | 'off' | 'loading' | 'live' | 'live (partial)' | 'no data' | 'unavailable';
  /** The panel's label for the kind on the map, for example "Atmospheric currents". */
  readonly label: string;
  /** The panel's own state line and qualification sentences. */
  readonly line: string;
  readonly notes: readonly string[];
  /** A drawn frame's model run and valid instant, epoch milliseconds. */
  readonly cycle?: number;
  readonly valid?: number;
}

/** One of the two reads made at the chosen place. */
export type PlaceRead =
  | { readonly status: 'none' }
  | { readonly status: 'loading' }
  | { readonly status: 'unavailable'; readonly note: string }
  | { readonly status: 'ready'; readonly claim: SourcedClaim };

export interface EnsoChainInput {
  readonly enso: EnsoRead;
  readonly surface: SurfaceRead;
  readonly jet: JetRead;
  /**
   * The chosen place's own title, or null when no place is chosen. `inside`
   * is the selection's `pointInsidePlace`: the reads are made at a point the
   * app chose inside the place (a search, a link), not at a click.
   */
  readonly place: { readonly label: string; readonly inside: boolean } | null;
  readonly outlook: PlaceRead;
  readonly here: PlaceRead;
  /**
   * The layers the seasonal press shows on the map, by their catalog names,
   * when none of them is the layer of the outlook the link reads (the mode
   * draws the seasonal precipitation outlook, the link reads the temperature
   * one). Empty or absent when the map draws what the link states.
   */
  readonly seasonDraws?: readonly string[];
}

/** One node of the overview strip: a link at a glance. */
export interface EnsoStripNode {
  readonly key: EnsoChainKey;
  /** The node's one word. */
  readonly word: string;
  readonly status: ChainLinkStatus;
  /** The read in its shortest form ("+1.69", "D2"), or the state word. */
  readonly mark: string;
  /** The read's evidence class; absent for a link with no read. */
  readonly evidence?: EvidenceClass;
}

export interface EnsoChainView {
  readonly links: readonly ChainLink[];
  readonly strip: readonly EnsoStripNode[];
}

export const ENSO_CHAIN_HEADING = 'ENSO: from the ocean to the weather here';
export const ENSO_CHAIN_CAPTION =
  'Five separate claims, each on its own clock. Press one to take the map to it. The words between them name relationships, never causes.';

/** The surface's source, as the layer catalog and the map key name it (src/config/layers.ts, src/ui/map-key.ts). */
const SURFACE_SOURCE = 'NASA GIBS, GHRSST MUR sea surface temperature anomaly';
/** The page the technical section links for the same product (src/ui/map-technical-information.ts). */
const SURFACE_SOURCE_URL =
  'https://www.earthdata.nasa.gov/news/worldview-image-archive/global-sea-surface-temperature-anomalies';

const STRIP_WORDS: Readonly<Record<EnsoChainKey, string>> = {
  index: 'Index',
  pattern: 'Pacific',
  jet: 'Jet',
  tendency: 'Season',
  here: 'Here'
};

const TERCILE_WORDS: Readonly<Record<string, string>> = {
  Above: 'above-normal',
  Below: 'below-normal',
  Normal: 'near-normal'
};

interface Built {
  readonly link: ChainLink;
  /** The strip's short mark for a read; a link with no read takes its state word. */
  readonly mark?: string;
}

function findClaim(enso: EnsoRead, product: string): SourcedClaim | null {
  return enso.status === 'ready' ? (enso.claims.find((claim) => claim.product === product) ?? null) : null;
}

function indexLink(enso: EnsoRead): Built {
  const base = {
    key: 'index',
    title: 'Observed index',
    relation: 'measured in the boxed region of',
    action: 'index',
    actionLabel: 'Show the index region and its values on the map'
  } as const;
  if (enso.status === 'loading') {
    return { link: { ...base, status: 'loading', note: 'Reading the NOAA Climate Prediction Center index snapshot.' } };
  }
  const claim = findClaim(enso, 'ensoIndex');
  if (enso.status === 'unavailable' || claim === null) {
    return {
      link: {
        ...base,
        status: 'unavailable',
        note: enso.status === 'unavailable' ? enso.note : 'The index snapshot holds no index read.'
      }
    };
  }
  const reading = claim.reading?.kind === 'enso-index' ? claim.reading : null;
  if (reading === null) {
    // Past the staleness cutoff src/impact/enso.ts withholds the reading: the
    // claim is a dated past-tense sentence, so no gauge is drawn for it.
    return {
      link: {
        ...base,
        status: 'ready',
        ...chainFieldsFromClaim(claim),
        note: 'This snapshot is old, so the state is given as a dated sentence in the detail above, not as a gauge.'
      },
      mark: 'dated'
    };
  }
  const value = signedIndex(reading.value);
  const when = `${reading.season} ${reading.year}${reading.preliminary ? ', preliminary' : ''}`;
  const headline = readingHeadline(reading) ?? '';
  return {
    link: {
      ...base,
      status: 'ready',
      ...chainFieldsFromClaim(claim),
      statement: `${headline}: ${reading.index} ${value} (${when})`,
      figure: indexGaugeSvg({
        value: reading.value,
        threshold: reading.threshold,
        below: 'La Nina',
        above: 'El Nino',
        valueLabel: value,
        state: 'read',
        title: `ENSO index against the CPC onset thresholds of minus and plus ${reading.threshold}. ${reading.index} ${value}, ${when}: ${headline}.`
      })
    },
    mark: value
  };
}

function patternLink(surface: SurfaceRead): Built {
  const base = {
    key: 'pattern',
    title: 'Tropical Pacific surface',
    relation: 'historically tends to shift',
    action: 'pattern',
    actionLabel: 'Show the ocean surface alone on the map'
  } as const;
  switch (surface.status) {
    case 'ready':
      return {
        link: {
          ...base,
          status: 'ready',
          statement: 'On the map: daily sea surface temperature anomaly.',
          source: SURFACE_SOURCE,
          sourceUrl: SURFACE_SOURCE_URL,
          // An analysis product, in NASA's own words as the technical section
          // quotes them ("Level 4, MUR sea surface temperature analysis
          // product"), so it wears the analyzed tier and never the observed plate.
          evidence: 'analyzed',
          dateLine: surface.date ? `Observed ${surface.date}` : null,
          ...(surface.date
            ? {}
            : { note: 'The provider did not state this frame\'s date this session. The latest frame it publishes is shown.' })
        },
        mark: 'on map'
      };
    case 'degraded':
      return { link: { ...base, status: 'partial', note: 'Some tiles of the sea surface temperature anomaly frame did not load.' } };
    case 'error':
      return { link: { ...base, status: 'unavailable', note: 'The sea surface temperature anomaly tiles did not load. Nothing is inferred about the ocean from a failed request.' } };
    case 'no-data':
      return { link: { ...base, status: 'idle', idleWord: 'no data', note: 'The provider returned no sea surface temperature anomaly tiles for this view.' } };
    case 'zoom-in':
      return { link: { ...base, status: 'idle', idleWord: 'zoom in to load', note: 'The sea surface temperature anomaly surface loads at a closer zoom.' } };
    case 'loading':
      return { link: { ...base, status: 'loading', note: 'Loading the sea surface temperature anomaly frame.' } };
    default:
      return { link: { ...base, status: 'idle', idleWord: 'not shown', note: 'The sea surface temperature anomaly surface is not on the map.' } };
  }
}

function jetLink(jet: JetRead): Built {
  const base = {
    key: 'jet',
    title: 'Jet and storm track (model guidance)',
    relation: 'one model instant, read beside a season',
    action: 'jet',
    actionLabel: 'Draw the jet-level wind on the map'
  } as const;
  const source = FLOW_WORDS.source.jet;
  if (jet.kind !== 'jet') {
    const drawn =
      jet.kind === null || jet.kind === 'off' || jet.status === 'inactive' || jet.status === 'off'
        ? 'No model overlay is drawn now.'
        : `The overlay drawn now is ${jet.label}.`;
    return {
      link: { ...base, status: 'idle', idleWord: 'not shown', note: `Press to draw ${source} on the map as model guidance. ${drawn}` }
    };
  }
  // The overlay's state line opens with its status word and a middle dot
  // ("unavailable · NOAA GFS 250 hPa wind did not load"). The link's pill
  // already says the word, so the reason starts after it.
  const lead = `${jet.status} · `;
  const line = jet.line.startsWith(lead) ? jet.line.slice(lead.length) : jet.line;
  const joined = [line, ...jet.notes].filter((part) => part !== '').join('. ').replace(/\.\./g, '.');
  const reason = joined === '' || joined.endsWith('.') ? joined : `${joined}.`;
  switch (jet.status) {
    case 'live':
      return {
        link: {
          ...base,
          status: 'ready',
          statement: `On the map: ${source}.`,
          source,
          evidence: 'modeled',
          dateLine:
            jet.cycle !== undefined && jet.valid !== undefined
              ? `${FLOW_WORDS.modelRun} ${dateLabel(jet.cycle)} · Model valid ${dateLabel(jet.valid)}`
              : null,
          note: 'Model output at one instant, not an observation. It keeps its own time, apart from the sea surface temperature map.'
        },
        mark: 'on map'
      };
    case 'live (partial)':
      return { link: { ...base, status: 'partial', note: reason } };
    case 'unavailable':
      return { link: { ...base, status: 'unavailable', note: reason } };
    case 'no data':
      return { link: { ...base, status: 'idle', idleWord: 'no data', note: reason } };
    default:
      return { link: { ...base, status: 'loading', note: `Loading ${source}.` } };
  }
}

/** Where a place read was made, in the claim's own sense (src/impact/sources.ts: a point inside the place, or the click). */
function wherePhrase(place: { readonly label: string; readonly inside: boolean }): string {
  return place.inside ? `at a point inside ${place.label}` : `at the clicked point (${place.label})`;
}

/** The two place links share their no-read states. */
function unreadPlaceLink(
  read: Exclude<PlaceRead, { status: 'ready' }>,
  place: EnsoChainInput['place'],
  what: string
): Pick<ChainLink, 'status' | 'idleWord' | 'note' | 'action' | 'actionLabel'> {
  if (place === null || read.status === 'none') {
    return {
      status: 'idle',
      idleWord: 'no place chosen',
      note: `Choose a place to read ${what} there.`,
      action: 'place',
      actionLabel: 'Choose a place'
    };
  }
  if (read.status === 'loading') return { status: 'loading', note: `Reading ${what} at ${place.label}.` };
  return { status: 'unavailable', note: read.note };
}

function tendencyLink(read: PlaceRead, place: EnsoChainInput['place'], seasonDraws: readonly string[]): Built {
  const base = { key: 'tendency', title: 'Seasonal outlook here', relation: 'read beside' } as const;
  const drawn = seasonDraws.join(' and ');
  const lit = {
    action: 'tendency',
    actionLabel: drawn !== '' ? `Show the ${drawn} on the map` : 'Show the seasonal outlook on the map'
  } as const;
  if (read.status !== 'ready' || place === null) {
    const unread = unreadPlaceLink(read.status === 'ready' ? { status: 'none' } : read, place, 'the NOAA Climate Prediction Center seasonal outlook');
    return { link: { ...base, ...lit, ...unread } };
  }
  const tercile = read.claim.reading?.kind === 'cpc-tercile' ? read.claim.reading : null;
  if (tercile === null) {
    return {
      link: {
        ...base,
        ...lit,
        status: 'ready',
        ...chainFieldsFromClaim(read.claim),
        note: `The outlook at ${place.label} is stated in that place's briefing.`
      },
      mark: 'read'
    };
  }
  const equal = tercile.cat === 'EC';
  return {
    link: {
      ...base,
      ...lit,
      status: 'ready',
      ...chainFieldsFromClaim(read.claim),
      statement: `${
        equal
          ? `Equal Chances (no favored tercile), ${tercile.season}`
          : `${tercile.prob}% chance of ${TERCILE_WORDS[tercile.cat] ?? tercile.cat} ${tercile.variable}, ${tercile.season}`
      }, ${wherePhrase(place)}.`,
      // The map this press shows may draw another outlook than the one read
      // here; the sentence keeps the two apart (truthfulness, invariant B1).
      note:
        // vocab-allow: honesty disclaimer denying that the CPC seasonal outlook is an ENSO forecast (DR-019, the technical section's own words)
        'A NOAA Climate Prediction Center seasonal outlook that ENSO informs, not an ENSO forecast.' +
        (drawn !== ''
          ? ` Pressing this link shows the ${drawn} on the map; the ${tercile.variable} read above is a separate layer.`
          : '')
    },
    mark: equal ? 'EC' : `${tercile.prob}%`
  };
}

function hereLink(read: PlaceRead, place: EnsoChainInput['place']): Built {
  const base = { key: 'here', title: 'Observed here now' } as const;
  const lit = { action: 'here', actionLabel: 'Open the current conditions for this place' } as const;
  if (read.status !== 'ready' || place === null) {
    const unread = unreadPlaceLink(read.status === 'ready' ? { status: 'none' } : read, place, 'what the U.S. Drought Monitor shows');
    return { link: { ...base, ...lit, ...unread } };
  }
  const usdm = read.claim.reading?.kind === 'usdm-category' ? read.claim.reading : null;
  if (usdm === null) {
    return {
      link: {
        ...base,
        ...lit,
        status: 'ready',
        ...chainFieldsFromClaim(read.claim),
        note: `What is observed at ${place.label} is stated in that place's briefing.`
      },
      mark: 'read'
    };
  }
  const headline = readingHeadline(usdm) ?? '';
  return {
    link: {
      ...base,
      ...lit,
      status: 'ready',
      ...chainFieldsFromClaim(read.claim),
      statement: `${headline}, ${wherePhrase(place)}.`,
      figure: classGaugeSvg({
        classes: USDM_SCALE,
        read: usdm.dm ?? 'none',
        none: USDM_NONE_SLOT,
        state: 'read',
        title: `U.S. Drought Monitor scale, D0 to D4. Read: ${headline}, ${wherePhrase(place)}.`
      }),
      ...(usdm.dm === null
        ? { note: 'This client has no analyzed-area mask, so this does not confirm no drought.' }
        : {})
    },
    mark: usdm.dm === null ? 'none' : `D${usdm.dm}`
  };
}

/**
 * The strip has room for about eleven characters under a node, so the three
 * longest state words are shortened there. The link's own card, under the
 * strip, always carries the full word.
 */
const STRIP_SHORT: Readonly<Record<string, string>> = {
  'no place chosen': 'no place',
  'zoom in to load': 'zoom in',
  'live (partial)': 'partial'
};

/** A no-read node's word: the link's own state word, never a value. */
function stateMark(link: ChainLink): string {
  const word = link.status === 'idle' ? (link.idleWord ?? 'not shown') : READ_STATE_WORD[link.status];
  return STRIP_SHORT[word] ?? word;
}

/** Build the five links and their overview nodes from what the host holds. */
export function buildEnsoChain(input: EnsoChainInput): EnsoChainView {
  const built: readonly Built[] = [
    indexLink(input.enso),
    patternLink(input.surface),
    jetLink(input.jet),
    tendencyLink(input.outlook, input.place, input.seasonDraws ?? []),
    hereLink(input.here, input.place)
  ];
  return {
    links: built.map((item) => item.link),
    strip: built.map((item, index) => {
      const key = ENSO_CHAIN_KEYS[index]!;
      const read = item.link.status === 'ready';
      return {
        key,
        word: STRIP_WORDS[key],
        status: item.link.status,
        mark: read ? (item.mark ?? 'read') : stateMark(item.link),
        ...(read && item.link.evidence ? { evidence: item.link.evidence } : {})
      };
    })
  };
}

// ---------------------------------------------------------------------------
// The overview strip: the five links at a glance
// ---------------------------------------------------------------------------

const n1 = (value: number): string => String(Math.round(value * 10) / 10);

/** The three form tiers the evidence badge wears, as a node's drawing. */
function nodeTier(evidence: EvidenceClass | undefined): 'plate' | 'keyline' | 'dashed' {
  if (evidence === 'observed') return 'plate';
  if (evidence === 'modeled' || evidence === 'modeled-analysis' || evidence === 'outlook') return 'dashed';
  return 'keyline';
}

/**
 * The overview strip: five nodes on one plain rail, in chain order. A node
 * with a read is a disc drawn in its evidence tier (the badge's own three
 * forms: a filled plate for an observation, a keyline for an analyzed,
 * classified or derived read, a dashed line for model output and outlooks)
 * with the read in its shortest form under it. A node with no read is an
 * open square with its state word under it, and no value. The rail has no
 * arrowhead and no direction: it joins separate claims, it is not a path
 * anything travels. Nothing here moves.
 */
export function ensoStripSvg(strip: readonly EnsoStripNode[]): string {
  const W = 240;
  const H = 46;
  const railY = 11;
  const step = W / strip.length;
  const cx = (index: number): number => step / 2 + index * step;
  const said = strip
    .map((node) => `${node.word}: ${node.mark}${node.evidence ? `, ${EVIDENCE_PRESENTATION[node.evidence].label.toLowerCase()}` : ''}`)
    .join('. ');
  let inner = `<path class="s-rail" d="M${n1(cx(0))} ${railY}H${n1(cx(strip.length - 1))}"/>`;
  strip.forEach((node, index) => {
    const x = cx(index);
    const read = node.status === 'ready';
    if (read) {
      inner += `<circle class="s-node s-node-${nodeTier(node.evidence)}" cx="${n1(x)}" cy="${railY}" r="5.5"/>`;
    } else {
      const slash =
        node.status === 'unavailable'
          ? `<path class="s-mark" d="M${n1(x - 4.5)} ${railY + 4.5}L${n1(x + 4.5)} ${railY - 4.5}"/>`
          : node.status === 'partial'
            ? `<path class="s-fill" d="M${n1(x - 4.5)} ${railY - 4.5}H${n1(x)}V${railY + 4.5}H${n1(x - 4.5)}Z"/>`
            : '';
      inner += `<rect class="s-node s-node-open" x="${n1(x - 4.5)}" y="${railY - 4.5}" width="9" height="9"/>${slash}`;
    }
    inner +=
      `<text class="s-word" x="${n1(x)}" y="29" text-anchor="middle">${escapeHtml(node.word)}</text>` +
      `<text class="${read ? 's-read' : 's-state'}" x="${n1(x)}" y="41" text-anchor="middle">${escapeHtml(node.mark)}</text>`;
  });
  const title = `The five links at a glance. ${said}.`;
  return (
    `<svg class="enso-strip" viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" role="img" ` +
    `aria-label="${escapeHtml(title)}" xmlns="http://www.w3.org/2000/svg"><title>${escapeHtml(title)}</title>${inner}</svg>`
  );
}

// ---------------------------------------------------------------------------
// The nested truth: one tap from every link
// ---------------------------------------------------------------------------

/** The disclosure's summary: the lead clause of the odds sentence, as src/impact/enso.ts composes it. */
export const ENSO_TRUTH_SUMMARY = `${ENSO_NESTED_TRUTH.lead}.`;

function claimBlock(claim: SourcedClaim, heading: string): string {
  const href = checkPopupHref(claim.sourceUrl);
  const name = href !== null
    ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(claim.source)}</a>`
    : escapeHtml(claim.source);
  const date = claimDateLine(claim);
  return (
    `<div class="enso-truth-claim" data-evidence="${escapeHtml(claim.evidence)}" data-truth-claim="${escapeHtml(claim.product)}">` +
    `<p class="enso-truth-head"><span class="enso-truth-title">${escapeHtml(heading)}</span>` +
    `<span class="impact-claim-badge">${escapeHtml(EVIDENCE_PRESENTATION[claim.evidence].label)}</span></p>` +
    `<p class="enso-truth-text">${escapeHtml(claim.text)}</p>` +
    (claim.uncertainty ? `<p class="enso-truth-qualifier">${escapeHtml(claim.uncertainty.text)}</p>` : '') +
    `<p class="enso-truth-source">Source: ${name}${date ? `, <span class="enso-truth-date">${escapeHtml(date)}</span>` : ''}</p>` +
    `</div>`
  );
}

/**
 * The nested truth, in the words src/impact/enso.ts governs: the odds
 * sentence, NOAA CPC's own sentence on single storms, the regional tendency
 * claim with its source and date, the index claim's full sentence and the
 * pointer to CPC's official status. Rendered closed; the summary carries the
 * lead clause, so the denial is on screen before any tap.
 */
export function renderEnsoTruth(enso: EnsoRead): string {
  const faq = checkPopupHref(ENSO_NESTED_TRUTH.eventsUrl);
  const tendency = findClaim(enso, 'ensoTendency');
  const index = findClaim(enso, 'ensoIndex');
  const authority = findClaim(enso, 'ensoAuthority');
  return (
    `<details class="enso-truth">` +
    `<summary class="enso-truth-summary"><span class="enso-truth-lead">${escapeHtml(ENSO_TRUTH_SUMMARY)}</span>` +
    `<span class="sr-only"> What this does and does not say.</span></summary>` +
    `<div class="enso-truth-body">` +
    // The tendency claim ends with the odds sentence, so it is shown alone only when that claim is absent.
    (tendency === null ? `<p class="enso-truth-text">${escapeHtml(ENSO_NESTED_TRUTH.odds)}</p>` : '') +
    `<blockquote class="enso-truth-quote"><p>${escapeHtml(ENSO_NESTED_TRUTH.events)}</p>` +
    `<footer>${faq !== null ? `<a href="${escapeHtml(faq)}" target="_blank" rel="noopener">${escapeHtml(ENSO_NESTED_TRUTH.eventsSource)}</a>` : escapeHtml(ENSO_NESTED_TRUTH.eventsSource)}</footer></blockquote>` +
    (tendency !== null ? claimBlock(tendency, 'What past events did in the Pacific Northwest') : '') +
    (index !== null ? claimBlock(index, 'What the index read says') : '') +
    (authority !== null ? claimBlock(authority, 'Where the official status is stated') : '') +
    `<button type="button" class="enso-truth-door" data-enso-door="technical">Technical information</button>` +
    `</div></details>`
  );
}
