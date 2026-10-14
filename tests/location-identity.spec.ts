import { expect, test } from './offline-test';
import type * as maplibregl from 'maplibre-gl';

import { resolveLocationIdentity } from '../src/state/location-identity';
import { invalidateSharedJsonRequest, US_STATES_SHARED_KEY } from '../src/util/fetch';

const STATE_FILL = 'us-states-fill';
const TRIBAL_FILL = 'tribal-lands-fill';
const BIA_FILL = 'bia-reservations-fill';
const AIANNH_FILL = 'aiannh-fill';

interface SyntheticRenderedFeature {
  readonly properties: Readonly<Record<string, unknown>>;
}

type SyntheticLayerValue =
  | SyntheticRenderedFeature
  | readonly SyntheticRenderedFeature[];

type SyntheticLayerFeatures = Readonly<Partial<Record<string, SyntheticLayerValue>>>;

function feature(properties: Readonly<Record<string, unknown>>): SyntheticRenderedFeature {
  return { properties };
}

/**
 * Minimal MapLibre test double for the rendered-feature identity path. A
 * rendered Washington State feature keeps the resolver on its synchronous
 * path, so these cases never fetch bundled data or contact a live service.
 */
function identityMap(layerFeatures: SyntheticLayerFeatures): maplibregl.Map {
  const features: SyntheticLayerFeatures = {
    [STATE_FILL]: feature({ STUSPS: 'WA', NAME: 'Washington' }),
    ...layerFeatures
  };

  return {
    project: () => ({ x: 0, y: 0 }),
    getLayer: (id: string) => (features[id] ? { id } : undefined),
    queryRenderedFeatures: (
      _point: maplibregl.PointLike,
      options?: { layers?: string[] }
    ) =>
      (options?.layers ?? []).flatMap((id) => {
        const value = features[id];
        if (!value) return [];
        return Array.isArray(value) ? value : [value];
      })
  } as unknown as maplibregl.Map;
}

async function containingTribal(
  layerFeatures: SyntheticLayerFeatures
): Promise<{ name: string; source: string } | null> {
  const identity = await resolveLocationIdentity(
    identityMap(layerFeatures),
    { lng: -120.5, lat: 47.2 },
    new AbortController().signal
  );
  return identity.containingTribal;
}

test('the subtype-aware identity matrix covers legal AIANNH, statistical AIANNH, BIA-only, conflicts, deployer data, and no match', async () => {
  const legalAiannh = feature({
    NAME: 'Synthetic Census Legal Area',
    AIANNHCC: 'D1'
  });
  const statisticalAiannh = feature({
    NAME: 'Synthetic Census Statistical Area',
    AIANNHCC: 'D6'
  });
  const bia = feature({ LARNAME: 'Synthetic BIA LAR Area' });
  const deployer = feature({ NAME: 'Synthetic Deployer Area' });

  const cases: ReadonlyArray<{
    readonly label: string;
    readonly layers: SyntheticLayerFeatures;
    readonly expected: { readonly name: string; readonly source: string } | null;
  }> = [
    {
      label: 'legal AIANNH only',
      layers: { [AIANNH_FILL]: legalAiannh },
      expected: { name: 'Synthetic Census Legal Area', source: 'aiannh' }
    },
    {
      label: 'statistical AIANNH only',
      layers: { [AIANNH_FILL]: statisticalAiannh },
      expected: { name: 'Synthetic Census Statistical Area', source: 'aiannh' }
    },
    {
      label: 'BIA only',
      layers: { [BIA_FILL]: bia },
      expected: { name: 'Synthetic BIA LAR Area', source: 'bia-reservation' }
    },
    {
      label: 'conflicting BIA and legal AIANNH',
      layers: {
        [BIA_FILL]: bia,
        [AIANNH_FILL]: [statisticalAiannh, legalAiannh]
      },
      expected: { name: 'Synthetic Census Legal Area', source: 'aiannh' }
    },
    {
      label: 'BIA outranks a statistical AIANNH area',
      layers: { [BIA_FILL]: bia, [AIANNH_FILL]: statisticalAiannh },
      expected: { name: 'Synthetic BIA LAR Area', source: 'bia-reservation' }
    },
    {
      label: 'deployer data outranks every federal representation',
      layers: {
        [TRIBAL_FILL]: deployer,
        [BIA_FILL]: bia,
        [AIANNH_FILL]: legalAiannh
      },
      expected: { name: 'Synthetic Deployer Area', source: 'tribal' }
    },
    {
      label: 'no match',
      layers: {},
      expected: null
    }
  ];

  for (const identityCase of cases) {
    expect(
      await containingTribal(identityCase.layers),
      identityCase.label
    ).toEqual(identityCase.expected);
  }
});

// ---------------------------------------------------------------------------
// The bundled-states fallback (no rendered states layer): a superseded click
// must not cancel a live one, and one failure must not last the session.
// ---------------------------------------------------------------------------

const BUNDLED_STATES = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { STUSPS: 'WA', NAME: 'Washington' },
      geometry: {
        type: 'Polygon',
        coordinates: [[[-125, 45.5], [-116.9, 45.5], [-116.9, 49], [-125, 49], [-125, 45.5]]]
      }
    }
  ]
});

/** A map with no rendered layers, so the state comes from the bundled file. */
const noLayersMap = identityMap({ [STATE_FILL]: [] });
const SEATTLE = { lng: -122.3, lat: 47.6 };

/** Answer the bundled file after `delayMs`, honouring the request's abort. */
function bundledStatesFetch(delayMs: number): typeof fetch {
  return (async (_input: unknown, init?: RequestInit) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(init.signal?.reason);
      }, { once: true });
    });
    return new Response(BUNDLED_STATES, { status: 200 });
  }) as typeof fetch;
}

test.describe.serial('bundled-states fallback', () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  test.beforeEach(() => {
    invalidateSharedJsonRequest(US_STATES_SHARED_KEY);
    console.warn = () => {};
  });
  test.afterEach(() => {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    invalidateSharedJsonRequest(US_STATES_SHARED_KEY);
  });

  test('one transient failure is retried on the next click', async () => {
    let calls = 0;
    const answer = bundledStatesFetch(0);
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) throw new TypeError('network down');
      return answer(input, init);
    }) as typeof fetch;

    const first = await resolveLocationIdentity(noLayersMap, SEATTLE, new AbortController().signal);
    expect(first.state).toBeNull();
    const second = await resolveLocationIdentity(noLayersMap, SEATTLE, new AbortController().signal);
    expect(second.state).toEqual({ code: 'WA', name: 'Washington' });
    expect(calls).toBe(2);
  });

  test('a superseded first click does not take the state from the live second click', async () => {
    globalThis.fetch = bundledStatesFetch(200);
    const a = new AbortController();
    const first = resolveLocationIdentity(noLayersMap, { lng: -120.5, lat: 47.4 }, a.signal).catch(
      () => null
    );
    const second = resolveLocationIdentity(noLayersMap, SEATTLE, new AbortController().signal);
    setTimeout(() => a.abort(), 50);
    await first;
    expect((await second).state).toEqual({ code: 'WA', name: 'Washington' });
  });
});
