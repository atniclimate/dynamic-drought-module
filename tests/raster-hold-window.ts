// The hold window shared by the browser cases in raster-status.spec.ts and the pure
// inequality in raster-status-logic.spec.ts that pins it below the proof deadline.

/**
 * How long a held first tile is observed before release: well inside the
 * shared proof deadline, so the held layer is still `loading` (not yet
 * `unavailable`) when the route is released.
 */
export const HOLD_PROBE_MS = 3_000;
