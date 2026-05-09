/**
 * Service endpoints. Centralized so any provider migration is a one-line
 * change.
 *
 * Open-source design notes:
 *   - Basemap is OpenTopoMap (CC-BY-SA, OpenStreetMap (OSM) plus Shuttle
 *     Radar Topography Mission (SRTM) topography). OSM standard tiles are
 *     kept as a fallback for resilience.
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

  // OSM standard tiles, used as a basemap fallback. Same `{s}` caveat as
  // above; pin to `a` for the MapLibre raster source.
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
