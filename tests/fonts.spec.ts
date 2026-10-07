import { test, expect } from './offline-test';
import { gotoApp } from './helpers';
import { installBoundaryStubs } from './tribal-fixtures';
import { installMinimapAnalysisStubs } from './minimap-fixtures';

test('D3 sidebar identity keeps its About door and uses the adopted stacked wordmark', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page, '?view=console&flow=off');
  const button = page.getByRole('button', { name: 'About ATNI Climate', exact: true });
  await expect(button).toHaveAttribute('popovertarget', 'about-atni');
  const mark = button.locator('.atni-wordmark');
  await expect(mark.locator(':scope > span')).toHaveText(['ATNI', 'CLIMATE']);
  await expect(mark).toHaveCSS('font-family', '"Spartan MB", sans-serif');
  await expect(mark).toHaveCSS('font-weight', '800');
  await expect(mark).toHaveCSS('background-color', 'rgb(1, 11, 19)');
  await expect(mark.locator(':scope > span').first()).toHaveCSS('color', 'rgb(255, 255, 255)');
  await expect(mark.locator('.atni-wordmark-climate')).toHaveCSS('color', 'rgb(225, 61, 51)');
  expect(await mark.evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(32);
  await button.focus();
  await page.keyboard.press('Enter');
  const about = page.locator('#about-atni');
  await expect(about).toBeVisible();
  const seal = about.locator('.about-seal');
  const aboutLink = about.locator('a[href]').first();
  await expect(aboutLink).toHaveCSS('color', 'rgb(176, 40, 33)');
  await expect(aboutLink).toHaveCSS('text-decoration-line', 'underline');
  await aboutLink.hover();
  await expect(aboutLink).toHaveCSS('color', 'rgb(140, 31, 25)');
  await expect(seal).toHaveAttribute('srcset', /atni-seal-on-dark-128\.png 2x$/);
  await expect(seal).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(seal).toHaveCSS('width', '64px');
  await expect.poll(() => seal.evaluate(node => {
    const image = node as HTMLImageElement;
    return image.complete && image.naturalWidth > 0;
  })).toBe(true);
  await page.keyboard.press('Escape');
  await expect(about).toBeHidden();
  await expect(button).toBeFocused();
  for (const width of [1280, 820]) {
    await page.setViewportSize({ width, height: 900 });
    const fits = await page.locator('.brand-text').evaluate(node => {
      const seat = node.getBoundingClientRect();
      return [...node.querySelectorAll('h1, p')].every(element => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return [...range.getClientRects()].every(rect => rect.left >= seat.left - 1 && rect.right <= seat.right + 1);
      });
    });
    expect(fits, 'all title and subtitle words fit the wider wordmark header').toBe(true);
  }
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', /\/brand\/atni-seal\.png$/);
});

for (const width of [400, 200]) {
test('D3 embed wordmark preserves its full-site link at ' + width, async ({ page }) => {
  await page.setViewportSize({ width, height: 600 });
  await gotoApp(page, '?embed=true&flow=off');
  const door = page.locator('.embed-brand');
  await expect(door).toHaveAccessibleName('Open the full Dynamic Drought Module by ATNI Climate');
  await expect(door).toHaveAttribute('href', 'https://atniclimate.github.io/dynamic-drought-module/');
  await expect(door.locator('.atni-wordmark > span')).toHaveText(['ATNI', 'CLIMATE']);
  await expect(door).toHaveCSS('background-color', 'rgb(1, 11, 19)');
  expect(await door.locator('.atni-wordmark').evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(32);
  expect(await door.evaluate(node => {
    const rect = node.getBoundingClientRect();
    return rect.left >= 0 && rect.right <= innerWidth && node.scrollWidth <= node.clientWidth;
  })).toBe(true);
});
}

/**
 * Self-hosted fonts: the stewardship rule made enforceable.
 *
 * The brand fonts (Spartan MB, DDM Heros) are served from public/fonts/,
 * not from Google Fonts; a third-party font request would leak the user's
 * IP address and the embedding page URL to Google on every load, against
 * the project's no-tracking stewardship rule (the module observes the
 * landscape for the user; it does not
 * report on them). This spec pins both halves of the guarantee: the fonts
 * really load (no silent fallback to system-ui), and no request reaches a
 * font CDN. Deterministic: same-origin fetches only, no live agency data.
 */
test.describe('self-hosted fonts', () => {
  test('brand fonts load from same-origin and no request reaches a font CDN', async ({ page }) => {
    const fontCdnRequests: string[] = [];
    const woff2Requests: string[] = [];
    page.on('request', (req) => {
      const url = req.url();
      if (/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(url)) fontCdnRequests.push(url);
      if (url.split('?')[0]!.endsWith('.woff2')) woff2Requests.push(url);
    });

    await gotoApp(page);

    // Force both families to resolve, then confirm they actually loaded
    // (document.fonts.load resolves with the matched FontFace entries; an
    // empty match would mean the @font-face declarations are gone and text
    // is silently falling back to system-ui).
    const loaded = await page.evaluate(async () => {
      const faces = await Promise.all([
        ...[600, 700, 800].map(weight => document.fonts.load(`${weight} 16px "Spartan MB"`, 'Drought')),
        ...[400, 700].map(weight => document.fonts.load(`${weight} 16px "DDM Heros"`, 'Drought')),
      ]);
      return faces.map(face => face.length);
    });
    expect(loaded).toHaveLength(5);
    for (const count of loaded) expect(count, 'an adopted face did not load').toBeGreaterThan(0);

    // Every font file fetched came from our own origin at the base subpath.
    expect(woff2Requests.length, 'no font files were fetched at all').toBeGreaterThan(0);
    for (const url of woff2Requests) {
      expect(url).toContain('/fonts/');
      expect(new URL(url).origin).toBe(new URL(page.url()).origin);
    }

    // The privacy guarantee itself: nothing left for a font CDN.
    expect(fontCdnRequests, 'a request escaped to a font CDN').toHaveLength(0);
  });
});

test('adopted font stacks keep orthography lazy and shape complete clusters with a web font', async ({ page, context }) => {
  await gotoApp(page);
  // Use the built app stylesheet without its application DOM or scripts. This
  // isolates lazy typography behavior; application first paint is a separate gate.
  const styles = await page.locator('link[rel="stylesheet"]').evaluateAll(links =>
    links.map(link => (link as HTMLLinkElement).href));
  expect(styles.length).toBeGreaterThan(0);
  const specimen = await context.newPage();
  await installBoundaryStubs(specimen);
  await installMinimapAnalysisStubs(specimen);
  const requests: string[] = [];
  specimen.on('request', request => {
    if (request.url().split('?')[0]!.endsWith('.woff2')) requests.push(request.url());
  });
  const specimenUrl = new URL('__font-contract.html', page.url()).href;
  await specimen.route(specimenUrl, route => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><head>${styles.map(href => `<link rel="stylesheet" href="${href}">`).join('')}</head><body><span id="display" style="font-family:var(--font-display);font-weight:700">Drought</span><span id="body" style="font-family:var(--font-body);font-weight:400">Drought 0123456789</span></body></html>`,
  }));
  try {
    await specimen.goto(specimenUrl);
    await specimen.evaluate(() => document.fonts.ready);
    expect(requests.some(url => /ddm-orthography-fallback\.woff2/.test(url))).toBe(false);
    expect(requests.some(url => /lexend-latin|league-spartan-latin-ext/.test(url))).toBe(false);
    const typography = await specimen.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return {
        display: getComputedStyle(document.querySelector('#display')!).fontFamily,
        body: getComputedStyle(document.querySelector('#body')!).fontFamily,
        synthesis: getComputedStyle(document.querySelector('#body')!).fontSynthesis,
        weights: ['--fw-title', '--fw-subtitle', '--fw-body', '--fw-strong'].map(token => style.getPropertyValue(token).trim()),
      };
    });
    expect(typography.display).toMatch(/^"?Spartan MB"?,/);
    expect(typography.body).toMatch(/^"?DDM Heros"?,/);
    expect(typography.synthesis).toBe('none');
    expect(typography.weights).toEqual(['700', '600', '400', '700']);
    // CDP reports fonts used for glyphs, unlike getComputedStyle, which only
    // reports the requested stack. No local system font can satisfy this proof.
    const cdp = await context.newCDPSession(specimen);
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    for (const id of ['display', 'body']) {
      for (const text of ['\u0294', '\u02b7', 'k\u0313', '\u1e35\u0313', 'k\u0331\u0313']) {
        await specimen.locator(`#${id}`).evaluate((element, value) => {
          element.textContent = value;
          element.getBoundingClientRect(); // Trigger font selection before awaiting FontFaceSet.ready.
        }, text);
        await specimen.evaluate(async () => { await document.fonts.ready; await new Promise(requestAnimationFrame); });
        const { root: documentNode } = await cdp.send('DOM.getDocument');
        const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: documentNode.nodeId, selector: `#${id}` });
        const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
        const used = fonts.filter(font => font.glyphCount > 0);
        expect(used.length, `${id}: ${text}`).toBeGreaterThan(0);
        expect(used.every(font => font.isCustomFont && font.familyName === 'DDM Orthography Fallback'), `${id}: ${text}: ${JSON.stringify(used)}`).toBe(true);
      }
    }
    expect(requests.some(url => /ddm-orthography-fallback\.woff2/.test(url))).toBe(true);
    for (const url of requests) expect(new URL(url).origin).toBe(new URL(specimenUrl).origin);
    await cdp.detach();
  } finally {
    await specimen.close();
  }
});
