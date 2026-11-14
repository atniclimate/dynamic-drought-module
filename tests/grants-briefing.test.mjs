import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The Grants.gov subsection of the Impact Briefing's federal resources
 * (DR-258): which rows a mode lists and in what order (src/impact/grants.ts,
 * `grantsListedForMode`), and the words the reader sees in each state
 * (src/ui/grants-render.ts): loading, a live read, a partial read and an
 * unavailable read. Made-up opportunities only; no request reaches the network.
 */

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) && context.parentURL?.endsWith('.ts') &&
        existsSync(fileURLToPath(new URL(`${specifier}.ts`, context.parentURL)))) return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  }
});

const {
  openTribalGrants, grantsListedForMode, grantsShownForPlace, GRANTS_LISTED, GRANTS_GOV_ATTRIBUTION,
  grantNameIndex, grantPlace, grantListedAt, nationsNamed, statesNamed
} = await import('../src/impact/grants.ts');
const { HAZARD_CLUSTER_KEYS } = await import('../src/config/clusters.ts');
const {
  GRANTS_SEARCH_PAGE, grantStatusLine, grantsCountLine, renderGrantsSection
} = await import('../src/ui/grants-render.ts');

const TODAY = '2026-11-13';
const READ_AT = '2026-11-13T18:00:00.000Z';

function row(over = {}) {
  const id = over.id ?? '900001';
  return {
    id, number: 'EX-1', title: 'Example Drought Resilience Program', agency: 'Example Bureau',
    status: 'posted', opens: '2026-10-01', closes: '2026-12-15', listings: [],
    url: `https://www.grants.gov/search-results-detail/${id}`,
    ...over
  };
}
const live = (rows, extra = {}) => ({ state: 'live', readAt: READ_AT, hitCount: rows.length, rows, dropped: 0, partial: false, ...extra });
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('drought lists drought and water rows, soonest close first, no close date next, forecasts last, at most five', () => {
  const open = openTribalGrants([
    row({ id: '1', title: 'Example Water Infrastructure', closes: '2027-03-01' }),
    row({ id: '2', title: 'Example Forecast Drought Planning', status: 'forecasted', closes: null }),
    row({ id: '3', title: 'Example Drought Relief', closes: null }),
    row({ id: '4', title: 'Example Watershed Restoration', closes: '2026-11-20' }),
    row({ id: '5', title: 'Example Flood Mitigation', closes: '2026-11-14' }),
    row({ id: '6', title: 'Example Youth Health', closes: '2026-11-14' }),
    row({ id: '7', title: 'Example Drought Monitoring', closes: '2026-12-01' }),
    row({ id: '8', title: 'Example Water Quality', closes: '2026-12-01' }),
    row({ id: '9', title: 'Example Drought Closed', closes: '2026-11-12' })
  ], TODAY);
  const listed = grantsListedForMode(open, 'drought');
  assert.equal(GRANTS_LISTED, 5);
  assert.deepEqual(listed.map((r) => r.id), ['4', '7', '8', '1', '3']);
  // With room, the forecast comes after every open row.
  assert.deepEqual(grantsListedForMode(open.filter((r) => r.id !== '1' && r.id !== '8'), 'drought').map((r) => r.id), ['4', '7', '3', '2']);
});

test('wildfire and heat list their own rows; flood, untagged and water rows never list outside drought', () => {
  const open = openTribalGrants([
    row({ id: '1', title: 'Example Community Wildfire Defense' }),
    row({ id: '2', title: 'Example Extreme Heat Preparedness' }),
    row({ id: '3', title: 'Example Flood Mitigation' }),
    row({ id: '4', title: 'Example Water Supply' }),
    row({ id: '5', title: 'Example Youth Health' })
  ], TODAY);
  assert.deepEqual(grantsListedForMode(open, 'wildfire').map((r) => r.id), ['1']);
  assert.deepEqual(grantsListedForMode(open, 'heat').map((r) => r.id), ['2']);
  for (const mode of HAZARD_CLUSTER_KEYS) {
    const ids = grantsListedForMode(open, mode).map((r) => r.id);
    assert.ok(!ids.includes('3') && !ids.includes('5'), `${mode} lists a flood or untagged row`);
    if (mode !== 'drought') assert.ok(!ids.includes('4'), `${mode} lists a water row`);
  }
});

test('a mode with no tag rule lists none', () => {
  const open = openTribalGrants([row({ id: '1', title: 'Example Drought and Wildfire and Extreme Heat Work' })], TODAY);
  const tagged = new Set(['drought', 'wildfire', 'heat']);
  for (const mode of HAZARD_CLUSTER_KEYS.filter((m) => !tagged.has(m))) {
    assert.deepEqual(grantsListedForMode(open, mode), [], mode);
  }
});

test('the status line: a stated close date in words, no stated date, or a forecast', () => {
  assert.equal(grantStatusLine(row({ closes: '2026-12-05' })), 'Open, closes December 5, 2026');
  assert.equal(grantStatusLine(row({ closes: null })), 'Open, no close date stated');
  assert.equal(grantStatusLine(row({ status: 'forecasted', closes: null })), 'Forecast, not yet open');
});

test('the count line counts every open and forecast row, and says "at least" when the read was partial', () => {
  assert.equal(grantsCountLine(12, 3, false), '12 open and 3 forecast opportunities list federally recognized Tribal governments as eligible.');
  assert.equal(grantsCountLine(0, 0, false), '0 open and 0 forecast opportunities list federally recognized Tribal governments as eligible.');
  assert.equal(grantsCountLine(12, 3, true), 'At least 12 open and 3 forecast opportunities list federally recognized Tribal governments as eligible.');
});

test('loading: the heading and one short reading line, no rows, no count', () => {
  const html = renderGrantsSection({ state: 'loading' }, 'drought', null, TODAY);
  assert.equal(text(html), 'Open federal funding (Grants.gov) Reading Grants.gov...');
  assert.match(html, /data-grants-state="loading"/);
});

test('unavailable: one line that sends the reader to Grants.gov, never "no grants"', () => {
  const html = renderGrantsSection({ state: 'unavailable', reason: 'timeout' }, 'drought', null, TODAY);
  assert.equal(text(html), 'Open federal funding (Grants.gov) Grants.gov did not answer. Search it directly.');
  assert.ok(html.includes(`href="${GRANTS_SEARCH_PAGE.replace(/&/g, '&amp;')}"`));
  assert.doesNotMatch(text(html), /no grants|no data|0 open/i);
});

test('live: the mode rows with title link, agency and status, then the count over all rows, the link and the credit', () => {
  const rows = [
    row({ id: '1', title: 'Example Drought <Relief> & Recovery', agency: 'Example Bureau', closes: '2026-12-05' }),
    row({ id: '2', title: 'Example Flood Mitigation', agency: 'Example Agency', closes: '2026-12-01' }),
    row({ id: '3', title: 'Example Water Planning', agency: null, status: 'forecasted', closes: null }),
    row({ id: '4', title: 'Example Closed Drought', closes: '2026-11-01' })
  ];
  const html = renderGrantsSection(live(rows), 'drought', null, TODAY);
  assert.equal(text(html), [
    'Open federal funding (Grants.gov)',
    'Example Drought &lt;Relief&gt; &amp; Recovery Example Bureau Open, closes December 5, 2026',
    'Example Water Planning Forecast, not yet open',
    '2 open and 1 forecast opportunities list federally recognized Tribal governments as eligible. Search all on Grants.gov',
    GRANTS_GOV_ATTRIBUTION
  ].join(' '));
  assert.ok(html.includes('href="https://www.grants.gov/search-results-detail/1"'));
  assert.ok(html.includes(`href="${GRANTS_SEARCH_PAGE.replace(/&/g, '&amp;')}"`));
  assert.match(html, /data-grants-state="live"/);
});

test('live with no row for the mode: the count, the link and the credit, and no empty list claim', () => {
  const html = renderGrantsSection(live([row({ id: '1', title: 'Example Youth Health' })]), 'wildfire', null, TODAY);
  assert.equal(text(html), [
    'Open federal funding (Grants.gov)',
    '1 open and 0 forecast opportunities list federally recognized Tribal governments as eligible. Search all on Grants.gov',
    GRANTS_GOV_ATTRIBUTION
  ].join(' '));
});

test('the search link opens the issuer search filtered to open and forecast, federally recognized Tribal governments', () => {
  const url = new URL(GRANTS_SEARCH_PAGE);
  assert.equal(url.origin, 'https://simpler.grants.gov');
  assert.equal(url.searchParams.get('eligibility'), 'federally_recognized_native_american_tribal_governments');
  assert.equal(url.searchParams.get('status'), 'forecasted,posted');
});

test('the subsection shows for a place inside the United States, Northwest or not, and for none outside it', () => {
  const place = (over) => ({
    kind: 'tribal', title: 'Example', properties: null, lngLat: { lng: -100, lat: 40 },
    regionKey: null, containing: { state: null, basis: 'none' }, ...over
  });
  const inState = (state, regionKey = null) => place({ regionKey, containing: { state, basis: 'point-in-polygon' } });
  assert.equal(grantsShownForPlace(inState('NM')), true);
  assert.equal(grantsShownForPlace(inState('WA', 'washington_state')), true);
  assert.equal(grantsShownForPlace(place({ kind: 'state', properties: { STUSPS: 'ok' } })), true);
  // British Columbia, Mexico and open ocean resolve no State; a Northwest camera framing must not stand in.
  assert.equal(grantsShownForPlace(place({ lngLat: { lng: -123, lat: 50 } })), false);
  assert.equal(grantsShownForPlace(place({ regionKey: 'washington_state', lngLat: { lng: -123, lat: 50 } })), false);
});

// Two live titles seen at Warm Springs, Oregon on 2026-11-13, and a general one.
const BASIN_TITLE = 'Native American Affairs: Fiscal Year 2025 Colorado River Basin Tribal Drought Resiliency Program';
const OSAGE_TITLE = 'Osage Nation Wildland Fire Response';
const GENERAL_TITLE = 'Tribal Wildfire Resilience and Drought Planning';
const WARM_SPRINGS = 'Confederated Tribes of the Warm Springs Reservation of Oregon';
const OSAGE = 'The Osage Nation';

/** The two roster sources the app loads, read from the shipped files: Federal Register names and label short names. */
function shippedNameIndex() {
  const roster = JSON.parse(readFileSync(new URL('../public/data/tribal-roster.json', import.meta.url), 'utf8'));
  const labels = JSON.parse(readFileSync(new URL('../public/data/tribal-label-names.json', import.meta.url), 'utf8'));
  const formal = Object.values(roster.labelAreas).flat();
  return grantNameIndex([...formal.map((n) => [n, n]), ...labels.shortNames.map((r) => [r.shortName, r.nation])]);
}

const placeAt = (title, state) => ({
  kind: 'aiannh', title, properties: null, lngLat: { lng: -121.3, lat: 44.8 },
  regionKey: null, containing: { state, basis: 'point-in-polygon' }
});

test('a title naming a Nation lists only in that Nation\'s briefing, by whole words, never on generic words', () => {
  const names = shippedNameIndex();
  assert.deepEqual([...nationsNamed(OSAGE_TITLE, names)], [OSAGE], 'a leading "The" in the roster name is dropped');
  assert.deepEqual([...nationsNamed(GENERAL_TITLE, names)], []);
  assert.deepEqual([...nationsNamed('Native Village Tribe Nation Band Indian grants', names)], []);
  assert.deepEqual([...nationsNamed('Confederated Tribes of Warm Springs housing', names)], [WARM_SPRINGS], 'the label short name');
  assert.deepEqual([...nationsNamed('OSAGE NATIONAL forest', names)], [], 'whole words only');
  assert.equal(grantNameIndex([['Native Village', 'X'], ['The Tribe', 'Y']]), null, 'generic names alone are dropped');

  const warmSprings = grantPlace(placeAt(WARM_SPRINGS, 'OR'), names);
  const osage = grantPlace(placeAt(OSAGE, 'OK'), names);
  assert.equal(grantListedAt(OSAGE_TITLE, warmSprings), false);
  assert.equal(grantListedAt(OSAGE_TITLE, osage), true);
  assert.equal(grantListedAt(GENERAL_TITLE, warmSprings), true);
});

test('a title naming a State or the Colorado River Basin lists only for a place inside it', () => {
  const names = shippedNameIndex();
  assert.deepEqual([...statesNamed(BASIN_TITLE)].sort(), ['AZ', 'CA', 'CO', 'NM', 'NV', 'UT', 'WY']);
  assert.deepEqual([...statesNamed('West Virginia Watershed Program')], ['WV'], 'the longer State name wins');
  assert.deepEqual([...statesNamed('Indiana and Arkansas')].sort(), ['AR', 'IN']);
  assert.deepEqual([...statesNamed('Indian Affairs, Kansas')], ['KS'], 'whole words: "Indian" is not Indiana');
  assert.equal(grantListedAt(BASIN_TITLE, grantPlace(placeAt(WARM_SPRINGS, 'OR'), names)), false);
  assert.equal(grantListedAt(BASIN_TITLE, grantPlace(placeAt('Navajo Nation', 'AZ'), names)), true);
  assert.equal(grantListedAt('Oregon Drought Relief', grantPlace(placeAt('Example', null), names)), false, 'no State known: a State row is not listed');
  // A Nation's name is set aside before States are read: "Mississippi Choctaw" names a Nation, not the State.
  const choctaw = grantPlace(placeAt('Mississippi Band of Choctaw Indians', 'MS'), names);
  assert.equal(grantListedAt('Mississippi Choctaw Drought Plan', choctaw), true);
});

test('Warm Springs lists the general rows and neither real title; the count still counts every row', () => {
  const names = shippedNameIndex();
  const rows = [
    row({ id: '1', title: BASIN_TITLE, closes: '2026-11-20' }),
    row({ id: '2', title: OSAGE_TITLE, closes: '2026-11-21' }),
    row({ id: '3', title: GENERAL_TITLE, closes: '2026-11-22' })
  ];
  const place = grantPlace(placeAt(WARM_SPRINGS, 'OR'), names);
  const open = openTribalGrants(rows, TODAY);
  assert.deepEqual(grantsListedForMode(open, 'drought', place).map((r) => r.id), ['3']);
  assert.deepEqual(grantsListedForMode(open, 'wildfire', place).map((r) => r.id), ['3']);
  assert.deepEqual(grantsListedForMode(open, 'drought').map((r) => r.id), ['1', '3'], 'no place: every mode row');
  const html = renderGrantsSection(live(rows), 'wildfire', place, TODAY);
  assert.ok(!html.includes(OSAGE_TITLE) && html.includes(GENERAL_TITLE));
  assert.ok(text(html).includes('3 open and 0 forecast opportunities'), 'filtered rows still count');
});

test('no authored long dash in the subsection source or this test', () => {
  const dash = String.fromCharCode(0x2014);
  for (const file of ['../src/ui/grants-render.ts', '../src/impact/grants.ts']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    // grants.ts maps the issuer's own "&mdash;" entity to the character as an escape, not as authored text.
    assert.ok(!src.includes(dash), file);
  }
});
