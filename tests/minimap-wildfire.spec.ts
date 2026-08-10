import { expect, test } from '@playwright/test';

import { FRAMING_KEYS } from '../src/config/framings';
import { MINIMAP_WHP } from '../src/config/minimap-whp';
import { MINIMAP_WILDFIRE_COLORS } from '../src/config/palette';
import {
  buildMinimapWildfireQueryBody,
  deriveMinimapWildfireSummary,
  getMinimapWildfireSnapshot,
  MINIMAP_WILDFIRE_WHERE,
  parseMinimapWildfireCount,
  retainMinimapWildfire,
} from '../src/state/minimap-wildfire';
import type { MinimapWhpFramingSummary } from '../src/config/minimap-whp';
import type { MinimapWildfireSnapshot } from '../src/state/minimap-wildfire';

function whp(
  highOrVeryHighPercent: number,
  moderateOrHigherPercent: number,
  coverage: MinimapWhpFramingSummary['coverage'] = 'live',
): MinimapWhpFramingSummary {
  return {
    coverage,
    highOrVeryHighPercent,
    moderateOrHigherPercent,
    landSamples: 100,
    waterSamplesExcluded: 10,
    noDataSamples: 0,
  };
}

function noWhp(): MinimapWhpFramingSummary {
  return {
    coverage: 'no-data',
    highOrVeryHighPercent: null,
    moderateOrHigherPercent: null,
    landSamples: 0,
    waterSamplesExcluded: 0,
    noDataSamples: 0,
  };
}

function signedArea(ring: readonly (readonly number[])[]): number {
  let twiceArea = 0;
  for (let index = 0; index < ring.length - 1; index++) {
    const current = ring[index];
    const next = ring[index + 1];
    if (!current || !next) continue;
    twiceArea += current[0]! * next[1]! - next[0]! * current[1]!;
  }
  return twiceArea / 2;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for state.');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

test.describe('generated minimap WHP overview', () => {
  test('pins source, palette, denominator, coverage, and approximate thresholds', () => {
    expect(MINIMAP_WHP.schemaVersion).toBe(1);
    expect(MINIMAP_WHP.source.organization).toBe(
      'United States Forest Service',
    );
    expect(MINIMAP_WHP.source.rasterMembers).toEqual({
      '1': 'whp2023_cls_hi',
      '2': 'whp2023_cls_ak',
      '3': 'whp2023_cls_conus',
    });
    expect(MINIMAP_WHP.method.approximate).toBe(true);
    expect(MINIMAP_WHP.method.interpolation).toBe('nearest neighbor');
    expect(MINIMAP_WHP.method.denominator).toBe(
      'classes 1 through 6; class 7 water excluded',
    );
    expect(MINIMAP_WHP.method.palette).toEqual({
      '1': { label: 'Very Low', rgba: [56, 163, 0, 255] },
      '2': { label: 'Low', rgba: [163, 255, 148, 255] },
      '3': { label: 'Moderate', rgba: [255, 255, 99, 255] },
      '4': { label: 'High', rgba: [255, 163, 0, 255] },
      '5': { label: 'Very High', rgba: [237, 30, 0, 255] },
      '6': { label: 'Non-burnable', rgba: [225, 225, 225, 255] },
      '7': { label: 'Water', rgba: [0, 112, 225, 255] },
    });
    expect(Object.keys(MINIMAP_WHP.framings)).toEqual(FRAMING_KEYS);
    expect(MINIMAP_WHP.framings['boreal-arctic'].coverage).toBe('no-data');
    expect(MINIMAP_WHP.framings.mexico.coverage).toBe('no-data');
    expect(MINIMAP_WHP.framings['pacific-coast'].coverage).toBe(
      'live-partial',
    );
    expect(
      MINIMAP_WHP.framings['pacific-coast'].moderateOrHigherPercent,
    ).toBeGreaterThan(30);
    expect(
      MINIMAP_WHP.framings['southeast-gulf'].moderateOrHigherPercent,
    ).toBeGreaterThan(30);
  });
});

test.describe('minimap wildfire classification', () => {
  test('pins the visible red, orange, yellow, and neutral channels', () => {
    expect(MINIMAP_WILDFIRE_COLORS).toEqual({
      'mapped-wildfire': '#D73027',
      'high-potential': '#FF9F1C',
      'moderate-potential': '#FFE066',
      'below-threshold': '#E2E8F0',
      'no-data': '#334155',
      'unavailable': '#1E293B',
    });
  });

  test('uses strict red, orange, then yellow precedence', () => {
    expect(
      deriveMinimapWildfireSummary(
        { status: 'live', count: 1 },
        whp(90, 95),
      ).condition,
    ).toBe('mapped-wildfire');
    expect(
      deriveMinimapWildfireSummary(
        { status: 'live', count: 0 },
        whp(50.001, 70),
      ).condition,
    ).toBe('high-potential');
    expect(
      deriveMinimapWildfireSummary(
        { status: 'live', count: 0 },
        whp(50, 70),
      ).condition,
    ).toBe('moderate-potential');
    expect(
      deriveMinimapWildfireSummary(
        { status: 'live', count: 0 },
        whp(10, 30.001),
      ).condition,
    ).toBe('moderate-potential');
    expect(
      deriveMinimapWildfireSummary(
        { status: 'live', count: 0 },
        whp(10, 30),
      ).condition,
    ).toBe('below-threshold');
  });

  test('does not fall through an unknown current count to static potential', () => {
    const summary = deriveMinimapWildfireSummary(
      { status: 'unavailable', count: null },
      whp(100, 100),
    );
    expect(summary.condition).toBe('unavailable');
    expect(summary.status).toBe('unavailable');
    expect(summary.mappedWildfirePerimeterCount).toBeNull();
  });

  test('carries partial and no-coverage honesty into the region status', () => {
    expect(
      deriveMinimapWildfireSummary(
        { status: 'live', count: 0 },
        whp(20, 40, 'live-partial'),
      ),
    ).toMatchObject({
      condition: 'moderate-potential',
      status: 'live-partial',
      whpCoverage: 'live-partial',
    });
    expect(
      deriveMinimapWildfireSummary(
        { status: 'live', count: 0 },
        noWhp(),
      ),
    ).toMatchObject({ condition: 'no-data', status: 'no-data' });
    expect(
      deriveMinimapWildfireSummary(
        { status: 'live', count: 2 },
        noWhp(),
      ),
    ).toMatchObject({
      condition: 'mapped-wildfire',
      status: 'live',
    });
  });
});

test.describe('minimap WFIGS count query', () => {
  test('posts the active WF/CX filter and closed clockwise authored rings', () => {
    for (const key of FRAMING_KEYS) {
      const body = buildMinimapWildfireQueryBody(key);
      expect(body.get('where')).toBe(MINIMAP_WILDFIRE_WHERE);
      expect(body.get('where')).not.toContain('RX');
      expect(body.get('returnCountOnly')).toBe('true');
      expect(body.get('returnGeometry')).toBe('false');
      expect(body.get('geometryType')).toBe('esriGeometryPolygon');
      expect(body.get('inSR')).toBe('4326');
      expect(body.get('spatialRel')).toBe('esriSpatialRelIntersects');
      expect(body.get('f')).toBe('json');

      const geometry = JSON.parse(body.get('geometry') ?? '') as {
        rings: number[][][];
        spatialReference: { wkid: number };
      };
      expect(geometry.spatialReference.wkid).toBe(4326);
      expect(geometry.rings.length).toBeGreaterThan(0);
      for (const ring of geometry.rings) {
        expect(ring[0]).toEqual(ring.at(-1));
        expect(signedArea(ring)).toBeLessThan(0);
        for (const point of ring) {
          expect(point[0]).toBeGreaterThanOrEqual(-180);
          expect(point[0]).toBeLessThanOrEqual(180);
        }
      }
    }

    const alaska = JSON.parse(
      buildMinimapWildfireQueryBody('alaska-northwest').get('geometry') ?? '',
    ) as { rings: number[][][] };
    expect(alaska.rings).toHaveLength(5);
    expect(alaska.rings.flat().some((point) => point[0]! > 170)).toBe(true);
  });

  test('accepts only nonnegative safe integer ArcGIS counts', () => {
    expect(parseMinimapWildfireCount({ count: 0 })).toBe(0);
    expect(parseMinimapWildfireCount({ count: 23 })).toBe(23);
    expect(() => parseMinimapWildfireCount({ count: -1 })).toThrow(
      /invalid count/,
    );
    expect(() => parseMinimapWildfireCount({ count: 1.5 })).toThrow(
      /invalid count/,
    );
    expect(() => parseMinimapWildfireCount({ count: '1' })).toThrow(
      /invalid count/,
    );
    expect(() =>
      parseMinimapWildfireCount({ error: { message: 'bad query' } }),
    ).toThrow(/ArcGIS error: bad query/);
  });
});

test.describe.serial('retained minimap wildfire runtime', () => {
  test('shares nine concurrent POSTs and derives a complete partial snapshot', async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; init: RequestInit }> = [];
    let activeCalls = 0;
    let peakCalls = 0;
    globalThis.fetch = async (input, init) => {
      const index = requests.length;
      requests.push({ url: String(input), init: init ?? {} });
      activeCalls++;
      peakCalls = Math.max(peakCalls, activeCalls);
      await Promise.resolve();
      activeCalls--;
      return new Response(JSON.stringify({ count: index === 0 ? 2 : 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const observed: MinimapWildfireSnapshot[] = [];
    const releaseFirst = retainMinimapWildfire((next) => observed.push(next));
    const releaseSecond = retainMinimapWildfire(() => undefined);
    try {
      await waitFor(
        () => !['idle', 'loading'].includes(getMinimapWildfireSnapshot().status),
      );
      const current = getMinimapWildfireSnapshot();
      expect(requests).toHaveLength(9);
      expect(peakCalls).toBe(9);
      expect(requests.every(({ url }) => url.endsWith('/query'))).toBe(true);
      expect(requests.every(({ init }) => init.method === 'POST')).toBe(true);
      expect(
        requests.every(
          ({ init }) =>
            init.headers !== undefined &&
            new Headers(init.headers).get('content-type') ===
              'application/x-www-form-urlencoded;charset=UTF-8',
        ),
      ).toBe(true);
      expect(current.status).toBe('live-partial');
      expect(current.checkedAtUtc).not.toBeNull();
      expect(current.summaries['alaska-northwest']).toMatchObject({
        condition: 'mapped-wildfire',
        mappedWildfirePerimeterCount: 2,
        status: 'live',
      });
      expect(current.summaries['pacific-coast']?.condition).toBe(
        'moderate-potential',
      );
      expect(current.summaries['arid-west']?.condition).toBe(
        'moderate-potential',
      );
      expect(current.summaries['southeast-gulf']?.condition).toBe(
        'moderate-potential',
      );
      expect(current.summaries.mexico?.condition).toBe('no-data');
      expect(observed.some(({ status }) => status === 'loading')).toBe(true);
    } finally {
      releaseFirst();
      releaseSecond();
      globalThis.fetch = originalFetch;
    }
    expect(getMinimapWildfireSnapshot().status).toBe('idle');
  });

  test('isolates one malformed ArcGIS response to its framing', async () => {
    const originalFetch = globalThis.fetch;
    const originalWarn = console.warn;
    let callIndex = 0;
    console.warn = () => undefined;
    globalThis.fetch = async () => {
      const index = callIndex++;
      const value =
        index === 2
          ? { error: { message: 'synthetic failure' } }
          : { count: 0 };
      return new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const release = retainMinimapWildfire(() => undefined);
    try {
      await waitFor(
        () => !['idle', 'loading'].includes(getMinimapWildfireSnapshot().status),
      );
      const current = getMinimapWildfireSnapshot();
      expect(callIndex).toBe(9);
      expect(current.status).toBe('live-partial');
      expect(current.summaries['pacific-coast']).toMatchObject({
        condition: 'unavailable',
        status: 'unavailable',
        mappedWildfirePerimeterCount: null,
      });
      expect(current.summaries['arid-west']?.condition).not.toBe('unavailable');
    } finally {
      release();
      globalThis.fetch = originalFetch;
      console.warn = originalWarn;
    }
  });

  test('clears the post-completion refresh timer on final release', async () => {
    const originalFetch = globalThis.fetch;
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const refreshHandle = { kind: 'synthetic-refresh-timer' } as unknown as
      ReturnType<typeof setTimeout>;
    let refreshScheduled = false;
    let refreshCleared = false;

    globalThis.setTimeout = ((
      callback: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (delay === 5 * 60_000) {
        refreshScheduled = true;
        return refreshHandle;
      }
      return originalSetTimeout(callback, delay, ...args);
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((handle?: ReturnType<typeof setTimeout>) => {
      if (handle === refreshHandle) {
        refreshCleared = true;
        return;
      }
      originalClearTimeout(handle);
    }) as typeof clearTimeout;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ count: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    const release = retainMinimapWildfire(() => undefined);
    try {
      await waitFor(
        () => !['idle', 'loading'].includes(getMinimapWildfireSnapshot().status),
      );
      expect(refreshScheduled).toBe(true);
      release();
      expect(refreshCleared).toBe(true);
      expect(getMinimapWildfireSnapshot().status).toBe('idle');
    } finally {
      release();
      globalThis.fetch = originalFetch;
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  test('final release aborts all pending requests and drops late outcomes', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    let aborts = 0;
    globalThis.fetch = (_input, init) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) throw new Error('Expected a fetch cancellation signal.');
        signal.addEventListener(
          'abort',
          () => {
            aborts++;
            reject(new DOMException('Aborted', 'AbortError'));
          },
          { once: true },
        );
      });
    };

    const observed: MinimapWildfireSnapshot[] = [];
    const release = retainMinimapWildfire((next) => observed.push(next));
    try {
      expect(calls).toBe(9);
      expect(getMinimapWildfireSnapshot().status).toBe('loading');
      release();
      await waitFor(() => aborts === 9);
      await Promise.resolve();
      expect(getMinimapWildfireSnapshot()).toEqual({
        status: 'idle',
        checkedAtUtc: null,
        summaries: {},
      });
      expect(observed.at(-1)?.status).toBe('loading');
    } finally {
      release();
      globalThis.fetch = originalFetch;
    }
  });
});
