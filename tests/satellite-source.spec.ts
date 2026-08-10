import { expect, test } from '@playwright/test';

import {
  isSatelliteFrameRecent,
  parseLatestSatelliteFrame,
  parseSatelliteFrames,
  SATELLITE_PROBE_BBOX,
  satelliteProbeUrl,
  satelliteTileTemplate
} from '../src/map/satellite';

const NOW = Date.UTC(2026, 7, 5, 18, 10);

test.describe('recent NOAA satellite source', () => {
  test('validates the newest catalog frame and pins the tile template', () => {
    const frame = parseLatestSatelliteFrame({
      features: [
        {
          attributes: {
            objectid: 9026,
            name: 'MERGEDGC.10-minute.20260805_1750.color',
            start_time: 1_785_951_600_000,
            end_time: 1_785_952_140_000
          }
        }
      ]
    }, NOW);

    expect(frame.objectId).toBe(9026);
    expect(frame.endTime - frame.startTime).toBe(9 * 60_000);

    const template = satelliteTileTemplate(frame);
    expect(template).toContain('bbox={bbox-epsg-3857}');
    expect(template).toContain('time=1785951600000');
    expect(decodeURIComponent(template)).toContain(
      '"lockRasterIds":["9026"]'
    );
    expect(satelliteProbeUrl(frame)).toContain(`bbox=${SATELLITE_PROBE_BBOX}`);
  });

  test('rejects missing, malformed, and implausibly long frames', () => {
    expect(() => parseLatestSatelliteFrame({ features: [] })).toThrow(
      /no recent frame/
    );
    expect(() =>
      parseLatestSatelliteFrame({
        features: [
          {
            attributes: {
              objectid: 1,
              name: 'bad',
              start_time: 1_000,
              end_time: 3_000_000
            }
          }
        ]
      }, NOW)
    ).toThrow(/no valid recent frame/);
  });

  test('skips a future newest record and retains a recent earlier candidate', () => {
    const valid = {
      objectid: 9,
      name: 'valid',
      start_time: NOW - 19 * 60_000,
      end_time: NOW - 10 * 60_000
    };
    const frames = parseSatelliteFrames({
      features: [
        {
          attributes: {
            objectid: 10,
            name: 'future',
            start_time: NOW + 21 * 60_000,
            end_time: NOW + 30 * 60_000
          }
        },
        { attributes: valid },
        {
          attributes: {
            objectid: 8,
            name: 'stale',
            start_time: NOW - 28 * 60 * 60_000,
            end_time: NOW - 27 * 60 * 60_000
          }
        }
      ]
    }, NOW);

    expect(frames).toHaveLength(1);
    expect(frames[0].objectId).toBe(9);
    expect(isSatelliteFrameRecent(frames[0], NOW)).toBe(true);
  });

  test('rejects catalogs whose candidates are all stale or future-dated', () => {
    expect(() => parseSatelliteFrames({
      features: [
        {
          attributes: {
            objectid: 1,
            name: 'stale',
            start_time: NOW - 30 * 60 * 60_000,
            end_time: NOW - 29 * 60 * 60_000
          }
        },
        {
          attributes: {
            objectid: 2,
            name: 'future',
            start_time: NOW + 60 * 60_000,
            end_time: NOW + 69 * 60_000
          }
        }
      ]
    }, NOW)).toThrow(/no valid recent frame/);
  });
});
