/**
 * POSITIVE fixture (T-P0-6): verbatim upstream agency product names carried
 * as quoted source data, plus the out-of-scope string shapes. The lint MUST
 * produce ZERO findings here.
 */

// A verbatim NWS product name, allowed with a named reason on the line above.
// vocab-allow: verbatim NWS product name, quoted source data
export const nwsProduct = 'Red Flag Warning';

export const nwsHeatProducts = ['Excessive Heat Warning', 'Heat Advisory']; // vocab-allow: verbatim NWS product names, quoted source data

/* vocab-allow: block-comment pragma form, verbatim NWS product name */
export const blockAllowed = 'Extreme Heat Warning';

// LOWERCASE single tokens are keys, ARIA roles, and CSS classes, out of
// scope without a pragma (DDM labels are Title Case; that boundary is the
// script's stated limitation):
export const layerKey = 'nws-alerts';
export const ariaRole = 'alert';
export const cssClass = 'sheet-alerts-note';

// Markup-only literals: the banned word appears only inside tag markup.
export const markupOnly = '<div class="sheet-alerts-list">';

// Comments are not surface strings: a forecast warning alert in a comment
// is fine, as is this identifier:
export const forecastPointCount = 3;

// Internal diagnostics are structurally out of scope:
export function boom(): never {
  throw new Error('no forecast periods in the upstream response');
}
export function log(): void {
  console.warn('the NWS alerts query failed');
}
