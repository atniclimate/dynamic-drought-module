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
import { stubCpcDroughtOutlook } from './cpc-outlook-fixtures';

/**
 * DDM-P2-T09: the recognized URL parameter vocabulary, read from its own
 * documentation (the key list in src/state/url.ts's module comment and the
 * one-shot `select` beside `parseSelectParam`). A canonical place reference
 * is identity only and is never URL state (src/config/entities.ts), so no key
 * named here or below should ever be added by a selection.
 *
 * 2026-09-27, D1 M7 (precedence.md row G2): `fire3d`, `flow`, `flowink` and
 * the new `sidebar` join the set; the first three were already written by
 * the app and missing here. Additive: the one assertion that reads the set
 * (the select=state:WA case below) carries none of the four.
 */
const RECOGNIZED_URL_KEYS: ReadonlySet<string> = new Set([
  'region', 'layers', 'embed', 'view', 'week', 'dmode', 'sst', 'outlook',
  'horizon', 'basemap', 'framing', 'cluster', 'ocean', 'studio', 'heatday',
  'spi', 'fire3d', 'flow', 'flowink', 'sidebar', 'select'
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

// ---------------------------------------------------------------------------
// D1 M7 (DDM-P10-T07, DR-139): the sidebar= key against every URL writer
// (the Codex Tier 2 disposition, record S3 and decision 1: invalid or
// duplicate values are dropped on the next write of ANY writer), and the
// reload restoration of every recognized durable key (precedence row H4).
// ---------------------------------------------------------------------------

import {
  syncFire3dParam,
  syncHeatRiskDayParam,
  syncSpiWindowParam,
  syncUrl
} from '../src/state/url';
import {
  parseEnsoFlowParams,
  syncEnsoFlowParams,
  writeEnsoFlowParams,
  type EnsoFlowKind
} from '../src/state/enso-flow';
import * as ensoFlowState from '../src/state/enso-flow';
import { readFileSync } from 'node:fs';
import type { HazardClusterDef, HazardClusterKey } from '../src/config/clusters';
import { fullSiteLayersStudioUrl, fullSitePlaceStudioUrl } from '../src/state/studio-route';
import { FRAMINGS } from '../src/config/framings';
import { installFakeBrowser } from './map-harness';
import { stubHeatRiskCatalog } from './helpers';
import type { Route } from '@playwright/test';

/** Inbound sidebar= forms and whether the one emitted form survives a write. */
const SIDEBAR_INBOUND: ReadonlyArray<{ readonly query: string; readonly kept: boolean }> = [
  { query: 'sidebar=closed', kept: true },
  { query: 'sidebar=closed&sidebar=closed', kept: false },
  { query: 'sidebar=open', kept: false },
  { query: 'sidebar=', kept: false },
  { query: 'sidebar=CLOSED', kept: false },
  { query: 'embed=true&sidebar=closed', kept: false },
  { query: 'embed=1&sidebar=closed', kept: false },
  { query: 'embed=false&sidebar=closed', kept: true }
];

/** The additive writers: each clones the current query and changes one key. */
const ADDITIVE_WRITERS: ReadonlyArray<{
  readonly name: string;
  readonly key: string;
  readonly value: string;
  readonly write: () => void;
}> = [
  { name: 'syncHeatRiskDayParam', key: 'heatday', value: '3', write: () => syncHeatRiskDayParam(3) },
  { name: 'syncSpiWindowParam', key: 'spi', value: '30', write: () => syncSpiWindowParam(30) },
  { name: 'syncFire3dParam', key: 'fire3d', value: 'true', write: () => syncFire3dParam(true) },
  {
    name: 'syncEnsoFlowParams',
    key: 'flow',
    value: 'wind',
    write: () => syncEnsoFlowParams({ kind: 'wind', ink: 'light' })
  }
];

/** A fake `window` carrying only `location.href`, for the link-out builders. */
function withLocationHref<T>(href: string, run: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { href } }
  });
  try {
    return run();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

test.describe('D1 M7: every URL writer normalizes sidebar= (S3)', () => {
  test('the heatday, spi, fire3d and flow writers preserve one sidebar=closed and drop every other form', () => {
    for (const writer of ADDITIVE_WRITERS) {
      for (const inbound of SIDEBAR_INBOUND) {
        const label = `${writer.name} over ?cluster=wildfire&${inbound.query}`;
        const browser = installFakeBrowser({ search: `?cluster=wildfire&${inbound.query}` });
        try {
          writer.write();
          const params = new URLSearchParams(browser.search());
          expect(params.getAll('sidebar'), label).toEqual(inbound.kept ? ['closed'] : []);
          expect(params.get(writer.key), `${label}: its own key`).toBe(writer.value);
          expect(params.get('cluster'), `${label}: a neighbour`).toBe('wildfire');
          expect(params.getAll('embed'), `${label}: embed untouched`).toEqual(
            new URLSearchParams(inbound.query).getAll('embed')
          );
        } finally {
          browser.restore();
        }
      }
    }
  });

  test('the canonical write emits sidebar=closed only from the live preference, never in an embed', () => {
    const cases: ReadonlyArray<{
      readonly inbound: string;
      readonly sidebarClosed: boolean | undefined;
      readonly embed: boolean;
      readonly expected: readonly string[];
    }> = [
      // The canonical write rebuilds from state: the inbound token is irrelevant.
      { inbound: '?sidebar=closed', sidebarClosed: true, embed: false, expected: ['closed'] },
      { inbound: '?sidebar=closed', sidebarClosed: false, embed: false, expected: [] },
      { inbound: '?sidebar=closed&sidebar=closed', sidebarClosed: undefined, embed: false, expected: [] },
      { inbound: '', sidebarClosed: true, embed: false, expected: ['closed'] },
      { inbound: '?sidebar=closed', sidebarClosed: true, embed: true, expected: [] }
    ];
    for (const { inbound, sidebarClosed, embed, expected } of cases) {
      const label = `${inbound || '(bare)'} sidebarClosed=${String(sidebarClosed)} embed=${embed}`;
      const browser = installFakeBrowser({ search: inbound });
      try {
        syncUrl({
          region: 'national',
          layers: new Set(['places']),
          embed,
          view: 'brief',
          ...(sidebarClosed === undefined ? {} : { sidebarClosed })
        });
        const params = new URLSearchParams(browser.search());
        expect(params.getAll('sidebar'), label).toEqual([...expected]);
        expect(params.get('embed'), label).toBe(embed ? 'true' : null);
      } finally {
        browser.restore();
      }
    }
  });

  test('the full-site link-outs normalize sidebar= before they drop embed', () => {
    const origin = 'http://127.0.0.1:4173/';
    for (const build of [fullSiteLayersStudioUrl, fullSitePlaceStudioUrl]) {
      for (const inbound of SIDEBAR_INBOUND) {
        const href = withLocationHref(`${origin}?view=brief&${inbound.query}`, build);
        const params = new URL(href).searchParams;
        expect(params.getAll('sidebar'), `${build.name} ${inbound.query}`).toEqual(
          inbound.kept ? ['closed'] : []
        );
        expect(params.has('embed'), `${build.name} ${inbound.query}: embed dropped`).toBe(false);
        expect(params.get('view'), `${build.name} ${inbound.query}: a neighbour`).toBe('brief');
      }
    }
  });
});

const RELOAD_DESKTOP = { width: 1280, height: 720 } as const;
const RELOAD_PHONE = { width: 390, height: 844 } as const;
const RELOAD_FRAMING = Object.keys(FRAMINGS)[0] ?? '';
const RELOAD_PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);
const RELOAD_FLOW_ROUTE = /^https:\/\/(?:marine-api|api)\.open-meteo\.com\/v1\//;

/** The SST tile service and the ENSO direction overlay (tests/enso-flow.spec.ts's stubs). */
async function stubEnsoForReload(page: Page): Promise<void> {
  await page.route((url) => url.href.includes('DescribeDomains'), (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/xml',
      body:
        "<Domains xmlns:ows='http://www.opengis.net/ows/1.1'><DimensionDomain><ows:Identifier>time</ows:Identifier>" +
        '<Domain>2026-09-01/2026-09-07/P1D</Domain><Size>1</Size></DimensionDomain></Domains>'
    })
  );
  await page.route(
    (url) => url.href.includes('GHRSST_L4_MUR') && url.pathname.endsWith('.png'),
    (route) => route.fulfill({ status: 200, contentType: 'image/png', body: RELOAD_PIXEL })
  );
  await page.route(RELOAD_FLOW_ROUTE, (route: Route) => {
    const url = new URL(route.request().url());
    const latitudes = (url.searchParams.get('latitude') ?? '').split(',').map(Number);
    const longitudes = (url.searchParams.get('longitude') ?? '').split(',').map(Number);
    const [valueKey = 'value', directionKey = 'direction'] = (
      url.searchParams.get('current') ?? ''
    ).split(',');
    const time = Math.floor(Date.now() / 900_000) * 900;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        latitudes.map((latitude, i) => ({
          latitude,
          longitude: longitudes[i],
          current_units: { time: 'unixtime', [valueKey]: 'm/s', [directionKey]: '°' },
          current: { time, interval: 900, [valueKey]: 2, [directionKey]: 90 }
        }))
      )
    });
  });
}

interface ReloadGroup {
  readonly name: string;
  readonly query: string;
  readonly viewport?: { readonly width: number; readonly height: number };
  readonly stubs?: (page: Page) => Promise<unknown>;
  readonly ready?: (page: Page) => Promise<void>;
  /** Every key this boot claims, with the value a reload must keep. */
  readonly expected: Readonly<Record<string, string>>;
}

/**
 * One boot per composable group, because no single URL can carry every key:
 * `layers=` outranks `cluster=`, `ocean=` needs cluster=enso, flow is written
 * only beside ENSO, heatday only while HeatRisk is on, an embed drops
 * sidebar=, and region= yields to framing=. The coverage case below checks
 * the table against RECOGNIZED_URL_KEYS, so a new key fails there first.
 */
const RELOAD_GROUPS: readonly ReloadGroup[] = [
  {
    name: 'camera, display, door, time, imagery, window and sidebar',
    query:
      '?region=central_oregon&layers=places&view=console&week=20240702&dmode=chg1' +
      '&sst=2024-07-01&outlook=monthly&basemap=default&spi=30&sidebar=closed',
    expected: {
      region: 'central_oregon',
      layers: 'places',
      view: 'console',
      week: '20240702',
      dmode: 'chg1',
      sst: '2024-07-01',
      outlook: 'monthly',
      basemap: 'default',
      spi: '30',
      sidebar: 'closed'
    }
  },
  {
    // A bare-cluster boot now composes the Drought recipe at the winning
    // horizon (found-030), which reaches the CPC outlook layer instead of
    // the fixture-stubbed North American Drought Monitor, so this reload
    // case needs the outlook stub too.
    name: 'horizon',
    query: '?horizon=weeks-ahead',
    stubs: stubCpcDroughtOutlook,
    expected: { horizon: 'weeks-ahead' }
  },
  {
    name: 'framing',
    query: `?framing=${encodeURIComponent(RELOAD_FRAMING)}&layers=places`,
    expected: { framing: RELOAD_FRAMING, layers: 'places' }
  },
  {
    name: 'studio',
    query: '?layers=places&view=brief&studio=layers',
    ready: async (page) => {
      await expect(page.locator('#layers-studio-root')).toBeVisible();
    },
    expected: { studio: 'layers' }
  },
  { name: 'embed', query: '?embed=true&layers=places&view=console', expected: { embed: 'true' } },
  {
    name: 'ENSO cluster, ocean and direction overlay',
    query: '?cluster=enso&ocean=pacific&view=brief&basemap=default&flow=currents&flowink=dark',
    stubs: stubEnsoForReload,
    expected: { cluster: 'enso', ocean: 'pacific', flow: 'currents', flowink: 'dark' }
  },
  {
    name: 'HeatRisk day',
    query: '?view=console&layers=heatrisk&heatday=3',
    stubs: (page) => stubHeatRiskCatalog(page),
    expected: { heatday: '3' }
  },
  {
    // The Fire 3D chunk is desktop-only and can honestly demote the mode on a
    // renderer that cannot hold it, so the flag's URL restoration is proven
    // at phone width, where nothing but the store reads it. The desktop scene
    // restore is tests/view-contracts.yaml:261-279.
    name: 'Fire 3D preference',
    query: '?layers=places&fire3d=true',
    viewport: RELOAD_PHONE,
    expected: { fire3d: 'true' }
  }
];

async function expectReloadKeys(page: Page, group: ReloadGroup, phase: string): Promise<void> {
  for (const [key, value] of Object.entries(group.expected)) {
    await expect
      .poll(async () => new URLSearchParams(await search(page)).getAll(key), {
        message: `${group.name}, ${phase}: ${key}`
      })
      .toEqual([value]);
  }
}

test.describe('D1 M7: reload restores every recognized durable key (precedence H4)', () => {
  test('reload restores every recognized durable key: the table covers RECOGNIZED_URL_KEYS minus select', () => {
    const covered = new Set(RELOAD_GROUPS.flatMap((group) => Object.keys(group.expected)));
    const durable = [...RECOGNIZED_URL_KEYS].filter((key) => key !== 'select');
    expect(durable.filter((key) => !covered.has(key)), 'durable keys with no reload case').toEqual([]);
    expect(
      [...covered].filter((key) => !RECOGNIZED_URL_KEYS.has(key)),
      'reload cases for keys the vocabulary does not recognize'
    ).toEqual([]);
  });

  for (const group of RELOAD_GROUPS) {
    test(`reload restores every recognized durable key: ${group.name}`, async ({ page }) => {
      await page.setViewportSize(group.viewport ?? RELOAD_DESKTOP);
      await page.route('**/gibs.earthdata.nasa.gov/**', (route) =>
        route.fulfill({ status: 503, contentType: 'text/plain', body: 'Synthetic offline response' })
      );
      await group.stubs?.(page);
      await gotoApp(page, group.query);
      await group.ready?.(page);
      await expectReloadKeys(page, group, 'boot');

      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.locator('html')).toHaveAttribute('data-ddm-controls', 'ready');
      await expect.poll(() => page.locator('html').getAttribute('data-ddm-boot')).toBe('idle');
      await group.ready?.(page);
      await expectReloadKeys(page, group, 'reload');
      if (group.expected['sidebar'] === 'closed') {
        await expect(page.locator('#app')).toHaveClass(/\bsidebar-collapsed\b/);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// D1 M13 (register found-010, found-017; precedence H4): the Share control
// states its own restore contract, and a copied link reloaded after a pan
// and an open briefing restores exactly that contract, not the camera and
// not the briefing place (neither is ever URL state,
// src/state/typed-place.ts:13-18).
// ---------------------------------------------------------------------------

/**
 * Record every clipboard write on `page` (src/ui/share.ts copies
 * `window.location.href` through src/util/clipboard.ts's
 * navigator.clipboard path). Mirrors the recorder in
 * tests/precedence.spec.ts (D1 M7); duplicated here because that helper is
 * local to its own file and not exported, and the brief's own pattern
 * ("read how existing Share tests read the copied URL") is this one.
 */
async function installClipboardRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const copies: string[] = [];
    (window as unknown as { __ddmM13Copies: string[] }).__ddmM13Copies = copies;
    Object.defineProperty(Navigator.prototype, 'clipboard', {
      configurable: true,
      get: () => ({
        writeText: async (text: string): Promise<void> => {
          copies.push(text);
        }
      })
    });
  });
}

/** Click Share and return the exact text it copied. */
async function copiedShareHref(page: Page): Promise<string> {
  const before = await page.evaluate(
    () => (window as unknown as { __ddmM13Copies: string[] }).__ddmM13Copies.length
  );
  await page.evaluate(() => {
    (document.getElementById('share-btn') as HTMLElement | null)?.click();
  });
  let copied: string | undefined;
  await expect
    .poll(async () => {
      copied = await page.evaluate(
        (count: number) =>
          (window as unknown as { __ddmM13Copies: string[] }).__ddmM13Copies[count],
        before
      );
      return copied !== undefined;
    })
    .toBe(true);
  return copied!;
}

test.describe('D1 M13: the Share control states its own restore contract (found-010, found-017)', () => {
  test('a copied Share link reloaded after a pan and an open briefing restores exactly what the Share control says it restores', async ({
    page
  }) => {
    await installClipboardRecorder(page);
    await gotoApp(
      page,
      '?select=state:WA&region=washington_state&layers=places&horizon=weeks-ahead&sidebar=closed'
    );

    // The accessible name and the title state the contract in words (red on
    // base: aria-label is the bare "Share view", title is "Copy
    // embed-ready link to clipboard"; neither names a single restored or
    // dropped key).
    const shareBtn = page.locator('#share-btn');
    const contract =
      /restores region or framing, layers, mode and horizon.*not the map position or an open briefing/;
    await expect(shareBtn).toHaveAttribute('aria-label', contract);
    await expect(shareBtn).toHaveAttribute('title', contract);

    // The deep link opened the briefing at boot; the one-shot `select=` has
    // not necessarily cleared the instant boot-idle stamps (found-010: "drops
    // select= within 700 ms"), so wait for it explicitly before treating the
    // URL as settled.
    const panel = page.locator('#impact-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect(panel.locator('#impact-panel-title')).toHaveText('Washington');
    await expect
      .poll(async () => new URLSearchParams(await search(page)).has('select'), {
        message: 'select= clears after the one-shot boot open'
      })
      .toBe(false);

    const beforeSearch = await search(page);

    // Pan the camera by dragging the map. Panning is not tracked by any URL
    // key (only the nine editorial `framing=` presets are), so this changes
    // nothing about to be asserted below except by NOT changing it.
    const canvas = page.locator('#map canvas.maplibregl-canvas').first();
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    const cx = box!.x + box!.width / 2;
    const cy = box!.y + box!.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx - 180, cy - 140, { steps: 12 });
    await page.mouse.up();
    await expect(panel).toBeVisible();

    // The pan and the open briefing are byte-identical to the URL before
    // them (found-010's own reproduction evidence).
    expect(await search(page)).toBe(beforeSearch);

    const copied = await copiedShareHref(page);
    const copiedUrl = new URL(copied);
    expect(copiedUrl.search).toBe(beforeSearch);
    expect(copiedUrl.searchParams.has('select')).toBe(false);

    // The confirmation states the same contract: the visual toast shows it
    // and the boot-present polite live region found-017 asks for
    // (#copy-toast-status; tests/impact-panel-a11y.spec.ts proves the
    // announcement mechanics; this proves the wording matches).
    await expect(page.locator('#copy-toast')).toContainText(contract);
    const status = page.locator('#copy-toast-status');
    await expect(status).toHaveAttribute('role', 'status');
    await expect(status).toHaveAttribute('aria-live', 'polite');
    await expect(status).toContainText(contract);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('html')).toHaveAttribute('data-ddm-controls', 'ready');
    await expect.poll(() => page.locator('html').getAttribute('data-ddm-boot')).toBe('idle');

    // Restored: region, layers, mode/horizon, sidebar.
    await expect(regionSelect(page)).toHaveValue('region:washington_state');
    await expect
      .poll(async () => (await urlLayers(page)).has('places'))
      .toBe(true);
    await expect(
      page.locator('.shell-horizon-btn[data-horizon="weeks-ahead"]')
    ).toHaveAttribute('aria-pressed', 'true', { timeout: 45_000 });
    await expect(page.locator('#app')).toHaveClass(/\bsidebar-collapsed\b/);

    // NOT restored: the panned camera left no URL trace to restore (proven
    // above), and the briefing place does not reopen (select= was already
    // gone from the copied link).
    await expect(page.locator('#impact-panel')).toBeHidden();
  });
});

/**
 * ENSO-FLOW-PLAN E1-5 (block E1): the `flow=off` token and the `flowDefault`
 * cluster field (C-fit.md 1.4). A mode whose definition carries `flowDefault`
 * opens with that kind when its link names no `flow=`; `flow=off` is the new
 * token that keeps it off, written only where that default is on. Block E1
 * set `flowDefault` on no cluster; E2-4 (DR-111, precedence.md 2.4) sets it
 * on ENSO alone, as wind, so ENSO opens with wind on. The default-on cases
 * here still pass a synthetic cluster table or an explicit default, so they
 * hold whatever a real cluster carries.
 */
test.describe('E1-5: flow=off and the flowDefault cluster field', () => {
  /** Parse, then write back over the same query, as the cloning writer does. */
  function roundTrip(query: string, modeDefault: EnsoFlowKind): {
    readonly kind: EnsoFlowKind;
    readonly ink: string;
    readonly written: string;
  } {
    const params = new URLSearchParams(query);
    const preference = parseEnsoFlowParams(params, modeDefault);
    writeEnsoFlowParams(params, preference, modeDefault);
    return { kind: preference.kind, ink: preference.ink, written: params.toString() };
  }

  test('flow=off parses and round-trips where the mode default is on', () => {
    // Default on (DR-111's wind, precedence.md 2.4): no flow= key opens it.
    expect(parseEnsoFlowParams(new URLSearchParams('cluster=enso'), 'wind')).toEqual({ kind: 'wind', ink: 'light' });
    // flow=off parses to off and is written back as itself.
    expect(roundTrip('cluster=enso&flow=off', 'wind')).toEqual({
      kind: 'off',
      ink: 'light',
      written: 'cluster=enso&flow=off'
    });
    // A second round trip is stable.
    expect(roundTrip(roundTrip('cluster=enso&flow=off', 'wind').written, 'wind').written).toBe('cluster=enso&flow=off');
    // flowink is not carried beside flow=off (nothing draws to ink).
    expect(roundTrip('cluster=enso&flow=off&flowink=dark', 'wind').written).toBe('cluster=enso&flow=off');
    // The default kind writes no flow key, so a boot with no key stays clean;
    // its ink still round-trips.
    expect(roundTrip('cluster=enso', 'wind').written).toBe('cluster=enso');
    expect(roundTrip('cluster=enso&flow=wind&flowink=dark', 'wind')).toEqual({
      kind: 'wind',
      ink: 'dark',
      written: 'cluster=enso&flowink=dark'
    });
    expect(roundTrip('cluster=enso&flowink=dark', 'wind')).toEqual({
      kind: 'wind',
      ink: 'dark',
      written: 'cluster=enso&flowink=dark'
    });
    // Another kind is still named (every 2026-09-13 link keeps its kind).
    expect(roundTrip('cluster=enso&flow=currents', 'wind').written).toBe('cluster=enso&flow=currents');
    expect(roundTrip('cluster=enso&flow=waves', 'wind').written).toBe('cluster=enso&flow=waves');
    // Where the default is off, flow=off is off and is never written.
    expect(roundTrip('layers=sst-anomaly&flow=off', 'off')).toEqual({
      kind: 'off',
      ink: 'light',
      written: 'layers=sst-anomaly'
    });
    expect(roundTrip('layers=sst-anomaly&flow=wind', 'off').written).toBe('layers=sst-anomaly&flow=wind');
  });

  test('a duplicate or unknown flow resolves to off', () => {
    const offInputs = [
      'flow=wind&flow=waves',
      'flow=wind&flow=wind',
      'flow=rainbow',
      'flow=',
      'flow=OFF',
      'flow=Wind',
      'flow=off&flow=wind'
    ];
    for (const input of offInputs) {
      // Where the default is on, the writer rewrites it as flow=off
      // (moving-paths section 12), so the link keeps meaning off.
      expect(roundTrip(`cluster=enso&${input}`, 'wind'), `${input} beside a default-on mode`).toEqual({
        kind: 'off',
        ink: 'light',
        written: 'cluster=enso&flow=off'
      });
      // Where the default is off, it resolves to off and is dropped.
      expect(roundTrip(`layers=sst-anomaly&${input}`, 'off'), `${input} where the default is off`).toEqual({
        kind: 'off',
        ink: 'light',
        written: 'layers=sst-anomaly'
      });
    }
  });

  test('flowDefault is read from the cluster definition, never a cluster literal', () => {
    const withDefault = (
      key: HazardClusterKey,
      flowDefault: HazardClusterDef['flowDefault']
    ): Record<HazardClusterKey, HazardClusterDef> => ({
      ...HAZARD_CLUSTERS,
      [key]: { ...HAZARD_CLUSTERS[key], flowDefault }
    });

    // E2-4 sets it on ENSO alone (DR-111 wind): ENSO opens with wind, the
    // other modes open with flow off, and an off ENSO link writes flow=off.
    for (const key of HAZARD_CLUSTER_KEYS) {
      const token = HAZARD_CLUSTERS[key].urlToken;
      expect(HAZARD_CLUSTERS[key].flowDefault, `${key}'s flowDefault`).toBe(token === 'enso' ? 'wind' : undefined);
    }
    expect(ensoFlowState.ensoFlowModeDefault(new URLSearchParams('cluster=enso'))).toBe('wind');
    expect(ensoFlowState.ensoFlowModeDefault(new URLSearchParams('cluster=wildfire'))).toBe('off');
    expect(ensoFlowState.ensoFlowModeDefault(new URLSearchParams('view=console'))).toBe('off');
    expect(parseEnsoFlowParams(new URLSearchParams('cluster=enso'))).toEqual({ kind: 'wind', ink: 'light' });
    expect(parseEnsoFlowParams(new URLSearchParams('cluster=enso&flow=off'))).toEqual({ kind: 'off', ink: 'light' });
    const enso = new URLSearchParams('cluster=enso');
    writeEnsoFlowParams(enso, { kind: 'off', ink: 'light' });
    expect(enso.toString()).toBe('cluster=enso&flow=off');
    const ensoWindDefault = new URLSearchParams('cluster=enso');
    writeEnsoFlowParams(ensoWindDefault, { kind: 'wind', ink: 'light' });
    expect(ensoWindDefault.toString()).toBe('cluster=enso');

    // The field decides, whichever cluster carries it.
    const ensoWind = withDefault('enso', 'wind');
    expect(ensoFlowState.ensoFlowModeDefault(new URLSearchParams('cluster=enso'), ensoWind)).toBe('wind');
    expect(ensoFlowState.ensoFlowModeDefault(new URLSearchParams('cluster=wildfire'), ensoWind)).toBe('off');
    expect(ensoFlowState.ensoFlowModeDefault(new URLSearchParams(''), ensoWind)).toBe('off');
    // layers= outranks cluster= (parseShellParams): a granular display is no mode.
    expect(ensoFlowState.ensoFlowModeDefault(new URLSearchParams('cluster=enso&layers=sst-anomaly'), ensoWind)).toBe('off');
    const wildfireWaves = withDefault('wildfire', 'waves');
    expect(ensoFlowState.ensoFlowModeDefault(new URLSearchParams('cluster=wildfire'), wildfireWaves)).toBe('waves');
    // ENSO keeps its own field (wind) beside the synthetic Wildfire default.
    expect(ensoFlowState.ensoFlowModeDefault(new URLSearchParams('cluster=enso'), wildfireWaves)).toBe('wind');
    // Drought's URL truth is absence, so a default on Drought reads from no token.
    expect(ensoFlowState.ensoFlowModeDefault(new URLSearchParams('view=console'), withDefault('drought', 'currents'))).toBe('currents');

    // And no cluster literal stands in for the field in the state module.
    const source = readFileSync(new URL('../src/state/enso-flow.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(source).toContain('flowDefault');
    expect(source).not.toMatch(/['"`](?:enso|drought|wildfire|heat)['"`]/);
  });
});
