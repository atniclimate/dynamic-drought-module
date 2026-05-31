/**
 * Small shared type guards.
 *
 * `isObject` was duplicated verbatim across the impact sources, the ENSO
 * reader, and the popups module; it lives here so the narrowing is declared
 * once. Pure and stateless, so importing it changes no behavior.
 */

/** Narrow an unknown value to a non-null object (a property bag). */
export function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object';
}
