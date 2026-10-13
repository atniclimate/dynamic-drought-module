import { FRAMINGS } from '../../config/framings';
import type { FramingKey } from '../../config/framings';

/** Whether a framing's authored extent can contain Nunavut land: it reaches
 * north of 60 N and overlaps 120 W to 60 W. Hawaii, Mexico and Southeast and
 * Gulf cannot, so a missing Nunavut mask says nothing about their land.
 * shortcut: camera bounds, not land geometry; revisit if a framing is redrawn. */
export function framingMayContainNunavut(key: FramingKey): boolean {
  const [[, west], [north, encodedEast]] = FRAMINGS[key].bounds;
  const east = encodedEast < west ? encodedEast + 360 : encodedEast;
  if (north <= 60) return false;
  return (west <= -60 && east >= -120) || (west <= 300 && east >= 240);
}
