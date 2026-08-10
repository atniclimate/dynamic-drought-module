import { expect, test } from '@playwright/test';
import type maplibregl from 'maplibre-gl';
import { readFileSync } from 'node:fs';

import { pointHasHeatRiskCoverage } from '../src/layers/heatrisk-coverage';
import { watchRasterTiles } from '../src/util/raster-status';

type Handler = (event: Record<string, unknown>) => void;

interface StateFeature {
  readonly properties: {
    readonly STUSPS: string;
  };
  readonly geometry: {
    readonly coordinates: unknown;
  };
}

interface StateFeatureCollection {
  readonly features: readonly StateFeature[];
}

const heatRiskSource = readFileSync(
  new URL('../src/layers/heatrisk.ts', import.meta.url),
  'utf8'
);

function visitVertices(
  coordinates: unknown,
  visit: (lng: number, lat: number) => void
): void {
  if (!Array.isArray(coordinates)) {
    throw new Error('Expected an array of GeoJSON coordinates.');
  }
  if (
    coordinates.length >= 2 &&
    typeof coordinates[0] === 'number' &&
    typeof coordinates[1] === 'number'
  ) {
    visit(coordinates[0], coordinates[1]);
    return;
  }
  for (const child of coordinates) visitVertices(child, visit);
}

class FakeMap {
  private readonly handlers = new Map<string, Handler[]>();

  on(name: string, handler: Handler): void {
    const current = this.handlers.get(name) ?? [];
    current.push(handler);
    this.handlers.set(name, current);
  }

  off(name: string, handler: Handler): void {
    const current = this.handlers.get(name) ?? [];
    this.handlers.set(
      name,
      current.filter((candidate) => candidate !== handler)
    );
  }

  fire(name: string, event: Record<string, unknown>): void {
    for (const handler of this.handlers.get(name) ?? []) handler(event);
  }
}

test('the raster watcher keeps its existing heal-only success behavior by default', () => {
  const map = new FakeMap();
  const reports: string[] = [];
  watchRasterTiles(
    map as unknown as maplibregl.Map,
    'shared-raster',
    (status) => reports.push(status)
  );

  map.fire('sourcedata', {
    sourceId: 'shared-raster',
    dataType: 'source',
    tile: {}
  });
  expect(reports).toEqual([]);

  for (let index = 0; index < 3; index += 1) {
    map.fire('error', {
      sourceId: 'shared-raster',
      error: new Error('synthetic tile failure')
    });
  }
  expect(reports).toEqual(['error']);

  map.fire('sourcedata', {
    sourceId: 'shared-raster',
    dataType: 'source',
    tile: {}
  });
  expect(reports).toEqual(['error', 'ready']);
});

test('the HeatRisk opt-in reports its first successful tile once', () => {
  const map = new FakeMap();
  const reports: string[] = [];
  const watcher = watchRasterTiles(
    map as unknown as maplibregl.Map,
    'heatrisk-frame',
    (status) => reports.push(status),
    { reportInitialSuccess: true }
  );

  const tileEvent = {
    sourceId: 'heatrisk-frame',
    dataType: 'source',
    tile: {}
  };
  map.fire('sourcedata', tileEvent);
  map.fire('sourcedata', tileEvent);
  expect(reports).toEqual(['ready']);

  watcher.reset();
  map.fire('sourcedata', tileEvent);
  expect(reports).toEqual(['ready', 'ready']);
});

test('the HeatRisk opt-in fails when its positive-success deadline expires', async () => {
  const map = new FakeMap();
  const reports: string[] = [];
  watchRasterTiles(
    map as unknown as maplibregl.Map,
    'heatrisk-frame',
    (status) => reports.push(status),
    {
      reportInitialSuccess: true,
      requestCompletenessDeadlineMs: 30
    }
  );

  map.fire('sourcedataloading', {
    sourceId: 'heatrisk-frame',
    dataType: 'source',
    tile: { tileID: { key: 'missing-1' } }
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(reports).toEqual(['error']);
});

test('the HeatRisk opt-in reports a mixed-success request cycle as partial', () => {
  const map = new FakeMap();
  const reports: string[] = [];
  watchRasterTiles(
    map as unknown as maplibregl.Map,
    'heatrisk-frame',
    (status) => reports.push(status),
    {
      reportInitialSuccess: true,
      requestCompletenessDeadlineMs: 1_000
    }
  );

  for (const key of ['loaded-1', 'missing-1']) {
    map.fire('sourcedataloading', {
      sourceId: 'heatrisk-frame',
      dataType: 'source',
      tile: { tileID: { key } }
    });
  }
  map.fire('sourcedata', {
    sourceId: 'heatrisk-frame',
    dataType: 'source',
    tile: { tileID: { key: 'loaded-1' } }
  });
  map.fire('idle', {});

  expect(reports).toEqual(['degraded']);
});

test('completeness reports ready when the target source settles without map idle', () => {
  const map = new FakeMap();
  const reports: string[] = [];
  watchRasterTiles(
    map as unknown as maplibregl.Map,
    'selected-frame',
    (status) => reports.push(status),
    {
      reportInitialSuccess: true,
      requestCompletenessDeadlineMs: 1_000
    }
  );

  map.fire('sourcedata', {
    sourceId: 'unrelated-source',
    dataType: 'source',
    isSourceLoaded: true
  });
  map.fire('sourcedata', {
    sourceId: 'selected-frame',
    dataType: 'source',
    isSourceLoaded: true
  });
  expect(reports).toEqual([]);

  map.fire('sourcedataloading', {
    sourceId: 'selected-frame',
    dataType: 'source',
    tile: { tileID: { key: 'loaded-1' } }
  });
  map.fire('sourcedata', {
    sourceId: 'selected-frame',
    dataType: 'source',
    isSourceLoaded: true,
    tile: { tileID: { key: 'loaded-1' } }
  });

  expect(reports).toEqual(['ready']);
});

test('completeness reports partial when the target source settles with known holes', () => {
  const map = new FakeMap();
  const reports: string[] = [];
  watchRasterTiles(
    map as unknown as maplibregl.Map,
    'selected-frame',
    (status) => reports.push(status),
    {
      reportInitialSuccess: true,
      requestCompletenessDeadlineMs: 1_000
    }
  );

  for (const key of ['loaded-1', 'missing-1']) {
    map.fire('sourcedataloading', {
      sourceId: 'selected-frame',
      dataType: 'source',
      tile: { tileID: { key } }
    });
  }
  map.fire('sourcedata', {
    sourceId: 'selected-frame',
    dataType: 'source',
    isSourceLoaded: false,
    tile: { tileID: { key: 'loaded-1' } }
  });
  map.fire('sourcedata', {
    sourceId: 'selected-frame',
    dataType: 'source',
    isSourceLoaded: true
  });

  expect(reports).toEqual(['degraded']);
});

test('completeness waits through three early errors and reports mixed success as partial', () => {
  const map = new FakeMap();
  const reports: string[] = [];
  watchRasterTiles(
    map as unknown as maplibregl.Map,
    'selected-frame',
    (status) => reports.push(status),
    {
      reportInitialSuccess: true,
      requestCompletenessDeadlineMs: 1_000
    }
  );

  for (const key of ['failed-1', 'failed-2', 'failed-3', 'loaded-1']) {
    map.fire('sourcedataloading', {
      sourceId: 'selected-frame',
      dataType: 'source',
      tile: { tileID: { key } }
    });
  }
  for (let index = 0; index < 3; index += 1) {
    map.fire('error', {
      sourceId: 'selected-frame',
      error: new Error(`synthetic tile failure ${index + 1}`)
    });
  }

  expect(reports).toEqual([]);
  map.fire('sourcedata', {
    sourceId: 'selected-frame',
    dataType: 'source',
    tile: { tileID: { key: 'loaded-1' } }
  });
  map.fire('idle', {});

  expect(reports).toEqual(['degraded']);
});

test('completeness still reports total failure after three early errors', () => {
  const map = new FakeMap();
  const reports: string[] = [];
  watchRasterTiles(
    map as unknown as maplibregl.Map,
    'selected-frame',
    (status) => reports.push(status),
    {
      reportInitialSuccess: true,
      requestCompletenessDeadlineMs: 1_000
    }
  );

  for (const key of ['failed-1', 'failed-2', 'failed-3']) {
    map.fire('sourcedataloading', {
      sourceId: 'selected-frame',
      dataType: 'source',
      tile: { tileID: { key } }
    });
    map.fire('error', {
      sourceId: 'selected-frame',
      error: new Error(`synthetic tile failure ${key}`)
    });
  }

  expect(reports).toEqual([]);
  map.fire('idle', {});

  expect(reports).toEqual(['error']);
});

test('the HeatRisk completeness opt-in treats an empty idle cycle as complete', () => {
  const map = new FakeMap();
  const reports: string[] = [];
  watchRasterTiles(
    map as unknown as maplibregl.Map,
    'heatrisk-frame',
    (status) => reports.push(status),
    {
      reportInitialSuccess: true,
      requestCompletenessDeadlineMs: 1_000
    }
  );

  map.fire('idle', {});

  expect(reports).toEqual(['ready']);
});

test('a completeness consumer can require positive tile evidence at idle', () => {
  const map = new FakeMap();
  const reports: string[] = [];
  watchRasterTiles(
    map as unknown as maplibregl.Map,
    'historical-ground',
    (status) => reports.push(status),
    {
      reportInitialSuccess: true,
      requestCompletenessDeadlineMs: 1_000,
      emptyIdleOutcome: 'error'
    }
  );

  map.fire('idle', {});

  expect(reports).toEqual(['error']);
});

test('the HeatRisk completeness opt-in retains its no-evidence deadline', async () => {
  const map = new FakeMap();
  const reports: string[] = [];
  watchRasterTiles(
    map as unknown as maplibregl.Map,
    'heatrisk-frame',
    (status) => reports.push(status),
    {
      reportInitialSuccess: true,
      requestCompletenessDeadlineMs: 30
    }
  );

  await new Promise((resolve) => setTimeout(resolve, 60));

  expect(reports).toEqual(['error']);
});

test('the HeatRisk coverage gate has no runtime state-geometry request', () => {
  expect(heatRiskSource).not.toContain('URLS.usStatesLocal');
});

test('the HeatRisk coverage ring contains every qualified geometry vertex', () => {
  const states = JSON.parse(
    readFileSync(
      new URL('../public/data/us-states.geojson', import.meta.url),
      'utf8'
    )
  ) as StateFeatureCollection;
  const excluded = new Set(['AK', 'HI', 'PR']);
  let vertexCount = 0;
  let outsideVertexCount = 0;

  for (const feature of states.features) {
    if (excluded.has(feature.properties.STUSPS)) continue;
    visitVertices(feature.geometry.coordinates, (lng, lat) => {
      vertexCount += 1;
      if (!pointHasHeatRiskCoverage(lng, lat)) outsideVertexCount += 1;
    });
  }

  expect(vertexCount).toBe(11_009);
  expect(outsideVertexCount).toBe(0);
});

for (const [name, lng, lat, expected] of [
  ['Presidio, Texas', -104.371, 29.56, true],
  ['Terlingua, Texas', -103.616, 29.321, true],
  ['Chisos Basin, Texas', -103.303, 29.27, true],
  ['Cape Flattery, Washington', -124.735, 48.383, true],
  ['Neah Bay, Washington', -124.625, 48.368, true],
  ['Brownsville, Texas', -97.497, 25.902, true],
  ['Key West, Florida', -81.78, 24.555, true],
  ['Caribou, Maine', -68.016, 46.861, true],
  ['San Diego, California', -117.161, 32.716, true],
  ['Nassau, Bahamas', -77.355, 25.044, false],
  ['Victoria, British Columbia', -123.366, 48.428, true],
  ['Tijuana, Mexico', -117.038, 32.514, true],
] as const) {
  test(`the HeatRisk coverage gate classifies ${name} with its documented outward bias`, () => {
    expect(pointHasHeatRiskCoverage(lng, lat)).toBe(expected);
  });
}

test('the HeatRisk coverage gate excludes distant non-covered centers', () => {
  expect(pointHasHeatRiskCoverage(-122.33, 47.61)).toBe(true);
  expect(pointHasHeatRiskCoverage(-149.9, 61.22)).toBe(false);
  expect(pointHasHeatRiskCoverage(-157.86, 21.31)).toBe(false);
  expect(pointHasHeatRiskCoverage(-66.11, 18.47)).toBe(false);
  expect(pointHasHeatRiskCoverage(-123.12, 49.28)).toBe(false);
});
