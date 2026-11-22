// Page-free tests moved from tests/s2-url-migration.spec.ts so they run in the pure lane (npm run verify:pure).

import { test, expect } from './offline-test';
import { DEFAULT_ON } from './helpers';
import { FRAMING_KEYS } from '../src/config/framings';
import { HAZARD_CLUSTER_KEYS, HAZARD_CLUSTERS } from '../src/config/clusters';
import { OCEAN_KEYS } from '../src/config/oceans';
import { LAYER_DEFS, type LayerKey } from '../src/config/layers';
import { parseFramingParam } from '../src/state/framing-store';
import { parseClusterParam, parseOceanParam } from '../src/state/cluster-store';
// The boot composition moved to the S3 cluster service (the S2 interim
// mechanics retired per the 2026-07-24 conductor amendment); the pinned
// assertions below are unchanged.
import { composeClusterIntent, keyForGeography } from '../src/state/cluster-service';
import { parseShellParams } from '../src/state/url';
import { deriveViewMode } from '../src/state/view-mode';

const SURFACE_KEYS = new Set(
  LAYER_DEFS.filter((def) => def.role === 'surface').map((def) => def.key)
);

// ---------------------------------------------------------------------------
// Node: the parse grammar
// ---------------------------------------------------------------------------

test.describe('S2 parse grammar (Node)', () => {
  test('framing= accepts the nine shape keys plus the explicit ALL camera', () => {
    for (const key of FRAMING_KEYS) {
      expect(parseFramingParam(key)).toBe(key);
    }
    expect(parseFramingParam('all')).toBe('all');
    expect(parseFramingParam(null)).toBeNull();
    expect(parseFramingParam('')).toBeNull();
    expect(parseFramingParam('national')).toBeNull();
    expect(parseFramingParam('MEXICO')).toBeNull();
    expect(parseFramingParam('atlantis')).toBeNull();
  });

  test('cluster= accepts the three ruled tokens; drought is absence (D-0.7.0-044)', () => {
    expect(parseClusterParam('wildfire')).toBe('wildfire');
    expect(parseClusterParam('heat')).toBe('heat');
    expect(parseClusterParam('enso')).toBe('enso');
    // Drought has NO token: even spelled out it reads as the default
    // (absence is the truth) and is dropped on the next canonical write.
    expect(parseClusterParam('drought')).toBe('drought');
    expect(parseClusterParam(null)).toBe('drought');
    expect(parseClusterParam('')).toBe('drought');
    expect(parseClusterParam('smoke')).toBe('drought');
  });

  test('ocean= accepts the three OceanKey tokens; everything else is null', () => {
    for (const key of OCEAN_KEYS) {
      expect(parseOceanParam(key)).toBe(key);
    }
    expect(parseOceanParam(null)).toBeNull();
    expect(parseOceanParam('')).toBeNull();
    expect(parseOceanParam('indian')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Node: the precedence table
// ---------------------------------------------------------------------------

test.describe('S2 precedence table (Node)', () => {
  test('layers= outranks cluster=: the cluster parses to absence when both appear (D-0.7.0-044)', () => {
    const both = parseShellParams(new URLSearchParams('?layers=usdm&cluster=wildfire'));
    expect(both.cluster).toBe('drought');

    // Even an explicit-empty layers= is the more specific intent.
    const explicitEmpty = parseShellParams(new URLSearchParams('?layers=&cluster=heat'));
    expect(explicitEmpty.cluster).toBe('drought');

    // Alone, the cluster survives.
    const alone = parseShellParams(new URLSearchParams('?cluster=wildfire'));
    expect(alone.cluster).toBe('wildfire');
  });

  test('ocean= is valid only beside a SURVIVING cluster=enso (D-0.7.0-042/053)', () => {
    // The happy pair.
    const enso = parseShellParams(new URLSearchParams('?cluster=enso&ocean=pacific'));
    expect(enso.cluster).toBe('enso');
    expect(enso.ocean).toBe('pacific');

    // No cluster: the ocean is ignored.
    expect(parseShellParams(new URLSearchParams('?ocean=pacific')).ocean).toBeNull();

    // A hazard cluster: still ignored.
    expect(
      parseShellParams(new URLSearchParams('?cluster=wildfire&ocean=arctic')).ocean
    ).toBeNull();

    // The cluster was outranked by layers=, so the ocean falls with it.
    const outranked = parseShellParams(
      new URLSearchParams('?cluster=enso&ocean=pacific&layers=usdm')
    );
    expect(outranked.cluster).toBe('drought');
    expect(outranked.ocean).toBeNull();
  });

  test('framing= is independent of the display parameters', () => {
    const p = parseShellParams(
      new URLSearchParams('?framing=mexico&layers=usdm&cluster=wildfire')
    );
    expect(p.framing).toBe('mexico');
    expect(p.cluster).toBe('drought');
  });

  test('region=national is the ALL alias: it never produces a framing (D-0.7.0-039/041)', () => {
    // The legacy value stays on the region path (honored forever; the
    // browser half below pins its camera landing) and normalizes to the
    // ALL framing state simply by never producing a framing token.
    expect(parseShellParams(new URLSearchParams('?region=national')).framing).toBeNull();
    expect(parseFramingParam('national')).toBeNull();
  });

  test('view derivation: only view=console opens the full-site console; embeds keep the display-link rule', () => {
    // A full-site display link opens Brief (owner, 2026-10-19).
    expect(deriveViewMode(new URLSearchParams('?cluster=wildfire'))).toBe('brief');
    expect(deriveViewMode(new URLSearchParams('?cluster=enso&ocean=pacific'))).toBe('brief');
    expect(deriveViewMode(new URLSearchParams('?framing=arid-west'))).toBe('brief');
    expect(deriveViewMode(new URLSearchParams('?region=washington_state&layers=states'))).toBe(
      'brief'
    );
    expect(deriveViewMode(new URLSearchParams('?select=state:WA&cluster=wildfire'))).toBe(
      'brief'
    );
    // An explicit view= wins over everything.
    expect(deriveViewMode(new URLSearchParams('?view=console&cluster=heat'))).toBe('console');
    expect(deriveViewMode(new URLSearchParams('?view=brief&cluster=heat'))).toBe('brief');
    expect(deriveViewMode(new URLSearchParams(''))).toBe('brief');
    // An embed naming a display parameter without select= keeps the console.
    expect(deriveViewMode(new URLSearchParams('?embed=true&layers=usdm'))).toBe('console');
    expect(deriveViewMode(new URLSearchParams('?embed=1&cluster=wildfire'))).toBe('console');
    expect(deriveViewMode(new URLSearchParams('?embed=true&select=state:WA&layers=states'))).toBe(
      'brief'
    );
    expect(deriveViewMode(new URLSearchParams('?embed=true'))).toBe('brief');
  });
});

// ---------------------------------------------------------------------------
// Node: the cluster boot composition
// ---------------------------------------------------------------------------

test.describe('S2 cluster boot composition (Node)', () => {
  test('drought composes back to exactly the default-on set (absence is the default display)', () => {
    expect([...composeClusterIntent('drought')].sort()).toEqual([...DEFAULT_ON].sort());
  });

  test('a hazard cluster is the untouched reference set plus its current recipe, one surface at most', () => {
    const reference = DEFAULT_ON.filter((key) => !SURFACE_KEYS.has(key));
    for (const cluster of HAZARD_CLUSTER_KEYS) {
      const composed = composeClusterIntent(cluster);
      // The default-on reference set is left alone (D-0.7.0-044).
      for (const key of reference) {
        expect(composed, `${cluster}: reference ${key} survives`).toContain(key);
      }
      // Every current-recipe member is applied: the recipe's own surface, or
      // its stand-in in the committed United States geography (DR-270).
      for (const recipeKey of HAZARD_CLUSTERS[cluster].recipes.current) {
        const key = keyForGeography(cluster, recipeKey);
        expect(composed, `${cluster}: recipe ${key} applied`).toContain(key);
      }
      // The one-surface invariant (UX-1) holds by construction. Cast: every
      // member `composeClusterIntent` pushes comes from a LayerDef's own
      // `key` (a LayerKey), but the function's own return type is the wider
      // `readonly string[]` (src/state/cluster-service.ts:146); a src typing
      // gap, worked around here rather than widened.
      const surfaces = composed.filter((key) => SURFACE_KEYS.has(key as LayerKey));
      expect(surfaces.length, `${cluster}: at most one surface`).toBeLessThanOrEqual(1);
      // No duplicates.
      expect(new Set(composed).size).toBe(composed.length);
    }
    // The drought default surface never rides a hazard cluster.
    expect(composeClusterIntent('wildfire')).not.toContain('usdm');
    expect(composeClusterIntent('enso')).toContain('sst-anomaly');
  });
});
