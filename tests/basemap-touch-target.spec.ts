import { test, expect } from '@playwright/test';
import { BasemapSwitcherControl } from '../src/map/basemap-switcher';
import {
  getBasemapMode,
  setBasemapMode
} from '../src/state/basemap-store';
import { gotoApp } from './helpers';

/**
 * U-UX-FIX-1 DEG-2 (usability triage 2026-07-24): the Satellite basemap
 * toggle measured 104x29px on mobile, under the 44px touch-target floor
 * that every other primary mobile control already meets (the sheet
 * controls' floor in app.css). The switcher must clear the same floor
 * when the mobile sheet shell is active, and keep the compact map
 * control family stack on desktop.
 */

test.describe('DEG-2 the Satellite toggle touch target (390x844)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the mobile switcher clears the 44px touch floor', async ({ page }) => {
    await gotoApp(page);
    // The mobile sheet shell is active (the touch-target floor's gate).
    await expect(page.locator('#app')).toHaveAttribute('data-sheet-detent', 'closed');

    const btn = page.locator('.basemap-switcher-btn');
    await expect(btn).toBeVisible();
    const box = await btn.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);

    // The button still works at the grown size: one tap flips the state
    // (aria-pressed carries it; real button semantics).
    await expect(btn).toHaveAttribute('aria-pressed', 'false');
    await btn.click();
    await expect(btn).toHaveAttribute('aria-pressed', 'true');
    await btn.click();
    await expect(btn).toHaveAttribute('aria-pressed', 'false');
  });
});

test.describe('DEG-2 desktop keeps the compact control family', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('a removed switcher releases its basemap-store subscription', () => {
    type FakeElement = {
      attributes: Map<string, string>;
      children: FakeElement[];
      classList: { toggle: (name: string, force?: boolean) => void };
      className: string;
      removed: boolean;
      setAttribute: (name: string, value: string) => void;
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

    const originalDocument = globalThis.document;
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
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: originalDocument
      });
    }
  });

  test('the desktop switcher stays in the one-family stack, unchanged', async ({
    page
  }) => {
    // Console keeps Share in the on-map control family. Desktop Brief moves
    // the same wired button into its ordered shell, where it is full width.
    await gotoApp(page, '?view=console');
    const btn = page.locator('.basemap-switcher-btn');
    await expect(btn).toBeVisible();
    const box = await btn.boundingBox();
    expect(box).not.toBeNull();
    // The compact family chrome: no touch floor on desktop, and the
    // switcher matches the Share view / Reset stack width (the shared
    // --map-ctrl-w token, asserted RELATIONALLY against a family member
    // so a ratified retune of the token value never fails this spec;
    // the DEG-2 contract is the family stack, not the token's number).
    const familyBox = await page.locator('#share-btn').boundingBox();
    expect(familyBox).not.toBeNull();
    expect(Math.abs(box!.width - familyBox!.width)).toBeLessThanOrEqual(1);
    expect(box!.height).toBeLessThan(44);
  });
});
