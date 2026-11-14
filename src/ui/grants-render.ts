/**
 * The Impact Briefing's "Open federal funding (Grants.gov)" subsection, at the
 * end of the federal resources group (DR-258). Pure and DOM-free: a read state
 * and a mode in, markup out. Every issuer string passes through `escapeHtml`.
 *
 * The rows are the active mode's (src/impact/grants.ts `grantsListedForMode`);
 * the count line counts every open and forecast row the read returned, listed
 * or not. A failed read says so and sends the reader to Grants.gov; it never
 * reads as "no grants". The Grants.gov API terms ask for the attribution
 * sentence wherever its rows show, so a live read always carries it.
 */

import type { HazardClusterKey } from '../config/clusters';
import {
  GRANTS_GOV_ATTRIBUTION,
  grantsListedForMode,
  openTribalGrants,
  type GrantOpportunity,
  type GrantsRead
} from '../impact/grants';
import { checkPopupHref, escapeHtml } from '../util/escape';

/** What the subsection shows: a read in flight, or the settled read. */
export type GrantsView = { readonly state: 'loading' } | GrantsRead;

/**
 * Grants.gov's search, open and forecast rows listed for federally recognized
 * Tribal governments. www.grants.gov/search-grants drops its query and sends a
 * visitor to this search; this form kept its filter and listed 837 rows on
 * 2026-11-13, when the API answered 836 for the same request.
 */
export const GRANTS_SEARCH_PAGE =
  'https://simpler.grants.gov/search?status=forecasted,posted&eligibility=federally_recognized_native_american_tribal_governments';

const HEADING = 'Open federal funding (Grants.gov)';

/** "December 5, 2026" from an ISO date. */
function dateInWords(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC'
  });
}

/** One row's status, in the issuer's terms. */
export function grantStatusLine(row: GrantOpportunity): string {
  // vocab-allow: Grants.gov's own opportunity status ("forecasted"), an agency's announced funding, not a DDM read
  if (row.status === 'forecasted') return 'Forecast, not yet open';
  return row.closes === null ? 'Open, no close date stated' : `Open, closes ${dateInWords(row.closes)}`;
}

/** The count over every open and forecast row; "At least" when the read was partial. */
export function grantsCountLine(open: number, forecast: number, partial: boolean): string {
  // vocab-allow: Grants.gov's own opportunity status ("forecasted"), an agency's announced funding, not a DDM read
  return `${partial ? 'At least ' : ''}${open} open and ${forecast} forecast opportunities list federally recognized Tribal governments as eligible.`;
}

function searchLink(words: string): string {
  return `<a href="${escapeHtml(GRANTS_SEARCH_PAGE)}" target="_blank" rel="noopener">${words}</a>`;
}

function renderGrant(row: GrantOpportunity): string {
  const href = checkPopupHref(row.url);
  const title =
    href !== null
      ? `<a class="impact-resource-label impact-resource-link" href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(row.title)}</a>`
      : `<p class="impact-resource-label">${escapeHtml(row.title)}</p>`;
  const agency = row.agency ? `<p class="impact-resource-agency">${escapeHtml(row.agency)}</p>` : '';
  return `<div class="impact-resource">${title}${agency}<p class="impact-resource-desc">${escapeHtml(grantStatusLine(row))}</p></div>`;
}

function body(view: GrantsView, mode: HazardClusterKey, today: string): string {
  if (view.state === 'loading') return '<p class="impact-resources-framing">Reading Grants.gov...</p>';
  if (view.state === 'unavailable') {
    return `<p class="impact-resources-framing">Grants.gov did not answer. ${searchLink('Search it directly.')}</p>`;
  }
  const open = openTribalGrants(view.rows, today);
  const posted = open.filter((row) => row.status === 'posted').length;
  return `${grantsListedForMode(open, mode).map(renderGrant).join('')}
    <p class="impact-resources-framing">${escapeHtml(grantsCountLine(posted, open.length - posted, view.partial))} ${searchLink('Search all on Grants.gov')}</p>
    <p class="impact-resources-framing">${escapeHtml(GRANTS_GOV_ATTRIBUTION)}</p>`;
}

/** The reader's own calendar date, ISO: a row closing today still reads as open. */
function readerToday(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** The subsection markup for one read state, the active mode and the reader's date (ISO). */
export function renderGrantsSection(view: GrantsView, mode: HazardClusterKey, today: string = readerToday()): string {
  return `
    <div class="impact-grants" data-grants-state="${view.state}">
      <h5 class="impact-resource-group-title">${HEADING}</h5>
      ${body(view, mode, today)}
    </div>
  `;
}
