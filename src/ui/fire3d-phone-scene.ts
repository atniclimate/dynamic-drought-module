/**
 * The phone shell's 3D chrome (owner direction 2026-11-09 (sprint),
 * DR-pending): the card that keeps the scene honest, and the pad that
 * turns and tilts it with one thumb.
 *
 * Loaded lazily by src/ui/fire3d-phone.ts the first time a phone asks for
 * the scene, with its stylesheet, so no other session pays for it.
 *
 * THE CARD is the phone's answer to docs/design/fire3d-context.md ("the
 * disclosure lives in the interface"). The desktop console keeps the terrain
 * coverage statement and the non-prediction disclosure beside its button;
 * an embed prints them on the map. A phone has neither seat, so they stand
 * on the map surface in one glass card for as long as the scene is asked
 * for: no close control, no tooltip, no tap. The words are the config's own
 * (src/config/fire3d-presentation.ts), never retyped here. The same card is
 * the entry's loading surface (docs/design/fire3d-entry.md): it names the
 * step the scene is waiting on, shows an indeterminate bar, and offers
 * Cancel, which withdraws the preference exactly as that note rules.
 *
 * NO CARD, NO SCENE. While the card is mounted for a wanted scene, #app
 * carries FIRE3D_PHONE_CHROME_ATTRIBUTE, and the scene's gate
 * (src/map/fire3d.ts `presentingShell`) admits a phone only then.
 *
 * THE PAD is five 44 px targets in a plus: tilt up, turn left, the compass,
 * turn right, tilt down. The compass shows which way the view faces and a
 * press on it returns north-up at the scene's opening tilt. It is camera
 * chrome: it changes how the same mapped data is seen and claims nothing,
 * so none of it enters the URL. Under reduced motion a press jumps.
 *
 * HOLDS. While mounted the chrome makes sure two-finger tilt and two-finger
 * rotate are on (MapLibre's `touchPitch` and `touchZoomRotate`), remembering
 * what it found, and puts exactly that back when it leaves. Every listener,
 * observer, node and custom property added here is removed in `unmount`.
 */

import '../styles/fire3d-phone.css';

import type * as maplibregl from 'maplibre-gl';

import {
  FIRE3D_PAD_ACTIONS,
  FIRE3D_PAD_EASE_MS,
  fire3dCameraAnnouncement,
  fire3dCompassName,
  fire3dCompassPoint,
  fire3dPadAtStop,
  fire3dPadTarget
} from '../config/fire3d-camera';
import type { Fire3DCamera, Fire3DPadAction } from '../config/fire3d-camera';
import { FIRE3D_PHONE_CHROME_ATTRIBUTE } from '../config/fire3d-phone';
import type { Fire3DPhoneOffer } from '../config/fire3d-phone';
import {
  FIRE3D_COVERAGE_NOTE,
  FIRE3D_ENTRY_TEXT,
  FIRE3D_NON_PREDICTION_NOTE,
  FIRE3D_OUT_OF_COVERAGE_STATUS,
  FIRE3D_PARTIAL_COVERAGE_STATUS,
  FIRE3D_PHONE_REFUSAL_TEXT,
  FIRE3D_PITCH_DEGREES,
  fire3dCoverageNote
} from '../config/fire3d-presentation';
import type { Fire3DStatus } from '../map/fire3d';
import { loadFire3DController } from '../map/fire3d-chunk';
import { getCommittedSnapshot } from '../state/cluster-service';
import { getFire3DPreference, setFire3DPreference } from '../state/fire3d-store';
import { registry } from '../state/registry';
import { prefersReducedMotion } from '../util/motion';
import { showToast } from './overlay';

/** What the eager cell asks of this chrome. */
export interface Fire3DPhoneScene {
  /**
   * `offer`: what stands where the 3D cell would be (`fire3dPhoneOffer`).
   * `asked`: the durable preference (`fire3d=true`). The scene is wanted
   * when the cell is offered and the preference is set.
   */
  set(offer: Fire3DPhoneOffer, asked: boolean): void;
}

/** The catalog key whose status the status line reads, as the console's control does. */
const HMS_SMOKE_LAYER_KEY = 'hms-smoke';

/** Present on #app while the card is in the document, in any form: the seats that make room for it key on this. */
const CARD_ATTRIBUTE = 'data-fire3d-card';
const CARD_BOTTOM_PROPERTY = '--fire3d-card-bottom';
const CARD_HEIGHT_PROPERTY = '--fire3d-card-h';
/** Clear ground kept between the card and the pad, px. */
const PAD_CLEARANCE_PX = 8;

/**
 * The status sentences, word for word the console control's own
 * (`statusLine` and `emptySmokeLine` in src/ui/island/fire3d-control.tsx;
 * tests/fire3d-phone.test.mjs fails if either side changes alone). They
 * speak the six honest layer states and nothing else.
 */
const LIVE = 'Live: terrain relief with the smoke volume.';
const LIVE_PARTIAL_UNAVAILABLE = 'Live (partial): terrain relief; smoke is unavailable.';
const LIVE_PARTIAL_VEIL = 'Live (partial): terrain relief; smoke stays in the flat veil.';
const EMPTY_SMOKE = 'No current smoke plumes in view; the issuer returned none for this area.';
/** The one failure the orchestrator cannot name, because it never arrived. */
const CHUNK_UNAVAILABLE = 'Unavailable. The 3D view did not load.';
/**
 * Why a press did not open the scene: the Wildfire view was applied, but
 * layers a person added are still on, so the display is a custom set and
 * the scene, which enters only from Wildfire's own layers
 * (`shouldFire3DBeActive`), has nothing to enter from.
 */
const CUSTOM_SET_UNAVAILABLE =
  'Unavailable. 3D opens from the Fire view\'s own layers; turn off the layers you added, then press 3D again.';

const PAD_NAMES: Readonly<Record<Exclude<Fire3DPadAction, 'reset'>, string>> = {
  'tilt-up': 'Tilt up, toward the horizon',
  'tilt-down': 'Tilt down, toward straight overhead',
  'rotate-left': 'Rotate left',
  'rotate-right': 'Rotate right'
};

const SVG_OPEN =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">';
const PAD_GLYPHS: Readonly<Record<Fire3DPadAction, string>> = {
  'tilt-up': `${SVG_OPEN}<path d="m6 14 6-6 6 6"/></svg>`,
  'tilt-down': `${SVG_OPEN}<path d="m6 10 6 6 6-6"/></svg>`,
  'rotate-left': `${SVG_OPEN}<path d="M4.5 12a7.5 7.5 0 1 0 2.6-5.7"/><path d="M4.5 4.5v4.3h4.3"/></svg>`,
  'rotate-right': `${SVG_OPEN}<path d="M19.5 12a7.5 7.5 0 1 1-2.6-5.7"/><path d="M19.5 4.5v4.3h-4.3"/></svg>`,
  // A needle: the solid half points north on the ground.
  reset:
    '<svg class="fire3d-pad-needle" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path d="M12 2.5 16 12H8z" fill="currentColor"/><path d="M8 12l4 9.5 4-9.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>'
};

interface TouchHold {
  readonly pitch: boolean;
  readonly zoomRotate: boolean;
  readonly rotationOff: boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Build the chrome for this map. Nothing touches the document until the
 * first `set(true, ...)`.
 */
export function createFire3DPhoneScene(map: maplibregl.Map, app: HTMLElement): Fire3DPhoneScene {
  // -------------------------------------------------------------------------
  // The card
  // -------------------------------------------------------------------------
  const card = el('section', 'fire3d-card');
  card.id = 'fire3d-phone-card';
  card.setAttribute('aria-labelledby', 'fire3d-card-title');

  const head = el('div', 'fire3d-card-head');
  const heading = el('div', 'fire3d-card-heading');
  // The view's own name (docs/design/fire3d-context.md: every surface calls it a 3D context view).
  const title = el('h2', 'fire3d-card-title', '3D context view');
  title.id = 'fire3d-card-title';
  // The step or state sentence is its own polite, atomic live node; Cancel is never inside it.
  const line = el('p', 'fire3d-card-status');
  line.setAttribute('role', 'status');
  line.setAttribute('aria-live', 'polite');
  line.setAttribute('aria-atomic', 'true');
  heading.append(title, line);
  const action = el('button', 'fire3d-card-action');
  action.type = 'button';
  const actionWord = el('span', 'fire3d-card-action-word');
  action.appendChild(actionWord);
  head.append(heading, action);

  // The rule under the head; while the entry loads it is also the progress bar (see `render`).
  const bar = el('div', 'fire3d-card-bar');
  bar.appendChild(el('i', 'fire3d-card-band'));

  const notes = el('div', 'fire3d-card-notes');
  const disclosure = el('p', 'fire3d-card-note', FIRE3D_NON_PREDICTION_NOTE);
  disclosure.dataset['fire3dDisclosure'] = '';
  const coverage = el('p', 'fire3d-card-note', FIRE3D_COVERAGE_NOTE);
  coverage.dataset['fire3dCoverage'] = '';
  const gap = el('p', 'fire3d-card-note fire3d-card-answer');
  gap.dataset['fire3dOutOfCoverage'] = '';
  const smoke = el('p', 'fire3d-card-note fire3d-card-answer');
  smoke.dataset['fire3dEmptySmoke'] = '';
  notes.append(disclosure, coverage, gap, smoke);
  card.append(head, bar, notes);

  // -------------------------------------------------------------------------
  // The pad
  // -------------------------------------------------------------------------
  const pad = el('div', 'fire3d-pad');
  pad.id = 'fire3d-phone-pad';
  pad.setAttribute('role', 'group');
  pad.setAttribute('aria-label', '3D camera');
  pad.hidden = true;
  const buttons = new Map<Fire3DPadAction, HTMLButtonElement>();
  const compassWord = el('span', 'fire3d-pad-word');
  for (const name of FIRE3D_PAD_ACTIONS) {
    const button = el('button', 'fire3d-pad-btn');
    button.type = 'button';
    button.dataset['pad'] = name;
    button.innerHTML = PAD_GLYPHS[name];
    if (name === 'reset') button.appendChild(compassWord);
    else button.setAttribute('aria-label', PAD_NAMES[name]);
    button.addEventListener('click', () => press(name));
    buttons.set(name, button);
    pad.appendChild(button);
  }
  const said = el('span', 'sr-only');
  said.setAttribute('role', 'status');
  said.setAttribute('aria-live', 'polite');
  pad.appendChild(said);

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------
  let mounted = false;
  let wanted = false;
  /** The refusal already said to a shared link, so one sentence stays one sentence. */
  let refused: Fire3DPhoneOffer | null = null;
  /** The scene's status, once its chunk has answered; null before. */
  let status: Fire3DStatus | null = null;
  let subscribed = false;
  /** The reason a scene that was asked for is not there; shown until dismissed, retried or left. */
  let failure: string | null = null;
  /** The scene's own sources have all reported loaded at least once in this activation. */
  let settledOnce = false;
  let hold: TouchHold | null = null;
  let announce = false;
  let frame = 0;
  let cardObserver: ResizeObserver | null = null;
  let appObserver: MutationObserver | null = null;
  let offSmoke: (() => void) | null = null;

  const camera = (): Fire3DCamera => ({ pitch: map.getPitch(), bearing: map.getBearing() });
  const limits = () => ({ maxPitch: map.getMaxPitch(), homePitch: FIRE3D_PITCH_DEGREES });
  const live = (): boolean => wanted && status?.state === 'active';

  // -------------------------------------------------------------------------
  // The camera
  // -------------------------------------------------------------------------
  function press(name: Fire3DPadAction): void {
    if (!live()) return;
    const from = camera();
    if (fire3dPadAtStop(name, from, limits())) return;
    const target = fire3dPadTarget(name, from, limits());
    announce = true;
    if (prefersReducedMotion()) map.jumpTo(target);
    else map.easeTo({ ...target, duration: FIRE3D_PAD_EASE_MS });
  }

  /** The needle and the stops follow the camera frame by frame; the words wait for it to stop. */
  const paintCompass = (): void => {
    const now = camera();
    const needle = buttons.get('reset')?.querySelector<SVGElement>('.fire3d-pad-needle');
    if (needle) needle.style.transform = `rotate(${(-now.bearing).toFixed(1)}deg)`;
    const word = fire3dCompassPoint(now.bearing).short;
    if (compassWord.textContent !== word) compassWord.textContent = word;
    for (const [name, button] of buttons) {
      const stopped = fire3dPadAtStop(name, now, limits());
      if (stopped) button.setAttribute('aria-disabled', 'true');
      else button.removeAttribute('aria-disabled');
    }
  };
  const nameCompass = (): void => {
    const now = camera();
    buttons.get('reset')?.setAttribute('aria-label', fire3dCompassName(now));
    if (!announce) return;
    announce = false;
    said.textContent = fire3dCameraAnnouncement(now);
  };

  function takeTouchHold(): TouchHold {
    const rotation = map.touchZoomRotate as unknown as { _rotationDisabled?: boolean };
    const found: TouchHold = {
      pitch: map.touchPitch.isEnabled(),
      zoomRotate: map.touchZoomRotate.isEnabled(),
      rotationOff: rotation._rotationDisabled === true
    };
    if (!found.pitch) map.touchPitch.enable();
    if (!found.zoomRotate) map.touchZoomRotate.enable();
    if (found.rotationOff) map.touchZoomRotate.enableRotation();
    return found;
  }
  function releaseTouchHold(found: TouchHold): void {
    if (!found.pitch) map.touchPitch.disable();
    if (found.rotationOff) map.touchZoomRotate.disableRotation();
    if (!found.zoomRotate) map.touchZoomRotate.disable();
  }

  // -------------------------------------------------------------------------
  // What the card says
  // -------------------------------------------------------------------------
  const smokeStatus = (): string | undefined => registry.getStatus(HMS_SMOKE_LAYER_KEY);

  function render(): void {
    if (!mounted) return;
    const state = status?.state ?? 'inactive';
    const failed = !wanted && failure !== null;
    const up = wanted && state === 'active';
    const loading = wanted && !(up && settledOnce);

    // One sentence: why a scene that was asked for is not there, else the
    // state of the one that is, else the step its entry is waiting on. A
    // wanted scene whose controller still reads the last try's `unavailable`
    // is a new entry that has not published yet, so it reads as loading.
    let text: string;
    if (failed) text = failure ?? '';
    else if (up && settledOnce) {
      text = status?.smokeVolume
        ? LIVE
        : smokeStatus() === 'error'
          ? LIVE_PARTIAL_UNAVAILABLE
          : LIVE_PARTIAL_VEIL;
    } else if (up) text = FIRE3D_ENTRY_TEXT.terrain;
    else if (state === 'checking') text = FIRE3D_ENTRY_TEXT[status?.phase ?? 'probe'];
    else text = FIRE3D_ENTRY_TEXT.chunk;
    if (line.textContent !== text) line.textContent = text;

    card.dataset['state'] = failed
      ? 'unavailable'
      : loading
        ? 'loading'
        : status?.smokeVolume
          ? 'live'
          : 'partial';
    if (loading) {
      card.setAttribute('aria-busy', 'true');
      // Indeterminate: a name and no value (docs/design/fire3d-entry.md, "Accessibility and words").
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-label', 'Loading the 3D view');
      bar.removeAttribute('aria-hidden');
    } else {
      card.removeAttribute('aria-busy');
      bar.removeAttribute('role');
      bar.removeAttribute('aria-label');
      bar.setAttribute('aria-hidden', 'true');
    }
    bar.hidden = failed;
    notes.hidden = failed;

    // Cancel while the entry is loading; Close once a failed scene has said why. Nothing while it is live.
    const word = failed ? 'Close' : loading ? 'Cancel' : '';
    const hadFocus = document.activeElement === action;
    action.hidden = word === '';
    actionWord.textContent = word;
    if (word === '') action.removeAttribute('aria-label');
    else action.setAttribute('aria-label', failed ? 'Close this notice' : 'Cancel the 3D view');
    if (hadFocus && action.hidden) focusCell();

    // The coverage note names the archive that actually answered, as the console's does.
    const depth = up && status ? status.terrainMaxZoom : null;
    const note =
      depth !== null
        ? fire3dCoverageNote(status?.terrainExtent ?? depth)
        : FIRE3D_COVERAGE_NOTE;
    if (coverage.textContent !== note) coverage.textContent = note;
    const reading = up ? status?.terrainCoverage : 'full';
    const gapText =
      reading === 'none'
        ? FIRE3D_OUT_OF_COVERAGE_STATUS
        : reading === 'partial'
          ? FIRE3D_PARTIAL_COVERAGE_STATUS
          : '';
    gap.hidden = gapText === '';
    if (gap.textContent !== gapText) gap.textContent = gapText;
    const smokeText = up && status?.smokeVolume && smokeStatus() === 'no-data' ? EMPTY_SMOKE : '';
    smoke.hidden = smokeText === '';
    if (smoke.textContent !== smokeText) smoke.textContent = smokeText;

    if (up) {
      paintCompass();
      nameCompass();
    }
    schedule();
  }

  function focusCell(): void {
    document.getElementById('fire3d-phone-cell')?.focus({ preventScroll: true });
  }

  // -------------------------------------------------------------------------
  // Seats: the card under the key, the sheet under the card, the pad where it fits
  // -------------------------------------------------------------------------
  function layout(): void {
    frame = 0;
    if (!mounted) return;
    const box = card.getBoundingClientRect();
    const bottom = `${Math.ceil(box.bottom)}px`;
    const height = `${Math.ceil(box.height)}px`;
    if (app.style.getPropertyValue(CARD_BOTTOM_PROPERTY) !== bottom) {
      app.style.setProperty(CARD_BOTTOM_PROPERTY, bottom);
    }
    if (app.style.getPropertyValue(CARD_HEIGHT_PROPERTY) !== height) {
      app.style.setProperty(CARD_HEIGHT_PROPERTY, height);
    }
    // The pad waits while a panel leads (the sheet at half or full), while
    // the key or Map information is open, and wherever it would meet the card.
    const stop = app.getAttribute('data-sheet-detent');
    const mapLeads = stop === 'closed' || stop === 'peek';
    const keyOpen = document.getElementById('map-key')?.dataset['keyDetailsOpen'] === 'true';
    if (wanted && keyOpen && !mapLeads) {
      // An open key drawer pushes the card down, and a panel rising to half
      // or full would cover it there. The card may not be covered, so the
      // drawer closes: the key's own toggle event, as its chip would send.
      window.dispatchEvent(new CustomEvent('ddm:toggle-map-key-details'));
      return;
    }
    let show = live() && mapLeads && !keyOpen && !app.hasAttribute('data-map-info-open');
    if (show) {
      pad.hidden = false;
      show = pad.getBoundingClientRect().top >= box.bottom + PAD_CLEARANCE_PX;
    }
    if (pad.hidden !== !show) {
      const within = pad.contains(document.activeElement);
      pad.hidden = !show;
      if (within && !show) focusCell();
    }
  }
  function schedule(): void {
    if (frame === 0) frame = window.requestAnimationFrame(layout);
  }

  // -------------------------------------------------------------------------
  // Mounting
  // -------------------------------------------------------------------------
  function onStatus(next: Fire3DStatus): void {
    status = next;
    if (next.state === 'unavailable') failure = `Unavailable. ${next.reason ?? ''}`.trim();
    if (next.state !== 'active') settledOnce = false;
    else if (next.transport === 'settled') settledOnce = true;
    render();
  }

  function subscribe(): void {
    if (subscribed) return;
    subscribed = true;
    void loadFire3DController().then(
      (controller) => {
        // Idempotent, and the boot path may not have run it on a phone that asked later.
        controller.initFire3DController(map);
        controller.onFire3DStatusChange(() => onStatus(controller.getFire3DStatus()));
        onStatus(controller.getFire3DStatus());
      },
      () => {
        subscribed = false;
        failure = CHUNK_UNAVAILABLE;
        // The ask is withdrawn honestly, as the failure ladder does for every later failure.
        if (getFire3DPreference()) setFire3DPreference(false);
        else render();
      }
    );
  }

  function mount(): void {
    if (mounted) return;
    mounted = true;
    app.append(card, pad);
    app.setAttribute(CARD_ATTRIBUTE, '');
    map.on('rotate', paintCompass);
    map.on('pitch', paintCompass);
    map.on('moveend', nameCompass);
    offSmoke = registry.on('status-change', (key) => {
      if (key === HMS_SMOKE_LAYER_KEY) render();
    });
    if (typeof ResizeObserver === 'function') {
      cardObserver = new ResizeObserver(schedule);
      cardObserver.observe(card);
    }
    // The card's seat follows the key's measured height and the sheet's stop, both written on #app.
    appObserver = new MutationObserver(schedule);
    appObserver.observe(app, {
      attributes: true,
      attributeFilter: ['style', 'data-sheet-detent', 'data-map-info-open']
    });
    window.addEventListener('resize', schedule);
    window.addEventListener('ddm:map-key-details-change', schedule);
  }

  function unmount(): void {
    if (!mounted) return;
    mounted = false;
    const within = card.contains(document.activeElement) || pad.contains(document.activeElement);
    map.off('rotate', paintCompass);
    map.off('pitch', paintCompass);
    map.off('moveend', nameCompass);
    offSmoke?.();
    offSmoke = null;
    cardObserver?.disconnect();
    cardObserver = null;
    appObserver?.disconnect();
    appObserver = null;
    window.removeEventListener('resize', schedule);
    window.removeEventListener('ddm:map-key-details-change', schedule);
    if (frame !== 0) window.cancelAnimationFrame(frame);
    frame = 0;
    card.remove();
    pad.remove();
    pad.hidden = true;
    said.textContent = '';
    app.removeAttribute(CARD_ATTRIBUTE);
    app.style.removeProperty(CARD_BOTTOM_PROPERTY);
    app.style.removeProperty(CARD_HEIGHT_PROPERTY);
    if (within) focusCell();
  }

  /** The gate's attribute and the touch hold stand exactly while a wanted scene has its card. */
  function holdScene(next: boolean): void {
    if (next === app.hasAttribute(FIRE3D_PHONE_CHROME_ATTRIBUTE)) return;
    if (next) {
      hold = takeTouchHold();
      app.setAttribute(FIRE3D_PHONE_CHROME_ATTRIBUTE, '');
    } else {
      app.removeAttribute(FIRE3D_PHONE_CHROME_ATTRIBUTE);
      if (hold) releaseTouchHold(hold);
      hold = null;
    }
  }

  action.addEventListener('click', () => {
    if (wanted) {
      // Cancel owns the preference (docs/design/fire3d-entry.md): the URL drops fire3d and the controller tears down.
      setFire3DPreference(false);
      return;
    }
    failure = null;
    unmount();
  });
  card.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || action.hidden) return;
    event.preventDefault();
    action.click();
  });

  return {
    set(offer: Fire3DPhoneOffer, asked: boolean): void {
      const offered = offer === 'cell';
      // A phone that was sent a 3D link it cannot hold reads one sentence, once.
      if (asked && !offered && offer !== 'silent') {
        if (refused !== offer) {
          refused = offer;
          showToast(FIRE3D_PHONE_REFUSAL_TEXT[offer]);
        }
      } else {
        refused = null;
      }

      const next = offered && asked;
      const state = status?.state;
      if (
        next &&
        !wanted &&
        getCommittedSnapshot().cluster !== 'wildfire' &&
        state !== 'active' &&
        state !== 'checking'
      ) {
        // The ask cannot be met from a custom set: withdraw it and say why.
        // The withdrawal re-enters this function with `asked` false, which
        // shows the reason below.
        failure = CUSTOM_SET_UNAVAILABLE;
        setFire3DPreference(false);
        return;
      }

      wanted = next;
      if (wanted) {
        failure = null;
        mount();
        holdScene(true);
        subscribe();
        render();
        return;
      }
      holdScene(false);
      if (offered && failure !== null) {
        mount();
        render();
        return;
      }
      failure = null;
      unmount();
    }
  };
}
