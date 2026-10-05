/**
 * The flowing paths' motion clock (ENSO-FLOW-PLAN.md E1-4; moving-paths.md
 * section 13; C-fit.md 1.8).
 *
 * One requestAnimationFrame loop, capped at 30 Hz, that steps the particles
 * (`onFrame`) and asks MapLibre for a frame (`triggerRepaint`). It never
 * calls `triggerRepaint` from inside a render. It stops, with no further
 * repaint, on any of:
 * - the viewer's Pause;
 * - `prefers-reduced-motion: reduce` (a live change listener, not a one-off
 *   read: src/util/motion.ts reads once and stays eager, so this store
 *   lives here, in the lazy flow chunk);
 * - a hidden document;
 * - the map container off screen (an IntersectionObserver, for embeds);
 * - the SST days playing (one clock moves at a time);
 * - a lost WebGL context, until it is restored.
 *
 * Pause is page-session state (sessionStorage, read and written inside
 * try/catch, never a URL key). With no stored choice the loop starts paused
 * under reduced motion (and wherever the caller asks for a still default,
 * the phone), and an explicit Play is honoured as the viewer's choice.
 *
 * The state goes out as one word, the snapshot's `motion` field that the
 * map key's Pause button reads (src/ui/map-key.ts). The button sends its
 * request back as MOTION_REQUEST_EVENT; `listenMotionRequests` applies it.
 */
import { getTimeBarSpec, onTimeBarSpecChange } from '../../ui/time-bar';

/**
 * The snapshot's `motion` word.
 * - moving: the loop runs.
 * - paused: the viewer paused, or a still default the viewer has not overruled.
 * - reduced: still under prefers-reduced-motion, with no explicit Play.
 * - held: nobody paused, but something holds the lines still for now (the
 *   SST days playing, a hidden document, the map off screen, a lost context).
 * - none: motion cannot happen at all (the button is not offered).
 */
export type MotionState = 'moving' | 'paused' | 'reduced' | 'held' | 'none';

/** Why a `held` loop is held, for the form notes E2-1 writes. */
export type MotionHold = 'sst' | 'hidden' | 'offscreen' | 'context';

/** What the loop needs of a MapLibre map. */
export interface MotionMap {
  triggerRepaint(): void;
  getCanvas(): HTMLCanvasElement;
  getContainer(): HTMLElement;
}

/** The SST days' play state. The default reads the time bar's installed spec. */
export interface SstClock {
  playing(): boolean;
  subscribe(listener: () => void): () => void;
}

export interface MotionLoopOptions {
  readonly map: MotionMap;
  /** One particle step per frame the loop lets through. */
  readonly onFrame?: (now: number) => void;
  /** Every change of `motion`, including the first. */
  readonly onChange?: (motion: MotionState) => void;
  /** Each restart after a stop: reset particle ages so nothing bursts. */
  readonly onResume?: () => void;
  /** Start still when the viewer has made no choice (the phone default). */
  readonly stillByDefault?: boolean;
  readonly sst?: SstClock;
  /** Defaults to window.sessionStorage, read inside try/catch. */
  readonly storage?: () => Storage | null;
}

export interface MotionLoop {
  readonly motion: MotionState;
  readonly hold: MotionHold | null;
  readonly paused: boolean;
  setPaused(paused: boolean): void;
  dispose(): void;
}

/** The map key's Pause button asks with this event; detail `{ paused }`. */
export const MOTION_REQUEST_EVENT = 'ddm:enso-flow-motion-request';
export const MOTION_STORAGE_KEY = 'ddm:flow-motion';
const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';
const FRAME_MS = 1000 / 30;
/** rAF timestamps jitter; a frame this close to the cap still counts. */
const FRAME_SLACK_MS = 2;

export const timeBarSstClock: SstClock = {
  playing: () => Boolean(getTimeBarSpec()?.play?.playing),
  subscribe: (listener) => onTimeBarSpecChange(listener)
};

function sessionStore(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

type Choice = 'paused' | 'playing' | null;

function readChoice(storage: () => Storage | null): Choice {
  try {
    const value = storage()?.getItem(MOTION_STORAGE_KEY);
    return value === 'paused' || value === 'playing' ? value : null;
  } catch {
    return null;
  }
}

function writeChoice(storage: () => Storage | null, choice: Choice): void {
  try {
    const store = storage();
    if (!store) return;
    if (choice) store.setItem(MOTION_STORAGE_KEY, choice);
    else store.removeItem(MOTION_STORAGE_KEY);
  } catch {
    // Private windows and blocked storage keep the choice for this load only.
  }
}

export function createMotionLoop(options: MotionLoopOptions): MotionLoop {
  const { map } = options;
  const storage = options.storage ?? sessionStore;
  const sst = options.sst ?? timeBarSstClock;
  const reducedQuery = typeof window.matchMedia === 'function' ? window.matchMedia(REDUCED_QUERY) : null;
  const canvas = map.getCanvas();
  const container = map.getContainer();

  let choice: Choice = readChoice(storage);
  let reduced = Boolean(reducedQuery?.matches);
  let sstPlaying = sst.playing();
  let offscreen = false;
  let contextLost = false;
  let disposed = false;
  let frame: number | null = null;
  let last = -Infinity;
  let motion: MotionState | null = null;

  const pausedNow = (): boolean =>
    choice === 'paused' || (choice === null && (reduced || Boolean(options.stillByDefault)));

  const holdNow = (): MotionHold | null => {
    if (sstPlaying) return 'sst';
    if (document.hidden) return 'hidden';
    if (offscreen) return 'offscreen';
    if (contextLost) return 'context';
    return null;
  };

  const stateNow = (): MotionState => {
    if (disposed) return 'none';
    if (pausedNow()) return choice === null && reduced ? 'reduced' : 'paused';
    return holdNow() ? 'held' : 'moving';
  };

  const tick = (now: number): void => {
    frame = null;
    if (disposed || motion !== 'moving') return;
    if (now - last >= FRAME_MS - FRAME_SLACK_MS) {
      // Never let a long gap become a burst of catch-up frames.
      last = now - last > FRAME_MS * 2 ? now : last + FRAME_MS;
      options.onFrame?.(now);
      map.triggerRepaint();
    }
    // A step may have paused the loop (its own onChange); check again.
    if (!disposed && motion === 'moving') frame = window.requestAnimationFrame(tick);
  };

  const stop = (): void => {
    if (frame !== null) window.cancelAnimationFrame(frame);
    frame = null;
  };

  const sync = (): void => {
    const next = stateNow();
    if (next === motion) return;
    const wasMoving = motion === 'moving';
    const first = motion === null;
    motion = next;
    if (next === 'moving') {
      last = -Infinity;
      if (!first && !wasMoving) options.onResume?.();
      if (frame === null) frame = window.requestAnimationFrame(tick);
    } else {
      stop();
    }
    options.onChange?.(next);
  };

  const onReducedChange = (event: MediaQueryListEvent): void => {
    reduced = event.matches;
    // A newer system request for less motion outranks an earlier Play.
    if (reduced && choice === 'playing') {
      choice = null;
      writeChoice(storage, null);
    }
    sync();
  };
  const onVisibility = (): void => sync();
  const onContextLost = (): void => {
    contextLost = true;
    sync();
  };
  const onContextRestored = (): void => {
    contextLost = false;
    sync();
  };
  const disposeSst = sst.subscribe(() => {
    sstPlaying = sst.playing();
    sync();
  });
  const observer =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver((entries) => {
          const entry = entries[entries.length - 1];
          if (!entry) return;
          offscreen = !entry.isIntersecting;
          sync();
        })
      : null;

  reducedQuery?.addEventListener('change', onReducedChange);
  document.addEventListener('visibilitychange', onVisibility);
  canvas.addEventListener('webglcontextlost', onContextLost);
  canvas.addEventListener('webglcontextrestored', onContextRestored);
  observer?.observe(container);
  sync();

  return {
    get motion() {
      return motion ?? 'none';
    },
    get hold() {
      return holdNow();
    },
    get paused() {
      return pausedNow();
    },
    setPaused(paused: boolean) {
      if (disposed) return;
      choice = paused ? 'paused' : 'playing';
      writeChoice(storage, choice);
      sync();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      reducedQuery?.removeEventListener('change', onReducedChange);
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      observer?.disconnect();
      disposeSst();
      sync();
    }
  };
}

/** Apply the map key's Pause requests to `loop`. Returns the unsubscribe. */
export function listenMotionRequests(loop: MotionLoop): () => void {
  const onRequest = (event: Event): void => {
    const detail = (event as CustomEvent<{ paused?: unknown }>).detail;
    if (typeof detail?.paused !== 'boolean') return;
    loop.setPaused(detail.paused);
  };
  window.addEventListener(MOTION_REQUEST_EVENT, onRequest);
  return () => window.removeEventListener(MOTION_REQUEST_EVENT, onRequest);
}
