import { test, expect } from './offline-test';
import { gotoApp, layerCheckbox, urlLayers, waitForLayerSettled } from './helpers';
import { stubWildfireFeeds } from './wildfire-fixtures';
import { STATUS_PILL_TEXT } from '../src/ui/island/pill-text';

for (const width of [1440, 820]) {
  test(`D3 M6 opaque sidebar layer selection and keyboard focus at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await stubWildfireFeeds(page);
    await gotoApp(page, '?view=console&layers=none&flow=off');
    const checkbox = layerCheckbox(page, 'nifc-fires');
    const row = page.locator('#sidebar .layer-toggle').filter({ has: checkbox });
    const name = row.locator('.layer-toggle-name');
    const status = page.locator('[data-layer-status="nifc-fires"]');
    await expect(checkbox).toBeEnabled();
    await expect(checkbox).not.toBeChecked();
    await row.hover();
    await expect(row).toHaveCSS('background-color', 'rgb(30, 36, 44)');
    await checkbox.focus();
    await expect(checkbox).toBeFocused();
    await expect(checkbox).toHaveCSS('outline-color', 'rgb(255, 255, 255)');
    await expect(checkbox).toHaveCSS('outline-width', '2px');
    await expect(checkbox).toHaveCSS('outline-offset', '0px');
    await expect(checkbox).toHaveCSS('box-shadow', 'rgb(1, 11, 19) 0px 0px 0px 4px');
    await checkbox.press('Space');
    await waitForLayerSettled(page, 'nifc-fires');
    await expect(status).toHaveClass(/\bready\b/);
    await expect(status).toHaveText(STATUS_PILL_TEXT.ready);
    await expect(checkbox).toBeChecked();
    expect(await urlLayers(page)).toEqual(new Set(['nifc-fires']));
    await expect(row).toHaveCSS('background-color', 'rgb(42, 49, 56)');
    await expect(row).toHaveCSS('border-top-color', 'rgb(138, 148, 166)');
    await expect(row).toHaveCSS('box-shadow', 'rgb(255, 255, 255) 2px 0px 0px 0px inset');
    await expect(name).toHaveCSS('color', 'rgb(255, 255, 255)');
    await expect(name).toHaveCSS('font-weight', '700');
    await expect(checkbox).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await expect(status).toHaveCSS('color', 'rgb(232, 236, 240)');
    await row.hover();
    await expect(row).toHaveCSS('background-color', 'rgb(42, 49, 56)');
    await page.mouse.move(width - 10, 10);
    await expect(row).toHaveCSS('background-color', 'rgb(42, 49, 56)');
    await checkbox.press('Space');
    await expect(checkbox).not.toBeChecked();
    await expect.poll(async () => (await urlLayers(page)).has('nifc-fires')).toBe(false);
    await expect(row).toHaveCSS('box-shadow', 'none');
  });
}

// A specimen of each existing application status class exercises the shipped
// stylesheet. It does not impersonate a source response or change status words.
for (const reducedMotion of ['reduce', 'no-preference'] as const) {
  test('D3 M6 six static status glyphs and neutral inks: ' + reducedMotion, async ({ page }) => {
    await page.emulateMedia({ reducedMotion });
    await gotoApp(page, '?region=central_oregon&view=console&layers=none&flow=off');
    await page.evaluate(words => {
      const specimen = document.createElement('section');
      specimen.id = 'status-contract-specimen';
      for (const [status, word] of Object.entries(words)) {
        const row = document.createElement('span');
        row.className = 'layer-toggle-status ' + status;
        row.dataset.status = status;
        row.textContent = word;
        specimen.append(row);
      }
      document.body.append(specimen);
    }, STATUS_PILL_TEXT);
    const samples = await page.locator('#status-contract-specimen .layer-toggle-status').evaluateAll(nodes =>
      nodes.map(node => {
        const word = getComputedStyle(node);
        const glyph = getComputedStyle(node, '::before');
        return {
          status: (node as HTMLElement).dataset.status!,
          text: node.textContent, color: word.color, weight: word.fontWeight,
          italic: word.fontStyle, content: glyph.content, width: glyph.width,
          height: glyph.height, border: glyph.borderTopWidth,
          image: glyph.backgroundImage, background: glyph.backgroundColor,
          animation: glyph.animationName, transition: glyph.transitionDuration
        };
      }));
    expect(samples).toHaveLength(6);
    for (const sample of samples) {
      expect(sample.text).toBe(STATUS_PILL_TEXT[sample.status as keyof typeof STATUS_PILL_TEXT]);
      expect(sample.content).toBe('""');
      expect(sample.width).toBe('8px');
      expect(sample.height).toBe('8px');
      expect(sample.border).toBe('1px');
      expect(sample.animation).toBe('none');
      expect(sample.transition).toBe('0s');
      expect(sample.color).toBe(sample.status === 'error' ? 'rgb(255, 255, 255)' :
        ['ready', 'degraded'].includes(sample.status) ? 'rgb(232, 236, 240)' : 'rgb(198, 203, 212)');
    }
    // Every state has a different shape even when rendered in monochrome.
    expect(new Set(samples.map(row => row.image + '/' + row.background)).size).toBe(6);
    expect(samples.find(row => row.status === 'error')!.weight).toBe('700');
    expect(samples.find(row => row.status === 'no-data')!.italic).toBe('italic');
  });
}
