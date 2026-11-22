// The exact-resolution cases of landscape-consumer.spec.ts, moved here because they open no page and so run in the pure lane.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test } from './offline-test';

import { placeRefFromBoundary } from '../src/config/entities';
import { postalCodeFromProperties } from '../src/config/geography';
import { resolveLandscapeContext } from '../src/impact/landscape-consumer';
import { loadLandscapeSignatureAtUrl } from '../src/impact/landscape';
import {
  resolveLandscapeSelection,
  selectedLandscapeEcoregion,
  UNSUPPORTED_LANDSCAPE_SELECTION_NOTE
} from '../src/impact/landscape-resolution';
import type { BoundarySelectionContext } from '../src/impact/types';
import { isStateCode } from '../src/impact/resources';

const ARTIFACT = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        '../public/data/landscape-signature-pnw.json',
        import.meta.url
      )
    ),
    'utf8'
  )
) as unknown;

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

function context(
  kind: BoundarySelectionContext['kind'],
  properties: BoundarySelectionContext['properties']
): BoundarySelectionContext {
  return {
    kind,
    title: 'Selected place',
    properties,
    lngLat: { lng: -122, lat: 46 },
    regionKey: 'washington_state',
    containing: containingFromProperties(properties),
    place: placeRefFromBoundary(kind, properties)
  };
}

function loadFixture(
  opts?: Parameters<typeof loadLandscapeSignatureAtUrl>[1]
) {
  return loadLandscapeSignatureAtUrl('https://example.invalid/landscape.json', {
    ...opts,
    fetchJsonImpl: async () => ARTIFACT
  });
}

test.describe('T3-2 exact selected-place resolution', () => {
  test('resolves exact Level IV and Level III issuer codes only', () => {
    expect(
      selectedLandscapeEcoregion(
        context('ecoregion', {
          US_L3CODE: '4',
          US_L4CODE: '4a'
        })
      )
    ).toEqual({ level: 4, code: '4a' });
    expect(
      selectedLandscapeEcoregion(
        context('ecoregion', { US_L3CODE: '4' })
      )
    ).toEqual({ level: 3, code: '4' });
    expect(
      selectedLandscapeEcoregion(context('state', { STUSPS: 'WA' }))
    ).toBeNull();
    expect(
      selectedLandscapeEcoregion(context('bia-reservation', { LARID: '1' }))
    ).toBeNull();
    expect(
      selectedLandscapeEcoregion(context('watershed', { huc4: '1703' }))
    ).toBeNull();
    expect(resolveLandscapeSelection(context('state', { STUSPS: 'WA' }))).toEqual({
      ok: false,
      note: UNSUPPORTED_LANDSCAPE_SELECTION_NOTE
    });
  });

  test('pins the shipped Western Cascades Level IV fields and provenance', async () => {
    const result = await resolveLandscapeContext(
      { level: 4, code: '4a' },
      { load: loadFixture }
    );

    expect(result.status).toBe('ready');
    expect(result.ecoregion).toEqual({
      level: 4,
      code: '4a',
      name: 'Western Cascades Lowlands and Valleys'
    });
    expect(result.artifactDate).toBe('2026-07-24');
    expect(result.support).toContain(
      'summarizes the full EPA Omernik Level IV ecoregion'
    );
    expect(result.support).toContain('not current conditions or a point reading');
    expect(result.facts).toEqual([
      {
        key: 'terrain',
        label: 'Terrain',
        text:
          'Mean elevation is 641 m (3 to 1,551 m). Mean slope is 17.0 degrees. Terrain coverage is 100.0%.'
      },
      {
        key: 'soil',
        label: 'Soil water storage',
        text:
          'Root-zone available water storage is 200 mm; the within-ecoregion 10th to 90th percentile is 113 to 285 mm. Estimated root-zone depth is 132 cm. Dominant surface texture is Loam. Soil coverage is 97.9%.'
      },
      {
        key: 'landcover',
        label: 'Land cover',
        text:
          'Forest 67.0%; cropland 1.5%; wetland 0.3%; open water 1.0%. Land-cover coverage is 100.0%.'
      },
      {
        key: 'fuels',
        label: 'Surface fuels and long-term hazard potential',
        text:
          'The largest modeled surface-fuel share is timber litter model 5 (TL5; issuer code 185), at 48.1%. Wildfire Hazard Potential shares are Very Low 3.9%, Low 11.7%, Moderate 72.6%, High 7.6%, Very High 1.6%, non-burnable 1.4%, and water 1.2%. WHP coverage is 100.0%.',
        note:
          'Wildfire Hazard Potential is 270 m static landscape context, not a current condition or risk reading.'
      }
    ]);
    expect(result.sources.map((source) => source.key)).toEqual([
      'terrain',
      'soilMukey',
      'soilSda',
      'landcoverNlcd',
      'fuelsFbfm40',
      'hazardWhp'
    ]);
    expect(result.sources.every((source) => source.vintage.length > 0)).toBe(
      true
    );
  });

  test('reports honest absence for an unbundled ecoregion', async () => {
    const unbundled = await resolveLandscapeContext(
      { level: 4, code: 'not-shipped' },
      { load: loadFixture }
    );
    expect(unbundled.status).toBe('unavailable');
    expect(unbundled.note).toContain(
      'No valid Level IV landscape-signature bundle is available'
    );
  });
});
