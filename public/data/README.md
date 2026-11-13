# Reference data

This folder holds the module's bundled data: two DEPLOYER-OWNED
placeholder files you may populate with your own authorized data
(`tribal-lands.geojson`, `treaty-areas.geojson`), bundled public
reference data the module ships with (states, ecoregions, hillshade,
place labels, the Tribal name roster), and one committed data snapshot
(`enso-indices.json`).

**Read this first: the map's default Tribal geography does NOT come from
this folder.** Two live layers fetch the publishing federal services
LIVE at view time and redistribute nothing:

- Tribal Lands (`aiannh`, default-on): US Census AIANNH (legal and
  statistical geographies, including Oklahoma Tribal Statistical Areas).
- Reservation Boundaries (`bia-reservations`, default-on): the Bureau of
  Indian Affairs (BIA) AIAN Land Area Representation.

The two placeholder files below back the SEPARATE deployer slots
(`tribal`, `treaty`), which are OFF by default and not shown in the
default interface: no catalog row or search result names them until a
`?layers=tribal` / `?layers=treaty` URL (or your own configuration)
turns them on. They exist so a deployer
(most importantly a Tribal Nation) can display its own boundary data,
under its own governance and authorization, without that data ever
entering this repository. When the file is empty the layer reports
`no data`; when the file cannot be fetched it
reports `unavailable`.

> **Stewardship note.** Anyone populating these files is responsible for
> the underlying authorizations. The map's default Tribal geography is public
> data (T0) from the federal services named above and needs nothing from this
> folder. For data an operator supplies here, Tribal Lands, Treaty Areas, and
> any sovereign-jurisdiction polygons must be redistributed only with the
> relevant Tribal Nation's consent. The empty-placeholder pattern is a
> deliberate part of this module's design; please preserve it on
> contributions back upstream.

---

## `tribal-lands.geojson` (deployer slot, layer key `tribal`, default-off)

Your own Tribal land boundary data. The popup labels this layer as
deployer-provided data and never implies federal agency custody.

**Avoiding a double-draw:** the live `aiannh` and `bia-reservations`
layers already draw federal representations by default. If your data
covers the same areas, consider linking or embedding with those live
layers toggled off (for example
`?layers=usdm,tribal,states`) so users see one clear representation;
the deployer slot never silently replaces or blends with the live
layers.

**Populate:** replace the empty `FeatureCollection` in this file with
GeoJSON in WGS 84 (EPSG:4326). A typical conversion from a shapefile,
using `ogr2ogr` from GDAL:

```bash
ogr2ogr -f GeoJSON -t_srs EPSG:4326 \
  -simplify 0.0005 \
  public/data/tribal-lands.geojson \
  YOUR_BOUNDARIES.shp
```

**Per-feature properties the app reads:** name from `LARNAME` (or
`LARName`, `NAME`, `name`, `TRIBE`, `RESERV_NAM`), optional
`LARGovernment`/`GOVT` (government), `LARType`/`TYPE` (type), and
`GISAcres`/`ACRES` (acreage). Missing properties simply do not render a
row; nothing breaks.

---

## `treaty-areas.geojson` (deployer slot, layer key `treaty`, default-off)

Your own Treaty or ceded-area boundary data. This slot is for a deployer's
own representation (a Nation's own depiction of its Treaty areas, or a
state-curated set).

**Per-feature properties the app reads:** `name`, `treaty_year`, and
`tribe`. Style overrides for specific Treaties live in the
`TREATY_COLORS` table in `src/config/palette.ts` (matched against
`name`).

> **Treaty boundaries.** Agency polygons are a representation of Treaty
> cession areas, not a definitive depiction of Tribal jurisdiction.
> Verify with the relevant Tribal Nation before using these polygons for
> any decision-making.

---

## Bundled public reference data (not placeholders)

- `ddm-base-na-2026-11.pmtiles`, `ddm-roads-na-2026-11.pmtiles`,
  `ddm-base-world-2026-11.pmtiles`, `ddm-forests-2026-11.pmtiles`: DDM's own
  base map and its reference layers (built by
  `node --max-old-space-size=16000 scripts/build-base-tiles.mjs`; every input
  pinned by SHA-256 in `scripts/data/base-tiles-inputs.json`). North America
  (180°W to 50°W, 14°N to 84°N) zoom 0 to 8, overzoomed by the map to 14:
  land, lakes, reservoirs, wetlands and glaciers, rivers and canals by stream
  order, country, province and Mexican state lines, county lines, place, lake
  and sea names (16,155,213 bytes); federal and state highways in the U.S. and
  principal highways in Canada, with route names, main-line railroads in the
  U.S. and large or high-hazard dams (10,575,287 bytes); the rest of the world
  zoom 0 to 5 (1,602,643 bytes); the National Forests' administrative
  boundaries (3,194,065 bytes). Sources: U.S. Census Bureau 2025 cartographic
  boundary files and TIGER/Line 2025 roads and railroads (public domain); USDA
  Forest Service administrative forest boundaries (CC0); U.S. Army Corps of
  Engineers National Inventory of Dams; USGS
  1:1,000,000-scale waterbodies, streams and cities, 2014 (public domain);
  Natural Resources Canada, Atlas of Canada National Scale Data 1:1,000,000
  (Open Government Licence - Canada); Natural Earth 1:10m v5.1.2 (public
  domain) for Mexico, Central America, the Caribbean and the world. Mesoscale
  by design; inside Tribal areas the street names are read live from the
  Census at zoom 12 and above (`src/layers/tribal-streets.ts`). No Tribal or
  Treaty boundary is stored in these files: those stay live-read. Retrieved
  2026-11-12 and 2026-11-13; sizes measured from the files and matching the
  receipt.
- `us-states.geojson`: state boundaries (US Census, public domain).
- `ecoregions-pnw.pmtiles`: EPA Omernik ecoregions, the served artifact
  (built by `npm run build:ecoregion-tiles`).
- `hillshade-dem-pnw.pmtiles`: retained terrain hillshade derived from USGS
  3DEP. The repository does not currently expose a supported rebuild command.
- `whp-2023-pnw.pmtiles`: USFS Wildfire Hazard Potential 2023 drape for
  the desktop 3D Fire view (built by `npm run build:whp-tiles`; U.S. Public
  Domain, USDA Forest Service Rocky Mountain Research Station). Server-rendered
  PNG tiles carry the issuer's own seven published classes, zooms 0-8 at
  512 px, 149 tiles, 13,582,961 bytes, retrieved 2026-08-19 UTC. The bake
  verifies the current issuer legend and uses categorical resampling so class
  boundaries never acquire invented colors. The archive attribution and
  in-app legend identify it as a static long-term hazard classification, not
  current fire conditions or a prediction. It loads only while the 3D Fire
  view is active and stands down when the live flat `usfs-whp` layer is on.
- `power-lines-pnw.pmtiles`: Pacific Northwest transmission lines for the
  independent, default-off Power Lines & Plants catalog layer (built by
  `npm run build:power-tiles`).
  A one-time extract of the ARCHIVED federal HIFLD dataset via the public
  Esri Federal User Community copy (accessInformation "U.S. Government";
  Extract capability enabled; the item states it is archived with last
  data update 2024-09-30). 6,941 features, zooms 0-11, 3,816 tiles,
  3,827,596 bytes, retrieved 2026-08-19 UTC. Issuer sentinel attributes are
  preserved verbatim (VOLTAGE -999999, VOLT_CLASS 'NOT AVAILABLE'). The in-app qualification
  carries the mandatory caveat: not comprehensive or current, never for
  siting or safety-critical decisions. The layer can be used in flat and 3D
  views, is never activated automatically by Fire 3D, and reports `zoom in to
  load` below zoom 6. Its live power-plant companion comes from EIA and is not
  stored in this archive.
- `us-places.json`: municipal label points (Natural Earth, built by
  `npm run build:places`; see scripts/).
- `tribal-roster.json` + `tribal-larname-crosswalk.json`: the
  names-only roster of federally recognized Tribes from the BIA annual
  Federal Register notice, with the reviewed LARNAME crosswalk and a
  Census AIANNH supplement (names only; no geometry): every federal
  statistical area (OTSA, TDSA, ANVSA), plus reservation and trust land
  areas only for Tribes AIAN-LAR does not locate. A Nation can appear both
  as a LAR land area and as a Census statistical area. Regenerated by
  script; do not hand-edit.

These are public, non-sovereign reference data; they are not deployer
slots.

The retained `npm run build:fuels-tiles` command is an offline restore and
research path for the retired LANDFIRE FBFM40 proof slice. Its output is not a
shipped artifact or an active Fire 3D input.

---

## `enso-indices.json` (committed snapshot, not a placeholder)

A committed snapshot of five National Oceanic and Atmospheric
Administration (NOAA) Climate Prediction Center (CPC) El Nino / Southern
Oscillation (ENSO) index series:

- the Relative Oceanic Nino Index (RONI), the operational headline and
  phase driver: the ONI with the tropical-mean ocean warming background
  removed (in a warming ocean the raw ONI drifts warm, so RONI often
  reads cooler);
- the Oceanic Nino Index (ONI), the standard three-month running mean of
  the Nino 3.4 sea surface temperature anomaly, kept as the historical
  continuity comparison;
- the analyzed monthly Nino 3.4 anomaly, a fast-moving companion that
  never declares a phase on its own;
- the weekly Nino 3.4 sea surface temperature anomaly (`nino34Weekly`); and
- the standardized Southern Oscillation Index (SOI), a supporting
  ocean-atmosphere agreement flag only.

Seasonal points carry a `preliminary` flag (recent seasons may still be
revised). They drive the drought-impact briefing's long-range ENSO tilt
and its index chart. `npm run check:enso` (`scripts/validate-enso-snapshot.mjs`,
part of `check:all`) refuses a snapshot that lacks this shape or drops a
required series, so a stale builder can never regress the live read again.

The CPC sources are served without Cross-Origin Resource Sharing (CORS)
headers, so a browser cannot fetch them directly. Per the
climate-data-sources doctrine, a slow monthly index is snapshotted at
build or commit time rather than proxied at runtime. Refresh the snapshot
(about monthly, when CPC updates the indices) with:

```bash
npm run build:enso
```

That runs `scripts/build-enso-snapshot.mjs`, which fetches all five
index products, parses each table, determines each ENSO phase, and rewrites
`enso-indices.json` with its retrieval date. Commit the regenerated file.
There is no deployer authorization concern here; this is public federal
climate data.

---

## `rtofs-surface-currents*` (committed model frame, not a placeholder)

One dated frame of ocean surface currents from the NOAA/NCEP Global RTOFS
ocean model, drawn by the ENSO "Ocean currents" choice: a JSON header
(`rtofs-surface-currents.json`: model run, valid instant, grids, scale)
and one gzip file per model grid, each on its own spacing and never
joined:

- `rtofs-surface-currents-trop-paci.i16.gz`: 1.0 degree, 40 S to 39 N and
  130 E to 111 W;
- `rtofs-surface-currents-alaska.i16.gz`: 0.3 degree, 40 N to 84.7 N and
  140 E to 115.3 W.

Each file is Int16 little-endian counts of 0.01 m/s (the model's own
precision), all eastward values then all northward values, rows north to
south, with -32768 where the model's own mask marks land. The values are
the issuer's, re-encoded and unchanged; this is not an official NOAA
product. The frame is as old as the last time it was built, and the map
states its run, valid instant and age.

NOAA serves these files without Cross-Origin Resource Sharing (CORS)
headers and keeps two days of them, so a browser cannot read them. Build
a new frame by hand, then commit the three files:

```bash
node scripts/build-rtofs-currents.mjs
```

There is no schedule and no deployer authorization concern here; this is
public federal model output (https://www.weather.gov/disclaimer).

---

## British Columbia basin drought levels (held)

The Province of British Columbia basin drought-level edition is held by
DR-160 (2026-09-28) until the Province's written permission or the owner's
re-ruling: its ArcGIS item terms say "you may not reproduce or distribute
them without the prior written permission of the Province". While the hold
stands (`BC_BASIN_EDITION_HELD` in `src/config/layers.ts`), no code path
selects, presents or fetches that edition, and no British Columbia basin
geometry is stored under `public/data/`. British Columbia keeps the drought
monitors (the Canadian Drought Monitor and the North American Drought
Monitor).

---

## `cdm-drought-areas.json` (committed monthly snapshot)

A compact World Geodetic System 1984 (WGS 84) snapshot of the Canadian
Drought Monitor from Agriculture and Agri-Food Canada, licensed under the
Open Government Licence - Canada. The dataset licence was reconfirmed through
the open.canada.ca record
`292646cd-619f-4200-afb1-8b2c52f984a2` on 2026-07-27.

The committed artifact records its own month (see its `month` field), source URL,
retrieval date, source archive byte count, present and absent classes,
reprojection, simplification, and stewardship result. The source archive
contained D0, D1, D2, and D3 files. D4 was absent, which means no area was in
that class for the published month; it does not mean the fetch failed. A
missing archive or failed build never writes an artifact.

Refresh a named month with:

```bash
npm run build:cdm -- YYYY-MM
```

The builder downloads one archive, expands it only in Node with the dev-only
`fflate` dependency, checks every archive member name and decoded content for
First Nations, Metis, Métis, Inuit, reserve, and Treaty terms, and fails
before write on any match. It also rejects unexpected GeoJSON or properties,
reprojects EPSG:3857 to WGS 84, and enforces a 5,000,000-byte build ceiling.
For the committed snapshot the mandatory result was:

`PASS: no First Nations, Metis, Métis, Inuit, reserve, or Treaty terms found in 4 archive member names or decoded contents.`

The runtime receives only the compact JSON artifact. Neither a ZIP archive nor
a ZIP decoder is imported by application code. Areas without a rendered
polygon are described as having no polygon coverage in the artifact; they are
never painted or described as class zero.

---

## Quick verification

After populating a deployer slot, test locally from the repo root:

```bash
npm run dev
# open http://localhost:5173/?layers=tribal
```

If the layer toggle reports `no data`, the file is
loading but contains zero features. If it reports `unavailable`, check
the path and that the file is valid JSON.

---

## File size budget

Browsers start to feel the strain above roughly 5 MB per layer. If a
converted file exceeds that:

- Increase `-simplify` tolerance (try 0.002, 0.005).
- Tighten a `-clipsrc` bounding box if you only need a sub-region.
- Consider splitting into per-region files.

GitHub also warns on files larger than 50 MB and refuses files larger
than 100 MB.
