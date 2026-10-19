/**
 * Where focus goes when a focused conditions tile is about to unmount on
 * Hide (S30D D1 M28: a focused control that disappears hands focus on).
 * The Alerts and Fires tiles render only while their layer is on, and the
 * Brief dock hides off tiles (its status line, hidden while a tile shows, is never a target).
 * Order: the next rendered tile, then the previous; else the strip, which
 * stays in view (its empty line holds the seat, the Brief dock included).
 * Not the dock's Layer legends summary: hiding the last legend-bearing layer
 * hides that whole disclosure, and focus would fall to the page body.
 * No imports, so `node --test` can load it (tests/strip-focus.test.mjs).
 */
export function stripFocusAfterHide(tile: HTMLElement): HTMLElement | null {
  const tiles = Array.from(tile.parentElement?.children ?? []) as HTMLElement[];
  const at = tiles.indexOf(tile);
  const sibling = [...tiles.slice(at + 1), ...tiles.slice(0, at).reverse()].find(
    (el) => el.getClientRects().length > 0
  );
  if (sibling) return sibling;
  const strip = tile.closest<HTMLElement>('#conditions-strip');
  if (strip) strip.tabIndex = -1;
  return strip;
}
