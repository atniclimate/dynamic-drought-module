import { test, expect, type Page } from '@playwright/test';

import {
  awaitQuiescence,
  gotoApp,
  stubHeatRiskCatalog,
  DEFAULT_ON,
  SURFACE_KEYS
} from './helpers';
import { stubCpcDroughtOutlook } from './cpc-outlook-fixtures';
import { emptyCollectionBody, routeGeojson } from './tribal-fixtures';
import { MOBILE_HAZARD_PRESETS, VIEW_PRESETS, type ViewPreset } from '../src/config/presets';

/**
 * found-114 (S30D unit P3-BOOT): a command a person gives while the page is
 * still finishing its boot wins; the deferred boot never re-applies its own
 * captured layer set over it.
 *
 * The map's controls are enabled the moment `buildSidebar` returns
 * (`src/ui/sidebar.ts`, `enableMapDependentControls` in its finally), but
 * the URL or default layer set is activated only once the lazy island chunk
 * settles (`islandReady.then(... applyLayerSet(bootParams.layers))`). On a
 * slow link a hazard-rail tap or a preset chip click lands in that window,
 * and before this unit the boot then re-checked and re-activated every key it
 * had captured, with no exclusivity pass: the drought surface and the chosen
 * surface drew together, and the share URL carried both.
 *
 * Each case HOLDS the island chunk (a route on its built URL that answers
 * only once released), issues its command while it is held, releases it,
 * waits for the catalog to mount and the page to go quiet, then reads the
 * catalog, its status pills and the URL in ONE evaluate. The catalog's
 * checked set is final by the time it is observable: the island mounts
 * synchronously and the boot's `applyLayerSet` records its checkbox intent in
 * the microtasks right after the mount, before any later task can read the
 * page.
 *
 * Every layer the final display should hold must be checked AND drawn (its
 * pill in a terminal status, never absent and never stuck loading). The boot
 * seeds its keys as checked before any activation (sidebar.ts, the boot
 * intent seeding), so "checked" alone cannot tell an applied key from a
 * skipped one: a design that skipped the WHOLE boot after any command would
 * leave a boot key the command kept (aiannh under every hazard preset)
 * checked, in the URL, and never drawn.
 *
 * Modes are never a literal list: the rail case taps every RENDERED rail
 * button in order (several quick mode changes), and the chip cases pick a
 * RENDERED chip by what its preset declares, each resolved to its preset
 * through `src/config/presets.ts`.
 *
 * The cluster (mode) buttons and the horizon chips are rendered by the
 * island itself (`src/ui/island/shell.tsx`), so they do not exist in this
 * window; every case asserts that before its command.
 */

/** Every request for the island chunk, tolerating a retry's query string. */
const ISLAND_CHUNK = /\/island-[^/?]*\.js(\?|$)/;

const SURFACES: ReadonlySet<string> = new Set(SURFACE_KEYS);

/** The pill statuses a finished activation leaves (everything but `loading`). */
const TERMINAL: ReadonlySet<string> = new Set(['ready', 'degraded', 'error', 'no-data', 'zoom-in']);

/** Answer every source a commanded mode may start, so no live agency decides a result. */
async function stubModeSources(page: Page): Promise<void> {
  await stubHeatRiskCatalog(page);
  await stubCpcDroughtOutlook(page);
  const empty = emptyCollectionBody();
  for (const pattern of [
    '**/SPC_firewx/MapServer/1/query?**',
    '**/NOAA_Satellite_Smoke_Detection_*/FeatureServer/0/query?**'
  ]) {
    await routeGeojson(page, pattern, empty);
  }
  // The SST surface installs before its optional date enumeration; bound the
  // enumeration deterministically (the hazard-rail spec's pattern).
  await page.route('**/gibs.earthdata.nasa.gov/**', (route) =>
    route.fulfill({ status: 503, contentType: 'text/plain', body: 'Synthetic offline response' })
  );
}

/**
 * Boot with the island chunk held, run `command` inside the window between
 * the controls becoming usable and the deferred boot work, then release the
 * chunk and wait for the catalog and for quiescence. `gotoApp` drives the
 * boot (its catalog wait is what observes the release), so it runs alongside
 * the command rather than before it. Once released, the route answers every
 * later request at once.
 */
async function bootWithHeldIsland(
  page: Page,
  query: string,
  command: () => Promise<void>
): Promise<void> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(ISLAND_CHUNK, async (route) => {
    await held;
    await route.continue();
  });
  // Settled into a value at once, so a failure while the command runs is
  // never an unhandled rejection; it is rethrown below.
  const booted = gotoApp(page, query).then(
    () => null,
    (err: unknown) => err
  );
  try {
    await expect(page.locator('html')).toHaveAttribute('data-ddm-controls', 'ready');
    // The window is open: the controls work, the deferred boot has not run,
    // and neither a catalog row nor a mode button exists yet.
    await expect(page.locator('input[data-layer-key]')).toHaveCount(0);
    await expect(page.locator('#shell-island [data-cluster]')).toHaveCount(0);
    await command();
  } finally {
    release();
  }
  const bootError = await booted;
  if (bootError) throw bootError;
  await awaitQuiescence(page);
}

interface DisplayRead {
  readonly checked: readonly string[];
  /** Every catalog pill's status token, '' when the registry holds none. */
  readonly statuses: Readonly<Record<string, string>>;
  readonly urlLayers: readonly string[];
  readonly urlHorizon: string | null;
}

/** The catalog's checked keys, every pill's status, and the URL's layers and horizon, in one read. */
async function readDisplay(page: Page): Promise<DisplayRead> {
  return page.evaluate(() => {
    const catalog = document.getElementById('layer-toggles');
    const checked = catalog
      ? [...catalog.querySelectorAll<HTMLInputElement>('input[data-layer-key]')]
          .filter((input) => input.checked)
          .map((input) => input.dataset['layerKey'] ?? '')
      : [];
    const statusClass = /(?:^|\s)(loading|ready|degraded|error|no-data|zoom-in)(?:\s|$)/;
    const statuses: Record<string, string> = {};
    for (const pill of catalog?.querySelectorAll('[data-layer-status]') ?? []) {
      const key = pill.getAttribute('data-layer-status') ?? '';
      statuses[key] = statusClass.exec(pill.className)?.[1] ?? '';
    }
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('layers');
    const urlLayers = raw
      ? raw
          .split(',')
          .map((key) => key.trim())
          .filter(Boolean)
      : [];
    return {
      checked: [...new Set(checked)].sort(),
      statuses,
      urlLayers: urlLayers.sort(),
      urlHorizon: params.get('horizon')
    };
  });
}

function surfacesOf(keys: Iterable<string>): string[] {
  return [...keys].filter((key) => SURFACES.has(key)).sort();
}

/** The keys whose pill is in a terminal status, sorted. */
function drawnKeys(read: DisplayRead): string[] {
  return Object.keys(read.statuses)
    .filter((key) => TERMINAL.has(read.statuses[key] ?? ''))
    .sort();
}

/**
 * The display is exactly `expected`: one surface (or none), every layer
 * checked AND drawn, no other surface holding a status, the URL agreeing,
 * and (when given) the URL's horizon.
 */
async function expectDisplayIs(
  page: Page,
  expected: readonly string[],
  horizon?: string
): Promise<void> {
  const read = await readDisplay(page);
  const wanted = [...expected].sort();
  expect(
    surfacesOf(read.checked),
    'after the held boot the display holds only the chosen surface (checked)'
  ).toEqual(surfacesOf(wanted));
  expect(read.checked, 'after the held boot the checked set is the chosen set').toEqual(wanted);
  expect(read.urlLayers, 'after the held boot the URL agrees with the display').toEqual(read.checked);
  if (horizon !== undefined) {
    expect(read.urlHorizon, 'after the held boot the URL carries the chosen horizon').toBe(horizon);
  }
  // The registry trails the checked set: a chosen layer reaches a terminal
  // status only when its activation settles, and a surface an EARLIER
  // command turned on and a later one turned off keeps its status until its
  // per-key off op has faded it out (the quiescence seam does not wait on an
  // unchecked key). Poll for both, never a fixed sleep; a chosen layer that
  // is never activated, or a status that never clears, still fails here.
  await expect
    .poll(
      async () => {
        const now = await readDisplay(page);
        return {
          undrawn: wanted
            .filter((key) => !TERMINAL.has(now.statuses[key] ?? ''))
            .map((key) => `${key}:${now.statuses[key] || 'none'}`),
          otherSurfaces: SURFACE_KEYS.filter(
            (key) => !wanted.includes(key) && (now.statuses[key] ?? '') !== ''
          )
        };
      },
      {
        message:
          'after the held boot every chosen layer is drawn and no other surface holds a status'
      }
    )
    .toEqual({ undrawn: [], otherSurfaces: [] });
}

/** The first rendered preset chip whose preset satisfies `accept`. */
async function firstRenderedChip(
  page: Page,
  accept: (preset: ViewPreset) => boolean,
  what: string
): Promise<{ label: string; preset: ViewPreset }> {
  const labels = await page.locator('#preset-chips .preset-chip').allTextContents();
  for (const label of labels) {
    const preset = VIEW_PRESETS.find((candidate) => candidate.label === label.trim());
    if (preset && accept(preset)) return { label: label.trim(), preset };
  }
  throw new Error(`no rendered preset chip ${what}`);
}

/** A preset that names a surface, none of them in `bootLayers`. */
function namesAnotherSurface(bootLayers: readonly string[]): (preset: ViewPreset) => boolean {
  const bootSurfaces = new Set(surfacesOf(bootLayers));
  return (preset) => {
    const surfaces = surfacesOf(preset.layers);
    return surfaces.length > 0 && surfaces.every((key) => !bootSurfaces.has(key));
  };
}

test.beforeEach(async ({ page }) => {
  await stubModeSources(page);
});

test.describe('a command during the deferred boot (phone, 390x844)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the last of several hazard rail taps while the island chunk is held wins over the deferred boot set', async ({
    page
  }) => {
    let last: ViewPreset | null = null;
    await bootWithHeldIsland(page, '', async () => {
      const buttons = page.locator('#hazard-rail button[data-preset]');
      const keys = await buttons.evaluateAll((controls) =>
        controls.map((control) => control.getAttribute('data-preset') ?? '')
      );
      // Several quick mode changes, one per rendered button, in order.
      expect(keys.length).toBeGreaterThan(1);
      for (const key of keys) {
        const preset = MOBILE_HAZARD_PRESETS.find((candidate) => candidate.key === key);
        expect(preset, `rail button ${key} resolves to a preset`).toBeDefined();
        await page.locator(`#hazard-rail button[data-preset="${key}"]`).click();
        last = preset ?? null;
      }
    });
    expect(last).not.toBeNull();
    await expectDisplayIs(page, (last as ViewPreset | null)?.layers ?? []);
  });
});

test.describe('a command during the deferred boot (desktop, 1280x800)', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('a preset chip click while the island chunk is held wins over the deferred boot set', async ({
    page
  }) => {
    let chosen: ViewPreset | null = null;
    await bootWithHeldIsland(page, '?view=console', async () => {
      const { label, preset } = await firstRenderedChip(
        page,
        namesAnotherSurface(DEFAULT_ON),
        'names a surface the boot did not'
      );
      await page.locator('#preset-chips .preset-chip', { hasText: label }).click();
      chosen = preset;
    });
    expect(chosen).not.toBeNull();
    await expectDisplayIs(page, (chosen as ViewPreset | null)?.layers ?? []);
  });

  test('a preset chip declaring a later horizon, pressed while the island chunk is held, wins over the deferred boot set', async ({
    page
  }) => {
    let chosen: ViewPreset | null = null;
    await bootWithHeldIsland(page, '?view=console', async () => {
      // The chip runs requestHorizon inside the window as well as its layers.
      const { label, preset } = await firstRenderedChip(
        page,
        (candidate) => candidate.horizon !== undefined && candidate.horizon !== 'current',
        'declares a horizon later than current'
      );
      await page.locator('#preset-chips .preset-chip', { hasText: label }).click();
      chosen = preset;
    });
    expect(chosen).not.toBeNull();
    const preset = chosen as ViewPreset | null;
    await expectDisplayIs(page, preset?.layers ?? [], preset?.horizon);
  });

  test('a preset chip click held behind an explicit layers= deep link wins over the deferred boot set', async ({
    page
  }) => {
    const deepLink = ['nadm-drought', 'states'];
    let chosen: ViewPreset | null = null;
    await bootWithHeldIsland(page, `?view=console&layers=${deepLink.join(',')}`, async () => {
      const { label, preset } = await firstRenderedChip(
        page,
        namesAnotherSurface(deepLink),
        'names a surface the deep link did not'
      );
      await page.locator('#preset-chips .preset-chip', { hasText: label }).click();
      chosen = preset;
    });
    expect(chosen).not.toBeNull();
    await expectDisplayIs(page, (chosen as ViewPreset | null)?.layers ?? []);
  });

  test('a Layers studio checkbox while the island chunk is held wins over the deferred boot set', async ({
    page
  }) => {
    await bootWithHeldIsland(page, '?view=brief', async () => {
      await page.locator('#layers-studio-entry').click();
      const toggle = page.locator('#layers-studio-root input[data-layer-key="heatrisk"]');
      await toggle.check();
      await expect(toggle).toBeChecked();
    });
    // Checking a surface turns the boot's surface off (the one-surface rule)
    // and leaves every other boot layer as the boot asked: those the boot
    // itself must still activate.
    const expected = [...DEFAULT_ON.filter((key) => !SURFACES.has(key)), 'heatrisk'];
    await expectDisplayIs(page, expected);
  });

  test('with no command in the window the deferred boot applies its set as before', async ({
    page
  }) => {
    const query = '?view=console';
    await bootWithHeldIsland(page, query, async () => {
      // No command: the window opens and closes untouched.
    });
    // Every boot key checked and drawn: each one was activated by the
    // deferred boot, since nothing else ran in the window.
    await expectDisplayIs(page, DEFAULT_ON);
    const summary = (read: DisplayRead) => ({
      checked: read.checked,
      drawn: drawnKeys(read),
      urlLayers: read.urlLayers
    });
    const heldBoot = summary(await readDisplay(page));

    // The same query booted with nothing held (the released route answers at
    // once) reaches the same display.
    await gotoApp(page, query);
    await awaitQuiescence(page);
    await expect
      .poll(async () => summary(await readDisplay(page)), {
        message: 'the held boot reaches the same display as an unheld boot'
      })
      .toEqual(heldBoot);
  });
});
