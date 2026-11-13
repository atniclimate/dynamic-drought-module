/**
 * Where focus goes when a focused conditions tile is about to unmount on
 * Hide (S30D D1 M28: a focused control that disappears hands focus on).
 * The Alerts and Fires tiles render only while their layer is on, and the
 * map seat shows only its first live tile (its status line is never a target).
 * Order: the next rendered tile, then the previous; then, on the map, the
 * Key chip beside it, since the reading line goes with its last live tile;
 * else the strip, which stays in view (its empty line holds the seat).
 * No imports, so `node --test` can load it (tests/strip-focus.test.mjs).
 */
export function stripFocusAfterHide(tile: HTMLElement): HTMLElement | null {
  const tiles = Array.from(tile.parentElement?.children ?? []) as HTMLElement[];
  const at = tiles.indexOf(tile);
  const sibling = [...tiles.slice(at + 1), ...tiles.slice(0, at).reverse()].find(
    (el) => el.getClientRects().length > 0
  );
  if (sibling) return sibling;
  const keyChip = tile.closest<HTMLElement>('#map-condition-indicator')?.querySelector<HTMLElement>('#map-key-details-toggle');
  if (keyChip) return keyChip;
  const strip = tile.closest<HTMLElement>('#conditions-strip');
  if (strip) strip.tabIndex = -1;
  return strip;
}
