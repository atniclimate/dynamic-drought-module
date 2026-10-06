import { test, expect, type Page, type Route } from './offline-test';

import { HAZARD_CLUSTER_KEYS } from '../src/config/clusters';
import { gotoApp, layerCheckbox, layerPill, search } from './helpers';

/**
 * DG-080 r2 finding 4: the deferred REAL layer-controller integration.
 *
 * The Node spec in tests/cluster-service.spec.ts drives the cluster
 * service against a test-local deferred controller, which proves the
 * service's coherence ASSUMING a controller drops stale settles; the
 * production controller's own drop is proved in
 * tests/stale-generation.test.mjs (stub modules settled by hand, out of
 * order, under the real `createLayerController`). This spec exercises the
 * whole production path in the built app: the real controller bound by
 * buildSidebar at boot, its per-key op chains, intent generations, abort at
 * off intent, the modules' own late-response guards, and the registry and
 * status writes, through the same shell buttons a user presses.
 *
 * The pressure pattern is the review's A -> B -> A: Wildfire (its pair's
 * fetches HELD at the network layer), Drought before anything settles,
 * Wildfire again (fresh fetches answered normally). The two request
 * generations carry DIFFERENT payloads (S30D P3-STALE, found-124): the
 * stale first generation answers an EMPTY collection, which a layer reports
 * as "no data", and the fresh generation answers a feature, which reads
 * "live". The first-generation responses are released only after the
 * second generation has settled, so a stale answer that landed anywhere
 * would show as a "no data" pill, in the history the page recorded from
 * before the first press or in the settled display, and the case fails on
 * it. Everything asserted is observable truth (checkbox intent, the status
 * pill's class and words, the summary sentence, the URL claim); nothing
 * reimplements the guard.
 *
 * Which defence this browser case reaches. The production abort at off
 * intent (the controller-owned signal and the modules' own cancellation
 * seam, two redundant mechanisms) cancels the held first-generation
 * fetches before they are released, so a single broken defence (one abort
 * seam, the op chain, the intent generation, a module guard) can stay green
 * here behind the next; the Node file above breaks and reds each defence on
 * its own.
 */

const NIFC_PATTERN = 'WFIGS_Interagency_Perimeters_Current';
const HMS_PATTERN = 'NOAA_Satellite_Smoke_Detection';

/** The stale generation's answer: a valid, EMPTY collection ("no data"). */
const EMPTY_COLLECTION = { type: 'FeatureCollection', features: [] };

/** The fresh generation's NIFC answer: one perimeter ("live"). */
const NIFC_FIXTURE = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {
        attr_IncidentName: 'Synthetic Integration Fire',
        attr_IncidentTypeCategory: 'WF',
        attr_IncidentSize: 1234,
        attr_FireDiscoveryDateTime: 1753300000000,
        attr_POOState: 'US-OR'
      },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-121, 44],
            [-120.5, 44],
            [-120.5, 44.5],
            [-121, 44.5],
            [-121, 44]
          ]
        ]
      }
    }
  ]
};

/** The fresh generation's HMS answer: one plume ("live"). */
const HMS_FIXTURE = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {
        Satellite: 'GOES-WEST',
        Start: '2026206 0000',
        End_: '2026206 0600',
        Density: 'Light'
      },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-122, 45],
            [-121, 45],
            [-121, 46],
            [-122, 46],
            [-122, 45]
          ]
        ]
      }
    }
  ]
};

/** Pill raw-status class for a key ('' while off/cleared). */
async function pillStatusClasses(page: Page, key: string): Promise<string> {
  return (
    (await page
      .locator(`[data-layer-status="${key}"]`)
      .getAttribute('class')) ?? ''
  );
}

type PillHistory = Record<string, string[]>;

const RECORDED_KEYS = ['nifc-fires', 'hms-smoke'] as const;

/**
 * Record every distinct pill class the page shows for the Wildfire pair from
 * now on. A stale answer that lands, even briefly, writes its status into the
 * pill; reading only the settled state would miss it.
 */
async function recordPillHistory(page: Page): Promise<void> {
  await page.evaluate((keys) => {
    const history: PillHistory = {};
    for (const key of keys) history[key] = [];
    const sample = (): void => {
      for (const key of keys) {
        const el = document.querySelector(`[data-layer-status="${key}"]`);
        const value = el ? el.className : '(absent)';
        const seen = history[key] as string[];
        if (seen[seen.length - 1] !== value) seen.push(value);
      }
    };
    sample();
    new MutationObserver(sample).observe(document.body, {
      subtree: true,
      attributes: true,
      childList: true,
      characterData: true
    });
    (window as unknown as { __pillHistory: PillHistory }).__pillHistory = history;
  }, RECORDED_KEYS);
}

async function readPillHistory(page: Page): Promise<PillHistory> {
  return page.evaluate(
    () => (window as unknown as { __pillHistory: PillHistory }).__pillHistory
  );
}

test.describe('real layer-controller integration (DG-080 r2 finding 4)', () => {
  test('rapid A -> B -> A through the shell: stale first-generation work never corrupts the settled display', async ({
    page
  }) => {
    // Held first-generation responses: fulfilled only after the fresh
    // generation settles, with the STALE payload (an empty collection). A
    // fulfill against an already-aborted request (the module cancellation
    // contract, invariant 5) rejects or never reaches the page; that is the
    // production abort path doing its job, so it is swallowed. `release`
    // resolves when the request has reached an outcome (the page received
    // the response and its body finished, or the page had aborted it), so
    // the case waits on that outcome, not on a window.
    let generation: 'stale' | 'fresh' = 'stale';
    const held: Array<() => Promise<void>> = [];
    const answer = (route: Route, body: unknown): Promise<void> =>
      route
        .fulfill({
          status: 200,
          contentType: 'application/geo+json',
          body: JSON.stringify(body)
        })
        .catch(() => {
          /* aborted by the page: the production cancellation won */
        })
        .then(async () => {
          const response = await route.request().response().catch(() => null);
          if (response) await response.finished().catch(() => null);
        });
    const serve = (route: Route, stale: unknown, fresh: unknown): void => {
      if (generation === 'stale') {
        held.push(() => answer(route, stale));
      } else {
        void answer(route, fresh);
      }
    };
    await page.route(
      (url) => url.href.includes(NIFC_PATTERN),
      (route) => serve(route, EMPTY_COLLECTION, NIFC_FIXTURE)
    );
    await page.route(
      (url) => url.href.includes(HMS_PATTERN),
      (route) => serve(route, EMPTY_COLLECTION, HMS_FIXTURE)
    );

    await gotoApp(page);
    await expect(page.locator('.shell-cluster-btn')).toHaveCount(
      HAZARD_CLUSTER_KEYS.length
    );
    await recordPillHistory(page);

    const wildfireBtn = page.locator('.shell-cluster-btn[data-cluster="wildfire"]');
    const droughtBtn = page.locator('.shell-cluster-btn[data-cluster="drought"]');

    // A: Wildfire. The pair's intent lands synchronously; the fetches
    // are held, so the committed button shows pending work, honestly.
    await wildfireBtn.click();
    await expect(wildfireBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(layerCheckbox(page, 'nifc-fires')).toBeChecked();
    await expect(layerCheckbox(page, 'hms-smoke')).toBeChecked();
    await expect.poll(() => held.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
    await expect(wildfireBtn).toHaveAttribute('data-pending', 'true');

    // B: Drought, before anything wildfire settled. The production
    // controller must supersede the in-flight pair activations. The surface
    // the Drought press switches to at the current horizon is nadm-drought.
    await droughtBtn.click();
    await expect(droughtBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(wildfireBtn).toHaveAttribute('aria-pressed', 'false');
    await expect(layerCheckbox(page, 'nifc-fires')).not.toBeChecked();
    await expect(layerCheckbox(page, 'nadm-drought')).toBeChecked();

    // A again: fresh wildfire generation, answered normally with the FRESH
    // payload.
    generation = 'fresh';
    await wildfireBtn.click();
    await expect(wildfireBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(layerCheckbox(page, 'nifc-fires')).toBeChecked();
    await expect(layerCheckbox(page, 'hms-smoke')).toBeChecked();
    await expect(layerCheckbox(page, 'nadm-drought')).not.toBeChecked();

    // The fresh generation settles live through the real controller and
    // registry (module status writes included) WHILE the stale responses are
    // still held: the per-key chain lets it start only because the abort at
    // off intent ended the stale op. The pill reads "live" for the feature
    // the fresh answer carried, not "no data" for the empty collection the
    // stale one did.
    await expect
      .poll(() => pillStatusClasses(page, 'nifc-fires'), { timeout: 45_000 })
      .toContain('ready');
    await expect
      .poll(() => pillStatusClasses(page, 'hms-smoke'), { timeout: 45_000 })
      .toContain('ready');
    await expect(wildfireBtn).toHaveAttribute('data-pending', 'false', {
      timeout: 45_000
    });
    await expect(page.locator('#shell-summary-primary')).toContainText(
      'Current Mapped Fire Perimeters (National Interagency Fire Center, NIFC)'
    );

    // NOW release the stale first-generation responses (same keys,
    // intended again under a newer generation: the review's hardest
    // case). The production guard (the abort at off intent with the
    // modules' own cancellation, per-key intent generations, op chains, the
    // modules' late-response guards) must drop them without a flicker of
    // state. Wait for every one to reach an outcome (delivered and
    // finished, or aborted by the page), then one round trip to the page,
    // instead of a window.
    await Promise.all(held.splice(0, held.length).map((release) => release()));
    await page.evaluate(() => undefined);

    await expect(wildfireBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(wildfireBtn).toHaveAttribute('data-pending', 'false');
    await expect(layerCheckbox(page, 'nifc-fires')).toBeChecked();
    await expect(layerCheckbox(page, 'hms-smoke')).toBeChecked();
    // The newest generation's answer is what the display shows: "live"
    // pills, not the stale generation's "no data".
    for (const key of RECORDED_KEYS) {
      expect(await pillStatusClasses(page, key)).toContain('ready');
      expect(await pillStatusClasses(page, key)).not.toContain('no-data');
      await expect(layerPill(page, key)).toHaveText('live');
    }
    // No pill ever carried the stale generation's status: across the whole
    // sequence the Wildfire pair went loading and live, never "no data",
    // "unavailable", or "live (partial)".
    const history = await readPillHistory(page);
    for (const key of RECORDED_KEYS) {
      const seen = history[key] ?? [];
      expect(
        seen.filter((cls) => /no-data|error|degraded/.test(cls)),
        `${key} pill history: ${JSON.stringify(seen)}`
      ).toEqual([]);
      expect(seen[seen.length - 1], `${key} pill history ends live`).toContain('ready');
    }
    // The dropped surface (nadm-drought, the Drought press's surface at the
    // current horizon) is off and makes no claim: unchecked, and its pill
    // carries no stale status class from the superseded generation.
    await expect(layerCheckbox(page, 'nadm-drought')).not.toBeChecked();
    expect(await pillStatusClasses(page, 'nadm-drought')).not.toContain('ready');
    await expect(page.locator('#shell-summary-primary')).toContainText(
      'Current Mapped Fire Perimeters (National Interagency Fire Center, NIFC)'
    );
    // The URL claim is the clean cluster, not a stale granular residue.
    await page.waitForFunction(() =>
      window.location.search.includes('cluster=wildfire')
    );
    expect(await search(page)).not.toContain('layers=');
  });
});
