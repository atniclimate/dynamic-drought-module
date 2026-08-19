import { readFileSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';
import { parse } from 'yaml';

import {
  gotoApp,
  layerCheckbox,
  layerPill,
  search,
  waitForLayerSettled
} from './helpers';
import { stubWildfireFeeds } from './wildfire-fixtures';

/**
 * The cross-view contract net.
 *
 * Every other spec in this suite asks whether ONE view behaves. This one
 * asks whether a person moving BETWEEN views keeps a coherent, shareable,
 * honest claim: the committed cluster, the URL, the 3D scene stamps, and
 * the catalog rows have to agree at every stop of the walk, not just at
 * the destination.
 *
 * The matrix lives in `tests/view-contracts.yaml` so a later change extends
 * the contract by adding a row rather than by writing another spec file,
 * and so the contract is readable by someone who does not read Playwright.
 * The vocabulary is deliberately small: if a row needs an action this file
 * cannot express, add the action here as a named step rather than reaching
 * into the page from the data.
 *
 * Assertion discipline: everything asserted here is production-observable
 * (URL parameters, aria-pressed, the document-element data stamps written
 * by src/map/fire3d.ts, catalog checkbox state, chrome presence). Nothing
 * reads a dev handle, so these rows hold against the deployed artifact.
 */

const CLUSTER_KEYS = ['drought', 'wildfire', 'heat', 'enso'] as const;
const FIRE3D_TOGGLE = '.shell-fire3d-btn';

/** Terrain build plus a DEM fan-out on the software renderer is slow. */
const FIRE3D_STAMP_TIMEOUT_MS = 60_000;

/**
 * URL writes are synchronous in the application, but the gesture that
 * triggers them competes with terrain tile work on the software renderer.
 * The default 10 s expect budget is tight enough that a starved frame, not
 * a broken contract, decides the result; 20 s keeps the assertion strict
 * about the VALUE while staying honest about the machine.
 */
const URL_POLL_TIMEOUT_MS = 20_000;

type Step =
  | { click_cluster: string }
  | { fire3d: 'on' | 'off' }
  | { select_region: string }
  | { set_layer: { key: string; on: boolean } }
  | { wait_settled: string }
  | { wait_fire3d: 'active' | 'inactive' }
  | { zoom_out: number }
  | { reload: true };

interface Expectations {
  cluster_pressed?: string;
  url_params?: Record<string, string | null>;
  url_layers_include?: string[];
  url_layers_exclude?: string[];
  fire3d_stamp?: 'active' | 'inactive' | 'absent';
  fire3d_context_includes?: string[];
  fire3d_context_excludes?: string[];
  fire3d_toggle?: 'pressed' | 'unpressed' | 'absent';
  layers_checked?: string[];
  layers_unchecked?: string[];
  /** Raw LayerStatus class on the catalog pill, keyed by layer key. */
  layer_status?: Record<string, string>;
  selector_counts?: Record<string, number>;
}

interface Row {
  id: string;
  description: string;
  url: string;
  stub_wildfire?: boolean;
  timeout_ms?: number;
  steps: Step[];
  expect: Expectations;
}

const MATRIX_URL = new URL('./view-contracts.yaml', import.meta.url);
const matrix = parse(readFileSync(MATRIX_URL, 'utf8')) as { rows: Row[] };

if (!Array.isArray(matrix?.rows) || matrix.rows.length === 0) {
  throw new Error('view-contracts.yaml carries no rows');
}

const seen = new Set<string>();
for (const row of matrix.rows) {
  if (seen.has(row.id)) {
    throw new Error(`view-contracts.yaml has a duplicate row id: ${row.id}`);
  }
  seen.add(row.id);
}

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

function fire3dStamp(page: Page): Promise<string | undefined> {
  return page.evaluate(() => document.documentElement.dataset['ddmFire3d']);
}

function fire3dContextStamp(page: Page): Promise<string | undefined> {
  return page.evaluate(
    () => document.documentElement.dataset['ddmFire3dContext']
  );
}

async function urlParam(page: Page, name: string): Promise<string | null> {
  return new URLSearchParams(await search(page)).get(name);
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function runStep(page: Page, step: Step): Promise<void> {
  if ('click_cluster' in step) {
    const key = step.click_cluster;
    await page.locator(`.shell-cluster-btn[data-cluster="${key}"]`).click();
    await expect(
      page.locator(`.shell-cluster-btn[data-cluster="${key}"]`)
    ).toHaveAttribute('aria-pressed', 'true');
    return;
  }

  if ('fire3d' in step) {
    const wanted = step.fire3d === 'on';
    const toggle = page.locator(FIRE3D_TOGGLE);
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute(
      'aria-pressed',
      wanted ? 'false' : 'true'
    );
    await toggle.click();
    await expect(toggle).toHaveAttribute(
      'aria-pressed',
      wanted ? 'true' : 'false'
    );
    return;
  }

  if ('select_region' in step) {
    await page
      .locator('#region-select')
      .selectOption(`region:${step.select_region}`, { force: true });
    return;
  }

  if ('set_layer' in step) {
    const box = layerCheckbox(page, step.set_layer.key);
    if (step.set_layer.on) await box.check();
    else await box.uncheck();
    return;
  }

  if ('wait_settled' in step) {
    await waitForLayerSettled(page, step.wait_settled);
    return;
  }

  if ('wait_fire3d' in step) {
    await expect
      .poll(() => fire3dStamp(page), { timeout: FIRE3D_STAMP_TIMEOUT_MS })
      .toBe(step.wait_fire3d);
    return;
  }

  if ('zoom_out' in step) {
    // The production build carries no dev map handle, so the camera moves
    // through the real control surface: MapLibre gives its canvas
    // tabIndex 0, and the minus key is its own zoom-out binding.
    const canvas = page.locator('#map canvas').first();
    await canvas.focus();
    for (let i = 0; i < step.zoom_out; i += 1) {
      await page.keyboard.press('Minus');
      await page.waitForTimeout(350);
    }
    return;
  }

  if ('reload' in step) {
    await page.reload({ waitUntil: 'domcontentloaded' });
    // Boot is finished when the sidebar has rebuilt, the same
    // network-independent signal `gotoApp` waits on.
    await expect(page.locator('#preset-chips .preset-chip')).not.toHaveCount(0);
    await expect(page.locator('#region-select option')).not.toHaveCount(0);
    return;
  }

  throw new Error(`unknown view-contract step: ${JSON.stringify(step)}`);
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

async function assertExpectations(
  page: Page,
  wanted: Expectations
): Promise<void> {
  if (wanted.cluster_pressed) {
    if (
      wanted.cluster_pressed !== 'none' &&
      !CLUSTER_KEYS.includes(wanted.cluster_pressed as never)
    ) {
      throw new Error(`unknown cluster key: ${wanted.cluster_pressed}`);
    }
    // `none` matches no key, so every button is asserted unpressed: the
    // honest chrome for a custom (granular `layers=`) display.
    for (const key of CLUSTER_KEYS) {
      await expect(
        page.locator(`.shell-cluster-btn[data-cluster="${key}"]`),
        `cluster button ${key}`
      ).toHaveAttribute(
        'aria-pressed',
        key === wanted.cluster_pressed ? 'true' : 'false'
      );
    }
  }

  for (const [name, value] of Object.entries(wanted.url_params ?? {})) {
    await expect
      .poll(() => urlParam(page, name), {
        message: `URL parameter ${name}`,
        timeout: URL_POLL_TIMEOUT_MS
      })
      .toBe(value);
  }

  if (wanted.url_layers_include || wanted.url_layers_exclude) {
    const tokens = new URLSearchParams(await search(page)).get('layers');
    const set = new Set(
      (tokens ?? '').split(',').map((token) => token.trim()).filter(Boolean)
    );
    for (const key of wanted.url_layers_include ?? []) {
      expect(set, `layers= should include ${key}`).toContain(key);
    }
    for (const key of wanted.url_layers_exclude ?? []) {
      expect(set, `layers= should not include ${key}`).not.toContain(key);
    }
  }

  if (wanted.fire3d_stamp) {
    if (wanted.fire3d_stamp === 'absent') {
      expect(await fire3dStamp(page)).toBeUndefined();
    } else {
      await expect
        .poll(() => fire3dStamp(page), { timeout: FIRE3D_STAMP_TIMEOUT_MS })
        .toBe(wanted.fire3d_stamp);
    }
  }

  if (wanted.fire3d_context_includes || wanted.fire3d_context_excludes) {
    const stamp = (await fire3dContextStamp(page)) ?? '';
    const tokens = new Set(stamp.split(/\s+/).filter(Boolean));
    for (const key of wanted.fire3d_context_includes ?? []) {
      expect(tokens, `3D context should include ${key}`).toContain(key);
    }
    for (const key of wanted.fire3d_context_excludes ?? []) {
      expect(tokens, `3D context should not include ${key}`).not.toContain(key);
    }
  }

  if (wanted.fire3d_toggle) {
    const toggle = page.locator(FIRE3D_TOGGLE);
    if (wanted.fire3d_toggle === 'absent') {
      await expect(toggle).toHaveCount(0);
    } else {
      await expect(toggle).toHaveAttribute(
        'aria-pressed',
        wanted.fire3d_toggle === 'pressed' ? 'true' : 'false'
      );
    }
  }

  for (const key of wanted.layers_checked ?? []) {
    await expect(layerCheckbox(page, key), `layer ${key}`).toBeChecked();
  }
  for (const key of wanted.layers_unchecked ?? []) {
    await expect(layerCheckbox(page, key), `layer ${key}`).not.toBeChecked();
  }

  for (const [key, status] of Object.entries(wanted.layer_status ?? {})) {
    // The RAW status word rides the pill as a CSS class, which is the
    // stable contract now that the displayed text varies per layer.
    await expect
      .poll(
        async () => {
          const cls = (await layerPill(page, key).getAttribute('class')) ?? '';
          return cls.split(/\s+/);
        },
        { message: `layer ${key} status`, timeout: FIRE3D_STAMP_TIMEOUT_MS }
      )
      .toContain(status);
  }

  for (const [selector, count] of Object.entries(
    wanted.selector_counts ?? {}
  )) {
    await expect(page.locator(selector), selector).toHaveCount(count);
  }
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

test.describe('view contracts', () => {
  for (const row of matrix.rows) {
    test(row.id, async ({ page }) => {
      if (row.timeout_ms) test.setTimeout(row.timeout_ms);
      test.info().annotations.push({
        type: 'contract',
        description: row.description
      });

      if (row.stub_wildfire) await stubWildfireFeeds(page);
      await gotoApp(page, row.url);

      for (const step of row.steps ?? []) await runStep(page, step);

      await assertExpectations(page, row.expect);
    });
  }
});
