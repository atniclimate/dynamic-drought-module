import { expect, test, type Page } from '@playwright/test';

import { REGIONS } from '../src/config/regions';
import {
  NIFC_AREA_QUERY_RECORD_CAP,
  NIFC_GEOMETRY_PRECISION,
  NIFC_MAX_ALLOWABLE_OFFSET_DEG,
  NIFC_OUT_FIELDS,
  buildNifcAreaPerimeterClaim
} from '../src/config/wildfire-presentation';
import { buildMinimapWildfireQueryBody } from '../src/state/minimap-wildfire';
import { leafletBoundsToMapLibre } from '../src/util/bbox';
import { gotoApp, layerPill, waitForLayerSettled } from './helpers';
import { NIFC_STUB, PNW_POLYGON, stubWildfireFeeds } from './wildfire-fixtures';

/**
 * FE-16 (2026-08-28): the NIFC WFIGS perimeters query must stay inside the
 * layer's 15 s budget. The shipped query (`outFields=*`, full-precision
 * geometry) measured 42.75 MB in 41.6 s for 243 perimeters, so the Fire
 * view's primary evidence read `unavailable` on every boot. This spec pins
 * the query shape that measured 1.83 MB in 4.5 s: a schema-exact field list
 * and server-side display generalization. It also pins the qualification
 * that makes the generalized edge an honest representation: the legend and
 * the map key both say the outline is generalized and by how much.
 */
test.describe('NIFC WFIGS query scope', () => {
  test('the perimeters query names its fields and asks the service to generalize', async ({
    page
  }) => {
    const queries: string[] = [];
    await stubWildfireFeeds(page);
    // The minimap's per-region wildfire counts hit the same service with
    // returnCountOnly; only the layer's GeoJSON query is under test here.
    await page.route(
      (url) =>
        url.href.includes('WFIGS_Interagency_Perimeters_Current') &&
        url.pathname.endsWith('/query') &&
        url.searchParams.get('f') === 'geojson',
      async (route) => {
        queries.push(route.request().url());
        await route.fallback();
      }
    );

    await gotoApp(page, '?cluster=wildfire&view=console');
    await waitForLayerSettled(page, 'nifc-fires');

    expect(queries.length, 'exactly one perimeters query per activation').toBe(1);
    const params = new URL(queries[0]!).searchParams;
    expect(params.get('where')).toBe('1=1');
    expect(params.get('f')).toBe('geojson');
    expect(params.get('outSR')).toBe('4326');
    expect(params.get('outFields')).toBe(NIFC_OUT_FIELDS.join(','));
    expect(params.get('outFields')).not.toContain('*');
    expect(params.get('geometryPrecision')).toBe(String(NIFC_GEOMETRY_PRECISION));
    expect(params.get('maxAllowableOffset')).toBe(String(NIFC_MAX_ALLOWABLE_OFFSET_DEG));
    // The runtime reads no attribute the query does not request, except the
    // legacy IncidentName fallbacks that older responses and fixtures carry.
    for (const field of [
      'attr_IncidentName',
      'attr_IncidentTypeCategory',
      'attr_UniqueFireIdentifier',
      'attr_IrwinID',
      'attr_IncidentSize',
      'attr_FireDiscoveryDateTime',
      'attr_POOState',
      // DDM-P1-T06: DDM-P14-T07's client-side predicate field, added once so
      // this pinned list changes only here.
      'attr_ActiveFireCandidate'
    ]) {
      expect(params.get('outFields')).toContain(field);
    }
    expect(params.get('outFields')).not.toContain('attr_DailyAcres');
  });

  test('the legend and the map key state the generalization', async ({ page }) => {
    await stubWildfireFeeds(page);
    await gotoApp(page, '?cluster=wildfire&view=console');
    await waitForLayerSettled(page, 'nifc-fires');

    const legend = page.locator('#legend, .legend, [data-legend]').first();
    await expect(legend).toContainText('0.0005 degree');
    await expect(legend).toContainText('not the full-resolution source geometry');

    const key = page.locator('#map-key [data-nifc-perimeter-key]');
    await expect(key).toBeVisible();
    await expect(key.locator('[data-nifc-generalization]')).toContainText('0.0005 degree');
    await expect(key.locator('.map-key-item')).toHaveCount(3);
  });

  // ---------------------------------------------------------------------
  // Viewport scoping and re-query (DDM-P1-T06). The stub answers BY
  // ENVELOPE (reading the request's `geometry` param) so the Washington
  // default view and a jump to Florida are answered with distinct
  // fixtures, and a test can tell the two requests apart.
  // ---------------------------------------------------------------------
  test.describe('viewport scoping re-queries on a view change (DDM-P1-T06)', () => {
    /** A small axis-aligned polygon at an arbitrary coordinate (unlike wildfire-fixtures.ts's PNW_POLYGON, not PNW-specific). */
    function boxPolygon(west: number, south: number) {
      return {
        type: 'Polygon',
        coordinates: [
          [
            [west, south],
            [west + 0.5, south],
            [west + 0.5, south + 0.4],
            [west, south + 0.4],
            [west, south]
          ]
        ]
      };
    }

    const FLORIDA_STUB = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {
            attr_IncidentTypeCategory: 'WF',
            poly_IncidentName: 'Synthetic Everglades'
          },
          geometry: boxPolygon(-81.6, 27.6)
        }
      ]
    };

    const EMPTY_COLLECTION = { type: 'FeatureCollection', features: [] };

    function parseEnvelope(url: URL): [number, number, number, number] | null {
      const raw = url.searchParams.get('geometry');
      if (!raw) return null;
      const parts = raw.split(',').map(Number);
      return parts.length === 4 && parts.every((n) => Number.isFinite(n))
        ? (parts as [number, number, number, number])
        : null;
    }

    /** The Florida jump's envelope sits east of the Rockies; the Washington default's does not. */
    function isFarEastEnvelope(envelope: readonly [number, number, number, number] | null): boolean {
      return envelope !== null && envelope[0] > -100;
    }

    /**
     * Route the layer's GeoJSON query by its requested envelope, recording
     * every query URL seen. `delayFarEastMs` stretches only the Florida
     * response so the intervening `loading` state is long enough to poll
     * reliably (case (c) below); `holdFarEast` holds it open indefinitely
     * until the returned `releaseFarEast` is called (the race case below);
     * the Washington response is never delayed or held.
     */
    async function routeNifcByEnvelope(
      page: Page,
      respond: (envelope: [number, number, number, number] | null) => unknown,
      opts: { delayFarEastMs?: number; holdFarEast?: boolean } = {}
    ): Promise<{ queries: string[]; releaseFarEast: () => void }> {
      const queries: string[] = [];
      let releaseFarEast = (): void => undefined;
      const held: Promise<void> = opts.holdFarEast
        ? new Promise((resolve) => {
            releaseFarEast = resolve;
          })
        : Promise.resolve();
      await page.route(
        (url) =>
          url.href.includes('WFIGS_Interagency_Perimeters_Current') &&
          url.pathname.endsWith('/query') &&
          url.searchParams.get('f') === 'geojson',
        async (route) => {
          const url = new URL(route.request().url());
          queries.push(url.toString());
          const envelope = parseEnvelope(url);
          if (isFarEastEnvelope(envelope)) {
            if (opts.holdFarEast) {
              await held;
            } else if (opts.delayFarEastMs) {
              await new Promise((resolve) => setTimeout(resolve, opts.delayFarEastMs));
            }
          }
          await route.fulfill({
            status: 200,
            contentType: 'application/geo+json',
            body: JSON.stringify(respond(envelope))
          });
        }
      );
      return { queries, releaseFarEast };
    }

    test('the request carries an envelope that contains the viewport, overscanned', async ({
      page
    }) => {
      await stubWildfireFeeds(page);
      const { queries } = await routeNifcByEnvelope(page, () => NIFC_STUB);

      await gotoApp(page, '?cluster=wildfire&view=console');
      await waitForLayerSettled(page, 'nifc-fires');

      expect(queries).toHaveLength(1);
      const params = new URL(queries[0]!).searchParams;
      expect(params.get('where')).toBe('1=1');
      expect(params.get('geometryType')).toBe('esriGeometryEnvelope');
      expect(params.get('inSR')).toBe('4326');
      expect(params.get('spatialRel')).toBe('esriSpatialRelIntersects');
      const raw = params.get('geometry');
      expect(raw).not.toBeNull();
      const envelope = raw!.split(',').map(Number);
      expect(envelope).toHaveLength(4);
      const [west, south, east, north] = envelope as [number, number, number, number];
      expect(west).toBeLessThan(east);
      expect(south).toBeLessThan(north);
      // The default view centers on [-121, 47] at zoom 7 (src/map/init.ts's
      // DEFAULT_CENTER/DEFAULT_ZOOM): a 0.05-degree margin around it is well
      // inside any reasonably sized viewport, so this proves containment
      // without needing the map container's exact rendered pixel size
      // (assert containment, not exact numbers).
      expect(west).toBeLessThan(-121 - 0.05);
      expect(east).toBeGreaterThan(-121 + 0.05);
      expect(south).toBeLessThan(47 - 0.05);
      expect(north).toBeGreaterThan(47 + 0.05);
    });

    test('a pan that stays inside the overscanned envelope issues no second request', async ({
      page
    }) => {
      await stubWildfireFeeds(page);
      const { queries } = await routeNifcByEnvelope(page, () => NIFC_STUB);

      await gotoApp(page, '?cluster=wildfire&view=console');
      await waitForLayerSettled(page, 'nifc-fires');
      expect(queries).toHaveLength(1);

      const mapBox = await page.locator('#map').boundingBox();
      expect(mapBox).not.toBeNull();
      const cx = mapBox!.x + mapBox!.width / 2;
      const cy = mapBox!.y + mapBox!.height / 2;
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx - 40, cy - 25, { steps: 5 });
      await page.mouse.up();
      // Past the 400 ms re-query debounce, with margin for the moveend and
      // any brief inertial settle.
      await page.waitForTimeout(900);

      expect(queries, 'a small pan inside the overscanned envelope reused the cache').toHaveLength(1);
      await expect(layerPill(page, 'nifc-fires')).not.toHaveClass(/no-data/);
    });

    test('a jump far outside the envelope re-queries, reporting loading then live, never no-data in between', async ({
      page
    }) => {
      await stubWildfireFeeds(page);
      const { queries } = await routeNifcByEnvelope(
        page,
        (envelope) => (isFarEastEnvelope(envelope) ? FLORIDA_STUB : NIFC_STUB),
        { delayFarEastMs: 500 }
      );

      await gotoApp(page, '?cluster=wildfire&view=console');
      await waitForLayerSettled(page, 'nifc-fires');
      expect(queries).toHaveLength(1);

      // The shared, real "select a place" search (search-fit.spec.ts's same
      // flow): a genuine camera fit to Florida's bounds, thousands of
      // kilometers outside the Washington default's overscanned envelope,
      // not a test-only hook (the dev-only __ddmMap handle is absent from
      // the production build this suite runs against).
      await page.locator('#catalog-search [data-ddm-search]').fill('florida');
      await page
        .locator('#catalog-search [data-search-group="place"] [data-search-kind="place"]', {
          hasText: 'Florida'
        })
        .first()
        .click();

      // Sample the pill for a fixed window covering the camera fit's own
      // animation, the moveend debounce, and the Florida response's
      // deliberate delay (all sit before the second request lands): it must
      // read loading at some point and never the empty-view text, before it
      // settles live.
      const seenClasses = new Set<string>();
      const sampleUntil = Date.now() + 5_000;
      while (Date.now() < sampleUntil) {
        const cls = (await layerPill(page, 'nifc-fires').getAttribute('class')) ?? '';
        for (const token of cls.split(/\s+/)) seenClasses.add(token);
        await page.waitForTimeout(50);
      }

      expect(queries, 'the far jump issued exactly one more request').toHaveLength(2);
      expect(seenClasses.has('loading'), 'the pill visited loading during the re-query').toBe(true);
      expect(seenClasses.has('no-data'), 'the pill never fell back to no-data during the re-query').toBe(
        false
      );
      await waitForLayerSettled(page, 'nifc-fires');
      await expect(layerPill(page, 'nifc-fires')).toHaveClass(/ready/);
    });

    test('a covering response with zero features reads no-data honestly', async ({ page }) => {
      await stubWildfireFeeds(page);
      const { queries } = await routeNifcByEnvelope(page, () => EMPTY_COLLECTION);

      await gotoApp(page, '?cluster=wildfire&view=console');
      await waitForLayerSettled(page, 'nifc-fires');

      expect(queries).toHaveLength(1);
      await expect(layerPill(page, 'nifc-fires')).toHaveClass(/no-data/);
    });

    // The 'washington_state' region's declared bounds (src/config/regions.ts:58:
    // `[[45.5435, -124.7630], [49.0024, -116.9159]]`, the SAME box the
    // brief's scout used); its geographic center is where `map.fitBounds`
    // centers the camera on both the initial boot (STATE.currentRegion
    // defaults to it) and a later `#reset-btn` click (which re-applies it),
    // regardless of viewport size or padding. A fixture centered exactly
    // there sits under the map's center pixel after either fit, so a click
    // at that pixel identifies WHICH collection is currently on the map
    // without needing the map container's exact rendered size.
    const WA_REGION_CENTER: readonly [number, number] = [
      (-124.763 + -116.9159) / 2,
      (45.5435 + 49.0024) / 2
    ];

    function centeredBoxPolygon(
      [cx, cy]: readonly [number, number],
      halfWidth = 0.25,
      halfHeight = 0.2
    ) {
      return {
        type: 'Polygon',
        coordinates: [
          [
            [cx - halfWidth, cy - halfHeight],
            [cx + halfWidth, cy - halfHeight],
            [cx + halfWidth, cy + halfHeight],
            [cx - halfWidth, cy + halfHeight],
            [cx - halfWidth, cy - halfHeight]
          ]
        ]
      };
    }

    const WA_CENTERED_STUB = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {
            attr_IncidentTypeCategory: 'WF',
            poly_IncidentName: 'Synthetic Center Fire'
          },
          geometry: centeredBoxPolygon(WA_REGION_CENTER)
        }
      ]
    };

    /** Click the exact center of `#map` and read the opened popup's title. */
    async function popupTitleAtMapCenter(page: Page): Promise<string> {
      const mapBox = await page.locator('#map').boundingBox();
      if (!mapBox) throw new Error('map container has no box');
      await page.mouse.click(mapBox.x + mapBox.width / 2, mapBox.y + mapBox.height / 2);
      const title = page.locator('.popup-title').first();
      await expect(title).toBeVisible();
      return ((await title.textContent()) ?? '').trim();
    }

    /**
     * The race the director's review found (2026-09-12): the OLD
     * `fetchAndApply` checked the cache BEFORE aborting the in-flight
     * controller and bumping `requestSeq`. A far jump starts B's fetch; a
     * pan back inside the still-cached A envelope, while B is still in
     * flight, was served from cache WITHOUT invalidating B's request
     * identity (aiannh.ts:427-436 does the abort and `++requestSeq` FIRST,
     * before its own cache lookup, for exactly this reason: "an older
     * network response must never land over a newer cached view"). B's
     * late response then passed the unchanged `token !== requestSeq` check
     * and painted Florida's data and status over the Washington view, and
     * replaced `cache`/`lastLoaded` with Florida's.
     *
     * The popup click at the map's center (not a status word or a count) is
     * the proof: it names WHICH collection is actually on the map at the
     * Washington camera position. If Florida's response had landed there
     * instead, the same click would open no popup at all (Florida's one
     * feature sits nowhere near Washington) or, worse, a stale Florida
     * feature note; either way it would not read "Synthetic Center Fire".
     */
    test('a pan back inside the still-cached envelope during an in-flight far jump keeps that view, not the far jump’s', async ({
      page
    }) => {
      await stubWildfireFeeds(page);
      const { queries, releaseFarEast } = await routeNifcByEnvelope(
        page,
        (envelope) => (isFarEastEnvelope(envelope) ? FLORIDA_STUB : WA_CENTERED_STUB),
        { holdFarEast: true }
      );

      await gotoApp(page, '?cluster=wildfire&view=console');
      await waitForLayerSettled(page, 'nifc-fires');
      expect(queries, 'the initial Washington-view request').toHaveLength(1);
      expect(await popupTitleAtMapCenter(page)).toBe('Synthetic Center Fire');

      // Jump far (Florida): starts B's fetch, held open by the route above.
      await page.locator('#catalog-search [data-ddm-search]').fill('florida');
      await page
        .locator('#catalog-search [data-search-group="place"] [data-search-kind="place"]', {
          hasText: 'Florida'
        })
        .first()
        .click();

      // Wait until B's request genuinely lands (it stays unanswered).
      await expect
        .poll(() => queries.length, { message: 'the far jump never issued its request' })
        .toBe(2);

      // Pan back inside A's envelope BEFORE B resolves: the real "Reset to
      // selected region bounds" control (#reset-btn, index.html), which
      // re-fits the camera to the still-selected Washington region
      // (STATE.currentRegion never changed; the region dropdown stayed on
      // "Washington State" through the search selection above) -- inside
      // A's cached envelope, not a test-only camera hook.
      await page.locator('#reset-btn').click();

      // The reset's re-query must resolve from A's cache with no third
      // request: give its fitBounds settle and the 400 ms debounce room,
      // then check before touching B at all.
      await page.waitForTimeout(1_500);
      expect(queries, 'the pan back inside the cache issued no third request').toHaveLength(2);
      await expect(layerPill(page, 'nifc-fires')).toHaveClass(/ready/);
      expect(await popupTitleAtMapCenter(page)).toBe('Synthetic Center Fire');

      // Release B's held response now that A's view is showing again.
      releaseFarEast();
      // A fixed wait proves only that B's response, once it is allowed to
      // resolve, does not paint over A within this window; it cannot prove
      // no future event ever could, which is what the request-count and
      // the popup-identity assertions right after are for (they hold
      // regardless of how long this wait is).
      await page.waitForTimeout(1_000);

      expect(queries, 'releasing B answers the SAME already-recorded request, never a new one').toHaveLength(2);
      await expect(layerPill(page, 'nifc-fires')).toHaveClass(/ready/);
      expect(await popupTitleAtMapCenter(page)).toBe('Synthetic Center Fire');
    });
  });
});

// ---------------------------------------------------------------------------
// DDM-P14-T07: the briefing and the minimap serve their fire counts from the
// perimeters layer's already-loaded collection when it covers the place or
// framing in question, issuing no second WFIGS request; the network (or
// count-only POST) read stays exactly as before when it does not.
// ---------------------------------------------------------------------------

/** The MINIMAP's declared count filter's predicate, restated here rather
 * than imported, so this spec's expectation is computed independently of
 * `MINIMAP_ACTIVE_WILDFIRE_FILTER.matches` in
 * src/config/wildfire-presentation.ts. NOT the briefing's rule (case (a)
 * below uses `briefingIncidentTypes` instead): the director's review of
 * this task's first draft found the two consumers do not share one filter. */
function matchesMinimapActiveFilter(properties: Record<string, unknown>): boolean {
  const code = String(properties['attr_IncidentTypeCategory'] ?? '').trim().toUpperCase();
  return Number(properties['attr_ActiveFireCandidate']) === 1 && (code === 'WF' || code === 'CX');
}

/** Walk a GeoJSON Polygon/MultiPolygon's coordinates into a
 * `[west, south, east, north]` bbox. */
function coordinatesBbox(geometry: { coordinates: unknown }): [number, number, number, number] {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  const visit = (node: unknown): void => {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === 'number' && typeof node[1] === 'number') {
      const [lng, lat] = node as [number, number];
      if (lng < west) west = lng;
      if (lng > east) east = lng;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
      return;
    }
    for (const child of node) visit(child);
  };
  visit(geometry.coordinates);
  return [west, south, east, north];
}

function bboxesOverlap(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number]
): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/**
 * The BRIEFING's own counting rule (director's fix, C3 report): every
 * mapped incident whose geometry intersects the place bbox, wildfire,
 * Prescribed fire, or unclassified alike (no active-only filter),
 * deduplicated by `attr_UniqueFireIdentifier`, restated here rather than
 * imported so this spec's expectation is computed independently of
 * `src/impact/sources.ts`'s `nifcClaimFromLoadedCollection`. Mirrors that
 * function's own dedupe rule: a feature with no usable identifier is never
 * deduped against another (kept individually), matching
 * `mergeByStableIdentifier` in `src/util/bbox.ts`.
 */
function briefingIncidentTypes(
  features: ReadonlyArray<{
    readonly properties: Record<string, unknown>;
    readonly geometry: { readonly coordinates: unknown };
  }>,
  bbox: readonly [number, number, number, number]
): unknown[] {
  const seen = new Set<string | number>();
  const types: unknown[] = [];
  for (const feature of features) {
    if (!bboxesOverlap(coordinatesBbox(feature.geometry), bbox)) continue;
    const id = feature.properties['attr_UniqueFireIdentifier'];
    if (typeof id === 'string' || typeof id === 'number') {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    types.push(feature.properties['attr_IncidentTypeCategory']);
  }
  return types;
}

/** Washington's declared camera bounds (src/config/regions.ts), in MapLibre
 * `[west, south, east, north]` order: within a few hundredths of a degree of
 * the real state-boundary walk `openStateBriefing` performs (verified
 * against public/data/us-states.geojson), comfortable margin for both
 * NIFC_STUB features below (one sits entirely south of it, the other well
 * inside it). */
const WASHINGTON_BRIEFING_BBOX = leafletBoundsToMapLibre(REGIONS.washington_state.bounds);

/** Every live briefing lane besides NIFC and the four hosts `gotoApp`
 * already stubs unconditionally (SPC Day 1-8, CPC seasonal temperature, the
 * recent satellite, and the boundary/minimap-analysis fixtures): USDM, NWS
 * active alerts, and the Worker resource proxy (waterSupply and friends).
 * Matches `tests/briefing-matrix.spec.ts`'s own `stubBaselineBriefingHosts`,
 * restated rather than imported (that helper is private to that file). */
async function stubOtherBriefingLanes(page: Page): Promise<void> {
  await page.route('**/USDM_current/FeatureServer/0/query?*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: JSON.stringify({ type: 'FeatureCollection', features: [] })
    })
  );
  await page.route('https://api.weather.gov/alerts/active?*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ features: [] })
    })
  );
  await page.route('**/proxy?*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  );
}

/** The briefing's current-fire cell (DDM-P14-T05's `product` field, and
 * DDM-P14-T07's subject): lane 'nifc' places at hazard 'fire', horizon
 * 'current' only (src/impact/matrix.ts). */
function currentFireCell(page: Page): ReturnType<Page['locator']> {
  return page.locator('.impact-hazard[data-horizon="current"][data-hazard="fire"]');
}

test.describe('DDM-P14-T07: the briefing and the minimap read the loaded NIFC collection', () => {
  test('(a) a briefing on a place inside the loaded envelope reads the collection: no second WFIGS request, count matches the briefing\'s own rule (every type, deduplicated)', async ({
    page
  }) => {
    await stubWildfireFeeds(page);
    await stubOtherBriefingLanes(page);
    // Case-local: NIFC_STUB plus one Prescribed-fire, inactive-candidate
    // feature well inside Washington, so this case proves the briefing
    // counts the WIDER set (director's fix, C3 report) rather than only
    // the minimap's active-WF/CX-only rows. NIFC_STUB itself is untouched
    // (it is shared by other specs, including this file's own cases (c)
    // and (d) and tests/fire3d-mode.spec.ts).
    const CASE_A_STUB = {
      type: 'FeatureCollection',
      features: [
        ...NIFC_STUB.features,
        {
          type: 'Feature',
          properties: {
            attr_IncidentTypeCategory: 'RX',
            attr_ActiveFireCandidate: 0,
            poly_IncidentName: 'Synthetic Prescribed Unit'
          },
          geometry: PNW_POLYGON(-119.5, 46.3)
        }
      ]
    };
    const geojsonQueries: string[] = [];
    await page.route(
      (url) =>
        url.href.includes('WFIGS_Interagency_Perimeters_Current') && url.pathname.endsWith('/query'),
      async (route) => {
        const request = route.request();
        if (request.method() === 'POST') {
          // The minimap's own count-only feed; not this case's subject.
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ count: 0 })
          });
        }
        geojsonQueries.push(request.url());
        await route.fulfill({
          status: 200,
          contentType: 'application/geo+json',
          body: JSON.stringify(CASE_A_STUB)
        });
      }
    );

    await gotoApp(page, '?view=brief&layers=nifc-fires,places');
    await waitForLayerSettled(page, 'nifc-fires');
    expect(geojsonQueries, "the layer's own boot query").toHaveLength(1);

    // The default region is Washington (src/config/regions.ts's
    // DEFAULT_REGION); the region-briefing trigger opens its anchored state
    // briefing (the same panel a map click builds), live, well after the
    // layer above has already settled to `ready`.
    await page.locator('#region-briefing-btn').click();

    const expectedTypes = briefingIncidentTypes(CASE_A_STUB.features, WASHINGTON_BRIEFING_BBOX);
    expect(expectedTypes.length, 'setup: at least two stub features must fall inside Washington').toBeGreaterThan(1);
    // The wider rule's proof: a Prescribed-fire, inactive record is in the
    // expected set (it would not be under the minimap's active-only filter).
    expect(expectedTypes).toContain('RX');
    const expectedText = buildNifcAreaPerimeterClaim(expectedTypes);

    const claim = currentFireCell(page).locator('.impact-claim').first();
    await expect(claim).toContainText(expectedText);

    expect(
      geojsonQueries,
      'the briefing answered from the loaded collection; no second WFIGS request'
    ).toHaveLength(1);
  });

  test('(b) a covered minimap framing reads the collection: no count-only POST for it, its count matches the declared filter', async ({
    page
  }) => {
    await stubWildfireFeeds(page);
    const hawaiiGeometry = buildMinimapWildfireQueryBody('hawaii').get('geometry');
    const HAWAII_STUB = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {
            attr_IncidentTypeCategory: 'WF',
            attr_ActiveFireCandidate: 1,
            poly_IncidentName: 'Synthetic Oahu Ridge'
          },
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [-157.95, 21.3],
                [-157.85, 21.3],
                [-157.85, 21.4],
                [-157.95, 21.4],
                [-157.95, 21.3]
              ]
            ]
          }
        }
      ]
    };

    const geojsonQueries: string[] = [];
    const countGeometries: string[] = [];
    await page.route(
      (url) =>
        url.href.includes('WFIGS_Interagency_Perimeters_Current') && url.pathname.endsWith('/query'),
      async (route) => {
        const request = route.request();
        if (request.method() === 'POST') {
          const body = new URLSearchParams(request.postData() ?? '');
          countGeometries.push(body.get('geometry') ?? '');
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ count: 0 })
          });
        }
        geojsonQueries.push(request.url());
        await route.fulfill({
          status: 200,
          contentType: 'application/geo+json',
          body: JSON.stringify(HAWAII_STUB)
        });
      }
    );

    // A framing small enough (the Hawaiian Islands) for a real camera's
    // overscanned query envelope to cover it whole, unlike the other eight
    // multi-state FRAMING_KEYS (design clause 3's coverage is real but rare
    // at ordinary viewport sizes): `region=hawaii` fits the SAME bounds
    // src/config/framings.ts records for the 'hawaii' framing
    // (tests/s1-substrate.spec.ts pins the two equal). `cluster=wildfire`
    // (not `layers=`) is required for the minimap's own wildfire metric and
    // its retained fetch to run at all: src/ui/island/minimap.tsx gates
    // `showWildfireMetric`/`retainMinimapWildfire` on
    // `metricContext === 'wildfire'`, and `layers=` outranks `cluster=` to
    // 'drought' (src/state/url.ts's `parseShellParams`).
    await gotoApp(page, '?view=brief&cluster=wildfire&region=hawaii');
    await waitForLayerSettled(page, 'nifc-fires');
    expect(geojsonQueries, "the layer's own boot query, fit to the Hawaii camera").toHaveLength(1);

    // The minimap's first mount races the layer's own boot activation (both
    // start at page load; the minimap's retained fetch does not wait on
    // ANY layer status), so its initial nine queries can land before the
    // layer settles to `ready` and are not this case's subject. A live
    // mode toggle away from and back to Wildfire unmounts then remounts
    // `retainMinimapWildfire` (src/ui/island/minimap.tsx gates it on
    // `metricContext === 'wildfire'`), which is "a minimap refresh" (the
    // acceptance sentence's phrase) driven well after `waitForLayerSettled`
    // above, with the layer unambiguously `ready`.
    countGeometries.length = 0;
    await page.locator('.shell-cluster-btn[data-cluster="drought"]').click();
    await page.locator('.shell-cluster-btn[data-cluster="wildfire"]').click();

    const expectedCount = HAWAII_STUB.features.filter((feature) =>
      matchesMinimapActiveFilter(feature.properties)
    ).length;
    expect(expectedCount, 'setup: the Hawaii stub must carry a countable feature').toBeGreaterThan(0);

    const hawaiiFraming = page.locator('.shell-minimap-map [data-framing="hawaii"]');
    await expect(hawaiiFraming).toHaveAttribute('data-wildfire-condition', 'mapped-wildfire');
    await expect(hawaiiFraming).toHaveAttribute('data-nifc-perimeter-count', String(expectedCount));

    expect(
      countGeometries.includes(hawaiiGeometry ?? '__unreachable__'),
      'the covered Hawaii framing never sent its own count-only POST on the refresh'
    ).toBe(false);
  });

  test('(c) with the layer OFF, the briefing issues exactly one bounded WFIGS request and aborts when the panel closes', async ({
    page
  }) => {
    await stubOtherBriefingLanes(page);
    const geojsonQueries: string[] = [];
    let releaseHeld = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      releaseHeld = resolve;
    });
    await page.route(
      (url) =>
        url.href.includes('WFIGS_Interagency_Perimeters_Current') && url.pathname.endsWith('/query'),
      async (route) => {
        geojsonQueries.push(route.request().url());
        await held;
        await route.fulfill({
          status: 200,
          contentType: 'application/geo+json',
          body: JSON.stringify({ type: 'FeatureCollection', features: [] })
        });
      }
    );
    const failures: string[] = [];
    page.on('requestfailed', (request) => {
      if (request.url().includes('WFIGS_Interagency_Perimeters_Current')) failures.push(request.url());
    });

    // `layers=places` only: the perimeters layer is never activated, so
    // `registry.getStatus('nifc-fires')` reads `undefined` and the
    // briefing's collection-read guard never fires (design clause 2's
    // "layer off" arm).
    await gotoApp(page, '?view=brief&layers=places');
    await page.locator('#region-briefing-btn').click();

    await expect.poll(() => geojsonQueries.length).toBe(1);
    const params = new URL(geojsonQueries[0]!).searchParams;
    expect(params.get('resultRecordCount')).toBe(String(NIFC_AREA_QUERY_RECORD_CAP));
    expect(params.get('f')).toBe('geojson');
    const [west, south, east, north] = (params.get('geometry') ?? '').split(',').map(Number);
    expect(west).toBeLessThan(east);
    expect(south).toBeLessThan(north);
    // Contained by Washington's declared bounds with slack for the
    // service's own coordinate rounding (round4 in src/impact/sources.ts).
    expect(west).toBeGreaterThanOrEqual(WASHINGTON_BRIEFING_BBOX[0] - 0.01);
    expect(east).toBeLessThanOrEqual(WASHINGTON_BRIEFING_BBOX[2] + 0.01);

    await page.locator('.impact-panel-close').click();
    await expect.poll(() => failures.length).toBeGreaterThan(0);

    releaseHeld();
  });

  test('(d) a place OUTSIDE the loaded envelope, layer ON, still issues its own bounded read (never the collection as zero)', async ({
    page
  }) => {
    await stubWildfireFeeds(page);
    await stubOtherBriefingLanes(page);
    // Oregon, not Florida: `impactSynthesis` (src/config/capability-matrix.ts)
    // is 'none' for every place outside the 'pnw' family (WA, OR, ID) or
    // 'ak-hi', so a Florida briefing never renders the twelve-cell horizon
    // matrix this case reads at all (a product capability boundary, not a
    // bug); Oregon keeps the matrix while still sitting outside Washington's
    // loaded envelope.
    const OREGON_BRIEFING_STUB = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {
            attr_UniqueFireIdentifier: 'OR-1',
            attr_IncidentName: 'Synthetic Deschutes',
            attr_IncidentTypeCategory: 'WF'
          },
          geometry: null
        }
      ]
    };
    const briefingQueries: string[] = [];
    await page.route(
      (url) =>
        url.href.includes('WFIGS_Interagency_Perimeters_Current') && url.pathname.endsWith('/query'),
      async (route) => {
        const request = route.request();
        if (request.method() === 'POST') {
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ count: 0 })
          });
        }
        const requestUrl = new URL(request.url());
        if (requestUrl.searchParams.get('resultRecordCount') !== null) {
          // The briefing's own bounded read.
          briefingQueries.push(request.url());
          await route.fulfill({
            status: 200,
            contentType: 'application/geo+json',
            body: JSON.stringify(OREGON_BRIEFING_STUB)
          });
          return;
        }
        // The perimeters layer's own viewport-scoped read (boot and any
        // re-query a later camera fit triggers); its own correctness is
        // proven by the "viewport scoping" describe above.
        await route.fulfill({
          status: 200,
          contentType: 'application/geo+json',
          body: JSON.stringify(NIFC_STUB)
        });
      }
    );

    // `select=state:OR` (tests/briefing-matrix.spec.ts's own deep-link
    // pattern, `?select=state:WA`) opens Oregon's briefing unconditionally
    // at boot (src/state/deep-link.ts's `applyDeepLink` passes no
    // `summaryFirst`, unlike the sidebar search-box selection
    // `search-fit.spec.ts` documents), combined with `layers=` at ONE boot.
    // The briefing's own NIFC read runs synchronously inside that same
    // deep-link call, before its `map.fitBounds` animation, `moveend`, and
    // the layer's 400 ms re-query debounce could possibly land, so this
    // case's outside-the-envelope outcome does not depend on whichever of
    // the layer's boot activation or the deep link wins their own race
    // (only case (a) above needs the layer settled first for that reason).
    await gotoApp(page, '?view=brief&layers=nifc-fires,places&select=state:OR');

    const expectedText = buildNifcAreaPerimeterClaim(
      OREGON_BRIEFING_STUB.features.map((feature) => feature.properties.attr_IncidentTypeCategory)
    );
    const claim = currentFireCell(page).locator('.impact-claim').first();
    await expect(claim).toContainText(expectedText);

    expect(
      briefingQueries,
      'a place outside the loaded envelope issues its own bounded read, never a false zero from the collection'
    ).toHaveLength(1);
  });
});
