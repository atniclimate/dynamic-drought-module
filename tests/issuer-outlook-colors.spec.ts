import { expect, test } from './offline-test';
import { gotoApp, layerPill, stubSpcFireOutlook } from './helpers';

type OutlookMap = {
  getContainer(): HTMLElement;
  getPaintProperty(layer: string, property: string): unknown;
  getImage(id: string): {
    pixelRatio: number;
    data: { width: number; height: number; data: Uint8Array };
  } | undefined;
  queryRenderedFeatures(options: { layers: string[] }): Array<{ properties: Record<string, unknown> }>;
};
type OutlookWindow = Window & { __issuerOutlookMaps: OutlookMap[] };

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const maps: OutlookMap[] = [];
    (window as unknown as OutlookWindow).__issuerOutlookMaps = maps;
    Object.defineProperty(Object.prototype, '_onWindowOnline', {
      configurable: true,
      set(this: OutlookMap, value: unknown) {
        Object.defineProperty(this, '_onWindowOnline', {
          configurable: true, enumerable: true, writable: true, value
        });
        maps.push(this);
      }
    });
  });
});


test('R8 USDM change map and both keys use eleven signed issuer classes', async ({ page }) => {
  const expected: Array<[number, string]> = [[-5,"#003D75"],[-4,"#016678"],[-3,"#359766"],[-2,"#8AD48C"],[-1,"#CCFFD4"],[0,"#CCCCCC"],[1,"#FFFF73"],[2,"#FFD438"],[3,"#FF9900"],[4,"#A87000"],[5,"#543005"]];
  const labels = ["Improved 5 categories","Improved 4 categories","Improved 3 categories","Improved 2 categories","Improved 1 category","No category change","Worsened 1 category","Worsened 2 categories","Worsened 3 categories","Worsened 4 categories","Worsened 5 categories"];
  const features = expected.map(([dn], i) => {
    const west = -122.8 + (i % 6) * .32;
    const south = 46.7 + Math.floor(i / 6) * .45;
    return { type: 'Feature', properties: { DN: dn }, geometry: {
      type: 'Polygon', coordinates: [[[west,south],[west+.24,south],
        [west+.24,south+.3],[west,south+.3],[west,south]]]
    }};
  });
  await page.route('**/USDM_current/**', route => route.fulfill({
    contentType: 'application/geo+json',
    body: JSON.stringify({ type:'FeatureCollection', features: [{
      ...features[0], properties: { DM: 2, MapDate: Date.UTC(2026,5,30) }
    }] })
  }));
  await page.route('**/*usdm*change.geojson', route => route.fulfill({
    contentType: 'application/geo+json',
    body: JSON.stringify({ type: 'FeatureCollection', date: '20260630', features })
  }));
  await gotoApp(page, '?region=washington_state&view=console&layers=usdm');
  await expect(layerPill(page, 'usdm')).toHaveText('live');
  for (const mode of ['chg1', 'chg4']) {
    await page.locator('#time-bar [data-mode="' + mode + '"]').click();
    await expect.poll(() => page.evaluate(() => {
      const map = (window as unknown as OutlookWindow).__issuerOutlookMaps.find(m => m.getContainer().id === 'map');
      try { return [...new Set(map?.queryRenderedFeatures({ layers: ['usdm-change-fill'] })
        .map(f => f.properties.DN) ?? [])].sort((a,b) => Number(a)-Number(b)); }
      catch { return []; }
    })).toEqual(expected.map(([dn]) => dn));
    const paint = await page.evaluate(() => {
      const map = (window as unknown as OutlookWindow).__issuerOutlookMaps.find(m => m.getContainer().id === 'map')!;
      return { expression: map.getPaintProperty('usdm-change-fill','fill-color'),
        opacity: map.getPaintProperty('usdm-change-fill','fill-opacity') };
    });
    expect(paint.expression).toEqual(['match',['get','DN'],...expected.flat(),'rgba(0,0,0,0)']);
    expect(paint.opacity).toBe(.54);
    const rgb = expected.map(([,hex]) => {
      const bytes = [1,3,5].map(i => parseInt(hex.slice(i,i+2),16));
      return 'rgb(' + bytes.join(', ') + ')';
    });
    const sidebar = page.locator('[data-legend="usdm"]');
    await expect(sidebar.locator('li')).toHaveText(labels);
    expect(await sidebar.locator('.swatch').evaluateAll(nodes => nodes.map(n => getComputedStyle(n).backgroundColor))).toEqual(rgb);
    await expect(page.locator('#map-key-legend .map-key-item')).toHaveText(labels);
    expect(await page.locator('#map-key-legend .map-key-swatch').evaluateAll(nodes =>
      nodes.map(n => getComputedStyle(n).backgroundColor))).toEqual(rgb);
  }
  await page.locator('#time-bar [data-mode="absolute"]').click();
  await expect(page.locator('#map-key-legend .map-key-item')).toHaveText(['No polygon', 'D0', 'D1', 'D2', 'D3', 'D4']);
  await expect(page.locator('#map-key-legend .map-key-label')).toHaveText('Drought');
});

for (const seat of [
  { name: 'desktop', width: 1440, height: 900, embed: false },
  { name: 'phone', width: 390, height: 844, embed: false },
  { name: 'embed document', width: 200, height: 600, embed: true }
] as const) test('R8 visible signed key and absolute restoration: ' + seat.name, async ({ page }) => {
  await page.setViewportSize({ width: seat.width, height: seat.height });
  const labels = ['Improved 5 categories', 'Improved 4 categories', 'Improved 3 categories',
    'Improved 2 categories', 'Improved 1 category', 'No category change',
    'Worsened 1 category', 'Worsened 2 categories', 'Worsened 3 categories',
    'Worsened 4 categories', 'Worsened 5 categories'];
  const geometry = { type: 'Polygon', coordinates: [[[-123,46],[-120,46],[-120,48],[-123,48],[-123,46]]] };
  await page.route('**/USDM_current/**', route => route.fulfill({
    contentType: 'application/geo+json', body: JSON.stringify({ type: 'FeatureCollection', features: [
      { type: 'Feature', geometry, properties: { DM: 2, MapDate: Date.UTC(2026,5,30) } }
    ] })
  }));
  await page.route('**/*usdm*change.geojson', route => route.fulfill({
    contentType: 'application/geo+json', body: JSON.stringify({ type: 'FeatureCollection', date: '20260630', features: [
      { type: 'Feature', geometry, properties: { DN: -5 } }
    ] })
  }));
  // URL-as-state boots are necessary for the embed, which has no mode control.
  // The existing R8 case separately preserves native desktop mode switching.
  for (const mode of ['chg1', 'chg4', 'absolute']) {
    await gotoApp(page, '?region=washington_state&view=console&layers=usdm' +
      (seat.embed ? '&embed=true' : '') + (mode === 'absolute' ? '' : '&dmode=' + mode));
    const toggle = page.locator('#map-key-details-toggle');
    await expect(toggle).toBeVisible();
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#map-key-content')).toBeVisible();
    const items = page.locator('#map-key-legend .map-key-item');
    const expected = mode === 'absolute' ? ['No polygon', 'D0', 'D1', 'D2', 'D3', 'D4'] : labels;
    await expect(items).toHaveText(expected);
    await expect(page.locator('#map-key-legend .map-key-label')).toHaveText(mode === 'absolute'
      ? 'Drought' : 'Drought change key (' + (mode === 'chg4' ? '4-week' : '1-week') + ')');
    expect(new URL(page.url()).searchParams.get('dmode')).toBe(mode === 'absolute' ? null : mode);
    for (let i = 0; i < expected.length; i++) {
      const item = items.nth(i);
      await expect(item).toBeVisible();
      // Inspect actual clipping ancestors, then use physical wheel input when
      // the bounded drawer scrolls. Every row must be reachable and readable.
      await expect.poll(async () => {
        const fit = await item.evaluate(element => {
          const box = element.getBoundingClientRect();
          let left = 0, right = innerWidth, top = 0, bottom = innerHeight;
          for (let p = element.parentElement; p; p = p.parentElement) {
            const css = getComputedStyle(p), r = p.getBoundingClientRect();
            if (/auto|scroll|hidden|clip/.test(css.overflowX)) { left = Math.max(left, r.left); right = Math.min(right, r.right); }
            if (/auto|scroll|hidden|clip/.test(css.overflowY)) { top = Math.max(top, r.top); bottom = Math.min(bottom, r.bottom); }
          }
          const range = document.createRange(); range.selectNodeContents(element);
          const text = [...range.getClientRects()];
          return { left, right, top, bottom, rowTop: box.top, rowBottom: box.bottom,
            horizontal: element.scrollWidth <= element.clientWidth + 1 && box.left >= left - 1 && box.right <= right + 1 &&
              text.every(r => r.left >= left - 1 && r.right <= right + 1),
            vertical: box.top >= top - 1 && box.bottom <= bottom + 1 };
        });
        if (!fit.vertical && fit.bottom > fit.top && fit.right > fit.left) {
          await page.mouse.move((fit.left + fit.right) / 2, (fit.top + fit.bottom) / 2);
          await page.mouse.wheel(0, fit.rowBottom > fit.bottom ? 48 : -48);
        }
        return fit.horizontal && fit.vertical;
      }, { message: seat.name + ' ' + mode + ': readable bounded row ' + expected[i] }).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(seat.width);
    // Native close stays reachable after scrolling through the whole key.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  }
});
function polygon(index: number, properties: Record<string, unknown>) {
  const west = -123.7 + index * 1.35;
  return {
    type: 'Feature',
    properties,
    geometry: { type: 'Polygon', coordinates: [[
      [west, 46], [west + 1, 46], [west + 1, 48], [west, 48], [west, 46]
    ]] }
  };
}

test('D3 S7 SPC three rendered classes retain exact issuer map and key colors', async ({ page }) => {
  await stubSpcFireOutlook(page, { 1: [5, 8, 10].map((dn, index) =>
    polygon(index, { dn, valid: '202610071200', expire: '202610081200' })) });
  await gotoApp(page, '?embed=true&region=washington_state&layers=spc-fire-weather');
  await expect(layerPill(page, 'spc-fire-weather')).toHaveText('live');
  await page.locator('#map-key-details-toggle').click();
  await expect.poll(() => page.evaluate(() => {
    const map = (window as unknown as OutlookWindow).__issuerOutlookMaps.find(m => m.getContainer().id === 'map');
    return [...new Set(map?.queryRenderedFeatures({ layers: ['spc-fire-weather-fill'] })
      .map(f => f.properties.dn) ?? [])].sort((a, b) => Number(a) - Number(b));
  })).toEqual([5, 8, 10]);
  const paints = await page.evaluate(() => {
    const map = (window as unknown as OutlookWindow).__issuerOutlookMaps.find(m => m.getContainer().id === 'map')!;
    return {
      fill: map.getPaintProperty('spc-fire-weather-fill', 'fill-color'),
      outline: map.getPaintProperty('spc-fire-weather-outline', 'line-color'),
      fillOpacity: map.getPaintProperty('spc-fire-weather-fill', 'fill-opacity'),
      lineOpacity: map.getPaintProperty('spc-fire-weather-outline', 'line-opacity')
    };
  });
  const expected = ['match', ['get', 'dn'], 5, '#e69800', 8, '#FF0000', 10, '#E600A9', '#9ca3af'];
  expect(paints.fill).toEqual(expected);
  expect(paints.outline).toEqual(expected);
  expect(paints.fillOpacity).toBe(0.3);
  expect(paints.lineOpacity).toBe(0.9);
  const key = page.locator('[data-spc-fire-weather-key]');
  await expect(key).toContainText('Extremely Critical');
  expect(await key.locator('.map-key-swatch').evaluateAll(nodes =>
    nodes.map(n => getComputedStyle(n).backgroundColor))).toEqual([
    'rgb(230, 152, 0)', 'rgb(255, 0, 0)', 'rgb(230, 0, 169)'
  ]);
});

for (const range of ['monthly', 'seasonal'] as const) {
  test('D3 S8 CPC ' + range + ' four rendered classes retain issuer hatch and legend colors', async ({ page }) => {
    const classes = ['Persistence', 'Development', 'Improvement', 'Removal', 'No_Drought'];
    const requestedLayers: string[] = [];
    await page.route('**/cpc_drought_outlk/MapServer/*/query?*', route => {
      const path = new URL(route.request().url()).pathname;
      requestedLayers.push(/\/MapServer\/(\d+)\/query$/.exec(path)?.[1] ?? path);
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ type: 'FeatureCollection', features: classes.map((outlook, index) =>
          polygon(index, { outlook, fcst_date: '10/01/2026', target: 'December 31' })) })
      });
    });
    await gotoApp(page, '?embed=true&region=washington_state&layers=drought&outlook=' + range);
    await expect(layerPill(page, 'drought')).toHaveText('live');
    await expect.poll(() => page.evaluate(() => {
      const map = (window as unknown as OutlookWindow).__issuerOutlookMaps.find(m => m.getContainer().id === 'map');
      return [...new Set(map?.queryRenderedFeatures({ layers: ['drought-outlook-fill'] })
        .map(f => f.properties.outlook) ?? [])].sort();
    })).toEqual(['Development', 'Improvement', 'Persistence', 'Removal']);
    expect(requestedLayers).toContain(range === 'monthly' ? '1' : '4');
    // Read the images registered by the real adapter, not reconstructed fixture tiles.
    const hatchImages = await page.evaluate(() => {
      const map = (window as unknown as OutlookWindow).__issuerOutlookMaps.find(m => m.getContainer().id === 'map')!;
      return ['persists', 'develops', 'improves', 'removal'].map(cls => {
        const image = map.getImage('outlook-hatch-' + cls);
        if (!image) return null;
        const { width, height, data } = image.data;
        const coreColors: number[][] = [];
        let gaps = 0;
        let singleStrokePixels = 0;
        let maximumAlpha = 0;
        for (let i = 0; i < data.length; i += 4) {
          const alpha = data[i + 3]!;
          if (alpha === 0) gaps++;
          if (Math.abs(alpha - 153) <= 1) singleStrokePixels++;
          maximumAlpha = Math.max(maximumAlpha, alpha);
          // Ignore faint antialiased edges where unpremultiplication amplifies rounding.
          if (alpha >= 128) coreColors.push([data[i]!, data[i + 1]!, data[i + 2]!]);
        }
        return { cls, width, height, pixelRatio: image.pixelRatio, gaps,
          singleStrokePixels, maximumAlpha, coreColors };
      });
    });
    const issuerInk = [[155, 99, 74], [255, 222, 99], [222, 212, 188], [178, 173, 105]];
    hatchImages.forEach((image, index) => {
      expect(image, 'registered class image').not.toBeNull();
      if (!image) throw new Error('Missing registered CPC hatch');
      expect([image.width, image.height, image.pixelRatio]).toEqual([36, 36, 2]);
      expect(image.gaps, image.cls + ' transparent ground').toBeGreaterThan(0);
      expect(image.singleStrokePixels, image.cls + ' 0.6-alpha ink').toBeGreaterThan(0);
      expect(image.coreColors.length, image.cls + ' positive ink').toBeGreaterThan(0);
      // Two fully covered strokes would reach 0.84. Antialiased intersections
      // can cover only part of a pixel, so this is a ceiling, not an exact value.
      if (image.cls === 'develops') {
        expect(image.maximumAlpha, 'overlapping crosshatch ink').toBeGreaterThan(154);
        expect(image.maximumAlpha, 'two-stroke alpha ceiling').toBeLessThanOrEqual(215);
      } else {
        expect(Math.abs(image.maximumAlpha - 153), image.cls + ' single stroke').toBeLessThanOrEqual(1);
      }
      for (const rgb of image.coreColors) {
        rgb.forEach((channel, component) => {
          expect(Math.abs(channel - issuerInk[index]![component]!)).toBeLessThanOrEqual(2);
        });
      }
    });
    const paints = await page.evaluate(() => {
      const map = (window as unknown as OutlookWindow).__issuerOutlookMaps.find(m => m.getContainer().id === 'map')!;
      return {
        outline: map.getPaintProperty('drought-outlook-outline', 'line-color'),
        pattern: map.getPaintProperty('drought-outlook-fill', 'fill-pattern'),
        opacity: map.getPaintProperty('drought-outlook-fill', 'fill-opacity')
      };
    });
    expect(paints.outline).toEqual(['match', ['get', 'outlook'],
      'Persistence', '#9B634A', 'Development', '#FFDE63',
      'Improvement', '#DED4BC', 'Removal', '#B2AD69', 'rgba(0,0,0,0)']);
    expect(paints.pattern).toEqual(['match', ['get', 'outlook'],
      'Persistence', 'outlook-hatch-persists', 'Development', 'outlook-hatch-develops',
      'Improvement', 'outlook-hatch-improves', 'Removal', 'outlook-hatch-removal', '']);
    expect(paints.opacity).toBe(1);
    expect(await page.locator('[data-legend="drought"] .swatch').evaluateAll(nodes =>
      nodes.map(n => getComputedStyle(n).backgroundColor))).toEqual([
      'rgb(155, 99, 74)', 'rgb(255, 222, 99)', 'rgb(222, 212, 188)', 'rgb(178, 173, 105)'
    ]);
  });
}
