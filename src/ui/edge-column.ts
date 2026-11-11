/**
 * The phone shell's right-edge column manager (owner direction 2026-11-09
 * (sprint), DR-pending).
 *
 * ONE COLUMN, ONE OWNER. While the phone shell is active (the shell stamps
 * `data-sheet-detent` on #app; never on desktop, never in an embed) every
 * right-edge control sits inside `#edge-column`: the map tools, the four
 * panel doors, the four hazard views and the view tools. The groups share
 * one flow, so two controls cannot occupy the same pixels, and the DOM
 * order is the visual order, so keyboard focus walks the column from the
 * top. Before this the doors were anchored from a clamped top and the
 * hazard views from the bottom, and the two stacks met on a short screen.
 *
 * THE SAME NODES MOVE. Nothing is cloned or rebuilt: each control keeps its
 * listeners, its pressed or expanded state and its accessible name, and
 * returns to its home seat when the phone shell goes away. The moving is
 * done by the seat watchers in src/ui/map-control-seat.ts, which this
 * module serves as the phone seat provider; a control another surface has
 * borrowed (the LAYERS studio borrows the satellite control) is left alone
 * until it is returned.
 *
 * WHAT FITS is decided by the pure planner in src/config/edge-column.ts
 * from the column's measured height and the number of controls each group
 * is showing. This module applies the plan: cell size and gap as custom
 * properties on #app, one or two tracks, and which groups are folded behind
 * a single cell that opens the rest as a row beside it.
 *
 * Presentation only. Nothing here enters the URL, and no map state is read
 * or written.
 */

import {
  EDGE_COLUMN_PROPERTIES,
  EDGE_GROUP_NAMES,
  EDGE_GROUP_ORDER,
  planEdgeColumn
} from '../config/edge-column';
import type { EdgeGroupId, EdgePlan } from '../config/edge-column';
import {
  notifyPhoneSeats,
  setPhoneSeatProvider,
  watchPhoneSeat
} from './map-control-seat';
import type { PhoneSeat } from './map-control-seat';

const SHELL_ATTRIBUTE = 'data-sheet-detent';
const ORDER_ATTRIBUTE = 'data-edge-order';
const WORD_ATTRIBUTE = 'data-edge-word';
const RESERVE_PROPERTY = '--edge-reserve-bottom';

/** Glyphs for a folded group with no single control to stand for it. */
const MORE_GLYPH =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true" focusable="false"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';

interface GroupParts {
  readonly root: HTMLElement;
  readonly fold: HTMLButtonElement;
  readonly body: HTMLElement;
}

interface TrackParts {
  readonly top: HTMLElement;
  readonly bottom: HTMLElement;
}

let app: HTMLElement | null = null;
let column: HTMLElement | null = null;
let bench: HTMLElement | null = null;
const tracks: TrackParts[] = [];
const groups = new Map<EdgeGroupId, GroupParts>();
let badge: HTMLElement | null = null;
let badgeHome: HTMLElement | null = null;
let mounted = false;
let applying = false;
let planKey = '';
let currentPlan: EdgePlan | null = null;
let openGroup: EdgeGroupId | null = null;
const planListeners = new Set<(plan: EdgePlan) => void>();

function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function buildColumn(host: HTMLElement): void {
  const root = el('div', 'edge-column');
  root.id = 'edge-column';
  root.hidden = true;
  for (let i = 0; i < 2; i += 1) {
    const track = el('div', 'edge-track');
    track.dataset['track'] = String(i);
    const top = el('div', 'edge-stack');
    top.dataset['stack'] = 'top';
    const bottom = el('div', 'edge-stack');
    bottom.dataset['stack'] = 'bottom';
    track.append(top, bottom);
    root.appendChild(track);
    tracks.push({ top, bottom });
  }
  for (const id of EDGE_GROUP_ORDER) {
    const names = EDGE_GROUP_NAMES[id];
    const groupRoot = el('div', 'edge-group');
    groupRoot.dataset['edgeGroup'] = id;
    const fold = document.createElement('button');
    fold.type = 'button';
    fold.className = 'edge-fold';
    fold.hidden = true;
    fold.setAttribute('aria-expanded', 'false');
    fold.setAttribute('aria-controls', `edge-body-${id}`);
    fold.setAttribute('aria-label', names.fold);
    const body = el('div', 'edge-body');
    body.id = `edge-body-${id}`;
    // The doors and the hazard views arrive inside their own named
    // containers; the two groups of single controls are named here.
    if (id === 'utility' || id === 'view') {
      body.setAttribute('role', 'group');
      body.setAttribute('aria-label', names.group);
    }
    fold.addEventListener('click', () => setOpen(openGroup === id ? null : id, true));
    body.addEventListener('click', (event) => onBodyClick(id, event));
    groupRoot.append(fold, body);
    groups.set(id, { root: groupRoot, fold, body });
    const first = tracks[0];
    if (first) (id === 'utility' ? first.top : first.bottom).appendChild(groupRoot);
  }
  root.addEventListener('keydown', onColumnKeydown);
  host.appendChild(root);
  column = root;

  // Controls made for the column wait here outside the phone shell.
  const holding = el('div', 'edge-bench');
  holding.hidden = true;
  host.appendChild(holding);
  bench = holding;
}

// ---------------------------------------------------------------------------
// The phone seat provider (see src/ui/map-control-seat.ts)
// ---------------------------------------------------------------------------

function stampTarget(node: HTMLElement): HTMLElement | null {
  if (node instanceof HTMLButtonElement) return node;
  const buttons = node.querySelectorAll<HTMLElement>('button');
  return buttons.length === 1 ? (buttons[0] ?? null) : null;
}

function place(node: HTMLElement, seat: PhoneSeat): void {
  const parts = groups.get(seat.group);
  if (!parts) return;
  node.setAttribute(ORDER_ATTRIBUTE, String(seat.order));
  if (seat.word) stampTarget(node)?.setAttribute(WORD_ATTRIBUTE, seat.word);
  let before: Element | null = null;
  for (const child of parts.body.children) {
    if (child === node) continue;
    if (Number(child.getAttribute(ORDER_ATTRIBUTE) ?? 0) > seat.order) {
      before = child;
      break;
    }
  }
  parts.body.insertBefore(node, before);
}

function release(node: HTMLElement): void {
  node.removeAttribute(ORDER_ATTRIBUTE);
  stampTarget(node)?.removeAttribute(WORD_ATTRIBUTE);
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/**
 * Whether a control counts toward its group: it is not hidden itself, nothing
 * between it and the group's body is hidden, and it is not styled away.
 *
 * The group's OWN `hidden` must not count. The manager sets that attribute
 * on a group the plan did not place (a group with nothing to show), so a
 * count that read it would stay at zero after the group's controls came
 * back, and the group would be hidden for the life of the page. That was
 * the fault: the Layers studio borrows Satellite, the view group empties
 * and is hidden, and Satellite never returned to the column.
 */
export function countsTowardGroup(button: HTMLElement, body: HTMLElement): boolean {
  if (button.hidden) return false;
  const hiddenAbove = button.closest<HTMLElement>('[hidden]');
  if (hiddenAbove !== null && body.contains(hiddenAbove)) return false;
  return getComputedStyle(button).display !== 'none';
}

function shownCells(body: HTMLElement): HTMLElement[] {
  const cells: HTMLElement[] = [];
  for (const button of body.querySelectorAll<HTMLElement>('button')) {
    if (countsTowardGroup(button, body)) cells.push(button);
  }
  return cells;
}

function refresh(): void {
  if (!mounted || applying || !column || !app) return;
  const available = column.clientHeight;
  if (available <= 0) return;
  const plan = planEdgeColumn({
    availableHeight: available,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    groups: EDGE_GROUP_ORDER.map((id) => {
      const parts = groups.get(id);
      return { id, count: parts ? shownCells(parts.body).length : 0 };
    }),
    badge: badge !== null && badge.parentElement !== badgeHome
  });
  const key = JSON.stringify(plan);
  if (key !== planKey) {
    planKey = key;
    currentPlan = plan;
    apply(plan);
    for (const fn of [...planListeners]) fn(plan);
  }
  mirrorFolds();
}

function apply(plan: EdgePlan): void {
  if (!column || !app) return;
  applying = true;
  try {
    const active = document.activeElement;
    const focused = active instanceof HTMLElement && column.contains(active) ? active : null;
    app.style.setProperty(EDGE_COLUMN_PROPERTIES.size, `${plan.size}px`);
    app.style.setProperty(EDGE_COLUMN_PROPERTIES.gap, `${plan.gap}px`);
    app.style.setProperty(EDGE_COLUMN_PROPERTIES.width, `${plan.width}px`);
    column.dataset['tracks'] = String(plan.tracks.length);
    column.dataset['fits'] = String(plan.fits);
    column.dataset['plan'] = `${plan.size}/${plan.tracks.length}/${plan.folded.join('+') || 'none'}`;
    const placed = new Set<EdgeGroupId>();
    plan.tracks.forEach((ids, index) => {
      const track = tracks[index];
      if (!track) return;
      for (const id of ids) {
        const parts = groups.get(id);
        if (!parts) continue;
        const stack = id === 'utility' ? track.top : track.bottom;
        if (parts.root.parentElement !== stack || parts.root.nextElementSibling !== null) {
          stack.appendChild(parts.root);
        }
        parts.root.hidden = false;
        placed.add(id);
      }
    });
    for (const [id, parts] of groups) {
      if (!placed.has(id)) parts.root.hidden = true;
      const folded = plan.folded.includes(id);
      parts.root.toggleAttribute('data-folded', folded);
      parts.fold.hidden = !folded;
      if (!folded && openGroup === id) setOpen(null, false);
      if (!folded) parts.root.removeAttribute('data-open');
    }
    if (badge && badge.parentElement !== badgeHome) {
      const track = tracks[plan.badgeTrack ?? 0];
      if (track && badge.parentElement !== track.top) track.top.prepend(badge);
    }
    if (focused?.isConnected && document.activeElement !== focused) {
      focused.focus({ preventScroll: true });
    }
  } finally {
    applying = false;
  }
}

// ---------------------------------------------------------------------------
// Folded groups
// ---------------------------------------------------------------------------

/** A folded group's one cell shows the control that is on, so the state stays readable. */
function mirrorFolds(): void {
  for (const [id, parts] of groups) {
    if (parts.fold.hidden) continue;
    const names = EDGE_GROUP_NAMES[id];
    const current =
      id === 'hazards'
        ? parts.body.querySelector<HTMLElement>('button[aria-pressed="true"]')
        : id === 'panels'
          ? parts.body.querySelector<HTMLElement>('button[aria-expanded="true"]')
          : null;
    const glyph = current?.querySelector('svg')?.cloneNode(true) ?? null;
    const word =
      current?.querySelector('.map-control-label, span')?.textContent?.trim() || names.word;
    const signature = `${current ? word : ''}|${glyph ? 'own' : 'more'}`;
    if (parts.fold.dataset['mirror'] === signature) continue;
    parts.fold.dataset['mirror'] = signature;
    parts.fold.toggleAttribute('data-current', current !== null);
    parts.fold.setAttribute(
      'aria-label',
      current ? `${names.fold}: ${word} is on` : names.fold
    );
    parts.fold.setAttribute(WORD_ATTRIBUTE, word);
    if (glyph instanceof Element) parts.fold.replaceChildren(glyph);
    else parts.fold.innerHTML = MORE_GLYPH;
  }
}

function onOutsidePointer(event: PointerEvent): void {
  if (openGroup === null) return;
  const parts = groups.get(openGroup);
  const target = event.target;
  if (parts && target instanceof Node && parts.root.contains(target)) return;
  setOpen(null, false);
}

function setOpen(id: EdgeGroupId | null, moveFocus: boolean): void {
  if (openGroup === id) return;
  const previous = openGroup !== null ? groups.get(openGroup) : undefined;
  if (previous) {
    previous.root.removeAttribute('data-open');
    previous.fold.setAttribute('aria-expanded', 'false');
    if (moveFocus && id === null && previous.body.contains(document.activeElement)) {
      previous.fold.focus({ preventScroll: true });
    }
  }
  openGroup = id;
  document.removeEventListener('pointerdown', onOutsidePointer, true);
  if (id === null) return;
  const parts = groups.get(id);
  if (!parts) return;
  parts.root.setAttribute('data-open', '');
  parts.fold.setAttribute('aria-expanded', 'true');
  document.addEventListener('pointerdown', onOutsidePointer, true);
  if (moveFocus) {
    const cells = shownCells(parts.body);
    const target =
      cells.find((cell) => cell.getAttribute('aria-pressed') === 'true') ?? cells[0];
    target?.focus({ preventScroll: true });
  }
}

/**
 * A press inside an open folded group closes the row, unless the press
 * opened something the same control must close again (Map information).
 */
function onBodyClick(id: EdgeGroupId, event: Event): void {
  if (openGroup !== id) return;
  const target = event.target;
  const button = target instanceof Element ? target.closest('button') : null;
  if (!button) return;
  window.setTimeout(() => {
    if (openGroup !== id) return;
    if (button.getAttribute('aria-expanded') === 'true') return;
    // The row is about to be hidden with the pressed control inside it:
    // hand focus to the cell that stands for the group, so a keyboard,
    // switch or screen reader user is not left on a control that is gone.
    setOpen(null, true);
  }, 0);
}

function onColumnKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || openGroup === null) return;
  const parts = groups.get(openGroup);
  // The panel's own Escape must not also fire for this press.
  event.preventDefault();
  event.stopPropagation();
  setOpen(null, false);
  parts?.fold.focus({ preventScroll: true });
}

// ---------------------------------------------------------------------------
// Mounting
// ---------------------------------------------------------------------------

function setMounted(next: boolean): void {
  if (!app || !column || next === mounted) return;
  mounted = next;
  if (next) {
    column.hidden = false;
    if (badge && badgeHome && tracks[0]) tracks[0].top.prepend(badge);
    notifyPhoneSeats();
    planKey = '';
    refresh();
    return;
  }
  setOpen(null, false);
  // Seats leave first, while the column is still in the document.
  notifyPhoneSeats();
  if (badge && badgeHome) badgeHome.prepend(badge);
  column.hidden = true;
  planKey = '';
  currentPlan = null;
  app.style.removeProperty(EDGE_COLUMN_PROPERTIES.size);
  app.style.removeProperty(EDGE_COLUMN_PROPERTIES.gap);
  app.style.removeProperty(EDGE_COLUMN_PROPERTIES.width);
}

/**
 * Build the column and start following the phone shell. Idempotent. Call
 * before the mobile shell initializes so its first activation finds the
 * column; a shell that is already active is picked up at once.
 */
export function initEdgeColumn(): void {
  if (column) return;
  const host = document.getElementById('app');
  if (!host) return;
  app = host;
  buildColumn(host);
  if (!column) return;

  setPhoneSeatProvider({
    hostFor: (group) => (mounted ? (groups.get(group)?.body ?? null) : null),
    place,
    release
  });

  const overlay = document.querySelector<HTMLElement>('.map-overlay-controls');
  const mapContainer = document.getElementById('map-container');
  const share = document.getElementById('share-btn');
  const reset = document.getElementById('reset-btn');
  const desktopSeat = document.getElementById('basemap-switcher-overlay-host');
  if (overlay && share) {
    watchPhoneSeat({
      node: share,
      home: overlay,
      placeHome: () => {
        if (share.parentElement === overlay) return;
        const next = reset?.parentElement === overlay ? reset : desktopSeat;
        overlay.insertBefore(share, next?.parentElement === overlay ? next : null);
      },
      phone: { group: 'utility', order: 10, word: 'Share' }
    });
  }
  if (overlay && reset) {
    watchPhoneSeat({
      node: reset,
      home: overlay,
      placeHome: () => {
        if (reset.parentElement === overlay) return;
        overlay.insertBefore(reset, desktopSeat?.parentElement === overlay ? desktopSeat : null);
      },
      phone: { group: 'utility', order: 20, word: 'Reset' }
    });
  }
  const doors = document.getElementById('mobile-footer-nav');
  if (doors) {
    watchPhoneSeat({
      node: doors,
      home: host,
      placeHome: () => {
        if (doors.parentElement !== host) host.insertBefore(doors, column);
      },
      phone: { group: 'panels', order: 10 }
    });
  }
  const rail = document.getElementById('hazard-rail');
  const railAnchor = document.getElementById('map-info-home');
  if (rail && mapContainer) {
    watchPhoneSeat({
      node: rail,
      home: mapContainer,
      placeHome: () => {
        if (rail.parentElement === mapContainer) return;
        mapContainer.insertBefore(
          rail,
          railAnchor?.parentElement === mapContainer ? railAnchor : null
        );
      },
      phone: { group: 'hazards', order: 10 }
    });
  }
  badge = overlay?.querySelector<HTMLElement>('.test-preview-badge') ?? null;
  badgeHome = badge ? overlay : null;

  // Controls come and go (a lane seats one, a mode hides one) and pressed
  // states change; either can alter what fits or what a folded cell shows.
  const mutation = new MutationObserver(() => refresh());
  mutation.observe(column, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['hidden', 'aria-pressed', 'aria-expanded']
  });
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => refresh()).observe(column);
  }
  window.addEventListener('resize', () => refresh());

  // The attribute's presence is the phone shell; its value can change which
  // controls a group shows (Map information waits while a panel is open).
  const shell = new MutationObserver(() => {
    setMounted(host.hasAttribute(SHELL_ATTRIBUTE));
    refresh();
  });
  shell.observe(host, { attributes: true, attributeFilter: [SHELL_ATTRIBUTE] });
  setMounted(host.hasAttribute(SHELL_ATTRIBUTE));
}

/**
 * Seat a control that exists for the phone column (Locate, the 3D entry).
 * It rides its group while the phone shell is active and waits, hidden,
 * outside it. Returns a dispose that removes it from the column's care.
 */
export function seatEdgeControl(node: HTMLElement, seat: PhoneSeat): () => void {
  const holding = bench;
  if (!holding) return () => {};
  holding.appendChild(node);
  return watchPhoneSeat({
    node,
    home: holding,
    placeHome: () => {
      if (node.parentElement !== holding) holding.appendChild(node);
    },
    phone: seat
  });
}

/**
 * Reserve room under the column for a surface that rises from the bottom
 * edge (a sheet at its resting height). The column re-plans for what is
 * left. Pass 0 to release.
 */
export function setEdgeReserveBottom(px: number): void {
  if (!app) return;
  if (px > 0) app.style.setProperty(RESERVE_PROPERTY, `${Math.round(px)}px`);
  else app.style.removeProperty(RESERVE_PROPERTY);
  refresh();
}

/** Re-plan now. For a change the column cannot observe (a stylesheet-driven hide). */
export function refreshEdgeColumn(): void {
  refresh();
}

/** The arrangement in force, or null outside the phone shell. */
export function getEdgePlan(): EdgePlan | null {
  return currentPlan;
}

/**
 * The band, in px from the right edge of the window, that the column
 * occupies: its tracks, its inset and any safe area. 0 outside the phone
 * shell. A camera fit adds it to its right padding, so the place it frames
 * is not left under the column. Measured, so it follows one track or two.
 */
export function edgeColumnInset(): number {
  if (!currentPlan || !column) return 0;
  const rect = column.getBoundingClientRect();
  if (rect.width <= 0) return 0;
  return Math.max(0, Math.round(window.innerWidth - rect.left));
}

/** Subscribe to arrangement changes (cell size, tracks, folded groups). */
export function onEdgePlanChange(fn: (plan: EdgePlan) => void): () => void {
  planListeners.add(fn);
  return () => {
    planListeners.delete(fn);
  };
}
