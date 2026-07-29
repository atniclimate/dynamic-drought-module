/**
 * NEGATIVE fixture (T-P0-6): a vocab-allow pragma with an EMPTY reason. The
 * reason is required (the pragma is the review surface); the lint MUST
 * still produce a finding here.
 */

// vocab-allow:
export const emptyReason = 'A drought warning with a reasonless pragma.';
