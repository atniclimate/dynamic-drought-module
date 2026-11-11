/**
 * "Show on map": the Place studio's second exit (owner direction 2026-11-09
 * (sprint), DR-pending).
 *
 * The selection bar offers two things to do with a chosen place: open its
 * briefing, or show it on the map. The first is the exit hand-off the studio
 * has always run. This module is the second: frame the place, mark its
 * boundary, and make it the selected place exactly as a search result or a
 * map click does (summary first, D-0.7.0-070). No briefing opens; the shell
 * names the place and offers its briefing.
 *
 * It lives apart from src/ui/island/place-studio.tsx on purpose: the studio's
 * own reads never look at the map (its overlap words must not move with the
 * live camera), and this is the one step of the exit that has to.
 *
 * STEWARDSHIP. The geometry drawn here is the one the studio already read
 * live for this selection (a Tribal Nation's with `cache: 'no-store'`).
 * Nothing is fetched again, nothing is written to storage, and nothing
 * outlives the selection: a Tribal Nation is drawn with the located overlay
 * the exit briefing uses, which clears with its selection
 * (src/state/located-boundary.ts); any other kind is drawn with the studio's
 * own neutral selection boundary (src/state/studio-boundary.ts), never in the
 * Tribal family colour, and is dropped here when the selection moves on. The
 * context carries the representation caveat's kind unchanged, so a briefing
 * opened later from this selection states it as any other does.
 */

import type { BoundarySelectionContext } from '../../impact/types';
import { clearStudioEmphasis, showStudioReturnBoundary } from '../../state/display-snapshot';
import { getMap } from '../../state/map-store';
import { onPlaceSelectionChange, setPlaceSelection } from '../../state/place-selection';
import { clearStudioBoundary, showStudioBoundary } from '../../state/studio-boundary';
import type { StudioBoundaryGeometry } from '../../state/studio-boundary';
import type { TypedPlaceKind } from '../../state/typed-place';
import { bboxToContinuousBounds } from '../../util/bbox';
import { edgeColumnInset } from '../edge-column';
import { getSheetDetent, isSheetActive, sheetCameraInset, sheetCameraSideInset } from '../mobile-sheet';

/** Drops the neutral boundary this module drew, once its place is no longer the selection. */
let release: (() => void) | null = null;

/**
 * Drop a boundary an earlier "Show on map" left on the map. The studio calls
 * this when it opens: from then on the map's selection display is the
 * studio's own again.
 */
export function releaseShownPlace(): void {
  release?.();
}

/**
 * Frame `bbox`, mark `geometry`, and make `context` the selected place.
 * Called from the studio's exit hand-off, after the display it set aside
 * has been restored.
 */
export function showPlaceOnMap(
  kind: TypedPlaceKind,
  context: BoundarySelectionContext,
  geometry: StudioBoundaryGeometry,
  bbox: readonly [number, number, number, number]
): void {
  release?.();
  const selection = { label: context.title, context };
  // Selection first: the located overlay records the selection current when it is shown.
  setPlaceSelection(selection);
  const map = getMap();
  if (!map) return;
  // Keep the place clear of the phone chrome that is on screen with it: the
  // right-edge column always, and while the sheet is up, the band it takes.
  // That band is the lower part of the map for the bottom sheet and the
  // left part for the landscape drawer; the numbers are the briefing fit's
  // own (`briefingCameraPadding`, src/state/deep-link.ts).
  const phone = isSheetActive();
  const sheetUp = phone && getSheetDetent() !== 'closed';
  map.fitBounds(bboxToContinuousBounds(bbox), {
    padding: phone
      ? {
          top: 24,
          left: 24 + (sheetUp ? sheetCameraSideInset() : 0),
          right: 24 + edgeColumnInset(),
          bottom: 24 + (sheetUp ? sheetCameraInset() : 0)
        }
      : { top: 40, left: 40, right: 40, bottom: 40 }
  });
  if (kind === 'tribe') {
    showStudioReturnBoundary(geometry);
    return;
  }
  // One mark, not two: the neutral boundary stands in for the studio's emphasis.
  clearStudioEmphasis();
  showStudioBoundary(map, geometry);
  const stop = onPlaceSelectionChange((next) => {
    // The briefing taking ownership of the same place keeps its boundary.
    if (next && next.label === selection.label && next.context.kind === context.kind) return;
    release?.();
  });
  release = () => {
    release = null;
    stop();
    clearStudioBoundary(map);
  };
}
