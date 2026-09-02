# Dynamic Drought Module (DDM)

`atniclimate/dynamic-drought-module` (the running version is stamped in
the application footer)

An embeddable, serverless web map for seeing drought across North America
and understanding conditions for supported places: current drought status,
wildfire and extreme heat risk, water and snowpack telemetry, and public
resources that address the impacts. The monthly continental overview covers
the United States, Canada, and Mexico; detailed place analysis remains
strongest in the United States and deepest in the Pacific Northwest (PNW).
Built by ATNI Climate (Affiliated Tribes of Northwest Indians).

**For a deployer, the module is a static folder.** Build it once, serve it
from any web host, embed it in any page with an `<iframe>`. There is no
backend, no account, no tracking, no analytics, and no proprietary tile
provider. Every view is a shareable URL.

**Stewardship comes first.** The module is built so each deployer (a
Tribal Nation, a state agency, a partner) controls its own copy on its own
infrastructure. Sovereign-jurisdiction data is never redistributed by this
repository. The live Tribal-geography layers (Tribal Lands and Reservation
Boundaries) are fetched LIVE from the publishing
federal services at view time, held only in the browser session, and never
bundled; requests run with `cache: 'no-store'` so nothing persists beyond
the session. Separately, two deployer-owned slots (`tribal`, `treaty`)
ship as empty placeholders a deployer may populate with its own authorized
data; they appear in the interface only when turned on by URL (see the
layer table below).

> **Treaty boundaries.** Agency polygons are a representation of Treaty
> cession areas, not a definitive depiction of Tribal jurisdiction. Treaty
> rights and Tribal sovereignty are matters of sovereign authority. Verify
> with the relevant Tribal Nation before using these polygons for any
> decision-making.

License: PolyForm Strict License 1.0.0. ATNI Climate, The Affiliated
Tribes of Northwest Indians, holds the rights. Noncommercial use is
permitted; selling or modifying the software requires explicit written
permission from ATNI Climate with provenance tracking. See `LICENSE`,
including the additional ATNI permission that covers noncommercial
self-hosting and data population.

## Current development baseline

The source package is `0.6.26`. It includes the interface, Fire 3D,
Wildfire Hazard Potential, structures, power, and smoke-volume refinements
described below. A merged commit is not by itself proof that the public site is
running it; every deploy is followed by an automated live check of the build
marker. Release history and its verification receipts are in
[`docs/RELEASE_NOTES.md`](docs/RELEASE_NOTES.md). The next phased work is
summarized in [`ROADMAP.md`](ROADMAP.md).

---

## What the module shows

- **Condition surfaces** (one at a time, so they never fight visually):
  the US Drought Monitor (USDM), the gridded Standardized Precipitation
  Index (SPI) with a 30-to-365-day window selector, the NOAA Climate
  Prediction Center (CPC) Seasonal Drought Outlook, NWS HeatRisk, the
  Storm Prediction Center fire-weather outlook, and USDA Forest Service
  Wildfire Hazard Potential.
- **Place** (the reference boundaries that say where you are and whose
  land you are looking at): state boundaries, EPA Omernik Level III and
  Level IV ecoregions, rivers, and the Tribal Nations umbrella: Tribal
  Lands (live from the US Census AIANNH service, covering legal AND
  statistical geographies including Oklahoma Tribal Statistical Areas),
  Reservation Boundaries (live from the Bureau of Indian Affairs (BIA)
  AIAN-LAR service, authoritative for BIA mission use only; feature
  definitions last published 2019 with continuing service updates, and
  never legal, survey, or jurisdictional truth). Where two agencies depict the
  same land the overlap is drawn legibly as two labeled representations,
  never blended. Deployers can additionally load their own Tribal Lands
  and Treaty Areas data into two default-off slots (URL-addressed; not
  shown in the default interface).
- **Events**: current mapped fire perimeters from the National Interagency
  Fire Center, with Wildfire and Wildfire Complex, Prescribed fire, and
  other or unclassified perimeters kept distinct; NOAA Hazard Mapping System
  smoke plumes; plus active National Weather Service (NWS) heat and
  fire-weather alerts.
- **Stations**: live water and snowpack telemetry with values in the
  sidebar and popups: USGS streamgages, NRCS SNOTEL snowpack, USBR
  Hydromet reservoir storage and AgriMet agricultural observations, and
  USACE reservoir forebay elevations.
- **The impact briefing**: click any boundary (a state, an ecoregion, a
  Tribal or reservation boundary) and the module composes a briefing for
  that place: land identity, current / near-term / long-range drought
  impact with wildfire and extreme heat foregrounded, the seasonal
  water-supply outlook, the El Nino / Southern Oscillation (ENSO) tilt,
  and public resources routed in stewardship order (the Tribe's own
  resources first, then federal, then state).
- **View presets**: five question-first chips ("Right now", "This week",
  "Season ahead", "Fire risk", "Whose land") that set the layer stack for
  the question being asked, without locking it.

Every layer reports an honest status in the sidebar (`loading`, `live`,
`live (partial)`, `unavailable`, `no data`, `zoom in to load`); a failed
or truncated upstream shows an honest pill, never a silent blank and
never an unqualified `live`.

---

## Quick start

Use Node.js 24 from the Active LTS line. The repository `.nvmrc` pins the
exact runtime (24.20.0) that every validation workflow uses; match it locally
with `nvm use` or `fnm use`.

```powershell
npm ci
npm run dev
# open http://localhost:5173/
```

Production build:

```powershell
npm run build
# emits dist/
npm run preview
# preview the production build at http://localhost:4173/
```

The ATNI deployment lives at
`https://atniclimate.github.io/dynamic-drought-module/` and is rebuilt on
every push to `main` via `.github/workflows/deploy.yml`. Deployers
self-hosting on their own infrastructure run `npm run build` and serve the
resulting `dist/` from any static web host.

---

## URL parameters (URL-as-state)

The application reads `window.location.search` on load, both for direct
visits and for embedded iframes. The **Share view** button copies the
current URL.

| Param | Values | Default |
| ----- | ------ | ------- |
| `region` | `washington_state`, `columbia_snake_basin`, `cascades`, `central_oregon`, `southwest_washington`, `south_puget_sound`, `national`, `alaska`, `hawaii`, `british_columbia` | `washington_state` |
| `layers` | comma-separated keys from the table below | `hillshade,nadm-drought,aiannh,bia-reservations,states` |
| `framing` | one of the nine ATNI-authored editorial framing keys, or `all` | none; `region` remains in control |
| `cluster` | `wildfire`, `heat`, or `enso`; an explicit `layers` list outranks it | Drought, encoded by absence |
| `ocean` | `pacific`, `arctic`, or `atlantic`, only with `cluster=enso` | none |
| `select` | `state:<postal code>` (for example `state:WA`): opens the map focused on that boundary with its impact briefing open; applied once, then dropped from the URL | none |
| `embed` | `true` or `1` (hides the sidebar for clean iframe presentation) | `false` |
| `view` | `brief` or `console` | derived from the rest of the URL; a bare URL opens Brief |
| `horizon` | `weeks-ahead` or `season-ahead` | current |
| `basemap` | `default` explicitly turns recent satellite imagery off; the legacy `satellite` token remains valid | recent satellite imagery, encoded by absence |
| `studio` | `layers` or `place` | none |
| `fire3d` | exact token `true`; entry requires a desktop viewport and the committed Wildfire cluster, while an active scene may remain through a custom layer stack as long as a Fire event layer remains | `false`, encoded by absence |
| `spi` | Gridded Drought Index accumulation window in days: `30`, `60`, `180`, or `365`; applies when the `gridded-index` layer is on | `90` day window, encoded by absence |

Temporal display parameters also round-trip (`week` for the USDM archive,
`dmode`, `sst`, `outlook`, and `heatday`). The authoritative grammar is
implemented in `src/state/url.ts` and pinned by the URL-state and legacy-link
browser tests. Old shared links keep working:
`tribal` is still a valid key (now the deployer-data slot, off by default and
not shown in the default interface; naming it in `layers` turns it on and
reveals its toggle), and legacy layer lists resolve deterministically.

Because condition surfaces render one at a time, a `layers` list naming
several surfaces resolves deterministically to the first surface named
(older shared links keep working).

### Embedding

```html
<iframe
  src="https://atniclimate.github.io/dynamic-drought-module/?select=state:WA&embed=true"
  width="100%" height="600"
  style="border:1px solid #243049; border-radius:6px;"
  loading="lazy"
  title="Drought, wildfire, and heat conditions">
</iframe>
```

---

## Layers and data sources

| Key | Layer | Role | Source |
| --- | ----- | ---- | ------ |
| `usdm` | US Drought Monitor | surface | NDMC FeatureServer (live) |
| `gridded-index` | Gridded Drought Index (SPI) | surface | NOAA NIDIS raster tiles (live) |
| `drought` | Seasonal Drought Outlook | surface | NOAA CPC vector MapServer (live) |
| `heatrisk` | HeatRisk (seven published days) | surface | NOAA NWS/WPC ImageServer (live) |
| `spc-fire-weather` | Fire Weather Outlook (Day 1) | surface | NOAA SPC MapServer (live) |
| `usfs-whp` | Wildfire Hazard Potential | surface | USFS GeoPlatform ImageServer (live) |
| `cdm-drought` | Canadian Drought Monitor (snapshot) | surface | Agriculture and Agri-Food Canada, bundled monthly snapshot |
| `nadm-drought` | North American Drought Monitor | surface | NOAA NCEI GeoJSON (live) |
| `sst-anomaly` | Ocean Temperature Anomaly | surface | NASA GIBS WMTS (live) |
| `states` | State Boundaries | reference | US Census, bundled GeoJSON (default-on) |
| `hillshade` | Terrain shading | reference | USGS 3DEP, bundled PMTiles (default-on) |
| `ecoregions` | Ecoregions (Level III/IV) | reference | EPA Omernik, bundled PMTiles |
| `places` | Municipal place labels | reference | Natural Earth, bundled (display-only) |
| `aiannh` | Tribal Lands | reference | US Census AIANNH MapServer (live, default-on) |
| `bia-reservations` | Reservation Boundaries | reference | BIA AIAN-LAR FeatureServer (live, default-on) |
| `tribal` | Tribal Lands (your own data) | reference | deployer slot, bundled EMPTY PLACEHOLDER, default-off, URL-only (no catalog row until turned on) |
| `treaty` | Treaty Areas (your own data) | reference | deployer slot, bundled EMPTY PLACEHOLDER, default-off, URL-only (no catalog row until turned on) |
| `hydrography` | Rivers | reference | OpenStreetMap via Overpass (live) |
| `nifc-fires` | Current Mapped Fire Perimeters (NIFC) | event | NIFC WFIGS FeatureServer (live) |
| `hms-smoke` | Smoke plumes | event | NOAA HMS FeatureServer (live) |
| `nws-alerts` | Heat & Fire Weather Alerts | event | NOAA NWS MapServer (live) |
| `telemetry` | Telemetry Stations | stations | USGS, NRCS, USBR, USACE (live) |
| `power-infrastructure` | Power Lines & Plants | reference | archived HIFLD transmission lines and live EIA plants, default-off |

(The British Columbia drought-levels surface swaps in for the US Drought
Monitor inside the `british_columbia` framing; it has no separate layer
key. Table aligned with the runtime registry on 2026-08-20.)

The framing minimap derives its colors from the current monthly
[North American Drought Monitor](https://www.drought.gov/data-maps-tools/north-american-drought-monitor-nadm).
Each authored framing uses an approximate cosine-latitude-weighted ordinal
mean of assessed land, from white `None` through dark-red `D4`, for its fill.
A separate outline carries the total D1-D4 share so the mean cannot hide
material drought extent. The most prevalent class and distribution remain
available as supporting detail, but they do not determine the fill. NADM does
not publish its exact analyzed-area mask. The minimap therefore excludes
Nunavut using a Statistics Canada 2021 Digital Boundary File as an
analysis-mask proxy and reports the northern framing as `live (partial)`. The
proxy is used only for calculation, never rendered as boundary or
jurisdictional geometry.

Nunavut proxy source: Government of Canada; Statistics Canada; Statistical
Geomatics Centre, 2021 Digital Boundary Files, reference date January 1,
2021. Contains information licensed under the
[Open Government Licence - Canada](https://open.canada.ca/en/open-government-licence-canada).
Adapted for DDM; no endorsement is implied.

Every live endpoint in `src/config/urls.ts` carries a verification
metadata block (HTTP status, content type, CORS posture, response-shape
caveats, verification date). Read it before touching a fetcher.

### Live Tribal geography and the deployer slots

The two live Tribal-geography layers (`aiannh`, `bia-reservations`) fetch
the publishing federal services live at view
time and redistribute nothing: responses are held in session memory
only, requested with `cache: 'no-store'`, and are never bundled, baked,
or written to disk by this module. Each popup names its publishing
agency, its vintage, and the representation caveat. Both layers are on
by default.

The `tribal` and `treaty` keys are the DEPLOYER slots: bundled empty
`FeatureCollection` placeholders (in `public/data/`), off by default,
that a deployer may populate with its own authorized data (a Tribal
Nation's own boundary data, under its own governance). They are not part
of the default interface: no catalog row or search result names them
until a `?layers=tribal` / `?layers=treaty` URL (or a deployer's own
configuration) turns them on. Their popups label the data as
deployer-provided. If you populate a slot with data that
duplicates one of the live federal layers, consider toggling that live
layer off in your embed links to avoid a confusing double-draw; the two
are deliberately separate so your data never silently replaces or blends
with a federal representation. Conversion commands and population
instructions are in [`public/data/README.md`](public/data/README.md).

### About the basemap and hydrography

The product-default basemap uses
[NOAA NESDIS merged GOES East and West GeoColor](https://www.nesdis.noaa.gov/imagery/satellite-maps)
from its rolling 24-hour archive. The Satellite control turns that recent
context on and off without creating a second state system. An absent
`basemap` parameter means satellite is on; `basemap=default` records the
explicit satellite-off choice and shows subdued OpenStreetMap ground.

The recent-imagery lifecycle queries a bounded set of catalog items and
selects the newest frame that passes a known-data image probe, then pins all
tiles to that one observed frame. The map displays the exact UTC observation
range and checks for a new frame every 10 minutes while active. A failed
refresh leaves the last known-good recent frame in place. If initial
activation fails, the basemap store and URL return honestly to `default`.
OpenStreetMap remains underneath because GOES coverage ends near 76 degrees
north and imagery can contain clouds or gaps. GeoColor is context only:
daytime areas approximate true color, while nighttime areas use infrared and
static reference lights.

Explicit Fire and Wildfire controls may request recent GeoColor as part of
their governed scene, but boot reconciliation and unrelated layer or horizon
changes do not override a visitor's manual basemap choice. Future
satellite-derived drought indicators, wildfire thermal detections, or land
surface temperature products belong in separately named layers with their
own status, timestamp, caveat, and legend. No proprietary tile providers,
authentication, or application backend are added. Hydrography queries the
volunteer-run Overpass API (three-mirror failover, viewport-driven, dormant
below zoom 7); institutional deployments expecting heavy concurrency should
plan for the planned National Hydrography Dataset PMTiles bundle.

### The desktop 3D Fire view

On desktop widths, the Fire view offers a 3D toggle: terrain relief from
the bundled Pacific Northwest USGS 3DEP archive under a pitched camera,
with the NOAA HMS smoke plumes re-presented as a stylized volume (vertical
extent encodes the issuer's density class, never measured plume height)
and issuer-published landscape context draped over the relief. The first
context layer is USFS Wildfire Hazard Potential 2023, baked to a bundled
archive with the issuer's categorical colors and nearest-neighbor sampling so
class boundaries never acquire invented colors. It is a long-term hazard
context, not an incident forecast.

Power infrastructure is a separate, default-off catalog layer that can be used
in flat or 3D views. It is not activated automatically by Fire 3D. Its
transmission lines come from the ARCHIVED federal HIFLD dataset (baked once,
last data update 2024-09-30, with that currency caveat always in the legend),
and its live power plants come from the U.S. Energy Information
Administration, labeled with the issuer's own reporting period. Substations
and distribution lines are absent: substation locations are withheld by the
publishing agencies for security reasons, and no authoritative public national
distribution-circuit dataset exists.

Building structures come from the Overture Maps Foundation buildings
theme (ODbL), extruded over the terrain from zoom 13: footprints with an
issuer-published height rise to it, and the rest draw in a visibly
dimmer tone at a disclosed placeholder height. The committed bake covers
the central Oregon region framing only; a full Pacific Northwest bake
was projected from the measured per-building tile rate at roughly
240 MB for z14-only tiles (about 380 MB at the shipped z13-14 scheme,
9.16 million footprints either way) and cannot ride the same-origin
hosting path, so the extract script's `--bbox` parameter is the
documented route for a deployer to bake their own region (see
`public/data/README.md`).

The view is a 3D context view, deliberately not a "digital twin": that
phrase is a term of art for systems that bundle physics-based fire
simulation with rendering, and this module runs no simulation of any
kind. The control carries two always-visible notes: the terrain coverage
statement, and a non-prediction disclosure stating that nothing in the
view shows or implies fire spread, ignition, or an all-clear. Wildland
fire science context for reading the terrain (for example, that fires
tend to spread faster uphill because rising heat preheats upslope fuels)
is published in NWCG's *Introduction to Wildland Fire Behavior* (S-190);
the module states no such inference about any specific incident.

### The Cloudflare Worker proxy (optional)

Most sources serve the browser directly. The allow-list in
`workers/proxy/src/index.ts` (mirrored in the `wrangler.toml` header) is
the authoritative set of proxied upstream routes. It permits only the exact
AWDB, AgriMet, Hydromet, NWRFC, USFS Wildfire Hazard Potential, US Drought
Monitor DSCI, and `api.weather.gov` reads used by the application.
The Worker in `workers/proxy/` is a CORS shim
with a strict allow-list; it returns upstream body bytes unchanged and injects
the browser-facing CORS headers.
Deploy it with `wrangler` and set `URLS.workerProxy` to enable those
sources; without it, the module still runs and reports those values
honestly as unavailable.

---

## Architecture invariants

- **No backend.** The static `dist/` folder is the entire production
  deployment; the optional Worker is a CORS shim, not application logic.
- **URL-as-state.** Region, active layers, selection, and the embed flag
  round-trip through the URL; every view is shareable and embeddable.
- **One surface at a time.** Condition surfaces are mutually exclusive by
  construction; place, events, and stations stack over the active surface.
- **Lazy loading with honest status.** Layers load on first toggle-on and
  report six canonical states; a data failure keeps the layer checked
  with an honest `unavailable` pill (a shared link never silently loses a
  layer because an upstream blipped), and a truncated response reads
  `live (partial)`, never an unqualified `live`.
- **Cancellable network operations.** Master abort signal plus per-call
  timeout on every non-trivial fetch; late responses to superseded
  operations are dropped, not rendered.
- **Live-fetch stewardship.** Sovereign-jurisdiction geography is never
  redistributed: the federal representations are fetched live per session
  (no-store), and the deployer-owned slots ship empty for population
  under the deployer's own authorizations.
- **Mobile and accessibility.** Outside embed mode, the map-first phone view
  at 720 pixels and narrower uses footer navigation and a three-detent bottom
  sheet. Shared map controls retain 44-pixel or larger targets, accessible
  names, keyboard focus, safe-area seating, and reduced-motion behavior.
  Region selection is arrow-key navigable; status changes are announced
  through a polite live region; embed semantics remain owned by the separate
  embed shell.

---

## Customization quick reference

| Want to change... | Edit in |
| ----------------- | ------- |
| Region bounds or names | `src/config/regions.ts` (`REGIONS`) |
| Layer registry and default-on set | `src/config/layers.ts` (`LAYER_DEFS`) |
| View presets | `src/config/presets.ts` (`VIEW_PRESETS`) |
| Colors and palettes | `src/config/palette.ts` |
| Telemetry stations | `src/config/telemetry.ts` |
| Endpoint URLs and the Worker base | `src/config/urls.ts` |
| Brand text and styles | `index.html` header, `src/styles/app.css` |

---

## Development

This repository carries the deployable application, bundled assets,
browser test suite, product data builders, validation gates, and optional
Cloudflare Worker. Run `npm run gate` for the static build and product
checks, and `npm run test:serial` for the full browser suite. Public release
history is in [`docs/RELEASE_NOTES.md`](docs/RELEASE_NOTES.md), and the
generated coverage record is in
[`docs/COVERAGE_MATRIX.md`](docs/COVERAGE_MATRIX.md). Design-document
authority and the durable convergence doctrine are in
[`docs/design/README.md`](docs/design/README.md). The public development
sequence is in [`ROADMAP.md`](ROADMAP.md), its canonical task definitions are
in [`docs/ROADMAP.yaml`](docs/ROADMAP.yaml), and setup, architecture, layer,
testing, and release guidance is in [`DEVELOPER.md`](DEVELOPER.md).

### Dependency overrides

`package.json` pins two `overrides` so the full `npm audit` (dev
dependencies included) reports zero vulnerabilities. Both target the
dev-only `mapshaper` chain, which is used exclusively by four offline
maintainer-run artifact builders (`scripts/build-states.mjs`,
`scripts/build-minimap-geometry.mjs`, `scripts/build-cdm-snapshot.mjs`,
`scripts/build-ecoregion-tiles.mjs`) and never ships in the bundle.

- `adm-zip: ^0.6.0` lifts mapshaper's zip helper past
  GHSA-xcpc-8h2w-3j85. mapshaper calls it as a plain function
  constructor for `.zip` read and write, and 0.6.0 keeps that export
  shape; both directions are exercised by regenerating the committed
  minimap artifact after any mapshaper upgrade.
- `@ngageoint/geopackage: npm:noop2@^2.0.0` replaces the GeoPackage
  subtree with an empty module. That subtree pins `image-size` 0.8.x
  (GHSA-w3rx-r6r6-pgpr, GHSA-5p2g-fcmc-qvqq, no fixed release exists)
  and a vulnerable `file-type`, so the only honest fix is removing it.
  mapshaper requires the library lazily and only for `.gpkg` input or
  output (guarded require sites in `mapshaper.js`: `importGeoPackage`
  and `exportGeoPackage`), and every pipeline here feeds mapshaper
  GeoJSON buffers or fflate-unzipped shapefile members, never `.gpkg`.
  A `.gpkg` request now stops with mapshaper's own "GeoPackage library
  is not loaded" message. Drop this override if a pipeline ever needs
  GeoPackage I/O and the upstream chain has a patched `image-size`.

## Browser support

Any evergreen browser (Chrome, Edge, Firefox, Safari 15.5 or newer).
MapLibre GL JavaScript uses WebGL 2 when the browser offers it and falls back to WebGL 1.

## Attribution and licensing

Copyright (c) 2026 ATNI Climate, The Affiliated Tribes of Northwest
Indians (ATNI). This project is licensed under the PolyForm Strict
License 1.0.0 (see `LICENSE`): noncommercial entities may use the
software; selling it, modifying it, or building new works on it requires
explicit written permission from ATNI Climate, granted with
provenance-tracking conditions (attribution preserved, changes documented
and disclosed to ATNI). The `LICENSE` file carries an additional ATNI
permission allowing noncommercial deployers to host unmodified copies and
populate the data placeholders and configuration tables for their own
deployment; that permission is what makes the self-hosting pattern in
this README work.

Data layers provided by sovereign Tribal Nations, state agencies, and
federal entities retain their respective public-domain or specific-use
licenses. Ensure you have authorization to redistribute any bundled
reference polygons.
