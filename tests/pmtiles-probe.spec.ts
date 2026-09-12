import { test, expect } from '@playwright/test';

import { parsePmtilesHeader, probeArchiveHeader } from '../src/util/pmtiles-probe';
import { pmtilesHeaderResponse, pmtilesObjectSize, pmtilesV3Header } from './map-harness';

/**
 * The PMTiles archive-header probe (DR-083 step 2; Codex 2026-09-10 finding
 * S1). Node-level against a stubbed global fetch: the probe gates six
 * archives (3D terrain deep and bundled, hillshade, WHP, structures, power
 * lines), and every caller already has a fallback for a rejection, so what
 * matters is that a truncated or foreign object is rejected HERE rather
 * than accepted and torn down later where no fallback exists.
 */

const ARCHIVE_URL = 'https://example.test/archive.pmtiles';

type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function withFetch(handler: FetchHandler): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

/** A body that answers the headers and then never delivers a byte. */
function stalledBody(): Response {
  return new Response(new ReadableStream<Uint8Array>({ start: () => undefined }), {
    status: 206,
    headers: { 'Content-Range': `bytes 0-126/${pmtilesObjectSize()}` }
  });
}

test.describe('the PMTiles header probe', () => {
  test('accepts a whole archive and returns the header the archive declares', async () => {
    const restore = withFetch(async () => pmtilesHeaderResponse({ maxZoom: 10 }));
    try {
      const header = await probeArchiveHeader(ARCHIVE_URL, new AbortController().signal);
      expect(header.maxZoom).toBe(10);
      expect(header.minZoom).toBe(0);
      expect(header.tileDataOffset).toBe(1133);
      expect(header.tileDataLength).toBe(35_251_077);
    } finally {
      restore();
    }
  });

  test('asks for exactly the 127-byte header', async () => {
    let range: string | null = null;
    const restore = withFetch(async (_input, init) => {
      range = new Headers(init?.headers).get('Range');
      return pmtilesHeaderResponse();
    });
    try {
      await probeArchiveHeader(ARCHIVE_URL, new AbortController().signal);
      expect(range).toBe('bytes=0-126');
    } finally {
      restore();
    }
  });

  test('rejects an object the server holds fewer bytes of than its header claims', async () => {
    // A valid header whose declared extent is 35,252,210 bytes, from a
    // server holding a 20,000,000-byte object: the partial upload S1 named.
    const restore = withFetch(async () => pmtilesHeaderResponse({}, { total: 20_000_000 }));
    try {
      await expect(
        probeArchiveHeader(ARCHIVE_URL, new AbortController().signal)
      ).rejects.toThrow(/truncated or foreign object/);
    } finally {
      restore();
    }
  });

  test('rejects the eight-byte magic alone, which the old probe accepted', async () => {
    const restore = withFetch(
      async () =>
        new Response(new Uint8Array([0x50, 0x4d, 0x54, 0x69, 0x6c, 0x65, 0x73, 0x03]), {
          status: 206,
          headers: { 'Content-Range': 'bytes 0-7/8' }
        })
    );
    try {
      await expect(
        probeArchiveHeader(ARCHIVE_URL, new AbortController().signal)
      ).rejects.toThrow(/short PMTiles header \(8 of 127 bytes\)/);
    } finally {
      restore();
    }
  });

  test('rejects an HTML page served in place of the archive', async () => {
    const restore = withFetch(
      async () => new Response('<html>not tiles</html>', { status: 200 })
    );
    try {
      await expect(
        probeArchiveHeader(ARCHIVE_URL, new AbortController().signal)
      ).rejects.toThrow(/magic mismatch/);
    } finally {
      restore();
    }
  });

  test('rejects a 206 that carries no Content-Range', async () => {
    // Wrapped in a fresh Uint8Array: see map-harness.ts's pmtilesHeaderResponse
    // for why `Response`'s BodyInit wants `Uint8Array<ArrayBuffer>`, not the
    // `Uint8Array<ArrayBufferLike>` pmtilesV3Header returns.
    const restore = withFetch(
      async () => new Response(new Uint8Array(pmtilesV3Header()), { status: 206 })
    );
    try {
      await expect(
        probeArchiveHeader(ARCHIVE_URL, new AbortController().signal)
      ).rejects.toThrow(/a 206 without a usable Content-Range/);
    } finally {
      restore();
    }
  });

  test('tolerates a server that ignored Range, checking Content-Length when it sends one', async () => {
    const whole = new Uint8Array(pmtilesV3Header());
    const restoreSized = withFetch(
      async () =>
        new Response(whole, {
          status: 200,
          headers: { 'Content-Length': String(pmtilesObjectSize()) }
        })
    );
    try {
      const header = await probeArchiveHeader(ARCHIVE_URL, new AbortController().signal);
      expect(header.maxZoom).toBe(8);
    } finally {
      restoreSized();
    }
    const restoreShort = withFetch(
      async () => new Response(whole, { status: 200, headers: { 'Content-Length': '500' } })
    );
    try {
      await expect(
        probeArchiveHeader(ARCHIVE_URL, new AbortController().signal)
      ).rejects.toThrow(/server holds 500/);
    } finally {
      restoreShort();
    }
  });

  test('a body that stalls after the headers arrive is cut off by the budget', async () => {
    const restore = withFetch(async () => stalledBody());
    try {
      const started = Date.now();
      await expect(
        probeArchiveHeader(ARCHIVE_URL, new AbortController().signal, 100)
      ).rejects.toThrow(/Aborted/);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      restore();
    }
  });

  test('an abort of the owning signal cancels a body still in flight', async () => {
    const restore = withFetch(async () => stalledBody());
    try {
      const controller = new AbortController();
      const probe = probeArchiveHeader(ARCHIVE_URL, controller.signal);
      setTimeout(() => controller.abort(), 20);
      await expect(probe).rejects.toThrow(/Aborted/);
    } finally {
      restore();
    }
  });

  test('parsePmtilesHeader refuses a header whose zooms are inverted', () => {
    expect(() => parsePmtilesHeader(pmtilesV3Header({ minZoom: 9, maxZoom: 8 }))).toThrow(
      /impossible zooms/
    );
  });
});
