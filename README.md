# Dynamic Drought Module (DDM)

`atniclimate/dynamic-drought-module`

An embeddable, serverless web map for visualizing drought conditions, hydrography, ecological boundaries, and live water and snowpack telemetry. Initial focus is the Pacific Northwest (PNW); regional generalization is planned (see [`ROADMAP.md`](ROADMAP.md)).

Serve the folder, or load it via GitHub Pages. No build step. The module is a single `index.html` plus a stylesheet, an `app.js` script, and a `data/` folder of reference polygons.

License: Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0).

> Looking for the target stack (TypeScript, Vite, MapLibre GL JavaScript, PMTiles, Cloudflare Workers, plus three additional layers)? See [`ROADMAP.md`](ROADMAP.md). This document describes the current shipping baseline.

---

## Quick start

```bash
git clone https://github.com/atniclimate/dynamic-drought-module.git
cd dynamic-drought-module
python3 -m http.server 8080
# open http://localhost:8080/
```

To deploy:

```bash
git add .
git commit -m "Initial DDM"
git push origin main
```

In the repository's **Settings -> Pages**, set the source to `main` / `/ (root)`. The site goes live in roughly 30 seconds at:

```
https://atniclimate.github.io/dynamic-drought-module/
```

The bundled `.nojekyll` file disables Jekyll processing so the `data/` folder serves cleanly.

---

## URL parameters

The application reads `window.location.search` on load, both for direct visits and for embedded iframes.

| Param    | Values                                                                                                                       | Default            |
| -------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `region` | `washington_state`, `columbia_snake_basin`, `cascades`, `central_oregon`, `southwest_washington`, `south_puget_sound`        | `washington_state` |
| `layers` | comma-separated keys: `hydrography`, `ecoregions`, `drought`, `tribal`, `treaty`, `telemetry`                                | `hydrography,tribal,telemetry` |
| `embed`  | `true` or `1` (hides the sidebar for clean iframe presentation)                                                              | `false`            |

### Examples

```
?region=central_oregon&layers=hydrography,drought,telemetry
?region=south_puget_sound&layers=tribal,treaty
?region=columbia_snake_basin&layers=drought,tribal&embed=true
```

### Embedding

```html
<iframe
  src="https://atniclimate.github.io/dynamic-drought-module/?region=cascades&layers=drought,telemetry&embed=true"
  width="100%" height="600"
  style="border:1px solid #243049; border-radius:6px;"
  loading="lazy"
  title="PNW Seasonal Drought Outlook">
</iframe>
```

A **Share view** button in the top-right of the map copies the current URL (region, active layers, and embed flag) to the clipboard. Pan, zoom, and toggle to the desired view, then click Share.

---

## Regions

Bounding boxes are in WGS 84, expressed as `(south, west)` to `(north, east)` for Leaflet. Padding is in degrees and is applied symmetrically on `fitBounds`.

| Key                    | Bounds                                  | Notes                                |
| ---------------------- | --------------------------------------- | ------------------------------------ |
| `washington_state`     | (45.54, -124.76) to (49.00, -116.92)    | statewide                            |
| `columbia_snake_basin` | (45.35, -126.17) to (50.22, -111.04)    | seven-state drainage                 |
| `cascades`             | (46.50, -122.50) to (49.00, -120.50)    | high-elevation snowpack              |
| `central_oregon`       | (43.50, -122.00) to (45.65, -120.30)    | Deschutes basin and named telemetry  |
| `southwest_washington` | (45.50, -124.30) to (47.00, -122.00)    | lower Columbia estuary               |
| `south_puget_sound`    | (46.90, -123.20) to (47.50, -122.10)    | inland marine waters                 |

Per-region padding lives in `REGIONS[key].padding` in `app.js` (currently 0.10 to 0.25 degrees).

---

## Layers and data sources

| Layer                       | Source                                                               | Endpoint                            | Lives where                       |
| --------------------------- | -------------------------------------------------------------------- | ----------------------------------- | --------------------------------- |
| Base map                    | OpenTopoMap (over OpenStreetMap plus SRTM)                           | XYZ raster tiles                    | upstream tile server              |
| Hydrography                 | OpenStreetMap, via Overpass API                                      | live JSON                           | three-mirror failover             |
| Ecoregions                  | EPA Level III                                                        | GeoJSON                             | bundled in `data/`                |
| Seasonal Drought Outlook    | NOAA Climate Prediction Center (CPC)                                 | OGC Web Map Service (WMS)           | live                              |
| Tribal Lands                | BIA AIAN-LAR (or Census AIANNH, or state portals)                    | GeoJSON                             | bundled in `data/`                |
| Treaty Areas                | WA Department of Archaeology and Historic Preservation (DAHP), or Native Land Digital | GeoJSON         | bundled in `data/`                |
| Telemetry                   | USGS Water Services (live JSON), plus deep links to NRCS, USACE, USBR portals | live JSON for USGS streamgages; portal links elsewhere | live |

All non-basemap layers are lazy-loaded on first toggle-on. Each reports its load state inline in the sidebar:

| Status                          | Meaning                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `loading...`                    | Fetching from the network                                                                                     |
| `live`                          | Loaded successfully                                                                                           |
| `zoom in to load`               | Hydrography is active but the current zoom is below z=7. Pan or zoom in to trigger an Overpass query for the visible area |
| `no data (see data/README.md)`  | The local GeoJSON file is an empty placeholder; populate it with authoritative data (see [`data/README.md`](data/README.md)) |
| `unavailable`                   | The endpoint failed (network error, rate limit, 404). Toggle off and back on to retry                         |

### About hydrography

On toggle-on, and on every debounced `moveend`, the application issues an Overpass Query Language request for `waterway=river|canal` within the current viewport. Results are cached by quantized bounding box so panning within a small area does not refetch. Below zoom level 7, the layer is intentionally dormant and the status pill reads `zoom in to load`. Mainstems (Columbia, Snake) render thicker than tributaries.

The Overpass API is volunteer-operated and rate-limited. The application debounces pan and zoom requests, caches results, and fails over through three mirrors (`overpass-api.de`, `kumi.systems`, `private.coffee`). For institutional deployments expecting concurrent users in the dozens or higher, consider running a [dedicated Overpass instance](https://wiki.openstreetmap.org/wiki/Overpass_API/Installation) and editing `URLS.overpassMirrors` in `app.js`.

### About the basemap

OpenTopoMap is a free, open-source raster basemap operated by volunteers. Please respect the [tile usage policy](https://opentopomap.org/about): light-to-moderate use is fine for an embedded module; heavier traffic should host its own tile server (Switch2OSM has a one-page guide).

### The `data/` folder

The three reference polygon layers (Ecoregions, Tribal Lands, Treaty Areas) load from bundled GeoJSON in `data/`. The shipped files are empty `FeatureCollection` placeholders, so the application is functional on first deploy without redistributing any agency or sovereign-jurisdiction data.

To enable a layer, replace the corresponding file with authoritative GeoJSON. Conversion commands (using `ogr2ogr` from GDAL) and download URLs are documented in [`data/README.md`](data/README.md).

> **Treaty boundaries.** Agency polygons are a representation of Treaty cession areas, not a definitive depiction of Tribal jurisdiction. Treaty rights and Tribal sovereignty are matters of sovereign authority. Verify with the relevant Tribal Nation before using these polygons for any decision-making.

---

## Telemetry stations

Each station renders as a colored marker anchored at exact coordinates. Clicking the marker (or the matching item in the sidebar) opens a popup. For USGS streamgages the popup fetches live instantaneous values (discharge code 00060, gage height code 00065) on every open. Stations whose agencies do not currently expose Cross-Origin Resource Sharing (CORS) friendly JSON (USACE Dataquery, NRCS AWDB, USBR AgriMet, NWRFC) surface an honest "open the source link" message rather than fake fetches that would fail in the browser.

| Region              | Stations                                                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Columbia and Snake  | Ice Harbor Dam (USACE), Bonneville Dam (BONO3), DART links                                                                              |
| Cascades            | Stevens Pass SNOTEL (791), Rainy Pass SNOTEL (711)                                                                                      |
| Central Oregon      | AgriMet Madras (MRSO), AgriMet Powell Butte (POBO), Wickiup Dam, Deschutes at Moody (USGS 14103000, MODO3)                              |
| Puget Sound         | Skagit near Concrete (CONW1, USGS 12194000), Puget Sound Vital Signs                                                                    |

To add a station, append an entry to `TELEMETRY_STATIONS` in `app.js` with `coords`, `agency`, `description`, optional `usgsSite` (for live data), and `links`.

> **Live SNOTEL Snow Water Equivalent (SWE) values.** The NRCS AWDB endpoint does not currently return CORS headers, so SNOTEL stations surface a station-link message rather than an in-popup reading. A Cloudflare Worker proxy is planned (see [`ROADMAP.md`](ROADMAP.md)) to enable in-popup SWE.

---

## Customization quick reference

| Want to change...           | Edit in `app.js`                       |
| --------------------------- | -------------------------------------- |
| Region bounds or names      | `REGIONS`                              |
| Ecoregion fill colors       | `ECOREGION_COLORS`                     |
| Drought outlook colors      | `DROUGHT_COLORS`                       |
| Treaty stroke colors        | `TREATY_COLORS`                        |
| Telemetry stations          | `TELEMETRY_STATIONS`                   |
| Endpoint URLs               | `URLS`                                 |
| Layer order, default-on     | `LAYER_DEFS` (`paneZ`, `defaultOn`)    |
| Brand text and colors       | `index.html` header, `style.css` `:root` |

---

## Architecture notes

- **No package manager.** Leaflet 1.9.4, League Spartan, and Lexend load from public Content Delivery Networks (unpkg, Google Fonts).
- **Lazy panes.** Each layer is registered to a uniquely-named Leaflet pane with a `z-index` chosen so polygons, raster tiles, vectors, and markers stack predictably.
- **URL-as-state.** Region selection and layer toggles call `syncUrl()`, which uses `history.replaceState`. The Share view button copies `window.location.href`. The `embed` flag is preserved across syncs so the share-from-embed flow stays consistent.
- **Hydrography is live OpenStreetMap.** See "About hydrography" above.
- **Reference polygons load locally.** `loadEcoregions`, `loadTribalLands`, and `loadTreatyAreas` use a shared `fetchLocalGeoJSON()` helper. An empty `FeatureCollection` is treated as `no data` rather than as an error.
- **Drought outlook is OGC WMS.** Leaflet's `tileLayer.wms` consumes the NOAA CPC service directly. No proprietary client.
- **Mobile.** The sidebar stacks above the map below 720 pixels viewport. The collapse button hides the sidebar entirely; an expand button slides in.

---

## Browser support

Tested mental model: any evergreen browser (Chrome, Edge, Firefox, Safari version 14 or newer). Uses `URLSearchParams`, `fetch`, async/await, and the Clipboard API (with a fallback to legacy `execCommand` on insecure contexts).

---

## Attribution and licensing

This project is licensed under the Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0) license.

- **Free to use and edit:** you are free to copy, redistribute, remix, and build upon this module.
- **Attribution:** you must give appropriate credit to ATNI Climate, provide a link to the license, and indicate if changes were made.
- **Non-commercial:** you may not use the material for commercial purposes.
- **ShareAlike:** if you remix, transform, or build upon the material, you must distribute your contributions under this exact same license.

Data layers provided by sovereign Tribal Nations, state agencies, and federal entities retain their respective public-domain or specific-use licenses. Ensure you have authorization to redistribute any bundled reference polygons.

---

## Roadmap

For the planned migration to TypeScript, Vite, MapLibre GL JavaScript, PMTiles, and Cloudflare Workers, plus three additional layers (NOAA United States Drought Monitor, National Interagency Fire Center active wildfire perimeters, USFS Wildfire Hazard Potential), see [`ROADMAP.md`](ROADMAP.md). The migration is a separate effort and does not affect the current shipping baseline.
