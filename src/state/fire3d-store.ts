import { syncFire3dParam } from './url';

/**
 * Shared 3D Fire mode preference store (W3), shaped like the other preference stores.
 *
 * The preference is the user's durable ask ("show the Fire view in 3D"),
 * round-tripped through the URL as the additive `fire3d=true` parameter.
 * It is deliberately NOT the mode's activation state: the fire3d
 * orchestrator (src/map/fire3d.ts) gates activation on this preference AND
 * a shell that can present the scene (the desktop console at its width and
 * height, or since 2026-11-09 the phone shell with its 3D chrome mounted)
 * AND the terrain capability AND the committed cluster condition, so the
 * preference can honestly outlive a temporary gate failure (a narrow or
 * short resize, a custom set inside Wildfire) and re-apply when the gate
 * reopens. Leaving Wildfire is not temporary: DR-122 drops the
 * preference and its parameter then (src/ui/sidebar.ts). The store
 * deliberately knows nothing about MapLibre.
 *
 * URL discipline: `setFire3DPreference` (a user choice or a forced honest
 * demotion after a terrain failure) writes the parameter through
 * `syncFire3dParam`; `seedFire3DPreference` (the boot seed from the parsed
 * URL, src/ui/sidebar.ts applyUrlStateSync) never writes the URL, matching
 * the other stores' no-redundant-write behavior.
 */

/**
 * The width at which the 3D chunk may load (src/main.ts) and a `fire3d=true`
 * boot loads it (src/ui/sidebar.ts): one value, or the two disagree. Equal to
 * FIRE3D_MIN_WIDTH_QUERY in src/config/fire3d-presentation.ts, which rides
 * the lazy chunk and so cannot be imported here.
 *
 * Moved from the desktop breakpoint to the phone floor on owner direction
 * 2026-11-09 (sprint), DR-pending: a phone may enter the scene through its
 * own cell (src/ui/fire3d-phone.ts). The number is
 * FIRE3D_PHONE_MIN_WIDTH_PX in src/config/fire3d-phone.ts, which states the
 * measurement behind it; tests/fire3d-phone.test.mjs holds this constant,
 * its twin and that number together. The width only says the chunk MAY
 * load: below the desktop breakpoint src/main.ts loads it when a person has
 * asked for the scene (`fire3d=true` in the URL), never because the view is
 * Wildfire, so a phone that did not ask pays nothing.
 */
export const FIRE3D_CHUNK_WIDTH_QUERY = '(min-width: 360px)';

let preference = false;

const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((fn) => {
    fn();
  });
}

/** The current 3D Fire mode preference; false until a toggle or URL seed. */
export function getFire3DPreference(): boolean {
  return preference;
}

/**
 * Record a preference change, write it through to the URL, and notify
 * subscribers. Idempotent: setting the current value again emits nothing
 * and performs no URL write.
 */
export function setFire3DPreference(next: boolean): void {
  if (next === preference) return;
  preference = next;
  syncFire3dParam(next);
  emit();
}

/**
 * Seed the preference from the parsed URL at boot WITHOUT writing the URL
 * (the canonical first write re-emits the parameter through syncUrl's own
 * preservation read). Idempotent like the setter.
 */
export function seedFire3DPreference(next: boolean): void {
  if (next === preference) return;
  preference = next;
  emit();
}

/** Subscribe to preference changes. Returns an unsubscribe function. */
export function onFire3DPreferenceChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
