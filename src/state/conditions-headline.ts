/**
 * The mode's own lead Conditions-in-view reading, published by the strip
 * (src/ui/island/conditions-strip.tsx) and shown on the desktop Key chip
 * (src/ui/map-key.ts; owner 2026-11-13, "one single box").
 */

export interface ConditionsHeadline {
  value: string;
  sublabel: string;
  color?: string;
  stale: boolean;
  tone: 'data' | 'none';
  /** The strip's own tile status sentence, plus ' Reading is stale.' when stale. */
  aria: string;
}

let current: ConditionsHeadline | null = null;
let signature = 'null';
const listeners = new Set<(headline: ConditionsHeadline | null) => void>();

export function setConditionsHeadline(next: ConditionsHeadline | null): void {
  const sig = JSON.stringify(next);
  if (sig === signature) return;
  signature = sig;
  current = next;
  for (const fn of listeners) fn(current);
}

/** A late subscriber gets the current value at once: map-key.ts loads lazily, after the strip may have published. */
export function onConditionsHeadline(fn: (headline: ConditionsHeadline | null) => void): () => void {
  listeners.add(fn);
  fn(current);
  return () => listeners.delete(fn);
}
