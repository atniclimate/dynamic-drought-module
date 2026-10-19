import { expect, test, type Page } from './offline-test';

import { MOBILE_HAZARD_PRESETS, type ViewPreset } from '../src/config/presets';
import { gotoApp, layerCheckbox, urlLayers, waitForLayerSettled } from './helpers';
import { emptyCollectionBody } from './tribal-fixtures';

/**
 * DR-065 failure mode 1: the fire-view toggle controls that "did not respond
 * as expected, or the interface did not return to its initial state after
 * toggling" (observed on an iPad). Ported from the retired
 * tests/preset-toggle-cycles.spec.ts when the desktop Quick views chip row
 * left (owner review, 2026-10-19): the repeated-cycle contract stays, on the
 * entry points that survive, the phone hazard rail (which applies a preset
 * through the same controller) and the catalog checkboxes behind the sheet's
 * Layers door.
 *
 * One toggle and one rail press are proven elsewhere; this file runs a
 * SEQUENCE on a touch viewport. Every round is net-neutral by construction
 * (each layer goes off and back on), so the rail's recipe is still the right
 * answer at the end of a round. Crossing to another hazard and returning is
 * the strongest statement of "the interface returns to its initial state".
 * The oracle is the preset table itself (`MOBILE_HAZARD_PRESETS`, the module
 * the rail is built from), never a snapshot taken mid-run.
 *
 * At every rest point the three surfaces that can disagree are compared:
 * the checkbox intent, the status pills, and the URL.
 */

/** Phone portrait with a coarse pointer: the rail is the phone shell's. */
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

/** The terminal raw status classes, mirroring `TERMINAL_STATUS_CLASSES` in tests/helpers.ts (not exported). */
const TERMINAL_STATUS_CLASSES = ['ready', 'degraded', 'error', 'no-data', 'zoom-in'] as const;

/**
 * The live fire products the Fire rail names, answered with the honest empty
 * collection (a legitimate `no data` day, a terminal state that keeps the
 * layer checked and in the URL) so the cycle measures the interface's own
 * settling. GIBS is answered offline for the same reason as hazard-rail.spec.ts.
 */
async function stubFireProducts(page: Page): Promise<void> {
  for (const pattern of [
    '**/WFIGS_Interagency_Perimeters_Current/**',
    '**/NOAA_Satellite_Smoke_Detection*/**',
    '**/SPC_firewx/**'
  ]) {
    await page.route(pattern, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/geo+json',
        body: JSON.stringify(emptyCollectionBody())
      })
    );
  }
  await page.route('**/gibs.earthdata.nasa.gov/**', (route) =>
    route.fulfill({ status: 503, contentType: 'text/plain', body: 'Synthetic offline response' })
  );
}

function presetNamed(key: string): ViewPreset {
  const found = MOBILE_HAZARD_PRESETS.find((candidate) => candidate.key === key);
  if (!found) throw new Error(`no hazard rail preset named "${key}" in MOBILE_HAZARD_PRESETS`);
  return found;
}

/**
 * Every way the interface disagrees with the preset, or with itself, as
 * plain sentences, read in one evaluation so intent and pill cannot be read
 * a beat apart. An empty list is the whole contract; the caller polls it,
 * because a dropped layer leaves the URL synchronously and clears its pill
 * one queued operation later.
 */
async function disagreements(page: Page, preset: ViewPreset): Promise<string[]> {
  const recipe = [...preset.layers].sort().join(', ');
  const rows = await page.locator('#layer-toggles input[data-layer-key]').evaluateAll((nodes) =>
    nodes.map((node) => {
      const input = node as HTMLInputElement;
      const key = input.getAttribute('data-layer-key') ?? '';
      const pill = document.querySelector(`#layer-toggles [data-layer-status="${key}"]`);
      const status = (pill?.getAttribute('class') ?? '')
        .split(/\s+/)
        .filter((token) => token.length > 0 && token !== 'layer-toggle-status');
      return { key, checked: input.checked, status, text: (pill?.textContent ?? '').trim() };
    })
  );
  const urlKeys = await urlLayers(page);
  const problems: string[] = [];

  const checked = rows.filter((row) => row.checked).map((row) => row.key).sort().join(', ');
  if (checked !== recipe) problems.push(`the checked layers are "${checked}", and the recipe is "${recipe}"`);
  const inUrl = [...urlKeys].sort().join(', ');
  if (inUrl !== recipe) problems.push(`the URL layers are "${inUrl}", and the recipe is "${recipe}"`);

  for (const row of rows) {
    if (row.checked) {
      if (!TERMINAL_STATUS_CLASSES.some((terminal) => row.status.includes(terminal))) {
        problems.push(`"${row.key}" is on but its pill claims "${row.status.join(' ') || 'nothing'}"`);
      }
      if (!urlKeys.has(row.key)) problems.push(`"${row.key}" is on but missing from the URL`);
    } else {
      if (urlKeys.has(row.key)) problems.push(`"${row.key}" is off but still in the URL`);
      // An off layer clears its pill; the one honest exception is a failed
      // activation, which unchecks the box and re-asserts `error`.
      if (!(row.status.length === 0 || (row.status.length === 1 && row.status[0] === 'error'))) {
        problems.push(`"${row.key}" is off but its pill still claims "${row.status.join(' ')}" ("${row.text}")`);
      }
    }
  }
  return problems.sort();
}

async function expectPresetAtRest(page: Page, preset: ViewPreset, moment: string): Promise<void> {
  await expect
    .poll(() => disagreements(page, preset), {
      message: `${moment}: the interface never settled into the ${preset.label} rail recipe`,
      timeout: 25_000
    })
    .toEqual([]);
}

/** Tap a rail button after proving it is a control a person could use, then see it pressed. */
async function tapRail(page: Page, preset: ViewPreset, moment: string): Promise<void> {
  const button = page.locator(`#hazard-rail button[data-preset="${preset.key}"]`);
  await expect(button, `${moment}: the ${preset.label} rail button is not on screen`).toBeVisible();
  await expect(button, `${moment}: the ${preset.label} rail button is disabled`).toBeEnabled();
  await expect(button, `${moment}: the ${preset.label} rail button reads unavailable`).not.toHaveAttribute(
    'aria-disabled',
    'true'
  );
  await button.tap();
  await expectPresetAtRest(page, preset, moment);
  await expect(button, `${moment}: the ${preset.label} rail button`).toHaveAttribute('aria-pressed', 'true');
}

/** Open the full catalog through the sheet's Layers door (a rail tap closes the sheet). */
async function openCatalog(page: Page): Promise<void> {
  const app = page.locator('#app');
  if ((await app.getAttribute('data-sheet-detent')) === 'full') return;
  await page.locator('#mobile-footer-nav button[data-tab="layers"]').tap();
  await expect(app).toHaveAttribute('data-sheet-detent', 'half');
  await page.locator('#sheet-all-layers-btn').tap();
  await expect(app).toHaveAttribute('data-sheet-detent', 'full');
}

/** One net-neutral round: each key goes off and back on through its catalog checkbox. */
async function toggleRound(page: Page, keys: readonly string[]): Promise<void> {
  await openCatalog(page);
  for (const key of keys) {
    await layerCheckbox(page, key).uncheck();
    await expect(layerCheckbox(page, key)).not.toBeChecked();
    await layerCheckbox(page, key).check();
    await expect(layerCheckbox(page, key)).toBeChecked();
  }
}

test.describe('DR-065 mode 1: repeated toggling returns the interface to its rail preset', () => {
  test('the Fire rail view survives three toggle rounds, a hazard excursion, and a return', async ({
    page
  }) => {
    const fire = presetNamed('hazard-fire');
    const drought = presetNamed('hazard-drought');

    await stubFireProducts(page);
    await gotoApp(page, '?view=console');
    expect(
      await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches),
      'the cycle must run with a coarse pointer'
    ).toBe(true);
    // Settle the default surface so the first swap is not racing its own boot activation.
    await waitForLayerSettled(page, 'nadm-drought');

    await tapRail(page, fire, 'the first Fire rail tap');

    // The pair the observation named, toggled repeatedly rather than once.
    for (let round = 1; round <= 3; round++) {
      await toggleRound(page, ['nifc-fires', 'hms-smoke']);
      await expectPresetAtRest(page, fire, `after toggle round ${String(round)} in Fire`);
    }

    // Cross to another hazard, toggle there too, and come back.
    await tapRail(page, drought, 'the Drought rail tap');
    for (let round = 1; round <= 2; round++) {
      await toggleRound(page, ['nadm-drought']);
      await expectPresetAtRest(page, drought, `after toggle round ${String(round)} in Drought`);
    }

    await tapRail(page, fire, 'the return to Fire');

    // One more round after the return: a used interface stays as responsive as a fresh one.
    await toggleRound(page, ['nifc-fires', 'hms-smoke']);
    await expectPresetAtRest(page, fire, 'after the toggle round that follows the return');
  });
});
