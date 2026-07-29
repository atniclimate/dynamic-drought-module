import { test, expect } from '@playwright/test';

import {
  CAPABILITY_AXIS_KEYS,
  CAPABILITY_AXIS_LABELS,
  CAPABILITY_LEVEL_RANK,
  CAPABILITY_MATRIX,
  COVERAGE_FAMILY_KEYS,
  COVERAGE_FAMILY_LABELS
} from '../src/config/capability-matrix';
import { regionCapabilityLevel } from '../src/config/region-capability';
import { REGIONS, type RegionKey } from '../src/config/regions';
import type {
  CapabilityAxisKey,
  CapabilityLevel,
  CoverageFamilyKey
} from '../src/types/capability-matrix';

/**
 * T-P0-3: the coverage/capability matrix consistency spec. Pure Node
 * assertions in the s1-substrate pattern (the matrix has no visible surface
 * yet; the application has no runtime caller of it, though the T-M0-4 hook
 * `regionCapabilityLevel` now drives M-BREADTH disablement). The
 * doc-drift check lives in the gate (`npm run gate` runs check:coverage);
 * this spec pins the data's internal honesty rules so a future edit cannot
 * make the matrix claim more than the underlying capabilities support.
 * T-M0-4 adds the region-substrate section at the bottom (Region metadata
 * and the hook).
 */

const FAMILY_KEYS: readonly CoverageFamilyKey[] = [
  'pnw',
  'conus',
  'ak-hi',
  'canada',
  'transboundary'
];
const AXIS_KEYS: readonly CapabilityAxisKey[] = [
  'display',
  'selectablePlace',
  'droughtState',
  'landscapeSignature',
  'impactSynthesis'
];
const LEVELS: readonly CapabilityLevel[] = ['full', 'partial', 'none'];

test.describe('capability matrix structure (T-P0-3)', () => {
  test('exactly the five ratified families, in the ratified order', () => {
    expect(COVERAGE_FAMILY_KEYS).toEqual(FAMILY_KEYS);
  });

  test('exactly the five ratified axes, in the ratified order', () => {
    expect(CAPABILITY_AXIS_KEYS).toEqual(AXIS_KEYS);
  });

  test('every cell carries a valid level and a one-line, non-empty note', () => {
    for (const family of COVERAGE_FAMILY_KEYS) {
      const row = CAPABILITY_MATRIX[family];
      for (const axis of CAPABILITY_AXIS_KEYS) {
        const cell = row[axis];
        expect(LEVELS, `${family}.${axis}: level valid`).toContain(cell.level);
        expect(cell.note.trim().length, `${family}.${axis}: note non-empty`).toBeGreaterThan(0);
        expect(/[\r\n]/.test(cell.note), `${family}.${axis}: note is one line`).toBe(false);
        expect(cell.note, `${family}.${axis}: note carries no em dash`).not.toContain(String.fromCharCode(0x2014));
      }
    }
  });

  test('labels exist for every family and axis', () => {
    for (const family of COVERAGE_FAMILY_KEYS) {
      expect(COVERAGE_FAMILY_LABELS[family].length).toBeGreaterThan(0);
    }
    for (const axis of CAPABILITY_AXIS_KEYS) {
      expect(CAPABILITY_AXIS_LABELS[axis].length).toBeGreaterThan(0);
    }
  });

  test('the level ranking is the ratified none < partial < full', () => {
    expect(CAPABILITY_LEVEL_RANK.none).toBeLessThan(CAPABILITY_LEVEL_RANK.partial);
    expect(CAPABILITY_LEVEL_RANK.partial).toBeLessThan(CAPABILITY_LEVEL_RANK.full);
  });
});

test.describe('capability matrix consistency (T-P0-3 honesty rules)', () => {
  test('impactSynthesis never exceeds droughtState for any family', () => {
    for (const family of COVERAGE_FAMILY_KEYS) {
      const row = CAPABILITY_MATRIX[family];
      expect(
        CAPABILITY_LEVEL_RANK[row.impactSynthesis.level],
        `${family}: the briefing cannot claim more than the drought data supports`
      ).toBeLessThanOrEqual(CAPABILITY_LEVEL_RANK[row.droughtState.level]);
    }
  });

  test("no axis is 'full' anywhere display is 'none'", () => {
    for (const family of COVERAGE_FAMILY_KEYS) {
      const row = CAPABILITY_MATRIX[family];
      if (row.display.level !== 'none') continue;
      for (const axis of CAPABILITY_AXIS_KEYS) {
        expect(
          row[axis].level,
          `${family}.${axis}: nothing is fully supported where the map does not render`
        ).not.toBe('full');
      }
    }
  });
});

test.describe('capability matrix current truth (through U7 Canada)', () => {
  test('the load-bearing levels match the ratified work order', () => {
    const levels: Record<CoverageFamilyKey, Record<CapabilityAxisKey, CapabilityLevel>> = {
      pnw: {
        display: 'full',
        selectablePlace: 'full',
        droughtState: 'partial',
        landscapeSignature: 'none',
        impactSynthesis: 'partial'
      },
      conus: {
        display: 'full',
        selectablePlace: 'partial',
        droughtState: 'partial',
        landscapeSignature: 'none',
        impactSynthesis: 'none'
      },
      'ak-hi': {
        display: 'partial',
        selectablePlace: 'partial',
        droughtState: 'none',
        landscapeSignature: 'none',
        impactSynthesis: 'none'
      },
      canada: {
        display: 'partial',
        selectablePlace: 'none',
        droughtState: 'partial',
        landscapeSignature: 'none',
        impactSynthesis: 'none'
      },
      transboundary: {
        display: 'none',
        selectablePlace: 'none',
        droughtState: 'none',
        landscapeSignature: 'none',
        impactSynthesis: 'none'
      }
    };
    for (const family of COVERAGE_FAMILY_KEYS) {
      for (const axis of CAPABILITY_AXIS_KEYS) {
        expect(
          CAPABILITY_MATRIX[family][axis].level,
          `${family}.${axis}: matches the ratified current truth (update this pin deliberately when a capability really changes)`
        ).toBe(levels[family][axis]);
      }
    }
  });
});

test.describe('region capability substrate (T-M0-4, N4a)', () => {
  const REGION_KEYS = Object.keys(REGIONS) as RegionKey[];
  const PNW_FRAMINGS: RegionKey[] = [
    'washington_state',
    'columbia_snake_basin',
    'cascades',
    'central_oregon',
    'southwest_washington',
    'south_puget_sound'
  ];

  test('every region carries the substrate fields with valid values', () => {
    for (const key of REGION_KEYS) {
      const region = REGIONS[key];
      expect(['pnw', 'explore', 'canada'], `${key}: group valid`).toContain(region.group);
      expect(COVERAGE_FAMILY_KEYS, `${key}: coverage family valid`).toContain(
        region.coverageFamily
      );
      expect(region.sourceEditions.length, `${key}: at least one edition`).toBeGreaterThan(0);
      for (const edition of region.sourceEditions) {
        expect(['usdm', 'cdm', 'bc-basin'], `${key}: edition source valid`).toContain(edition.source);
        expect(['weekly', 'monthly', 'weekly-in-season'], `${key}: cadence valid`).toContain(edition.cadence);
        expect(['full', 'us-portion'], `${key}: scope valid`).toContain(edition.scope);
      }
      if (region.memberStates) {
        for (const state of region.memberStates) {
          expect(state, `${key}: USPS code shape`).toMatch(/^[A-Z]{2}$/);
        }
      }
    }
  });

  test('the ratified family mapping includes British Columbia in Canada', () => {
    for (const key of PNW_FRAMINGS) {
      expect(REGIONS[key].coverageFamily, `${key}: pnw family`).toBe('pnw');
      expect(REGIONS[key].group, `${key}: pnw group`).toBe('pnw');
    }
    expect(REGIONS.national.coverageFamily).toBe('conus');
    expect(REGIONS.alaska.coverageFamily).toBe('ak-hi');
    expect(REGIONS.hawaii.coverageFamily).toBe('ak-hi');
    for (const key of ['national', 'alaska', 'hawaii'] as RegionKey[]) {
      expect(REGIONS[key].group, `${key}: explore group`).toBe('explore');
    }
    expect(REGIONS.british_columbia.coverageFamily).toBe('canada');
    expect(REGIONS.british_columbia.group).toBe('canada');
  });

  test('the Alaska display note records the Aleutian fit without promoting analysis', () => {
    expect(CAPABILITY_MATRIX['ak-hi'].display.level).toBe('partial');
    expect(CAPABILITY_MATRIX['ak-hi'].display.note).toContain('Aleutian');
    expect(CAPABILITY_MATRIX['ak-hi'].impactSynthesis.level).toBe('none');
    expect(CAPABILITY_MATRIX['ak-hi'].landscapeSignature.level).toBe('none');
  });

  test('the Columbia and Snake basin and British Columbia keep their source editions separate', () => {
    expect(REGIONS.columbia_snake_basin.sourceEditions).toEqual([
      { source: 'usdm', cadence: 'weekly', scope: 'us-portion' }
    ]);
    // The basin's fuzzy state membership is deliberately NOT inferred.
    expect(REGIONS.columbia_snake_basin.memberStates).toBeUndefined();
    expect(REGIONS.british_columbia.sourceEditions).toEqual([
      {
        source: 'bc-basin',
        cadence: 'weekly-in-season',
        scope: 'full'
      }
    ]);
    for (const key of REGION_KEYS.filter((key) => key !== 'british_columbia')) {
      for (const edition of REGIONS[key].sourceEditions) {
        expect(edition.source, `${key}: existing United States edition remains unchanged`).toBe(
          'usdm'
        );
      }
    }
  });

  test('memberStates is populated exactly where enumerable without inference', () => {
    expect(REGIONS.washington_state.memberStates).toEqual(['WA']);
    expect(REGIONS.cascades.memberStates).toEqual(['WA']);
    expect(REGIONS.central_oregon.memberStates).toEqual(['OR']);
    expect(REGIONS.southwest_washington.memberStates).toEqual(['WA']);
    expect(REGIONS.south_puget_sound.memberStates).toEqual(['WA']);
    expect(REGIONS.alaska.memberStates).toEqual(['AK']);
    expect(REGIONS.hawaii.memberStates).toEqual(['HI']);
    // Omitted means "not enumerated here", never "no states".
    expect(REGIONS.national.memberStates).toBeUndefined();
  });

  test('regionCapabilityLevel reads the matrix row of every region family and axis', () => {
    for (const key of REGION_KEYS) {
      for (const axis of CAPABILITY_AXIS_KEYS) {
        expect(
          regionCapabilityLevel(key, axis),
          `${key}.${axis}: the hook returns the family cell`
        ).toBe(CAPABILITY_MATRIX[REGIONS[key].coverageFamily][axis].level);
      }
    }
    // Two concrete honesty reads (values pinned above): Alaska drought
    // state is 'none' even though upstream USDM covers Alaska (upstream
    // truth vs module capability), and the PNW briefing stays 'partial'.
    expect(regionCapabilityLevel('alaska', 'droughtState')).toBe('none');
    expect(regionCapabilityLevel('washington_state', 'impactSynthesis')).toBe('partial');
  });
});
