// Page-free tests moved from tests/m-breadth-heatrisk-days.spec.ts so they run in the pure lane (npm run verify:pure).

import { expect, test } from './offline-test';

import { HAZARD_CLUSTERS } from '../src/config/clusters';
import { MOBILE_HAZARD_PRESETS } from '../src/config/presets';

test.describe('U-HEATRISK-DAYS multi-day read', () => {
  test('HeatRisk preset and cluster descriptions state published dated impact levels', () => {
    const presetDescriptions = MOBILE_HAZARD_PRESETS
      .filter((preset) => preset.layers.includes('heatrisk'))
      .map((preset) => preset.description);
    const descriptions = [
      ...presetDescriptions,
      HAZARD_CLUSTERS.heat.description
    ];

    expect(presetDescriptions).toHaveLength(1);
    expect(descriptions).toHaveLength(2);
    for (const description of descriptions) {
      expect(description).toMatch(
        /published National Weather Service HeatRisk heat-impact levels/i
      );
      expect(description).not.toMatch(/\b(?:forecast|today)\b/i);
    }
  });
});
