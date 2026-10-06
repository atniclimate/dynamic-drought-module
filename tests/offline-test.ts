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
  context: async ({ context }, use) => {
    await installOfflineBackstop(context);
    await use(context);
  }
});
