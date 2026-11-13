import { test, expect, type Page } from './offline-test';
import {
  gotoApp,
  layerCheckbox,
  layerPill,
  PILL,
  search,
  stubHeatRiskCatalog,
  urlLayers,
  waitForLayerSettled
} from './helpers';
import { NWS_WWA_EMPTY } from './nws-wwa-fixtures';

const ALERTS = 'nws-alerts';
const ALERTS_NAME = 'Heat & Fire Weather Alerts';
const WWA_QUERY = '/eventdriven/rest/services/WWA/watch_warn_adv/MapServer/1/query';
const alertsDoor = (page: Page) => page.locator('#mobile-footer-nav button[data-tab="alerts"]');
const alertsTile = (page: Page) => page.locator('.conditions-metric[data-metric="alerts"]');

/** Fail the first activation; hold the explicit retry so its intent and
 * loading state can be inspected before the successful empty read arrives. */
async function failThenHold(page: Page) {
  let calls = 0;
  let release = (): void => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route((url) => url.pathname.endsWith(WWA_QUERY), async (route) => {
    calls += 1;
    if (calls === 1) {
      await route.abort();
      return;
    }
    await held;
    await route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: JSON.stringify(NWS_WWA_EMPTY)
    });
  });
  return { calls: () => calls, release };
}

async function expectHeatIntent(page: Page): Promise<void> {
  await expect(layerCheckbox(page, ALERTS)).toBeChecked();
  await expect(page.locator('.shell-cluster-btn[data-cluster="heat"]')).toHaveAttribute('aria-pressed', 'true');
  const params = new URLSearchParams(await search(page));
  expect(params.get('cluster')).toBe('heat');
  expect(params.has('layers')).toBe(false);
}

async function bootFailedHeat(page: Page): Promise<void> {
  await stubHeatRiskCatalog(page);
  await gotoApp(page, '?region=washington_state&view=console&cluster=heat');
  await waitForLayerSettled(page, ALERTS);
  await expect(layerPill(page, ALERTS)).toHaveClass(/\berror\b/);
  await expect(layerPill(page, ALERTS)).toHaveText(PILL.unavailable);
  await expectHeatIntent(page);
}

/** A failed tile retries; once live, Heat's own alerts reading opens the Key
 * (owner item 9, 2026-11-13: a mode's reading never switches its layer off). */
async function expectTileAction(page: Page, action: 'Retry' | 'Key'): Promise<void> {
  if (action === 'Retry') {
    await expect(alertsTile(page)).toHaveAttribute('title', `Retry ${ALERTS_NAME}`);
    await expect(alertsTile(page)).toHaveAttribute('aria-label', /Press to retry\.$/);
    await expect(alertsTile(page)).toHaveAttribute('aria-pressed', 'true');
    return;
  }
  await expect(alertsTile(page)).toHaveAttribute('title', `${ALERTS_NAME} details and key`);
  await expect(alertsTile(page)).toHaveAttribute('aria-label', new RegExp(`Open ${ALERTS_NAME} details and key\\.$`));
  await expect(alertsTile(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(alertsTile(page)).not.toHaveAttribute('aria-pressed', /.*/);
}

/** The strip's Key door: the Key opens, the layer, mode and URL stay. */
async function expectKeyOpened(page: Page, before: string): Promise<void> {
  await expect(alertsTile(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#map-key-content')).toBeVisible();
  await expectHeatIntent(page);
  expect(await search(page)).toBe(before);
}

async function useDoor(page: Page, door: string): Promise<void> {
  if (door === 'conditions strip') await alertsTile(page).click();
  else if (door === 'Alerts pane') await alertsDoor(page).click();
  else if (door === 'catalog keyboard') await layerCheckbox(page, ALERTS).press('Space');
  else await layerCheckbox(page, ALERTS).click();
}

test.describe('found-075: explicit doors retry a failed checked layer', () => {
  for (const door of ['conditions strip', 'Alerts pane', 'catalog checkbox', 'catalog keyboard'] as const) {
    test(`${door} retries without withdrawing the committed layer, mode or URL`, async ({ page }) => {
      if (door === 'Alerts pane') await page.setViewportSize({ width: 390, height: 844 });
      const gate = await failThenHold(page);
      try {
        await bootFailedHeat(page);
        expect(gate.calls()).toBe(1);
        const before = await search(page);
        await expectTileAction(page, 'Retry');
        await expect(alertsTile(page).locator('.conditions-action')).toHaveText('Retry');

        await useDoor(page, door);

        // Red on the old implementation: neither hide nor an already-checked
        // no-op starts the second request. The held request proves this is a
        // real retry, not merely a checkbox or status repaint.
        await expect.poll(gate.calls, { message: `${door} started the explicit retry` }).toBe(2);
        await expect(layerPill(page, ALERTS)).toHaveClass(/\bloading\b/);
        await expectHeatIntent(page);
        expect(await search(page)).toBe(before);
        await expectTileAction(page, 'Key');
        await expect(alertsTile(page).locator('.conditions-action')).toHaveCount(0);

        if (door === 'Alerts pane') {
          // Close and reopen while the retry is held. Opening the pane asks
          // for the layer again, but loading intent must not enqueue a retry.
          await alertsDoor(page).click();
          await alertsDoor(page).click();
          await expect(page.locator('#sheet-alerts-body')).toContainText('Checking');
          await expectHeatIntent(page);
          expect(gate.calls()).toBe(2);
        }

        gate.release();
        await waitForLayerSettled(page, ALERTS);
        await expect(layerPill(page, ALERTS)).toHaveClass(/\bno-data\b/);
        await expectHeatIntent(page);
        expect(await search(page)).toBe(before);
        expect(gate.calls()).toBe(2);
        await expectTileAction(page, 'Key');

        if (door === 'conditions strip') {
          // A clean empty read is active, not a failed retry: the reading
          // opens the Key and the mode's layer stays on.
          await alertsTile(page).click();
          await expectKeyOpened(page, before);
          expect(gate.calls()).toBe(2);
        } else if (door !== 'Alerts pane') {
          // The catalog checkbox keeps its normal hide action.
          await layerCheckbox(page, ALERTS).click();
          await expect(layerCheckbox(page, ALERTS)).not.toBeChecked();
          await expect.poll(async () => (await urlLayers(page)).has(ALERTS)).toBe(false);
          await expect(page.locator('.shell-cluster-btn[data-cluster="heat"]')).toHaveAttribute('aria-pressed', 'false');
          expect(gate.calls()).toBe(2);
        }
      } finally {
        gate.release();
      }
    });
  }

  for (const door of ['conditions strip', 'Alerts pane', 'catalog checkbox'] as const) {
    test(`${door} preserves its normal action after an active refresh error`, async ({ page }) => {
      if (door === 'Alerts pane') await page.setViewportSize({ width: 390, height: 844 });
      let calls = 0;
      await page.route((url) => url.pathname.endsWith(WWA_QUERY), async (route) => {
        calls += 1;
        if (calls > 1) return route.abort();
        return route.fulfill({
          status: 200,
          contentType: 'application/geo+json',
          body: JSON.stringify(NWS_WWA_EMPTY)
        });
      });
      await stubHeatRiskCatalog(page);
      await gotoApp(page, '?region=washington_state&view=console&cluster=heat');
      await waitForLayerSettled(page, ALERTS);
      await expect(layerPill(page, ALERTS)).toHaveClass(/\bno-data\b/);
      await expectHeatIntent(page);
      expect(calls).toBe(1);
      const before = await search(page);

      // The adapter's ordinary visibility refresh keeps the registry active.
      // Move only Date.now so a stale snapshot refreshes without timer churn.
      await page.evaluate(() => {
        const realNow = Date.now.bind(Date);
        Date.now = () => realNow() + 5 * 60_000 + 1;
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await expect.poll(() => calls).toBe(2);
      await expect(layerPill(page, ALERTS)).toHaveClass(/\berror\b/);
      await expectHeatIntent(page);
      expect(await search(page)).toBe(before);
      await expectTileAction(page, 'Key');
      await expect(alertsTile(page).locator('.conditions-action')).toHaveText('Key');

      await useDoor(page, door);
      if (door === 'conditions strip') {
        await expectKeyOpened(page, before);
      } else if (door === 'Alerts pane') {
        await expect(page.locator('#sheet-alerts-body')).toContainText('The National Weather Service alert feed is not reachable right now.');
        await expectHeatIntent(page);
        expect(await search(page)).toBe(before);
      } else {
        await expect(layerCheckbox(page, ALERTS)).not.toBeChecked();
        await expect.poll(async () => (await urlLayers(page)).has(ALERTS)).toBe(false);
        await expect(page.locator('.shell-cluster-btn[data-cluster="heat"]')).toHaveAttribute('aria-pressed', 'false');
      }
      expect(calls).toBe(2);
    });
  }

  test('a custom failure still withdraws its checkbox and URL, then a normal check activates it', async ({ page }) => {
    const gate = await failThenHold(page);
    try {
      await gotoApp(page, '?region=washington_state&view=console&layers=nws-alerts');
      await waitForLayerSettled(page, ALERTS);
      await expect(layerCheckbox(page, ALERTS)).not.toBeChecked();
      await expect(layerPill(page, ALERTS)).toHaveClass(/\berror\b/);
      expect((await urlLayers(page)).has(ALERTS)).toBe(false);
      expect(gate.calls()).toBe(1);

      await layerCheckbox(page, ALERTS).click();
      await expect.poll(gate.calls).toBe(2);
      await expect(layerCheckbox(page, ALERTS)).toBeChecked();
      gate.release();
      await waitForLayerSettled(page, ALERTS);
      await expect(layerPill(page, ALERTS)).toHaveClass(/\bno-data\b/);
      expect((await urlLayers(page)).has(ALERTS)).toBe(true);
      expect(gate.calls()).toBe(2);
    } finally {
      gate.release();
    }
  });
});
