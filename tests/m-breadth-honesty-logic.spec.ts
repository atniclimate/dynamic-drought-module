// These tests came from m-breadth-honesty.spec.ts: none of them opens a page, so they run in the pure lane.
import { test, expect } from './offline-test';

import type { RegionKey } from '../src/config/regions';
import { placeRefFromBoundary } from '../src/config/entities';
import { postalCodeFromProperties } from '../src/config/geography';
import {
  regionCapabilityLevel,
  regionCapabilityNote
} from '../src/config/region-capability';
import { createBriefingSkeleton } from '../src/impact/briefing';
import {
  buildResources,
  isStateCode,
  resolveStateCode
} from '../src/impact/resources';
import type { BoundarySelectionContext } from '../src/impact/types';

/** Mirrors `containingFromProperties` (src/impact/context.ts): derived from
 * the literal's own properties only, never from `regionKey`. */
function containingFromProperties(
  properties: BoundarySelectionContext['properties']
): BoundarySelectionContext['containing'] {
  const code = postalCodeFromProperties(properties);
  return code !== null && isStateCode(code)
    ? { state: code, basis: 'feature-property' }
    : { state: null, basis: 'none' };
}

function selectionContext(
  regionKey: RegionKey | null,
  properties: Readonly<Record<string, unknown>> | null = null
): BoundarySelectionContext {
  return {
    kind: 'bia-reservation',
    title: 'Example place',
    properties,
    lngLat: { lng: -98, lat: 38 },
    regionKey,
    containing: containingFromProperties(properties),
    place: placeRefFromBoundary('bia-reservation', properties)
  };
}

function resourceUrls(context: BoundarySelectionContext): string[] {
  return buildResources(context)
    .map((resource) => resource.url)
    .filter((url): url is string => typeof url === 'string');
}

test.describe('M-BREADTH resource-routing honesty', () => {
  test('Canada and transboundary contexts do not fall through to Washington', () => {
    const canada = selectionContext('canada' as RegionKey);
    const transboundary = selectionContext('columbia_snake_basin');

    expect(resolveStateCode(canada)).toBeNull();
    expect(resolveStateCode(transboundary)).toBeNull();
    expect(resourceUrls(canada).join(' ')).not.toContain('/states/washington');
    expect(resourceUrls(transboundary).join(' ')).not.toContain('/states/washington');
  });

  test('the existing PNW route remains Washington-aware', () => {
    const washington = selectionContext('washington_state');
    expect(resolveStateCode(washington)).toBe('WA');
    expect(resourceUrls(washington)).toContain(
      'https://www.drought.gov/states/washington'
    );
  });

  test('an explicit state identity is not routed when the matrix lacks validation', () => {
    const kansasProperties = { STUSPS: 'KS', NAME: 'Kansas' };
    const kansas = {
      ...selectionContext('national'),
      kind: 'state' as const,
      properties: kansasProperties,
      containing: containingFromProperties(kansasProperties)
    };
    expect(resolveStateCode(kansas)).toBe('KS');
    expect(createBriefingSkeleton(kansas).resources).toEqual([]);
  });
});

for (const provenance of [
  { label: 'absent', regionKey: null },
  { label: 'unrecognized', regionKey: 'future-region' as RegionKey }
] as const) {
  test(`${provenance.label} provenance is unavailable through the runtime capability consumer`, () => {
    expect(
      regionCapabilityLevel(
        provenance.regionKey,
        'impactSynthesis'
      )
    ).toBe('none');
    expect(
      regionCapabilityNote(
        provenance.regionKey,
        'impactSynthesis'
      )
    ).toBe(
      'Drought impact analysis and resource routing are unavailable because this selection has no recognized coverage region.'
    );
    expect(
      createBriefingSkeleton(selectionContext(provenance.regionKey)).resources
    ).toEqual([]);
  });
}
