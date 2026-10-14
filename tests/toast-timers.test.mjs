import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * showToast: a second toast cancels the first one's pending fade and hide
 * (it keeps its own full hold), and a long message is held longer than 1.7 s.
 * Real overlay.ts, a fake DOM and a fake clock.
 */

// Extensionless relative `.ts` imports (see tests/hydrate-lane-reject.test.mjs).
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith('.') &&
      !/\.[a-z]+$/i.test(specifier) &&
      typeof context.parentURL === 'string' &&
      context.parentURL.endsWith('.ts')
    ) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) {
        return nextResolve(`${specifier}.ts`, context);
      }
    }
    return nextResolve(specifier, context);
  }
});

let now = 0;
let nextId = 0;
const timers = new Map();
globalThis.window = {
  setTimeout(fn, ms) {
    nextId += 1;
    timers.set(nextId, { at: now + ms, fn });
    return nextId;
  },
  clearTimeout(id) {
    timers.delete(id);
  },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
};
const toast = {
  hidden: true,
  textContent: '',
  offsetWidth: 0,
  parentElement: null,
  classList: {
    shown: false,
    add(c) {
      if (c === 'visible') this.shown = true;
    },
    remove(c) {
      if (c === 'visible') this.shown = false;
    }
  }
};
const status = { textContent: '' };
globalThis.document = {
  getElementById: (id) =>
    id === 'copy-toast' ? toast : id === 'copy-toast-status' ? status : null
};
globalThis.queueMicrotask = (fn) => fn();

const { showToast } = await import('../src/ui/overlay.ts');

function advanceTo(to) {
  for (;;) {
    const due = [...timers.entries()]
      .filter(([, t]) => t.at <= to)
      .sort((a, b) => a[1].at - b[1].at)[0];
    if (!due) break;
    timers.delete(due[0]);
    now = due[1].at;
    due[1].fn();
  }
  now = to;
}
const visible = () => !toast.hidden && toast.classList.shown;

test('a second toast within 2 s keeps its own full hold', () => {
  showToast('A');
  advanceTo(1900);
  showToast('B');
  advanceTo(1900 + 1600);
  assert.ok(visible(), 'B is still on screen 1.6 s after it was shown');
  advanceTo(1900 + 1701);
  assert.equal(toast.classList.shown, false, 'B fades after its own 1.7 s');
  advanceTo(1900 + 1701 + 250);
  assert.equal(toast.hidden, true);
});

test('a long message is held about 55 ms a character', () => {
  const message = 'x'.repeat(107);
  const start = now;
  showToast(message);
  advanceTo(start + 5000);
  assert.ok(visible(), 'a 107-character toast is still readable at 5 s');
  advanceTo(start + 55 * 107 + 1);
  assert.equal(toast.classList.shown, false);
});

test('a very long message (a crafted link) is held at most 8 s', () => {
  const start = now;
  showToast('x'.repeat(2035));
  advanceTo(start + 7999);
  assert.ok(visible());
  advanceTo(start + 8001);
  assert.equal(toast.classList.shown, false, 'not the 112 s a 2,035-character hold would be');
});
