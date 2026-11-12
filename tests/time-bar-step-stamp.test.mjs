/**
 * The time bar's step buttons and its horizon line (src/ui/time-bar.ts).
 *
 * Two quick Previous presses must ask for two stops back: an owning layer
 * re-installs its spec only once the stop it was asked for has loaded, so a
 * second press made before that must count from the stop already asked for,
 * not from the stop still on the map. And a stamp over data that is not the
 * newest names that data's own date in place of "now".
 *
 * Fake elements stand in for the DOM. It registers no Playwright tests: it
 * runs under `node --test`.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith('.') &&
      !/\.[a-z]+$/i.test(specifier) &&
      typeof context.parentURL === 'string' &&
      context.parentURL.endsWith('.ts') &&
      existsSync(fileURLToPath(new URL(`${specifier}.ts`, context.parentURL)))
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  }
});

class FakeButton {
  constructor(step) {
    this.dataset = { step };
    this.listeners = [];
  }
  addEventListener(type, fn) {
    if (type === 'click') this.listeners.push(fn);
  }
  click() {
    for (const fn of this.listeners) fn();
  }
}
class FakeBar {
  hidden = true;
  dataset = {};
  html = '';
  buttons = [];
  setAttribute() {}
  contains() {
    return false;
  }
  set innerHTML(html) {
    this.html = html;
    this.buttons = [...html.matchAll(/data-step="(-?1)"/g)].map(([, step]) => new FakeButton(step));
  }
  querySelector() {
    return null;
  }
  querySelectorAll(selector) {
    return selector === '.time-bar-step' ? this.buttons : [];
  }
}
const bar = new FakeBar();
globalThis.HTMLElement = class {};
globalThis.document = { activeElement: null, getElementById: (id) => (id === 'time-bar' ? bar : null) };

const { clearTimeBar, setTimeBar, stampHorizonText } = await import('../src/ui/time-bar.ts');
const { HORIZON_CHROME } = await import('../src/impact/horizon-chrome.ts');

function railSpec(index, onStep, stamp = {}) {
  return {
    ariaLabel: 'Weeks',
    stamp: { horizon: 'current', headline: 'h', detail: 'd', register: 'observed', ...stamp },
    rail: { count: 10, index, valueText: (i) => `stop ${i}`, onStep }
  };
}
const previous = () => bar.buttons.find((b) => b.dataset.step === '-1');

test('two quick Previous presses ask for two stops back before the first has loaded', () => {
  const asked = [];
  setTimeBar('usdm', railSpec(9, (i) => asked.push(i)));
  previous().click();
  previous().click();
  assert.deepEqual(asked, [8, 7]);
  clearTimeBar('usdm');
});

test('a re-installed spec is the new base: a step after a load or a failed load counts from the stop shown', () => {
  const asked = [];
  const onStep = (i) => asked.push(i);
  setTimeBar('usdm', railSpec(9, onStep));
  previous().click();
  // The stop loaded: the owner re-installs at 8.
  setTimeBar('usdm', railSpec(8, onStep));
  previous().click();
  // That load failed: the owner re-installs the unchanged spec at 8.
  setTimeBar('usdm', railSpec(8, onStep));
  previous().click();
  assert.deepEqual(asked, [8, 7, 7]);
  clearTimeBar('usdm');
});

test('the horizon line names the shown data\'s own date in place of "now" when the layer gives one', () => {
  assert.equal(stampHorizonText('current'), `${HORIZON_CHROME.current.title} · ${HORIZON_CHROME.current.subtitle}`);
  assert.equal(stampHorizonText('current', 'Jun 23, 2026'), `${HORIZON_CHROME.current.title} · Jun 23, 2026`);
  setTimeBar('usdm', railSpec(8, () => {}, { asOf: 'Jun 23, 2026' }));
  assert.match(bar.html, /class="time-bar-stamp-horizon"[^>]*>Current Conditions · Jun 23, 2026</);
  assert.doesNotMatch(bar.html, /· now/);
  clearTimeBar('usdm');
});
