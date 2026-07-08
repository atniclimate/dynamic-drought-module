/**
 * Temporal-axis state store (0.5.0b, critical-review Section 5).
 *
 * Holds the restorable "when" of the view, parallel to the LayerRegistry's
 * "what": the selected US Drought Monitor (USDM) week, the USDM view mode
 * (absolute categories or the change map), and the selected Sea Surface
 * Temperature (SST) anomaly frame date. All of it round-trips through the
 * URL (CLAUDE.md section 6 invariant 2) via three parameters the sidebar's
 * `pushUrl` serializes and `applyUrlState` restores:
 *
 *   week    YYYYMMDD USDM valid-Tuesday; absent = the current week
 *   dmode   'chg1' | 'chg4' (the 1-week / 4-week change map); absent =
 *           absolute D0-D4 categories
 *   sst     YYYY-MM-DD SST anomaly frame; absent = the latest frame
 *
 * Playback state is deliberately NOT stored or serialized: the maintainer
 * ratified (2026-07-08, the 0.5.0b grammar decision) that a shared link
 * lands on the exact dated frame, paused; playing is always a fresh user
 * gesture. This keeps shared links polite on rural bandwidth and honest
 * under prefers-reduced-motion.
 *
 * The store is a plain observable singleton, mirroring the LayerRegistry
 * pattern (src/state/registry.ts): synchronous setters, snapshot getters,
 * and a change event the sidebar subscribes to for URL sync.
 */

/** USDM surface view mode: absolute categories, or the honest derivative. */
export type UsdmViewMode = 'absolute' | 'chg1' | 'chg4';

/** Which CPC drought outlook register the outlook surface renders. */
export type OutlookRange = 'monthly' | 'seasonal';

/** The set of valid `dmode` URL tokens, for parse-time validation. */
const USDM_MODES: ReadonlySet<string> = new Set(['chg1', 'chg4']);

/** `week` parameter shape: eight digits, YYYYMMDD. Validity beyond shape
 * (a real published valid-Tuesday) is enforced by the USDM module against
 * the enumerated week list; an unknown week snaps to the nearest stop. */
const WEEK_RE = /^\d{8}$/;

/** `sst` parameter shape: YYYY-MM-DD. */
const SST_RE = /^\d{4}-\d{2}-\d{2}$/;

type TimelineListener = () => void;

class TimelineStore {
  private usdmWeekValue: string | null = null;
  private usdmModeValue: UsdmViewMode = 'absolute';
  private sstDateValue: string | null = null;
  private outlookRangeValue: OutlookRange = 'seasonal';

  private readonly listeners: TimelineListener[] = [];

  /** Selected USDM valid-Tuesday (YYYYMMDD), or null for the current week. */
  get usdmWeek(): string | null {
    return this.usdmWeekValue;
  }

  /** USDM view mode: absolute fills or the 1-week / 4-week change map. */
  get usdmMode(): UsdmViewMode {
    return this.usdmModeValue;
  }

  /** Selected SST anomaly frame date (YYYY-MM-DD), or null for the latest. */
  get sstDate(): string | null {
    return this.sstDateValue;
  }

  /** The CPC drought outlook register ('seasonal' is the historic default,
   * matching what the 'drought' layer rendered before the temporal axis). */
  get outlookRange(): OutlookRange {
    return this.outlookRangeValue;
  }

  setUsdmWeek(week: string | null): void {
    const next = week !== null && WEEK_RE.test(week) ? week : null;
    if (next === this.usdmWeekValue) return;
    this.usdmWeekValue = next;
    this.emit();
  }

  setUsdmMode(mode: UsdmViewMode): void {
    if (mode === this.usdmModeValue) return;
    this.usdmModeValue = mode;
    this.emit();
  }

  setSstDate(date: string | null): void {
    const next = date !== null && SST_RE.test(date) ? date : null;
    if (next === this.sstDateValue) return;
    this.sstDateValue = next;
    this.emit();
  }

  setOutlookRange(range: OutlookRange): void {
    if (range === this.outlookRangeValue) return;
    this.outlookRangeValue = range;
    this.emit();
  }

  /** Reset every temporal selection to "now" (the parameterless URL). */
  reset(): void {
    const dirty =
      this.usdmWeekValue !== null ||
      this.usdmModeValue !== 'absolute' ||
      this.sstDateValue !== null ||
      this.outlookRangeValue !== 'seasonal';
    this.usdmWeekValue = null;
    this.usdmModeValue = 'absolute';
    this.sstDateValue = null;
    this.outlookRangeValue = 'seasonal';
    if (dirty) this.emit();
  }

  /**
   * Subscribe to any temporal-state change. Returns an unsubscribe
   * function. Fires synchronously after each mutating setter.
   */
  onChange(listener: TimelineListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  private emit(): void {
    for (const listener of this.listeners.slice()) listener();
  }
}

/** Process-wide singleton, mirroring `registry` in src/state/registry.ts. */
export const timeline = new TimelineStore();

/** Parse-time validation for the `dmode` URL parameter. */
export function parseUsdmMode(raw: string | null): UsdmViewMode {
  return raw !== null && USDM_MODES.has(raw) ? (raw as UsdmViewMode) : 'absolute';
}

/** Parse-time validation for the `week` URL parameter. */
export function parseUsdmWeek(raw: string | null): string | null {
  return raw !== null && WEEK_RE.test(raw) ? raw : null;
}

/** Parse-time validation for the `sst` URL parameter. */
export function parseSstDate(raw: string | null): string | null {
  return raw !== null && SST_RE.test(raw) ? raw : null;
}

/** Parse-time validation for the `outlook` URL parameter. */
export function parseOutlookRange(raw: string | null): OutlookRange {
  return raw === 'monthly' ? 'monthly' : 'seasonal';
}
