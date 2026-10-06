import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Collect the spec's setup without starting Playwright or making a request.
const setups = [];
globalThis.__coordinatorOfflineSetups = setups;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@playwright/test' || specifier === './helpers') {
      return { url: `offline-proof:${specifier}`, shortCircuit: true };
    }
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) && context.parentURL?.endsWith('.ts')) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'offline-proof:@playwright/test') {
      return { format: 'module', shortCircuit: true, source:
        'export const test = { beforeEach: (fn) => globalThis.__coordinatorOfflineSetups.push(fn), describe() {} }; export const expect = () => {};' };
    }
    if (url === 'offline-proof:./helpers') {
      return { format: 'module', shortCircuit: true, source:
        'export const gotoApp = () => {}; export const waitForLayerSettled = () => {};' };
    }
    return nextLoad(url, context);
  }
});
await import('./coordinator-frame-model.spec.ts');
delete globalThis.__coordinatorOfflineSetups;

test('coordinator frame setup answers external HTTP requests offline before boot', async () => {
  const routes = [];
  for (const setup of setups) {
    await setup({ context: { route: async (matches, handle) => routes.push({ matches, handle }) } });
  }
  for (const address of ['https://tile.openstreetmap.org/0/0/0.png', 'https://example.org/service', 'http://example.org/service']) {
    const route = routes.find(({ matches }) => matches(new URL(address)));
    assert.ok(route, `no offline backstop for ${address}`);
    let response;
    await route.handle({ fulfill: async (value) => { response = value; } });
    assert.deepEqual(response, { status: 503, contentType: 'text/plain', body: 'Synthetic offline response' });
  }
  for (const address of ['http://127.0.0.1:4173/', 'http://localhost:4173/', 'data:text/plain,fixture']) {
    assert.ok(routes.every(({ matches }) => !matches(new URL(address))), address);
  }
});
