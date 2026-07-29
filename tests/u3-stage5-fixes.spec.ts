import { test, expect } from '@playwright/test';
import type maplibregl from 'maplibre-gl';

import { gotoApp } from './helpers';
import {
  showLocatedBoundary,
  clearLocatedBoundary,
  initLocatedBoundary
} from '../src/state/located-boundary';
import { setPlaceSelection } from '../src/state/place-selection';
import type { PlaceSelection } from '../src/state/place-selection';
import type { BoundarySelectionContext } from '../src/impact/types';

/**
 * U3 stage-5 fix-forward coverage (the Codex adversarial round, reconciled
 * under D-0.7.0-026 and the stage-5 LOG entry):
 *
 *   - The STRUCTURAL provenance gate (major 2): a Tribal Nation name renders
 *     ONLY from a roster row whose provenance is trusted; anything else
 *     renders the BIA land-area label, even if the data file carries a
 *     pretender displayName.
 *   - Honest failure states (major 5): a failed roster load reads
 *     "unavailable", never "No matches"; a failed live BIA locate surfaces a
 *     toast, never a silent no-op.
 *   - The located-boundary highlight clears on EVERY selection change
 *     (major 4), asserted in Node against a fake map.
 *   - The embed-exit remounts the Brief-head search (minor 7).
 *   - The keyboard highlight is item-keyed, so async Tribal results cannot
 *     shift it onto an unrelated row (minor 8).
 *
 * Deterministic backbone only: the failure cases run against Playwright
 * route interception (no live upstream is exercised), and the Node cases run
 * against source modules with a fake map, matching the u3i pattern. The
 * desktop emphasis-during-briefing and highlight-after-close BEHAVIOR on the
 * real map is browser-pass evidence (stage 5), not CI assertions, for the
 * same reason as u3i: the production build exposes no map handle.
 */

const CONSOLE_SEARCH = '#catalog-search [data-ddm-search]';

/** A minimal selection for driving the store in Node tests. */
function fakeSelection(label: string): PlaceSelection {
  return { label, context: { title: label } as unknown as BoundarySelectionContext };
}

// ---------------------------------------------------------------------------
// Major 4 (Node): the located-boundary highlight clears on EVERY change
// ---------------------------------------------------------------------------

test.describe('U3 stage-5: located-boundary clear seam (major 4)', () => {
  interface FakeMapState {
    layers: Set<string>;
    sources: Set<string>;
  }

  function fakeMap(): { map: maplibregl.Map; state: FakeMapState } {
    const state: FakeMapState = { layers: new Set(), sources: new Set() };
    const map = {
      getSource: (id: string) => (state.sources.has(id) ? { setData: () => undefined } : undefined),
      addSource: (id: string) => {
        state.sources.add(id);
      },
      removeSource: (id: string) => {
        state.sources.delete(id);
      },
      getLayer: (id: string) => (state.layers.has(id) ? {} : undefined),
      addLayer: (spec: { id: string }) => {
        state.layers.add(spec.id);
      },
      removeLayer: (id: string) => {
        state.layers.delete(id);
      }
    } as unknown as maplibregl.Map;
    return { map, state };
  }

  const GEOM = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } as const;

  let dispose: (() => void) | null = null;
  test.afterEach(() => {
    dispose?.();
    dispose = null;
    setPlaceSelection(null);
  });

  test('a selection CHANGE clears the highlight, not only a close to null', () => {
    const { map, state } = fakeMap();
    dispose = initLocatedBoundary(map);

    showLocatedBoundary(map, GEOM);
    expect(state.layers.size).toBe(2);

    // A NEW subject (a different briefing or popup), not a close: the stale
    // highlight must go, because it depicts the previous subject.
    setPlaceSelection(fakeSelection('Another place'));
    expect(state.layers.size).toBe(0);
    expect(state.sources.size).toBe(0);
  });

  test('the locate ordering contract: set-then-show keeps the new subject; close clears it', () => {
    const { map, state } = fakeMap();
    dispose = initLocatedBoundary(map);

    // The search-locate path opens the briefing FIRST (which sets the
    // selection and clears any stale highlight) and shows its own highlight
    // AFTER, so the new subject survives the seam.
    setPlaceSelection(fakeSelection('Located land area'));
    showLocatedBoundary(map, GEOM);
    expect(state.layers.size).toBe(2);

    // Closing the briefing nulls the selection; the highlight goes with it.
    setPlaceSelection(null);
    expect(state.layers.size).toBe(0);
  });

  test('clearLocatedBoundary is safe when nothing is shown', () => {
    const { map, state } = fakeMap();
    expect(() => clearLocatedBoundary(map)).not.toThrow();
    expect(state.layers.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Major 2 (browser): the structural provenance gate
// ---------------------------------------------------------------------------

test.describe('U3 stage-5: the roster provenance gate (major 2, D-0.7.0-026)', () => {
  test('a Tribal Nation name renders only from trusted provenance; everything else keeps the BIA label', async ({
    page
  }) => {
    // A crafted roster with a pretender: the lar-label row and the
    // no-provenance row both carry a displayName that MUST NOT render.
    await page.route('**/data/tribal-roster.json', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          meta: {},
          areas: [
            {
              larName: 'Gatecheck Trusted',
              displayName: 'Formal Federal Register Nation Name',
              provenance: 'safe-match'
            },
            {
              larName: 'Gatecheck Untrusted',
              displayName: 'Guessed Nation Name (must not render)',
              provenance: 'lar-label'
            },
            {
              larName: 'Gatecheck Legacy',
              displayName: 'Legacy Guessed Name (must not render)'
            }
          ]
        })
      })
    );

    await gotoApp(page, '?view=console');
    await page.locator(CONSOLE_SEARCH).fill('gatecheck');

    const tribalGroup = page.locator('#catalog-search [data-search-group="tribal"]');
    await expect(tribalGroup).toBeVisible();

    // The trusted row renders its formal name; the untrusted rows render the
    // BIA land-area label verbatim.
    await expect(tribalGroup).toContainText('Formal Federal Register Nation Name');
    await expect(tribalGroup).toContainText('Gatecheck Untrusted');
    await expect(tribalGroup).toContainText('Gatecheck Legacy');
    await expect(tribalGroup).not.toContainText('Guessed Nation Name');
    await expect(tribalGroup).not.toContainText('Legacy Guessed Name');
  });
});

// ---------------------------------------------------------------------------
// Major 5 (browser): honest failure states
// ---------------------------------------------------------------------------

test.describe('U3 stage-5: honest search failure states (major 5)', () => {
  test('a failed roster load reads unavailable, never "No matches"', async ({ page }) => {
    await page.route('**/data/tribal-roster.json', (route) =>
      route.fulfill({ status: 500, contentType: 'text/plain', body: 'boom' })
    );

    await gotoApp(page, '?view=console');
    // A query that matches nothing synchronous, so the Tribal group's state
    // is the only thing on screen: the distinction under test.
    await page.locator(CONSOLE_SEARCH).fill('yakama');

    const unavailable = page.locator('#catalog-search .ddm-search-unavailable');
    await expect(unavailable).toBeVisible();
    await expect(unavailable).toContainText('Tribal land area search is unavailable');
    // The dishonest framing this fix removes: a service failure presented as
    // a clean zero-result answer.
    await expect(page.locator('#catalog-search .ddm-search-results')).not.toContainText(
      'No matches for'
    );
  });

  test('a failed live BIA locate surfaces a toast, never a silent no-op', async ({ page }) => {
    // The bundled roster loads normally; only the live AIAN-LAR locate dies.
    await page.route('**/BIA_AIAN_National_LAR/**', (route) => route.abort());

    await gotoApp(page, '?view=console');
    await page.locator(CONSOLE_SEARCH).fill('yakama');

    const row = page
      .locator('#catalog-search [data-search-kind="tribal"][data-search-id="Yakama"]')
      .first();
    await expect(row).toBeVisible();
    await row.click();

    const toast = page.locator('#copy-toast');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('Could not reach the BIA land area service');
  });
});

// ---------------------------------------------------------------------------
// Minor 7 (browser): embed-exit remounts the Brief-head search
// ---------------------------------------------------------------------------

test.describe('U3 stage-5: embed-exit Brief search (minor 7)', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('expanding out of a brief embed mounts the Brief-head search without a reload', async ({
    page
  }) => {
    await gotoApp(page, '?embed=true');

    // The C1 boot gate held: no search chunk, empty head host in embed.
    await expect(page.locator('#brief-search [data-ddm-search]')).toHaveCount(0);

    await page.locator('#sidebar-expand').click();

    // The exit path remounts the head search (lazy chunk); the input appears
    // without a reload.
    await expect(page.locator('#brief-search [data-ddm-search]')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Minor 8 (browser): the item-keyed keyboard highlight
// ---------------------------------------------------------------------------

test.describe('U3 stage-5: item-keyed keyboard highlight (minor 8)', () => {
  test('async Tribal results do not move the highlight off the chosen row', async ({ page }) => {
    // Hold the roster response until the highlight is placed, then release
    // it; the resolved Tribal group inserts ABOVE the Layers group.
    let releaseRoster: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseRoster = resolve;
    });
    await page.route('**/data/tribal-roster.json', async (route) => {
      await gate;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          meta: {},
          areas: [
            {
              larName: 'Tribal Highlight Fixture',
              displayName: 'Tribal Highlight Fixture',
              provenance: 'lar-label'
            }
          ]
        })
      });
    });

    await gotoApp(page, '?view=console');
    const input = page.locator(CONSOLE_SEARCH);
    // "tribal" matches the live Tribal Lands layer row (`aiannh`)
    // synchronously and the fixture land area asynchronously. (The deployer
    // slot left the search index with Unit I, D-0.7.0-038 part 3.)
    await input.fill('tribal');

    const layerRow = page.locator(
      '#catalog-search [data-search-kind="layer"][data-search-id="aiannh"]'
    );
    await expect(layerRow).toBeVisible();

    // Highlight the layer row while the Tribal group is still pending.
    await input.press('ArrowDown');
    await expect(layerRow).toHaveAttribute('aria-selected', 'true');

    // The roster lands; its group renders above Layers, shifting positions.
    releaseRoster?.();
    await expect(
      page.locator('#catalog-search [data-search-kind="tribal"][data-search-id="Tribal Highlight Fixture"]')
    ).toBeVisible();

    // The highlight stayed on the ITEM, not the position.
    await expect(layerRow).toHaveAttribute('aria-selected', 'true');
    const active = page.locator('#catalog-search [role="option"][aria-selected="true"]');
    await expect(active).toHaveCount(1);
    await expect(active).toHaveAttribute('data-search-kind', 'layer');
  });
});

// ---------------------------------------------------------------------------
// Adversarial round 2 (2026-07-12): the locate master abort covers EVERY
// supersede path (invariant 5). Round 1 fixed the locate-supersedes-locate
// case; the re-review found a non-Tribal supersede and a panel close left
// the in-flight LARNAME request running to its timeout (late results were
// dropped, but the request itself survived). Both paths must CANCEL it.
// ---------------------------------------------------------------------------

test.describe('U3 stage-5 round 2: LARNAME abort on supersede and close', () => {
  test('a non-Tribal supersede aborts the in-flight LARNAME request', async ({ page }) => {
    let larAborted = false;
    // Hold the LAR query open; a client-side abort is the only way it ends.
    await page.route('**/BIA_AIAN_National_LAR/**', () => {
      /* pend forever */
    });
    page.on('requestfailed', (req) => {
      if (req.url().includes('BIA_AIAN_National_LAR')) larAborted = true;
    });

    await gotoApp(page, '?view=console');
    await page.locator(CONSOLE_SEARCH).fill('yakama');
    const larRequest = page.waitForRequest((req) => req.url().includes('BIA_AIAN_National_LAR'));
    await page
      .locator('#catalog-search [data-search-kind="tribal"][data-search-id="Yakama"]')
      .first()
      .click();
    await larRequest;

    // Supersede with a place briefing; the locate request must die, not
    // merely lose the intent race.
    await page.locator(CONSOLE_SEARCH).fill('washington');
    await page
      .locator('#catalog-search [data-search-group="place"] [data-search-kind="place"]')
      .first()
      .click();

    await expect.poll(() => larAborted, { timeout: 10_000 }).toBe(true);
  });

  test('closing the briefing panel aborts the in-flight LARNAME request', async ({ page }) => {
    let larAborted = false;
    await page.route('**/BIA_AIAN_National_LAR/**', () => {
      /* pend forever */
    });
    page.on('requestfailed', (req) => {
      if (req.url().includes('BIA_AIAN_National_LAR')) larAborted = true;
    });

    // A briefing is already open via the select= deep link (an explicitly
    // direct open; the SEARCH path is summary-first under D-0.7.0-070 and
    // no longer opens the panel), so the panel's close control exists
    // while the locate is in flight.
    await gotoApp(page, '?view=console&select=state:WA');
    const closeBtn = page.locator('.impact-panel-close');
    await expect(closeBtn).toBeVisible({ timeout: 15_000 });

    await page.locator(CONSOLE_SEARCH).fill('yakama');
    const larRequest = page.waitForRequest((req) => req.url().includes('BIA_AIAN_National_LAR'));
    await page
      .locator('#catalog-search [data-search-kind="tribal"][data-search-id="Yakama"]')
      .first()
      .click();
    await larRequest;

    // Close the panel: the selection clears to null and the subscription
    // cancels the request.
    await closeBtn.click();

    await expect.poll(() => larAborted, { timeout: 10_000 }).toBe(true);
  });
});
