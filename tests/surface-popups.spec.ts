import { test, expect } from './offline-test';
import { gotoApp, waitForLayerSettled } from './helpers';

// Codex block 2 review, P2: every external request a fixture does not route
// (an unstubbed service) is answered 503 locally, as in
// popup-viewport.spec.ts's tier dispatcher. Registered first, so gotoApp's
// context stubs and each fixture's page routes are checked before it.
test.beforeEach(async ({ context }) => {
  await context.route(
    (url) => url.protocol.startsWith('http') && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost',
    (route) => route.fulfill({ status: 503, contentType: 'text/plain', body: 'Synthetic offline response' })
  );
});

/**
 * The M25 surfaces (S30D D1 M25; DDM-P11-T04), moved here from
 * tests/identify-paths.spec.ts's describe "identify paths: the M25 surfaces"
 * (the sibling of M24's tests/place-popups.spec.ts). The census over these
 * builders stays in identify-paths (the scaffold runs
 * tests/frame-fixtures-surfaces.ts's SURFACE_CENSUS_FIXTURES), and the PF3
 * tier rows stay in tests/popup-viewport.spec.ts.
 *
 * The seven condition-surface builders (USDM, USDM change, NADM, CDM, the
 * held BC drought, CPC outlook, HMS) answer the coordinator a model (S30D
 * P1-FRAME, draft DR-178: the coordinator is the frame's one caller and
 * serializes it): their named fields stay inside the frame, the NADM primary
 * source is the product page, the coordinator's late door lands in the
 * framed actions slot, the frame takes the desktop measure, and every
 * builder fails soft on its data (PF1: issuer time text it cannot read is
 * shown as supplied; only a missing value, or one that is neither text nor a
 * finite number, is not stated; a year below 1000 is never read as a year).
 * The stubs and the one-read named-field reader are
 * tests/frame-fixtures-surfaces.ts's, loaded with a dynamic import. The held
 * BC builder has no browser case while DR-160 holds: it is proven here
 * statically and in Node only.
 */

type SurfaceFixtures = typeof import('./frame-fixtures-surfaces');
const surfaceFixtures = (): Promise<SurfaceFixtures> => import('./frame-fixtures-surfaces');

const SUPPLIED_EXPLANATION = 'As the issuer states it; DDM does not read it as a full date.';
const NADM_GEOJSON = 'https://www.ncei.noaa.gov/pub/data/nidis/geojson/na/nadm/NADM-current.geojson';

/** One expected clock line as readFramedResponse reports it. */
function clockLine(
  label: string,
  parts: { time?: string; datetime?: string; supplied?: string; explanation?: string; reason?: string }
): Record<string, string | null> {
  return {
    label,
    time: parts.time ?? null,
    datetime: parts.datetime ?? null,
    supplied: parts.supplied ?? null,
    explanation: parts.explanation ?? null,
    reason: parts.reason ?? null
  };
}

const USDM_SOURCE = { label: 'U.S. Drought Monitor', href: 'https://droughtmonitor.unl.edu/' };
const CHANGE_SOURCE = { label: 'USDM Change Maps', href: 'https://droughtmonitor.unl.edu/Maps/ChangeMaps.aspx' };
const NADM_SOURCE = { label: 'North American Drought Monitor', href: 'https://www.drought.gov/data-maps-tools/north-american-drought-monitor-nadm' };
const CDM_SOURCE = { label: 'Canadian Drought Monitor source', href: 'https://open.canada.ca/data/en/dataset/292646cd-619f-4200-afb1-8b2c52f984a2' };
const CPC_SOURCE = { label: 'CPC Drought Outlook', href: 'https://www.cpc.ncep.noaa.gov/products/expert_assessment/sdo_summary.php' };
const HMS_SOURCE = { label: 'NOAA OSPO Hazard Mapping System', href: 'https://www.ospo.noaa.gov/products/land/hms.html' };
const DROUGHT_GOV = { label: 'Drought.gov', href: 'https://www.drought.gov/' };
const CPC_PERSISTS_NOTE =
  'Existing drought is favored to persist through the outlook period. This is a forecast register: a shift in odds, not a forecast of outcomes.';
const HMS_NOTES = [
  'Analyst-drawn smoke plume from GOES satellite imagery. Density classes describe apparent smoke thickness (Light, Medium, Heavy), not ground-level air quality; check local air quality observations for exposure decisions.',
  'Strategic context only, not tactical fire operations or evacuation guidance.'
];
const HMS_HEAD = {
  title: 'HMS smoke analysis',
  issuer: 'Issued by: NOAA NESDIS Office of Satellite and Product Operations',
  values: ['Medium smoke'],
  swatches: ['Medium']
};

interface NamedFieldRow {
  readonly name: string;
  readonly id: string;
  readonly variant?: 'default' | 'malformed';
  readonly extra?: string;
  readonly expected: Record<string, unknown>;
}

/** Every head slot and every body string the builders carried before the frame (section 9's EXISTING rows). */
const NAMED_FIELDS: readonly NamedFieldRow[] = [
  {
    name: 'USDM',
    id: 'usdm',
    expected: {
      title: 'U.S. Drought Monitor',
      issuer: 'Issued by: NDMC, NOAA, USDA',
      values: ['D2 - Severe Drought'],
      swatches: ['D2'],
      // MapDate Date.UTC(2026, 7, 11) under America/Los_Angeles: a
      // date-only clock never shifts a day (D1.md item 8).
      // The head keeps the first clock; the valid window stands in the body's
      // more-clocks slot, words unchanged (S30D block 3, the head fits).
      clocks: [clockLine('Map date', { time: 'Aug 11, 2026', datetime: '2026-08-11' })],
      moreClocks: [
        clockLine('Valid', { time: 'Aug 11, 2026', datetime: '2026-08-11' }),
        clockLine('to', { time: 'Aug 17, 2026', datetime: '2026-08-17' })
      ],
      source: USDM_SOURCE,
      fallback: USDM_SOURCE,
      moreLinks: [DROUGHT_GOV],
      rows: [],
      notes: [
        'Crop or pasture losses are likely and water shortages are common; water-use restrictions may be imposed. Fire risk is high.',
        'Updated weekly each Thursday.'
      ]
    }
  },
  {
    name: 'USDM change',
    id: 'usdm-change',
    expected: {
      title: 'U.S. Drought Monitor change',
      issuer: 'Issued by: NDMC, NOAA, USDA (via drought.gov)',
      values: ['Worsened 1 category'],
      // The exact issuer class (DN), keyed in USDM_CHANGE_COLORS since the
      // 2026-10-07 change palette replaced the five grouped buckets.
      swatches: ['1'],
      clocks: [clockLine('Through', { time: 'Aug 11, 2026', datetime: '2026-08-11' })],
      source: CHANGE_SOURCE,
      fallback: CHANGE_SOURCE,
      moreLinks: [],
      rows: [],
      notes: ['How the drought category moved over the window, not where it stands. Observed analysis, not a forecast.']
    }
  },
  {
    name: 'NADM',
    id: 'nadm',
    expected: {
      title: 'North American Drought Monitor',
      issuer: 'Issued by: North American Drought Monitor · tri-national consensus product',
      values: ['D2 · Severe drought'],
      swatches: ['D2'],
      clocks: [clockLine('Consensus month', { time: 'Jun 2026', datetime: '2026-06' })],
      source: NADM_SOURCE,
      fallback: NADM_SOURCE,
      moreLinks: [{ label: 'North American Drought Monitor source', href: NADM_GEOJSON }],
      rows: [],
      notes: [
        'Monthly continental context, published 2 to 3 weeks after month-end. This product is not blended with a United States, Canadian, or provincial drought edition.',
        'The source publishes no country or issuing-agency attribute for this polygon. No issuer is inferred from its location.',
        'Areas without a polygon have no coverage from this source; they are not assigned class zero.'
      ]
    }
  },
  {
    name: 'CDM',
    id: 'cdm',
    expected: {
      title: 'Canadian Drought Monitor',
      issuer: 'Issued by: Agriculture and Agri-Food Canada',
      values: ['D2'],
      swatches: ['D2'],
      clocks: [clockLine('Month', { time: 'Jun 2026', datetime: '2026-06' })],
      source: CDM_SOURCE,
      fallback: CDM_SOURCE,
      moreLinks: [{ label: 'Open Government Licence - Canada', href: 'https://open.canada.ca/en/open-government-licence-canada' }],
      rows: [],
      notes: [
        'Monthly Canadian Drought Monitor classification. This feature is not blended with a United States or provincial product.',
        'Areas without a polygon are not assigned class zero by this artifact.'
      ]
    }
  },
  {
    name: 'CPC seasonal (a valid-through label with no year stays supplied)',
    id: 'cpc',
    expected: {
      title: 'NOAA CPC Seasonal Drought Outlook',
      issuer: 'Issued by: NOAA Climate Prediction Center',
      values: ['Drought persists'],
      swatches: ['PERSISTS'],
      clocks: [clockLine('Issued', { time: 'Jun 30, 2026', datetime: '2026-06-30' })],
      moreClocks: [clockLine('Valid through', { supplied: 'September 30', explanation: SUPPLIED_EXPLANATION })],
      source: CPC_SOURCE,
      fallback: CPC_SOURCE,
      moreLinks: [DROUGHT_GOV],
      rows: [],
      notes: [CPC_PERSISTS_NOTE]
    }
  },
  {
    name: 'CPC monthly (a "Mon YYYY" label at month precision)',
    id: 'cpc',
    extra: '&outlook=monthly',
    expected: {
      title: 'NOAA CPC Monthly Drought Outlook',
      issuer: 'Issued by: NOAA Climate Prediction Center',
      values: ['Drought persists'],
      swatches: ['PERSISTS'],
      clocks: [clockLine('Issued', { time: 'Jun 30, 2026', datetime: '2026-06-30' })],
      moreClocks: [clockLine('Valid through', { time: 'Jul 2026', datetime: '2026-07' })],
      source: CPC_SOURCE,
      fallback: CPC_SOURCE,
      moreLinks: [DROUGHT_GOV],
      rows: [],
      notes: [CPC_PERSISTS_NOTE]
    }
  },
  {
    name: 'HMS (both window ends at UTC instants)',
    id: 'hms',
    expected: {
      ...HMS_HEAD,
      clocks: [
        clockLine('Observed', { time: 'Aug 18, 2026, 12:00 UTC', datetime: '2026-08-18T12:00:00.000Z' }),
        clockLine('to', { time: 'Aug 18, 2026, 18:00 UTC', datetime: '2026-08-18T18:00:00.000Z' })
      ],
      source: HMS_SOURCE,
      fallback: HMS_SOURCE,
      moreLinks: [],
      rows: [['Detected by', 'GOES-WEST']],
      notes: HMS_NOTES
    }
  },
  {
    name: 'HMS (a malformed Start is shown as supplied; a blank End_ is not stated)',
    id: 'hms',
    variant: 'malformed',
    expected: {
      ...HMS_HEAD,
      clocks: [
        clockLine('Observed', { supplied: '2026-08-18 12:00Z', explanation: SUPPLIED_EXPLANATION }),
        clockLine('to', { reason: 'unavailable' })
      ],
      source: HMS_SOURCE,
      fallback: HMS_SOURCE,
      moreLinks: [],
      rows: [['Detected by', 'GOES-WEST']],
      notes: HMS_NOTES
    }
  }
];

test.describe('identify paths: the M25 surfaces', () => {
  test.use({ timezoneId: 'America/Los_Angeles' });

  test('each surface popup keeps its named fields inside the frame', async ({ page }) => {
    test.setTimeout(60_000 + 40_000 * NAMED_FIELDS.length);
    const s = await surfaceFixtures();
    for (const row of NAMED_FIELDS) {
      await s.bootSurface(page, row.id, { variant: row.variant ?? 'default', extra: row.extra ?? '' });
      await s.clickUntilSurfaceResponse(page, row.id);
      const read = await s.readFramedResponse(page);
      expect(read, `${row.name}: the response renders through the frame`).not.toBeNull();
      expect(
        {
          title: read!.title,
          issuer: read!.issuer,
          values: read!.values,
          swatches: read!.swatches,
          clocks: read!.clocks,
          moreClocks: read!.moreClocks,
          source: read!.source,
          fallback: read!.fallback,
          moreLinks: read!.moreLinks,
          rows: read!.rows,
          notes: read!.notes
        },
        row.name
        // A row with one clock has no more-clocks slot (S30D block 3).
      ).toEqual({ moreClocks: [], ...row.expected });
    }
  });

  test('the NADM source links the product page, the raw GeoJSON only as a more link', async ({ page }) => {
    const s = await surfaceFixtures();
    await s.bootSurface(page, 'nadm');
    await s.clickUntilSurfaceResponse(page, 'nadm');
    const links = await page.evaluate(() => {
      const root = document.querySelector('.maplibregl-popup .maplibregl-popup-content > [data-popup-frame]');
      if (!root) return null;
      return Array.from(root.querySelectorAll('a')).map((a) => ({
        slot: a.closest('[data-popup-slot]')?.getAttribute('data-popup-slot') ?? null,
        href: a.getAttribute('href') ?? ''
      }));
    });
    expect(links, 'the NADM response renders through the frame').not.toBeNull();
    expect(
      links!.filter((l) => l.slot === 'source' || l.slot === 'source-fallback'),
      'the head source and its body fallback link the product page'
    ).toEqual([
      { slot: 'source', href: s.NADM_PRODUCT_PAGE },
      { slot: 'source-fallback', href: s.NADM_PRODUCT_PAGE }
    ]);
    expect(
      links!.filter((l) => /\.geojson$/i.test(l.href)),
      'the raw GeoJSON appears once, as a more link'
    ).toEqual([{ slot: 'more-links', href: NADM_GEOJSON }]);
  });

  test('the late door lands in the framed actions slot, after the source and before Other map features here', async ({
    page
  }) => {
    const s = await surfaceFixtures();
    // Two surface hits under the centre (NADM, and HMS, an event layer that
    // stacks), so the disclosure exists; surfaces themselves are exclusive.
    await s.routeSurface(page, 'nadm');
    await s.routeSurface(page, 'hms');
    await gotoApp(page, '?region=washington_state&view=console&layers=nadm-drought,hms-smoke');
    await waitForLayerSettled(page, 'nadm-drought');
    await waitForLayerSettled(page, 'hms-smoke');
    const box = await page.locator('#map').boundingBox();
    if (!box) throw new Error('map container has no box');
    const head = page.locator('.maplibregl-popup .maplibregl-popup-content > [data-popup-frame] > [data-popup-region="head"]');
    await expect(async () => {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await expect(head.locator(':scope > details.popup-other-features')).toHaveCount(1, { timeout: 1500 });
    }).toPass({ timeout: 20_000 });
    // The door resolves asynchronously after the popup has painted.
    const door = head.locator('[data-ddm-impact-trigger]');
    await expect(door).toBeVisible({ timeout: 10_000 });
    await expect(door).toContainText('Washington');
    const order = await head.evaluate((h) => {
      const button = h.querySelector('[data-ddm-impact-trigger]');
      const actions = button?.parentElement ?? null;
      const source = h.querySelector(':scope > [data-popup-slot="source"]');
      const details = h.querySelector(':scope > details.popup-other-features');
      if (!actions || !source || !details) return null;
      return {
        parentSlot: actions.getAttribute('data-popup-slot'),
        parentIsHeadChild: actions.parentElement === h,
        actionsFollowSource: (source.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
        disclosureFollowsActions: (actions.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
      };
    });
    expect(order).toEqual({ parentSlot: 'actions', parentIsHeadChild: true, actionsFollowSource: true, disclosureFollowsActions: true });
    await door.click();
    await expect(page.locator('#impact-panel')).toBeVisible();
    await expect(page.locator('#impact-panel-title')).toHaveText('Washington');
  });

  test('a CDM popup takes the late door in its actions slot wherever a supported place resolves', async ({ page }) => {
    // The restated D1.md:425 case (the director's Tier 1 call 1): the door
    // is the coordinator's for every non-place surface and appears only
    // where a place resolves; the no-door half is popup-viewport.spec.ts's
    // NADM British Columbia case. The CDM polygon here covers Washington.
    const s = await surfaceFixtures();
    await s.bootSurface(page, 'cdm');
    await s.clickUntilSurfaceResponse(page, 'cdm');
    const actions = page.locator(
      '.maplibregl-popup .maplibregl-popup-content > [data-popup-frame] > [data-popup-region="head"] > [data-popup-slot="actions"]'
    );
    const door = actions.locator(':scope > [data-ddm-impact-trigger]');
    await expect(door).toBeVisible({ timeout: 10_000 });
    await expect(door).toContainText('Washington');
  });

  test('the framed surface popup takes the desktop measure', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const s = await surfaceFixtures();
    await s.bootSurface(page, 'nadm');
    await s.clickUntilSurfaceResponse(page, 'nadm');
    const width = await page.evaluate(() => {
      const root = document.querySelector('.maplibregl-popup .maplibregl-popup-content > [data-popup-frame]');
      return root ? root.getBoundingClientRect().width : null;
    });
    expect(width, 'the NADM response renders through the frame').not.toBeNull();
    // --popup-measure (app.css, 304px; src/config/map-chrome.ts mirrors it).
    expect(Math.abs(width! - Math.min(304, 1440 - 24)), `frame width ${width}`).toBeLessThanOrEqual(1);
  });



  test('issuer times that are not text, or name a year below 1000, still open the surface popup', async ({ page }) => {
    // The two Codex findings in the browser, through the coordinator's
    // model path: the popup opens and its clocks read as the builder states
    // them. Booleans survive MapLibre's feature encoding (an array or an
    // object would reach the builder as JSON text), so `true` and `false`
    // stand for the non-text values here; the Node cases above cover the rest.
    test.setTimeout(120_000);
    const s = await surfaceFixtures();
    const rows = [
      {
        name: 'HMS: Start true (absent), End_ in year 0099 (supplied)',
        id: 'hms',
        clocks: [clockLine('Observed', { reason: 'unavailable' }), clockLine('to', { supplied: '0099001 1200', explanation: SUPPLIED_EXPLANATION })],
        values: ['Medium smoke']
      },
      {
        name: 'USDM: MapDate false (not stated, never Jan 1, 1970)',
        id: 'usdm',
        clocks: [clockLine('Map date', { reason: 'unavailable' })],
        values: ['D2 - Severe Drought']
      }
    ];
    for (const row of rows) {
      await s.bootSurface(page, row.id, { variant: 'nontext' });
      await s.clickUntilSurfaceResponse(page, row.id);
      const read = await s.readFramedResponse(page);
      expect(read, `${row.name}: the response renders through the frame`).not.toBeNull();
      expect({ values: read!.values, clocks: read!.clocks }, row.name).toEqual({ values: row.values, clocks: row.clocks });
    }
  });
});
