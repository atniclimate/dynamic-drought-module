import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Audit finding 4: a `studio=` link in an embed or a frame set the route, but
 * no studio ever mounts there, so map clicks, Enter/Space and the held
 * `select=` briefing waited on a screen nobody owned. `studioOwnsScreen()` is
 * the one question those gates ask: a route is set AND this document is not
 * physically framed AND `#app` has no `embed` class (the same two tests
 * view-shell and the sidebar already use to refuse a studio mount).
 */

const app = { classList: { contains: (name) => app.classes.has(name) }, classes: new Set() };

function stubWindow(framed) {
  const self = {};
  globalThis.window = {
    self,
    top: framed ? {} : self,
    location: { search: '?studio=place', href: 'https://example.test/?studio=place', pathname: '/' },
    history: { state: null, replaceState() {}, pushState() {} },
    addEventListener() {}
  };
  globalThis.document = { getElementById: (id) => (id === 'app' ? app : null) };
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = typeof context.parentURL === 'string' ? new URL(context.parentURL) : null;
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) && parent?.pathname.endsWith('.ts')) {
      const candidate = new URL(`${specifier}.ts`, parent);
      if (existsSync(fileURLToPath(candidate))) return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  }
});

// Physical framing is read once at module load, so each framing is a fresh
// evaluation of the module (the query string forces one).
async function load(framed, tag) {
  stubWindow(framed);
  return import(`../src/state/studio-route.ts?${tag}`);
}

test('studioOwnsScreen: a route, not framed, not embed', async () => {
  app.classes.clear();
  const { initializeStudioRoute, studioOwnsScreen } = await load(false, 'own');
  initializeStudioRoute('place', { synthesizeReturnEntry: false });
  assert.equal(studioOwnsScreen(), true);
});

test('studioOwnsScreen: an embed class never lets a route own the screen', async () => {
  app.classes.clear();
  const { initializeStudioRoute, studioOwnsScreen } = await load(false, 'embed');
  initializeStudioRoute('place', { synthesizeReturnEntry: false });
  app.classes.add('embed');
  assert.equal(studioOwnsScreen(), false);
  app.classes.delete('embed');
  assert.equal(studioOwnsScreen(), true);
});

test('studioOwnsScreen: a physical frame never lets a route own the screen', async () => {
  app.classes.clear();
  const { initializeStudioRoute, studioOwnsScreen } = await load(true, 'framed');
  initializeStudioRoute('place', { synthesizeReturnEntry: false });
  assert.equal(studioOwnsScreen(), false);
});

test('studioOwnsScreen: no route is never an owner', async () => {
  app.classes.clear();
  const { initializeStudioRoute, studioOwnsScreen } = await load(false, 'none');
  initializeStudioRoute(null, { synthesizeReturnEntry: false });
  assert.equal(studioOwnsScreen(), false);
});
