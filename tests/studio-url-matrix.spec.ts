import { expect, test, type Page } from './offline-test';

import { FRAMINGS, type FramingKey } from '../src/config/framings';
import { HAZARD_CLUSTERS, HAZARD_CLUSTER_KEYS } from '../src/config/clusters';
import { TRIBAL_NATIONS_GROUP } from '../src/config/layer-groups';
import { parseShellParams, parseStudioParam } from '../src/state/url';
import { gotoApp, search, stubHeatRiskCatalog, urlLayers, waitForLayerSettled } from './helpers';
import { stubRecentSatellite } from './satellite-fixture';
import { AIANNH_ROUTE, BIA_ROUTE, emptyCollectionBody, routeGeojson } from './tribal-fixtures';

const FRAMING = Object.keys(FRAMINGS)[0] as FramingKey;
const TERMINAL_CLASSES = ['ready', 'degraded', 'error', 'no-data', 'zoom-in'] as const;

interface MatrixCase {
  readonly name: string;
  readonly studio: 'layers' | 'place';
  readonly query: string;
  readonly settleKey: string;
  readonly expected: Readonly<Record<string, string | null>>;
}

const MATRIX: readonly MatrixCase[] = [
  {
    name: 'PLACE composes with Console view',
    studio: 'place',
    query: '?layers=places&view=console&studio=place',
    settleKey: 'places',
    expected: { studio: 'place', view: 'console' }
  },
  {
    name: 'LAYERS composes with framing',
    studio: 'layers',
    query: `?framing=${encodeURIComponent(FRAMING)}&layers=places&view=brief&studio=layers`,
    settleKey: 'places',
    expected: { studio: 'layers', view: 'brief', framing: FRAMING }
  },
  {
    name: 'LAYERS composes with a surviving Wildfire cluster',
    studio: 'layers',
    query: '?cluster=wildfire&view=brief&studio=layers',
    settleKey: 'nifc-fires',
    expected: { studio: 'layers', cluster: 'wildfire', layers: null }
  },
  {
    name: 'LAYERS composes with ENSO and ocean',
    studio: 'layers',
    query: '?cluster=enso&ocean=pacific&view=brief&studio=layers',
    settleKey: 'sst-anomaly',
    expected: { studio: 'layers', cluster: 'enso', ocean: 'pacific', layers: null }
  },
  {
    name: 'granular layers outrank a cluster without suppressing LAYERS',
    studio: 'layers',
    query: '?layers=places&cluster=wildfire&view=brief&studio=layers',
    settleKey: 'places',
    expected: { studio: 'layers', layers: 'places', cluster: null }
  },
  {
    name: 'LAYERS composes with temporal and basemap tokens',
    studio: 'layers',
    query:
      '?layers=places&view=brief&week=20240702&dmode=chg1&sst=2024-07-01' +
      '&outlook=monthly&basemap=satellite&studio=layers',
    settleKey: 'places',
    expected: {
      studio: 'layers',
      week: '20240702',
      dmode: 'chg1',
      sst: '2024-07-01',
      outlook: 'monthly',
      basemap: null
    }
  },
  {
    // precedence row J2's sidebar clause (D1 M7, DR-139): the studio composes
    // with sidebar=closed, and the popstate rewrite from live state
    // (src/ui/sidebar.ts syncStudioRoute) re-emits it on Back.
    name: 'LAYERS composes with sidebar=closed',
    studio: 'layers',
    query: '?layers=places&view=brief&sidebar=closed&studio=layers',
    settleKey: 'places',
    expected: { studio: 'layers', view: 'brief', sidebar: 'closed' }
  }
];

async function stubMatrixDependencies(page: Page): Promise<void> {
  await routeGeojson(page, AIANNH_ROUTE, emptyCollectionBody());
  await routeGeojson(page, BIA_ROUTE, emptyCollectionBody());
  await page.route('**/data/us-places.json', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ places: [{ name: 'Fixture City', lon: -120, lat: 44 }] })
    })
  );
  await page.route('**/data/us-states.geojson', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: JSON.stringify({ type: 'FeatureCollection', features: [] })
    })
  );
  for (const pattern of [
    '**/WFIGS_Interagency_Perimeters_Current/**',
    '**/NOAA_Satellite_Smoke_Detection*/**',
    '**/SPC*Fire*Weather*/**'
  ]) {
    await page.route(pattern, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/geo+json',
        body: JSON.stringify(emptyCollectionBody())
      })
    );
  }
  await stubRecentSatellite(page);
  await page.route('**/gibs.earthdata.nasa.gov/**', (route) =>
    route.fulfill({ status: 503, contentType: 'text/plain', body: 'Synthetic offline response' })
  );
}

async function waitForScopedLayerSettled(
  page: Page,
  studio: MatrixCase['studio'],
  key: string
): Promise<void> {
  if (studio === 'place') {
    await waitForLayerSettled(page, key);
    return;
  }
  const pill = page.locator(`#layers-studio-root [data-layer-status="${key}"]`);
  await expect.poll(async () => {
    const classes = ((await pill.getAttribute('class')) ?? '').split(/\s+/);
    return TERMINAL_CLASSES.some((terminal) => classes.includes(terminal));
  }).toBe(true);
}

function expectParams(url: URL, expected: Readonly<Record<string, string | null>>): void {
  for (const [key, value] of Object.entries(expected)) {
    if (value === null) expect(url.searchParams.has(key), `${key} should be absent`).toBe(false);
    else expect(url.searchParams.get(key), `${key} should survive`).toBe(value);
  }
}

test.describe('studio URL precedence matrix', () => {
  test('pure parsing keeps studio additive and shell precedence unchanged', () => {
    expect(parseStudioParam('layers')).toBe('layers');
    expect(parseStudioParam('place')).toBe('place');
    expect(parseStudioParam('invalid')).toBeNull();

    const granular = parseShellParams(
      new URLSearchParams(`framing=${encodeURIComponent(FRAMING)}&layers=places&cluster=enso&ocean=pacific`)
    );
    expect(granular.framing).toBe(FRAMING);
    expect(granular.cluster).toBe('drought');
    expect(granular.ocean).toBeNull();

    const enso = parseShellParams(new URLSearchParams('cluster=enso&ocean=pacific'));
    expect(enso.cluster).toBe('enso');
    expect(enso.ocean).toBe('pacific');
  });

  for (const scenario of MATRIX) {
    test(`${scenario.name}: canonical write, reload, and Back`, async ({ page }) => {
      await stubMatrixDependencies(page);
      await gotoApp(page, scenario.query);
      const root = page.locator(`#${scenario.studio}-studio-root`);
      await expect(root).toBeVisible();
      await waitForScopedLayerSettled(page, scenario.studio, scenario.settleKey);

      const canonicalStudioUrl = new URL(page.url());
      expectParams(canonicalStudioUrl, scenario.expected);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(root).toBeVisible();
      await waitForScopedLayerSettled(page, scenario.studio, scenario.settleKey);
      expect(page.url()).toBe(canonicalStudioUrl.href);

      const mapUrl = new URL(canonicalStudioUrl);
      mapUrl.searchParams.delete('studio');
      await root.getByRole('button', { name: 'Back to map' }).click();
      await expect(root).toHaveCount(0);
      await expect.poll(() => page.url()).toBe(mapUrl.href);
    });
  }

  for (const malformed of [
    {
      name: 'duplicate studio parameters',
      query: '?layers=places&view=brief&studio=layers&studio=place'
    },
    {
      name: 'an invalid studio parameter',
      query: '?layers=places&view=brief&studio=invalid'
    }
  ] as const) {
    test(`${malformed.name} canonicalizes to the map route`, async ({ page }) => {
      await stubMatrixDependencies(page);
      await gotoApp(page, malformed.query);
      await waitForLayerSettled(page, 'places');
      await expect(page.locator('#layers-studio-root')).toHaveCount(0);
      await expect(page.locator('#place-studio-root')).toHaveCount(0);
      const canonical = new URL(page.url());
      expect(canonical.searchParams.has('studio')).toBe(false);

      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForLayerSettled(page, 'places');
      expect(page.url()).toBe(canonical.href);
    });
  }

  test('embed plus studio preserves the link-out token without mounting', async ({ page }) => {
    await stubMatrixDependencies(page);
    await gotoApp(page, '?embed=true&layers=places&view=brief&studio=place');
    await expect(page.locator('#place-studio-root')).toHaveCount(0);
    await expect(page.locator('#layers-studio-root')).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get('studio')).toBe('place');

    const link = page
      .locator('#studio-linkout-pair')
      .getByRole('link', { name: 'Open place selection on the full site' });
    const href = new URL((await link.getAttribute('href')) ?? '');
    expect(href.searchParams.get('studio')).toBe('place');
    expect(href.searchParams.has('embed')).toBe(false);

    const canonical = page.url();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#place-studio-root')).toHaveCount(0);
    expect(page.url()).toBe(canonical);
  });

  // D1 M7 (DR-139; the Codex Tier 2 disposition, record S4+S6): sidebar=
  // survives Back and Forward across the app's own studio entries, and the
  // popstate policy that rewrites the popped entry from LIVE state is kept,
  // so a historical token never overwrites a choice made after Back.
  const sidebarTokens = (page: Page): string[] =>
    new URL(page.url()).searchParams.getAll('sidebar');

  test('both studios retain sidebar through direct boot, reload, Back and Forward', async ({
    page
  }) => {
    await stubMatrixDependencies(page);
    await page.setViewportSize({ width: 1280, height: 720 });
    const app = page.locator('#app');
    for (const studio of ['layers', 'place'] as const) {
      const root = page.locator(`#${studio}-studio-root`);
      await gotoApp(page, `?layers=places&view=brief&sidebar=closed&studio=${studio}`);
      await expect(root, `${studio}: direct boot`).toBeVisible();
      await waitForScopedLayerSettled(page, studio, 'places');
      expect(sidebarTokens(page), `${studio}: direct boot`).toEqual(['closed']);
      await expect(app, `${studio}: direct boot`).toHaveClass(/\bsidebar-collapsed\b/);

      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(root, `${studio}: reload`).toBeVisible();
      await waitForScopedLayerSettled(page, studio, 'places');
      expect(sidebarTokens(page), `${studio}: reload`).toEqual(['closed']);

      await page.goBack();
      await expect(root, `${studio}: Back`).toHaveCount(0);
      await expect
        .poll(() => new URL(page.url()).searchParams.has('studio'), { message: `${studio}: Back` })
        .toBe(false);
      expect(sidebarTokens(page), `${studio}: Back`).toEqual(['closed']);
      await expect(app, `${studio}: Back`).toHaveClass(/\bsidebar-collapsed\b/);

      await page.goForward();
      await expect(root, `${studio}: Forward`).toBeVisible();
      await expect
        .poll(() => new URL(page.url()).searchParams.get('studio'), { message: `${studio}: Forward` })
        .toBe(studio);
      expect(sidebarTokens(page), `${studio}: Forward`).toEqual(['closed']);
    }
  });

  test('Forward cannot overwrite a choice made after Back', async ({ page }) => {
    await stubMatrixDependencies(page);
    await page.setViewportSize({ width: 1280, height: 720 });
    const app = page.locator('#app');
    const root = page.locator('#layers-studio-root');
    await gotoApp(page, '?layers=places&view=brief&studio=layers');
    await expect(root).toBeVisible();
    expect(sidebarTokens(page)).toEqual([]);

    // Back to the synthesized map entry, then close the sidebar there.
    await page.goBack();
    await expect(root).toHaveCount(0);
    await page.locator('#sidebar-collapse').click();
    await expect(app).toHaveClass(/\bsidebar-collapsed\b/);
    await expect.poll(() => sidebarTokens(page)).toEqual(['closed']);

    // Forward lands on a studio entry recorded without the key; the live
    // choice wins and the entry is rewritten to carry it.
    await page.goForward();
    await expect(root).toBeVisible();
    await expect.poll(() => sidebarTokens(page)).toEqual(['closed']);
    await expect(app).toHaveClass(/\bsidebar-collapsed\b/);

    // The inverse: reopen after Back, and Forward onto the entry that now
    // carries sidebar=closed must not re-close it.
    await page.goBack();
    await expect(root).toHaveCount(0);
    await page.locator('#sidebar-expand').click();
    await expect(app).not.toHaveClass(/\bsidebar-collapsed\b/);
    await expect.poll(() => sidebarTokens(page)).toEqual([]);
    await page.goForward();
    await expect(root).toBeVisible();
    await expect
      .poll(() => new URL(page.url()).searchParams.get('studio'))
      .toBe('layers');
    await expect.poll(() => sidebarTokens(page)).toEqual([]);
    await expect(app).not.toHaveClass(/\bsidebar-collapsed\b/);
  });

  // The Codex M7 review, F3 (review:97): switching studios replaces the ONE
  // marked studio entry (src/state/studio-route.ts enterStudio) and keeps
  // sidebar=closed; the canonical writer keeps the ddmStudioEntry marker
  // (src/state/url.ts syncUrl preserves history.state), so a reload inside
  // the studio never synthesizes a second predecessor. A marker lost before
  // a reload adds an entry, which the count below catches.
  test('switching studios in both directions keeps sidebar=closed on one marked entry through canonical writes and reloads', async ({
    page
  }) => {
    test.setTimeout(120_000);
    await stubMatrixDependencies(page);
    await page.setViewportSize({ width: 1280, height: 720 });
    const app = page.locator('#app');
    const historyLength = (): Promise<number> => page.evaluate(() => window.history.length);
    const studioMarker = (): Promise<boolean> =>
      page.evaluate(
        () =>
          (window.history.state as { ddmStudioEntry?: boolean } | null)?.ddmStudioEntry === true
      );
    const studios = ['layers', 'place'] as const;
    type Studio = (typeof studios)[number];

    await gotoApp(page, '?layers=places&view=brief&sidebar=closed');
    await waitForLayerSettled(page, 'places');
    await expect(app).toHaveClass(/\bsidebar-collapsed\b/);
    expect(sidebarTokens(page), 'the map').toEqual(['closed']);
    expect(await studioMarker(), 'the map entry is unmarked').toBe(false);
    const lengthAtMap = await historyLength();

    // The entry doors sit in the collapsed column, so they are invoked
    // through their own click handlers (as "closing the sidebar round-trips
    // through the URL, a reload and a studio Back" does).
    const enter = async (studio: Studio): Promise<void> => {
      await expect(page.locator(`#${studio}-studio-entry`)).toHaveCount(1);
      await page.evaluate((id: string) => {
        const door = document.getElementById(id);
        if (!(door instanceof HTMLElement)) throw new Error(`no #${id}`);
        door.click();
      }, `${studio}-studio-entry`);
    };
    const expectStudioEntry = async (studio: Studio, moment: string): Promise<void> => {
      const other = studios.find((candidate) => candidate !== studio)!;
      await expect(page.locator('html'), moment).toHaveAttribute('data-ddm-controls', 'ready');
      await expect(page.locator(`#${studio}-studio-root`), moment).toBeVisible();
      await expect(page.locator(`#${other}-studio-root`), moment).toHaveCount(0);
      await expect
        .poll(() => new URL(page.url()).searchParams.getAll('studio'), { message: moment })
        .toEqual([studio]);
      await waitForScopedLayerSettled(page, studio, 'places');
      expect(sidebarTokens(page), `${moment}: sidebar=`).toEqual(['closed']);
      await expect(app, moment).toHaveClass(/\bsidebar-collapsed\b/);
      expect(await studioMarker(), `${moment}: the ddmStudioEntry marker`).toBe(true);
      expect(await historyLength(), `${moment}: one studio entry above the map`).toBe(
        lengthAtMap + 1
      );
    };
    // 2026-09-27, the executed gate d1-m7 CMD62: the first draft toggled the
    // sidebar catalog's #layer-toggle-places inside the Place studio and
    // expected an empty layers=. Both were wrong. The Place studio holds its
    // own clean display (src/state/display-snapshot.ts cleanIntent, the
    // tribe rail adds aiannh and bia-reservations beside places), and its
    // onCheckedChange enforcement puts a set-aside toggle straight back, so
    // that toggle never changes layers=. Every canonical write below now
    // comes from a control the open studio itself offers, and every
    // expected layers= value is derived from the URL read just before it
    // (compared as a sorted key list; syncUrl joins the intent set in
    // insertion order, src/state/url.ts syncUrl).
    const layerList = (value: string | null): string[] | null =>
      value === null
        ? null
        : value
            .split(',')
            .filter((key) => key.length > 0)
            .sort();
    const urlLayers = (): string[] | null =>
      layerList(new URL(page.url()).searchParams.get('layers'));
    const checkedKeys = (selector: string): Promise<string[]> =>
      page
        .locator(selector)
        .evaluateAll((inputs) =>
          inputs.map((input) => input.getAttribute('data-layer-key') ?? '').sort()
        );
    /** The layers= list once the URL agrees with the checked catalog rows
     * (the bridge intent syncUrl serializes, src/ui/sidebar.ts pushUrl). */
    const settledLayers = async (
      selector: string,
      moment: string,
      requiredKeys: readonly string[] = []
    ): Promise<string[]> => {
      let settled: string[] = [];
      await expect
        .poll(
          async () => {
            settled = await checkedKeys(selector);
            return requiredKeys.every((key) => settled.includes(key)) &&
              JSON.stringify(urlLayers()) === JSON.stringify(settled);
          },
          { message: `${moment}: layers= matches the checked rows` }
        )
        .toBe(true);
      return settled;
    };
    /** Layers studio: two canonical writes through the studio's own row for
     * places (src/ui/island/catalog.tsx LayerRow onChange, then the registry
     * change drives pushUrl and syncUrl's replaceState), the key removed
     * and then restored relative to the URL read just before. */
    const layersRowWrites = async (moment: string): Promise<void> => {
      const before = await settledLayers(
        '#layers-studio-root input[id^="studio-layer-toggle-"]:checked',
        moment
      );
      expect(before, `${moment}: places is on before the writes`).toContain('places');
      const row = page.locator('#layers-studio-root input[data-layer-key="places"]');
      await row.uncheck();
      await expect
        .poll(urlLayers, { message: `${moment}: places removed from layers=` })
        .toEqual(before.filter((key) => key !== 'places'));
      await row.check();
      await expect
        .poll(urlLayers, { message: `${moment}: places restored to layers=` })
        .toEqual(before);
    };
    /** Place studio: two canonical writes through the studio's own type rail
     * (src/ui/island/place-studio.tsx #place-type-*, setKind, then
     * setPlaceStudioDisplayKind swaps the rail's reference layers through
     * syncIntent, and the registry change drives pushUrl). The first write
     * must move layers= off the list read just before it; the second must
     * return it to that list. The rail's reference keys are the runtime's,
     * never typed here. */
    const placeRailWrites = async (moment: string): Promise<void> => {
      const sidebarRows = 'input[id^="layer-toggle-"]:checked';
      const tribe = page.locator('#place-type-tribe');
      const state = page.locator('#place-type-state');
      await expect(tribe, `${moment}: the tribe rail is pressed`).toHaveAttribute(
        'aria-pressed',
        'true'
      );
      // The pressed rail renders before its effects install the reference
      // intent. URL and checked rows can still agree on the old display.
      // Capture only after the tribe rail's shipped members reach both.
      const before = await settledLayers(
        sidebarRows,
        `${moment}: before`,
        TRIBAL_NATIONS_GROUP.members
      );
      expect(before, `${moment}: places is on before the writes`).toContain('places');
      await state.click();
      await expect(state, `${moment}: the state rail is pressed`).toHaveAttribute(
        'aria-pressed',
        'true'
      );
      await expect
        .poll(
          async () => {
            const url = JSON.stringify(urlLayers());
            return url === JSON.stringify(await checkedKeys(sidebarRows)) &&
              url !== JSON.stringify(before);
          },
          { message: `${moment}: the state rail rewrote layers=` }
        )
        .toBe(true);
      await tribe.click();
      await expect(tribe, `${moment}: the tribe rail is pressed again`).toHaveAttribute(
        'aria-pressed',
        'true'
      );
      await expect
        .poll(urlLayers, { message: `${moment}: the tribe rail restored layers=` })
        .toEqual(before);
    };

    await enter('layers');
    await expectStudioEntry('layers', 'map to Layers');

    await enter('place');
    await expectStudioEntry('place', 'Layers to Place');
    await placeRailWrites('in Place');
    await expectStudioEntry('place', 'Place after canonical writes');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expectStudioEntry('place', 'Place after a reload');

    await enter('layers');
    await expectStudioEntry('layers', 'Place to Layers');
    await layersRowWrites('in Layers');
    await expectStudioEntry('layers', 'Layers after canonical writes');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expectStudioEntry('layers', 'Layers after a reload');

    // One Back leaves the studio for the map entry the first door pushed
    // above, still closed; the count is unchanged by the traversal. The map
    // entry belonged to the document before the reloads, so this Back loads
    // it afresh from its recorded URL.
    await page.goBack();
    await expect(page.locator('html'), 'Back').toHaveAttribute('data-ddm-controls', 'ready');
    for (const studio of studios) {
      await expect(page.locator(`#${studio}-studio-root`), `Back: ${studio}`).toHaveCount(0);
    }
    await expect
      .poll(() => new URL(page.url()).searchParams.has('studio'), { message: 'Back' })
      .toBe(false);
    expect(sidebarTokens(page), 'Back').toEqual(['closed']);
    await expect(app, 'Back').toHaveClass(/\bsidebar-collapsed\b/);
    expect(await studioMarker(), 'Back: the map entry is unmarked').toBe(false);
    expect(await historyLength(), 'Back').toBe(lengthAtMap + 1);
  });

  // found-011 (register; CODEMAP:1749; D1 M16): the Place studio's clean
  // display sets the committed hazard surface aside (a recipe member is a
  // surface or event role), and restoring the exact captured intent
  // afterward re-checks it, but the outer commitment (src/state/cluster-
  // service.ts) had already demoted to 'custom' the moment the studio set
  // it aside, and the raw store write display-snapshot.ts used to restore
  // it was a silent no-op whenever the captured cluster equalled the
  // store's value the whole time (Drought, the store's ever-present
  // default: the store itself never actually left 'drought', even though
  // the service's own committed claim had). Wildfire and ENSO restored
  // correctly before the fix because their token differs from the store's
  // default, so the raw write DID change the store's value and notify.
  // Every HAZARD_CLUSTER_KEYS mode is exercised here (DR-113), Drought
  // included, so the fix is proven where the raw write alone could not
  // reach it.
  test('opening and closing the Place studio keeps the committed hazard pressed and its surface in layers= in every HAZARD_CLUSTER_KEYS mode', async ({
    page
  }) => {
    test.setTimeout(30_000 + HAZARD_CLUSTER_KEYS.length * 30_000);
    await stubMatrixDependencies(page);
    await stubHeatRiskCatalog(page);

    for (const cluster of HAZARD_CLUSTER_KEYS) {
      await test.step(cluster, async () => {
        const token = HAZARD_CLUSTERS[cluster].urlToken;
        const query = token === null ? '?view=brief' : `?view=brief&cluster=${token}`;
        await gotoApp(page, query);
        const settleKey = HAZARD_CLUSTERS[cluster].recipes.current[0];
        if (settleKey) await waitForLayerSettled(page, settleKey);
        const button = page.locator(`.shell-cluster-btn[data-cluster="${cluster}"]`);
        await expect(button, `${cluster}: pressed before the studio`).toHaveAttribute(
          'aria-pressed',
          'true'
        );
        const before = await urlLayers(page);

        await page.locator('#studio-entry-pair #place-studio-entry').click();
        const studio = page.locator('#place-studio-root');
        await expect(studio, `${cluster}: studio opens`).toBeVisible();
        await studio.getByRole('button', { name: 'Back to map' }).click();
        await expect(studio, `${cluster}: studio closes`).toHaveCount(0);
        if (settleKey) await waitForLayerSettled(page, settleKey);

        await expect(button, `${cluster}: pressed after Back`).toHaveAttribute(
          'aria-pressed',
          'true',
          { timeout: 10_000 }
        );
        const params = new URLSearchParams(await search(page));
        if (token !== null) {
          expect(params.get('cluster'), `${cluster}: cluster= after Back`).toBe(token);
        } else {
          expect(params.has('cluster'), `${cluster}: cluster= absent after Back`).toBe(false);
          expect(await urlLayers(page), `${cluster}: layers= after Back`).toEqual(before);
        }
      });
    }
  });
});
