import { syncFire3dParam } from './url';

/**
 * Shared 3D Fire mode preference store (W3), shaped like basemap-store.
 *
 * The preference is the user's durable ask ("show the Fire view in 3D"),
 * round-tripped through the URL as the additive `fire3d=true` parameter.
 * It is deliberately NOT the mode's activation state: the fire3d
 * orchestrator (src/map/fire3d.ts) gates activation on this preference AND
 * the desktop width query AND the terrain capability AND the committed
 * cluster condition, so the preference can honestly outlive a temporary
 * gate failure (a cluster switch, a narrow resize) and re-apply when the
 * gate reopens. The store deliberately knows nothing about MapLibre.
 *
 * URL discipline: `setFire3DPreference` (a user choice or a forced honest
 * demotion after a terrain failure) writes the parameter through
 * `syncFire3dParam`; `seedFire3DPreference` (the boot seed from the parsed
 * URL, src/ui/sidebar.ts applyUrlStateSync) never writes the URL, matching
 * the basemap seed's no-redundant-write behavior.
 */

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
