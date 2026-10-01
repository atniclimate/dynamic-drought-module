/**
 * The briefing matrix: four hazard rows by three horizon columns (DR-012 b),
 * and the acceptance sentence of DDM-P7-T02.
 *
 *   "Every one of the twelve hazard-by-horizon cells renders either a sourced
 *    claim or a named unavailable state, and no cell inherits another
 *    hazard's issuer or clock."
 *
 * The first clause is checked twice: over the model, where a cell with no
 * claim must carry a note, and in the browser, where every cell must reach
 * the DOM with a claim or a note in it. The second clause is checked by
 * giving every lane a uniquely sourced claim and proving that no cell ends up
 * holding a claim from a lane the matrix never declared for it.
 *
 * The model cases need no browser; they import the matrix module, which is
 * pure by construction (no DOM, no fetches, no application state).
 */

import { expect, test, type Page } from '@playwright/test';

import { makeClaim } from '../src/impact/evidence';
import {
  applyMatrix,
  createHorizonCells,
  fillCell,
  HAZARD_KEYS,
  HORIZON_KEYS,
  LANE_PLACEMENT,
  lanesForCell,
  MATRIX_LANE_KEYS,
  type MatrixLaneKey,
  type MatrixLaneResult
} from '../src/impact/matrix';
import type { HazardCell, Horizon, HorizonKey } from '../src/impact/types';
import type { ProductKey } from '../src/config/products';
import { gotoApp, stubSpcFireOutlook } from './helpers';
// M20 (DDM-P7-T10, DR-113): the mode loop below reads HAZARD_CLUSTER_KEYS
// itself rather than a hardcoded four, and the horizon loop reads the
// rendered `.shell-horizon-btn` chips through the same crosswalk the shell
// uses, rather than importing HORIZON_KEYS as a second, parallel source.
import {
  HAZARD_CLUSTER_KEYS,
  type HazardClusterKey,
  type TemporalHorizonKey
} from '../src/config/clusters';
import { SHELL_HAZARD_KEY, SHELL_HORIZON_KEY } from '../src/impact/horizon-chrome';

/**
 * The product each lane's generic test claim names (DDM-P14-T05 microtask 2):
 * these fixtures have no real source, so each lane maps to the one catalog
 * product `src/config/products.ts` records for that lane. `enso` reads six
 * distinct products from one lane; `ensoIndex` (the current index-state read)
 * stands in as representative here, matching the lane's own primary claim.
 */
const LANE_PRODUCT: Readonly<Record<MatrixLaneKey, ProductKey>> = {
  usdm: 'usdm',
  dsci: 'dsci',
  nifc: 'nifc-fires',
  nwsAlerts: 'nws-alerts',
  heatRisk: 'heatrisk',
  nwsForecast: 'nwsForecast',
  cpcExtended: 'cpcExtended',
  enso: 'ensoIndex',
  waterSupply: 'waterSupply',
  cpcSeasonal: 'cpcSeasonal',
  cpcSeasonalTemp: 'cpcSeasonalTemp',
  spcFireOutlook: 'spc-fire-weather'
};

function emptyHorizon(key: HorizonKey): Horizon {
  return {
    key,
    title: key,
    subtitle: '',
    cells: createHorizonCells(key),
    claims: [],
    status: 'loading'
  };
}

function emptyHorizons(): Record<HorizonKey, Horizon> {
  return {
    current: emptyHorizon('current'),
    nearTerm: emptyHorizon('nearTerm'),
    longRange: emptyHorizon('longRange')
  };
}

/** One answered lane whose single claim names the lane as its issuer. */
function lanePayload(lane: MatrixLaneKey): MatrixLaneResult {
  return {
    ok: true,
    claims: [
      makeClaim({
        text: `A sourced statement from ${lane}.`,
        source: lane,
        product: LANE_PRODUCT[lane],
        evidence: 'analyzed',
        dates: { valid: '2026-09-03' }
      })
    ]
  };
}

function allLanesAnswered(): Map<MatrixLaneKey, MatrixLaneResult> {
  return new Map(MATRIX_LANE_KEYS.map((lane) => [lane, lanePayload(lane)]));
}

function everyCell(horizons: Record<HorizonKey, Horizon>): HazardCell[] {
  return HORIZON_KEYS.flatMap((horizon) =>
    HAZARD_KEYS.map((hazard) => horizons[horizon].cells[hazard])
  );
}

test('the matrix is twelve cells, one per hazard and horizon', () => {
  const horizons = emptyHorizons();
  const cells = everyCell(horizons);
  expect(cells).toHaveLength(12);
  const identities = cells.map((cell) => `${cell.horizon}:${cell.hazard}`);
  expect(new Set(identities).size).toBe(12);
  for (const cell of cells) {
    expect(cell.label.length).toBeGreaterThan(0);
  }
});

test('every cell renders a sourced claim or a named unavailable state', () => {
  for (const results of [
    new Map<MatrixLaneKey, MatrixLaneResult>(),
    allLanesAnswered(),
    new Map<MatrixLaneKey, MatrixLaneResult>(
      MATRIX_LANE_KEYS.map((lane) => [
        lane,
        { ok: false, claims: [], note: `${lane} did not respond.` }
      ])
    )
  ]) {
    const horizons = emptyHorizons();
    applyMatrix(horizons, results);
    for (const cell of everyCell(horizons)) {
      const named = typeof cell.note === 'string' && cell.note.length > 0;
      const sourced = cell.claims.length > 0;
      const waiting = cell.status === 'loading';
      expect(
        sourced || named || waiting,
        `${cell.horizon}:${cell.hazard} rendered nothing`
      ).toBe(true);
      // A settled cell is never blank and never silent.
      if (!waiting) expect(sourced || named).toBe(true);
    }
  }
});

test('a settled cell with no claim always names what is missing', () => {
  const horizons = emptyHorizons();
  applyMatrix(horizons, allLanesAnswered());
  for (const cell of everyCell(horizons)) {
    if (cell.claims.length === 0) {
      expect(cell.status).toBe('unavailable');
      expect(cell.note ?? '').not.toBe('');
    }
  }
});

test('no cell inherits another hazard issuer or clock', () => {
  const horizons = emptyHorizons();
  applyMatrix(horizons, allLanesAnswered());
  for (const cell of everyCell(horizons)) {
    const declared = lanesForCell(cell.horizon, cell.hazard);
    for (const claim of cell.claims) {
      expect(
        declared.includes(claim.source as MatrixLaneKey),
        `${cell.horizon}:${cell.hazard} holds a claim issued by ${claim.source}`
      ).toBe(true);
    }
  }
});

// Was four cells until DDM-P12-T02 (DR-031 a) wired the CPC weekly Nino 3.4
// file into the ENSO near-term cell, which gave that cell a declared lane;
// down to two (the fire cells only) since DDM-P7-T07 wired the CPC seasonal
// temperature outlook into the heat long-range cell; down to one (the
// long-range fire cell only) since DDM-P7-T03 (DR-022 a) wired the SPC Day
// 1-8 Fire Weather Outlook into the near-term fire cell. The long-range fire
// cell stays unwired on purpose: NIFC's National Wildland Significant Fire
// Potential Outlook has no machine-readable endpoint (verify-spc-nifc.md,
// S20), so this cell reads the shared unavailable form naming that product
// rather than a "not wired yet" placeholder. The remaining wired cells can
// still render an absence, but they do so because their lane had nothing to
// report, not because no product was ever wired to it.
test('the long-range fire cell with no wired product says so from the first paint', () => {
  const horizons = emptyHorizons();
  const unwired = everyCell(horizons).filter(
    (cell) => lanesForCell(cell.horizon, cell.hazard).length === 0
  );
  expect(unwired.map((cell) => `${cell.horizon}:${cell.hazard}`)).toEqual([
    'longRange:fire'
  ]);
  for (const cell of unwired) {
    // Never a spinner for a source that will not come.
    expect(cell.status).toBe('unavailable');
    expect(cell.note ?? '').not.toBe('');
  }
  expect(horizons.longRange.cells.fire.note).toContain(
    'National Wildland Significant Fire Potential Outlook'
  );
  expect(horizons.longRange.cells.fire.note).toContain('PDF only');
  expect(horizons.longRange.cells.fire.note).not.toContain('Wildfire Hazard Potential');
  expect(horizons.longRange.cells.fire.note).not.toContain('WHP');
});

test('the near-term fire cell now has a declared SPC lane', () => {
  expect(lanesForCell('nearTerm', 'fire')).toEqual(['spcFireOutlook']);
});

test('one query answering two hazards files each statement in its own row', () => {
  const horizons = emptyHorizons();
  const fireOnly = makeClaim({
    // vocab-allow: reports the upstream NWS alert product in effect
    text: 'A fire-weather alert is in effect here.',
    source: 'nwsAlerts',
    product: 'nws-alerts',
    evidence: 'observed',
    dates: { retrieved: '2026-09-03' },
    hazards: ['fire']
  });
  const both = makeClaim({
    // vocab-allow: reports the absence of upstream NWS alert products
    text: 'No active red-flag fire-weather or extreme-heat alerts here.',
    source: 'nwsAlerts',
    product: 'nws-alerts',
    evidence: 'observed',
    dates: { retrieved: '2026-09-03' }
  });
  applyMatrix(
    horizons,
    new Map<MatrixLaneKey, MatrixLaneResult>([
      ['nwsAlerts', { ok: true, claims: [fireOnly, both] }]
    ])
  );
  expect(horizons.current.cells.fire.claims).toEqual([fireOnly, both]);
  expect(horizons.current.cells.heat.claims).toEqual([both]);
});

test('one snapshot answering two horizons files each claim under its own clock', () => {
  const horizons = emptyHorizons();
  const stateNow = makeClaim({
    text: 'The observed index state.',
    source: 'enso',
    product: 'ensoIndex',
    evidence: 'derived',
    dates: { retrieved: '2026-09-03' },
    horizon: 'current'
  });
  const seasonAhead = makeClaim({
    text: 'The seasonal tendency.',
    source: 'enso',
    product: 'ensoTendency',
    evidence: 'derived',
    dates: { retrieved: '2026-09-03' },
    horizon: 'longRange'
  });
  applyMatrix(
    horizons,
    new Map<MatrixLaneKey, MatrixLaneResult>([
      ['enso', { ok: true, claims: [stateNow, seasonAhead] }]
    ])
  );
  expect(horizons.current.cells.enso.claims).toEqual([stateNow]);
  expect(horizons.longRange.cells.enso.claims).toEqual([seasonAhead]);
  expect(horizons.nearTerm.cells.enso.claims).toEqual([]);
});

test('a lane failure names its own row and leaves the row beside it alone', () => {
  const horizons = emptyHorizons();
  applyMatrix(
    horizons,
    new Map<MatrixLaneKey, MatrixLaneResult>([
      ['usdm', lanePayload('usdm')],
      ['dsci', lanePayload('dsci')],
      ['nifc', { ok: false, claims: [], note: 'NIFC did not respond.' }],
      ['nwsAlerts', lanePayload('nwsAlerts')],
      ['enso', lanePayload('enso')]
    ])
  );
  expect(horizons.current.cells.drought.status).toBe('ready');
  expect(horizons.current.cells.drought.note).toBeUndefined();
  expect(horizons.current.cells.fire.status).toBe('partial');
  expect(horizons.current.cells.fire.note).toBe('NIFC did not respond.');
  expect(horizons.current.cells.heat.status).toBe('ready');
  expect(horizons.current.cells.heat.note).toBeUndefined();
});

test('a cell keeps loading only while one of its own lanes is in flight', () => {
  const cell: HazardCell = {
    hazard: 'drought',
    horizon: 'current',
    label: 'Drought',
    claims: [],
    status: 'loading'
  };
  fillCell(cell, new Map<MatrixLaneKey, MatrixLaneResult>());
  expect(cell.status).toBe('loading');
  fillCell(
    cell,
    new Map<MatrixLaneKey, MatrixLaneResult>([['usdm', lanePayload('usdm')]])
  );
  expect(cell.status).toBe('partial');
  fillCell(
    cell,
    new Map<MatrixLaneKey, MatrixLaneResult>([
      ['usdm', lanePayload('usdm')],
      ['dsci', lanePayload('dsci')]
    ])
  );
  expect(cell.status).toBe('ready');
});

test('every lane is placed in at least one hazard row and one horizon', () => {
  for (const lane of MATRIX_LANE_KEYS) {
    const placement = LANE_PLACEMENT[lane];
    expect(placement.hazards.length).toBeGreaterThan(0);
    expect(placement.horizons.length).toBeGreaterThan(0);
  }
});

function collection(features: unknown[]): string {
  return JSON.stringify({ type: 'FeatureCollection', features });
}

/**
 * The non-default briefing hosts a `?view=brief&select=` boot reaches:
 * USDM, NIFC current perimeters, NWS active alerts, and the Worker proxy
 * (waterSupply and friends). `gotoApp` stubs the satellite, boundary,
 * minimap and CPC seasonal temperature reads unconditionally; every other
 * live lane needs its own deterministic answer here so a spec that opens
 * the briefing never reaches a live agency (S17's lesson).
 */
async function stubBaselineBriefingHosts(page: Page): Promise<void> {
  await page.route('**/USDM_current/FeatureServer/0/query?*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: collection([])
    })
  );
  await page.route('**/WFIGS_Interagency_Perimeters_Current/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: collection([])
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
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '[]'
    })
  );
}

test('the open briefing renders all twelve cells, each with a claim or a named state', async ({
  page
}) => {
  await stubBaselineBriefingHosts(page);
  // DDM-P7-T03: the near-term fire cell holds a live SPC lane; `gotoApp`
  // itself now stubs every one of the eight Day 1-8 layer queries with a
  // deterministic empty answer by default (F1, tests/helpers.ts
  // `stubSpcFireOutlook`), the honest "no area is drawn" case, so no
  // explicit route is needed here.
  await gotoApp(page, '?view=brief&layers=places&select=state:WA');

  const cells = page.locator('.impact-horizons .impact-hazard');
  await expect(cells).toHaveCount(12);
  for (const horizon of HORIZON_KEYS) {
    for (const hazard of HAZARD_KEYS) {
      const cell = page.locator(
        `.impact-hazard[data-horizon="${horizon}"][data-hazard="${hazard}"]`
      );
      await expect(cell).toHaveCount(1);
      await expect(
        cell.locator('.impact-claim, .impact-horizon-note, .impact-horizon-loading')
      ).not.toHaveCount(0);
    }
  }

  await expect(
    page.locator('.impact-hazard[data-horizon="nearTerm"][data-hazard="fire"]')
  ).toContainText('Storm Prediction Center');
  await expect(
    page.locator('.impact-hazard[data-horizon="longRange"][data-hazard="fire"]')
  ).toContainText('National Wildland Significant Fire Potential Outlook');
});

// ---------------------------------------------------------------------------
// DDM-P7-T03: SPC Day 1-8 Fire Weather Outlook (near-term fire) and the
// NIFC unavailable form (long-range fire).
// ---------------------------------------------------------------------------

/** One GeoJSON Feature with the given properties, geometry omitted (the
 * fetcher never reads geometry, matching `esriPointQuery`'s `returnGeometry:
 * 'false'`). */
function spcFeature(properties: Record<string, unknown>): unknown {
  return { type: 'Feature', geometry: null, properties };
}

// `stubSpcFireOutlook` (tests/helpers.ts, DDM-P7-T03 fix round) replaces the
// local helper that lived here in round 1: `gotoApp` now stubs this host by
// default (F1), so every case below calls the shared, imported helper WITH
// its own reading BEFORE `gotoApp`, which the helper's WeakSet guard makes
// authoritative over `gotoApp`'s later, empty-default call.

test('SPC Day 1 categorical: a stubbed dn 8 feature renders the VERIFIED word, product name, issuer and valid window in the outlook register', async ({
  page
}) => {
  await stubBaselineBriefingHosts(page);
  await stubSpcFireOutlook(page, {
    1: [spcFeature({ dn: 8, valid: '202609091700', expire: '202609101200' })]
  });
  await gotoApp(page, '?view=brief&layers=places&select=state:WA');

  const cell = page.locator(
    '.impact-hazard[data-horizon="nearTerm"][data-hazard="fire"]'
  );
  const day1Claim = cell.locator('.impact-claim').first();
  await expect(day1Claim).toContainText('SPC Day 1 Fire Weather Outlook');
  // This dn 8 fixture proves the issuer's "Critical" word and the sentence
  // shape (about.html); it does NOT exercise the dn 10 "Extreme" to
  // "Extremely Critical" palette correction, which the dn 10 case below
  // proves (F4, S20 fix round: the prior comment overclaimed this).
  await expect(day1Claim).toContainText(
    'Critical risk from wind and relative humidity'
  );
  await expect(day1Claim).toContainText(
    'valid Sep 9, 2026, 17:00 UTC to Sep 10, 2026, 12:00 UTC'
  );
  await expect(day1Claim.locator('.impact-claim-source')).toContainText(
    'Storm Prediction Center'
  );
  await expect(day1Claim.locator('.impact-claim-register')).toHaveText('outlook');
});

test('SPC Day 2 categorical: a stubbed dn 10 feature renders the issuer\'s own "Extremely Critical" word, never the renderer\'s "Extreme"', async ({
  page
}) => {
  await stubBaselineBriefingHosts(page);
  await stubSpcFireOutlook(page, {
    4: [spcFeature({ dn: 10, valid: '202609091700', expire: '202609101200' })]
  });
  await gotoApp(page, '?view=brief&layers=places&select=state:WA');

  const cell = page.locator(
    '.impact-hazard[data-horizon="nearTerm"][data-hazard="fire"]'
  );
  await expect(cell).toContainText(
    'SPC Day 2 Fire Weather Outlook: Extremely Critical risk from wind and relative humidity at this point'
  );
  await expect(cell).not.toContainText('Extreme risk');
});

test('SPC Day 1 with a malformed dn: the point-heat-briefing convention drops the feature rather than inventing a "Category 0" risk or a false no-area reading', async ({
  page
}) => {
  await stubBaselineBriefingHosts(page);
  await stubSpcFireOutlook(page, {
    1: [spcFeature({ dn: 0, valid: '202609091700', expire: '202609101200' })]
  });
  await gotoApp(page, '?view=brief&layers=places&select=state:WA');

  const cell = page.locator(
    '.impact-hazard[data-horizon="nearTerm"][data-hazard="fire"]'
  );
  // Day 1 states neither an invented risk nor a false "no area" reading.
  await expect(cell).not.toContainText('Category 0');
  await expect(cell).not.toContainText(
    'SPC Day 1 Fire Weather Outlook: no Elevated, Critical, or Extremely Critical area is drawn over this point for this day.'
  );
  // Day 2 (layer 4, no stubbed feature) still states its own honest no-area
  // sentence, and the cell as a whole is not unavailable.
  await expect(cell).toContainText(
    'SPC Day 2 Fire Weather Outlook: no Elevated, Critical, or Extremely Critical area is drawn over this point for this day.'
  );
  await expect(cell.locator('.impact-horizon-note')).toHaveCount(0);
});

test('SPC Day 1 and Day 2 with no feature: the cell states the no-area sentence, never no data and never unavailable', async ({
  page
}) => {
  await stubBaselineBriefingHosts(page);
  await stubSpcFireOutlook(page, {});
  await gotoApp(page, '?view=brief&layers=places&select=state:WA');

  const cell = page.locator(
    '.impact-hazard[data-horizon="nearTerm"][data-hazard="fire"]'
  );
  await expect(cell).toContainText(
    'SPC Day 1 Fire Weather Outlook: no Elevated, Critical, or Extremely Critical area is drawn over this point for this day.'
  );
  await expect(cell).toContainText(
    'SPC Day 2 Fire Weather Outlook: no Elevated, Critical, or Extremely Critical area is drawn over this point for this day.'
  );
  await expect(cell).not.toContainText('no data');
  await expect(cell.locator('.impact-horizon-note')).toHaveCount(0);
});

test('SPC transport failure: the near-term fire cell reads unavailable naming the product', async ({
  page
}) => {
  await stubBaselineBriefingHosts(page);
  await stubSpcFireOutlook(page, {}, { httpStatus: 503 });
  await gotoApp(page, '?view=brief&layers=places&select=state:WA');

  const cell = page.locator(
    '.impact-hazard[data-horizon="nearTerm"][data-hazard="fire"]'
  );
  await expect(cell.locator('.impact-horizon-note')).toContainText(
    'Storm Prediction Center'
  );
  await expect(cell.locator('.impact-horizon-note')).toContainText(
    'Fire Weather Outlook'
  );
  await expect(cell.locator('.impact-claim')).toHaveCount(0);
});

test('the Days 3-8 probabilistic reads: 0.40, 0.70 and the live "Probability Too Low" value each state their own honest sentence', async ({
  page
}) => {
  await stubBaselineBriefingHosts(page);
  await stubSpcFireOutlook(page, {
    8: [
      spcFeature({
        dn: 40,
        label: '0.40',
        label2: '40% Wind/RH Risk',
        valid: '202609101200',
        expire: '202609111200',
        issue: '202609082156'
      })
    ],
    11: [
      spcFeature({
        dn: 70,
        label: '0.70',
        label2: '70% Wind/RH Risk',
        valid: '202609111200',
        expire: '202609121200',
        issue: '202609082156'
      })
    ],
    23: [
      spcFeature({
        dn: 0,
        label: 'Probability Too Low',
        label2: ' ',
        valid: '202609151200',
        expire: '202609161200',
        issue: '202609082156'
      })
    ]
  });
  await gotoApp(page, '?view=brief&layers=places&select=state:WA');

  const cell = page.locator(
    '.impact-hazard[data-horizon="nearTerm"][data-hazard="fire"]'
  );
  await expect(cell).toContainText(
    'SPC Day 3 Fire Weather Outlook: 40% probability of critical fire weather and/or lightning-based ignition within 12 miles of this point'
  );
  await expect(cell).toContainText(
    'SPC Day 4 Fire Weather Outlook: 70% probability of critical fire weather and/or lightning-based ignition within 12 miles of this point'
  );
  await expect(cell).toContainText(
    'SPC Day 8 Fire Weather Outlook: this point returns "Probability Too Low", a service value with no public SPC definition found; treated here as below the 10% threshold SPC does map, not as no-data.'
  );
  // The renderer's own band names are never printed for these layers.
  await expect(cell).not.toContainText('Marginal');
  await expect(cell).not.toContainText('Critical (70%)');
  // Days 5, 6, and 7 drew no probabilistic feature and fold into one
  // sentence, with the serial comma the verdict's own (c) sentence uses.
  await expect(cell).toContainText(
    'SPC Day 3-8 Fire Weather Outlook: no area is drawn over this point for Days 5, 6, and 7.'
  );
});

// ---------------------------------------------------------------------------
// DDM-P2-T07: the active hazard mode is emphasized in every horizon
// section (DR-092), never reordered, and never a severity ranking between
// the four hazards. There is no contiguous "hazard row" in the DOM: each
// of the three `.impact-horizon` sections builds its own four
// `.impact-hazard` cells, so the active hazard is marked once inside EACH
// section (three cells total), not once overall.
// ---------------------------------------------------------------------------

/** The shell's four hazard cluster buttons live in the always-mounted
 * Brief-mode VIEW block (app.css's S4 shell section), so they are present
 * and clickable while the impact briefing panel is open on top of the map;
 * clicking one is a live in-page mode switch, no navigation. Every case
 * below drives the switch this way, never via a boot-time `cluster=`
 * param: a `cluster=` URL param races the panel's own `select=` deep-link
 * paint against `initClusterService`'s URL seed (cluster-service.ts's own
 * comment on why `selectedHazard` is re-seeded there), so the FIRST paint
 * after a `cluster=` boot is not a reliable place to assert from. A live
 * click has no such race: `requestCluster` commits and publishes in one
 * synchronous transaction.) */
function clusterBtn(page: Page, cluster: 'drought' | 'wildfire' | 'heat' | 'enso'): ReturnType<Page['locator']> {
  return page.locator(`.shell-cluster-btn[data-cluster="${cluster}"]`);
}

/** Every `.impact-hazard` cell across all three horizons, in document order. */
function allHazardRows(page: Page): ReturnType<Page['locator']> {
  return page.locator('.impact-horizons .impact-hazard');
}

/** The `data-hazard` of every cell currently carrying `aria-current`, one
 * per horizon section when the emphasis is correctly applied. */
async function activeHazardValues(page: Page): Promise<string[]> {
  return page
    .locator('.impact-horizons .impact-hazard[aria-current="true"]')
    .evaluateAll((rows) =>
      rows.map((row) => {
        // Throw, never filter: an active row without a hazard attribute is
        // a regression this helper must surface, not silently drop.
        const hazard = row.getAttribute('data-hazard');
        if (hazard === null) throw new Error('an active hazard row carries no data-hazard');
        return hazard;
      })
    );
}

async function orderedHazardValues(page: Page): Promise<(string | null)[]> {
  return allHazardRows(page).evaluateAll((rows) => rows.map((row) => row.getAttribute('data-hazard')));
}

test('the default-boot Drought mode emphasizes the drought cell in all three horizons, and no other hazard', async ({
  page
}) => {
  await stubBaselineBriefingHosts(page);
  await stubSpcFireOutlook(page, {});
  // No `cluster=` param: the app's default committed cluster is Drought
  // (cluster-service.ts's own `!== 'drought'` baseline check), so this
  // case needs no live click and is the fresh-open baseline the next test
  // switches away from.
  await gotoApp(page, '?view=brief&layers=places&select=state:WA');

  await expect(page.locator('.impact-hazard-active')).toHaveCount(3);
  for (const horizon of HORIZON_KEYS) {
    await expect(
      page.locator(`.impact-hazard[data-horizon="${horizon}"][data-hazard="drought"]`)
    ).toHaveClass(/impact-hazard-active/);
    await expect(
      page.locator(`.impact-hazard[data-horizon="${horizon}"][data-hazard="drought"]`)
    ).toHaveAttribute('aria-current', 'true');
  }
  const active = await activeHazardValues(page);
  expect(active).toHaveLength(3);
  expect(new Set(active)).toEqual(new Set(['drought']));
});

test('a live switch to Wildfire mode emphasizes the fire cell in all three horizons (the crosswalk, not a naive key match)', async ({
  page
}) => {
  await stubBaselineBriefingHosts(page);
  await stubSpcFireOutlook(page, {});
  await gotoApp(page, '?view=brief&layers=places&select=state:WA');
  // found-089: the default-boot paint can still be mid-repaint the instant
  // `gotoApp` resolves (`applyActiveHazardEmphasis` re-toggles on every
  // paint, including the loading paint), so a bare `activeHazardValues`
  // read right here raced an empty set about 1 run in 8 on base code too.
  // Settle first, per horizon, on the M20 pattern (waitForSettledHazardRow
  // above), before reading anything.
  for (const horizon of HORIZON_KEYS) {
    await waitForSettledHazardRow(page, 'drought', horizon, SHELL_HAZARD_KEY.drought);
  }
  expect(new Set(await activeHazardValues(page))).toEqual(new Set(['drought']));
  const orderBefore = await orderedHazardValues(page);

  // A naive implementation matching the shell's cluster key ('wildfire')
  // directly against `data-hazard` would emphasize NOTHING once this
  // fires, since the briefing's cells are named 'fire': this is the case
  // that proves the crosswalk (SHELL_HAZARD_KEY) is actually read.
  await clusterBtn(page, 'wildfire').click();

  await expect(page.locator('.impact-hazard-active')).toHaveCount(3);
  for (const horizon of HORIZON_KEYS) {
    await waitForSettledHazardRow(page, 'wildfire', horizon, SHELL_HAZARD_KEY.wildfire);
    await expect(
      page.locator(`.impact-hazard[data-horizon="${horizon}"][data-hazard="fire"]`)
    ).toHaveClass(/impact-hazard-active/);
    await expect(
      page.locator(`.impact-hazard[data-horizon="${horizon}"][data-hazard="fire"]`)
    ).toHaveAttribute('aria-current', 'true');
    // No other hazard in this same horizon carries the emphasis.
    for (const hazard of HAZARD_KEYS) {
      if (hazard === 'fire') continue;
      await expect(
        page.locator(`.impact-hazard[data-horizon="${horizon}"][data-hazard="${hazard}"]`)
      ).not.toHaveClass(/impact-hazard-active/);
    }
  }
  // Re-settle before the fresh, one-round-trip read below: the per-horizon
  // web-first assertions above already retried to a stable state, but
  // `applyActiveHazardEmphasis` can still repaint again between the last of
  // them passing and this `evaluateAll` running, so read only after every
  // horizon is confirmed settled on 'fire' again.
  for (const horizon of HORIZON_KEYS) {
    await waitForSettledHazardRow(page, 'wildfire', horizon, SHELL_HAZARD_KEY.wildfire);
  }
  const active = await activeHazardValues(page);
  expect(active).toHaveLength(3);
  expect(new Set(active)).toEqual(new Set(['fire']));
  // The switch changed exactly the emphasis: row order is untouched
  // (DR-092: never reordered).
  expect(await orderedHazardValues(page)).toEqual(orderBefore);
});

test('the twelve cells keep HAZARD_KEYS order in every horizon regardless of which mode is active (DR-092: never reordered)', async ({
  page
}) => {
  await stubBaselineBriefingHosts(page);
  await stubSpcFireOutlook(page, {});
  await gotoApp(page, '?view=brief&layers=places&select=state:WA');
  await clusterBtn(page, 'wildfire').click();
  // SETUP GUARD, not this test's subject: without it a silently failed click
  // would leave the page in Drought mode and the order check below would still
  // pass, proving nothing about "while a mode is active". If this line is what
  // fails, the defect is in the emphasis, not in row order; the emphasis itself
  // is owned by the two cases above.
  expect(
    new Set(await activeHazardValues(page)),
    'setup: the switch to Wildfire must land before row order is judged'
  ).toEqual(new Set(['fire']));

  const perHorizon = page.locator('.impact-horizons .impact-horizon');
  await expect(perHorizon).toHaveCount(3);
  for (let i = 0; i < 3; i++) {
    const rows = perHorizon.nth(i).locator('.impact-hazard');
    const hazards = await rows.evaluateAll((els) => els.map((el) => el.getAttribute('data-hazard')));
    expect(hazards).toEqual([...HAZARD_KEYS]);
  }
});

test('the emphasis moves on a live mode switch, not only on a fresh open, and stays three cells (one per horizon) throughout', async ({
  page
}) => {
  await stubBaselineBriefingHosts(page);
  await stubSpcFireOutlook(page, {});
  await gotoApp(page, '?view=brief&layers=places&select=state:WA');
  // found-094: the same boot-paint race found-089 fixed above (:672), at
  // this case's first read; red about 1 run in 15 on base and changed code
  // alike (gates/ab-bm755.log). Settle per horizon before reading.
  for (const horizon of HORIZON_KEYS) {
    await waitForSettledHazardRow(page, 'drought', horizon, SHELL_HAZARD_KEY.drought);
  }
  expect(new Set(await activeHazardValues(page))).toEqual(new Set(['drought']));

  await clusterBtn(page, 'wildfire').click();
  await expect(page.locator('.impact-hazard-active')).toHaveCount(3);
  const afterWildfire = await activeHazardValues(page);
  expect(afterWildfire).toHaveLength(3);
  expect(new Set(afterWildfire)).toEqual(new Set(['fire']));

  await clusterBtn(page, 'drought').click();
  await expect(page.locator('.impact-hazard-active')).toHaveCount(3);
  const afterDrought = await activeHazardValues(page);
  expect(afterDrought).toHaveLength(3);
  expect(new Set(afterDrought)).toEqual(new Set(['drought']));
});

test('the long-range Fire cell renders the unavailable form naming the NIFC product, and neither fire cell names WHP', async ({
  page
}) => {
  await stubBaselineBriefingHosts(page);
  await stubSpcFireOutlook(page, {});
  await gotoApp(page, '?view=brief&layers=places&select=state:WA');

  const longRange = page.locator(
    '.impact-hazard[data-horizon="longRange"][data-hazard="fire"]'
  );
  await expect(longRange).toContainText(
    'National Wildland Significant Fire Potential Outlook'
  );
  await expect(longRange).toContainText('PDF only');
  await expect(longRange.locator('.impact-claim')).toHaveCount(0);

  const nearTerm = page.locator(
    '.impact-hazard[data-horizon="nearTerm"][data-hazard="fire"]'
  );
  for (const cell of [nearTerm, longRange]) {
    await expect(cell).not.toContainText('Wildfire Hazard Potential');
    await expect(cell).not.toContainText('WHP');
  }
});

// ---------------------------------------------------------------------------
// M20 (DDM-P7-T10, register item owner-1n, DR-123, RATIFICATION-4 Q9 'a'):
// the four hazard boxes in every horizon compute equal border, padding and
// box-shadow, active or not, first or last; the committed mode keeps its
// tint and a small "your mode" word but draws no edge line.
// ---------------------------------------------------------------------------

/** The horizon keys the shell itself renders, read from its own chips
 * (`.shell-horizon-btn[data-horizon]`) through the same `SHELL_HORIZON_KEY`
 * crosswalk `shell.tsx` reads, rather than a second hardcoded copy of the
 * three horizon keys (DR-113: enumerate what is rendered, never assume a
 * fixed count). */
async function renderedHorizonKeys(page: Page): Promise<HorizonKey[]> {
  const chipKeys = await page
    .locator('.shell-horizon-btn')
    .evaluateAll((buttons) =>
      buttons.map((btn) => {
        const key = btn.getAttribute('data-horizon');
        if (key === null) throw new Error('a horizon chip carries no data-horizon');
        return key;
      })
    );
  expect(chipKeys.length, 'setup: at least one horizon chip must render').toBeGreaterThan(0);
  return chipKeys.map((key) => SHELL_HORIZON_KEY[key as TemporalHorizonKey]);
}

interface HazardRowSnapshot {
  readonly hazard: string | null;
  readonly ariaCurrent: string | null;
  readonly activeClass: boolean;
  readonly borderTop: string;
  readonly paddingTop: number;
  readonly paddingRight: number;
  readonly paddingBottom: number;
  readonly paddingLeft: number;
  readonly boxShadow: string;
  readonly titleId: string | null;
  readonly labelledBy: string | null;
  readonly titleText: string;
  readonly markerVisible: boolean;
  readonly markerText: string;
}

/**
 * Waits until this horizon's rows have settled on the pressed mode, read
 * fresh each poll (never a handle carried across polls): all
 * `HAZARD_KEYS.length` `.impact-hazard` rows for this horizon are in the
 * document, and exactly one of them, matching `expectedHazard`, carries
 * `aria-current="true"`. `applyActiveHazardEmphasis` re-toggles this on every
 * paint, including the loading paint, so this also proves the panel is not
 * mid-repaint at the moment the settled read below happens.
 */
async function waitForSettledHazardRow(
  page: Page,
  cluster: HazardClusterKey,
  horizon: HorizonKey,
  expectedHazard: string
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ horizon, count }) => {
            const rows = Array.from(
              document.querySelectorAll<HTMLElement>(`.impact-hazard[data-horizon="${horizon}"]`)
            );
            if (rows.length !== count) return null;
            const active = rows.filter((row) => row.getAttribute('aria-current') === 'true');
            if (active.length !== 1) return null;
            return active[0]!.getAttribute('data-hazard');
          },
          { horizon, count: HAZARD_KEYS.length }
        ),
      { message: `${cluster}/${horizon}: settle on ${expectedHazard}` }
    )
    .toBe(expectedHazard);
}

/**
 * A fresh, single-round-trip read of every `.impact-hazard` row for one
 * horizon: computed border, padding, box-shadow, class/attribute state, and
 * the "your mode" marker's visibility and text. Querying and reading happen
 * inside ONE `page.evaluate` call, so no node can be replaced between a
 * selector resolving and the read running: `paint()`
 * (`impact-panel-runtime.ts`) replaces `bodyEl.innerHTML` wholesale on every
 * hydration step, and a `Locator.evaluate()`/`evaluateAll()` call resolves
 * its element(s) in one round trip and reads them in a second, a window in
 * which a repaint can detach the very node about to be read, computing an
 * empty box-shadow and an unparsable NaN padding (the failure this
 * replaces).
 */
async function readHazardRows(page: Page, horizon: HorizonKey): Promise<HazardRowSnapshot[]> {
  return page.evaluate((horizon) => {
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>(`.impact-hazard[data-horizon="${horizon}"]`)
    );
    const isVisible = (el: HTMLElement): boolean => {
      if (el.hidden) return false;
      if (el.getClientRects().length === 0) return false;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
      if (cs.display === 'none') return false;
      if (parseFloat(cs.opacity) === 0) return false;
      return true;
    };
    return rows.map((el) => {
      const cs = getComputedStyle(el);
      const title = el.querySelector<HTMLElement>('.impact-hazard-title');
      const marker = el.querySelector<HTMLElement>('.impact-hazard-you');
      return {
        hazard: el.getAttribute('data-hazard'),
        ariaCurrent: el.getAttribute('aria-current'),
        activeClass: el.classList.contains('impact-hazard-active'),
        borderTop: `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`,
        paddingTop: parseFloat(cs.paddingTop),
        paddingRight: parseFloat(cs.paddingRight),
        paddingBottom: parseFloat(cs.paddingBottom),
        paddingLeft: parseFloat(cs.paddingLeft),
        boxShadow: cs.boxShadow,
        titleId: title ? title.id : null,
        labelledBy: el.getAttribute('aria-labelledby'),
        titleText: title ? title.innerText : '',
        markerVisible: marker ? isVisible(marker) : false,
        markerText: marker ? (marker.textContent ?? '') : ''
      };
    });
  }, horizon);
}

test("the four hazard boxes in every horizon compute equal border, padding and box-shadow, and their text starts at least 12 px from the row's left edge", async ({
  page
}) => {
  await stubBaselineBriefingHosts(page);
  await stubSpcFireOutlook(page, {});
  await gotoApp(page, '?view=brief&layers=places&select=state:WA');

  const horizons = await renderedHorizonKeys(page);

  // Every HAZARD_CLUSTER_KEYS mode (DR-113), not just the default boot: the
  // default Drought boot puts the active row FIRST in each horizon
  // (HAZARD_KEYS[0] === 'drought'), exactly where the pre-fix
  // `.impact-hazard:first-child` override and the active box-shadow used to
  // collide, so a check limited to that one mode would not prove parity for
  // a middle or last active row.
  for (const cluster of HAZARD_CLUSTER_KEYS) {
    await clusterBtn(page, cluster).click();
    const expectedHazard = SHELL_HAZARD_KEY[cluster];
    for (const horizon of horizons) {
      await waitForSettledHazardRow(page, cluster, horizon, expectedHazard);
      const rows = await readHazardRows(page, horizon);
      if (rows.length !== HAZARD_KEYS.length) {
        throw new Error(
          `${cluster}/${horizon}: expected ${HAZARD_KEYS.length} hazard rows, found ${rows.length}`
        );
      }
      const [first, ...rest] = rows;
      for (const row of rest) {
        expect(row.borderTop, `${cluster}/${horizon}: border-top parity`).toBe(first!.borderTop);
        expect(
          {
            top: row.paddingTop,
            right: row.paddingRight,
            bottom: row.paddingBottom,
            left: row.paddingLeft
          },
          `${cluster}/${horizon}: padding parity`
        ).toEqual({
          top: first!.paddingTop,
          right: first!.paddingRight,
          bottom: first!.paddingBottom,
          left: first!.paddingLeft
        });
        expect(row.boxShadow, `${cluster}/${horizon}: box-shadow parity`).toBe(first!.boxShadow);
      }
      for (const row of rows) {
        expect(row.paddingLeft, `${cluster}/${horizon}: left gutter`).toBeGreaterThanOrEqual(12);
      }
    }
  }
});

test('the committed-mode row names itself in words and draws no edge line', async ({ page }) => {
  await stubBaselineBriefingHosts(page);
  await stubSpcFireOutlook(page, {});
  await gotoApp(page, '?view=brief&layers=places&select=state:WA');

  const horizons = await renderedHorizonKeys(page);

  for (const cluster of HAZARD_CLUSTER_KEYS) {
    await clusterBtn(page, cluster).click();
    const expectedHazard = SHELL_HAZARD_KEY[cluster];
    for (const horizon of horizons) {
      await waitForSettledHazardRow(page, cluster, horizon, expectedHazard);
      const rows = await readHazardRows(page, horizon);
      if (rows.length !== HAZARD_KEYS.length) {
        throw new Error(
          `${cluster}/${horizon}: expected ${HAZARD_KEYS.length} hazard rows, found ${rows.length}`
        );
      }

      const activeRows = rows.filter((row) => row.activeClass);
      if (activeRows.length !== 1) {
        throw new Error(
          `${cluster}/${horizon}: expected exactly one .impact-hazard-active row, found ${activeRows.length}`
        );
      }
      const active = activeRows[0]!;

      // Draws no edge line: DR-123 removes the inset box-shadow RULINGS.md
      // B2 (a) named ("the inset accent line is removed").
      expect(active.boxShadow, `${cluster}/${horizon}: no inset accent`).toBe('none');

      // Names itself in words: the row's own marker is visible text, once,
      // on this row only.
      expect(active.markerVisible, `${cluster}/${horizon}: marker visible`).toBe(true);
      expect(active.markerText, `${cluster}/${horizon}: marker text`).toBe('your mode');

      // The section's accessible name (aria-labelledby -> the <h4>) still
      // reads just the hazard label: the marker lives outside that
      // element, so the word never doubles into the name a screen reader
      // announces for the row's heading or region.
      expect(active.labelledBy, `${cluster}/${horizon}: labelledby`).toBe(active.titleId);
      expect(active.titleText, `${cluster}/${horizon}: title text`).not.toContain('your mode');

      // Exactly one row per horizon carries the marker and the emphasis;
      // the other three show neither (DR-092: one mode-to-row lookup).
      const others = rows.filter((row) => !row.activeClass);
      expect(others.length, `${cluster}/${horizon}: other row count`).toBe(HAZARD_KEYS.length - 1);
      for (const other of others) {
        expect(other.ariaCurrent, `${cluster}/${horizon}: ${other.hazard} aria-current`).not.toBe(
          'true'
        );
        expect(other.markerVisible, `${cluster}/${horizon}: ${other.hazard} marker hidden`).toBe(
          false
        );
      }
    }
  }
});

// ---------------------------------------------------------------------------
// found-022 (S30D D1 M27): a briefing chart's labels render at one CSS size
// at every desktop viewport. The size is read in RENDERED pixels (each SVG
// text element's bounding box height, which carries the viewBox scale;
// codex C2), never getComputedStyle(text).fontSize, which stays at the SVG
// unit size however far the viewBox stretches it. The chart is a real one:
// a two-point DSCI series answers the WA drought-severity lane (codex C6).
// ---------------------------------------------------------------------------

test('chart label text renders at a fixed CSS size within 1 px at 1280x720, 1440x900 and 2560x1440', async ({
  page
}) => {
  await stubBaselineBriefingHosts(page);
  await stubSpcFireOutlook(page, {});
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 84);
  const isoDay = (d: Date): string => d.toISOString().slice(0, 10);
  // Registered after the generic proxy stub, so it wins for this one call.
  await page.route('**/proxy?url=*GetDSCI*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { mapDate: isoDay(start), dsci: 200 },
        { mapDate: isoDay(end), dsci: 210 }
      ])
    })
  );

  const heights: Record<string, number[]> = {};
  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 1440, height: 900 },
    { width: 2560, height: 1440 }
  ]) {
    await page.setViewportSize(viewport);
    await gotoApp(page, '?view=brief&layers=places&select=state:WA');
    const chart = page.locator('#impact-panel .impact-claim-chart svg.ddm-chart[aria-label*="DSCI"]').first();
    await expect(chart).toBeVisible({ timeout: 15_000 });
    // Fonts first, outside the read: a read that awaits inside evaluate can
    // outlive the SVG it resolved when the briefing re-renders its chart,
    // and a detached SVG measures 0 px. The poll gates on layout only, so a
    // label size difference still fails the comparison below.
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    let reading = { width: 0, texts: [] as number[] };
    await expect
      .poll(
        async () => {
          reading = await chart.evaluate((svg) => ({
            width: svg.getBoundingClientRect().width,
            texts: Array.from(svg.querySelectorAll('text')).map((t) => t.getBoundingClientRect().height)
          }));
          return reading.width > 0 && reading.texts.length > 0 && reading.texts.every((h) => h > 0);
        },
        { timeout: 10_000, message: `${viewport.width}: a laid-out chart that draws its labels` }
      )
      .toBe(true);
    heights[`${viewport.width}x${viewport.height} (chart ${reading.width.toFixed(0)} px wide)`] = reading.texts;
  }

  const runs = Object.values(heights);
  const detail = JSON.stringify(heights);
  for (let i = 0; i < runs[0]!.length; i += 1) {
    const sizes = runs.map((run) => run[i]!);
    expect(Math.max(...sizes) - Math.min(...sizes), `label ${i}: ${detail}`).toBeLessThanOrEqual(1);
  }
});
