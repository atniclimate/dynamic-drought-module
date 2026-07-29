/** NEGATIVE fixture (T-P0-6): a banned word in the rendered TEXT between
 * HTML tags must be found even though tag markup itself is stripped; and a
 * comparison `<` must not eat the rest of the line. */
export const htmlProse =
  '<p class="note">A drought warning computed by this module.</p>';
export const comparisonProse =
  'Forecast < 20 percent means DDM issues its own alert here.';
