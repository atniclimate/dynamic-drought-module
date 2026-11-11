/**
 * Shared touch gesture helpers (owner direction 2026-11-09 (sprint),
 * DR-pending).
 *
 * One drag recognizer for every phone surface that follows the hand: sheets
 * with detents, side drawers, cards that dismiss. It is built on Pointer
 * Events, so touch, pen and mouse take one path, and it reports a release
 * velocity so the settle spring (src/util/spring.ts) can carry the motion
 * on from the finger's speed.
 *
 * WHAT IT WILL NOT DO. It never claims a pointer until the finger has
 * travelled past the slop on the drag's own axis, so a tap stays a tap and
 * a scroll on the other axis stays a scroll. A caller that hosts scrolling
 * content answers `canStart` (a sheet lets the drag begin only when its
 * content is scrolled to the top and the finger moves down).
 *
 * The pure helpers at the bottom (`projectRelease`, `nearestDetent`,
 * `rubberBand`, `trackVelocity`) hold the arithmetic, so node tests cover
 * it without a browser. Nothing here reads or writes application state.
 */

export type DragAxis = 'x' | 'y';

export interface DragSample {
  /** Travel from the press point along the drag axis, px. */
  readonly delta: number;
  /** Velocity along the drag axis, px per second. Positive is right or down. */
  readonly velocity: number;
  /** The pointer's client position. */
  readonly clientX: number;
  readonly clientY: number;
  readonly pointerType: string;
}

export interface DragOptions {
  readonly axis: DragAxis;
  /** Travel before the drag claims the pointer. Default 8 px. */
  readonly slop?: number;
  /**
   * Asked once, when the slop is crossed. `direction` is 1 for right or
   * down, -1 for left or up. Return false to leave the gesture alone.
   */
  readonly canStart?: (event: PointerEvent, direction: 1 | -1) => boolean;
  readonly onStart?: (sample: DragSample) => void;
  readonly onMove: (sample: DragSample) => void;
  /** `cancelled` is true when the system took the pointer away. */
  readonly onEnd: (sample: DragSample, cancelled: boolean) => void;
}

interface TimedPoint {
  readonly t: number;
  readonly p: number;
}

/** Samples older than this do not describe the release. */
const VELOCITY_WINDOW_MS = 100;

/**
 * Velocity in px per second from timed positions, using only the last
 * 100 ms: a finger that stopped before lifting releases at rest.
 */
export function trackVelocity(points: readonly TimedPoint[], now: number): number {
  const recent = points.filter((point) => now - point.t <= VELOCITY_WINDOW_MS);
  const first = recent[0];
  const last = recent[recent.length - 1];
  if (!first || !last || last.t === first.t) return 0;
  return ((last.p - first.p) / (last.t - first.t)) * 1000;
}

/**
 * Follow a drag on `target`. Returns a dispose function. The element
 * should carry `touch-action` for the other axis (`pan-x` for a vertical
 * drag surface that is not itself scrollable, or `none` on a grabber).
 */
export function attachDrag(target: HTMLElement, options: DragOptions): () => void {
  const slop = options.slop ?? 8;
  let pointerId: number | null = null;
  let originX = 0;
  let originY = 0;
  let dragging = false;
  let refused = false;
  let suppressClick = false;
  let points: TimedPoint[] = [];

  const along = (event: PointerEvent): number =>
    options.axis === 'y' ? event.clientY - originY : event.clientX - originX;
  const across = (event: PointerEvent): number =>
    options.axis === 'y' ? event.clientX - originX : event.clientY - originY;

  const sample = (event: PointerEvent): DragSample => ({
    delta: along(event),
    velocity: trackVelocity(points, event.timeStamp),
    clientX: event.clientX,
    clientY: event.clientY,
    pointerType: event.pointerType
  });

  const release = (): void => {
    if (pointerId !== null && target.hasPointerCapture?.(pointerId)) {
      target.releasePointerCapture(pointerId);
    }
    pointerId = null;
    dragging = false;
    refused = false;
    points = [];
  };

  const onDown = (event: PointerEvent): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    // A drag in progress keeps its pointer; a second finger does not take it.
    // A press that never became a drag is not held on to: its release can
    // happen where this element does not hear it (the pointer is captured
    // only once the drag starts), and a remembered pointer would then refuse
    // every later press.
    if (pointerId !== null && dragging) return;
    pointerId = event.pointerId;
    originX = event.clientX;
    originY = event.clientY;
    dragging = false;
    refused = false;
    points = [{ t: event.timeStamp, p: 0 }];
  };

  const onMove = (event: PointerEvent): void => {
    if (event.pointerId !== pointerId) return;
    // A mouse moving with no button down is a hover: the press this
    // recognizer remembers was released elsewhere. Forget it, and end a drag
    // that somehow outlived its button as cancelled.
    if (event.pointerType === 'mouse' && event.buttons === 0) {
      const wasDragging = dragging;
      const last = sample(event);
      release();
      if (wasDragging) options.onEnd(last, true);
      return;
    }
    if (refused) return;
    const travel = along(event);
    if (!dragging) {
      if (Math.abs(across(event)) > Math.abs(travel) && Math.abs(across(event)) > slop) {
        // The gesture belongs to the other axis.
        refused = true;
        return;
      }
      if (Math.abs(travel) < slop) return;
      if (options.canStart && !options.canStart(event, travel > 0 ? 1 : -1)) {
        refused = true;
        return;
      }
      dragging = true;
      target.setPointerCapture?.(event.pointerId);
      options.onStart?.(sample(event));
    }
    points.push({ t: event.timeStamp, p: travel });
    if (points.length > 24) points.shift();
    // A claimed drag owns the gesture: no scroll, no text selection.
    if (event.cancelable) event.preventDefault();
    options.onMove(sample(event));
  };

  const onUp = (event: PointerEvent): void => {
    if (event.pointerId !== pointerId) return;
    const wasDragging = dragging;
    const last = sample(event);
    release();
    if (wasDragging) options.onEnd(last, event.type === 'pointercancel');
  };

  /** A drag that ended on a control must not also press it. */
  const onClickCapture = (event: MouseEvent): void => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  };
  const armClickSuppression = (event: PointerEvent): void => {
    if (event.pointerId !== pointerId || !dragging) return;
    suppressClick = true;
    window.setTimeout(() => {
      suppressClick = false;
    }, 0);
  };

  target.addEventListener('pointerdown', onDown);
  target.addEventListener('pointermove', onMove, { passive: false });
  target.addEventListener('pointerup', armClickSuppression, true);
  target.addEventListener('pointerup', onUp);
  target.addEventListener('pointercancel', onUp);
  target.addEventListener('click', onClickCapture, true);

  return () => {
    release();
    target.removeEventListener('pointerdown', onDown);
    target.removeEventListener('pointermove', onMove);
    target.removeEventListener('pointerup', armClickSuppression, true);
    target.removeEventListener('pointerup', onUp);
    target.removeEventListener('pointercancel', onUp);
    target.removeEventListener('click', onClickCapture, true);
  };
}

/**
 * Where a release would come to rest if nothing caught it: the position
 * plus the distance the release velocity carries over `seconds`. A sheet
 * snaps to the detent nearest this point, so a short fast flick travels a
 * full detent and a slow drag settles where it was let go.
 */
export function projectRelease(position: number, velocity: number, seconds = 0.18): number {
  return position + velocity * seconds;
}

/** The detent nearest `position`. `detents` may be in any order and must not be empty. */
export function nearestDetent(position: number, detents: readonly number[]): number {
  let best = detents[0] ?? position;
  for (const detent of detents) {
    if (Math.abs(detent - position) < Math.abs(best - position)) best = detent;
  }
  return best;
}

/**
 * Resistance past a limit: travel `overshoot` px beyond the end and the
 * surface follows by less and less, never exceeding `range`.
 */
export function rubberBand(overshoot: number, range: number, stiffness = 0.55): number {
  if (range <= 0) return 0;
  const sign = overshoot < 0 ? -1 : 1;
  const x = Math.abs(overshoot);
  return sign * (1 - 1 / ((x * stiffness) / range + 1)) * range;
}

/**
 * A short tick on a detent snap, where the device offers it. Android
 * Chrome does; iOS Safari does not and this is then a no-op. Never the
 * only signal: the snap is also seen and announced.
 */
export function hapticTick(ms = 8): void {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(ms);
    }
  } catch {
    // A blocked or absent vibration API is not an error worth surfacing.
  }
}
