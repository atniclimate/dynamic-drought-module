import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The briefing's gauge family and the shared evidence chain (owner direction
 * 2026-11-09 (sprint), DR-pending): src/ui/gauges.ts and
 * src/ui/evidence-chain.ts, driven as the pure string builders they are.
 *
 * What is proven here:
 *   1. a read class is marked by position and an ink keyline (exactly one
 *      caret, exactly one keylined block), on the issuer's own colours in the
 *      issuer's own order;
 *   2. a figure with no read draws no marker, no value and no issuer colour:
 *      `loading`, `unavailable` and `no-data` are three different drawings,
 *      and none of them is a zero;
 *   3. the chain draws at most five links, keeps a link with no read in its
 *      place under its state word, never prints a statement for it, labels
 *      its joints as relationships and draws no arrow.
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
  HEATRISK_SCALE,
  READ_STATE_WORD,
  USDM_NONE_SLOT,
  USDM_SCALE,
  classGaugeSvg,
  dayStripSvg,
  indexGaugeSvg,
  spcCategoryCell
} = await import('../src/ui/gauges.ts');
const { CHAIN_MAX_LINKS, chainFieldsFromClaim, renderEvidenceChain } = await import(
  '../src/ui/evidence-chain.ts'
);
const { HEATRISK_CATEGORIES, SPC_FIREWX_CATEGORIES, USDM_CATEGORIES } = await import(
  '../src/config/palette.ts'
);

const count = (html, needle) => html.split(needle).length - 1;
const fills = (html) => [...html.matchAll(/fill="(#[0-9A-Fa-f]{6})"/g)].map((m) => m[1]);

test('the scales are the issuer tables, lowest class first', () => {
  assert.deepEqual(USDM_SCALE.map((c) => [c.tick, c.color]), USDM_CATEGORIES.map((c) => [c.code, c.color]));
  assert.deepEqual(
    HEATRISK_SCALE.map((c) => [c.tick, c.color]),
    HEATRISK_CATEGORIES.map((c) => [String(c.value), c.color])
  );
  assert.deepEqual(READ_STATE_WORD, {
    loading: 'loading...',
    ready: 'live',
    partial: 'live (partial)',
    unavailable: 'unavailable'
  });
});

test('a read class is marked by position and a keyline, on every issuer colour in order', () => {
  for (let dm = 0; dm < 5; dm += 1) {
    const svg = classGaugeSvg({ classes: USDM_SCALE, none: USDM_NONE_SLOT, read: dm, state: 'read', title: `read D${dm}` });
    assert.equal(count(svg, 'class="g-caret"'), 1, `D${dm}: one caret`);
    assert.equal(count(svg, 'g-read'), 1, `D${dm}: one keylined block`);
    assert.equal(count(svg, 'g-tick-read'), 1, `D${dm}: one bold tick`);
    // The whole scale is drawn, in the issuer's colours and order, whichever class is read.
    assert.deepEqual(fills(svg), USDM_CATEGORIES.map((c) => c.color));
    // The marked block is the read class: its colour sits on the keylined rect.
    assert.match(svg, new RegExp(`class="g-seg g-read" fill="${USDM_CATEGORIES[dm].color}"`));
    assert.match(svg, new RegExp(`class="g-tick g-tick-read"[^>]*>D${dm}<`));
    assert.match(svg, /role="img" aria-label="read D\d"/);
    assert.match(svg, /data-gauge-state="read"/);
  }
});

test('the no-class position is a slot of its own, never a class and never colour', () => {
  const svg = classGaugeSvg({ classes: USDM_SCALE, none: USDM_NONE_SLOT, read: 'none', state: 'read', title: 'none' });
  assert.equal(count(svg, 'class="g-caret"'), 1);
  assert.match(svg, /class="g-slot g-read"/);
  assert.doesNotMatch(svg, /class="g-seg g-read"/);
  assert.deepEqual(fills(svg), USDM_CATEGORIES.map((c) => c.color));
  assert.match(svg, /No D0-D4 category drawn/);
});

test('a class gauge with no read draws no marker, no tick and no issuer colour', () => {
  const drawings = {};
  for (const state of ['loading', 'unavailable', 'no-data']) {
    // Even when a caller passes a class by mistake, an unread state marks nothing.
    const svg = classGaugeSvg({ classes: HEATRISK_SCALE, read: 3, state, title: state });
    assert.equal(count(svg, 'g-caret'), 0, `${state}: no caret`);
    assert.equal(count(svg, 'g-read'), 0, `${state}: no keylined block`);
    assert.deepEqual(fills(svg), [], `${state}: no issuer colour`);
    assert.equal(count(svg, 'class="g-tick'), 0, `${state}: no class ticks`);
    assert.equal(count(svg, 'g-seg-empty'), HEATRISK_SCALE.length, `${state}: the scale's outline`);
    assert.match(svg, new RegExp(`data-gauge-state="${state}"`));
    drawings[state] = svg.replace(/aria-label="[^"]*"|<title>[^<]*<\/title>|data-gauge-state="[^"]*"/g, '');
  }
  // Three states, three drawings: the hatch is unavailable's, the short bar is no data's.
  assert.equal(count(drawings.unavailable, 'g-hatch'), 1);
  assert.equal(count(drawings.loading, 'g-hatch') + count(drawings.loading, 'g-nodata'), 0);
  assert.equal(count(drawings['no-data'], 'g-nodata'), 1);
  assert.equal(count(drawings['no-data'], 'g-hatch'), 0);
  assert.notEqual(drawings.loading, drawings.unavailable);
  assert.notEqual(drawings.loading, drawings['no-data']);
  assert.notEqual(drawings.unavailable, drawings['no-data']);
});

test('the index gauge marks the issuer thresholds and holds any value on its axis', () => {
  const read = indexGaugeSvg({ value: 1.69, threshold: 0.5, below: 'La Nina', above: 'El Nino', valueLabel: '+1.69', state: 'read', title: 't' });
  assert.equal(count(read, 'class="g-dot"'), 1);
  assert.match(read, />\+1\.69</);
  assert.match(read, />La Nina -0\.5</);
  assert.match(read, />El Nino \+0\.5</);
  assert.equal(count(read, 'class="g-threshold"'), 2);
  const x = (svg) => Number(/class="g-dot" cx="([\d.]+)"/.exec(svg)[1]);
  // A value past the default range widens the axis instead of pinning the dot to its end.
  const far = indexGaugeSvg({ value: 3.4, threshold: 0.5, below: 'La Nina', above: 'El Nino', state: 'read', title: 't' });
  assert.ok(x(far) < 230 && x(far) > x(read), `dot at ${x(far)}`);
  const cold = indexGaugeSvg({ value: -1.2, threshold: 0.5, below: 'La Nina', above: 'El Nino', state: 'read', title: 't' });
  assert.ok(x(cold) < 120);
  for (const state of ['loading', 'unavailable']) {
    const none = indexGaugeSvg({ value: 1.69, threshold: 0.5, below: 'La Nina', above: 'El Nino', state, title: 't' });
    assert.equal(count(none, 'g-dot'), 0, `${state}: no value dot`);
    assert.equal(count(none, 'g-value'), 0, `${state}: no value`);
  }
  assert.equal(count(indexGaugeSvg({ value: null, threshold: 0.5, below: 'a', above: 'b', state: 'unavailable', title: 't' }), 'g-hatch'), 1);
});

test('the day strip keeps a class, a probability, no area and no read apart', () => {
  const critical = spcCategoryCell(8);
  assert.deepEqual(
    [5, 8, 10].map((dn) => spcCategoryCell(dn).step),
    [1, 2, 3],
    'height steps follow the issuer order'
  );
  assert.equal(critical.color, SPC_FIREWX_CATEGORIES.find((c) => c.dn === 8).color);
  assert.deepEqual(spcCategoryCell(7), { kind: 'unread' }, 'an unknown dn is not read as a class');
  const groups = [
    { caption: 'category', days: [{ tick: 'Day 1', cell: critical, lead: true }, { tick: '2', cell: { kind: 'none' } }] },
    {
      caption: 'probability',
      days: [
        { tick: '3', cell: { kind: 'probability', percent: 40 } },
        { tick: '4', cell: { kind: 'word', word: 'low', label: 'Probability Too Low' } },
        { tick: '5', cell: { kind: 'unread' } }
      ]
    }
  ];
  const svg = dayStripSvg({ groups, state: 'read', title: 't' });
  assert.equal(count(svg, 'class="g-frame'), 5, 'one frame per day');
  assert.equal(count(svg, 'g-caret'), 1, 'one lead day');
  assert.deepEqual(fills(svg), [critical.color], 'only a class wears an issuer colour');
  assert.equal(count(svg, 'g-fill-ink'), 1, 'a probability is neutral ink');
  assert.match(svg, />40%</);
  assert.match(svg, />low</);
  assert.equal(count(svg, 'g-hatch'), 1, 'only the unread day is hatched');
  assert.match(svg, /Day 2: No area drawn/);
  // With no read, every day is unread: no fill, no lead, no value.
  const down = dayStripSvg({ groups, state: 'unavailable', title: 't' });
  assert.deepEqual(fills(down), []);
  assert.equal(count(down, 'g-caret') + count(down, 'g-fill') + count(down, '>40%<'), 0);
  assert.equal(count(down, 'g-hatch'), 5);
  const loading = dayStripSvg({ groups, state: 'loading', title: 't' });
  assert.equal(count(loading, 'g-hatch') + count(loading, 'g-fill') + count(loading, 'g-caret'), 0);
});

const claim = {
  source: 'NOAA CPC',
  sourceUrl: 'https://www.cpc.ncep.noaa.gov/',
  evidence: 'derived',
  dates: { published: '2026-10-03', retrieved: '2026-11-02' }
};

test('a chain link takes its source, date and evidence class from one claim', () => {
  assert.deepEqual(chainFieldsFromClaim(claim), {
    source: 'NOAA CPC',
    sourceUrl: 'https://www.cpc.ncep.noaa.gov/',
    evidence: 'derived',
    dateLine: 'Published 2026-10-03'
  });
});

test('the chain draws each link as its own claim and its joints as relationships', () => {
  const links = [
    { key: 'a', title: 'Observed index', status: 'ready', statement: 'El Nino conditions', relation: 'companion measurement', action: 'detail:enso', actionLabel: 'Open the ENSO detail', ...chainFieldsFromClaim(claim) },
    { key: 'b', title: 'Jet and storm track', status: 'unavailable', statement: 'must not render', note: 'No product is read.', relation: 'informs', ...chainFieldsFromClaim(claim) },
    { key: 'c', title: 'Loading link', status: 'loading', relation: 'read beside' },
    { key: 'd', title: 'Observed here now', status: 'ready', statement: 'D2 Severe drought', source: 'Unsafe link', sourceUrl: 'http://example.org/' }
  ];
  const html = renderEvidenceChain(links, { heading: 'ENSO link', caption: 'Relationships, not causes.', id: 't' });
  assert.equal(count(html, '<li class="evidence-chain-link'), 4);
  assert.match(html, /aria-labelledby="evidence-chain-title-t"/);
  assert.match(html, /<h4 class="evidence-chain-title" id="evidence-chain-title-t">ENSO link<\/h4>/);
  // A read link wears its evidence badge and names its source with a date.
  assert.match(html, /data-chain-link="a" data-chain-status="ready"/);
  assert.match(html, /impact-claim-derived/);
  assert.match(html, /<span class="impact-claim-badge">Derived<\/span>/);
  assert.match(html, /<a href="https:\/\/www\.cpc\.ncep\.noaa\.gov\/" target="_blank" rel="noopener">NOAA CPC<\/a> <span class="impact-claim-date">Published 2026-10-03<\/span>/);
  assert.match(html, /data-chain-action="detail:enso" aria-label="Observed index\. Open the ENSO detail"/);
  // A link with no read keeps its place, says its state, and prints no statement and no badge.
  assert.match(html, /data-chain-link="b" data-chain-status="unavailable"/);
  assert.match(html, /impact-hazard-pill-unavailable">unavailable</);
  assert.match(html, /impact-hazard-pill-loading">loading\.\.\.</);
  assert.doesNotMatch(html, /must not render/);
  assert.equal(count(html, 'impact-claim-badge'), 1, 'only the read link with an evidence class wears a badge');
  assert.match(html, /No product is read\./);
  // Joints: one fewer than the links, each a labelled relationship; no arrow anywhere.
  assert.equal(count(html, 'class="evidence-chain-joint"'), 3);
  assert.deepEqual(
    [...html.matchAll(/class="evidence-chain-relation">([^<]*)</g)].map((m) => m[1]),
    ['companion measurement', 'informs', 'read beside']
  );
  assert.doesNotMatch(html, /[←-⇿⟵-⟿➔➜]|&rarr;|-&gt;|=&gt;/);
  // Only an https source becomes a link.
  assert.doesNotMatch(html, /http:\/\/example\.org/);
  assert.match(html, /Source: Unsafe link/);
});

test('a chain never draws more than five links, and escapes what it is given', () => {
  assert.equal(CHAIN_MAX_LINKS, 5);
  const many = Array.from({ length: 8 }, (_, index) => ({ key: `k${index}`, title: `Link ${index}`, status: 'ready' }));
  const html = renderEvidenceChain(many, { heading: 'h', caption: 'c' });
  assert.equal(count(html, '<li class="evidence-chain-link'), 5);
  assert.equal(count(html, 'class="evidence-chain-joint"'), 4);
  const hostile = renderEvidenceChain(
    [{ key: 'x"y', title: '<img src=x>', status: 'ready', statement: '<script>1</script>', relation: '<b>r</b>' }, { key: 'z', title: 'z', status: 'ready' }],
    { heading: '<h1>', caption: '<i>' }
  );
  assert.doesNotMatch(hostile, /<img|<script|<b>|<h1>|<i>/);
});
