/**
 * Whether what the Fire Weather Outlook layer last read is the Storm Prediction Center's own
 * "no area outlined" answer, still inside its valid period. The layer is lazy and the Key is
 * eager, so the fact travels through this small module: the Key words "No Risk Areas Forecast"
 * only while it holds, never for an empty collection or an expired issuance, where SPC gave
 * no such answer (review, 2026-11-13).
 */

let spcNoArea = false;

export function setSpcNoArea(value: boolean): void {
  spcNoArea = value;
}

export function isSpcNoArea(): boolean {
  return spcNoArea;
}
