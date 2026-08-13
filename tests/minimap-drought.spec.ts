import { expect, test } from '@playwright/test';

import {
  deriveMinimapDroughtSnapshot,
  droughtAverageClassForScore,
} from '../src/state/minimap-drought';
import {
  FRAMING_ANALYSIS_AREAS,
  FRAMING_SHAPES,
} from '../src/config/framing-shapes';

const LAND_FIXTURE = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { FIPS_CNTRY: 'US' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-180, 10],
            [-40, 10],
            [-40, 85],
            [-180, 85],
            [-180, 10],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      properties: { FIPS_CNTRY: 'US' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [172, 52],
            [174, 52],
            [174, 54],
            [172, 54],
            [172, 52],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      properties: { FIPS_CNTRY: 'CA' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-142, 41],
            [-51, 41],
            [-51, 85],
            [-142, 85],
            [-142, 41],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      properties: { FIPS_CNTRY: 'MX' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-120, 14],
            [-85, 14],
            [-85, 34],
            [-120, 34],
            [-120, 14],
          ],
        ],
      },
    },
  ],
};

const ANALYSIS_EXCLUSION_FIXTURE = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { PRUID: '62' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-100, 68],
            [-90, 68],
            [-90, 75],
            [-100, 75],
            [-100, 68],
          ],
        ],
      },
    },
  ],
};

function feature(
  droughtClass: string,
  month: string,
  coordinates: number[][][],
) {
  return {
    type: 'Feature',
    properties: { DROUGHTCAT: droughtClass, YEAR_MONTH: month },
    geometry: { type: 'Polygon', coordinates },
  };
}

test.describe('North American minimap drought summaries', () => {
  test('rounds the ordinal mean to the nearest class with half ties less severe', () => {
    expect(droughtAverageClassForScore(0)).toBe('none');
    expect(droughtAverageClassForScore(0.5)).toBe('none');
    expect(droughtAverageClassForScore(0.500_001)).toBe('D0');
    expect(droughtAverageClassForScore(1.5)).toBe('D0');
    expect(droughtAverageClassForScore(1.500_001)).toBe('D1');
    expect(droughtAverageClassForScore(4.5)).toBe('D3');
    expect(droughtAverageClassForScore(4.500_001)).toBe('D4');
    expect(droughtAverageClassForScore(5)).toBe('D4');
  });

  test('uses the largest area share and preserves None as a real white-ramp class', () => {
    const snapshot = deriveMinimapDroughtSnapshot(
      {
        type: 'FeatureCollection',
        features: [
          feature('d3', '202607', [
            [
              [-132, 37],
              [-112, 37],
              [-112, 57],
              [-132, 57],
              [-132, 37],
            ],
          ]),
        ],
      },
      LAND_FIXTURE,
      ANALYSIS_EXCLUSION_FIXTURE,
    );

    expect(snapshot.status).toBe('live');
    expect(snapshot.month).toBe('2026-07');
    expect(snapshot.summaries['pacific-coast']?.dominant).toBe('D3');
    expect(
      snapshot.summaries['pacific-coast']?.dominantPercent,
    ).toBeGreaterThan(50);
    expect(snapshot.summaries.hawaii?.dominant).toBe('none');
    expect(snapshot.summaries.hawaii?.averageSeverityScore).toBe(0);
    expect(snapshot.summaries.hawaii?.averageClass).toBe('none');
    expect(snapshot.summaries.hawaii?.dryOrDroughtPercent).toBe(0);
  });

  test('uses cosine latitude weights for a regional ordinal mean while retaining mode and impact fields', () => {
    const snapshot = deriveMinimapDroughtSnapshot(
      {
        type: 'FeatureCollection',
        features: [
          feature('d4', '202607', [
            [
              [-119, 23.5],
              [-86, 23.5],
              [-86, 33],
              [-119, 33],
              [-119, 23.5],
            ],
          ]),
        ],
      },
      LAND_FIXTURE,
      ANALYSIS_EXCLUSION_FIXTURE,
    );

    const mexico = snapshot.summaries.mexico;
    expect(mexico).toBeDefined();
    expect(mexico?.dominant).toBe('none');
    expect(mexico?.averageSeverityScore).toBeLessThan(2.5);
    expect(mexico?.averageSeverityScore).toBeCloseTo(2.4, 1);
    expect(mexico?.averageClass).toBe('D1');
    expect(mexico?.distribution.none).toBeGreaterThan(50);
    expect(mexico?.distribution.D4).toBeLessThan(50);
    expect(mexico?.droughtPercent).toBe(mexico?.distribution.D4);
    expect(mexico?.dryOrDroughtPercent).toBe(mexico?.distribution.D4);
    expect(mexico?.coverage).toBe('live');
  });

  test('marks the far-north estimate partial and rejects mixed source months', () => {
    const valid = deriveMinimapDroughtSnapshot(
      {
        type: 'FeatureCollection',
        features: [
          feature('d0', '202607', [
            [
              [-180, 10],
              [-40, 10],
              [-40, 80],
              [-180, 80],
              [-180, 10],
            ],
          ]),
        ],
      },
      LAND_FIXTURE,
      ANALYSIS_EXCLUSION_FIXTURE,
    );
    expect(valid.summaries['boreal-arctic']?.coverage).toBe('live-partial');

    expect(() =>
      deriveMinimapDroughtSnapshot(
        {
          type: 'FeatureCollection',
          features: [
            feature('d0', '202607', [
              [
                [-125, 40],
                [-120, 40],
                [-120, 45],
                [-125, 45],
                [-125, 40],
              ],
            ]),
            feature('d1', '202606', [
              [
                [-110, 35],
                [-105, 35],
                [-105, 40],
                [-110, 40],
                [-110, 35],
              ],
            ]),
          ],
        },
        LAND_FIXTURE,
        ANALYSIS_EXCLUSION_FIXTURE,
      ),
    ).toThrow(/mixes consensus months/);
  });

  test('removes the Nunavut proxy from both drought and None shares', () => {
    const snapshot = deriveMinimapDroughtSnapshot(
      {
        type: 'FeatureCollection',
        features: [
          feature('d4', '202607', [
            [
              [-100, 68],
              [-90, 68],
              [-90, 75],
              [-100, 75],
              [-100, 68],
            ],
          ]),
        ],
      },
      LAND_FIXTURE,
      ANALYSIS_EXCLUSION_FIXTURE,
    );

    expect(snapshot.summaries['boreal-arctic']?.coverage).toBe('live-partial');
    expect(snapshot.summaries['boreal-arctic']?.distribution.D4).toBe(0);
    expect(
      snapshot.summaries['boreal-arctic']?.notAnalyzedPercent,
    ).toBeGreaterThan(0);
    expect(
      snapshot.summaries['boreal-arctic']?.excludedSamples,
    ).toBeGreaterThan(0);
  });

  test('includes southern Mexico and the wrapped western Aleutians in analysis coverage', () => {
    const snapshot = deriveMinimapDroughtSnapshot(
      {
        type: 'FeatureCollection',
        features: [
          feature('d3', '202607', [
            [
              [-100, 14],
              [-86, 14],
              [-86, 17.4],
              [-100, 17.4],
              [-100, 14],
            ],
          ]),
          feature('d4', '202607', [
            [
              [172.4, 52.4],
              [173.5, 52.4],
              [173.5, 53.4],
              [172.4, 53.4],
              [172.4, 52.4],
            ],
          ]),
        ],
      },
      LAND_FIXTURE,
      ANALYSIS_EXCLUSION_FIXTURE,
    );

    expect(snapshot.summaries.mexico?.distribution.D3).toBeGreaterThan(0);
    expect(
      snapshot.summaries['alaska-northwest']?.distribution.D4,
    ).toBeGreaterThan(0);
  });

  test('analysis areas reach the authored extent without the Arctic lobe', () => {
    const mexicoSouth = Math.min(
      ...FRAMING_SHAPES.mexico.map((point) => point[1]),
    );
    const alaskaWest = Math.min(
      ...(FRAMING_ANALYSIS_AREAS['alaska-northwest'] ?? []).flatMap((area) =>
        area.shape.map((point) => point[0]),
      ),
    );
    const canadaNorth = Math.max(
      ...(FRAMING_ANALYSIS_AREAS['boreal-arctic'] ?? []).flatMap((area) =>
        area.shape.map((point) => point[1]),
      ),
    );
    const canadaEast = Math.max(
      ...(FRAMING_ANALYSIS_AREAS['eastern-forests'] ?? []).flatMap((area) =>
        area.shape.map((point) => point[0]),
      ),
    );

    expect(mexicoSouth).toBeLessThan(15);
    expect(alaskaWest).toBeLessThanOrEqual(-188);
    expect(canadaNorth).toBeGreaterThanOrEqual(71);
    expect(canadaNorth).toBeLessThanOrEqual(72);
    expect(canadaEast).toBeGreaterThanOrEqual(-52);
  });
});
