import { test, expect } from '@playwright/test';

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { gotoApp, layerCheckbox, waitForLayerSettled } from './helpers';
import {
  MAP_MIN_ZOOM,
  REGIONS,
  zoomToFitLongitudeSpan
} from '../src/config/regions';

/**
 * U4a: the whole-US zoom-out (D-0.7.0-018 item 5).
 *
 * The corpus flagged DEFAULT_MIN_ZOOM = 5 as a release blocker: the
 * national framing's bounds fit at roughly zoom 2-4 depending on viewport,
 * and fitBounds clamps to the floor, cropping the frame. The floor now
 * lives in src/config/regions.ts as MAP_MIN_ZOOM, and this spec pins the
 * ACCEPTANCE CRITERION in Node with the same arithmetic MapLibre uses
 * (512 px world at zoom 0): fitting the padded national longitude span
 * must not clamp at ANY fixture viewport, including the narrowest phone.
 *
 * A Node test rather than a browser drive because the production build
 * exposes no map handle (the u3i pattern); the rendered whole-US framing
 * is stage-5 screenshot-matrix evidence.
 */

const FIXTURE_WIDTHS_PX = [1440, 800, 390, 400] as const;

/** The production fit applies 20 CSS px of screen padding per side
 * (sidebar.ts fitBounds `padding: 20`), which shrinks the usable width;
 * the arithmetic must model it or the margin is overstated (the stage-5
 * adversarial medium 11). */
const FIT_SCREEN_PADDING_PX = 20;

test.describe('U4a: the whole-US zoom floor invariant', () => {
  test('the national framing fits above MAP_MIN_ZOOM at every fixture width', () => {
    const national = REGIONS.national;
    const [[, west], [, east]] = national.bounds;
    // The region fit applies its padding in degrees on each side.
    const paddedSpan = east - west + 2 * national.padding;

    for (const width of FIXTURE_WIDTHS_PX) {
      const usable = width - 2 * FIT_SCREEN_PADDING_PX;
      const zoomNeeded = zoomToFitLongitudeSpan(paddedSpan, usable);
      expect(
        MAP_MIN_ZOOM,
        `national span ${paddedSpan.toFixed(1)} deg needs zoom ` +
          `${zoomNeeded.toFixed(2)} in ${usable}px usable; the floor must sit at or below it`
      ).toBeLessThanOrEqual(zoomNeeded);
    }
  });

  test('the floor stays a floor: no region fit targets a zoom below it', () => {
    // Lowering the floor must never be compensated by raising it later in a
    // way that re-clamps a framing. The NARROWEST fixture is the binding
    // case (fitting the same span in fewer pixels means a lower zoom), so
    // every shipped region is checked at every fixture width, padding
    // modeled; the floor binds nothing.
    for (const [key, region] of Object.entries(REGIONS)) {
      const [[, west], [, east]] = region.bounds;
      const paddedSpan = east - west + 2 * region.padding;
      for (const width of FIXTURE_WIDTHS_PX) {
        const usable = width - 2 * FIT_SCREEN_PADDING_PX;
        const zoomNeeded = zoomToFitLongitudeSpan(paddedSpan, usable);
        expect(
          zoomNeeded,
          `region ${key} would clamp at the ${width}px fixture`
        ).toBeGreaterThanOrEqual(MAP_MIN_ZOOM);
      }
    }
  });
});

/**
 * U4c: states as default-on chrome MUST NOT cost the click surface (the
 * plan-attack major 3). The transparent fill is the click-to-briefing
 * target for the fourth selectable space; restyling the outline as
 * zoom-interpolated chrome and flipping defaultOn leaves that behavior
 * intact, and this spec pins it: with the default view over Washington,
 * clicking the map opens the state briefing.
 */
test.describe('U4c: state boundaries as chrome keep the click surface', () => {
  test('a state click still opens the impact briefing after the chrome restyle', async ({
    page
  }) => {
    await gotoApp(page, '?view=console');

    // States is default-on since U4c; the bundled GeoJSON settles fast.
    await waitForLayerSettled(page, 'states');

    const map = page.locator('#map');
    const box = await map.boundingBox();
    if (!box) throw new Error('map container has no box');

    // Console clicks open the boundary popup first; the briefing is the
    // popup's explicit trigger (the two-doors contract), so the popup
    // appearing IS the click surface working. A click that lands while the
    // region-fit camera is still easing can be consumed as a camera
    // interaction (no idle handle is exposed by design), so the drive
    // retries the click exactly as a person would.
    const trigger = page.locator('[data-ddm-impact-trigger]');
    await expect(async () => {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await expect(trigger).toBeVisible({ timeout: 1500 });
    }).toPass({ timeout: 20_000 });
    await trigger.click();

    const panel = page.locator('#impact-panel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('#impact-panel-title')).toHaveText('Washington');
  });
});

/**
 * U4e: municipal place labels. The build script's glyph gate is re-asserted
 * here against the SHIPPED artifact (a hand-edited bundle must not dodge the
 * build-time check): every bundled name is NFC-normalized and every
 * codepoint falls inside a glyph range that actually ships, so no label can
 * silently fail to draw in production. The browser case pins the honest
 * toggle: the layer is off by default, reads live once on (bundled source,
 * no third-party request), and comes off cleanly.
 */
test.describe('U4e: municipal place labels', () => {
  test('the shipped bundle is NFC-clean and inside the shipped glyph ranges', () => {
    const bundle = JSON.parse(
      readFileSync(resolve(process.cwd(), 'public/data/us-places.json'), 'utf8')
    ) as { places: Array<{ name: string; rank: number }> };

    const ranges = readdirSync(
      resolve(process.cwd(), 'public/fonts/glyphs/Noto Sans Regular')
    )
      .filter((f) => f.endsWith('.pbf'))
      .map((f) => f.replace('.pbf', '').split('-').map(Number));

    expect(bundle.places.length).toBeGreaterThan(500);
    for (const p of bundle.places) {
      expect(p.name, `${p.name} is not NFC-normalized`).toBe(p.name.normalize('NFC'));
      expect(Number.isFinite(p.rank)).toBe(true);
      for (const ch of p.name) {
        const cp = ch.codePointAt(0)!;
        const covered = ranges.some(([lo, hi]) => cp >= lo && cp <= hi);
        expect(
          covered,
          `${p.name}: U+${cp.toString(16)} outside the shipped glyph ranges`
        ).toBe(true);
      }
    }
  });

  test('the labels toggle is off by default and honest when on', async ({ page }) => {
    await gotoApp(page, '?view=console');

    const checkbox = layerCheckbox(page, 'places');
    await expect(checkbox).not.toBeChecked();

    await checkbox.check();
    await waitForLayerSettled(page, 'places');
    await expect(page.locator('[data-layer-status="places"]')).toHaveText('live');

    await checkbox.uncheck();
    await expect(checkbox).not.toBeChecked();
  });
});

/**
 * Console cleanliness at boot (added after the 2026-07-12 review drive
 * caught a MapLibre style-validation error the suite had no way to see:
 * an invalid paint expression logs console.error and silently falls back).
 * A style or paint defect must fail CI, not wait for a human with
 * devtools open.
 */
test.describe('U4: the boot console is clean of style errors', () => {
  test('no console.error mentions a style, paint, or layers path at boot', async ({ page }) => {
    const styleErrors: string[] = [];
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const text = m.text();
      if (/layers\.|paint\.|layout\.|expression|style/i.test(text)) {
        styleErrors.push(text.slice(0, 300));
      }
    });

    await gotoApp(page, '?view=console');
    await waitForLayerSettled(page, 'states');
    // Exercise the toggled label layer too: its filter and paint validate
    // on addLayer, not at boot.
    await layerCheckbox(page, 'places').check();
    await waitForLayerSettled(page, 'places');

    expect(styleErrors, styleErrors.join('\n')).toHaveLength(0);
  });
});
