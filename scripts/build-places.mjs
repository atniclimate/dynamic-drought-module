/**
 * Build the bundled municipal place-label source (U4e, 0.7.0).
 *
 * Source: Natural Earth 1:10m Populated Places (simple attributes), PUBLIC
 * DOMAIN (https://www.naturalearthdata.com/about/terms-of-use/), filtered to
 * United States places. Municipal names and point locations are public
 * reference data, not sovereign-jurisdiction polygons (CLAUDE.md hard rule 1
 * protects Tribal, Treaty, and sovereign-jurisdiction data; this bundles
 * neither). The raster basemap's baked-in labels cannot be toggled, so a
 * small bundled symbol source is the only honest municipal-labels delivery.
 *
 * SCALERANK is Natural Earth's zoom-density field (0 = always shown,
 * larger = only at closer zooms); the layer's text filter keys off it so
 * low zooms never place every small town (the cartography-lens density
 * requirement).
 *
 * NAMING POLICY (D-0.7.0-030, RULED 2026-07-14): GNIS/BGN-official forms
 * for Hawaiian municipalities, applied through the provenance-carrying
 * crosswalk at scripts/data/hi-gnis-crosswalk.json (built from the USGS
 * GNIS Domestic Names dataset). SAFE matches only: an ambiguous row keeps
 * the Natural Earth baseline name,
 * never a guessed spelling. A renamed place carries its GNIS feature id
 * in the bundle (`gnis`) so the provenance is structural, not a process
 * promise (the 026b pattern). Display keeps the official okina (U+02BB)
 * and macron forms; any future text search over these names applies
 * LOOKUP-ONLY apostrophe equivalence and never rewrites the display
 * string (ruling condition 2). The 512-767 glyph range (the okina) is
 * recorded in public/fonts/README.md.
 *
 * GLYPH GATE (build-failing, the 026b pattern): every emitted name must be
 * NFC-normalized and fall entirely inside the glyph ranges bundled under
 * public/fonts/glyphs/Noto Sans Regular/ (0-511 today). A name outside the
 * bundled ranges fails THIS BUILD loudly rather than failing silently as an
 * undrawn label in production (MapLibre skips labels whose range file 404s).
 *
 * Usage: node scripts/build-places.mjs
 */

import { writeFile, readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const SOURCE_URL =
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_populated_places_simple.geojson';
const RETRIEVED = '2026-07-12';

const CROSSWALK_PATH = fileURLToPath(
  new URL('./data/hi-gnis-crosswalk.json', import.meta.url)
);

/** Hawaii bounding test matching the crosswalk build's own filter, so a
 * mainland place that happens to share a Hawaiian name is never renamed. */
function inHawaii(lon, lat) {
  return lon < -154 && lat >= 18.5 && lat <= 22.5;
}

const OUT_PATH = fileURLToPath(
  new URL('../public/data/us-places.json', import.meta.url)
);
const GLYPH_DIR = fileURLToPath(
  new URL('../public/fonts/glyphs/Noto Sans Regular/', import.meta.url)
);

/** Read the bundled glyph ranges so the gate reflects what actually ships. */
async function bundledRanges() {
  const files = await readdir(GLYPH_DIR);
  return files
    .filter((f) => f.endsWith('.pbf'))
    .map((f) => f.replace('.pbf', '').split('-').map(Number))
    .sort((a, b) => a[0] - b[0]);
}

function codepointInRanges(cp, ranges) {
  return ranges.some(([lo, hi]) => cp >= lo && cp <= hi);
}

async function main() {
  console.log(`fetching ${SOURCE_URL}`);
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const fc = await res.json();

  const ranges = await bundledRanges();
  console.log(
    `bundled glyph ranges: ${ranges.map(([a, b]) => `${a}-${b}`).join(', ')}`
  );

  // The D-0.7.0-030 crosswalk: safe-match GNIS official names, keyed by the
  // Natural Earth baseline name, applied only inside the Hawaii box.
  const crosswalk = JSON.parse(await readFile(CROSSWALK_PATH, 'utf8'));
  const gnisByBaseline = new Map(
    crosswalk.entries
      .filter((e) => e.status === 'safe-match')
      .map((e) => [e.neName, e])
  );
  let renamed = 0;

  const violations = [];
  const places = [];
  for (const f of fc.features) {
    const p = f.properties ?? {};
    if (p.adm0_a3 !== 'USA') continue;
    const raw = String(p.name ?? '').trim();
    if (!raw) continue;
    // NFC is mandatory (the glyph audit): decomposed combining marks never
    // compose in MapLibre's glyph path.
    let name = raw.normalize('NFC');
    const [lon, lat] = f.geometry.coordinates;

    // GNIS official form (safe matches only; Hawaii box only). The GNIS
    // feature id ships with the renamed row: provenance the consumer (and
    // the shipped-artifact spec) can check, not a process promise.
    let gnis = null;
    const xw = gnisByBaseline.get(name);
    if (xw && inHawaii(lon, lat) && xw.gnisName !== name) {
      name = xw.gnisName.normalize('NFC');
      gnis = xw.gnisId;
      renamed++;
    }

    for (const ch of name) {
      const cp = ch.codePointAt(0);
      if (!codepointInRanges(cp, ranges)) {
        violations.push(
          `${name}: U+${cp.toString(16).toUpperCase().padStart(4, '0')} (${ch}) outside bundled glyph ranges`
        );
      }
    }
    places.push({
      name,
      lon: Math.round(lon * 1e4) / 1e4,
      lat: Math.round(lat * 1e4) / 1e4,
      // Natural Earth SCALERANK: the zoom-density key (0 = national scale).
      rank: Number.isFinite(p.scalerank) ? p.scalerank : 10,
      ...(gnis !== null ? { gnis } : {})
    });
  }
  console.log(`GNIS official forms applied: ${renamed} (safe matches only)`);

  if (violations.length > 0) {
    console.error('GLYPH GATE FAILED (fetch the missing range per public/fonts/README.md):');
    for (const v of violations) console.error(`  ${v}`);
    process.exit(1);
  }

  places.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));

  const out = {
    _comment:
      'Municipal place labels (U4e). Names and points from Natural Earth 1:10m Populated Places (public domain), United States subset, NFC-normalized, glyph-gated at build time. Hawaiian municipalities carry GNIS/BGN-official forms per D-0.7.0-030 (ruled 2026-07-14); a renamed row carries its GNIS feature id. Regenerate with node scripts/build-places.mjs.',
    meta: {
      source: 'Natural Earth 1:10m Populated Places (simple)',
      sourceUrl: SOURCE_URL,
      license: 'public domain',
      retrieved: RETRIEVED,
      naming:
        'GNIS official Hawaiian forms via scripts/data/hi-gnis-crosswalk.json (safe matches only; D-0.7.0-030)',
      count: places.length
    },
    places
  };

  await writeFile(OUT_PATH, JSON.stringify(out));
  console.log(`wrote ${OUT_PATH} (${places.length} places)`);
}

await main();
