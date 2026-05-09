# Reference data

The three GeoJSON files in this folder back the static reference layers shown on the map (Ecoregions, Tribal Lands, Treaty Areas). They ship as empty `FeatureCollection` placeholders so the app loads cleanly on first deploy. Replace them with authoritative data using the steps below.

The app reports a layer as `no data (see data/README.md)` when its file is empty, and as `unavailable` when the file cannot be fetched.

> **Stewardship note.** Anyone populating these files is responsible for the underlying authorizations. Tribal Lands, Treaty Areas, and any sovereign-jurisdiction polygons must be redistributed only with the relevant Tribal Nation's consent. The empty-placeholder pattern is a deliberate part of this module's design (see `CLAUDE.md` §2 and §4); please preserve it on contributions back upstream.

---

## `ecoregions-pnw.geojson`

EPA Level III Ecoregions, clipped to the Pacific Northwest (PNW).

**Source:** US Environmental Protection Agency (EPA), Ecoregion Maps and Data.

- Landing page: https://www.epa.gov/eco-research/level-iii-and-iv-ecoregions-continental-united-states
- Direct shapefile (CONUS Level III): ftp://newftp.epa.gov/EPADataCommons/ORD/Ecoregions/us/us_eco_l3.zip

**Convert** to GeoJSON, clipped to a PNW bounding box and reprojected to WGS 84, using `ogr2ogr` from GDAL:

```bash
ogr2ogr -f GeoJSON \
  -t_srs EPSG:4326 \
  -clipsrc -125 41 -110 50 \
  -simplify 0.001 \
  data/ecoregions-pnw.geojson \
  us_eco_l3.shp
```

`-simplify 0.001` reduces vertex count for browser performance; tune as needed.

**Expected per-feature properties:** the app reads `US_L3NAME` first, then falls back to `NA_L3NAME` or `name`. Any of these will populate the legend and color map.

**Color mapping:** the `ECOREGION_COLORS` constant in `app.js` keys colors by ecoregion name. Add or adjust entries to match the names in your converted file.

---

## `tribal-lands.geojson`

Tribal land area boundaries.

**Sources** (pick the one that fits your use):

- **Bureau of Indian Affairs (BIA), American Indian / Alaska Native Land Area Representation (AIAN-LAR).**
  - Catalog page: https://catalog.data.gov/dataset/american-indian-and-alaska-native-areas
  - Federal authoritative; used widely in federal mapping.

- **US Census Bureau, American Indian / Alaska Native / Native Hawaiian Areas (AIANNH).**
  - https://www.census.gov/geographies/mapping-files/time-series/geo/cartographic-boundary.html
  - Cleaner, lighter-weight; well-suited for web maps.

- **State sources** (where a single state suffices):
  - Washington: https://geo.wa.gov/ ("Tribal Lands")
  - Oregon: https://spatialdata.oregonexplorer.info/
  - Idaho: https://insideidaho.org/

**Convert** (clipped to PNW):

```bash
ogr2ogr -f GeoJSON -t_srs EPSG:4326 \
  -clipsrc -125 41 -110 50 \
  -simplify 0.0005 \
  data/tribal-lands.geojson \
  AIAN_LAR.shp
```

**Expected per-feature properties:** the app reads `LARNAME` first, then falls back to `name` or `NAME`.

---

## `treaty-areas.geojson`

Treaty cession boundaries (Medicine Creek 1854, Yakama 1855, Nez Perce 1855, Walla Walla 1855, etc.).

**Sources:**

- **Washington Department of Archaeology and Historic Preservation (DAHP), WISAARD.**
  - https://wisaard.dahp.wa.gov/ (Tribal layers, Treaty boundaries for Washington Tribes).
  - Export from the WISAARD viewer or contact DAHP for a shapefile.

- **Library of Congress, Royce Indian Land Cessions in the United States.**
  - https://www.loc.gov/resource/g3701em.gct00002/ (historical cession maps; some are digitized as GeoJSON).

- **Native Land Digital.**
  - https://native-land.ca/ provides territorial GeoJSON under CC-BY; the Treaties tab includes boundary data. Native Land's data is community-curated and is not authoritative for legal or administrative use.

**Expected per-feature properties:** `name`, `treaty_year`, and `tribe`. The app uses these to color and label the polygons. Style overrides for specific Treaties live in the `TREATY_COLORS` table in `app.js` (matched against `name`).

> **Treaty boundaries.** Agency polygons are a representation of Treaty cession areas, not a definitive depiction of Tribal jurisdiction. Verify with the relevant Tribal Nation before using these polygons for any decision-making.

---

## Quick verification

After converting and dropping a file in this folder, test locally. From the repo root:

```bash
python3 -m http.server 8080
# then open http://localhost:8080/?layers=ecoregions
```

Or simply commit and push (GitHub Pages will serve the file at `https://atniclimate.github.io/dynamic-drought-module/data/ecoregions-pnw.geojson`).

If the layer toggle still reports `no data (see data/README.md)`, the file is loading but contains zero features. If it reports `unavailable`, check the path and that the file is valid JSON.

---

## File size budget

Browsers start to feel the strain above roughly 5 MB per layer. If a converted file exceeds that:

- Increase `-simplify` tolerance (try 0.002, 0.005).
- Tighten the `-clipsrc` bounding box if you only need a sub-region.
- Consider splitting into per-region files and switching the loader to fetch by region.

GitHub also warns on files larger than 50 MB and refuses files larger than 100 MB.
