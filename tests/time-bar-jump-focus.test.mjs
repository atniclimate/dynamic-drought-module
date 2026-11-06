/**
 * A time-bar jump chip hands keyboard focus to the next bar, not the page
 * body (src/ui/time-bar.ts render). A jump turns the old layer off, which
 * clears its bar under the focused chip, and the new owner installs a bar
 * with different chips. Fake elements stand in for the DOM: setting the
 * bar's innerHTML replaces its children and, like a browser, drops focus
 * to the body when the focused child goes.
 *
 * It registers no Playwright tests: it runs under `node --test`.
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

class FakeElement {
  constructor(dataset = {}) {
    this.dataset = dataset;
  }
  matches() {
    return false;
  }
  addEventListener() {}
  focus() {
    globalThis.document.activeElement = this;
  }
}
globalThis.HTMLElement = FakeElement;

const body = new FakeElement();
const elsewhere = new FakeElement();
class FakeBar extends FakeElement {
  hidden = true;
  children = [];
  setAttribute() {}
  contains(node) {
    return this.children.includes(node);
  }
  set innerHTML(html) {
    const lost = this.children.includes(globalThis.document.activeElement);
    this.children = [...html.matchAll(/data-jump="([^"]+)"/g)].map(
      ([, jump]) => new FakeElement({ jump })
    );
    if (lost) globalThis.document.activeElement = body;
  }
  querySelector(selector) {
    const jump = /^\[data-jump="(.+)"\]$/.exec(selector)?.[1];
    if (jump) return this.children.find((c) => c.dataset.jump === jump) ?? null;
    if (selector === '.time-bar-jump, .time-bar-rail') return this.children[0] ?? null;
    return null;
  }
  querySelectorAll(selector) {
    return selector === '.time-bar-jump' ? this.children : [];
  }
}
const bar = new FakeBar();
globalThis.document = {
  body,
  activeElement: body,
  getElementById: (id) => (id === 'time-bar' ? bar : null)
};

const { clearTimeBar, setTimeBar } = await import('../src/ui/time-bar.ts');

function spec(...keys) {
  return {
    ariaLabel: 'Time',
    stamp: { register: 'current', horizon: 'current', headline: 'h', detail: 'd' },
    jumps: {
      options: keys.map((key) => ({ key, label: key, title: key })),
      onJump() {}
    }
  };
}

function focusChip(key) {
  bar.querySelector(`[data-jump="${key}"]`).focus();
}

test('clear first, then the new bar: the new bar takes focus', () => {
  setTimeBar('usdm', spec('monthly'));
  focusChip('monthly');
  clearTimeBar('usdm');
  assert.equal(document.activeElement, body);
  setTimeBar('outlook', spec('weekly'));
  assert.equal(document.activeElement?.dataset.jump, 'weekly');
  clearTimeBar('outlook');
});

test('the new bar installs before the old clear: focus lands on its chip', () => {
  setTimeBar('usdm', spec('monthly'));
  focusChip('monthly');
  setTimeBar('outlook', spec('weekly'));
  assert.equal(document.activeElement?.dataset.jump, 'weekly');
  clearTimeBar('outlook');
});

test('a bar that installs after the person moved on leaves focus alone', () => {
  setTimeBar('usdm', spec('monthly'));
  focusChip('monthly');
  clearTimeBar('usdm');
  elsewhere.focus();
  setTimeBar('outlook', spec('weekly'));
  assert.equal(document.activeElement, elsewhere);
  clearTimeBar('outlook');
});

test('a bar cleared without focus does not pull focus on the next install', () => {
  document.activeElement = body;
  setTimeBar('usdm', spec('monthly'));
  clearTimeBar('usdm');
  setTimeBar('outlook', spec('weekly'));
  assert.equal(document.activeElement, body);
  clearTimeBar('outlook');
});
