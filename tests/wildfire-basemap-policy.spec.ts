import { expect, test } from './offline-test';

import { HAZARD_CLUSTERS } from '../src/config/clusters';
import { HMS_OVERVIEW_QUALIFICATION } from '../src/config/wildfire-presentation';

test.describe('Wildfire HMS copy', () => {
  test('copy keeps the HMS observation clock stated on its own', () => {
    expect(HAZARD_CLUSTERS.wildfire.description).toContain(
      'independently timed NOAA Hazard Mapping System (HMS) smoke plumes'
    );
    expect(HMS_OVERVIEW_QUALIFICATION).toContain(
      'not ground-level air quality'
    );
  });
});
