/**
 * The PLACE studio's hold on the map display (owner direction 2026-11-09
 * (sprint), DR-pending).
 *
 * While the PLACE studio is open it sets the hazard surfaces and events
 * aside for a clean display, and when it closes it restores the display it
 * captured (src/state/display-snapshot.ts). The hold is on from that capture
 * until the restore has finished, so a reader never sees the half-restored
 * set as the person's own choice.
 *
 * The 3D Fire view reads it (src/map/fire3d.ts): a scene that is already up
 * stays up through the round trip, instead of tearing down when its Fire
 * layers are set aside and starting over when they come back.
 *
 * No imports, so the chunks that need it share one tiny module and a Node
 * harness loads it as it is.
 */

let held = false;

export function setPlaceDisplayHeld(next: boolean): void {
  held = next;
}

export function isPlaceDisplayHeld(): boolean {
  return held;
}
