import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

import {
  fetchJsonWithBudget,
  fetchWithBudget
} from '../src/util/fetch';

test('the NWS point request aborts a response body held after headers', async () => {
  const sources = readFileSync(
    new URL('../src/impact/sources.ts', import.meta.url),
    'utf8'
  );
  const functionStart = sources.indexOf(
    'export async function fetchNwsForecastClaims'
  );
  expect(functionStart).toBeGreaterThan(-1);
  const implementation = sources.slice(functionStart);
  const readsWithFullBodyBudget = implementation.includes(
    'fetchJsonWithBudget('
  );
  const fetchPointBody = readsWithFullBodyBudget
    ? fetchJsonWithBudget
    : async (
        url: string,
        opts: RequestInit | null,
        signal: AbortSignal | null,
        timeoutMs: number
      ): Promise<unknown> => {
        const response = await fetchWithBudget(
          url,
          opts,
          signal,
          timeoutMs
        );
        return response.json() as Promise<unknown>;
      };

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
  const request = fetchPointBody(
    '/nws-points.json',
    null,
    master.signal,
    10_000
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
