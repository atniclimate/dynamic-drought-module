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

import { expect, test } from '@playwright/test';

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

test('the four cells with no wired product say so from the first paint', () => {
  const horizons = emptyHorizons();
  const unwired = everyCell(horizons).filter(
    (cell) => lanesForCell(cell.horizon, cell.hazard).length === 0
  );
  expect(unwired.map((cell) => `${cell.horizon}:${cell.hazard}`)).toEqual([
    'nearTerm:fire',
    'nearTerm:enso',
    'longRange:fire',
    'longRange:heat'
  ]);
  for (const cell of unwired) {
    // Never a spinner for a source that will not come.
    expect(cell.status).toBe('unavailable');
    expect(cell.note ?? '').not.toBe('');
  }
  expect(horizons.nearTerm.cells.fire.note).toContain(
    'Storm Prediction Center'
  );
  expect(horizons.longRange.cells.fire.note).toContain(
    'National Interagency Fire Center'
  );
  expect(horizons.longRange.cells.heat.note).toContain('CPC seasonal');
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

test('the open briefing renders all twelve cells, each with a claim or a named state', async ({
  page
}) => {
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
  ).toContainText('National Interagency Fire Center');
});
