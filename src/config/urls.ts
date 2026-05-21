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

  // ---------- USGS Water Services (open data, CORS-OK) ----------
  usgsIV: 'https://waterservices.usgs.gov/nwis/iv/',

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

  // ---------- Static reference layers (bundled GeoJSON in public/data/) ----------
  // Vite serves the `public/` directory at the site root, so the runtime
  // URLs are `/data/<file>.geojson` (leading slash). The placeholder files
  // live at `public/data/` per CLAUDE.md section 7.
  ecoregionsLocal: '/data/ecoregions-pnw.geojson',
  tribalLandsLocal: '/data/tribal-lands.geojson',
  treatyAreasLocal: '/data/treaty-areas.geojson',

  // ---------- Cloudflare Worker proxy ----------
  // Filled in during M10 once the Worker is deployed. While empty, callers
  // that need CORS-restricted endpoints (NRCS Air-Water Database (AWDB),
  // USACE Dataquery, USBR Hydromet, NWRFC) should detect the empty string
  // and fail gracefully with the layer's `unavailable` status.
  workerProxy: '' as string
});
