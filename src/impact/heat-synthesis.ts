import type { SourceResult } from './sources';
import type {
  HeatSourceRead,
  HeatSynthesis,
  PointHeatBriefing,
  PointHeatMetricSeries
} from './types';

function unitLabel(unitCode: string): string {
  const unit = unitCode.split(':').at(-1);
  if (unit === 'degC') return '°C';
  if (unit === 'degF') return '°F';
  if (unit === 'percent') return '%';
  return unit ?? unitCode;
}

function firstValue(
  metrics: readonly PointHeatMetricSeries[],
  key: PointHeatMetricSeries['key']
): string | null {
  const metric = metrics.find((candidate) => candidate.key === key);
  const value = metric?.values[0];
  return value
    ? `${metric.label} ${value.value} ${unitLabel(value.unitCode)} (${value.unitCode})`
    : null;
}

function pointHeatRead(pointHeat: PointHeatBriefing): HeatSourceRead | null {
  if (pointHeat.status !== 'ready' && pointHeat.status !== 'degraded') {
    return null;
  }
  const parts: string[] = [];
  const observation = pointHeat.observation;
  if (observation.status === 'ready') {
    const values = [
      firstValue(observation.metrics, 'temperature'),
      firstValue(observation.metrics, 'relativeHumidity'),
      firstValue(observation.metrics, 'heatIndex')
    ].filter((value): value is string => value !== null);
    const station =
      observation.stationName ??
      observation.stationId ??
      'the nearest NWS station';
    const distance =
      observation.distanceKm === undefined
        ? ''
        : `, ${observation.distanceKm.toFixed(1)} km from the selected point`;
    const timestamp = observation.timestamp
      ? ` at ${observation.timestamp}`
      : '';
    parts.push(
      `Nearby observation from ${station}${distance}: ${values.join(', ')}${timestamp}.`
    );
  }
  if (pointHeat.grid.status === 'ready') {
    const preferred =
      firstValue(pointHeat.grid.metrics, 'heatIndex') ??
      firstValue(pointHeat.grid.metrics, 'apparentTemperature') ??
      firstValue(pointHeat.grid.metrics, 'maxTemperature') ??
      firstValue(pointHeat.grid.metrics, 'temperature');
    const series = pointHeat.grid.metrics.find((metric) => {
      const first = metric.values[0];
      return (
        first &&
        `${metric.label} ${first.value} ${unitLabel(first.unitCode)} (${first.unitCode})` ===
          preferred
      );
    });
    const validTime = series?.values[0]?.validTime;
    if (preferred) {
      parts.push(
        `Earliest populated current or future NWS grid read: ${preferred}` +
          `${validTime ? `, valid ${validTime}` : ''}.`
      );
    } else {
      parts.push('NWS grid heat guidance is available.');
    }
  }
  if (parts.length === 0) return null;
  return {
    key: 'pointHeat',
    label: 'NWS point observation and grid guidance',
    text: parts.join(' ')
  };
}

/**
 * Compose a comparison without inventing thresholds or a DDM heat class.
 * Each read remains issuer-verbatim or a direct formatting of issuer values.
 */
export function synthesizeHeatSources(
  pointHeat: PointHeatBriefing,
  results: readonly SourceResult[],
  allSettled: boolean
): HeatSynthesis {
  const reads: HeatSourceRead[] = [];
  const pointRead = pointHeatRead(pointHeat);
  if (pointRead) reads.push(pointRead);
  for (const result of results) {
    if (result.heatRead) reads.push(result.heatRead);
  }

  if (!allSettled) {
    return {
      status: 'loading',
      reads,
      note:
        'Heat sources are still resolving. Each source retains its own validity and spatial support.'
    };
  }

  const failed = results.filter((result) => !result.ok);
  const pointFailed = pointHeat.status === 'error';
  let status: HeatSynthesis['status'];
  if (reads.length === 0) {
    status = pointHeat.status === 'no-data' && failed.length === 0
      ? 'no-data'
      : 'error';
  } else if (
    failed.length > 0 ||
    pointFailed ||
    pointHeat.status === 'degraded'
  ) {
    status = 'degraded';
  } else {
    status = 'ready';
  }

  const failureNotes = failed
    .map((result) => result.note)
    .filter((note): note is string => typeof note === 'string');
  const framing =
    reads.length > 0
      ? 'These issuer products describe different times and spatial supports. DDM shows them together but does not combine them into a new heat class.'
      : pointHeat.note ??
        'No heat source returned a readable value for the selected point.';
  return {
    status,
    reads,
    note:
      failureNotes.length > 0
        ? `${framing} ${failureNotes.join(' ')}`
        : framing
  };
}
