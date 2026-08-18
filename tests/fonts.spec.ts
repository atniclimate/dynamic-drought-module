import { test, expect } from '@playwright/test';
import { gotoApp } from './helpers';

/**
 * Self-hosted fonts: the stewardship rule made enforceable.
 *
 * The brand fonts (League Spartan, Lexend) are served from public/fonts/,
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
      const spartan = await document.fonts.load('600 16px "League Spartan"', 'Drought');
      const lexend = await document.fonts.load('400 16px Lexend', 'Drought');
      return { spartan: spartan.length, lexend: lexend.length };
    });
    expect(loaded.spartan, 'League Spartan did not load').toBeGreaterThan(0);
    expect(loaded.lexend, 'Lexend did not load').toBeGreaterThan(0);

    // Every font file fetched came from our own origin at the base subpath.
    expect(woff2Requests.length, 'no font files were fetched at all').toBeGreaterThan(0);
    for (const url of woff2Requests) {
      expect(url).toContain('/fonts/');
    }

    // The privacy guarantee itself: nothing left for a font CDN.
    expect(fontCdnRequests, 'a request escaped to a font CDN').toHaveLength(0);
  });
});
