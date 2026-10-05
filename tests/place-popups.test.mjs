import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * S30D D1 M24 (register owner-1k; DDM-P11-T04; interface-chrome-popups-text.md
 * 3.5 rows 1 to 6 and "The Conditions block"; the Codex Tier 2 review's PF1
 * and PF4, and its test rows :213, :214 and :224): the six place builders and
 * the Conditions block, fed real inputs under plain `node --test` (review
 * :229: pure model and validation tests in Node, construction and geometry in
 * the browser specs, no DOM dependency). Every assertion reads the frame
 * markup string the real builder returns.
 *
 * Red on a94eee5: the builders return the legacy markup (no
 * `data-popup-frame`), `PlaceConditions` carries `html` and no `rows`, and the
 * fire names are one joined sentence.
 */

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

const popups = await import('../src/ui/popups.ts');
const { buildPlaceConditionsHtml } = await import('../src/ui/popup-conditions.ts');
const { registry } = await import('../src/state/registry.ts');
const { dateTok } = await import('../src/util/text-tokens.ts');
const { serializePopupFrame } = await import('../src/ui/popup-frame.ts');
const { getLayerDef } = await import('../src/config/layers.ts');
const { HAZARD_CLUSTERS, HAZARD_CLUSTER_KEYS } = await import('../src/config/clusters.ts');
const { getHazardCluster, setHazardCluster } = await import('../src/state/cluster-store.ts');
const { timeline } = await import('../src/state/timeline.ts');

/**
 * S30D block 2, M24 round 2 (P1-FRAME's contract, draft DR-178): each place
 * builder returns the frame's MODEL and its layer answers `model:`, so the
 * InteractionCoordinator is the frame's one caller. Every case below
 * serializes the returned model exactly as the coordinator does, so each
 * assertion reads the markup both sinks receive. Red on round 1: the
 * builders returned the serialized string and no `...PopupModel` existed.
 */
function framed(model, name) {
  assert.equal(typeof model, 'object', `${name} returned ${typeof model}, not the frame's model`);
  assert.notEqual(model, null, `${name} returned null`);
  assert.equal(model.kind, 'place', `${name}: a place model`);
  return serializePopupFrame(model);
}
const buildStatePopupHtml = (...args) => framed(popups.buildStatePopupModel(...args), 'state');
const buildTribalPopupHtml = (...args) => framed(popups.buildTribalPopupModel(...args), 'tribal');
const buildBiaReservationPopupHtml = (...args) => framed(popups.buildBiaReservationPopupModel(...args), 'bia');
const buildAiannhPopupHtml = (...args) => framed(popups.buildAiannhPopupModel(...args), 'aiannh');
const buildTreatyPopupHtml = (...args) => framed(popups.buildTreatyPopupModel(...args), 'treaty');
const buildEcoregionPopupHtml = (...args) => framed(popups.buildEcoregionPopupModel(...args), 'ecoregion');

const NBSP = ' ';

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

/** The inner markup of the first element carrying `data-popup-slot="<slot>"`. */
function slot(html, name) {
  const match = new RegExp(`<([a-z0-9]+)[^>]*data-popup-slot="${name}"[^>]*>([\\s\\S]*?)</\\1>`).exec(html);
  return match ? match[2] : null;
}

function headOf(html) {
  return html.slice(html.indexOf('data-popup-region="head"'), html.indexOf('data-popup-region="body"'));
}

function bodyOf(html) {
  return html.slice(html.indexOf('data-popup-region="body"'));
}

function hrefsIn(fragment) {
  return [...fragment.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
}

/** Detail rows as label to text. */
function detailsOf(html) {
  return Object.fromEntries(
    [...html.matchAll(/<dl data-detail="row"><dt>([^<]*)<\/dt><dd>([^<]*)<\/dd><\/dl>/g)].map((m) => [textOf(m[1]), textOf(m[2])])
  );
}

function noteOf(html) {
  const match = /<p data-popup-slot="note" data-representation="([^"]*)">([^<]*)<\/p>/.exec(html);
  return match ? { variant: match[1], text: textOf(match[2]) } : null;
}

function doorOf(html) {
  const match = /<button type="button" class="([^"]*)" data-ddm-impact-trigger>([^<]*)<\/button>/.exec(html);
  assert.ok(match, 'the frame carries one briefing door');
  return { className: match[1], label: textOf(match[2]) };
}

const QUIET = {
  head: [{ label: 'Conditions', text: 'No condition layer (drought, NWS alerts, or wildfire perimeters) is currently active on the map.' }],
  rows: [],
  hasWarning: false,
  warningLabel: null
};

const WARNED = {
  head: [{ text: 'Wildfire' }],
  rows: [{ label: 'Wildfire', text: 'Active mapped perimeter in this area (NIFC WFIGS)', items: ['Fixture Creek'] }],
  hasWarning: true,
  warningLabel: 'Mapped wildfire perimeter'
};

const NOTHING_MAPPED = "Nothing mapped here on the active condition layers; each layer's reading is below.";

/** A PlaceConditions with the given body rows and a present-only head line. */
function conditionsOf(rows, headText, warningLabel = null) {
  return { head: [{ text: headText }], rows, hasWarning: warningLabel !== null, warningLabel };
}

// The verbatim caveats, copied from src/ui/popups.ts at a94eee5 so a
// paraphrase, a dropped sentence or a substituted generic sentence reds.
const BIA_CAVEAT = (retrieved) =>
  `This boundary is from the Bureau of Indian Affairs (BIA) American Indian and Alaska Native Land Area Representation (AIAN-LAR). Land Area Representation (LAR) feature definitions were last published in 2019. The live BIA service separately reports continuing spatial-accuracy and attribute updates. Retrieved on ${retrieved}. The layer is BIA-authoritative for BIA mission use only. This representation is for illustrative, reference, and statistical use, not legal, survey, or jurisdictional truth. It is requested live from the BIA service when the layer needs it, held only in this browser session's memory, and not bundled by this module. Tribal sovereignty and a Tribe's own understanding of its territory are matters of sovereign authority. No federal dataset maps every Tribal Nation; absence from this layer is not absence of a Nation or of its rights.`;
const TRIBAL_CAVEAT =
  "This boundary comes from data supplied by this deployment's operator under its own authorization (see data/README.md in the deployed module). It is a representation, not a definitive depiction of Tribal jurisdiction; Tribal sovereignty and a Tribe's own understanding of its territory are matters of sovereign authority.";
const TREATY_CAVEAT =
  'Agency polygons are a representation of Treaty cession areas, not a definitive depiction of Tribal jurisdiction. Treaty rights and Tribal sovereignty are matters of sovereign authority.';
const AIANNH_LEGAL =
  "This is a US Census Bureau representation of Tribal land (vintage January 1, 2025), requested live from the Census TIGERweb service when the layer needs it, held only in this browser session's memory, and not bundled by this module, for general spatial reference. It is a representation, not a definitive depiction of Tribal jurisdiction; Tribal sovereignty and a Tribe's own understanding of its territory are matters of sovereign authority. No federal dataset maps every Tribal Nation; absence from this layer is not absence of a Nation or of its rights.";
const AIANNH_STATISTICAL =
  "This is a US Census Bureau statistical geography (vintage January 1, 2025), requested live from the Census TIGERweb service when the layer needs it, held only in this browser session's memory, and not bundled by this module, for tabulation and general spatial reference. A statistical area is not a reservation, not trust land, and not a depiction of Tribal jurisdiction or land ownership; Tribal sovereignty and a Tribe's own understanding of its territory are matters of sovereign authority. No federal dataset maps every Tribal Nation; absence from this layer is not absence of a Nation or of its rights.";
const AIANNH_OTSA =
  "This boundary is the US Census Bureau's statistical delineation (vintage January 1, 2025) of a reservation as it existed before Oklahoma statehood (1907), requested live from the Census TIGERweb service when the layer needs it, held only in this browser session's memory, and not bundled by this module. 'Statistical area' describes the Census dataset, not the land's status: in McGirt v. Oklahoma (2020) and later rulings, courts affirmed that several of these reservations were never disestablished and remain Indian country. Boundaries and legal status are matters of each Nation's sovereign authority; consult the Nation for any authoritative statement. No federal dataset maps every Tribal Nation; absence from this layer is not absence of a Nation or of its rights.";

// ---------------------------------------------------------------------------
// The six builders (review :213, :224)
// ---------------------------------------------------------------------------

const EPA = 'https://www.epa.gov/eco-research/level-iii-and-iv-ecoregions-continental-united-states';

test('every place builder renders its named fields through one frame root', () => {
  const cases = [
    {
      name: 'state',
      html: buildStatePopupHtml({ NAME: 'Fixture State', STUSPS: 'FX' }, QUIET),
      title: 'Fixture State',
      issuer: 'Boundary from: U.S. Census Bureau (cartographic boundary)',
      clock: 'Edition 2023',
      details: { 'Postal code': 'FX' },
      note: null,
      hrefs: [
        'https://www.census.gov/geographies/mapping-files/time-series/geo/cartographic-boundary.html',
        'https://www.census.gov/geographies/mapping-files/time-series/geo/cartographic-boundary.html'
      ]
    },
    {
      name: 'tribal',
      html: buildTribalPopupHtml({ LARName: 'Fixture Lands', LARGovernment: 'Fixture Government', LARType: 'Fixture Type', GISAcres: 1234.4 }, QUIET),
      title: 'Fixture Lands',
      issuer: 'Supplied by this deployment',
      clock: "Edition This deployment's own data states no edition.",
      details: { Government: 'Fixture Government', Type: 'Fixture Type', Acres: (1234).toLocaleString() },
      note: { variant: 'tribal:deployer', text: TRIBAL_CAVEAT },
      hrefs: []
    },
    {
      name: 'bia',
      html: buildBiaReservationPopupHtml(
        { LARNAME: 'Fixture Reservation', CLASSIFICATION: 'Fixture Classification', REGION: 'Fixture Region', GISACRES: 1000, __DDM_RETRIEVED_ON: '2026-09-30' },
        QUIET
      ),
      title: 'Fixture Reservation',
      issuer: 'Boundary from: BIA (AIAN Land Area Representation)',
      // The head keeps the first clock; the retrieval stamp stands in the
      // body's more-clocks slot (S30D block 3, the head fits).
      clock: 'LAR definitions published 2019',
      moreClocks: `Retrieved on Sep${NBSP}30,${NBSP}2026`,
      details: { Classification: 'Fixture Classification', 'BIA region': 'Fixture Region', Acres: (1000).toLocaleString() },
      note: { variant: 'bia-reservations:lar', text: BIA_CAVEAT('2026-09-30') },
      hrefs: ['https://biamaps.geoplatform.gov/', 'https://onemap-bia-geospatial.hub.arcgis.com/', 'https://biamaps.geoplatform.gov/']
    },
    {
      name: 'treaty',
      html: buildTreatyPopupHtml({ treaty_year: '1800', tribe: 'Fixture Tribe' }, 'Fixture Treaty Area', QUIET),
      title: 'Fixture Treaty Area',
      issuer: 'Boundary from: deployer · bundled GeoJSON',
      clock: "Edition This deployment's own data states no edition.",
      details: { Signed: '1800', Tribe: 'Fixture Tribe' },
      note: { variant: 'treaty:agency-representation', text: TREATY_CAVEAT },
      hrefs: ['https://wisaard.dahp.wa.gov/', 'https://native-land.ca/', 'https://wisaard.dahp.wa.gov/']
    },
    {
      name: 'ecoregion III',
      html: buildEcoregionPopupHtml('Fixture Ecoregion', QUIET, { level: 'III' }),
      title: 'Fixture Ecoregion',
      issuer: 'Boundary from: U.S. EPA (Omernik Level III)',
      clock: 'Delineation 2012',
      details: {},
      note: null,
      hrefs: [EPA, EPA]
    },
    {
      name: 'ecoregion IV',
      html: buildEcoregionPopupHtml('Fixture Subregion', QUIET, { level: 'IV', parentL3: 'Fixture Ecoregion' }),
      title: 'Fixture Subregion',
      issuer: 'Boundary from: U.S. EPA (Omernik Level IV)',
      clock: 'Delineation 2012',
      details: { Within: 'Fixture Ecoregion (Level III)' },
      note: null,
      hrefs: [EPA, EPA]
    }
  ];
  for (const c of cases) {
    assert.ok(c.html.startsWith('<article data-popup-frame data-popup-kind="place"'), `${c.name}: ${c.html.slice(0, 80)}`);
    assert.ok(c.html.endsWith('</article>'), `${c.name}: markup beside the frame root`);
    assert.equal(textOf(slot(c.html, 'title')), c.title, c.name);
    assert.equal(textOf(slot(c.html, 'issuer')), c.issuer, c.name);
    assert.equal(textOf(slot(c.html, 'clock')), c.clock, c.name);
    const more = slot(c.html, 'more-clocks');
    assert.equal(more === null ? null : textOf(more), c.moreClocks ?? null, c.name);
    assert.equal(textOf(slot(c.html, 'value')), `Conditions ${QUIET.head[0].text}`, c.name);
    assert.deepEqual(detailsOf(c.html), c.details, c.name);
    assert.deepEqual(noteOf(c.html), c.note, c.name);
    // The source in the head, any more links and the source again in the body.
    assert.deepEqual([...hrefsIn(headOf(c.html)), ...hrefsIn(bodyOf(c.html))], c.hrefs, c.name);
    assert.equal(doorOf(c.html).label, `Open the Impact Briefing for ${c.title}`, c.name);
    // The qualifications are verbatim where a builder carries one.
    if (c.name === 'state') {
      assert.ok(
        textOf(bodyOf(c.html)).includes(
          'State boundary from the United States Census Bureau cartographic boundary file (1:20,000,000 generalization); a reference frame for conditions and resources, not a survey-grade line.'
        )
      );
    }
    if (c.name.startsWith('ecoregion')) {
      assert.ok(
        textOf(bodyOf(c.html)).includes(
          'Ecoregions denote areas of general similarity in ecosystems and in the type, quality, and quantity of environmental resources.'
        )
      );
    }
  }
});

test('every AIANNH branch carries its own approved caveat variant verbatim', () => {
  const cases = [
    { code: 'D1', type: 'Federal reservation', variant: 'aiannh:legal', text: AIANNH_LEGAL },
    { code: 'D6', type: 'Oklahoma Tribal Statistical Area (statistical)', variant: 'aiannh:otsa', text: AIANNH_OTSA },
    { code: 'E1', type: 'Alaska Native Village Statistical Area (statistical)', variant: 'aiannh:statistical', text: AIANNH_STATISTICAL },
    { code: 'Z9', type: 'Census AIANNH area', variant: 'aiannh:statistical', text: AIANNH_STATISTICAL }
  ];
  for (const c of cases) {
    const html = buildAiannhPopupHtml({ NAME: `Fixture ${c.code} Area`, AIANNHCC: c.code }, QUIET);
    assert.equal(textOf(slot(html, 'issuer')), 'Boundary from: U.S. Census Bureau (AIANNH)', c.code);
    assert.equal(textOf(slot(html, 'clock')), `Vintage Jan${NBSP}1,${NBSP}2025`, c.code);
    assert.deepEqual(detailsOf(html), { Type: c.type }, c.code);
    assert.deepEqual(noteOf(html), { variant: c.variant, text: c.text }, c.code);
    assert.deepEqual(hrefsIn(html), ['https://www.census.gov/programs-surveys/geography.html', 'https://www.census.gov/programs-surveys/geography.html'], c.code);
  }
});

test('the deployer Tribal popup links nowhere and states why it has no source', () => {
  const html = buildTribalPopupHtml({ LARName: 'Fixture Lands' }, WARNED);
  assert.ok(html.includes('data-popup-product="tribal"'));
  assert.deepEqual(hrefsIn(html), []);
  assert.equal(html.includes('<a '), false);
  const reason = "No public source page: this layer is supplied by this deployment's operator.";
  // S30D block 3 (the head fits): with no link the head has no source slot;
  // the reason is stated once, in the body's source-fallback slot.
  assert.equal(slot(html, 'source'), null);
  assert.equal(textOf(headOf(html)).includes(reason), false);
  assert.equal(textOf(slot(html, 'source-fallback')), reason);
  assert.equal(textOf(html).split(reason).length - 1, 1);
});

test('the door keeps one label and pulses only when a warning earned it; the warning stands in its row', () => {
  for (const build of [
    (c) => buildStatePopupHtml({ NAME: 'Fixture Place' }, c),
    (c) => buildTribalPopupHtml({ LARName: 'Fixture Place' }, c),
    (c) => buildBiaReservationPopupHtml({ LARNAME: 'Fixture Place' }, c),
    (c) => buildAiannhPopupHtml({ NAME: 'Fixture Place', AIANNHCC: 'D1' }, c),
    (c) => buildTreatyPopupHtml({}, 'Fixture Place', c),
    (c) => buildEcoregionPopupHtml('Fixture Place', c)
  ]) {
    const quiet = build(QUIET);
    const warned = build(WARNED);
    assert.deepEqual(doorOf(quiet), { className: 'popup-impact-btn', label: 'Open the Impact Briefing for Fixture Place' });
    assert.deepEqual(doorOf(warned), { className: 'popup-impact-btn popup-impact-btn--pulse', label: 'Open the Impact Briefing for Fixture Place' });
    // The door sits in the head's actions slot, after the source.
    assert.ok(slot(warned, 'actions').includes('data-ddm-impact-trigger'));
    // The head names the condition; its full row stands first in the body.
    assert.equal(textOf(slot(warned, 'value')), 'Wildfire');
    assert.equal(textOf(slot(warned, 'conditions')), 'Wildfire Active mapped perimeter in this area (NIFC WFIGS) Fixture Creek');
    assert.equal(headOf(warned).includes('data-popup-slot="conditions"'), false);
  }
});

// ---------------------------------------------------------------------------
// Fail soft on data (the cover note's rule C1)
// ---------------------------------------------------------------------------

test('a blank title falls to the fallback and the popup still opens', () => {
  assert.equal(textOf(slot(buildStatePopupHtml({ NAME: '   ' }, QUIET), 'title')), 'State');
  assert.equal(textOf(slot(buildStatePopupHtml({ NAME: '   ', name: 'Fixture State' }, QUIET), 'title')), 'Fixture State');
  assert.equal(textOf(slot(buildTribalPopupHtml({ LARName: ' ' }, QUIET), 'title')), 'Tribal Land Area');
  assert.equal(textOf(slot(buildBiaReservationPopupHtml({ LARNAME: '\t' }, QUIET), 'title')), 'Reservation land area');
  assert.equal(textOf(slot(buildAiannhPopupHtml({ NAME: ' ' }, QUIET), 'title')), 'Tribal land area');
  assert.equal(textOf(slot(buildTreatyPopupHtml({}, '  ', QUIET), 'title')), 'Treaty Area');
  assert.equal(textOf(slot(buildEcoregionPopupHtml(' ', QUIET), 'title')), 'Ecoregion');
  // A whitespace-only detail is left out rather than printed empty.
  assert.deepEqual(detailsOf(buildStatePopupHtml({ NAME: 'Fixture State', STUSPS: '  ' }, QUIET)), {});
  // Props missing altogether.
  for (const html of [
    buildStatePopupHtml(null, QUIET),
    buildTribalPopupHtml(null, QUIET),
    buildBiaReservationPopupHtml(null, QUIET),
    buildAiannhPopupHtml(null, QUIET),
    buildTreatyPopupHtml(null, 'Fixture Treaty Area', QUIET)
  ]) {
    assert.ok(html.startsWith('<article data-popup-frame'));
  }
});

test('the BIA retrieval stamp: a date, a malformed value shown as supplied, an absence not stated', () => {
  // The head keeps the first clock and the body's more-clocks slot the
  // retrieval stamp (S30D block 3, the head fits): read in that order.
  const clock = (stamp) => {
    const html = buildBiaReservationPopupHtml({ LARNAME: 'Fixture', __DDM_RETRIEVED_ON: stamp }, QUIET);
    assert.equal(textOf(slot(html, 'clock')), 'LAR definitions published 2019');
    return `${textOf(slot(html, 'clock'))} ${textOf(slot(html, 'more-clocks'))}`;
  };
  assert.equal(clock('2024-02-29'), `LAR definitions published 2019 Retrieved on Feb${NBSP}29,${NBSP}2024`);
  // Not a calendar date (no 30 February, no 29 February in 2025): shown as supplied, raw text kept.
  for (const bad of ['2026-02-30', '2025-02-29', '2026-13-01', 'yesterday']) {
    assert.equal(
      clock(bad),
      `LAR definitions published 2019 Retrieved on ${bad} As the issuer states it; DDM does not read it as a full date.`,
      bad
    );
  }
  for (const absent of [undefined, null, '', '  ']) {
    assert.equal(clock(absent), 'LAR definitions published 2019 Retrieved on not recorded', String(absent));
    const note = noteOf(buildBiaReservationPopupHtml({ LARNAME: 'Fixture', __DDM_RETRIEVED_ON: absent }, QUIET));
    assert.equal(note.text, BIA_CAVEAT('not recorded'));
  }
});

// ---------------------------------------------------------------------------
// The Conditions block (D1.md:145; design 3.5 "The Conditions block")
// ---------------------------------------------------------------------------

const PLACE = {
  type: 'Polygon',
  coordinates: [[[-123.5, 46.0], [-118.0, 46.0], [-118.0, 48.6], [-123.5, 48.6], [-123.5, 46.0]]]
};

function square(west, south, size = 0.4) {
  return {
    type: 'Polygon',
    coordinates: [[[west, south], [west + size, south], [west + size, south + size], [west, south + size], [west, south]]]
  };
}

/** A map double: the named fills answer their features to any query region. */
function fakeMap(fills) {
  return {
    getLayer: (id) => (Object.prototype.hasOwnProperty.call(fills, id) ? { id } : undefined),
    queryRenderedFeatures: (_region, options) => options.layers.flatMap((id) => fills[id] ?? []),
    project: ([lng, lat]) => ({ x: (lng + 180) * 10, y: (90 - lat) * 10 }),
    getContainer: () => ({ clientWidth: 100_000, clientHeight: 100_000 })
  };
}

function withLayers(keys, run) {
  for (const key of keys) {
    registry.activate(key);
    registry.setStatus(key, 'ready');
  }
  try {
    return run();
  } finally {
    for (const key of keys) registry.deactivate(key);
  }
}

test('a fire condition lists its names as list items, with its own issuer, and earns the pulse', () => {
  const result = withLayers(['nifc-fires'], () =>
    buildPlaceConditionsHtml(
      fakeMap({
        'nifc-fires-fill': [
          { properties: { attr_IncidentTypeCategory: 'WF', poly_IncidentName: 'Fixture Creek' }, geometry: square(-123.2, 46.1) },
          { properties: { attr_IncidentTypeCategory: 'WF', poly_IncidentName: 'Fixture Ridge' }, geometry: square(-118.6, 48.0) },
          { properties: { attr_IncidentTypeCategory: 'WF', poly_IncidentName: 'Fixture Outside' }, geometry: square(-110.0, 40.0) }
        ]
      }),
      [0, 0],
      PLACE
    )
  );
  assert.deepEqual(result.rows, [
    { label: 'Wildfire', text: 'Active mapped perimeter in this area (NIFC WFIGS)', items: ['Fixture Creek', 'Fixture Ridge'] }
  ]);
  assert.equal(result.hasWarning, true);
  assert.deepEqual(result.head, [{ text: 'Wildfire' }]);
  const html = buildBiaReservationPopupHtml({ LARNAME: 'Fixture Reservation' }, result);
  assert.ok(slot(html, 'conditions').includes('<ul><li>Fixture Creek</li><li>Fixture Ridge</li></ul>'), slot(html, 'conditions'));
  assert.equal(bodyOf(html).includes('Fixture Creek, Fixture Ridge'), false, 'the names were joined into one sentence');
  assert.equal(doorOf(html).className, 'popup-impact-btn popup-impact-btn--pulse');
});

test('drought rows carry the issuer clock the read feature states, and only that', () => {
  const nadm = (props) =>
    withLayers(['nadm-drought'], () =>
      buildPlaceConditionsHtml(fakeMap({ 'nadm-drought-fill': [{ properties: props, geometry: PLACE }] }), [0, 0], PLACE)
    ).rows[0];
  assert.deepEqual(nadm({ DROUGHTCAT: 'd2', YEAR_MONTH: '202608' }), {
    label: 'Drought',
    text: 'D2 Severe drought (North American Drought Monitor)',
    clock: { kind: 'point', meaning: 'month', label: 'Consensus month', at: { precision: 'month', month: '2026-08' } }
  });
  assert.equal(nadm({ DROUGHTCAT: 'D2' }).clock, undefined, 'an absent YEAR_MONTH fabricated a clock');
  assert.deepEqual(nadm({ DROUGHTCAT: 'D2', YEAR_MONTH: '202613' }).clock.at, {
    precision: 'supplied',
    text: '202613',
    explanation: 'As the issuer states it; DDM does not read it as a full date.'
  });
  const absence = nadm({ DROUGHTCAT: 'none here' });
  assert.deepEqual(absence, { label: 'Drought', text: 'No drought category polygon here (North American Drought Monitor).' });

  const usdm = (props) =>
    withLayers(['usdm'], () =>
      buildPlaceConditionsHtml(fakeMap({ 'usdm-frame-a-fill': [{ properties: props, geometry: PLACE }] }), [0, 0], PLACE)
    ).rows[0];
  assert.deepEqual(usdm({ DM: 1, MapDate: Date.UTC(2026, 8, 22) }).clock, {
    kind: 'point',
    meaning: 'map-date',
    label: 'Map date',
    at: { precision: 'date', date: '2026-09-22' }
  });
  assert.equal(usdm({ DM: 1 }).clock, undefined);
  assert.equal(usdm({ DM: 1, MapDate: 'Tuesday' }).clock.at.precision, 'supplied');
  // A clock the frame renders, and a supplied value it shows as supplied.
  const html = buildStatePopupHtml({ NAME: 'Fixture State' }, conditionsOf([usdm({ DM: 1, MapDate: 'Tuesday' })], 'Drought'));
  assert.ok(textOf(slot(html, 'conditions')).includes('Map date Tuesday As the issuer states it; DDM does not read it as a full date.'));
});

test('an alert window end is an instant only with its zone; anything else is shown as supplied', () => {
  const alert = (ends) =>
    withLayers(['nws-alerts'], () =>
      buildPlaceConditionsHtml(
        fakeMap({ 'nws-alerts-fill': [{ properties: { prod_type: 'Red Flag Warning', ends }, geometry: square(-122, 47) }] }),
        [0, 0],
        PLACE
      )
    );
  const zoned = alert('2026-09-30T18:00:00-07:00');
  assert.equal(zoned.rows[0].text, `Red Flag Warning in this area, until ${dateTok(Date.UTC(2026, 9, 1, 1, 0))} (NOAA NWS)`);
  assert.equal(zoned.rows[0].clock, undefined);
  assert.equal(zoned.hasWarning, true);
  assert.equal(zoned.warningLabel, 'Red Flag Warning');
  // The warning's words stand in its own row, so the door can stay one label.
  assert.ok(zoned.rows[0].text.includes('Red Flag Warning'));
  for (const raw of ['2026-09-30T18:00:00', '2026-02-30T18:00:00Z', 'Tonight']) {
    const row = alert(raw).rows[0];
    assert.equal(row.text, 'Red Flag Warning in this area (NOAA NWS)', raw);
    assert.deepEqual(row.clock, {
      kind: 'point',
      meaning: 'valid',
      label: 'Until',
      at: { precision: 'supplied', text: raw, explanation: 'As the issuer states it; DDM does not read it as a full date.' }
    }, raw);
  }
  assert.equal(alert(null).rows[0].text, 'Red Flag Warning in this area (NOAA NWS)');
  assert.equal(alert(null).rows[0].clock, undefined);
});

const SUPPLIED = 'As the issuer states it; DDM does not read it as a full date.';

/** The one alert row for a window end, read through the real block. */
function alertRowFor(ends) {
  return withLayers(['nws-alerts'], () =>
    buildPlaceConditionsHtml(
      fakeMap({ 'nws-alerts-fill': [{ properties: { prod_type: 'Red Flag Warning', ends }, geometry: square(-122, 47) }] }),
      [0, 0],
      PLACE
    )
  ).rows[0];
}

test('a numeric alert end outside the Date range is shown as supplied, never formatted (Codex diff review)', () => {
  // A finite number a Date cannot hold: dateTok would throw on the Invalid Date.
  for (const ends of [1e20, -1e20, 8.64e15 + 1]) {
    const row = alertRowFor(ends);
    assert.equal(row.text, 'Red Flag Warning in this area (NOAA NWS)', String(ends));
    assert.deepEqual(row.clock.at, { precision: 'supplied', text: String(ends), explanation: SUPPLIED }, String(ends));
    // The real builder still opens on it.
    const html = buildStatePopupHtml({ NAME: 'Fixture State' }, conditionsOf([row], 'NWS alert', 'Red Flag Warning'));
    assert.ok(html.startsWith('<article data-popup-frame'), String(ends));
  }
  // The range's own edge is still an instant.
  assert.equal(alertRowFor(8.64e15).text, `Red Flag Warning in this area, until ${dateTok(8.64e15)} (NOAA NWS)`);
});

test('an ISO alert end with a year below 1000 is shown as supplied, never mapped onto 19xx (Codex diff review)', () => {
  for (const ends of ['0099-01-01T00:00:00Z', '0000-01-01T00:00:00Z', '0999-12-31T23:59:59+01:00']) {
    const row = alertRowFor(ends);
    assert.equal(row.text, 'Red Flag Warning in this area (NOAA NWS)', ends);
    assert.deepEqual(row.clock.at, { precision: 'supplied', text: ends, explanation: SUPPLIED }, ends);
  }
  // The four-digit floor itself is read.
  assert.equal(
    alertRowFor('1000-01-01T00:00:00Z').text,
    `Red Flag Warning in this area, until ${dateTok(Date.UTC(1000, 0, 1))} (NOAA NWS)`
  );
});

test('a feature value that is not text is absent, never String()-ed into a throw (Codex diff review)', () => {
  const broken = { toString: null };
  // The title falls to the builder's fallback and every popup still opens.
  assert.equal(textOf(slot(buildStatePopupHtml({ NAME: broken }, QUIET), 'title')), 'State');
  assert.equal(textOf(slot(buildStatePopupHtml({ NAME: broken, name: 'Fixture State' }, QUIET), 'title')), 'Fixture State');
  assert.equal(textOf(slot(buildTribalPopupHtml({ LARName: broken }, QUIET), 'title')), 'Tribal Land Area');
  assert.equal(textOf(slot(buildBiaReservationPopupHtml({ LARNAME: broken }, QUIET), 'title')), 'Reservation land area');
  assert.equal(textOf(slot(buildAiannhPopupHtml({ NAME: broken }, QUIET), 'title')), 'Tribal land area');
  assert.equal(textOf(slot(buildEcoregionPopupHtml(broken, QUIET), 'title')), 'Ecoregion');
  // Detail values, the acres, the subtype code and the retrieval stamp alike.
  assert.deepEqual(detailsOf(buildStatePopupHtml({ NAME: 'Fixture State', STUSPS: broken }, QUIET)), {});
  assert.deepEqual(
    detailsOf(buildTribalPopupHtml({ LARName: 'Fixture Lands', LARGovernment: broken, GOVT: 'Fixture Government', LARType: broken, GISAcres: broken }, QUIET)),
    { Government: 'Fixture Government' }
  );
  const bia = buildBiaReservationPopupHtml(
    { LARNAME: 'Fixture', CLASSIFICATION: broken, REGION: broken, GISACRES: broken, __DDM_RETRIEVED_ON: broken },
    QUIET
  );
  assert.deepEqual(detailsOf(bia), {});
  assert.equal(noteOf(bia).text, BIA_CAVEAT('not recorded'));
  const aiannh = buildAiannhPopupHtml({ NAME: 'Fixture Area', AIANNHCC: broken }, QUIET);
  assert.deepEqual(detailsOf(aiannh), { Type: 'Census AIANNH area' });
  assert.deepEqual(noteOf(aiannh), { variant: 'aiannh:statistical', text: AIANNH_STATISTICAL });
  assert.deepEqual(detailsOf(buildTreatyPopupHtml({ treaty_year: broken, tribe: broken }, 'Fixture Treaty Area', QUIET)), {});
  // The Conditions block reads rendered properties the same way.
  const rows = withLayers(['nadm-drought', 'nws-alerts', 'nifc-fires'], () =>
    buildPlaceConditionsHtml(
      fakeMap({
        'nadm-drought-fill': [{ properties: { DROUGHTCAT: broken }, geometry: PLACE }],
        'nws-alerts-fill': [{ properties: { prod_type: broken }, geometry: square(-122, 47) }],
        'nifc-fires-fill': [{ properties: { attr_IncidentTypeCategory: 'WF', poly_IncidentName: broken }, geometry: square(-122, 47) }]
      }),
      [0, 0],
      PLACE
    )
  ).rows;
  assert.deepEqual(
    rows.map((row) => row.items ?? row.text),
    [
      'No drought category polygon here (North American Drought Monitor).',
      'No active NWS heat or fire weather watch, warning, or advisory in this area. Only those products are requested.',
      ['Mapped fire perimeter']
    ]
  );
});

test('nothing on, and a layer asked for but unread, keep their sentences', () => {
  // No condition layer on: the existing sentence in the head, no body rows,
  // and so no conditions slot in the frame.
  const none = buildPlaceConditionsHtml(fakeMap({}), [0, 0], PLACE);
  assert.deepEqual(none.head, [
    { label: 'Conditions', text: 'No condition layer (drought, NWS alerts, or wildfire perimeters) is currently active on the map.' }
  ]);
  assert.deepEqual(none.rows, []);
  const noneHtml = buildStatePopupHtml({ NAME: 'Fixture State' }, none);
  assert.equal(noneHtml.includes('data-popup-slot="conditions"'), false);
  registry.setStatus('nifc-fires', 'error');
  try {
    const unread = buildPlaceConditionsHtml(fakeMap({}), [0, 0], PLACE);
    assert.deepEqual(unread.head, [
      {
        label: 'Conditions',
        text: 'A condition layer is switched on but could not be read, so this card cannot describe conditions here.'
      }
    ]);
    assert.deepEqual(unread.rows, []);
  } finally {
    registry.deactivate('nifc-fires');
  }
  // Layers on, nothing reported at the place: every row is an absence, so
  // the head says DDM's own approved line and each reading is in the body,
  // in the block's order (drought, then NWS alerts, then wildfire).
  const all = withLayers(['nadm-drought', 'nws-alerts', 'nifc-fires'], () =>
    buildPlaceConditionsHtml(
      fakeMap({ 'nadm-drought-fill': [], 'nws-alerts-fill': [], 'nifc-fires-fill': [] }),
      [0, 0],
      PLACE
    )
  );
  assert.deepEqual(all.head, [{ text: NOTHING_MAPPED }]);
  assert.deepEqual(all.rows.map((row) => row.label), ['Drought', 'NWS alert', 'Wildfire']);
  const allHtml = buildStatePopupHtml({ NAME: 'Fixture State' }, all);
  assert.equal(textOf(slot(allHtml, 'value')), NOTHING_MAPPED);
  assert.equal([...bodyOf(allHtml).matchAll(/<div data-value-row>/g)].length, 3, 'the three readings stand in the body');
  assert.equal([...headOf(allHtml).matchAll(/<div data-value-row>/g)].length, 1, 'the head carries one value line');
});

test('the head names only the conditions present at the place; an absence row is never present (owner, 2026-10-01)', () => {
  const PRESENT_ONLY = withLayers(['nadm-drought', 'nifc-fires'], () =>
    buildPlaceConditionsHtml(
      fakeMap({
        'nadm-drought-fill': [{ properties: { DROUGHTCAT: 'D1' }, geometry: PLACE }],
        // A perimeter outside the place: the fire row is an absence.
        'nifc-fires-fill': [{ properties: { attr_IncidentTypeCategory: 'WF', poly_IncidentName: 'Fixture Outside' }, geometry: square(-110.0, 40.0) }]
      }),
      [0, 0],
      PLACE
    )
  );
  assert.deepEqual(PRESENT_ONLY.head, [{ text: 'Drought' }]);
  assert.deepEqual(PRESENT_ONLY.rows.map((row) => row.text), [
    'D1 Moderate drought (North American Drought Monitor)',
    'No mapped wildfire perimeter in this area (NIFC WFIGS).'
  ]);
  const html = buildAiannhPopupHtml({ NAME: 'Fixture Area', AIANNHCC: 'D1' }, PRESENT_ONLY);
  assert.equal(textOf(slot(html, 'value')), 'Drought');
  // The body's conditions slot comes first, ahead of the detail rows.
  const body = bodyOf(html);
  assert.ok(body.indexOf('data-popup-slot="conditions"') < body.indexOf('data-popup-slot="rows"'), body.slice(0, 200));
  assert.ok(textOf(body).includes('No mapped wildfire perimeter in this area (NIFC WFIGS).'));

  // Two present conditions, each label once, in table order; an absence
  // between them is not named.
  const both = withLayers(['nadm-drought', 'nws-alerts', 'nifc-fires'], () =>
    buildPlaceConditionsHtml(
      fakeMap({
        'nadm-drought-fill': [{ properties: { DROUGHTCAT: 'D2' }, geometry: PLACE }],
        'nws-alerts-fill': [],
        'nifc-fires-fill': [
          { properties: { attr_IncidentTypeCategory: 'WF', poly_IncidentName: 'Fixture Creek' }, geometry: square(-123.2, 46.1) }
        ]
      }),
      [0, 0],
      PLACE
    )
  );
  assert.deepEqual(both.head, [{ text: 'Drought · Wildfire' }]);
  // Two alert products present: their one label once.
  const alerts = withLayers(['nws-alerts'], () =>
    buildPlaceConditionsHtml(
      fakeMap({
        'nws-alerts-fill': [
          { properties: { prod_type: 'Heat Advisory' }, geometry: square(-122, 47) },
          { properties: { prod_type: 'Red Flag Warning' }, geometry: square(-121, 47) }
        ]
      }),
      [0, 0],
      PLACE
    )
  );
  assert.deepEqual(alerts.head, [{ text: 'NWS alert' }]);
  assert.equal(alerts.rows.length, 2);
});

// ---------------------------------------------------------------------------
// Read completeness apart from presence (draft DR-179; the Codex review of
// round 1, 2026-10-04, finding 1 and B2) and ENSO's interim line (draft
// DR-180). Red on round 1: a status row counted as "nothing present" and the
// head read "Nothing mapped here" over an unread layer; a loading layer with
// no fill fell through to the nothing-on sentence; a degraded NIFC read and
// an unread drought read stated an absence in the body.
// ---------------------------------------------------------------------------

const NOT_EVERY_READ = "Not every condition layer has been read here yet; each layer's state is below.";
const NOTHING_ON = 'No condition layer (drought, NWS alerts, or wildfire perimeters) is currently active on the map.';
const COULD_NOT_READ = 'A condition layer is switched on but could not be read, so this card cannot describe conditions here.';
const NO_ROW_FOR_MODE = 'No condition layer for this mode is currently active';

/**
 * Leave each layer's registry state as the app leaves it, run, then clear it.
 * `on` is a registered key (a module that resolved, or one whose later
 * refresh failed and kept its fill); off with a status is an activation still
 * loading (the controller registers a key only once it resolves) or one that
 * failed (the controller drops the key and keeps its 'error').
 */
function withRegistry(entries, run) {
  for (const { key, status, on } of entries) {
    if (on) registry.activate(key);
    if (status !== undefined) registry.setStatus(key, status);
  }
  try {
    return run();
  } finally {
    for (const { key } of entries) registry.deactivate(key);
  }
}

/** A layer's own name, as the sidebar shows it (src/config/layers.ts). */
function layerName(key) {
  const def = getLayerDef(key);
  assert.ok(def, `${key} has no layer definition`);
  return def.name;
}

const OUTSIDE = square(-110.0, 40.0);

test('a present condition names the head even beside an unread layer (head branch a)', () => {
  const result = withRegistry(
    [
      { key: 'nadm-drought', status: 'ready', on: true },
      { key: 'nws-alerts', status: 'error', on: true }
    ],
    () =>
      buildPlaceConditionsHtml(
        fakeMap({ 'nadm-drought-fill': [{ properties: { DROUGHTCAT: 'D1' }, geometry: PLACE }], 'nws-alerts-fill': [] }),
        [0, 0],
        PLACE
      )
  );
  assert.deepEqual(result.head, [{ text: 'Drought' }]);
  assert.deepEqual(result.rows, [
    { label: 'Drought', text: 'D1 Moderate drought (North American Drought Monitor)' },
    { label: 'NWS alert', text: 'Unavailable, so this card cannot say whether one is active in this area.' }
  ]);
});

test('a confirmed empty read on every active layer still says "Nothing mapped here" (head branch b)', () => {
  const result = withRegistry(
    [
      { key: 'nadm-drought', status: 'ready', on: true },
      { key: 'nws-alerts', status: 'no-data', on: true },
      { key: 'nifc-fires', status: 'no-data', on: true }
    ],
    () =>
      buildPlaceConditionsHtml(
        fakeMap({ 'nadm-drought-fill': [], 'nws-alerts-fill': [], 'nifc-fires-fill': [] }),
        [0, 0],
        PLACE
      )
  );
  assert.deepEqual(result.head, [{ text: NOTHING_MAPPED }]);
  assert.deepEqual(
    result.rows.map((row) => row.text),
    [
      'No drought category polygon here (North American Drought Monitor).',
      'No active NWS heat or fire weather watch, warning, or advisory in this area. Only those products are requested.',
      'No mapped wildfire perimeter in this area (NIFC WFIGS).'
    ]
  );
  const html = buildStatePopupHtml({ NAME: 'Fixture State' }, result);
  assert.equal(textOf(slot(html, 'value')), NOTHING_MAPPED);
});

test('a refresh failure that keeps the fill: the head says not every layer has been read (head branch c)', () => {
  // src/layers/nws-alerts.ts refreshSnapshot: a failed refresh clears the
  // displayed snapshot and reports 'error' while the fill and the active key
  // stay; a transfer-limited answer reports 'degraded'.
  for (const [status, sentence] of [
    ['error', 'Unavailable, so this card cannot say whether one is active in this area.'],
    ['degraded', 'The response was incomplete, so this card cannot rule one out in this area.']
  ]) {
    const result = withRegistry([{ key: 'nws-alerts', status, on: true }], () =>
      buildPlaceConditionsHtml(fakeMap({ 'nws-alerts-fill': [] }), [0, 0], PLACE)
    );
    assert.deepEqual(result.head, [{ text: NOT_EVERY_READ }], status);
    assert.deepEqual(result.rows, [{ label: 'NWS alert', text: sentence }], status);
    const html = buildBiaReservationPopupHtml({ LARNAME: 'Fixture Reservation' }, result);
    assert.equal(textOf(slot(html, 'value')), NOT_EVERY_READ, status);
    assert.equal(textOf(slot(html, 'conditions')), `NWS alert ${sentence}`, status);
    assert.equal(headOf(html).includes(NOTHING_MAPPED), false, status);
  }
});

test('a degraded NIFC read with no perimeter here states no absence; a perimeter it did read is still named', () => {
  // src/layers/nifc-fires.ts: a truncated load reports 'degraded' ("live (partial)").
  const unread = withRegistry([{ key: 'nifc-fires', status: 'degraded', on: true }], () =>
    buildPlaceConditionsHtml(
      fakeMap({ 'nifc-fires-fill': [{ properties: { attr_IncidentTypeCategory: 'WF', poly_IncidentName: 'Fixture Outside' }, geometry: OUTSIDE }] }),
      [0, 0],
      PLACE
    )
  );
  assert.deepEqual(unread.head, [{ text: NOT_EVERY_READ }]);
  assert.deepEqual(unread.rows, [{ label: 'Wildfire', text: layerName('nifc-fires'), state: 'live (partial)' }]);
  assert.equal(unread.hasWarning, false);
  const read = withRegistry([{ key: 'nifc-fires', status: 'degraded', on: true }], () =>
    buildPlaceConditionsHtml(
      fakeMap({ 'nifc-fires-fill': [{ properties: { attr_IncidentTypeCategory: 'WF', poly_IncidentName: 'Fixture Creek' }, geometry: square(-123.2, 46.1) }] }),
      [0, 0],
      PLACE
    )
  );
  assert.deepEqual(read.head, [{ text: 'Wildfire' }]);
  assert.deepEqual(read.rows, [{ label: 'Wildfire', text: 'Active mapped perimeter in this area (NIFC WFIGS)', items: ['Fixture Creek'] }]);
});

test('a condition layer still loading with no fill: not every layer read, never the nothing-on sentence (Codex B2)', () => {
  const cases = [
    { key: 'nadm-drought', row: { label: 'Drought', text: layerName('nadm-drought'), state: 'loading' } },
    { key: 'usdm', row: { label: 'Drought', text: layerName('usdm'), state: 'loading' } },
    { key: 'nws-alerts', row: { label: 'NWS alert', text: 'Still loading, so this card cannot say whether one is active in this area.' } },
    { key: 'nifc-fires', row: { label: 'Wildfire', text: layerName('nifc-fires'), state: 'loading' } }
  ];
  for (const c of cases) {
    // Status 'loading', key not yet registered, no fill in the style.
    const result = withRegistry([{ key: c.key, status: 'loading', on: false }], () =>
      buildPlaceConditionsHtml(fakeMap({}), [0, 0], PLACE)
    );
    assert.deepEqual(result.head, [{ text: NOT_EVERY_READ }], c.key);
    assert.deepEqual(result.rows, [c.row], c.key);
    const html = buildAiannhPopupHtml({ NAME: 'Fixture Area', AIANNHCC: 'D1' }, result);
    assert.equal(textOf(slot(html, 'value')).includes(NOTHING_ON), false, c.key);
  }
});

test('no body row states an absence from a layer whose read is loading, incomplete or unavailable', () => {
  const fills = {
    'nadm-drought': { 'nadm-drought-fill': [{ properties: { DROUGHTCAT: 'none' }, geometry: PLACE }] },
    usdm: { 'usdm-frame-a-fill': [{ properties: { MapDate: 0 }, geometry: PLACE }] },
    'nws-alerts': { 'nws-alerts-fill': [] },
    'nifc-fires': { 'nifc-fires-fill': [{ properties: { attr_IncidentTypeCategory: 'WF' }, geometry: OUTSIDE }] }
  };
  const word = { loading: 'loading', degraded: 'live (partial)', error: 'unavailable' };
  for (const status of ['loading', 'degraded', 'error']) {
    for (const [key, fill] of Object.entries(fills)) {
      const result = withRegistry([{ key, status, on: true }], () => buildPlaceConditionsHtml(fakeMap(fill), [0, 0], PLACE));
      const where = `${key} ${status}`;
      assert.equal(result.rows.length, 1, where);
      assert.doesNotMatch(result.rows[0].text, /^No /, `${where}: an absence from an unread layer`);
      assert.deepEqual(result.head, [{ text: NOT_EVERY_READ }], where);
      if (key !== 'nws-alerts') {
        assert.deepEqual(result.rows[0], { label: result.rows[0].label, text: layerName(key), state: word[status] }, where);
      }
    }
  }
  // The same fills read completely keep their absence sentences.
  for (const [key, fill] of Object.entries(fills)) {
    const result = withRegistry([{ key, status: 'ready', on: true }], () => buildPlaceConditionsHtml(fakeMap(fill), [0, 0], PLACE));
    assert.match(result.rows[0].text, /^No /, `${key} ready`);
    assert.deepEqual(result.head, [{ text: NOTHING_MAPPED }], `${key} ready`);
  }
});

test('a layer that failed to activate beside a complete read: not every layer read, never "Nothing mapped here"', () => {
  // The drought read is complete and its absence stands; the failed layer
  // (its key dropped, its 'error' kept) states its own state in the body,
  // in table order, since the head promises each layer's state below (the
  // Codex review of dbf5e1fa, P2 2: it used to leave no row).
  const result = withRegistry(
    [
      { key: 'nifc-fires', status: 'error', on: false },
      { key: 'nadm-drought', status: 'ready', on: true }
    ],
    () => buildPlaceConditionsHtml(fakeMap({ 'nadm-drought-fill': [] }), [0, 0], PLACE)
  );
  assert.deepEqual(result.head, [{ text: NOT_EVERY_READ }]);
  assert.deepEqual(result.rows, [
    { label: 'Drought', text: 'No drought category polygon here (North American Drought Monitor).' },
    { label: 'Wildfire', text: layerName('nifc-fires'), state: 'unavailable' }
  ]);
});

// The Codex review of dbf5e1fa (C:/dev/_reviews/dynamic-drought-module/
// b3m24-proofs/read-completeness.test.mjs), ported as regression cases.

test('a failed activation has a body state when the head promises each layer state below (Codex P2 2)', () => {
  const result = withRegistry(
    [
      { key: 'nadm-drought', status: 'ready', on: true },
      { key: 'nifc-fires', status: 'error', on: false }
    ],
    () => buildPlaceConditionsHtml(fakeMap({ 'nadm-drought-fill': [] }), [0, 0])
  );
  assert.match(result.head[0].text, /each layer's state is below/);
  assert.ok(result.rows.some((row) => row.label === 'Wildfire' && row.state === 'unavailable'), JSON.stringify(result));
  // With no other row the head keeps its own sentence and promises nothing below.
  const alone = withRegistry([{ key: 'nifc-fires', status: 'error', on: false }], () =>
    buildPlaceConditionsHtml(fakeMap({}), [0, 0], PLACE)
  );
  assert.deepEqual(alone.head, [{ label: 'Conditions', text: COULD_NOT_READ }]);
  assert.deepEqual(alone.rows, []);
});

test('a ready USDM change register does not assert nothing is mapped (Codex P2 1)', () => {
  // The change register shows change polygons and hides the category slots
  // (src/layers/usdm.ts): the card read no current category, so the register
  // row establishes neither presence nor absence.
  timeline.setUsdmMode('chg1');
  try {
    const result = withRegistry([{ key: 'usdm', status: 'ready', on: true }], () =>
      buildPlaceConditionsHtml(
        fakeMap({ 'usdm-change-fill': [{ properties: { USDM_CHANGE: 1 } }], 'usdm-frame-a-fill': [], 'usdm-frame-b-fill': [] }),
        [0, 0]
      )
    );
    assert.match(result.rows[0].text, /change register/);
    assert.doesNotMatch(result.head[0].text, /Nothing mapped here/, JSON.stringify(result));
    assert.deepEqual(result.head, [{ text: NOT_EVERY_READ }]);
  } finally {
    timeline.setUsdmMode('absolute');
  }
});

test('in a mode with no place row the nothing-on head reads the interim line; the other sentences keep their cases (draft DR-180)', () => {
  const before = getHazardCluster();
  const deferred = HAZARD_CLUSTER_KEYS.filter((mode) => HAZARD_CLUSTERS[mode].placeConditionRow === null);
  assert.ok(deferred.length > 0, 'no mode defers its place row, so the interim line is unexercised');
  try {
    for (const mode of HAZARD_CLUSTER_KEYS) {
      setHazardCluster(mode);
      const none = buildPlaceConditionsHtml(fakeMap({}), [0, 0], PLACE);
      const want = HAZARD_CLUSTERS[mode].placeConditionRow === null ? NO_ROW_FOR_MODE : NOTHING_ON;
      assert.deepEqual(none.head, [{ label: 'Conditions', text: want }], mode);
      assert.deepEqual(none.rows, [], mode);
      // A layer asked for and unread keeps its own sentence in every mode.
      const failed = withRegistry([{ key: 'nws-alerts', status: 'error', on: false }], () =>
        buildPlaceConditionsHtml(fakeMap({}), [0, 0], PLACE)
      );
      assert.deepEqual(failed.head, [{ label: 'Conditions', text: COULD_NOT_READ }], mode);
      // A switched-on layer is never "not active", in any mode.
      const loading = withRegistry([{ key: 'nws-alerts', status: 'loading', on: false }], () =>
        buildPlaceConditionsHtml(fakeMap({}), [0, 0], PLACE)
      );
      assert.deepEqual(loading.head, [{ text: NOT_EVERY_READ }], mode);
    }
    setHazardCluster(deferred[0]);
    const html = buildStatePopupHtml({ NAME: 'Fixture State' }, buildPlaceConditionsHtml(fakeMap({}), [0, 0], PLACE));
    assert.equal(textOf(slot(html, 'value')), `Conditions ${NO_ROW_FOR_MODE}`);
  } finally {
    setHazardCluster(before);
  }
});
