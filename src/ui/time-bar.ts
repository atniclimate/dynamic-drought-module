/**
 * The time bar (0.5.0b): one map-bottom control that carries the temporal
 * axis for whichever condition surface is active, and whose affordances
 * TEACH the temporal honesty doctrine (critical-review Section 5):
 *
 *   - Authored, stepped products (USDM weeks, CPC outlooks) get a discrete
 *     snap-to-stop rail and step buttons. No Play button exists on them.
 *   - The one continuous field (SST anomaly) gets a Play button. The
 *     affordance difference IS the lesson: you can replay a measured daily
 *     field; you can only leaf through an analyst's weekly judgments.
 *   - The stamp under the rail is the register indicator: the observed
 *     register shows a hard VALID date in the accent cyan and display
 *     face; the outlook register swaps instrument to an ISSUED date plus
 *     valid-through range in the warn amber and body face. The change is
 *     deliberate and unmistakable (CLAUDE.md section 6 invariant 6).
 *
 * The bar lives in the SIDEBAR after place and before the display description
 * (Option 1, D-0.7.0-067; the floating map-bottom bar remains retired). On the
 * mobile Brief shell the same node moves into the at-hand host. Every
 * capability and URL round-trip is unchanged, and exactly one surface owns
 * the bar at a time (surfaces are mutually exclusive). Layer modules install a
 * spec on activate and remove it on deactivate; the bar renders whatever the
 * current owner declares and never invents temporal capability. Embed mode has
 * no sidebar, so the render also mirrors the stamp HEADLINE into the on-map
 * `#embed-date-stamp` chip (visible only in embed via app.css): the
 * smallest honest valid-date statement the date-honesty rule requires.
 *
 * Accessibility: the rail is a native range input (arrow keys work, the
 * discrete `step` snaps by construction); the stamp is aria-live polite so
 * a step announces its new date; every button meets the 24 px target rule.
 */

import { escapeHtml } from '../util/escape';

/** A mode chip row (the USDM absolute / 1-week / 4-week change toggle). */
export interface TimeBarMode {
  readonly key: string;
  readonly label: string;
  /** Accessible description of what the mode shows (or why it is off). */
  readonly title: string;
  /** Honestly unavailable (e.g. change maps exist for the current week
   * only); rendered disabled with the explanatory title, never hidden. */
  readonly disabled?: boolean;
}

/** A jump chip: a labeled instrument switch rendered beyond the rail
 * (outlook stops from the observed register, and the way back). */
export interface TimeBarJump {
  readonly key: string;
  readonly label: string;
  readonly title: string;
  /** Hatched styling marks a jump INTO the outlook register. */
  readonly hatched: boolean;
}

/** The two typographic registers the stamp can render in. */
export type StampRegister = 'observed' | 'outlook';

export interface TimeBarStamp {
  /** Headline line ("VALID JUN 30, 2026" / "ISSUED JUN 30 · THROUGH JUL"). */
  readonly headline: string;
  /** Context line (product name and register description). */
  readonly detail: string;
  readonly register: StampRegister;
}

export interface TimeBarSpec {
  /** Accessible name for the whole control. */
  readonly ariaLabel: string;
  readonly stamp: TimeBarStamp;
  /** Discrete rail; omit for jump-only bars (the outlook register). */
  readonly rail?: {
    /** Number of stops; indices run 0 (oldest) to count-1 (newest). */
    readonly count: number;
    readonly index: number;
    /** Accessible value text for a stop index (a real product date). */
    readonly valueText: (index: number) => string;
    readonly onStep: (index: number) => void;
  };
  readonly modes?: {
    readonly options: readonly TimeBarMode[];
    readonly activeKey: string;
    readonly onSelect: (key: string) => void;
  };
  readonly jumps?: {
    readonly options: readonly TimeBarJump[];
    readonly onJump: (key: string) => void;
  };
  /** Present ONLY on continuous fields (SST). Absent = no Play, ever. */
  readonly play?: {
    readonly playing: boolean;
    /** Disabled while frames buffer; the pill carries the loading state. */
    readonly disabled: boolean;
    readonly onToggle: () => void;
  };
}

let currentOwner: string | null = null;
let currentSpec: TimeBarSpec | null = null;

/**
 * The last markup actually swapped into the container. A re-render whose
 * built markup is IDENTICAL skips the innerHTML swap entirely: the swap
 * replaces every button mid-gesture, and a user's (or Playwright's) click
 * whose mousedown and mouseup straddle the swap dispatches no click event
 * at all (the targets differ, so the event dies on the container). Registry
 * status flaps re-render the bar far more often than its content changes,
 * so without this memo a click shortly after an instrument switch could be
 * silently swallowed (found 2026-07-15 by the temporal-axis suite under a
 * warm worker; the Unit I session). Handlers read `currentSpec` at event
 * time, so a skipped swap never pins stale callbacks.
 */
let lastRenderedHtml: string | null = null;

const mobileSheetMedia: MediaQueryList | null =
  typeof window !== 'undefined' ? window.matchMedia('(max-width: 720px)') : null;
let hostSyncArmed = false;

function container(): HTMLElement | null {
  return document.getElementById('time-bar');
}

/**
 * Move the one time-bar node between its stable desktop and mobile seats.
 * Moving the node preserves its listeners, current specification, and focused
 * descendant. The mobile host is used only by the non-embed Brief shell;
 * console keeps the direct-child seat so its full stack remains complete.
 */
export function syncTimeBarHost(): void {
  const el = container();
  const app = document.getElementById('app');
  const briefHead = document.getElementById('brief-head');
  const mobileHost = document.getElementById('sheet-time-host');
  if (!el || !app || !briefHead || !mobileHost) return;

  const focused =
    document.activeElement instanceof HTMLElement && el.contains(document.activeElement)
      ? document.activeElement
      : null;
  const useMobileHost =
    mobileSheetMedia?.matches === true &&
    app.hasAttribute('data-sheet-detent') &&
    app.classList.contains('view-brief') &&
    !app.classList.contains('embed');

  if (useMobileHost) {
    // mobile-sheet groups its report door after initialization. Keep the
    // stable time host between search and that action group.
    const actions = document.getElementById('sheet-at-hand-actions');
    if (actions?.parentElement === mobileHost.parentElement && mobileHost.nextElementSibling !== actions) {
      actions.insertAdjacentElement('beforebegin', mobileHost);
    }
    if (el.parentElement !== mobileHost) mobileHost.appendChild(el);
  } else if (el.parentElement !== briefHead.parentElement || el.previousElementSibling !== briefHead) {
    briefHead.insertAdjacentElement('afterend', el);
  }

  if (focused && focused.isConnected && document.activeElement !== focused) {
    focused.focus({ preventScroll: true });
  }
}

/** Watch only the presentation hooks that can change the correct host. */
function armTimeBarHostSync(): void {
  if (hostSyncArmed) return;
  const app = document.getElementById('app');
  if (!app) return;
  hostSyncArmed = true;
  const observer = new MutationObserver(syncTimeBarHost);
  observer.observe(app, {
    attributes: true,
    attributeFilter: ['class', 'data-sheet-detent']
  });
  mobileSheetMedia?.addEventListener('change', syncTimeBarHost);
}

/**
 * The minimal embed valid-date stamp (E2, D-0.7.0-058 ruling 1): a chip in
 * the map bottom dock carrying only the stamp headline and register. CSS
 * shows it in embed mode alone; everywhere else the sidebar bar is the
 * temporal surface. Mirrored on every render so the embed date can never
 * drift from the spec the owning surface installed.
 */
function syncEmbedStamp(spec: TimeBarSpec | null): void {
  const stamp = document.getElementById('embed-date-stamp');
  if (!stamp) return;
  if (!spec) {
    stamp.hidden = true;
    stamp.textContent = '';
    return;
  }
  stamp.hidden = false;
  stamp.dataset.register = spec.stamp.register;
  stamp.textContent = spec.stamp.headline;
}

/**
 * Install (or update) the time bar for `owner` (a layer key). The bar
 * shows the given spec until the same owner clears it. A non-owning
 * caller's clear is ignored, so a slow deactivate cannot tear down the
 * bar a newly activated surface just installed.
 */
export function setTimeBar(owner: string, spec: TimeBarSpec): void {
  currentOwner = owner;
  currentSpec = spec;
  render();
}

/** Remove the time bar if `owner` still owns it. */
export function clearTimeBar(owner: string): void {
  if (currentOwner !== owner) return;
  currentOwner = null;
  currentSpec = null;
  render();
}

/** The owning layer key, exposed for tests and the sidebar's debugging. */
export function timeBarOwner(): string | null {
  return currentOwner;
}

/**
 * A focus marker for the control the user is on, so a re-render (the Play
 * loop re-renders each tick to advance the clock) does not silently drop
 * keyboard focus (Section 508). Restored by selector after the swap.
 */
function focusMarker(el: HTMLElement): string | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !el.contains(active)) return null;
  if (active.matches('[data-play]')) return '[data-play]';
  if (active.matches('.time-bar-rail')) return '.time-bar-rail';
  if (active.dataset.step) return `[data-step="${active.dataset.step}"]`;
  if (active.dataset.mode) return `[data-mode="${active.dataset.mode}"]`;
  if (active.dataset.jump) return `[data-jump="${active.dataset.jump}"]`;
  return null;
}

function render(): void {
  armTimeBarHostSync();
  syncTimeBarHost();
  const el = container();
  if (!el) return;

  syncEmbedStamp(currentSpec);

  if (!currentSpec) {
    el.hidden = true;
    el.innerHTML = '';
    lastRenderedHtml = null;
    return;
  }

  const restoreFocus = focusMarker(el);

  const spec = currentSpec;
  el.hidden = false;
  el.setAttribute('aria-label', spec.ariaLabel);
  el.dataset.register = spec.stamp.register;

  const parts: string[] = [];

  // --- rail row: step buttons + discrete range + jumps + play ---
  parts.push('<div class="time-bar-rail-row">');

  if (spec.rail) {
    const atStart = spec.rail.index <= 0;
    const atEnd = spec.rail.index >= spec.rail.count - 1;
    parts.push(
      `<button type="button" class="time-bar-step" data-step="-1" aria-label="Previous date" ${atStart ? 'disabled' : ''}>` +
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>' +
        '</button>'
    );
    parts.push(
      `<input type="range" class="time-bar-rail" min="0" max="${spec.rail.count - 1}" step="1" ` +
        `value="${spec.rail.index}" aria-valuetext="${escapeHtml(spec.rail.valueText(spec.rail.index))}" ` +
        `aria-label="${escapeHtml(spec.ariaLabel)} date" />`
    );
    parts.push(
      `<button type="button" class="time-bar-step" data-step="1" aria-label="Next date" ${atEnd ? 'disabled' : ''}>` +
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>' +
        '</button>'
    );
  }

  if (spec.jumps) {
    for (const j of spec.jumps.options) {
      parts.push(
        `<button type="button" class="time-bar-jump${j.hatched ? ' hatched' : ''}" ` +
          `data-jump="${escapeHtml(j.key)}" title="${escapeHtml(j.title)}">${escapeHtml(j.label)}</button>`
      );
    }
  }

  if (spec.play) {
    const label = spec.play.playing ? 'Pause' : 'Play';
    const icon = spec.play.playing
      ? '<rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/>'
      : '<polygon points="6 4 20 12 6 20"/>';
    parts.push(
      `<button type="button" class="time-bar-play" data-play aria-label="${label}" title="${label}" ${spec.play.disabled ? 'disabled' : ''}>` +
        `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" stroke="none" aria-hidden="true">${icon}</svg>` +
        '</button>'
    );
  }

  parts.push('</div>');

  // --- stamp: the register indicator ---
  parts.push(
    '<div class="time-bar-stamp" aria-live="polite" aria-atomic="true">' +
      `<span class="time-bar-stamp-headline">${escapeHtml(spec.stamp.headline)}</span>` +
      `<span class="time-bar-stamp-detail">${escapeHtml(spec.stamp.detail)}</span>` +
      '</div>'
  );

  // --- mode chips (USDM absolute / change) ---
  if (spec.modes) {
    parts.push('<div class="time-bar-modes" role="group" aria-label="View mode">');
    for (const m of spec.modes.options) {
      const active = m.key === spec.modes.activeKey;
      parts.push(
        `<button type="button" class="time-bar-mode${active ? ' active' : ''}" ` +
          `data-mode="${escapeHtml(m.key)}" title="${escapeHtml(m.title)}" ` +
          `aria-pressed="${active ? 'true' : 'false'}"${m.disabled ? ' disabled' : ''}>${escapeHtml(m.label)}</button>`
      );
    }
    parts.push('</div>');
  }

  // Identical markup: keep the existing DOM and its listeners (the memo
  // note above; the handlers below read `currentSpec` at event time, so
  // the freshly installed spec still drives them).
  const html = parts.join('');
  if (html === lastRenderedHtml) return;
  el.innerHTML = html;
  lastRenderedHtml = html;

  // --- wiring ---
  // Every handler reads `currentSpec` at EVENT time (never the `spec` this
  // render closed over): a later content-identical render skips the swap
  // and keeps these listeners, and they must drive the newest callbacks.
  if (spec.rail) {
    const rail = el.querySelector<HTMLInputElement>('.time-bar-rail');
    const step = (delta: number): void => {
      const r = currentSpec?.rail;
      if (!r) return;
      const next = Math.min(r.count - 1, Math.max(0, r.index + delta));
      if (next !== r.index) r.onStep(next);
    };
    rail?.addEventListener('change', () => {
      const v = Number(rail.value);
      if (Number.isInteger(v)) currentSpec?.rail?.onStep(v);
    });
    // `input` fires per notch while dragging; stepping per notch would
    // spam fetches, so the fetch-triggering step waits for `change`
    // (release / arrow key). The valuetext still updates live for SR users.
    rail?.addEventListener('input', () => {
      const v = Number(rail.value);
      const r = currentSpec?.rail;
      if (r && Number.isInteger(v)) {
        rail.setAttribute('aria-valuetext', r.valueText(v));
      }
    });
    for (const btn of el.querySelectorAll<HTMLButtonElement>('.time-bar-step')) {
      btn.addEventListener('click', () => step(Number(btn.dataset.step)));
    }
  }

  if (spec.jumps) {
    for (const btn of el.querySelectorAll<HTMLButtonElement>('.time-bar-jump')) {
      btn.addEventListener('click', () => {
        const key = btn.dataset.jump;
        if (key) currentSpec?.jumps?.onJump(key);
      });
    }
  }

  if (spec.modes) {
    for (const btn of el.querySelectorAll<HTMLButtonElement>('.time-bar-mode')) {
      btn.addEventListener('click', () => {
        const key = btn.dataset.mode;
        if (key && key !== currentSpec?.modes?.activeKey) currentSpec?.modes?.onSelect(key);
      });
    }
  }

  if (spec.play) {
    el.querySelector<HTMLButtonElement>('[data-play]')?.addEventListener(
      'click',
      () => currentSpec?.play?.onToggle()
    );
  }

  if (restoreFocus) {
    el.querySelector<HTMLElement>(restoreFocus)?.focus({ preventScroll: true });
  }
}
