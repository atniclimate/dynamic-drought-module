/**
 * DDM-P15-T07: this file is SUPPOSED to fail typechecking.
 *
 * It exists to prove, on every run, that a hand-built `BoundarySelectionContext`
 * literal (src/impact/types.ts) missing one of its REQUIRED fields is a
 * compiler error, not a silent gap that `tsconfig.tests.json` fails to catch.
 * It is excluded from that config's own `include` (see `exclude` there),
 * so `npm run typecheck:tests` never sees it directly, and is checked on its
 * own, under `tsconfig.context-literal-typo.json`, by
 * `tests/types/check-context-literal-typo.mjs`, which asserts the OPPOSITE
 * of a normal check: it fails if this file compiles cleanly, because that
 * would mean `containing` silently became optional (or the interface
 * silently lost the field) and a missing-containing literal would no
 * longer fail type checking.
 *
 * Do not "fix" the omission below by adding `containing`. It is deliberate,
 * and its line is pinned in `tests/types/check-context-literal-typo.mjs`;
 * the fixture and that script are edited together.
 *
 * `place` is deliberately NOT the omitted field: the C3 housekeeping commit
 * (2026-09-12) made it optional, so leaving it out proves nothing.
 */

import type { BoundarySelectionContext } from '../../src/impact/types';

// Missing `containing` (a required field): see the file header.
export const INCOMPLETE_CONTEXT: BoundarySelectionContext = {
  kind: 'state',
  title: 'Kansas',
  properties: { STUSPS: 'KS' },
  lngLat: { lng: -97.5, lat: 38.5 },
  regionKey: 'national'
};
