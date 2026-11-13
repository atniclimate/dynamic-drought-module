import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The priority briefing's reading order (owner direction 2026-11-09 (sprint),
 * DR-pending): the published table in src/impact/priority.ts and the one pure
 * function that orders a place's structured readings by it.
 *
 * What is proven here, against the real module and the real palette tables:
 *   1. the table is the documented one (rows, the issuer's order inside each
 *      row, the NWS priority numbers as read from the issuer page);
 *   2. the order is lexicographic: row, then the issuer's class order, then
 *      the fixed hazard order, and it does not depend on input order;
 *   3. nothing is blended: the relative order of two entries never changes
 *      when other hazards' reads are added or removed;
 *   4. absence is never ranked: a read with no class in the table, and a
 *      cell that was not read, are returned in `rest`, and no hazard is
 *      dropped;
 *   5. reasons are sentences built from issuer words, with no number the
 *      reading did not carry;
 *   6. the input (the matrix cells) is never mutated.
 */

// Extensionless relative `.ts` imports (see tests/briefing-truth.test.mjs).
registerHooks({
  resolve(specifier, context, nextResolve) {
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

const {
  NWS_PRODUCT_PRIORITY,
  PRIORITY_HORIZONS,
  PRIORITY_ORDER_NOTE,
  PRIORITY_ROWS,
  PRIORITY_RULE_STATEMENTS,
  daysPhrase,
  orderBriefing,
  readingHeadline,
  sortNwsEvents
} = await import('../src/impact/priority.ts');
const { HAZARD_KEYS, HAZARD_LABELS } = await import('../src/impact/matrix.ts');
const { HAZARD_CLUSTER_KEYS } = await import('../src/config/clusters.ts');
const { SHELL_HAZARD_KEY } = await import('../src/impact/horizon-chrome.ts');
const { HEATRISK_CATEGORIES, SPC_FIREWX_CATEGORIES, USDM_CATEGORIES, NWS_ALERT_COLORS } = await import(
  '../src/config/palette.ts'
);

let serial = 0;
/** A claim shaped like makeClaim's output, carrying one reading. */
function claim(reading, extra = {}) {
  serial += 1;
  return {
    text: `claim ${serial}`,
    source: 'test source',
    evidence: 'observed',
    kind: 'observation',
    product: 'usdm',
    dates: { retrieved: '2026-11-09' },
    ...(reading ? { reading } : {}),
    ...extra
  };
}

function cell(hazard, horizon, claims, status = 'ready', note) {
  return { hazard, horizon, status, claims, ...(note ? { note } : {}) };
}

/** Twelve-cell-shaped input for the eight cells the order reads, all ready and empty unless given. */
function place(overrides = {}) {
  const cells = [];
  for (const horizon of ['current', 'nearTerm']) {
    for (const hazard of HAZARD_KEYS) {
      const key = `${hazard}:${horizon}`;
      cells.push(overrides[key] ?? cell(hazard, horizon, [], 'unavailable', `no ${key} read`));
    }
  }
  return cells;
}

const READ = {
  usdm: (dm) => ({ kind: 'usdm-category', dm }),
  heat: (value, day = 1) => ({ kind: 'heatrisk-level', value, day }),
  nws: (...events) => ({ kind: 'nws-products', events }),
  wfigs: (wildfire, prescribed = 0, other = 0, lowerBound = false) => ({
    kind: 'wfigs-perimeters',
    wildfire,
    prescribed,
    other,
    lowerBound
  }),
  spcCategory: (day, category) => ({ kind: 'spc-fire-days', days: [day], category }),
  spcProbability: (day, probability) => ({ kind: 'spc-fire-days', days: [day], probability }),
  spcNone: (...days) => ({ kind: 'spc-fire-days', days }),
  enso: (conditions, value) => ({
    kind: 'enso-index',
    index: 'RONI',
    value,
    season: 'JAS',
    year: 2026,
    preliminary: true,
    conditions,
    threshold: 0.5
  })
};

/** A place where every family holds a ranked class. */
function busyPlace() {
  return place({
    'drought:current': cell('drought', 'current', [claim(READ.usdm(2))]),
    'fire:current': cell('fire', 'current', [
      claim(READ.wfigs(2)),
      claim(READ.nws('Fire Weather Watch', 'Red Flag Warning'))
    ]),
    'heat:current': cell('heat', 'current', [claim(READ.nws('Heat Advisory'))]),
    'enso:current': cell('enso', 'current', [claim(READ.enso('el-nino', 1.69))]),
    'heat:nearTerm': cell('heat', 'nearTerm', [claim(READ.heat(3))]),
    'fire:nearTerm': cell('fire', 'nearTerm', [
      claim(READ.spcCategory(1, 8)),
      claim(READ.spcCategory(2, 10)),
      claim(READ.spcProbability(4, '0.40')),
      claim(READ.spcNone(3, 5, 6, 7, 8))
    ])
  });
}

const keysOf = (order) => order.ranked.map((entry) => `${entry.hazard}:${entry.family}:${entry.row}`);

test('the table is the published one: seven rows, in the documented order', () => {
  assert.deepEqual(
    PRIORITY_ROWS.map((row) => row.key),
    [
      'nws-product',
      'wfigs-wildfire',
      'usdm-category',
      'heatrisk-level',
      'spc-category',
      'spc-probability',
      'enso-conditions'
    ]
  );
  for (const row of PRIORITY_ROWS) {
    assert.ok(row.title.length > 0 && row.issuer.length > 0 && row.field.length > 0, row.key);
    assert.ok(row.classes.length > 0 && row.orderBasis.length > 0, row.key);
    if (row.basisUrl !== undefined) assert.match(row.basisUrl, /^https:\/\//);
  }
  assert.deepEqual(PRIORITY_HORIZONS, ['current', 'nearTerm']);
  assert.match(PRIORITY_ORDER_NOTE, /not a severity score/);
  assert.ok(PRIORITY_RULE_STATEMENTS.some((line) => /not a severity score/.test(line)));
  assert.ok(PRIORITY_RULE_STATEMENTS.some((line) => /not an all-clear/.test(line)));
});

test('inside a row the classes are the issuer\'s own, first-read first', () => {
  const row = (key) => PRIORITY_ROWS.find((candidate) => candidate.key === key);
  assert.deepEqual(
    row('usdm-category').classes,
    [4, 3, 2, 1, 0].map((dm) => `${USDM_CATEGORIES[dm].code} ${USDM_CATEGORIES[dm].label}`)
  );
  assert.deepEqual(
    row('heatrisk-level').classes,
    [4, 3, 2, 1].map((value) => `${value} ${HEATRISK_CATEGORIES[value].label}`)
  );
  assert.deepEqual(
    row('spc-category').classes,
    [...SPC_FIREWX_CATEGORIES].sort((a, b) => b.dn - a.dn).map((category) => category.label)
  );
  assert.deepEqual(row('spc-probability').classes, ['70%', '40%']);
});

test('the NWS row follows the issuer\'s published priority, and covers every product the briefing reads', () => {
  // The Priority column of https://www.weather.gov/help-map, read 2026-11-09.
  assert.deepEqual(NWS_PRODUCT_PRIORITY, {
    'Extreme Heat Warning': 44,
    'Excessive Heat Warning': 44,
    'Red Flag Warning': 52,
    'Heat Advisory': 63,
    'Extreme Heat Watch': 93,
    'Excessive Heat Watch': 93,
    'Fire Weather Watch': 96
  });
  // Every name is one the map already colours (the same issuer table's Hex Code column).
  for (const name of Object.keys(NWS_PRODUCT_PRIORITY)) {
    assert.ok(NWS_ALERT_COLORS[name], `${name} has no palette row`);
  }
  assert.deepEqual(PRIORITY_ROWS[0].classes, [
    'Extreme Heat Warning',
    'Red Flag Warning',
    'Heat Advisory',
    'Extreme Heat Watch',
    'Fire Weather Watch'
  ]);
  assert.deepEqual(sortNwsEvents(['Fire Weather Watch', 'Red Flag Warning']), [
    'Red Flag Warning',
    'Fire Weather Watch'
  ]);
});

test('the order is lexicographic: row first, one entry per issuer product family', () => {
  const order = orderBriefing(busyPlace());
  assert.deepEqual(keysOf(order), [
    'fire:nws:nws-product',
    'heat:nws:nws-product',
    'fire:wfigs:wfigs-wildfire',
    'drought:usdm:usdm-category',
    'heat:heatrisk:heatrisk-level',
    'fire:spc:spc-category',
    'enso:enso:enso-conditions'
  ]);
  assert.deepEqual(order.ranked.map((entry) => entry.rowNumber), [1, 1, 2, 3, 4, 5, 7]);
  // The SPC days share one entry, placed by its first class (Day 2, Extremely Critical).
  const spc = order.ranked.find((entry) => entry.family === 'spc');
  assert.equal(spc.members.length, 4);
  assert.equal(spc.lead.reading.category, 10);
  assert.equal(spc.headline, 'Extremely Critical, Day 2');
});

test('inside a row the issuer\'s class order decides, ahead of the fixed hazard order', () => {
  // Heat's product outranks Fire's in the NWS table, though Fire precedes Heat in the hazard order.
  const order = orderBriefing(
    place({
      'fire:current': cell('fire', 'current', [claim(READ.nws('Red Flag Warning'))]),
      'heat:current': cell('heat', 'current', [claim(READ.nws('Extreme Heat Warning'))])
    })
  );
  assert.deepEqual(keysOf(order), ['heat:nws:nws-product', 'fire:nws:nws-product']);
  // A former name takes its renamed row.
  const legacy = orderBriefing(
    place({
      'fire:current': cell('fire', 'current', [claim(READ.nws('Red Flag Warning'))]),
      'heat:current': cell('heat', 'current', [claim(READ.nws('Excessive Heat Warning'))])
    })
  );
  assert.deepEqual(keysOf(legacy), ['heat:nws:nws-product', 'fire:nws:nws-product']);
});

test('a tie inside a class keeps the fixed hazard order', () => {
  // Two names the table does not carry tie after every listed product.
  const order = orderBriefing(
    place({
      'heat:current': cell('heat', 'current', [claim(READ.nws('Unlisted product B'))]),
      'fire:current': cell('fire', 'current', [claim(READ.nws('Unlisted product A'))])
    })
  );
  assert.deepEqual(keysOf(order), ['fire:nws:nws-product', 'heat:nws:nws-product']);
  assert.deepEqual(HAZARD_KEYS, ['drought', 'fire', 'heat', 'enso']);
});

test('the result does not depend on the order the cells arrive in', () => {
  const cells = busyPlace();
  const expected = keysOf(orderBriefing(cells));
  const reversed = [...cells].reverse();
  assert.deepEqual(keysOf(orderBriefing(reversed)), expected);
  const rotated = [...cells.slice(3), ...cells.slice(0, 3)];
  assert.deepEqual(keysOf(orderBriefing(rotated)), expected);
});

test('nothing is blended: two entries keep their relative order whatever else is read', () => {
  const full = busyPlace();
  const fullOrder = keysOf(orderBriefing(full));
  // Every subset of the six reading-bearing cells: the surviving entries keep the full order.
  const bearing = full.filter((c) => c.claims.length > 0);
  for (let mask = 1; mask < 1 << bearing.length; mask += 1) {
    const kept = new Set(bearing.filter((_, index) => (mask >> index) & 1));
    const subset = full.map((c) =>
      c.claims.length === 0 || kept.has(c) ? c : cell(c.hazard, c.horizon, [], 'unavailable', 'removed')
    );
    const got = keysOf(orderBriefing(subset));
    assert.deepEqual(got, fullOrder.filter((key) => got.includes(key)), `mask ${mask}`);
  }
});

test('a class is ranked by itself: the issuer scale decides which class of a family leads', () => {
  for (const [low, high] of [[0, 4], [1, 2], [3, 4]]) {
    const lowEntry = orderBriefing(place({ 'drought:current': cell('drought', 'current', [claim(READ.usdm(low))]) })).ranked[0];
    const highEntry = orderBriefing(place({ 'drought:current': cell('drought', 'current', [claim(READ.usdm(high))]) })).ranked[0];
    assert.equal(lowEntry.row, 'usdm-category');
    assert.equal(highEntry.row, 'usdm-category');
    assert.notEqual(lowEntry.headline, highEntry.headline);
  }
  // SPC: the higher category leads the family even on the later day; the earlier day leads a tie.
  const laterHigher = orderBriefing(
    place({ 'fire:nearTerm': cell('fire', 'nearTerm', [claim(READ.spcCategory(1, 5)), claim(READ.spcCategory(2, 8))]) })
  ).ranked[0];
  assert.equal(laterHigher.headline, 'Critical, Day 2');
  const sameClass = orderBriefing(
    place({ 'fire:nearTerm': cell('fire', 'nearTerm', [claim(READ.spcCategory(2, 8)), claim(READ.spcCategory(1, 8))]) })
  ).ranked[0];
  assert.equal(sameClass.headline, 'Critical, Day 1');
  // With no category drawn, a mapped probability places the family in the probability row.
  const probability = orderBriefing(
    place({ 'fire:nearTerm': cell('fire', 'nearTerm', [claim(READ.spcNone(1)), claim(READ.spcProbability(5, '0.40')), claim(READ.spcProbability(6, '0.70'))]) })
  ).ranked[0];
  assert.equal(probability.row, 'spc-probability');
  assert.equal(probability.headline, '70% probability, Day 6');
});

test('a read with no class in the table is listed, never ranked and never dropped', () => {
  const order = orderBriefing(
    place({
      'drought:current': cell('drought', 'current', [claim(READ.usdm(null))]),
      'fire:current': cell('fire', 'current', [claim(READ.wfigs(0, 1)), claim(READ.nws())]),
      'heat:current': cell('heat', 'current', [claim(READ.nws())]),
      'enso:current': cell('enso', 'current', [claim(READ.enso('neutral', 0.12))]),
      'heat:nearTerm': cell('heat', 'nearTerm', [claim(READ.heat(0)), claim(null)]),
      'fire:nearTerm': cell('fire', 'nearTerm', [
        claim(READ.spcNone(1)),
        claim(READ.spcNone(2)),
        claim(READ.spcProbability(3, 'Probability Too Low')),
        claim(READ.spcNone(4, 5, 6, 7, 8))
      ])
    })
  );
  assert.deepEqual(order.ranked, []);
  assert.deepEqual(order.rest.map((item) => item.hazard), HAZARD_KEYS);
  const rest = Object.fromEntries(order.rest.map((item) => [item.hazard, item]));
  assert.deepEqual(rest.drought.reads.map((read) => read.headline), ['No D0-D4 category drawn']);
  // NWS and WFIGS absences keep their own sentence (a null headline), never a DDM all-clear.
  assert.deepEqual(rest.fire.reads.map((read) => [read.family, read.headline]), [
    ['wfigs', null],
    ['nws', null],
    ['spc', 'No area drawn over this point, Days 1, 2, 4, 5, 6, 7 and 8. Probability Too Low, Day 3']
  ]);
  assert.deepEqual(rest.heat.reads.map((read) => read.headline), [null, 'HeatRisk 0 Little to None']);
  assert.deepEqual(rest.enso.reads.map((read) => read.headline), [
    'Neutral conditions: RONI +0.12 (JAS 2026, preliminary)'
  ]);
  for (const item of order.rest) {
    for (const read of item.reads) {
      assert.doesNotMatch(String(read.headline), /all.clear|safe|no risk|no drought\b/i);
    }
  }
});

test('a hazard that was not read is listed under its own state with its reason', () => {
  const loading = orderBriefing(
    ['current', 'nearTerm'].flatMap((horizon) => HAZARD_KEYS.map((hazard) => cell(hazard, horizon, [], 'loading')))
  );
  assert.deepEqual(loading.ranked, []);
  assert.deepEqual(loading.rest.map((item) => item.hazard), HAZARD_KEYS);
  for (const item of loading.rest) {
    assert.deepEqual(item.states.map((state) => state.status), ['loading', 'loading']);
    assert.deepEqual(item.reads, []);
  }

  const mixed = orderBriefing(
    place({
      'drought:current': cell('drought', 'current', [claim(READ.usdm(3))], 'partial', 'The USDM drought-severity trend did not respond.'),
      'heat:nearTerm': cell('heat', 'nearTerm', [], 'unavailable', 'The HeatRisk classification did not respond.')
    })
  );
  assert.deepEqual(keysOf(mixed), ['drought:usdm:usdm-category']);
  // Drought leads AND still reports that its cell was only partly read.
  const drought = mixed.rest.find((item) => item.hazard === 'drought');
  assert.deepEqual(drought.states[0], {
    horizon: 'current',
    status: 'partial',
    note: 'The USDM drought-severity trend did not respond.'
  });
  const heat = mixed.rest.find((item) => item.hazard === 'heat');
  assert.ok(heat.states.some((state) => state.status === 'unavailable' && /HeatRisk/.test(state.note)));
  // Every hazard appears in ranked, in rest, or in both.
  for (const hazard of HAZARD_KEYS) {
    assert.ok(
      mixed.ranked.some((entry) => entry.hazard === hazard) || mixed.rest.some((item) => item.hazard === hazard),
      hazard
    );
  }
  // A hazard with no cell in the input at all is still listed, as not read.
  const missing = orderBriefing([cell('drought', 'current', [claim(READ.usdm(1))])]);
  assert.deepEqual(missing.rest.map((item) => item.hazard), ['fire', 'heat', 'enso']);
  for (const item of missing.rest) assert.equal(item.states[0].status, 'unavailable');
});

test('a cell whose claims carry no reading still speaks: its leading claim stands in as text', () => {
  const first = claim(null, { text: 'CPC 6-10 day outlook: above-normal temperature.' });
  const order = orderBriefing(
    place({ 'drought:nearTerm': cell('drought', 'nearTerm', [first, claim(null)]) })
  );
  const drought = order.rest.find((item) => item.hazard === 'drought');
  // B5: the text read carries its cell's own state, so it is never a bare horizon label.
  assert.deepEqual(drought.texts, [{ horizon: 'nearTerm', status: 'ready', claim: first }]);
});

test('the hazard rows are the modes, in the mode table\'s order (DR-113)', () => {
  assert.deepEqual(HAZARD_KEYS, HAZARD_CLUSTER_KEYS.map((key) => SHELL_HAZARD_KEY[key]));
  const tieLine = PRIORITY_RULE_STATEMENTS.find((line) => /Ties keep one fixed hazard order/.test(line));
  assert.ok(tieLine.includes(HAZARD_KEYS.map((hazard) => HAZARD_LABELS[hazard]).join(', ')));
});

test('the active mode\'s hazard leads; every other entry keeps the order it had (B3)', () => {
  const cells = busyPlace();
  const today = keysOf(orderBriefing(cells));
  for (const hazard of HAZARD_KEYS) {
    const order = orderBriefing(cells, { hazard });
    const got = keysOf(order);
    const own = today.filter((key) => key.startsWith(`${hazard}:`));
    assert.deepEqual(got, [...own, ...today.filter((key) => !own.includes(key))], hazard);
    // The rest leads with the mode's hazard too, where it has one; the others keep their order.
    const restHazards = order.rest.map((item) => item.hazard);
    const others = restHazards.filter((key) => key !== hazard);
    assert.deepEqual(restHazards, restHazards.includes(hazard) ? [hazard, ...others] : others);
    assert.deepEqual(others, HAZARD_KEYS.filter((key) => others.includes(key)));
  }
  // An unranked mode hazard heads the rest.
  for (const hazard of HAZARD_KEYS) {
    const order = orderBriefing(place(), { hazard });
    assert.deepEqual(order.ranked, []);
    assert.deepEqual(order.rest.map((item) => item.hazard), [hazard, ...HAZARD_KEYS.filter((key) => key !== hazard)]);
  }
});

test('the at-hand line leads with point heat only in its own mode (B3, B6)', async () => {
  const { selectBriefNarrativeLine } = await import('../src/impact/brief-narrative-selector.ts');
  const { POINT_HEAT_HAZARD } = await import('../src/impact/horizon-chrome.ts');
  const temperature = { key: 'temperature', values: [{ value: 32, unitCode: 'wmoUnit:degC' }] };
  const cells = Object.fromEntries(
    HAZARD_KEYS.map((hazard) => [hazard, { claims: [{ text: `${hazard} current claim` }] }])
  );
  const briefing = {
    pointHeat: { observation: { status: 'ready', stationName: 'Near Station', metrics: [temperature] }, grid: { status: 'no-data', metrics: [] } },
    horizons: { current: { cells, claims: HAZARD_KEYS.map((hazard) => cells[hazard].claims[0]) } }
  };
  for (const hazard of HAZARD_KEYS) {
    const line = selectBriefNarrativeLine(briefing, hazard);
    if (hazard === POINT_HEAT_HAZARD) assert.match(line, /^Heat at the selected point: Near Station/);
    else assert.equal(line, `${hazard} current claim`);
  }
  // No mode given: the shipped order, point heat first.
  assert.match(selectBriefNarrativeLine(briefing), /^Heat at the selected point/);
  // A mode with no current claim falls back to point heat.
  const empty = { ...briefing, horizons: { current: { cells: { ...cells, drought: { claims: [] } }, claims: [] } } };
  assert.match(selectBriefNarrativeLine(empty, 'drought'), /^Heat at the selected point/);
  // Point heat not ready in its own mode: the mode's own cell, never another hazard's claim.
  const unready = { ...briefing, pointHeat: { observation: { status: 'loading', metrics: [] }, grid: { status: 'loading', metrics: [] } } };
  assert.equal(selectBriefNarrativeLine(unready, POINT_HEAT_HAZARD), `${POINT_HEAT_HAZARD} current claim`);
});

test('only the map\'s horizon enters the order (B4)', () => {
  const near = orderBriefing(busyPlace(), { horizon: 'nearTerm' });
  assert.deepEqual(keysOf(near), ['heat:heatrisk:heatrisk-level', 'fire:spc:spc-category']);
  const current = orderBriefing(busyPlace(), { horizon: 'current' });
  assert.ok(keysOf(current).every((key) => !/heatrisk|spc/.test(key)));
  for (const entry of current.ranked) assert.equal(entry.lead.horizon, 'current');
  // Long Range: a seasonal claim with no ranked reading speaks as text, with its state.
  const seasonal = claim({ kind: 'cpc-tercile', variable: 'temperature', cat: 'Above', prob: 50, season: 'Sep-Oct-Nov 2026' });
  const long = orderBriefing(
    [
      ...busyPlace(),
      cell('heat', 'longRange', [seasonal], 'partial', 'One window did not respond.'),
      cell('drought', 'longRange', [], 'unavailable', 'no long-range drought read')
    ],
    { horizon: 'longRange' }
  );
  assert.deepEqual(long.ranked, []);
  const heat = long.rest.find((item) => item.hazard === 'heat');
  assert.deepEqual(heat.texts, [{ horizon: 'longRange', status: 'partial', claim: seasonal }]);
  // A hazard with no cell at this horizon is listed as not read, at this horizon.
  const fire = long.rest.find((item) => item.hazard === 'fire');
  assert.deepEqual(fire.states, [{ horizon: 'longRange', status: 'unavailable' }]);
});

test('seasonal reads and long-range cells never enter the order', () => {
  const order = orderBriefing([
    ...place({ 'drought:current': cell('drought', 'current', [claim(READ.usdm(1))]) }),
    cell('drought', 'longRange', [claim(READ.usdm(4))]),
    cell('heat', 'longRange', [
      claim({ kind: 'cpc-tercile', variable: 'temperature', cat: 'Above', prob: 50, season: 'Sep-Oct-Nov 2026' })
    ])
  ]);
  assert.deepEqual(keysOf(order), ['drought:usdm:usdm-category']);
  assert.equal(order.ranked[0].headline, 'D1 Moderate drought');
});

test('reasons are sentences in issuer words, carrying no number the reading did not', () => {
  const order = orderBriefing(busyPlace());
  const reasons = Object.fromEntries(order.ranked.map((entry) => [`${entry.hazard}:${entry.family}`, entry.reason]));
  assert.deepEqual(reasons, {
    'fire:nws': 'NWS Red Flag Warning and Fire Weather Watch in effect here',
    'heat:nws': 'NWS Heat Advisory in effect here',
    'fire:wfigs': '2 current mapped NIFC wildfire perimeters intersect the bounding box around this selection',
    'drought:usdm': 'U.S. Drought Monitor: D2 Severe drought at the selected point',
    'heat:heatrisk': 'NWS HeatRisk: 3 Major at the selected point, on the 0 to 4 scale',
    'fire:spc': 'SPC Day 2 Fire Weather Outlook: Extremely Critical at the selected point',
    'enso:enso': 'El Nino conditions present: RONI +1.69 (JAS 2026, preliminary)'
  });
  // The NWS priority number, the row number and the class rank are never printed.
  for (const entry of order.ranked) {
    assert.doesNotMatch(entry.reason, /\b(44|52|63|93|96)\b/);
    assert.doesNotMatch(entry.reason, /row|rank|score|priority/i);
  }
  const floor = orderBriefing(
    place({ 'fire:current': cell('fire', 'current', [claim(READ.wfigs(50, 0, 0, true))]) })
  ).ranked[0];
  assert.equal(
    floor.reason,
    'At least 50 current mapped NIFC wildfire perimeters intersect the bounding box around this selection'
  );
  assert.equal(
    orderBriefing(place({ 'fire:current': cell('fire', 'current', [claim(READ.wfigs(1))]) })).ranked[0].reason,
    '1 current mapped NIFC wildfire perimeter intersects the bounding box around this selection'
  );
  assert.equal(readingHeadline(READ.heat(null)), 'No data at the selected point');
  assert.equal(daysPhrase([3, 4, 5, 6, 7, 8]), 'Days 3 to 8');
  assert.equal(daysPhrase([2, 1]), 'Days 1 and 2');
  assert.equal(daysPhrase([5]), 'Day 5');
});

test('the cells are read, never rearranged or changed', () => {
  const freeze = (value) => {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  };
  const cells = freeze(busyPlace());
  const before = JSON.stringify(cells);
  orderBriefing(cells);
  assert.equal(JSON.stringify(cells), before);
});
