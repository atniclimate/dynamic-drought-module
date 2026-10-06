import { expect, test, type Page } from '@playwright/test';

import { gotoApp } from './helpers';

/**
 * Map labels load DDM's own fonts (found-039, taken early from D2).
 *
 * `src/map/style.ts` used to build the glyph template as
 * `${window.location.origin}${import.meta.env.BASE_URL}fonts/...`. With Vite
 * `base: './'` that is `http://127.0.0.1:4173./fonts/...` (a dot glued to the
 * host: "Failed to parse URL", 26 warnings a load, and not one .pbf request
 * left the page) and `https://atniclimate.github.io./fonts/...` on the live
 * site, so every label fell back to a locally rendered font. The template is
 * now an absolute same-origin URL under the deployed base.
 *
 * `layers=places` is the labelled boot: the bundled place labels are a symbol
 * layer with `text-font: ['Noto Sans Regular']`, which is the one fontstack
 * under `public/fonts/glyphs/`. The national default framing puts the rank-2
 * anchor cities in view, so the first symbol placement asks for a glyph range.
 *
 * No live network: the glyph .pbf files are DDM's own static files served by
 * the preview, and every other request a boot makes is stubbed by `gotoApp`.
 */

const SUBPATH = '/dynamic-drought-module';

interface GlyphProbe {
  readonly warnings: string[];
  readonly requests: string[];
  readonly responses: Array<{ url: string; status: number }>;
}

/** Collect glyph-range console messages and every glyph request and response. */
function probeGlyphs(page: Page): GlyphProbe {
  const probe: GlyphProbe = { warnings: [], requests: [], responses: [] };
  page.on('console', (message) => {
    if (message.type() !== 'warning' && message.type() !== 'error') return;
    const text = message.text();
    // MapLibre words a failed range "Unable to load glyph range <n>, <range>
    // ..."; the fetch failure it wraps names the glyph URL. Either shape counts.
    if (/glyph/i.test(text) || /fonts\/glyphs/i.test(text)) probe.warnings.push(text);
  });
  page.on('request', (request) => {
    if (/\/fonts\/glyphs\//.test(request.url())) probe.requests.push(request.url());
  });
  page.on('response', (response) => {
    if (/\/fonts\/glyphs\//.test(response.url())) {
      probe.responses.push({ url: response.url(), status: response.status() });
    }
  });
  return probe;
}

test.describe('glyphs', () => {
  test("a labelled boot loads a glyph range from DDM's own fonts with zero glyph-range warnings", async ({
    page
  }) => {
    const probe = probeGlyphs(page);

    await gotoApp(page, '?layers=places');

    // Red before the fix: no glyph request ever leaves the page (the template
    // does not parse as a URL), so this poll runs out and names the warnings.
    await expect
      .poll(() => probe.responses.length, {
        message:
          'a glyph .pbf was never requested; glyph warnings so far: ' +
          (probe.warnings.join(' | ') || '(none)')
      })
      .toBeGreaterThan(0);

    const first = new URL(probe.responses[0]!.url);
    expect(first.origin, 'the glyph range is DDM’s own, same origin').toBe(
      new URL(page.url()).origin
    );
    expect(first.hostname, 'no trailing dot on the host').not.toMatch(/\.$/);
    expect(first.pathname).toMatch(/^\/fonts\/glyphs\/Noto%20Sans%20Regular\/\d+-\d+\.pbf$/);

    for (const response of probe.responses) {
      expect(response.status, `GET ${response.url}`).toBe(200);
    }
    expect(probe.warnings, 'glyph-range warnings').toEqual([]);
  });

  test('the glyph template resolves under the deployed subpath', async ({ page }) => {
    // The GitHub Pages seat: the same artifact mounted beneath the repository
    // name (tests/deployment-subpath.spec.ts maps it the same way). A template
    // that ignores the page's own directory asks for `/fonts/glyphs/...` at the
    // origin root, which Pages answers 404.
    await page.route(`**${SUBPATH}/**`, async (route) => {
      const requested = new URL(route.request().url());
      const mountedPath = requested.pathname.slice(SUBPATH.length) || '/';
      const previewUrl = new URL(`${mountedPath}${requested.search}`, requested.origin);
      const response = await route.fetch({ url: previewUrl.href });
      await route.fulfill({ response });
    });
    const probe = probeGlyphs(page);

    await gotoApp(page, `${SUBPATH}/?layers=places`);
    expect(new URL(page.url()).pathname).toBe(`${SUBPATH}/`);

    await expect
      .poll(() => probe.responses.length, {
        message:
          'a glyph .pbf was never requested at the subpath; requests: ' +
          (probe.requests.join(' | ') || '(none)') +
          '; glyph warnings: ' +
          (probe.warnings.join(' | ') || '(none)')
      })
      .toBeGreaterThan(0);

    for (const response of probe.responses) {
      const url = new URL(response.url);
      expect(url.hostname, 'no trailing dot on the host').not.toMatch(/\.$/);
      expect(url.pathname).toMatch(
        /^\/dynamic-drought-module\/fonts\/glyphs\/Noto%20Sans%20Regular\/\d+-\d+\.pbf$/
      );
      expect(response.status, `GET ${response.url}`).toBe(200);
    }
    expect(probe.warnings, 'glyph-range warnings').toEqual([]);
  });
});
