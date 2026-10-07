import { expect, test } from './offline-test';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACKNOWLEDGEMENTS,
  ACKNOWLEDGEMENT_IDS,
  PRODUCT_CREDITS,
  PROVIDERS,
  PROVIDER_KEYS,
  RAWS_PUBLIC_VIEW_NOTICE,
  type AcknowledgementId,
  type ProviderKey
} from '../src/config/acknowledgements';
import { PRODUCTS, PRODUCT_KEYS, type ProductKey } from '../src/config/products';
import { externalLinks, renderAcknowledgements } from '../src/ui/acknowledgements';
import { escapeHtml } from '../src/util/escape';

/**
 * S30D D1 M22 (DDM-P7-T11; design record acknowledgements-table.md
 * sections 5.1 and 5.2): the acknowledgements section credits every
 * `products.ts` product and every non-catalog provider by a row it renders,
 * renders a sentence only once the cite batch recorded it, and carries no
 * orphan row, no unlinked licence and no image.
 *
 * Browser-free (`verify:pure`): imports from src/ and a read-only scan of
 * the source tree on disk.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EN_DASH = String.fromCharCode(0x2013);
const EM_DASH = String.fromCharCode(0x2014);

/**
 * The references-ledger slugs the M22 cite batch (workflow wf_f7e3c5f0-9ec,
 * 2026-09-29; the director's cite sheet c01 to c28) recorded for the texts
 * this section may place. A sentence whose `citeId` is outside this list is
 * uncited and must not render. A later cite batch appends its slugs here in
 * the same commit as its rows.
 */
const CITED = new Set<string>([
  'nifc-raws-public-view',
  'osm-basemap-ground-credit',
  'osm-overpass-hydrography',
  'eia-power-plants',
  'esri-fuc-transmission-lines-host',
  'overture-buildings-theme',
  'overture-source-esri-community-maps',
  'overture-source-microsoft-ml-buildings',
  'overture-source-usgs-3dep',
  'noto-sans-glyphs-ofl',
  'usgs-3dep-hillshade-pnw-changes',
  'usgs-3dep-terrain-archive-changes',
  'usgs-3dep-landscape-signature',
  'aafc-canadian-drought-monitor',
  'statcan-2021-digital-boundary-files',
  'open-meteo-licence',
  'copernicus-marine-smoc',
  'usdm',
  'nadm-ncei',
  'nws-web-disclaimer',
  'cocorahs-data-usage-policy',
  'census-cb-2023-state-20m'
]);

const DEPLOYER = { name: 'Fixture GIS office' };

function allSentences(id: AcknowledgementId) {
  const row = ACKNOWLEDGEMENTS[id];
  return [...row.credits, ...row.changes, ...row.notices];
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

test('every products.ts product is credited by a row the section renders', () => {
  const html = renderAcknowledgements({ deployer: DEPLOYER });
  const problems: string[] = [];
  for (const key of PRODUCT_KEYS) {
    // A runtime read as well as the compile-time Record: a product added to
    // PRODUCT_KEYS with no PRODUCT_CREDITS entry fails here too.
    const ids: readonly string[] =
      (PRODUCT_CREDITS as Partial<Record<ProductKey, readonly string[]>>)[key] ?? [];
    if (ids.length === 0) problems.push(`${key}: no credit row`);
    for (const id of ids) {
      if (!(id in ACKNOWLEDGEMENTS)) problems.push(`${key}: unknown row "${id}"`);
      else if (!html.includes(`data-ack-id="${id}"`)) problems.push(`${key}: row "${id}" not rendered`);
    }
  }
  expect(problems).toEqual([]);
  console.log(
    `acknowledgements: ${PRODUCT_KEYS.length} products -> ` +
      `${new Set(PRODUCT_KEYS.flatMap((key) => PRODUCT_CREDITS[key])).size} rows`
  );
});

test('every non-catalog provider is credited by a rendered row', () => {
  const html = renderAcknowledgements({ deployer: DEPLOYER });
  for (const key of PROVIDER_KEYS) {
    for (const id of PROVIDERS[key]) expect(html, `${key} -> ${id}`).toContain(`data-ack-id="${id}"`);
  }
});

test('a credit sentence renders only after ddm-cite, and a link never changes a word', () => {
  const html = renderAcknowledgements({ deployer: DEPLOYER });
  for (const id of ACKNOWLEDGEMENT_IDS) {
    for (const sentence of allSentences(id)) {
      const cited = sentence.citeId !== null && CITED.has(sentence.citeId);
      if (!cited) {
        expect(html, `${id}: uncited text rendered`).not.toContain(escapeHtml(sentence.text));
        continue;
      }
      if (sentence.html !== undefined) {
        expect(stripTags(sentence.html), `${id}: linked form differs from the cited text`).toBe(
          sentence.text
        );
        expect(html, `${id}: cited linked sentence not rendered`).toContain(
          externalLinks(sentence.html)
        );
      } else {
        expect(html, `${id}: cited sentence not rendered`).toContain(escapeHtml(sentence.text));
      }
    }
  }
});

test('no orphan rows; the deployer row renders only when a deployer is configured', () => {
  const referenced = new Set<string>([
    ...PRODUCT_KEYS.flatMap((key: ProductKey) => PRODUCT_CREDITS[key]),
    ...PROVIDER_KEYS.flatMap((key: ProviderKey) => PROVIDERS[key])
  ]);
  expect(ACKNOWLEDGEMENT_IDS.filter((id) => !referenced.has(id))).toEqual([]);
  expect(Object.keys(ACKNOWLEDGEMENTS).sort()).toEqual([...ACKNOWLEDGEMENT_IDS].sort());
  expect(renderAcknowledgements({})).not.toContain('data-ack-id="deployer"');
  expect(renderAcknowledgements({ deployer: DEPLOYER })).toContain('data-ack-id="deployer"');
});

test('every licence renders as an https link, with only the adopted ATNI lockup image', () => {
  const html = renderAcknowledgements({ deployer: DEPLOYER });
  let licensed = 0;
  for (const id of ACKNOWLEDGEMENT_IDS) {
    const licence = ACKNOWLEDGEMENTS[id].licence;
    if (!licence) continue;
    licensed++;
    expect(licence.url, id).toMatch(/^https:\/\//);
    expect(html, `${id}: licence link`).toContain(`href="${escapeHtml(licence.url)}"`);
  }
  expect(licensed).toBeGreaterThan(0);
  expect([...html.matchAll(/<img\b[^>]*>/gi)].map(match => match[0])).toEqual([
    '<img class="ack-atni-lockup" src="./brand/atni-climate-lockup.png" alt="Affiliated Tribes of Northwest Indians, ATNI Climate" loading="lazy" />'
  ]);
  for (const id of ACKNOWLEDGEMENT_IDS) expect(ACKNOWLEDGEMENTS[id].logo.verdict).toBe('styled-text');
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1] ?? '');
  expect(hrefs.filter((href) => !href.startsWith('https://'))).toEqual([]);
});

test("the public-view RAWS notice renders verbatim under DDM's label, never as NIFC's words (DR-159)", () => {
  const html = renderAcknowledgements({});
  expect(RAWS_PUBLIC_VIEW_NOTICE.text).toBe(
    'Public-view station data for awareness only; not for on-the-ground coordination.'
  );
  const row = /<li class="ack-row" data-ack-id="nifc">([\s\S]*?)<\/li>/.exec(html)?.[1] ?? '';
  expect(row).toContain(
    `<span class="ack-notice-label">DDM notice:</span> ${RAWS_PUBLIC_VIEW_NOTICE.text}`
  );
  expect(row).not.toMatch(/class="ack-credit"[^>]*>[^<]*Public-view/);
});

test('U+2013 appears only inside the published OGL-Canada sentences, and no U+2014 anywhere', () => {
  const html = renderAcknowledgements({ deployer: DEPLOYER });
  expect(html).not.toContain(EM_DASH);
  for (const id of ACKNOWLEDGEMENT_IDS) {
    for (const sentence of allSentences(id)) {
      if (sentence.text.includes(EN_DASH)) {
        expect(sentence.text, id).toContain(`Open Government Licence ${EN_DASH} Canada`);
      }
    }
  }
});

test('name-only rows are listed for the owner card (printed, never a failure)', () => {
  const nameOnly = ACKNOWLEDGEMENT_IDS.filter((id) => allSentences(id).length === 0);
  console.log(`acknowledgements: ${nameOnly.length} name-only rows: ${nameOnly.join(', ')}`);
  expect(Array.isArray(nameOnly)).toBe(true);
});

/**
 * The attribution-site belt (design section 5.2 item 4): every src/ file
 * that declares a MapLibre source `attribution:` maps to a product or a
 * provider, so a new layer cannot declare a source without a credit row.
 */
const ATTRIBUTION_SITES: Readonly<Record<string, ProductKey | ProviderKey>> = {
  'src/layers/aiannh.ts': 'aiannh',
  // The held BC basin edition draws under the usdm product (DR-160).
  'src/layers/bc-drought.ts': 'usdm',
  'src/layers/bia-reservations.ts': 'bia-reservations',
  'src/layers/cdm-drought.ts': 'cdm-drought',
  'src/layers/drought.ts': 'drought',
  'src/layers/enso-flow.ts': 'enso-flow',
  'src/layers/gridded-index.ts': 'gridded-index',
  'src/layers/heatrisk.ts': 'heatrisk',
  'src/layers/hms-smoke.ts': 'hms-smoke',
  'src/layers/hydrography.ts': 'hydrography',
  'src/layers/nadm-drought.ts': 'nadm-drought',
  'src/layers/nifc-fires.ts': 'nifc-fires',
  'src/layers/nws-alerts.ts': 'nws-alerts',
  'src/layers/power-3d.ts': 'power-infrastructure',
  'src/layers/spc-fire-weather.ts': 'spc-fire-weather',
  'src/layers/sst-anomaly.ts': 'sst-anomaly',
  'src/layers/states.ts': 'states',
  'src/layers/usdm.ts': 'usdm',
  'src/layers/usfs-whp.ts': 'usfs-whp',
  'src/layers/whp-3d.ts': 'whp-3d',
  'src/map/satellite.ts': 'satellite-geocolor',
  'src/map/style.ts': 'basemap-ground'
};

async function listSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listSourceFiles(full)));
    else if (extname(entry.name) === '.ts' || extname(entry.name) === '.tsx') {
      out.push(relative(ROOT, full).replace(/\\/g, '/'));
    }
  }
  return out;
}

test('every src/ source attribution site maps to a credited product or provider', async () => {
  const files = await listSourceFiles(join(ROOT, 'src'));
  const sites: string[] = [];
  for (const file of files) {
    const source = await readFile(join(ROOT, file), 'utf8');
    if (/^\s*attribution\s*:/m.test(source)) sites.push(file);
  }
  const unlisted = sites.filter((file) => !(file in ATTRIBUTION_SITES));
  expect(unlisted, 'a source attribution site with no credit mapping').toEqual([]);
  const stale = Object.keys(ATTRIBUTION_SITES).filter((file) => !sites.includes(file));
  expect(stale, 'a mapped site that no longer declares an attribution').toEqual([]);
  const html = renderAcknowledgements({ deployer: DEPLOYER });
  for (const [file, key] of Object.entries(ATTRIBUTION_SITES)) {
    const rows: readonly string[] =
      key in PRODUCTS ? PRODUCT_CREDITS[key as ProductKey] : PROVIDERS[key as ProviderKey];
    expect(rows.length, file).toBeGreaterThan(0);
    for (const id of rows) expect(html, `${file} -> ${id}`).toContain(`data-ack-id="${id}"`);
  }
});
