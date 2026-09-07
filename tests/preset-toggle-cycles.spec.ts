import { expect, test, type Page } from '@playwright/test';

import { VIEW_PRESETS, type ViewPreset } from '../src/config/presets';
import { gotoApp, layerCheckbox, urlLayers, waitForLayerSettled } from './helpers';
import { emptyCollectionBody } from './tribal-fixtures';

/**
 * DR-065 failure mode 1: the fire-view toggle controls that "did not respond
 * as expected, or the interface did not return to its initial state after
 * toggling" (planning/user-research/2026-08-02-community-member-powell-river.md,
 * observed on an iPad).
 *
 * The suite already proves that ONE toggle settles correctly
 * (`layer-coactivation.spec.ts`) and that ONE preset click settles correctly
 * (`ux2-presets.spec.ts`). Neither runs a SEQUENCE, and neither runs on a
 * touch viewport, so the observed failure had no contract at all. This file
 * is that contract.
 *
 * Three things make it a different question from the two specs above:
 *
 *   1. It runs a repeated cycle, not a single act. Every round is
 *      net-neutral BY CONSTRUCTION (off then on for each of the two paired
 *      event layers; the co-activation partner is already on both times, so
 *      the cascade is a no-op), so the recipe is still the right answer at
 *      the end of the round. If the interface does not come back, the
 *      per-key operation chain, the intent generations, or the URL write
 *      order is at fault, which is exactly what the observation describes.
 *   2. It crosses presets and returns. A preset REPLACES the active set, so
 *      leaving Fire risk for Whose land and coming back is the strongest
 *      available statement of "the interface returns to its initial state":
 *      the second Fire risk must equal the first, layer for layer.
 *   3. The oracle is the preset table itself (`VIEW_PRESETS`, the same
 *      module the chip row is built from), never a snapshot taken mid-run.
 *      A snapshot would happily agree with a wrong state it had already
 *      recorded; the recipe cannot.
 *
 * At every rest point the three surfaces that can disagree are compared with
 * each other: the checkbox intent, the status pills, and the URL.
 */

/** Tablet portrait with a coarse pointer: the device the failure was seen on. */
test.use({ viewport: { width: 820, height: 1180 }, hasTouch: true });

/**
 * The five terminal raw status classes, mirroring `TERMINAL_STATUS_CLASSES`
 * in `tests/helpers.ts` (not exported there) and the same list
 * `studio-url-matrix.spec.ts` keeps. Classifying by raw class rather than by
 * pill text keeps this valid for every layer, since the no-data wording
 * varies per layer (`noDataLabel`).
 */
const TERMINAL_STATUS_CLASSES = ['ready', 'degraded', 'error', 'no-data', 'zoom-in'] as const;

/**
 * The three live fire products the Fire risk recipe names. Stubbed with the
 * honest empty collection so a cycle spec measures the interface's own
 * settling behavior rather than three agencies' response times: an empty
 * FeatureCollection is a legitimate `no data` day for each of them, and
 * `no data` is a terminal state that keeps the layer registered, checked,
 * and in the URL. GIBS is answered offline for the same reason: the Fire
 * risk chip asks for the satellite basemap.
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
  const found = VIEW_PRESETS.find((candidate) => candidate.key === key);
  if (!found) throw new Error(`no view preset named "${key}" in VIEW_PRESETS`);
  return found;
}

interface RowReading {
  readonly checked: boolean;
  /** The pill's status class, or the empty string when it claims nothing. */
  readonly status: string;
  readonly text: string;
}

/**
 * Read every catalog row's checkbox intent and its pill in ONE evaluation,
 * so the two cannot be read a beat apart and appear to agree (or disagree)
 * because of the gap rather than because of the state.
 */
async function readCatalog(page: Page): Promise<Map<string, RowReading>> {
  const rows = await page
    .locator('#layer-toggles input[data-layer-key]')
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const input = node as HTMLInputElement;
        const key = input.getAttribute('data-layer-key') ?? '';
        const pill = document.querySelector(`#layer-toggles [data-layer-status="${key}"]`);
        const status = (pill?.getAttribute('class') ?? '')
          .split(/\s+/)
          .filter((token) => token.length > 0 && token !== 'layer-toggle-status')
          .join(' ');
        return { key, checked: input.checked, status, text: (pill?.textContent ?? '').trim() };
      })
    );
  return new Map(
    rows.map((row) => [row.key, { checked: row.checked, status: row.status, text: row.text }])
  );
}

/**
 * Every way the interface currently disagrees with the preset, or with
 * itself, as plain sentences. An empty list is the whole contract.
 *
 * Collected all at once rather than asserted one at a time so a failure
 * reports EVERY disagreement at that moment instead of only the first, and
 * so the caller can poll the whole picture: "at rest" is a state the
 * interface has to reach, not an instant to sample. The three surfaces do
 * not move together, and deliberately so. A preset drops a layer from the
 * checkbox intent and therefore from the URL synchronously, while the
 * layer's own teardown (fade out, remove, clear the pill) runs one queued
 * operation later, so a sampled read lands inside that gap and sees a pill
 * still reading "live" for a layer the URL has already let go. The gap is
 * ordinary; never closing it would not be.
 */
async function disagreements(page: Page, preset: ViewPreset): Promise<string[]> {
  const recipe = [...preset.layers].sort().join(', ');
  const rows = await readCatalog(page);
  const urlKeys = await urlLayers(page);
  const problems: string[] = [];

  const checked = [...rows]
    .filter(([, row]) => row.checked)
    .map(([key]) => key)
    .sort()
    .join(', ');
  if (checked !== recipe) {
    problems.push(`the checked layers are "${checked}", and the recipe is "${recipe}"`);
  }

  const inUrl = [...urlKeys].sort().join(', ');
  if (inUrl !== recipe) {
    problems.push(`the URL layers are "${inUrl}", and the recipe is "${recipe}"`);
  }

  for (const [key, row] of rows) {
    const tokens = row.status.split(' ').filter((token) => token.length > 0);
    if (row.checked) {
      if (!TERMINAL_STATUS_CLASSES.some((terminal) => tokens.includes(terminal))) {
        problems.push(`"${key}" is on but its pill claims "${row.status || 'nothing'}"`);
      }
      if (!urlKeys.has(key)) problems.push(`"${key}" is on but missing from the URL`);
    } else {
      if (urlKeys.has(key)) problems.push(`"${key}" is off but still in the URL`);
      // An off layer clears its pill. The ONE honest exception is the failed
      // activation, which deliberately unchecks the box, keeps the key out
      // of the URL, and RE-ASSERTS `error` so the pill still reads
      // "unavailable" rather than silently reading "off"
      // (src/state/layer-controller.ts, the terminal-error guard). Any other
      // surviving state is a pill claiming a layer that is not there.
      if (!(tokens.length === 0 || (tokens.length === 1 && tokens[0] === 'error'))) {
        problems.push(`"${key}" is off but its pill still claims "${row.status}" ("${row.text}")`);
      }
    }
  }
  return problems.sort();
}

/**
 * The whole contract at one rest point: the interface becomes exactly what
 * the preset defines, and its three state surfaces come to agree with each
 * other, within the same budget a single layer activation is given.
 *
 * `moment` names the point in the sequence so a failure reads as "after the
 * third toggle round" rather than as an anonymous set mismatch.
 */
async function expectPresetAtRest(
  page: Page,
  preset: ViewPreset,
  moment: string
): Promise<void> {
  await expect
    .poll(() => disagreements(page, preset), {
      message: `${moment}: the interface never settled into the ${preset.label} recipe`,
      timeout: 25_000
    })
    .toEqual([]);
}

/**
 * Apply a preset by its chip, after proving the chip is a control a person
 * could actually use. "Some did not respond as expected" is half of what was
 * observed, so a chip that is present but inert would satisfy a plain click
 * and hide exactly the failure this file exists to catch. Every tap here
 * happens after `gotoApp` has seen `data-ddm-boot="idle"`, which is the
 * moment the map-dependent wiring is live.
 */
async function tapPreset(page: Page, preset: ViewPreset, moment: string): Promise<void> {
  const chip = page.locator('#preset-chips .preset-chip', { hasText: preset.label });
  await expect(chip, `${moment}: the ${preset.label} chip is not on screen`).toBeVisible();
  await expect(chip, `${moment}: the ${preset.label} chip is disabled`).toBeEnabled();
  await expect(
    chip,
    `${moment}: the ${preset.label} chip is still marked unavailable`
  ).not.toHaveAttribute('aria-disabled', 'true');
  await chip.tap();
}

/**
 * One net-neutral toggle round on a pair of layers the preset names. Each
 * layer goes off and back on; the co-activation partner is on throughout, so
 * the user-toggle cascade adds nothing and the round must end where it began.
 */
async function toggleRound(page: Page, keys: readonly string[]): Promise<void> {
  for (const key of keys) {
    await layerCheckbox(page, key).uncheck();
    await expect(layerCheckbox(page, key)).not.toBeChecked();
    await layerCheckbox(page, key).check();
    await expect(layerCheckbox(page, key)).toBeChecked();
  }
}

test.describe('DR-065 mode 1: repeated toggling returns the interface to its preset', () => {
  test('the fire view survives three toggle rounds, a preset excursion, and a return', async ({
    page
  }) => {
    const fireRisk = presetNamed('fire-risk');
    const whoseLand = presetNamed('whose-land');

    await stubFireProducts(page);
    // Console: the Quick views chip row is hidden in Brief behind the console
    // door (E1 deliverable 1), and the observation was of the fire view's
    // toggle controls, which live in the console catalog.
    await gotoApp(page, '?view=console');

    // Prove the viewport really is the coarse-pointer one the observation
    // came from, rather than a desktop run in tablet clothing.
    expect(
      await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches),
      'the tablet case must run with a coarse pointer'
    ).toBe(true);

    // Settle the default surface before the first preset swap, so the swap
    // that turns it off is not racing its own boot activation.
    await waitForLayerSettled(page, 'nadm-drought');

    await tapPreset(page, fireRisk, 'the first Fire risk chip');
    await expectPresetAtRest(page, fireRisk, 'after the first Fire risk chip');

    // The pair the observation named: Current Mapped Fire Perimeters and
    // Smoke Plumes, toggled repeatedly rather than once.
    for (let round = 1; round <= 3; round++) {
      await toggleRound(page, ['nifc-fires', 'hms-smoke']);
      await expectPresetAtRest(page, fireRisk, `after toggle round ${String(round)} in Fire risk`);
    }

    // Cross to a different preset, toggle there too, and come back.
    await tapPreset(page, whoseLand, 'the Whose land chip');
    await expectPresetAtRest(page, whoseLand, 'after the Whose land chip');

    for (let round = 1; round <= 2; round++) {
      await toggleRound(page, ['states']);
      await expectPresetAtRest(
        page,
        whoseLand,
        `after toggle round ${String(round)} in Whose land`
      );
    }

    await tapPreset(page, fireRisk, 'the return to Fire risk');
    await expectPresetAtRest(page, fireRisk, 'after returning to Fire risk');

    // One more round after the return: a preset applied to an already-used
    // interface must leave controls as responsive as a freshly booted one.
    await toggleRound(page, ['nifc-fires', 'hms-smoke']);
    await expectPresetAtRest(page, fireRisk, 'after the toggle round that follows the return');
  });
});
