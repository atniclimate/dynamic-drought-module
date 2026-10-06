import { createServer } from 'node:http';
import { test, expect, continueLocalRoute } from './offline-test';
import { routeAllTribalFixtures } from './tribal-fixtures';
import { installMinimapAnalysisStubs } from './minimap-fixtures';

test('the offline boundary blocks unmatched requests while page and later context fixtures still win', async ({ page, context }) => {
  await routeAllTribalFixtures(page);
  await installMinimapAnalysisStubs(page);
  let hits = 0;
  // This loopback address deliberately falls outside the preview allowlist.
  // A broken backstop can reach only this test server, never a live service.
  const server = createServer((_request, response) => {
    hits += 1;
    response.writeHead(200, { 'Content-Type': 'text/plain' }).end('escaped the backstop');
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.2', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('offline sentinel did not bind');
    const origin = `http://127.0.0.2:${address.port}`;
    const unmatched = await page.goto(`${origin}/unmatched`);
    expect(unmatched?.status()).toBe(503);
    expect(await unmatched?.text()).toBe('Synthetic offline response');

    await context.route(`${origin}/fixture`, (route) => route.fulfill({ status: 200, body: 'context fixture' }));
    expect(await (await page.goto(`${origin}/fixture`))?.text()).toBe('context fixture');
    await page.route(`${origin}/fixture`, (route) => route.fulfill({ status: 200, body: 'page fixture' }));
    await context.route(`${origin}/fixture`, (route) => route.fulfill({ status: 200, body: 'newest context fixture' }));
    expect(await (await page.goto(`${origin}/fixture`))?.text()).toBe('page fixture');

    await page.route('**/assets/offline-sentinel.js', continueLocalRoute);
    expect((await page.goto(`${origin}/assets/offline-sentinel.js`))?.status()).toBe(503);
    expect(hits, 'all external-shaped requests stayed inside Playwright routing').toBe(0);
  } finally {
    await page.goto('about:blank');
    if (server.listening) await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});
