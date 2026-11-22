// The currents frame header and the fixture cycle, shared by tests/flow-wire.spec.ts and tests/flow-wire-logic.spec.ts.

import { readFileSync } from 'node:fs';

export const FRAME = JSON.parse(readFileSync(new URL('../public/data/rtofs-surface-currents.json', import.meta.url), 'utf8')) as {
  readonly run: string; readonly valid: string; readonly grids: readonly { readonly file: string }[];
};
export const FRAME_RUN = Date.parse(FRAME.run);
export const FRAME_VALID = Date.parse(FRAME.valid);
/** Three and a half days after the frame's valid instant: its line ends "frame 3 days old". */
export const FRAME_CLOCK = FRAME_VALID + 3.5 * 24 * 3_600_000;
export const FIXTURE_CYCLE = Date.UTC(2026, 9, 5, 6);
export const FIXTURE_VALID = Date.UTC(2026, 9, 5, 12);
