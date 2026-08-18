import { test, expect } from '@playwright/test';

import {
  gotoApp,
  layerCheckbox,
  regionSelect,
  selectRegion,
  search,
  urlLayers,
  waitForLayerSettled,
  DEFAULT_ON
} from './helpers';
import { FRAMING_KEYS } from '../src/config/framings';
import { HAZARD_CLUSTER_KEYS, HAZARD_CLUSTERS } from '../src/config/clusters';
import { OCEAN_KEYS } from '../src/config/oceans';
import { LAYER_DEFS } from '../src/config/layers';
import { parseFramingParam } from '../src/state/framing-store';
import { parseClusterParam, parseOceanParam } from '../src/state/cluster-store';
// The boot composition moved to the S3 cluster service (the S2 interim
// mechanics retired per the 2026-07-24 conductor amendment); the pinned
// assertions below are unchanged.
import { composeClusterIntent } from '../src/state/cluster-service';
import { parseShellParams } from '../src/state/url';
import { deriveViewMode } from '../src/state/view-mode';

/**
 * S2: the region-shell URL migration (D-0.7.0-039/041/042/044/046/053;
 * this suite pins the region-shell precedence table in full).
 *
 * Two halves, matching the suite's established shapes:
 *
 *   - Pure Node assertions (the u4-opening-map / s1-substrate pattern)
 *     pin the parse grammar and EVERY precedence pair, because the
 *     parsers are deliberately pure over URLSearchParams (the
 *     deriveViewMode pattern) exactly so the table is testable without
 *     a browser.
 *   - Browser drives pin the boot behavior: the cluster recipe applied
 *     through the ordinary activation path, the durable-truth URL
 *     claim and its handoff back to layers=, the ocean gating, and the
 *     legacy links that must keep working byte for byte.
 */

const SURFACE_KEYS = new Set(
  LAYER_DEFS.filter((def) => def.role === 'surface').map((def) => def.key)
);

// ---------------------------------------------------------------------------
// Node: the parse grammar
// ---------------------------------------------------------------------------

test.describe('S2 parse grammar (Node)', () => {
  test('framing= accepts the nine shape keys plus the explicit ALL camera', () => {
    for (const key of FRAMING_KEYS) {
      expect(parseFramingParam(key)).toBe(key);
    }
    expect(parseFramingParam('all')).toBe('all');
    expect(parseFramingParam(null)).toBeNull();
    expect(parseFramingParam('')).toBeNull();
    expect(parseFramingParam('national')).toBeNull();
    expect(parseFramingParam('MEXICO')).toBeNull();
    expect(parseFramingParam('atlantis')).toBeNull();
  });

  test('cluster= accepts the three ruled tokens; drought is absence (D-0.7.0-044)', () => {
    expect(parseClusterParam('wildfire')).toBe('wildfire');
    expect(parseClusterParam('heat')).toBe('heat');
    expect(parseClusterParam('enso')).toBe('enso');
    // Drought has NO token: even spelled out it reads as the default
    // (absence is the truth) and is dropped on the next canonical write.
    expect(parseClusterParam('drought')).toBe('drought');
    expect(parseClusterParam(null)).toBe('drought');
    expect(parseClusterParam('')).toBe('drought');
    expect(parseClusterParam('smoke')).toBe('drought');
  });

  test('ocean= accepts the three OceanKey tokens; everything else is null', () => {
    for (const key of OCEAN_KEYS) {
      expect(parseOceanParam(key)).toBe(key);
    }
    expect(parseOceanParam(null)).toBeNull();
    expect(parseOceanParam('')).toBeNull();
    expect(parseOceanParam('indian')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Node: the precedence table
// ---------------------------------------------------------------------------

test.describe('S2 precedence table (Node)', () => {
  test('layers= outranks cluster=: the cluster parses to absence when both appear (D-0.7.0-044)', () => {
    const both = parseShellParams(new URLSearchParams('?layers=usdm&cluster=wildfire'));
    expect(both.cluster).toBe('drought');

    // Even an explicit-empty layers= is the more specific intent.
    const explicitEmpty = parseShellParams(new URLSearchParams('?layers=&cluster=heat'));
    expect(explicitEmpty.cluster).toBe('drought');

    // Alone, the cluster survives.
    const alone = parseShellParams(new URLSearchParams('?cluster=wildfire'));
    expect(alone.cluster).toBe('wildfire');
  });

  test('ocean= is valid only beside a SURVIVING cluster=enso (D-0.7.0-042/053)', () => {
    // The happy pair.
    const enso = parseShellParams(new URLSearchParams('?cluster=enso&ocean=pacific'));
    expect(enso.cluster).toBe('enso');
    expect(enso.ocean).toBe('pacific');

    // No cluster: the ocean is ignored.
    expect(parseShellParams(new URLSearchParams('?ocean=pacific')).ocean).toBeNull();

    // A hazard cluster: still ignored.
    expect(
      parseShellParams(new URLSearchParams('?cluster=wildfire&ocean=arctic')).ocean
    ).toBeNull();

    // The cluster was outranked by layers=, so the ocean falls with it.
    const outranked = parseShellParams(
      new URLSearchParams('?cluster=enso&ocean=pacific&layers=usdm')
    );
    expect(outranked.cluster).toBe('drought');
    expect(outranked.ocean).toBeNull();
  });

  test('framing= is independent of the display parameters', () => {
    const p = parseShellParams(
      new URLSearchParams('?framing=mexico&layers=usdm&cluster=wildfire')
    );
    expect(p.framing).toBe('mexico');
    expect(p.cluster).toBe('drought');
  });

  test('region=national is the ALL alias: it never produces a framing (D-0.7.0-039/041)', () => {
    // The legacy value stays on the region path (honored forever; the
    // browser half below pins its camera landing) and normalizes to the
    // ALL framing state simply by never producing a framing token.
    expect(parseShellParams(new URLSearchParams('?region=national')).framing).toBeNull();
    expect(parseFramingParam('national')).toBeNull();
  });

  test('view derivation: display links open the console; select= still outranks (D-0.7.0-017/041/044)', () => {
    // The new display parameters mean "the sharer meant the map",
    // exactly like layers= and region=.
    expect(deriveViewMode(new URLSearchParams('?cluster=wildfire'))).toBe('console');
    expect(deriveViewMode(new URLSearchParams('?cluster=enso&ocean=pacific'))).toBe('console');
    expect(deriveViewMode(new URLSearchParams('?framing=arid-west'))).toBe('console');
    // select= keeps outranking every display clause for view derivation.
    expect(deriveViewMode(new URLSearchParams('?select=state:WA&cluster=wildfire'))).toBe(
      'brief'
    );
    expect(deriveViewMode(new URLSearchParams('?select=state:WA&layers=states'))).toBe('brief');
    // An explicit view= still wins over everything.
    expect(deriveViewMode(new URLSearchParams('?view=brief&cluster=heat'))).toBe('brief');
    // A bare URL still opens Brief (with no unsolicited briefing behind
    // it since D-0.7.0-041; pinned in view-mode.spec.ts).
    expect(deriveViewMode(new URLSearchParams(''))).toBe('brief');
  });
});

// ---------------------------------------------------------------------------
// Node: the cluster boot composition
// ---------------------------------------------------------------------------

test.describe('S2 cluster boot composition (Node)', () => {
  test('drought composes back to exactly the default-on set (absence is the default display)', () => {
    expect([...composeClusterIntent('drought')].sort()).toEqual([...DEFAULT_ON].sort());
  });

  test('a hazard cluster is the untouched reference set plus its current recipe, one surface at most', () => {
    const reference = (DEFAULT_ON as readonly string[]).filter(
      (key) => !SURFACE_KEYS.has(key)
    );
    for (const cluster of HAZARD_CLUSTER_KEYS) {
      const composed = composeClusterIntent(cluster);
      // The default-on reference set is left alone (D-0.7.0-044).
      for (const key of reference) {
        expect(composed, `${cluster}: reference ${key} survives`).toContain(key);
      }
      // Every current-recipe member is applied.
      for (const key of HAZARD_CLUSTERS[cluster].recipes.current) {
        expect(composed, `${cluster}: recipe ${key} applied`).toContain(key);
      }
      // The one-surface invariant (UX-1) holds by construction.
      const surfaces = composed.filter((key) => SURFACE_KEYS.has(key));
      expect(surfaces.length, `${cluster}: at most one surface`).toBeLessThanOrEqual(1);
      // No duplicates.
      expect(new Set(composed).size).toBe(composed.length);
    }
    // The drought default surface never rides a hazard cluster.
    expect(composeClusterIntent('wildfire')).not.toContain('usdm');
    expect(composeClusterIntent('enso')).toContain('sst-anomaly');
  });
});

// ---------------------------------------------------------------------------
// Browser: cluster boots, the durable-truth claim, and its handoff
// ---------------------------------------------------------------------------

/**
 * Stub the two wildfire-recipe agency endpoints with empty
 * FeatureCollections: an empty result is a genuine terminal on state
 * (`no-data`), so the boot is deterministic and the cluster claim
 * cannot be dropped by a live-agency outage mid-spec (smoke-suite
 * doctrine: never couple to live values).
 */
async function stubWildfireRecipe(page: import('@playwright/test').Page): Promise<void> {
  const empty = JSON.stringify({ type: 'FeatureCollection', features: [] });
  await page.route('**/WFIGS_Interagency_Perimeters_Current/**', (route) =>
    route.fulfill({ contentType: 'application/geo+json', body: empty })
  );
  await page.route('**/NOAA_Satellite_Smoke_Detection*/**', (route) =>
    route.fulfill({ contentType: 'application/geo+json', body: empty })
  );
}

test.describe('S2 cluster= in the browser', () => {
  test('a cluster=wildfire boot applies the current recipe over the untouched reference set', async ({
    page
  }) => {
    await stubWildfireRecipe(page);
    await gotoApp(page, '?cluster=wildfire');

    // A display link opens the console (the sharer meant the map).
    await expect(page.locator('#app')).toHaveClass(/\bview-console\b/);

    // The current-horizon recipe: perimeters plus smoke ONLY
    // (D-0.7.0-043 part 1), through the ordinary activation path.
    await expect(layerCheckbox(page, 'nifc-fires')).toBeChecked();
    await expect(layerCheckbox(page, 'hms-smoke')).toBeChecked();
    // The drought default surface does not ride along...
    await expect(layerCheckbox(page, 'usdm')).not.toBeChecked();
    // ...and the default-on reference set is left alone.
    await expect(layerCheckbox(page, 'aiannh')).toBeChecked();
    await expect(layerCheckbox(page, 'bia-reservations')).toBeChecked();
    await expect(layerCheckbox(page, 'states')).toBeChecked();

    // The durable-truth claim (D-0.7.0-044): the URL carries ONLY the
    // one-word token; no granular layers= while the display is clean.
    await waitForLayerSettled(page, 'nifc-fires');
    const params = new URLSearchParams(await search(page));
    expect(params.get('cluster')).toBe('wildfire');
    expect(params.get('layers')).toBeNull();
  });

  test('customizing a layer drops cluster= for the granular layers= (D-0.7.0-044)', async ({
    page
  }) => {
    await stubWildfireRecipe(page);
    await gotoApp(page, '?cluster=wildfire');
    await waitForLayerSettled(page, 'nifc-fires');
    await expect
      .poll(async () => new URLSearchParams(await search(page)).get('cluster'))
      .toBe('wildfire');

    // The moment the user customizes (any divergence from the cluster's
    // composition), the claim comes off and the honest list goes on.
    await layerCheckbox(page, 'places').check();
    await expect
      .poll(async () => new URLSearchParams(await search(page)).get('cluster'))
      .toBeNull();
    await expect.poll(async () => (await urlLayers(page)).has('places')).toBe(true);
    await expect.poll(async () => (await urlLayers(page)).has('nifc-fires')).toBe(true);
  });

  test('layers= outranks cluster= at boot: layers wins, cluster is dropped on sync', async ({
    page
  }) => {
    await gotoApp(page, '?layers=usdm&cluster=wildfire');

    await expect(layerCheckbox(page, 'usdm')).toBeChecked();
    await expect(layerCheckbox(page, 'nifc-fires')).not.toBeChecked();
    await expect(layerCheckbox(page, 'hms-smoke')).not.toBeChecked();

    await waitForLayerSettled(page, 'usdm');
    await expect
      .poll(async () => new URLSearchParams(await search(page)).get('cluster'), {
        timeout: 25_000
      })
      .toBeNull();
    await expect
      .poll(async () => (await urlLayers(page)).has('usdm'), { timeout: 25_000 })
      .toBe(true);
  });

  test('an unknown cluster token reads as absence and is dropped (policy rule 2)', async ({
    page
  }) => {
    await gotoApp(page, '?cluster=volcano');

    // Absence means the default display: the default-on set activates.
    for (const key of DEFAULT_ON) {
      await expect(layerCheckbox(page, key)).toBeChecked();
    }
    await waitForLayerSettled(page, 'states');
    await expect
      .poll(async () => new URLSearchParams(await search(page)).get('cluster'), {
        timeout: 25_000
      })
      .toBeNull();
  });
});

test.describe('S2 ocean= in the browser', () => {
  test('an ocean boot applies the ENSO cluster and keeps the pair in the URL (D-0.7.0-042/053)', async ({
    page
  }) => {
    await gotoApp(page, '?cluster=enso&ocean=pacific');

    await expect(page.locator('#app')).toHaveClass(/\bview-console\b/);
    // The ENSO display: the shipped SST anomaly surface, reference set
    // untouched, drought surface off.
    await expect(layerCheckbox(page, 'sst-anomaly')).toBeChecked();
    await expect(layerCheckbox(page, 'usdm')).not.toBeChecked();
    await expect(layerCheckbox(page, 'states')).toBeChecked();

    await waitForLayerSettled(page, 'states');
    const params = new URLSearchParams(await search(page));
    expect(params.get('cluster')).toBe('enso');
    expect(params.get('ocean')).toBe('pacific');
    expect(params.get('layers')).toBeNull();
  });

  test('ocean= without cluster=enso is ignored and dropped on sync', async ({ page }) => {
    await gotoApp(page, '?ocean=pacific');

    // The default display boots (the ocean alone claims nothing).
    for (const key of DEFAULT_ON) {
      await expect(layerCheckbox(page, key)).toBeChecked();
    }
    await waitForLayerSettled(page, 'states');
    await expect
      .poll(async () => new URLSearchParams(await search(page)).get('ocean'), {
        timeout: 25_000
      })
      .toBeNull();
  });
});

test.describe('S2 framing= and the legacy links in the browser', () => {
  test('a framing boot round-trips framing= and claims one camera (region= is dropped)', async ({
    page
  }) => {
    await gotoApp(page, '?framing=arid-west');

    await expect(page.locator('#app')).toHaveClass(/\bview-console\b/);
    // Camera-only: no briefing opened, no cluster claimed, and the
    // default display activated untouched.
    await expect(page.locator('#impact-panel')).toHaveCount(0);
    for (const key of DEFAULT_ON) {
      await expect(layerCheckbox(page, key)).toBeChecked();
    }

    await waitForLayerSettled(page, 'states');
    const params = new URLSearchParams(await search(page));
    expect(params.get('framing')).toBe('arid-west');
    // One camera vocabulary at a time: framing= replaces region=.
    expect(params.get('region')).toBeNull();
  });

  test('an unknown framing token returns camera custody to the legacy region and is dropped', async ({ page }) => {
    await gotoApp(page, '?framing=atlantis');

    await waitForLayerSettled(page, 'states');
    const params = new URLSearchParams(await search(page));
    expect(params.get('framing')).toBeNull();
    // With no framing active, the legacy region emission is unchanged.
    expect(params.get('region')).toBe('washington_state');
  });

  test('a region click clears the minimap framing (one camera vocabulary)', async ({
    page
  }) => {
    await gotoApp(page, '?framing=pacific-coast');
    await expect
      .poll(async () => new URLSearchParams(await search(page)).get('framing'))
      .toBe('pacific-coast');

    // An explicit legacy region choice is a camera gesture: the framing
    // context resets and region= returns to the URL.
    await selectRegion(page, 'central_oregon');
    await expect
      .poll(async () => new URLSearchParams(await search(page)).get('framing'))
      .toBeNull();
    await expect
      .poll(async () => new URLSearchParams(await search(page)).get('region'))
      .toBe('central_oregon');
  });

  test('legacy region= links keep working byte for byte, national included (D-0.7.0-039)', async ({
    page
  }) => {
    // An ordinary curated region: honored exactly as today.
    await gotoApp(page, '?region=central_oregon&layers=usdm');
    await expect(regionSelect(page)).toHaveValue('region:central_oregon');
    await expect(layerCheckbox(page, 'usdm')).toBeChecked();

    // The national alias: still a valid region (the camera fit rides
    // REGIONS.national as always), still re-emitted as region=national,
    // and it produces NO framing token. NOTE the deliberate staging
    // (Codex S2 finding 1, reconciled): D-0.7.0-041's full
    // normalization to absence waits on the bare-URL default camera,
    // because dropping the parameter while a bare URL still boots the
    // Washington fit would re-camera this legacy link to that retired
    // default. That precondition still holds today: DEFAULT_REGION in
    // src/config/regions.ts is 'washington_state' and neither syncUrl
    // nor pushUrl normalizes region=national to absence. This assertion
    // flips to expect region absent only when the bare-URL camera stops
    // defaulting to Washington and the serializer drops the token.
    await gotoApp(page, '?region=national');
    await expect(regionSelect(page)).toHaveValue('region:national');
    await waitForLayerSettled(page, 'states');
    const params = new URLSearchParams(await search(page));
    expect(params.get('region')).toBe('national');
    expect(params.get('framing')).toBeNull();
  });

  test('select= still outranks the display parameters for the view door (D-0.7.0-017)', async ({
    page
  }) => {
    await stubWildfireRecipe(page);
    await gotoApp(page, '?select=state:WA&cluster=wildfire');

    // The sharer meant the briefing: Brief opens with the deep-linked
    // panel, while the cluster display still applies underneath.
    await expect(page.locator('#app')).toHaveClass(/\bview-brief\b/);
    await expect(page.locator('#impact-panel')).toBeVisible({ timeout: 15_000 });
    await expect(layerCheckbox(page, 'nifc-fires')).toBeChecked();
    await expect
      .poll(async () => new URLSearchParams(await search(page)).get('cluster'), {
        timeout: 25_000
      })
      .toBe('wildfire');
    // The one-shot select= is never re-emitted (policy rule 8).
    await expect
      .poll(async () => (await search(page)).includes('select='), { timeout: 25_000 })
      .toBe(false);
  });
});
