/**
 * The phone sheet's motion (owner direction 2026-11-09 (sprint),
 * DR-pending).
 *
 * src/ui/mobile-sheet.ts owns WHICH stop the sheet is at; this module makes
 * the glass get there the way a hand expects. It is loaded only when the
 * phone shell activates, so a desktop or embed session never downloads it,
 * and nothing here is required for function: without it a stop change
 * lands at once.
 *
 * TWO REPRESENTATIONS, ONE PICTURE. At rest the stylesheet makes the sheet
 * exactly as tall as its stop, with no transform
 * (src/styles/mobile-panels.css). To move, `begin` gives the element its
 * full height once and a `transform` that puts its top edge where it
 * already was, so nothing shifts on screen; from then on only the transform
 * changes, per frame, until `rest` hands the element back to the
 * stylesheet. Height is never animated.
 *
 * WHAT MOVES IT.
 * - A drag (src/util/gesture.ts `attachDrag`) on the header strip, and on
 *   the content when the content has nothing to scroll that way: at peek,
 *   when it fits, or when it is at its top and the finger moves down. The
 *   sheet follows the finger 1:1 and rubber-bands past full. On release the
 *   velocity is projected to the nearest stop (`projectRelease`,
 *   `nearestDetent`, and the landing rules in src/config/sheet-detents.ts)
 *   and the shared spring carries it there from the finger's speed
 *   (src/util/spring.ts `runSpring`). A flick down from peek, or a drag
 *   well below it, closes the sheet.
 * - The grabber as a control: Enter, Space or a tap steps to the next stop,
 *   ArrowUp and ArrowDown step up and down.
 * - Any other stop change (a door, the close control, Escape, a report
 *   opening): the controller calls `go` and the same spring runs from rest.
 *
 * CONTENT KEEPS ITS PLACE. On the way up the controller's `present` stamps
 * the new stop first, so the content rises with the glass; on the way to
 * closed it is stamped last, so the content leaves with it.
 *
 * REDUCED MOTION. `runSpring` lands on the stop at once: same end state,
 * no travel. A drag still follows the finger; that motion is the reader's
 * own.
 *
 * The map furniture that sits on the sheet's top edge (the scale rulers,
 * the dock with its notices and the OpenStreetMap credit) rides along by
 * transform while the sheet moves, so it is never left under the glass.
 *
 * Presentation only. Nothing here enters the URL or reads map state.
 */

import {
  SHEET_DRAWER_QUERY,
  SHEET_TOKENS,
  drawerOffsets,
  releaseStops,
  riderLift,
  sheetOffsets,
  stepStop
} from '../config/sheet-detents';
import type {
  SheetForm,
  SheetHeights,
  SheetOffsets,
  SheetStep
} from '../config/sheet-detents';
import {
  attachDrag,
  hapticTick,
  nearestDetent,
  projectRelease,
  rubberBand
} from '../util/gesture';
import type { DragSample } from '../util/gesture';
import { prefersReducedMotion } from '../util/motion';
import { runSpring } from '../util/spring';
import type { SpringRun } from '../util/spring';
import { getSheetDetent, setSheetDetent } from './mobile-sheet';
import type { SheetDetent, SheetMotion, SheetMotionHost } from './mobile-sheet';

const CLOSE_GLYPH =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18"/></svg>';

/** How the grabber's accessible name states each stop. */
const STOP_WORDS: Record<SheetDetent, string> = {
  closed: 'closed',
  peek: 'lowered',
  half: 'open',
  full: 'fully open'
};

/** Content a drag must never take from: it selects, types or picks. */
const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

/**
 * Attach the motion to the sheet. Called once, by the controller, the
 * first time the phone shell activates.
 */
export function attachSheetMotion(
  app: HTMLElement,
  sheet: HTMLElement,
  host: SheetMotionHost
): SheetMotion {
  const head = sheet.querySelector<HTMLElement>('.sheet-grabber-row');
  const grabber = sheet.querySelector<HTMLButtonElement>('#sheet-grabber');
  const body = sheet.querySelector<HTMLElement>('.sidebar-scroll');
  const drawerQuery = window.matchMedia(SHEET_DRAWER_QUERY);

  let form: SheetForm = drawerQuery.matches ? 'drawer' : 'sheet';
  let heights: SheetHeights = { peek: 0, half: 0, full: 0 };
  let offsets: SheetOffsets = sheetOffsets(heights);
  /** The riders' lift with the sheet closed: the bottom safe area. */
  let floor = 0;
  /** Displacement toward closed, px. Meaningful only while `moving`. */
  let offset = 0;
  let moving = false;
  let spring: SpringRun | null = null;
  let runId = 0;
  /** A release hands these to the `go` its stop change causes. */
  let flick = 0;
  let released = false;
  let startStop: SheetDetent = 'half';
  let origin = 0;

  // -------------------------------------------------------------------------
  // Geometry: the stylesheet owns the numbers, this reads them.
  // -------------------------------------------------------------------------

  const probe = document.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText =
    'position:fixed;top:0;left:0;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none';
  for (const length of [
    'var(--sheet-h-peek)',
    'var(--sheet-h-half)',
    'var(--sheet-h-full)',
    'env(safe-area-inset-bottom, 0px)'
  ]) {
    const cell = document.createElement('i');
    cell.style.cssText = `display:block;width:0;height:${length}`;
    probe.appendChild(cell);
  }
  app.appendChild(probe);

  const riders = (): HTMLElement[] =>
    form === 'sheet'
      ? [
          document.getElementById('map-bottom-dock'),
          document.querySelector<HTMLElement>('#map .maplibregl-ctrl-bottom-left')
        ].filter((node): node is HTMLElement => node !== null)
      : [];

  const measure = (): void => {
    form = drawerQuery.matches ? 'drawer' : 'sheet';
    if (form === 'drawer') {
      offsets = drawerOffsets(sheet.getBoundingClientRect().width);
      return;
    }
    const read = (index: number): number =>
      probe.children[index]?.getBoundingClientRect().height ?? 0;
    heights = { peek: read(0), half: read(1), full: read(2) };
    floor = read(3);
    offsets = sheetOffsets(heights);
  };

  // -------------------------------------------------------------------------
  // The two representations
  // -------------------------------------------------------------------------

  /** Seat the riders for `offset` against the stop the stylesheet is showing. */
  const ride = (): void => {
    const stamped = app.getAttribute('data-sheet-detent');
    const atRest =
      stamped === 'peek' || stamped === 'half'
        ? riderLift(heights[stamped], heights.half, floor)
        : floor;
    const shift = atRest - riderLift(heights.full - offset, heights.half, floor);
    for (const node of riders()) {
      node.style.transform = shift === 0 ? '' : `translate3d(0,${shift}px,0)`;
    }
  };

  const place = (value: number): void => {
    offset = value;
    if (form === 'sheet') {
      sheet.style.transform = `translate3d(0,${value}px,0)`;
      ride();
    } else {
      sheet.style.transform = `translate3d(${-value}px,0,0)`;
    }
  };

  /** Enter the moving representation at the seat of `from`. A no-op mid-flight. */
  const begin = (from: SheetDetent): void => {
    if (moving) return;
    measure();
    moving = true;
    sheet.setAttribute('data-sheet-moving', '');
    if (form === 'sheet') sheet.style.height = `${heights.full}px`;
    place(offsets[from]);
  };

  /** Hand the element back to the stylesheet. */
  const rest = (): void => {
    moving = false;
    sheet.removeAttribute('data-sheet-moving');
    sheet.removeAttribute('data-sheet-dragging');
    sheet.style.height = '';
    sheet.style.transform = '';
    for (const node of riders()) node.style.transform = '';
  };

  const halt = (): void => {
    runId += 1;
    spring?.stop();
    spring = null;
  };

  /** Carry the sheet to `to` on the shared spring, from `velocity` px/s. */
  const run = (to: SheetDetent, velocity: number, done: () => void): void => {
    halt();
    const id = runId;
    let live = true;
    const handle = runSpring({
      from: offset,
      to: offsets[to],
      velocity,
      reducedMotion: prefersReducedMotion(),
      // A spring that passes full meets the same resistance a finger does.
      onUpdate: (value) => place(value < 0 ? -rubberBand(-value, SHEET_TOKENS.rubber) : value),
      onRest: () => {
        live = false;
        if (runId !== id) return;
        spring = null;
        done();
      }
    });
    if (live && runId === id) spring = handle;
  };

  // -------------------------------------------------------------------------
  // The drag
  // -------------------------------------------------------------------------

  /** A sheet closes downward, a drawer leftward. */
  const toward = (): 1 | -1 => (form === 'sheet' ? 1 : -1);

  /**
   * Whether a vertical drag that began on `target` inside the content
   * belongs to the sheet and not to scrolling: never from an entry, never
   * from a nested scroller, always when the content has nothing to scroll,
   * and otherwise only downward from the top.
   */
  const contentYields = (target: EventTarget | null, direction: 1 | -1): boolean => {
    if (!body || !(target instanceof Element) || target.closest(EDITABLE)) return false;
    for (let node: Element | null = target; node && node !== body; node = node.parentElement) {
      if (
        node.scrollHeight > node.clientHeight + 1 &&
        /auto|scroll/.test(getComputedStyle(node).overflowY)
      ) {
        return false;
      }
    }
    if (
      body.scrollHeight <= body.clientHeight + 1 ||
      getComputedStyle(body).overflowY === 'hidden'
    ) {
      return true;
    }
    return direction === 1 && body.scrollTop <= 0;
  };

  const onStart = (): void => {
    const at = getSheetDetent();
    startStop = at ?? 'half';
    halt();
    begin(startStop);
    origin = offset;
    sheet.setAttribute('data-sheet-dragging', '');
  };

  const onMove = (sample: DragSample): void => {
    const next = origin + toward() * sample.delta;
    place(
      next < 0 ? -rubberBand(-next, SHEET_TOKENS.rubber) : Math.min(next, offsets.closed)
    );
  };

  const onEnd = (sample: DragSample, cancelled: boolean): void => {
    sheet.removeAttribute('data-sheet-dragging');
    const velocity = cancelled ? 0 : toward() * sample.velocity;
    // A gesture the system took back returns the sheet where it was.
    const stops = cancelled ? [startStop] : releaseStops(form, startStop, offset, offsets);
    const landing = nearestDetent(
      projectRelease(offset, velocity),
      stops.map((stop) => offsets[stop])
    );
    const to = stops.find((stop) => offsets[stop] === landing) ?? startStop;
    if (to === getSheetDetent()) {
      run(to, velocity, () => {
        rest();
        host.settle();
      });
      return;
    }
    flick = velocity;
    released = true;
    setSheetDetent(to);
  };

  const open = (): boolean => {
    const at = getSheetDetent();
    return at !== null && at !== 'closed';
  };

  let disposeDrags: Array<() => void> = [];
  const arm = (): void => {
    for (const dispose of disposeDrags) dispose();
    disposeDrags = [];
    const axis = form === 'sheet' ? 'y' : 'x';
    if (head) {
      disposeDrags.push(
        attachDrag(head, { axis, canStart: open, onStart, onMove, onEnd })
      );
    }
    if (body) {
      disposeDrags.push(
        attachDrag(body, {
          axis,
          // A mouse drag in the content selects text; the header drags for it.
          canStart: (event, direction) =>
            open() &&
            event.pointerType !== 'mouse' &&
            (form === 'drawer' ? direction === -1 : contentYields(event.target, direction)),
          onStart,
          onMove,
          onEnd
        })
      );
    }
  };
  arm();
  drawerQuery.addEventListener('change', () => {
    halt();
    if (moving) {
      rest();
      host.settle();
    }
    form = drawerQuery.matches ? 'drawer' : 'sheet';
    arm();
  });

  // Pointer Events cannot stop a native scroll once it has begun, so the
  // one decision above is also made on the first touch move, where calling
  // preventDefault keeps the browser from scrolling a gesture the sheet
  // takes. Every other gesture scrolls natively, untouched.
  if (body) {
    let touchX = 0;
    let touchY = 0;
    let takes: boolean | null = null;
    body.addEventListener(
      'touchstart',
      (event) => {
        const touch = event.touches[0];
        if (!touch) return;
        touchX = touch.clientX;
        touchY = touch.clientY;
        takes = null;
      },
      { passive: true }
    );
    body.addEventListener(
      'touchmove',
      (event) => {
        const touch = event.touches[0];
        if (!touch || event.touches.length !== 1 || form !== 'sheet' || !open()) return;
        if (takes === null) {
          const dx = touch.clientX - touchX;
          const dy = touch.clientY - touchY;
          if (dx === 0 && dy === 0) return;
          takes = Math.abs(dy) >= Math.abs(dx) && contentYields(event.target, dy > 0 ? 1 : -1);
        }
        if (takes && event.cancelable) event.preventDefault();
      },
      { passive: false }
    );
  }

  // -------------------------------------------------------------------------
  // The header: the grabber as a control, the title, the close control
  // -------------------------------------------------------------------------

  const step = (kind: SheetStep): void => {
    const at = getSheetDetent();
    if (!at) return;
    const next = stepStop(at, kind);
    if (next !== at) setSheetDetent(next);
  };
  grabber?.addEventListener('click', () => step('next'));
  grabber?.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    step(event.key === 'ArrowUp' ? 'up' : 'down');
  });

  const title = document.createElement('h2');
  title.id = 'sheet-title';
  title.className = 'sheet-title';
  const close = document.createElement('button');
  close.type = 'button';
  close.id = 'sheet-close';
  close.className = 'sheet-close';
  close.setAttribute('aria-label', 'Close the panel');
  close.innerHTML = CLOSE_GLYPH;
  // The controller returns focus to the open door when the sheet closes.
  close.addEventListener('click', () => setSheetDetent('closed'));
  head?.append(title, close);

  /**
   * The title is the open door's own word, read from the door, so the two
   * can never disagree. A sheet no door claimed is named for what it shows.
   */
  const describe = (): void => {
    const stamped = app.getAttribute('data-sheet-detent') as SheetDetent | null;
    if (!stamped) return;
    const tab =
      app.getAttribute('data-sheet-tab') ??
      (stamped === 'full' && sheet.querySelector('#sheet-report .impact-panel.open')
        ? 'brief'
        : app.classList.contains('view-console')
          ? 'layers'
          : 'place');
    const word =
      document
        .querySelector(`#mobile-footer-nav button[data-tab="${tab}"] span`)
        ?.textContent?.trim() ?? '';
    if (title.textContent !== word) title.textContent = word;
    grabber?.setAttribute(
      'aria-label',
      `Resize the ${word} panel, now ${STOP_WORDS[stamped]}`.replace(/\s+/g, ' ')
    );
  };
  new MutationObserver(describe).observe(app, {
    attributes: true,
    attributeFilter: ['data-sheet-detent', 'data-sheet-tab', 'class']
  });
  describe();

  return {
    go(from, to) {
      const velocity = flick;
      const snapped = released;
      flick = 0;
      released = false;
      if (to === 'closed') {
        begin(from);
      } else {
        // Hold the old seat while the content changes, or start below the edge.
        if (from !== 'closed') begin(from);
        host.present();
        if (moving) place(offset);
        else begin('closed');
      }
      run(to, velocity, () => {
        if (to === 'closed') host.present();
        rest();
        if (snapped) hapticTick();
        host.settle();
      });
    },
    reset() {
      halt();
      flick = 0;
      released = false;
      if (moving) rest();
    }
  };
}
