/**
 * The source commit embedded at build time (vite.config.ts `define`;
 * T1-0 receipt integrity). Replaced with a string literal by the
 * bundler; `'unknown'` when git is unavailable at build time.
 */
declare const __DDM_BUILD_SHA__: string;

/**
 * A release verifier may inject a fresh per-run nonce. Local builds use
 * 'dev'. Asserted together with the SHA so two servers built from the same
 * commit are distinguishable.
 */
declare const __DDM_BUILD_NONCE__: string;
