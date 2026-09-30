/**
 * DDM's own notice about the public-view RAWS stations and the label it
 * renders under (S30D D1 M22; DR-159). Two literals in their own module so
 * the station layer's legend (src/layers/telemetry.ts) imports the notice
 * without pulling the whole acknowledgements table
 * (src/config/acknowledgements.ts, which re-exports both) into its chunk.
 */

import type { CreditSentence } from './acknowledgements';

/**
 * The public-view RAWS notice, DDM's own notice (DR-159; RATIFICATION-6 Q8,
 * Q8b option c, the short form verbatim). Rendered in the Impact Briefing's
 * acknowledgements (the `nifc` row) and in the station layer's legend
 * (src/layers/telemetry.ts), each time under the DDM notice label, never as
 * NIFC's words.
 */
// ledger: nifc-raws-public-view (cite sheet c01)
export const RAWS_PUBLIC_VIEW_NOTICE: CreditSentence = {
  text: 'Public-view station data for awareness only; not for on-the-ground coordination.',
  citeId: 'nifc-raws-public-view'
};

/** The label a DDM notice renders under (DR-159: DDM's, never NIFC's). */
export const DDM_NOTICE_LABEL = 'DDM notice';
