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
}

export function fakeMapHarness(initial?: {
  readonly pitch?: number;
  readonly bearing?: number;
  readonly zoom?: number;
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

  const applyCameraOptions = (options: Record<string, unknown>): void => {
    if (typeof options['pitch'] === 'number') camera.pitch = options['pitch'];
    if (typeof options['bearing'] === 'number') {
      camera.bearing = options['bearing'];
    }
  };

  const map = {
    getSource: (id: string) => sources.get(id),
    addSource: (id: string, spec: Record<string, unknown>) => {
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
    getZoom: () => zoom
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

/** A minimal valid PMTiles v3 header prefix (magic + spec version 3). */
export const PMTILES_V3_HEADER_PREFIX = new Uint8Array([
  0x50, 0x4d, 0x54, 0x69, 0x6c, 0x65, 0x73, 0x03
]);
