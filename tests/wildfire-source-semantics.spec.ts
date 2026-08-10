import { expect, test } from '@playwright/test';

import {
  HMS_DENSITY_PRESENTATION,
  HMS_OVERVIEW_QUALIFICATION,
  NIFC_INCIDENT_PRESENTATION,
  USFS_WHP_PRESENTATION,
  buildHmsSmokeFillPaint,
  buildNifcAreaPerimeterClaim,
  buildNifcFillPaint,
  buildNifcIncidentFilter,
  buildNifcLinePaint,
  classifyNifcIncidentType,
  nifcIncidentTypeLabel,
  parseArcGisPolygonFeatureCollection,
  resolveHmsDensityPresentation
} from '../src/config/wildfire-presentation';
import {
  activate as activateHms,
  cancelActivation as cancelHms,
  deactivate as deactivateHms
} from '../src/layers/hms-smoke';
import {
  activate as activateNifc,
  cancelActivation as cancelNifc,
  deactivate as deactivateNifc
} from '../src/layers/nifc-fires';
import {
  activate as activateSpc,
  cancelActivation as cancelSpc,
  deactivate as deactivateSpc
} from '../src/layers/spc-fire-weather';
import { registry } from '../src/state/registry';
import { buildFireKey, buildWhpKey } from '../src/ui/map-key';

const VALID_POLYGON_COLLECTION = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-121, 45],
            [-120, 45],
            [-120, 46],
            [-121, 45]
          ]
        ]
      }
    }
  ]
} as const;

function fakeMapHarness(): {
  readonly map: Parameters<typeof activateNifc>[0];
  readonly sources: Set<string>;
  readonly layers: Set<string>;
} {
  const sources = new Set<string>();
  const layers = new Set<string>();
  const map = {
    getSource: (id: string) => (sources.has(id) ? {} : undefined),
    addSource: (id: string) => {
      sources.add(id);
    },
    removeSource: (id: string) => {
      sources.delete(id);
    },
    getLayer: (id: string) => (layers.has(id) ? {} : undefined),
    addLayer: (layer: { id: string }) => {
      layers.add(layer.id);
    },
    removeLayer: (id: string) => {
      layers.delete(id);
    }
  } as unknown as Parameters<typeof activateNifc>[0];
  return { map, sources, layers };
}

test('NIFC splits wildfire, Prescribed fire, and unclassified perimeters', () => {
  expect(NIFC_INCIDENT_PRESENTATION.wildfire.codes).toEqual(['WF', 'CX']);
  expect(NIFC_INCIDENT_PRESENTATION.prescribed.codes).toEqual(['RX']);

  expect(classifyNifcIncidentType('WF')).toBe('wildfire');
  expect(classifyNifcIncidentType('cx')).toBe('wildfire');
  expect(classifyNifcIncidentType('RX')).toBe('prescribed');
  expect(classifyNifcIncidentType('other')).toBe('other');
  expect(classifyNifcIncidentType(null)).toBe('other');

  expect(nifcIncidentTypeLabel('WF')).toBe('Wildfire');
  expect(nifcIncidentTypeLabel('CX')).toBe('Wildfire complex');
  expect(nifcIncidentTypeLabel('RX')).toBe('Prescribed fire');
  expect(nifcIncidentTypeLabel('unknown')).toBe(
    'Other or unclassified fire perimeter'
  );

  const wildfireFilter = buildNifcIncidentFilter('wildfire');
  const prescribedFilter = buildNifcIncidentFilter('prescribed');
  const otherFilter = buildNifcIncidentFilter('other');
  expect(JSON.stringify(wildfireFilter)).not.toContain('RX');
  expect(JSON.stringify(prescribedFilter)).toContain('RX');
  expect(JSON.stringify(otherFilter)).toContain('WF');
  expect(JSON.stringify(otherFilter)).toContain('CX');
  expect(JSON.stringify(otherFilter)).toContain('RX');

  expect(buildNifcFillPaint('wildfire')).not.toEqual(
    buildNifcFillPaint('prescribed')
  );
  expect(buildNifcLinePaint('wildfire')).not.toEqual(
    buildNifcLinePaint('prescribed')
  );
  expect(buildNifcLinePaint('other')).toMatchObject({
    'line-color': NIFC_INCIDENT_PRESENTATION.other.lineColor,
    'line-dasharray': [2, 2]
  });
});

test('selected-area NIFC copy keeps Wildfire, Prescribed fire, and other counts distinct', () => {
  expect(buildNifcAreaPerimeterClaim([])).toBe(
    'No current mapped NIFC fire perimeters intersect this area.'
  );
  expect(buildNifcAreaPerimeterClaim(['RX'])).toBe(
    '1 current mapped NIFC fire perimeter intersects this area: 1 Prescribed fire perimeter.'
  );
  const mixed = buildNifcAreaPerimeterClaim(['WF', 'CX', 'RX', 'unknown']);
  expect(mixed).toContain('2 wildfire perimeters');
  expect(mixed).toContain('1 Prescribed fire perimeter');
  expect(mixed).toContain('1 other or unclassified fire perimeter');
  expect(mixed).not.toMatch(/4 active wildfires?/i);
});

test('HMS uses one cool veil and an explicit unclassified fallback', () => {
  const light = resolveHmsDensityPresentation('Light');
  const medium = resolveHmsDensityPresentation('medium');
  const heavy = resolveHmsDensityPresentation('HEAVY');
  const unknown = resolveHmsDensityPresentation('unexpected');
  const missing = resolveHmsDensityPresentation(undefined);

  expect(light).toBe(HMS_DENSITY_PRESENTATION.Light);
  expect(medium).toBe(HMS_DENSITY_PRESENTATION.Medium);
  expect(heavy).toBe(HMS_DENSITY_PRESENTATION.Heavy);
  expect(unknown).toBe(HMS_DENSITY_PRESENTATION.Unknown);
  expect(missing).toBe(HMS_DENSITY_PRESENTATION.Unknown);

  expect(light.color).toBe('#93a8c4');
  expect(medium.color).toBe('#93a8c4');
  expect(heavy.color).toBe('#93a8c4');
  expect([light.opacity, medium.opacity, heavy.opacity]).toEqual([
    0.08,
    0.17,
    0.33
  ]);
  expect({ color: unknown.color, opacity: unknown.opacity }).not.toEqual({
    color: light.color,
    opacity: light.opacity
  });

  expect(buildHmsSmokeFillPaint()).toEqual({
    'fill-color': [
      'match',
      ['upcase', ['to-string', ['coalesce', ['get', 'Density'], '']]],
      'LIGHT',
      HMS_DENSITY_PRESENTATION.Light.color,
      'MEDIUM',
      HMS_DENSITY_PRESENTATION.Medium.color,
      'HEAVY',
      HMS_DENSITY_PRESENTATION.Heavy.color,
      HMS_DENSITY_PRESENTATION.Unknown.color
    ],
    'fill-opacity': [
      'match',
      ['upcase', ['to-string', ['coalesce', ['get', 'Density'], '']]],
      'LIGHT',
      0.08,
      'MEDIUM',
      0.17,
      'HEAVY',
      0.33,
      HMS_DENSITY_PRESENTATION.Unknown.opacity
    ]
  });
  expect(HMS_OVERVIEW_QUALIFICATION).toContain(
    'current or previous UTC day'
  );
  expect(HMS_OVERVIEW_QUALIFICATION).not.toMatch(/current UTC day\./);
});

test('fire key composition reflects SPC-only, NIFC-only, and combined active sets', () => {
  const cases = [
    {
      name: 'SPC-only',
      active: new Set(['spc-fire-weather']),
      hasSpc: true,
      hasNifc: false
    },
    {
      name: 'NIFC-only',
      active: new Set(['nifc-fires']),
      hasSpc: false,
      hasNifc: true
    },
    {
      name: 'SPC and NIFC',
      active: new Set(['spc-fire-weather', 'nifc-fires']),
      hasSpc: true,
      hasNifc: true
    }
  ] as const;

  for (const entry of cases) {
    const key = buildFireKey(entry.active);
    const contract = `${key.ariaLabel} ${key.itemsHtml}`;

    expect(
      key.itemsHtml.includes('data-spc-fire-weather-key'),
      entry.name
    ).toBe(entry.hasSpc);
    expect(
      key.itemsHtml.includes('data-nifc-perimeter-key'),
      entry.name
    ).toBe(entry.hasNifc);
    expect(contract.includes('Storm Prediction Center'), entry.name).toBe(
      entry.hasSpc
    );
    expect(contract.includes('National Interagency Fire Center'), entry.name).toBe(
      entry.hasNifc
    );

    if (entry.hasNifc) {
      expect(contract).toContain('Mapped wildfire perimeter');
      expect(contract).toContain('Prescribed fire perimeter');
      expect(contract).toContain('Other or unclassified fire perimeter');
      expect(key.ariaLabel).toContain('current mapped Wildfire perimeters');
    }
    expect(contract).not.toMatch(/incident points?/i);
    expect(contract).not.toMatch(/hotspots?/i);
  }
});

test('static WHP key carries five classes and its source qualification', () => {
  const whp = buildWhpKey();
  const whpContract = `${whp.ariaLabel} ${whp.itemsHtml}`;
  for (const category of USFS_WHP_PRESENTATION.categories) {
    expect(whpContract).toContain(category.label);
  }
  expect(whpContract).toContain('static 2023 edition');
  expect(whpContract).toContain('270 m resolution');
  expect(whpContract).toContain('conterminous United States (CONUS) only');
  expect(whpContract).toContain('not current fire conditions or a forecast');
});

test('ArcGIS polygon parser rejects malformed and error-shaped HTTP 200 bodies', () => {
  const malformedBodies: unknown[] = [
    null,
    [],
    { type: 'FeatureCollection' },
    { type: 'FeatureCollection', features: {} },
    {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: { type: 'Polygon', coordinates: [] }
        }
      ]
    },
    {
      ...VALID_POLYGON_COLLECTION,
      exceededTransferLimit: 'yes'
    }
  ];

  for (const body of malformedBodies) {
    expect(() =>
      parseArcGisPolygonFeatureCollection(body, 'Test source')
    ).toThrow();
  }
  expect(() =>
    parseArcGisPolygonFeatureCollection(
      { error: { code: 500, message: 'query failed' } },
      'Test source'
    )
  ).toThrow('Test source ArcGIS error 500: query failed');

  const truncated = parseArcGisPolygonFeatureCollection(
    { ...VALID_POLYGON_COLLECTION, exceededTransferLimit: true },
    'Test source'
  );
  expect(truncated.collection.features).toHaveLength(1);
  expect(truncated.truncated).toBe(true);
});

test('NIFC, HMS, and SPC map invalid responses to unavailable and truncation to live partial', async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const documentDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'document'
  );
  const modules = [
    {
      key: 'nifc-fires',
      activate: activateNifc,
      deactivate: deactivateNifc
    },
    {
      key: 'hms-smoke',
      activate: activateHms,
      deactivate: deactivateHms
    },
    {
      key: 'spc-fire-weather',
      activate: activateSpc,
      deactivate: deactivateSpc
    }
  ] as const;
  const responses = [
    {
      name: 'malformed FeatureCollection',
      body: { type: 'FeatureCollection', features: [{}] },
      status: 'error',
      renders: false
    },
    {
      name: 'ArcGIS error body',
      body: { error: { code: 400, message: 'bad query' } },
      status: 'error',
      renders: false
    },
    {
      name: 'transfer-truncated FeatureCollection',
      body: { ...VALID_POLYGON_COLLECTION, exceededTransferLimit: true },
      status: 'degraded',
      renders: true
    }
  ] as const;

  try {
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { getElementById: () => null }
    });
    console.warn = () => undefined;

    for (const module of modules) {
      for (const response of responses) {
        globalThis.fetch = async () =>
          new Response(JSON.stringify(response.body), {
            status: 200,
            headers: { 'content-type': 'application/geo+json' }
          });
        const harness = fakeMapHarness();

        await module.activate(harness.map);

        expect(
          registry.getStatus(module.key),
          `${module.key}: ${response.name}`
        ).toBe(response.status);
        expect(
          harness.sources.size > 0,
          `${module.key}: ${response.name}`
        ).toBe(response.renders);
        expect(
          harness.layers.size > 0,
          `${module.key}: ${response.name}`
        ).toBe(response.renders);

        module.deactivate(harness.map);
        registry.deactivate(module.key);
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    for (const module of modules) {
      module.deactivate(fakeMapHarness().map);
      registry.deactivate(module.key);
    }
    if (documentDescriptor) {
      Object.defineProperty(globalThis, 'document', documentDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'document');
    }
  }
});

test('Wildfire network layers synchronously cancel pending activation', async () => {
  const originalFetch = globalThis.fetch;
  const fakeMap = {
    getSource: () => undefined,
    getLayer: () => undefined,
    addSource: () => {
      throw new Error('aborted activation mutated map state');
    },
    addLayer: () => {
      throw new Error('aborted activation mutated map state');
    },
    removeLayer: () => undefined,
    removeSource: () => undefined
  } as unknown as Parameters<typeof activateNifc>[0];

  const modules = [
    {
      key: 'nifc-fires',
      activate: activateNifc,
      cancel: cancelNifc
    },
    {
      key: 'hms-smoke',
      activate: activateHms,
      cancel: cancelHms
    },
    {
      key: 'spc-fire-weather',
      activate: activateSpc,
      cancel: cancelSpc
    }
  ] as const;

  try {
    for (const module of modules) {
      let noteFetchEntered: (() => void) | null = null;
      const fetchEntered = new Promise<void>((resolve) => {
        noteFetchEntered = resolve;
      });
      let fetchSignal: AbortSignal | null = null;

      globalThis.fetch = async (_input, init) => {
        fetchSignal = init?.signal ?? null;
        noteFetchEntered?.();

        return await new Promise<Response>((_resolve, reject) => {
          const rejectAbort = (): void =>
            reject(new DOMException('Aborted', 'AbortError'));
          if (fetchSignal?.aborted) rejectAbort();
          else fetchSignal?.addEventListener('abort', rejectAbort, { once: true });
        });
      };

      const activation = module.activate(fakeMap);
      await fetchEntered;
      module.cancel();

      // This assertion occurs without yielding after the off intent.
      expect(fetchSignal?.aborted, module.key).toBe(true);

      await activation;
      registry.deactivate(module.key);
    }
  } finally {
    globalThis.fetch = originalFetch;
    for (const module of modules) {
      module.cancel();
      registry.deactivate(module.key);
    }
  }
});
