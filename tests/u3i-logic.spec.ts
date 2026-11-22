// The Node-level palette and emphasis cases of u3i.spec.ts, moved here because they open no page and so run in the pure lane.
import { test, expect } from './offline-test';
import type * as maplibregl from 'maplibre-gl';

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
