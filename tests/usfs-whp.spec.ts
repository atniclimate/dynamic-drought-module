import { expect, test } from '@playwright/test';

import { activate, deactivate } from '../src/layers/usfs-whp';
import { registry } from '../src/state/registry';

type MapEvent = Record<string, unknown>;
type MapHandler = (event: MapEvent) => void;

class FakeWhpMap {
  private source: unknown;
  private layer: unknown;
  private readonly listeners = new Map<string, Set<MapHandler>>();

  getSource(): unknown {
    return this.source;
  }

  addSource(_id: string, source: unknown): void {
    this.source = source;
  }

  removeSource(): void {
    this.source = undefined;
  }

  getLayer(): unknown {
    return this.layer;
  }

  addLayer(layer: unknown): void {
    this.layer = layer;
  }

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
