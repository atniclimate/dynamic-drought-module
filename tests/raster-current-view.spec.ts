import { expect, test, type Page, type Route } from '@playwright/test';

import { RASTER_PROOF_DEADLINE_MS } from '../src/util/raster-status';
import { gotoApp, layerPill, PILL, selectRegion } from './helpers';

/**
 * A tile-proven raster's pill follows the view MapLibre shows, including a
 * view it restores from its own tile cache (DDM-P14-T04; Codex round 3, J3).
 *
 * MapLibre 6.6 moves a loaded tile that leaves the view into an out-of-view
 * cache (node_modules/maplibre-gl/src/tile/tile_manager.ts:781-794) and puts
 * it back when the view returns (`_addTile`, :694-723): no network request,
 * no `dataloading` event (:721-722 fire it only for a NEW tile) and no `data`
 * event. A verdict built only from request and load events cannot see that
 * return; a reader of the tile manager's current view can. This case drives
 * the real tile manager in the production build, every request routed:
 *
 *   boot  United States (region=national), every tile answers: live.
 *   B0    Hawaii, every tile held: the shared proof deadline floors the pill
 *         at live (partial) (found-042) and leaves that cycle open.
 *   A1    Central Oregon, every tile answers: live. The pill can only move
 *         from live (partial) to live once every tile of this view has
 *         loaded, so the whole view is cached when it leaves.
 *   B1    Hawaii, every tile answers 404 (NIDIS's own answer outside CONUS):
 *         no idle follows an all-404 view, so the verdict is a deadline read
 *         of the settled, all-errored view: unavailable.
 *   A2    Central Oregon again, the same fit as A1, so every tile comes back
 *         from the cache. The route records any tile request and answers it
 *         404, so no response can prove a tile; the pill must read live, and
 *         the route must have seen no request at all.
 *
 * Why B0 and not a 404 view before A1: a 404 view walks its failed tiles up
 * to their parents (tile_manager.ts:195-199, 662-684), and the errored
 * ancestors it shares with Central Oregon (zoom 1 and 0) would stay on the
 * map while A1 loads, a different case. Held tiles request no parent.
 *
 * Why the return cannot pass on request history: after B1 the request sets
 * hold only B1's failed tiles, which leave the map with `sourcedataabort`
 * (tile_manager.ts:797), and A2 adds nothing. A watcher reading those sets
 * has no evidence at A2, so it keeps unavailable (it reports nothing without
 * an open cycle, and an empty cycle reads `error` under TILE_PROOF_WATCH).
 *
 * The camera: the region select (tests/helpers.ts `selectRegion`, as
 * layer-cancellation.spec.ts and m-breadth-bc-drought.spec.ts use it) runs
 * `fitBounds` with `animate: !prefersReducedMotion()` (src/ui/sidebar.ts:
 * 594-603), so under emulated reduced motion (as fire3d-mode.spec.ts uses
 * it) every move is one instant jump with no intermediate views. The
 * production build carries no map handle (src/main.ts:274).
 */

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

async function fulfillPng(route: Route): Promise<void> {
  await route
    .fulfill({ status: 200, contentType: 'image/png', body: ONE_PIXEL_PNG })
    .catch(() => undefined);
}

async function fulfillNotFound(route: Route): Promise<void> {
  await route.fulfill({ status: 404, body: '' }).catch(() => undefined);
}

/** A route gate: every request routed through it waits for `release()`. */
function routeGate(): { readonly held: Promise<void>; release(): void } {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release: () => release() };
}

const isGriddedTile = (url: URL): boolean =>
  url.pathname.includes('/current-conditions/tile/v1/') && url.pathname.endsWith('.png');

/**
 * The product sidecar: the default window's published zoom ceiling (6), so
 * the source is never rebuilt mid-case (src/layers/gridded-index.ts:451-460).
 */
async function stubGriddedInfo(page: Page): Promise<void> {
  await page.route('**/current-conditions/tile/v1/*/info.json', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ date: '2026-09-24', tilezmax: '6' })
    })
  );
}

type TilePhase = 'boot' | 'hold' | 'first-visit' | 'fail' | 'return';

interface GriddedTileRoute {
  /** How the next tile request is answered; set before each camera move. */
  phase: TilePhase;
  /** Every tile URL requested while `phase` read this value, in order. */
  urls(phase: TilePhase): string[];
  /** Let the held requests go; each then answers 404, never a tile. */
  releaseHeld(): void;
}

/**
 * Route every gridded-index tile by phase and log it. A held request is let
 * go only after its view has left (MapLibre aborted it), and then as a 404,
 * so a late response can never prove a tile.
 */
async function routeGriddedTiles(page: Page): Promise<GriddedTileRoute> {
  const log: Array<{ readonly phase: TilePhase; readonly url: string }> = [];
  const gate = routeGate();
  const tiles: GriddedTileRoute = {
    phase: 'boot',
    urls: (phase) => log.filter((entry) => entry.phase === phase).map((entry) => entry.url),
    releaseHeld: () => gate.release()
  };
  await page.route(isGriddedTile, async (route) => {
    const phase = tiles.phase;
    log.push({ phase, url: route.request().url() });
    if (phase === 'boot' || phase === 'first-visit') {
      await fulfillPng(route);
      return;
    }
    if (phase === 'hold') await gate.held;
    await fulfillNotFound(route);
  });
  return tiles;
}

/**
 * Fail closed on any host this case does not answer: registered on the
 * CONTEXT before `gotoApp`, so every page route and every context stub the
 * helpers install later is tried first (Playwright's order), and whatever
 * none of them claims is aborted and logged here instead of reaching a live
 * provider.
 */
async function abortUnroutedHosts(page: Page, appOrigin: string): Promise<string[]> {
  const aborted: string[] = [];
  await page.context().route(
    (url) => url.origin !== appOrigin,
    async (route) => {
      aborted.push(route.request().url());
      await route.abort('blockedbyclient').catch(() => undefined);
    }
  );
  return aborted;
}

/** Two animation frames: MapLibre's next render (and its tile update) has run. */
async function nextFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      })
  );
}

test.describe('a raster pill follows the current view, cache restores included (DDM-P14-T04, J3)', () => {
  test('gridded-index reads live again when its view returns to tiles MapLibre restores from its own cache', async ({
    page,
    baseURL
  }) => {
    // Boot, one proof deadline (B0) and four camera moves.
    test.setTimeout(90_000);
    const aborted = await abortUnroutedHosts(
      page,
      new URL(baseURL ?? 'http://127.0.0.1:4173/').origin
    );
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.route('https://tile.openstreetmap.org/**', fulfillPng);
    await stubGriddedInfo(page);
    const tiles = await routeGriddedTiles(page);
    const pill = layerPill(page, 'gridded-index');

    try {
      await gotoApp(page, '?view=console&layers=gridded-index&region=national');
      await expect(pill).toHaveText(PILL.live);
      expect(tiles.urls('boot').length, 'the boot view fetched its tiles').toBeGreaterThan(0);

      // B0: the held view falls to live (partial) at the proof deadline.
      tiles.phase = 'hold';
      await selectRegion(page, 'hawaii');
      await expect(pill).toHaveText(PILL.degraded, { timeout: RASTER_PROOF_DEADLINE_MS + 7_000 });
      expect(tiles.urls('hold').length, 'the Hawaii view requested tiles').toBeGreaterThan(0);

      // A1: live again only once every Central Oregon tile has loaded.
      tiles.phase = 'first-visit';
      await selectRegion(page, 'central_oregon');
      await expect(pill).toHaveText(PILL.live);
      const firstVisit = new Set(tiles.urls('first-visit'));
      expect(firstVisit.size, 'the first Central Oregon visit fetched its tiles').toBeGreaterThan(0);
      tiles.releaseHeld();

      // B1: every tile fails; the settled view reads unavailable. MapLibre fires
      // no event for a 404 and no idle follows an all-404 view, so the verdict
      // comes at the proof deadline, as B0's does.
      tiles.phase = 'fail';
      await selectRegion(page, 'hawaii');
      await expect(pill).toHaveText(PILL.unavailable, { timeout: RASTER_PROOF_DEADLINE_MS + 7_000 });
      const failed = tiles.urls('fail');
      expect(failed.length, 'the failing Hawaii view requested tiles').toBeGreaterThan(0);
      expect(
        failed.filter((url) => firstVisit.has(url)),
        'the failing view shares no tile with Central Oregon, so none of its cached tiles was touched'
      ).toEqual([]);

      // A2: the same fit as A1; every tile comes back from MapLibre's cache.
      tiles.phase = 'return';
      await selectRegion(page, 'central_oregon');
      await nextFrames(page);
      expect(tiles.urls('return'), 'the return to Central Oregon requested no tile').toEqual([]);
      await expect(pill).toHaveText(PILL.live);
      await nextFrames(page);
      expect(tiles.urls('return'), 'the live verdict came with no tile request').toEqual([]);
    } finally {
      tiles.releaseHeld();
      if (aborted.length > 0) {
        test.info().annotations.push({
          type: 'aborted-unrouted-requests',
          description: aborted.join('\n')
        });
      }
    }
  });
});
