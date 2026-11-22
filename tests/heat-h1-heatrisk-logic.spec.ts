// Page-free tests moved from heat-h1-heatrisk.spec.ts: they never open a page, so they run in the pure lane.
import { expect, test } from './offline-test';

import { HEATRISK_CATEGORIES } from '../src/config/palette';
import { makeClaim } from '../src/impact/evidence';
import { HORIZON_CHROME } from '../src/impact/horizon-chrome';
import { fillCell } from '../src/impact/matrix';
import type { MatrixLaneKey, MatrixLaneResult } from '../src/impact/matrix';
import type { HazardCell } from '../src/impact/types';
import { createHeatRiskSequenceLoader } from '../src/ui/heatrisk-sequence-loader';

// DDM-P8-T03 (R2, 2026-09-07): the second half of this test used to pin
// TEMPORAL_HORIZON_LABELS['weeks-ahead'] to 'next seven days'. That table
// had zero production consumers and was removed under R1 (horizon-chrome.ts
// is now the single horizon-name source for the whole interface); this pin
// is re-pointed at HORIZON_CHROME, the new source, at the same strength
// (exact string equality) rather than dropped.
test('the issuer HeatRisk table and the near-term horizon heading are exact and centralized', () => {
  expect(HEATRISK_CATEGORIES).toEqual([
    {
      value: 0,
      label: 'Little to None',
      color: '#E8F9E7',
      meaning: 'This level of heat poses little to no risk from expected heat.'
    },
    {
      value: 1,
      label: 'Minor',
      color: '#F4F257',
      meaning:
        'This level of heat affects primarily those individuals extremely sensitive to heat, especially when outdoors without effective cooling and/or adequate hydration.'
    },
    {
      value: 2,
      label: 'Moderate',
      color: '#F69632',
      meaning:
        'This level of heat affects most individuals sensitive to heat, especially those without effective cooling and/or adequate hydration. Impacts possible in some health systems and in heat-sensitive industries.'
    },
    {
      value: 3,
      label: 'Major',
      color: '#E22F33',
      meaning:
        'This level of heat affects anyone without effective cooling and/or adequate hydration. Impacts likely in some health systems, heat-sensitive industries and infrastructure.'
    },
    {
      value: 4,
      label: 'Extreme',
      color: '#7A0E7F',
      meaning:
        'This level of rare and/or long-duration extreme heat with little to no overnight relief affects anyone without effective cooling and/or adequate hydration. Impacts likely in most health systems, heat-sensitive industries and infrastructure.'
    }
  ]);
  expect(HORIZON_CHROME.nearTerm.subtitle).toBe('days to weeks');
});

test.describe('review regressions for HeatRisk honesty and lifecycle', () => {
  test('review regression: applies an inactive snapshot when the sequence chunk finishes late', async () => {
    let release: (module: {
      readonly mountHeatRiskSequence: (detail: {
        readonly status: string;
      }) => void;
    }) => void = () => {};
    const loaded = new Promise<{
      readonly mountHeatRiskSequence: (detail: {
        readonly status: string;
      }) => void;
    }>((resolve) => {
      release = resolve;
    });
    const mountedStatuses: string[] = [];
    const loader = createHeatRiskSequenceLoader(
      () => loaded,
      (err) => {
        throw err;
      }
    );

    loader.apply({
      status: 'ready',
      frames: [],
      selectedDay: 3,
      hasCoverage: true
    });
    loader.apply({
      status: 'inactive',
      frames: [],
      selectedDay: null,
      hasCoverage: null
    });
    release({
      mountHeatRiskSequence: (detail) => {
        mountedStatuses.push(detail.status);
      }
    });
    await loaded;
    await Promise.resolve();

    expect(mountedStatuses).toEqual(['inactive']);
  });

  // The note this case guards moved from the horizon to the Heat near-term
  // cell when the briefing became a four-hazard by three-horizon matrix
  // (DDM-P7-T02): a HeatRisk failure is the Heat row's business and no longer
  // speaks for the drought row beside it.
  test('review regression: clears the prior source failure note after a successful recomputation', () => {
    const cell: HazardCell = {
      hazard: 'heat',
      horizon: 'nearTerm',
      label: 'Heat',
      status: 'loading',
      claims: []
    };
    const failure: MatrixLaneResult = {
      ok: false,
      claims: [],
      note:
        'The National Weather Service HeatRisk classification did not respond.'
    };
    fillCell(cell, new Map<MatrixLaneKey, MatrixLaneResult>([['heatRisk', failure]]));
    expect(cell.note).toBe(
      'The National Weather Service HeatRisk classification did not respond.'
    );

    const answered: MatrixLaneResult = {
      ok: true,
      claims: [
        makeClaim({
          text: 'HeatRisk (Experimental) value 2, Moderate, at the selected point.',
          source: 'National Weather Service HeatRisk (Experimental)',
          product: 'heatrisk',
          evidence: 'classified',
          dates: { valid: '2026-08-03' }
        })
      ]
    };
    fillCell(
      cell,
      new Map<MatrixLaneKey, MatrixLaneResult>([
        ['heatRisk', answered],
        ['nwsForecast', { ok: true, claims: [] }]
      ])
    );
    expect(cell.note).toBeUndefined();
    expect(cell.status).toBe('ready');
  });
});
