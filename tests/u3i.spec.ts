import { test, expect } from '@playwright/test';
import type maplibregl from 'maplibre-gl';

import { gotoApp, regionButton, layerCheckbox, layerPill } from './helpers';
import { REGIONS, DEFAULT_REGION, type RegionKey } from '../src/config/regions';
import {
  TRIBAL_FAMILY_COLOR,
  TRIBAL_FILL_COLOR,
  TRIBAL_OUTLINE_COLOR,
  RESERVATION_FILL_COLOR,
  RESERVATION_OUTLINE_COLOR,
  TREATY_COLOR_DEFAULT,
  TREATY_COLORS
} from '../src/config/palette';
import {
  emphasizePlace,
  clearEmphasis,
  initPlaceEmphasis
} from '../src/state/place-emphasis';
import { setPlaceSelection } from '../src/state/place-selection';

/**
 * U3i: consolidated coverage for the U3 catalog-and-search overhaul.
 *
 * U3 shipped seven behavior-affecting sub-units (the magenta Tribal family,
 * the one search across three hosts, the region demotion, the Water & Snow
 * collapse, the feature-state emphasis) with no dedicated regression coverage.
 * This file adds it, holding two lines the suite draws elsewhere:
 *
 *   - Deterministic backbone only (playwright.config.ts doctrine 2): no test
 *     depends on a live agency response. The search-render cases read a bundled
 *     roster; the layer-selection cases toggle `treaty`, a bundled, default-off
 *     layer (no external fetch); the color and emphasis cases run in Node
 *     against source constants and a fake map.
 *   - Production build, never the dev server (doctrine 1). The dev-only
 *     `window.__ddmMap` handle is dead-code-eliminated from `dist/`, so the
 *     on-map paint and feature-state RENDER cannot be read here; that legibility
 *     check is the stage-5 Codex browser pass. What is deterministic and
 *     production-safe is the palette source of truth (the magenta family) and
 *     the emphasis module's own logic (fake map), so those are asserted here.
 */

const REGION_KEYS = Object.keys(REGIONS) as RegionKey[];

// ---------------------------------------------------------------------------
// U3e: the region grid demoted to a "jump to" list (D-0.7.0-009)
// ---------------------------------------------------------------------------

/**
 * The region grid became a plain, secondary single-column "jump to" list with
 * full-word `region.label` names (replacing the abbreviated `short`). Desktop
 * Brief now rehosts that same radiogroup ahead of the continental minimap; the
 * `#region-buttons` / `.region-btn` / `data-region-key` contract is unchanged.
 */
test.describe('U3i region demotion (D-0.7.0-009)', () => {
  test('console: the jump-to list shows full-word labels with radiogroup semantics', async ({
    page
  }) => {
    await gotoApp(page, '?view=console');

    // A visible console "where" control in its static fallback seat.
    await expect(page.locator('#panel-region')).toBeVisible();
    await expect(page.locator('#region-buttons')).toHaveAttribute('role', 'radiogroup');

    // Every region renders as a radio option.
    await expect(page.locator('#region-buttons .region-btn')).toHaveCount(REGION_KEYS.length);
    await expect(page.locator('#region-buttons .region-btn[role="radio"]')).toHaveCount(
      REGION_KEYS.length
    );

    // The visible text of EVERY button is the full-word `region.label`, NOT the
    // retired `short` (every label differs from its short, so trimmed exact
    // match doubles as the anti-`short` assertion, and covering all nine catches
    // a partial revert).
    for (const key of REGION_KEYS) {
      await expect(regionButton(page, key)).toHaveText(REGIONS[key].label);
    }

    // Radiogroup: exactly one option is checked (the default region), and it is
    // the active one.
    await expect(page.locator('#region-buttons .region-btn[aria-checked="true"]')).toHaveCount(1);
    await expect(regionButton(page, DEFAULT_REGION)).toHaveAttribute('aria-checked', 'true');
    await expect(regionButton(page, DEFAULT_REGION)).toHaveClass(/\bactive\b/);
  });

  test('brief: the same region jump-to panel is seated before the minimap', async ({
    page
  }) => {
    await gotoApp(page); // bare URL => Brief

    await expect(page.locator('#app')).toHaveClass(/\bview-brief\b/);

    await expect(page.locator('#shell-region-host > #panel-region')).toBeVisible();
    await expect(regionButton(page, DEFAULT_REGION)).toBeVisible();
    await expect(page.locator('#region-buttons .region-btn')).toHaveCount(REGION_KEYS.length);

    // The existing Brief search remains available in its later refinement seat.
    await expect(page.locator('#brief-search [data-ddm-search]')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// U3f2: the Water & Snow telemetry panel collapses by default (D-0.7.0-018)
// ---------------------------------------------------------------------------

/**
 * The telemetry panel heading is a reveal disclosure (`#telemetry-reveal`, a
 * button carrying `aria-expanded`) toggling a collapsible `#telemetry-body`
 * that ships `hidden`. Revealing is a pure DOM toggle: it never activates the
 * telemetry layer or changes its status pill (the honesty check). Driven in
 * console, where the full instrument is unambiguously shown and the telemetry
 * layer is off by default (it left the default-on set at H4).
 */
test.describe('U3i Water & Snow collapses by default (D-0.7.0-018)', () => {
  test('the panel is collapsed on first paint', async ({ page }) => {
    await gotoApp(page, '?view=console');

    await expect(page.locator('#telemetry-reveal')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#telemetry-body')).toBeHidden();
  });

  test('the disclosure reveals and re-collapses the body', async ({ page }) => {
    await gotoApp(page, '?view=console');

    await page.locator('#telemetry-reveal').click();
    await expect(page.locator('#telemetry-reveal')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#telemetry-body')).toBeVisible();

    // A second click closes it again (round-trip).
    await page.locator('#telemetry-reveal').click();
    await expect(page.locator('#telemetry-reveal')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#telemetry-body')).toBeHidden();
  });

  test('revealing never activates the telemetry layer (honesty check)', async ({ page }) => {
    await gotoApp(page, '?view=console');

    // Baseline: telemetry is not default-on, so its pill is empty and its
    // catalog checkbox is unchecked.
    await expect(layerPill(page, 'telemetry')).toBeEmpty();
    await expect(layerCheckbox(page, 'telemetry')).not.toBeChecked();

    await page.locator('#telemetry-reveal').click();
    await expect(page.locator('#telemetry-body')).toBeVisible(); // the reveal really happened

    // Unchanged: revealing is sidebar-local, never a layer activation.
    await expect(layerPill(page, 'telemetry')).toBeEmpty();
    await expect(layerCheckbox(page, 'telemetry')).not.toBeChecked();
  });
});

// ---------------------------------------------------------------------------
// U3g: the magenta-to-violet Tribal-context boundary family (D-0.7.0-019)
// ---------------------------------------------------------------------------

/**
 * Node-level guard on the palette source of truth. D-0.7.0-019 groups Tribal
 * Lands, Treaty Areas, and the live BIA reservations into ONE magenta-to-violet
 * tone family, replacing the prior unrelated warm-orange / seven-hue / indigo
 * spread. The on-map render and opacity hierarchy are the stage-5 browser pass
 * (the dev-only `__ddmMap` handle is absent from the production build the suite
 * verifies); what is deterministic here is that every family color still sits
 * in the magenta-to-violet band, saturated and bright enough to read, so a
 * revert to any other hue (the old warm orange, a blue/teal, a near-black or
 * washed-out grey) fails loudly, and the seven Treaty colors stay distinct.
 */
test.describe('U3i magenta Tribal family (D-0.7.0-019)', () => {
  /** Hue [0,360), HSV saturation [0,1], and HSV value [0,1] for a `#rrggbb`. */
  function hsv(hex: string): { hue: number; sat: number; val: number } {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) throw new Error(`not a 6-digit hex color: ${hex}`);
    const int = parseInt(m[1]!, 16);
    const r = ((int >> 16) & 0xff) / 255;
    const g = ((int >> 8) & 0xff) / 255;
    const b = (int & 0xff) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let hue = 0;
    if (d !== 0) {
      if (max === r) hue = (((g - b) / d) % 6 + 6) % 6;
      else if (max === g) hue = (b - r) / d + 2;
      else hue = (r - g) / d + 4;
      hue *= 60;
    }
    return { hue, sat: max === 0 ? 0 : d / max, val: max };
  }

  test('every family color sits in the magenta-to-violet band', () => {
    const family: ReadonlyArray<{ name: string; hex: string }> = [
      { name: 'TRIBAL_FAMILY_COLOR', hex: TRIBAL_FAMILY_COLOR },
      { name: 'TRIBAL_FILL_COLOR', hex: TRIBAL_FILL_COLOR },
      { name: 'TRIBAL_OUTLINE_COLOR', hex: TRIBAL_OUTLINE_COLOR },
      { name: 'RESERVATION_FILL_COLOR', hex: RESERVATION_FILL_COLOR },
      { name: 'RESERVATION_OUTLINE_COLOR', hex: RESERVATION_OUTLINE_COLOR },
      { name: 'TREATY_COLOR_DEFAULT', hex: TREATY_COLOR_DEFAULT },
      ...TREATY_COLORS.map((c) => ({ name: `TREATY_COLORS['${c.match}']`, hex: c.color }))
    ];

    for (const { name, hex } of family) {
      const { hue, sat, val } = hsv(hex);
      // Magenta (~330, pink edge) through violet (~255); nothing warm, blue, or
      // grey. The ruled family pin #8d006b sits at hue ~314 (E2, D-0.7.0-058
      // ruling 3), inside the band; the seven-hue spread remains for
      // the bundled deployer Treaty slot.
      expect(hue, `${name} (${hex}) hue ${hue.toFixed(0)} out of the magenta-to-violet band`).toBeGreaterThanOrEqual(250);
      expect(hue, `${name} (${hex}) hue ${hue.toFixed(0)} out of the magenta-to-violet band`).toBeLessThanOrEqual(335);
      // Saturated and bright enough to read as a color (excludes near-black /
      // washed-out greys that would still pass a hue check).
      expect(sat, `${name} (${hex}) is washed out (sat ${sat.toFixed(2)})`).toBeGreaterThan(0.4);
      expect(val, `${name} (${hex}) is too dark (val ${val.toFixed(2)})`).toBeGreaterThan(0.42);
    }

    // The E2 family pin (D-0.7.0-058 ruling 3): the ONE Tribal
    // boundary family hex, shared by every fill and outline of the family
    // (weight and fill strength stay the distinction channels, D-0.7.0-043
    // part 4).
    expect(TRIBAL_FAMILY_COLOR).toBe('#8d006b');
    for (const hex of [
      TRIBAL_FILL_COLOR,
      TRIBAL_OUTLINE_COLOR,
      RESERVATION_FILL_COLOR,
      RESERVATION_OUTLINE_COLOR
    ]) {
      expect(hex).toBe(TRIBAL_FAMILY_COLOR);
    }
    // The deployer Treaty spread is the seven expected Treaties, each a
    // DISTINCT hue (a family is not one purple repeated; adjacent areas stay
    // tellable apart, per the palette contract).
    expect(TREATY_COLORS.map((c) => c.match)).toEqual([
      'Medicine Creek',
      'Yakama',
      'Nez Perce',
      'Point Elliott',
      'Point No Point',
      'Quinault',
      'Walla Walla'
    ]);
    const treatyColors = TREATY_COLORS.map((c) => c.color.toLowerCase());
    expect(new Set(treatyColors).size).toBe(treatyColors.length);
  });
});

// ---------------------------------------------------------------------------
// U3h: selected-place feature-state emphasis
// ---------------------------------------------------------------------------

/**
 * `src/state/place-emphasis.ts` toggles a `selected` feature-state on the
 * chosen boundary so it stays lit while its popup or briefing is open, and
 * clears it when the selection ends. The on-map paint reading is the stage-5
 * browser pass; the module's own logic is deterministic and asserted here with
 * a fake map that records `setFeatureState` calls.
 */
test.describe('U3i selected-place emphasis (U3h)', () => {
  interface SetCall {
    target: { source: string; id: string | number };
    state: { selected: boolean };
  }

  function fakeMap(opts: { sourceMissing?: boolean; throwOnSet?: boolean } = {}): {
    map: maplibregl.Map;
    calls: SetCall[];
  } {
    const calls: SetCall[] = [];
    const map = {
      getSource: (_id: string) => (opts.sourceMissing ? undefined : {}),
      setFeatureState: (target: SetCall['target'], state: SetCall['state']) => {
        if (opts.throwOnSet) throw new Error('feature not in the clipped source');
        calls.push({ target, state });
      }
    } as unknown as maplibregl.Map;
    return { map, calls };
  }

  // The module carries a single `current` across tests in this worker; reset it
  // so each case starts with nothing lit.
  test.beforeEach(() => {
    clearEmphasis(fakeMap().map);
  });

  // The close-seam test subscribes a store listener; dispose it so it cannot
  // leak into a later test in the same worker.
  let disposeCloseSeam: (() => void) | null = null;
  test.afterEach(() => {
    disposeCloseSeam?.();
    disposeCloseSeam = null;
  });

  test('emphasizing lights the feature; clearing turns it off', () => {
    const { map, calls } = fakeMap();

    emphasizePlace(map, 'bia-reservations', 'LARID-1');
    expect(calls.at(-1)).toEqual({
      target: { source: 'bia-reservations', id: 'LARID-1' },
      state: { selected: true }
    });

    clearEmphasis(map);
    expect(calls.at(-1)).toEqual({
      target: { source: 'bia-reservations', id: 'LARID-1' },
      state: { selected: false }
    });
  });

  test('moving emphasis clears the prior feature before lighting the new one', () => {
    const { map, calls } = fakeMap();

    emphasizePlace(map, 'us-states', 'A');
    emphasizePlace(map, 'us-states', 'B');

    // The move writes selected:false on A, then selected:true on B.
    expect(calls.slice(-2)).toEqual([
      { target: { source: 'us-states', id: 'A' }, state: { selected: false } },
      { target: { source: 'us-states', id: 'B' }, state: { selected: true } }
    ]);
  });

  test('a missing id clears the live emphasis; a missing source and a clipped feature are silent', () => {
    // Missing id CLEARS a live emphasis rather than lighting an unknown feature:
    // light A, then pass null, and the last write turns A off.
    const cleared = fakeMap();
    emphasizePlace(cleared.map, 'us-states', 'A');
    emphasizePlace(cleared.map, 'us-states', null);
    expect(cleared.calls.at(-1)).toEqual({
      target: { source: 'us-states', id: 'A' },
      state: { selected: false }
    });

    // Missing source (the layer was toggled off): no paint written.
    const gone = fakeMap({ sourceMissing: true });
    emphasizePlace(gone.map, 'us-states', 'X');
    expect(gone.calls).toHaveLength(0);

    // setFeatureState throwing (feature absent from clipped data) is swallowed.
    const throws = fakeMap({ throwOnSet: true });
    expect(() => emphasizePlace(throws.map, 'us-states', 'Y')).not.toThrow();
  });

  test('the close seam clears emphasis when the place selection goes null', () => {
    const { map, calls } = fakeMap();
    disposeCloseSeam = initPlaceEmphasis(map); // subscribes to the place-selection store

    emphasizePlace(map, 'us-states', 'Z');
    expect(calls.at(-1)?.state).toEqual({ selected: true });

    // Closing the popup/briefing nulls the store; the subscriber drops the lit
    // feature.
    setPlaceSelection(null);
    expect(calls.at(-1)).toEqual({
      target: { source: 'us-states', id: 'Z' },
      state: { selected: false }
    });
  });
});

// ---------------------------------------------------------------------------
// U3b/c/d: the one search across the three hosts
// ---------------------------------------------------------------------------

/**
 * The unified search returns three result kinds (places, Tribal land areas by
 * name, layers) and rides three hosts (the console catalog, the Brief head, the
 * mobile at-hand sheet). `search.spec.ts` covers all three kinds in the console
 * host and place selection in the Brief and sheet hosts; the gap this fills is
 * the Tribal-land-area and layer kinds in the Brief head and the mobile sheet.
 * All render/select assertions are network-independent: the roster is bundled,
 * and the exercised layer (`treaty`) is a bundled, default-off placeholder, so
 * selecting it activates no external fetch. The live BIA locate (tribal
 * SELECTION) is the stage-5 Codex browser pass.
 */
test.describe('U3i one search across hosts (U3b/c/d)', () => {
  test('brief head: a Tribal land area renders as a result row', async ({ page }) => {
    await gotoApp(page, '?view=brief');

    await page.locator('#brief-search [data-ddm-search]').fill('nez perce');
    await expect(
      page
        .locator('#brief-search [data-search-group="tribal"] [role="option"]')
        .filter({ hasText: 'Nez Perce Tribe' })
    ).toBeVisible();
  });

  test('brief head: a layer result toggles its layer and clears the query', async ({ page }) => {
    await gotoApp(page, '?view=brief');

    // Baseline: places (City & Town Labels) is a bundled, default-off layer
    // (unchecked to start), so seeing it checked afterward proves the
    // selection did the activation. (The old example, the `treaty` deployer
    // slot, left the search index with Unit I, D-0.7.0-038 part 3.)
    await expect(layerCheckbox(page, 'places')).not.toBeChecked();

    const input = page.locator('#brief-search [data-ddm-search]');
    await input.fill('town labels');
    const result = page.locator(
      '#brief-search [data-search-kind="layer"][data-search-id="places"]'
    );
    await expect(result).toBeVisible();
    await result.click();

    // The shared toggle command turns the layer on (the checkbox holds the DOM
    // state even though the catalog is hidden in Brief) and the input clears.
    await expect(layerCheckbox(page, 'places')).toBeChecked();
    await expect(input).toHaveValue('');
  });

  test.describe('the mobile at-hand sheet (390x844)', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('sheet: a Tribal land area renders as a result row', async ({ page }) => {
      await gotoApp(page); // bare => Brief; the shell boots map-first (closed)
      await page.locator('#mobile-footer-nav button[data-tab="place"]').click();

      await page.locator('#sheet-search [data-ddm-search]').fill('spokane');
      await expect(
        page
          .locator('#sheet-search [data-search-group="tribal"] [role="option"]')
          .filter({ hasText: 'Spokane Tribe of the Spokane Reservation' })
      ).toBeVisible();
    });

    test('sheet: a layer result toggles its layer and clears the query', async ({ page }) => {
      await gotoApp(page);
      await page.locator('#mobile-footer-nav button[data-tab="place"]').click();

      await expect(layerCheckbox(page, 'places')).not.toBeChecked();

      const input = page.locator('#sheet-search [data-ddm-search]');
      await input.fill('town labels');
      const result = page.locator(
        '#sheet-search [data-search-kind="layer"][data-search-id="places"]'
      );
      await expect(result).toBeVisible();
      await result.click();

      await expect(layerCheckbox(page, 'places')).toBeChecked();
      await expect(input).toHaveValue('');
    });
  });
});

// ---------------------------------------------------------------------------
// The half-detent fit (Codex plan-attack MINOR 6)
// ---------------------------------------------------------------------------

/**
 * At a short-phone 390x844 in console mode, the sheet's HALF detent must fit
 * the whole console-half stack (the region jump-to list, the quick views, and
 * the door to the full catalog) without the retired U2 compaction. Because
 * `.sidebar-scroll` is `overflow: hidden` at half, anything pushed below the
 * fold is clipped and unreachable; the load-bearing assertion is that the
 * all-layers door's bottom edge falls inside the 844px viewport.
 */
test.describe('U3i half-detent fit at 390x844 (MINOR 6)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the console-half stack fits without the retired compaction', async ({ page }) => {
    await gotoApp(page, '?view=console'); // the shell boots map-first (closed)
    const app = page.locator('#app');

    // The Layers door opens the console at half. (A broken door or detent
    // transition fails HERE, before the known-gap marker below, so a real
    // regression still reds the suite.)
    await page.locator('#mobile-footer-nav button[data-tab="layers"]').click();
    await expect(app).toHaveAttribute('data-sheet-detent', 'half');

    // The whole half-console stack is present.
    await expect(page.locator('#panel-region')).toBeVisible();
    await expect(page.locator('#panel-quick-views')).toBeVisible();
    const door = page.locator('#sheet-all-layers-btn');
    await expect(door).toBeVisible();

    const doorBox = await door.boundingBox();
    const sheetBox = await page.locator('#sidebar').boundingBox();
    expect(doorBox).not.toBeNull();
    expect(sheetBox).not.toBeNull();
    expect(doorBox!.y).toBeGreaterThanOrEqual(sheetBox!.y); // inside the sheet band

    // MINOR 6 RESOLVED (2026-07-14 mobile-shell build, from the ratified
    // 2026-07-11 mockup): the conditions strip left the half detent (it is
    // peek's content) and `.sidebar-scroll` scrolls INTERNALLY at half, the
    // mockup's own sheet-body behavior. The former expected-fail marker is
    // off: the contract is now that a touch user can genuinely REACH the
    // door at half, by layout or by the real scroll surface.
    const scroll = page.locator('#sidebar .sidebar-scroll');
    expect(await scroll.evaluate((el) => getComputedStyle(el).overflowY)).toBe('auto');
    await door.scrollIntoViewIfNeeded();
    const reachableBox = await door.boundingBox();
    expect(reachableBox).not.toBeNull();
    expect(reachableBox!.y + reachableBox!.height).toBeLessThanOrEqual(844);
  });
});
