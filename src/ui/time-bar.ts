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
 * The bar lives on the map (not the sidebar) so it survives embed mode
 * with the sidebar collapsed, and it is owned by exactly one surface at a
 * time (surfaces are mutually exclusive). Layer modules install a spec on
 * activate and remove it on deactivate; the bar renders whatever the
 * current owner declares and never invents temporal capability.
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
  /** Accessible description of what the mode shows. */
  readonly title: string;
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

function container(): HTMLElement | null {
  return document.getElementById('time-bar');
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

function render(): void {
  const el = container();
  if (!el) return;

  if (!currentSpec) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }

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
          `aria-pressed="${active ? 'true' : 'false'}">${escapeHtml(m.label)}</button>`
      );
    }
    parts.push('</div>');
  }

  el.innerHTML = parts.join('');

  // --- wiring ---
  if (spec.rail) {
    const rail = el.querySelector<HTMLInputElement>('.time-bar-rail');
    const step = (delta: number): void => {
      if (!spec.rail) return;
      const next = Math.min(
        spec.rail.count - 1,
        Math.max(0, spec.rail.index + delta)
      );
      if (next !== spec.rail.index) spec.rail.onStep(next);
    };
    rail?.addEventListener('change', () => {
      const v = Number(rail.value);
      if (Number.isInteger(v)) spec.rail?.onStep(v);
    });
    // `input` fires per notch while dragging; stepping per notch would
    // spam fetches, so the fetch-triggering step waits for `change`
    // (release / arrow key). The valuetext still updates live for SR users.
    rail?.addEventListener('input', () => {
      const v = Number(rail.value);
      if (spec.rail && Number.isInteger(v)) {
        rail.setAttribute('aria-valuetext', spec.rail.valueText(v));
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
        if (key) spec.jumps?.onJump(key);
      });
    }
  }

  if (spec.modes) {
    for (const btn of el.querySelectorAll<HTMLButtonElement>('.time-bar-mode')) {
      btn.addEventListener('click', () => {
        const key = btn.dataset.mode;
        if (key && key !== spec.modes?.activeKey) spec.modes?.onSelect(key);
      });
    }
  }

  if (spec.play) {
    el.querySelector<HTMLButtonElement>('[data-play]')?.addEventListener(
      'click',
      () => spec.play?.onToggle()
    );
  }
}
