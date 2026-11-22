// The model cases of briefing-matrix.spec.ts, moved here because they open no page and so run in the pure lane.
import { expect, test } from './offline-test';

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
  bcws: 'bcws-fires',
  liveFuelMoisture: 'live-fuel-moisture',
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

/**
 * A distinct valid date per lane (S30D P3-TRUTH, the second verifier's "weak
 * tests" finding: every lane used to carry the same '2026-09-03', so a cell
 * holding another lane's clock could not be told apart). Derived from the
 * lane's position in MATRIX_LANE_KEYS, so a new lane gets its own day.
 */
const LANE_VALID_DATE: Readonly<Record<MatrixLaneKey, string>> = Object.fromEntries(
  MATRIX_LANE_KEYS.map((lane, index) => [lane, `2026-09-${String(index + 1).padStart(2, '0')}`])
) as Record<MatrixLaneKey, string>;

/** One answered lane whose single claim names the lane as its issuer and
 * carries the lane's own valid date. */
function lanePayload(lane: MatrixLaneKey): MatrixLaneResult {
  return {
    ok: true,
    claims: [
      makeClaim({
        text: `A sourced statement from ${lane}.`,
        source: lane,
        product: LANE_PRODUCT[lane],
        evidence: 'analyzed',
        dates: { valid: LANE_VALID_DATE[lane] }
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
  // Twelve lanes, twelve distinct clocks: the clock check below is only a
  // check if no two lanes share a day.
  expect(new Set(Object.values(LANE_VALID_DATE)).size).toBe(MATRIX_LANE_KEYS.length);
  let checked = 0;
  for (const cell of everyCell(horizons)) {
    const declared = lanesForCell(cell.horizon, cell.hazard);
    for (const claim of cell.claims) {
      expect(
        declared.includes(claim.source as MatrixLaneKey),
        `${cell.horizon}:${cell.hazard} holds a claim issued by ${claim.source}`
      ).toBe(true);
      // The clock, per claim: the claim's valid date is its own lane's, and
      // that lane is one declared for this cell.
      expect(
        claim.dates?.valid,
        `${cell.horizon}:${cell.hazard} claim from ${claim.source} wears another lane's clock`
      ).toBe(LANE_VALID_DATE[claim.source as MatrixLaneKey]);
      expect(
        declared.map((lane) => LANE_VALID_DATE[lane]),
        `${cell.horizon}:${cell.hazard} holds a clock no declared lane carries`
      ).toContain(claim.dates?.valid);
      checked += 1;
    }
  }
  expect(checked, 'setup: the answered matrix holds claims to check').toBeGreaterThan(0);
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
    text: 'No active red-flag fire-weather or heat alerts here.',
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
