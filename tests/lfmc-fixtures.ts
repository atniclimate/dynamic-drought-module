/**
 * The live fuel moisture maps' stand-in for browser tests: the one place the
 * publisher's host is routed (tests/boundary-boot-inventory.test.mjs,
 * ROUTE_HOMES). Every boot installs it through `gotoApp`, so no spec reaches
 * the publisher.
 *
 * The default arm, `offshore`, publishes two maps whose rasters cover a small
 * patch of the Pacific in the far south-west corner of the publisher's box.
 * No place a spec selects is under them, so the briefing's live fuel moisture
 * lane reads the list, finds that the maps do not reach the place, and states
 * nothing: every briefing reads exactly as it did before the lane existed. A
 * spec about the feature itself asks for `inland` (the same maps, moved over
 * the place it names) or `unavailable` (the host answers 503).
 *
 * The rasters are built by tests/lfmc-fixture.mjs in the exact form the app
 * reads, and answer byte ranges with 206 as the publisher's host does.
 */

import type { BrowserContext, Page } from '@playwright/test';

import { LFMC_NO_DATA, buildLfmcCog, lfmcList, lfmcListRow } from './lfmc-fixture.mjs';

export const LFMC_HOST_PATH = 'https://valpamp.github.io/eosial-lfmc-data/';

export type LfmcStubArm =
  | { readonly arm: 'offshore' }
  | { readonly arm: 'unavailable' }
  /** The maps' north-west corner; they span 0.64 degrees east and 0.48 degrees south of it. */
  | { readonly arm: 'inland'; readonly west: number; readonly north: number };

interface LfmcStubState {
  arm: LfmcStubArm;
  /** Every request seen: the path under the host folder and its `Range` header, if any. */
  readonly log: { path: string; range: string | null }[];
}

const states = new WeakMap<BrowserContext, LfmcStubState>();
const CORS = { 'access-control-allow-origin': '*' };
const MAPS = [
  lfmcListRow('2026-10-16', '2026-10-24', 3008, 'viirs_20261016_fixture_uint16-nearest-v1.tif'),
  lfmcListRow('2026-10-24', '2026-11-01', 3008, 'viirs_20261024_fixture_uint16-nearest-v1.tif')
];

/** A 64 x 48 cell map of 0.01 degree cells: 50 plus column plus row, with an empty 8 x 8 corner. */
function raster(west: number, north: number, shift: number): Buffer {
  const full = (col: number, row: number): number => (col < 8 && row < 8 ? LFMC_NO_DATA : 50 + shift + col + row);
  return buildLfmcCog({
    west,
    north,
    pixel: 0.01,
    levels: [0, 1, 2].map((level) => ({
      width: 64 >> level,
      height: 48 >> level,
      value: (col: number, row: number) => full(col << level, row << level)
    }))
  });
}

/** The stub's state for this page's context: set `arm` before the read it should answer, read `log` after. */
export function lfmcStub(page: Page): LfmcStubState {
  const state = states.get(page.context());
  if (!state) throw new Error('installDefaultLfmcStub has not run for this context');
  return state;
}

/** Route the publisher's host on the CONTEXT, once, fail-closed. A spec sets an arm; it never routes the host itself. */
export async function installDefaultLfmcStub(page: Page): Promise<void> {
  const context = page.context();
  if (states.has(context)) return;
  const state: LfmcStubState = { arm: { arm: 'offshore' }, log: [] };
  states.set(context, state);
  await context.route((url) => url.href.startsWith(LFMC_HOST_PATH), async (route) => {
    const request = route.request();
    const path = request.url().slice(LFMC_HOST_PATH.length);
    const range = (await request.headerValue('range')) ?? null;
    state.log.push({ path, range });
    const arm = state.arm;
    if (arm.arm === 'unavailable') {
      return route.fulfill({ status: 503, headers: CORS, body: 'Synthetic live fuel moisture outage' }).catch(() => undefined);
    }
    if (path === 'manifest.json') {
      return route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(lfmcList(MAPS)) }).catch(() => undefined);
    }
    const index = MAPS.findIndex((row) => row.raster === path);
    if (index < 0) return route.fulfill({ status: 404, headers: CORS, body: 'not found' }).catch(() => undefined);
    // Offshore: the south-west corner of the publisher's box, over open ocean.
    const [west, north] = arm.arm === 'inland' ? [arm.west, arm.north] : [-127.8, 29.8];
    const bytes = raster(west, north, index * 5);
    const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? '');
    if (!match) return route.fulfill({ status: 200, headers: CORS, contentType: 'image/tiff', body: bytes }).catch(() => undefined);
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), bytes.length - 1);
    if (start >= bytes.length) return route.fulfill({ status: 416, headers: CORS, body: '' }).catch(() => undefined);
    return route
      .fulfill({
        status: 206,
        headers: { ...CORS, 'content-range': `bytes ${start}-${end}/${bytes.length}`, 'accept-ranges': 'bytes' },
        contentType: 'image/tiff',
        body: bytes.subarray(start, end + 1)
      })
      .catch(() => undefined);
  });
}
