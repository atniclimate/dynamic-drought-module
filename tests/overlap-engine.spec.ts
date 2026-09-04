import { expect, test } from '@playwright/test';
import type { Feature, FeatureCollection, Geometry, MultiPolygon, Polygon } from 'geojson';

import {
  computeOverlapRows,
  OVERLAP_SLIVER_SHARE
} from '../src/ui/island/overlap-engine';

const rectangle = (west: number, south: number, east: number, north: number): Polygon => ({
  type: 'Polygon',
  coordinates: [[
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south]
  ]]
});

const feature = (id: string, geometry: Geometry | null): Feature<Geometry | null> => ({
  type: 'Feature',
  id,
  properties: { id },
  geometry
});

const collection = (
  ...features: Array<Feature<Geometry | null>>
): FeatureCollection<Geometry | null> => ({
  type: 'FeatureCollection',
  features
});

const invalidPolygonComponents: ReadonlyArray<{
  readonly name: string;
  readonly coordinates: Polygon['coordinates'];
}> = [
  {
    name: 'a self-touching spike',
    coordinates: [[
      [10, 0],
      [14, 0],
      [14, 4],
      [12, 2],
      [10, 4],
      [12, 2],
      [10, 0]
    ]]
  },
  {
    name: 'a collinear ring',
    coordinates: [[[10, 0], [12, 2], [14, 4], [10, 0]]]
  },
  {
    name: 'a sub-minimum ring',
    coordinates: [[[10, 0], [11, 1], [10, 0]]]
  }
];

test.describe('computeOverlapRows', () => {
  test('classifies a selected geometry fully within a candidate', () => {
    const selected = rectangle(0, 0, 4, 4);
    const candidate = feature('outer', rectangle(-2, -2, 6, 6));

    const result = computeOverlapRows(selected, collection(candidate));

    expect(result.hasSuppressedSlivers).toBe(false);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.candidate).toBe(candidate);
    expect(result.rows[0]?.relationship).toBe('within');
    expect(result.rows[0]?.evidence.shareOfSelectedArea).toBeCloseTo(1, 12);
    expect(result.rows[0]?.evidence.shareOfCandidateArea).toBeGreaterThan(0);
    expect(result.rows[0]?.evidence.shareOfCandidateArea).toBeLessThan(1);
    expect(result.rows[0]?.evidence.shareOfSmallerArea).toBeCloseTo(1, 12);
  });

  test('classifies a candidate fully contained by the selected geometry', () => {
    const selected = rectangle(-2, -2, 6, 6);
    const candidate = feature('inner', rectangle(0, 0, 4, 4));

    const result = computeOverlapRows(selected, collection(candidate));

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.relationship).toBe('contains');
    expect(result.rows[0]?.evidence.shareOfCandidateArea).toBeCloseTo(1, 12);
    expect(result.rows[0]?.evidence.shareOfSelectedArea).toBeGreaterThan(0);
    expect(result.rows[0]?.evidence.shareOfSelectedArea).toBeLessThan(1);
    expect(result.rows[0]?.evidence.intersectionAreaSquareMetres).toBeCloseTo(
      result.rows[0]?.evidence.candidateAreaSquareMetres ?? 0,
      4
    );
  });

  test('classifies a material partial intersection as overlaps with complete evidence', () => {
    const selected = rectangle(0, 0, 10, 5);
    const candidate = feature('partial', rectangle(5, 0, 15, 5));

    const result = computeOverlapRows(selected, collection(candidate));
    const row = result.rows[0];

    expect(row?.relationship).toBe('overlaps');
    expect(row?.evidence.shareOfSelectedArea).toBeCloseTo(0.5, 12);
    expect(row?.evidence.shareOfCandidateArea).toBeCloseTo(0.5, 12);
    expect(row?.evidence.shareOfSmallerArea).toBeCloseTo(0.5, 12);
    expect(row?.evidence.selectedAreaSquareMetres).toBeGreaterThan(0);
    expect(row?.evidence.candidateAreaSquareMetres).toBeGreaterThan(0);
    expect(row?.evidence.intersectionAreaSquareMetres).toBeGreaterThan(0);
  });

  test('suppresses a sliver immediately below 2.0 percent of the smaller area', () => {
    const selected = rectangle(0, 0, 10, 5);
    const candidate = feature('below', rectangle(9.8001, 0, 19.8001, 5));

    const result = computeOverlapRows(selected, collection(candidate));

    expect(OVERLAP_SLIVER_SHARE).toBe(0.02);
    expect(result.rows).toEqual([]);
    expect(result.hasSuppressedSlivers).toBe(true);
  });

  test('keeps an overlap exactly at 2.0 percent of the smaller area', () => {
    const selected = rectangle(0, 0, 10, 5);
    const candidate = feature('boundary', rectangle(9.8, 0, 19.8, 5));

    const result = computeOverlapRows(selected, collection(candidate));

    expect(result.hasSuppressedSlivers).toBe(false);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.relationship).toBe('overlaps');
    expect(result.rows[0]?.evidence.shareOfSmallerArea).toBeCloseTo(0.02, 12);
  });

  test('keeps an overlap immediately above 2.0 percent of the smaller area', () => {
    const selected = rectangle(0, 0, 10, 5);
    const candidate = feature('above', rectangle(9.7999, 0, 19.7999, 5));

    const result = computeOverlapRows(selected, collection(candidate));

    expect(result.hasSuppressedSlivers).toBe(false);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.evidence.shareOfSmallerArea).toBeGreaterThan(0.02);
  });

  test('sets the suppression flag while retaining material rows and candidate order', () => {
    const selected = rectangle(0, 0, 10, 5);
    const material = feature('material', rectangle(5, 0, 15, 5));
    const sliver = feature('sliver', rectangle(9.9, 0, 19.9, 5));
    const contained = feature('contained', rectangle(1, 1, 2, 2));

    const result = computeOverlapRows(selected, collection(material, sliver, contained));

    expect(result.rows.map((row) => row.candidate.id)).toEqual(['material', 'contained']);
    expect(result.hasSuppressedSlivers).toBe(true);
  });

  test('rejects malformed candidates and omits null and non-areal ones', () => {
    const selected = rectangle(0, 0, 10, 10);
    const empty: Polygon = { type: 'Polygon', coordinates: [] };
    const zeroArea: Polygon = {
      type: 'Polygon',
      coordinates: [[[1, 1], [2, 2], [3, 3], [1, 1]]]
    };
    const selfTouching: Polygon = {
      type: 'Polygon',
      coordinates: [[
        [1, 1],
        [5, 1],
        [5, 5],
        [3, 3],
        [1, 5],
        [3, 3],
        [1, 1]
      ]]
    };

    // IB-10: a malformed candidate is NAMED as unusable, while a null or
    // non-areal candidate stays silently omitted. Before this fix both
    // collapsed into the same silent omission, so a broken geometry looked
    // exactly like a point.
    const emptyCandidate = feature('empty', empty);
    const zeroCandidate = feature('zero', zeroArea);
    const selfTouchingCandidate = feature('self-touching', selfTouching);
    const result = computeOverlapRows(selected, collection(
      emptyCandidate,
      zeroCandidate,
      selfTouchingCandidate,
      feature('null', null),
      feature('point', { type: 'Point', coordinates: [2, 2] })
    ));

    expect(result).toEqual({
      rows: [],
      hasSuppressedSlivers: false,
      rejections: [
        {
          source: 'candidate',
          reason: 'invalid-polygon-component',
          candidate: emptyCandidate
        },
        {
          source: 'candidate',
          reason: 'invalid-polygon-component',
          candidate: zeroCandidate
        },
        {
          source: 'candidate',
          reason: 'invalid-polygon-component',
          candidate: selfTouchingCandidate
        }
      ]
    });
  });

  test('returns no rows for empty, zero-area, or self-touching selections', () => {
    const candidate = feature('valid', rectangle(0, 0, 10, 10));
    const empty: Polygon = { type: 'Polygon', coordinates: [] };
    const zeroArea: Polygon = {
      type: 'Polygon',
      coordinates: [[[0, 0], [1, 1], [2, 2], [0, 0]]]
    };
    const selfTouching: Polygon = {
      type: 'Polygon',
      coordinates: [[
        [0, 0],
        [4, 0],
        [4, 4],
        [2, 2],
        [0, 4],
        [2, 2],
        [0, 0]
      ]]
    };

    // Each of these is a malformed selection, so each is REPORTED rather than
    // silently dropped (IB-10): a wholly unusable geometry must not be
    // indistinguishable from a non-areal one. Place Studio turns a selection
    // rejection into `selectionUnavailable`, an honest empty state.
    const selectionRejected = {
      rows: [],
      hasSuppressedSlivers: false,
      rejections: [{
        source: 'selection',
        reason: 'invalid-polygon-component'
      }]
    };
    expect(computeOverlapRows(empty, collection(candidate))).toEqual(selectionRejected);
    expect(computeOverlapRows(zeroArea, collection(candidate))).toEqual(selectionRejected);
    expect(computeOverlapRows(selfTouching, collection(candidate))).toEqual(selectionRejected);
  });

  test('reports a rejection for wholly degenerate MultiPolygons', () => {
    // IB-10: a candidate whose EVERY component is malformed used to return
    // `omitted`, which produced no rejection row and read exactly like a
    // non-areal candidate. It is now rejected the same way a mixed-validity
    // one is, so the reader is told the geometry could not be used.
    const whollyDegenerate: MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: invalidPolygonComponents.map(({ coordinates }) => coordinates)
    };
    const validCandidate = feature('valid', rectangle(0, 0, 10, 10));

    expect(computeOverlapRows(whollyDegenerate, collection(validCandidate))).toEqual({
      rows: [],
      hasSuppressedSlivers: false,
      rejections: [{
        source: 'selection',
        reason: 'invalid-polygon-component'
      }]
    });
    const degenerateCandidate = feature('degenerate', whollyDegenerate);
    expect(computeOverlapRows(
      rectangle(0, 0, 10, 10),
      collection(degenerateCandidate)
    )).toEqual({
      rows: [],
      hasSuppressedSlivers: false,
      rejections: [{
        source: 'candidate',
        reason: 'invalid-polygon-component',
        candidate: degenerateCandidate
      }]
    });
  });

  test('aggregates disjoint MultiPolygon parts for containment and area shares', () => {
    const selected: MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: [
        rectangle(0, 0, 4, 4).coordinates,
        rectangle(10, 0, 14, 4).coordinates
      ]
    };
    const candidate: MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: [
        rectangle(1, 1, 3, 3).coordinates,
        rectangle(11, 1, 13, 3).coordinates
      ]
    };

    const result = computeOverlapRows(selected, collection(feature('parts', candidate)));

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.relationship).toBe('contains');
    expect(result.rows[0]?.evidence.shareOfCandidateArea).toBeCloseTo(1, 12);
    expect(result.rows[0]?.evidence.shareOfSelectedArea).toBeCloseTo(0.25, 3);
    expect(result.rejections).toBeUndefined();
  });

  for (const invalidComponent of invalidPolygonComponents) {
    test(`rejects a mixed-validity selection containing ${invalidComponent.name}`, () => {
      const selected: MultiPolygon = {
        type: 'MultiPolygon',
        coordinates: [
          rectangle(0, 0, 4, 4).coordinates,
          invalidComponent.coordinates
        ]
      };
      const candidate = feature('inside-valid-remainder', rectangle(1, 1, 3, 3));

      const result = computeOverlapRows(selected, collection(candidate));

      expect(result).toEqual({
        rows: [],
        hasSuppressedSlivers: false,
        rejections: [{
          source: 'selection',
          reason: 'invalid-polygon-component'
        }]
      });
    });

    test(`rejects a mixed-validity candidate containing ${invalidComponent.name}`, () => {
      const selected = rectangle(-1, -1, 5, 5);
      const candidateGeometry: MultiPolygon = {
        type: 'MultiPolygon',
        coordinates: [
          rectangle(0, 0, 4, 4).coordinates,
          invalidComponent.coordinates
        ]
      };
      const candidate = feature('mixed-validity', candidateGeometry);

      const result = computeOverlapRows(selected, collection(candidate));

      expect(result).toEqual({
        rows: [],
        hasSuppressedSlivers: false,
        rejections: [{
          source: 'candidate',
          reason: 'invalid-polygon-component',
          candidate
        }]
      });
    });
  }

  test('rejects mixed-validity component pairs spanning the antimeridian on both sides', () => {
    const validComponent = rectangle(170, 50, -175, 60).coordinates;
    const invalidComponent: Polygon['coordinates'] = [[
      [-174, 51],
      [-168, 51],
      [-168, 59],
      [-171, 55],
      [-174, 59],
      [-171, 55],
      [-174, 51]
    ]];
    const mixedGeometry: MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: [validComponent, invalidComponent]
    };
    const overlapping = feature('antimeridian-overlap', rectangle(175, 52, -178, 58));

    const selectedResult = computeOverlapRows(mixedGeometry, collection(overlapping));
    const candidate = feature('antimeridian-mixed', mixedGeometry);
    const candidateResult = computeOverlapRows(
      rectangle(168, 48, -176, 62),
      collection(candidate)
    );

    expect(selectedResult).toEqual({
      rows: [],
      hasSuppressedSlivers: false,
      rejections: [{
        source: 'selection',
        reason: 'invalid-polygon-component'
      }]
    });
    expect(candidateResult).toEqual({
      rows: [],
      hasSuppressedSlivers: false,
      rejections: [{
        source: 'candidate',
        reason: 'invalid-polygon-component',
        candidate
      }]
    });
  });

  test('subtracts holes from both area and intersection evidence', () => {
    const selected: Polygon = {
      type: 'Polygon',
      coordinates: [
        rectangle(0, 0, 10, 10).coordinates[0] ?? [],
        rectangle(4, 4, 6, 6).coordinates[0] ?? []
      ]
    };
    const insideHole = feature('hole', rectangle(4.5, 4.5, 5.5, 5.5));
    const material = feature('material', rectangle(0, 0, 2, 10));

    const result = computeOverlapRows(selected, collection(insideHole, material));

    expect(result.rows.map((row) => row.candidate.id)).toEqual(['material']);
    expect(result.rows[0]?.relationship).toBe('contains');
    expect(result.hasSuppressedSlivers).toBe(false);
  });

  test('unwraps antimeridian-crossing containment for Alaska-style framing', () => {
    const selected = rectangle(170, 50, -170, 60);
    const candidate = feature('aleutian-core', rectangle(175, 52, -175, 58));

    const result = computeOverlapRows(selected, collection(candidate));

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.relationship).toBe('contains');
    expect(result.rows[0]?.evidence.shareOfCandidateArea).toBeCloseTo(1, 12);
    expect(result.rows[0]?.evidence.shareOfSelectedArea).toBeLessThan(0.5);
  });

  test('aligns opposite longitude encodings across the antimeridian', () => {
    const selected = rectangle(170, 50, -170, 60);
    const candidate = feature('western-encoding', rectangle(-175, 50, -165, 60));

    const result = computeOverlapRows(selected, collection(candidate));

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.relationship).toBe('overlaps');
    expect(result.rows[0]?.evidence.shareOfCandidateArea).toBeCloseTo(0.5, 12);
    expect(result.rows[0]?.evidence.shareOfSelectedArea).toBeCloseTo(0.25, 12);
  });

  test('does not treat edge or point contact as overlap or as a suppressed sliver', () => {
    const selected = rectangle(0, 0, 10, 10);
    const edge = feature('edge', rectangle(10, 0, 20, 10));
    const point = feature('point', rectangle(10, 10, 20, 20));

    const result = computeOverlapRows(selected, collection(edge, point));

    expect(result).toEqual({ rows: [], hasSuppressedSlivers: false });
  });
});
