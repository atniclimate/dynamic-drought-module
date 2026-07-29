import { test, expect } from '@playwright/test';

import type { RegionKey } from '../src/config/regions';
import {
  regionCapabilityLevel,
  regionCapabilityNote
} from '../src/config/region-capability';
import { createBriefingSkeleton } from '../src/impact/briefing';
import {
  buildResources,
  resolveStateCode
} from '../src/impact/resources';
import type { BoundarySelectionContext } from '../src/impact/types';
import { gotoApp } from './helpers';

function selectionContext(
  regionKey: RegionKey | null,
  properties: Readonly<Record<string, unknown>> | null = null
): BoundarySelectionContext {
  return {
    kind: 'bia-reservation',
    title: 'Example place',
    properties,
    lngLat: { lng: -98, lat: 38 },
    regionKey
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
    const kansas = {
      ...selectionContext('national'),
      kind: 'state' as const,
      properties: { STUSPS: 'KS', NAME: 'Kansas' }
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

test('impactSynthesis none renders its matrix note and starts no briefing sources', async ({
  page
}) => {
  await gotoApp(page, '?region=national&layers=states&view=brief');
  expect(new URL(page.url()).searchParams.get('region')).toBe('national');

  await page.locator('#brief-search [data-ddm-search]').fill('kansas');
  await page
    .locator(
      '#brief-search [data-search-kind="place"][data-search-id="KS"]'
    )
    .click();
  await expect(page.locator('#brief-place-name')).toHaveText('Kansas');

  const briefingSourceRequests: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (
      url.includes('/data/enso-indices.json') ||
      url.includes('/USDM_current/FeatureServer/0/query') ||
      url.includes('/StateStatistics/GetDSCI') ||
      url.includes('/WFIGS_Interagency_Perimeters_Current/') ||
      url.startsWith('https://api.weather.gov/') ||
      url.includes('/cpc_610_outlk/') ||
      url.includes('/cpc_814_outlk/') ||
      url.includes('nwrfc.noaa.gov/water_supply/')
    ) {
      briefingSourceRequests.push(url);
    }
  });

  await page.locator('#brief-full-report-link').click();
  const panel = page.locator('#impact-panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.impact-capability-unavailable')).toContainText(
    'The briefing synthesis and resource routing are not validated outside the PNW.'
  );
  await page.waitForTimeout(500);
  expect(briefingSourceRequests).toEqual([]);
  await expect(panel.locator('.impact-resource-link')).toHaveCount(0);
});
