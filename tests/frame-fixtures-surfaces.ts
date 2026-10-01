/**
 * The surface builders' frame fixtures (S30D D1 M25: USDM, USDM change, NADM,
 * CDM, CPC outlook, HMS; the held BC builder has none while DR-160 holds),
 * keyed by the manifest's builder id. Empty until M25 migrates them; see
 * tests/frame-fixtures.ts.
 */
import type { CensusFixture, TierFixture } from './frame-fixtures';

export const SURFACE_CENSUS_FIXTURES: Readonly<Record<string, CensusFixture>> = {};

export const SURFACE_TIER_FIXTURES: Readonly<Record<string, TierFixture>> = {};
