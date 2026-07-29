/**
 * POSITIVE fixture (T-P0-6): the honesty-disclaimer usage, where DDM copy
 * uses the word to DENY being one. Allowed with a named reason; the lint
 * MUST produce ZERO findings here.
 */

export const disclaimer =
  // vocab-allow: honesty disclaimer, uses the word to deny being one
  'This is a shift in the odds, not a forecast of outcomes.';
