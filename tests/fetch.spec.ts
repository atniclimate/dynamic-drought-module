import { expect, test } from '@playwright/test';

import { fetchJsonWithBudget } from '../src/util/fetch';

test.describe('fetchJsonWithBudget', () => {
  test('aborts and cancels a delayed response body after headers arrive', async () => {
    const originalFetch = globalThis.fetch;
    let noteHeadersReturned: (() => void) | null = null;
    let noteBodyCancelled: (() => void) | null = null;
    const headersReturned = new Promise<void>((resolve) => {
      noteHeadersReturned = resolve;
    });
    const bodyCancelled = new Promise<void>((resolve) => {
      noteBodyCancelled = resolve;
    });

    globalThis.fetch = async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"delayed":'));
        },
        cancel() {
          noteBodyCancelled?.();
        }
      });
      const response = new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
      noteHeadersReturned?.();
      return response;
    };

    try {
      const master = new AbortController();
      const request = fetchJsonWithBudget('/delayed.json', null, master.signal, 10_000);
      await headersReturned;
      master.abort();

      await expect(request).rejects.toMatchObject({ name: 'AbortError' });
      await expect(bodyCancelled).resolves.toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
