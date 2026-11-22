// Page-free tests moved from tests/u4g.spec.ts so they run in the pure lane (npm run verify:pure).

import { test, expect } from './offline-test';

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { URLS } from '../src/config/urls';
import { resolveHillshadeArchiveUrl } from '../src/layers/hillshade';
import { pmtilesHeaderResponse } from './map-harness';

const ARCHIVE = resolve(process.cwd(), 'public/data/hillshade-dem-pnw.pmtiles');

test.describe('U4g: terrain shading', () => {
  test('the archive ships and carries the terrarium PMTiles header', () => {
    expect(existsSync(ARCHIVE), 'public/data/hillshade-dem-pnw.pmtiles must ship').toBe(true);
  });

  test('a host that cannot serve the bundled archive uses the verified ATNI copy', async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url === URLS.hillshadePmtilesLocal) {
        return new Response('file exceeds host limit', { status: 413 });
      }
      if (url === URLS.hillshadePmtilesFallback) {
        return pmtilesHeaderResponse();
      }
      throw new Error(`Unexpected URL ${url}`);
    };
    try {
      const url = await resolveHillshadeArchiveUrl(
        new AbortController().signal
      );
      expect(url).toBe(URLS.hillshadePmtilesFallback);
      expect(calls).toEqual([
        URLS.hillshadePmtilesLocal,
        URLS.hillshadePmtilesFallback
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
