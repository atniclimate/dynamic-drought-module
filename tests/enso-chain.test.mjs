import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The ENSO mode's chain as data (owner direction 2026-11-09 (sprint),
 * DR-pending): src/ui/enso-chain-model.ts, driven as the pure builders it
 * holds, and drawn through the shared link component
 * (src/ui/evidence-chain.ts) exactly as the host does.
 *
 * What is proven here:
 *   1. the chain is always five links, in one order, under one set of keys,
 *      and the shared component draws all five and no more;
 *   2. the words between links are the four relationships the module cites,
 *      in every state, and none of them is a cause or an arrow;
 *   3. every state of every link: a read wears its own source, clock and
 *      evidence class; `loading`, `live (partial)`, `unavailable` and the
 *      idle states are each their own drawing with their own reason;
 *   4. a link with no read never draws a value, a zero or an all-clear: no
 *      statement, no figure, no badge, no source date, and its overview node
 *      is an open square under a state word;
 *   5. model guidance and an outlook never wear the observation plate;
 *   6. the nested truth is the governed words of src/impact/enso.ts, closed
 *      at first with the denial on its summary, and NOAA CPC's sentence is
 *      the one the technical section quotes;
 *   7. the chain never wears the full detail's claim class names, its
 *      stylesheet draws colour and corners through tokens only, its presses
 *      write no history of their own, and it sits behind a dynamic import;
 *   8. the seasonal link says which outlook layer its press puts on the map
 *      whenever that is not the outlook it reads, from the mode's own recipe;
 *   9. the Guide door makes five doors in the phone column, and the planner
 *      fits five at every phone viewport the sprint names.
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
  ENSO_CHAIN_CAPTION,
  ENSO_CHAIN_HEADING,
  ENSO_CHAIN_KEYS,
  ENSO_TRUTH_SUMMARY,
  buildEnsoChain,
  ensoStripSvg,
  renderEnsoTruth
} = await import('../src/ui/enso-chain-model.ts');
const { CHAIN_MAX_LINKS, renderEvidenceChain } = await import('../src/ui/evidence-chain.ts');
const { ENSO_NESTED_TRUTH, readEnsoClaims } = await import('../src/impact/enso.ts');
const { claimDateLine, makeClaim } = await import('../src/impact/evidence.ts');
const { signedIndex } = await import('../src/impact/priority.ts');
const { FLOW_WORDS, dateLabel } = await import('../src/layers/enso-flow-data.ts');
const { READ_STATE_WORD } = await import('../src/ui/gauges.ts');
const { USDM_CATEGORIES, USDM_NONE_SWATCH } = await import('../src/config/palette.ts');
const { HAZARD_CLUSTERS } = await import('../src/config/clusters.ts');
const { getLayerDef } = await import('../src/config/layers.ts');
const { PRODUCTS } = await import('../src/config/products.ts');
const { EDGE_COLUMN_TOKENS, planEdgeColumn } = await import('../src/config/edge-column.ts');
const { ENSO_INDICES_SHARED_KEY, invalidateSharedJsonRequest } = await import('../src/util/fetch.ts');

const read = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const count = (text, needle) => text.split(needle).length - 1;
/** Source text with its comments removed, so a rule is tested against code, not prose. */
const code = (path) => read(path).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');

const KEYS = ['index', 'pattern', 'jet', 'tendency', 'here'];
const RELATIONS = [
  'measured in the boxed region of',
  'historically tends to shift',
  'one model instant, read beside a season',
  'read beside'
];
/** The full detail's claim class names: `impact-claim-observed` and its six siblings. */
const EVIDENCE_CLASS_NAME = /impact-claim-(?:observed|analyzed|classified|modeled|derived|outlook)/;
/** Every word an overview node may show for a link with no read. */
const STATE_MARKS = new Set(['loading...', 'unavailable', 'partial', 'not shown', 'no data', 'zoom in', 'no place']);

// ---------------------------------------------------------------------------
// Fixtures: the real index claims from the bundled snapshot, and place claims
// shaped by the real claim factory.
// ---------------------------------------------------------------------------

function dayOffset(days) {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** The module's own claims for the bundled snapshot, restamped to an age in days (tests/enso-stale-claims.test.mjs). */
async function ensoClaimsAtAge(days) {
  const snap = JSON.parse(read('../public/data/enso-indices.json'));
  const day = dayOffset(days);
  snap.retrieved = day;
  for (const key of ['roni', 'oni', 'nino34', 'nino34Weekly', 'soi']) {
    if (snap[key]) snap[key].published = day;
  }
  invalidateSharedJsonRequest(ENSO_INDICES_SHARED_KEY);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(snap));
  try {
    const result = await readEnsoClaims(new AbortController().signal);
    assert.equal(result.ok, true);
    return { claims: result.claims, snap };
  } finally {
    globalThis.fetch = originalFetch;
    invalidateSharedJsonRequest(ENSO_INDICES_SHARED_KEY);
  }
}

const fresh = await ensoClaimsAtAge(30);
const stale = await ensoClaimsAtAge(150);

const outlookClaim = (reading) =>
  makeClaim({
    text: 'The NOAA CPC seasonal temperature outlook for this point, as its claim states it.',
    source: 'NOAA Climate Prediction Center seasonal temperature outlook',
    sourceUrl: 'https://www.cpc.ncep.noaa.gov/products/predictions/long_range/',
    evidence: 'outlook',
    product: 'cpcSeasonalTemp',
    dates: { issued: '2026-09-01', retrieved: '2026-11-09' },
    ...(reading ? { reading } : {})
  });
const tercile = (cat, prob = 50) => ({ kind: 'cpc-tercile', variable: 'temperature', cat, prob, season: 'Sep-Oct-Nov 2026' });

const usdmClaim = (reading) =>
  makeClaim({
    text: 'The U.S. Drought Monitor read for this point, as its claim states it.',
    source: 'U.S. Drought Monitor (NDMC / NOAA / USDA)',
    sourceUrl: 'https://droughtmonitor.unl.edu/',
    evidence: 'analyzed',
    product: 'usdm',
    dates: { valid: '2026-11-05', retrieved: '2026-11-09' },
    ...(reading ? { reading } : {})
  });

const WA = { label: 'Washington', inside: true };
const CYCLE = Date.UTC(2026, 10, 9, 6);
const VALID = Date.UTC(2026, 10, 9, 12);
const JET_OFF = { kind: null, status: 'inactive', label: '', line: '', notes: [] };
const JET_LIVE = {
  kind: 'jet',
  status: 'live',
  label: 'Jet-level wind',
  line: `live · ${FLOW_WORDS.source.jet} · ${FLOW_WORDS.modelRun} ${dateLabel(CYCLE)} · Model valid ${dateLabel(VALID)}`,
  notes: [FLOW_WORDS.bins.jet],
  cycle: CYCLE,
  valid: VALID
};

/** A chain with every link read; each test overrides the part it speaks for. */
function input(overrides = {}) {
  return {
    enso: { status: 'ready', claims: fresh.claims },
    surface: { status: 'ready', date: '2026-11-08' },
    jet: JET_LIVE,
    place: WA,
    outlook: { status: 'ready', claim: outlookClaim(tercile('Above')) },
    here: { status: 'ready', claim: usdmClaim({ kind: 'usdm-category', dm: 2 }) },
    ...overrides
  };
}

const linkOf = (view, key) => view.links.find((link) => link.key === key);
const nodeOf = (view, key) => view.strip.find((node) => node.key === key);
const draw = (view) => renderEvidenceChain(view.links, { id: 'enso', heading: ENSO_CHAIN_HEADING, caption: ENSO_CHAIN_CAPTION });
/** One link's own markup, cut out of the drawn chain. */
function drawnLink(view, key) {
  const html = draw(view);
  const found = [...html.matchAll(/<li class="evidence-chain-link"[\s\S]*?<\/li>/g)].map((m) => m[0]);
  const item = found.find((li) => li.includes(`data-chain-link="${key}"`));
  assert.ok(item, `the ${key} link is drawn`);
  return item;
}

/**
 * The no-read contract, asserted for one link in one state: the data holds
 * no read, the drawn card shows none, and the overview node is an open square
 * under a state word.
 */
function assertNoRead(view, key, status, label) {
  const link = linkOf(view, key);
  assert.equal(link.status, status, `${label}: status`);
  for (const field of ['statement', 'figure', 'evidence', 'source', 'sourceUrl']) {
    assert.equal(link[field], undefined, `${label}: no ${field}`);
  }
  assert.ok(link.dateLine === undefined || link.dateLine === null, `${label}: no date`);
  assert.ok(typeof link.note === 'string' && link.note.length > 12, `${label}: says why`);
  // Nothing in a no-read reason claims a quiet state.
  assert.doesNotMatch(link.note, /\b(?:all clear|no drought|no risk|calm|safe|normal|nothing to report)\b/i, `${label}: no all-clear`);

  const item = drawnLink(view, key);
  assert.match(item, new RegExp(`data-chain-status="${status}"`), `${label}: drawn status`);
  assert.equal(count(item, 'evidence-chain-statement'), 0, `${label}: no statement drawn`);
  assert.equal(count(item, 'evidence-chain-figure'), 0, `${label}: no figure drawn`);
  assert.equal(count(item, '<svg'), 0, `${label}: no gauge, so no zero needle`);
  assert.equal(count(item, 'impact-claim-badge'), 0, `${label}: no evidence badge`);
  assert.equal(count(item, 'data-evidence'), 0, `${label}: no evidence class`);
  assert.equal(count(item, 'impact-claim-date'), 0, `${label}: no date drawn`);
  assert.equal(count(item, 'impact-hazard-pill'), status === 'idle' ? 1 : 2, `${label}: one state pill`);

  const node = nodeOf(view, key);
  assert.equal(node.status, status, `${label}: node status`);
  assert.equal(node.evidence, undefined, `${label}: node wears no evidence tier`);
  assert.ok(STATE_MARKS.has(node.mark), `${label}: node mark "${node.mark}" is a state word`);
  assert.doesNotMatch(node.mark, /\d/, `${label}: node mark holds no number`);
}

// ---------------------------------------------------------------------------
// 1. Five links, one order
// ---------------------------------------------------------------------------

test('the chain is always five links in one order, and the component draws all five', () => {
  assert.deepEqual([...ENSO_CHAIN_KEYS], KEYS);
  assert.equal(CHAIN_MAX_LINKS, 5);
  assert.equal(ENSO_CHAIN_KEYS.length, CHAIN_MAX_LINKS, 'the chain fills the component and never exceeds it');
  const empty = {
    enso: { status: 'loading' },
    surface: { status: null, date: null },
    jet: JET_OFF,
    place: null,
    outlook: { status: 'none' },
    here: { status: 'none' }
  };
  for (const [label, view] of [['every link read', buildEnsoChain(input())], ['no link read', buildEnsoChain(empty)]]) {
    assert.deepEqual(view.links.map((link) => link.key), KEYS, `${label}: link keys`);
    assert.deepEqual(view.strip.map((node) => node.key), KEYS, `${label}: overview keys`);
    assert.deepEqual(view.strip.map((node) => node.word), ['Index', 'Pacific', 'Jet', 'Season', 'Here'], `${label}: overview words`);
    const html = draw(view);
    assert.equal(count(html, '<li class="evidence-chain-link"'), 5, `${label}: five cards`);
    assert.equal(count(html, 'class="evidence-chain-joint"'), 4, `${label}: four joints`);
    assert.match(html, /aria-labelledby="evidence-chain-title-enso"/);
    // Every link is a press control named for what the press does.
    assert.equal(count(html, 'class="evidence-chain-open"'), 5, `${label}: five press controls`);
    for (const link of view.links) {
      assert.ok(link.action && link.actionLabel, `${label}: ${link.key} names its press`);
    }
  }
  // A sixth link handed to the component is not drawn.
  const six = [...buildEnsoChain(input()).links, { key: 'extra', title: 'Extra', status: 'ready' }];
  assert.equal(count(renderEvidenceChain(six, { heading: 'h', caption: 'c' }), '<li class="evidence-chain-link"'), 5);
});

// ---------------------------------------------------------------------------
// 2. The words between links
// ---------------------------------------------------------------------------

test('the words between links are the four cited relationships, in every state, and never a cause', () => {
  const views = [
    buildEnsoChain(input()),
    buildEnsoChain(input({ enso: { status: 'unavailable', note: 'The ENSO index snapshot was unavailable.' } })),
    buildEnsoChain(input({ surface: { status: 'error', date: null }, jet: JET_OFF })),
    buildEnsoChain(input({ place: null, outlook: { status: 'none' }, here: { status: 'none' } }))
  ];
  for (const view of views) {
    assert.deepEqual(view.links.slice(0, 4).map((link) => link.relation), RELATIONS);
    assert.equal(view.links[4].relation, undefined, 'the last link has no next link');
    const html = draw(view);
    assert.deepEqual([...html.matchAll(/class="evidence-chain-relation">([^<]*)</g)].map((m) => m[1]), RELATIONS);
    // No arrow anywhere in the chain: a relationship is not a direction.
    assert.doesNotMatch(html, /[←-⇿⟵-⟿➔➜]|&rarr;|-&gt;|=&gt;/);
  }
  for (const relation of RELATIONS) {
    assert.doesNotMatch(relation, /\b(?:cause[sd]?|causing|because|drives?|driven|leads? to|results? in|makes?|brings?|triggers?|produces?|will|due to)\b/i, relation);
  }
  // The caption says what the joints are, and the heading names both ends.
  assert.match(ENSO_CHAIN_CAPTION, /relationships, never causes/);
  assert.match(ENSO_CHAIN_CAPTION, /each on its own clock/);
  assert.equal(ENSO_CHAIN_HEADING, 'ENSO: from the ocean to the weather here');
  // The second joint stands on the sentence the module carries, which names the jet streams.
  assert.match(ENSO_NESTED_TRUTH.events, /position and intensity of the jet streams/);
});

// ---------------------------------------------------------------------------
// 3 and 4. Every state of every link
// ---------------------------------------------------------------------------

test('index link: a read draws the snapshot value on the issuer thresholds, from the claim itself', () => {
  const view = buildEnsoChain(input());
  const link = linkOf(view, 'index');
  const claim = fresh.claims.find((candidate) => candidate.product === 'ensoIndex');
  const latest = fresh.snap.roni.latest;
  assert.equal(claim.reading.kind, 'enso-index', 'the claim carries its reading');
  assert.equal(link.status, 'ready');
  assert.equal(link.source, claim.source);
  assert.equal(link.sourceUrl, claim.sourceUrl);
  assert.equal(link.evidence, claim.evidence);
  assert.equal(link.dateLine, claimDateLine(claim));
  // The statement is built from the typed reading: the snapshot's own season, year and value.
  const value = signedIndex(latest.anom);
  assert.match(link.statement, /^(?:El Nino|La Nina|Neutral) conditions: RONI [+-]?\d+\.\d\d \([A-Z]{3} \d{4}(?:, preliminary)?\)$/);
  assert.ok(link.statement.includes(`RONI ${value} (${latest.seas} ${latest.year}`), link.statement);
  assert.equal(link.statement.includes('preliminary'), latest.preliminary === true);
  assert.match(link.figure, /class="ddm-gauge ddm-gauge-index" data-gauge-state="read"/);
  assert.equal(count(link.figure, 'class="g-dot"'), 1, 'one value dot');
  assert.equal(count(link.figure, 'class="g-threshold"'), 2, 'both onset thresholds');
  assert.ok(link.figure.includes(`>${value}<`), 'the dot is labelled with the value');
  assert.equal(link.action, 'index');
  const node = nodeOf(view, 'index');
  assert.equal(node.mark, value);
  assert.equal(node.evidence, claim.evidence);
  const item = drawnLink(view, 'index');
  assert.equal(count(item, 'impact-claim-badge'), 1);
  assert.match(item, /class="impact-claim-date">Published \d{4}-\d{2}-\d{2}</);
});

test('index link: an old snapshot is a dated sentence, never a gauge that looks current', () => {
  const claim = stale.claims.find((candidate) => candidate.product === 'ensoIndex');
  assert.equal(claim.reading, undefined, 'the module withholds the reading past its cutoff');
  const view = buildEnsoChain(input({ enso: { status: 'ready', claims: stale.claims } }));
  const link = linkOf(view, 'index');
  assert.equal(link.status, 'ready');
  assert.equal(link.statement, undefined);
  assert.equal(link.figure, undefined);
  assert.equal(link.source, claim.source);
  assert.equal(link.dateLine, claimDateLine(claim));
  assert.match(link.note, /dated sentence/);
  assert.equal(nodeOf(view, 'index').mark, 'dated');
  assert.equal(count(drawnLink(view, 'index'), '<svg'), 0);
});

test('index link: loading and unavailable hold no read', () => {
  assertNoRead(buildEnsoChain(input({ enso: { status: 'loading' } })), 'index', 'loading', 'index loading');
  const down = buildEnsoChain(input({ enso: { status: 'unavailable', note: 'The ENSO index snapshot was unavailable.' } }));
  assertNoRead(down, 'index', 'unavailable', 'index unavailable');
  assert.equal(linkOf(down, 'index').note, 'The ENSO index snapshot was unavailable.');
  assert.equal(nodeOf(down, 'index').mark, 'unavailable');
  // A snapshot that answered without the index claim is not a read either.
  const without = fresh.claims.filter((candidate) => candidate.product !== 'ensoIndex');
  const missing = buildEnsoChain(input({ enso: { status: 'ready', claims: without } }));
  assertNoRead(missing, 'index', 'unavailable', 'index claim missing');
  assert.equal(nodeOf(buildEnsoChain(input({ enso: { status: 'loading' } })), 'index').mark, READ_STATE_WORD.loading);
});

test('pattern link: the surface is an analyzed product on its own frame date', () => {
  const view = buildEnsoChain(input());
  const link = linkOf(view, 'pattern');
  assert.equal(link.status, 'ready');
  assert.equal(link.evidence, 'analyzed', 'an analysis product never wears the observed plate');
  assert.equal(link.statement, 'On the map: daily sea surface temperature anomaly.');
  assert.equal(link.source, 'NASA GIBS, GHRSST MUR sea surface temperature anomaly');
  assert.match(link.sourceUrl, /^https:\/\/www\.earthdata\.nasa\.gov\//);
  assert.equal(link.dateLine, 'Observed 2026-11-08');
  assert.equal(link.note, undefined);
  assert.equal(link.figure, undefined, 'the map is the figure');
  assert.equal(nodeOf(view, 'pattern').mark, 'on map');
  // The technical section links the same product page.
  assert.ok(read('../src/ui/map-technical-information.ts').includes(link.sourceUrl));
  // A frame whose date the provider did not state says so and prints no date.
  const undated = linkOf(buildEnsoChain(input({ surface: { status: 'ready', date: null } })), 'pattern');
  assert.equal(undated.status, 'ready');
  assert.equal(undated.dateLine, null);
  assert.match(undated.note, /did not state this frame's date/);
});

test('pattern link: each layer state that holds no read is its own state', () => {
  const cases = [
    ['loading', 'loading', 'loading...', undefined],
    ['degraded', 'partial', 'partial', undefined],
    ['error', 'unavailable', 'unavailable', undefined],
    ['no-data', 'idle', 'no data', 'no data'],
    ['zoom-in', 'idle', 'zoom in', 'zoom in to load'],
    [null, 'idle', 'not shown', 'not shown']
  ];
  const notes = new Set();
  for (const [layerStatus, status, mark, idleWord] of cases) {
    const view = buildEnsoChain(input({ surface: { status: layerStatus, date: '2026-11-08' } }));
    assertNoRead(view, 'pattern', status, `pattern ${layerStatus}`);
    assert.equal(nodeOf(view, 'pattern').mark, mark, `pattern ${layerStatus}: mark`);
    assert.equal(linkOf(view, 'pattern').idleWord, idleWord, `pattern ${layerStatus}: idle word`);
    notes.add(linkOf(view, 'pattern').note);
  }
  assert.equal(notes.size, cases.length, 'six states, six reasons');
  // The card carries the canonical six-state words in full.
  const partial = drawnLink(buildEnsoChain(input({ surface: { status: 'degraded', date: null } })), 'pattern');
  assert.match(partial, /impact-hazard-pill-partial">live \(partial\)</);
  const failed = buildEnsoChain(input({ surface: { status: 'error', date: null } }));
  assert.match(drawnLink(failed, 'pattern'), /impact-hazard-pill-unavailable">unavailable</);
  assert.match(linkOf(failed, 'pattern').note, /Nothing is inferred about the ocean from a failed request/);
  assert.match(drawnLink(buildEnsoChain(input({ surface: { status: 'zoom-in', date: null } })), 'pattern'), /class="impact-hazard-pill">zoom in to load</);
});

test('jet link: off until asked for, and then model guidance on its own two clocks', () => {
  // Not asked for: idle in plain words, never `unavailable`.
  const idle = [
    [JET_OFF, /No model overlay is drawn now\.$/],
    [{ kind: 'off', status: 'off', label: 'Off', line: 'Overlay off', notes: [] }, /No model overlay is drawn now\.$/],
    [{ kind: 'wind', status: 'live', label: 'Atmospheric currents', line: 'live', notes: [] }, /The overlay drawn now is Atmospheric currents\.$/],
    [{ kind: 'waves', status: 'live (partial)', label: 'Ocean waves', line: 'live (partial)', notes: [] }, /The overlay drawn now is Ocean waves\.$/],
    // Another kind that is loading, or that failed, was chosen and is not on the map: the link never says it is drawn.
    [{ kind: 'pwat', status: 'loading', label: 'Precipitable water', line: 'loading', notes: [] }, /The overlay chosen now is Precipitable water\.$/],
    [{ kind: 'wind', status: 'unavailable', label: 'Atmospheric currents', line: 'unavailable', notes: [] }, /The overlay chosen now is Atmospheric currents\.$/],
    [{ kind: 'currents', status: 'no data', label: 'Ocean currents', line: 'no data', notes: [] }, /The overlay chosen now is Ocean currents\.$/],
    // A snapshot that names no kind (an older publisher) still says only what its status supports.
    [{ kind: null, status: 'live', label: 'Atmospheric currents', line: 'live', notes: [] }, /The overlay drawn now is Atmospheric currents\.$/]
  ];
  for (const [jet, drawn] of idle) {
    const view = buildEnsoChain(input({ jet }));
    assertNoRead(view, 'jet', 'idle', `jet idle (${jet.kind}, ${jet.status})`);
    assert.doesNotMatch(linkOf(view, 'jet').note, jet.status === 'live' || jet.status === 'live (partial)' ? /chosen now/ : /drawn now is/);
    const link = linkOf(view, 'jet');
    assert.equal(link.idleWord, 'not shown');
    assert.match(link.note, /^Press to draw NOAA GFS 250 hPa wind on the map as model guidance\./);
    assert.match(link.note, drawn);
    assert.equal(nodeOf(view, 'jet').mark, 'not shown');
    assert.match(drawnLink(view, 'jet'), /class="impact-hazard-pill">not shown</);
  }

  const view = buildEnsoChain(input());
  const link = linkOf(view, 'jet');
  assert.equal(link.status, 'ready');
  assert.equal(link.evidence, 'modeled');
  assert.equal(link.source, FLOW_WORDS.source.jet);
  assert.equal(link.statement, 'On the map: NOAA GFS 250 hPa wind.');
  assert.equal(link.dateLine, `Model run ${dateLabel(CYCLE)} · Model valid ${dateLabel(VALID)}`);
  // The two clocks are the overlay's own line, as data: the same words the panel prints.
  assert.ok(JET_LIVE.line.endsWith(link.dateLine));
  assert.match(link.note, /Model output at one instant, not an observation/);
  assert.equal(link.title, 'Jet and storm track (model guidance)');
  assert.equal(nodeOf(view, 'jet').mark, 'on map');
  assert.equal(nodeOf(view, 'jet').evidence, 'modeled');
  // A drawn frame with no clocks handed over prints no date; it never borrows another link's.
  const { cycle: _cycle, valid: _valid, ...clockless } = JET_LIVE;
  assert.equal(linkOf(buildEnsoChain(input({ jet: clockless })), 'jet').dateLine, null);
});

test('jet link: loading, partial, unavailable and no data keep the overlay\'s own reason', () => {
  const failedLine = `unavailable · ${FLOW_WORDS.unavailable.jet}`;
  const failedNote = 'No direction or calm condition is inferred from a failed request.';
  const cases = [
    [{ kind: 'jet', status: 'loading', label: 'Jet-level wind', line: `loading · ${FLOW_WORDS.source.jet}`, notes: [] }, 'loading', 'loading...'],
    [{ kind: 'jet', status: 'loading', label: 'Jet-level wind', line: '', notes: [] }, 'loading', 'loading...'],
    [{ kind: 'jet', status: 'live (partial)', label: 'Jet-level wind', line: 'live (partial) · part of the view', notes: ['A part is not covered.'] }, 'partial', 'partial'],
    [{ kind: 'jet', status: 'unavailable', label: 'Jet-level wind', line: failedLine, notes: [failedNote] }, 'unavailable', 'unavailable'],
    [{ kind: 'jet', status: 'no data', label: 'Jet-level wind', line: `no data · ${FLOW_WORDS.noOcean}`, notes: [FLOW_WORDS.mask] }, 'idle', 'no data']
  ];
  for (const [jet, status, mark] of cases) {
    const view = buildEnsoChain(input({ jet }));
    const label = `jet ${jet.status}`;
    const link = linkOf(view, 'jet');
    assert.equal(link.status, status, label);
    for (const field of ['statement', 'figure', 'evidence', 'source']) assert.equal(link[field], undefined, `${label}: no ${field}`);
    assert.ok(link.note.length > 0, `${label}: says why`);
    assert.equal(nodeOf(view, 'jet').mark, mark, label);
    assert.equal(nodeOf(view, 'jet').evidence, undefined, label);
    const item = drawnLink(view, 'jet');
    assert.equal(count(item, 'evidence-chain-statement') + count(item, '<svg') + count(item, 'impact-claim-badge'), 0, label);
  }
  const down = linkOf(buildEnsoChain(input({ jet: cases[3][0] })), 'jet');
  // The overlay's failure words arrive whole, with its refusal to infer. Its
  // line opens with the status word the pill already says, so the reason
  // starts after it and the word is on the card once.
  assert.equal(down.note, `${FLOW_WORDS.unavailable.jet}. ${failedNote}`);
  assert.doesNotMatch(down.note, /^unavailable/);
  const noData = linkOf(buildEnsoChain(input({ jet: cases[4][0] })), 'jet');
  assert.equal(noData.idleWord, 'no data');
  assert.equal(noData.note, `${FLOW_WORDS.noOcean}. ${FLOW_WORDS.mask}`);
  assert.equal(linkOf(buildEnsoChain(input({ jet: cases[2][0] })), 'jet').note, 'part of the view. A part is not covered.');
  for (const index of [0, 1]) {
    assert.equal(linkOf(buildEnsoChain(input({ jet: cases[index][0] })), 'jet').note, `Loading ${FLOW_WORDS.source.jet}.`);
  }
  // A line with no status lead, and a reason with no closing stop, are kept whole and closed.
  const odd = { kind: 'jet', status: 'unavailable', label: 'Jet-level wind', line: 'The held frame is past its limit', notes: [] };
  assert.equal(linkOf(buildEnsoChain(input({ jet: odd })), 'jet').note, 'The held frame is past its limit.');
});

test('place links: with no place chosen both are idle and their press chooses a place', () => {
  for (const place of [null, WA]) {
    const view = buildEnsoChain(input({ place, outlook: { status: 'none' }, here: { status: 'none' } }));
    for (const key of ['tendency', 'here']) {
      assertNoRead(view, key, 'idle', `${key} with no read at ${place ? place.label : 'no place'}`);
      const link = linkOf(view, key);
      assert.equal(link.idleWord, 'no place chosen');
      assert.equal(link.action, 'place');
      assert.equal(link.actionLabel, 'Choose a place');
      assert.match(link.note, /^Choose a place to read .+ there\.$/);
      assert.equal(nodeOf(view, key).mark, 'no place');
      assert.match(drawnLink(view, key), /class="impact-hazard-pill">no place chosen</);
    }
  }
  // A read with no place in hand is not shown as that place's read.
  const orphan = buildEnsoChain(input({ place: null }));
  assert.equal(linkOf(orphan, 'tendency').status, 'idle');
  assert.equal(linkOf(orphan, 'here').status, 'idle');
});

test('place links: loading and unavailable name the place and keep the source\'s reason', () => {
  const loading = buildEnsoChain(input({ outlook: { status: 'loading' }, here: { status: 'loading' } }));
  const down = buildEnsoChain(
    input({
      outlook: { status: 'unavailable', note: 'The NOAA CPC seasonal temperature outlook returned no reading for this point.' },
      here: { status: 'unavailable', note: 'This source did not respond.' }
    })
  );
  for (const key of ['tendency', 'here']) {
    assertNoRead(loading, key, 'loading', `${key} loading`);
    assert.match(linkOf(loading, key).note, /^Reading .+ at Washington\.$/);
    assertNoRead(down, key, 'unavailable', `${key} unavailable`);
    // The press still takes the map to the link's own view.
    assert.equal(linkOf(loading, key).action, key);
    assert.equal(linkOf(down, key).action, key);
  }
  assert.equal(linkOf(down, 'tendency').note, 'The NOAA CPC seasonal temperature outlook returned no reading for this point.');
  assert.equal(linkOf(down, 'here').note, 'This source did not respond.');
});

test('tendency link: the outlook is the issuer\'s tercile at the place, and denies being an ENSO forecast', () => {
  const words = { Above: 'above-normal', Below: 'below-normal', Normal: 'near-normal' };
  for (const [cat, word] of Object.entries(words)) {
    const view = buildEnsoChain(input({ outlook: { status: 'ready', claim: outlookClaim(tercile(cat, 40)) } }));
    const link = linkOf(view, 'tendency');
    assert.equal(link.status, 'ready');
    assert.equal(link.statement, `40% chance of ${word} temperature, Sep-Oct-Nov 2026, at a point inside Washington.`);
    assert.equal(link.evidence, 'outlook');
    assert.equal(link.source, 'NOAA Climate Prediction Center seasonal temperature outlook');
    assert.equal(link.dateLine, 'Issued 2026-09-01');
    assert.equal(link.note, 'A NOAA Climate Prediction Center seasonal outlook that ENSO informs, not an ENSO forecast.');
    assert.equal(link.title, 'Seasonal outlook here');
    assert.equal(link.action, 'tendency');
    assert.equal(nodeOf(view, 'tendency').mark, '40%');
    assert.equal(nodeOf(view, 'tendency').evidence, 'outlook');
  }
  // Equal Chances is a read with no favored tercile, and prints no probability.
  const equal = buildEnsoChain(input({ outlook: { status: 'ready', claim: outlookClaim(tercile('EC', 33)) } }));
  assert.equal(linkOf(equal, 'tendency').statement, 'Equal Chances (no favored tercile), Sep-Oct-Nov 2026, at a point inside Washington.');
  assert.equal(nodeOf(equal, 'tendency').mark, 'EC');
  // A click is named as a click.
  const clicked = buildEnsoChain(input({ place: { label: 'Selected point', inside: false } }));
  assert.match(linkOf(clicked, 'tendency').statement, /, at the clicked point \(Selected point\)\.$/);
  assert.match(linkOf(clicked, 'here').statement, /, at the clicked point \(Selected point\)\.$/);
  // A claim with no typed reading is never cut out of its sentence.
  const untyped = buildEnsoChain(input({ outlook: { status: 'ready', claim: outlookClaim(null) } }));
  assert.equal(linkOf(untyped, 'tendency').statement, undefined);
  assert.match(linkOf(untyped, 'tendency').note, /stated in that place's briefing/);
  assert.equal(nodeOf(untyped, 'tendency').mark, 'read');
  assert.equal(linkOf(untyped, 'tendency').source, 'NOAA Climate Prediction Center seasonal temperature outlook');
});

test('tendency link: when its press draws another outlook than it reads, the link says which', () => {
  // Today's tables: the mode's seasonal horizon adds the precipitation outlook, and the link reads temperature.
  const recipes = HAZARD_CLUSTERS.enso.recipes;
  const adds = recipes['season-ahead'].filter((key) => !recipes.current.includes(key));
  assert.deepEqual(adds, ['cpc-seasonal-precip']);
  assert.equal(PRODUCTS.cpcSeasonalTemp.layerKey, 'cpc-seasonal-temp');
  assert.equal(adds.includes(PRODUCTS.cpcSeasonalTemp.layerKey), false, 'the press does not draw the outlook the link reads');
  const names = adds.map((key) => getLayerDef(key).name);
  assert.deepEqual(names, ['Seasonal Precipitation Outlook']);
  // The host derives exactly that from the same tables, never from a typed name.
  const host = code('../src/ui/enso-chain.ts');
  assert.match(host, /HAZARD_CLUSTERS\.enso\.recipes\[\s*'season-ahead'\s*\]/);
  assert.match(host, /PRODUCTS\[outlook\.claim\.product\]\.layerKey/);
  assert.doesNotMatch(host, /Seasonal Precipitation Outlook|cpc-seasonal-precip/);

  const view = buildEnsoChain(input({ seasonDraws: names }));
  const link = linkOf(view, 'tendency');
  assert.equal(link.statement, '50% chance of above-normal temperature, Sep-Oct-Nov 2026, at a point inside Washington.');
  assert.equal(
    link.note,
    'A NOAA Climate Prediction Center seasonal outlook that ENSO informs, not an ENSO forecast. ' +
      'Pressing this link shows the Seasonal Precipitation Outlook on the map; the temperature read above is a separate layer.'
  );
  assert.equal(link.actionLabel, 'Show the Seasonal Precipitation Outlook on the map');
  assert.match(drawnLink(view, 'tendency'), /aria-label="Seasonal outlook here\. Show the Seasonal Precipitation Outlook on the map"/);
  // Two layers are both named; none, and the map draws what the link states, so nothing is added.
  const two = linkOf(buildEnsoChain(input({ seasonDraws: ['A Outlook', 'B Outlook'] })), 'tendency');
  assert.match(two.note, /shows the A Outlook and B Outlook on the map/);
  for (const seasonDraws of [[], undefined]) {
    const same = linkOf(buildEnsoChain(input({ seasonDraws })), 'tendency');
    assert.equal(same.note, 'A NOAA Climate Prediction Center seasonal outlook that ENSO informs, not an ENSO forecast.');
    assert.equal(same.actionLabel, 'Show the seasonal outlook on the map');
  }
  // A link with no read states no outlook, so it has nothing to keep apart; its press is still named for the map.
  const loading = linkOf(buildEnsoChain(input({ outlook: { status: 'loading' }, seasonDraws: names })), 'tendency');
  assert.doesNotMatch(loading.note, /separate layer/);
  assert.equal(loading.actionLabel, 'Show the Seasonal Precipitation Outlook on the map');
});

test('here link: the drought category is marked on the issuer scale; no polygon is not an all-clear', () => {
  for (let dm = 0; dm < 5; dm += 1) {
    const view = buildEnsoChain(input({ here: { status: 'ready', claim: usdmClaim({ kind: 'usdm-category', dm }) } }));
    const link = linkOf(view, 'here');
    const category = USDM_CATEGORIES[dm];
    assert.equal(link.status, 'ready');
    assert.equal(link.statement, `${category.code} ${category.label}, at a point inside Washington.`);
    assert.equal(link.evidence, 'analyzed');
    assert.equal(link.source, 'U.S. Drought Monitor (NDMC / NOAA / USDA)');
    assert.equal(link.dateLine, 'Valid 2026-11-05');
    assert.equal(link.note, undefined);
    assert.equal(count(link.figure, 'class="g-caret"'), 1, `D${dm}: one caret`);
    assert.match(link.figure, new RegExp(`class="g-seg g-read" fill="${category.color}"`), `D${dm}: the read block`);
    assert.equal(link.action, 'here');
    assert.equal(nodeOf(view, 'here').mark, `D${dm}`);
  }
  const none = buildEnsoChain(input({ here: { status: 'ready', claim: usdmClaim({ kind: 'usdm-category', dm: null }) } }));
  const link = linkOf(none, 'here');
  assert.equal(link.status, 'ready');
  assert.equal(link.statement, `${USDM_NONE_SWATCH.label}, at a point inside Washington.`);
  assert.equal(link.note, 'This client has no analyzed-area mask, so this does not confirm no drought.');
  // The marked position is the no-class slot, never D0 and never a colour.
  assert.match(link.figure, /class="g-slot g-read"/);
  assert.doesNotMatch(link.figure, /class="g-seg g-read"/);
  // The overview node never says a bare "none" under "Here": that would read as an all-clear.
  assert.equal(nodeOf(none, 'here').mark, 'no D0-D4');
  assert.match(ensoStripSvg(none.strip), /Here: no D0-D4, analyzed/);
  const untyped = buildEnsoChain(input({ here: { status: 'ready', claim: usdmClaim(null) } }));
  assert.equal(linkOf(untyped, 'here').statement, undefined);
  assert.equal(linkOf(untyped, 'here').figure, undefined);
  assert.match(linkOf(untyped, 'here').note, /stated in that place's briefing/);
});

test('every link holds its own source and clock: no two read links share a date line', () => {
  const view = buildEnsoChain(input());
  const dates = view.links.map((link) => link.dateLine);
  assert.equal(new Set(dates).size, 5, dates.join(' | '));
  assert.equal(new Set(view.links.map((link) => link.source)).size, 5);
  assert.deepEqual(view.links.map((link) => link.evidence), [
    fresh.claims.find((candidate) => candidate.product === 'ensoIndex').evidence,
    'analyzed',
    'modeled',
    'outlook',
    'analyzed'
  ]);
  const html = draw(view);
  assert.equal(count(html, 'impact-claim-badge'), 5, 'each read link wears its own badge');
  assert.equal(count(html, 'class="impact-claim-date"'), 5, 'each read link prints its own date');
  assert.doesNotMatch(html, EVIDENCE_CLASS_NAME);
});

// ---------------------------------------------------------------------------
// 5. The overview strip
// ---------------------------------------------------------------------------

test('the overview strip draws a read as a disc in its evidence tier and no read as an open square', () => {
  const view = buildEnsoChain(input());
  const svg = ensoStripSvg(view.strip);
  assert.match(svg, /^<svg class="enso-strip"[^>]* role="img" aria-label="The five links at a glance\. /);
  assert.equal(count(svg, '<circle class="s-node'), 5, 'five reads, five discs');
  assert.equal(count(svg, 's-node-open'), 0);
  // Model guidance and the outlook are dashed; nothing here is an observation, so nothing is a filled plate.
  const tiers = [...svg.matchAll(/<circle class="s-node s-node-(\w+)"/g)].map((m) => m[1]);
  const tierOf = (evidence) => (evidence === 'observed' ? 'plate' : evidence === 'modeled' || evidence === 'modeled-analysis' || evidence === 'outlook' ? 'dashed' : 'keyline');
  assert.deepEqual(tiers, view.strip.map((node) => tierOf(node.evidence)));
  assert.equal(tiers[2], 'dashed', 'the jet is model guidance');
  assert.equal(tiers[3], 'dashed', 'the season is an outlook');
  assert.equal(count(svg, 's-node-plate'), 0);
  // One plain rail: a single horizontal stroke, no arrowhead, no direction, nothing that moves.
  assert.equal(count(svg, 'class="s-rail"'), 1);
  assert.match(svg, /<path class="s-rail" d="M[\d.]+ [\d.]+H[\d.]+"\/>/);
  assert.doesNotMatch(svg, /<marker|<polygon|<animate|marker-end|[←-⇿⟵-⟿➔➜]/);
  // The text alternative says every node's word, mark and evidence class.
  const label = /aria-label="([^"]*)"/.exec(svg)[1];
  for (const node of view.strip) assert.ok(label.includes(`${node.word}: ${node.mark}`), `${node.word} in the label`);
  assert.match(label, /Jet: on map, modeled/);
  assert.match(label, /Season: 50%, outlook/);

  // An observation would wear the filled plate, and only an observation.
  const observed = ensoStripSvg([{ key: 'here', word: 'Here', status: 'ready', mark: 'D2', evidence: 'observed' }]);
  assert.equal(count(observed, 's-node-plate'), 1);

  const none = buildEnsoChain({
    enso: { status: 'unavailable', note: 'The ENSO index snapshot was unavailable.' },
    surface: { status: 'degraded', date: null },
    jet: JET_OFF,
    place: null,
    outlook: { status: 'none' },
    here: { status: 'none' }
  });
  const unread = ensoStripSvg(none.strip);
  assert.equal(count(unread, '<circle'), 0, 'no read, no disc');
  assert.equal(count(unread, 's-node-open'), 5, 'five open squares');
  assert.equal(count(unread, 'class="s-read"'), 0, 'no value under any node');
  assert.equal(count(unread, 'class="s-state"'), 5);
  assert.equal(count(unread, 'class="s-mark"'), 1, 'unavailable wears the slash');
  assert.equal(count(unread, 'class="s-fill"'), 1, 'partial wears the half fill');
  assert.deepEqual(none.strip.map((node) => node.mark), ['unavailable', 'partial', 'not shown', 'no place', 'no place']);
  for (const node of none.strip) assert.ok(STATE_MARKS.has(node.mark));
  // The card under the strip always carries the full word.
  assert.equal(linkOf(none, 'tendency').idleWord, 'no place chosen');
  assert.match(drawnLink(none, 'pattern'), />live \(partial\)</);
  // Whatever it is handed is escaped.
  assert.doesNotMatch(ensoStripSvg([{ key: 'index', word: '<b>', status: 'ready', mark: '"<i>' }]), /<b>|<i>/);
});

// ---------------------------------------------------------------------------
// 6. The nested truth
// ---------------------------------------------------------------------------

test('the nested truth is the governed words, closed at first with the denial on its summary', () => {
  assert.equal(ENSO_TRUTH_SUMMARY, 'This is a shift in the odds, not a forecast.');
  assert.ok(ENSO_NESTED_TRUTH.odds.startsWith(`${ENSO_NESTED_TRUTH.lead}: `), 'the lead is the odds sentence\'s own first clause');
  for (const driver of ['Pacific Decadal Oscillation', 'event strength and timing', 'intraseasonal variability']) {
    assert.ok(ENSO_NESTED_TRUTH.odds.includes(driver), driver);
  }
  // NOAA CPC's sentence is the one the technical section quotes, with the same link and name.
  const technical = read('../src/ui/map-technical-information.ts');
  assert.ok(technical.includes(`"${ENSO_NESTED_TRUTH.events}"`), 'the quotation is the technical section\'s, word for word');
  assert.ok(technical.includes(`href="${ENSO_NESTED_TRUTH.eventsUrl}"`));
  assert.ok(technical.includes(`>${ENSO_NESTED_TRUTH.eventsSource}</a>`));

  for (const enso of [{ status: 'loading' }, { status: 'unavailable', note: 'down' }]) {
    const html = renderEnsoTruth(enso);
    assert.match(html, /^<details class="enso-truth"><summary class="enso-truth-summary">/, 'closed at first');
    assert.doesNotMatch(html, /<details[^>]* open/);
    assert.ok(html.includes(`<span class="enso-truth-lead">${ENSO_TRUTH_SUMMARY}</span>`));
    // With no claims in hand the odds sentence and the quotation still stand.
    assert.equal(count(html, ENSO_NESTED_TRUTH.odds), 1);
    assert.ok(html.includes(ENSO_NESTED_TRUTH.events));
    assert.ok(html.includes(`<a href="${ENSO_NESTED_TRUTH.eventsUrl}" target="_blank" rel="noopener">${ENSO_NESTED_TRUTH.eventsSource}</a>`));
    assert.equal(count(html, 'class="enso-truth-claim"'), 0);
    assert.match(html, /<button type="button" class="enso-truth-door" data-enso-door="technical">Technical information<\/button>/);
  }

  const html = renderEnsoTruth({ status: 'ready', claims: fresh.claims });
  const tendency = fresh.claims.find((candidate) => candidate.product === 'ensoTendency');
  const index = fresh.claims.find((candidate) => candidate.product === 'ensoIndex');
  assert.ok(tendency && index, 'the snapshot yields a tendency claim and an index claim');
  // The tendency claim ends with the odds sentence, so it is on the page once.
  assert.ok(tendency.text.endsWith(ENSO_NESTED_TRUTH.odds));
  assert.equal(count(html, ENSO_NESTED_TRUTH.odds), 1);
  for (const claim of [tendency, index]) {
    assert.ok(html.includes(`data-evidence="${claim.evidence}" data-truth-claim="${claim.product}"`), claim.product);
    assert.ok(html.includes(claimDateLine(claim)), `${claim.product}: dated`);
  }
  assert.ok(count(html, 'class="enso-truth-claim"') >= 2);
  assert.equal(count(html, 'class="enso-truth-source">Source: '), count(html, 'class="enso-truth-claim"'), 'every block names its source');
  assert.equal(count(html, 'impact-claim-badge'), count(html, 'class="enso-truth-claim"'), 'every block wears its evidence class');
  assert.doesNotMatch(html, EVIDENCE_CLASS_NAME);
});

// ---------------------------------------------------------------------------
// 7. Structure: class names, tokens, state and laziness
// ---------------------------------------------------------------------------

test('the chain never wears the full detail claim class names', () => {
  for (const path of ['../src/ui/enso-chain-model.ts', '../src/ui/enso-chain.ts', '../src/ui/enso-chain-loader.ts']) {
    const source = code(path);
    assert.doesNotMatch(source, /cssClass/, `${path} reads no evidence cssClass`);
    assert.doesNotMatch(source, EVIDENCE_CLASS_NAME, `${path} writes no claim class name`);
  }
  const sheet = read('../src/styles/enso-chain.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(sheet, EVIDENCE_CLASS_NAME, 'the stylesheet selects no claim class name');
});

test('the chain stylesheet takes colour and corners from tokens, and moves nothing', () => {
  const sheet = read('../src/styles/enso-chain.css').replace(/\/\*[\s\S]*?\*\//g, '');
  // Colour belongs to the data: no literal colour, so no new hue can arrive here.
  assert.doesNotMatch(sheet, /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(|\bcolor-mix\(/, 'no literal colour');
  // Corners come from the radius tokens; nothing is a pill or a circle.
  const radii = [...sheet.matchAll(/border-radius:\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.ok(radii.length > 0);
  for (const radius of radii) {
    assert.match(radius, /^var\(--(?:radius-sm|radius-md|glass-radius)\)$/, `border-radius: ${radius}`);
  }
  // Even outlines: no rule gives one side its own border width.
  assert.doesNotMatch(sheet, /border-(?:top|right|bottom|left)-width|border-(?:left|right):\s*[2-9]/);
  // Nothing moves, so reduced motion has nothing to switch off.
  assert.doesNotMatch(sheet, /\btransition\b|\banimation\b|@keyframes/);
  // A control that is on inverts: the open disclosure wears the selected face and sets the focus inset.
  const open = /\.enso-truth\[open\] > \.enso-truth-summary \{([^}]*)\}/.exec(sheet);
  assert.ok(open, 'a rule for the open disclosure');
  assert.match(open[1], /--selection-shadow: var\(--selected-focus-inset\);/);
  assert.match(open[1], /background: var\(--face-selected\);/);
  assert.match(open[1], /color: var\(--ink-on-selected\);/);
});

test('the presses go through existing doors: the host writes no history and parses no link', () => {
  const host = code('../src/ui/enso-chain.ts');
  assert.doesNotMatch(host, /pushState|replaceState|location\.(?:search|href|hash)\s*=|URLSearchParams|replaceQuery|syncUrl/);
  for (const door of ['requestOcean', 'requestHorizon', 'requestCluster', 'requestEnsoFlowKind', 'enterPlaceStudio', 'openImpactPanel', 'openTechnicalInformation']) {
    // Once in its import and at least once where a press uses it.
    assert.ok(count(host, door) >= 2, `${door} is imported and used`);
  }
  assert.match(host, /from '\.\.\/state\/cluster-service'/);
  assert.match(host, /from '\.\.\/layers\/enso-flow'/);
  assert.match(host, /from '\.\.\/state\/studio-route'/);
  // The guide's open state is presentation: an attribute on #app, never a link token.
  assert.match(host, /'data-enso-guide'/);
  assert.equal(read('../src/state/url.ts').includes('enso-guide'), false);
});

test('the chain is lazy: the layer holds only its loader, and the loader imports it dynamically', () => {
  const loader = code('../src/ui/enso-chain-loader.ts');
  assert.match(loader, /import\('\.\/enso-chain'\)/, 'a dynamic import');
  assert.doesNotMatch(loader, /^import (?!type )[^\n]*from '\.\/enso-chain'/m, 'no static import of the chain');
  assert.doesNotMatch(loader, /\.css'/, 'the loader carries no stylesheet');
  // An embed loads nothing.
  assert.match(loader, /classList\.contains\('embed'\)/);
  const layer = code('../src/layers/sst-anomaly.ts');
  assert.match(layer, /from '\.\.\/ui\/enso-chain-loader'/);
  assert.doesNotMatch(layer, /from '\.\.\/ui\/enso-chain(?:-model)?'/, 'the layer never imports the chain itself');
  // The briefing's source functions load only when a place is chosen; the
  // policy that gates them is a static import (a dynamic one made it a chunk
  // of its own and moved three small modules out of the entry chunk).
  const host = code('../src/ui/enso-chain.ts');
  assert.match(host, /import\('\.\.\/impact\/sources'\)/);
  assert.doesNotMatch(host, /import\('\.\.\/impact\/source-policy'\)/);
  assert.match(host, /^import \{ briefingSourcePolicy, sourceMayRun \} from '\.\.\/impact\/source-policy';$/m);
  // Nothing outside the chain's own modules imports it statically.
  for (const path of ['../src/main.ts', '../src/ui/sidebar.ts', '../src/ui/mobile-sheet.ts', '../src/ui/edge-column.ts', '../src/ui/sheet-motion.ts']) {
    assert.doesNotMatch(code(path), /enso-chain(?:-model|-loader)?'/, `${path} does not import the chain`);
  }
});

test('the two place links ask their sources only once the panel is on screen, and once per place', () => {
  const host = code('../src/ui/enso-chain.ts');
  const body = (name) => {
    const start = host.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} exists`);
    const next = host.indexOf('\nfunction ', start + 1);
    return host.slice(start, next < 0 ? undefined : next);
  };
  // Taking a selection asks nothing by itself: it marks the place unread and
  // reads only when the panel is on screen.
  const take = body('setPlace');
  assert.match(take, /state\.placeController\?\.abort\(\);/, 'a new selection cancels the last read');
  assert.match(take, /state\.placeUnread = true;/);
  assert.match(take, /if \(state\.onScreen\) readPlace\(state\);/);
  assert.doesNotMatch(take, /import\(|fetch[A-Z]|briefingSourcePolicy/, 'taking a selection asks nothing');
  // The read spends the unread mark before it asks, so one place is read once
  // however often the panel comes and goes.
  const readFn = body('readPlace');
  assert.match(readFn, /if \(!state\.place \|\| !state\.placeUnread\) return;\s*state\.placeUnread = false;/);
  assert.ok(readFn.indexOf('state.placeUnread = false;') < readFn.indexOf("import('../impact/sources')"), 'spent before the sources load');
  // On screen is the browser's own answer for the panel, dropped when the chain leaves.
  assert.match(host, /new IntersectionObserver\(/);
  assert.match(host, /state\.onScreen = last\.isIntersecting;\s*if \(state\.onScreen\) readPlace\(state\);/);
  assert.match(host, /seen\.observe\(panel\);\s*state\.offs\.push\(\(\) => seen\.disconnect\(\)\);/);
  // The selection in force at mount and every later one go through the same gate.
  assert.equal(count(host, 'readPlace(state)'), 3, 'three callers: a selection, the panel coming on screen, focus inside it');
  assert.match(host, /onPlaceSelectionChange\(\(selection\) => setPlace\(state, selection\)\)/);
  assert.match(host, /setPlace\(state, getPlaceSelection\(\)\);/);
});

// ---------------------------------------------------------------------------
// 9. Five doors in the phone column
// ---------------------------------------------------------------------------

test('the Guide door makes five doors, and the planner fits five at every phone viewport', () => {
  // The door rides the panel group, after the four doors (order 10 is the doors' own seat).
  const host = code('../src/ui/enso-chain.ts');
  assert.match(host, /seatEdgeControl\(door, \{ group: 'panels', order: 20 \}\)/);
  assert.match(code('../src/ui/edge-column.ts'), /phone: \{ group: 'panels', order: 10 \}/);

  const plan = (viewportWidth, viewportHeight, utility) =>
    planEdgeColumn({
      availableHeight: viewportHeight - 2 * EDGE_COLUMN_TOKENS.inset,
      viewportWidth,
      viewportHeight,
      // Map information waits while a panel is open, so the map tools are three or two.
      groups: [
        { id: 'utility', count: utility },
        { id: 'panels', count: 5 },
        { id: 'hazards', count: 4 },
        { id: 'view', count: 1 }
      ],
      badge: true
    });
  const expected = [
    [320, 568, 44, 1, ['utility']],
    [360, 640, 44, 1, []],
    [375, 553, 44, 1, ['utility']],
    [375, 667, 44, 1, []],
    [390, 844, 52, 1, []],
    [412, 915, 52, 1, []],
    [667, 375, 44, 2, []]
  ];
  for (const [width, height, size, tracks, folded] of expected) {
    for (const utility of [3, 2]) {
      const got = plan(width, height, utility);
      const where = `${width}x${height}, ${utility} map tools`;
      assert.equal(got.fits, true, `five doors fit at ${where}`);
      assert.ok(got.size >= EDGE_COLUMN_TOKENS.minTarget, `44 px cells at ${where}`);
      assert.equal(got.tracks.flat().includes('panels'), true, `the doors are placed at ${where}`);
      // The doors themselves are never folded at these sizes: the Guide door is one press away.
      assert.equal(got.folded.includes('panels'), false, `the doors are not folded at ${where}`);
      if (utility === 3) assert.deepEqual([got.size, got.tracks.length, got.folded], [size, tracks, folded], where);
    }
  }
  // Across every phone height the plan with five doors fits or is the last arrangement and says so.
  for (const width of [320, 360, 375, 390, 412, 667, 720]) {
    for (let height = 240; height <= 1000; height += 1) {
      const got = plan(width, height, 3);
      assert.ok(got.size >= 44);
      if (!got.fits) assert.equal(got.tracks.length, 2, `gave up before two tracks at ${width}x${height}`);
    }
  }
});
