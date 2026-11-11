/**
 * The evidence chain (owner direction 2026-11-09 (sprint), DR-pending): the
 * ONE shared component that lays a few separate claims side by side as links,
 * so a person can read in seconds how the tropical Pacific relates to a
 * place. The priority briefing (src/ui/briefing-lead.ts) feeds it from the
 * claims a briefing already holds; the ENSO surfaces are meant to feed the
 * same component with their own links, never a second copy of it.
 *
 * INTERFACE. `renderEvidenceChain(links, options)` returns an HTML string.
 * It takes its links as DATA and owns no source, no fetch, no state and no
 * DOM: the caller builds each `ChainLink` from a claim (or from the honest
 * absence of one) and inserts the string. Styles are in
 * src/styles/briefing-lead.css under `.evidence-chain`; a module that renders
 * a chain imports that stylesheet (or this module's renderer through
 * briefing-lead.ts, which already does).
 *
 * WHAT A LINK IS. One claim on its own clock, wearing its own evidence class
 * and naming its own source. A link never borrows the source or the date of
 * the link beside it, exactly as a matrix cell never does.
 *
 * WHAT A CONNECTOR IS. A labelled RELATIONSHIP between two neighbouring
 * links ("historically tends to shift", "informs", "read beside"), written by
 * the caller. It is never an arrow and never a cause: the component draws a
 * plain joint with the words on it, and the caller's `caption` says what the
 * joints mean. A caller that cannot name a relationship it can cite leaves
 * `relation` out, and the joint is drawn bare.
 *
 * NO READ. A link whose source did not answer, or that the caller has no
 * source for, is still drawn, in its place, under its state word
 * (`loading...`, `live (partial)`, `unavailable`) with the caller's reason. A
 * chain never closes ranks over a missing link. A link whose view has simply
 * not been asked for (an overlay that is off, a place not yet chosen) is
 * `idle`: nothing failed, so it wears the caller's own plain word and never
 * `unavailable`.
 *
 * LAYOUT. The chain runs down its column at every width: one card per link,
 * with the joint between two cards. It is not laid across: five cards and
 * four joints leave each card too narrow to hold a figure in any host the
 * briefing has (looked at in a 1063 px harness, 2026-11-09, and dropped).
 *
 * At most `CHAIN_MAX_LINKS` links are drawn; any beyond that are ignored, so
 * a caller that has more picks its five.
 */

import { claimDateLine, EVIDENCE_PRESENTATION } from '../impact/evidence';
import type { EvidenceClass, HorizonStatus, SourcedClaim } from '../impact/types';
import { checkPopupHref, escapeHtml } from '../util/escape';
import { READ_STATE_WORD } from './gauges';

/** The most links one chain draws. */
export const CHAIN_MAX_LINKS = 5;

/**
 * A link's state: a read (`ready`), one of the read states that hold none, or
 * `idle` (the ENSO chain's addition, owner direction 2026-11-09 (sprint),
 * DR-pending): the link's view has not been asked for, so there is no read
 * and no failure to report.
 */
export type ChainLinkStatus = HorizonStatus | 'idle';

export interface ChainLink {
  /** Stable and unique inside the chain; rendered as `data-chain-link`. */
  readonly key: string;
  /** What the link is, in plain words, for example "Observed index". */
  readonly title: string;
  /**
   * `ready` for a link that holds a read; any other status draws the state
   * word and `note` and no statement.
   */
  readonly status: ChainLinkStatus;
  /** The plain state word of an `idle` link, for example "not shown". */
  readonly idleWord?: string;
  /**
   * The read itself, short, in the issuer's words, built by the caller from
   * typed data (a `ClaimReading`), never cut out of a claim's sentence.
   */
  readonly statement?: string;
  /** Trusted inline SVG (src/ui/gauges.ts) drawn under the statement. Never user-supplied. */
  readonly figure?: string;
  /** The claim's own source name; shown for every link that has one. */
  readonly source?: string;
  /** The claim's own source link; only `https://` renders as an anchor. */
  readonly sourceUrl?: string;
  /** The claim's own evidence class; drawn as the same badge a claim wears. */
  readonly evidence?: EvidenceClass;
  /** The claim's own date line: the word the claim uses ("Published", "Valid") and its date. */
  readonly dateLine?: string | null;
  /** Why the link holds no read, or what a partial read is missing. */
  readonly note?: string;
  /** How this link relates to the NEXT one: a relationship, never a cause. */
  readonly relation?: string;
  /**
   * An opaque token for the host. When set, the link's title is a button
   * carrying it as `data-chain-action`, so one tap can open the claim's full
   * text; the host listens for the click. Omitted, the title is plain text.
   */
  readonly action?: string;
  /** The accessible name of that button, for example "Open the ENSO detail". */
  readonly actionLabel?: string;
}

export interface EvidenceChainOptions {
  /** The chain's heading. */
  readonly heading: string;
  /** One or two sentences under the heading: what the links are and what the joints mean. */
  readonly caption: string;
  /** Makes the heading id unique when a document holds more than one chain. */
  readonly id?: string;
}

/**
 * The fields a link takes from a claim, in one call, so a caller cannot give
 * a link one claim's sentence and another claim's source or date.
 */
export function chainFieldsFromClaim(
  claim: Pick<SourcedClaim, 'source' | 'sourceUrl' | 'evidence' | 'dates'>
): Pick<ChainLink, 'source' | 'sourceUrl' | 'evidence' | 'dateLine'> {
  return {
    source: claim.source,
    ...(claim.sourceUrl ? { sourceUrl: claim.sourceUrl } : {}),
    evidence: claim.evidence,
    dateLine: claimDateLine(claim)
  };
}

function renderLink(link: ChainLink, last: boolean): string {
  const pres = link.evidence ? EVIDENCE_PRESENTATION[link.evidence] : null;
  const read = link.status === 'ready';
  const title = link.action
    ? `<button type="button" class="evidence-chain-open" data-chain-action="${escapeHtml(link.action)}"${
        link.actionLabel ? ` aria-label="${escapeHtml(`${link.title}. ${link.actionLabel}`)}"` : ''
      }>${escapeHtml(link.title)}</button>`
    : `<span class="evidence-chain-step">${escapeHtml(link.title)}</span>`;
  const badge = pres && read ? `<span class="impact-claim-badge">${escapeHtml(pres.label)}</span>` : '';
  // A link with no read says so with the same word and glyph a matrix cell uses.
  // An idle link wears the pill's plain face (an open mark) and its own
  // word. That word is "not shown" for a view nobody asked for, or the
  // layer's own state where the matrix has no status for it ("no data",
  // "zoom in to load"): never the glyph of a read state it is not in.
  const state = read
    ? ''
    : link.status === 'idle'
      ? `<span class="impact-hazard-pill">${escapeHtml(link.idleWord ?? 'not shown')}</span>`
      : `<span class="impact-hazard-pill impact-hazard-pill-${link.status}">${escapeHtml(READ_STATE_WORD[link.status])}</span>`;
  const statement =
    read && link.statement ? `<p class="evidence-chain-statement">${escapeHtml(link.statement)}</p>` : '';
  const figure = read && link.figure ? `<div class="evidence-chain-figure">${link.figure}</div>` : '';
  const note = link.note ? `<p class="evidence-chain-note">${escapeHtml(link.note)}</p>` : '';
  const href = checkPopupHref(link.sourceUrl);
  const sourceName = link.source
    ? href !== null
      ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(link.source)}</a>`
      : escapeHtml(link.source)
    : '';
  const date = link.dateLine ? ` <span class="impact-claim-date">${escapeHtml(link.dateLine)}</span>` : '';
  const source = sourceName ? `<p class="evidence-chain-source">Source: ${sourceName}${date}</p>` : '';
  // The joint to the next link. The words are the relationship; with none
  // given the joint is bare. A screen reader hears it as the link's last line.
  const joint = last
    ? ''
    : `<p class="evidence-chain-joint">${
        link.relation
          ? `<span class="sr-only">Relationship to the next link: </span><span class="evidence-chain-relation">${escapeHtml(link.relation)}</span>`
          : ''
      }</p>`;
  return (
    `<li class="evidence-chain-link"${pres && read && link.evidence ? ` data-evidence="${escapeHtml(link.evidence)}"` : ''} data-chain-link="${escapeHtml(link.key)}" data-chain-status="${link.status}">` +
    `<div class="evidence-chain-card">` +
    `<div class="evidence-chain-head">${title}${badge}${state}</div>` +
    statement +
    figure +
    note +
    source +
    `</div>` +
    joint +
    `</li>`
  );
}

/** Render a chain of at most `CHAIN_MAX_LINKS` links as one section. */
export function renderEvidenceChain(
  links: readonly ChainLink[],
  options: EvidenceChainOptions
): string {
  const shown = links.slice(0, CHAIN_MAX_LINKS);
  const headingId = `evidence-chain-title${options.id ? `-${options.id}` : ''}`;
  return (
    `<section class="evidence-chain" aria-labelledby="${escapeHtml(headingId)}">` +
    `<h4 class="evidence-chain-title" id="${escapeHtml(headingId)}">${escapeHtml(options.heading)}</h4>` +
    `<p class="evidence-chain-caption">${escapeHtml(options.caption)}</p>` +
    `<ol class="evidence-chain-links">${shown
      .map((link, index) => renderLink(link, index === shown.length - 1))
      .join('')}</ol>` +
    `</section>`
  );
}
