/**
 * The acknowledgements section renderer (S30D D1 M22; task DDM-P7-T11;
 * design record acknowledgements-table.md sections 1.1 to 1.3 and 1.8).
 *
 * A pure string renderer: rows come from `src/config/acknowledgements.ts`;
 * every plain sentence and name passes through `escapeHtml`; a sentence
 * with an issuer-given `html` form renders that first-party markup (its
 * text content is asserted equal to the cited text in
 * tests/acknowledgements.spec.ts); a licence renders as an `https://`
 * anchor only. Styled text throughout (Q-LOGOS): no image, no issuer
 * colour. A sentence with a null `citeId` never renders (DR-147).
 *
 * Imported only by the lazy impact-panel runtime and the tests, never by
 * the eager facade (DR-085; `scripts/check-activation-budget.mjs`).
 */

import {
  ACKNOWLEDGEMENTS,
  ACKNOWLEDGEMENT_GROUPS,
  ACKNOWLEDGEMENT_IDS,
  DDM_NOTICE_LABEL,
  type AcknowledgementRow,
  type CreditSentence
} from '../config/acknowledgements';
import { escapeHtml } from '../util/escape';

export interface AcknowledgementsOptions {
  /**
   * The deployment's own data credit. The deployer row renders only when a
   * deployment bundles its own Tribal or Treaty data and names itself here;
   * it never links to the polygons.
   */
  readonly deployer?: { readonly name: string };
  /** Render the disclosure open (the acknowledgements-only presentation). */
  readonly open?: boolean;
}

/** The section's disclosure id, the pointer's target. */
export const ACKNOWLEDGEMENTS_SECTION_ID = 'impact-acknowledgements';

/** Issuer links in the section open outside the map, like every other
 * briefing link. Applied to first-party markup only. */
export function externalLinks(html: string): string {
  return html.replace(/<a href="/g, '<a target="_blank" rel="noopener" href="');
}

function sentenceHtml(sentence: CreditSentence): string | null {
  if (sentence.citeId === null) return null;
  return sentence.html !== undefined ? externalLinks(sentence.html) : escapeHtml(sentence.text);
}

function renderSentences(
  sentences: readonly CreditSentence[],
  className: string
): string {
  return sentences
    .map(sentenceHtml)
    .filter((html): html is string => html !== null)
    .map((html) => `<p class="${className}">${html}</p>`)
    .join('');
}

function renderRow(row: AcknowledgementRow, options: AcknowledgementsOptions): string {
  const deployerCredit =
    row.group === 'deployer' && options.deployer
      ? `<p class="ack-credit">${escapeHtml(options.deployer.name)}</p>`
      : '';
  const notices = row.notices
    .filter((notice) => notice.citeId !== null)
    .map(
      (notice) =>
        `<p class="ack-notice"><span class="ack-notice-label">${escapeHtml(DDM_NOTICE_LABEL)}:</span> ${escapeHtml(notice.text)}</p>`
    )
    .join('');
  const licence =
    row.licence && row.licence.url.startsWith('https://')
      ? `<p class="ack-licence"><a href="${escapeHtml(row.licence.url)}" target="_blank" rel="noopener">${escapeHtml(row.licence.name)}</a></p>`
      : '';
  return (
    `<li class="ack-row" data-ack-id="${escapeHtml(row.id)}">` +
    `<p class="ack-name">${escapeHtml(row.name)}</p>` +
    deployerCredit +
    renderSentences(row.credits, 'ack-credit') +
    renderSentences(row.changes, 'ack-changes') +
    notices +
    licence +
    '</li>'
  );
}

/** Render the whole section as one `<details>` disclosure, closed by default. */
export function renderAcknowledgements(options: AcknowledgementsOptions = {}): string {
  const rows = ACKNOWLEDGEMENT_IDS.map((id) => ACKNOWLEDGEMENTS[id]).filter(
    (row) => row.group !== 'deployer' || options.deployer !== undefined
  );
  const groups = ACKNOWLEDGEMENT_GROUPS.map((group) => {
    const members = rows
      .filter((row) => row.group === group.key)
      .sort((a, b) => a.name.localeCompare(b.name, 'en'));
    if (members.length === 0) return '';
    const headingId = `ack-group-${group.key}`;
    return (
      `<section class="ack-group" aria-labelledby="${headingId}">` +
      `<h4 id="${headingId}">${escapeHtml(group.heading)}</h4>` +
      `<ul class="ack-rows">${members.map((row) => renderRow(row, options)).join('')}</ul>` +
      '</section>'
    );
  }).join('');
  return (
    `<details id="${ACKNOWLEDGEMENTS_SECTION_ID}" class="impact-acknowledgements"${options.open ? ' open' : ''}>` +
    '<summary>Acknowledgements</summary>' +
    groups +
    '</details>'
  );
}
