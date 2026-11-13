/**
 * Build DDM's own base map from public files (DDM-P17-T12), replacing the
 * OpenStreetMap raster ground and the Overpass river lookups.
 *
 * Three PMTiles vector archives land in public/data/:
 *   ddm-base-na-<edition>.pmtiles     North America box, zoom 0 to 8 (the map
 *                                      overzooms to 14): land, water bodies
 *                                      (lakes, reservoirs, wetlands, glaciers),
 *                                      rivers and canals, country, province and
 *                                      Mexican state lines, county lines,
 *                                      place, water and sea names.
 *   ddm-roads-na-<edition>.pmtiles    The same box and zooms: federal and state
 *                                      highways (U.S.) and principal highways
 *                                      (Canada), with route names; its own file
 *                                      so each stays under the 20 MB line.
 *   ddm-base-world-<edition>.pmtiles  The rest of the world, zoom 0 to 5: land,
 *                                      lakes, country lines, major places, seas.
 *
 * Sources (all public; the receipt table scripts/data/base-tiles-inputs.json
 * pins every file by SHA-256 and retrieval date):
 *   - U.S. Census Bureau: 2025 cartographic boundary files (states, counties,
 *     1:500,000) and TIGER/Line 2025 primary and secondary roads. Federal
 *     works, public domain; Census asks to be cited as the source.
 *   - U.S. Geological Survey: 1:1,000,000-scale waterbodies and wetlands,
 *     streams, and cities and towns (National Atlas small-scale data, 2014).
 *     USGS-authored data are U.S. public domain.
 *   - Natural Resources Canada: Atlas of Canada National Scale Data
 *     1:1,000,000 (landmass, boundary lines, waterbodies, rivers, roads, place
 *     names). Open Government Licence - Canada.
 *   - Natural Earth 1:10m v5.1.2 (public domain): everything outside the U.S.
 *     and Canada, and the world below zoom 6.
 *
 * Tribal and Treaty boundaries never enter either archive: they stay
 * live-read from their publishing services (CLAUDE.md, Tribal boundaries are
 * public), and the build refuses a layer whose name suggests one.
 *
 * Usage: node --max-old-space-size=12288 scripts/build-base-tiles.mjs
 *   DDM_BASE_CACHE  download and unpack folder (default <tmp>/ddm-base-cache;
 *                   about 810 MB of downloads, 1.5 GB unpacked)
 *   DDM_BASE_REPIN=1  accept changed input hashes and rewrite the receipt
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { unzipSync } from 'fflate';
import mapshaper from 'mapshaper';
import { PMTiles } from 'pmtiles';
import { geojsonLayersToPmtiles } from './lib/geojson-to-pmtiles.mjs';

export const EDITION = '2026-11';
/** The North America detail box [w, s, e, n]; the world archive is everything outside it. */
const NA_BOX = [-180, 14, -50, 84];
const NA_MAX_ZOOM = 8;
const WORLD_MAX_ZOOM = 5;
/** DR-150: above this an archive goes to R2 (the owner's upload), not the public tree. */
const SIZE_LINE_BYTES = 20 * 1024 * 1024;

const CACHE = (process.env.DDM_BASE_CACHE ?? join(tmpdir(), 'ddm-base-cache')).replaceAll('\\', '/');
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RECEIPT_PATH = join(ROOT, 'scripts/data/base-tiles-inputs.json');
const OUT_NA = join(ROOT, `public/data/ddm-base-na-${EDITION}.pmtiles`);
const OUT_WORLD = join(ROOT, `public/data/ddm-base-world-${EDITION}.pmtiles`);
const OUT_ROADS = join(ROOT, `public/data/ddm-roads-na-${EDITION}.pmtiles`);
const GLYPH_DIR = join(ROOT, 'public/fonts/glyphs/Noto Sans Regular');
const HI_CROSSWALK = join(ROOT, 'scripts/data/hi-gnis-crosswalk.json');

const NE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson';
const AC = 'https://ftp.maps.canada.ca/pub/nrcan_rncan/vector/framework_cadre/Atlas_of_Canada_1M';
const SMALL = 'https://prd-tnm.s3.amazonaws.com/StagedProducts/Small-scale/data';
const TIGER = 'https://www2.census.gov/geo/tiger';
const STATE_FIPS = ('01 02 04 05 06 08 09 10 11 12 13 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 ' +
  '31 32 33 34 35 36 37 38 39 40 41 42 44 45 46 47 48 49 50 51 53 54 55 56 72').split(' ');

const ISSUERS = {
  census: 'U.S. Census Bureau (public domain; cite the Census Bureau as the source)',
  usgs: 'U.S. Geological Survey (U.S. public domain)',
  nrcan: 'Natural Resources Canada (Open Government Licence - Canada)',
  ne: 'Natural Earth (public domain)'
};

/** Every input file: key, URL, issuer. */
const INPUTS = [
  ['ne-land', `${NE}/ne_10m_land.geojson`, 'ne'],
  ['ne-countries', `${NE}/ne_10m_admin_0_countries.geojson`, 'ne'],
  ['ne-lakes', `${NE}/ne_10m_lakes.geojson`, 'ne'],
  ['ne-rivers', `${NE}/ne_10m_rivers_lake_centerlines.geojson`, 'ne'],
  ['ne-country-lines', `${NE}/ne_10m_admin_0_boundary_lines_land.geojson`, 'ne'],
  ['ne-region-lines', `${NE}/ne_10m_admin_1_states_provinces_lines.geojson`, 'ne'],
  ['ne-places', `${NE}/ne_10m_populated_places_simple.geojson`, 'ne'],
  ['ne-marine', `${NE}/ne_10m_geography_marine_polys.geojson`, 'ne'],
  ['us-states', `${TIGER}/GENZ2025/shp/cb_2025_us_state_500k.zip`, 'census'],
  ['us-counties', `${TIGER}/GENZ2025/shp/cb_2025_us_county_500k.zip`, 'census'],
  ...STATE_FIPS.map((f) => [`us-roads-${f}`, `${TIGER}/TIGER2025/PRISECROADS/tl_2025_${f}_prisecroads.zip`, 'census']),
  ['us-water', `${SMALL}/Hydrography/wtrbdyp010g.shp_nt00886.tar.gz`, 'usgs'],
  ['us-streams', `${SMALL}/Hydrography/streaml010g.shp_nt00885.tar.gz`, 'usgs'],
  ['us-cities', `${SMALL}/Boundaries/citiesx010g_shp_nt00962.tar.gz`, 'usgs'],
  ['ca-land', `${AC}/boundary/AC_1M_BoundaryPolygons.shp.zip`, 'nrcan'],
  ['ca-lines', `${AC}/boundary/AC_1M_BoundaryLines.shp.zip`, 'nrcan'],
  ['ca-water', `${AC}/hydrology/AC_1M_Waterbodies.shp.zip`, 'nrcan'],
  ['ca-rivers', `${AC}/hydrology/AC_1M_Rivers.shp.zip`, 'nrcan'],
  ['ca-roads', `${AC}/transportation/AC_1M_Roads.shp.zip`, 'nrcan'],
  ['ca-places', `${AC}/place_names/AC_1M_PlaceNames.shp.zip`, 'nrcan']
];

/** Download once into the cache (a .part file keeps a broken download from passing as whole). */
async function fetchCached(url) {
  const path = `${CACHE}/${basename(url)}`;
  if (existsSync(path) && (await stat(path)).size > 0) return path;
  console.log(`  downloading ${url}`);
  // One at a time: the NRCan host drops parallel connections.
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${url} -> HTTP ${res.status}`);
  await writeFile(`${path}.part`, Buffer.from(await res.arrayBuffer()));
  await rename(`${path}.part`, path);
  return path;
}

/** Minimal ustar reader: regular files only, which is all these archives hold. */
function untar(buf) {
  const files = {};
  const text = (o, n) => buf.toString('latin1', o, o + n).replace(/\0[\s\S]*$/, '');
  for (let o = 0; o + 512 <= buf.length; ) {
    const name = text(o, 100);
    if (!name) break;
    const prefix = text(o + 345, 155);
    const size = parseInt(text(o + 124, 12).trim() || '0', 8);
    const type = buf[o + 156];
    o += 512;
    if (type === 0x30 || type === 0) files[prefix ? `${prefix}/${name}` : name] = buf.subarray(o, o + size);
    o += Math.ceil(size / 512) * 512;
  }
  return files;
}

/** Unpack a zip or tar.gz beside the cache once; returns the unpack folder. */
async function unpack(path) {
  const dir = `${CACHE}/unpacked/${basename(path).replace(/\.(zip|tar\.gz)$/, '')}`;
  if (existsSync(`${dir}/.done`)) return dir;
  const buf = await readFile(path);
  const members = path.endsWith('.zip')
    ? Object.fromEntries(Object.entries(unzipSync(new Uint8Array(buf))).map(([k, v]) => [k, Buffer.from(v)]))
    : untar(gunzipSync(buf));
  for (const [name, bytes] of Object.entries(members)) {
    if (name.endsWith('/') || name.includes('..')) continue;
    await mkdir(dirname(`${dir}/${name}`), { recursive: true });
    await writeFile(`${dir}/${name}`, bytes);
  }
  await writeFile(`${dir}/.done`, '');
  return dir;
}

/** Find one member by basename inside an unpack folder (zips nest a subfolder). */
async function member(dir, name) {
  for (const entry of await readdir(dir, { recursive: true })) {
    if (basename(entry) === name) return `${dir}/${entry}`.replaceAll('\\', '/');
  }
  throw new Error(`${name} not found in ${dir}`);
}

/** Run a mapshaper command and return its GeoJSON output. */
async function ms(cmd) {
  const out = await mapshaper.applyCommands(`${cmd} -o out.json format=geojson precision=0.0001`);
  const text = out['out.json'];
  if (!text) throw new Error(`mapshaper produced no output for: ${cmd.slice(0, 120)}`);
  const json = JSON.parse(text.toString());
  // A layer with no attribute fields comes back as a GeometryCollection.
  if (json.type === 'GeometryCollection') {
    return fc(json.geometries.filter(Boolean).map((geometry) => ({ type: 'Feature', properties: {}, geometry })));
  }
  return { ...json, features: json.features.filter((f) => f.geometry) };
}

const fc = (features) => ({ type: 'FeatureCollection', features });

/** Whether a point lies inside a geometry's bounds (a cheap guard against a composition step losing a whole region). */
function inBounds(geometry, [x, y]) {
  let w = 180, s = 90, e = -180, n = -90;
  const visit = (c) => {
    if (typeof c[0] === 'number') {
      w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); n = Math.max(n, c[1]);
    } else c.forEach(visit);
  };
  visit(geometry.coordinates);
  return x >= w && x <= e && y >= s && y <= n;
}

const km = ([x1, y1], [x2, y2]) => {
  const r = Math.PI / 180;
  const a = Math.sin(((y2 - y1) * r) / 2) ** 2 + Math.cos(y1 * r) * Math.cos(y2 * r) * Math.sin(((x2 - x1) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
};
const lineKm = (line) => line.slice(1).reduce((sum, pt, i) => sum + km(line[i], pt), 0);

/**
 * The U.S.-Mexico border as the stretch of the Census border states' outline between its two ends, the
 * Pacific terminus and the Rio Grande mouth, taken the shorter way round so no coast joins it. Fails the
 * build if an end has no outline vertex within 2 km or the length is far from the border's 3,145 km.
 */
function borderArc(collection, from, to) {
  const rings = collection.features.flatMap(({ geometry: g }) => (g.type === 'Polygon' ? [g.coordinates[0]] : g.coordinates.map((poly) => poly[0])));
  const ring = rings.reduce((a, b) => (b.length > a.length ? b : a));
  const nearest = (pt) => {
    let best = 0;
    ring.forEach((v, i) => { if (km(v, pt) < km(ring[best], pt)) best = i; });
    if (km(ring[best], pt) > 2) throw new Error(`border end ${pt} has no outline vertex within 2 km`);
    return best;
  };
  const [i, j] = [nearest(from), nearest(to)].sort((a, b) => a - b);
  const inside = ring.slice(i, j + 1);
  const around = [...ring.slice(j), ...ring.slice(1, i + 1)]; // the ring is closed: its first and last vertex are one point
  const arc = lineKm(inside) <= lineKm(around) ? inside : around;
  const length = lineKm(arc);
  if (length < 2800 || length > 3600) throw new Error(`U.S.-Mexico border measured ${Math.round(length)} km, expected about 3,145`);
  return arc;
}

/** Run mapshaper over an in-memory collection (`-i in.json` in the command). */
async function msData(cmd, collection) {
  const out = await mapshaper.applyCommands(`${cmd} -o out.json format=geojson precision=0.0001`, { 'in.json': JSON.stringify(collection) });
  return JSON.parse(out['out.json'].toString());
}

/**
 * Split a collection into zoom bands that write one tile layer: each feature is
 * stored only from the zoom that first shows it (null drops it), so the low
 * zooms, which the opening view reads, carry only what they draw.
 */
function bands(name, collection, minZoomOf, tolerance) {
  const groups = new Map();
  for (const f of collection.features) {
    const z = minZoomOf(f.properties);
    if (z === null) continue;
    if (!groups.has(z)) groups.set(z, []);
    groups.get(z).push(f);
  }
  return Object.fromEntries([...groups].map(([z, feats]) => [`${name}@${z}`, { data: fc(feats), minZoom: z, as: name, tolerance }]));
}
const BOX = `bbox=${NA_BOX.join(',')}`;
const SIMPLE = '-simplify interval=60 keep-shapes';

/** Smaller is more prominent; the style shows rank <= a zoom-dependent limit. */
function placeRank(pop, capital) {
  if (capital === 'national' || pop >= 1_000_000) return 1;
  if (capital === 'region' || pop >= 300_000) return 2;
  if (pop >= 100_000) return 3;
  if (pop >= 30_000) return 4;
  if (pop >= 10_000) return 5;
  if (pop >= 3_000) return 6;
  return 7;
}

const tidyRoad = (name) =>
  String(name ?? '')
    .replace(/^I- ?/, 'I-')
    .replace(/^US Hwy /, 'US ')
    .replace(/^State (?:Rte|Hwy|Route|Highway) /, 'SR ')
    .trim();

async function northAmerica(paths, hiNames) {
  const p = (k) => paths[k];
  console.log('land');
  const usLand = await ms(`-i ${await member(p('us-states'), 'cb_2025_us_state_500k.shp')} -proj wgs84 -clip ${BOX} -dissolve -filter-islands min-area=1km2 remove-empty ${SIMPLE} -filter-fields`);
  const caLand = await ms(`-i ${await member(p('ca-land'), 'AC_1M_Landmass.shp')} -filter "COUNTRY=='Canada'||COUNTRY=='Denmark'" -proj wgs84 -clip ${BOX} -filter-islands min-area=2km2 remove-empty ${SIMPLE} -dissolve`);
  // Mexico, Central America and the Caribbean: Natural Earth's country polygons for every country but
  // the U.S., Canada, Greenland, Puerto Rico and the U.S. Virgin Islands, so its coarser coast never
  // shows past the government coastlines. (Erasing those countries from Natural Earth's land layer
  // removed the whole continent, Mexico included; the country polygons need no erase.)
  const restLand = await ms(`-i ${p('ne-countries')} -filter "['USA','CAN','GRL','PRI','VIR'].indexOf(ADM0_A3) == -1" -clip ${BOX} -filter-islands min-area=2km2 remove-empty -dissolve`);
  for (const [name, at, part] of [['Mexico City', [-99.13, 19.43], restLand], ['Kansas', [-98, 38.5], usLand], ['Saskatchewan', [-106, 54], caLand]]) {
    if (!part.features.some((f) => inBounds(f.geometry, at))) throw new Error(`land is missing at ${name}`);
  }
  const land = fc([...usLand.features, ...caLand.features, ...restLand.features]);

  console.log('water');
  const usKinds = "({'Lake':'lake','Reservoir':'reservoir','Lake Intermittent':'intermittent','Lake Dry':'dry','Swamp or Marsh':'wetland','Glacier':'glacier','Stream':'river','Canal':'river'})[Feature] || 'lake'";
  const usWater = await ms(`-i ${await member(p('us-water'), 'wtrbdyp010g.shp')} -proj wgs84 -clip ${BOX} -each "kind = ${usKinds}; name = Name || ''; sqkm = Area_sq_mi * 2.59" ${SIMPLE} -filter-fields kind,name,sqkm`);
  const caWater = await ms(`-i ${await member(p('ca-water'), 'AC_1M_Waterbodies.shp')} encoding=utf8 -proj wgs84 -filter "SHAPE_Area >= 25e6 || (SHAPE_Area >= 2e6 && this.centroidX < -114 && this.centroidY < 60.1)" -clip ${BOX} -each "kind = TYPE == 'Intermittent Water' ? 'intermittent' : 'lake'; name = NAME || NOM || ''; sqkm = SHAPE_Area / 1e6" ${SIMPLE} -filter-fields kind,name,sqkm`);
  const restWater = await ms(`-i ${p('ne-lakes')} -clip ${BOX} -filter "this.centroidY < 32.5" -each "kind = 'lake'; name = name || ''; sqkm = 100" -filter-fields kind,name,sqkm`);
  const water = fc([...usWater.features, ...caWater.features, ...restWater.features]);

  console.log('rivers');
  const usRivers = await ms(`-i ${await member(p('us-streams'), 'streaml010g.shp')} -filter "Strahler >= 4 || ((Feature == 'Canal' || Feature == 'Aqueduct') && !!Name)" -proj wgs84 -clip ${BOX} -each "rank = Strahler > 0 ? Strahler : 3; kind = (Feature == 'Canal' || Feature == 'Aqueduct') ? 'canal' : Feature == 'Stream Intermittent' ? 'intermittent' : 'river'; name = Name || ''" -filter-fields rank,kind,name -dissolve rank,kind,name ${SIMPLE}`);
  const caRivers = await ms(`-i ${await member(p('ca-rivers'), 'AC_1M_Rivers_sparse.shp')} encoding=utf8 -proj wgs84 -clip ${BOX} -each "rank = 5; kind = TYPE == 'Intermittent River' ? 'intermittent' : 'river'; name = NAME || NOM || ''" -filter-fields rank,kind,name -dissolve rank,kind,name ${SIMPLE}`);
  const restRivers = await ms(`-i ${p('ne-rivers')} -clip ${BOX} -filter "this.bounds[3] < 32.6" -each "rank = scalerank <= 4 ? 7 : scalerank <= 7 ? 6 : 5; kind = 'river'; name = name || ''" -filter-fields rank,kind,name`);
  const river = fc([...usRivers.features, ...caRivers.features, ...restRivers.features]);

  console.log('boundaries');
  // Each border comes from the source that drew the land beside it (owner decision 2 A, 2026-11-12), so it
  // meets the coast it ends at: U.S.-Canada from the Atlas of Canada, U.S.-Mexico from the Census state
  // edge, Natural Earth for every other border.
  const statesShp = await member(p('us-states'), 'cb_2025_us_state_500k.shp');
  const countryLines = await ms(`-i ${p('ne-country-lines')} -filter "ADM0_A3_L != 'USA' && ADM0_A3_R != 'USA'" -clip ${BOX} -each "kind = 'country'" -filter-fields kind`);
  // The south-bound filter drops the one offshore line (Gulf of Maine): the map draws land and lake borders, not sea ones.
  const usCanada = await ms(`-i ${await member(p('ca-lines'), 'AC_1M_BoundaryLines.shp')} -filter "TYPE == 'International'" -proj wgs84 -filter "this.bounds[1] > 41" -clip ${BOX} -each "kind = 'country'" ${SIMPLE} -filter-fields kind`);
  const borderStates = await ms(`-i ${statesShp} -proj wgs84 -filter "['CA','AZ','NM','TX'].indexOf(STUSPS) > -1" -dissolve`);
  const usMexico = await msData(`-i in.json ${SIMPLE} -each "kind = 'country'"`,
    fc([{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: borderArc(borderStates, [-117.124, 32.534], [-97.146, 25.956]) } }]));
  // State lines at the base map's scale (owner decision 1 A): inner lines only, the coast is the land edge.
  // Drawn by the State Boundaries layer (src/layers/states.ts), which keeps the bundled coarse file as its click target.
  const stateLines = await ms(`-i ${statesShp} -proj wgs84 -clip ${BOX} -innerlines ${SIMPLE} -each "kind = 'state'"`);
  const caRegions = await ms(`-i ${await member(p('ca-lines'), 'AC_1M_BoundaryLines.shp')} -filter "TYPE == 'Provincial or Territorial'" -proj wgs84 -clip ${BOX} -each "kind = 'region'" ${SIMPLE} -filter-fields kind`);
  const mxRegions = await ms(`-i ${p('ne-region-lines')} -filter "ADM0_A3 == 'MEX'" -clip ${BOX} -each "kind = 'region'" -filter-fields kind`);
  const boundary = fc([...countryLines.features, ...usCanada.features, ...usMexico.features, ...stateLines.features, ...caRegions.features, ...mxRegions.features]);
  const county = await ms(`-i ${await member(p('us-counties'), 'cb_2025_us_county_500k.shp')} -proj wgs84 -clip ${BOX} -innerlines ${SIMPLE} -each "kind = 'county'"`);

  console.log('roads');
  const seen = new Map();
  for (const f of STATE_FIPS) {
    const shp = await member(p(`us-roads-${f}`), `tl_2025_${f}_prisecroads.shp`);
    const roads = await ms(`-i ${shp} -filter "MTFCC == 'S1100' || (MTFCC == 'S1200' && ['I','U','S'].indexOf(RTTYP) > -1)" -proj wgs84 -clip ${BOX} -each "cls = MTFCC == 'S1100' ? 1 : RTTYP == 'S' ? 3 : 2; name = FULLNAME || ''" -filter-fields cls,name ${SIMPLE}`);
    for (const feat of roads.features) {
      // A co-signed route repeats its edge once per name: keep one, the higher class, with its name.
      const key = JSON.stringify(feat.geometry.coordinates);
      const prior = seen.get(key);
      feat.properties.name = tidyRoad(feat.properties.name);
      if (!prior || feat.properties.cls < prior.properties.cls) seen.set(key, feat);
    }
  }
  const caRoads = await ms(`-i ${await member(p('ca-roads'), 'AC_1M_Roads.shp')} -filter "CARTO == 'Multi-lane Highway' || CARTO == 'Principal Highway' || CARTO == 'Secondary Highway'" -proj wgs84 -clip ${BOX} -each "cls = CARTO == 'Multi-lane Highway' || TYPE == 'Freeway' ? 1 : CARTO == 'Principal Highway' ? 2 : 3; name = ''" -filter-fields cls,name ${SIMPLE}`);
  const road = fc([...seen.values(), ...caRoads.features]);

  console.log('places');
  const usPlaces = await ms(`-i ${await member(p('us-cities'), 'citiesx010g.shp')} -proj wgs84 -clip ${BOX} -filter "POP_2010 >= 1000 || FEATURE2 != '-999'" -each "cap = FEATURE2 == 'National Capital' ? 'national' : FEATURE2.indexOf('State Capital') > -1 ? 'region' : ''; pop = Math.max(POP_2010, 0); gnis = GNIS_ID; name = NAME" -filter-fields name,pop,cap,gnis`);
  for (const feat of usPlaces.features) {
    const official = hiNames.get(feat.properties.gnis);
    if (official) feat.properties.name = official;
    delete feat.properties.gnis;
  }
  const caPlaces = await ms(`-i ${await member(p('ca-places'), 'AC_1M_PlaceNames.shp')} encoding=utf8 -proj wgs84 -clip ${BOX} -filter "EST_POP >= 500 || !!CAPITAL" -each "cap = CAPITAL == 'national' ? 'national' : CAPITAL ? 'region' : ''; pop = Math.max(EST_POP, 0); name = NAME || NOM" -filter-fields name,pop,cap`);
  const restPlaces = await ms(`-i ${p('ne-places')} -clip ${BOX} -filter "['USA','CAN','PRI','VIR'].indexOf(adm0_a3) == -1 && scalerank <= 8" -each "cap = adm0cap ? 'national' : ''; pop = Math.max(pop_max, 0); name = name" -filter-fields name,pop,cap`);
  const place = fc([...usPlaces.features, ...caPlaces.features, ...restPlaces.features]);
  for (const feat of place.features) feat.properties.rank = placeRank(feat.properties.pop, feat.properties.cap);

  console.log('water labels');
  const lakeRank = "sqkm >= 2500 ? 1 : sqkm >= 500 ? 2 : sqkm >= 100 ? 3 : 4";
  const lakeLabels = await ms(`-i ${await member(p('us-water'), 'wtrbdyp010g.shp')} -proj wgs84 -clip ${BOX} -filter "!!Name && Area_sq_mi >= 8 && Feature != 'Swamp or Marsh'" -each "sqkm = Area_sq_mi * 2.59; name = Name" -points inner -each "rank = ${lakeRank}; kind = 'lake'" -filter-fields name,rank,kind`);
  const caLakeLabels = await ms(`-i ${await member(p('ca-water'), 'AC_1M_Waterbodies.shp')} encoding=utf8 -proj wgs84 -clip ${BOX} -filter "!!(NAME || NOM) && SHAPE_Area >= 2e7" -each "sqkm = SHAPE_Area / 1e6; name = NAME || NOM" -points inner -each "rank = ${lakeRank}; kind = 'lake'" -filter-fields name,rank,kind`);
  // The label point is taken before the box clip, so a sea that crosses the box edge is named once, by whichever archive holds its point.
  const seaLabels = await ms(`-i ${p('ne-marine')} -filter "!!name && featurecla != 'reef'" -points inner -clip ${BOX} -each "rank = Math.min(scalerank, 4) || 1; kind = 'sea'" -filter-fields name,rank,kind`);
  const water_label = fc([...lakeLabels.features, ...caLakeLabels.features, ...seaLabels.features]);

  const roads = await msData('-i in.json -dissolve cls,name', road);
  // Tolerance is in 1/4096 of a tile: 5 is about 190 m at zoom 8, under one screen pixel there.
  return {
    land: { data: land, tolerance: 4 },
    ...bands('water', water, ({ kind, sqkm }) =>
      kind === 'wetland' && sqkm < 5 ? null : sqkm >= 250 ? 0 : sqkm >= 25 ? 4 : sqkm >= 5 ? 6 : 7, 5),
    ...bands('river', river, ({ rank }) => (rank >= 7 ? 3 : rank === 6 ? 4 : rank === 5 ? 5 : rank === 4 ? 6 : 7), 4),
    boundary,
    county: { data: county, minZoom: 5, tolerance: 4 },
    ...bands('road', roads, ({ cls }) => 3 + cls, 4),
    ...bands('place', place, ({ rank }) => (rank <= 2 ? 0 : rank <= 5 ? rank + 2 : 8)),
    ...bands('water_label', water_label, ({ rank }) => [0, 0, 4, 6, 7][rank] ?? 7)
  };
}

async function world(paths) {
  const p = (k) => paths[k];
  const erase = `-erase ${BOX}`;
  const land = await ms(`-i ${p('ne-land')} ${erase} -filter-fields`);
  const water = await ms(`-i ${p('ne-lakes')} ${erase} -filter "scalerank <= 6" -each "kind = 'lake'; name = name || ''" -filter-fields kind,name`);
  const boundary = await ms(`-i ${p('ne-country-lines')} ${erase} -each "kind = 'country'" -filter-fields kind`);
  const place = await ms(`-i ${p('ne-places')} -filter "scalerank <= 4 && !(this.x >= ${NA_BOX[0]} && this.x <= ${NA_BOX[2]} && this.y >= ${NA_BOX[1]} && this.y <= ${NA_BOX[3]})" -each "cap = adm0cap ? 'national' : ''; pop = Math.max(pop_max, 0); name = name" -filter-fields name,pop,cap`);
  for (const feat of place.features) feat.properties.rank = placeRank(feat.properties.pop, feat.properties.cap);
  const water_label = await ms(`-i ${p('ne-marine')} -filter "!!name && scalerank <= 3" -points inner -filter "!(this.x >= ${NA_BOX[0]} && this.x <= ${NA_BOX[2]} && this.y >= ${NA_BOX[1]} && this.y <= ${NA_BOX[3]})" -each "rank = Math.min(scalerank, 4) || 1; kind = 'sea'" -filter-fields name,rank,kind`);
  return { land, water, boundary, place, water_label };
}

/** Fail the build on a name the shipped glyph ranges cannot draw, NFC-normalizing first. */
async function glyphGate(layers) {
  const ranges = (await readdir(GLYPH_DIR))
    .filter((f) => f.endsWith('.pbf'))
    .map((f) => f.replace('.pbf', '').split('-').map(Number));
  const bad = new Set();
  for (const spec of Object.values(layers)) {
    for (const feat of (spec.data ?? spec).features) {
      if (typeof feat.properties?.name !== 'string') continue;
      feat.properties.name = feat.properties.name.normalize('NFC').trim();
      for (const ch of feat.properties.name) {
        const cp = ch.codePointAt(0);
        if (!ranges.some(([lo, hi]) => cp >= lo && cp <= hi)) bad.add(`${feat.properties.name} (U+${cp.toString(16).toUpperCase()})`);
      }
    }
  }
  if (bad.size) throw new Error(`names outside the shipped glyph ranges:\n  ${[...bad].slice(0, 40).join('\n  ')}`);
}

function refuseSovereignLayers(layers) {
  for (const name of Object.keys(layers)) {
    if (/tribal|treaty|aiannh|reserv|nation/i.test(name)) throw new Error(`refused layer ${name}: Tribal and Treaty boundaries stay live-read`);
  }
}

async function readBack(archive, canaries) {
  const reader = new PMTiles({
    getKey: () => 'build',
    getBytes: async (offset, length) => {
      const s = archive.subarray(offset, offset + length);
      return { data: s.buffer.slice(s.byteOffset, s.byteOffset + s.byteLength) };
    }
  });
  const header = await reader.getHeader();
  const meta = await reader.getMetadata();
  for (const [label, z, lon, lat] of canaries) {
    const x = Math.floor(((lon + 180) / 360) * 2 ** z);
    const r = (lat * Math.PI) / 180;
    const y = Math.floor(((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * 2 ** z);
    const tile = await reader.getZxy(z, x, y);
    if (!tile || tile.data.byteLength === 0) throw new Error(`canary tile empty: ${label} z${z}/${x}/${y}`);
  }
  return { header, meta };
}

async function main() {
  await mkdir(`${CACHE}/unpacked`, { recursive: true });
  const prior = existsSync(RECEIPT_PATH) ? JSON.parse(await readFile(RECEIPT_PATH, 'utf8')) : null;
  const receipt = [];
  const paths = {};
  for (const [key, url, issuer] of INPUTS) {
    const file = await fetchCached(url);
    const sha256 = createHash('sha256').update(await readFile(file)).digest('hex');
    const pinned = prior?.inputs?.find((i) => i.url === url);
    if (pinned && pinned.sha256 !== sha256 && process.env.DDM_BASE_REPIN !== '1') {
      throw new Error(`input changed since it was pinned: ${url}\n  pinned ${pinned.sha256}\n  now    ${sha256}\nRebuild with DDM_BASE_REPIN=1 after reading what changed.`);
    }
    const retrieved = pinned && pinned.sha256 === sha256 ? pinned.retrieved : (await stat(file)).mtime.toISOString().slice(0, 10);
    receipt.push({ key, url, issuer: ISSUERS[issuer], sha256, bytes: (await stat(file)).size, retrieved });
    paths[key] = file.endsWith('.geojson') ? file : await unpack(file);
  }

  const crosswalk = JSON.parse(await readFile(HI_CROSSWALK, 'utf8'));
  const hiNames = new Map(crosswalk.entries.filter((e) => e.status === 'safe-match').map((e) => [Number(e.gnisId), e.gnisName]));

  const na = await northAmerica(paths, hiNames);
  const ww = await world(paths);
  for (const layers of [na, ww]) {
    refuseSovereignLayers(layers);
    await glyphGate(layers);
  }

  if (process.env.DDM_BASE_MEASURE === '1') {
    // Size each North America layer alone, to see where the bytes go.
    const byLayer = {};
    for (const [name, spec] of Object.entries(na)) (byLayer[spec.as ?? name] ??= {})[name] = spec;
    for (const [name, group] of Object.entries(byLayer)) {
      const { archive, tileCount } = geojsonLayersToPmtiles(group, { minZoom: 0, maxZoom: NA_MAX_ZOOM, bounds: NA_BOX });
      const n = Object.values(group).reduce((s, spec) => s + (spec.data ?? spec).features.length, 0);
      console.log(`  ${name}: ${n} features, ${tileCount} tiles, ${archive.length.toLocaleString()} bytes`);
    }
    return;
  }

  const sources = [...new Set(INPUTS.map(([, , issuer]) => ISSUERS[issuer]))].join('; ');
  const attribution = `DDM base map, edition ${EDITION}. Sources: ${sources}. Changes by DDM: reprojected, clipped, generalized and merged for display; boundaries are representations, not legal land descriptions. Contains information licensed under the Open Government Licence - Canada.`;
  const results = [];
  // The highways ride their own archive (the roads archive of DDM-P17-T08), so each file stays under the line.
  const roads = Object.fromEntries(Object.entries(na).filter(([, spec]) => spec.as === 'road'));
  const base = Object.fromEntries(Object.entries(na).filter(([, spec]) => spec.as !== 'road'));
  for (const [out, layers, maxZoom, bounds, canaries] of [
    [OUT_NA, base, NA_MAX_ZOOM, NA_BOX, [
      ['Columbia mouth', 6, -123.9, 46.25], ['Great Lakes', 5, -84, 45], ['Puget Sound', 8, -122.45, 47.6],
      ['Hawaii', 6, -155.5, 19.6], ['Aleutians', 6, -170, 52.5], ['Rio Grande', 7, -106.6, 35.1], ['BC coast', 7, -125.5, 50.2]
    ]],
    [OUT_ROADS, roads, NA_MAX_ZOOM, NA_BOX, [['I-5 Seattle', 8, -122.32, 47.6], ['Trans-Canada Kamloops', 7, -120.3, 50.7], ['I-80 Nebraska', 6, -99, 40.7]]],
    [OUT_WORLD, ww, WORLD_MAX_ZOOM, [-180, -85, 180, 85], [['Peru coast', 5, -77, -12], ['Japan', 4, 139.7, 35.7]]]
  ]) {
    console.log(`\nbaking ${basename(out)} ...`);
    const { archive, tileCount } = geojsonLayersToPmtiles(layers, {
      minZoom: 0,
      maxZoom,
      bounds,
      tolerance: 3,
      name: basename(out, '.pmtiles'),
      attribution
    });
    if (archive.length > SIZE_LINE_BYTES) throw new Error(`${basename(out)} is ${archive.length} bytes, over the ${SIZE_LINE_BYTES}-byte public-tree line (DR-150)`);
    const { header, meta } = await readBack(archive, canaries);
    await writeFile(out, archive);
    const counts = {};
    for (const [k, v] of Object.entries(layers)) counts[v.as ?? k] = (counts[v.as ?? k] ?? 0) + (v.data ?? v).features.length;
    console.log(`  ${tileCount} tiles, ${archive.length.toLocaleString()} bytes, zoom ${header.minZoom}-${header.maxZoom}`);
    console.log(`  layers: ${meta.vector_layers.map((l) => `${l.id} z${l.minzoom}-${l.maxzoom} (${counts[l.id]})`).join(', ')}`);
    results.push({ file: basename(out), bytes: archive.length, tiles: tileCount, features: counts });
  }

  await writeFile(RECEIPT_PATH, `${JSON.stringify({ edition: EDITION, built: new Date().toISOString().slice(0, 10), outputs: results, inputs: receipt }, null, 2)}\n`);
  console.log(`\nwrote ${RECEIPT_PATH}`);
}

await main();
