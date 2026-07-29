import { test, expect } from '@playwright/test';

import {
  FRAMINGS,
  FRAMING_KEYS
} from '../src/config/framings';
import {
  HAZARD_CLUSTERS,
  HAZARD_CLUSTER_KEYS,
  CLUSTER_DISPLAY_NAMES,
  TEMPORAL_HORIZON_KEYS
} from '../src/config/clusters';
import { OCEANS, OCEAN_KEYS } from '../src/config/oceans';
import {
  INTERACTION_TARGET_RANKS,
  interactionRank
} from '../src/config/interaction-ranks';
import { REGIONS } from '../src/config/regions';
import { LAYER_DEFS } from '../src/config/layers';
import {
  getTypedPlace,
  setTypedPlace,
  onTypedPlaceChange
} from '../src/state/typed-place';

/**
 * S1: the region-shell state and config substrate (D-0.7.0-039 through
 * -057 as consumed by the S1 handoff). Pure Node assertions in the
 * u4-opening-map pattern: the substrate has no visible surface, so the
 * spec pins the ruled vocabulary and the tables' internal honesty
 * instead of driving a browser.
 */

const LAYER_KEYS = new Set(LAYER_DEFS.map((def) => def.key));
const SURFACE_KEYS = new Set(
  LAYER_DEFS.filter((def) => def.role === 'surface').map((def) => def.key)
);

type LeafletBounds = readonly [readonly [number, number], readonly [number, number]];

function expectValidBounds(bounds: LeafletBounds, label: string): void {
  const [[south, west], [north, east]] = bounds;
  expect(south, `${label}: south below north`).toBeLessThan(north);
  expect(west, `${label}: west below east`).toBeLessThan(east);
  expect(Math.abs(south), `${label}: south is a latitude`).toBeLessThanOrEqual(90);
  expect(Math.abs(north), `${label}: north is a latitude`).toBeLessThanOrEqual(90);
  expect(Math.abs(west), `${label}: west is a longitude`).toBeLessThanOrEqual(180);
  expect(Math.abs(east), `${label}: east is a longitude`).toBeLessThanOrEqual(180);
}

test.describe('S1 framings (D-0.7.0-039, D-0.7.0-051)', () => {
  test('exactly nine editorial framings, each with valid bounds and a provenance note', () => {
    expect(FRAMING_KEYS).toHaveLength(9);
    expect(new Set(FRAMING_KEYS).size).toBe(9);
    for (const key of FRAMING_KEYS) {
      const def = FRAMINGS[key];
      expect(def.label.length, `${key}: label present`).toBeGreaterThan(0);
      expect(def.provenance.length, `${key}: provenance never empty`).toBeGreaterThan(0);
      expect(def.padding, `${key}: padding positive`).toBeGreaterThan(0);
      expectValidBounds(def.bounds, key);
    }
  });

  test('the Hawaii framing fits the real Hawaii bounds (spike round 4 item 6)', () => {
    expect(FRAMINGS.hawaii.bounds).toEqual(REGIONS.hawaii.bounds);
  });

  test('RegionKey is not widened: framings live beside REGIONS, not inside it', () => {
    for (const key of FRAMING_KEYS) {
      if (key === 'hawaii') continue; // the one deliberate camera overlap
      expect(
        Object.keys(REGIONS),
        'framing keys stay out of the legacy REGIONS table'
      ).not.toContain(key);
    }
  });
});

test.describe('S1 hazard clusters (D-0.7.0-042/043/044)', () => {
  test('exactly the four ruled clusters with the ruled titles', () => {
    expect(HAZARD_CLUSTER_KEYS).toEqual(['drought', 'wildfire', 'heat', 'enso']);
    expect(HAZARD_CLUSTER_KEYS.map((k) => HAZARD_CLUSTERS[k].title)).toEqual([
      'Drought',
      'Wildfire',
      'Extreme Heat',
      'ENSO'
    ]);
    expect(CLUSTER_DISPLAY_NAMES.heat).toBe('Extreme Heat');
  });

  test('URL tokens are one word; drought is absence (D-0.7.0-044)', () => {
    expect(HAZARD_CLUSTERS.drought.urlToken).toBeNull();
    for (const key of ['wildfire', 'heat', 'enso'] as const) {
      const token = HAZARD_CLUSTERS[key].urlToken;
      expect(token, `${key}: token present`).not.toBeNull();
      expect(token, `${key}: one lowercase word`).toMatch(/^[a-z]+$/);
    }
  });

  test('every recipe names real layers with at most one surface per horizon', () => {
    for (const clusterKey of HAZARD_CLUSTER_KEYS) {
      const recipes = HAZARD_CLUSTERS[clusterKey].recipes;
      for (const horizon of TEMPORAL_HORIZON_KEYS) {
        const layers = recipes[horizon];
        for (const layerKey of layers) {
          expect(
            LAYER_KEYS.has(layerKey),
            `${clusterKey}/${horizon}: ${layerKey} exists in LAYER_DEFS`
          ).toBe(true);
        }
        const surfaces = layers.filter((k) => SURFACE_KEYS.has(k));
        expect(
          surfaces.length,
          `${clusterKey}/${horizon}: at most one surface (UX-1)`
        ).toBeLessThanOrEqual(1);
      }
    }
  });

  test('the current wildfire recipe is perimeters plus smoke only (D-0.7.0-043 part 1)', () => {
    const current = HAZARD_CLUSTERS.wildfire.recipes.current;
    expect([...current].sort()).toEqual(['hms-smoke', 'nifc-fires']);
    expect(current).not.toContain('usfs-whp');
  });

  test('ENSO v1 is the shipped SST anomaly surface at every horizon (D-0.7.0-042 honesty boundary)', () => {
    for (const horizon of TEMPORAL_HORIZON_KEYS) {
      expect(HAZARD_CLUSTERS.enso.recipes[horizon]).toEqual(['sst-anomaly']);
    }
  });
});

test.describe('S1 oceans (D-0.7.0-042/051/053)', () => {
  test('three schematic ocean zones with valid bounds and provenance', () => {
    expect(OCEAN_KEYS).toEqual(['pacific', 'arctic', 'atlantic']);
    for (const key of OCEAN_KEYS) {
      const def = OCEANS[key];
      expect(def.label.length, `${key}: label present`).toBeGreaterThan(0);
      expect(def.provenance, `${key}: honest schematic note`).toContain('Schematic');
      expectValidBounds(def.bounds, key);
    }
  });

  test('the Pacific framing contains the Nino 3.4 region (D-0.7.0-053)', () => {
    const [[south, west], [north, east]] = OCEANS.pacific.bounds;
    // Nino 3.4: 5S to 5N, 170W to 120W.
    expect(south).toBeLessThanOrEqual(-5);
    expect(north).toBeGreaterThanOrEqual(5);
    expect(west).toBeLessThanOrEqual(-170);
    expect(east).toBeGreaterThanOrEqual(-120);
  });
});

test.describe('S1 interaction ranks (D-0.7.0-041 part 2)', () => {
  test('eight unique kinds; smallest intentional subject first, condition surface last', () => {
    expect(INTERACTION_TARGET_RANKS).toHaveLength(8);
    expect(new Set(INTERACTION_TARGET_RANKS).size).toBe(8);
    expect(INTERACTION_TARGET_RANKS[0]).toBe('point-event');
    expect(INTERACTION_TARGET_RANKS[INTERACTION_TARGET_RANKS.length - 1]).toBe('condition-surface');
    // Sovereign geography outranks state outlines and the surface.
    expect(interactionRank('reservation-boundary')).toBeLessThan(interactionRank('state-boundary'));
    expect(interactionRank('tribal-lands')).toBeLessThan(interactionRank('state-boundary'));
    expect(interactionRank('state-boundary')).toBeLessThan(interactionRank('condition-surface'));
  });
});

test.describe('S1 typed-place store (D-0.7.0-035 ruling 2, D-0.7.0-046)', () => {
  test('set, get, subscribe, and clear round-trip; listener isolation holds', () => {
    expect(getTypedPlace()).toBeNull();

    const seen: Array<string | null> = [];
    const offThrowing = onTypedPlaceChange(() => {
      throw new Error('listener failure must not stop the others');
    });
    const off = onTypedPlaceChange((place) => {
      seen.push(place ? place.id : null);
    });

    setTypedPlace({ kind: 'state', id: 'WA', label: 'Washington' });
    expect(getTypedPlace()).toEqual({ kind: 'state', id: 'WA', label: 'Washington' });

    setTypedPlace(null);
    expect(getTypedPlace()).toBeNull();
    expect(seen).toEqual(['WA', null]);

    off();
    offThrowing();
    setTypedPlace({ kind: 'watershed', id: '17', label: 'Pacific Northwest (HUC 17)' });
    expect(seen).toEqual(['WA', null]);
    setTypedPlace(null);
  });
});
