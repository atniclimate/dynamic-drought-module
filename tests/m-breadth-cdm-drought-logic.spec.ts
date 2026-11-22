// Page-free tests moved from tests/m-breadth-cdm-drought.spec.ts so they run in the pure lane (npm run verify:pure).

import { expect, test } from './offline-test';
import { readFileSync, statSync } from 'node:fs';

const ARTIFACT_PATH = 'public/data/cdm-drought-areas.json';
const LICENSE_TITLE = 'Open Government Licence - Canada';
const LICENSE_URL =
  'https://open.canada.ca/en/open-government-licence-canada';

function componentCountsByClass(collection: {
  features: readonly {
    properties: { dm: number };
    geometry: { type: string; coordinates: readonly unknown[] };
  }[];
}) {
  const counts: Record<string, number> = {
    D0: 0,
    D1: 0,
    D2: 0,
    D3: 0,
    D4: 0
  };
  for (const feature of collection.features) {
    const code = `D${feature.properties.dm}`;
    counts[code] =
      (counts[code] ?? 0) +
      (feature.geometry.type === 'Polygon'
        ? 1
        : feature.geometry.coordinates.length);
  }
  return counts;
}

test.describe('Canadian Drought Monitor committed monthly snapshot', () => {
  test('committed artifact records publication, class occupancy, provenance, and stewardship', () => {
    const artifact = JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8'));
    expect(statSync(ARTIFACT_PATH).size).toBeLessThanOrEqual(2_450_000);
    expect(artifact.schemaVersion).toBe(1);
    expect(artifact.product).toBe('Canadian Drought Monitor');
    expect(artifact.month).toBe('2026-10');
    expect(artifact.monthState).toBe('published');
    expect(artifact.license.title).toBe(LICENSE_TITLE);
    expect(artifact.license.url).toBe(LICENSE_URL);
    expect(artifact.provenance.sourceUrl).toBe(
      'https://agriculture.canada.ca/atlas/data_donnees/canadianDroughtMonitor/data_donnees/geoJSON/areasofDrought/2026/cdm_2610_drought_areas_json.zip'
    );
    expect(artifact.provenance.retrieved).toBe('2026-11-13');
    expect(artifact.provenance.archiveBytes).toBe(7_802_370);
    expect(artifact.provenance.classesPresent).toEqual([
      'D0',
      'D1',
      'D2',
      'D3'
    ]);
    expect(artifact.provenance.classesAbsent).toEqual(['D4']);
    expect(artifact.classes.find((entry: { class: string }) => entry.class === 'D4'))
      .toMatchObject({
        state: 'absent-no-occupied-area',
        featureCount: 0,
        componentCount: 0
      });
    expect(artifact.provenance.stewardshipCheck.result).toBe(
      'PASS: no First Nations, Metis, Métis, Inuit, reserve, or Treaty terms found in 4 archive member names or decoded contents.'
    );
    expect(artifact.provenance.componentPreservation).toBe(
      'PASS: shipped component count equals source component count for every class.'
    );
    const expectedComponentCounts = {
      D0: 1837,
      D1: 1237,
      D2: 614,
      D3: 347,
      D4: 0
    };
    expect(
      Object.fromEntries(
        artifact.classes.map(
          (entry: { class: string; componentCount: number }) => [
            entry.class,
            entry.componentCount
          ]
        )
      )
    ).toEqual(expectedComponentCounts);
    expect(componentCountsByClass(artifact.data)).toEqual(
      expectedComponentCounts
    );
    expect(
      artifact.data.features.every(
        (feature: { properties: Record<string, unknown> }) =>
          Object.keys(feature.properties).join(',') === 'dm'
      )
    ).toBe(true);
    expect(artifact.bounds[0]).toBeGreaterThanOrEqual(-180);
    expect(artifact.bounds[1]).toBeGreaterThanOrEqual(-90);
    expect(artifact.bounds[2]).toBeLessThanOrEqual(180);
    expect(artifact.bounds[3]).toBeLessThanOrEqual(90);
  });
});
