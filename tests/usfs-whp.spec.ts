import { expect, test } from './offline-test';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { activate, deactivate } from '../src/layers/usfs-whp';
import * as classes from '../src/layers/usfs-whp-classes';
import { registry } from '../src/state/registry';
import { loadWhpShade, shadeWhpPixels } from '../src/layers/whp-shade-protocol';
import { URLS } from '../src/config/urls';

test('the shaded archive keeps its published bounds and zooms in TileJSON', async () => {
  const archive = readFileSync(join(process.cwd(), 'public', 'data', basename(URLS.whp2023PmtilesLocal)));
  const header = new DataView(archive.buffer, archive.byteOffset, 127);
  const originalFetch = globalThis.fetch;
  const url = 'https://example.test/whp-bounds.pmtiles';
  globalThis.fetch = async (input, init) => {
    expect(String(input)).toBe(url);
    expect(new Headers(init?.headers).get('range')).toBe('bytes=0-16383');
    return new Response(archive.subarray(0, 16384), {
      status: 206,
      headers: { 'Content-Range': `bytes 0-16383/${archive.length}` }
    });
  };
  try {
    const result = await loadWhpShade({ url: `whp-shade://${url}`, type: 'json' }, new AbortController());
    expect(result.data).toEqual({
      tiles: [`whp-shade://${url}/{z}/{x}/{y}`],
      minzoom: header.getUint8(100),
      maxzoom: header.getUint8(101),
      bounds: [102, 106, 110, 114].map((offset) => header.getInt32(offset, true) / 1e7)
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('3D hazard shading preserves class order, source transparency, and visible fire colors', () => {
  const pixels = new Uint8ClampedArray([
    56, 163, 0, 255, 163, 255, 148, 255, 255, 255, 99, 255,
    255, 163, 0, 255, 237, 30, 0, 255, 225, 225, 225, 255,
    0, 112, 225, 255, 0, 0, 0, 0
  ]);
  shadeWhpPixels(pixels);
  expect(Array.from(pixels).filter((_, index) => index % 4 === 3)).toEqual([0, 38, 97, 173, 255, 0, 0, 0]);
  expect(Array.from(pixels.slice(0, 28)).filter((_, index) => index % 4 !== 3)).toEqual(Array(21).fill(255));
  expect(() => shadeWhpPixels(new Uint8ClampedArray([255, 0, 0, 255]))).toThrow('Unrecognized WHP class');
});

type MapEvent = Record<string, unknown>;
type MapHandler = (event: MapEvent) => void;
type FakeSource = { tiles: string[]; roundZoom: boolean; setTiles: (tiles: string[]) => void };

class FakeWhpMap {
  private source: FakeSource | undefined;
  private layer: unknown;
  private readonly listeners = new Map<string, Set<MapHandler>>();
  terrain = false;
  readonly paint = new Map<string, unknown>();

  getTerrain(): object | null { return this.terrain ? {} : null; }

  getCenter(): { lng: number; lat: number } { return { lng: -120.5, lat: 44 }; }

  getSource(): FakeSource | undefined {
    return this.source;
  }

  addSource(_id: string, source: { tiles: string[] }): void {
    // Match the native RasterTileSource default. The adapter must change it;
    // this fake proves configuration/lifecycle, not GPU sampling.
    this.source = { ...source, roundZoom: true, setTiles: (tiles) => { this.source!.tiles = tiles; } };
  }

  removeSource(): void {
    this.source = undefined;
  }

  getLayer(): unknown {
    return this.layer;
  }

  addLayer(layer: { paint: Record<string, unknown> }): void {
    this.layer = layer;
    for (const [key, value] of Object.entries(layer.paint)) this.paint.set(key, value);
  }

  setPaintProperty(_id: string, key: string, value: unknown): void { this.paint.set(key, value); }

  removeLayer(): void {
    this.layer = undefined;
  }

  on(event: string, handler: MapHandler): this {
    const handlers = this.listeners.get(event) ?? new Set<MapHandler>();
    handlers.add(handler);
    this.listeners.set(event, handlers);
    return this;
  }

  off(event: string, handler: MapHandler): this {
    this.listeners.get(event)?.delete(handler);
    return this;
  }

  emit(event: string, payload: MapEvent = {}): void {
    for (const handler of this.listeners.get(event) ?? []) handler(payload);
  }
}

test('WHP stays loading until proxied raster tiles actually succeed', async () => {
  const fakeMap = new FakeWhpMap();
  const map = fakeMap as unknown as Parameters<typeof activate>[0];
  registry.deactivate('usfs-whp');

  try {
    await activate(map);
    expect(registry.getStatus('usfs-whp')).toBe('loading');

    const tileEvent = {
      sourceId: 'usfs-whp',
      dataType: 'source',
      tile: { tileID: { key: 'selected-tile' } }
    };
    fakeMap.emit('sourcedataloading', tileEvent);
    fakeMap.emit('sourcedata', tileEvent);
    expect(registry.getStatus('usfs-whp')).toBe('loading');

    fakeMap.emit('idle');
    expect(registry.getStatus('usfs-whp')).toBe('ready');
  } finally {
    deactivate(map);
    registry.deactivate('usfs-whp');
  }
});

test('Fuel risk WHP is white-shaded with or without terrain; the classes layer keeps issuer colors', async () => {
  const fakeMap = new FakeWhpMap();
  const map = fakeMap as unknown as Parameters<typeof activate>[0];
  const classesMap = new FakeWhpMap();
  const classesTarget = classesMap as unknown as Parameters<typeof classes.activate>[0];
  try {
    await activate(map);
    expect(fakeMap.paint.get('raster-resampling')).toBe('nearest');
    expect(fakeMap.getSource()!.roundZoom).toBe(false);
    const shadedTiles = [...fakeMap.getSource()!.tiles];
    expect(shadedTiles[0]).toContain('whp-image-shade://');
    fakeMap.terrain = true;
    fakeMap.emit('terrain');
    expect(fakeMap.getSource()!.tiles).toEqual(shadedTiles);
    fakeMap.terrain = false;
    fakeMap.emit('terrain');
    expect(fakeMap.getSource()!.tiles).toEqual(shadedTiles);

    await classes.activate(classesTarget);
    // The classes row decodes only to clear the issuer's opaque-black NoData; its colours stay the issuer's.
    expect(classesMap.getSource()!.tiles).toEqual(shadedTiles.map((tile) => tile.replace('whp-image-shade://', 'whp-image-classes://')));
    // DR-138 / D3 R7 preserves class sampling on the issuer-coloured row too.
    expect(classesMap.paint.get('raster-resampling')).toBe('nearest');
    expect(classesMap.getSource()!.roundZoom).toBe(false);
    classesMap.terrain = true;
    classesMap.emit('terrain');
    expect(classesMap.getSource()!.tiles[0]).toContain('whp-image-classes://');
  } finally {
    deactivate(map);
    classes.deactivate(classesTarget);
    registry.deactivate('usfs-whp');
    registry.deactivate('usfs-whp-classes');
  }
});
