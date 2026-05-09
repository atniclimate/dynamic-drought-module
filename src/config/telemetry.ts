/**
 * Telemetry stations.
 *
 * Each marker carries enough metadata to either fetch live data (where Cross-
 * Origin Resource Sharing (CORS) permits) or surface authoritative source
 * links. Ported verbatim from the vanilla `app.js` `TELEMETRY_STATIONS`
 * constant (lines 131 to 262 in the v0.1.x baseline). The shape conforms to
 * `TelemetryStation` in `src/types/station.ts`; coordinates are
 * `[latitude, longitude]` to match the bounding-box convention from the
 * baseline. Conversion to MapLibre's `[lng, lat]` happens at the boundary
 * inside `src/layers/telemetry.ts`.
 *
 * Agency acronyms used below (spelled out on first use):
 *   USACE  = United States Army Corps of Engineers
 *   USGS   = United States Geological Survey
 *   USBR   = United States Bureau of Reclamation
 *   NRCS   = Natural Resources Conservation Service
 *   AWDB   = Air-Water Database (NRCS station registry)
 *   SNOTEL = Snow Telemetry (NRCS network)
 *   SWE    = Snow Water Equivalent
 *   NWRFC  = Northwest River Forecast Center (National Oceanic and
 *            Atmospheric Administration (NOAA))
 *   PSP    = Puget Sound Partnership
 *
 * Stewardship: this table contains only generic agency station metadata; no
 * Tribal, Treaty, or sovereign-jurisdiction data lives here.
 */
import type { TelemetryStation } from '../types/station';

export const TELEMETRY_STATIONS: readonly TelemetryStation[] = [
  // ------------------- Columbia / Snake Basin -------------------
  {
    id: 'ihr',
    name: 'Ice Harbor Dam',
    coords: [46.2503, -118.8783],
    region: 'columbia_snake_basin',
    type: 'dam',
    agency: 'USACE',
    color: '#06b6d4',
    description:
      'Lower Snake River dam. Forebay/tailwater elevation and total dissolved gas (TDG) drive salmonid passage management.',
    links: [
      { label: 'USACE Dataquery 2.0', url: 'https://www.nwd-wc.usace.army.mil/dd/common/dataquery/www/' },
      { label: 'DART River Environment', url: 'https://www.cbr.washington.edu/dart/query/river_daily' }
    ]
  },
  {
    id: 'bono3',
    name: 'Bonneville Dam (BONO3)',
    coords: [45.6440, -121.9410],
    region: 'columbia_snake_basin',
    type: 'dam',
    agency: 'NWRFC / USACE',
    color: '#06b6d4',
    description:
      'Lowermost Columbia River dam. NWRFC stage and discharge plotted alongside USACE operations.',
    links: [
      { label: 'NWRFC flowplot (BONO3)', url: 'https://www.nwrfc.noaa.gov/river/station/flowplot/flowplot.cgi?id=BONO3' },
      { label: 'DART quick-look', url: 'https://www.cbr.washington.edu/dart/' }
    ]
  },

  // ------------------- Cascades (snowpack) -------------------
  {
    id: 'snotel_791',
    name: 'Stevens Pass SNOTEL (791)',
    coords: [47.7472, -121.0867],
    region: 'cascades',
    type: 'snotel',
    agency: 'NRCS',
    color: '#e2e8f0',
    description:
      'Upper Tye River basin · 3,940 ft. Daily Snow Water Equivalent (SWE) reading drives runoff forecasts.',
    awdbStation: '791:WA:SNTL',
    links: [
      { label: 'NRCS station page', url: 'https://wcc.sc.egov.usda.gov/nwcc/site?sitenum=791' },
      { label: 'WA Water Supply Outlook', url: 'https://www.nrcs.usda.gov/wps/portal/wcc/home/quicklinks/states/wa/' }
    ]
  },
  {
    id: 'snotel_711',
    name: 'Rainy Pass SNOTEL (711)',
    coords: [48.5181, -120.7367],
    region: 'cascades',
    type: 'snotel',
    agency: 'NRCS',
    color: '#e2e8f0',
    description: 'Upper Granite Creek · 4,880 ft. North Cascades SWE indicator.',
    awdbStation: '711:WA:SNTL',
    links: [
      { label: 'NRCS station page', url: 'https://wcc.sc.egov.usda.gov/nwcc/site?sitenum=711' },
      { label: 'WA Water Supply Outlook', url: 'https://www.nrcs.usda.gov/wps/portal/wcc/home/quicklinks/states/wa/' }
    ]
  },

  // ------------------- Central Oregon -------------------
  {
    id: 'mrso',
    name: 'AgriMet Madras (MRSO)',
    coords: [44.6700, -121.1300],
    region: 'central_oregon',
    type: 'agrimet',
    agency: 'USBR',
    color: '#f59e0b',
    description:
      'Crop water-use station. Air temperature, RH, solar radiation drive evapotranspiration estimates.',
    links: [
      { label: 'AgriMet daily / hourly', url: 'https://www.usbr.gov/pn/agrimet/agrimetmap/mrsoda.html' }
    ]
  },
  {
    id: 'pobo',
    name: 'AgriMet Powell Butte (POBO)',
    coords: [44.1480, -121.0180],
    region: 'central_oregon',
    type: 'agrimet',
    agency: 'USBR',
    color: '#f59e0b',
    description: 'Climate observations for irrigated agriculture in the Deschutes basin.',
    links: [
      { label: 'AgriMet daily / hourly', url: 'https://www.usbr.gov/pn/agrimet/agrimetmap/poboda.html' }
    ]
  },
  {
    id: 'wickiup',
    name: 'Wickiup Dam',
    coords: [43.6864, -121.6864],
    region: 'central_oregon',
    type: 'reservoir',
    agency: 'USBR',
    color: '#a855f7',
    description:
      'Primary storage facility for the Deschutes basin. Real-time capacity is a leading drought indicator.',
    links: [
      { label: 'USBR Hydromet "Teacup" diagrams', url: 'https://www.usbr.gov/pn/hydromet/select.html' }
    ]
  },
  {
    id: 'modo3',
    name: 'Deschutes at Moody (MODO3)',
    coords: [45.6220, -120.9056],
    region: 'central_oregon',
    type: 'gage',
    agency: 'USGS',
    color: '#06b6d4',
    description: 'USGS 14103000, outflow of the Deschutes basin into the Columbia River.',
    usgsSite: '14103000',
    links: [
      { label: 'USGS streamgage', url: 'https://waterdata.usgs.gov/monitoring-location/14103000' }
    ]
  },

  // ------------------- Puget Sound -------------------
  {
    id: 'conw1',
    name: 'Skagit nr Concrete (CONW1)',
    coords: [48.5247, -121.7700],
    // CONW1 is in the upper Skagit (north WA), not strictly South Puget Sound;
    // the spec lists it under "Puget Sound", so we anchor it to the cascades
    // region for filtering and let it show on every map.
    region: 'cascades',
    type: 'gage',
    agency: 'NWRFC / USGS',
    color: '#06b6d4',
    description:
      'Skagit basin runoff. NWRFC volume forecasts use SNOTEL inputs to project exceedance probabilities.',
    usgsSite: '12194000',
    links: [
      { label: 'NWRFC flowplot (CONW1)', url: 'https://www.nwrfc.noaa.gov/river/station/flowplot/flowplot.cgi?id=CONW1' },
      { label: 'USGS streamgage', url: 'https://waterdata.usgs.gov/monitoring-location/12194000' }
    ]
  },
  {
    id: 'ps_vital_signs',
    name: 'Puget Sound Vital Signs',
    coords: [47.2529, -122.4443],
    region: 'south_puget_sound',
    type: 'indicator',
    agency: 'PSP',
    color: '#10b981',
    description:
      'Summer low-flow indicator for Puget Sound streams. Critical to salmonid rearing habitat health.',
    links: [
      { label: 'Vital Signs portal', url: 'https://vitalsigns.pugetsoundinfo.wa.gov/' },
      { label: 'PS Info Data Center', url: 'https://www.pugetsoundinfo.wa.gov/' }
    ]
  }
];
