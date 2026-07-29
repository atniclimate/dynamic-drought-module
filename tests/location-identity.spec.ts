import { expect, test } from '@playwright/test';
import type maplibregl from 'maplibre-gl';

import { resolveLocationIdentity } from '../src/state/location-identity';

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
