import { expect, test } from '@playwright/test';

import {
  DRAPE_OPACITY,
  FBFM40_PRESENTATION,
  POWER_LINE_COLOR,
  POWER_LINE_WIDTHS,
  POWER_LINES_QUALIFICATION,
  POWER_PLANTS_QUALIFICATION,
  POWER_SHARED_QUALIFICATION,
  STRUCTURES_PRESENTATION,
  STRUCTURES_QUALIFICATION,
  buildPowerLinePaint,
  buildStructuresMeasuredPaint,
  buildStructuresPlaceholderPaint,
  HMS_DENSITY_PRESENTATION,
  HMS_OVERVIEW_QUALIFICATION,
  HMS_VOLUME_HEIGHT_SCALE_METERS,
  HMS_VOLUME_HEIGHTS,
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
import { FIRE3D_COVERAGE_NOTE } from '../src/config/fire3d-presentation';
import { STRUCTURES_EMBED_LINE } from '../src/map/fire3d-context';
import { registry } from '../src/state/registry';
import {
  buildFireKey,
  buildWhpKey,
  resolveMapKeyFamily
} from '../src/ui/map-key';
import { captureWarnings, type CapturedWarnings } from './map-harness';

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

    // The two FLAT targets, pinned. The list also carries the DR-064
    // ribbon's six fade slabs so the 3D scene pulses in phase with this
    // outline; those layers exist only while the 3D Fire mode is active, so
    // on this flat map the controller skips them (the paint assertions
    // below see exactly two writes per frame). tests/fire3d-mode.spec.ts
    // owns their side of the contract.
    expect(
      WILDFIRE_PULSE_PAINT_TARGETS.filter(
        (target) => !target.layerId.startsWith('nifc-perimeter-ribbon')
      )
    ).toEqual([
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

test('selected-area NIFC copy names the bounding box, keeps categories distinct, and reports a full page as a floor', () => {
  // DR-024 b: the query covers a bounding box wider than the boundary, so
  // the sentence names the box and never "this area".
  expect(buildNifcAreaPerimeterClaim([])).toBe(
    'No current mapped NIFC fire perimeters intersect the bounding box around this selection.'
  );
  // DR-058 a: one category, one count, no restatement.
  expect(buildNifcAreaPerimeterClaim(['RX'])).toBe(
    '1 current mapped NIFC Prescribed fire perimeter intersects the bounding box around this selection.'
  );
  expect(buildNifcAreaPerimeterClaim(['WF', 'WF', 'CX'])).toBe(
    '3 current mapped NIFC wildfire perimeters intersect the bounding box around this selection.'
  );
  const mixed = buildNifcAreaPerimeterClaim(['WF', 'CX', 'RX', 'unknown']);
  expect(mixed).toBe(
    '4 current mapped NIFC fire perimeters intersect the bounding box around this selection: 2 wildfire, 1 Prescribed fire and 1 other or unclassified fire.'
  );
  expect(mixed).not.toMatch(/4 active wildfires?/i);
  expect(mixed).not.toContain('this area');
  // A page returned at the record cap is a lower bound, and says so.
  const floor = buildNifcAreaPerimeterClaim(Array(50).fill('WF'), { truncated: true });
  expect(floor).toBe(
    '50 current mapped NIFC wildfire perimeters intersect the bounding box around this selection. The service returned its 50-record maximum, so this count is a lower bound.'
  );
  expect(buildNifcAreaPerimeterClaim(['WF'], { truncated: false })).not.toContain('lower bound');
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
    HMS_VOLUME_HEIGHTS.Light,
    'MEDIUM',
    HMS_VOLUME_HEIGHTS.Medium,
    'HEAVY',
    HMS_VOLUME_HEIGHTS.Heavy,
    HMS_VOLUME_HEIGHTS.Unknown
  ]);

  // The heights are DERIVED, not typed twice. Until 2026-08-19 they were
  // hand-copied literals in the paint and again in the legend, which is a
  // drift waiting to happen the moment the scale moves; the scale moved
  // that same day (4,000 to 10,000 m, because a plume hundreds of
  // kilometres wide and 320 m tall had nothing to read as volume).
  const heights = HMS_VOLUME_HEIGHTS;
  const classes = ['Light', 'Medium', 'Heavy', 'Unknown'] as const;

  // Each height is the 2D veil opacity times one scale, rounded to 10 m so
  // the legend reads as stylized rather than as a spurious measurement.
  for (const cls of classes) {
    expect(heights[cls]).toBe(
      Math.round(
        (HMS_DENSITY_PRESENTATION[cls].opacity *
          HMS_VOLUME_HEIGHT_SCALE_METERS) /
          10
      ) * 10
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

/**
 * The FBFM40 table outlived the drape it fed: the 3D scene swapped to the
 * hazard drape on 2026-08-19, and scripts/build-fuels-tiles.mjs remains the
 * restore path, which cross-checks this table against the served LANDFIRE
 * legend on every rebake. The table therefore still has to be true.
 */
test('the retired FBFM40 key still carries the issuer palette verbatim and a snapshot qualification', () => {
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

});

/**
 * The hazard drape that replaced it, and the reason the swap was possible
 * at all: WHP is a published hazard scale, so no recoloring was needed to
 * answer the owner's "yellow through red" ask.
 */
test('the WHP drape key mirrors the issuer legend exactly, including its two non-hazard classes', () => {
  const categories = USFS_WHP_PRESENTATION.categories;
  // SEVEN, not five. The raster carries values 1-7 and the issuer legend
  // names all seven; the two beyond the hazard scale paint pixels on the
  // map and so must appear in the key. Before 2026-08-19 this table listed
  // five classes in colors the service does not use, so grey and blue
  // areas rendered with nothing in the key to explain them.
  expect(categories).toHaveLength(7);
  expect(categories.map((c) => c.label)).toEqual([
    'Very Low',
    'Low',
    'Moderate',
    'High',
    'Very High',
    'Non-burnable',
    'Water'
  ]);
  // The issuer's own swatch colors, decoded from its legend endpoint and
  // re-verified by scripts/build-whp-tiles.mjs on every rebake.
  expect(categories.map((c) => c.color)).toEqual([
    '#38a300',
    '#a3ff94',
    '#ffff63',
    '#ffa300',
    '#ed1e00',
    '#e1e1e1',
    '#0070e1'
  ]);
  // The five hazard classes ARE the yellow-through-red progression the
  // owner asked for, without DDM choosing a single color.
  expect(USFS_WHP_PRESENTATION.qualification).toMatch(/2023 edition/);
  expect(USFS_WHP_PRESENTATION.qualification).toMatch(/270 m resolution/);
  expect(USFS_WHP_PRESENTATION.qualification).toMatch(
    /not current fire conditions or a forecast/i
  );
  // The two non-hazard classes are named as such, so neither reads as a
  // hazard rating of zero.
  expect(USFS_WHP_PRESENTATION.qualification).toMatch(/non-hazard classes/i);

  // The drape stays translucent context under perimeters and smoke.
  expect(DRAPE_OPACITY).toBeGreaterThan(0);
  expect(DRAPE_OPACITY).toBeLessThanOrEqual(0.6);
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
  // The absence statement grew a REASON on 2026-08-19: naming what is
  // missing was never the hard part; naming whose decision it is, and
  // that absence is not evidence of nonexistence, is what keeps a sparse
  // transmission network from reading as the whole grid.
  expect(POWER_SHARED_QUALIFICATION).toMatch(
    /substations and distribution circuits are absent because no authoritative public national source publishes them/i
  );
  expect(POWER_SHARED_QUALIFICATION).toMatch(
    /held privately by utilities/i
  );
  expect(POWER_SHARED_QUALIFICATION).toMatch(
    /withheld for security since 2022/i
  );
  expect(POWER_SHARED_QUALIFICATION).toMatch(
    /not evidence that none are present/i
  );
});

test('the committed structures archive and every in-app disclosure agree on release, share, and region', async () => {
  // The archive's own attribution (written by the bake from the extract's
  // provenance sidecar) is the ground truth; the UI constants may never
  // drift from it, or the legend misdescribes the artifact.
  const { readFileSync } = await import('node:fs');
  const { PMTiles } = await import('pmtiles');
  const bytes = readFileSync('public/data/structures-central-oregon.pmtiles');
  const reader = new PMTiles({
    getKey: () => 'test',
    getBytes: async (offset: number, length: number) => {
      const slice = bytes.subarray(offset, offset + length);
      return {
        data: slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength)
      };
    }
  });
  const meta = (await reader.getMetadata()) as { attribution: string };
  const attribution = meta.attribution;

  const release = /release (\d{4}-\d{2}-\d{2}\.\d+)/.exec(attribution)?.[1];
  const share = /(\d+)% of footprints/.exec(attribution)?.[1];
  expect(release).toBeTruthy();
  expect(share).toBeTruthy();
  expect(attribution).toContain('central Oregon pilot coverage only');

  expect(STRUCTURES_QUALIFICATION).toContain(`release ${release}`);
  expect(STRUCTURES_QUALIFICATION).toContain(`${share} percent`);
  expect(STRUCTURES_QUALIFICATION).toMatch(/central Oregon pilot coverage only/i);
  expect(FIRE3D_COVERAGE_NOTE).toMatch(/central Oregon/);
  expect(STRUCTURES_EMBED_LINE).toMatch(/central Oregon/);
});

test('the structures context separates published heights from disclosed placeholders', () => {
  // Two visibly different tones: the placeholder read must never pass as
  // a measured one.
  expect(STRUCTURES_PRESENTATION.measuredColor).not.toBe(
    STRUCTURES_PRESENTATION.placeholderColor
  );

  // Published heights extrude verbatim; placeholders follow the disclosed
  // rule (three meters per published floor, otherwise the fixed
  // placeholder), never an estimate dressed as data.
  const measured = buildStructuresMeasuredPaint();
  expect(measured['fill-extrusion-height']).toEqual(['get', 'h']);
  expect(measured['fill-extrusion-color']).toBe(
    STRUCTURES_PRESENTATION.measuredColor
  );
  const placeholder = buildStructuresPlaceholderPaint();
  expect(placeholder['fill-extrusion-height']).toEqual([
    'case',
    ['has', 'f'],
    ['*', ['get', 'f'], STRUCTURES_PRESENTATION.metersPerFloor],
    STRUCTURES_PRESENTATION.placeholderMeters
  ]);
  expect(placeholder['fill-extrusion-color']).toBe(
    STRUCTURES_PRESENTATION.placeholderColor
  );
  // fill-extrusion-opacity is not data-driven, so both layers share one
  // constant translucency (the smoke-volume constraint).
  expect(measured['fill-extrusion-opacity']).toBe(
    placeholder['fill-extrusion-opacity']
  );

  // The qualification pins the license, the pilot coverage, the height
  // split, and what the footprints are NOT.
  expect(STRUCTURES_QUALIFICATION).toMatch(/ODbL/);
  expect(STRUCTURES_QUALIFICATION).toMatch(/release 2026-07-22\.0/);
  expect(STRUCTURES_QUALIFICATION).toMatch(/central Oregon pilot coverage only/i);
  expect(STRUCTURES_QUALIFICATION).toMatch(/placeholder height/i);
  expect(STRUCTURES_QUALIFICATION).toMatch(
    /not parcel, occupancy, or condition records/i
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
  // other condition surface. Since UI-14(b) it carries its own 'enso'
  // family (src/ui/map-key.ts resolveMapKeyFamily) rather than 'other'.
  expect(resolveMapKeyFamily(new Set(['sst-anomaly', 'nifc-fires']))).toBe(
    'enso'
  );
  expect(resolveMapKeyFamily(new Set(['sst-anomaly']))).toBe('enso');
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
  const documentDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'document'
  );
  // `label` is the source name each module hands the shared ArcGIS parser,
  // so it is the name that reaches the log when the parse rejects a body.
  const modules = [
    {
      key: 'nifc-fires',
      activate: activateNifc,
      deactivate: deactivateNifc,
      label: 'NIFC WFIGS',
      failure: '[nifc-fires] WFIGS perimeters fetch failed.',
      truncation:
        '[nifc-fires] WFIGS response reached the ArcGIS transfer limit; rendering available perimeters as live (partial).'
    },
    {
      key: 'hms-smoke',
      activate: activateHms,
      deactivate: deactivateHms,
      label: 'NOAA HMS smoke',
      failure: '[hms-smoke] HMS smoke fetch failed.',
      truncation:
        '[hms-smoke] HMS response reached the ArcGIS transfer limit; rendering available plumes as live (partial).'
    },
    {
      key: 'spc-fire-weather',
      activate: activateSpc,
      deactivate: deactivateSpc,
      label: 'NOAA SPC fire-weather outlook',
      failure: '[spc-fire-weather] outlook fetch failed.',
      truncation:
        '[spc-fire-weather] outlook response reached the ArcGIS transfer limit; rendering available categories as live (partial).'
    }
  ] as const;
  // `reason` is the parser's own message, minus the source label it prefixes;
  // `null` means the body parsed and only the transfer-limit flag was raised.
  const responses = [
    {
      name: 'malformed FeatureCollection',
      body: { type: 'FeatureCollection', features: [{}] },
      status: 'error',
      renders: false,
      reason: 'response contained an invalid polygon feature.'
    },
    {
      name: 'ArcGIS error body',
      body: { error: { code: 400, message: 'bad query' } },
      status: 'error',
      renders: false,
      reason: 'ArcGIS error 400: bad query'
    },
    {
      name: 'transfer-truncated FeatureCollection',
      body: { ...VALID_POLYGON_COLLECTION, exceededTransferLimit: true },
      status: 'degraded',
      renders: true,
      reason: null
    }
  ] as const;
  // Captured inside the try below, so the patch cannot outlive a throw.
  let warnings: CapturedWarnings | undefined;

  try {
    warnings = captureWarnings();
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { getElementById: () => null }
    });

    for (const module of modules) {
      for (const response of responses) {
        const warnedBefore = warnings.messages.length;
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
        // Each of the nine cases says why exactly once, naming the source.
        expect(
          warnings.messages.slice(warnedBefore),
          `${module.key}: ${response.name}`
        ).toEqual([
          response.reason === null
            ? module.truncation
            : `${module.failure} Error: ${module.label} ${response.reason}`
        ]);

        module.deactivate(harness.map);
        registry.deactivate(module.key);
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
    warnings?.restore();
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
