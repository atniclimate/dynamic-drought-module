/**
 * Locate: the lazy half (owner direction 2026-11-09 (sprint), DR-pending).
 *
 * src/ui/locate-control.ts loads this on the first press of the Locate cell
 * or the first eligible launch. It drives the pure state machine in
 * src/state/geolocate.ts from the browser's Geolocation API, and turns each
 * state into three things that always agree: the cell (idle, busy, on), the
 * card (what is happening, in one plain line, and the next step) and a
 * polite announcement.
 *
 * THE POINT LIVES HERE AND NOWHERE ELSE. The accepted position is held in
 * the reducer's state and in the marker on the map, both in memory. This
 * module writes nothing to storage but the launch preference (the word yes
 * or no), builds no URL, and makes no request: the only reads it starts are
 * the bundled state outlines and the briefing of a PLACE
 * (src/ui/locate-place.ts states what each of those sends). Leaving the
 * phone shell, cancelling, or pressing the lit cell drops the position and
 * every layer, source, timer and listener that came with it.
 *
 * ONE ATTEMPT AT A TIME. Every answer from the device carries the attempt
 * number it belongs to, and the reducer ignores any other: a late fix after
 * a cancel, a timeout or a newer press finds nothing to revive. The clock
 * runs only while the device is being read (12 seconds, the stated bound),
 * never while the person reads the browser's own question.
 */

import '../styles/locate.css';

import type * as maplibregl from 'maplibre-gl';

import { TRIBAL_NATIONS_GROUP } from '../config/layer-groups';
import { showLocateMarker } from '../map/locate-marker';
import type { LocateMarker } from '../map/locate-marker';
import {
  FIX_SETTLE_MS,
  IDLE_STATE,
  LOCATE_TIMEOUT_MS,
  accuracyLine,
  coarseCell,
  isInFlight,
  isLocated,
  locatedCopy,
  phaseCopy,
  reduceLocate,
  tribalCopy,
  tribalDisclosure
} from '../state/geolocate';
import type {
  LocateEvent,
  LocateFix,
  LocateState,
  PermissionReading,
  StateFinding,
  StateRef,
  TribalHit
} from '../state/geolocate';
import { readLaunchPreference, writeLaunchPreference } from '../state/locate-preference';
import type { LaunchPreference } from '../state/locate-preference';
import { registry } from '../state/registry';
import { prefersReducedMotion } from '../util/motion';
import { createLocateCard } from './locate-card';
import type { CardAction, CardBlock, CardView } from './locate-card';
import type { LocateApi } from './locate-control';
import {
  agenciesAsked,
  checkTribalLands,
  openStateBriefingFor,
  openTribalBriefingFor,
  resolveStates,
  tribalLayerName,
  tribalLayerReadings,
  tribalPlaceWords
} from './locate-place';
import type { TribalCheck, TribalPlaceWords } from './locate-place';
import { getSheetDetent, isSheetActive, setSheetDetent } from './mobile-sheet';
import { activateTribalNationsGroup } from './tribal-nations-action';

/** A busy card that would only flash is not shown: a quick fix goes straight to its answer. */
const BUSY_REVEAL_MS = 250;
/** How long the permission reading may take before the attempt goes on without it. */
const PERMISSION_READ_MS = 800;

/** What an accepted position has led to. Dropped whole when the position is. */
interface Located {
  readonly fix: LocateFix;
  /** `undefined`: the outlines are still being read. `null`: they could not be. */
  finding: StateFinding | null | undefined;
  tribal: 'idle' | 'running' | TribalCheck;
  /** The area a check placed the position in, as a click on it would title it. */
  place: TribalPlaceWords | null;
  /** The card's body is unfolded. */
  open: boolean;
  /** Unfolding the body lowered the sheet from half; folding it gives the half back. */
  loweredSheet: boolean;
  /** Aborts this position's reads when it is dropped. */
  readonly work: AbortController;
  /** Aborts the Tribal lands check alone. */
  check: AbortController | null;
}

export function createLocate(map: maplibregl.Map, button: HTMLButtonElement, status: HTMLElement): LocateApi {
  const app = document.getElementById('app');
  const dock = document.getElementById('map-bottom-dock');
  if (!app || !dock) throw new Error('Locate needs the map dock');

  let state: LocateState = IDLE_STATE;
  let attempts = 0;
  let watchId: number | null = null;
  let permissionStatus: PermissionStatus | null = null;
  let deadlineTimer = 0;
  let settleTimer = 0;
  let revealTimer = 0;
  let locatingSince = 0;
  /** The busy card is on screen (or due at once). */
  let busyShown = false;
  /** This attempt began at launch, with no gesture behind it. */
  let fromLaunch = false;
  let offered = false;
  let marker: LocateMarker | null = null;
  let located: Located | null = null;
  let preference: LaunchPreference = readLaunchPreference();
  let offRegistry: (() => void) | null = null;

  const inShell = (): boolean => button.closest('#edge-column') !== null;

  // -------------------------------------------------------------------------
  // The announcement and the cell
  // -------------------------------------------------------------------------

  const say = (text: string): void => {
    // Cleared first, so a repeated line is still a change and still read.
    status.textContent = '';
    queueMicrotask(() => {
      status.textContent = text;
    });
  };

  const syncButton = (): void => {
    const busy = isInFlight(state.phase);
    const on = isLocated(state.phase);
    button.setAttribute('aria-pressed', String(on));
    if (busy) button.setAttribute('aria-busy', 'true');
    else button.removeAttribute('aria-busy');
    button.setAttribute(
      'aria-label',
      busy
        ? 'Locate: finding your position. Press to cancel.'
        : on
          ? 'Locate: your position is shown. Press to remove it.'
          : 'Locate: find my place'
    );
  };

  // -------------------------------------------------------------------------
  // The device
  // -------------------------------------------------------------------------

  const readPermission = async (): Promise<PermissionReading> => {
    try {
      const reading = await Promise.race([
        navigator.permissions.query({ name: 'geolocation' }),
        new Promise<null>((resolve) => window.setTimeout(() => resolve(null), PERMISSION_READ_MS))
      ]);
      if (!reading) return 'unknown';
      if (permissionStatus !== reading) {
        if (permissionStatus) permissionStatus.onchange = null;
        permissionStatus = reading;
        // The person answered the browser's question: the clock may start, or the attempt is over.
        reading.onchange = () => {
          if (isInFlight(state.phase)) {
            dispatch({ type: 'permission', attempt: state.attempt, permission: reading.state });
          }
        };
      }
      return reading.state;
    } catch {
      return 'unknown';
    }
  };

  const stopAcquiring = (): void => {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    window.clearTimeout(deadlineTimer);
    window.clearTimeout(settleTimer);
    window.clearTimeout(revealTimer);
    if (permissionStatus) permissionStatus.onchange = null;
    permissionStatus = null;
  };

  const begin = async (retry: boolean, launch = false): Promise<void> => {
    attempts += 1;
    const attempt = attempts;
    stopAcquiring();
    fromLaunch = launch;
    offered = false;
    const geo = 'geolocation' in navigator ? navigator.geolocation : null;
    const secure = window.isSecureContext;
    const permission = geo && secure ? await readPermission() : 'unknown';
    // A newer press, a cancel or a shell change came in while the browser was read.
    if (attempt !== attempts) return;
    dispatch({ type: 'start', attempt, supported: geo !== null, secure, permission, retry });
    if (!geo || state.attempt !== attempt || !isInFlight(state.phase)) return;
    watchId = geo.watchPosition(
      (position) =>
        dispatch({
          type: 'fix',
          attempt,
          fix: {
            lng: position.coords.longitude,
            lat: position.coords.latitude,
            accuracy: position.coords.accuracy
          }
        }),
      (error) => {
        // After a refusal, read what the browser now says: blocked, or only not allowed this time.
        void (error.code === 1 ? readPermission() : Promise.resolve(undefined)).then((after) =>
          dispatch({ type: 'error', attempt, code: error.code, ...(after ? { permission: after } : {}) })
        );
      },
      // The retry takes a quicker, less exact position; the time the person
      // spends on the browser's question is not part of the bound.
      { enableHighAccuracy: !retry, maximumAge: 0, timeout: LOCATE_TIMEOUT_MS }
    );
  };

  /** Drop the position: the marker, its ring, and everything read for it. */
  const remove = (): void => {
    dispatch({ type: 'clear' });
    say('Your position is removed from the map.');
  };

  /** Stop an attempt that is in flight, including one still reading the permission. */
  const cancel = (): void => {
    attempts += 1;
    dispatch({ type: 'cancel' });
  };

  // -------------------------------------------------------------------------
  // The state machine's one door
  // -------------------------------------------------------------------------

  function dispatch(event: LocateEvent): void {
    const before = state;
    state = reduceLocate(state, event);
    if (state === before) return;
    const attempt = state.attempt;

    if (!isInFlight(state.phase)) {
      stopAcquiring();
      busyShown = false;
    } else if (!isInFlight(before.phase)) {
      // A card already on screen answers the press at once.
      busyShown = card.shown;
      if (!busyShown) {
        revealTimer = window.setTimeout(() => {
          busyShown = true;
          render();
        }, BUSY_REVEAL_MS);
      }
    }
    if (state.phase === 'locating' && before.phase !== 'locating') {
      locatingSince = performance.now();
      deadlineTimer = window.setTimeout(() => dispatch({ type: 'deadline', attempt }), LOCATE_TIMEOUT_MS);
    }
    if (state.pending && !before.pending) {
      settleTimer = window.setTimeout(() => dispatch({ type: 'settle', attempt }), FIX_SETTLE_MS);
    }
    if (isLocated(before.phase) && !isLocated(state.phase)) dropLocated();
    if (isLocated(state.phase) && !isLocated(before.phase) && state.fix) {
      enterLocated(state.fix, state.phase === 'located-low');
    }

    syncButton();
    render();
    const copy = phaseCopy(state);
    if (copy && (state.phase !== before.phase || state.permission !== before.permission)) {
      say(isInFlight(state.phase) ? `${copy.title}.` : `${copy.title}. ${copy.body}`);
    }
  }

  // -------------------------------------------------------------------------
  // A position, and the place it is in
  // -------------------------------------------------------------------------

  function dropLocated(): void {
    located?.check?.abort();
    located?.work.abort();
    located = null;
    marker?.remove();
    marker = null;
    offRegistry?.();
    offRegistry = null;
  }

  function enterLocated(fix: LocateFix, approximate: boolean): void {
    dropLocated();
    const mine: Located = {
      fix,
      finding: undefined,
      tribal: 'idle',
      place: null,
      open: true,
      loweredSheet: false,
      work: new AbortController(),
      check: null
    };
    located = mine;
    marker = showLocateMarker(map, fix, {
      approximate,
      label: `Your position. ${accuracyLine(fix)}`,
      animate: !prefersReducedMotion()
    });
    // The line shown before a Tribal lands check names the layers that are on.
    offRegistry = registry.on('change', () => {
      if (located === mine && mine.tribal === 'idle') render();
    });
    nameThePlace(mine);
  }

  /** Read the bundled outlines and say what they support. */
  function nameThePlace(mine: Located): void {
    mine.finding = undefined;
    void resolveStates(mine.fix, mine.work.signal).then((finding) => {
      if (located !== mine) return;
      mine.finding = finding;
      const copy = locatedCopy(mine.fix, finding);
      say(`${copy.title}. ${accuracyLine(mine.fix)} ${copy.qualifier}`.trim());
      const only = copy.certain ? copy.states[0] : undefined;
      if (only) openState(mine, only);
      else render();
    });
  }

  /**
   * Fold or unfold the card's body. Above a sheet at half there is no room
   * for the body, so the two trade: unfolding lowers the sheet to its first
   * lines, and folding gives it the half back if nothing else moved it.
   */
  function setOpen(mine: Located, open: boolean): void {
    mine.open = open;
    if (open && getSheetDetent() === 'half') {
      mine.loweredSheet = true;
      setSheetDetent('peek');
    } else if (!open && mine.loweredSheet) {
      mine.loweredSheet = false;
      if (getSheetDetent() === 'peek') setSheetDetent('half');
    }
    render();
  }

  function openState(mine: Located, place: StateRef): void {
    // The briefing answers in the sheet: the card stands as its two lines above it.
    mine.open = false;
    mine.loweredSheet = false;
    render();
    void openStateBriefingFor(map, place, () => located === mine).then(() => {
      // A launch has no gesture to earn the sheet's rise; the stored opt-in is the ask.
      if (located === mine && fromLaunch && isSheetActive() && getSheetDetent() === 'closed') {
        setSheetDetent('half');
      }
    });
  }

  async function openArea(mine: Located, hit: TribalHit, words: TribalPlaceWords | null): Promise<void> {
    const named = words ?? (await tribalPlaceWords(hit, null).catch(() => null));
    if (located !== mine || !named) return;
    mine.open = false;
    mine.loweredSheet = false;
    render();
    await openTribalBriefingFor(map, hit, named, () => located === mine);
  }

  function checkTribal(mine: Located): void {
    mine.check?.abort();
    const check = new AbortController();
    mine.check = check;
    mine.work.signal.addEventListener('abort', () => check.abort(), { once: true });
    mine.tribal = 'running';
    mine.place = null;
    render();
    say('Checking Tribal lands near you.');
    void checkTribalLands(map, mine.fix, check.signal).then(async (result) => {
      if (located !== mine || mine.check !== check || check.signal.aborted || !result) return;
      const inside = result.kind === 'verdict' && result.verdict.kind === 'inside' ? result.verdict : null;
      const words = inside ? await tribalPlaceWords(inside.hit, inside.biaLandArea).catch(() => null) : null;
      if (located !== mine || mine.check !== check || check.signal.aborted) return;
      mine.tribal = result;
      mine.place = words;
      mine.check = null;
      const view = locatedView(mine);
      say(`${view.title}. ${view.lines.join(' ')}`);
      if (inside && words) void openArea(mine, inside.hit, words);
      else render();
    });
  }

  function stopTribal(mine: Located): void {
    mine.check?.abort();
    mine.check = null;
    mine.tribal = 'idle';
    render();
    say('Tribal lands check stopped.');
  }

  // -------------------------------------------------------------------------
  // The card
  // -------------------------------------------------------------------------

  const card = createLocateCard(dock, () => stepBack());

  const setPreference = (value: 'yes' | 'no'): void => {
    preference = writeLaunchPreference(value) ? value : 'unavailable';
  };

  /** The launch opt-in. Absent where the browser will not hold the choice. */
  const optIn = (): CardBlock[] =>
    preference === 'unavailable'
      ? []
      : [
          {
            type: 'check',
            id: 'launch',
            label: 'Find my place when I open the map',
            hint: 'Saves this choice only, never your position.',
            checked: preference === 'yes',
            onChange: (checked) => {
              setPreference(checked ? 'yes' : 'no');
              render();
            }
          }
        ];

  const closeOffer = (): void => {
    // The offer has been seen: it is not made again.
    if (preference === 'unset') setPreference('no');
    offered = false;
    render();
  };

  const openPlaceDoor = (): void => {
    if (getSheetDetent() === 'closed') {
      document.querySelector<HTMLButtonElement>('#mobile-footer-nav button[data-tab="place"]')?.click();
    }
  };

  function tribalBlocks(mine: Located): CardBlock[] {
    const again: CardAction = { id: 'tribal', label: 'Check again', style: 'primary', run: () => checkTribal(mine) };
    const turnOn: CardBlock[] = [
      { type: 'text', text: TRIBAL_NATIONS_GROUP.actionDescription, style: 'note' },
      {
        type: 'actions',
        items: [
          { id: 'tribal-on', label: `Turn on ${TRIBAL_NATIONS_GROUP.label}`, style: 'primary', run: activateTribalNationsGroup }
        ]
      }
    ];
    if (mine.tribal === 'idle') {
      if (tribalLayerReadings().every((layer) => layer.status === 'off')) {
        return [
          { type: 'text', text: 'No Tribal boundary layer is on, so there is nothing loaded to check your position against.' },
          ...turnOn
        ];
      }
      const agencies = agenciesAsked();
      return [
        {
          type: 'text',
          text: tribalDisclosure(
            agencies.length > 0 ? agencies : ['the boundary data this map was given'],
            coarseCell(mine.fix.lng, mine.fix.lat)
          ),
          style: 'note'
        },
        {
          type: 'actions',
          items: [{ id: 'tribal', label: 'Check Tribal lands near you', style: 'primary', run: () => checkTribal(mine) }]
        }
      ];
    }
    if (mine.tribal === 'running') return [];
    if (mine.tribal.kind === 'moved') return [{ type: 'actions', items: [again] }];
    const { verdict } = mine.tribal;
    const copy = tribalCopy(verdict, tribalLayerName);
    const blocks: CardBlock[] = copy.detail.map((text) => ({ type: 'text', text }));
    if (verdict.kind === 'inside') {
      if (mine.place && mine.place.title !== verdict.hit.name) {
        blocks.push({ type: 'text', text: `Its briefing is titled ${mine.place.title}.` });
      }
      if (mine.place?.caveat) blocks.push({ type: 'text', text: mine.place.caveat, style: 'caveat' });
    } else if (verdict.kind === 'near') {
      const first = verdict.hits[0];
      if (first) {
        blocks.push({
          type: 'actions',
          items: [{ id: 'area', label: `Open ${first.name}`, style: 'primary', run: () => void openArea(mine, first, null) }]
        });
      }
    } else if (verdict.kind === 'incomplete') {
      blocks.push({ type: 'actions', items: [again] });
    } else if (verdict.kind === 'layers-off') {
      blocks.push(...turnOn);
    }
    return blocks;
  }

  function locatedView(mine: Located): CardView {
    const tone = state.phase === 'located-low' ? 'approximate' : 'found';
    const accuracy = accuracyLine(mine.fix);
    // The card stays for as long as the position does: it is the marker's legend.
    if (mine.finding === undefined) {
      return { tone, title: 'Naming your place', lines: [accuracy], bound: null, blocks: [], fold: null, close: null };
    }
    if (mine.tribal === 'running') {
      return {
        tone: 'busy',
        title: 'Checking Tribal lands near you',
        lines: ['Loading boundaries for the grid square that contains you.'],
        bound: null,
        // Stopped by name, like every search in flight.
        blocks: [{ type: 'actions', items: [{ id: 'tribal', label: 'Stop', style: 'quiet', run: () => stopTribal(mine) }] }],
        fold: null,
        close: null
      };
    }

    const copy = locatedCopy(mine.fix, mine.finding);
    const blocks: CardBlock[] = [];
    if (!copy.certain) {
      if (copy.states.length > 0) {
        blocks.push({
          type: 'actions',
          items: copy.states.map((place, index) => ({
            id: `open-${place.code}`,
            label: `Open ${place.name}`,
            style: index === 0 ? 'primary' : 'quiet',
            run: () => openState(mine, place)
          }))
        });
      } else if (mine.finding === null) {
        blocks.push({ type: 'actions', items: [{ id: 'name', label: 'Try again', style: 'primary', run: () => nameThePlace(mine) }] });
      } else {
        blocks.push({
          type: 'actions',
          items: [{ id: 'place', label: 'Find a place by name', style: 'primary', run: openPlaceDoor }]
        });
      }
    }

    let title = copy.title;
    let qualifier = copy.qualifier;
    // Tribal lands are checked only where this map named a state: its boundary layers are United States sources.
    if (copy.states.length > 0) {
      if (mine.tribal === 'idle') {
        qualifier = `${qualifier} Tribal lands not checked.`.trim();
      } else if (mine.tribal.kind === 'moved') {
        qualifier = `${qualifier} Tribal lands not checked: the map moved before the check finished.`.trim();
      } else {
        const words = tribalCopy(mine.tribal.verdict, tribalLayerName);
        title = words.title ?? title;
        qualifier = words.title ? words.qualifier : `${qualifier} ${words.qualifier}`.trim();
      }
      blocks.push(...tribalBlocks(mine));
    }
    blocks.push(...optIn(), {
      type: 'actions',
      items: [
        {
          id: 'remove',
          label: 'Remove my position',
          style: 'quiet',
          run: () => {
            remove();
            button.focus({ preventScroll: true });
          }
        }
      ]
    });

    return {
      tone,
      title,
      lines: [`${accuracy} ${qualifier}`.trim()],
      bound: null,
      blocks,
      fold: {
        open: mine.open,
        label: mine.open ? 'Show less about your position' : 'Show more about your position',
        toggle: () => setOpen(mine, !mine.open)
      },
      close: null
    };
  }

  function currentView(): CardView | null {
    const copy = phaseCopy(state);
    if (copy && isInFlight(state.phase)) {
      if (!busyShown) return null;
      return {
        tone: 'busy',
        title: copy.title,
        lines: [copy.body],
        bound:
          state.phase === 'locating'
            ? { totalMs: LOCATE_TIMEOUT_MS, elapsedMs: performance.now() - locatingSince }
            : null,
        // A search in flight is cancelled by name, never just hidden.
        blocks: [{ type: 'actions', items: [{ id: 'cancel', label: 'Cancel', style: 'quiet', run: cancel }] }],
        fold: null,
        close: null
      };
    }
    if (copy) {
      const dismiss = (): void => dispatch({ type: 'dismiss' });
      const retry = state.phase === 'timeout';
      return {
        tone: 'stopped',
        title: copy.title,
        lines: [copy.body],
        bound: null,
        blocks:
          copy.next === 'Try again'
            ? [
                {
                  type: 'actions',
                  items: [{ id: 'retry', label: 'Try again', style: 'primary', run: () => void begin(retry) }]
                }
              ]
            : [],
        fold: null,
        close: { label: 'Close', run: dismiss }
      };
    }
    if (located) return locatedView(located);
    if (offered) {
      return {
        tone: 'offer',
        title: 'Find your place',
        lines: ['See conditions for the place you are standing in. Your position stays on this device.'],
        bound: null,
        blocks: [
          {
            type: 'actions',
            items: [
              {
                id: 'locate',
                label: 'Locate me',
                style: 'primary',
                run: () => {
                  if (preference === 'unset') setPreference('no');
                  void begin(false);
                }
              },
              { id: 'later', label: 'Not now', style: 'quiet', run: closeOffer }
            ]
          },
          ...optIn()
        ],
        fold: null,
        close: { label: 'Dismiss this offer', run: closeOffer }
      };
    }
    return null;
  }

  function render(): void {
    const view = currentView();
    if (view) card.show(view);
    else card.hide();
  }

  /** Escape inside the card: step back once, and hand focus to the cell. */
  function stepBack(): void {
    if (isInFlight(state.phase)) cancel();
    else if (phaseCopy(state)) dispatch({ type: 'dismiss' });
    else if (located) {
      if (located.tribal === 'running') stopTribal(located);
      else setOpen(located, false);
    } else if (offered) closeOffer();
    button.focus({ preventScroll: true });
  }

  // The phone shell is where the cell lives. When it goes (a wider window,
  // an embed), nothing is left on the map that the person could not remove.
  new MutationObserver(() => {
    if (inShell()) return;
    attempts += 1;
    stopAcquiring();
    offered = false;
    dropLocated();
    state = IDLE_STATE;
    busyShown = false;
    syncButton();
    render();
  }).observe(app, { attributes: true, attributeFilter: ['data-sheet-detent'] });

  return {
    press(): void {
      if (isInFlight(state.phase)) {
        cancel();
        say('Locate cancelled.');
      } else if (isLocated(state.phase)) {
        remove();
      } else {
        if (offered && preference === 'unset') setPreference('no');
        void begin(false);
      }
    },
    offer(): void {
      if (offered || state.phase !== 'idle' || !inShell()) return;
      // An offer that could only fail is not made; the cell still explains on a press.
      if (!('geolocation' in navigator) || !window.isSecureContext) return;
      void readPermission().then((permission) => {
        if (permission === 'denied' || state.phase !== 'idle' || !inShell()) return;
        offered = true;
        render();
        say('Find your place: an offer to locate you is on the map. Your position stays on this device.');
      });
    },
    locateOnLaunch(): void {
      if (state.phase === 'idle' && inShell()) void begin(false, true);
    }
  };
}
