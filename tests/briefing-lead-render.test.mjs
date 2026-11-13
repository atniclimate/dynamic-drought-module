import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The priority view of the Impact Briefing, executed (owner direction
 * 2026-11-09 (sprint), DR-pending): src/ui/briefing-lead.ts `renderLeadView`
 * and `buildEnsoChainLinks` run here on hand-built briefings, because the
 * sentences this view prints about a cell that was NOT fully read are claims
 * too, and reading the module as text cannot prove what it prints.
 *
 * What is proven here:
 *   1. "No source answered" is printed only for a settled cell that holds
 *      nothing and was given no words. A partly read cell (a source did
 *      answer) never wears it, and neither does a cell the matrix marked
 *      with an empty note (a lane answered with nothing to say);
 *   2. the Drought tile does not say "this week's map" (true only until the
 *      next release); the map's own date rides the source line;
 *   3. the "Present together" caption states no date of its own: each read
 *      carries its own clock;
 *   4. the briefing's chain relates the unread jet link to nothing.
 */

// Extensionless relative `.ts` imports, and the stylesheet the view imports
// for the browser (see tests/briefing-truth.test.mjs for the first half).
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.css')) {
      return { url: 'data:text/javascript,export default 0;', shortCircuit: true };
    }
    if (
      specifier.startsWith('.') &&
      !/\.[a-z]+$/i.test(specifier) &&
      typeof context.parentURL === 'string' &&
      context.parentURL.endsWith('.ts')
    ) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) {
        return nextResolve(`${specifier}.ts`, context);
      }
    }
    return nextResolve(specifier, context);
  }
});

const { renderLeadView, renderFocusHead, buildEnsoChainLinks } = await import('../src/ui/briefing-lead.ts');
const { HAZARD_KEYS, HORIZON_KEYS } = await import('../src/impact/matrix.ts');
const { POINT_HEAT_HAZARD } = await import('../src/impact/horizon-chrome.ts');

const NO_SOURCE = 'No source answered for this hazard at this horizon.';
const NOW = Date.UTC(2026, 10, 9, 20);

const cell = (hazard, horizon, status, claims = [], note) => ({
  hazard,
  horizon,
  status,
  claims,
  label: hazard,
  ...(note !== undefined ? { note } : {})
});

const usdmClaim = {
  text: 'This location is in D2 Severe drought as of the U.S. Drought Monitor map dated Oct 20, 2026.',
  source: 'U.S. Drought Monitor (NDMC / NOAA / USDA)',
  sourceUrl: 'https://droughtmonitor.unl.edu/',
  product: 'usdm',
  evidence: 'analyzed',
  kind: 'analysis',
  dates: { valid: '2026-10-20', retrieved: '2026-11-09' },
  reading: {
    kind: 'usdm-category',
    dm: 2,
    window: { from: Date.UTC(2026, 9, 20), to: Date.UTC(2026, 9, 27) }
  }
};

const nwsClaim = {
  text: 'A fire-weather alert is in effect here: Red Flag Warning.',
  source: 'NWS active alerts',
  sourceUrl: 'https://www.weather.gov/',
  product: 'nws-alerts',
  evidence: 'observed',
  kind: 'observation',
  dates: { retrieved: '2026-11-08' },
  hazards: ['fire'],
  reading: { kind: 'nws-products', events: ['Red Flag Warning'] }
};

/** A briefing whose every cell is in one state, to be overridden per case. */
function briefingOf(status, note) {
  const horizons = {};
  for (const horizon of HORIZON_KEYS) {
    const cells = {};
    for (const hazard of HAZARD_KEYS) cells[hazard] = cell(hazard, horizon, status, [], note);
    horizons[horizon] = { key: horizon, status, cells };
  }
  return { horizons, landTitle: 'Test place', landKind: '' };
}

const text = (html) =>
  html
    .replace(/<svg[\s\S]*?<\/svg>/g, ' [figure] ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const restRow = (html, hazard) =>
  text(
    new RegExp(`<li class="lead-rest-item" data-lead-hazard="${hazard}">[\\s\\S]*?</li>`).exec(html)?.[0] ?? ''
  );

test('a partly read cell never says no source answered', () => {
  const briefing = briefingOf('loading');
  // One lane answered (the weekly map), another is still in flight: the
  // matrix marks the cell live (partial) and gives it no note.
  briefing.horizons.current.cells.drought = cell('drought', 'current', 'partial', [usdmClaim]);
  const html = renderLeadView(briefing, NOW);
  const row = restRow(html, 'drought');
  assert.notEqual(row, '', 'the partly read hazard is listed under other reads and gaps');
  assert.match(row, /live \(partial\)/);
  assert.ok(!row.includes(NO_SOURCE), `a source did answer; the row said: ${row}`);
  assert.ok(text(html).includes('D2 Severe drought'), 'and its read is drawn as a tile');
});

test('a cell the matrix marked with an empty note states no absence sentence', () => {
  const briefing = briefingOf('loading');
  // Every lane settled; one answered in part with nothing to state. The
  // matrix sets note '' precisely to keep the absence sentence off the cell.
  briefing.horizons.nearTerm.cells.fire = cell('fire', 'nearTerm', 'unavailable', [], '');
  const row = restRow(renderLeadView(briefing, NOW), 'fire');
  assert.match(row, /unavailable/);
  assert.ok(!row.includes(NO_SOURCE), `the lane answered; the row said: ${row}`);
});

test('a settled cell with nothing and no words still says no source answered', () => {
  const briefing = briefingOf('loading');
  briefing.horizons.nearTerm.cells.fire = cell('fire', 'nearTerm', 'unavailable', []);
  const row = restRow(renderLeadView(briefing, NOW), 'fire');
  assert.ok(row.includes(NO_SOURCE), `the fallback keeps its one honest use; the row said: ${row}`);
});

test('a cell with its own note prints that note and nothing else', () => {
  const briefing = briefingOf('loading');
  briefing.horizons.current.cells.heat = cell('heat', 'current', 'unavailable', [], 'The heat service did not respond.');
  const row = restRow(renderLeadView(briefing, NOW), 'heat');
  assert.ok(row.includes('The heat service did not respond.'));
  assert.ok(!row.includes(NO_SOURCE));
});

test('the Drought tile names the weekly map and leaves the date to the source line', () => {
  const briefing = briefingOf('unavailable', 'not read in this fixture');
  briefing.horizons.current.cells.drought = cell('drought', 'current', 'ready', [usdmClaim]);
  const all = text(renderLeadView(briefing, NOW));
  assert.ok(all.includes('The weekly map, at the selected point.'));
  assert.ok(!/this week/i.test(all), 'the map is not called this week\'s: that is true only until the next release');
  assert.ok(all.includes('2026-10-20'), 'the map\'s own date is on the tile');
});

test('a Drought read over the place says the worst in this area, never a point (lane AREA wiring)', () => {
  const briefing = briefingOf('unavailable', 'not read in this fixture');
  const areaClaim = { ...usdmClaim, reading: { ...usdmClaim.reading, scope: 'area' } };
  briefing.horizons.current.cells.drought = cell('drought', 'current', 'ready', [areaClaim]);
  const all = text(renderLeadView(briefing, NOW));
  assert.ok(all.includes('The weekly map, the worst in this area.'), all);
  assert.ok(!all.includes('at the selected point'), all);
  const here = buildEnsoChainLinks(briefing).find((link) => link.key === 'here');
  assert.match(here.statement, /^D2 .+ in this area$/);
});

test('the together strip joins reads without stamping a date of its own', () => {
  const briefing = briefingOf('unavailable', 'not read in this fixture');
  briefing.horizons.current.cells.drought = cell('drought', 'current', 'ready', [usdmClaim]);
  briefing.horizons.current.cells.fire = cell('fire', 'current', 'ready', [nwsClaim]);
  const html = renderLeadView(briefing, NOW);
  const strip = text(/<section class="lead-together"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '');
  assert.notEqual(strip, '', 'two hazards hold a ranked read, so the strip is drawn');
  assert.ok(strip.includes('D2 Severe drought') && strip.includes('Red Flag Warning'));
  assert.ok(!/Nov(ember)? \d|2026/.test(strip), `the strip states no date of its own; it said: ${strip}`);
  assert.ok(strip.includes('DDM draws no cause between them.'));
});

test('the briefing chain relates the unread jet link to nothing', () => {
  const briefing = briefingOf('unavailable', 'not read in this fixture');
  const links = buildEnsoChainLinks(briefing);
  const jet = links.find((link) => link.key === 'jet');
  assert.ok(jet, 'the chain keeps the jet link in its place');
  assert.equal(jet.status, 'unavailable');
  assert.equal(jet.relation, 'read beside');
  for (const link of links) {
    assert.ok(!/\b(causes?|drives?|leads? to|informs)\b/i.test(link.relation ?? ''), `no causal or unsupported joint: ${link.relation}`);
  }
});

test('a tile hands its figure\'s words to assistive technology as its description', () => {
  const briefing = briefingOf('unavailable', 'not read in this fixture');
  briefing.horizons.current.cells.drought = cell('drought', 'current', 'ready', [usdmClaim]);
  const html = renderLeadView(briefing, NOW);
  const tile = /<button type="button" class="lead-tile"[\s\S]*?<\/button>/.exec(html)?.[0] ?? '';
  const describedBy = /aria-describedby="([^"]+)"/.exec(tile)?.[1];
  assert.ok(describedBy, 'the tile points at a description');
  const words = new RegExp(`id="${describedBy}">([^<]*)<`).exec(tile)?.[1] ?? '';
  const figureLabel = /<svg[^>]*aria-label="([^"]*)"/.exec(tile)?.[1] ?? '';
  assert.notEqual(figureLabel, '', 'the tile draws a figure');
  assert.equal(words, figureLabel, 'the description is the figure\'s own label, word for word');
  assert.match(words, /D0 to D4/);
});

test('the doors and tiles use the names the view switch and the head link already use', () => {
  const none = renderLeadView(briefingOf('unavailable', 'not read in this fixture'), NOW);
  const doors = [...none.matchAll(/class="lead-door"[^>]*>([^<]*)</g)].map((m) => m[1]);
  assert.deepEqual(doors, ['Full detail', 'How this is ordered']);
  assert.match(text(none), /Nothing here is ranked yet\. That is not an all-clear: each hazard is listed below with its state\./);
  const briefing = briefingOf('unavailable', 'not read in this fixture');
  briefing.horizons.current.cells.drought = cell('drought', 'current', 'ready', [usdmClaim]);
  const html = renderLeadView(briefing, NOW);
  const open = [...html.matchAll(/class="lead-open" aria-hidden="true">([^<]*)</g)].map((m) => m[1]);
  assert.ok(open.length >= 2, 'a tile and a rest row each carry the word');
  assert.ok(open.every((word) => word === 'Full detail'), `the word is the view switch's own: ${open}`);
  assert.ok(!html.includes('Federal text</span>'));
});

test('the unread-together caption and the wildfire scope say what is drawn, in fewer words', () => {
  const briefing = briefingOf('unavailable', 'not read in this fixture');
  briefing.horizons.current.cells.drought = cell('drought', 'current', 'ready', [usdmClaim]);
  briefing.horizons.current.cells.fire = cell('fire', 'current', 'ready', [nwsClaim]);
  const html = renderLeadView(briefing, NOW);
  assert.ok(text(html).includes('Separate issuer products, each ranked and dated above. Grouped only because they are present together; DDM draws no cause between them.'));
  const jet = buildEnsoChainLinks(briefing).find((link) => link.key === 'jet');
  assert.equal(jet.title, 'Jet-level wind (model guidance)');
});

const textClaim = {
  text: 'CPC 6-10 day outlook: above-normal temperature.',
  source: 'NOAA Climate Prediction Center',
  product: 'cpc-extended',
  evidence: 'modeled',
  kind: 'outlook',
  dates: { retrieved: '2026-11-09' }
};

const firstTileName = (html) =>
  /<button type="button" class="lead-tile"[^>]*aria-label="([^"]*)"/.exec(html)?.[1] ?? '';

test('a tile\'s accessible name carries the scope words its face shows (B9)', () => {
  const briefing = briefingOf('unavailable', 'not read in this fixture');
  briefing.horizons.current.cells.drought = cell('drought', 'current', 'ready', [usdmClaim]);
  briefing.horizons.current.cells.fire = cell('fire', 'current', 'ready', [
    { ...nwsClaim, reading: { kind: 'wfigs-perimeters', wildfire: 2, prescribed: 0, other: 0, lowerBound: false } }
  ]);
  const html = renderLeadView(briefing, NOW);
  const names = [...html.matchAll(/class="lead-tile"[^>]*aria-label="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(names.some((name) => name.includes('The weekly map, at the selected point.')), names.join(' | '));
  assert.ok(names.some((name) => name.includes('Current perimeters in a search area wider than this place.')), names.join(' | '));
});

test('a cell with no reading leaves other reads and gaps; a gap stays with its state (B5)', () => {
  const briefing = briefingOf('ready');
  briefing.horizons.nearTerm.cells.drought = cell('drought', 'nearTerm', 'ready', [textClaim]);
  const html = renderLeadView(briefing, NOW, { horizon: 'nearTerm' });
  assert.doesNotMatch(html, /stated in the federal text/);
  assert.equal(restRow(html, 'drought'), '', 'a ready cell with no reading is not listed');
  // The same cell, partly read: the gap stays with its state word.
  briefing.horizons.nearTerm.cells.drought = cell('drought', 'nearTerm', 'partial', [textClaim], 'One window did not respond.');
  const gap = restRow(renderLeadView(briefing, NOW, { horizon: 'nearTerm' }), 'drought');
  assert.match(gap, /live \(partial\) Near Term/);
  assert.match(gap, /One window did not respond\./);
  assert.doesNotMatch(gap, /stated in the federal text/);
});

test('an all-ready, text-only briefing claims no list below it, at either horizon (B5)', () => {
  const briefing = briefingOf('ready');
  for (const horizon of ['nearTerm', 'longRange']) {
    for (const hazard of HAZARD_KEYS) briefing.horizons[horizon].cells[hazard] = cell(hazard, horizon, 'ready', [textClaim]);
    const html = renderLeadView(briefing, NOW, { horizon });
    const said = text(/<p class="lead-none">[\s\S]*?<\/p>/.exec(html)?.[0] ?? '');
    assert.equal(said, 'Nothing here is ranked yet. That is not an all-clear.', horizon);
    assert.ok(!html.includes('lead-rest-list'), `${horizon}: no rest list is drawn`);
    assert.doesNotMatch(html, /listed below/, horizon);
  }
});

test('an ENSO link that only points to the detail is a door, with no pointer sentence', () => {
  const briefing = briefingOf('unavailable', 'not read in this fixture');
  const plain = { ...usdmClaim, product: 'ensoNino34Monthly', reading: undefined };
  briefing.horizons.current.cells.enso = cell('enso', 'current', 'ready', [plain]);
  const links = buildEnsoChainLinks(briefing);
  const pattern = links.find((link) => link.key === 'pattern');
  assert.equal(pattern.status, 'ready');
  assert.equal(pattern.action, 'detail:enso');
  assert.equal(pattern.note, undefined);
  const index = buildEnsoChainLinks(
    Object.assign(briefing, {
      horizons: {
        ...briefing.horizons,
        current: { ...briefing.horizons.current, cells: { ...briefing.horizons.current.cells, enso: cell('enso', 'current', 'ready', [{ ...plain, product: 'ensoIndex' }]) } }
      }
    })
  ).find((link) => link.key === 'index');
  assert.equal(index.action, 'detail:enso');
  assert.equal(index.note, undefined);
  for (const link of links) assert.doesNotMatch(link.note ?? '', /stated in the ENSO detail/);
});

test('the active mode\'s hazard leads the view, ranked or not (B3)', () => {
  const briefing = briefingOf('unavailable', 'not read in this fixture');
  briefing.horizons.current.cells.drought = cell('drought', 'current', 'ready', [usdmClaim]);
  briefing.horizons.current.cells.fire = cell('fire', 'current', 'ready', [nwsClaim]);
  // Fire's NWS product outranks the drought class in the table; Drought mode reads Drought first.
  assert.match(firstTileName(renderLeadView(briefing, NOW)), /^Fire:/);
  assert.match(firstTileName(renderLeadView(briefing, NOW, { hazard: 'drought' })), /^Drought:/);
  // A mode whose hazard holds no ranked read: its own state comes before every tile.
  for (const hazard of HAZARD_KEYS.filter((key) => key !== 'drought' && key !== 'fire')) {
    const html = renderLeadView(briefing, NOW, { hazard });
    const own = html.indexOf(`<li class="lead-rest-item" data-lead-hazard="${hazard}">`);
    assert.ok(own >= 0 && own < html.indexOf('class="lead-tile"'), hazard);
    assert.equal(html.split(`data-lead-hazard="${hazard}" data-lead-key="rest:`).length, 2, 'listed once');
  }
});

test('the view reads the map\'s horizon only (B4)', () => {
  const briefing = briefingOf('unavailable', 'not read in this fixture');
  briefing.horizons.current.cells.drought = cell('drought', 'current', 'ready', [usdmClaim]);
  briefing.horizons.longRange.cells.drought = cell('drought', 'longRange', 'ready', [textClaim]);
  assert.match(text(renderLeadView(briefing, NOW, { horizon: 'current' })), /D2 Severe drought/);
  const long = renderLeadView(briefing, NOW, { horizon: 'longRange' });
  assert.doesNotMatch(long, /class="lead-tile"/);
  assert.equal(restRow(long, 'drought'), '', 'a ready cell with no reading is not listed');
  assert.doesNotMatch(text(long), /Current Conditions|Near Term/);
});

test('point heat is the lead\'s detail in its own mode only (B6)', () => {
  const pointHeat = '<section class="point-heat" aria-label="Heat at selected point">station read</section>';
  const briefing = briefingOf('unavailable', 'not read in this fixture');
  for (const hazard of HAZARD_KEYS) {
    const html = renderLeadView(briefing, NOW, { hazard, pointHeat });
    assert.equal(html.includes(pointHeat), hazard === POINT_HEAT_HAZARD, hazard);
  }
  assert.ok(!renderLeadView(briefing, NOW, { pointHeat }).includes(pointHeat), 'no mode, no point heat');
});

test('the focus head names no count of hazards (DR-113)', () => {
  assert.doesNotMatch(text(renderFocusHead()), /\b(four|4) hazards\b/i);
});
