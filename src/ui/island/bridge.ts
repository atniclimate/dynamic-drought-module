/**
 * Framework-neutral bridge between the sidebar's LayerControllerView
 * adapter and the lazily-mounted view island (ADR 0002, D-0.7.0-021).
 *
 * The island rides a lazy chunk, but the layer controller needs its
 * checkbox reads and writes to work from the first millisecond of boot
 * (applyLayerSet checks each URL-named row's box before the island has
 * mounted). This module is that seam: a tiny eager store of per-layer
 * checkbox intent that the view adapter writes and reads synchronously,
 * and that the island snapshots at mount and subscribes to afterward.
 *
 * MUST stay free of preact imports: anything imported statically from
 * sidebar.ts lands in the entry chunk, and the whole point of the
 * island shape is that the framework does not (ADR 0002 condition 1).
 */

type CheckedListener = (key: string, checked: boolean) => void;

const checkedByKey = new Map<string, boolean>();
const listeners = new Set<CheckedListener>();

/**
 * Record a layer row's checkbox intent. Called by the sidebar's view
 * adapter (the controller unchecking a failed or excluded surface, the
 * URL-boot path checking its layer set) and by the island's own change
 * handler, so both writers converge on one source of truth.
 */
export function setChecked(key: string, checked: boolean): void {
  const previous = checkedByKey.get(key);
  checkedByKey.set(key, checked);
  // ARCH-10: every listener is wired (through the sidebar) to a `pushUrl`,
  // which rebuilds two URLSearchParams and calls history.replaceState. Boot
  // alone re-emitted an unchanged value roughly ten times. An emit whose value
  // did not move has no subscriber-visible effect, so skip it. A key's FIRST
  // write still emits even when it is `false`, because `checkedSnapshot` gains
  // an entry that was not there before.
  if (previous === checked) return;
  for (const fn of [...listeners]) fn(key, checked);
}

/** The recorded intent for a key; an unknown key reads unchecked. */
export function isChecked(key: string): boolean {
  return checkedByKey.get(key) ?? false;
}

/**
 * Subscribe to intent changes (the island's render trigger). Returns an
 * unsubscribe function.
 */
export function onCheckedChange(fn: CheckedListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** A fresh copy of the whole intent map (the island's mount snapshot). */
export function checkedSnapshot(): ReadonlyMap<string, boolean> {
  return new Map(checkedByKey);
}
