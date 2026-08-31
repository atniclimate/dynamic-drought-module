import type { ImpactBriefing } from './types';

import {
  formatPointHeatInterval,
  formatPointHeatTimestamp,
  formatPointHeatValue
} from './point-heat-format';

/**
 * Select the critical-first at-hand line used by the mobile sheet and Place
 * Studio. A live point observation leads, then current or future grid
 * guidance, then the existing current drought claim.
 */
export function selectBriefNarrativeLine(
  briefing: ImpactBriefing
): string | null {
  const observation = briefing.pointHeat.observation;
  if (observation.status === 'ready') {
    const temperature = observation.metrics.find(
      (metric) => metric.key === 'temperature'
    )?.values[0];
    const heatIndex = observation.metrics.find(
      (metric) => metric.key === 'heatIndex'
    )?.values[0];
    const values = [
      temperature
        ? `temperature ${formatPointHeatValue(temperature.value, temperature.unitCode)}`
        : null,
      heatIndex
        ? `heat index ${formatPointHeatValue(heatIndex.value, heatIndex.unitCode)}`
        : null
    ].filter((value): value is string => value !== null);
    if (values.length > 0) {
      const station =
        observation.stationName ??
        observation.stationId ??
        'the nearest NWS station';
      return `Heat at the selected point: ${station} reports ${values.join(', ')}${observation.timestamp ? ` at ${formatPointHeatTimestamp(observation.timestamp)}` : ''}.`;
    }
  }

  if (briefing.pointHeat.grid.status === 'ready') {
    const metric =
      briefing.pointHeat.grid.metrics.find(
        (candidate) => candidate.key === 'heatIndex'
      ) ??
      briefing.pointHeat.grid.metrics.find(
        (candidate) => candidate.key === 'apparentTemperature'
      ) ??
      briefing.pointHeat.grid.metrics.find(
        (candidate) => candidate.key === 'maxTemperature'
      ) ??
      briefing.pointHeat.grid.metrics[0];
    const value = metric?.values[0];
    if (metric && value) {
      return `Heat at the selected point: NWS grid ${metric.label.toLowerCase()} ${formatPointHeatValue(value.value, value.unitCode)}, valid ${formatPointHeatInterval(value.startTime, value.endTime)}.`;
    }
  }

  const text = briefing.horizons.current.claims[0]?.text.trim();
  return text ? text : null;
}
