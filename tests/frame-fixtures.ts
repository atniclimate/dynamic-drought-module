/**
 * The frame-fixture registry (S30D D1 M24 to M26; DDM-P11-T04). Each builder
 * batch that leaves LEGACY_ALLOWANCE (tests/identify-paths-manifest.ts) adds
 * its fixtures to its own module, so parallel batches never edit one hunk:
 * the places (M24), the surfaces (M25), the events and stations (M26). The
 * census in tests/identify-paths.spec.ts and the PF3 tier rows in
 * tests/popup-viewport.spec.ts dispatch through these two records, keyed by
 * the manifest's builder id.
 */
import type { Page } from '@playwright/test';
import { PLACE_CENSUS_FIXTURES, PLACE_TIER_FIXTURES } from './frame-fixtures-places';
import { SURFACE_CENSUS_FIXTURES, SURFACE_TIER_FIXTURES } from './frame-fixtures-surfaces';
import { FIRE_LABEL_CENSUS_FIXTURES, FIRE_LABEL_TIER_FIXTURES } from './frame-fixtures-fires-labels';

/**
 * The census spec's own helpers, handed to each fixture (a spec file exports
 * nothing, so a fixture module cannot import them).
 */
export interface CensusHelpers {
  /** Click the map centre until the audit has recorded the wanted entry ('map:<layerId>'). */
  clickCenterUntilSeen(page: Page, wanted: string): Promise<void>;
  /** The init-script observer's record: entries seen and violations found. */
  readAudit(page: Page): Promise<{ readonly seen: string[]; readonly violations: string[] }>;
}

/**
 * Boots its builder's layer, clicks until the audit has seen the builder's
 * response, and asserts window.__ddmFrameCheck on it (four non-empty head
 * slots plus a link-bearing head source or the body's stated reason; the
 * frame root owns the displayed content) and no audit violation.
 * The observer is already installed as an init script when it runs.
 */
export type CensusFixture = (page: Page, h: CensusHelpers) => Promise<void>;

/** The PF3 tier promises for one migrated builder (D1 M23 PF3). */
export interface TierFixture {
  /** At the FULL and usable-COMPACT boundaries the primary source and the last note stay hit-test reachable. */
  sourcesAtTierBoundaries(page: Page): Promise<void>;
  /** At 1280x720 to 2560x1440 the head shows unscrolled, only the body scrolls, the close control is reachable; the panel half. */
  longHeadAndPanel(page: Page): Promise<void>;
}

export const CENSUS_FIXTURES: Readonly<Record<string, CensusFixture>> = {
  ...PLACE_CENSUS_FIXTURES,
  ...SURFACE_CENSUS_FIXTURES,
  ...FIRE_LABEL_CENSUS_FIXTURES
};

export const TIER_FIXTURES: Readonly<Record<string, TierFixture>> = {
  ...PLACE_TIER_FIXTURES,
  ...SURFACE_TIER_FIXTURES,
  ...FIRE_LABEL_TIER_FIXTURES
};
