import { expect, test } from '@playwright/test';

import { fetchBufferedWithBudget, fetchJsonWithBudget } from '../src/util/fetch';

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

test.describe('fetchBufferedWithBudget', () => {
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
          controller.enqueue(new Uint8Array([0, 1, 2]));
        },
        cancel() {
          noteBodyCancelled?.();
        }
      });
      noteHeadersReturned?.();
      return new Response(body, { status: 200 });
    };

    try {
      const master = new AbortController();
      const request = fetchBufferedWithBudget('/delayed.bin', null, master.signal, 10_000);
      await headersReturned;
      master.abort();

      await expect(request).rejects.toMatchObject({ name: 'AbortError' });
      await expect(bodyCancelled).resolves.toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('preserves response status, headers, and exact body bytes', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(new Uint8Array([0, 127, 128, 255]), {
      status: 206,
      statusText: 'Partial Content',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Test': 'preserved'
      }
    });

    try {
      const response = await fetchBufferedWithBudget('/bytes.bin', null, null, 1_000);
      expect(response.status).toBe(206);
      expect(response.statusText).toBe('Partial Content');
      expect(response.headers.get('content-type')).toBe('application/octet-stream');
      expect(response.headers.get('x-test')).toBe('preserved');
      expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([0, 127, 128, 255]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
