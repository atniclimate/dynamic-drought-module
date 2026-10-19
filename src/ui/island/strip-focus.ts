/**
 * Where focus goes when a focused conditions tile is about to unmount on
 * Hide (S30D D1 M28: a focused control that disappears hands focus on).
 * The Alerts and Fires tiles render only while their layer is on, and the
 * Brief dock hides off tiles and collapses with its last live reading.
 * Order: the next rendered tile, then the previous; else, in the Brief dock,
 * the Layer legends summary below it; else the strip, which stays in view.
 * No imports, so `node --test` can load it (tests/strip-focus.test.mjs).
 */
export function stripFocusAfterHide(tile: HTMLElement): HTMLElement | null {
  const tiles = Array.from(tile.parentElement?.children ?? []) as HTMLElement[];
  const at = tiles.indexOf(tile);
  const sibling = [...tiles.slice(at + 1), ...tiles.slice(0, at).reverse()].find(
    (el) => el.getClientRects().length > 0
  );
  if (sibling) return sibling;
  const legends = tile
    .closest('.sidebar-bottom-dock')
    ?.querySelector<HTMLElement>('.sidebar-legend-disclosure > summary');
  if (legends) return legends;
  const strip = tile.closest<HTMLElement>('#conditions-strip');
  if (strip) strip.tabIndex = -1;
  return strip;
}
