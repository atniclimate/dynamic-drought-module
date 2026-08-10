import { expect, test } from '@playwright/test';

import { HAZARD_CLUSTERS } from '../src/config/clusters';
import {
  MOBILE_HAZARD_PRESETS,
  VIEW_PRESETS
} from '../src/config/presets';
import { HMS_OVERVIEW_QUALIFICATION } from '../src/config/wildfire-presentation';

test.describe('Wildfire recent-scene configuration', () => {
  test('only explicit Wildfire and Fire choices prefer recent satellite', () => {
    expect(HAZARD_CLUSTERS.wildfire.preferredBasemap).toBe('satellite');
    expect(HAZARD_CLUSTERS.drought.preferredBasemap).toBeUndefined();
    expect(HAZARD_CLUSTERS.heat.preferredBasemap).toBeUndefined();
    expect(HAZARD_CLUSTERS.enso.preferredBasemap).toBeUndefined();

    const mobilePreferences = new Map(
      MOBILE_HAZARD_PRESETS.map((preset) => [preset.key, preset.preferredBasemap])
    );
    expect(mobilePreferences.get('hazard-fire')).toBe('satellite');
    expect(mobilePreferences.get('hazard-drought')).toBeUndefined();
    expect(mobilePreferences.get('hazard-heat')).toBeUndefined();

    const quickPreferences = new Map(
      VIEW_PRESETS.map((preset) => [preset.key, preset.preferredBasemap])
    );
    expect(quickPreferences.get('fire-risk')).toBe('satellite');
    for (const key of ['right-now', 'this-week', 'season-ahead', 'whose-land']) {
      expect(quickPreferences.get(key)).toBeUndefined();
    }
  });

  test('copy keeps GeoColor context separate from the HMS observation clock', () => {
    expect(HAZARD_CLUSTERS.wildfire.description).toContain(
      'Recent NOAA GOES GeoColor context'
    );
    expect(HAZARD_CLUSTERS.wildfire.description).toContain(
      'independently timed NOAA Hazard Mapping System (HMS) smoke plumes'
    );
    expect(HMS_OVERVIEW_QUALIFICATION).toContain(
      'independent of the recent NOAA GeoColor basemap frame'
    );
    expect(HMS_OVERVIEW_QUALIFICATION).toContain(
      'not ground-level air quality'
    );
  });
});
