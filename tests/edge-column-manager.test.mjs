import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The right-edge column's manager (owner direction 2026-11-09 (sprint),
 * DR-pending): the one rule in src/ui/edge-column.ts that decides whether a
 * control counts toward its group.
 *
 * Why it has its own test. The manager hides a group the plan did not place
 * (a group with nothing to show). The count once treated that attribute as a
 * reason not to count the group's controls, so a group that was ever empty
 * stayed at zero and stayed hidden for the life of the page: the Layers
 * studio borrows Satellite, the view group empties, and Satellite never came
 * back to the column. docs/design/mobile-map-chrome.md says nothing is
 * dropped; this is the rule that keeps that true.
 *
 * The nodes here are plain objects with the three members the rule reads
 * (`hidden`, `closest`, `contains`); the full sequence in a browser is
 * checked on the sprint camera.
 */

// Extensionless relative `.ts` imports (see tests/briefing-truth.test.mjs).
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

const { countsTowardGroup, isConditionalCell } = await import('../src/ui/edge-column.ts');

/** A node with a parent chain, a `hidden` flag and a computed display. */
function node(parent = null, { hidden = false, display = 'flex' } = {}) {
  return {
    parent,
    hidden,
    display,
    closest(selector) {
      assert.equal(selector, '[hidden]');
      for (let at = this; at; at = at.parent) if (at.hidden) return at;
      return null;
    },
    contains(other) {
      for (let at = other; at; at = at.parent) if (at === this) return true;
      return false;
    }
  };
}

globalThis.getComputedStyle = (element) => ({ display: element.display });

/** root (the group) > body > [container >] button */
function group({ rootHidden = false, bodyHidden = false, containerHidden = false, buttonHidden = false, display = 'flex' } = {}) {
  const root = node(null, { hidden: rootHidden });
  const body = node(root, { hidden: bodyHidden });
  const container = node(body, { hidden: containerHidden });
  const button = node(container, { hidden: buttonHidden, display });
  return { body, button };
}

test('a shown control counts', () => {
  const { body, button } = group();
  assert.equal(countsTowardGroup(button, body), true);
});

test('a control hidden by its own attribute, by a container inside the body, or by the body does not count', () => {
  for (const hiddenAt of ['buttonHidden', 'containerHidden', 'bodyHidden']) {
    const { body, button } = group({ [hiddenAt]: true });
    assert.equal(countsTowardGroup(button, body), false, hiddenAt);
  }
});

test('a control styled away does not count', () => {
  const { body, button } = group({ display: 'none' });
  assert.equal(countsTowardGroup(button, body), false);
});

/** A cell inside a seat node that carries `data-edge-order`, as `place` stamps it. */
function seated(order) {
  const seat = { getAttribute: (name) => (name === 'data-edge-order' ? String(order) : null) };
  return { closest: (selector) => (selector === '[data-edge-order]' ? seat : null) };
}

test('the conditional table names only real modes and real seats, and tells them from the always-present cells', async () => {
  const { HAZARD_CLUSTER_KEYS } = await import('../src/config/clusters.ts');
  const { EDGE_CONDITIONAL_SEATS, EDGE_GROUP_ORDER } = await import('../src/config/edge-column.ts');
  assert.ok(EDGE_CONDITIONAL_SEATS.length > 0);
  for (const seat of EDGE_CONDITIONAL_SEATS) {
    assert.ok(EDGE_GROUP_ORDER.includes(seat.group), seat.group);
    assert.ok(seat.modes.length > 0 && seat.modes.every((mode) => HAZARD_CLUSTER_KEYS.includes(mode)), seat.group);
    assert.equal(isConditionalCell(seat.group, seated(seat.order)), true, `${seat.group}:${seat.order}`);
    // The same order in another group is a different seat.
    const other = EDGE_GROUP_ORDER.find((id) => !EDGE_CONDITIONAL_SEATS.some((s) => s.group === id && s.order === seat.order));
    assert.equal(isConditionalCell(other, seated(seat.order)), false);
  }
  // The four doors, SAT, Locate and the hazard views ride the first orders: always present.
  assert.equal(isConditionalCell('panels', seated(10)), false);
  assert.equal(isConditionalCell('view', seated(10)), false);
  assert.equal(isConditionalCell('view', seated(20)), false);
  assert.equal(isConditionalCell('hazards', seated(10)), false);
  // A cell nobody has seated is not conditional.
  assert.equal(isConditionalCell('panels', { closest: () => null }), false);
});

test('the group being hidden does not stop its controls from counting', () => {
  // The manager hid the group because it was empty. Its control is back:
  // it must count, or the group could never be shown again.
  const { body, button } = group({ rootHidden: true });
  assert.equal(countsTowardGroup(button, body), true);
});
