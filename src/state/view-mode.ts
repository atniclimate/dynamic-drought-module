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
 * Boot derivation for URLs that do not carry an explicit `view=`:
 *
 *   1. An explicit `view=` always wins (it IS the mode).
 *   2. On the full site every URL without `view=console` opens BRIEF
 *      (owner, 2026-10-19).
 *   3. An embed naming `layers=`, `region=`, `cluster=`, `ocean=` or
 *      `framing=` without `select=` keeps the older display-link rule
 *      (D-0.7.0-017, D-0.7.0-044) and opens the CONSOLE; any other
 *      embed opens BRIEF (D-ARCH-002).
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

/** Derive the boot mode from the URL parameters (Brief unless view=console; embeds keep the display-link rule). */
export function deriveViewMode(params: URLSearchParams): ViewMode {
  const explicit = params.get('view');
  if (explicit === 'brief' || explicit === 'console') return explicit;
  // Inline embed tokens: importing parseEmbedParam would cycle through url.ts.
  const embed = params.get('embed');
  if (
    (embed === 'true' || embed === '1') &&
    !params.get('select') &&
    ['layers', 'region', 'cluster', 'ocean', 'framing'].some((k) => params.has(k))
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
