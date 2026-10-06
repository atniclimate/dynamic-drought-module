import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';

const root = new URL('./', import.meta.url);
const sharedUrl = new URL('./offline-test.ts', root);
const specNames = readdirSync(root, { recursive: true }).filter((name) => name.endsWith('.spec.ts'));
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@playwright/test') return { url: 'offline-test:playwright', shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'offline-test:playwright') {
      return {
        format: 'module', shortCircuit: true,
        source: 'export const test = { extend: (fixtures) => { globalThis.__offlineFixtures = fixtures; return {}; } }; export const expect = {};'
      };
    }
    return nextLoad(url, context);
  }
});

async function sharedFixture() {
  assert.ok(existsSync(sharedUrl), 'the browser suite needs a shared offline fixture');
  return import(sharedUrl.href);
}

test('every browser spec obtains test from the shared offline fixture', () => {
  const bypasses = [];
  for (const name of specNames) {
    const specUrl = new URL(name.replaceAll('\\', '/'), root);
    const source = readFileSync(specUrl, 'utf8');
    const importsTest = [...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)]
      .some(([, names, module]) => names.split(',').some((name) => /^test(?:\s+as\s+\w+)?$/.test(name.trim())) &&
        new URL(`${module}.ts`, specUrl).href === sharedUrl.href);
    if (!importsTest) bypasses.push(name);
  }
  assert.deepEqual(bypasses, [], 'specs must inherit the offline context before browser setup');
});

test('the context fixture installs the external HTTP backstop before use without making context automatic', async () => {
  await sharedFixture();
  const fixture = globalThis.__offlineFixtures.context;
  assert.equal(typeof fixture, 'function', 'the override stays lazy, so pure tests never request a browser');
  const routes = [];
  const context = { route: async (matches, handle) => routes.push({ matches, handle }) };
  let used = false;
  await fixture({ context }, async (actual) => {
    used = true;
    assert.equal(actual, context, 'preserve the built-in context and its trace options');
    assert.equal(routes.length, 1, 'backstop is ready before test fixtures register');
    // Playwright runs a later context route first; fixtures keep their precedence.
    await actual.route((url) => url.pathname === '/specific', () => {});
  });
  assert.equal(used, true);
  const [{ matches, handle }] = routes;
  for (const address of [
    'https://tile.openstreetmap.org/0/0/0.png', 'http://example.org/service',
    'https://new-upstream.example/endpoint', 'http://127.0.0.2/sentinel',
    'https://localhost.example/service', 'https://127.0.0.1.example/service'
  ]) {
    assert.equal(matches(new URL(address)), true, address);
  }
  for (const address of [
    'http://127.0.0.1:4173/', 'http://localhost:4173/', 'http://[::1]:4173/',
    'data:text/plain,fixture', 'blob:http://127.0.0.1:4173/fixture'
  ]) {
    assert.equal(matches(new URL(address)), false, address);
  }
  let response;
  await handle({ fulfill: async (value) => { response = value; } });
  assert.deepEqual(response, { status: 503, contentType: 'text/plain', body: 'Synthetic offline response' });
});

test('local continuation preserves its network path while external lookalike assets fall back', async () => {
  const { continueLocalRoute } = await sharedFixture();
  for (const [address, expected] of [
    ['http://127.0.0.1:4173/assets/panel.js', 'continue'],
    ['http://localhost:4173/data/us-states.geojson', 'continue'],
    ['https://example.org/assets/panel.js', 'fallback'],
    ['https://example.org/data/us-states.geojson', 'fallback']
  ]) {
    const calls = [];
    await continueLocalRoute({
      request: () => ({ url: () => address }),
      continue: async () => { calls.push('continue'); },
      fallback: async () => { calls.push('fallback'); }
    });
    assert.deepEqual(calls, [expected], address);
  }
});

test('raw contexts block service workers and install their backstop before creating a page', () => {
  for (const name of ['mode-switch-cost.spec.ts', 'flow-measure.spec.ts']) {
    const text = readFileSync(new URL(name, root), 'utf8');
    const contexts = [...text.matchAll(/const context = await browser\.newContext\(\{([\s\S]*?)\}\);([\s\S]*?)const page = await context\.newPage\(\)/g)];
    assert.equal(contexts.length, name.startsWith('flow-') ? 3 : 1, `${name} raw context inventory`);
    for (const [, options, setup] of contexts) {
      assert.match(options, /serviceWorkers:\s*'block'/, `${name} raw context blocks service workers`);
      assert.match(setup, /await install(?:Offline)?Backstop\(context\)/, `${name} backstop precedes page creation`);
    }
  }
  const config = readFileSync(new URL('../playwright.config.ts', root), 'utf8');
  assert.match(config, /serviceWorkers:\s*'block'/, 'the built-in contexts block service workers');
  const measure = readFileSync(new URL('mode-switch-cost.spec.ts', root), 'utf8');
  assert.doesNotMatch(measure, /(?:nifc|nadm|nwsWwa):\s*'live'/, 'the routine measurement uses deterministic fixtures');
});

test('the browser specs cannot continue or fetch an external request around the backstop', () => {
  let rawContexts = 0;
  for (const name of specNames) {
    const source = readFileSync(new URL(name.replaceAll('\\', '/'), root), 'utf8');
    assert.doesNotMatch(source, /route\.continue\s*\(/, `${name} must guard a direct continuation`);
    const fetches = [...source.matchAll(/route\.fetch\(/g)].length;
    const guards = [...source.matchAll(/if \(isExternalHttp\(new URL\(route\.request\(\)\.url\(\)\)\)\) return route\.fallback\(\);\s*const response = await route\.fetch\(/g)].length;
    assert.equal(fetches, guards, `${name} must guard each route.fetch`);
    rawContexts += [...source.matchAll(/browser\.newContext\(/g)].length;
    assert.doesNotMatch(source, /serviceWorkers:\s*'allow'/, `${name} cannot bypass routes with a service worker`);
  }
  assert.equal(rawContexts, 4, 'new raw contexts must join the explicit offline setup inventory');
});
