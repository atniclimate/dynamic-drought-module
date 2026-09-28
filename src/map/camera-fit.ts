/**
 * Camera fits for the committed camera kinds, and the check that says whether
 * the live camera still shows one (D1 M8, found-029, DDM-P10-T07).
 *
 * CAMERA-ONLY: nothing here writes a store, the URL or the DOM. The stores
 * are only READ, by `committedCameraTarget`, in the boot camera precedence of
 * `applyUrlStateSync` in src/ui/sidebar.ts: an ocean camera (`ocean=`) wins
 * over a framing (`framing=`, where `all` is the North American ALL extent),
 * which wins over the legacy region (`region=`).
 *
 * Every fit goes through a target built here, `{ bounds, padding }`, and the
 * equality check measures the SAME target with MapLibre's own
 * `cameraForBounds`, so a fit and the check that decides whether to repeat it
 * can never disagree about where a camera kind lands.
 *
 * The camera is not URL state: a refit after a sidebar toggle changes the view
 * only, never `framing=`, `region=`, `cluster=` or `ocean=`.
 */

import { LngLat } from 'maplibre-gl';
import type * as maplibregl from 'maplibre-gl';

import { ALL_FRAMING_BOUNDS, FRAMINGS, framingFitBounds } from '../config/framings';
import type { FramingKey } from '../config/framings';
import { OCEANS } from '../config/oceans';
import type { OceanKey } from '../config/oceans';
import { REGIONS, regionToMapLibreBounds } from '../config/regions';
import type { Region, RegionKey } from '../config/regions';
import { getOceanFraming } from '../state/cluster-store';
import { getFraming } from '../state/framing-store';
import { getCurrentRegion } from '../state/region-store';
import { prefersReducedMotion } from '../util/motion';

/** The pixel inset every camera fit in the application uses. */
export const CAMERA_FIT_PADDING_PX = 20;

/** A committed camera: the bounds a fit frames, and its pixel inset. */
export interface CameraTarget {
  readonly bounds: [[number, number], [number, number]];
  readonly padding: number;
}

/** A camera is flat when its pitch and bearing are both below this, in degrees. */
const FLAT_TOLERANCE_DEG = 0.5;
/** The live zoom matches a target within this many zoom levels. */
const ZOOM_TOLERANCE = 0.01;
/** The live centre matches a target within this many CSS pixels. */
const CENTRE_TOLERANCE_PX = 1;
/** A camera is unchanged when its centre moved less than this, in CSS pixels. */
const UNCHANGED_CENTRE_PX = 0.5;
/** A camera is unchanged when zoom, pitch and bearing moved less than this. */
const UNCHANGED_EPSILON = 1e-6;

/** An editorial framing's camera (src/config/framings.ts). */
export function framingTarget(key: FramingKey): CameraTarget {
  return { bounds: framingFitBounds(FRAMINGS[key]), padding: CAMERA_FIT_PADDING_PX };
}

/** The ALL camera: the full North American minimap extent, no degree padding. */
export function allTarget(): CameraTarget {
  return {
    bounds: framingFitBounds({ bounds: ALL_FRAMING_BOUNDS, padding: 0 }),
    padding: CAMERA_FIT_PADDING_PX
  };
}

/** An ocean camera (src/config/oceans.ts). */
export function oceanTarget(key: OceanKey): CameraTarget {
  return { bounds: framingFitBounds(OCEANS[key]), padding: CAMERA_FIT_PADDING_PX };
}

/**
 * A legacy region's camera: the region's bounds in MapLibre order, widened by
 * the region's own padding in degrees on every side (the vanilla
 * `selectRegion`, app.js 1132-1151). Null for a key with no region.
 */
export function regionTarget(key: RegionKey): CameraTarget | null {
  const region: Region | undefined = REGIONS[key];
  if (!region) return null;
  const [west, south, east, north] = regionToMapLibreBounds(region);
  const pad = region.padding;
  return {
    bounds: [
      [west - pad, south - pad],
      [east + pad, north + pad]
    ],
    padding: CAMERA_FIT_PADDING_PX
  };
}

/**
 * The camera the user last committed, in the boot precedence: the ocean
 * camera, else the framing (`all` or a key), else the current region. Null
 * when none is committed.
 */
export function committedCameraTarget(): CameraTarget | null {
  const ocean = getOceanFraming();
  if (ocean !== null) return oceanTarget(ocean);
  const framing = getFraming();
  if (framing === 'all') return allTarget();
  if (framing !== null) return framingTarget(framing);
  const region = getCurrentRegion();
  return region === null ? null : regionTarget(region);
}

/** Fit the camera to a target; `animate` false jumps (the reduced-motion house rule). */
export function fitCameraTarget(
  map: maplibregl.Map,
  target: CameraTarget,
  animate: boolean
): void {
  map.fitBounds(target.bounds, { padding: target.padding, animate });
}

/** Fit the camera to a framing, mirroring the boot path's fit. */
export function fitFraming(map: maplibregl.Map, key: FramingKey): void {
  fitCameraTarget(map, framingTarget(key), !prefersReducedMotion());
}

/** Fit ALL to the full North American minimap extent. */
export function fitAll(map: maplibregl.Map): void {
  fitCameraTarget(map, allTarget(), !prefersReducedMotion());
}

/** Fit an ocean camera. */
export function fitOcean(map: maplibregl.Map, key: OceanKey): void {
  fitCameraTarget(map, oceanTarget(key), !prefersReducedMotion());
}

/** Fit a legacy region, the math of `selectRegion` in src/ui/sidebar.ts. */
export function fitRegion(
  map: maplibregl.Map,
  key: RegionKey,
  animate: boolean = !prefersReducedMotion()
): void {
  const target = regionTarget(key);
  if (target) fitCameraTarget(map, target, animate);
}

/**
 * Whether the live camera shows `target` exactly as a fit to it would at the
 * current canvas: the camera is flat (a pitched or rotated camera, Fire 3D's
 * included, is the user's own), the target's zoom clamped to the map's zoom
 * range is within ZOOM_TOLERANCE of the live zoom, and the target centre
 * projects within CENTRE_TOLERANCE_PX of the live centre. Both centres are
 * wrapped first; a mismatch across the antimeridian reads as no match, the
 * safe answer (no refit).
 */
export function cameraMatchesTarget(map: maplibregl.Map, target: CameraTarget): boolean {
  if (
    map.getPitch() >= FLAT_TOLERANCE_DEG ||
    Math.abs(map.getBearing()) >= FLAT_TOLERANCE_DEG
  ) {
    return false;
  }
  const camera = map.cameraForBounds(target.bounds, { padding: target.padding });
  if (!camera || camera.center === undefined || camera.zoom === undefined) return false;
  const zoom = Math.min(map.getMaxZoom(), Math.max(map.getMinZoom(), camera.zoom));
  if (Math.abs(zoom - map.getZoom()) > ZOOM_TOLERANCE) return false;
  const targetPoint = map.project(LngLat.convert(camera.center).wrap());
  const livePoint = map.project(map.getCenter().wrap());
  return (
    Math.hypot(targetPoint.x - livePoint.x, targetPoint.y - livePoint.y) <=
    CENTRE_TOLERANCE_PX
  );
}

/** The live camera, for a later "has anything moved it" check. */
export interface CameraState {
  readonly center: maplibregl.LngLat;
  readonly zoom: number;
  readonly pitch: number;
  readonly bearing: number;
}

/** Read the live camera. */
export function readCameraState(map: maplibregl.Map): CameraState {
  return {
    center: map.getCenter(),
    zoom: map.getZoom(),
    pitch: map.getPitch(),
    bearing: map.getBearing()
  };
}

/**
 * Whether the live camera still equals `state`: a pan, zoom, pitch or
 * rotation since reads as changed. A canvas resize alone keeps the camera.
 */
export function cameraStateUnchanged(map: maplibregl.Map, state: CameraState): boolean {
  if (
    Math.abs(map.getZoom() - state.zoom) > UNCHANGED_EPSILON ||
    Math.abs(map.getPitch() - state.pitch) > UNCHANGED_EPSILON ||
    Math.abs(map.getBearing() - state.bearing) > UNCHANGED_EPSILON
  ) {
    return false;
  }
  const then = map.project(state.center);
  const now = map.project(map.getCenter());
  return Math.hypot(then.x - now.x, then.y - now.y) < UNCHANGED_CENTRE_PX;
}
