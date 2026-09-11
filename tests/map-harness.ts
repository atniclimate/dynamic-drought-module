/**
 * Shared fake MapLibre map + browser-global stubs for Node-level module
 * tests (the wildfire-source-semantics fakeMapHarness pattern, extracted
 * and extended for the 3D Fire mode: terrain, sky, camera, layout, layer
 * order, and map events).
 *
 * These tests run in the Playwright runner's Node process against source
 * modules directly (playwright.config doctrine: the production BROWSER
 * build has no dev handles, so render-level truth is asserted here against
 * the module's own map calls, and browser specs assert the
 * production-observable stamps and chrome).
 */

import { test } from '@playwright/test';
import type * as maplibregl from 'maplibre-gl';

export interface RecordedCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

export interface FakeLayerSpec {
  readonly id: string;
  readonly type?: string;
  readonly source?: string;
  /** Zoom gate, for layers that refuse to draw below a framing. */
  readonly minzoom?: number;
  readonly paint?: Readonly<Record<string, unknown>>;
  layout?: Record<string, unknown>;
}

export interface FakeMapHarness {
  readonly map: maplibregl.Map;
  readonly sources: Map<string, Record<string, unknown>>;
  /** Ordered layer ids (style order, bottom first). */
  readonly layerOrder: string[];
  readonly layerSpecs: Map<string, FakeLayerSpec>;
  readonly layoutChanges: {
    layerId: string;
    name: string;
    value: unknown;
  }[];
  readonly paintChanges: {
    layerId: string;
    paintProperty: string;
    value: unknown;
  }[];
  readonly cameraCalls: {
    kind: 'easeTo' | 'jumpTo';
    options: Record<string, unknown>;
  }[];
  readonly skyCalls: unknown[];
  /** removeSource calls refused because a layer still used the source
   * (the real MapLibre fires an error event instead of removing). */
  readonly refusedSourceRemovals: string[];
  readonly camera: { pitch: number; bearing: number };
  getTerrain(): { source: string; exaggeration?: number } | null;
  /** Dispatch a map event to listeners bound via map.on. */
  emit(type: string, event: unknown): void;
  listenerCount(type: string): number;
  /**
   * Move the camera's zoom and fire `moveend`, the way a real pan or zoom
   * settles. Zoom-gated layers watch that event, so a spec drives the gate
   * through the same seam the application does.
   */
  setZoom(next: number): void;
  getZoom(): number;
  /**
   * Move the view center and fire `moveend`, the way a real pan settles
   * (fire3d.ts's coverage tracking watches this event). Defaults to
   * FIRE3D_TERRAIN_COVERAGE's own declared center so a spec that never
   * calls this behaves as an ordinary in-coverage activation, unchanged
   * from before this method existed.
   */
  setCenter(next: { lng: number; lat: number }): void;
  /**
   * Set the view box `getBounds` reports directly and fire `moveend`. The
   * centre follows the box's middle, so a spec that sets bounds does not
   * leave the two disagreeing. Use this for a view that straddles a coverage
   * edge, which is the case a centre alone cannot describe.
   */
  setBounds(next: {
    west: number;
    south: number;
    east: number;
    north: number;
  }): void;
  /** Widen or narrow the derived view box around the centre, in degrees. */
  setViewHalfSpan(next: number): void;
}

export function fakeMapHarness(initial?: {
  readonly pitch?: number;
  readonly bearing?: number;
  readonly zoom?: number;
  readonly center?: { readonly lng: number; readonly lat: number };
  /** Half the width/height of the reported view box, degrees. Default 0.05. */
  readonly viewHalfSpan?: number;
}): FakeMapHarness {
  const sources = new Map<string, Record<string, unknown>>();
  const layerOrder: string[] = [];
  const layerSpecs = new Map<string, FakeLayerSpec>();
  const layoutChanges: FakeMapHarness['layoutChanges'] = [];
  const paintChanges: FakeMapHarness['paintChanges'] = [];
  const cameraCalls: FakeMapHarness['cameraCalls'] = [];
  const skyCalls: unknown[] = [];
  const refusedSourceRemovals: string[] = [];
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const camera = {
    pitch: initial?.pitch ?? 0,
    bearing: initial?.bearing ?? 0
  };
  let terrain: { source: string; exaggeration?: number } | null = null;
  // The default sits above every zoom gate in the application, so a spec
  // that does not care about zoom behaves as it always did.
  let zoom = initial?.zoom ?? 8;
  // Defaults to the bundled terrain archive's own declared center
  // (public/data/hillshade-dem-pnw.pmtiles metadata: [-119, 45.5]), so a
  // spec that never calls setCenter keeps behaving as an ordinary
  // in-coverage activation, exactly as before FIRE3D_TERRAIN_COVERAGE
  // tracking existed.
  let center = { lng: initial?.center?.lng ?? -119, lat: initial?.center?.lat ?? 45.5 };
  // Half the width and half the height of the view box getBounds reports, in
  // degrees. Small by default (a tight view around the centre) so every spec
  // written before getBounds existed still reads as a fully covered view
  // wherever its centre used to read as covered, and as fully uncovered
  // wherever its centre used to read as uncovered.
  let viewHalfSpan = initial?.viewHalfSpan ?? 0.05;
  // An explicit box wins over the derived one, for the straddling cases the
  // centre-plus-span form cannot express as clearly.
  let explicitBounds: {
    west: number;
    south: number;
    east: number;
    north: number;
  } | null = null;

  const applyCameraOptions = (options: Record<string, unknown>): void => {
    if (typeof options['pitch'] === 'number') camera.pitch = options['pitch'];
    if (typeof options['bearing'] === 'number') {
      camera.bearing = options['bearing'];
    }
  };

  const map = {
    getSource: (id: string) => sources.get(id),
    addSource: (id: string, spec: Record<string, unknown>) => {
      // Model the real GeoJSONSource read-back seam. MapLibre's own
      // `getData()` resolves with the object the source was given (it reads
      // `_data.geojson`, not the worker's tiles), and a presentation
      // companion that re-presents another layer's geometry uses it rather
      // than importing that layer's module (src/layers/nifc-perimeter-ribbon.ts).
      // Defined non-enumerably so `toEqual`/`toMatchObject` assertions over
      // the recorded source specs are unaffected.
      if (spec['type'] === 'geojson' && !('getData' in spec)) {
        Object.defineProperty(spec, 'getData', {
          enumerable: false,
          value: () => Promise.resolve(spec['data'])
        });
      }
      sources.set(id, spec);
    },
    removeSource: (id: string) => {
      for (const spec of layerSpecs.values()) {
        if (spec.source === id) {
          // Mirror the real MapLibre refusal: an error EVENT, no removal.
          refusedSourceRemovals.push(id);
          return;
        }
      }
      sources.delete(id);
    },
    getLayer: (id: string) => layerSpecs.get(id),
    addLayer: (layer: FakeLayerSpec, beforeId?: string) => {
      layerSpecs.set(layer.id, layer);
      const at = beforeId === undefined ? -1 : layerOrder.indexOf(beforeId);
      if (at === -1) layerOrder.push(layer.id);
      else layerOrder.splice(at, 0, layer.id);
    },
    removeLayer: (id: string) => {
      layerSpecs.delete(id);
      const at = layerOrder.indexOf(id);
      if (at !== -1) layerOrder.splice(at, 1);
    },
    moveLayer: (id: string, beforeId?: string) => {
      const from = layerOrder.indexOf(id);
      if (from === -1) return;
      layerOrder.splice(from, 1);
      const at = beforeId === undefined ? -1 : layerOrder.indexOf(beforeId);
      if (at === -1) layerOrder.push(id);
      else layerOrder.splice(at, 0, id);
    },
    getStyle: () => ({ layers: layerOrder.map((id) => ({ id })) }),
    setLayoutProperty: (layerId: string, name: string, value: unknown) => {
      layoutChanges.push({ layerId, name, value });
      const spec = layerSpecs.get(layerId);
      if (spec) {
        spec.layout = { ...(spec.layout ?? {}), [name]: value };
      }
    },
    setPaintProperty: (
      layerId: string,
      paintProperty: string,
      value: unknown
    ) => {
      paintChanges.push({ layerId, paintProperty, value });
    },
    setTerrain: (spec: { source: string; exaggeration?: number } | null) => {
      terrain = spec;
    },
    getTerrain: () => terrain,
    setSky: (spec: unknown) => {
      skyCalls.push(spec);
    },
    getPitch: () => camera.pitch,
    getBearing: () => camera.bearing,
    getZoom: () => zoom,
    getCenter: () => ({ ...center }),
    /**
     * The visible footprint, in MapLibre's `LngLatBounds` accessor shape.
     * Derived from the centre and `viewHalfSpan` so an existing spec that
     * only calls `setCenter` keeps behaving as it did, while a spec that
     * needs a view straddling a coverage edge can widen the span or set an
     * explicit box with `setBounds`. Read by fire3d.ts's
     * `readTerrainCoverage`, which is what makes the three coverage
     * readings testable at all.
     */
    getBounds: () => {
      const box = explicitBounds ?? {
        west: center.lng - viewHalfSpan,
        south: center.lat - viewHalfSpan,
        east: center.lng + viewHalfSpan,
        north: center.lat + viewHalfSpan
      };
      return {
        getWest: () => box.west,
        getSouth: () => box.south,
        getEast: () => box.east,
        getNorth: () => box.north
      };
    },
    easeTo: (options: Record<string, unknown>) => {
      cameraCalls.push({ kind: 'easeTo', options });
      applyCameraOptions(options);
    },
    jumpTo: (options: Record<string, unknown>) => {
      cameraCalls.push({ kind: 'jumpTo', options });
      applyCameraOptions(options);
    },
    on: (type: string, listener: (event: unknown) => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    off: (type: string, listener: (event: unknown) => void) => {
      listeners.get(type)?.delete(listener);
    }
  } as unknown as maplibregl.Map;

  return {
    map,
    sources,
    layerOrder,
    layerSpecs,
    layoutChanges,
    paintChanges,
    cameraCalls,
    skyCalls,
    refusedSourceRemovals,
    camera,
    getTerrain: () => terrain,
    emit: (type: string, event: unknown) => {
      for (const listener of [...(listeners.get(type) ?? [])]) {
        listener(event);
      }
    },
    listenerCount: (type: string) => listeners.get(type)?.size ?? 0,
    setZoom: (next: number) => {
      zoom = next;
      for (const listener of [...(listeners.get('moveend') ?? [])]) {
        listener({});
      }
    },
    getZoom: () => zoom,
    setCenter: (next: { lng: number; lat: number }) => {
      center = { ...next };
      explicitBounds = null;
      for (const listener of [...(listeners.get('moveend') ?? [])]) {
        listener({});
      }
    },
    setBounds: (next: {
      west: number;
      south: number;
      east: number;
      north: number;
    }) => {
      explicitBounds = { ...next };
      center = {
        lng: (next.west + next.east) / 2,
        lat: (next.south + next.north) / 2
      };
      for (const listener of [...(listeners.get('moveend') ?? [])]) {
        listener({});
      }
    },
    setViewHalfSpan: (next: number) => {
      viewHalfSpan = next;
      explicitBounds = null;
      for (const listener of [...(listeners.get('moveend') ?? [])]) {
        listener({});
      }
    }
  };
}

export interface FakeBrowserOptions {
  /** matchMedia('(min-width: 721px)') result; toggle via setDesktop. */
  readonly desktop?: boolean;
  /** matchMedia('(prefers-reduced-motion: reduce)') result. */
  readonly reducedMotion?: boolean;
  /** Initial location.search (with the leading '?', or ''). */
  readonly search?: string;
}

export interface FakeBrowser {
  /** Current fake window.location.search. */
  search(): string;
  setDesktop(matches: boolean): void;
  restore(): void;
}

/**
 * Install fake `window` and `document` globals sufficient for the fire3d
 * orchestrator and the URL sync helpers: a per-query matchMedia with
 * change listeners, a mutable location plus replaceState-only history,
 * and a documentElement dataset for the mode's truth stamps.
 */
export function installFakeBrowser(
  options: FakeBrowserOptions = {}
): FakeBrowser {
  const windowDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'window'
  );
  const documentDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'document'
  );

  let desktop = options.desktop ?? true;
  const reducedMotion = options.reducedMotion ?? false;
  const location = {
    pathname: '/',
    search: options.search ?? ''
  };
  const widthListeners = new Set<() => void>();

  const matchMedia = (query: string) => {
    const isWidth = query.includes('min-width');
    return {
      get matches(): boolean {
        return isWidth ? desktop : reducedMotion;
      },
      addEventListener: (type: string, listener: () => void) => {
        if (isWidth && type === 'change') widthListeners.add(listener);
      },
      removeEventListener: (type: string, listener: () => void) => {
        if (isWidth && type === 'change') widthListeners.delete(listener);
      }
    };
  };

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      matchMedia,
      location,
      history: {
        state: null,
        replaceState: (_state: unknown, _title: string, url: string) => {
          const q = url.indexOf('?');
          location.search = q === -1 ? '' : url.slice(q);
        }
      },
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis)
    }
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      getElementById: () => null,
      documentElement: { dataset: {} as Record<string, string> },
      createElement: () => {
        throw new Error('fake document does not build DOM');
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined
    }
  });

  return {
    search: () => location.search,
    setDesktop: (matches: boolean) => {
      desktop = matches;
      for (const listener of [...widthListeners]) listener();
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

export interface CapturedWarnings {
  /** Every `console.warn` call since capture began, one joined string each. */
  readonly messages: string[];
  /**
   * Put the real `console.warn` back and record what was captured as a
   * `console.warn` annotation on the current test, so a test that fails
   * before its warning assertion still carries the evidence in the report.
   * Call from `finally` or `afterEach`.
   */
  restore(): void;
}

/**
 * Capture `console.warn` for the duration of a by-design failure path.
 *
 * The runtime's honest degrade paths (a corrupt archive, three tile errors
 * in the rolling window, a dead fetch) each warn their reason with the
 * error attached, and Node prints that error's full stack. In a Node-level
 * test that deliberately drives those paths, the stack is noise that buries
 * the reporter's own lines (DDM-P0-T06). Capturing it lets the test assert
 * the warning was issued, which is part of the contract, instead of
 * printing it; the annotation written on restore keeps the sanitized text
 * (message and error name, no stack) with the test result either way.
 */
export function captureWarnings(): CapturedWarnings {
  const original = console.warn;
  const messages: string[] = [];
  console.warn = (...args: unknown[]): void => {
    // `console.warn(reason, err)` with no error passes `undefined`; drop it
    // rather than record a literal "undefined" token.
    messages.push(
      args
        .filter((arg) => arg !== undefined && arg !== null)
        .map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg)))
        .join(' ')
    );
  };
  return {
    messages,
    restore: () => {
      console.warn = original;
      if (messages.length === 0) return;
      try {
        test.info().annotations.push({
          type: 'console.warn',
          description: messages.join('\n')
        });
      } catch {
        // Outside a test (no test.info()), the messages stay in memory only.
      }
    }
  };
}

/** The shape of a synthetic PMTiles v3 header; every field has a bundled-archive default. */
export interface PmtilesHeaderShape {
  readonly minZoom?: number;
  readonly maxZoom?: number;
  readonly tileDataOffset?: number;
  readonly tileDataLength?: number;
  /** 2 is PNG, the terrarium raster-dem archives' type. */
  readonly tileType?: number;
  /** [west, south, east, north] in degrees. */
  readonly bounds?: readonly [number, number, number, number];
}

/**
 * The bundled hillshade archive's own header numbers (read from
 * public/data/hillshade-dem-pnw.pmtiles on 2026-09-10: tile data at offset
 * 1133 for 35,251,077 bytes, a 35,252,210-byte object, zoom 0 to 8, the
 * PNW box). A fixture built with no overrides describes that archive.
 */
const BUNDLED_HEADER_SHAPE: Required<PmtilesHeaderShape> = {
  minZoom: 0,
  maxZoom: 8,
  tileDataOffset: 1133,
  tileDataLength: 35_251_077,
  tileType: 2,
  bounds: [-125, 41.5, -110.5, 49.5]
};

/**
 * A complete 127-byte PMTiles v3 header (magic, version 3, and the fields
 * src/util/pmtiles-probe.ts reads at their spec offsets), so a stub answers
 * the probe the way a real archive does. Before 2026-09-10 the fixture was
 * the eight-byte magic alone, which is exactly the truncated shape the
 * hardened probe now rejects.
 */
export function pmtilesV3Header(shape: PmtilesHeaderShape = {}): Uint8Array {
  const s = { ...BUNDLED_HEADER_SHAPE, ...shape };
  const bytes = new Uint8Array(127);
  bytes.set([0x50, 0x4d, 0x54, 0x69, 0x6c, 0x65, 0x73, 0x03], 0);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(56, BigInt(s.tileDataOffset), true);
  view.setBigUint64(64, BigInt(s.tileDataLength), true);
  view.setUint8(99, s.tileType);
  view.setUint8(100, s.minZoom);
  view.setUint8(101, s.maxZoom);
  const [west, south, east, north] = s.bounds;
  view.setInt32(102, Math.round(west * 1e7), true);
  view.setInt32(106, Math.round(south * 1e7), true);
  view.setInt32(110, Math.round(east * 1e7), true);
  view.setInt32(114, Math.round(north * 1e7), true);
  return bytes;
}

/** The whole-object size a header of this shape implies. */
export function pmtilesObjectSize(shape: PmtilesHeaderShape = {}): number {
  const s = { ...BUNDLED_HEADER_SHAPE, ...shape };
  return s.tileDataOffset + s.tileDataLength;
}

/**
 * The response a ranged header probe gets from a healthy server: 206 with a
 * Content-Range whose total matches the header's own extent. Pass `total`
 * to model a server holding a different number of bytes (a truncated
 * upload), which the probe must reject.
 */
export function pmtilesHeaderResponse(
  shape: PmtilesHeaderShape = {},
  options: { readonly total?: number } = {}
): Response {
  const total = options.total ?? pmtilesObjectSize(shape);
  return new Response(pmtilesV3Header(shape), {
    status: 206,
    headers: { 'Content-Range': `bytes 0-126/${total}` }
  });
}
