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

import { LANDSCAPE_SIGNATURE_LOCAL_URL } from './landscape-url';

const BASE_URL =
  import.meta.env?.BASE_URL ?? '/dynamic-drought-module/';

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
  // `src/map/style.ts`. The bare hostname is the OSM tile policy's ONLY
  // supported form (U4f, policy fetched live 2026-07-12): the legacy a/b/c
  // sharding subdomains "may be slower or withdrawn without notice".
  // Policy invariants: never append cache-busting query params to tile
  // URLs, and never add a Referrer-Policy that strips the Referer from
  // tile requests (the policy's web-traffic attribution branch).
  basemapOSM: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',

  // NOAA NESDIS merged GOES East and West GeoColor, the opt-in recent
  // satellite basemap. This is the rolling, time-enabled 24-hour archive,
  // not the similarly named current-only service. Runtime queries a bounded
  // set of recent frames, rejects stale or future-dated records, probes them
  // newest to oldest, then pins every exportImage tile to the selected object
  // id and observation time. This prevents a viewport from mixing scans and
  // defeats the service's otherwise ambiguous 12-hour tile cache. New frames
  // arrive every 10 or 15 minutes; the client refreshes metadata every 10
  // minutes while active. Coverage ends near 76.46 degrees north and south,
  // so the subdued OpenStreetMap layer remains underneath.
  // Verified 2026-08-05: query and exportImage return HTTP 200 without
  // authentication, correctly reflect browser origins for CORS, and expose
  // objectid, name, start_time, and end_time. Direct browser access only; no
  // Worker proxy is involved.
  noaaMergedGeoColorImageServer:
    'https://satellitemaps.nesdis.noaa.gov/arcgis/rest/services/MERGEDGC_Last_24hr/ImageServer',

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

  // ---------- USGS Water Services Instantaneous Values (open data, CORS-OK) ----------
  // United States Geological Survey (USGS) Water Services, Instantaneous
  // Values (IV). Two query shapes share this base URL:
  //   - Single-site value fetch (existing use): `${usgsIV}?format=json
  //     &sites=<siteCode>&parameterCd=<codes>&siteStatus=active`.
  //   - Viewport DISCOVERY (unit A2 slice 2): `${usgsIV}?format=json
  //     &bBox=<west,south,east,north>&parameterCd=00060,00065
  //     &siteStatus=active` (no `sites`). With no period, the service
  //     defaults to mode=LATEST (one instantaneous point per
  //     site-parameter pair), which is what discovery needs.
  // Response is WaterML JSON; the site list is at value.timeSeries[]:
  //   .sourceInfo.siteName                              site name
  //   .sourceInfo.siteCode[0].value                     USGS site code
  //   .sourceInfo.geoLocation.geogLocation.latitude     decimal degrees (EPSG:4326)
  //   .sourceInfo.geoLocation.geogLocation.longitude    decimal degrees
  //   .variable.variableCode[0].value                   parameter code (00060, 00065)
  //   .variable.unit.unitCode                           unit (ft3/s, ft)
  //   .values[0].value[0].value                         latest reading (string; parse float)
  //   .values[0].value[0].dateTime                      ISO 8601, station-local offset
  // A gage reporting multiple parameters emits multiple timeSeries sharing
  // one siteCode; group by `sourceInfo.siteCode[0].value` before applying
  // the 50-nearest cap, or a station double-counts.
  // CAVEAT (load-bearing): the bBox size limit varies by latitude (an
  // equal-area cap, not a flat degree cap): roughly
  // width_deg * cos(latitude) * height_deg <= 25. A box that exceeds it
  // returns HTTP 400 with a `text/html` body (do not JSON-parse the error).
  // A low-zoom viewport can exceed it, so the consumer must clamp the query
  // bBox from the viewport center latitude, or fall back to "zoom in to
  // load". CAVEAT: `siteStatus=active` does not guarantee a current reading
  // (some active sites were months stale in testing); read `dateTime` per
  // series and treat anything past a telemetry window (for example 24
  // hours) as stale, not live.
  // Verified 2026-07-06 (ddm-source-verifier): HTTP 200, Content-Type
  // application/json, Access-Control-Allow-Origin: * (genuine wildcard,
  // confirmed with an unrelated test origin, not a reflection). Direct
  // fetch; no Worker proxy needed (host is not on the allow-list and does
  // not need to be).
  usgsIV: 'https://waterservices.usgs.gov/nwis/iv/',

  // ---------- NRCS AWDB REST (SNOTEL / SCAN station data) ----------
  // Natural Resources Conservation Service Air-Water Database REST service.
  // Data endpoint: `${nrcsAwdbRest}?stationTriplets=<id:state:network>
  // &elements=WTEQ,SNWD,PREC&duration=DAILY&beginDate=<Y-M-D>&endDate=<Y-M-D>`
  // returns a JSON array of { stationTriplet, data: [{ stationElement
  // { elementCode, storedUnitCode, durationName, dataPrecision }, values:
  // [{ date, value }] }] }. Element codes: WTEQ (Snow Water Equivalent,
  // inches), SNWD (snow depth), PREC (water-year precipitation accumulation).
  // Verified 2026-07-01: HTTP 200, Content-Type application/json,
  // Access-Control-Allow-Origin: * observed WITHOUT an Origin header (a
  // wildcard posture, so direct browser fetch works; this supersedes the
  // older "CORS restricted, proxy required" note in the agency-data skill,
  // which described the SOAP-era service). Access method: API (REST JSON).
  // Route: direct fetch primary; this exact path stays in the Worker route table and
  // the same request through `${workerProxy}/proxy?url=...` was verified the
  // same day (HTTP 200, body unchanged) as the resilience path if the
  // agency's CORS posture drifts. Daily values post once per day; the latest
  // daily reading observed was the prior calendar day.
  nrcsAwdbRest: 'https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/data',

  // ---------- NRCS AWDB REST station metadata (SNOTEL / SCAN discovery) ----------
  // The station-metadata (discovery) sibling of nrcsAwdbRest, same host.
  // Consumer appends `?stationTriplets=<pattern>[,<pattern>]
  // &returnStationElements=<bool>&activeOnly=<bool>`. stationTriplets takes
  // the `*` wildcard in any position (stationId:stateCode:networkCode):
  // network-only discovery uses `*:*:SNTL` (Snow Telemetry) or `*:*:SCAN`
  // (Soil Climate Analysis Network); a region cut uses a comma list of
  // per-state patterns, for example `*:WA:SNTL,*:OR:SNTL,*:ID:SNTL`.
  // Response is a bare JSON array (no envelope), one object per station:
  //   [].stationTriplet   "302:OR:SNTL"
  //   [].name             station name
  //   [].latitude         decimal degrees (WGS 84)
  //   [].longitude        decimal degrees
  //   [].elevation        feet
  //   [].beginDate / .endDate   service window; endDate "2100-01-01 00:00"
  //                             is the "still active" sentinel
  // With returnStationElements=true (default false; omit for a lean
  // coordinate-only payload): [].stationElements[].elementCode carries
  // WTEQ (Snow Water Equivalent, in), SNWD (snow depth, in), PREC (precip
  // accumulation, in) for SNOTEL; SMS (soil moisture, percent, ordinal =
  // depth sensor) for SCAN.
  // CAVEAT (load-bearing): there is NO server-side bounding-box or
  // networkCds filter; an unrecognized parameter is silently ignored, not
  // rejected (a guessed networkCds returns the full multi-network list).
  // So fetch per network (and optionally per state list for a region),
  // cache client-side (station metadata changes rarely, a days-to-weeks
  // cache is fine), and do the viewport bounding box and nearest-N cap in
  // the browser. Sizes: nationwide SNTL 912 stations (~395 kB), SCAN 212
  // (~92 kB), Pacific Northwest SNTL (WA+OR+ID) 245 (~107 kB).
  // CAVEAT: percent-encode the query via URLSearchParams / encodeURIComponent;
  // an unencoded `*` or `:` returned HTTP 400 in testing.
  // Verified 2026-07-06 (ddm-source-verifier): HTTP 200, Content-Type
  // application/json, Access-Control-Allow-Origin: * (genuine wildcard,
  // confirmed with no Origin header, the app origin, and an unrelated test
  // origin). Direct fetch; no Worker proxy needed (this exact path is also in
  // the Worker route table; the same request through the Worker
  // returned a byte-identical body the same day, as the resilience path).
  nrcsAwdbStations: 'https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/stations',

  // ---------- NIFC RAWS station registry (A3, keyless) ----------
  // Interagency Remote Automated Weather Stations (RAWS) discovery, the
  // National Interagency Fire Center (NIFC) "Public View" ArcGIS
  // FeatureServer (owner NIFC_Authoritative). Consumer appends
  // `/1/query?where=1=1&geometry=<west,south,east,north>
  // &geometryType=esriGeometryEnvelope&inSR=4326
  // &spatialRel=esriSpatialRelIntersects&outFields=StationName,StationID,
  // MesoWestStationID,Latitude,Longitude,State,Agency,Status,ObservedDate
  // &f=geojson` (matches the usdmFeatureServer / biaLar pattern).
  // GeoJSON: .features[].geometry.coordinates [lon,lat];
  // .properties.StationID, .StationName, .MesoWestStationID (cross-ref to
  // Synoptic if a deployer brings a key), .State/.Agency/.Status ("A" =
  // active), .ObservedDate (epoch ms), plus live current-conditions
  // strings (RelativeHumidity, AirTempStandPlace, WindSpeedMPH,
  // FuelMoisture) with embedded units (parse the leading number).
  // CAVEAT (load-bearing): the layer id is 1 (`/FeatureServer/1`), not 0.
  // CAVEAT: maxRecordCount 2000; a nationwide no-geometry query silently
  // truncates (exceededTransferLimit), so ALWAYS pass a spatial envelope
  // (this endpoint DOES filter server-side by bbox, unlike the AWDB list).
  // Filter Status "A" for active (3220 features nationwide include
  // retired; a PNW bbox returned 737).
  // KEY SITUATION: the Synoptic Data / MesoWest metadata API is the
  // reputational RAWS source but is KEYED (live probe returned 401
  // "Missing token"); this NIFC authoritative FeatureServer is the keyless
  // substitute.
  // Verified 2026-07-06 (ddm-source-verifier): HTTP 200, application/json,
  // Access-Control-Allow-Origin: * (genuine wildcard). Direct fetch; no
  // Worker proxy.
  nifcRawsFeatureServer:
    'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/PublicView_RAWS/FeatureServer/1',

  // ---------- NOAA CO-OPS tides and currents station metadata (A3, keyless) ----------
  // National Oceanic and Atmospheric Administration (NOAA) Center for
  // Operational Oceanographic Products and Services (CO-OPS) Metadata API
  // (mdapi) station discovery. Consumer appends
  // `/stations.json?type=waterlevels`. Envelope: { count, units, stations }.
  //   .stations[].id / .name / .lat / .lng (WGS 84) / .state
  //   .stations[].affiliations (e.g. "NWLON") / .tidal / .greatlakes
  //   .stations[].products.self (per-station live-data link for hydration)
  // CAVEAT (load-bearing): `state=<code>` is accepted but SILENTLY IGNORED
  // (like nrcsAwdbStations); fetch the one national list (301 stations,
  // ~775 kB), cache client-side, and filter to viewport in the browser
  // (coastal WA+OR is 23 stations, well under the cap).
  // Verified 2026-07-06 (ddm-source-verifier): HTTP 200, application/json,
  // Access-Control-Allow-Origin: * (genuine wildcard). Direct fetch; no
  // Worker proxy.
  noaaCoopsStations: 'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json',

  // ---------- USBR AgriMet station registry (A3, keyless, Worker-proxy route) ----------
  // United States Bureau of Reclamation (USBR) AgriMet agricultural weather
  // network (both regions), the discovery companion to usbrHydrometArcCsv.
  // No REST/JSON API: the station list is a JavaScript data file backing
  // the public station map. Fetch as TEXT, regex out the single-quoted
  // string assigned to `agrimet_sites`, then JSON.parse it. Parsed shape is
  // a GeoJSON-like FeatureCollection: .features[].geometry.coordinates
  // [lon,lat]; .properties.StationID (5-char site code, the id
  // usbrHydrometArcCsv's PCODE query expects), .StationName, .StationState,
  // .StationElevation (feet), .webpage.
  // CAVEAT (load-bearing): Content-Type is application/x-javascript, NOT
  // JSON (do not response.json()). CAVEAT: Access-Control-Allow-Origin is
  // ABSENT, so direct browser fetch fails; Worker-proxy ONLY. The host
  // (www.usbr.gov) is ALREADY on the Worker allow-list (usbrHydrometArcCsv),
  // so no allow-list change; the proxied request returned a byte-identical
  // body. CAVEAT: single national file (199 stations; PNW core WA+OR+ID is
  // 131), no region-scoped URL, filter client-side.
  // Verified 2026-07-06 (ddm-source-verifier): HTTP 200,
  // application/x-javascript, CORS absent; proxied body byte-identical.
  usbrAgrimetSitesJs: 'https://www.usbr.gov/gp/agrimet/data_files/AgrimetSites.js',

  // ---------- CoCoRaHS station registry via Iowa Environmental Mesonet (A3, keyless mirror) ----------
  // Community Collaborative Rain, Hail and Snow Network (CoCoRaHS) station
  // discovery. CoCoRaHS's own Web API (api2.cocorahs.org) requires HTTP
  // Basic authentication (live probe returned 401), a per-registrant
  // credential and a poor fit for a keyless static bundle. The Iowa
  // Environmental Mesonet (IEM, Iowa State University) operates a keyless
  // per-state GeoJSON mirror of the same registry. Consumer appends
  // `?network=<STATE>_COCORAHS` (one two-letter state per call:
  // WA_COCORAHS, OR_COCORAHS, ID_COCORAHS; no combined endpoint).
  // GeoJSON: .features[].geometry.coordinates [lon,lat]; .properties.sid
  // (e.g. "WA-AD-11"), .sname, .state/.county/.elevation (meters), .online
  // (boolean, currently reporting), .archive_end (null = still active).
  // CAVEAT (load-bearing): the list is the FULL historical roster, not just
  // active (WA 1941 features, 1075 online); filter client-side on
  // online:true before the viewport/cap or dead stations surface. CAVEAT:
  // no combined-region call (three sequential fetches WA/OR/ID, merge
  // client-side); heaviest payload of the four (WA ~1.1 MB), cache
  // client-side. PROVENANCE CAVEAT: this is a THIRD-PARTY mirror (IEM), not
  // CoCoRaHS's own infrastructure; treat as "verified reachable and shaped
  // as claimed," re-verify if IEM sync cadence is ever in question.
  // Verified 2026-07-06 (ddm-source-verifier): HTTP 200,
  // application/vnd.geo+json, Access-Control-Allow-Origin: * (genuine
  // wildcard). Direct fetch; no Worker proxy.
  iemCocorahsNetwork: 'https://mesonet.agron.iastate.edu/geojson/network.php',

  // ---------- NWRFC Water Supply Forecast Report (bulk CSV) ----------
  // Northwest River Forecast Center seasonal water-supply forecasts for the
  // Columbia Basin and PNW coastal rivers. Consumer appends
  // `?Type=ALL&Source=ALL&Wyr=<water_year>&WyrDate=<YYYY-MM-DD>&Flavor=ESP10`.
  // Columns: ID, Location, FcstPeriod, then Min/90/75/50/25/10/Max forecast
  // (KAF) each paired with a percent-of-average column (1991-2020 normals),
  // PeriodAvg, PrevRO, CurRO, CurPerAvg, FcstDate.
  // Verified 2026-07-01 (scout-and-verify pipeline): HTTP 200, Content-Type
  // text/html; charset=UTF-8, Access-Control-Allow-Origin ABSENT (confirmed
  // both with and without an Origin header), so browser consumption is
  // Worker-proxy ONLY; the proxied request returned 200 with a byte-identical
  // body. Access method: bulk download (CGI CSV endpoint).
  // Anti-scrape note: this is the machine CSV twin of ws_report.cgi (HTML);
  // do not parse the per-station ws_forecasts.php pages.
  // CAVEAT (load-bearing): the body is CSV wrapped in a bare HTML shell
  // (<title>, <body>, <pre> ... </pre>, </body>); strip markup lines before
  // parsing. CAVEAT: Source=<id> does NOT filter (byte-identical to ALL);
  // fetch the full table (123 stations, ~740 rows observed) and filter
  // client-side by ID. CAVEAT: FcstDate echoes the requested WyrDate; pass
  // today's date, there is no "latest" default. Wyr is the water year
  // (October through December roll to the next calendar year).
  nwrfcWsReportCsv: 'https://www.nwrfc.noaa.gov/water_supply/ws_report_csv.cgi',

  // ---------- USBR Hydromet / AgriMet daily-arc CSV (PN region CGI) ----------
  // Consumer appends `?parameter=<SITE%20PCODE[,...]>&syer=<Y>&smnth=<M>
  // &sdy=<D>&eyer=<Y>&emnth=<M>&edy=<D>&format=2`. PCODEs in use: AF
  // (reservoir storage, acre-feet), ET (daily reference evapotranspiration,
  // inches), MM / MX / MN (mean / max / min daily air temperature, F).
  // Verified 2026-07-01 (scout-and-verify pipeline): HTTP 200, Content-Type
  // text/html; charset=UTF-8, Access-Control-Allow-Origin ABSENT (confirmed
  // with and without an Origin header), so browser consumption is
  // Worker-proxy ONLY; the proxied request returned 200 with a byte-identical
  // body. Access method: bulk download (CGI CSV endpoint).
  // Anti-scrape note: the machine CSV-table twin of the Hydromet and AgriMet
  // report pages; do not scrape the HTML graphing UI or teacup diagrams.
  // CAVEAT (load-bearing): the body is CSV inside an HTML shell with
  // BEGIN DATA / END DATA markers; parse only between the markers. Fields
  // are comma-delimited and space-padded; trim each. The most recent day
  // commonly reads the literal "NO RECORD" (not yet posted; about one
  // calendar day of lag observed); treat as missing, not as an error.
  usbrHydrometArcCsv: 'https://www.usbr.gov/pn-bin/webarccsv.pl',

  // ---------- USACE CWMS Data API ----------
  // Corps Water Management System Data API v2. Consumer appends
  // `/timeseries?name=<id>&office=<office>&begin=<ISO>&end=<ISO>` or
  // `/catalog/TIMESERIES?office=<office>&like=<regex>`.
  // Verified 2026-07-01 (scout-and-verify pipeline): HTTP 200, Content-Type
  // application/json;version=2, Access-Control-Allow-Origin: * (a genuine
  // wildcard, confirmed with and without an Origin header), so the DIRECT
  // fetch is the route; the Worker path was also confirmed byte-identical as
  // resilience. Access method: API (REST JSON).
  // CAVEAT (load-bearing): every request needs an explicit
  // `Accept: application/json;version=2` header. A wrong timeseries id
  // returns HTTP 200 with an EMPTY values array, not an error; consumers
  // must not treat 200-with-empty as success and should fall back to
  // /catalog/TIMESERIES discovery. Working example: office NWDP,
  // `IHR.Elev-Forebay.Inst.1Hour.0.Best` (hourly, units ft); the sibling
  // `...Ave.~1Day.1Day.CBT-REV` reports in meters. Read the response's
  // `units` field per series, never assume.
  usaceCwmsData: 'https://cwms-data.usace.army.mil/cwms-data',

  // ---------- National Weather Service (NWS) API ----------
  // api.weather.gov: the public National Oceanic and Atmospheric
  // Administration (NOAA) NWS Application Programming Interface (API). Used by
  // the impact briefing for active alerts (red-flag fire weather, excessive
  // heat), point observations, raw grid guidance, and point forecasts. NWS
  // requires an identifying User-Agent. Browsers discard a caller-supplied
  // User-Agent, so the production-identification path is the allow-listed
  // Worker. Direct mode remains a graceful fallback for forks without a Worker.
  //   - Active alerts:  `${nwsApi}/alerts/active?point=<lat>,<lon>`
  //   - Point metadata: `${nwsApi}/points/<lat>,<lon>` (returns the forecast URL)
  // Re-verified 2026-07-29: alerts, points, grid data, station lists, and
  // latest observations returned CORS-open JSON. Chromium discarded a custom
  // fetch User-Agent. Set `nwsApiUseWorker` true only in the same release that
  // follows deployment of a matching Worker route revision in workers/proxy/.
  nwsApi: 'https://api.weather.gov',
  nwsApiUseWorker: true as boolean,

  // NOAA NWS event-driven Watch/Warning/Advisory (WWA) MapServer, layer 1
  // (WatchesWarnings). Used by the heat and fire-weather alerts map layer:
  // unlike `${nwsApi}/alerts/active` (whose zone-based alerts carry null
  // geometry), this service resolves zone geometry server-side and emits
  // polygon GeoJSON. Updated every 5 minutes per the service description.
  // Verified 2026-07-01: query with prod_type filter returned HTTP 200,
  // Content-Type application/geo+json, reflected-origin CORS
  // (Access-Control-Allow-Origin echoed the requesting Origin, like the BIA
  // FeatureServer), polygon features with prod_type / onset / ends /
  // expiration / wfo / url attributes. Access method: ESRI REST query,
  // f=geojson, direct.
  nwsWwaMapServer:
    'https://mapservices.weather.noaa.gov/eventdriven/rest/services/WWA/watch_warn_adv/MapServer/1',

  // ---------- NOAA Storm Prediction Center (SPC) Fire Weather Outlook ------
  // The SPC Fire Weather Outlooks MapServer, same NOAA mapservices cloud host
  // as `nwsWwaMapServer`. Layer 1 ("Day 1 Outlook") and layer 4 ("Day 2
  // Outlook") are the categorical fire-weather THREAT forecasts (pre-existing
  // fuel dryness combined with forecast wind, relative humidity, and dry
  // lightning over the next one to two days). This is not the NFDRS
  // fuel-dryness fire danger rating and not an active-fire product; the popup
  // carries that framing. Layers 2 and 5 are separate dry-thunderstorm
  // sub-layers, not wired. The categorical field is `dn` (Data Number), an
  // INTEGER with no string sibling: 5 = Elevated, 8 = Critical, 10 = Extreme
  // (per the service's documented risk classification; the consumer maps the
  // value client-side). `valid` / `expire` carry the validity window as
  // `YYYYMMDDHHMM` UTC strings. An empty FeatureCollection is a legitimate
  // "no elevated fire weather today" result, not an error (confirmed live:
  // the nationwide Day 1 pull returned two Southwest features on the
  // verification date while a PNW envelope returned zero). Updated up to five
  // times daily (Day 1) and twice daily (Day 2).
  // Verified 2026-07-01: HTTP 200, Content-Type application/geo+json,
  // Access-Control-Allow-Origin reflected the request origin (confirmed
  // against the app origin; absent without an Origin header), so a browser
  // fetch needs no proxy. Access method: ESRI REST MapServer query,
  // f=geojson, direct (the SPC graphical page is not scraped).
  spcFireWeatherOutlookMapServer:
    'https://mapservices.weather.noaa.gov/vector/rest/services/fire_weather/SPC_firewx/MapServer',

  // ---------- NWS HeatRisk (experimental) ----------
  // The NWS / Weather Prediction Center HeatRisk index: five classes (0
  // little-to-none, 1 minor, 2 moderate, 3 major, 4 extreme) of expected
  // heat impact, one value per day across a rolling 7-day forecast, CONUS.
  // NWS flags the product as EXPERIMENTAL (no availability guarantee;
  // changes without notice); the sidebar label carries that word.
  // Verified 2026-07-01: HTTP 200; exportImage returns image/png (confirmed
  // by PNG magic bytes and a pixel decode showing the published class
  // colors, not a blank tile); Access-Control-Allow-Origin reflected the
  // request origin (confirmed against the app origin, localhost, and an
  // unrelated origin), so no Worker proxy is needed. Access method: ESRI
  // ImageServer exportImage raster tiles, MapLibre bbox template, direct.
  // CAVEAT (load-bearing, found in adversarial verification): this is a
  // 7-day rolling forecast mosaic keyed on idp_validtime. Omitting `time`
  // is stable but WRONG: a no-time exportImage matched the +2-day raster,
  // not today (confirmed via identify catalogItemVisibilities). The
  // consumer MUST read timeInfo.timeExtent[0] from the service metadata at
  // activation and pass it as `time=<epoch ms>`; a static URL template is
  // not sufficient. The WMS sibling is not exposed (HTTP 400); do not use
  // it as a fallback. The raw pixel values are a single-band float 0 to 4;
  // the class colors are applied server-side, so no client recoloring.
  // MULTI-DAY CONFIRMED 2026-07-06 (ddm-source-verifier, closing a B3
  // unknown): the time-keyed mosaic delivers real per-day signal, not a
  // static frame. /identify at a PNW point (-120.5, 46.6) across the full
  // timeInfo.timeExtent returned class 2 (day 1), 1 (day 4), 1 (day 7),
  // each response's catalogItems idp_validtime matching the requested time
  // and resolving to a distinct granule (HeatRisk_<1|4|7>_Mercator). A
  // Phoenix point read 2 on all three days (plausible persistent risk, not
  // a defect; not every point varies every window). CORS on /identify:
  // reflected origin (confirmed for the deploy origin). Callers MUST pass
  // time=<epoch ms> from timeInfo.timeExtent; omitting it is undefined.
  // This is the verified basis for a Days 1-7 heat outlook read.
  nwsHeatRisk:
    'https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer',

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
  //
  // A second path on the same base is a DOCUMENTED CANDIDATE only: nothing in
  // src/ consumes it today, and the path is absent from the Worker proxy
  // allowlist (workers/proxy/src/index.ts pins GetDSCI alone), so wiring it
  // up would require a Worker allowlist addition first. It is the
  // per-category area-percent series that could enumerate valid USDM weeks
  // and populate per-week sidebar statistics.
  //   `${usdmDataServices}/StateStatistics/GetDroughtSeverityStatisticsByAreaPercent
  //    ?aoi=<fips>&startdate=M/D/YYYY&enddate=M/D/YYYY&statisticsType=1`
  // Send `Accept: application/json` (defaults to CSV like GetDSCI; the
  // `Access-Control-Allow-Origin: *` header is only emitted when the request
  // carries an `Origin` header, which every real browser fetch sends, so this
  // is invisible from a bare `curl` call without `-H "Origin: ..."`).
  // Verified 2026-07-08: HTTP 200, Content-Type application/json;
  // charset=utf-8, Access-Control-Allow-Origin: * (confirmed with an Origin
  // header present, matching real browser behavior; also confirmed on the
  // CORS preflight OPTIONS response). Returns an array of weekly records:
  // { mapDate, stateAbbreviation, none, d0, d1, d2, d3, d4, validStart,
  // validEnd, statisticFormatID }. `mapDate`/`validStart` land on real
  // Tuesdays (verified for aoi=53, 41, 16 across the full 2000-01-04 to
  // present range); `d0`..`d4` are cumulative percent-of-area-in-category-
  // or-worse (`none` + `d0` = 100). Tested aoi=53 (WA), 41 (OR), 16 (ID).
  // Freshness matches the USDM Thursday release cadence: as of Wednesday
  // 2026-07-08 the latest record was the week ending Tuesday 2026-06-30 (the
  // following week's map, valid through 2026-07-07, had not yet posted).
  // CORS DRIFT 2026-07-14 (caught by the 0.6.8 publish verification): the
  // host STOPPED emitting Access-Control-Allow-Origin (three consecutive
  // probes with a real Origin header, no ACAO, no Vary; both earlier
  // verifications above recorded ACAO present). The DSCI trend fetch now
  // rides the Worker proxy (src/impact/sources.ts; exact route entry added
  // same day), per the vary-origin intermittency doctrine. If a later
  // probe shows the header restored, KEEP the Worker route: intermittent
  // CORS is the failure mode the doctrine exists for.
  usdmDataServices: 'https://usdmdataservices.unl.edu/api',

  // ---------- USDM per-week archive (0.5.0b temporal axis) ----------
  // Every published USDM week since 2000-01-04 as the same NDMC ArcGIS
  // Online FeatureServer family as `usdmFeatureServer`. The consumer appends
  // `/query?where=MapDate=timestamp '<YYYY-MM-DD> 00:00:00'&outFields=...
  // &outSR=4326&f=geojson` with the Tuesday valid date. Schema CAVEAT
  // (verified live 2026-07-08): the validity fields are ValidStartDate /
  // ValidEndDate here, NOT the ValidStart/ValidEnd of USDM_current, and an
  // outFields naming a nonexistent field returns HTTP 400. DM 0..4 and
  // MapDate (epoch ms) match. Pass maxAllowableOffset=0.01&
  // geometryPrecision=4: a bad-drought national week shrinks from ~6.5 MB
  // to ~440 KB (measured 2026-07-08).
  // Verified 2026-07-08 (ddm-source-sweep wf_6ab55eaf): HTTP 200,
  // application/json, Access-Control-Allow-Origin: * (wildcard). Direct
  // fetch, no Worker proxy.
  // CAVEAT (load-bearing): the newest archived week must be read LIVE (the
  // scrubber derives it from the USDM_current MapDate); on a Wednesday the
  // most recent Tuesday is NOT yet published (Thursday release). CAVEAT:
  // f=topojson returns HTTP 400 (GeoJSON only). CAVEAT: request only the
  // fields the popup needs; outFields=* on a bad-drought week is a large
  // payload on rural connections.
  usdmArchiveFeatureServer:
    'https://services5.arcgis.com/0OTVzJS4K09zlixn/arcgis/rest/services/USDM_archive/FeatureServer/0',

  // ---------- USDM Change Maps (0.5.0b, the honest velocity field) ----------
  // Categorical change classes (worsened / no change / improved) for the
  // CURRENT USDM week only; there is no keyless historical-change archive,
  // so the change toggle is offered only at the newest scrubber stop.
  // 1-week change: the drought.gov data bucket (same GCS host as
  // nidisGriddedTileRoot). 4-week change: the NCEI NIDIS mirror.
  // Verified 2026-07-08 (ddm-source-sweep wf_6ab55eaf): both HTTP 200,
  // application/geo+json, Access-Control-Allow-Origin: * (wildcard),
  // top-level `date` field matching the current valid Tuesday (20260630 at
  // verification, released Thursday 2026-07-02). Direct fetch, no proxy.
  usdmChange1wkGeojson:
    'https://storage.googleapis.com/noaa-nidis-drought-gov-data/current-conditions/json/v1/us/usdm/usdm-change.geojson',
  usdmChange4wkGeojson:
    'https://www.ncei.noaa.gov/pub/data/nidis/geojson/us/usdm/usdm-4wk-change.geojson',

  // ---------- CPC drought outlook, vector form (0.5.0b outlook register) ----------
  // The same cpc_drought_outlk service the raster `cpcDroughtWMS` above
  // renders, but the ArcGIS REST vector layers, so the outlook register can
  // draw hatched fills client-side with the issued date and valid-through
  // target read from attributes. Layer 1 = Monthly Drought Outlook (US +
  // Puerto Rico), layer 4 = Seasonal Drought Outlook (US + Puerto Rico);
  // island-territory layers are siblings. Consumer appends
  // `/<1|4>/query?where=1=1&outFields=outlook,fcst_date,target,idp_filedate
  // &outSR=4326&f=geojson`. Attributes: `outlook` (the four-class tendency),
  // `fcst_date` (issued, 'MM/DD/YYYY'), `target` (valid-through label).
  // Verified 2026-07-08 (ddm-source-sweep wf_6ab55eaf): HTTP 200,
  // application/geo+json, Access-Control-Allow-Origin reflected origin
  // (same posture as nwsWwaMapServer / usfsWhp; browser fetch needs no
  // proxy). Monthly issued last day of month for the following month;
  // Seasonal issued with a three-month horizon.
  cpcDroughtOutlookVectorMapServer:
    'https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/cpc_drought_outlk/MapServer',

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
  // CORS REGRESSION 2026-07-09 (0.7.0 pre-open assessment; repaired as H3):
  // a real browser saw 49/49 `exportImage` responses WITHOUT the
  // Access-Control-Allow-Origin header while the metadata endpoint kept
  // answering with it, and a same-day curl probe got the header again; the
  // posture is INTERMITTENT (Vary: Origin cache-variant suspected). The
  // layer module therefore routes tiles through `${workerProxy}/proxy`
  // (this exact exportImage path is in the Worker route table); this URL is the
  // upstream base only, never fetched directly by the browser anymore.
  usfsWhp:
    'https://imagery.geoplatform.gov/iipp/rest/services/Fire_Aviation/USFS_EDW_RMRS_WildfireHazardPotentialClassified/ImageServer',

  // ---------- Bureau of Indian Affairs (BIA) reservation boundaries ----------
  // American Indian and Alaska Native Land Area Representation (AIAN-LAR): the
  // Land Area Representation feature definitions were last published in 2019.
  // The live BIA service separately reports continuing spatial-accuracy and
  // attribute updates. BIA authority is limited to BIA mission use; this
  // representation is illustrative, reference, and statistical only, not
  // legal, survey, or jurisdictional truth. The runtime stamps each successful
  // response with its browser retrieval date for the popup.
  // Hosted as an Environmental Systems Research Institute (ESRI)
  // FeatureServer, the `/0/query` path with `f=geojson` and a spatial envelope
  // (esriGeometryEnvelope, inSR=4326) returns a polygon FeatureCollection
  // clipped to the requested extent, with fields LARID, LARNAME,
  // CLASSIFICATION, GISACRES, REGION. Consumed live, not bundled: live
  // consumption commits no sovereign polygons to the repository. The bundled
  // empty
  // `tribal-lands.geojson` placeholder remains the deployer's own-data slot.
  // The `biamaps.doi.gov` host returned HTTP 500 at verification; use the
  // `biamaps.geoplatform.gov` host below.
  // Verified 2026-05-30: HTTP 200, Content-Type application/geo+json,
  // Access-Control-Allow-Origin: <reflected request origin> (verified against
  // https://atniclimate.github.io, so a browser fetch needs no proxy).
  // Fact-separated provenance receipt (D-0.8.0-052): the BIA governance page
  // says LAR feature definitions were last published in 2019; the service
  // metadata separately reports continuing spatial-accuracy and attribute
  // updates. Runtime records the actual browser retrieval date.
  // Access method: ESRI FeatureServer query, f=geojson, spatial envelope clip.
  // Anti-scrape note: the BIA AIAN-LAR FeatureServer, not the OneMap HTML hub.
  biaLarFeatureServer:
    'https://biamaps.geoplatform.gov/server/rest/services/DivLTR/BIA_AIAN_National_LAR/FeatureServer/0',

  // ---------- US Census Bureau TIGERweb AIANNH (Tribal Lands, live) ----------
  // American Indian, Alaska Native, and Native Hawaiian Areas (AIANNH), the
  // Census Bureau's comprehensive Tribal-geography product, hosted as an ESRI
  // MapServer. This is the BROAD Tribal Lands layer (D-0.7.0-032): it carries
  // reservations and off-reservation trust land AND the statistical
  // geographies AIAN-LAR does not (Oklahoma Tribal Statistical Areas (OTSA),
  // Alaska Native Village Statistical Areas, Hawaiian Home Lands, state
  // reservations, joint-use areas), so it closes the confirmed Oklahoma gap
  // (biaLarFeatureServer returns zero features for Oklahoma). Consumed LIVE,
  // not bundled: activation-time agency fetch commits no sovereign polygons to
  // the repository and does not engage the no-redistribution hard rule (exactly
  // like biaLarFeatureServer). Layer 47 is the comprehensive layer; per-type
  // siblings exist (2 Federal reservations, 3 off-reservation trust land, 7
  // OTSA, 10 joint-use, 4 state reservations, 5 Hawaiian Home Lands, 6 Alaska
  // Native Village Statistical Areas). Consumer appends
  // `/<layer>/query?where=1=1&geometry=<bbox>&geometryType=esriGeometryEnvelope
  // &inSR=4326&outSR=4326&spatialRel=esriSpatialRelIntersects&outFields=NAME,
  // AIANNH,AIANNHCC,MTFCC,BASENAME,AIANNHNS,AREALAND,AREAWATER&returnGeometry=
  // true&f=geojson`, the biaLarFeatureServer pattern. STEWARDSHIP: AIANNHCC is
  // the reliable subtype field (MTFCC is coarser via layer 47); statistical
  // areas MUST be labeled distinctly from legal reservation/trust-land
  // representations (Codex architectural review HIGH constraint, never blend
  // with AIAN-LAR). AREALAND/AREAWATER are STRING-typed (parse before area
  // math). Generalize large geometry with maxAllowableOffset+geometryPrecision
  // but visually verify small/detached parcels survive (per the review).
  // Verified 2026-07-15 (ddm-source-verifier): HTTP 200, Content-Type
  // application/geo+json on /query; Access-Control-Allow-Origin: <reflected
  // request origin> (genuine reflection confirmed three ways including a bogus-
  // origin control, works for https://atniclimate.github.io, no proxy needed;
  // NOT on the Worker ALLOW_LIST, adding it if CORS ever drifts is a hard-rule-
  // 7 decision). Layer 47 returned 31 features for the Oklahoma envelope (25
  // OTSA + Osage reservation + Shawnee trust land + 4 joint-use); layer 7
  // returned 25 OTSA. Vintage "January 1, 2025". maxRecordCount 100000 (no
  // truncation risk). Provenance chain for the D-0.7.0-032 T0 condition:
  // publisher US Census Bureau, a federal statistical product, activation-time
  // fetch (recorded in the 2026-07-15 tier assessment).
  // Anti-scrape note: the ArcGIS REST /query path, not the TIGERweb viewer.
  censusAiannhMapServer:
    'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/AIANNHA/MapServer',

  // ---------- BIA Tribal Leaders Directory (headquarters points, live) ----------
  // Administrative-headquarters POINT layer (not a boundary), proposed to give
  // spatial representation to the 314 federally recognized Tribal Nations with
  // no mapped land area in AIAN-LAR (public/data/tribal-larname-crosswalk.json
  // rosterNoLar). A government office location, markedly lower sensitivity than
  // a jurisdiction boundary. Consumed LIVE. Consumer appends
  // `/query?where=1=1&outFields=*&f=geojson` (588 records, one page,
  // maxRecordCount 2000) or `/query?where=tribefullname='<name>'&...`. GeoJSON
  // Point; geometry.coordinates [lon,lat] (prefer over the single-precision
  // longitude/latitude scalar fields). STEWARDSHIP: BIA's own disclaimer ("not
  // an official listing of federally recognized tribes... does not guarantee
  // the accuracy of the Directory's tribal contact information") must ride in
  // any surfacing, the "representation, not settled fact" pattern adapted to
  // contact accuracy. CAVEATS: 27 of 588 rows have a NULL physicaladdress (all
  // true SQL NULL; fall back to mailingaddress or name/region/phone); NEVER set
  // credentials:'include' (the service returns Access-Control-Allow-Credentials:
  // true alongside the wildcard ACAO, spec-invalid together, inert only while
  // anonymous). Verified 2026-07-15 (ddm-source-verifier): HTTP 200,
  // Content-Type application/json; charset=utf-8; Access-Control-Allow-Origin: *
  // (GENUINE wildcard, confirmed with the production origin, no-origin, and an
  // OPTIONS preflight; more permissive than biaLarFeatureServer; direct fetch,
  // no proxy). Live count 588; same-day layer-wide edit stamp (monthly BIA CSV
  // sync). NOT yet wired to a layer (candidate for the landless-Tribe point
  // display; D-0.7.0-032 records the source, the UI is a later unit).
  // Anti-scrape note: the TribalLeadership_Directory FeatureServer /0/query
  // path, not the bia.gov HTML map viewer.
  biaTribalLeadersDirectory:
    'https://services1.arcgis.com/UxqqIfhng71wUT9x/arcgis/rest/services/TribalLeadership_Directory/FeatureServer/0',

  waEcologyCededLands:
    'https://services.arcgis.com/6lCKYNJLvwTXqrmp/arcgis/rest/services/ECY/FeatureServer/10',

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

  // ---------- USGS Watershed Boundary Dataset ----------
  // Verified 2026-07-16 for browser-direct, attribute-only HUC2 and HUC4
  // catalog queries plus per-selection and bbox-scoped geometry. Geometry
  // requests must carry zoom-scaled maxAllowableOffset and cancellation.
  wbdMapServer:
    'https://hydro.nationalmap.gov/arcgis/rest/services/wbd/MapServer',

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
  // TEMPORAL CAVEAT (0.5.0b sweep, 2026-07-08): these tiles are a single
  // current-conditions snapshot with NO time dimension; the gridded SPI
  // surface cannot be honestly stepped from this source. The time-enumerable
  // form is the University of Idaho THREDDS gridMET aggregation
  // (https://tds-proxy.nkn.uidaho.edu/thredds/.../agg_met_spi90d_1979_
  // CurrentYear_CONUS.nc, OPeNDAP + NetCDF subset, wildcard CORS, verified
  // live 2026-07-08 with a native FIVE-day cadence, not weekly), but NetCDF
  // decoding in the browser is a new transport; recorded here as verified
  // NOT wired, deferred past 0.5.0. The VegDRI / QuickDRI weekly WMS at
  // dmsdata.cr.usgs.gov (TIME-enabled, wildcard CORS, weekly Monday steps,
  // exact-match TIME required, off-list dates return an HTTP 200 XML
  // ServiceException) were likewise verified 2026-07-08 and left unwired.

  // ---------- Static reference layers (bundled data in public/data/) ----------
  // Vite serves `public/` under the configured `base`, so the runtime URLs
  // must be prefixed with `import.meta.env.BASE_URL` (which is
  // `/dynamic-drought-module/` in dev and on GitHub Pages). A bare leading
  // slash (`/data/...`) resolves to the host root and 404s under the base path,
  // both locally and on Pages; that was a latent bug (the empty-placeholder
  // layers surfaced as `error` instead of `no-data`). BASE_URL ends with a
  // slash, so the path segment must not start with one.
  ecoregionsLocal: BASE_URL + 'data/ecoregions-pnw.geojson',
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
  ecoregionsPmtilesLocal: BASE_URL + 'data/ecoregions-pnw.pmtiles',
  // The PNW hillshade raster-dem archive (U4g, D-0.7.0-012/-029): terrarium
  // PNG tiles, 512 px, z0-8, whole-meter quantized, baked by
  // Built from the USGS 3DEP ImageServer (public domain; vintage and
  // retrieval are recorded in the PMTiles archive metadata). Served same-origin
  // from Pages exactly like the ecoregion bundle (the D-029 per-asset
  // selection, 2026-07-14: 33.6 MB fits the Pages path; the z9 build is a
  // reproducible artifact, not shipped).
  hillshadePmtilesLocal: BASE_URL + 'data/hillshade-dem-pnw.pmtiles',
  // Hosting-size fallback for the exact same committed z0-8 archive. The ATNI
  // GitHub Pages copy was verified 2026-07-29 as 35,252,210 bytes with byte
  // ranges, Access-Control-Allow-Origin: *, and a matching PMTiles header.
  // Runtime uses this only after the deployer's bundled local copy fails its
  // bounded header probe, so normal static deployments remain self-contained.
  hillshadePmtilesFallback:
    'https://atniclimate.github.io/dynamic-drought-module/data/hillshade-dem-pnw.pmtiles',
  // The PNW LANDFIRE fuel-model drape for the desktop 3D Fire mode: LF2024
  // Scott and Burgan 40 Fire Behavior Fuel Models (FBFM40), CONUS, rendered
  // server-side by the LANDFIRE ImageServer's own class colors and baked to
  // PNG PMTiles by scripts/build-fuels-tiles.mjs (`npm run build:fuels-tiles`;
  // U.S. Public Domain, USGS-produced; vintage, retrieval date, and the
  // reduced-resolution disclosure are recorded in the archive attribution).
  // Loaded only while the 3D Fire mode is active, via the pmtiles protocol's
  // ranged reads, exactly like the hillshade archive above.
  fuelsFbfm40PmtilesLocal: BASE_URL + 'data/fuels-fbfm40-pnw.pmtiles',
  // PNW transmission lines for the desktop 3D Fire mode: a one-time build
  // extract (scripts/build-power-tiles.mjs, `npm run build:power-tiles`) of
  // the ARCHIVED federal HIFLD dataset via the public Esri Federal User
  // Community copy (Extract capability enabled; accessInformation "U.S.
  // Government"; the item states it is archived with last data update
  // 2024-09-30). Deliberately baked rather than fetched live: an orphaned
  // archive is not a runtime dependency, and the in-app qualification
  // carries the mandatory currency caveat. Loaded only while the 3D Fire
  // mode is active.
  powerLinesPmtilesLocal: BASE_URL + 'data/power-lines-pnw.pmtiles',
  // Central Oregon building footprints for the desktop 3D Fire mode:
  // Overture Maps Foundation buildings theme (ODbL; fuses OpenStreetMap,
  // Microsoft, Esri, and Google open building sets), extracted by
  // scripts/extract-overture-buildings.py and baked by
  // scripts/build-structures-tiles.mjs (`npm run build:structures-tiles`).
  // The committed default covers the central_oregon region framing only
  // (a full-PNW bake measured roughly 240 MB and was rejected; the extract
  // script's --bbox parameter is the deployer path for other regions).
  // z13-14 vector tiles; loaded only while the 3D Fire mode is active.
  structuresPmtilesLocal: BASE_URL + 'data/structures-central-oregon.pmtiles',
  tribalLandsLocal: BASE_URL + 'data/tribal-lands.geojson',
  treatyAreasLocal: BASE_URL + 'data/treaty-areas.geojson',
  // United States state boundaries, baked from the Census Bureau cartographic
  // boundary file (1:20,000,000 generalization, 2023 vintage, public domain)
  // by scripts/build-states.mjs (`npm run build:states`; source download
  // verified HTTP 200 on 2026-07-01). Public administrative reference data,
  // not sovereign-jurisdiction polygons, so bundling is consistent with the
  // no-redistribution hard rule. Provenance is recorded in the file's
  // `metadata` foreign member.
  usStatesLocal: BASE_URL + 'data/us-states.geojson',
  // Municipal place labels (U4e; Natural Earth 1:10m populated places,
  // public domain, US subset; built by scripts/build-places.mjs with the
  // build-failing glyph gate). Names only plus points; naming policy rides
  // D-0.7.0-030.
  usPlacesLocal: BASE_URL + 'data/us-places.json',
  // ENSO index snapshot (the Oceanic Nino Index and the Relative ONI; built by
  // scripts/build-enso-snapshot.mjs, `npm run build:enso`). Bundled, so the
  // no-CORS CPC sources are read at build time, not by the browser at runtime.
  ensoIndicesLocal: BASE_URL + 'data/enso-indices.json',
  // Landscape-signature artifact (T-M0-3; built by scripts/landscape via
  // `npm run build:landscape`, validated against
  // schema/landscape-signature.schema.json). The artifact IS committed and
  // ships (169 bundles at T-S1-4, 2026-07-25; the gate validates it via
  // check:landscape-schema). T3-2 consumes it lazily for exact Level III and
  // Level IV ecoregion briefings; unsupported boundary kinds never request
  // the artifact and explain the missing one-to-one resolution honestly.
  landscapeSignatureLocal: LANDSCAPE_SIGNATURE_LOCAL_URL,
  // Per-state resource catalog base (0.6.0 R2). Public resource LINKS are not
  // sovereign data, so the catalog ships in-repo (D-0.6.0-004); each state's
  // rows live at `<base>data/resources/<lowercase-two-letter-code>.json` and are
  // fetched only for the clicked state (lazy). The schema is enforced by
  // scripts/check-resource-catalog.mjs and src/impact/resource-catalog.ts.
  resourcesLocalBase: BASE_URL + 'data/resources/',

  // ---------- NASA GIBS sea surface temperature anomaly (B2, keyless WMTS) ----------
  // Global Imagery Browse Services (GIBS) GHRSST Level 4 MUR sea surface
  // temperature (SST) anomaly, daily, ~1 km. The ENSO ocean surface: the
  // equatorial warm/cool tongue rendered as map tiles. MapLibre raster tile
  // template; the GIBS path order is {z}/{y}/{x} (TileMatrix/TileRow/TileCol),
  // the REVERSE of the OSM z/x/y convention; MapLibre substitutes tokens by
  // name so the template below is correct as written.
  // Verified 2026-07-06 (ddm-source-verifier): HTTP 200, Content-Type
  // image/png, Access-Control-Allow-Origin: * (genuine wildcard, confirmed
  // with an Origin header). Direct fetch, no Worker proxy. Confirmed at z=3
  // tiles 3/3/1, 3/4/1, 3/2/2 (Pacific rows): all 200, PNG magic bytes.
  // Layer-Time-Actual 2026-07-05 for the `default` segment (one-day lag,
  // daily cadence; Time dimension runs 2019-07-23 to present in P1D blocks
  // with rare short gaps). CAVEAT (load-bearing): TileMatrixSet
  // GoogleMapsCompatible_Level7 tops out at TileMatrix 7; set maxzoom 7 on
  // the source or tiles 404 beyond it. AccessConstraints: none.
  // UNVERIFIED: the anomaly climatology baseline is NOT stated in
  // GetCapabilities or the colormap XML; do not assert a baseline in UI copy.
  gibsSstAnomalyWmts:
    'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png',

  // ---------- GIBS SST anomaly TIME axis (0.5.0b, the one true Play loop) ----------
  // The dated form of the template above: the `{TIME}` token (YYYY-MM-DD)
  // is substituted by the SST layer module BEFORE the source is created
  // (MapLibre only expands {z}/{y}/{x}). Dates are enumerated live from the
  // WMTS DescribeDomains resource below (a compact per-layer XML, NOT the
  // multi-megabyte all-layer GetCapabilities).
  // Re-verified 2026-07-08 (ddm-source-sweep wf_6ab55eaf): tiles HTTP 200,
  // image/png, wildcard CORS; latest granule 2026-07-07 (one-day lag on the
  // daily P1D cadence; the current UTC date 404s until published).
  // DescribeDomains HTTP 200 text/xml, wildcard CORS; 11 P1D DimensionDomain
  // ranges spanning 2019-07-23 to present (short gaps exist; enumerate the
  // ranges, never assume contiguity). The MUR25 sibling (Level6, 2002+) was
  // also verified but is non-contiguous and coarser; not wired.
  gibsSstAnomalyWmtsTime:
    'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/{TIME}/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png',
  gibsSstDescribeDomains:
    'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/wmts.cgi?SERVICE=WMTS&REQUEST=DescribeDomains&VERSION=1.0.0&LAYER=GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies&TILEMATRIXSET=GoogleMapsCompatible_Level7',

  // ---------- NOAA CPC weekly SST anomaly (B2 fallback, verified not wired) ----------
  // Fallback SST anomaly raster (weekly cadence, coarser). Same host family
  // as cpcDroughtWMS / nwsWwaMapServer. Kept as the verified fallback if the
  // GIBS layer ever retires; not wired.
  // Verified 2026-07-06 (ddm-source-verifier): HTTP 200, image/png (PNG
  // magic bytes, 256x256 RGBA), Access-Control-Allow-Origin reflected origin
  // (Vary: Origin; same posture as usfsWhp already in this file). Layer 4 is
  // "Weekly Global Sea Surface Temp Anomaly" (layer 0 is absolute SST).
  // Updates weekly Monday 1100Z. CAVEAT: "This service is not time enabled"
  // (current week only). UNVERIFIED: anomaly baseline not stated in metadata.
  cpcWeeklySstAnomalyMapServer:
    'https://mapservices.weather.noaa.gov/raster/rest/services/climate/cpc_wkly_sst/MapServer',

  // ---------- CPC official ENSO probabilities (REMOVED; tombstone) ----------
  // REMOVED 2026-07-21 (T-P0-1, D-0.8.0-011 finding 3): cpcEnsoProbabilities,
  // the CPC probabilistic-outlook page. It is HTML-only (a server-rendered
  // table, no documented machine feed), so the build-time consumer was a
  // scrape, contrary to the anti-scrape doctrine. The ENSO snapshot is
  // indices-only; a plume returns only via a documented CPC machine endpoint
  // or an explicitly-labeled modeled NMME ensemble (workplan T-V0-3).

  // ---------- B3 coupled-hazards slate (all five verified 2026-07-06) ----------
  // Per the ratified B3 discipline: the pipeline ran against all five
  // candidates; wiring is "verified N, wired M, never all." Stamps below are
  // the verifier's findings; wiring status is noted per entry.

  // NOAA Hazard Mapping System (HMS) satellite smoke plumes: polygons with a
  // Light/Medium/Heavy Density class, GOES-East/West detection.
  // Verified 2026-07-06 (ddm-source-verifier): HTTP 200, application/json,
  // Access-Control-Allow-Origin: * (genuine wildcard, Origin header set).
  // ESRI FeatureServer query, f=geojson, direct. CAVEAT (load-bearing):
  // Start/End_ are Julian "YYYYDDD HHMM" STRINGS (not ISO); parse
  // client-side, and filter recent-only via `where=Start LIKE '<YYYYDDD>%'`
  // (the filter was confirmed to genuinely discriminate; a stale-day control
  // returned 0). maxRecordCount 1000; observed unfiltered count 85.
  // UNVERIFIED: copyrightText is empty; do not assert a license in UI copy.
  noaaHmsSmokeFeatureServer:
    'https://services2.arcgis.com/C8EMgrsFcRFL6LrL/arcgis/rest/services/NOAA_Satellite_Smoke_Detection_(v1)/FeatureServer/0',

  // U.S. Energy Information Administration power plants (EIA Forms
  // 860/860M), the point companion to the baked transmission-line archive
  // in the 3D Fire mode's power context. Verified 2026-08-18 PDT: hosted by
  // the Esri Federal User Community org, item b063316fac7345dba4bae96eaa813b2f,
  // public, independently maintained (item modified 2026-08-05;
  // dataLastEditDate 2025-07-01; record Period '202502'), CORS
  // Access-Control-Allow-Origin: *, Cache-Control public max-age 3600.
  // The PNW envelope returned 625 points in one request (~25 KB gzipped
  // with the trimmed outFields). licenseInfo is Esri MLA boilerplate over
  // U.S. federal data; attribute "Energy Information Administration (EIA)"
  // and surface the Period vintage rather than implying real-time.
  eiaPowerPlantsFeatureLayer:
    'https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/Power_Plants_in_the_US/FeatureServer/0',

  // EPA AirNow current monitor readings (the KEYLESS ArcGIS layer behind
  // fire.airnow.gov; api.airnow.gov is keyed and correctly bypassed).
  // Verified 2026-07-06 (ddm-source-verifier): HTTP 200, application/json,
  // Access-Control-Allow-Origin: * (genuine wildcard). FeatureServer query,
  // f=geojson, direct; bbox envelope form confirmed. CAVEAT: the path
  // segment carries literal spaces; keep them percent-encoded (%20) or the
  // URL is rejected before it reaches the server. CAVEAT: PM25_AQI and
  // OZONE_AQI are nullable per monitor; ValidTime is epoch ms (observed 37
  // minutes stale). A PNW bbox pulls in British Columbia monitors near the
  // border; do not word popups US-only. maxRecordCount 10000. Preliminary,
  // not-fully-QA'd data per EPA; AQI-display framing only. NOT yet wired.
  epaAirNowCurrentFeatureServer:
    'https://services.arcgis.com/cJ9YHowT8TU7DUyn/arcgis/rest/services/Air%20Now%20Current%20Monitor%20Data%20Public/FeatureServer/0',

  // NIFC Interagency Fire Perimeter History, all years (burned-context;
  // the historic sibling of nifcFires, same trusted org).
  // Verified 2026-07-06 (ddm-source-verifier): HTTP 200, application/json,
  // Access-Control-Allow-Origin: * (genuine wildcard). FeatureServer query,
  // f=geojson, spatial envelope, direct. CAVEAT (load-bearing):
  // FIRE_YEAR_INT carries a 9999 sentinel for unknown year (268 rows
  // nationwide); filter `FIRE_YEAR_INT < 9000` before any max/latest-year
  // computation. Real coverage confirmed through 2024 (2025 and 2026 counts
  // are 0); current-year fires live in nifcFires, so a seamless timeline
  // must stitch both. maxRecordCount 2000; a PNW-bbox+year query returned
  // 11 records (payloads stay sane). NOT yet wired (0.8.0 burned-context).
  nifcHistoricPerimetersFeatureServer:
    'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/InterAgencyFirePerimeterHistory_All_Years_View/FeatureServer/0',

  // USGS EROS VegDRI weekly vegetation drought stress (observed impact),
  // GeoServer WMS. Re-verified 2026-07-08 (ddm-source-verifier,
  // adversarial pass; originally verified 2026-07-06): HTTP 200,
  // image/png (magic bytes, 512x512 decode, 10-color palette, non-
  // transparent pixels confirmed by pixel sample), Access-Control-Allow-
  // Origin: * (genuine wildcard on a bare GeoServer; no Worker proxy
  // needed). EPSG:3857 GetMap CONFIRMED working (native web-mercator; no
  // reprojection). Layer (workspace:layer):
  // quickdri_vegdri_conus_week_data:vegdri_conus_week_data. Weekly TIME
  // dimension, default="current" (confirmed byte-identical to the
  // explicit latest-TIME request). GetCapabilities lists the full valid
  // TIME set; latest granule at this re-verification is still
  // 2026-06-29 (the 2026-07-06 week had not posted as of 2026-07-08, a
  // 9-16 day lag depending on how the week is counted; a wider lag than
  // the 7-day figure noted 2026-07-06, so treat weekly cadence as
  // approximate, not guaranteed). CAVEAT (load-bearing, new this pass):
  // TIME must match a GetCapabilities Dimension value EXACTLY; there is
  // no nearest-match fallback. An off-list TIME (tested with an
  // out-of-range date) returns HTTP 200 with Content-Type text/xml
  // (OGC ServiceExceptionReport, code InvalidDimensionValue), not a
  // PNG, so callers must branch on Content-Type or snap requested dates
  // to the published Dimension list rather than compute "last Monday."
  // The Dimension list also shows a historical ~4-week gap
  // (2022-07-25 to 2022-08-22), evidence this product has had past
  // outages; not disqualifying, but do not assume unbroken weekly
  // continuity when back-filling a time series. CAVEAT: the response
  // sets an HttpOnly session cookie; fine for raster tiles, never fetch
  // with credentials included. NOT yet wired.
  usgsVegdriWeeklyWms:
    'https://dmsdata.cr.usgs.gov/geoserver/quickdri_vegdri_conus_week_data/wms',

  // Verified 2026-07-08 (ddm-source-verifier, adversarial pass): HTTP 200,
  // Content-Type image/png (PNG magic bytes; a 183,976-byte frame for
  // TIME=2026-06-29 versus a 59,619-byte frame for TIME=2017-01-09 at the
  // same bbox, confirming TIME is genuinely respected and not ignored),
  // Access-Control-Allow-Origin: * (genuine wildcard, confirmed with no
  // Origin header, the app origin, and an unrelated test origin). Access
  // method: WMS (GetCapabilities + GetMap raster PNG frames, TIME
  // dimension). EPSG:3857 GetMap confirmed (native web-mercator; no
  // reprojection). Layer (workspace:layer):
  // quickdri_quickdri_conus_week_data:quickdri_conus_week_data. Weekly
  // time dimension, default="current"; discrete list runs
  // 2016-12-26..2026-06-29 at verification (9-day lag on a weekly
  // cadence); the no-TIME default request is byte-identical to
  // TIME=2026-06-29, confirming default really tracks latest. CAVEAT
  // (load-bearing, adversarial finding): TIME must exactly match a value
  // from the GetCapabilities time list; GeoServer does NOT snap to
  // nearest for this layer. An off-list TIME (tested one week off) or an
  // out-of-range TIME (tested a 2030 date) both return HTTP 200 but
  // Content-Type text/xml;charset=UTF-8, an OGC ServiceExceptionReport
  // (code InvalidDimensionValue), not a PNG; a consumer MUST check
  // Content-Type before treating the body as image bytes, and should
  // snap requested dates to the published discrete list (parse it from
  // GetCapabilities) rather than assume every Sunday or Monday works.
  // CAVEAT: the response sets an HttpOnly session cookie, same as the
  // sibling usgsVegdriWeeklyWms; fine for anonymous raster tiles, never
  // fetch with credentials included. No Cache-Control header observed.
  // Anti-scrape note: this GetMap endpoint already is the machine path;
  // there is no separate HTML viewer being bypassed. Same host, CORS,
  // 3857 support, and cookie caveat as usgsVegdriWeeklyWms (the
  // faster-response QuickDRI composite versus VegDRI's observed-impact
  // product). NOT yet wired.
  usgsQuickdriWeeklyWms:
    'https://dmsdata.cr.usgs.gov/geoserver/quickdri_quickdri_conus_week_data/wms',

  // ---------- B4 transboundary slate (verified 2026-07-06; 0.7.0 wiring) ----------
  // Per the ratified B4 scope these are VERIFIED, NOT WIRED; region-config
  // and UI work is 0.7.0. Seam doctrine (phase LOG 2026-07-07): USDM weekly,
  // NADM monthly consensus, and BC's 0-5 basin scale are three DIFFERENT
  // products; any border view names the issuing agency per polygon, never
  // blends them into one field.

  // North American Drought Monitor (NADM) continental monthly snapshot
  // (NOAA NCEI hosting; tri-national consensus). Regional cuts with an
  // identical schema exist per basin (NADM-<Region>current.geojson;
  // Columbia confirmed).
  // Properties: DROUGHTCAT "d0".."d4", YEAR_MONTH "YYYYMM", POPULATION,
  // POP_PCT, AREA_SQMI, AREA_PCT. NO per-feature issuing-agency attribute
  // (labeling NDMC vs AAFC vs CONAGUA needs a spatial join; flagged for
  // 0.7.0 honest framing). CAVEAT (extension trap): the sibling .json files
  // are TopoJSON ("type":"Topology") despite HTTP 200 application/json;
  // only fetch .geojson. The legacy NADM ArcGIS MapServer that search
  // engines still index is DEAD (404); do not resurrect it.
  // Verified 2026-07-06 (ddm-source-verifier): HTTP 200, application/geo+json,
  // Access-Control-Allow-Origin: * (wildcard, Origin set); YEAR_MONTH
  // 202605, Last-Modified 2026-06-16 (monthly, 2-3 week publication lag).
  // RECONFIRMED 2026-07-27: direct .geojson remains HTTP 200 with wildcard
  // CORS; 616,132 bytes, five MultiPolygons, DROUGHTCAT d0-d4, YEAR_MONTH
  // 202606, Last-Modified 2026-07-16. NCEI's current open-data policy keeps
  // NOAA and other federal data public domain in the United States, while
  // contributed international holdings retain their originator's terms.
  // Carry product attribution: National Oceanic and Atmospheric
  // Administration (NOAA), National Drought Mitigation Center (NDMC),
  // United States Department of Agriculture (USDA), Agriculture and Agri-Food
  // Canada (AAFC), and Mexico's National Water Commission (CONAGUA). Do not
  // infer an issuing agency for a polygon. Runtime must fetch this .geojson
  // only; the sibling .json extension remains the TopoJSON trap.
  nadmCurrentGeojson:
    'https://www.ncei.noaa.gov/pub/data/nidis/geojson/na/nadm/NADM-current.geojson',
  // NCEI's companion country base. The minimap filters this file to the US,
  // Canada, and Mexico before estimating area shares, so ocean and neighboring
  // countries cannot be mislabeled as `None`. It is a land-analysis mask, not
  // a jurisdictional display layer and is never rendered or redistributed.
  // Verified 2026-08-05: HTTP 200, application/geo+json, wildcard CORS,
  // 96,827 bytes, FIPS_CNTRY country codes, Polygon/MultiPolygon geometry.
  // The file does not identify NADM's drought-not-analyzed areas in Nunavut;
  // the far-north minimap summary must remain live (partial).
  nadmNorthAmericaBaseGeojson:
    'https://www.ncei.noaa.gov/pub/data/nidis/geojson/na/base/northamerica.geojson',
  // Statistics Canada 2021 Census Digital Boundary File, province and
  // territory layer, filtered to Nunavut and generalized to 0.01 degrees by
  // the documented ArcGIS maxAllowableOffset query. NADM's published maps
  // shade Nunavut as drought not analyzed, but its machine files omit that
  // mask. The minimap therefore intersects this boundary with NCEI land and
  // removes it from the denominator as an explicitly partial analysis-mask
  // proxy. It is never rendered or redistributed. The Digital Boundary File
  // includes coastal water, which is why it must only subtract from land.
  // Verified 2026-08-05: one 19,962-byte GeoJSON Polygon, PRUID 62,
  // origin-reflecting CORS, Open Government Licence - Canada.
  statsCanNunavutBoundaryGeojson:
    'https://geo.statcan.gc.ca/geo_wa/rest/services/2021/Digital_boundary_files/MapServer/0/query?f=geojson&geometryPrecision=5&maxAllowableOffset=0.01&outFields=PRUID%2CDGUID%2CPRNAME%2CPRENAME%2CPRFNAME%2CPREABBR%2CPRFABBR%2CLANDAREA&outSR=4326&returnGeometry=true&where=PRUID%20%3D%20%2762%27',

  // Canadian Drought Monitor (CDM, Agriculture and Agri-Food Canada) monthly
  // bulk archive. Consumer substitutes <year>/<yymm>: .../areasofDrought/
  // <year>/cdm_<yymm>_drought_areas_json.zip. License: Open Government
  // Licence - Canada (confirmed via open.canada.ca dataset
  // 292646cd-619f-4200-afb1-8b2c52f984a2; reconfirmed unchanged
  // 2026-07-27 through the open.canada.ca package API).
  // CAVEAT (load-bearing): the zip holds ONE FILE PER OCCUPIED CLASS ONLY
  // (CDM_<yymm>_D<n>_LR.geojson; May 2026 held D0/D1/D2, no D3/D4 file);
  // never assume all five. Properties are ONLY {OBJECTID, DM 0-4, AREA_AC,
  // Shape_Length, Shape_Area}: no region names, no per-feature date (the
  // month lives in the filename). CAVEAT: geometry CRS is EPSG:3857, not
  // WGS 84; reproject before use. STEWARDSHIP CHECK (explicit, per the
  // ratified Canadian-Indigenous deferral): the May 2026 archive was
  // downloaded, expanded, and grepped; NO First Nations, Metis, Inuit,
  // reserve, or Treaty boundary data is bundled (re-check any future month
  // used; the archive regenerates monthly).
  // Verified 2026-07-06 (ddm-source-verifier): HTTP 200, application/zip,
  // 2,187,740 bytes; Access-Control-Allow-Origin ABSENT (Origin set), so
  // browser use is Worker-proxy ONLY and agriculture.canada.ca is NOT on
  // the Worker ALLOW_LIST. T-V0-6 selected the build-time snapshot route;
  // agriculture.canada.ca stays off the allow list.
  cdmDroughtAreasZipRoot:
    'https://agriculture.canada.ca/atlas/data_donnees/canadianDroughtMonitor/data_donnees/geoJSON/areasofDrought',
  // Compact build-time snapshot emitted by scripts/build-cdm-snapshot.mjs.
  // The artifact records its own month, class occupancy, source URL, byte
  // count, retrieval date, reprojection, and mandatory stewardship result.
  cdmDroughtAreasLocal: './data/cdm-drought-areas.json',

  // British Columbia drought levels by water basin (GeoBC / Water Management
  // Branch), ArcGIS Online hosted feature view, layer 27
  // (BC_Current_Drought_Levels; 41 basins; DroughtLevel 0-5 with a 99
  // sentinel = "not updated outside core drought season"; weekly Thursday
  // in season). Parentheses in the path are kept percent-encoded (%28 %29).
  // LICENSE CAVEAT (LOAD-BEARING): the ArcGIS item metadata licenses this
  // "Access Only" with "Copyright (c), Province of British Columbia. All
  // rights reserved." This is NOT the Open Government Licence - British
  // Columbia. MAINTAINER SIGN-OFF 2026-07-08 (Patrick Freeland, maintainer
  // of record): approved for use, accepting the "All rights reserved"
  // terms as a display/attribution source; the license blocker is lifted.
  // RECONFIRMED 2026-07-27: the ArcGIS item still says "Access Only",
  // "Copyright (c), Province of British Columbia. All rights reserved.";
  // public access, Query/Extract capabilities, and wildcard CORS are unchanged.
  // The actual layer wiring remains a scheduled 0.7.0 transboundary task
  // (seam doctrine: name the issuing agency per polygon, never blend); this
  // stamp only clears the gate. Any deployer re-serving this into a Tribe's
  // site should carry the "Province of British Columbia" attribution and
  // re-confirm the license has not changed. Recorded in the 0.5.0 phase LOG.
  // Verified 2026-07-06 (ddm-source-verifier): HTTP 200, application/json,
  // Access-Control-Allow-Origin: * (wildcard, Origin set) on both ?f=json
  // and /query; capabilities "Query,Extract" only (no edit operations
  // listed for the anonymous view; none attempted). maxRecordCount 2000.
  bcDroughtLevelsFeatureServer:
    'https://services1.arcgis.com/xeMpV7tU1t4KD3Ei/arcgis/rest/services/British_Columbia_Drought_Levels_%28Edit%29_view/FeatureServer/27',

  // ---------- Cloudflare Worker proxy ----------
  // The deployed DDM CORS proxy (workers/proxy/, `npm run deploy` there).
  // Request format: `${workerProxy}/proxy?url=<encoded_upstream_url>`;
  // only the exact AWDB, AgriMet, Hydromet, NWRFC, USDM DSCI, WHP exportImage,
  // and NWS read paths used by the runtime are accepted; everything else is
  // rejected with 403. Deployed 2026-07-01 to the atniclimate workers.dev
  // subdomain; health check at `${workerProxy}/healthz`. Callers must still
  // detect an empty string and fail gracefully so a fork without a deployed
  // Worker degrades to the layer's `unavailable` status.
  workerProxy: 'https://ddm-proxy.atniclimate.workers.dev' as string
});
