/**
 * What the camera does when the hazard cluster changes into or out of ENSO
 * (owner's F9, desktop): entering fits the Pacific, which holds the Nino 3.4
 * box and the broad anomaly pattern; leaving restores the view the person had
 * before entering. Pure on purpose, so a node test pins the four cases; the
 * caller in src/ui/sidebar.ts owns the map, the capture and the motion rule.
 */

import type { HazardClusterKey } from '../config/clusters';
import type { CameraState } from './camera-fit';

/**
 * The camera held from before ENSO was entered. One holder, so the cluster
 * subscriber (the normal leave) and the shell's explicit mode press (a leave
 * from a custom composition, where the store already says drought and no
 * change fires) restore the same capture and the second caller finds nothing.
 */
let held: CameraState | null = null;

export function holdEnsoCamera(state: CameraState): void {
  held = state;
}

export function hasHeldEnsoCamera(): boolean {
  return held !== null;
}

/** Return the held camera and drop it, or null. */
export function takeEnsoCamera(): CameraState | null {
  const state = held;
  held = null;
  return state;
}

export interface EnsoCameraAction {
  /** Save the live camera before anything moves it. */
  readonly capture: boolean;
  /** Fit the Pacific. False when the ocean dropdown already fits its own ocean. */
  readonly fitPacific: boolean;
  /** Put the saved camera back, then drop it. */
  readonly restore: boolean;
}

const NONE: EnsoCameraAction = { capture: false, fitPacific: false, restore: false };

export function ensoCameraAction(
  previous: HazardClusterKey,
  next: HazardClusterKey,
  hasCaptured: boolean,
  oceanSet: boolean,
  customized = false
): EnsoCameraAction {
  if (previous !== 'enso' && next === 'enso') {
    // A capture still held means the person never left ENSO's view (a custom
    // composition flipped the store); the earlier view is the one to go back to.
    return { capture: !hasCaptured, fitPacific: !oceanSet, restore: false };
  }
  // Ticking a layer box in ENSO flips the store to drought with a custom
  // composition; the person did not leave, so the view stays where it is.
  if (previous === 'enso' && next !== 'enso' && hasCaptured && !customized) {
    return { capture: false, fitPacific: false, restore: true };
  }
  return NONE;
}

/**
 * The centre a fit lands on when its zoom would fall below the map's floor (a
 * small embed): the floor centre, so the Nino 3.4 box stays in frame. Null when
 * the fit clears the floor or reports no zoom, and the plain fit applies.
 */
export function floorCentreOrNull(
  fitZoom: number | undefined,
  minZoom: number,
  floorCentre: readonly [number, number]
): [number, number] | null {
  return fitZoom !== undefined && fitZoom < minZoom ? [floorCentre[0], floorCentre[1]] : null;
}

/**
 * Whether a boot into ENSO fits the Pacific the way the mode button does: only
 * when the URL names no camera of its own. `ocean=` and `framing=` are cameras;
 * so are a `select=` place (the deep link fits its boundary) and a `region=`
 * other than the default, which every bare URL resolves to.
 */
export function ensoBootFitsPacific(
  cluster: HazardClusterKey,
  oceanSet: boolean,
  framingSet: boolean,
  defaultRegion: boolean,
  placeSelected: boolean
): boolean {
  return cluster === 'enso' && !oceanSet && !framingSet && defaultRegion && !placeSelected;
}
