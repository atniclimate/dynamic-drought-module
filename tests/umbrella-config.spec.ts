import { test, expect } from '@playwright/test';
import { LAYER_GROUPS, TRIBAL_NATIONS_GROUP } from '../src/config/layer-groups';
import { LAYER_DEFS } from '../src/config/layers';

/**
 * Config-level invariants for the layer groups (Unit F; the Codex front-end
 * consultation risk 5). Pure node-side assertions over the config tables:
 * no browser, no network.
 */
test.describe('layer-group config invariants', () => {
  test('every group member exists exactly once with the reference role', () => {
    for (const group of LAYER_GROUPS) {
      const seen = new Set<string>();
      for (const key of group.members) {
        expect(seen.has(key), `duplicate member "${key}" in ${group.key}`).toBe(false);
        seen.add(key);
        const def = LAYER_DEFS.find((d) => d.key === key);
        expect(def, `member "${key}" of ${group.key} must exist in LAYER_DEFS`).toBeTruthy();
        expect(def!.role, `member "${key}" must be a reference layer`).toBe('reference');
      }
    }
  });

  test('no layer belongs to more than one group', () => {
    const owned = new Set<string>();
    for (const group of LAYER_GROUPS) {
      for (const key of group.members) {
        expect(owned.has(key), `layer "${key}" appears in two groups`).toBe(false);
        owned.add(key);
      }
    }
  });

  test('the group and button action set are exactly the two present-day members, never a deployer slot', () => {
    const group = TRIBAL_NATIONS_GROUP;
    expect([...group.members]).toEqual(['aiannh', 'bia-reservations']);
    expect([...group.buttonActivates]).toEqual(['aiannh', 'bia-reservations']);
    for (const key of group.buttonActivates) {
      expect(group.members.includes(key), `action key "${key}" must be a member`).toBe(true);
    }
    expect(group.buttonActivates.includes('tribal')).toBe(false);
    expect(group.buttonActivates.includes('treaty')).toBe(false);
  });
});
