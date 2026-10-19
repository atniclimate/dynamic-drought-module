import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * Finding 17: a light-dismiss press sets swallowNextClick, expecting a click.
 * On a phone a press that becomes a pan or scroll fires no click, so the flag
 * must not outlive the gesture and eat the next real tap. It clears on the
 * next pointerdown, on pointercancel, and after 400 ms, whichever is first.
 *
 * Runs under plain `node --test`: the module has no imports, so a fake
 * document and a fake popover are the whole environment.
 */

globalThis.Node = class {};

const { wireShellPopover } = await import('../src/ui/island/popover-discipline.ts');

function setup() {
  const listeners = new Map();
  globalThis.document = {
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type)
  };
  let open = true;
  const pop = {
    matches: () => open,
    contains: () => false,
    hidePopover: () => {
      open = false;
    },
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null
  };
  const dispose = wireShellPopover(pop, () => null);
  const fire = (type) => {
    const event = {
      target: new Node(),
      prevented: false,
      preventDefault() {
        this.prevented = true;
      },
      stopPropagation() {}
    };
    listeners.get(type)?.(event);
    return event;
  };
  return { fire, dispose, listeners };
}

test('the click that follows a dismissing press is still swallowed', () => {
  const { fire } = setup();
  fire('pointerdown');
  assert.equal(fire('click').prevented, true);
  assert.equal(fire('click').prevented, false, 'only one click is consumed');
});

test('a dismissing press that becomes a pan (pointercancel) leaves the next click alone', () => {
  const { fire } = setup();
  fire('pointerdown');
  fire('pointercancel');
  assert.equal(fire('click').prevented, false);
});

test('the next pointerdown clears the flag before its own click', () => {
  const { fire } = setup();
  fire('pointerdown');
  fire('pointerdown');
  assert.equal(fire('click').prevented, false);
});

test('the flag expires after 400 ms with no click', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { fire } = setup();
  fire('pointerdown');
  t.mock.timers.tick(400);
  assert.equal(fire('click').prevented, false);
});

test('opening focuses the framing radiogroup stop, not an earlier ocean zone', () => {
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  let focused = null;
  const el = (name) => ({ focus: () => (focused = name) });
  // Document order: the ocean paths (tabindex 0) precede the radiogroup.
  const ocean = el('ocean'), radio = el('radio');
  let onToggle;
  const pop = {
    addEventListener: (type, fn) => type === 'toggle' && (onToggle = fn),
    removeEventListener() {},
    querySelector: (sel) => (sel.startsWith('[role="radiogroup"]') ? radio : ocean)
  };
  wireShellPopover(pop, () => null);
  onToggle({ newState: 'open' });
  assert.equal(focused, 'radio');
});

test('the disposer removes every listener', () => {
  const { dispose, listeners } = setup();
  dispose();
  assert.equal(listeners.size, 0);
});
