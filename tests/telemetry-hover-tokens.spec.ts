import { test, expect } from './offline-test';
import { gotoApp, waitForLayerSettled, urlLayers } from './helpers';
import { stubCpcDroughtOutlook } from './cpc-outlook-fixtures';

for (const width of [1440, 820]) {
  test('D3 opaque sidebar selection and briefing focus use adopted neutral tokens at ' + width, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    // Season ahead activates the actual CPC drought outlook, not the
    // seasonal temperature product already stubbed by gotoApp.
    await stubCpcDroughtOutlook(page);
    await gotoApp(page, '?region=washington_state&view=console&layers=none&flow=off');
    const sidebar = page.locator('#sidebar');
    const chip = sidebar.getByRole('button', { name: 'Season ahead', exact: true });
    await expect(chip).toHaveAttribute('aria-pressed', 'false');
    await chip.focus();
    await page.keyboard.press('Space');
    await waitForLayerSettled(page, 'drought');
    await waitForLayerSettled(page, 'aiannh');
    await expect(sidebar.locator('[data-layer-status="drought"]')).toHaveClass(/\bready\b/);
    await expect.poll(async () => [...await urlLayers(page)].sort()).toEqual(['aiannh', 'drought']);
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await expect(chip).toBeFocused();
    await expect(chip).toHaveCSS('background-color', 'rgb(42, 49, 56)');
    await expect(chip).toHaveCSS('color', 'rgb(255, 255, 255)');
    await expect(chip).toHaveCSS('font-weight', '700');
    await expect(chip).toHaveCSS('outline-color', 'rgb(255, 255, 255)');
    await expect(chip).toHaveCSS('outline-width', '2px');
    await expect(chip).toHaveCSS('outline-offset', '0px');
    const shadow = await chip.evaluate(node => getComputedStyle(node).boxShadow);
    expect(shadow).toContain('rgb(255, 255, 255) 2px 0px 0px 0px inset');
    expect(shadow).toContain('rgb(1, 11, 19) 0px 0px 0px 4px');
    await expect(sidebar.locator('input[type="checkbox"][data-layer-key="drought"]')).toBeChecked();
    await chip.hover();
    await expect(chip).toHaveCSS('background-color', 'rgb(42, 49, 56)');
    await expect(chip).toHaveCSS('color', 'rgb(255, 255, 255)');
    const briefing = sidebar.locator('#region-briefing-btn');
    await expect(briefing).toBeVisible();
    await expect(briefing).toHaveCSS('background-color', 'rgb(30, 36, 44)');
    await expect(briefing).toHaveCSS('border-top-color', 'rgb(138, 148, 166)');
    await briefing.hover();
    await expect(briefing).toHaveCSS('background-color', 'rgb(42, 49, 56)');
    await expect(briefing).toHaveCSS('color', 'rgb(232, 236, 240)');
    await briefing.focus();
    await page.keyboard.press('Tab');
    await briefing.focus();
    await expect(briefing).toHaveCSS('outline-color', 'rgb(255, 255, 255)');
    await expect(briefing).toHaveCSS('box-shadow', 'rgb(1, 11, 19) 0px 0px 0px 4px');
    await page.keyboard.press('Enter');
    const panel = page.locator('#impact-panel');
    await expect(panel).toBeVisible();
    await panel.locator('.impact-panel-close').click();
    await expect(panel).toBeHidden();
    await expect(briefing).toBeFocused();
  });
}

test('D3 opaque quick-view and checkbox controls keep neutral accessible edges', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await gotoApp(page, '?region=central_oregon&view=console&layers=none&flow=off');
  const chip = page.locator('.preset-chip[aria-pressed="false"]').first();
  await expect(chip).toBeVisible();
  await expect(chip).toHaveCSS('background-color', 'rgb(30, 36, 44)');
  await expect(chip).toHaveCSS('border-top-color', 'rgb(138, 148, 166)');
  await chip.hover();
  await expect(chip).toHaveCSS('background-color', 'rgb(42, 49, 56)');
  await expect(chip).toHaveCSS('color', 'rgb(232, 236, 240)');
  await expect(chip).toHaveCSS('border-top-color', 'rgb(138, 148, 166)');
  const checkbox = page.locator('.layer-toggle:visible input[type="checkbox"]:not(:checked)').first();
  await expect(checkbox).toHaveCSS('border-top-color', 'rgb(138, 148, 166)');
  await expect(checkbox).toHaveCSS('background-color', 'rgb(1, 11, 19)');
  // The real footer sits on S1; T4 is permitted here, unlike S3 hover descendants.
  await expect(page.locator('.sidebar-footer .muted').first()).toHaveCSS('color', 'rgb(138, 148, 166)');
});

test('D3 adopted opaque aliases reach the real sidebar and collapse control', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await gotoApp(page, '?region=central_oregon&view=console&layers=none&flow=off');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(1, 11, 19)');
  await expect(page.locator('body')).toHaveCSS('color', 'rgb(232, 236, 240)');
  await expect(page.locator('#sidebar')).toHaveCSS('background-color', 'rgb(20, 20, 20)');
  const collapse = page.getByRole('button', { name: 'Collapse sidebar', exact: true });
  await expect(collapse).toHaveCSS('color', 'rgb(152, 161, 180)');
  await collapse.hover();
  await expect(collapse).toHaveCSS('background-color', 'rgb(30, 36, 44)');
  await expect(collapse).toHaveCSS('color', 'rgb(232, 236, 240)');
  await collapse.click();
  const expand = page.getByRole('button', { name: 'Expand sidebar', exact: true });
  await expect(expand).toBeVisible();
  await expect(expand).toHaveCSS('background-color', 'rgb(20, 20, 20)');
  await expand.click();
  await expect(collapse).toBeVisible();
  await expect(page.locator('#sidebar')).toHaveCSS('background-color', 'rgb(20, 20, 20)');
});

test('D3 telemetry hover pairs adopted S3 with accessible status ink and control boundary', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await gotoApp(page, '?region=central_oregon&view=console&layers=none&flow=off');
  // Specimen uses the actual sidebar button/classes, exercising the shipped
  // stylesheet. It does not assert a fictional station response.
  await page.evaluate(() => {
    const fixture = document.createElement('section');
    fixture.id = 'telemetry-token-specimen';
    fixture.style.cssText = 'position:fixed;top:100px;right:20px;z-index:99999';
    fixture.innerHTML = '<button class="telemetry-item" type="button">' +
      '<span class="telemetry-meta"><span class="telemetry-name">Fixture</span>' +
      '<span class="telemetry-agency">Fixture</span>' +
      '<span class="telemetry-values loading">loading...</span>' +
      '<span class="telemetry-values unavailable">unavailable</span>' +
      '</span></button>';
    document.body.append(fixture);
  });
  const row = page.locator('#telemetry-token-specimen .telemetry-item');
  await expect(row).toHaveCSS('border-top-color', 'rgb(138, 148, 166)');
  await row.hover();
  await expect(row).toHaveCSS('background-color', 'rgb(42, 49, 56)');
  await expect(row).toHaveCSS('border-top-color', 'rgb(138, 148, 166)');
  for (const state of ['loading', 'unavailable']) {
    await expect(row.locator('.telemetry-values.' + state)).toHaveCSS('color', 'rgb(152, 161, 180)');
    await expect(row.locator('.telemetry-values.' + state)).toHaveCSS('font-style', 'italic');
  }
  const colors = await row.evaluate(node => {
    const style = getComputedStyle(node);
    return {
      background: style.backgroundColor, border: style.borderTopColor,
      inks: [...node.querySelectorAll('.telemetry-name,.telemetry-agency,.telemetry-values')]
        .map(child => getComputedStyle(child).color)
    };
  });
  const luminance = (color: string): number => {
    const channels = color.match(/[0-9.]+/g)!.slice(0, 3).map(Number).map(value => value / 255)
      .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return channels.reduce((sum, channel, i) => sum + channel * [0.2126, 0.7152, 0.0722][i]!, 0);
  };
  const contrast = (a: string, b: string): number => {
    const values = [luminance(a), luminance(b)].sort((x, y) => x - y);
    return (values[1]! + 0.05) / (values[0]! + 0.05);
  };
  for (const ink of colors.inks) expect(contrast(ink, colors.background)).toBeGreaterThanOrEqual(4.5);
  expect(contrast(colors.border, colors.background)).toBeGreaterThanOrEqual(3);
});
