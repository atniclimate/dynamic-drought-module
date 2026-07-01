/**
 * Service endpoints. Centralized so any provider migration is a one-line
 * change.
 *
 * Open-source design notes:
 *   - Basemap is the OpenStreetMap (OSM) standard raster, subdued via
 *     raster paint in `src/map/style.ts` so the drought layers dominate.
 *     OpenTopoMap is retained below as a pre-approved alternative.
 *   - Hydrography is queried live from OSM via the Overpass Application
 *     Programming Interface (API). No API key required; fair-use rate
 *     limits apply.
 *   - Reference polygon layers (ecoregions, Tribal lands, Treaty areas)
 *     load from `public/data/` (Vite serves this directory at the site
 *     root, hence the leading slash).
 *   - Drought outlook uses the National Oceanic and Atmospheric
 *     Administration (NOAA) Climate Prediction Center (CPC) Web Map Service
 *     (WMS) endpoint. WMS is an Open Geospatial Consortium (OGC) open
 *     standard, so this is not a proprietary Environmental Systems Research
 *     Institute (ESRI) dependency.
 *   - United States Geological Survey (USGS) Water Services is open data,
 *     Cross-Origin Resource Sharing (CORS) enabled, JavaScript Object
 *     Notation (JSON).
 */
export const URLS = Object.freeze({
  // ---------- Basemaps (raster tiles) ----------
  // MapLibre GL JavaScript raster sources do not natively expand the `{s}`
  // subdomain placeholder used by Leaflet templates. Pin a single subdomain
  // (`a`) for the primary template; callers wanting round-robin can read
  // the `basemapTopoVariants` array and rotate themselves. If a future
  // migration moves to a hosted vector tile bundle, this comment can go.
  basemapTopo: 'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
  basemapTopoVariants: [
    'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
    'https://b.tile.opentopomap.org/{z}/{x}/{y}.png',
    'https://c.tile.opentopomap.org/{z}/{x}/{y}.png'
  ],

  // OSM standard tiles: the active basemap, subdued via raster paint in
  // `src/map/style.ts`. Pin to `a` for the MapLibre raster source (MapLibre
  // does not expand the Leaflet `{s}` subdomain placeholder).
  basemapOSM: 'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',

  // ---------- Hydrography (live OSM via Overpass API) ----------
  // Mirrors are tried in order with a 12s per-call timeout and 350ms
  // backoff between failures. All must respond with `Access-Control-
  // Allow-Origin: *`. Verified during the v0.1.1 polish pass; sizes
  // and freshness can drift, so retest before reordering.
  overpassMirrors: [
    'https://overpass-api.de/api/interpreter',          // canonical, freshest
    'https://overpass.kumi.systems/api/interpreter',    // independent operator
    'https://overpass.openstreetmap.fr/api/interpreter' // replaces private.coffee
  ],

  // ---------- Drought outlook (NOAA CPC, OGC WMS) ----------
  cpcDroughtWMS: 'https://mapservices.weather.noaa.gov/vector/services/outlooks/cpc_drought_outlk/MapServer/WMSServer',

  // ---------- CPC 6-10 day and 8-14 day outlooks (NOAA, ArcGIS MapServer) --
  // The Climate Prediction Center (CPC) extended-range temperature and
  // precipitation outlooks, hosted as ArcGIS MapServer services on the same
  // NOAA cloud host as `cpcDroughtWMS` (the post-2023 replacement for the
  // retired idpgis.ncep.noaa.gov). Each service exposes layer 0 = temperature
  // and layer 1 = precipitation. A point query
  // (`/<0|1>/query?...&geometry=<lon>,<lat>&geometryType=esriGeometryPoint
  // &inSR=4326&f=geojson`) returns one polygon feature carrying `cat`
  // ("Above" / "Below" / "Normal") and `prob` (33, 40, 50, 60, 70, 80, 90; 36
  // for Near Normal). The near-term horizon of the impact briefing reads these
  // for the probability tilt. The consumer appends `/0` (temp) or `/1`
  // (precip) and `/query` at call time, matching the `usdmFeatureServer`
  // pattern.
  // Resolved by ddm-data-scout and verified 2026-05-30: HTTP 200,
  // Content-Type application/json, one feature returned for a PNW point, and a
  // browser fetch from the app origin succeeds (Access-Control-Allow-Origin: *
  // confirmed by live in-page fetch, not just by header inspection).
  cpc610OutlookMapServer:
    'https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/cpc_6_10_day_outlk/MapServer',
  cpc814OutlookMapServer:
    'https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/cpc_8_14_day_outlk/MapServer',

  // ---------- USGS Water Services (open data, CORS-OK) ----------
  usgsIV: 'https://waterservices.usgs.gov/nwis/iv/',

  // ---------- National Weather Service (NWS) API ----------
  // api.weather.gov: the public National Oceanic and Atmospheric
  // Administration (NOAA) NWS Application Programming Interface (API). Used by
  // the impact briefing for active alerts (red-flag fire weather, excessive
  // heat) at a point and for the point forecast (near-term temperature). The
  // service recommends a descriptive User-Agent, but browsers cannot set that
  // header (it is forbidden); GET requests still succeed and are CORS-open.
  //   - Active alerts:  `${nwsApi}/alerts/active?point=<lat>,<lon>`
  //   - Point metadata: `${nwsApi}/points/<lat>,<lon>` (returns the forecast URL)
  // Verified 2026-05-30: HTTP 200, Content-Type application/geo+json (alerts)
  // and application/geo+json (points), Access-Control-Allow-Origin: * (browser
  // fetch confirmed from the app origin). Access method: REST GeoJSON, direct.
  nwsApi: 'https://api.weather.gov',

  // ---------- United States Drought Monitor (USDM) -----------
  // Joint product of National Drought Mitigation Center (NDMC) at the
  // University of Nebraska-Lincoln (UNL), the National Oceanic and
  // Atmospheric Administration (NOAA), and the United States Department of
  // Agriculture (USDA). Hosted as an Environmental Systems Research
  // Institute (ESRI) Representational State Transfer (REST) FeatureServer
  // by NDMC on ArcGIS Online. The `/0/query` path with `f=geojson` returns
  // a polygon FeatureCollection with the five USDM categories (D0-D4) in
  // the `DM` integer attribute.
  // Verified 2026-05-09: HTTP 200, Content-Type
  // `application/json; charset=utf-8`, `Access-Control-Allow-Origin: *`.
  usdmFeatureServer:
    'https://services5.arcgis.com/0OTVzJS4K09zlixn/arcgis/rest/services/USDM_current/FeatureServer/0',

  // ---------- USDM Data Services (drought statistics API) ----------
  // The National Drought Mitigation Center (NDMC) USDM Data Services API serves
  // weekly drought statistics, including the Drought Severity and Coverage
  // Index (DSCI, 0 to 500), by area of interest (`aoi` = a Federal Information
  // Processing Standards (FIPS) code; Washington = 53, Oregon = 41, Idaho = 16).
  // The DSCI time series drives the impact panel's drought-severity trend chart.
  // Send `Accept: application/json` (the service defaults to CSV).
  //   `${usdmDataServices}/StateStatistics/GetDSCI?aoi=<fips>&startdate=M/D/YYYY
  //    &enddate=M/D/YYYY&statisticsType=1`
  // Verified 2026-05-30 (live in-page fetch): HTTP 200, Content-Type
  // application/json, Access-Control-Allow-Origin: *, returns an array of
  // { name, mapDate, dsci } weekly records.
  usdmDataServices: 'https://usdmdataservices.unl.edu/api',

  // ---------- National Interagency Fire Center (NIFC) active perimeters --
  // Wildland Fire Interagency Geospatial Services (WFIGS) Current
  // Interagency Fire Perimeters, hosted as an ESRI REST FeatureServer on
  // the NIFC Open Data Hub. Refreshed approximately every 5 minutes. The
  // `/0/query` path with `f=geojson` returns a polygon FeatureCollection
  // with attributes prefixed `poly_*` (geometry source) and `attr_*`
  // (incident metadata).
  // Verified 2026-05-09: HTTP 200, Content-Type
  // `application/json; charset=utf-8`, `Access-Control-Allow-Origin: *`.
  nifcFires:
    'https://services3.arcgis.com/T4QMspbfLg3qTGWY/ArcGIS/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0',

  // ---------- USDA Forest Service (USFS) Wildfire Hazard Potential ------
  // Wildfire Hazard Potential (WHP), classified five-class raster
  // (1=Very Low through 5=Very High; values 6-7 cover non-burnable
  // developed and water classes). Published as an ESRI ImageServer on
  // the federal GeoPlatform imagery host. We do not consume an XYZ tile
  // template; instead, MapLibre's raster source pulls per-tile PNGs via
  // the ImageServer `exportImage` operation with `{bbox-epsg-3857}`.
  // Verified 2026-05-09: HTTP 200 from `exportImage`, Content-Type
  // `image/png`, `Access-Control-Allow-Origin: https://atniclimate.github.io`
  // (origin-echoed under `Vary: Origin`; the deploy origin is allowed).
  usfsWhp:
    'https://imagery.geoplatform.gov/iipp/rest/services/Fire_Aviation/USFS_EDW_RMRS_WildfireHazardPotentialClassified/ImageServer',

  // ---------- Bureau of Indian Affairs (BIA) reservation boundaries ----------
  // American Indian and Alaska Native Land Area Representation (AIAN-LAR): the
  // authoritative federal depiction of reservation and trust land extent for
  // federally recognized Tribes, hosted as an Environmental Systems Research
  // Institute (ESRI) FeatureServer. The `/0/query` path with `f=geojson` and a
  // spatial envelope (esriGeometryEnvelope, inSR=4326) returns a polygon
  // FeatureCollection clipped to the requested extent, with fields LARID,
  // LARNAME, CLASSIFICATION, GISACRES, REGION. Consumed live, not bundled:
  // live consumption commits no sovereign polygons to the repository (exactly
  // like USDM and NIFC), the stance reconciled in the ddm-tribal-boundary-
  // mapping skill against CLAUDE.md hard rule 1. The bundled empty
  // `tribal-lands.geojson` placeholder remains the deployer's own-data slot.
  // The `biamaps.doi.gov` host returned HTTP 500 at verification; use the
  // `biamaps.geoplatform.gov` host below.
  // Verified 2026-05-30: HTTP 200, Content-Type application/geo+json,
  // Access-Control-Allow-Origin: <reflected request origin> (verified against
  // https://atniclimate.github.io, so a browser fetch needs no proxy).
  // Access method: ESRI FeatureServer query, f=geojson, spatial envelope clip.
  // Anti-scrape note: the BIA AIAN-LAR FeatureServer, not the OneMap HTML hub.
  biaLarFeatureServer:
    'https://biamaps.geoplatform.gov/server/rest/services/DivLTR/BIA_AIAN_National_LAR/FeatureServer/0',

  // ---------- EPA Omernik ecoregions (live services, Phase D fallback) ----------
  // The Environmental Protection Agency (EPA) Office of Research and Development
  // publishes the Omernik Level III and Level IV ecoregions as ArcGIS MapServer
  // layers (no FeatureServer is published). Layer 11 is Level III polygons;
  // layer 7 is Level IV polygons (and carries the Level III fields too). The
  // primary DDM delivery is the baked PMTiles bundle below
  // (`ecoregionsPmtilesLocal`); these live services are the documented fallback
  // for selection metadata and for self-hosters who do not bake the bundle. The
  // consumer appends `/<layer>/query?...&geometry=<bbox>&geometryType=
  // esriGeometryEnvelope&inSR=4326&f=geojson`, matching the usdmFeatureServer
  // pattern. Fields: US_L3CODE, US_L3NAME, NA_L3CODE, NA_L3NAME (layer 11) plus
  // US_L4CODE, US_L4NAME (layer 7). Ecoregions are a landscape representation,
  // not a jurisdictional boundary; they never displace a Tribal selection.
  // Resolved by ddm-data-scout and verified 2026-05-30: layer 11 HTTP 200,
  // Content-Type application/geo+json, 20 Level III features for the PNW bbox in
  // one page (maxRecordCount 1000); Access-Control-Allow-Origin reflected (any
  // origin echoed, so a browser fetch from the app origin needs no proxy). Layer
  // 7 returns the Level IV shape but the full-PNW-bbox geometry query times out
  // (HTTP 504) at the EPA gateway, so geometry must be fetched with
  // returnGeometry=false (attributes) or per-state / paginated bboxes. Data
  // vintage December 2011 (static reference). Anti-scrape note: the MapServer
  // /query path, not the EPA eco-research HTML page.
  epaEcoregionsMapServer:
    'https://geodata.epa.gov/arcgis/rest/services/ORD/USEPA_Ecoregions_Level_III_and_IV/MapServer',

  // The Commission for Environmental Cooperation (CEC) North American Level III
  // terrestrial ecoregions, hosted as an ArcGIS Online FeatureServer. Wildcard
  // CORS (unlike the reflected-origin EPA host), so it is the most portable live
  // Level III source; it corroborates the EPA Level III boundaries but uses the
  // CEC schema (NameL3_En, L3Key_En) and carries no Level IV. Consumer appends
  // `/3/query?...&f=geojson`.
  // Resolved by ddm-data-scout and verified 2026-05-30: HTTP 200, Content-Type
  // application/json, Access-Control-Allow-Origin: * (wildcard confirmed by
  // sending Origin: https://atniclimate.github.io); 125 Level III features for
  // the PNW bbox (maxRecordCount 2000). dataLastEditDate 2025-08-28. Anti-scrape
  // note: the FeatureServer /3/query path, not the HTML service page.
  cecEcoregionsL3FeatureServer:
    'https://services7.arcgis.com/oF9CDB4lUYF7Um9q/arcgis/rest/services/NA_Terrestrial_Ecoregions_Level_3/FeatureServer/3',

  // ---------- NIDIS gridded drought-index tiles (NOAA, XYZ raster) ----------
  // The National Integrated Drought Information System (NIDIS) publishes the
  // current-conditions gridded drought indices as XYZ raster tiles on a public
  // Google Cloud Storage bucket behind drought.gov. The Standardized
  // Precipitation Index (SPI) is available at several accumulation windows; the
  // product slug encodes the index and window, for example
  // `ce-ACIS_NRCC_NN-spi-90d`. The full tile template is
  // `${nidisGriddedTileRoot}/<slug>/{z}/{x}/{y}.png`. Tiles exist to zoom 6
  // (the source maxzoom); MapLibre overzooms above that. The color scale is
  // baked into the tiles (no per-feature properties, so no popups); the
  // authoritative legend lives on drought.gov.
  // Verified 2026-05-30 (live in-page fetch from the app origin): HTTP 200,
  // Content-Type image/png, Access-Control-Allow-Origin: * for the SPI 30, 60,
  // 90, 180, and 365 day windows. The Standardized Precipitation
  // Evapotranspiration Index (SPEI) and Evaporative Demand Drought Index (EDDI)
  // are not published under this `ce-ACIS_NRCC_NN-` prefix (404), so only SPI
  // windows are wired; resolving the SPEI and EDDI slugs is a future refinement.
  nidisGriddedTileRoot:
    'https://storage.googleapis.com/noaa-nidis-drought-gov-data/current-conditions/tile/v1',

  // ---------- Static reference layers (bundled data in public/data/) ----------
  // Vite serves `public/` under the configured `base`, so the runtime URLs
  // must be prefixed with `import.meta.env.BASE_URL` (which is
  // `/dynamic-drought-module/` in dev and on GitHub Pages). A bare leading
  // slash (`/data/...`) resolves to the host root and 404s under the base path,
  // both locally and on Pages; that was a latent bug (the empty-placeholder
  // layers surfaced as `error` instead of `no-data`). BASE_URL ends with a
  // slash, so the path segment must not start with one.
  ecoregionsLocal: import.meta.env.BASE_URL + 'data/ecoregions-pnw.geojson',
  // EPA Omernik Level III and Level IV ecoregion polygons for the PNW, baked
  // into a PMTiles vector bundle by scripts/build-ecoregion-tiles.mjs
  // (`npm run build:ecoregion-tiles`) from the EPA Region 10 shapefiles. Two
  // source-layers: `ecoregions-l3` and `ecoregions-l4`. Read in the browser via
  // the pmtiles protocol (HTTP Range Requests, so only the header, directory,
  // and visible tiles download). The simplification tolerance, source vintage,
  // and retrieval date are baked into the archive attribution so the overlay
  // never implies precision the source does not carry. The empty
  // `ecoregions-pnw.geojson` above is the legacy placeholder, retained until the
  // ecoregion layer module consumes this bundle.
  ecoregionsPmtilesLocal: import.meta.env.BASE_URL + 'data/ecoregions-pnw.pmtiles',
  tribalLandsLocal: import.meta.env.BASE_URL + 'data/tribal-lands.geojson',
  treatyAreasLocal: import.meta.env.BASE_URL + 'data/treaty-areas.geojson',
  // United States state boundaries, baked from the Census Bureau cartographic
  // boundary file (1:20,000,000 generalization, 2023 vintage, public domain)
  // by scripts/build-states.mjs (`npm run build:states`; source download
  // verified HTTP 200 on 2026-07-01). Public administrative reference data,
  // not sovereign-jurisdiction polygons, so bundling is consistent with
  // CLAUDE.md hard rule 1. Provenance is recorded in the file's `metadata`
  // foreign member.
  usStatesLocal: import.meta.env.BASE_URL + 'data/us-states.geojson',
  // ENSO index snapshot (the Oceanic Nino Index and the Relative ONI; built by
  // scripts/build-enso-snapshot.mjs, `npm run build:enso`). Bundled, so the
  // no-CORS CPC sources are read at build time, not by the browser at runtime.
  ensoIndicesLocal: import.meta.env.BASE_URL + 'data/enso-indices.json',

  // ---------- Cloudflare Worker proxy ----------
  // Filled in during M10 once the Worker is deployed. While empty, callers
  // that need CORS-restricted endpoints (NRCS Air-Water Database (AWDB),
  // USACE Dataquery, USBR Hydromet, NWRFC) should detect the empty string
  // and fail gracefully with the layer's `unavailable` status.
  workerProxy: '' as string
});
