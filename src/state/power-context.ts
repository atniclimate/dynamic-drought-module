/**
 * What the power layer currently has on screen.
 *
 * A three-field store exists here, rather than a getter exported from
 * `src/layers/power-3d.ts`, for one reason worth recording: the 3D Fire
 * orchestrator needs to know whether power is rendering so its embed
 * disclosure describes the actual scene, and importing that getter from
 * the layer module would drag the whole power layer (and its popup
 * builders, and their transitive weight) into the 3D mode's
 * first-activation closure. The activation-budget gate caught exactly
 * that: the closure went from 8.7 kB to 26.2 kB gzip for a boolean.
 *
 * So the layer WRITES here and the orchestrator READS here, and neither
 * imports the other. The value is presentation truth only: it never
 * enters the URL, and nothing reads it to decide whether to activate.
 */

/** What actually activated, for truth-preserving downstream disclosures. */
export interface PowerContextState {
  readonly linesOn: boolean;
  readonly plantsOn: boolean;
  /** Issuer reporting period label: 'YYYY-MM', 'mixed reporting periods',
   * or 'unreported'; null while the plants surface is off. */
  readonly periodLabel: string | null;
}

let current: PowerContextState | null = null;

/** The power surfaces currently rendered, or null when none are. */
export function getPowerContextState(): PowerContextState | null {
  return current;
}

/** Record what the power layer rendered; null when it drew nothing. */
export function setPowerContextState(next: PowerContextState | null): void {
  current = next;
}
