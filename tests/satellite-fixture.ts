import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';

import {
  SATELLITE_PROBE_BBOX,
  type SatelliteFrame
} from '../src/map/satellite';

const FIXTURE_NOW = Math.floor(Date.now() / 60_000) * 60_000;

export const SATELLITE_FRAME: SatelliteFrame = Object.freeze({
  objectId: 9026,
  name: 'MERGEDGC.10-minute.fixture_previous.color',
  startTime: FIXTURE_NOW - 24 * 60_000,
  endTime: FIXTURE_NOW - 15 * 60_000
});

export const SATELLITE_NEW_FRAME: SatelliteFrame = Object.freeze({
  objectId: 9027,
  name: 'MERGEDGC.10-minute.fixture_newest.color',
  startTime: FIXTURE_NOW - 14 * 60_000,
  endTime: FIXTURE_NOW - 5 * 60_000
});

function makeProbeTile(): Buffer {
  const png = new PNG({ width: 256, height: 256 });
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const offset = (y * png.width + x) * 4;
      const west = x < png.width / 2;
      png.data[offset] = west ? 34 : 174;
      png.data[offset + 1] = west ? 91 : 126;
      png.data[offset + 2] = west ? 132 : 57;
      png.data[offset + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

const VALID_TILE = makeProbeTile();

function frameObjectId(requestUrl: string): number | null {
  const encodedRule = new URL(requestUrl).searchParams.get('mosaicRule');
  if (!encodedRule) return null;
  try {
    const rule = JSON.parse(encodedRule) as { lockRasterIds?: unknown };
    if (!Array.isArray(rule.lockRasterIds)) return null;
    const objectId = Number(rule.lockRasterIds[0]);
    return Number.isInteger(objectId) ? objectId : null;
  } catch {
    return null;
  }
}

export function satelliteObservationRangeText(frame: SatelliteFrame): string {
  const format = (milliseconds: number, includeDate: boolean): string =>
    new Intl.DateTimeFormat('en-US', {
      ...(includeDate
        ? { month: 'short', day: 'numeric', year: 'numeric' }
        : {}),
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: 'UTC'
    }).format(new Date(milliseconds));
  return `${format(frame.startTime, true)} to ${format(frame.endTime, false)} UTC`;
}

export interface SatelliteStubOptions {
  readonly frames?: readonly SatelliteFrame[];
  readonly failedProbeFrameIds?: readonly number[];
  readonly failedRenderedFrameIds?: readonly number[];
}

export interface SatelliteStubController {
  readonly probeFrameIds: readonly number[];
  readonly renderedFrameIds: readonly number[];
  setFrames(frames: readonly SatelliteFrame[]): void;
  failProbeFrame(objectId: number): void;
  failRenderedFrame(objectId: number): void;
}

const stubbedPages = new WeakMap<Page, SatelliteStubController>();

export async function stubRecentSatellite(
  page: Page,
  options: SatelliteStubOptions = {}
): Promise<SatelliteStubController> {
  const existing = stubbedPages.get(page);
  if (existing) return existing;
  let frames = [...(options.frames ?? [SATELLITE_FRAME])];
  const failedProbeFrameIds = new Set(options.failedProbeFrameIds ?? []);
  const failedRenderedFrameIds = new Set(options.failedRenderedFrameIds ?? []);
  const probeFrameIds: number[] = [];
  const renderedFrameIds: number[] = [];

  await page.route('**/MERGEDGC_Last_24hr/ImageServer/query?**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        features: frames.map((frame) => ({
          attributes: {
            objectid: frame.objectId,
            name: frame.name,
            start_time: frame.startTime,
            end_time: frame.endTime
          }
        }))
      })
    })
  );
  await page.route(
    '**/MERGEDGC_Last_24hr/ImageServer/exportImage?**',
    (route) => {
      const url = new URL(route.request().url());
      const objectId = frameObjectId(url.href);
      const isProbe = url.searchParams.get('bbox') === SATELLITE_PROBE_BBOX;
      if (objectId !== null) {
        (isProbe ? probeFrameIds : renderedFrameIds).push(objectId);
      }
      if (objectId !== null && isProbe && failedProbeFrameIds.has(objectId)) {
        return route.fulfill({
          status: 503,
          contentType: 'text/plain',
          body: 'Synthetic unpublished frame'
        });
      }
      if (
        objectId !== null &&
        !isProbe &&
        failedRenderedFrameIds.has(objectId)
      ) {
        return route.abort();
      }
      return route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: VALID_TILE
      });
    }
  );

  const controller: SatelliteStubController = {
    probeFrameIds,
    renderedFrameIds,
    setFrames(nextFrames): void {
      frames = [...nextFrames];
    },
    failProbeFrame(objectId): void {
      failedProbeFrameIds.add(objectId);
    },
    failRenderedFrame(objectId): void {
      failedRenderedFrameIds.add(objectId);
    }
  };
  stubbedPages.set(page, controller);
  return controller;
}

export async function failRecentSatelliteTiles(page: Page): Promise<void> {
  await page.unroute('**/MERGEDGC_Last_24hr/ImageServer/exportImage?**');
  await page.route(
    '**/MERGEDGC_Last_24hr/ImageServer/exportImage?**',
    (route) => route.abort()
  );
}
