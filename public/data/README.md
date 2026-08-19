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
`no data (see data/README.md)`; when the file cannot be fetched it
reports `unavailable`.

> **Stewardship note.** Anyone populating these files is responsible for
> the underlying authorizations. Tribal Lands, Treaty Areas, and any
> sovereign-jurisdiction polygons must be redistributed only with the
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

- `us-states.geojson`: state boundaries (US Census, public domain).
- `ecoregions-pnw.pmtiles`: EPA Omernik ecoregions, the served artifact
  (built by `npm run build:ecoregion-tiles`); `ecoregions-pnw.geojson`
  is the legacy placeholder retained for compatibility.
- `hillshade-dem-pnw.pmtiles`: terrain hillshade (USGS 3DEP-derived,
  built by `npm run build:hillshade-tiles`).
- `fuels-fbfm40-pnw.pmtiles`: LANDFIRE 2024 (LF2024) Scott and Burgan 40
  Fire Behavior Fuel Models (FBFM40) drape for the desktop 3D Fire view
  (built by `npm run build:fuels-tiles`; U.S. Public Domain,
  USGS-produced). Server-rendered PNG tiles carrying LANDFIRE's own
  published class colors, zooms 0-8 at 512 px (reduced resolution from
  the 30 m source; measured 25,749,464 bytes at bake, retrieved
  2026-08-18). The vintage, retrieval date, and the snapshot-not-a-
  prediction caveat are recorded in the archive attribution and repeated
  in the in-app legend. Loaded only while the 3D Fire view is active.
- `us-places.json`: municipal label points (Natural Earth, built by
  `npm run build:states` tooling; see scripts/).
- `tribal-roster.json` + `tribal-larname-crosswalk.json`: the
  names-only roster of federally recognized Tribes from the BIA annual
  Federal Register notice, with the reviewed LARNAME crosswalk (names
  only; no geometry). Regenerated by script; do not hand-edit.

These are public, non-sovereign reference data; they are not deployer
slots.

---

## `enso-indices.json` (committed snapshot, not a placeholder)

A committed snapshot of four National Oceanic and Atmospheric
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
  never declares a phase on its own; and
- the standardized Southern Oscillation Index (SOI), a supporting
  ocean-atmosphere agreement flag only.

Seasonal points carry a `preliminary` flag (recent seasons may still be
revised). They drive the drought-impact briefing's long-range ENSO tilt
and its index chart. The publish script refuses to copy back any
externally refreshed snapshot that lacks this shape or drops a series
(see `scripts/publish-public.mjs`), so a stale builder can never regress
the live read again.

Both CPC sources are served without Cross-Origin Resource Sharing (CORS)
headers, so a browser cannot fetch them directly. Per the
climate-data-sources doctrine, a slow monthly index is snapshotted at
build or commit time rather than proxied at runtime. Refresh the snapshot
(about monthly, when CPC updates the indices) with:

```bash
npm run build:enso
```

That runs `scripts/build-enso-snapshot.mjs`, which fetches all four
index products, parses each table, determines each ENSO phase, and rewrites
`enso-indices.json` with its retrieval date. Commit the regenerated file.
There is no deployer authorization concern here; this is public federal
climate data.

---

## British Columbia basin drought levels (live, not bundled)

The British Columbia drought framing fetches basin geometry directly from
the Province of British Columbia ArcGIS FeatureServer at activation time.
No British Columbia basin geometry is copied into this repository or stored
under `public/data/`.

The source attribution is `Province of British Columbia`. Its ArcGIS item
terms were reconfirmed on 2026-07-27 and remain `Access Only`, `Copyright
(c), Province of British Columbia. All rights reserved.` The maintainer's
2026-07-08 display-and-attribution sign-off therefore remains applicable.
The layer asks only for the basin identifier, basin name, drought level, and
source date needed by the display.

The provincial 0 through 5 scale is not converted to United States Drought
Monitor categories. Source value 99 renders as `No update`, meaning the basin
is not measured outside the core drought season; it is never put on the
severity ramp.

---

## `cdm-drought-areas.json` (committed monthly snapshot)

A compact World Geodetic System 1984 (WGS 84) snapshot of the Canadian
Drought Monitor from Agriculture and Agri-Food Canada, licensed under the
Open Government Licence - Canada. The dataset licence was reconfirmed through
the open.canada.ca record
`292646cd-619f-4200-afb1-8b2c52f984a2` on 2026-07-27.

The committed artifact is for June 2026. It records its month, source URL,
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
For the June 2026 snapshot the mandatory result was:

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
# open http://localhost:5173/dynamic-drought-module/?layers=tribal
```

If the layer toggle reports `no data (see data/README.md)`, the file is
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
