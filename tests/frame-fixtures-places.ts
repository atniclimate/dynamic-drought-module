/**
 * The place builders' frame fixtures (S30D D1 M24: state, deployer tribal,
 * BIA, AIANNH, Treaty, ecoregion), keyed by the manifest's builder id; see
 * tests/frame-fixtures.ts for the registry and its two records.
 *
 * Three exports:
 *   - PLACE_CENSUS_FIXTURES: the census click per builder (the identify-paths
 *     census runs each on a fresh page, held offline, with the observer
 *     installed);
 *   - PLACE_TIER_FIXTURES: the PF3 tier rows per builder (the popup-viewport
 *     spec runs each on a fresh page);
 *   - PLACE_FRAME_FIXTURES: the per-builder boot, click targets and expected
 *     fields, read by the two-sink describe in tests/identify-paths.spec.ts
 *     and by tests/place-popups.spec.ts.
 *
 * NO-REDISTRIBUTION GUARD (AGENTS.md rule 1): every geometry below is a
 * hand-authored rectangle or comb over the pinned Washington framing, and
 * every name an obviously synthetic fixture label. The deployer slots
 * (tribal, treaty) are answered per page by route and never written to
 * public/data; the BIA and AIANNH bodies come from tests/tribal-fixtures.ts
 * through its route helpers. No live service decides a result: gotoApp
 * installs the suite stubs, and each fixture routes the rest of its data.
 */
import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { gotoApp, waitForLayerSettled } from './helpers';
import { AIANNH_ROUTE, BIA_ROUTE, routeGeojson } from './tribal-fixtures';
import type { CensusFixture, TierFixture } from './frame-fixtures';
import {
  MIN_COMPACT_BODY_REGION_HEIGHT_PX,
  MIN_USABLE_REGION_HEIGHT_PX,
  MIN_USABLE_REGION_WIDTH_PX
} from '../src/ui/popup-viewport';

// ---------------------------------------------------------------------------
// Synthetic bodies
// ---------------------------------------------------------------------------

function rect(w: number, s: number, e: number, n: number): { type: 'Polygon'; coordinates: number[][][] } {
  return { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] };
}

/** One feature over the viewport centre of the Washington framing. */
function centreBody(properties: Record<string, unknown>, geometry: unknown = rect(-123.5, 46.0, -118.0, 48.6)): unknown {
  return { type: 'FeatureCollection', features: [{ type: 'Feature', id: 1, properties, geometry }] };
}

/**
 * The Treaty click target is the OUTLINE layer (src/layers/treaty.ts), so a
 * click must land on an edge, not an interior. The map centre's coordinates
 * are not readable in a production build, so this hand-authored comb puts an
 * edge everywhere instead: one MultiPolygon of 0.02-degree stripes with
 * 0.02-degree gaps across the whole Washington framing, so every point of it
 * lies within 0.01 degrees of a vertical edge.
 *
 * The arithmetic, at EVERY viewport the fixtures use (360 wide up to
 * 2560x1440): the boot fits the padded Washington bounds (src/config/regions.ts
 * washington_state, -124.7630 to -116.9159, padded 0.15 degrees each side by
 * src/map/camera-fit.ts regionTarget: 8.147 degrees of longitude) inside the
 * map, and the map is never wider than the viewport, so the fitted scale is at
 * least 8.147 / 2560 = 0.00318 degrees per CSS px at the widest viewport and
 * coarser everywhere else (8.147 / 1280 = 0.0064 at 1280 wide; about 0.023 at
 * 360). The farthest a click can sit from an edge, 0.01 degrees, is then at
 * most 0.01 / 0.00318 = 3.1 CSS px (1.6 px at 1280 wide, under 0.5 px at
 * 360), inside the coordinator's 6 px fine click box at every viewport, so the
 * centre click lands on an outline edge by construction. (The 0.1-degree comb
 * this replaces left about 10 px at 2560x1440: the Codex diff review.)
 */
function treatyComb(properties: Record<string, unknown>): unknown {
  const stripes: number[][][][] = [];
  // Integer steps, so no floating drift accumulates across the 213 stripes.
  for (let i = 0; i * 4 < 850; i += 1) {
    const w = (-12500 + i * 4) / 100;
    stripes.push(rect(w, 45.2, (-12500 + i * 4 + 2) / 100, 49.2).coordinates);
  }
  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', id: 1, properties, geometry: { type: 'MultiPolygon', coordinates: stripes } }]
  };
}

/** A title long enough to wrap the head over several lines (the PF3 long-head rows). */
export const LONG_TITLE_SUFFIX = ' With A Deliberately Long Synthetic Name That Wraps Across Several Lines Of The Head';

/**
 * The longest REALISTIC title for the PF3 no-scroll row (the director's Tier 1
 * test-design call, block 2, 2026-10-05, option 1: the no-scroll row measures
 * each builder with its longest realistic title, and the 107-character
 * LONG_TITLE_SUFFIX title stays only for the host-cap row). 72 characters, above
 * the longest Census AIANNH name form, about 61 characters ("... Reservation
 * and Off-Reservation Trust Land"), for BIA, AIANNH, deployer Tribal and
 * Treaty. The state builder's is "District of Columbia" (20), the longest NAME
 * in public/data/us-states.geojson. The ecoregion's title is the bundled
 * data's and is unchanged.
 */
export const REALISTIC_LONG_TITLE = 'Synthetic Fixture Nation Reservation and Off-Reservation Trust Land Area';
const REALISTIC_STATE_TITLE = 'District of Columbia';

async function fulfillJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({ status: 200, contentType: 'application/geo+json', body: JSON.stringify(body) });
}

// ---------------------------------------------------------------------------
// The verbatim caveats and the expected fields
// ---------------------------------------------------------------------------

const TRIBAL_CAVEAT =
  "This boundary comes from data supplied by this deployment's operator under its own authorization (see data/README.md in the deployed module). It is a representation, not a definitive depiction of Tribal jurisdiction; Tribal sovereignty and a Tribe's own understanding of its territory are matters of sovereign authority.";
const BIA_CAVEAT = (retrieved: string): string =>
  `This boundary is from the Bureau of Indian Affairs (BIA) American Indian and Alaska Native Land Area Representation (AIAN-LAR). Land Area Representation (LAR) feature definitions were last published in 2019. The live BIA service separately reports continuing spatial-accuracy and attribute updates. Retrieved on ${retrieved}. The layer is BIA-authoritative for BIA mission use only. This representation is for illustrative, reference, and statistical use, not legal, survey, or jurisdictional truth. It is requested live from the BIA service when the layer needs it, held only in this browser session's memory, and not bundled by this module. Tribal sovereignty and a Tribe's own understanding of its territory are matters of sovereign authority. No federal dataset maps every Tribal Nation; absence from this layer is not absence of a Nation or of its rights.`;
const TREATY_CAVEAT =
  'Agency polygons are a representation of Treaty cession areas, not a definitive depiction of Tribal jurisdiction. Treaty rights and Tribal sovereignty are matters of sovereign authority.';
export const AIANNH_CAVEATS: Readonly<Record<'legal' | 'statistical' | 'otsa', string>> = {
  legal:
    "This is a US Census Bureau representation of Tribal land (vintage January 1, 2025), requested live from the Census TIGERweb service when the layer needs it, held only in this browser session's memory, and not bundled by this module, for general spatial reference. It is a representation, not a definitive depiction of Tribal jurisdiction; Tribal sovereignty and a Tribe's own understanding of its territory are matters of sovereign authority. No federal dataset maps every Tribal Nation; absence from this layer is not absence of a Nation or of its rights.",
  statistical:
    "This is a US Census Bureau statistical geography (vintage January 1, 2025), requested live from the Census TIGERweb service when the layer needs it, held only in this browser session's memory, and not bundled by this module, for tabulation and general spatial reference. A statistical area is not a reservation, not trust land, and not a depiction of Tribal jurisdiction or land ownership; Tribal sovereignty and a Tribe's own understanding of its territory are matters of sovereign authority. No federal dataset maps every Tribal Nation; absence from this layer is not absence of a Nation or of its rights.",
  otsa:
    "This boundary is the US Census Bureau's statistical delineation (vintage January 1, 2025) of a reservation as it existed before Oklahoma statehood (1907), requested live from the Census TIGERweb service when the layer needs it, held only in this browser session's memory, and not bundled by this module. 'Statistical area' describes the Census dataset, not the land's status: in McGirt v. Oklahoma (2020) and later rulings, courts affirmed that several of these reservations were never disestablished and remain Indian country. Boundaries and legal status are matters of each Nation's sovereign authority; consult the Nation for any authoritative statement. No federal dataset maps every Tribal Nation; absence from this layer is not absence of a Nation or of its rights."
};

const DEPLOYER_NO_SOURCE = "No public source page: this layer is supplied by this deployment's operator.";

export interface PlaceLink {
  readonly label: string;
  readonly href: string;
}

/** What a place frame must carry, field for field (review :213, :224). */
export interface PlaceExpectation {
  /** The title, or null where the bundled data names it (ecoregions). */
  readonly title: string | null;
  readonly issuer: string;
  /** Detail rows by label; a function value checks the text instead of matching it. */
  readonly details: Readonly<Record<string, string | ((text: string) => boolean)>>;
  /** The representation note: its `product:variant` and its exact text. */
  readonly note: { readonly variant: string; readonly text: string } | null;
  /** The primary source: a link, or the deployer's stated reason. */
  readonly source: { readonly link: PlaceLink } | { readonly none: string };
  readonly moreLinks: readonly PlaceLink[];
}

/** One click target of a builder: the layer id it answers on and its boot steps. */
export interface PlaceTarget {
  readonly layerId: string;
  /** Run after the boot settles (the ecoregion Level IV switch). */
  readonly afterBoot?: (page: Page) => Promise<void>;
  /** Whether the panel-foot (brief) half runs for this target. */
  readonly panel: boolean;
  readonly expected: PlaceExpectation;
}

export interface PlaceFrameFixture {
  /** The manifest builder id. */
  readonly id: string;
  /** The layers= key, and the key the boot waits on. */
  readonly layerKey: string;
  /**
   * The page routes the builder's data needs, before gotoApp; `long` gives the
   * place a long title where its data allows; `title` names the place exactly
   * (the realistic-title no-scroll row) and wins over `long`.
   */
  prepare(page: Page, options?: { readonly long?: boolean; readonly title?: string }): Promise<void>;
  readonly targets: readonly [PlaceTarget, ...PlaceTarget[]];
  /** Whether `prepare({ long: true })` really lengthens the title (false where bundled data names the place). */
  readonly longTitle: boolean;
  /** The builder's longest realistic title for the PF3 no-scroll row (REALISTIC_LONG_TITLE), absent where the bundled data names the place. */
  readonly realisticTitle?: string;
}

function today(): string {
  // The BIA layer stamps the retrieval day in UTC (src/layers/bia-reservations.ts).
  return new Date().toISOString().slice(0, 10);
}

/** Choose the ecoregion detail level through its own legend control. */
async function selectEcoregionLevelIV(page: Page): Promise<void> {
  const select = page.locator('#ecoregion-level');
  await expect(select).toBeVisible();
  await select.selectOption('ecoregions-l4');
  await expect(select).toHaveValue('ecoregions-l4');
}

const STATE_LINK: PlaceLink = {
  label: 'Census cartographic boundary files',
  href: 'https://www.census.gov/geographies/mapping-files/time-series/geo/cartographic-boundary.html'
};
const EPA_LINK: PlaceLink = {
  label: 'EPA Ecoregions',
  href: 'https://www.epa.gov/eco-research/level-iii-and-iv-ecoregions-continental-united-states'
};

export const PLACE_FRAME_FIXTURES: Readonly<Record<string, PlaceFrameFixture>> = {
  state: {
    id: 'state',
    layerKey: 'states',
    longTitle: true,
    realisticTitle: REALISTIC_STATE_TITLE,
    async prepare(page, options) {
      // The bundled Census file names Washington at the centre; the long-head
      // rows serve one synthetic state rectangle instead.
      if (options?.long || options?.title !== undefined) {
        const name = options.title ?? `Synthetic State Fixture${LONG_TITLE_SUFFIX}`;
        await page.route('**/data/us-states.geojson', (route) =>
          fulfillJson(route, centreBody({ STATEFP: '53', STUSPS: 'WA', NAME: name }, rect(-124.8, 45.5, -116.9, 49.0)))
        );
      }
    },
    targets: [
      {
        layerId: 'us-states-fill',
        panel: true,
        expected: {
          title: 'Washington',
          issuer: 'Boundary from: U.S. Census Bureau (cartographic boundary)',
          details: { 'Postal code': 'WA' },
          note: null,
          source: { link: STATE_LINK },
          moreLinks: []
        }
      }
    ]
  },
  tribal: {
    id: 'tribal',
    layerKey: 'tribal',
    longTitle: true,
    realisticTitle: REALISTIC_LONG_TITLE,
    async prepare(page, options) {
      const name = options?.title ?? `Synthetic Deployer Lands Fixture${options?.long ? LONG_TITLE_SUFFIX : ''}`;
      await page.route('**/data/tribal-lands.geojson', (route) =>
        fulfillJson(
          route,
          centreBody({ LARName: name, LARGovernment: 'Synthetic Fixture Government', LARType: 'Fixture Type', GISAcres: 1000 })
        )
      );
    },
    targets: [
      {
        layerId: 'tribal-lands-fill',
        panel: true,
        expected: {
          title: 'Synthetic Deployer Lands Fixture',
          issuer: 'Supplied by this deployment',
          details: { Government: 'Synthetic Fixture Government', Type: 'Fixture Type', Acres: '1,000' },
          note: { variant: 'tribal:deployer', text: TRIBAL_CAVEAT },
          source: { none: DEPLOYER_NO_SOURCE },
          moreLinks: []
        }
      }
    ]
  },
  bia: {
    id: 'bia',
    layerKey: 'bia-reservations',
    longTitle: true,
    realisticTitle: REALISTIC_LONG_TITLE,
    async prepare(page, options) {
      // The suite stub's syntheticBiaBody (tests/tribal-fixtures.ts) serves
      // the ordinary boot; the long-head rows rename the same rectangle.
      if (options?.long || options?.title !== undefined) {
        await routeGeojson(
          page,
          BIA_ROUTE,
          centreBody({
            LARID: '99001',
            LARNAME: options.title ?? `Synthetic Reservation Fixture${LONG_TITLE_SUFFIX}`,
            CLASSIFICATION: 'Fixture Classification',
            GISACRES: 1000,
            REGION: 'Fixture Region'
          })
        );
      }
    },
    targets: [
      {
        layerId: 'bia-reservations-fill',
        panel: true,
        get expected(): PlaceExpectation {
          return {
            title: 'Synthetic Reservation Fixture',
            issuer: 'Boundary from: BIA (AIAN Land Area Representation)',
            details: { Classification: 'Fixture Classification', 'BIA region': 'Fixture Region', Acres: '1,000' },
            note: { variant: 'bia-reservations:lar', text: BIA_CAVEAT(today()) },
            source: { link: { label: 'BIA GeoPlatform', href: 'https://biamaps.geoplatform.gov/' } },
            moreLinks: [{ label: 'BIA OneMap', href: 'https://onemap-bia-geospatial.hub.arcgis.com/' }]
          };
        }
      }
    ]
  },
  aiannh: {
    id: 'aiannh',
    layerKey: 'aiannh',
    longTitle: true,
    realisticTitle: REALISTIC_LONG_TITLE,
    async prepare(page, options) {
      // The suite stub's syntheticAiannhBody puts its D1 legal fixture at the
      // centre; the long-head rows serve one D1 feature with a long name.
      if (options?.long || options?.title !== undefined) {
        await routeGeojson(
          page,
          AIANNH_ROUTE,
          centreBody({ NAME: options.title ?? `Synthetic Legal Fixture Area${LONG_TITLE_SUFFIX}`, AIANNHCC: 'D1', AIANNHNS: '90000001' })
        );
      }
    },
    targets: [
      {
        layerId: 'aiannh-fill',
        panel: true,
        expected: {
          title: 'Synthetic Legal Fixture Area',
          issuer: 'Boundary from: U.S. Census Bureau (AIANNH)',
          details: { Type: 'Federal reservation' },
          note: { variant: 'aiannh:legal', text: AIANNH_CAVEATS.legal },
          source: { link: { label: 'US Census geography', href: 'https://www.census.gov/programs-surveys/geography.html' } },
          moreLinks: []
        }
      }
    ]
  },
  treaty: {
    id: 'treaty',
    layerKey: 'treaty',
    longTitle: true,
    realisticTitle: REALISTIC_LONG_TITLE,
    async prepare(page, options) {
      const name = options?.title ?? `Synthetic Treaty Fixture Area${options?.long ? LONG_TITLE_SUFFIX : ''}`;
      await page.route('**/data/treaty-areas.geojson', (route) =>
        fulfillJson(route, treatyComb({ name, treaty_year: '1800', tribe: 'Synthetic Fixture Tribe' }))
      );
    },
    targets: [
      {
        layerId: 'treaty-areas-outline',
        panel: true,
        expected: {
          title: 'Synthetic Treaty Fixture Area',
          issuer: 'Boundary from: deployer · bundled GeoJSON',
          details: { Signed: '1800', Tribe: 'Synthetic Fixture Tribe' },
          note: { variant: 'treaty:agency-representation', text: TREATY_CAVEAT },
          source: { link: { label: 'WA DAHP WISAARD', href: 'https://wisaard.dahp.wa.gov/' } },
          moreLinks: [{ label: 'Native Land Digital', href: 'https://native-land.ca/' }]
        }
      }
    ]
  },
  ecoregion: {
    id: 'ecoregion',
    layerKey: 'ecoregions',
    // The bundled EPA PMTiles names the ecoregion; no long title is possible.
    longTitle: false,
    async prepare() {},
    targets: [
      {
        layerId: 'ecoregions-l3-fill',
        panel: true,
        expected: {
          title: null,
          issuer: 'Boundary from: U.S. EPA (Omernik Level III)',
          details: {},
          note: null,
          source: { link: EPA_LINK },
          moreLinks: []
        }
      },
      {
        // The Level IV switch lives in the map key's legend section, which the
        // console shell shows; the panel-foot half runs at Level III only.
        layerId: 'ecoregions-l4-fill',
        afterBoot: selectEcoregionLevelIV,
        panel: false,
        expected: {
          title: null,
          issuer: 'Boundary from: U.S. EPA (Omernik Level IV)',
          details: { Within: (text: string) => text.endsWith(' (Level III)') && text.length > ' (Level III)'.length },
          note: null,
          source: { link: EPA_LINK },
          moreLinks: []
        }
      }
    ]
  }
};

// ---------------------------------------------------------------------------
// Shared steps
// ---------------------------------------------------------------------------

export const MAP_ROOT = '.maplibregl-popup-content > [data-popup-frame]';
export const PANEL_ROOT = '#panel-response .panel-response-host > [data-popup-frame]';

/** Boot one target of a fixture in a view, its data routed, settled. */
export async function bootPlace(
  page: Page,
  fixture: PlaceFrameFixture,
  target: PlaceTarget,
  view: 'console' | 'brief',
  extra: { readonly embed?: boolean; readonly layers?: readonly string[] } = {}
): Promise<void> {
  const layers = [fixture.layerKey, ...(extra.layers ?? [])];
  await gotoApp(page, `?region=washington_state${extra.embed ? '&embed=true' : ''}&view=${view}&layers=${layers.join(',')}`);
  for (const key of layers) await waitForLayerSettled(page, key);
  if (target.afterBoot) await target.afterBoot(page);
}

/**
 * Click the map centre until a framed response shows in the given sink. With
 * `layerId`, only a response the coordinator stamped as answering on that
 * layer counts (`data-ddm-response`, src/map/interaction-coordinator.ts): a
 * level switch (the ecoregion Level IV select) takes effect at the next
 * render, so a click before it can still answer on the hidden level.
 */
export async function clickCentreUntilFramed(page: Page, root: string, layerId?: string): Promise<Locator> {
  const box = await page.locator('#map').boundingBox();
  if (!box) throw new Error('map container has no box');
  const framed = page.locator(layerId === undefined ? root : `${root}[data-ddm-response="${layerId}"]`);
  await expect(async () => {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(framed).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 20_000 });
  return framed;
}

/** Read every field the expectation names in ONE evaluate, then compare. */
export async function expectPlaceFields(root: Locator, expected: PlaceExpectation, label: string): Promise<string> {
  const read = await root.evaluate((el) => {
    const text = (node: Element | null): string | null => (node ? (node.textContent ?? '').trim() : null);
    const links = (selector: string): { label: string; href: string | null }[] =>
      Array.from(el.querySelectorAll(selector)).map((a) => ({ label: (a.textContent ?? '').trim(), href: a.getAttribute('href') }));
    return {
      title: text(el.querySelector('[data-popup-slot="title"]')),
      issuer: text(el.querySelector('[data-popup-slot="issuer"]')),
      details: Array.from(el.querySelectorAll('[data-detail="row"]')).map((dl) => [text(dl.querySelector('dt')), text(dl.querySelector('dd'))]),
      notes: Array.from(el.querySelectorAll('[data-popup-slot="note"][data-representation]')).map((p) => ({
        variant: p.getAttribute('data-representation'),
        text: p.textContent ?? ''
      })),
      headNotes: el.querySelectorAll('[data-popup-region="head"] [data-popup-slot="note"]').length,
      source: { text: text(el.querySelector('[data-popup-slot="source"]')), links: links('[data-popup-slot="source"] a[href]') },
      fallback: { text: text(el.querySelector('[data-popup-slot="source-fallback"]')), links: links('[data-popup-slot="source-fallback"] a[href]') },
      more: links('[data-popup-slot="more-links"] a[href]'),
      anchors: el.querySelectorAll('a[href]').length,
      product: el.getAttribute('data-popup-product')
    };
  });
  if (expected.title !== null) expect(read.title, `${label}: title`).toBe(expected.title);
  else expect((read.title ?? '').length, `${label}: title`).toBeGreaterThan(0);
  expect(read.issuer, `${label}: issuer`).toBe(expected.issuer);
  const details = Object.fromEntries(read.details.map(([k, v]) => [k ?? '', v ?? '']));
  expect(Object.keys(details).sort(), `${label}: detail labels`).toEqual(Object.keys(expected.details).sort());
  for (const [key, want] of Object.entries(expected.details)) {
    if (typeof want === 'function') expect(want(details[key] ?? ''), `${label}: detail ${key} = "${details[key]}"`).toBe(true);
    else expect(details[key], `${label}: detail ${key}`).toBe(want);
  }
  expect(read.notes, `${label}: the representation note`).toEqual(expected.note === null ? [] : [expected.note]);
  expect(read.headNotes, `${label}: a note in the head`).toBe(0);
  if ('link' in expected.source) {
    expect(read.source.links, `${label}: the head source`).toEqual([expected.source.link]);
    expect(read.fallback.links, `${label}: the body source`).toEqual([expected.source.link]);
  } else {
    // The head fits (S30D block 3): with no link the head has no source slot;
    // the reason is stated in the body's source-fallback slot alone.
    expect(read.source, `${label}: a head source slot without a link`).toEqual({ text: null, links: [] });
    expect(read.fallback, `${label}: the body source reason`).toEqual({ text: expected.source.none, links: [] });
    expect(read.anchors, `${label}: a deployer link`).toBe(0);
  }
  expect(read.more, `${label}: more links`).toEqual(expected.moreLinks);
  return read.title ?? '';
}

/**
 * Strict reachability (the cover note's rule C5): the probe point is the
 * centre of a part of the target visible inside its scroll region and the
 * viewport, and the element there is the target or inside it (never an
 * ancestor, which a clipped target would still return). An inline link that
 * wraps has one box per line, and the centre of their union can fall on the
 * paragraph between them, so each line box is probed in turn and the first
 * visible one decides.
 */
export async function expectStrictlyReachable(target: Locator, label: string): Promise<void> {
  await target.evaluate((el) => el.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  await expect
    .poll(
      async () =>
        target.evaluate((el) => {
          const region = el.closest('.coordinated-response-body, .coordinated-response-head');
          const boxes = Array.from(el.getClientRects());
          let verdict = 'not in view';
          for (const r of boxes.length > 0 ? boxes : [el.getBoundingClientRect()]) {
            const clip = region ? region.getBoundingClientRect() : r;
            const left = Math.max(r.left, clip.left, 0);
            const right = Math.min(r.right, clip.right, window.innerWidth);
            const top = Math.max(r.top, clip.top, 0);
            const bottom = Math.min(r.bottom, clip.bottom, window.innerHeight);
            if (right - left < 1 || bottom - top < 1) continue;
            const found = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
            if (found && (found === el || el.contains(found))) return 'ok';
            verdict = `covered by ${found ? `${found.tagName.toLowerCase()}.${String(found.className)}` : 'nothing'}`;
          }
          return verdict;
        }),
      { message: `${label} is not reachable at the centre of its visible part`, timeout: 7_000 }
    )
    .toBe('ok');
}

/** The body targets a builder actually carries: the source again (link or reason), any more links, the caveat note. */
function bodyTargets(root: Locator, expected: PlaceExpectation): { locator: Locator; label: string; href?: string }[] {
  const body = root.locator('[data-popup-region="body"]');
  const out: { locator: Locator; label: string; href?: string }[] = [];
  if ('link' in expected.source) {
    out.push({ locator: body.locator('[data-popup-slot="source-fallback"] a[href]'), label: 'the body source link', href: expected.source.link.href });
  } else {
    out.push({ locator: body.locator('[data-popup-slot="source-fallback"]'), label: 'the stated no-source reason' });
  }
  for (const [i, link] of expected.moreLinks.entries()) {
    out.push({ locator: body.locator('[data-popup-slot="more-links"] a[href]').nth(i), label: `the more link ${link.label}`, href: link.href });
  }
  // The caveat where the builder carries one; otherwise its last note (the
  // state's generalization note, the ecoregion description). Every place
  // builder carries one or the other.
  out.push(
    expected.note !== null
      ? { locator: body.locator('[data-popup-slot="note"][data-representation]'), label: 'the representation caveat' }
      : { locator: body.locator('[data-popup-slot="note"]').last(), label: 'the last note' }
  );
  return out;
}

async function expectBodyTargetsReachable(root: Locator, expected: PlaceExpectation, where: string): Promise<void> {
  for (const target of bodyTargets(root, expected)) {
    await expect(target.locator, `${where}: ${target.label}`).toHaveCount(1);
    if (target.href !== undefined) await expect(target.locator).toHaveAttribute('href', target.href);
    await expectStrictlyReachable(target.locator, `${where}: ${target.label}`);
  }
}

// ---------------------------------------------------------------------------
// The census fixtures
// ---------------------------------------------------------------------------

interface AuditWindow {
  __ddmFrameCheck?: (root: Element, sink: Element) => string | null;
}

function censusFixture(fixture: PlaceFrameFixture): CensusFixture {
  return async (page, h) => {
    await fixture.prepare(page);
    for (const target of fixture.targets) {
      await bootPlace(page, fixture, target, 'console');
      await h.clickCenterUntilSeen(page, `map:${target.layerId}`);
      expect((await h.readAudit(page)).violations, `${fixture.id} ${target.layerId}`).toEqual([]);
      const verdict = await page.evaluate((selector) => {
        const root = document.querySelector(selector);
        const sink = root?.parentElement;
        const check = (window as unknown as AuditWindow).__ddmFrameCheck;
        if (!root || !sink) return 'no framed response in the map popup';
        if (!check) return 'the observer is not installed';
        return check(root, sink);
      }, MAP_ROOT);
      expect(verdict, `${fixture.id} ${target.layerId}: the frame check`).toBeNull();
      await expect(page.locator(MAP_ROOT)).toHaveAttribute('data-ddm-response', target.layerId);
    }
  };
}

// ---------------------------------------------------------------------------
// The PF3 tier fixtures
// ---------------------------------------------------------------------------

const WWA_QUERY = '/eventdriven/rest/services/WWA/watch_warn_adv/MapServer/1/query';

/** The embed's reachable region (no sheet, no footer): the map rect in the viewport, inset 12 px. */
async function embedRegion(page: Page): Promise<{ top: number; left: number; bottom: number; right: number; h: number; w: number }> {
  const map = await page.locator('#map').boundingBox();
  if (!map) throw new Error('the map has no bounding box');
  const vp = page.viewportSize();
  if (!vp) throw new Error('no viewport');
  const top = Math.max(0, map.y) + 12;
  const left = Math.max(0, map.x) + 12;
  const bottom = Math.min(vp.height, map.y + map.height) - 12;
  const right = Math.min(vp.width, map.x + map.width) - 12;
  return { top, left, bottom, right, h: bottom - top, w: right - left };
}

async function sourcesAtTierBoundaries(page: Page, fixture: PlaceFrameFixture): Promise<void> {
  const target = fixture.targets[0];
  await page.setViewportSize({ width: 360, height: 300 });
  await fixture.prepare(page);
  await bootPlace(page, fixture, target, 'console', { embed: true });
  const root = await clickCentreUntilFramed(page, MAP_ROOT, target.layerId);
  const content = page.locator('.maplibregl-popup-content');
  const mapBox = await page.locator('#map').boundingBox();
  if (!mapBox) throw new Error('the map has no bounding box');
  const mapTop = Math.max(0, mapBox.y);
  // The embed's horizontal inset (the region is the map rect less its
  // margins), measured at 360 wide, sizes the width-boundary viewport below.
  const insetX = 360 - (await embedRegion(page)).w;

  // Each row names the axis it sits AT; the other axis is clear of its
  // boundary. The width row is the FULL boundary's width component
  // (MIN_USABLE_REGION_WIDTH_PX): a text column of 88 px, still FULL.
  const tiers = [
    { name: 'FULL', width: 360, height: Math.ceil(mapTop) + 24 + MIN_USABLE_REGION_HEIGHT_PX, at: 'height', boundary: MIN_USABLE_REGION_HEIGHT_PX, compact: false },
    { name: 'usable COMPACT', width: 360, height: Math.ceil(mapTop) + 24 + MIN_COMPACT_BODY_REGION_HEIGHT_PX, at: 'height', boundary: MIN_COMPACT_BODY_REGION_HEIGHT_PX, compact: true },
    { name: 'FULL width', width: Math.ceil(insetX + MIN_USABLE_REGION_WIDTH_PX), height: 300, at: 'width', boundary: MIN_USABLE_REGION_WIDTH_PX, compact: false }
  ] as const;
  for (const tier of tiers) {
    const where = `${fixture.id} at the ${tier.name} boundary`;
    await page.setViewportSize({ width: tier.width, height: tier.height });
    // The boundary claimed is the boundary measured, within one pixel.
    const r = await embedRegion(page);
    const atAxis = tier.at === 'height' ? r.h : r.w;
    expect(atAxis, `${where}: the region ${tier.at}`).toBeGreaterThanOrEqual(tier.boundary);
    expect(atAxis, `${where}: the region ${tier.at}`).toBeLessThan(tier.boundary + (tier.at === 'height' ? 2 : 1));
    if (tier.at === 'height') expect(r.w, `${where}: the region width`).toBeGreaterThanOrEqual(MIN_USABLE_REGION_WIDTH_PX);
    else expect(r.h, `${where}: the region height`).toBeGreaterThanOrEqual(MIN_USABLE_REGION_HEIGHT_PX);
    await expect
      .poll(
        async () => {
          const box = await content.boundingBox();
          if (!box) return 'no box';
          return box.y >= r.top - 1 && box.x >= r.left - 1 && box.y + box.height <= r.bottom + 1 && box.x + box.width <= r.right + 1
            ? 'ok'
            : JSON.stringify(box);
        },
        { message: `${where}: the card is not contained in the region`, timeout: 10_000 }
      )
      .toBe('ok');
    if (tier.compact) await expect(content).toHaveClass(/\bddm-popup-compact\b/);
    else await expect(content).not.toHaveClass(/\bddm-popup-compact\b/);
    await expectBodyTargetsReachable(root, target.expected, where);
    await expectStrictlyReachable(page.locator('.maplibregl-popup-close-button'), `${where}: the close control`);
  }
}

const DESKTOP_VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 }
] as const;

/** The three condition layers, so the head carries three condition rows. */
const CONDITION_LAYERS = ['nadm-drought', 'nws-alerts', 'nifc-fires'] as const;

async function longHeadAndPanel(page: Page, fixture: PlaceFrameFixture): Promise<void> {
  const target = fixture.targets[0];
  // A clean empty alert read, so the alerts row is a confirmed zero.
  await page.route(
    (url) => url.pathname.endsWith(WWA_QUERY),
    (route) => fulfillJson(route, { type: 'FeatureCollection', features: [] })
  );
  for (const viewport of DESKTOP_VIEWPORTS) {
    const where = `${fixture.id} at ${viewport.width}x${viewport.height}`;
    await page.setViewportSize(viewport);

    // The map popup: the normal desktop head shows unscrolled, the close
    // control is reachable, and the body is the scroll region holding the
    // source, the more links and the caveat. The no-scroll row measures the
    // builder's longest REALISTIC title (REALISTIC_LONG_TITLE, 72 characters,
    // above the longest Census AIANNH name form of about 61; the state's
    // "District of Columbia"), the director's Tier 1 test-design call of
    // 2026-10-05 (option 1); the 107-character long title stays for the
    // host-cap row below. A later page route wins, so each half routes its own.
    if (fixture.realisticTitle !== undefined) await fixture.prepare(page, { title: fixture.realisticTitle });
    await bootPlace(page, fixture, target, 'console', { layers: CONDITION_LAYERS });
    const root = await clickCentreUntilFramed(page, MAP_ROOT, target.layerId);
    if (fixture.realisticTitle !== undefined) await expect(root.locator('[data-popup-slot="title"]')).toHaveText(fixture.realisticTitle);
    // Three condition rows, each in full, stand first in the BODY; the head
    // keeps ONE value line (the owner's present-only head, 2026-10-01).
    const rows = root.locator('[data-popup-region="body"] [data-popup-slot="conditions"] [data-value-row]');
    expect(await rows.count(), `${where}: condition rows in the body`).toBeGreaterThanOrEqual(3);
    await expect(root.locator('[data-popup-region="head"] [data-value-row]'), `${where}: the head value line`).toHaveCount(1);
    await expect(root.locator('[data-popup-region="head"] [data-popup-slot="conditions"]'), `${where}: conditions in the head`).toHaveCount(0);
    const head = await root.locator('[data-popup-region="head"]').evaluate((el) => ({
      scroll: el.scrollHeight,
      client: el.clientHeight
    }));
    // The measured head, for the margin the director reads off the run log.
    console.log(`PF3 no-scroll head ${where}: ${JSON.stringify(head)}`);
    expect(head.scroll, `${where}: the head scrolls (${JSON.stringify(head)})`).toBeLessThanOrEqual(head.client + 1);
    await expectStrictlyReachable(page.locator('.maplibregl-popup-close-button'), `${where}: the close control`);
    const overflowY = await root.locator('[data-popup-region="body"]').evaluate((el) => getComputedStyle(el).overflowY);
    expect(overflowY, `${where}: the body is a scroll region`).toBe('auto');
    await expectBodyTargetsReachable(root, target.expected, `${where}, map popup`);

    // The panel foot: the same frame at the foot of the Brief panel; the
    // source and the caveat stay reachable there (its head may scroll: the
    // panel caps it, app.css .panel-response-host). The host-cap row keeps
    // the 107-character long title.
    await fixture.prepare(page, { long: true });
    await bootPlace(page, fixture, target, 'brief', { layers: CONDITION_LAYERS });
    const panel = await clickCentreUntilFramed(page, PANEL_ROOT, target.layerId);
    if (fixture.longTitle) await expect(panel.locator('[data-popup-slot="title"]')).toContainText(LONG_TITLE_SUFFIX.trim());
    // The host caps the frame (PF3 "cap width by the host"), long title included.
    const fit = await panel.evaluate((frame) => {
      const host = frame.parentElement;
      if (!host) return null;
      const f = frame.getBoundingClientRect();
      const h = host.getBoundingClientRect();
      return { left: f.left - h.left, right: h.right - f.right, overflow: host.scrollWidth - host.clientWidth };
    });
    expect(fit, `${where}: the panel host`).not.toBeNull();
    expect(fit!.left, `${where}: the frame starts outside the host`).toBeGreaterThanOrEqual(-0.5);
    expect(fit!.right, `${where}: the frame runs past the host`).toBeGreaterThanOrEqual(-0.5);
    expect(fit!.overflow, `${where}: the host overflows`).toBeLessThanOrEqual(1);
    await expectBodyTargetsReachable(panel, target.expected, `${where}, panel foot`);
    if ('link' in target.expected.source) {
      const headSource = panel.locator('[data-popup-region="head"] [data-popup-slot="source"] a[href]');
      await expect(headSource).toHaveAttribute('href', target.expected.source.link.href);
    }
  }
}

function tierFixture(fixture: PlaceFrameFixture): TierFixture {
  return {
    sourcesAtTierBoundaries: (page) => sourcesAtTierBoundaries(page, fixture),
    longHeadAndPanel: (page) => longHeadAndPanel(page, fixture)
  };
}

export const PLACE_CENSUS_FIXTURES: Readonly<Record<string, CensusFixture>> = Object.fromEntries(
  Object.entries(PLACE_FRAME_FIXTURES).map(([id, fixture]) => [id, censusFixture(fixture)])
);

export const PLACE_TIER_FIXTURES: Readonly<Record<string, TierFixture>> = Object.fromEntries(
  Object.entries(PLACE_FRAME_FIXTURES).map(([id, fixture]) => [id, tierFixture(fixture)])
);
