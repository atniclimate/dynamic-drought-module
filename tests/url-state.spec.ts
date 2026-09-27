import { test, expect } from '@playwright/test';
import type { Page, Response } from '@playwright/test';
import { placeRefFromBoundary } from '../src/config/entities';
import {
  gotoApp,
  layerCheckbox,
  layerPill,
  regionSelect,
  urlLayers,
  search,
  waitForLayerSettled,
  DEFAULT_ON,
  PILL
} from './helpers';
import {
  AIANNH_ROUTE,
  BIA_ROUTE,
  routeBoundary,
  syntheticAiannhBody,
  syntheticBiaBody
} from './tribal-fixtures';
import { HAZARD_CLUSTER_KEYS, HAZARD_CLUSTERS } from '../src/config/clusters';

/**
 * DDM-P2-T09: the recognized URL parameter vocabulary, read from its own
 * documentation (src/state/url.ts:29-63 for the twelve documented keys,
 * :349-374 for the one-shot `select`). A canonical place reference is
 * identity only and is never URL state (src/config/entities.ts), so no key
 * named here or below should ever be added by a selection.
 */
const RECOGNIZED_URL_KEYS: ReadonlySet<string> = new Set([
  'region', 'layers', 'embed', 'view', 'week', 'dmode', 'sst', 'outlook',
  'horizon', 'basemap', 'framing', 'cluster', 'ocean', 'studio', 'heatday',
  'spi', 'select'
]);

/** Names a `PlaceRef` or a raw coordinate could plausibly take; none is ever a real URL key. */
const FORBIDDEN_URL_KEYS = ['place', 'lng', 'lat', 'lon', 'x', 'y', 'coords'] as const;

function assertNoNewUrlParam(rawSearch: string): void {
  const params = new URLSearchParams(rawSearch);
  for (const key of params.keys()) {
    expect(RECOGNIZED_URL_KEYS.has(key), `unrecognized URL key: ${key}`).toBe(true);
  }
  for (const forbidden of FORBIDDEN_URL_KEYS) {
    expect(params.has(forbidden), `forbidden URL key present: ${forbidden}`).toBe(false);
  }
}

/**
 * Capture the WA feature's own properties from the bundled
 * `us-states.geojson` response a door's own fetch retrieves (never a
 * separate fetch of this test's own making), so the computed reference
 * reflects exactly what that door read.
 */
async function captureWaProperties(
  page: Page,
  action: () => Promise<void>
): Promise<Record<string, unknown> | null> {
  let captured: Record<string, unknown> | null = null;
  const listener = async (response: Response): Promise<void> => {
    if (!response.url().includes('/data/us-states.geojson')) return;
    try {
      const body = (await response.json()) as {
        features?: Array<{ properties?: Record<string, unknown> }>;
      };
      const match = body.features?.find((f) => f.properties?.['STUSPS'] === 'WA');
      if (match?.properties) captured = match.properties;
    } catch {
      // A held or aborted response has no body; not this capture's concern.
    }
  };
  page.on('response', listener);
  try {
    await action();
  } finally {
    page.off('response', listener);
  }
  return captured;
}

/**
 * URL-as-state (a core project invariant): region selection, layer
 * toggles, and the embed flag round-trip through `window.location.search`.
 * A shared or embedded link must restore the view it encodes, and every
 * toggle must be reflected back into the URL.
 *
 * The layer driven for the round trip is `places` (City & Town Labels), a
 * bundled artifact that loads same-origin and fast, so its activation
 * resolves without depending on any live agency endpoint.
 */
test.describe('URL as state', () => {
  test('a bare boot never publishes an empty or partial layers value while the live defaults load (boot layer intent)', async ({ page }) => {
    // Hold both live Tribal-geography responses open so the boot layer
    // set cannot settle, then prove every boot-window URL write carries the
    // FULL default set (the parsed boot intent), never `layers=` and never
    // a completion-order partial set: a reload or share during boot must
    // reproduce the default view (URL policy rules 5 and 7; bootLayerIntent
    // in src/ui/sidebar.ts). Synthetic fixtures only; no real polygon
    // touches the repo.
    const releases: Array<() => void> = [];
    const hold = async (pattern: string, body: unknown): Promise<void> => {
      const gate = new Promise<void>((resolve) => releases.push(resolve));
      await routeBoundary(page, pattern, async (route) => {
        await gate;
        await route.fulfill({
          contentType: 'application/geo+json',
          body: JSON.stringify(body)
        });
      });
    };
    await hold(AIANNH_ROUTE, syntheticAiannhBody());
    await hold(BIA_ROUTE, syntheticBiaBody());

    // This case holds the boot open by design (two default layers cannot
    // settle until the releases below fire), so it opts out of the boot-idle
    // wait in gotoApp and owns its own waits.
    await gotoApp(page, '', { bootIdle: false });

    const isFullDefaultSet = async (): Promise<boolean> => {
      const layers = await urlLayers(page);
      return (
        layers.size === DEFAULT_ON.length &&
        (DEFAULT_ON as readonly string[]).every((key) => layers.has(key))
      );
    };

    // The first canonical write lands promptly and already carries the full
    // default set (the boot intent), while the live responses are held.
    await expect
      .poll(async () => new URLSearchParams(await search(page)).get('layers') !== null, {
        timeout: 15_000
      })
      .toBe(true);
    // Sampled over a real window: it never degrades to empty or partial.
    for (let i = 0; i < 5; i++) {
      expect(await isFullDefaultSet(), 'boot-window layers must stay the full default set').toBe(
        true
      );
      await page.waitForTimeout(200);
    }

    // Release the held responses; the post-settle write keeps the full set
    // (everything activated), nothing less and nothing more.
    for (const release of releases) release();
    await expect.poll(isFullDefaultSet, { timeout: 25_000 }).toBe(true);
  });

  test('a deep link restores the region and the exact layer set', async ({ page }) => {
    await gotoApp(page, '?region=central_oregon&layers=usdm,tribal');

    // Region restored.
    await expect(regionSelect(page)).toHaveValue('region:central_oregon');

    // Exactly the named layers are on; an explicit layer list overrides the
    // default-on set, so an unnamed layer (telemetry) is off here.
    await expect(layerCheckbox(page, 'usdm')).toBeChecked();
    await expect(layerCheckbox(page, 'tribal')).toBeChecked();
    await expect(layerCheckbox(page, 'telemetry')).not.toBeChecked();
  });

  test('an unknown ?layers= key boots to a working shell with nothing active for it', async ({
    page
  }) => {
    // DDM-P1-T05: parseUrlParams deliberately passes an unknown layer key
    // through unfiltered (src/state/url.ts:253-258) and leaves rejection to
    // the registry. The registry's rejection is `getLayerDef` returning
    // `null` (src/config/layers.ts:389-391), which every caller (the boot
    // seed loop at src/ui/sidebar.ts:1706-1708, and applyLayerSet at
    // src/state/layer-controller.ts:502-509) treats as a silent no-op: the
    // key never enters the checkbox bridge, so it is checked nowhere.
    const pageErrors: Error[] = [];
    page.on('pageerror', (error) => pageErrors.push(error));

    await gotoApp(page, '?layers=bogus-key-does-not-exist');

    // No phantom row: the unknown key never gets a checkbox or a status
    // pill in the DOM.
    await expect(
      page.locator('input[data-layer-key="bogus-key-does-not-exist"]')
    ).toHaveCount(0);
    await expect(
      page.locator('[data-layer-status="bogus-key-does-not-exist"]')
    ).toHaveCount(0);

    // An explicit `?layers=` list overrides the default-on set (the same
    // rule the deep-link test below relies on), and the named key matches
    // no real layer, so every normally-default-on layer stays off too.
    for (const key of DEFAULT_ON) {
      await expect(layerCheckbox(page, key)).not.toBeChecked();
    }

    // The canonical post-boot rewrite drops the unknown key rather than
    // carrying it forward: unknown keys never enter the checkbox bridge
    // that `syncUrl` serializes from (src/ui/sidebar.ts:614-637).
    await expect
      .poll(async () => (await urlLayers(page)).has('bogus-key-does-not-exist'))
      .toBe(false);
    expect(await urlLayers(page)).toEqual(new Set());

    expect(pageErrors).toEqual([]);
  });

  test('a mixed layers list activates the real key and ignores the bogus one', async ({
    page
  }) => {
    const pageErrors: Error[] = [];
    page.on('pageerror', (error) => pageErrors.push(error));

    // Places (City & Town Labels) is the same cheap, same-origin, bundled
    // reference layer the round-trip test below drives; it is a
    // `role: 'reference'` key, so it never collides with surface
    // exclusivity handling in `resolveExclusiveSurface`.
    await gotoApp(page, '?layers=places,bogus-key-does-not-exist');

    await expect(layerCheckbox(page, 'places')).toBeChecked();
    await waitForLayerSettled(page, 'places');
    await expect(layerPill(page, 'places')).toHaveText('live');

    await expect(
      page.locator('input[data-layer-key="bogus-key-does-not-exist"]')
    ).toHaveCount(0);
    for (const key of DEFAULT_ON) {
      await expect(layerCheckbox(page, key)).not.toBeChecked();
    }

    const layers = await urlLayers(page);
    expect(layers.has('places')).toBe(true);
    expect(layers.has('bogus-key-does-not-exist')).toBe(false);

    expect(pageErrors).toEqual([]);
  });

  test('toggling a layer round-trips through the URL', async ({ page }) => {
    // Console boot (E1 deliverable 1, 2026-07-16): this test drives a
    // catalog checkbox, and Brief mode now hides the catalog behind the
    // console door. Boot mode only; every URL assertion is unchanged.
    await gotoApp(page, '?view=console');

    // Places (City & Town Labels) is off by default and loads a bundled,
    // same-origin artifact, so the round trip does not couple to any live
    // agency endpoint. (The old driver, the `treaty` deployer slot, left
    // the visible catalog with Unit I, D-0.7.0-038 part 3; the placeholder
    // pill honesty it also probed is covered by the legacy ?layers=tribal
    // landing spec in tribal-live-layers.spec.ts.)
    await expect(layerCheckbox(page, 'places')).not.toBeChecked();

    // Toggle a bundled reference layer on: it appears in the URL.
    await layerCheckbox(page, 'places').check();
    await expect.poll(async () => (await urlLayers(page)).has('places')).toBe(true);
    await waitForLayerSettled(page, 'places');
    await expect(layerPill(page, 'places')).toHaveText('live');

    // Toggle it back off: it leaves the URL and its pill clears.
    await layerCheckbox(page, 'places').uncheck();
    await expect.poll(async () => (await urlLayers(page)).has('places')).toBe(false);
    await expect(layerPill(page, 'places')).toBeEmpty();

    // Toggle it on AGAIN: the second activation reuses the cached layer
    // module (the lazy-load contract: subsequent toggles flip a
    // cached source/layer set; the chunk import happened on the first
    // toggle) and must land in the same honest terminal state. This is the
    // cheapest deterministic probe of the lazy-load re-activation path.
    await layerCheckbox(page, 'places').check();
    await expect.poll(async () => (await urlLayers(page)).has('places')).toBe(true);
    await waitForLayerSettled(page, 'places');
    await expect(layerPill(page, 'places')).toHaveText('live');
  });

  test('a layer whose activation fails without throwing never enters the share URL', async ({ page }) => {
    // Regression for critical-review finding #2 (2026-07-07): a non-throwing
    // activate() failure (the module catches its own fetch error, calls
    // reportStatus('error'), and returns) used to resolve normally, so the
    // spine ran registry.activate and the failed key was counted in the pill
    // and written to the share URL, corrupting URL-as-state (invariant 2).
    //
    // Force USDM's FeatureServer query to fail at the network layer. The fetch
    // rejects, usdm.ts's own signal is not aborted, so it takes exactly the
    // reportStatus('error'); return path under test (not the thrown-error path
    // the catch block already handled).
    await page.route('**/USDM_current/**', (route) => route.abort());

    // Start all-off (explicit empty ?layers=) so nothing auto-activates, then
    // drive a single user toggle: the cleanest one-activation reproduction.
    await gotoApp(page, '?layers=');
    await expect(layerCheckbox(page, 'usdm')).not.toBeChecked();

    await layerCheckbox(page, 'usdm').check();
    await waitForLayerSettled(page, 'usdm');

    // The failed layer reports its honest terminal pill, not a fake "live"...
    await expect(layerPill(page, 'usdm')).toHaveText(PILL.unavailable);
    // ...and is scrubbed from the two places the bug corrupted: the checkbox
    // reverts to unchecked, and the key never lands in the share URL.
    await expect(layerCheckbox(page, 'usdm')).not.toBeChecked();
    await expect.poll(async () => (await urlLayers(page)).has('usdm')).toBe(false);
  });

  test('expanding the sidebar in embed mode deliberately exits embed', async ({ page }) => {
    await gotoApp(page, '?embed=true');
    await expect(page.locator('#app')).toHaveClass(/\bembed\b/);

    // In embed mode the sidebar is hidden and the floating expand button is
    // the escape hatch back to the full chrome (a project hard rule:
    // collapse/expand and the embed contract are first-class).
    const expand = page.locator('#sidebar-expand');
    await expect(expand).toBeVisible();
    await expand.click();

    // Expanding always exits embed mode (src/ui/sidebar.ts): the embed class
    // clears and the flag leaves the URL so a refresh holds the full view.
    await expect(page.locator('#app')).not.toHaveClass(/\bembed\b/);
    await expect(page.locator('#app')).not.toHaveClass(/\bsidebar-collapsed\b/);
    await expect.poll(async () => (await search(page)).includes('embed=true')).toBe(false);
  });

  test('embed mode sets the embed class and preserves the flag across syncUrl', async ({ page }) => {
    await gotoApp(page, '?embed=true');

    // The embed flag drives the app-shell class the embed CSS keys off.
    await expect(page.locator('#app')).toHaveClass(/\bembed\b/);
    expect(await search(page)).toContain('embed=true');

    // Boot fires syncUrl repeatedly (the region fit, then each default-on
    // layer as it activates). The embed flag must survive every one of those
    // rewrites (the URL-as-state invariant: embed preservation is
    // mandatory). The settle signal is the layer key ENTERING the URL: that
    // write only happens after the activation's registry change fires
    // syncUrl, so several rewrites are guaranteed to have run by then.
    // (Mechanism note, U1: this used to settle on the catalog status pill,
    // but a bare ?embed=true boots the BRIEF door since D-ARCH-002, and a
    // brief embed never mounts the catalog island at all (headroom C1), so
    // no pill DOM exists here. The assertions are unchanged.)
    await expect
      .poll(async () => (await urlLayers(page)).has('nadm-drought'), { timeout: 25_000 })
      .toBe(true);
    expect(await search(page)).toContain('embed=true');
  });

  test('a desktop bare boot is open while the embed stays closed', async ({ page }) => {
    // DDM-P10-T07 part 1: the stable-position rule (2026-09-13) covers
    // where the sidebar sits, not whether it starts open; at 721 CSS px and
    // wider, index.html no longer ships the collapsed class, so a bare boot
    // (and every hazard cluster's own boot) opens with the sidebar expanded.
    // The embed exit is untouched: an embed boot forces the column closed
    // regardless of this default (app.css :377-382, :398-402).
    const app = page.locator('#app');
    const sidebar = page.locator('#sidebar');
    const collapseBtn = page.locator('#sidebar-collapse');
    const expandBtn = page.locator('#sidebar-expand');

    // The four desktop/tablet viewports named in the launch prompt. Looping
    // every cluster boot at every viewport would push this well past a
    // sane runtime, so the full open/collapse/reopen assertion set runs at
    // all four viewports on a bare boot, and the per-cluster leg below runs
    // at one representative viewport (1280x720).
    const viewports = [
      { width: 1280, height: 720 },
      { width: 1440, height: 900 },
      { width: 1920, height: 1080 },
      { width: 900, height: 675 }
    ];

    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await gotoApp(page);

      await expect(app).not.toHaveClass(/\bsidebar-collapsed\b/);

      // The sidebar's rendered width must match the app-shell's own
      // computed grid column (var(--sidebar-w) resolved for this
      // viewport, 340px above 1024 and a clamp() as low as 334px in the
      // 721-1024 band), not a literal constant.
      const [sidebarBox, gridColumns] = await Promise.all([
        sidebar.boundingBox(),
        page.evaluate(() => {
          const el = document.getElementById('app');
          return el ? getComputedStyle(el).gridTemplateColumns : '';
        })
      ]);
      expect(sidebarBox, `${viewport.width}x${viewport.height}: #sidebar has no box`).not.toBeNull();
      const expectedWidth = parseFloat(gridColumns.split(' ')[0] ?? '');
      expect(
        Number.isNaN(expectedWidth),
        `${viewport.width}x${viewport.height}: could not read the grid column width`
      ).toBe(false);
      expect(
        Math.abs(sidebarBox!.width - expectedWidth),
        `${viewport.width}x${viewport.height}: sidebar width ${sidebarBox!.width} vs grid column ${expectedWidth}`
      ).toBeLessThanOrEqual(1);

      await expect(expandBtn, `${viewport.width}x${viewport.height}: expand hidden on open`).toBeHidden();
      await expect(collapseBtn, `${viewport.width}x${viewport.height}: collapse visible on open`).toBeVisible();

      // Collapse: the column drops to zero width and focus moves to expand.
      await collapseBtn.click();
      await expect(app, `${viewport.width}x${viewport.height}: collapsed class after collapse`).toHaveClass(
        /\bsidebar-collapsed\b/
      );
      const collapsedBox = await sidebar.boundingBox();
      expect(
        collapsedBox === null || collapsedBox.width <= 1,
        `${viewport.width}x${viewport.height}: sidebar did not collapse to zero width`
      ).toBe(true);
      await expect(expandBtn, `${viewport.width}x${viewport.height}: expand focused after collapse`).toBeFocused();

      // Reopen: the column returns and focus moves back to collapse.
      await expandBtn.click();
      await expect(app, `${viewport.width}x${viewport.height}: collapsed class cleared after reopen`).not.toHaveClass(
        /\bsidebar-collapsed\b/
      );
      await expect(collapseBtn, `${viewport.width}x${viewport.height}: collapse focused after reopen`).toBeFocused();
    }

    // Every hazard cluster's own bare boot opens the same way (N modes,
    // never four literals): one representative viewport, looped over
    // HAZARD_CLUSTER_KEYS rather than hard-coded cluster names.
    await page.setViewportSize({ width: 1280, height: 720 });
    for (const cluster of HAZARD_CLUSTER_KEYS) {
      const token = HAZARD_CLUSTERS[cluster].urlToken;
      const query = token === null ? '' : `?cluster=${token}`;
      await gotoApp(page, query);
      await expect(app, `cluster "${cluster}" bare boot is collapsed`).not.toHaveClass(/\bsidebar-collapsed\b/);
      await expect(sidebar, `cluster "${cluster}" sidebar is hidden`).toBeVisible();
    }

    // The embed leg stays closed regardless of the flipped default.
    await page.setViewportSize({ width: 1280, height: 720 });
    await gotoApp(page, '?embed=true');
    await expect(app).toHaveClass(/\bembed\b/);
    const embedBox = await sidebar.boundingBox();
    expect(embedBox === null || embedBox.width <= 1, 'embed sidebar did not stay collapsed').toBe(true);
    await expect(expandBtn).toBeVisible();
  });

  test('an embed boot keeps the zero-width sidebar out of the tab order', async ({ page }) => {
    // Guard for the M1 flip: an embed boot must never let Tab land inside
    // the zero-width `#sidebar` column. Before the flip this was green for
    // free, because index.html always shipped `sidebar-collapsed`
    // alongside `embed`, and the desktop rule at app.css :404-408 hides
    // `.sidebar-collapsed .sidebar` (visibility:hidden, no pointer-events).
    // On the flipped tree (index.html no longer ships that class at boot)
    // an embed-only boot is left with only the width:0 rule at app.css
    // :398-402, which does not remove the sidebar from the tab order, so
    // this case is expected to fail here until a CSS rule is added beside
    // :404-408 to also hide `.app-shell.embed .sidebar` (owned by the
    // director, not this file, per the launch prompt).
    await page.setViewportSize({ width: 1280, height: 720 });
    await gotoApp(page, '?embed=true');
    await page.evaluate(() => document.body.focus());

    const maxPresses = 60;
    for (let i = 0; i < maxPresses; i++) {
      await page.keyboard.press('Tab');
      const insideSidebar = await page.evaluate(() => {
        const active = document.activeElement;
        const el = document.getElementById('sidebar');
        return !!(active && el && el.contains(active));
      });
      expect(insideSidebar, `tab press ${i + 1} landed inside #sidebar`).toBe(false);
    }
  });
});

test.describe('DDM-P2-T09: one canonical place reference, no new URL parameter', () => {
  test('the select=state:WA deep link resolves the state:WA reference and adds no URL parameter', async ({
    page
  }) => {
    const waProperties = await captureWaProperties(page, async () => {
      await gotoApp(page, '?select=state:WA');
      await expect(page.locator('#impact-panel-title')).toHaveText('Washington');
    });

    expect(waProperties).not.toBeNull();
    expect(placeRefFromBoundary('state', waProperties)).toEqual({ scheme: 'state', code: 'WA' });

    assertNoNewUrlParam(await search(page));
  });
});

test.describe('D1 M4, found-026: unique Jump to region labels', () => {
  test('every Jump to region option label is unique', async ({ page }) => {
    await gotoApp(page);
    const labels = await page.locator('#region-select option').allTextContents();
    // Hawaii is the one framing drawn to match its detailed region 1:1
    // (framings.ts's comment at :299-302); both options must still read
    // differently in the one combined list (D1 M4, found-026, was 'Hawaii'
    // twice: option 9 the overview camera, option 18 the detailed region).
    expect(new Set(labels).size, labels.join(', ')).toBe(labels.length);
  });
});
