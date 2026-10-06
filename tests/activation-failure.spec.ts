import { continueLocalRoute } from './offline-test';
import { expect, test, type Page } from './offline-test';

import {
  HAZARD_CLUSTERS,
  HAZARD_CLUSTER_KEYS,
  TEMPORAL_HORIZON_KEYS,
  type HazardClusterKey,
  type TemporalHorizonKey
} from '../src/config/clusters';
import {
  gotoApp,
  layerCheckbox,
  layerPill,
  search,
  urlLayers,
  waitForLayerSettled,
  PILL
} from './helpers';

/**
 * DDM-P1-T03 (`docs/ROADMAP.yaml:180`): "A thrown and a non-thrown activation
 * failure both leave the checkbox and URL self-corrected and the unavailable
 * state visible and announced once."
 *
 * Before this task the two failure tails in `activateWithIndicator`
 * (`src/state/layer-controller.ts`) ran the same four steps in a DIFFERENT
 * order. The non-thrown branch cleared the checkbox and intent, called
 * `registry.deactivate` (which clears the key's stored status as a side
 * effect, `src/state/registry.ts`), and only THEN re-asserted `'error'`. The
 * thrown branch asserted `'error'` FIRST and called `registry.deactivate`
 * LAST, so its `'error'` was wiped and never re-asserted: a later
 * `registry.getStatus()` read `undefined` (off), not `'error'`
 * (unavailable). Both branches now call one shared `failActivation` helper,
 * in the non-thrown branch's order, so the two paths cannot diverge again.
 *
 * `tests/url-state.spec.ts` ("a layer whose activation fails without
 * throwing never enters the share URL") already proves the checkbox, pill
 * and URL clauses for the non-thrown path; this file re-proves those three
 * clauses for BOTH paths side by side and adds the "announced once" clause,
 * which no existing spec checks.
 *
 * The live region is `#layer-status-live` (`src/ui/sidebar.ts`); a
 * `MutationObserver` installed before the toggle records every write to it,
 * so "announced" counts actual `status-change` events carrying the word the
 * app uses for `'error'` (`PILL.unavailable`, `src/ui/island/pill-text.ts`),
 * not just the final DOM text a single read would show. Both tests below
 * assert EXACTLY one announcement: `failActivation`
 * (`src/state/layer-controller.ts`) now reads `registry.getStatus(key)`
 * before deactivating, and when a module already self-reported `'error'`
 * (the non-thrown path; for example usdm.ts:794 `reportStatus('error');
 * return`) it calls `registry.deactivate(key, { keepStatus: true })` and
 * does NOT call `setStatus` again, instead of unconditionally re-asserting
 * `'error'` after `registry.deactivate` wiped it and double-announcing
 * (DDM-P1-T03 correction, 2026-09-08).
 */

/** Start recording every write to the polite live region's text. */
async function watchAnnouncements(page: Page): Promise<void> {
  await page.evaluate(() => {
    const el = document.getElementById('layer-status-live');
    const w = window as unknown as { __ddmAnnouncements?: string[] };
    w.__ddmAnnouncements = [];
    if (!el) return;
    const observer = new MutationObserver(() => {
      w.__ddmAnnouncements!.push(el.textContent ?? '');
    });
    observer.observe(el, { childList: true, characterData: true, subtree: true });
  });
}

/** Every live-region write recorded since the matching `watchAnnouncements` call. */
async function recordedAnnouncements(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __ddmAnnouncements?: string[] }).__ddmAnnouncements ?? []
  );
}

test.describe('DDM-P1-T03: activation failure, thrown and non-thrown, self-correct identically', () => {
  test('a thrown activation failure (a layer chunk that fails to import) self-corrects and announces "unavailable" once', async ({
    page
  }) => {
    // Ecoregions is off by default and, on first toggle, fetches nothing but
    // its own chunk, so aborting that chunk request throws before the
    // module is ever obtained: `loadLayerModule` (src/config/layers.ts)
    // rejects, and `activateWithIndicator`'s `catch (err)` branch runs with
    // `mod` never assigned -- the genuinely thrown path.
    await page.route(/ecoregions-[^/]*\.js(\?.*)?$/, (route) => route.abort());
    await gotoApp(page, '?layers=');
    await watchAnnouncements(page);

    // `.click()`, not `.check()`: the aborted chunk import (a single hop,
    // no module ever loaded to make a second request from) can fail and
    // self-correct fast enough that `.check()`'s own post-click "did it
    // become checked" verification sometimes samples after the checkbox
    // has already been unchecked again by failActivation, reporting
    // "Clicking the checkbox did not change its state" for behavior this
    // test means to exercise. `waitForLayerSettled` below is the real
    // synchronization point.
    await layerCheckbox(page, 'ecoregions').click();
    await waitForLayerSettled(page, 'ecoregions');

    await expect(layerCheckbox(page, 'ecoregions')).not.toBeChecked();
    await expect(layerPill(page, 'ecoregions')).toHaveText(PILL.unavailable);
    expect((await urlLayers(page)).has('ecoregions')).toBe(false);

    const seen = await recordedAnnouncements(page);
    expect(seen.filter((text) => text.includes(PILL.unavailable)).length).toBe(1);
  });

  test('a non-thrown activation failure (a module that reports its own error) self-corrects and is announced', async ({
    page
  }) => {
    // USDM's own fetch failure is caught inside usdm.ts's activateUsdm
    // (reportStatus('error'); return), so mod.activate resolves normally:
    // the controller's non-thrown branch
    // (`registry.getStatus(def.key) === 'error'`) runs, never the
    // `catch (err)` branch above. Same regression as tests/url-state.spec.ts's
    // "never enters the share URL" test; this test adds the live-region
    // check that one does not make.
    await page.route('**/USDM_current/**', (route) => route.abort());
    await gotoApp(page, '?layers=');
    await watchAnnouncements(page);

    await layerCheckbox(page, 'usdm').check();
    await waitForLayerSettled(page, 'usdm');

    await expect(layerCheckbox(page, 'usdm')).not.toBeChecked();
    await expect(layerPill(page, 'usdm')).toHaveText(PILL.unavailable);
    expect((await urlLayers(page)).has('usdm')).toBe(false);

    // usdm.ts's own `reportStatus('error')` (usdm.ts:794) sets the stored
    // status to 'error' before returning; failActivation
    // (src/state/layer-controller.ts) sees that status already recorded and
    // calls `registry.deactivate(key, { keepStatus: true })` instead of
    // deactivating plain and calling `setStatus` again, so only usdm.ts's
    // own status-change announces "unavailable": exactly once.
    const seen = await recordedAnnouncements(page);
    expect(seen.filter((text) => text.includes(PILL.unavailable)).length).toBe(1);
  });

  // D1 M5 (2026-09-27; found-003, DDM-P10-T09; the director's Tier 1 scope):
  // a failure of a RECIPE layer of the COMMITTED cluster keeps the layer
  // checked, so the view stays committed. The two cases above are custom
  // `layers=` sets and keep their uncheck-and-leave behaviour.
  test('a recipe layer that fails to activate keeps its hazard pressed, cluster= in the URL and Current Conditions enabled, in every HAZARD_CLUSTER_KEYS mode', async ({
    page
  }) => {
    // One case per distinct non-empty recipe, enumerated from config (DR-113):
    // a horizon whose recipe repeats an earlier one's layers is the same
    // failure and is reached only through that earlier chip; an empty recipe
    // (Extreme Heat at season-ahead) has no layer to fail.
    const cases: Array<{
      readonly cluster: HazardClusterKey;
      readonly horizon: TemporalHorizonKey;
      readonly failing: string;
    }> = [];
    for (const cluster of HAZARD_CLUSTER_KEYS) {
      const seen = new Set<string>();
      for (const horizon of TEMPORAL_HORIZON_KEYS) {
        const recipe = HAZARD_CLUSTERS[cluster].recipes[horizon];
        const failing = recipe[0];
        const signature = recipe.join(',');
        if (failing === undefined || seen.has(signature)) continue;
        seen.add(signature);
        cases.push({ cluster, horizon, failing });
      }
    }
    expect(new Set(cases.map((c) => c.cluster))).toEqual(new Set(HAZARD_CLUSTER_KEYS));
    test.setTimeout(60_000 + cases.length * 45_000);

    // The other recipe members answer an empty, valid collection, so the one
    // forced failure is the only failure and no case reaches a live agency.
    await page.route(
      (url) =>
        url.href.includes('WFIGS_Interagency_Perimeters_Current') ||
        url.href.includes('NOAA_Satellite_Smoke_Detection') ||
        url.href.includes('/SPC_firewx/MapServer/1/query') ||
        url.pathname.endsWith('/watch_warn_adv/MapServer/1/query'),
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/geo+json',
          body: JSON.stringify({ type: 'FeatureCollection', features: [] })
        })
    );

    // The thrown shape: the failing layer's own chunk (Vite names it after
    // the module, plus an eight-character hash) never loads, so
    // `loadLayerModule` rejects inside the controller's activation. One
    // route, pointed at each case's chunk in turn; a fresh navigation per
    // case, so no module is cached.
    let failingChunk: RegExp | null = null;
    await page.route(
      (url) => failingChunk !== null && failingChunk.test(url.pathname),
      (route) => route.abort()
    );

    for (const { cluster, horizon, failing } of cases) {
      await test.step(`${cluster} at ${horizon}: ${failing} fails`, async () => {
        failingChunk = new RegExp(`/${failing}-[A-Za-z0-9_-]{8}\\.js$`);
        await gotoApp(page, '?view=console');
        const clusterButton = page.locator(`.shell-cluster-btn[data-cluster="${cluster}"]`);
        await clusterButton.click();
        if (horizon !== 'current') {
          await page.locator(`.shell-horizon-btn[data-horizon="${horizon}"]`).click();
        }
        await waitForLayerSettled(page, failing);

        await expect(layerPill(page, failing)).toHaveText(PILL.unavailable);
        await expect(layerCheckbox(page, failing)).toBeChecked();
        await expect(clusterButton).toHaveAttribute('aria-pressed', 'true');
        await expect(
          page.locator(`.shell-horizon-btn[data-horizon="${horizon}"]`)
        ).toHaveAttribute('aria-pressed', 'true');
        const params = new URLSearchParams(await search(page));
        const token = HAZARD_CLUSTERS[cluster].urlToken;
        if (token !== null) {
          expect(params.get('cluster')).toBe(token);
          expect(params.has('layers')).toBe(false);
        } else {
          // The default view serializes as absence of cluster= and its
          // layer list (src/state/url.ts), so the claim is that list.
          expect(params.has('cluster')).toBe(false);
          expect((await urlLayers(page)).has(failing)).toBe(true);
        }
        // Current Conditions stays enabled as the way back.
        expect(
          await page
            .locator(`.shell-horizon-btn[data-horizon="${TEMPORAL_HORIZON_KEYS[0]}"]`)
            .getAttribute('aria-disabled')
        ).toBeNull();
      });
    }
  });

  // A third shape -- a module that self-reports 'error' and THEN throws
  // (drought.ts:527-529, `reportStatus('error'); throw err;`) -- is not
  // added here: reaching that catch block requires ensureHatchImages,
  // map.addSource, or map.addLayer (drought.ts:477-514) to throw, and none
  // of those depend on a network request a Playwright `page.route` abort
  // can reach; forcing one deterministically would need patching MapLibre
  // internals from the test, which this brief's owned files do not cover.
});

// Imported here rather than in the header so the found-073 cases below are
// a pure append (ES module imports are hoisted wherever they sit).
import { DEFAULT_ON_KEYS } from '../src/config/layers';

/**
 * found-073 and found-074 (D1 follow-up to M5, 2026-09-27; DDM-P10-T09).
 *
 * found-073: every committed composition carries the persistent reference
 * set (the default-on keys that are not a surface: `composeClusterIntent`,
 * src/state/cluster-service.ts), which is NOT a recipe member, so M5's
 * keep-checked rule did not reach it. Before this fix a failed reference
 * layer was unchecked, the checked set no longer equalled the committed
 * composition, and `reconcileClusterWithLayerIntent` demoted the mode to a
 * custom set. The director's ruling of 2026-09-27 extends M5's rule from the
 * recipe to the whole committed composition: the failed reference layer
 * stays checked and reads unavailable, the hazard stays pressed, `cluster=`
 * stays, and Drought's `layers=` list is unchanged, so a reload boots
 * Drought again.
 *
 * The reference layer forced to fail is State Boundaries (`states`): it is a
 * member of every composition, it activates from a bundled file with no live
 * agency behind it, and its chunk is imported only by its own layer loader.
 * Terrain Shading was not chosen because its chunk is also a static
 * dependency of the Fire 3D chunk (src/map/fire3d.ts imports
 * `resolveHillshadeArchive`), so aborting it could fail an unrelated import.
 *
 * found-074: a persisted reference extra (a reference layer on outside the
 * composition, here City & Town Labels) makes a mode switch commit DEMOTED
 * by design: the snapshot reads 'custom' and the URL keeps the granular
 * `layers=` truth, because a one-word `cluster=` would drop the extra from
 * the share round-trip (D-0.7.0-044; cluster-service.ts "Reference extras"
 * and applyCluster step 5). No hazard is pressed from the moment of the
 * switch, before any layer settles, so a recipe failure there is a failure
 * in a custom set and keeps M5's custom-set rule: it unchecks and leaves
 * `layers=`. The case below pins that kept behaviour.
 */
test.describe('found-073 and found-074: a failed reference layer and a persisted extra', () => {
  /** The failing reference layer (see the block comment above). */
  const REFERENCE = 'states';

  /** Answer the live event and alert recipe members with an empty valid
   * collection, exactly as the M5 case does, so no case reaches an agency. */
  async function stubRecipeEvents(page: Page): Promise<void> {
    await page.route(
      (url) =>
        url.href.includes('WFIGS_Interagency_Perimeters_Current') ||
        url.href.includes('NOAA_Satellite_Smoke_Detection') ||
        url.href.includes('/SPC_firewx/MapServer/1/query') ||
        url.pathname.endsWith('/watch_warn_adv/MapServer/1/query'),
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/geo+json',
          body: JSON.stringify({ type: 'FeatureCollection', features: [] })
        })
    );
  }

  /** The reference layer's own chunk request, held until the test releases
   * it and then aborted (the thrown shape of M5's technique). With `hold`
   * false the request aborts at once. A property bag, not a bare `let`, so
   * the resolver the route handler stores stays callable to the checker. */
  const gate = { hold: true, requested: false, release: (): void => {} };

  async function failReferenceChunk(page: Page): Promise<void> {
    const chunk = new RegExp(`/${REFERENCE}-[A-Za-z0-9_-]{8}\\.js$`);
    await page.route(
      (url) => chunk.test(url.pathname),
      async (route) => {
        gate.requested = true;
        if (gate.hold) {
          await new Promise<void>((resolve) => {
            gate.release = resolve;
          });
        }
        await route.abort();
      }
    );
  }

  /** The committed mode's claim survives the failure exactly as M5 keeps a
   * failed recipe layer: the reference layer checked and unavailable, the
   * hazard pressed, cluster= kept, and Drought's layers= list equal to the
   * list the display carried before the failure (the reference layer in
   * it). */
  async function expectModeKept(
    page: Page,
    cluster: HazardClusterKey,
    droughtLayers: ReadonlySet<string>
  ): Promise<void> {
    await expect(layerPill(page, REFERENCE)).toHaveText(PILL.unavailable);
    await expect(layerCheckbox(page, REFERENCE)).toBeChecked();
    await expect(
      page.locator(`.shell-cluster-btn[data-cluster="${cluster}"]`)
    ).toHaveAttribute('aria-pressed', 'true');
    const params = new URLSearchParams(await search(page));
    const token = HAZARD_CLUSTERS[cluster].urlToken;
    if (token !== null) {
      expect(params.get('cluster')).toBe(token);
      expect(params.has('layers')).toBe(false);
    } else {
      // Drought serializes as absence of cluster= plus its checked list.
      expect(params.has('cluster')).toBe(false);
      expect(droughtLayers.has(REFERENCE)).toBe(true);
      expect(await urlLayers(page)).toEqual(new Set(droughtLayers));
    }
  }

  test('a reference layer that fails after a hazard is pressed stays checked and unavailable, is announced once, and leaves the hazard pressed and the URL unchanged, in every HAZARD_CLUSTER_KEYS mode', async ({
    page
  }) => {
    test.setTimeout(60_000 + HAZARD_CLUSTER_KEYS.length * 60_000);
    await stubRecipeEvents(page);
    await failReferenceChunk(page);

    for (const cluster of HAZARD_CLUSTER_KEYS) {
      await test.step(`${cluster}: ${REFERENCE} fails after the press`, async () => {
        gate.hold = true;
        gate.requested = false;
        // An all-off boot, so the press is the transaction that activates
        // the whole composition, the failing reference layer included.
        await gotoApp(page, '?view=console&layers=');
        await watchAnnouncements(page);
        await page.locator(`.shell-cluster-btn[data-cluster="${cluster}"]`).click();
        // The press wrote its URL synchronously; read it while the
        // reference chunk is still held, then let the failure land.
        await expect.poll(() => gate.requested).toBe(true);
        const before = await urlLayers(page);
        gate.release();
        await waitForLayerSettled(page, REFERENCE);

        await expectModeKept(page, cluster, before);
        const failedName = 'State Boundaries: ' + PILL.unavailable;
        const seen = await recordedAnnouncements(page);
        expect(seen.filter((text) => text.includes(failedName)).length).toBe(1);

        if (HAZARD_CLUSTERS[cluster].urlToken === null) {
          // Drought's claim is its layers= list; a reload of the URL after
          // the failure boots Drought again (the reference layer fails
          // again at once and stays checked).
          gate.hold = false;
          await gotoApp(page, await search(page));
          await waitForLayerSettled(page, REFERENCE);
          await expectModeKept(page, cluster, before);
        }
      });
    }
  });

  test('a reference layer that fails on a mode deep link stays checked and unavailable, and the mode boots pressed with its URL unchanged, in every HAZARD_CLUSTER_KEYS mode', async ({
    page
  }) => {
    test.setTimeout(60_000 + HAZARD_CLUSTER_KEYS.length * 45_000);
    await stubRecipeEvents(page);
    gate.hold = false;
    await failReferenceChunk(page);

    for (const cluster of HAZARD_CLUSTER_KEYS) {
      await test.step(`${cluster}: ${REFERENCE} fails during the boot`, async () => {
        const token = HAZARD_CLUSTERS[cluster].urlToken;
        await gotoApp(page, token === null ? '?view=console' : `?view=console&cluster=${token}`);
        await waitForLayerSettled(page, REFERENCE);

        // A bare Drought boot is the default-on set (src/state/url.ts).
        await expectModeKept(page, cluster, DEFAULT_ON_KEYS);
      });
    }
  });

  test('a recipe layer that fails in a switch carrying a persisted reference extra keeps the designed demoted commit: no hazard pressed, the extra kept, the failed layer unchecked and out of layers=', async ({
    page
  }) => {
    const EXTRA = 'places';
    const cases = HAZARD_CLUSTER_KEYS.flatMap((cluster) => {
      const failing = HAZARD_CLUSTERS[cluster].recipes[TEMPORAL_HORIZON_KEYS[0]][0];
      return failing === undefined ? [] : [{ cluster, failing }];
    });
    expect(new Set(cases.map((c) => c.cluster))).toEqual(new Set(HAZARD_CLUSTER_KEYS));
    test.setTimeout(60_000 + cases.length * 45_000);
    await stubRecipeEvents(page);

    let failingChunk: RegExp | null = null;
    await page.route(
      (url) => failingChunk !== null && failingChunk.test(url.pathname),
      (route) => route.abort()
    );

    for (const { cluster, failing } of cases) {
      await test.step(`${cluster}: ${failing} fails beside ${EXTRA}`, async () => {
        failingChunk = new RegExp(`/${failing}-[A-Za-z0-9_-]{8}\\.js$`);
        await gotoApp(page, `?view=console&layers=${EXTRA}`);
        await waitForLayerSettled(page, EXTRA);
        const clusterButton = page.locator(`.shell-cluster-btn[data-cluster="${cluster}"]`);
        await clusterButton.click();
        await waitForLayerSettled(page, failing);

        await expect(layerPill(page, failing)).toHaveText(PILL.unavailable);
        await expect(layerCheckbox(page, failing)).not.toBeChecked();
        await expect(layerCheckbox(page, EXTRA)).toBeChecked();
        await expect(clusterButton).toHaveAttribute('aria-pressed', 'false');
        const params = new URLSearchParams(await search(page));
        expect(params.has('cluster')).toBe(false);
        const listed = await urlLayers(page);
        expect(listed.has(EXTRA)).toBe(true);
        expect(listed.has(failing)).toBe(false);
      });
    }
  });
});

/**
 * found-087 (register; DDM-P1-T10): before this fix `loadLayerModule`
 * (`src/config/layers.ts`) called `def.load()` bare. A failed dynamic
 * `import()` is cached by the engine per URL, so a bare replay after a
 * rejection names the SAME url and rejects again with NO new network
 * request: a layer whose chunk failed to load once could never load again
 * this session, however many later explicit re-checks a reader made. The
 * fix routes every layer's `load` through one per-key
 * `createChunkLoader(def.load, import.meta.url)` (`src/util/chunk-retry.ts`),
 * memoised lazily on first load, so a LATER call imports the chunk under a
 * fresh `retry=<n>` query, a cache key the engine has never marked failed.
 *
 * Ecoregions (off by default, a pure chunk-load case with no other network
 * dependency once its module resolves: `tests/activation-failure.spec.ts`'s
 * own "thrown" case above already uses this exact chunk for the same
 * reason) is not in the default composition, so a fresh boot with
 * `?layers=` starts it off and this test drives its own single toggle
 * in and out, matching the brief's "not in a default composition" option.
 */
test.describe('found-087: a layer whose chunk failed once loads on a later re-check', () => {
  test('a layer whose chunk failed once loads on a later re-check, through a retry URL', async ({
    page
  }) => {
    const chunkRequests: string[] = [];
    await page.route(/ecoregions-[^/]*\.js(\?.*)?$/, (route) => {
      chunkRequests.push(route.request().url());
      // Abort only the FIRST request; every later one (the retry) is let
      // through to prove it reaches the network under a new url rather
      // than never being requested at all.
      if (chunkRequests.length === 1) {
        void route.abort();
      } else {
        void continueLocalRoute(route);
      }
    });
    await gotoApp(page, '?layers=');

    await layerCheckbox(page, 'ecoregions').click();
    await waitForLayerSettled(page, 'ecoregions');
    await expect(layerCheckbox(page, 'ecoregions')).not.toBeChecked();
    await expect(layerPill(page, 'ecoregions')).toHaveText(PILL.unavailable);
    // Predicted red on the base source: `loadLayerModule` replayed the SAME
    // cached-failed url, which the engine rejects without ever reaching the
    // network, so `chunkRequests.length` stays 1 forever, never 2 -- no
    // amount of re-checking would grow it. This assertion passes already
    // (both before and after the fix); the growth to 2 below is the one
    // that reds on the base source.
    expect(chunkRequests.length).toBe(1);

    // A later, explicit re-check: no timer, no automatic retry, just the
    // reader unchecking and checking the box again, exactly the action this
    // unit's scope names.
    await layerCheckbox(page, 'ecoregions').click();
    await waitForLayerSettled(page, 'ecoregions');

    expect(chunkRequests.length).toBe(2);
    expect(new URL(chunkRequests[1]).searchParams.get('retry')).toBe('1');
    await expect(layerCheckbox(page, 'ecoregions')).toBeChecked();
    await expect(layerPill(page, 'ecoregions')).toHaveText(PILL.live);
  });
});
