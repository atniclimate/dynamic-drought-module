import { expect, test } from './offline-test';
import { gotoApp } from './helpers';
import { build } from 'rolldown';
import { fileURLToPath } from 'node:url';

async function script(module: string, name: string): Promise<string> {
  const input = fileURLToPath(new URL(`../src/layers/${module}.ts`, import.meta.url));
  const output = await build({ input, write: false, logLevel: 'silent', output: { format: 'iife', name } });
  const chunk = output.output.find(item => item.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Missing dryness test bundle');
  return chunk.code;
}

test('native XML parser admits exact RG domain and only parsed ServiceException triggers one previous TIME', async ({ page }) => {
  await gotoApp(page);
  await page.addScriptTag({ content: await script('dryness-ground', '__d5Ground') });
  await page.addScriptTag({ content: await script('dryness-discovery', '__d5Discovery') });
  const result = await page.evaluate(async () => {
    const ground = (window as unknown as { __d5Ground: typeof import('../src/layers/dryness-ground') }).__d5Ground;
    const discovery = (window as unknown as { __d5Discovery: typeof import('../src/layers/dryness-discovery') }).__d5Discovery;
    const times = ['2026-09-28T00:00:00.000Z', '2026-09-21T00:00:00.000Z'];
    const capabilities = `<WMS_Capabilities version="1.3.0" xmlns="http://www.opengis.net/wms"><Capability><Layer><Layer><Name>rg_conus_week_data</Name><Dimension name="time" units="ISO8601">${[...times].reverse().join(',')}</Dimension></Layer></Layer></Capability></WMS_Capabilities>`;
    const parsed = discovery.parseRelativeGreennessCapabilities(capabilities, 'rg_conus_week_data', 2);
    let rejected = 0;
    for (const xml of [capabilities.replace('</Dimension>', ''), capabilities.replace('rg_conus_week_data', 'wrong'),
      capabilities.replace('units="ISO8601"', 'units="unknown"'), capabilities.replace('http://www.opengis.net/wms', 'urn:unknown'),
      '<!DOCTYPE x [<!ENTITY a "b">]>' + capabilities]) {
      try { discovery.parseRelativeGreennessCapabilities(xml, 'rg_conus_week_data', 2); } catch { rejected++; }
    }
    const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
    const context = canvas.getContext('2d')!; context.fillStyle = '#732600'; context.fillRect(0, 0, 1, 1);
    const png = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), 'image/png'));
    const originalFetch = window.fetch;
    const cases = [];
    for (const response of ['service', 'malformed', 'html', 'wrong-mime', 'all-service', 'missing-metadata', 'wrong-frame']) {
      const requests: string[] = [], snapshots: Array<import('../src/layers/dryness-ground').DrynessSnapshot | null> = [];
      const sources = new Map<string, unknown>(), layers = new Map<string, { source?: unknown }>();
      const handlers = new Map<string, Set<(event: unknown) => void>>();
      const map = {
        addSource(id: string, value: unknown) { sources.set(id, value); }, getSource(id: string) { return sources.get(id); },
        removeSource(id: string) { sources.delete(id); }, addLayer(value: { id: string; source?: unknown }) { layers.set(value.id, value); },
        getLayer(id: string) { return layers.get(id); }, removeLayer(id: string) { layers.delete(id); },
        on(type: string, fn: (event: unknown) => void) { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type)!.add(fn); },
        off(type: string, fn: (event: unknown) => void) { handlers.get(type)?.delete(fn); }
      } as unknown as import('maplibre-gl').Map;
      // One loaded tile of the mounted source: the tile proof the ground now waits for.
      const proveTile = () => {
        for (const sourceId of sources.keys()) {
          for (const fn of [...(handlers.get('sourcedata') ?? [])]) {
            fn({ sourceId, dataType: 'source', tile: { tileID: { key: 1 } }, isSourceLoaded: true });
          }
        }
      };
      const frame = (value: string, productKey: 'star-vhi' | 'usgs-relative-greenness') => ({ productKey, frame: value,
        issuer: 'fixture', legendRows: ['fixture'], clockLabel: value, coverage: 'fixture', qualification: 'fixture', creditKey: 'fixture',
        tileUrl: (z: number, x: number, y: number) => `https://dryness.invalid/${value}/${z}/${x}/${y}.png`,
        tileSize: 256, maxZoom: 7, bounds: [-180, -80, 180, 80] as const });
      window.fetch = async (input, init) => {
        const value = input instanceof Request ? input.url : String(input);
        if (new URL(value, location.href).origin !== 'https://dryness.invalid') return originalFetch(input, init);
        requests.push(value);
        if (value.endsWith('/capabilities')) return new Response(capabilities, { headers: { 'content-type': 'text/xml' } });
        if (value.includes('/2026001/') || value.includes('/2025052/')) return new Response('unavailable', { status: 500 });
        if (value.includes(times[0]!) || response === 'all-service') {
          const xml = response === 'malformed' ? '<ServiceExceptionReport><ServiceException>' : response === 'html' ? '<html>ServiceException</html>' :
            '<ServiceExceptionReport><ServiceException code="InvalidDimensionValue">TIME</ServiceException></ServiceExceptionReport>';
          return new Response(xml, { headers: { 'content-type': response === 'wrong-mime' ? 'text/plain' : 'application/vnd.ogc.se_xml' } });
        }
        return new Response(png, { headers: { 'content-type': 'image/png' } });
      };
      const adapter = ground.createDrynessGround({ protocolName: 'dryness-browser-test', layerId: 'dryness-test', beforeId: () => 'hillshade',
        allowedOrigins: ['https://dryness.invalid'], star: [frame('2026001', 'star-vhi'), frame('2025052', 'star-vhi')],
        rg: { capabilitiesUrl: 'https://dryness.invalid/capabilities', layerName: 'rg_conus_week_data', frame: time => ({
          ...frame(time, 'usgs-relative-greenness'), ...(response === 'missing-metadata' ? { coverage: '' } : {}),
          ...(response === 'wrong-frame' ? { frame: '2026-09-14T00:00:00.000Z' } : {})
        }) },
        tileLimits: { timeoutMs: 1000, maxDecodedBytes: 10000, maxOutputBytes: 10000, maxPixels: 1 },
        metadataLimits: { timeoutMs: 1000, maxDecodedBytes: 10000, maxTimes: 2 }, selectionDeadlineMs: 5000,
        readyState: () => 'live (partial)', publish(snapshot) {
          if (snapshot?.selected && (!sources.has(snapshot.sourceId!) || layers.get('dryness-test')?.source !== snapshot.sourceId ||
              snapshot.selected.clockLabel !== snapshot.selected.frame)) throw new Error('Nonatomic selected record');
          if (!snapshot?.selected && sources.size) throw new Error('Orphan source');
          snapshots.push(snapshot);
        } });
      try {
        await adapter.activate(map, new AbortController().signal);
        proveTile();
        const final = snapshots.at(-1);
        cases.push({ response, requests, state: final?.state, frame: final?.selected?.frame, product: final?.selected?.productKey,
          failures: final?.failures, mounted: sources.size });
      } finally { adapter.deactivate(); window.fetch = originalFetch; }
    }
    return { parsed, rejected, cases };
  });
  expect(result.parsed).toEqual(['2026-09-28T00:00:00.000Z', '2026-09-21T00:00:00.000Z']);
  expect(result.rejected).toBe(5);
  const success = result.cases.find(row => row.response === 'service')!;
  expect(success.state).toBe('live (partial)');
  expect(success.frame).toBe('2026-09-21T00:00:00.000Z');
  expect(success.product).toBe('usgs-relative-greenness');
  expect(success.requests).toHaveLength(5);
  expect(success.failures?.map(row => row.productKey)).toEqual(['star-vhi', 'star-vhi', 'usgs-relative-greenness']);
  for (const row of result.cases.filter(row => row.response !== 'service')) {
    expect(row.state).toBe('unavailable'); expect(row.mounted).toBe(0);
    expect(row.requests).toHaveLength(row.response === 'all-service' ? 5 :
      ['missing-metadata', 'wrong-frame'].includes(row.response) ? 3 : 4);
  }
});
