import { expect, test } from '@playwright/test';

import {
  clearNwsResponseCache,
  createNwsRequestSession
} from '../src/impact/nws-point';
import { fetchPointHeat } from '../src/impact/point-heat';
import type { BoundarySelectionContext } from '../src/impact/types';

const CONTEXT: BoundarySelectionContext = {
  kind: 'state',
  title: 'Kansas',
  properties: { STUSPS: 'KS' },
  lngLat: { lng: -97.5, lat: 38.5 },
  regionKey: 'national'
};

test.beforeEach(() => {
  clearNwsResponseCache();
});

test('point heat aborts a stalled points body and does not promote it to shared cache', async () => {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  let noteHeadersReturned: (() => void) | null = null;
  let noteBodyCancelled: (() => void) | null = null;
  const headersReturned = new Promise<void>((resolve) => {
    noteHeadersReturned = resolve;
  });
  const bodyCancelled = new Promise<void>((resolve) => {
    noteBodyCancelled = resolve;
  });

  globalThis.fetch = async () => {
    requestCount += 1;
    if (requestCount > 1) {
      return Response.json({
        properties: {
          forecastGridData: null,
          observationStations: null,
          forecast: null
        }
      });
    }
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
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

  const firstController = new AbortController();
  const first = fetchPointHeat(
    CONTEXT,
    createNwsRequestSession(firstController.signal)
  );
  try {
    await headersReturned;
    firstController.abort();
    await expect(bodyCancelled).resolves.toBeUndefined();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });

    const secondController = new AbortController();
    const second = await fetchPointHeat(
      CONTEXT,
      createNwsRequestSession(secondController.signal)
    );
    expect(second.status).toBe('no-data');
    expect(requestCount).toBe(2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a superseded request session cannot return a completed cached value after abort', async () => {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    return Response.json({
      properties: {
        forecastGridData: null,
        observationStations: null,
        forecast: null
      }
    });
  };
  try {
    const firstController = new AbortController();
    const first = await fetchPointHeat(
      CONTEXT,
      createNwsRequestSession(firstController.signal)
    );
    expect(first.status).toBe('no-data');
    expect(requestCount).toBe(1);

    const secondController = new AbortController();
    secondController.abort();
    await expect(
      fetchPointHeat(
        CONTEXT,
        createNwsRequestSession(secondController.signal)
      )
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(requestCount).toBe(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
