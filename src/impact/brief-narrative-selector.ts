import type { HazardKey, ImpactBriefing, SourcedClaim } from './types';

import { POINT_HEAT_HAZARD } from './horizon-chrome';
import {
  formatDistanceKm,
  formatPointHeatInterval,
  formatPointHeatTimestamp,
  formatPointHeatValue
} from './point-heat-format';

function firstText(claims: readonly SourcedClaim[] | undefined): string | null {
  const text = claims?.[0]?.text.trim();
  return text ? text : null;
}

function pointHeatLine(briefing: ImpactBriefing): string | null {
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
      // DRAFT wording (pending the owner's read-back): the distance clause, in heat-synthesis.ts's own words.
      const distance =
        observation.distanceKm === undefined
          ? ''
          : `, ${formatDistanceKm(observation.distanceKm)} from the selected point,`;
      return `Heat at the selected point: ${station}${distance} reports ${values.join(', ')}${observation.timestamp ? ` at ${formatPointHeatTimestamp(observation.timestamp)}` : ''}.`;
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
  return null;
}

/**
 * Select the critical-first at-hand line used by the mobile sheet and Place
 * Studio. In the point-heat row's mode, or with no mode given, a live point
 * observation leads, then current or future grid guidance, then the mode's own
 * current claim, then the existing current claim. In any other mode the mode's own current claim leads
 * (DESIGN B3, B6), then the same order.
 */
export function selectBriefNarrativeLine(
  briefing: ImpactBriefing,
  hazard?: HazardKey
): string | null {
  const own =
    hazard === undefined
      ? null
      : firstText(briefing.horizons.current.cells[hazard].claims);
  // In the point-heat mode the point read leads; the mode's own cell still precedes the flat list.
  return hazard === POINT_HEAT_HAZARD
    ? pointHeatLine(briefing) ?? own ?? firstText(briefing.horizons.current.claims)
    : own ?? pointHeatLine(briefing) ?? firstText(briefing.horizons.current.claims);
}
