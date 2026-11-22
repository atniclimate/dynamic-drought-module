// Page-free tests moved from provenance.spec.ts: they never open a page, so they run in the pure lane.
import { test, expect } from './offline-test';
import { caveatFor } from '../src/impact/context';
import { buildTribeCatalogEntries } from '../src/config/place-catalog';

test.describe('DDM-P2-T10: the place catalog gates a formal Nation name the same way search does (DR-094)', () => {
  // WORDING (DR-094): grepping src/ui/island/place-studio.tsx and
  // src/config/place-catalog.ts (this task's owned files) for a string
  // naming the Nation-to-polygon relation found none of their OWN making;
  // the one place-studio.tsx surface that names it (the Tribal overlap
  // row's caveat, `TRIBAL_OVERLAP_CAVEAT`) already reads it from
  // `caveatFor('bia-reservation')` (src/impact/context.ts, not owned by
  // this task), which already says "representation". This pins that
  // inherited wording so a future change to either file cannot drop it
  // silently.
  test('the studio\'s tribal overlap caveat calls the polygon a representation', () => {
    expect(caveatFor('bia-reservation')).toContain('representation');
  });
});

/**
 * DDM-P2-T12 (browser-free): `buildTribeCatalogEntries` is the pure loop
 * body of `loadTribeEntries` (src/config/place-catalog.ts), driven here with
 * hand-built roster and crosswalk rows and no `page` or browser fixture.
 * Playwright creates no browser context for a test that never destructures
 * one (the same reason the page-less case above needs none).
 */
test.describe('DDM-P2-T12: loadTribeEntries tests provenance directly and labels with the gated name', () => {
  test('an untrusted row whose displayName equals its larName is listed under its land-area name', () => {
    const larName = 'DDM-P2-T12 Pure Untrusted Fixture Area';
    const crosswalkTribe = 'DDM-P2-T12 Pure Untrusted Fixture Crosswalk Tribe Name';
    const entries = buildTribeCatalogEntries(
      [{ larName, displayName: larName, provenance: 'unverified' }],
      {
        meta: { rosterSource: 'Fixture roster', landAreaSource: 'Fixture land areas' },
        matched: [{ tribe: crosswalkTribe, larName }],
        rosterNoLar: []
      }
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe(larName);
    expect(entries.some((entry) => entry.label === crosswalkTribe)).toBe(false);
  });

  test("a trusted row whose crosswalk tribe differs from its roster displayName is listed under the roster's name", () => {
    const larName = 'DDM-P2-T12 Pure Trusted Fixture Area';
    const displayName = 'DDM-P2-T12 Pure Trusted Fixture Roster Display Name';
    const crosswalkTribe = 'DDM-P2-T12 Pure Trusted Fixture Different Crosswalk Tribe Name';
    const entries = buildTribeCatalogEntries(
      [{ larName, displayName, provenance: 'bia-authoritative' }],
      {
        meta: { rosterSource: 'Fixture roster', landAreaSource: 'Fixture land areas' },
        matched: [{ tribe: crosswalkTribe, larName }],
        rosterNoLar: []
      }
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe(displayName);
    expect(entries.some((entry) => entry.label === crosswalkTribe)).toBe(false);
    // The crosswalk's own tribe string appears in no label at all.
    expect(entries.map((entry) => entry.label)).not.toContain(crosswalkTribe);
  });
});
