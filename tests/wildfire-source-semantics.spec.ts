import { expect, test } from '@playwright/test';

import {
  FBFM40_PRESENTATION,
  FUELS_DRAPE_OPACITY,
  POWER_LINE_COLOR,
  POWER_LINE_WIDTHS,
  POWER_LINES_QUALIFICATION,
  POWER_PLANTS_QUALIFICATION,
  POWER_SHARED_QUALIFICATION,
  buildPowerLinePaint,
  HMS_DENSITY_PRESENTATION,
  HMS_OVERVIEW_QUALIFICATION,
  HMS_VOLUME_HEIGHT_SCALE_METERS,
  HMS_VOLUME_OPACITY,
  HMS_VOLUME_QUALIFICATION,
  NIFC_INCIDENT_PRESENTATION,
  USFS_WHP_PRESENTATION,
  WILDFIRE_PULSE_COLORS,
  WILDFIRE_PULSE_DURATION_MS,
  WILDFIRE_STATIC_COLOR,
  buildHmsSmokeFillPaint,
  buildHmsSmokeVolumePaint,
  buildNifcAreaPerimeterClaim,
  buildNifcFillPaint,
  buildNifcIncidentFilter,
  buildNifcLinePaint,
  classifyNifcIncidentType,
  interpolateWildfirePulseColor,
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
  deactivate as deactivateNifc,
  WILDFIRE_PULSE_PAINT_TARGETS
} from '../src/layers/nifc-fires';
import {
  activate as activateSpc,
  cancelActivation as cancelSpc,
  deactivate as deactivateSpc
} from '../src/layers/spc-fire-weather';
import { registry } from '../src/state/registry';
import {
  buildFireKey,
  buildWhpKey,
  resolveMapKeyFamily
} from '../src/ui/map-key';

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

const MIXED_FIRE_COLLECTION = {
  type: 'FeatureCollection',
  features: ['WF', 'RX', 'OTHER'].map((incidentType, index) => ({
    type: 'Feature',
    properties: { attr_IncidentTypeCategory: incidentType },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [-121 + index, 45],
          [-120 + index, 45],
          [-120 + index, 46],
          [-121 + index, 45]
        ]
      ]
    }
  }))
} as const;

interface PaintChange {
  readonly layerId: string;
  readonly paintProperty: string;
  readonly value: unknown;
}

function fakeMapHarness(): {
  readonly map: Parameters<typeof activateNifc>[0];
  readonly sources: Set<string>;
  readonly layers: Set<string>;
  readonly layerSpecs: Map<
    string,
    { readonly id: string; readonly paint?: Readonly<Record<string, unknown>> }
  >;
  readonly paintChanges: PaintChange[];
} {
  const sources = new Set<string>();
  const layers = new Set<string>();
  const layerSpecs = new Map<
    string,
    { readonly id: string; readonly paint?: Readonly<Record<string, unknown>> }
  >();
  const paintChanges: PaintChange[] = [];
  const map = {
    getSource: (id: string) => (sources.has(id) ? {} : undefined),
    addSource: (id: string) => {
      sources.add(id);
    },
    removeSource: (id: string) => {
      sources.delete(id);
    },
    getLayer: (id: string) => layerSpecs.get(id),
    addLayer: (layer: {
      id: string;
      paint?: Readonly<Record<string, unknown>>;
    }) => {
      layers.add(layer.id);
      layerSpecs.set(layer.id, layer);
    },
    removeLayer: (id: string) => {
      layers.delete(id);
      layerSpecs.delete(id);
    },
    setPaintProperty: (layerId: string, paintProperty: string, value: unknown) => {
      paintChanges.push({ layerId, paintProperty, value });
    }
  } as unknown as Parameters<typeof activateNifc>[0];
  return { map, sources, layers, layerSpecs, paintChanges };
}

function installAnimationBrowser(reducedMotion: boolean): {
  readonly frames: Map<number, (timestamp: number) => void>;
  readonly canceledFrames: number[];
  readonly visibilityListenerCount: () => number;
  readonly takeNextFrame: () => (timestamp: number) => void;
  readonly setHidden: (hidden: boolean) => void;
  readonly restore: () => void;
} {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const documentDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'document'
  );
  const frames = new Map<number, (timestamp: number) => void>();
  const canceledFrames: number[] = [];
  const visibilityListeners = new Set<() => void>();
  let nextFrameId = 1;
  let documentHidden = false;

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      matchMedia: () => ({ matches: reducedMotion }),
      requestAnimationFrame: (callback: (timestamp: number) => void) => {
        const id = nextFrameId++;
        frames.set(id, callback);
        return id;
      },
      cancelAnimationFrame: (id: number) => {
        canceledFrames.push(id);
        frames.delete(id);
      }
    }
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      get hidden() {
        return documentHidden;
      },
      getElementById: () => null,
      addEventListener: (type: string, listener: () => void) => {
        if (type === 'visibilitychange') visibilityListeners.add(listener);
      },
      removeEventListener: (type: string, listener: () => void) => {
        if (type === 'visibilitychange') visibilityListeners.delete(listener);
      }
    }
  });

  return {
    frames,
    canceledFrames,
    visibilityListenerCount: () => visibilityListeners.size,
    takeNextFrame: () => {
      const next = frames.entries().next().value as
        | [number, (timestamp: number) => void]
        | undefined;
      if (!next) throw new Error('No wildfire animation frame was scheduled.');
      frames.delete(next[0]);
      return next[1];
    },
    setHidden: (hidden: boolean) => {
      documentHidden = hidden;
      for (const listener of [...visibilityListeners]) listener();
    },
    restore: () => {
      if (windowDescriptor) {
        Object.defineProperty(globalThis, 'window', windowDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
      if (documentDescriptor) {
        Object.defineProperty(globalThis, 'document', documentDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'document');
      }
    }
  };
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

test('wildfire pulse palette has an exact static midpoint and deterministic interpolation', () => {
  expect(WILDFIRE_PULSE_COLORS).toEqual([
    '#ff3300',
    '#ff4c00',
    '#ff6600'
  ]);
  expect(WILDFIRE_STATIC_COLOR).toBe('#ff4c00');
  expect(NIFC_INCIDENT_PRESENTATION.wildfire.fillColor).toBe(
    WILDFIRE_STATIC_COLOR
  );
  expect(NIFC_INCIDENT_PRESENTATION.wildfire.lineColor).toBe(
    WILDFIRE_STATIC_COLOR
  );

  const quarterCycle = WILDFIRE_PULSE_DURATION_MS / 4;
  expect(interpolateWildfirePulseColor(0)).toBe('#ff3300');
  expect(interpolateWildfirePulseColor(quarterCycle)).toBe('#ff4c00');
  expect(interpolateWildfirePulseColor(quarterCycle * 2)).toBe('#ff6600');
  expect(interpolateWildfirePulseColor(quarterCycle * 3)).toBe('#ff4c00');
  expect(interpolateWildfirePulseColor(WILDFIRE_PULSE_DURATION_MS)).toBe(
    '#ff3300'
  );
  expect(interpolateWildfirePulseColor(Number.NaN)).toBe(
    WILDFIRE_STATIC_COLOR
  );
  expect(interpolateWildfirePulseColor(quarterCycle / 2)).not.toBe(
    WILDFIRE_PULSE_COLORS[0]
  );
  expect(interpolateWildfirePulseColor(quarterCycle / 2)).not.toBe(
    WILDFIRE_PULSE_COLORS[1]
  );

  expect(buildNifcFillPaint('wildfire')).toMatchObject({
    'fill-color': WILDFIRE_STATIC_COLOR,
    'fill-color-transition': { duration: 0, delay: 0 }
  });
  expect(buildNifcLinePaint('wildfire')).toMatchObject({
    'line-color': WILDFIRE_STATIC_COLOR,
    'line-color-transition': { duration: 0, delay: 0 }
  });
});

test('NIFC pulse updates only WF/CX paint and deactivation cancels stale frames', async () => {
  const originalFetch = globalThis.fetch;
  const browser = installAnimationBrowser(false);
  const harness = fakeMapHarness();
  globalThis.fetch = async () =>
    new Response(JSON.stringify(MIXED_FIRE_COLLECTION), {
      status: 200,
      headers: { 'content-type': 'application/geo+json' }
    });

  try {
    await activateNifc(harness.map);

    expect(WILDFIRE_PULSE_PAINT_TARGETS).toEqual([
      { layerId: 'nifc-fires-fill', paintProperty: 'fill-color' },
      { layerId: 'nifc-fires-outline', paintProperty: 'line-color' }
    ]);
    expect(browser.frames.size).toBe(1);
    expect(browser.visibilityListenerCount()).toBe(1);

    const firstFrameAt = 1_000;
    browser.takeNextFrame()(firstFrameAt);
    expect(harness.paintChanges).toEqual([
      {
        layerId: 'nifc-fires-fill',
        paintProperty: 'fill-color',
        value: WILDFIRE_STATIC_COLOR
      },
      {
        layerId: 'nifc-fires-outline',
        paintProperty: 'line-color',
        value: WILDFIRE_STATIC_COLOR
      }
    ]);

    browser.takeNextFrame()(
      firstFrameAt + WILDFIRE_PULSE_DURATION_MS / 4
    );
    expect(harness.paintChanges.slice(-2)).toEqual([
      {
        layerId: 'nifc-fires-fill',
        paintProperty: 'fill-color',
        value: WILDFIRE_PULSE_COLORS[2]
      },
      {
        layerId: 'nifc-fires-outline',
        paintProperty: 'line-color',
        value: WILDFIRE_PULSE_COLORS[2]
      }
    ]);
    expect(
      harness.paintChanges.some(
        ({ layerId }) =>
          layerId.includes('prescribed') || layerId.includes('other')
      )
    ).toBe(false);

    browser.setHidden(true);
    expect(browser.frames.size).toBe(0);
    expect(browser.canceledFrames).toHaveLength(1);
    browser.setHidden(false);
    expect(browser.frames.size).toBe(1);

    const staleFrame = [...browser.frames.values()][0];
    expect(staleFrame).toBeDefined();
    const paintCountBeforeDeactivate = harness.paintChanges.length;
    deactivateNifc(harness.map);
    expect(browser.frames.size).toBe(0);
    expect(browser.visibilityListenerCount()).toBe(0);
    expect(browser.canceledFrames).toHaveLength(2);

    staleFrame?.(firstFrameAt + WILDFIRE_PULSE_DURATION_MS / 2);
    expect(harness.paintChanges).toHaveLength(paintCountBeforeDeactivate);
    expect(harness.layers.size).toBe(0);
  } finally {
    deactivateNifc(harness.map);
    registry.deactivate('nifc-fires');
    globalThis.fetch = originalFetch;
    browser.restore();
  }
});

test('reduced motion keeps wildfire paint static and schedules no pulse', async () => {
  const originalFetch = globalThis.fetch;
  const browser = installAnimationBrowser(true);
  const harness = fakeMapHarness();
  globalThis.fetch = async () =>
    new Response(JSON.stringify(MIXED_FIRE_COLLECTION), {
      status: 200,
      headers: { 'content-type': 'application/geo+json' }
    });

  try {
    await activateNifc(harness.map);

    expect(browser.frames.size).toBe(0);
    expect(browser.visibilityListenerCount()).toBe(0);
    expect(harness.paintChanges).toHaveLength(0);
    expect(harness.layerSpecs.get('nifc-fires-fill')?.paint).toMatchObject({
      'fill-color': WILDFIRE_STATIC_COLOR
    });
    expect(harness.layerSpecs.get('nifc-fires-outline')?.paint).toMatchObject({
      'line-color': WILDFIRE_STATIC_COLOR
    });
    expect(harness.layerSpecs.get('nifc-prescribed-fill')?.paint).toMatchObject({
      'fill-color': NIFC_INCIDENT_PRESENTATION.prescribed.fillColor
    });
    expect(harness.layerSpecs.get('nifc-other-outline')?.paint).toMatchObject({
      'line-color': NIFC_INCIDENT_PRESENTATION.other.lineColor
    });
  } finally {
    deactivateNifc(harness.map);
    registry.deactivate('nifc-fires');
    globalThis.fetch = originalFetch;
    browser.restore();
  }
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

test('smoke volume heights are the 2D opacities scaled, rank identically, and Unknown never falls to Light', () => {
  const paint = buildHmsSmokeVolumePaint();
  const height = paint['fill-extrusion-height'] as unknown[];

  // Exact match-expression shape, mirroring buildHmsSmokeFillPaint: the
  // Unknown class is the FALLBACK branch, never routed through 'LIGHT'.
  expect(height).toEqual([
    'match',
    ['upcase', ['to-string', ['coalesce', ['get', 'Density'], '']]],
    'LIGHT',
    320,
    'MEDIUM',
    680,
    'HEAVY',
    1320,
    480
  ]);

  const heights = {
    Light: 320,
    Medium: 680,
    Heavy: 1320,
    Unknown: 480
  } as const;
  const classes = ['Light', 'Medium', 'Heavy', 'Unknown'] as const;

  // The baked literals are exactly the 2D veil opacities times one scale.
  for (const cls of classes) {
    expect(heights[cls]).toBeCloseTo(
      HMS_DENSITY_PRESENTATION[cls].opacity * HMS_VOLUME_HEIGHT_SCALE_METERS,
      6
    );
  }

  // Height ranking matches the ruled opacity ranking exactly.
  const byOpacity = [...classes].sort(
    (a, b) => HMS_DENSITY_PRESENTATION[a].opacity - HMS_DENSITY_PRESENTATION[b].opacity
  );
  const byHeight = [...classes].sort((a, b) => heights[a] - heights[b]);
  expect(byHeight).toEqual(byOpacity);

  // Unknown is visually distinct from Light in the vertical read too.
  expect(heights.Unknown).not.toBe(heights.Light);
  expect(heights.Unknown).toBeGreaterThan(heights.Light);
  expect(heights.Unknown).toBeLessThan(heights.Medium);

  // Colors mirror the 2D veil exactly; the volume translucency is the
  // ruled mid-ramp constant (fill-extrusion-opacity is not data-driven).
  expect(paint['fill-extrusion-color']).toEqual(
    buildHmsSmokeFillPaint()['fill-color']
  );
  expect(paint['fill-extrusion-opacity']).toBe(HMS_VOLUME_OPACITY);
  expect(HMS_VOLUME_OPACITY).toBe(HMS_DENSITY_PRESENTATION.Medium.opacity);
  expect(paint['fill-extrusion-base']).toBe(0);

  // The legend qualification states what the vertical treatment is NOT.
  expect(HMS_VOLUME_QUALIFICATION).toMatch(/stylized/i);
  expect(HMS_VOLUME_QUALIFICATION).toMatch(
    /not measured plume height, concentration, or transport/i
  );
});

test('the FBFM40 drape key carries the issuer palette verbatim and a snapshot qualification', () => {
  const codes = FBFM40_PRESENTATION.classes.map((c) => c.code);
  // The full issuer key, one row per served class, no invented grouping:
  // 5 nonburnable NB classes plus the 39 served burnable models (the
  // LF2024 CONUS legend fetched at bake time; GR9 is not served there).
  expect(codes).toHaveLength(44);
  expect(new Set(codes).size).toBe(44);
  const families = new Set(codes.map((code) => code.replace(/\d+$/, '')));
  expect([...families].sort()).toEqual(['GR', 'GS', 'NB', 'SB', 'SH', 'TL', 'TU']);
  for (const entry of FBFM40_PRESENTATION.classes) {
    expect(entry.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(entry.label.length).toBeGreaterThan(3);
  }
  // Spot-check issuer colors against the fetched LF2024 legend evidence.
  const byCode = new Map(FBFM40_PRESENTATION.classes.map((c) => [c.code, c.color]));
  expect(byCode.get('NB8')).toBe('#000ed6');
  expect(byCode.get('TU5')).toBe('#267300');
  expect(byCode.get('TL5')).toBe('#bee8ff');
  expect(byCode.get('SB2')).toBe('#c500ff');

  // The qualification names the vintage and denies the prediction read.
  expect(FBFM40_PRESENTATION.qualification).toMatch(/LANDFIRE 2024/);
  expect(FBFM40_PRESENTATION.qualification).toMatch(/reduced resolution/i);
  expect(FBFM40_PRESENTATION.qualification).toMatch(/translucent/i);
  expect(FBFM40_PRESENTATION.qualification).toMatch(
    /not current conditions, fire behavior, or a forecast/i
  );

  // The drape stays translucent context under perimeters and smoke.
  expect(FUELS_DRAPE_OPACITY).toBeGreaterThan(0);
  expect(FUELS_DRAPE_OPACITY).toBeLessThanOrEqual(0.6);
});

test('the power context maps issuer voltage classes to width only, with the archive caveat pinned', () => {
  // Exactly the seven VOLT_CLASS values served inside the PNW envelope
  // (verified live 2026-08-19 UTC), unknowns included as their own class.
  const byClass = new Map<string, number>(
    POWER_LINE_WIDTHS as readonly (readonly [string, number])[]
  );
  expect([...byClass.keys()].sort()).toEqual(
    ['100-161', '220-287', '345', '500', 'DC', 'NOT AVAILABLE', 'UNDER 100'].sort()
  );
  // Width follows the issuer's kV ordering; the unknown sentinel draws
  // thinnest so absence of data never reads as high voltage.
  const kvOrder = ['UNDER 100', '100-161', '220-287', '345', '500'];
  for (let i = 1; i < kvOrder.length; i++) {
    expect(byClass.get(kvOrder[i])!).toBeGreaterThan(byClass.get(kvOrder[i - 1])!);
  }
  expect(byClass.get('NOT AVAILABLE')).toBe(byClass.get('UNDER 100'));

  // One color for every line: the paint carries no data-driven color, so
  // the layer can never read as a severity ramp.
  const paint = buildPowerLinePaint();
  expect(paint['line-color']).toBe(POWER_LINE_COLOR);
  const width = paint['line-width'] as unknown[];
  expect(width[0]).toBe('match');
  // The match falls back to the thinnest width for any unseen class.
  expect(width[width.length - 1]).toBe(0.6);

  // The qualifications pin the archive currency caveat, the mixed-status
  // disclosure, the dashed unknown-class treatment, the plants' bounded
  // meaning, and the honest absence of substations and distribution
  // lines. Composed per active surface in src/layers/power-3d.ts so no
  // sentence ever describes a layer that is not in the scene.
  expect(POWER_LINES_QUALIFICATION).toMatch(/ARCHIVED/);
  expect(POWER_LINES_QUALIFICATION).toMatch(/2024-09-30/);
  expect(POWER_LINES_QUALIFICATION).toMatch(/inactive or status-unknown/i);
  expect(POWER_LINES_QUALIFICATION).toMatch(/dashed at the thinnest width/i);
  expect(POWER_PLANTS_QUALIFICATION).toMatch(/EIA inventory locations/);
  expect(POWER_PLANTS_QUALIFICATION).toMatch(/location only, not capacity or fuel/i);
  expect(POWER_SHARED_QUALIFICATION).toMatch(
    /never for siting or safety-critical decisions/i
  );
  expect(POWER_SHARED_QUALIFICATION).toMatch(
    /substations and distribution lines have no authoritative public national source/i
  );
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

test('a still-loading fire product renders a named loading section, never an omission (W2-D6)', () => {
  // NIFC in flight beside a live SPC outlook: the section is named with a
  // loading row instead of silently absent.
  const nifcLoading = buildFireKey(
    new Set(['spc-fire-weather']),
    new Set(['nifc-fires'])
  );
  expect(nifcLoading.itemsHtml).toContain('data-spc-fire-weather-key');
  expect(nifcLoading.itemsHtml).toContain('data-nifc-perimeter-key');
  expect(nifcLoading.itemsHtml).toContain('data-key-loading="nifc-fires"');
  expect(nifcLoading.ariaLabel).toContain(
    'National Interagency Fire Center (NIFC) current mapped fire perimeters loading.'
  );

  // The reverse: SPC loading beside live perimeters.
  const spcLoading = buildFireKey(
    new Set(['nifc-fires']),
    new Set(['spc-fire-weather'])
  );
  expect(spcLoading.itemsHtml).toContain('data-key-loading="spc-fire-weather"');
  expect(spcLoading.ariaLabel).toContain(
    'Storm Prediction Center (SPC) Day 1 fire-weather outlook loading.'
  );
  expect(spcLoading.ariaLabel).toContain('current mapped Wildfire perimeters');

  // Loading-only is enough to earn the key (activation continuity).
  const bothLoading = buildFireKey(
    new Set(),
    new Set(['spc-fire-weather', 'nifc-fires'])
  );
  expect(bothLoading.itemsHtml).toContain('data-key-loading="spc-fire-weather"');
  expect(bothLoading.itemsHtml).toContain('data-key-loading="nifc-fires"');

  // Absence semantics unchanged: nothing active or loading still throws.
  expect(() => buildFireKey(new Set(), new Set())).toThrow();
});

test('map-key family precedence matches the rendered key for mixed active sets', () => {
  expect(
    resolveMapKeyFamily(
      new Set(['heatrisk', 'spc-fire-weather', 'nadm-drought', 'nifc-fires'])
    )
  ).toBe('heat');
  expect(
    resolveMapKeyFamily(
      new Set(['spc-fire-weather', 'nadm-drought', 'nifc-fires'])
    )
  ).toBe('fire');
  expect(resolveMapKeyFamily(new Set(['nadm-drought', 'nifc-fires']))).toBe(
    'drought'
  );
  expect(resolveMapKeyFamily(new Set(['nifc-fires']))).toBe('fire');
  // The SST anomaly surface outranks the NIFC event fallback like every
  // other condition surface, and carries no hazard family (W2-D1).
  expect(resolveMapKeyFamily(new Set(['sst-anomaly', 'nifc-fires']))).toBe(
    'other'
  );
  expect(resolveMapKeyFamily(new Set(['sst-anomaly']))).toBe('other');
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
