import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from './offline-test';
import { gotoApp, waitForLayerSettled } from './helpers';
import { BUILDERS, LEGACY_ALLOWANCE, stripComments } from './identify-paths-manifest';
import { serializePopupFrame } from '../src/ui/popup-frame';
import type { PopupModel } from '../src/ui/popup-frame';

// Codex block 2 review, P2: every external request a fixture does not route
// (the OSM raster tiles, an unstubbed service) is answered 503 locally, as in
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

const ROOT = process.cwd();

function readSource(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

type SurfaceFixtures = typeof import('./frame-fixtures-surfaces');
const surfaceFixtures = (): Promise<SurfaceFixtures> => import('./frame-fixtures-surfaces');

const SUPPLIED_EXPLANATION = 'As the issuer states it; DDM does not read it as a full date.';
const NADM_GEOJSON = 'https://www.ncei.noaa.gov/pub/data/nidis/geojson/na/nadm/NADM-current.geojson';
const NBSP = ' ';

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
      swatches: ['worsened1'],
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

/** The seven surface builders' modules (usdm.ts holds two). */
const SURFACE_MODULES = [
  'src/layers/usdm.ts',
  'src/layers/nadm-drought.ts',
  'src/layers/cdm-drought.ts',
  'src/layers/bc-drought.ts',
  'src/layers/drought.ts',
  'src/layers/hms-smoke.ts'
] as const;

/** One fail-soft row: a real builder's model, serialized by the real frame. */
interface FailSoftCase {
  readonly name: string;
  readonly build: () => PopupModel;
  readonly contains: readonly string[];
  readonly lacks?: readonly string[];
}

/** Serialize every case through the frame: no builder or frame throw, each fragment present, each absent one absent. */
function expectFailSoft(cases: readonly FailSoftCase[]): void {
  for (const c of cases) {
    let markup = '';
    let failure: string | null = null;
    try {
      markup = serializePopupFrame(c.build());
    } catch (error) {
      failure = String(error);
    }
    expect(failure, `${c.name}: the builder or the frame threw`).toBeNull();
    for (const fragment of c.contains) expect(markup, c.name).toContain(fragment);
    for (const fragment of c.lacks ?? []) expect(markup, c.name).not.toContain(fragment);
  }
}

const supplied = (text: string): string =>
  `<span data-clock-supplied>${text}</span> <span data-clock-explanation>${SUPPLIED_EXPLANATION}</span>`;
const notStated = (label: string): string =>
  `<p data-clock-meaning="not-stated"><span class="popup-clock-label">${label}</span> <span data-clock-reason>unavailable</span></p>`;
const absentEnd = (label: string): string =>
  `<span class="popup-clock-label">${label}</span> <span data-clock-reason>unavailable</span>`;
const noSwatch = (text: string): string => `<div data-value-row><span class="popup-value-text">${text}</span></div>`;

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

  test('every surface builder module renders through the frame, the held BC builder included', async () => {
    // Draft DR-178 (S30D P1-FRAME): a layer module answers the coordinator
    // a model and imports only the frame's types; the coordinator alone
    // serializes it, so no surface module holds serializePopupFrame or a
    // legacy content answer.
    for (const file of SURFACE_MODULES) {
      const code = stripComments(readSource(file));
      expect(/import\s+type\s*\{[^}]*\}\s*from\s*['"]\.\.\/ui\/popup-frame['"]/.test(code), `${file} imports the frame's types`).toBe(true);
      expect(/\bmodel:\s*build[A-Za-z]+PopupModel\(/.test(code), `${file} answers the coordinator a model`).toBe(true);
      expect(code.includes('serializePopupFrame'), `${file} still serializes the frame itself`).toBe(false);
      expect(/\bcontent\s*:/.test(code), `${file} still gives a legacy content answer`).toBe(false);
      expect(code.includes('class="popup-title"'), `${file} still writes a legacy title`).toBe(false);
    }
    const bc = BUILDERS.find((b) => b.id === 'bc-drought');
    expect(bc?.held, 'the BC builder stays held (DR-160)').toBeDefined();
    expect(LEGACY_ALLOWANCE.includes('bc-drought'), 'a held builder holds no allowance line').toBe(false);

    // Execution in this Node context, with an import failure reported apart
    // from a serialization failure (the module is never imported by the app
    // while DR-160 holds).
    let mod: typeof import('../src/layers/bc-drought') | null = null;
    let importFailure: string | null = null;
    try {
      mod = await import('../src/layers/bc-drought');
    } catch (error) {
      importFailure = String(error);
    }
    expect(importFailure, 'the held BC module failed to IMPORT in the spec context').toBeNull();
    const cases = [
      {
        props: { BasinName: 'Fixture Basin', DroughtLevel: 3, Date_Modified: Date.UTC(2026, 6, 23) },
        title: 'Fixture Basin',
        value: '<span class="popup-swatch" aria-hidden="true" data-swatch-table="BC_DROUGHT_LEVELS" data-swatch-class="3"',
        clock: `<time datetime="2026-07-23">Jul${NBSP}23,${NBSP}2026</time>`
      },
      {
        props: { BasinName: 'Fixture Basin', DroughtLevel: 99, Date_Modified: Date.UTC(2026, 6, 23) },
        title: 'Fixture Basin',
        value: '<span class="popup-value-text">No update</span>',
        clock: `<time datetime="2026-07-23">Jul${NBSP}23,${NBSP}2026</time>`
      },
      {
        props: { BasinName: '  ', DroughtLevel: 'constructor', Date_Modified: 'not a date' },
        title: 'Unnamed basin',
        value: '<div data-value-row><span class="popup-value-text">Level unavailable</span></div>',
        clock: '<span data-clock-supplied>not a date</span>'
      }
    ];
    for (const c of cases) {
      let markup = '';
      let serializeFailure: string | null = null;
      try {
        markup = serializePopupFrame(mod!.buildBcDroughtPopupModel(c.props));
      } catch (error) {
        serializeFailure = String(error);
      }
      expect(serializeFailure, `the held BC model failed to SERIALIZE (${c.title})`).toBeNull();
      expect(markup).toContain(`<h3 class="popup-title" data-popup-slot="title">${c.title}</h3>`);
      expect(markup).toContain('<p class="popup-agency" data-popup-slot="issuer">Issued by: Province of British Columbia</p>');
      expect(markup).toContain(c.value);
      expect(markup).toContain(c.clock);
      expect(markup).toContain(
        '<p data-popup-slot="source"><a href="https://www.arcgis.com/home/item.html?id=f1842161d9c2454a98f9fc3b45d5d92e" target="_blank" rel="noopener">British Columbia drought levels source</a></p>'
      );
    }
  });

  test('every surface builder fails soft on malformed, absent, blank and unknown data (Node)', async () => {
    // C1 (Codex 2026-10-01): a builder never throws out of `respond` on a
    // feature's data; present issuer time text it cannot read is supplied,
    // only a missing, null or blank value is not stated; an issuer class
    // such as 'constructor' never resolves an inherited member.
    const [usdm, cpc, hms, nadm, cdm] = await Promise.all([
      import('../src/layers/usdm'),
      import('../src/layers/drought'),
      import('../src/layers/hms-smoke'),
      import('../src/layers/nadm-drought'),
      import('../src/layers/cdm-drought')
    ]);
    expectFailSoft([
      {
        name: 'USDM: an unknown class, a malformed map date, one valid end',
        build: () => usdm.buildUsdmPopupModel({ DM: 'constructor', MapDate: 'not a date', ValidStart: Date.UTC(2026, 7, 11), ValidEnd: '  ' }),
        contains: [
          noSwatch('Unknown drought category'),
          supplied('not a date'),
          `<span class="popup-clock-label">Valid</span> <time datetime="2026-08-11">Aug${NBSP}11,${NBSP}2026</time>`,
          absentEnd('to')
        ]
      },
      { name: 'USDM: no dates at all', build: () => usdm.buildUsdmPopupModel({}), contains: [notStated('Map date')] },
      {
        name: 'USDM change: an unknown class and no map date',
        build: () => usdm.buildUsdmChangePopupModel({ DN: 'constructor', MapDate: null }),
        contains: [noSwatch('Unknown change class'), notStated('Through')]
      },
      {
        name: 'NADM: an unknown class and no month',
        build: () => nadm.buildNadmPopupModel({ DROUGHTCAT: 'constructor' }, null),
        contains: [noSwatch('Unknown class'), notStated('Consensus month')]
      },
      {
        name: 'NADM: the loaded snapshot month (always YYYY-MM) renders as the month time line',
        build: () => nadm.buildNadmPopupModel({ DROUGHTCAT: 'd1' }, '2026-06'),
        contains: [`<span class="popup-clock-label">Consensus month</span> <time datetime="2026-06">Jun${NBSP}2026</time>`],
        lacks: ['data-clock-supplied']
      },
      {
        name: 'CDM: an unknown class and a blank month',
        build: () => cdm.buildCdmPopupModel({ dm: 'constructor' }, ' '),
        contains: [noSwatch('Unknown'), notStated('Month')]
      },
      {
        name: 'CPC: an unknown class, an impossible issue date, a label with no year',
        build: () => cpc.buildOutlookPopupModel({ outlook: 'constructor', fcst_date: '02/30/2026', target: 'September 30' }, 'seasonal'),
        contains: [
          noSwatch('Drought outlook'),
          supplied('02/30/2026'),
          supplied('September 30'),
          'CPC drought outlook class. This is a forecast register'
        ]
      },
      {
        name: 'CPC: an inherited class name and a blank issue date',
        build: () => cpc.buildOutlookPopupModel({ outlook: 'toString', fcst_date: '   ' }, 'monthly'),
        contains: [noSwatch('Drought outlook'), notStated('Issued'), 'CPC drought outlook class.']
      },
      {
        name: 'CPC: a leap day is a calendar date',
        build: () => cpc.buildOutlookPopupModel({ outlook: 'Removal', fcst_date: '02/29/2028' }, 'seasonal'),
        contains: [`<time datetime="2028-02-29">Feb${NBSP}29,${NBSP}2028</time>`, 'data-swatch-class="REMOVAL"']
      },
      {
        name: 'HMS: an unknown density, day 366 of a common year, no end',
        build: () => hms.buildHmsPopupModel({ Density: 'constructor', Start: '2025366 1200' }),
        contains: [
          'data-swatch-class="Unknown"',
          '<span class="popup-value-text">Unclassified smoke density</span>',
          supplied('2025366 1200'),
          absentEnd('to')
        ]
      },
      {
        name: 'HMS: hour 24 is not a time of day',
        build: () => hms.buildHmsPopupModel({ Density: 'Heavy', Start: '2024366 2400', End_: '2024366 2359' }),
        contains: [supplied('2024366 2400'), `<time datetime="2024-12-31T23:59:00.000Z">Dec${NBSP}31,${NBSP}2024,${NBSP}23:59${NBSP}UTC</time>`]
      },
      { name: 'HMS: no window at all', build: () => hms.buildHmsPopupModel({}), contains: [notStated('Observed')] }
    ]);
  });

  test('an issuer year below 1000 is supplied text, never read as a year in another century (Node)', async () => {
    // Codex N2-2 diff review, M25 finding 1: Date.UTC reads years 0 to 99
    // as 1900 to 1999, and a day 366 checked against year 0000 (a leap year)
    // was built in 1900 (not one). A year below 1000 is shown as the issuer
    // supplied it, as M24 decided for its own parser.
    const hms = await import('../src/layers/hms-smoke');
    expectFailSoft([
      {
        name: 'HMS: a Start in year 0099 and an End_ on day 366 of year 0000',
        build: () => hms.buildHmsPopupModel({ Density: 'Light', Start: '0099001 1200', End_: '0000366 1200' }),
        contains: [supplied('0099001 1200'), supplied('0000366 1200')],
        lacks: ['1999', '1901', '<time']
      },
      {
        name: 'HMS: a Start in year 0999 is still supplied; year 1000 is read',
        build: () => hms.buildHmsPopupModel({ Density: 'Light', Start: '0999001 1200', End_: '1000001 0000' }),
        contains: [
          supplied('0999001 1200'),
          `<time datetime="1000-01-01T00:00:00.000Z">Jan${NBSP}1,${NBSP}1000,${NBSP}00:00${NBSP}UTC</time>`
        ]
      }
    ]);
  });

  test('an issuer date that is neither text nor a finite number is absent, never its String() and never 1970 (Node)', async () => {
    // Codex N2-2 diff review, M25 finding 2: HMS `Start: []` became blank
    // supplied text the frame refuses (no popup), BC had the same failure,
    // and USDM `MapDate: false` became January 1, 1970.
    const [usdm, cpc, hms, bc] = await Promise.all([
      import('../src/layers/usdm'),
      import('../src/layers/drought'),
      import('../src/layers/hms-smoke'),
      import('../src/layers/bc-drought')
    ]);
    expectFailSoft([
      {
        name: 'HMS: Start [] and End_ {}',
        build: () => hms.buildHmsPopupModel({ Density: 'Medium', Start: [], End_: {} }),
        contains: [notStated('Observed')],
        lacks: ['data-clock-supplied']
      },
      {
        name: 'HMS: Start true is absent; a read End_ stays an instant',
        build: () => hms.buildHmsPopupModel({ Density: 'Medium', Start: true, End_: '2026230 1800' }),
        contains: [absentEnd('Observed'), `<time datetime="2026-08-18T18:00:00.000Z">`],
        lacks: ['data-clock-supplied']
      },
      {
        name: 'HMS: a finite number is text (shown as supplied)',
        build: () => hms.buildHmsPopupModel({ Density: 'Medium', Start: 2026230, End_: Number.NaN }),
        contains: [supplied('2026230'), absentEnd('to')]
      },
      {
        name: 'USDM: MapDate false, ValidStart [] and ValidEnd {}',
        build: () => usdm.buildUsdmPopupModel({ DM: 1, MapDate: false, ValidStart: [], ValidEnd: {} }),
        contains: [notStated('Map date')],
        lacks: ['1970', 'data-clock-supplied', '>Valid<']
      },
      {
        name: 'USDM: MapDate true and an infinite ValidEnd beside a read ValidStart',
        build: () => usdm.buildUsdmPopupModel({ DM: 1, MapDate: true, ValidStart: Date.UTC(2026, 7, 11), ValidEnd: Number.POSITIVE_INFINITY }),
        contains: [notStated('Map date'), absentEnd('to')],
        lacks: ['1970', 'data-clock-supplied']
      },
      {
        name: 'USDM change: MapDate false',
        build: () => usdm.buildUsdmChangePopupModel({ DN: 1, MapDate: false }),
        contains: [notStated('Through')],
        lacks: ['1970']
      },
      {
        name: 'CPC: fcst_date [] and target {}',
        build: () => cpc.buildOutlookPopupModel({ outlook: 'Persistence', fcst_date: [], target: {} }, 'seasonal'),
        contains: [notStated('Issued')],
        lacks: ['data-clock-supplied', 'Valid through']
      },
      {
        name: 'BC: Date_Modified []',
        build: () => bc.buildBcDroughtPopupModel({ BasinName: 'Fixture Basin', DroughtLevel: 2, Date_Modified: [] }),
        contains: [notStated('Source date')],
        lacks: ['data-clock-supplied']
      },
      {
        name: 'BC: Date_Modified false',
        build: () => bc.buildBcDroughtPopupModel({ BasinName: 'Fixture Basin', DroughtLevel: 2, Date_Modified: false }),
        contains: [notStated('Source date')],
        lacks: ['data-clock-supplied', '1970']
      },
      {
        // Codex block 2 review, P3: absence is decided before any conversion,
        // so an object whose coercion throws is absent, not an exception.
        name: 'BC: Date_Modified an object whose coercion throws',
        build: () =>
          bc.buildBcDroughtPopupModel({ BasinName: 'Fixture Basin', DroughtLevel: 2, Date_Modified: JSON.parse('{"toString":null}') }),
        contains: [notStated('Source date')],
        lacks: ['data-clock-supplied']
      }
    ]);
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
