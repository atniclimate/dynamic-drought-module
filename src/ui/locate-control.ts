/**
 * Locate: the button and the launch check (owner direction 2026-11-09
 * (sprint), DR-pending).
 *
 * This is the EAGER half and it is deliberately almost nothing: one button
 * seated under SAT in the phone column's view tools, one polite status
 * region that exists from boot (so a screen reader has found it before the
 * first press), and the launch check. The state machine, the card, the
 * marker, the place resolution and the stylesheet arrive as one lazy chunk
 * (src/ui/locate-runtime.ts) on the first press or the first eligible
 * launch.
 *
 * THE LAUNCH RULE. The browser's permission question is never raised by a
 * page load. A first launch makes an OFFER (a card; one tap to locate, one
 * to dismiss). A later launch locates by itself only when the stored
 * preference is `yes` AND the Permissions API says the permission is
 * already granted, which is the one case where asking the device cannot
 * raise a question. A browser without that API therefore never locates on
 * launch; the button is all it shows. A launch that opens a shared place
 * (`select=`) or a studio makes no offer and no automatic read: the link is
 * the ask.
 *
 * The button rides the column only while the phone shell is active; on
 * desktop and in an embed it waits, hidden, on the column's bench
 * (src/ui/edge-column.ts), so no phone chrome leaks into either (B13).
 */

import type * as maplibregl from 'maplibre-gl';

import { readLaunchPreference } from '../state/locate-preference';
import { studioOwnsScreen } from '../state/studio-route';
import { seatEdgeControl } from './edge-column';
import { showToast } from './overlay';

/** What the lazy half answers to. */
export interface LocateApi {
  /** The button was pressed: start, cancel or clear, by state. */
  press(): void;
  /** First launch: show the offer card. */
  offer(): void;
  /** A later launch with the preference on and the permission already granted. */
  locateOnLaunch(): void;
}

/**
 * A person standing in a ring: the same two parts the map marker and its
 * accuracy ring draw. The ring is open behind the figure.
 */
const GLYPH =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
  '<circle cx="12" cy="4.6" r="2.3"/><path d="M8.7 14.4v-2.2a3.3 3.3 0 0 1 6.6 0v2.2"/>' +
  '<path class="locate-ring" d="M17.2 15.9a8.5 3.4 0 1 1-10.4 0"/></svg>';

export function initLocateControl(map: maplibregl.Map, deepLinkBoot: boolean): void {
  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'locate-btn';
  // The name leads with the visible word (WCAG 2.5.3).
  button.setAttribute('aria-label', 'Locate: find my place');
  button.setAttribute('aria-pressed', 'false');
  button.innerHTML = GLYPH;

  const status = document.createElement('div');
  status.id = 'locate-status';
  status.className = 'sr-only';
  status.setAttribute('role', 'status');
  document.getElementById('map-container')?.appendChild(status);

  seatEdgeControl(button, { group: 'view', order: 20, word: 'Locate' });

  let runtime: Promise<LocateApi> | null = null;
  const load = (): Promise<LocateApi> => {
    runtime ??= import('./locate-runtime').then((module) => module.createLocate(map, button, status));
    // A chunk that failed to load is asked for again by the next press.
    runtime.catch(() => {
      runtime = null;
    });
    return runtime;
  };

  button.addEventListener('click', () => {
    void load().then(
      (api) => api.press(),
      () => showToast('Locate could not load. Check your connection and try again.')
    );
  });

  // The launch check runs once the boot has settled, and only where the
  // button is on screen: the offer points at it.
  void window.__ddm?.ready.then(() => {
    if (deepLinkBoot || studioOwnsScreen() || !button.closest('#edge-column')) return;
    const preference = readLaunchPreference();
    if (preference === 'unset') {
      void load().then((api) => api.offer(), () => undefined);
    } else if (preference === 'yes') {
      void navigator.permissions?.query({ name: 'geolocation' }).then(
        (permission) => {
          if (permission.state === 'granted') void load().then((api) => api.locateOnLaunch(), () => undefined);
        },
        () => undefined
      );
    }
  });
}
