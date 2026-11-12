/**
 * The phone shell's 3D cell (owner direction 2026-11-09 (sprint),
 * DR-pending): the one explicit way a phone enters the 3D Fire view.
 *
 * WHERE IT IS. One cell in the right-edge column's view tools, under SAT
 * (and under Locate when that is seated): `seatEdgeControl` with group
 * 'view', order 30, word '3D'. The column gives it the cell face, and
 * `aria-pressed="true"` inverts it, like every selected control.
 *
 * WHEN IT EXISTS. Only where pressing it means something: Fire is the
 * person's hazard view, and this phone can hold the scene (the WebGL 2 probe
 * passed, the screen is at least FIRE3D_PHONE_MIN_WIDTH_PX wide and
 * FIRE3D_PHONE_MIN_HEIGHT_PX tall). Everywhere else it is ABSENT (`hidden`),
 * never disabled, so the column never shows a dead control and re-plans as
 * if it were not there. `fire3dPhoneOffer` is the whole decision.
 *
 * WHAT A PRESS DOES. It sets the same durable preference the desktop
 * console's button sets (`fire3d=true` in the URL), after committing the
 * Wildfire view the way that button does when the display is the phone's
 * own Fire set: the scene enters only from Wildfire's own layers
 * (`shouldFire3DBeActive`), and `cluster=wildfire&fire3d=true` is a link
 * that opens the same way on a phone and on a desk. It does not touch the
 * basemap: imagery the person has on is held while the scene is up and
 * comes back when it leaves. Pressing the inverted cell clears the
 * preference: that is Exit, and it is Cancel while the entry is still
 * loading.
 *
 * WHAT STAYS LAZY. This file is all the entry chunk pays: a button and a
 * decision. The scene's own chunk (src/map/fire3d.ts) is loaded by
 * src/main.ts when the URL names the mode, which on a phone happens only
 * through this press or a shared link, never because the view is Wildfire.
 * The card, the camera pad and their stylesheet ride a second lazy chunk
 * (src/ui/fire3d-phone-scene.ts) asked for at the same moment.
 *
 * NO CARD, NO SCENE. The scene's gate admits a phone only while that second
 * chunk has mounted its card, which is where the terrain coverage statement
 * and the non-prediction disclosure stand on a phone. If the chunk cannot
 * load, the preference is withdrawn and the flat map says why.
 *
 * A phone that cannot hold the scene but was sent a `fire3d=true` link gets
 * no cell and ONE sentence, once, in the words the console uses for the
 * same refusal (the second chunk says it, so the entry carries no sentence
 * it rarely needs). The preference itself is kept, as it is on a short
 * desktop window: it is the person's durable ask, and the gate, not the
 * URL, decides.
 */

import type * as maplibregl from 'maplibre-gl';

import { FIRE3D_PHONE_MIN_HEIGHT_QUERY, fire3dPhoneOffer } from '../config/fire3d-phone';
import { webGl2Capability } from '../map/gl-capability';
import {
  getCommittedSnapshot,
  onCommittedSnapshotChange,
  requestCluster
} from '../state/cluster-service';
import {
  FIRE3D_CHUNK_WIDTH_QUERY,
  getFire3DPreference,
  onFire3DPreferenceChange,
  setFire3DPreference
} from '../state/fire3d-store';
import { createChunkLoader } from '../util/chunk-retry';
import { askAgainForStylesheets } from '../util/chunk-stylesheets';
import { seatEdgeControl } from './edge-column';
import type { Fire3DPhoneScene } from './fire3d-phone-scene';
import { showToast } from './overlay';

/** The phone shell exists exactly while #app carries this (src/ui/mobile-sheet.ts). */
const SHELL_ATTRIBUTE = 'data-sheet-detent';

/** A map tilted into perspective, which is what the press does. */
const GLYPH =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 19 7 7h10l4 12z"/><path d="M5 13h14M10 7l-1 12M14 7l1 12"/></svg>';

/** The failure ladder's own sentence (src/map/fire3d.ts `failScene`), for the one failure that happens before it loads. */
const UNAVAILABLE = '3D Fire view unavailable; the flat map remains accurate.';

/**
 * The chrome's chunk. After a failure the next ask imports it under a new URL
 * (src/util/chunk-retry.ts), which brings the module alone, so its failed
 * stylesheet is asked for first (src/util/chunk-stylesheets.ts).
 */
const loadScene = createChunkLoader(
  () => import('./fire3d-phone-scene'),
  import.meta.url,
  undefined,
  askAgainForStylesheets
);

let wired = false;

/**
 * Create the cell, seat it, and keep it true to the view and the device.
 * Idempotent. Call after the right-edge column and the phone sheet exist.
 */
export function initFire3DPhone(map: maplibregl.Map): void {
  const app = document.getElementById('app');
  if (wired || !app) return;
  wired = true;

  const cell = document.createElement('button');
  cell.type = 'button';
  cell.id = 'fire3d-phone-cell';
  cell.hidden = true;
  // The console button's own words; they contain the word the cell shows (WCAG 2.5.3).
  cell.setAttribute('aria-label', '3D Fire view');
  cell.innerHTML = GLYPH;
  seatEdgeControl(cell, { group: 'view', order: 30, word: '3D' });

  const width = window.matchMedia(FIRE3D_CHUNK_WIDTH_QUERY);
  const height = window.matchMedia(FIRE3D_PHONE_MIN_HEIGHT_QUERY);
  let scene: Fire3DPhoneScene | null = null;
  let loading = false;

  const sync = (): void => {
    const snapshot = getCommittedSnapshot();
    const offer = fire3dPhoneOffer({
      phoneShell: app.hasAttribute(SHELL_ATTRIBUTE),
      fireView: snapshot.cluster === 'wildfire' || snapshot.selectedHazard === 'wildfire',
      webgl2: webGl2Capability().webgl2,
      wideEnough: width.matches,
      tallEnough: height.matches
    });
    const asked = getFire3DPreference();
    cell.hidden = offer !== 'cell';
    cell.setAttribute('aria-pressed', String(asked));
    if (scene) {
      scene.set(offer, asked);
      return;
    }
    // The chrome is asked for only when there is a scene to keep honest, or
    // a shared link to answer with one sentence.
    if (loading || !asked || offer === 'silent') return;
    loading = true;
    // A chrome that refuses to draw (its stylesheet missing) fails here too.
    void loadScene()
      .then(({ createFire3DPhoneScene }) => createFire3DPhoneScene(map, app))
      .then(
        (created) => {
          scene = created;
          sync();
        },
        () => {
          loading = false;
          // No card, no scene: withdraw the ask and say so.
          setFire3DPreference(false);
          showToast(UNAVAILABLE);
        }
      );
  };

  cell.addEventListener('click', () => {
    const asked = getFire3DPreference();
    if (!asked && getCommittedSnapshot().cluster !== 'wildfire') {
      // The scene enters only from Wildfire's own layers, so the phone's own
      // Fire set is committed as that view first, as the console's button
      // does. The basemap stays the person's own, which the console's button
      // does not do: the rail's Fire view opens on imagery, the scene holds
      // imagery off while it is opening or open (`holdSatellite`, DR-105),
      // and leaving the scene brings it back.
      requestCluster('wildfire');
    }
    setFire3DPreference(!asked);
  });

  onFire3DPreferenceChange(sync);
  onCommittedSnapshotChange(sync);
  width.addEventListener('change', sync);
  height.addEventListener('change', sync);
  // The attribute's presence is the phone shell. Its value is the sheet's
  // stop, so this also runs when the sheet settles; `sync` only restates
  // what already holds then.
  new MutationObserver(sync).observe(app, { attributes: true, attributeFilter: [SHELL_ATTRIBUTE] });
  sync();
}
