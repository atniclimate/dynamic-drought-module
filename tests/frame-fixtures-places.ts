/**
 * The place builders' frame fixtures (S30D D1 M24: state, deployer tribal,
 * BIA, AIANNH, Treaty, ecoregion), keyed by the manifest's builder id. Empty
 * until M24 migrates them; see tests/frame-fixtures.ts.
 */
import type { CensusFixture, TierFixture } from './frame-fixtures';

export const PLACE_CENSUS_FIXTURES: Readonly<Record<string, CensusFixture>> = {};

export const PLACE_TIER_FIXTURES: Readonly<Record<string, TierFixture>> = {};
