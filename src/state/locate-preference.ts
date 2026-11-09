/**
 * Locate's one stored value (owner direction 2026-11-09 (sprint), DR-pending).
 *
 * The launch preference is the ONLY thing Locate ever writes to storage: the
 * word `yes` or the word `no`. `yes` means "find my place when I open the
 * map"; `no` means the person has seen the offer and declined or left the
 * box clear. No position, no place name, no time and no count is stored
 * here or anywhere else (src/state/geolocate.ts holds the point in memory
 * only).
 *
 * Why its own file: the launch check runs at boot, and the state machine,
 * the card and the marker must not. This module is the few lines both
 * halves share, so the entry chunk carries only these.
 *
 * Storage can be absent or forbidden (private browsing, a blocked site
 * setting): merely touching `localStorage` may throw there. Every access is
 * wrapped, and the honest reading is `unavailable`: Locate then makes no
 * launch offer (it could not remember a "not now") and hides the option.
 *
 * Kept import-free on purpose, so `node --test` can load it with Node's type
 * stripping and no resolve hook.
 */

/** The storage key. The value is `yes` or `no`, nothing else. */
export const LAUNCH_PREFERENCE_KEY = 'ddm.locate.launch';

/** `unset`: first launch. `unavailable`: this browser will not hold the choice. */
export type LaunchPreference = 'yes' | 'no' | 'unset' | 'unavailable';

/** The two members of the Storage interface this module uses. */
export interface PreferenceStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The default store. A thunk, because reading the property can itself throw. */
export function browserStore(): PreferenceStore {
  return window.localStorage;
}

/** Read the launch preference. Never throws. */
export function readLaunchPreference(
  store: () => PreferenceStore = browserStore
): LaunchPreference {
  try {
    const value = store().getItem(LAUNCH_PREFERENCE_KEY);
    return value === 'yes' || value === 'no' ? value : 'unset';
  } catch {
    return 'unavailable';
  }
}

/** Store the launch preference. Returns false when the browser refused. Never throws. */
export function writeLaunchPreference(
  value: 'yes' | 'no',
  store: () => PreferenceStore = browserStore
): boolean {
  try {
    store().setItem(LAUNCH_PREFERENCE_KEY, value);
    return true;
  } catch {
    return false;
  }
}
