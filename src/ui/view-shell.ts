/**
 * The view shell (U1, D-ARCH-002: "two doors"; amended by S2,
 * D-0.7.0-041: no unsolicited briefing).
 *
 * Owns the mode chrome around the Brief/console split: the header mode
 * switch, the Brief head (the lede, the place picker, and the console
 * door), and the `#app` mode classes the stylesheet keys off. The U1
 * answer-first boot (a Brief boot auto-opened the active region's
 * briefing) is DELIBERATELY RETIRED (D-0.7.0-041 part 1): the boot
 * never opens the impact briefing without an explicit selection; a
 * briefing opens ONLY from an explicit place selection or a `select=`
 * deep link. What survives of D-0.7.0-006 is the never-fake half: this
 * module still never fabricates a briefing for an empty state.
 *
 * The mode itself lives in `src/state/view-mode.ts` (URL-derived at
 * boot, `view=` round-tripped by the sidebar's URL sync). BRIEF leads
 * with the briefing search and keeps the catalog beneath the Brief head
 * as the drill-down (layers-SECOND, not layers-never); CONSOLE is the
 * full instrument. Deeper console reshaping (the region grid demoting
 * to a jump-to list, the searchable catalog) is U3 (D-0.7.0-009), not
 * here.
 *
 * The mode swap crossfades via the View Transitions API where present,
 * guarded by prefers-reduced-motion (headroom B5); without support it
 * is an instant swap, which is also the reduced-motion behavior.
 *
 * Stewardship: the place picker routes through `openStateBriefing`,
 * which builds the same boundary context a map click would; no Tribal,
 * Treaty, or sovereign-jurisdiction data is surfaced by this module.
 */

import type maplibregl from 'maplibre-gl';

import { getPlaceSelection } from '../state/place-selection';
import { getViewMode, onViewModeChange, setViewMode } from '../state/view-mode';
import type { ViewMode } from '../state/view-mode';
import { closeImpactPanel, openImpactPanel } from './impact-panel';
import { buildTribalNationsBriefAction } from './tribal-nations-action';
import { prefersReducedMotion } from '../util/motion';

/**
 * Apply the mode to the app shell: the `view-brief`/`view-console`
 * classes (the stylesheet's hook) and the Brief head's visibility.
 */
function applyModeClass(mode: ViewMode): void {
  const app = document.getElementById('app');
  if (app) {
    app.classList.toggle('view-brief', mode === 'brief');
    app.classList.toggle('view-console', mode === 'console');
  }
  const head = document.getElementById('brief-head');
  if (head) head.hidden = mode !== 'brief';
}

/** Reflect the mode into the header switch's pressed states. */
function updateModeSwitch(mode: ViewMode): void {
  document
    .querySelectorAll<HTMLButtonElement>('.view-switch [data-view]')
    .forEach((btn) => {
      btn.setAttribute('aria-pressed', btn.dataset['view'] === mode ? 'true' : 'false');
    });
}

/**
 * Reopen the briefing for the PERSISTING explicit place selection when
 * the Brief door opens, if one is current. This is the D-0.7.0-041
 * replacement for the retired U1 answer-first open: the selection was
 * an explicit user act and persists across the door switch (a selected
 * briefing place is cleared only by its own explicit control), so
 * reopening it is honoring that act, not soliciting a briefing. With no
 * selection, the panel simply stays closed; the region-anchor fallback
 * (the unsolicited half of the old behavior) is retired, and no
 * briefing is fabricated for an empty state (the surviving half of
 * D-0.7.0-006).
 */
function reopenSelectedPlace(): void {
  const place = getPlaceSelection();
  if (place) openImpactPanel(place.context);
}

/**
 * Switch modes with a crossfade. The mutation flips the store (whose
 * subscribers apply the classes, re-sync the URL, and mount the island
 * if needed) and swaps the briefing panel to match the door: console is
 * the map, so the panel closes; Brief reopens the persisting explicit
 * selection if one is current and otherwise stays closed (D-0.7.0-041:
 * never an unsolicited briefing).
 */
function switchMode(mode: ViewMode): void {
  if (mode === getViewMode()) return;
  const mutate = (): void => {
    setViewMode(mode);
    if (mode === 'console') {
      closeImpactPanel();
    } else {
      reopenSelectedPlace();
    }
  };
  const doc = document as Document & {
    startViewTransition?: (update: () => void) => unknown;
  };
  if (typeof doc.startViewTransition === 'function' && !prefersReducedMotion()) {
    doc.startViewTransition(() => {
      mutate();
    });
  } else {
    mutate();
  }
}

/** Build the two-button mode switch into the sidebar header. */
function buildModeSwitch(): void {
  const header = document.querySelector('.sidebar-header');
  const collapseBtn = document.getElementById('sidebar-collapse');
  if (!header || !collapseBtn) return;

  const group = document.createElement('div');
  group.className = 'view-switch';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'View');
  group.innerHTML = `
    <button type="button" data-view="brief" aria-pressed="false" title="The briefing-led view">Brief</button>
    <button type="button" data-view="console" aria-pressed="false" title="The full map and layers view">Console</button>
  `;
  group.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset['view'];
      if (target === 'brief' || target === 'console') switchMode(target);
    });
  });
  header.insertBefore(group, collapseBtn);
  updateModeSwitch(getViewMode());
}

/**
 * Fill the Brief head: the lede, the ONE search (U3, replacing the U1 stopgap
 * state `<select>`), and the console door. The search is the shared component
 * (places + Tribal land areas + layers), the same one the console catalog and
 * the mobile sheet mount, so a person types one box wherever they are.
 *
 * E1 deliverable 1 (D-0.7.0-041 part 2, review E1.2): the lede is worded
 * around selecting a place on the map, not around an already-open report,
 * and the console door keeps its honest name (the interim escape to the
 * full instrument; it is not renamed a studio). The Brief-mode section
 * hiding itself is CSS-first (src/styles/app.css, the view-brief rules).
 */
function buildBriefHead(map: maplibregl.Map): void {
  const head = document.getElementById('brief-head');
  if (!head) return;

  head.innerHTML = `
    <h2 class="panel-title">Drought briefing</h2>
    <p class="brief-head-lede">What does the current drought mean for a place? Select a Tribal land area, a reservation, or a state on the map, or search for one below; the briefing opens with conditions, outlooks, and resources for the place you choose.</p>
    <div id="brief-search"></div>
    <button type="button" id="brief-console-door" class="brief-console-door">Open the map &amp; layers console</button>
  `;

  const door = head.querySelector<HTMLButtonElement>('#brief-console-door');
  door?.addEventListener('click', () => {
    switchMode('console');
  });

  // The compact Tribal Nations action (umbrella Unit F) moved here from
  // the impact panel's chrome at the S2/E1 integration: D-0.7.0-041
  // retired the unsolicited briefing, so the panel is no longer the
  // default Brief surface, and the ratified visibility guarantee (the
  // group command and its health line visible on the default Brief,
  // Codex final-pass finding 2) now rides the Brief head. A brief embed
  // keeps the panel-hosted instance instead (the sidebar is collapsed
  // there); one instance ever, the id is unique.
  const isEmbedBoot = document.getElementById('app')?.classList.contains('embed') ?? false;
  if (!isEmbedBoot) {
    head.appendChild(buildTribalNationsBriefAction());
  }

  mountBriefSearch(map);
}

/**
 * Mount the shared search into the Brief head. Gated by the C1 rule: a brief
 * embed never downloads the island / search chunk at BOOT (the Brief head
 * chrome is not the embed's surface). The embed-exit path (the sidebar
 * expand control) calls back through `ensureBriefHeadSearch` once the embed
 * class is gone, so an exited embed gets the head search without a reload
 * (the U3 stage-5 minor 7 fix). Every other boot has the island mounted
 * already, so the extra chunk is free. Mounting is idempotent: the search
 * renders into a dedicated container and a re-render replaces it.
 */
function mountBriefSearch(map: maplibregl.Map): void {
  const isEmbed = document.getElementById('app')?.classList.contains('embed') ?? false;
  if (isEmbed && getViewMode() === 'brief') return;
  const container = document.getElementById('brief-search');
  if (!container) return;
  void import('./search-controller').then(({ mountSearchInto }) => {
    mountSearchInto(map, container);
  });
}

/**
 * Public seam for the embed-exit path: mount the Brief-head search if the
 * boot-time C1 gate skipped it (a brief embed) and the app has since left
 * embed mode. Safe to call repeatedly.
 */
export function ensureBriefHeadSearch(map: maplibregl.Map): void {
  mountBriefSearch(map);
}

/**
 * Public seam for the embed-exit path (Codex S2/E1 integration finding
 * 2): an embed boot skips the head-hosted Tribal Nations action, and
 * the panel hosts it only when BUILT under the embed class, so an
 * exited embed could end up with no instance at all. Idempotent: if
 * the unique id already exists anywhere (the panel-hosted instance
 * from an embed-boot panel build), this is a no-op; otherwise the
 * Brief head gains the action, keeping the umbrella's default-Brief
 * visibility guarantee after the exit.
 */
export function ensureBriefHeadTribalAction(): void {
  if (document.getElementById('tribal-nations-brief-action')) return;
  const head = document.getElementById('brief-head');
  if (!head) return;
  head.appendChild(buildTribalNationsBriefAction());
}

/**
 * Initialize the view shell. Called once from boot, after the sidebar
 * (which seeds the mode from the URL). The shell builds chrome only:
 * the U1 answer-first boot open that used to fire here is retired
 * (D-0.7.0-041 part 1; no unsolicited briefing), so a `select=` deep
 * link (applied by the caller afterward) and explicit selections are
 * the only briefing openers.
 */
export function initViewShell(map: maplibregl.Map): void {
  buildModeSwitch();
  buildBriefHead(map);
  applyModeClass(getViewMode());

  onViewModeChange((mode) => {
    applyModeClass(mode);
    updateModeSwitch(mode);
  });
}
