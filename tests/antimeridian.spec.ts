import { test, expect } from '@playwright/test';

import type { MultiPolygon, Polygon } from 'geojson';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createViteServer } from 'vite';

import {
  bboxCrossesAntimeridian,
  geometryBboxAcrossAntimeridian,
  geometryLikelyCrossesAntimeridian,
  naiveBboxSuggestsAntimeridianCrossing,
  normalizeLongitude,
  splitBboxAtAntimeridian,
  type LngLatBbox
} from '../src/util/antimeridian';
import {
  arcGisEnvelopeValues,
  bboxCenter,
  bboxIntersection,
  bboxIntersects,
  bboxToContinuousBounds,
  mergeByStableIdentifier,
  selectionEnvelopes,
  unionBboxes
} from '../src/util/bbox';
import {
  REGIONS,
  regionToMapLibreBounds,
  zoomToFitLongitudeSpan
} from '../src/config/regions';
import { buildBoundaryContext, geometryBbox } from '../src/impact/context';
import { captureWarnings } from './map-harness';

type FetchNifcClaims =
  typeof import('../src/impact/sources').fetchNifcClaims;

async function withFetchNifcClaims<T>(
  run: (fetchNifcClaims: FetchNifcClaims) => Promise<T>
): Promise<T> {
  const vite = await createViteServer({
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true }
  });
  try {
    const sourceModule = (await vite.ssrLoadModule(
      '/src/impact/sources.ts'
    )) as { fetchNifcClaims: FetchNifcClaims };
    return await run(sourceModule.fetchNifcClaims);
  } finally {
    await vite.close();
  }
}

/**
 * N2-A: the antimeridian contract and its first behavioral consumers. Pure Node
 * assertions in the s1-substrate pattern (nothing here drives a browser).
 *
 * Two spec families:
 * 1. The util contracts (src/util/antimeridian.ts): the two-representation
 *    doctrine, normalization, validation policy, and the split.
 * 2. N2-A behavior: selection bboxes, cameras, intersections, and service
 *    envelopes keep the compact antimeridian extent instead of smearing
 *    across the world.
 */

/** Two-lobe Aleutian-style MultiPolygon straddling the antimeridian. */
const CROSSING_LOBES: MultiPolygon = {
  type: 'MultiPolygon',
  coordinates: [
    [
      [
        [178.0, 51.5],
        [179.5, 51.5],
        [179.5, 52.5],
        [178.0, 52.5],
        [178.0, 51.5]
      ]
    ],
    [
      [
        [-179.5, 51.0],
        [-170.0, 51.0],
        [-170.0, 53.0],
        [-179.5, 53.0],
        [-179.5, 51.0]
      ]
    ]
  ]
};

/** A single ring whose segment wraps (RFC 7946 wrap signature). */
const WRAP_SEGMENT_POLYGON: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [179.0, 51.0],
      [-179.0, 51.0],
      [-179.0, 52.0],
      [179.0, 52.0],
      [179.0, 51.0]
    ]
  ]
};

/** An ordinary PNW polygon nowhere near the antimeridian. */
const PNW_POLYGON: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [-124.0, 45.5],
      [-117.0, 45.5],
      [-117.0, 49.0],
      [-124.0, 49.0],
      [-124.0, 45.5]
    ]
  ]
};

test.describe('normalizeLongitude (T-M0-4 D1)', () => {
  test('congruent modulo 360 into [-180, 180], sign-preserving at the edges', () => {
    expect(normalizeLongitude(190)).toBe(-170);
    expect(normalizeLongitude(-190)).toBe(170);
    expect(normalizeLongitude(540)).toBe(180);
    expect(normalizeLongitude(-540)).toBe(-180);
    expect(normalizeLongitude(180)).toBe(180);
    expect(normalizeLongitude(-180)).toBe(-180);
    expect(normalizeLongitude(0)).toBe(0);
    expect(normalizeLongitude(-124.763)).toBe(-124.763);
  });

  test('total on non-finite input: NaN in, NaN out', () => {
    expect(Number.isNaN(normalizeLongitude(NaN))).toBe(true);
    expect(Number.isNaN(normalizeLongitude(Infinity))).toBe(true);
    expect(Number.isNaN(normalizeLongitude(-Infinity))).toBe(true);
  });
});

test.describe('bboxCrossesAntimeridian: the ENCODED-form predicate (D2a)', () => {
  test('encoded crossing form (west > east) is crossing', () => {
    expect(bboxCrossesAntimeridian([170, 50, -170, 55])).toBe(true);
    expect(bboxCrossesAntimeridian([179.5, 51, -179.5, 53])).toBe(true);
  });

  test('ordinary and NAIVE walked boxes are not crossing (that question belongs to the naive heuristic)', () => {
    expect(bboxCrossesAntimeridian([-124, 45, -117, 49])).toBe(false);
    // The naive walk of a crossing geometry: west <= east, span > 180.
    expect(bboxCrossesAntimeridian([-179.5, 51, 179.5, 53])).toBe(false);
  });

  test('deliberate edge classifications: full world, same-meridian endpoints, zero width', () => {
    // Raw span exactly 360 is the full-world box, not a crossing.
    expect(bboxCrossesAntimeridian([-180, -90, 180, 90])).toBe(false);
    // 180 and -180 are the same meridian: zero interior, not a crossing.
    expect(bboxCrossesAntimeridian([180, 50, -180, 55])).toBe(false);
    // Zero width.
    expect(bboxCrossesAntimeridian([12, 50, 12, 55])).toBe(false);
    // Endpoints equal after normalization (190 and -170).
    expect(bboxCrossesAntimeridian([190, 50, -170, 55])).toBe(false);
  });

  test('validation policy: throws RangeError on invalid boxes', () => {
    expect(() => bboxCrossesAntimeridian([NaN, 0, 10, 10])).toThrow(RangeError);
    expect(() => bboxCrossesAntimeridian([0, 40, 10, 30])).toThrow(RangeError); // south > north
    expect(() => bboxCrossesAntimeridian([0, -91, 10, 0])).toThrow(RangeError); // latitude range
    expect(() => bboxCrossesAntimeridian([0, 0, 400, 10])).toThrow(RangeError); // span > 360
  });
});

test.describe('naiveBboxSuggestsAntimeridianCrossing: the walked-box heuristic (D2b)', () => {
  test('span strictly greater than 180 flags; exactly 180 deliberately does not', () => {
    expect(naiveBboxSuggestsAntimeridianCrossing([-179.5, 51, 179.5, 53])).toBe(true);
    expect(naiveBboxSuggestsAntimeridianCrossing([-90, 0, 90, 10])).toBe(false); // exactly 180
    expect(naiveBboxSuggestsAntimeridianCrossing([-90, 0, 90.5, 10])).toBe(true);
    expect(naiveBboxSuggestsAntimeridianCrossing([-124, 45, -117, 49])).toBe(false);
  });
});

test.describe('geometryLikelyCrossesAntimeridian: evidence from geometry (D2 rev 2)', () => {
  test('wrap-signature segments and split lobes both count as evidence', () => {
    expect(geometryLikelyCrossesAntimeridian(WRAP_SEGMENT_POLYGON)).toBe(true);
    expect(geometryLikelyCrossesAntimeridian(CROSSING_LOBES)).toBe(true);
  });

  test('ordinary geometry, empty geometry, and GeometryCollection are false', () => {
    expect(geometryLikelyCrossesAntimeridian(PNW_POLYGON)).toBe(false);
    expect(geometryLikelyCrossesAntimeridian(null)).toBe(false);
    expect(geometryLikelyCrossesAntimeridian(undefined)).toBe(false);
    expect(
      geometryLikelyCrossesAntimeridian({ type: 'GeometryCollection', geometries: [] })
    ).toBe(false);
  });
});

test.describe('geometryBboxAcrossAntimeridian: compact geometry walks (N2-A)', () => {
  test('derives the full compact Aleutian extent from split lobes', () => {
    expect(geometryBboxAcrossAntimeridian(CROSSING_LOBES)).toEqual([
      178,
      51,
      -170,
      53
    ]);
  });

  test('keeps ordinary geometry unchanged and empty geometry absent', () => {
    expect(geometryBboxAcrossAntimeridian(PNW_POLYGON)).toEqual([
      -124,
      45.5,
      -117,
      49
    ]);
    expect(geometryBboxAcrossAntimeridian(null)).toBeNull();
    expect(
      geometryBboxAcrossAntimeridian({
        type: 'GeometryCollection',
        geometries: []
      })
    ).toBeNull();
  });
});

test.describe('splitBboxAtAntimeridian (D3)', () => {
  test('encoded crossing form splits into the two hemisphere halves', () => {
    expect(splitBboxAtAntimeridian([170, 50, -170, 55])).toEqual([
      [170, 50, 180, 55],
      [-180, 50, -170, 55]
    ]);
  });

  test('non-crossing boxes return one longitude-normalized box', () => {
    expect(splitBboxAtAntimeridian([-124, 45, -117, 49])).toEqual([[-124, 45, -117, 49]]);
    expect(splitBboxAtAntimeridian([190, 50, 200, 55])).toEqual([[-170, 50, -160, 55]]);
  });

  test('NOT a repair path: a naive walked box passes through in one piece', () => {
    expect(splitBboxAtAntimeridian([-179.5, 51, 179.5, 53])).toEqual([[-179.5, 51, 179.5, 53]]);
  });

  test('every full-world box returns the ONE canonical form (the normalization promise holds)', () => {
    expect(splitBboxAtAntimeridian([-180, -90, 180, 90])).toEqual([[-180, -90, 180, 90]]);
    // A valid full-world box with an unnormalized endpoint must not leak it.
    expect(splitBboxAtAntimeridian([0, -90, 360, 90])).toEqual([[-180, -90, 180, 90]]);
    expect(splitBboxAtAntimeridian([-170, 10, 190, 20])).toEqual([[-180, 10, 180, 20]]);
  });

  test('zero-interior boxes return one canonical zero-width box (the 180/-180 duality collapses)', () => {
    expect(splitBboxAtAntimeridian([12, 50, 12, 55])).toEqual([[12, 50, 12, 55]]);
    // Same meridian, two representations: canonicalized onto the west form.
    expect(splitBboxAtAntimeridian([180, 50, -180, 55])).toEqual([[180, 50, 180, 55]]);
    // Raw span -360 (endpoints one full wrap apart, descending).
    expect(splitBboxAtAntimeridian([190, 50, -170, 55])).toEqual([[-170, 50, -170, 55]]);
  });

  test('an encoded crossing with a zero-width half keeps the half (documented, not dropped)', () => {
    expect(splitBboxAtAntimeridian([180, 50, -170, 55])).toEqual([
      [180, 50, 180, 55],
      [-180, 50, -170, 55]
    ]);
  });

  test('the shared throw policy holds through EVERY public bbox-taking function', () => {
    const invalid: ReadonlyArray<LngLatBbox> = [
      [NaN, 0, 10, 10], // non-finite
      [0, 40, 10, 30], // south > north
      [0, -91, 10, 0], // latitude out of range
      [0, 0, 400, 10] // longitude span beyond one wrap
    ];
    for (const box of invalid) {
      expect(() => bboxCrossesAntimeridian(box), `crosses: [${box.join(',')}]`).toThrow(RangeError);
      expect(
        () => naiveBboxSuggestsAntimeridianCrossing(box),
        `naive: [${box.join(',')}]`
      ).toThrow(RangeError);
      expect(() => splitBboxAtAntimeridian(box), `split: [${box.join(',')}]`).toThrow(RangeError);
    }
  });
});

test.describe('context flag: buildBoundaryContext carries crossing evidence (D4)', () => {
  test('a crossing selection carries a complete service bbox beside the naive bbox', () => {
    const context = buildBoundaryContext('state', { NAME: 'Alaska' }, CROSSING_LOBES, {
      lng: -175,
      lat: 52
    });
    expect(context.bbox).toEqual([-179.5, 51, 179.5, 53]);
    expect(context.serviceBbox).toEqual([178, 51, -170, 53]);
    expect(context.bboxCrossesAntimeridian).toBe(true);
  });

  test('an ordinary selection carries no flag property at all (omitted, never false)', () => {
    const context = buildBoundaryContext('state', { NAME: 'Washington' }, PNW_POLYGON, {
      lng: -120,
      lat: 47
    });
    expect(context.bbox).toEqual([-124.0, 45.5, -117.0, 49.0]);
    expect('bboxCrossesAntimeridian' in context).toBe(false);
  });
});

/*
 * N2-A consumer behavior through the shared seams production imports.
 * Boundary contexts carry an exact compact service envelope beside the
 * compatibility bbox. The raw `geometryBbox` helper remains below to pin why
 * naive min/max output cannot support an antimeridian service request.
 */
test.describe('consumer behavior on a crossing selection (N2-A)', () => {
  const naiveWalk = geometryBbox(CROSSING_LOBES) as [number, number, number, number];
  const compactWalk = geometryBboxAcrossAntimeridian(CROSSING_LOBES) as LngLatBbox;

  test('the walked box of the crossing fixture is near-world-spanning (the smear)', () => {
    expect(naiveWalk).toEqual([-179.5, 51.0, 179.5, 53.0]);
    expect(naiveBboxSuggestsAntimeridianCrossing(naiveWalk)).toBe(true);
  });

  test('NIFC envelope: a production context becomes exactly two non-crossing requests', () => {
    const context = buildBoundaryContext(
      'state',
      { NAME: 'Alaska' },
      CROSSING_LOBES,
      { lng: -175, lat: 52 }
    );
    expect(context.serviceBbox).toEqual([178, 51, -170, 53]);
    expect(selectionEnvelopes(context.serviceBbox, context.lngLat)).toEqual([
      '178,51,180,53',
      '-180,51,-170,53'
    ]);
    expect(selectionEnvelopes(compactWalk, { lng: -175, lat: 52 })).toEqual([
      '178,51,180,53',
      '-180,51,-170,53'
    ]);
  });

  test('NIFC production fetch pins both complete service envelopes by value', async () => {
    const context = buildBoundaryContext(
      'state',
      { NAME: 'Alaska' },
      CROSSING_LOBES,
      { lng: -175, lat: 52 }
    );
    await withFetchNifcClaims(async (fetchNifcClaims) => {
      const originalFetch = globalThis.fetch;
      const envelopes: string[] = [];
      const outFields: string[] = [];
      globalThis.fetch = async (input) => {
        const rawUrl =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        const envelope = new URL(rawUrl).searchParams.get('geometry');
        if (envelope) envelopes.push(envelope);
        const fields = new URL(rawUrl).searchParams.get('outFields');
        if (fields) outFields.push(fields);
        return new Response(
          JSON.stringify({ type: 'FeatureCollection', features: [] }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          }
        );
      };

      try {
        const result = await fetchNifcClaims(
          context,
          new AbortController().signal
        );
        expect(result.ok).toBe(true);
        expect(envelopes).toEqual([
          '178,51,180,53',
          '-180,51,-170,53'
        ]);
        expect(outFields).toHaveLength(2);
        for (const fields of outFields) {
          expect(fields.split(',')).toContain('attr_IncidentTypeCategory');
        }
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  test('NIFC envelope: the no-bbox click halo is unchanged', () => {
    expect(selectionEnvelopes(undefined, { lng: -175, lat: 52 })).toEqual([
      '-175.5,51.5,-174.5,52.5'
    ]);
  });

  test('ArcGIS envelope values use the same two-piece service contract', () => {
    expect(arcGisEnvelopeValues(compactWalk)).toEqual([
      '178,51,180,53',
      '-180,51,-170,53'
    ]);
  });

  test('camera midpoint stays near the selected Aleutian geometry', () => {
    expect(bboxCenter(compactWalk)).toEqual({ lng: -176, lat: 52 });
    expect(Math.abs(bboxCenter(naiveWalk).lng)).toBeGreaterThanOrEqual(170);
    expect(bboxToContinuousBounds(compactWalk)).toEqual([178, 51, 190, 53]);
  });

  test('search bbox union preserves the compact encoded crossing', () => {
    const lobeBoxes = CROSSING_LOBES.coordinates.map(
      (poly) => geometryBbox({ type: 'Polygon', coordinates: poly }) as [number, number, number, number]
    );
    expect(unionBboxes(lobeBoxes)).toEqual([178, 51, -170, 53]);
    expect(unionBboxes([])).toBeNull();
  });

  test('the aggregate search geometry carries crossing evidence and the exact bbox', () => {
    const aggregate: MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: CROSSING_LOBES.coordinates
    };
    const cameraBbox = geometryBboxAcrossAntimeridian(aggregate) as LngLatBbox;
    const aggregateContext = buildBoundaryContext(
      'bia-reservation',
      { LARNAME: 'Example land area' },
      aggregate,
      bboxCenter(cameraBbox)
    );
    expect(aggregateContext.bboxCrossesAntimeridian).toBe(true);
    expect(cameraBbox).toEqual([178, 51, -170, 53]);
  });

  test('overlap intersection rejects distant places and keeps either Aleutian side', () => {
    const hudsonBay: LngLatBbox = [-95, 51.5, -78, 52.5];
    expect(bboxIntersects(naiveWalk, hudsonBay)).toBe(false);
    expect(bboxIntersection(naiveWalk, hudsonBay)).toBeNull();
    expect(bboxIntersects(compactWalk, [179, 51.5, 180, 52.5])).toBe(true);
    expect(bboxIntersects(compactWalk, [-180, 51.5, -175, 52.5])).toBe(true);
    const florida: LngLatBbox = [-83, 25, -80, 31];
    expect(bboxIntersects(naiveWalk, florida)).toBe(false);
  });

  test('an encoded crossing box intersects and clips on both sides', () => {
    const crossing: LngLatBbox = [170, 50, -170, 55];
    expect(bboxIntersects(crossing, [175, 51, 176, 52])).toBe(true);
    expect(bboxIntersection(crossing, [175, 51, 176, 52])).toEqual([
      175,
      51,
      176,
      52
    ]);
    expect(bboxIntersects(crossing, [-176, 51, -175, 52])).toBe(true);
  });

  test('split responses merge duplicate stable identifiers once', () => {
    const merged = mergeByStableIdentifier(
      [
        [{ id: 'west', value: 1 }, { id: 'shared', value: 2 }],
        [{ id: 'shared', value: 3 }, { id: 'east', value: 4 }]
      ],
      (feature) => feature.id
    );
    expect(merged).toEqual([
      { id: 'west', value: 1 },
      { id: 'shared', value: 2 },
      { id: 'east', value: 4 }
    ]);
  });

  test('a sibling failure after headers aborts the other response body', async () => {
    let finishStalledBody: (() => void) | null = null;
    let noteBodyCancelled: (() => void) | null = null;
    const bodyCancelled = new Promise<void>((resolve) => {
      noteBodyCancelled = resolve;
    });
    const server = createHttpServer((request, response) => {
      if (request.url === '/stalled') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.write('{"type":"FeatureCollection","features":[');
        finishStalledBody = () => {
          if (!response.writableEnded) response.end(']}');
        };
        response.on('close', () => {
          if (!response.writableEnded) noteBodyCancelled?.();
        });
        return;
      }
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end('{"error":"sibling failed"}');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('The local response-body test server did not bind.');
    }

    const originalFetch = globalThis.fetch;
    let requestIndex = 0;
    let noteHeadersReturned: (() => void) | null = null;
    const headersReturned = new Promise<void>((resolve) => {
      noteHeadersReturned = resolve;
    });
    globalThis.fetch = async (_input, init) => {
      const index = requestIndex++;
      if (index === 0) {
        const response = await originalFetch(
          `http://127.0.0.1:${address.port}/stalled`,
          init
        );
        noteHeadersReturned?.();
        return response;
      }
      await headersReturned;
      return originalFetch(
        `http://127.0.0.1:${address.port}/failed`,
        init
      );
    };

    const warnings = captureWarnings();
    try {
      const context = buildBoundaryContext(
        'state',
        { NAME: 'Alaska' },
        CROSSING_LOBES,
        { lng: -175, lat: 52 }
      );
      await withFetchNifcClaims(async (fetchNifcClaims) => {
        const result = await fetchNifcClaims(
          context,
          new AbortController().signal
        );
        expect(result.ok).toBe(false);
      });
      // The failure is reported once, by the query that owns the envelope,
      // and the cancelled sibling stays silent (an abort is not a fault).
      expect(warnings.messages).toEqual([
        expect.stringMatching(/^\[impact\] NIFC query failed\./)
      ]);
      await expect(
        Promise.race([
          bodyCancelled.then(() => true),
          new Promise<boolean>((resolve) => {
            setTimeout(() => resolve(false), 500);
          })
        ])
      ).resolves.toBe(true);
    } finally {
      warnings.restore();
      globalThis.fetch = originalFetch;
      finishStalledBody?.();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

test.describe('Alaska and Hawaii region fits (N2-A)', () => {
  test('Alaska includes the tested Aleutian longitude in a compact continuous fit', () => {
    expect(REGIONS.alaska.bounds).toEqual([
      [51, 172],
      [71.5, -129.5]
    ]);
    const fit = regionToMapLibreBounds(REGIONS.alaska);
    expect(fit).toEqual([172, 51, 230.5, 71.5]);
    expect(fit[2] - fit[0]).toBeLessThan(90);
    expect(
      zoomToFitLongitudeSpan(
        -129.5 - 172 + 2 * REGIONS.alaska.padding,
        350
      )
    ).toBeGreaterThanOrEqual(2);
  });

  test('Hawaii remains a separate unchanged fit', () => {
    expect(REGIONS.hawaii.bounds).toEqual([
      [18.5, -160.5],
      [22.5, -154.5]
    ]);
    expect(regionToMapLibreBounds(REGIONS.hawaii)).toEqual([
      -160.5,
      18.5,
      -154.5,
      22.5
    ]);
  });
});
