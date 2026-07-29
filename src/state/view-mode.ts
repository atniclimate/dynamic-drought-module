/**
 * The Brief/console view-mode store (U1, D-ARCH-002: "answer-first,
 * two doors").
 *
 * The application has two doors: BRIEF leads with the drought briefing
 * and keeps the map and layer catalog as the drill-down; CONSOLE is the
 * full map-and-layers instrument. The mode round-trips through the URL
 * as `view=brief|console` (invariant 2: URL as state). Since S2
 * (D-0.7.0-041) a Brief boot no longer auto-opens a briefing: the mode
 * derivation below stands, but a briefing opens ONLY from an explicit
 * place selection or a `select=` deep link, never unsolicited.
 *
 * Boot derivation for URLs that do not carry an explicit `view=` (the
 * legacy-URL rule, D-0.7.0-017):
 *
 *   1. An explicit `view=` always wins (it IS the mode).
 *   2. A `select=` deep link opens BRIEF: the sharer meant the briefing
 *      (the recommended partner URL carries `layers=states` only to
 *      make the selected boundary visible, so `select` outranks the
 *      layers clause below).
 *   3. A URL naming `layers=`, a `cluster=` or its `ocean=` companion
 *      (S2, D-0.7.0-044: a display link), or a `region` or `framing=`
 *      without `select=`, opens the CONSOLE: the sharer meant the map.
 *   4. A bare URL opens BRIEF (embeds included: embeds default to
 *      brief, D-ARCH-002).
 *
 * This module is a tiny store in the region-store pattern: the URL
 * parser writes the boot mode, the view shell writes user switches, and
 * subscribers (the sidebar's URL sync, the shell's class application)
 * react to changes.
 */

export type ViewMode = 'brief' | 'console';

type ViewModeListener = (mode: ViewMode) => void;

let currentMode: ViewMode = 'brief';
const listeners = new Set<ViewModeListener>();

/** Derive the boot mode from the URL parameters (the legacy-URL rule). */
export function deriveViewMode(params: URLSearchParams): ViewMode {
  const explicit = params.get('view');
  if (explicit === 'brief' || explicit === 'console') return explicit;
  if (params.get('select')) return 'brief';
  if (
    params.has('layers') ||
    params.has('region') ||
    params.has('cluster') ||
    params.has('ocean') ||
    params.has('framing')
  ) {
    return 'console';
  }
  return 'brief';
}

/** The active view mode. */
export function getViewMode(): ViewMode {
  return currentMode;
}

/**
 * The explicit-Brief boot flag (U-UX-FIX-1 DEF-2). True only when the
 * INBOUND URL carried a literal, valid `view=brief` token, recorded by the
 * sidebar's boot URL application from the parser's raw explicitness (the
 * derived Brief mode of a bare URL never sets it). The mobile sheet reads
 * it exactly once, at its boot activation, to raise the Brief surface at
 * the half detent: a shared or reloaded `?view=brief` link reproduces what
 * the sender saw, while a bare boot keeps the ratified map-first closed
 * state (D-0.7.0-041). The sheet clears the flag after its boot evaluation
 * so later shell activations (a viewport crossing, the embed-exit reveal)
 * are never re-raised by the app's own `view=` stamp.
 */
let explicitBriefBoot = false;

/** Record whether the boot URL explicitly asked for the Brief door. */
export function setExplicitBriefBoot(flag: boolean): void {
  explicitBriefBoot = flag;
}

/** Whether the boot URL explicitly asked for the Brief door (see above). */
export function isExplicitBriefBoot(): boolean {
  return explicitBriefBoot;
}

/** Consume the boot-time ask (called once the boot shell has evaluated). */
export function clearExplicitBriefBoot(): void {
  explicitBriefBoot = false;
}

/**
 * Set the view mode. Notifies subscribers only on a real change; the
 * boot write (same value as the initial state) is silent by nature.
 */
export function setViewMode(mode: ViewMode): void {
  if (mode === currentMode) return;
  currentMode = mode;
  for (const fn of [...listeners]) fn(mode);
}

/** Subscribe to mode changes. Returns an unsubscribe function. */
export function onViewModeChange(fn: ViewModeListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
