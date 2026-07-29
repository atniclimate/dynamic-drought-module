import { expect, test } from '@playwright/test';

import {
  clearNwsResponseCache,
  createNwsRequestSession
} from '../src/impact/nws-point';

test('the NWS point request aborts a response body held after headers', async () => {
  clearNwsResponseCache();
  const originalFetch = globalThis.fetch;
  let noteHeadersReturned: (() => void) | null = null;
  let noteBodyCancelled: (() => void) | null = null;
  let bodyController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let heldFetchSignal: AbortSignal | null = null;
  const headersReturned = new Promise<void>((resolve) => {
    noteHeadersReturned = resolve;
  });
  const bodyCancelled = new Promise<void>((resolve) => {
    noteBodyCancelled = resolve;
  });

  globalThis.fetch = async (_input, init) => {
    heldFetchSignal = init?.signal ?? null;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
        controller.enqueue(new TextEncoder().encode('{"properties":'));
      },
      cancel() {
        noteBodyCancelled?.();
      }
    });
    noteHeadersReturned?.();
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/geo+json' }
    });
  };

  const master = new AbortController();
  const request = createNwsRequestSession(master.signal).fetchJson(
    '/nws-points.json',
    60_000
  );
  try {
    await headersReturned;
    master.abort();

    await expect
      .poll(() => heldFetchSignal?.aborted ?? false, { timeout: 500 })
      .toBe(true);
    await expect(bodyCancelled).resolves.toBeUndefined();
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  } finally {
    if (!(heldFetchSignal?.aborted ?? false)) {
      bodyController?.error(new DOMException('Test cleanup', 'AbortError'));
      await request.catch(() => undefined);
    }
    globalThis.fetch = originalFetch;
  }
});
