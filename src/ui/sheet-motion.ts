/**
 * The phone window's motion (owner direction 2026-11-09 (sprint),
 * DR-pending; every window full screen, owner 2026-11-13).
 *
 * src/ui/mobile-sheet.ts owns WHICH stop the window is at; this module makes
 * the glass get there. It is loaded only when the phone shell activates, so
 * a desktop or embed session never downloads it, and nothing here is
 * required for function: without it a stop change lands at once, and the
 * window's "Back to map" is static markup the controller wires itself.
 *
 * TWO REPRESENTATIONS, ONE PICTURE. At rest the stylesheet makes every open
 * stop one full-screen window, with no transform
 * (src/styles/mobile-panels.css). To move, `begin` gives the element its
 * full height once and a `transform` that puts its top edge where it
 * already was; from then on only the transform changes, per frame, until
 * `rest` hands the element back to the stylesheet. Height is never animated.
 *
 * A stop change (a door, Back to map, Escape, a report opening) calls `go`
 * and the shared spring (src/util/spring.ts `runSpring`) carries the window
 * up from below the edge or back down past it. On the way up the
 * controller's `present` stamps the new stop first, so the content rises
 * with the glass; on the way to closed it is stamped last, so the content
 * leaves with it.
 *
 * REDUCED MOTION. `runSpring` lands on the stop at once: same end state,
 * no travel.
 *
 * Presentation only. Nothing here enters the URL or reads map state.
 */

import { SHEET_TOKENS, sheetOffsets } from '../config/sheet-detents';
import type { SheetOffsets } from '../config/sheet-detents';
import { rubberBand } from '../util/gesture';
import { prefersReducedMotion } from '../util/motion';
import { runSpring } from '../util/spring';
import type { SpringRun } from '../util/spring';
import type { SheetDetent, SheetMotion, SheetMotionHost } from './mobile-sheet';

/**
 * Attach the motion to the window. Called once, by the controller, the
 * first time the phone shell activates.
 */
export function attachSheetMotion(
  app: HTMLElement,
  sheet: HTMLElement,
  host: SheetMotionHost
): SheetMotion {
  const head = sheet.querySelector<HTMLElement>('.sheet-grabber-row');

  let offsets: SheetOffsets = sheetOffsets({ peek: 0, half: 0, full: 0 });
  /** Displacement toward closed, px. Meaningful only while `moving`. */
  let offset = 0;
  let moving = false;
  let spring: SpringRun | null = null;
  let runId = 0;

  // The stylesheet owns the window's height; this reads it.
  const probe = document.createElement('i');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText =
    'position:fixed;top:0;left:0;width:0;height:var(--sheet-h-full);visibility:hidden;pointer-events:none';
  app.appendChild(probe);

  /** Every open stop is the same full-screen seat. */
  const measure = (): number => {
    const full = probe.getBoundingClientRect().height;
    offsets = sheetOffsets({ peek: full, half: full, full });
    return full;
  };

  const place = (value: number): void => {
    offset = value;
    sheet.style.transform = `translate3d(0,${value}px,0)`;
  };

  /** Enter the moving representation at the seat of `from`. A no-op mid-flight. */
  const begin = (from: SheetDetent): void => {
    if (moving) return;
    const full = measure();
    moving = true;
    sheet.setAttribute('data-sheet-moving', '');
    sheet.style.height = `${full}px`;
    place(offsets[from]);
  };

  /** Hand the element back to the stylesheet. */
  const rest = (): void => {
    moving = false;
    sheet.removeAttribute('data-sheet-moving');
    sheet.style.height = '';
    sheet.style.transform = '';
  };

  const halt = (): void => {
    runId += 1;
    spring?.stop();
    spring = null;
  };

  /** Carry the window to `to` on the shared spring. */
  const run = (to: SheetDetent, done: () => void): void => {
    halt();
    const id = runId;
    let live = true;
    const handle = runSpring({
      from: offset,
      to: offsets[to],
      velocity: 0,
      reducedMotion: prefersReducedMotion(),
      // A spring that passes the top meets resistance; the glass runs below the edge.
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

  // The title follows the static "Back to map" in the header row.
  const title = document.createElement('h2');
  title.id = 'sheet-title';
  title.className = 'sheet-title';
  head?.append(title);

  /**
   * The title is the open door's own word, read from the door, so the two
   * can never disagree. A sheet no door claimed is named for what it shows:
   * a surface that fills such a sheet says its own name in `data-sheet-name`
   * on #app (the ENSO guide, src/ui/enso-chain.ts), and with none the name
   * follows the view mode. A door always outranks that name.
   */
  const describe = (): void => {
    const stamped = app.getAttribute('data-sheet-detent') as SheetDetent | null;
    if (!stamped) return;
    const door = app.getAttribute('data-sheet-tab');
    const named = door === null ? app.getAttribute('data-sheet-name') : null;
    const tab =
      door ??
      (stamped === 'full' && sheet.querySelector('#sheet-report .impact-panel.open')
        ? 'brief'
        : app.classList.contains('view-console')
          ? 'layers'
          : 'place');
    const word =
      named ??
      document
        .querySelector(`#mobile-footer-nav button[data-tab="${tab}"] span`)
        ?.textContent?.trim() ??
      '';
    if (title.textContent !== word) title.textContent = word;
  };
  new MutationObserver(describe).observe(app, {
    attributes: true,
    attributeFilter: ['data-sheet-detent', 'data-sheet-tab', 'data-sheet-name', 'class']
  });
  describe();

  return {
    go(from, to) {
      if (to === 'closed') {
        begin(from);
      } else {
        // Hold the old seat while the content changes, or start below the edge.
        if (from !== 'closed') begin(from);
        host.present();
        if (moving) place(offset);
        else begin('closed');
      }
      run(to, () => {
        if (to === 'closed') host.present();
        rest();
        host.settle();
      });
    },
    reset() {
      halt();
      if (moving) rest();
    }
  };
}
