# Dynamic Drought Module (DDM)

`atniclimate/dynamic-drought-module`

An embeddable, serverless web map for visualizing drought conditions, hydrography, ecological boundaries, wildfire activity, and live water and snowpack telemetry. Initial focus is the Pacific Northwest (PNW); regional generalization is planned (see [`ROADMAP.md`](ROADMAP.md)).

The build is TypeScript plus Vite, the map renderer is MapLibre GL JavaScript, and the optional Cloudflare Worker in `workers/proxy/` adds Cross-Origin Resource Sharing (CORS) headers to non-CORS agency endpoints (NRCS Air-Water Database (AWDB), USACE Dataquery, USBR Hydromet, NWRFC). Output is a static `dist/` folder served via GitHub Pages.

License: Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0).

> Looking for the previous vanilla Leaflet baseline (no build step, single `app.js` + `style.css` + `index.html`)? See the `v0.1.2` tag: `git checkout v0.1.2`.

---

## Quick start

```powershell
git clone https://github.com/atniclimate/dynamic-drought-module.git
cd dynamic-drought-module
npm install
npm run dev
# open http://localhost:5173/dynamic-drought-module/
```

Production build:

```powershell
npm run build
# emits dist/
npm run preview
# preview the production build at http://localhost:4173/
```

Type checking only (no emit):

```powershell
npm run typecheck
```

The deployed site lives at `https://atniclimate.github.io/dynamic-drought-module/` and is rebuilt on every push to `main` via `.github/workflows/deploy.yml`. Deployers self-hosting on their own infrastructure can run `npm run build` and serve the resulting `dist/` from any static web host.

---

## URL parameters

The application reads `window.location.search` on load, both for direct visits and for embedded iframes.

| Param    | Values                                                                                                                       | Default            |
| -------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `region` | `washington_state`, `columbia_snake_basin`, `cascades`, `central_oregon`, `southwest_washington`, `south_puget_sound`        | `washington_state` |
| `layers` | comma-separated keys: `hydrography`, `ecoregions`, `drought`, `usdm`, `tribal`, `treaty`, `nifc-fires`, `usfs-whp`, `telemetry` | `hydrography,tribal,telemetry` |
| `embed`  | `true` or `1` (hides the sidebar for clean iframe presentation)                                                              | `false`            |

### Examples

```
?region=central_oregon&layers=hydrography,drought,telemetry
?region=south_puget_sound&layers=tribal,treaty
?region=columbia_snake_basin&layers=drought,usdm,nifc-fires&embed=true
```

### Embedding

```html
<iframe
  src="https://atniclimate.github.io/dynamic-drought-module/?region=cascades&layers=drought,usdm,telemetry&embed=true"
  width="100%" height="600"
  style="border:1px solid #243049; border-radius:6px;"
  loading="lazy"
  title="PNW Drought + Wildfire Outlook">
</iframe>
```

A **Share view** button in the top-right of the map copies the current URL (region, active layers, and embed flag) to the clipboard.

---

## Regions

Bounding boxes are in WGS 84.

| Key                    | Bounds                                  | Notes                                |
| ---------------------- | --------------------------------------- | ------------------------------------ |
| `washington_state`     | (45.54, -124.76) to (49.00, -116.92)    | statewide                            |
| `columbia_snake_basin` | (45.35, -126.17) to (50.22, -111.04)    | seven-state drainage                 |
| `cascades`             | (46.50, -122.50) to (49.00, -120.50)    | high-elevation snowpack              |
| `central_oregon`       | (43.50, -122.00) to (45.65, -120.30)    | Deschutes basin and named telemetry  |
| `southwest_washington` | (45.50, -124.30) to (47.00, -122.00)    | lower Columbia estuary               |
| `south_puget_sound`    | (46.90, -123.20) to (47.50, -122.10)    | inland marine waters                 |

Per-region padding lives in `REGIONS[key].padding` in `src/config/regions.ts` (currently 0.10 to 0.25 degrees).

---

## Layers and data sources

| Layer                           | Source                                                               | Endpoint                                | Lives where                       |
| ------------------------------- | -------------------------------------------------------------------- | --------------------------------------- | --------------------------------- |
| Base map                        | OpenTopoMap (over OpenStreetMap plus SRTM)                           | XYZ raster tiles                        | upstream tile server              |
| Hydrography                     | OpenStreetMap, via Overpass API                                      | live JSON                               | three-mirror failover             |
| Ecoregions                      | EPA Level III                                                        | GeoJSON                                 | bundled in `public/data/`         |
| Seasonal Drought Outlook        | NOAA CPC                                                             | OGC WMS                                 | live                              |
| US Drought Monitor (USDM)       | NDMC / UNL / NOAA / USDA                                             | ArcGIS REST FeatureServer (`f=geojson`) | live                              |
| Tribal Lands                    | BIA AIAN-LAR (or Census AIANNH, or state portals)                    | GeoJSON                                 | bundled in `public/data/`         |
| Treaty Areas                    | WA DAHP, or Native Land Digital                                      | GeoJSON                                 | bundled in `public/data/`         |
| Active Wildfires (NIFC)         | National Interagency Fire Center, WFIGS Current Interagency Fire Perimeters | ArcGIS REST FeatureServer       | live                              |
| Wildfire Hazard Potential (WHP) | USFS / Federal GeoPlatform                                           | ArcGIS ImageServer (`exportImage`)      | live                              |
| Telemetry                       | USGS Water Services live, plus deep links to NRCS, USACE, USBR portals; SNOTEL via the Cloudflare Worker proxy | live JSON | live              |

All non-basemap layers are lazy-loaded on first toggle-on. Each reports its load state inline in the sidebar:

| Status                                   | Meaning                                                                                              |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `loading...`                             | Fetching from the network                                                                            |
| `live`                                   | Loaded successfully                                                                                  |
| `zoom in to load`                        | Hydrography is active but the current zoom is below z=7                                              |
| `empty placeholder (see data/README.md)` | The local GeoJSON file is an empty placeholder; populate it with authoritative data                  |
| `unavailable`                            | The endpoint failed (network error, rate limit, 404). Toggle off and back on to retry                |

### About hydrography

On toggle-on, and on every debounced `moveend`, the application issues an Overpass Query Language request for `waterway=river|canal` within the current viewport. Results are cached by quantized bounding box. Below zoom level 7, the layer is intentionally dormant. Mainstems (Columbia, Snake) render thicker than tributaries.

The Overpass API is volunteer-operated. Mirrors are tried in order with a 12-second per-call timeout: `overpass-api.de`, `overpass.kumi.systems`, `overpass.openstreetmap.fr`. For institutional deployments expecting concurrent users in the dozens or higher, consider running a dedicated Overpass instance or replacing this layer with a National Hydrography Dataset (NHD) PMTiles bundle (see [`ROADMAP.md`](ROADMAP.md)).

### About the basemap

OpenTopoMap is a free, open-source raster basemap operated by volunteers. Light-to-moderate use is fine for an embedded module; heavier traffic should host its own tile server.

### About the placeholders

The three reference polygon layers (Ecoregions, Tribal Lands, Treaty Areas) load from bundled GeoJSON in `public/data/`. They ship as empty `FeatureCollection` placeholders, so the application is functional on first deploy without redistributing any agency or sovereign-jurisdiction data. To enable a layer, replace the corresponding file with authoritative GeoJSON. Conversion commands and download URLs are documented in [`public/data/README.md`](public/data/README.md).

> **Treaty boundaries.** Agency polygons are a representation of Treaty cession areas, not a definitive depiction of Tribal jurisdiction. Treaty rights and Tribal sovereignty are matters of sovereign authority. Verify with the relevant Tribal Nation before using these polygons for any decision-making.

---

## Telemetry stations

Each station renders as a colored marker. Clicking the marker (or the matching item in the sidebar) opens a popup. For USGS streamgages the popup fetches live instantaneous values (discharge code 00060, gage height code 00065). Stations whose agencies do not currently expose CORS-friendly JSON (USACE Dataquery, NRCS AWDB, USBR AgriMet, NWRFC) surface an honest "open the source link" message rather than fake fetches that would fail in the browser.

Live SNOTEL Snow Water Equivalent (SWE) values can be fetched in-browser when the deployer has the Cloudflare Worker proxy in `workers/proxy/` deployed and `URLS.workerProxy` populated. See `workers/proxy/wrangler.toml` and the deploy steps in [`workers/proxy/`](workers/proxy/).

To add a station, append an entry to `TELEMETRY_STATIONS` in `src/config/telemetry.ts` with `coords`, `agency`, `description`, optional `usgsSite` (for live data), and `links`.

---

## Customization quick reference

| Want to change...           | Edit in                                    |
| --------------------------- | ------------------------------------------ |
| Region bounds or names      | `src/config/regions.ts` (`REGIONS`)        |
| Layer registry              | `src/config/layers.ts` (`LAYER_DEFS`)      |
| Ecoregion fill colors       | `src/config/palette.ts`                    |
| Drought outlook colors      | `src/config/palette.ts`                    |
| Treaty stroke colors        | `src/config/palette.ts` (`TREATY_COLORS`)  |
| Telemetry stations          | `src/config/telemetry.ts`                  |
| Endpoint URLs               | `src/config/urls.ts`                       |
| Default-on layers           | `LAYER_DEFS[i].defaultOn`                  |
| Brand text and colors       | `index.html` header, `src/styles/app.css`  |

---

## Architecture notes

- **No backend.** The static `dist/` folder served via GitHub Pages is the entire production deployment. The optional Cloudflare Worker in `workers/proxy/` is a CORS shim, not application logic.
- **URL-as-state.** Region, active layers, and embed flag round-trip through `window.location.search`. The `embed` flag is preserved across syncs so the share-from-embed flow stays consistent.
- **Lazy-loaded layers.** Each layer is loaded on first toggle-on. Subsequent toggles flip visibility on a cached source / layer set.
- **Empty-FeatureCollection placeholders.** Reference-polygon layers default to empty placeholders. An empty placeholder renders as `empty placeholder (see data/README.md)` rather than as an error.
- **Cancellable network operations.** Hydrography and telemetry both use a master abort signal plus per-call timeout. Hung connections do not block the application. Late-arriving responses to superseded operations are dropped, not rendered.
- **Honest user feedback.** The clipboard helper returns a real boolean. The popup data block shows real values or an honest "open the source link" message; it never fakes a fetch that would fail in production.
- **Mobile.** Sidebar stacks above the map below 720 pixels viewport. The collapse and expand buttons preserve embed semantics. `map.resize()` is called on viewport changes (rotation, browser resize, address-bar collapse).
- **Accessibility.** Region radiogroup supports arrow-key navigation; layer status changes are announced through a polite live region; telemetry list items are keyboard-activatable buttons with `:focus-visible` rings.

---

## File structure

```
/
├── .github/workflows/deploy.yml        # Build -> GitHub Pages
├── public/data/                        # Empty-FeatureCollection placeholders
├── src/
│   ├── main.ts                         # Boot
│   ├── styles/app.css
│   ├── config/                         # REGIONS, LAYER_DEFS, palette, telemetry, urls
│   ├── map/                            # createMap, base style spec
│   ├── layers/                         # One file per layer module
│   ├── state/                          # url, registry
│   ├── ui/                             # sidebar, popups, share, overlay
│   ├── util/                           # fetch, clipboard, escape, bbox
│   └── types/                          # region, layer, station
├── workers/proxy/                      # Cloudflare Worker CORS proxy
├── CLAUDE.md                           # Authoritative project context
├── README.md                           # This file
├── ROADMAP.md                          # PMTiles + regional generalization
├── CHANGES.md                          # Session-by-session change log
├── TODO.md                             # Deferred items
└── LICENSE                             # CC BY-NC-SA 4.0 full text
```

For the full named-export contract per module see `CLAUDE.md` section 8.

---

## Browser support

Tested mental model: any evergreen browser (Chrome, Edge, Firefox, Safari version 14 or newer). MapLibre GL JavaScript requires WebGL 1; almost all current devices satisfy that.

---

## Attribution and licensing

This project is licensed under the Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0) license.

- **Free to use and edit:** copy, redistribute, remix, and build upon this module.
- **Attribution:** give appropriate credit to ATNI Climate, link the license, indicate changes.
- **Non-commercial:** do not use the material for commercial purposes.
- **ShareAlike:** distribute remixes under this same license.

Data layers provided by sovereign Tribal Nations, state agencies, and federal entities retain their respective public-domain or specific-use licenses. Ensure you have authorization to redistribute any bundled reference polygons.

---

## Roadmap

PMTiles for hydrography (replacing the live Overpass dependency with a static NHD-derived bundle) and regional generalization beyond the Pacific Northwest are the next major work items. See [`ROADMAP.md`](ROADMAP.md).
