import { test as base, type BrowserContext, type Route } from '@playwright/test';

export * from '@playwright/test';

/** Only the local preview and local test servers may reach the network. */
export function isExternalHttp(url: URL): boolean {
  return (url.protocol === 'http:' || url.protocol === 'https:') &&
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
}

/** Install first: later context fixtures and all page fixtures keep precedence. */
export async function installOfflineBackstop(context: BrowserContext): Promise<void> {
  await context.route(isExternalHttp, (route) => route.fulfill({
    status: 503, contentType: 'text/plain', body: 'Synthetic offline response'
  }));
}

/** A held local asset keeps its original continuation; an external URL reaches the backstop. */
export async function continueLocalRoute(route: Route): Promise<void> {
  if (isExternalHttp(new URL(route.request().url()))) await route.fallback();
  else await route.continue();
}

// Override the built-in fixture without making it automatic: pure tests still
// collect and run without launching a browser, and trace options stay intact.
export const test = base.extend({
  context: async ({ context }, use, testInfo) => {
    await installOfflineBackstop(context);
    await use(context);
    // A 3D page closed with software-renderer frames still queued stalled this
    // worker's browser in the NEXT test's context setup (15 to 60+ s on GitHub,
    // run 38526081258); a failed test restarts the worker, so only a pass drains.
    if (testInfo.project.name === 'chromium-3d' && testInfo.status === 'passed') await drainMapRenderers(context);
  }
});

/** One 1x1 readback per map canvas waits out the queued frames (the RAWS case's drain). */
async function drainMapRenderers(context: BrowserContext): Promise<void> {
  const started = Date.now();
  for (const page of context.pages()) {
    await page.evaluate(() => {
      for (const canvas of document.querySelectorAll<HTMLCanvasElement>('canvas.maplibregl-canvas')) {
        const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null;
        gl?.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      }
    }).catch(() => {}); // a crashed or navigating page has nothing left to drain
  }
  const ms = Date.now() - started;
  if (ms > 1_000) console.log(`[3d-teardown] drained the map renderer in ${ms} ms before the context closed`);
}
