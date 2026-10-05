import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * S30D D1 M23 (DDM-P11-T04; DR-139; the Codex Tier 2 review's PF1, PF2 and
 * PF4 as dispositioned in D1-CODEX-TIER2-DISPOSITION.md): the popup frame's
 * pure model, serializer and link validator, under plain
 * `node --test`. No DOM: the serializer returns the frame's markup string,
 * and every assertion here reads that string. DOM construction, injection
 * inertness in a real document, geometry and both sinks are the browser
 * specs' (tests/identify-paths.spec.ts, tests/popup-viewport.spec.ts).
 *
 * Red on base (cb836fe): the module does not exist, so the import below fails.
 */

// The product modules import each other without extensions (`../util/escape`),
// which the bundler resolves and Node's type stripping does not. This hook
// appends `.ts` to a relative, extensionless specifier whose parent is a
// `.ts` module and whose `.ts` target exists (tests/boot-idle-seam.test.mjs,
// the same hook).
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

const frame = await import('../src/ui/popup-frame.ts');
const { serializePopupFrame, PopupFrameError } = frame;

const NBSP = ' ';
const PAYLOAD = '"><img src=x onerror="globalThis.__pwned=1">';
const ESCAPED_PAYLOAD = '&quot;&gt;&lt;img src=x onerror=&quot;globalThis.__pwned=1&quot;&gt;';

const link = (label, href) => ({ label, href });

function surface(overrides = {}) {
  return {
    kind: 'surface',
    title: 'U.S. Drought Monitor',
    issuer: { role: 'issued-by', name: 'NDMC, NOAA, USDA', productKey: 'usdm' },
    value: [{ text: 'D1 Moderate Drought' }],
    clocks: [
      {
        kind: 'point',
        meaning: 'map-date',
        label: 'Map date',
        at: { precision: 'date', date: '2026-09-22' }
      }
    ],
    source: { link: link('U.S. Drought Monitor', 'https://droughtmonitor.unl.edu/') },
    ...overrides
  };
}

/** The head region's markup: from its opening to the body's opening. */
function headOf(html) {
  const start = html.indexOf('data-popup-region="head"');
  const end = html.indexOf('data-popup-region="body"');
  assert.ok(start > 0 && end > start, 'the frame carries a head region followed by a body region');
  return html.slice(html.indexOf('>', start) + 1, html.lastIndexOf('<', end));
}

function bodyOf(html) {
  const start = html.indexOf('data-popup-region="body"');
  assert.ok(start > 0, 'the frame carries a body region');
  return html.slice(html.indexOf('>', start) + 1);
}

function slotsIn(fragment) {
  return [...fragment.matchAll(/data-popup-slot="([a-z-]+)"/g)].map((m) => m[1]);
}

/** Visible text of a markup fragment: tags removed, the five entities decoded. */
function textOf(fragment) {
  return fragment
    .replace(/<[^>]*>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t\r\n]+/g, ' ')
    .trim();
}

function hrefsIn(fragment) {
  return [...fragment.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
}

// ---------------------------------------------------------------------------
// Group fixtures (synthetic; PF2: M23 proves the shape, D2 builds the engine).
// Size order (Z 0.5 ha, B 700 ha, A 9,108 acres) deliberately differs from
// the issuer-then-key order (B, Z, A), so a size sort reds the order row.
// ---------------------------------------------------------------------------

const NIFC_A = {
  key: 'NIFC-A',
  issuer: 'nifc',
  identifier: '2026-WAFIX-000123',
  name: 'Fixture Creek',
  sizes: [
    { label: 'Reported size', text: '9,108 acres (about 3,686 ha)' },
    { label: 'Mapped perimeter area', text: '23,784 acres (about 9,625 ha)' }
  ],
  clocks: [
    {
      kind: 'point',
      meaning: 'discovered',
      label: 'Discovered',
      at: { precision: 'instant', at: Date.UTC(2026, 7, 20, 18, 5), zone: 'America/Los_Angeles' }
    }
  ],
  links: [link('NIFC Open Data', 'https://data-nifc.opendata.arcgis.com/')]
};

const BC_Z = {
  key: 'bcws:2026-Z99999',
  issuer: 'bcws',
  identifier: 'Fire number Z99999 (2026)',
  sizes: [{ label: 'Reported size', text: '0.5 ha (about 1 acres)' }],
  status: { from: 'issuer', text: 'Out of Control' },
  clocks: [
    {
      kind: 'point',
      meaning: 'perimeter-date',
      label: 'Perimeter date',
      at: { precision: 'date', date: '2026-08-21' }
    }
  ],
  versions: [
    {
      id: '2026082101',
      clocks: [
        {
          kind: 'point',
          meaning: 'record-loaded',
          label: 'Record loaded',
          at: { precision: 'date', date: '2026-08-21' }
        }
      ]
    }
  ],
  links: [link('BC Wildfire Service record', 'https://wildfiresituation.nrs.gov.bc.ca/map?fire=Z99999')],
  outsideView: true
};

const BC_B = {
  key: 'bcws:2026-B00001',
  issuer: 'bcws',
  identifier: 'Fire number B00001 (2026)',
  sizes: [{ label: 'Reported size', text: '700 ha (about 1,730 acres)' }],
  status: { from: 'unknown', text: 'Fixture unknown-status wording' },
  clocks: [{ kind: 'not-stated', label: 'Perimeter date', reason: 'Fixture reason: not supplied.' }],
  links: []
};

function groupInput(overrides = {}) {
  return {
    groupKey: 'g:0001',
    computedAt: Date.UTC(2026, 8, 26, 21, 5),
    zone: 'America/Los_Angeles',
    issuers: ['nifc', 'bcws'],
    records: [NIFC_A, BC_Z, BC_B],
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// D1.md M23 TEST FIRST rows
// ---------------------------------------------------------------------------

test('the head renders title, issuer with its role, value, clock and source in that order', () => {
  const html = serializePopupFrame(surface());
  assert.ok(html.startsWith('<article data-popup-frame data-popup-kind="surface"'), html.slice(0, 80));
  const head = headOf(html);
  assert.deepEqual(slotsIn(head), ['title', 'issuer', 'value', 'clock', 'source', 'actions']);
  const text = textOf(head);
  assert.ok(text.startsWith('U.S. Drought Monitor Issued by: NDMC, NOAA, USDA D1 Moderate Drought Map date'), text);
  // The four ratified role prefixes (interface-chrome-popups-text.md 3.3).
  const roles = [
    [{ role: 'boundary-from', name: 'U.S. Census Bureau', productKey: 'states' }, 'Boundary from: U.S. Census Bureau'],
    [{ role: 'computed-by-ddm-from', name: 'NOAA CPC', productKey: 'dsci' }, 'Computed by DDM from: NOAA CPC']
  ];
  for (const [issuer, expected] of roles) {
    assert.ok(textOf(headOf(serializePopupFrame(surface({ issuer })))).includes(expected), expected);
  }
  // The body keeps the primary source reachable under squeeze (PF3): the
  // head keeps its source slot, and the body offers the same link again.
  const body = bodyOf(html);
  assert.deepEqual(hrefsIn(body), ['https://droughtmonitor.unl.edu/']);
  assert.ok(slotsIn(body).includes('source-fallback'));
});

test('every string is escaped (an injected img onerror stays inert)', () => {
  const clock = {
    kind: 'point',
    meaning: 'observed',
    label: PAYLOAD,
    at: { precision: 'supplied', text: PAYLOAD, explanation: PAYLOAD }
  };
  const html = serializePopupFrame(
    surface({
      title: PAYLOAD,
      issuer: { role: 'issued-by', name: PAYLOAD, productKey: 'usdm' },
      value: [{ label: PAYLOAD, text: PAYLOAD, items: [PAYLOAD], issuer: PAYLOAD, clock }],
      clocks: [clock],
      source: { link: link(PAYLOAD, 'https://droughtmonitor.unl.edu/') },
      details: [
        { kind: 'row', label: PAYLOAD, text: PAYLOAD },
        { kind: 'list', label: PAYLOAD, items: [PAYLOAD] },
        { kind: 'chart', label: PAYLOAD, chartKey: PAYLOAD, summary: PAYLOAD, data: [1, 2], options: { title: PAYLOAD }, unit: PAYLOAD, attribution: PAYLOAD }
      ],
      qualifications: [PAYLOAD],
      actions: [{ kind: 'briefing', place: PAYLOAD, warningLabel: PAYLOAD }]
    })
  );
  assert.equal(html.includes('<img'), false, 'a raw <img reached the markup');
  assert.equal(/\sonerror=/.test(html.replace(/onerror=&quot;/g, '')), false, 'a live onerror attribute reached the markup');
  assert.ok(html.split(ESCAPED_PAYLOAD).length > 12, 'the payload appears, escaped once, in every slot');
  assert.equal(html.includes('&amp;lt;'), false, 'a string was escaped twice');
  // Record keys and identifiers in attributes and text.
  const group = serializePopupFrame({
    kind: 'group',
    group: groupInput({ records: [{ ...BC_B, key: PAYLOAD, identifier: PAYLOAD }, BC_Z] })
  });
  assert.equal(group.includes('<img'), false);
  assert.ok(group.includes(`data-record-key="${ESCAPED_PAYLOAD}"`));
});

/**
 * S30D D1 M24 (D1.md:145, "every briefing door names the place it opens,
 * with one label in every mode"; design record 3.3 "The door pulse": the
 * warning is printed as words in the value row that earned it, so the pulse
 * is decoration). Red on a94eee5: a warning door reads
 * "Fixture warning - Open the Impact Briefing for Fixture Place".
 */
test('the briefing door keeps one label whatever its warning, and pulses only with a warning', () => {
  const doorOf = (html) => {
    const match = /<button type="button" class="([^"]*)" data-ddm-impact-trigger>([^<]*)<\/button>/.exec(html);
    assert.ok(match, 'the frame carries one briefing door');
    return { className: match[1], label: match[2] };
  };
  const plain = doorOf(serializePopupFrame(surface({ actions: [{ kind: 'briefing', place: 'Fixture Place' }] })));
  const warned = doorOf(
    serializePopupFrame(surface({ actions: [{ kind: 'briefing', place: 'Fixture Place', warningLabel: 'Fixture warning' }] }))
  );
  assert.equal(plain.label, 'Open the Impact Briefing for Fixture Place');
  assert.equal(warned.label, plain.label, 'a warning renames the door');
  assert.equal(plain.className, 'popup-impact-btn');
  assert.equal(warned.className, 'popup-impact-btn popup-impact-btn--pulse');
  // The warning label's escape path: whatever it carries never reaches the
  // markup, raw or escaped; only the pulse class says a warning earned it.
  const injected = serializePopupFrame(surface({ actions: [{ kind: 'briefing', place: 'Fixture Place', warningLabel: PAYLOAD }] }));
  assert.equal(injected.includes('<img'), false);
  assert.equal(injected.includes(ESCAPED_PAYLOAD), false, 'the warning label reached the door markup');
  assert.equal(doorOf(injected).label, 'Open the Impact Briefing for Fixture Place');
  assert.equal(doorOf(injected).className, 'popup-impact-btn popup-impact-btn--pulse');
});

/**
 * found-106 (REGISTER.yaml:3427): "requiredLink builds its rejection message
 * from the value it validated." Red on a94eee5: the message re-reads the
 * href, so a getter that answers 'javascript:x' then 'https://example.org/'
 * is validated on the first answer and reported with the second, and is
 * read twice.
 */
test('requiredLink names the value it validated (found-106)', () => {
  let reads = 0;
  const shifting = {
    label: 'Fixture source',
    get href() {
      reads += 1;
      return reads === 1 ? 'javascript:x' : 'https://example.org/';
    }
  };
  assert.throws(
    () => serializePopupFrame(surface({ source: { link: shifting } })),
    (err) => err instanceof PopupFrameError && err.message === 'not an https link: javascript:x'
  );
  assert.equal(reads, 1, 'requiredLink read the href more than once');
});

/**
 * S30D D1 M24 (the owner's "Body slot, present-only head", 2026-10-01; PF3:
 * the normal desktop head shows without scrolling): condition rows are full
 * value rows rendered FIRST in the body, ahead of the detail rows, each
 * through the same row renderer and the same one escaping boundary as the
 * head's value line. No conditions, no slot.
 */
test('condition rows render first in the body, never in the head, escaped once', () => {
  const clock = { kind: 'point', meaning: 'month', label: 'Consensus month', at: { precision: 'month', month: '2026-08' } };
  const html = serializePopupFrame(
    surface({
      value: [{ text: 'Drought · Wildfire' }],
      conditions: [
        { label: 'Drought', text: 'D1 Moderate drought (North American Drought Monitor)', clock },
        { label: 'Wildfire', text: 'Active mapped perimeter in this area (NIFC WFIGS)', items: ['Fixture Creek', 'Fixture Ridge'] }
      ],
      details: [{ kind: 'row', label: 'Postal code', text: 'FX' }]
    })
  );
  const head = headOf(html);
  const body = bodyOf(html);
  assert.equal(head.includes('data-popup-slot="conditions"'), false, 'the conditions slot is in the head');
  assert.equal([...head.matchAll(/<div data-value-row>/g)].length, 1, 'the head carries one value line');
  assert.ok(body.startsWith('<div data-popup-slot="conditions">'), body.slice(0, 120));
  assert.ok(body.indexOf('data-popup-slot="conditions"') < body.indexOf('data-popup-slot="rows"'));
  assert.equal([...body.matchAll(/<div data-value-row>/g)].length, 2);
  assert.ok(body.includes('<ul><li>Fixture Creek</li><li>Fixture Ridge</li></ul>'));
  assert.ok(body.includes(`<p data-clock-meaning="month"><span class="popup-clock-label">Consensus month</span> <time datetime="2026-08">Aug${NBSP}2026</time></p>`), body);
  // The same escaping boundary: a payload in a condition row stays inert.
  const injected = serializePopupFrame(surface({ conditions: [{ label: PAYLOAD, text: PAYLOAD, items: [PAYLOAD], issuer: PAYLOAD }] }));
  assert.equal(injected.includes('<img'), false);
  assert.equal(injected.split(ESCAPED_PAYLOAD).length - 1, 4);
  // Validated as rows: a blank row text is refused, a non-list refused.
  assert.throws(() => serializePopupFrame(surface({ conditions: [{ text: '  ' }] })), PopupFrameError);
  assert.throws(() => serializePopupFrame(surface({ conditions: 'Drought' })), PopupFrameError);
  // No condition rows: no slot at all.
  assert.equal(serializePopupFrame(surface()).includes('data-popup-slot="conditions"'), false);
  assert.equal(serializePopupFrame(surface({ conditions: [] })).includes('data-popup-slot="conditions"'), false);
});

test('links are https only', () => {
  for (const href of ['http://droughtmonitor.unl.edu/', 'javascript:alert(1)', 'data:text/html,x', '//droughtmonitor.unl.edu/']) {
    assert.throws(
      () => serializePopupFrame(surface({ source: { link: link('Source', href) } })),
      PopupFrameError,
      href
    );
  }
  assert.ok(serializePopupFrame(surface()).includes('href="https://droughtmonitor.unl.edu/" target="_blank" rel="noopener"'));
});

test('not-stated clocks and none sources print their reasons', () => {
  const html = serializePopupFrame(
    surface({
      clocks: [{ kind: 'not-stated', label: 'Edition', reason: 'Fixture reason: the issuer states no edition.' }],
      source: { none: 'Fixture reason: no public source page.' }
    })
  );
  const head = textOf(headOf(html));
  assert.ok(head.includes('Edition Fixture reason: the issuer states no edition.'), head);
  // S30D block 3 (the head fits): a stated no-source reason is printed in the
  // body's source-fallback slot only; the head has no source slot without a link.
  assert.equal(head.includes('Fixture reason: no public source page.'), false, head);
  assert.equal(slotsIn(headOf(html)).includes('source'), false, headOf(html));
  assert.ok(textOf(bodyOf(html)).endsWith('Fixture reason: no public source page.'), textOf(bodyOf(html)));
  assert.equal(hrefsIn(html).length, 0);
  for (const bad of [{ kind: 'not-stated', label: 'Edition', reason: ' ' }]) {
    assert.throws(() => serializePopupFrame(surface({ clocks: [bad] })), PopupFrameError);
  }
  assert.throws(() => serializePopupFrame(surface({ source: { none: '' } })), PopupFrameError);
});

test('the head fits: a source prints in the head only as a link, and only the first clock stays in the head', () => {
  // S30D block 3, the director's Tier 2 call (the owner's present-only head,
  // RATIFICATION-10; the G1 A5 rule). Red before it: the head printed the
  // stated no-source reason and every clock.
  const second = { kind: 'point', meaning: 'retrieved', label: 'Retrieved on', at: { precision: 'date', date: '2026-10-05' } };
  const third = { kind: 'not-stated', label: 'Edition', reason: 'Fixture reason: the issuer states no edition.' };
  const html = serializePopupFrame(
    surface({
      clocks: [surface().clocks[0], second, third],
      source: { none: 'Fixture reason: no public source page.' },
      conditions: [{ label: 'Drought', text: 'Fixture condition row' }],
      details: [{ kind: 'row', label: 'Fixture', text: 'Fixture detail' }]
    })
  );
  const head = headOf(html);
  const body = bodyOf(html);
  assert.deepEqual(slotsIn(head), ['title', 'issuer', 'value', 'clock', 'actions']);
  assert.equal(textOf(head).includes('Fixture reason: no public source page.'), false, textOf(head));
  assert.equal(head.match(/data-clock-meaning=/g)?.length, 1, head);
  assert.ok(textOf(head).includes(`Map date Sep${NBSP}22,${NBSP}2026`), textOf(head));
  // The later clocks, words unchanged and in order, right after the conditions.
  assert.deepEqual(slotsIn(body).slice(0, 3), ['conditions', 'more-clocks', 'rows']);
  const more = /<div data-popup-slot="more-clocks">([\s\S]*?)<\/div><div data-popup-slot="rows">/.exec(body);
  assert.ok(more, body);
  assert.equal(textOf(more[1]), `Retrieved on Oct${NBSP}5,${NBSP}2026 Edition Fixture reason: the issuer states no edition.`);
  // The reason still prints once, in the body's source-fallback slot.
  assert.equal(html.split('Fixture reason: no public source page.').length - 1, 1);
  assert.ok(/<p data-popup-slot="source-fallback">Fixture reason: no public source page\.<\/p>/.test(body), body);
  // One clock and a link: the head keeps its source, and no more-clocks slot.
  const plain = serializePopupFrame(surface());
  assert.deepEqual(slotsIn(headOf(plain)), ['title', 'issuer', 'value', 'clock', 'source', 'actions']);
  assert.equal(plain.includes('data-popup-slot="more-clocks"'), false);
});

test('date-only clocks never shift a day under America/Los_Angeles and America/Vancouver', () => {
  const original = process.env.TZ;
  try {
    for (const zone of ['America/Los_Angeles', 'America/Vancouver']) {
      process.env.TZ = zone;
      // Self-check: the zone is really in effect, so a formatter that went
      // through `new Date('YYYY-MM-DD')` would land on the previous day here.
      assert.equal(new Date('2026-09-26').getDate(), 25, `TZ=${zone} is not in effect`);
      const html = serializePopupFrame(
        surface({
          clocks: [
            { kind: 'point', meaning: 'map-date', label: 'Map date', at: { precision: 'date', date: '2026-09-26' } },
            { kind: 'point', meaning: 'month', label: 'Month', at: { precision: 'month', month: '2026-01' } }
          ]
        })
      );
      // The head keeps the first clock; the second stands in the body's
      // more-clocks slot (S30D block 3, the head fits).
      const head = headOf(html);
      const body = bodyOf(html);
      assert.ok(head.includes(`<time datetime="2026-09-26">Sep${NBSP}26,${NBSP}2026</time>`), head);
      assert.ok(body.includes(`<time datetime="2026-01">Jan${NBSP}2026</time>`), body);
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test('group records sort by issuer then key and the group head carries no acres, ha, status word, name or date', () => {
  const html = serializePopupFrame({ kind: 'group', group: groupInput() });
  const keys = [...bodyOf(html).matchAll(/data-record-key="([^"]*)"/g)].map((m) => m[1]);
  // "BC Wildfire Service (British Columbia)" sorts before "NIFC WFIGS (United States)".
  assert.deepEqual(keys, ['bcws:2026-B00001', 'bcws:2026-Z99999', 'NIFC-A']);
  const head = textOf(headOf(html));
  for (const forbidden of ['acres', ' ha', 'Out of Control', 'Fixture Creek', 'Z99999', 'B00001', '000123', 'Aug', '2026', 'Discovered', 'Perimeter date', 'unknown-status']) {
    assert.equal(head.includes(forbidden), false, `the group head carries "${forbidden}": ${head}`);
  }
  // Nothing is summed: no size appears that no record supplied.
  for (const summed of ['9,808', '9808', '9,109']) assert.equal(html.includes(summed), false);
});

test('a stewarded kind without its representation caveat throws', () => {
  const place = (productKey, representation, issuer) => ({
    kind: 'place',
    title: 'Synthetic Fixture Area',
    issuer: issuer ?? { role: 'boundary-from', name: 'Fixture publisher', productKey },
    value: [{ text: 'Fixture condition' }],
    clocks: [{ kind: 'not-stated', label: 'Edition', reason: 'Fixture reason.' }],
    source: { link: link('Fixture source', 'https://www.census.gov/programs-surveys/geography.html') },
    ...(representation === undefined ? {} : { representation })
  });
  for (const product of ['bia-reservations', 'aiannh', 'treaty']) {
    assert.throws(() => serializePopupFrame(place(product)), PopupFrameError, product);
    assert.throws(() => serializePopupFrame(place(product, { product, variant: 'bogus', text: 'x' })), PopupFrameError);
    assert.throws(
      () => serializePopupFrame(place(product, { product: 'tribal', variant: 'deployer', text: 'x' })),
      PopupFrameError
    );
  }
  // AIANNH's three distinct branches each render, verbatim, in the body.
  for (const variant of ['legal', 'statistical', 'otsa']) {
    const text = `Fixture ${variant} caveat, verbatim; with "quotes" & ampersands.`;
    const html = serializePopupFrame(place('aiannh', { product: 'aiannh', variant, text }));
    const body = bodyOf(html);
    assert.ok(body.includes(`data-representation="aiannh:${variant}"`), body);
    assert.ok(textOf(body).includes(text), textOf(body));
    assert.equal(textOf(headOf(html)).includes('caveat'), false, 'the caveat stays in the scrolling body');
  }
  assert.throws(() => serializePopupFrame(place('aiannh', { product: 'aiannh', variant: 'legal', text: '   ' })), PopupFrameError);
  // A caveat on an unprotected product is a product-policy mismatch.
  assert.throws(
    () => serializePopupFrame(surface({ representation: { product: 'treaty', variant: 'agency-representation', text: 'x' } })),
    PopupFrameError
  );
  // The deployer variant: caveat required, a no-source reason required, and
  // no link in any link slot (plan_rules 7).
  const deployer = (extra) => ({
    ...place('tribal', { product: 'tribal', variant: 'deployer', text: 'Fixture deployer caveat.' }, {
      role: 'supplied-by-deployment',
      productKey: 'tribal'
    }),
    source: { none: 'Fixture reason: this layer is supplied by this deployment.' },
    ...extra
  });
  assert.ok(textOf(headOf(serializePopupFrame(deployer({})))).includes('Supplied by this deployment'));
  assert.throws(() => serializePopupFrame(deployer({ source: { link: link('x', 'https://example.org/') } })), PopupFrameError);
  assert.throws(() => serializePopupFrame(deployer({ moreLinks: [link('x', 'https://example.org/')] })), PopupFrameError);
  assert.throws(() => serializePopupFrame(deployer({ records: [NIFC_A] })), PopupFrameError);
  const noCaveat = deployer({});
  delete noCaveat.representation;
  assert.throws(() => serializePopupFrame(noCaveat), PopupFrameError);
  // The deployer role belongs to the deployer product only.
  assert.throws(
    () => serializePopupFrame(surface({ issuer: { role: 'supplied-by-deployment', productKey: 'usdm' }, source: { none: 'x' } })),
    PopupFrameError
  );
});

// ---------------------------------------------------------------------------
// The Codex review's rows (2026-09-27_s30d-d1-tier2-designs.md :212, :216, :222)
// ---------------------------------------------------------------------------

test('clock precision preserves years, months, observed windows and supplied target labels', () => {
  const html = serializePopupFrame(
    surface({
      kind: 'surface',
      clocks: [
        { kind: 'point', meaning: 'published', label: 'LAR definitions published', at: { precision: 'year', year: '2019' } },
        { kind: 'point', meaning: 'month', label: 'Month', at: { precision: 'month', month: '2026-06' } },
        {
          kind: 'window',
          meaning: 'observed',
          from: { label: 'Start', at: { precision: 'instant', at: Date.UTC(2026, 8, 26, 15, 0), zone: 'UTC' } },
          until: { label: 'End', at: { precision: 'absent', reason: 'Fixture reason: the issuer gave no end.' } }
        },
        {
          kind: 'point',
          meaning: 'valid',
          label: 'Valid through',
          at: { precision: 'supplied', text: 'September 30', explanation: 'Fixture: as the issuer states it.' }
        }
      ]
    })
  );
  // The head keeps the first clock; the later three stand, words unchanged, in
  // the body's more-clocks slot (S30D block 3, the head fits).
  const head = headOf(html);
  const later = bodyOf(html);
  assert.ok(head.includes('<time datetime="2019">2019</time>'), 'a year stays a year');
  assert.ok(later.includes(`<time datetime="2026-06">Jun${NBSP}2026</time>`), 'a month stays a month');
  assert.ok(later.includes('data-clock-meaning="observed"'), 'an observed window keeps its meaning');
  assert.ok(later.includes(`<time datetime="2026-09-26T15:00:00.000Z">Sep${NBSP}26,${NBSP}2026,${NBSP}15:00${NBSP}UTC</time>`), later);
  assert.ok(textOf(later).includes('End Fixture reason: the issuer gave no end.'), 'an absent endpoint states its reason');
  assert.ok(textOf(later).includes('Valid through September 30 Fixture: as the issuer states it.'));
  assert.equal(/datetime="2019-|datetime="2026-06-/.test(html), false, 'no day was fabricated');
  // Never fabricate a zone: an instant without one is rejected.
  const noZone = { kind: 'point', meaning: 'issued', label: 'Issued', at: { precision: 'instant', at: 0, zone: '' } };
  assert.throws(() => serializePopupFrame(surface({ clocks: [noZone] })), PopupFrameError);
  for (const [precision, field, value] of [
    ['year', 'year', '19'],
    ['month', 'month', '2026-13'],
    ['date', 'date', '2026-02-31x']
  ]) {
    const bad = { kind: 'point', meaning: 'edition', label: 'Edition', at: { precision, [field]: value } };
    assert.throws(() => serializePopupFrame(surface({ clocks: [bad] })), PopupFrameError, `${precision} ${value}`);
  }
});

test('group head is derived only from group facts', () => {
  const html = serializePopupFrame({
    kind: 'group',
    // Forged extras on the input are ignored: the head is derived.
    group: { ...groupInput(), title: 'Fixture Creek Complex', status: 'Out of Control' }
  });
  const head = headOf(html);
  assert.deepEqual(slotsIn(head), ['title', 'issuer', 'value', 'clock', 'source', 'actions']);
  const text = textOf(head);
  assert.ok(text.startsWith('Overlapping agency fire perimeters (3 records)'), text);
  assert.ok(text.includes('Computed by DDM from NIFC WFIGS and BC Wildfire Service perimeters'), text);
  assert.ok(text.includes('Overlapping agency perimeters counted as one fire area.'), text);
  assert.ok(text.includes(`Grouping computed 14:05${NBSP}PDT`), text);
  assert.ok(text.includes('Source: per record'), text);
  assert.equal(hrefsIn(head).length, 0, 'the group head links no record');
  const body = textOf(bodyOf(html));
  assert.ok(
    body.includes(
      `Grouping computed by DDM from the agencies' perimeters at 14:05${NBSP}PDT. DDM states no combined name, size or status.`
    ),
    body
  );
  // Admitted issuers only (DR-104: M3 never enters a group), two records at
  // least, and every record's issuer among the group's.
  assert.throws(() => serializePopupFrame({ kind: 'group', group: groupInput({ issuers: ['nifc', 'm3'] }) }), PopupFrameError);
  assert.throws(() => serializePopupFrame({ kind: 'group', group: groupInput({ records: [NIFC_A] }) }), PopupFrameError);
  assert.throws(() => serializePopupFrame({ kind: 'group', group: groupInput({ issuers: ['nifc'] }) }), PopupFrameError);
  assert.throws(() => serializePopupFrame({ kind: 'group', group: groupInput({ records: [NIFC_A, { ...BC_Z, issuer: 'm3' }] }) }), PopupFrameError);
  assert.throws(() => serializePopupFrame({ kind: 'group', group: groupInput({ zone: '' }) }), PopupFrameError);
  // The two ratified notices print verbatim.
  const notices = textOf(
    serializePopupFrame({ kind: 'group', group: groupInput({ notices: ['grouping-unavailable', 'bcws-layer-off'] }) })
  );
  assert.ok(notices.includes("Grouping with other agencies' perimeters is unavailable right now"));
  assert.ok(notices.includes('BC Wildfire Service layer is off; its records are not listed'));
});

test('record fields retain both identifiers and links', () => {
  const body = bodyOf(serializePopupFrame({ kind: 'group', group: groupInput() }));
  const nifc = body.slice(body.indexOf('data-record-key="NIFC-A"'));
  const nifcText = textOf(nifc);
  assert.ok(nifcText.includes('NIFC WFIGS (United States)'));
  assert.ok(nifcText.includes('Fixture Creek') && nifcText.includes('2026-WAFIX-000123'), nifcText);
  assert.ok(nifcText.includes('Reported size 9,108 acres (about 3,686 ha)'), nifcText);
  assert.ok(nifcText.includes('Mapped perimeter area 23,784 acres (about 9,625 ha)'), nifcText);
  assert.ok(hrefsIn(nifc).includes('https://data-nifc.opendata.arcgis.com/'));
  const z = body.slice(body.indexOf('data-record-key="bcws:2026-Z99999"'), body.indexOf('data-record-key="NIFC-A"'));
  const zText = textOf(z);
  assert.ok(zText.includes('BC Wildfire Service (British Columbia)'));
  assert.ok(zText.includes('Fire number Z99999 (2026)'));
  assert.ok(zText.includes('Out of Control'));
  assert.ok(zText.includes('2026082101'), 'the version is listed');
  assert.ok(zText.includes('extends outside this view'));
  assert.deepEqual(hrefsIn(z), ['https://wildfiresituation.nrs.gov.bc.ca/map?fire=Z99999']);
  const b = body.slice(body.indexOf('data-record-key="bcws:2026-B00001"'), body.indexOf('data-record-key="bcws:2026-Z99999"'));
  assert.ok(b.includes('data-status-from="unknown"'), 'an unknown status says so');
  assert.equal(textOf(b).includes('extends outside this view'), false);
});

test('every link position validates HTTPS and the BC record host', () => {
  const forged = [
    'http://droughtmonitor.unl.edu/',
    'javascript:alert(1)',
    'not a url',
    'https://user:pw@evil.example/',
    'https://droughtmonitor.unl.edu@evil.example/',
    42,
    { toString: () => 'https://droughtmonitor.unl.edu/' }
  ];
  for (const href of forged) {
    assert.throws(() => serializePopupFrame(surface({ source: { link: link('Source', href) } })), PopupFrameError, String(href));
    assert.throws(
      () => serializePopupFrame(surface({ moreLinks: [link('More', href)] })),
      PopupFrameError,
      `moreLinks ${String(href)}`
    );
  }
  // Record links are issuer data: an unsafe one is dropped, never rendered.
  const bcHost = [
    'https://wildfiresituation.nrs.gov.bc.ca.evil.example/x',
    'https://evil.example/?wildfiresituation.nrs.gov.bc.ca',
    'https://user@wildfiresituation.nrs.gov.bc.ca/x',
    'http://wildfiresituation.nrs.gov.bc.ca/x',
    'https://xwildfiresituation.nrs.gov.bc.ca/x'
  ];
  const records = [
    { ...BC_Z, links: bcHost.map((href) => link('BC record', href)) },
    { ...NIFC_A, links: [link('NIFC', 'http://data-nifc.opendata.arcgis.com/'), link('NIFC', 'javascript:alert(1)'), link('NIFC', 'https://data-nifc.opendata.arcgis.com/ok')] }
  ];
  const body = bodyOf(serializePopupFrame({ kind: 'group', group: groupInput({ records }) }));
  assert.deepEqual(hrefsIn(body), ['https://data-nifc.opendata.arcgis.com/ok']);
  // The same validator, directly: exact host where mandated.
  assert.equal(frame.checkPopupHref('https://wildfiresituation.nrs.gov.bc.ca/map', 'wildfiresituation.nrs.gov.bc.ca'), 'https://wildfiresituation.nrs.gov.bc.ca/map');
  for (const href of bcHost) assert.equal(frame.checkPopupHref(href, 'wildfiresituation.nrs.gov.bc.ca'), null, href);
});

test('a collection renders its group sections inside one frame root, ordered by group key', () => {
  const html = serializePopupFrame({
    kind: 'collection',
    sections: [groupInput({ groupKey: 'g:0002' }), groupInput({ groupKey: 'g:0001', records: [BC_Z, BC_B], issuers: ['bcws'] })]
  });
  assert.equal(html.match(/data-popup-frame/g)?.length, 1, 'one frame root');
  const order = [...html.matchAll(/data-popup-section data-group-key="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['g:0001', 'g:0002']);
  const head = textOf(headOf(html));
  assert.ok(head.includes('Overlapping agency fire perimeters (2 records)') && head.includes('Overlapping agency fire perimeters (3 records)'), head);
  assert.throws(
    () => serializePopupFrame({ kind: 'collection', sections: [groupInput(), groupInput()] }),
    PopupFrameError,
    'two sections with one group key are one section, never two'
  );
});

// ---------------------------------------------------------------------------
// M23 repair round 1 (Codex ultra diff review 2026-09-30, findings 1 and 5)
// ---------------------------------------------------------------------------

const AGENCY_CAVEATS = {
  'bia-reservations': { product: 'bia-reservations', variant: 'lar', text: 'Fixture LAR caveat.' },
  aiannh: { product: 'aiannh', variant: 'legal', text: 'Fixture legal caveat.' },
  treaty: { product: 'treaty', variant: 'agency-representation', text: 'Fixture agency caveat.' }
};

function agencyPlace(product, overrides = {}) {
  return {
    kind: 'place',
    title: 'Synthetic Fixture Area',
    issuer: { role: 'boundary-from', name: 'Fixture publisher', productKey: product },
    value: [{ text: 'Fixture condition' }],
    clocks: [{ kind: 'not-stated', label: 'Edition', reason: 'Fixture reason.' }],
    source: { link: link('Fixture source', 'https://www.census.gov/programs-surveys/geography.html') },
    representation: AGENCY_CAVEATS[product],
    ...overrides
  };
}

function deployerPlace(overrides = {}) {
  return {
    kind: 'place',
    title: 'Synthetic Fixture Area',
    issuer: { role: 'supplied-by-deployment', productKey: 'tribal' },
    value: [{ text: 'Fixture condition' }],
    clocks: [{ kind: 'not-stated', label: 'Edition', reason: 'Fixture reason.' }],
    source: { none: 'Fixture reason: this layer is supplied by this deployment.' },
    representation: { product: 'tribal', variant: 'deployer', text: 'Fixture deployer caveat.' },
    ...overrides
  };
}

test('the product policy holds at runtime: a deployer source is its reason alone, agency products stay place and boundary-from', () => {
  // Positive controls: each shape renders as given.
  assert.equal(hrefsIn(serializePopupFrame(deployerPlace())).length, 0);
  for (const product of Object.keys(AGENCY_CAVEATS)) {
    assert.ok(serializePopupFrame(agencyPlace(product)).includes(`data-popup-product="${product}"`), product);
  }
  // A mixed { none, link } source is refused, never rendered with the link
  // preferred (finding 1: two hrefs, head and source fallback).
  const mixed = { none: 'Fixture reason.', link: link('Polygon', 'https://example.org/polygon.geojson') };
  assert.throws(() => serializePopupFrame(deployerPlace({ source: mixed })), PopupFrameError, 'a mixed deployer source');
  assert.throws(
    () => serializePopupFrame(deployerPlace({ source: { none: 'Fixture reason.', href: 'https://example.org/' } })),
    PopupFrameError,
    'a deployer source with any key beside none'
  );
  // The agency products are places whose issuer supplied the boundary.
  for (const product of Object.keys(AGENCY_CAVEATS)) {
    assert.throws(() => serializePopupFrame(agencyPlace(product, { kind: 'event' })), PopupFrameError, `${product} as an event`);
    assert.throws(
      () => serializePopupFrame(agencyPlace(product, { issuer: { role: 'issued-by', name: 'Fixture publisher', productKey: product } })),
      PopupFrameError,
      `${product} issued-by`
    );
  }
});

test('a deployer source never yields a link through an inherited or getter link, and a deployer is always a place', () => {
  // The Codex re-check's counterexample (2026-09-30 r1 review, finding 1):
  // Object.keys sees only `none`; the link hides in a prototype getter.
  class GetterSource {
    none = 'Fixture reason: supplied by this deployment.';
    get link() {
      return { label: 'Polygon', href: 'https://example.org/polygon.geojson' };
    }
  }
  const inherited = Object.create({ link: link('Polygon', 'https://example.org/polygon.geojson') });
  inherited.none = 'Fixture reason.';
  const hidden = { none: 'Fixture reason.' };
  Object.defineProperty(hidden, 'link', { value: link('Polygon', 'https://example.org/polygon.geojson'), enumerable: false });
  for (const [what, source] of [['getter', new GetterSource()], ['inherited', inherited], ['non-enumerable', hidden]]) {
    let html = '';
    assert.throws(() => {
      html = serializePopupFrame(deployerPlace({ source }));
    }, PopupFrameError, what);
    assert.equal(hrefsIn(html).length, 0, `${what}: no href rendered`);
  }
  assert.throws(() => serializePopupFrame(deployerPlace({ kind: 'event' })), PopupFrameError, 'a deployer event');
});

test('the frame serializes from one validated snapshot: a getter cannot change policy after validation', () => {
  // The Codex r2 re-check, finding 1: a deployer reason getter that installs
  // moreLinks after the policy check.
  const deployer = deployerPlace();
  deployer.source = {
    get none() {
      Object.assign(deployer, { moreLinks: [link('Polygon', 'https://example.org/polygon.geojson')] });
      return 'Deployment reason';
    }
  };
  let html = '';
  try {
    html = serializePopupFrame(deployer);
  } catch (error) {
    assert.ok(error instanceof PopupFrameError, String(error));
  }
  assert.equal(hrefsIn(html).length, 0, 'the deployer rendered no link');

  // An agency model whose value getter flips kind and role after validation.
  const agency = agencyPlace('aiannh');
  const rows = agency.value;
  Object.defineProperty(agency, 'value', {
    get() {
      agency.kind = 'event';
      agency.issuer = { role: 'issued-by', name: 'Flipped publisher', productKey: 'aiannh' };
      return rows;
    }
  });
  let agencyHtml = '';
  try {
    agencyHtml = serializePopupFrame(agency);
  } catch (error) {
    assert.ok(error instanceof PopupFrameError, String(error));
  }
  if (agencyHtml !== '') {
    assert.ok(agencyHtml.startsWith('<article data-popup-frame data-popup-kind="place"'), agencyHtml.slice(0, 80));
    assert.ok(textOf(headOf(agencyHtml)).includes('Boundary from: Fixture publisher'), 'the validated role and issuer render');
    assert.equal(agencyHtml.includes('Flipped publisher'), false);
  }

  // A group record whose issuer flips from bcws (host-checked) to nifc (no
  // mandated host) after the group check: the evil link never renders.
  let reads = 0;
  const flipping = {
    ...BC_Z,
    links: [link('BC record', 'https://evil.example/record')],
    get issuer() {
      reads += 1;
      return reads === 1 ? 'bcws' : 'nifc';
    }
  };
  let groupHtml = '';
  try {
    groupHtml = serializePopupFrame({ kind: 'group', group: groupInput({ records: [flipping, BC_B] }) });
  } catch (error) {
    assert.ok(error instanceof PopupFrameError, String(error));
  }
  assert.equal(groupHtml.includes('evil.example'), false, 'a host-checked record link stays checked');
});

/** Serialize, accepting a PopupFrameError as a refusal (then nothing rendered). */
function renderOrRefuse(model) {
  try {
    return serializePopupFrame(model);
  } catch (error) {
    assert.ok(error instanceof PopupFrameError, String(error));
    return '';
  }
}

const INJECTED = '"></span><a href="https://evil.example/polygon.geojson">Polygon</a><span x="';

test('nested fields are read once: a swatch colour getter cannot inject markup after its check', () => {
  // The Codex r3 re-check, finding 1, verbatim in shape.
  const model = deployerPlace();
  let reads = 0;
  model.value[0].swatch = {
    table: 'fixture',
    classKey: 'fixture',
    get color() {
      reads += 1;
      return reads === 1 ? '#ffffff' : `#ffffff${INJECTED}`;
    }
  };
  const html = renderOrRefuse(model);
  assert.equal((html.match(/<a /g) ?? []).length, 0, 'a deployer frame holds no link');
  // The legitimate swatch span itself ends `"></span>`; the injection is the
  // markup after it.
  assert.equal(html.includes('"></span><a'), false, 'no attribute break-out');
  assert.equal((html.match(/<span class="popup-swatch"/g) ?? []).length, html === '' ? 0 : 1);
  assert.equal(html.includes('evil.example'), false);
  assert.equal(reads <= 1, true, `the colour was read ${reads} times`);
});

test('nested fields are read once: a chart value getter cannot inject markup after its check', () => {
  let reads = 0;
  const data = [1, 2];
  Object.defineProperty(data, 0, {
    get() {
      reads += 1;
      return reads === 1 ? 1 : INJECTED;
    }
  });
  const html = renderOrRefuse(
    surface({ details: [{ kind: 'chart', label: 'x', chartKey: 'k', summary: 'x', data, options: { title: 'x' }, unit: 'u' }] })
  );
  assert.equal((html.match(/<a /g) ?? []).length, html === '' ? 0 : 2, 'only the source link and its body fallback');
  assert.equal(html.includes('evil.example'), false);
});

test('nested fields are read once: a clock value getter cannot swap in another value after its check', () => {
  let reads = 0;
  const at = {
    precision: 'date',
    get date() {
      // One read in two carries the injection, so a check and a write that
      // read separately disagree; a single read is either refused or clean.
      reads += 1;
      return reads === 1 ? `2026-09-22${INJECTED}` : '2026-09-22';
    }
  };
  const html = renderOrRefuse(surface({ clocks: [{ kind: 'point', meaning: 'map-date', label: 'Map date', at }] }));
  assert.equal(html.includes('evil.example'), false, 'the validated date is the one written');
  assert.ok(html === '' || html.includes(`<time datetime="2026-09-22">Sep${NBSP}22,${NBSP}2026</time>`));
});

test('the feature path reads the model kind once', () => {
  let reads = 0;
  const model = surface();
  delete model.kind;
  Object.defineProperty(model, 'kind', {
    enumerable: true,
    get() {
      reads += 1;
      return 'surface';
    }
  });
  serializePopupFrame(model);
  assert.equal(reads, 1);
});

test('a source that is not an object is refused as a PopupFrameError, never a TypeError', () => {
  for (const source of ['https://droughtmonitor.unl.edu/', 42, null, undefined, true]) {
    assert.throws(() => serializePopupFrame(surface({ source })), PopupFrameError, `issued ${String(source)}`);
    assert.throws(() => serializePopupFrame(deployerPlace({ source })), PopupFrameError, `deployer ${String(source)}`);
  }
});

test('a chart detail carries its data, unit and attribution into the frame for the builder to mount', () => {
  const html = serializePopupFrame(
    surface({
      details: [
        {
          kind: 'chart',
          label: 'Streamflow, last 7 days',
          chartKey: 'flow',
          summary: 'Fixture summary.',
          data: [12, 3.5, -0.25, 1e3],
          options: { title: 'Streamflow', unit: 'ft3/s', source: 'Fixture source line' },
          unit: 'ft3/s',
          attribution: `Fixture attribution ${PAYLOAD}`
        }
      ]
    })
  );
  const figure = /<figure data-detail="chart"[^>]*>[\s\S]*?<\/figure>/.exec(html)?.[0] ?? '';
  assert.ok(figure.includes('data-popup-chart="flow"'), figure);
  assert.ok(figure.includes('data-chart-values="12,3.5,-0.25,1000"'), figure);
  assert.ok(figure.includes('data-chart-unit="ft3/s"'), figure);
  assert.ok(textOf(figure).includes(`Fixture attribution ${PAYLOAD}`), 'the attribution shows as its own text');
  assert.equal(figure.includes('<img'), false, 'the attribution is escaped');
  for (const data of [[1, Number.NaN], [1, '2'], 'x']) {
    assert.throws(
      () => serializePopupFrame(surface({ details: [{ kind: 'chart', label: 'x', chartKey: 'k', summary: 'x', data, options: { title: 'x' }, unit: 'u' }] })),
      PopupFrameError,
      `chart data ${String(data)}`
    );
  }
});

test('a qualified list item renders its text and an escaped title that stays inert', () => {
  const title = '3200 m from the clicked point" onmouseover="globalThis.__pwned=1" x="<';
  const html = serializePopupFrame(
    surface({
      details: [{ kind: 'list', label: 'Nearest monitoring stations', items: ['Plain <b>', { text: 'Station "A"', qualifier: { text: '3.2 km', title } }] }],
      value: [{ text: 'Fixture', items: [{ text: 'Row item', qualifier: { text: 'q', title: '<t>' } }] }]
    })
  );
  assert.ok(html.includes('<li>Plain &lt;b&gt;</li>'), html);
  assert.ok(
    html.includes(
      '<li>Station &quot;A&quot; <span data-list-qualifier title="3200 m from the clicked point&quot; onmouseover=&quot;globalThis.__pwned=1&quot; x=&quot;&lt;">3.2 km</span></li>'
    ),
    html
  );
  assert.ok(html.includes('<li>Row item <span data-list-qualifier title="&lt;t&gt;">q</span></li>'), html);
  assert.equal(/\sonmouseover=/.test(html.replace(/onmouseover=&quot;/g, '')), false, 'a live handler attribute reached the markup');
  for (const item of [7, { text: 'x', qualifier: { text: 'q' } }, { qualifier: { text: 'q', title: 't' } }]) {
    assert.throws(
      () => serializePopupFrame(surface({ details: [{ kind: 'list', label: 'x', items: [item] }] })),
      PopupFrameError,
      `list item ${JSON.stringify(item)}`
    );
  }
});

// ---------------------------------------------------------------------------
// The coordinator's collection ingress (PF2; Codex N2 correction C6) is
// tested at the REAL ingress, through collectHits and commit, in
// tests/interaction-coordinator-collect.test.mjs (M23 repair round 1: the
// two cases that stood here moved there under the same names).
// ---------------------------------------------------------------------------
