/**
 * Locate: the card (owner direction 2026-11-09 (sprint), DR-pending).
 *
 * One glass card says what Locate is doing and what it found. It rides the
 * shared bottom dock (`#map-bottom-dock`), the flex column where notices
 * and the OpenStreetMap credit already stack, so it can never cover them
 * and they can never cover it. With the phone sheet closed it sits beside
 * the Locate cell that opened it; when a place's briefing raises the sheet,
 * the dock (and so the card) rides the sheet's top edge.
 *
 * THE FIGURE IS THE MARKER'S LEGEND. The small figure at the head of the
 * card is the map marker in miniature: a person in a ring. A solid ring is
 * a good fix, a dashed ring an approximate one, an open ring a search in
 * progress, a struck ring a search that stopped. The map and the card
 * therefore say the same thing in the same marks.
 *
 * TWO NODES, ON PURPOSE. The outer element is the dock's child: the sheet's
 * motion moves every dock child by an inline transform while the sheet
 * travels (src/ui/sheet-motion.ts), so nothing here may animate it. The
 * plate inside it is the glass, and the one settle on arrival is the
 * plate's.
 *
 * This module only draws. It is handed a plain description of the card and
 * rebuilds the card's contents from it; it holds no position and decides
 * nothing. Focus survives a redraw: a control that had focus is found again
 * by its id.
 */

/** Which face the figure wears. */
export type CardTone = 'offer' | 'busy' | 'found' | 'approximate' | 'stopped';

export interface CardAction {
  readonly id: string;
  readonly label: string;
  readonly style: 'primary' | 'quiet';
  readonly run: () => void;
}

export type CardBlock =
  | { readonly type: 'text'; readonly text: string; readonly style?: 'note' | 'caveat' }
  /** One row of buttons. They wrap where the card is narrow. */
  | { readonly type: 'actions'; readonly items: readonly CardAction[] }
  | {
      readonly type: 'check';
      readonly id: string;
      readonly label: string;
      /** A second, quieter line inside the same label. */
      readonly hint: string;
      readonly checked: boolean;
      readonly onChange: (checked: boolean) => void;
    };

export interface CardView {
  readonly tone: CardTone;
  readonly title: string;
  /** Lines under the title: the qualification of the claim the title makes. */
  readonly lines: readonly string[];
  /** The running time bound, drawn as a bar that empties. Null when no clock runs. */
  readonly bound: { readonly totalMs: number; readonly elapsedMs: number } | null;
  readonly blocks: readonly CardBlock[];
  /**
   * When set, the body folds behind a control in the head, so the card can
   * stand as two lines above a raised sheet. Null: the body always shows.
   */
  readonly fold: { readonly open: boolean; readonly label: string; readonly toggle: () => void } | null;
  /**
   * The closing control at the head of the card; its label says what it does
   * in this state. Null where a named button is the only honest control (a
   * search in flight is cancelled, never just hidden) or where the card
   * stays for as long as the position does.
   */
  readonly close: { readonly label: string; readonly run: () => void } | null;
}

const FIGURE =
  '<svg class="locate-figure" viewBox="0 0 40 40" aria-hidden="true" focusable="false">' +
  '<circle class="locate-figure-ring" cx="20" cy="20" r="18"/>' +
  '<circle class="locate-figure-badge" cx="20" cy="20" r="11.5"/>' +
  '<g class="locate-figure-person"><circle cx="20" cy="16.4" r="2.9"/><path d="M14.3 26.3a5.7 5.7 0 0 1 11.4 0z"/></g>' +
  '<path class="locate-figure-strike" d="M9 31 31 9"/></svg>';

const ICON = (path: string): string =>
  `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${path}"/></svg>`;
const CLOSE_GLYPH = ICON('M6 6l12 12M18 6 6 18');
const FOLD_GLYPH = ICON('M6 9l6 6 6-6');
const CHECK_GLYPH =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3.2 8.4l3.1 3.1 6.5-7"/></svg>';

export interface LocateCard {
  /** Show the card with this content. */
  show(view: CardView): void;
  hide(): void;
  readonly shown: boolean;
  /** Move focus to the card's title, so a keyboard or screen-reader user lands on the answer. */
  focusTitle(): void;
  /** Whether focus is inside the card. */
  hasFocus(): boolean;
  readonly element: HTMLElement;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Keep a measure and its unit, and a distance and its conversion, on one line: "20 m (65 ft)". */
function keepUnits(text: string): string {
  return text.replace(/(\d) (km|mi|m|ft)\b( \()?/g, (_, digit: string, unit: string, open?: string) =>
    `${digit}\u00a0${unit}${open ? '\u00a0(' : ''}`
  );
}

function renderBlocks(host: HTMLElement, blocks: readonly CardBlock[]): void {
  for (const block of blocks) {
    if (block.type === 'text') {
      host.appendChild(
        el('p', `locate-card-text${block.style ? ` locate-card-${block.style}` : ''}`, keepUnits(block.text))
      );
    } else if (block.type === 'actions') {
      const row = el('div', 'locate-card-actions');
      for (const item of block.items) {
        const button = el('button', `locate-card-action locate-card-action-${item.style}`, item.label);
        button.type = 'button';
        button.dataset['locateId'] = item.id;
        button.addEventListener('click', () => item.run());
        row.appendChild(button);
      }
      host.appendChild(row);
    } else {
      const label = el('label', 'locate-card-check');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = block.checked;
      input.dataset['locateId'] = block.id;
      input.addEventListener('change', () => block.onChange(input.checked));
      const box = el('span', 'locate-card-check-box');
      box.innerHTML = CHECK_GLYPH;
      const words = el('span', 'locate-card-check-words');
      words.append(el('span', 'locate-card-check-label', block.label), el('span', 'locate-card-check-hint', block.hint));
      label.append(input, box, words);
      host.appendChild(label);
    }
  }
}

/** Build the card once, in the bottom dock. Hidden until `show`. */
export function createLocateCard(dock: HTMLElement, onEscape: () => void): LocateCard {
  const card = el('section', 'locate-card');
  card.id = 'locate-card';
  card.hidden = true;
  card.setAttribute('aria-labelledby', 'locate-card-title');
  card.innerHTML =
    `<div class="locate-card-plate"><header class="locate-card-head">${FIGURE}<div class="locate-card-reading">` +
    '<h2 id="locate-card-title" class="locate-card-title" tabindex="-1"></h2></div>' +
    `<button type="button" class="locate-card-tool locate-card-fold" data-locate-id="fold" aria-controls="locate-card-body" hidden>${FOLD_GLYPH}</button>` +
    `<button type="button" class="locate-card-tool locate-card-close" data-locate-id="close">${CLOSE_GLYPH}</button></header>` +
    '<div class="locate-card-bound" aria-hidden="true" hidden><span></span></div>' +
    '<div id="locate-card-body" class="locate-card-body"></div></div>';
  // First in the dock: notices and the credit stay between the card and the scale.
  dock.prepend(card);

  const plate = card.querySelector<HTMLElement>('.locate-card-plate')!;
  const head = card.querySelector<HTMLElement>('.locate-card-head')!;
  const title = card.querySelector<HTMLElement>('.locate-card-title')!;
  const reading = card.querySelector<HTMLElement>('.locate-card-reading')!;
  const fold = card.querySelector<HTMLButtonElement>('.locate-card-fold')!;
  const close = card.querySelector<HTMLButtonElement>('.locate-card-close')!;
  const bound = card.querySelector<HTMLElement>('.locate-card-bound')!;
  const bar = bound.querySelector<HTMLElement>('span')!;
  const body = card.querySelector<HTMLElement>('.locate-card-body')!;
  let closeRun: () => void = () => {};
  let foldRun: () => void = () => {};
  close.addEventListener('click', () => closeRun());
  fold.addEventListener('click', () => foldRun());
  // A body longer than the map band scrolls inside the plate (the stylesheet's
  // cap), under the head. One mark says there is more below the fold and
  // goes at the end; the other says the body has passed under the head.
  const markScroll = (): void => {
    plate.toggleAttribute('data-more', plate.scrollHeight - plate.clientHeight - plate.scrollTop > 8);
    plate.toggleAttribute('data-scrolled', plate.scrollTop > 0);
  };
  plate.addEventListener('scroll', markScroll, { passive: true });
  // The cap follows the sheet's top edge, so the plate's box changes with no redraw here.
  if (typeof ResizeObserver === 'function') new ResizeObserver(markScroll).observe(plate);
  card.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    // The sheet's own Escape must not also fire for this press.
    event.stopPropagation();
    onEscape();
  });

  return {
    element: card,
    get shown(): boolean {
      return !card.hidden;
    },
    show(view: CardView): void {
      const active = document.activeElement;
      const focusedId =
        active instanceof HTMLElement && card.contains(active) ? (active.dataset['locateId'] ?? 'title') : null;
      // A redraw of the same card (a box ticked below the fold) keeps its place; a new claim starts at its title.
      const scrolled = !card.hidden && title.textContent === view.title ? plate.scrollTop : 0;

      plate.dataset['tone'] = view.tone;
      title.textContent = view.title;
      for (const line of reading.querySelectorAll('.locate-card-line')) line.remove();
      for (const line of view.lines) reading.appendChild(el('p', 'locate-card-line', keepUnits(line)));
      close.hidden = view.close === null;
      if (view.close) {
        close.setAttribute('aria-label', view.close.label);
        closeRun = view.close.run;
      }

      fold.hidden = view.fold === null;
      // Folded, the card may stand as its title alone where the screen is short (the stylesheet decides).
      plate.toggleAttribute('data-folded', view.fold !== null && !view.fold.open);
      // Unfolded, it may take the dock's width where the screen is short and wide.
      card.toggleAttribute('data-open', view.fold !== null && view.fold.open);
      if (view.fold) {
        fold.setAttribute('aria-label', view.fold.label);
        fold.setAttribute('aria-expanded', String(view.fold.open));
        foldRun = view.fold.toggle;
      }

      bound.hidden = view.bound === null;
      if (view.bound) {
        // A redraw must not restart the clock: the bar resumes where the time is.
        bar.style.animationDuration = `${view.bound.totalMs}ms`;
        bar.style.animationDelay = `-${Math.max(0, Math.round(view.bound.elapsedMs))}ms`;
      }

      body.replaceChildren();
      const showBody = view.blocks.length > 0 && (view.fold === null || view.fold.open);
      if (showBody) renderBlocks(body, view.blocks);
      body.hidden = !showBody;

      if (card.hidden) {
        card.hidden = false;
        // One settle as the card arrives; the stylesheet's reduced-motion block removes it.
        plate.classList.remove('locate-card-arriving');
        void plate.offsetWidth;
        plate.classList.add('locate-card-arriving');
      }
      if (focusedId !== null) {
        const next =
          focusedId === 'title' ? title : card.querySelector<HTMLElement>(`[data-locate-id="${focusedId}"]:not([hidden])`);
        (next ?? title).focus({ preventScroll: true });
      }
      // A control brought into view by the keyboard stops below the head, not under it.
      plate.style.scrollPaddingTop = `${head.offsetHeight}px`;
      plate.scrollTop = scrolled;
      markScroll();
    },
    hide(): void {
      card.hidden = true;
      card.removeAttribute('data-open');
      body.replaceChildren();
    },
    focusTitle(): void {
      title.focus({ preventScroll: true });
    },
    hasFocus(): boolean {
      return card.contains(document.activeElement);
    }
  };
}
