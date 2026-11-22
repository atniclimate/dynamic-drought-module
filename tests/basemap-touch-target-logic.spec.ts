// Moved from tests/basemap-touch-target.spec.ts: this test never opens a page, so it runs in the pure lane (verify:pure).
import { test, expect } from './offline-test';
import { BasemapSwitcherControl } from '../src/map/basemap-switcher';
import {
  getBasemapMode,
  setBasemapMode
} from '../src/state/basemap-store';

test.describe('DEG-2 desktop keeps the compact control family', () => {
  test('a removed switcher releases its basemap-store subscription', () => {
    type FakeElement = {
      attributes: Map<string, string>;
      children: FakeElement[];
      classList: { toggle: (name: string, force?: boolean) => void };
      className: string;
      removed: boolean;
      setAttribute: (name: string, value: string) => void;
      toggleAttribute: (name: string, force?: boolean) => boolean;
      addEventListener: () => void;
      appendChild: (child: FakeElement) => FakeElement;
      remove: () => void;
      textContent: string;
      title: string;
      type: string;
    };

    const created: FakeElement[] = [];
    const makeElement = (): FakeElement => {
      const element: FakeElement = {
        attributes: new Map(),
        children: [],
        classList: { toggle: () => {} },
        className: '',
        removed: false,
        setAttribute(name, value) {
          element.attributes.set(name, value);
        },
        toggleAttribute(name, force) {
          const on = force ?? !element.attributes.has(name);
          if (on) element.attributes.set(name, '');
          else element.attributes.delete(name);
          return on;
        },
        addEventListener: () => {},
        appendChild(child) {
          element.children.push(child);
          return child;
        },
        remove() {
          element.removed = true;
        },
        textContent: '',
        title: '',
        type: ''
      };
      created.push(element);
      return element;
    };

    // The pure lane shares one worker: put back the descriptor this test found
    // (or delete the property when there was none), as installFakeBrowser.restore does.
    const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const original = getBasemapMode();
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { createElement: makeElement }
    });

    try {
      const control = new BasemapSwitcherControl();
      const container = control.onAdd({} as never);
      const button = created[1];
      const before = button?.attributes.get('aria-pressed');

      control.onRemove();
      setBasemapMode(original === 'default' ? 'satellite' : 'default');

      expect(container).toBe(created[0]);
      expect(created[0]?.removed).toBe(true);
      expect(button?.attributes.get('aria-pressed')).toBe(before);
    } finally {
      setBasemapMode(original);
      if (documentDescriptor) {
        Object.defineProperty(globalThis, 'document', documentDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'document');
      }
    }
  });
});
