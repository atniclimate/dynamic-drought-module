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
import { gotoApp } from './helpers';

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
    evidence: 'observed',
    dates: { retrieved: '2026-09-03' },
    hazards: ['fire']
  });
  const both = makeClaim({
    // vocab-allow: reports the absence of upstream NWS alert products
    text: 'No active red-flag fire-weather or extreme-heat alerts here.',
    source: 'nwsAlerts',
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
    evidence: 'derived',
    dates: { retrieved: '2026-09-03' },
    horizon: 'current'
  });
  const seasonAhead = makeClaim({
    text: 'The seasonal tendency.',
    source: 'enso',
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
  // DDM-P7-T03: the near-term fire cell now holds a live SPC lane, so every
  // one of the eight Day 1-8 layer queries needs a deterministic empty
  // answer here (an unstubbed request would otherwise reach the live
  // agency, S17's lesson). An empty FeatureCollection is the honest "no
  // area is drawn" case, not an error.
  await page.route('**/SPC_firewx/MapServer/*/query?*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: collection([])
    })
  );

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

/**
 * Route every SPC fire weather outlook layer query
 * (`spcFireWeatherOutlookMapServer`, the SPC_firewx MapServer) to a
 * deterministic fixture, keyed by ArcGIS layer id (1 Day 1, 4 Day 2, 8/11/
 * 14/17/20/23 Days 3-8). A layer with no entry in `layerFeatures` answers
 * with an empty FeatureCollection, the honest "no area drawn" case. Modeled
 * on the `stubCpcSeasonalTempOutlook` precedent in tests/helpers.ts (read,
 * not edited: this task owns only this spec file).
 */
async function stubSpcFireOutlook(
  page: Page,
  layerFeatures: Partial<Record<number, unknown[]>>,
  options: { readonly httpStatus?: number; readonly errorEnvelope?: boolean } = {}
): Promise<void> {
  await page.route('**/SPC_firewx/MapServer/*/query?*', async (route) => {
    if (options.httpStatus !== undefined && options.httpStatus !== 200) {
      await route.fulfill({
        status: options.httpStatus,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'stubbed upstream failure' })
      });
      return;
    }
    if (options.errorEnvelope) {
      await route.fulfill({
        status: 200,
        contentType: 'text/plain',
        body: JSON.stringify({
          status: 'error',
          messages: ['Could not access any server machines.']
        })
      });
      return;
    }
    const url = new URL(route.request().url());
    const layerMatch = /\/MapServer\/(\d+)\/query/.exec(url.pathname);
    const layer = layerMatch ? Number(layerMatch[1]) : NaN;
    await route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: collection(layerFeatures[layer] ?? [])
    });
  });
}

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
  // The issuer's public word (about.html), never the renderer's "Extreme".
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
  // Days 5, 6 and 7 drew no probabilistic feature and fold into one sentence.
  await expect(cell).toContainText(
    'SPC Day 3-8 Fire Weather Outlook: no area is drawn over this point for Days 5, 6 and 7.'
  );
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
