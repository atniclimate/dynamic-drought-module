import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

/**
 * Audit round 5, ENSO lane: the CPC outlooks ENSO draws at Weeks ahead and
 * Season ahead are named in the on-map key (R5-29), and Technical information
 * says what DR-019 bound them to say (R5-30).
 *
 * Runs under plain `node --test` (Node 24 strips types); the resolve hook
 * maps the sources' extensionless relative imports to their .ts files.
 */

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith('.') &&
      !/\.[a-z]+$/i.test(specifier) &&
      typeof context.parentURL === 'string' &&
      context.parentURL.endsWith('.ts')
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  }
});

const { cpcOutlookRows } = await import('../src/ui/map-key.ts');
const { CPC_EXTENDED_COLORS, CPC_SEASONAL_COLORS } = await import('../src/config/palette.ts');
const { HAZARD_CLUSTERS } = await import('../src/config/clusters.ts');
const { renderMapTechnicalInformation } = await import('../src/ui/map-technical-information.ts');

const rowLabels = (html, key) => {
  const row = new RegExp(`<span class="map-key-scale" data-cpc-key="${key}">(.*?)<span class="map-key-item">NOAA Climate Prediction Center</span></span>`).exec(html);
  assert.ok(row, `a key row for ${key}`);
  return [...row[1].matchAll(/<span class="map-key-swatch" style="background:([^"]+)"><\/span>([^<]+)<\/span>/g)].map((m) => [m[1], m[2]]);
};
const swatches = (rows) => rows.filter((row) => row.color[3] > 0).map(({ label, color: [r, g, b] }) => [`rgb(${r},${g},${b})`, label]);

test('every CPC outlook an ENSO horizon or option can draw has a key row with its renderer classes', () => {
  const enso = HAZARD_CLUSTERS.enso;
  const outlooks = [...new Set([...Object.values(enso.recipes).flat(), ...enso.optionalLayers])].filter((key) => key.startsWith('cpc-'));
  assert.ok(outlooks.includes('cpc-seasonal-precip') && outlooks.includes('cpc-814-precip'));
  const { html, ariaLabel } = cpcOutlookRows((key) => outlooks.includes(key));
  for (const key of outlooks) assert.ok(html.includes(`data-cpc-key="${key}"`), key);
  // Equal Chances is drawn clear, so the seasonal row has no swatch for it.
  assert.deepEqual(rowLabels(html, 'cpc-seasonal-precip'), swatches(CPC_SEASONAL_COLORS.precipitation));
  assert.ok(!rowLabels(html, 'cpc-seasonal-precip').some(([, label]) => label === 'Equal Chances'));
  assert.deepEqual(rowLabels(html, 'cpc-814-precip'), swatches(CPC_EXTENDED_COLORS.precipitation));
  assert.match(html, /<strong class="map-key-scale-label">Seasonal Precipitation Outlook<\/strong>/);
  assert.match(ariaLabel, /NOAA Climate Prediction Center 8-14 Day Precipitation Outlook key, Above, 90%.*An outlook is a shift in odds, not an observed condition\./);
});

test('an outlook that is not drawn has no key row', () => {
  assert.deepEqual(cpcOutlookRows(() => false), { html: '', ariaLabel: '' });
  const { html } = cpcOutlookRows((key) => key === 'cpc-seasonal-precip');
  assert.equal([...html.matchAll(/data-cpc-key=/g)].length, 1);
});

test('Technical information states DR-019: the Season ahead outlooks are CPC seasonal outlooks that ENSO informs, not an ENSO forecast', () => {
  const html = renderMapTechnicalInformation();
  const heading = '<h4>ENSO</h4>';
  const section = html.slice(html.indexOf(heading), html.indexOf('<h4>', html.indexOf(heading) + heading.length));
  assert.ok(section.includes('<p>At Season ahead the outlooks drawn are NOAA Climate Prediction Center seasonal outlooks that ENSO informs, not an ENSO forecast.</p>'));
  // The current-conditions sentence holds at Current only.
  assert.ok(section.includes('<p>At Current the map shows current conditions.</p>'));
  assert.ok(!section.includes('<p>The map shows current conditions.</p>'));
});
