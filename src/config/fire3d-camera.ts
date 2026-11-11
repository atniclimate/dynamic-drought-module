/**
 * The phone 3D scene's one-thumb camera: step sizes and the arithmetic of
 * each press (owner direction 2026-11-09 (sprint), DR-pending).
 *
 * The pad is CAMERA CHROME. It turns and tilts the view of the same mapped
 * data and claims nothing about it, so nothing here is written to the URL
 * and no number here is an issuer's. Kept import-free so `node --test` can
 * prove the arithmetic without a map.
 */

/** A pad press. `reset` is the compass: north up, the scene's opening tilt. */
export type Fire3DPadAction = 'tilt-up' | 'tilt-down' | 'rotate-left' | 'rotate-right' | 'reset';

/** The pad's actions in reading order (top, then the middle row, then bottom). */
export const FIRE3D_PAD_ACTIONS: readonly Fire3DPadAction[] = [
  'tilt-up',
  'rotate-left',
  'reset',
  'rotate-right',
  'tilt-down'
];

/**
 * Degrees of tilt per press. Ten presses would cross the whole range; six
 * take the opening 60 degrees to straight overhead.
 */
export const FIRE3D_PAD_TILT_STEP_DEG = 10;

/**
 * Degrees of turn per press: one point of a sixteen-point compass, so every
 * press lands on a direction the compass can name.
 */
export const FIRE3D_PAD_TURN_STEP_DEG = 22.5;

/** How long one press takes to ease, in ms. Reduced motion jumps instead. */
export const FIRE3D_PAD_EASE_MS = 240;

/** A camera the pad can move: MapLibre's own pitch and bearing, in degrees. */
export interface Fire3DCamera {
  readonly pitch: number;
  readonly bearing: number;
}

export interface Fire3DCameraLimits {
  /** The map's pitch ceiling (`map.getMaxPitch()`). */
  readonly maxPitch: number;
  /** The tilt the scene opens at (FIRE3D_PITCH_DEGREES). */
  readonly homePitch: number;
}

/** A bearing folded into MapLibre's own range, greater than -180 and at most 180. */
export function normalizeBearing(bearing: number): number {
  const turned = ((((bearing + 180) % 360) + 360) % 360) - 180;
  return turned === -180 ? 180 : turned;
}

/**
 * Where a press takes the camera. Pure: the caller eases or jumps there.
 *
 * Tilting UP raises the view toward the horizon (pitch grows) and stops at
 * the map's ceiling; tilting DOWN lowers it toward straight overhead and
 * stops at 0. Turning RIGHT turns the view clockwise, as turning your head
 * right would, so the bearing grows; the result is snapped to the nearest
 * compass point so repeated presses never drift off the sixteen.
 */
export function fire3dPadTarget(
  action: Fire3DPadAction,
  camera: Fire3DCamera,
  limits: Fire3DCameraLimits
): Fire3DCamera {
  const step = FIRE3D_PAD_TURN_STEP_DEG;
  const snap = (bearing: number): number => normalizeBearing(Math.round(bearing / step) * step);
  switch (action) {
    case 'tilt-up':
      return {
        pitch: Math.min(limits.maxPitch, camera.pitch + FIRE3D_PAD_TILT_STEP_DEG),
        bearing: camera.bearing
      };
    case 'tilt-down':
      return { pitch: Math.max(0, camera.pitch - FIRE3D_PAD_TILT_STEP_DEG), bearing: camera.bearing };
    case 'rotate-left':
      return { pitch: camera.pitch, bearing: snap(camera.bearing - step) };
    case 'rotate-right':
      return { pitch: camera.pitch, bearing: snap(camera.bearing + step) };
    default:
      return { pitch: limits.homePitch, bearing: 0 };
  }
}

/** Whether a press would change nothing, so the control can say it is at its stop. */
export function fire3dPadAtStop(
  action: Fire3DPadAction,
  camera: Fire3DCamera,
  limits: Fire3DCameraLimits
): boolean {
  const target = fire3dPadTarget(action, camera, limits);
  return (
    Math.abs(target.pitch - camera.pitch) < 0.05 &&
    Math.abs(normalizeBearing(target.bearing - camera.bearing)) < 0.05
  );
}

const COMPASS_POINTS: readonly (readonly [string, string])[] = [
  ['N', 'north'],
  ['NNE', 'north-northeast'],
  ['NE', 'northeast'],
  ['ENE', 'east-northeast'],
  ['E', 'east'],
  ['ESE', 'east-southeast'],
  ['SE', 'southeast'],
  ['SSE', 'south-southeast'],
  ['S', 'south'],
  ['SSW', 'south-southwest'],
  ['SW', 'southwest'],
  ['WSW', 'west-southwest'],
  ['W', 'west'],
  ['WNW', 'west-northwest'],
  ['NW', 'northwest'],
  ['NNW', 'north-northwest']
];

/**
 * The compass point the view faces: the direction at the top of the screen.
 * `short` is the letters the compass shows, `long` the words its accessible
 * name speaks.
 */
export function fire3dCompassPoint(bearing: number): { readonly short: string; readonly long: string } {
  const index = Math.round((((bearing % 360) + 360) % 360) / FIRE3D_PAD_TURN_STEP_DEG) % COMPASS_POINTS.length;
  const [short, long] = COMPASS_POINTS[index] ?? ['N', 'north'];
  return { short, long };
}

/**
 * The compass's accessible name: what a press does, then where the view
 * stands now. The first words are the action, so a voice-control user can
 * say them.
 */
export function fire3dCompassName(camera: Fire3DCamera): string {
  const point = fire3dCompassPoint(camera.bearing);
  return (
    'Reset the 3D view: north up, opening tilt. ' +
    `Now facing ${point.long}, tilted ${Math.round(camera.pitch)} degrees.`
  );
}

/** What a press said to assistive technology once the camera has stopped. */
export function fire3dCameraAnnouncement(camera: Fire3DCamera): string {
  const point = fire3dCompassPoint(camera.bearing);
  return `Facing ${point.long}, tilted ${Math.round(camera.pitch)} degrees.`;
}
