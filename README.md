# Dynamic Drought Module (DDM)

`atniclimate/dynamic-drought-module` (the running version is stamped in
the application footer)

The Planet is changing rapidly, and stable systems cannot be assumed to maintain their usual patterns. What were once rare occurrences are now becoming more and more regular. We feel these impacts, both directly and indirectly, through the communities we care for and the information we curate. Drought, wildfire, extreme heat, marine heatwaves, hurricanes; are all interrelated. The El Niño and La Niña events, atmospheric waves and heat domes, these are all drivers of the weather and climate conditions and extremes. The changes we experience are irrefutable; through drought, extreme heat, wildfire, and even hurricanes, we must adapt. The impacts of these extremes are physical, they affect real communities, and can cause great pain and suffering. Therefore, we must respond in a way that is strategic, tactical, and with great care and consideration of others.

This tool began as a way to connect the disparate data and information sources from the North American Drought Monitor overlain with Tribal Lands; soon, through the data sources from NOAA and the National Weather Service, localized Impact Briefings could be generated, with Tribal, State, and Regional areas able to have curated reports. But soon, it evolved to include Wildfire, and to find sources where fuel-loads were high, or where extreme heat and red flag warnings would make traceable areas vulnerable. But the discovery of APIs that access large datasets from NOAA, NASA, USGS, and state and federal agencies, and with the right formula and engineering, could be integrated to show the interrelations of these measures, and to help connect it within one place that is easily accessible and open to the public.

This module is built in service to others. Every dataset within it describes conditions of the rivers, mountains, forests, and coastlines, and the atmosphere… Relatives. We, the People, live with and depend upon these interrelated systems; and we have a responsibility to respect and honor this reality. Countless scientists, professionals, communities, and tax-payer funded infrastructure, have contributed to the ability to access a broad range of geospatial data, and the computational resources we have access are more powerful than we may realize. With Honor, Pride, and Respect, this climate intelligence system, with responsible utilization of these technologies and information systems, and commitment to data sovereignty and provenance, transforms our ability to respond to life-threatening impacts in the defense and protection of the lands and waters we call Home.

Ultimately, this module, this tool, this system… still not sure what to call, is meant for all Peoples. Its principal focus remains to serve Tribal Nations; whose connections with the landscapes and seascapes have existed since time immemorial. Together, we must understand one another. We must understand the world around us. Critical climate intelligence, and finding ways to respond rapidly, can be a way to transform this understanding into coordinated action. It is with the hope, that good information leads to good decision-making, and through collaboration of knowledges and institutions, it allows us to care better for one another; to be good Relatives and to be good Ancestors.

It is with this sense of humility, of Honor and Respect for sovereignty and preserving life and ways of life, that this tool exists. It is meant to be used, to be built upon, and to be shared. It is never meant to be hoarded, never meant to be sold, and never meant to be used in a way that could harm. This platform strives to Honor sovereignty in many forms: data, Indigenous data, network, digital, and computational sovereignty. It is intended to be able to stand alone, the publicly accessible data as its baseline, but federated in such a way that it is not centralized. It does not rely on ATNI Climate or GitHub, however this is the place that it emerges from. Building a Fire; little to big.

While there exists explicit licensure to protect this system from exploitation, it is asked that whomever utilizes it does so with care and with responsibility.

In Service and Friendship, Mvto,
Patrick A Freeland | Affiliated Tribes of Northwest Indians

An embeddable, serverless web map of drought, wildfire, and extreme heat
across North America, wherever the issuing agencies publish data: current
drought status, wildfire and heat risk, water and snowpack telemetry, and
the public resources that address the impacts. Coverage is rich for the
United States, the source of most layers, and limited for Canada and
Mexico: the tri-national North American Drought Monitor covers all three
countries, and Canada adds its Canadian Drought Monitor and British
Columbia's basin drought levels. Built by ATNI Climate (Affiliated Tribes
of Northwest Indians).

**For a deployer, the module is a static folder.** Build it once, serve it
from any web host, embed it in any page with an `<iframe>`. No backend, no
account, no tracking, no analytics, no proprietary tile provider; every
view is a shareable URL.

**Stewardship comes first.** Each deployer (Tribal Nation, state agency,
partner) controls its own copy on its own infrastructure.
Sovereign-jurisdiction data is never redistributed by this repository; the
live Tribal-geography layers are fetched from their publishing federal
services at view time, a governance decision detailed under Live Tribal
geography below. Two deployer-owned slots (`tribal`, `treaty`) ship as
empty placeholders a deployer may populate with its own authorized data;
they appear only when turned on by URL.

> **Treaty boundaries.** Agency polygons are a representation of Treaty
> cession areas, not a definitive depiction of Tribal jurisdiction. Treaty
> rights and Tribal sovereignty are matters of sovereign authority. Verify
> with the relevant Tribal Nation before using these polygons for any
> decision-making.

License: the DDM Community License 1.0 (`LICENSE`). Anyone may use, host,
modify, and share the module for noncommercial purposes under the same
terms (share-alike); no commercial use is permitted. `CITATION.cff` gives
the citation; `llms.txt` states the same conditions for automated readers.
Full obligations are in Attribution and licensing below.

## Current development baseline

The source package is `0.6.26`. A merged commit is not by itself proof
that the public site is running it; every deploy is followed by an
automated live check of the build marker. Release history and verification
receipts are in [`docs/RELEASE_NOTES.md`](docs/RELEASE_NOTES.md).
Development planning is maintained privately by ATNI Climate; this
repository carries the application, its tests and scripts, and the user
and maintainer documentation.

---

## What the module shows

The module shows five kinds of information, plus the presets that arrange
them. Each kind answers a different question about conditions and place.

- **Condition surfaces** answer the severity question for the visible
  area, shown one at a time so they never fight visually: the US Drought
  Monitor (USDM), the gridded Standardized Precipitation Index (SPI)
  with a 30-to-365-day window selector, the NOAA Climate Prediction
  Center (CPC) Seasonal Drought Outlook, NWS HeatRisk, the Storm
  Prediction Center fire-weather outlook, and USDA Forest Service
  Wildfire Hazard Potential.
- **Place** tells you where you are and whose land you are looking at:
  state boundaries, EPA Omernik Level III and Level IV ecoregions,
  rivers, and the Tribal Nations umbrella: Tribal Lands (live from the
  US Census AIANNH service, covering legal AND statistical geographies
  including Oklahoma Tribal Statistical Areas), Reservation Boundaries
  (live from the Bureau of Indian Affairs (BIA) AIAN-LAR service,
  authoritative for BIA mission use only; feature definitions last
  published 2019 with continuing service updates, and never legal,
  survey, or jurisdictional truth). Where two agencies depict the same
  land the overlap is drawn legibly as two labeled representations,
  never blended.
- **Events** show what is actively happening: current mapped fire
  perimeters from the National Interagency Fire Center (Wildfire and
  Wildfire Complex, Prescribed fire, and other or unclassified perimeters
  kept distinct), NOAA Hazard Mapping System smoke plumes, and active
  National Weather Service (NWS) heat and fire-weather alerts.
- **Stations** report what the instruments on the ground are reading,
  with live values in the sidebar and popups: USGS streamgages, NRCS
  SNOTEL snowpack, USBR Hydromet reservoir storage and AgriMet
  agricultural observations, and USACE reservoir forebay elevations.
- **The impact briefing** answers what the data means for one place.
  Click any boundary (state, ecoregion, Tribal, or reservation) and the
  module composes it from land identity, current / near-term / long-range
  drought impact with wildfire and extreme heat foregrounded, the
  seasonal water-supply outlook, the El Nino / Southern Oscillation
  (ENSO) tilt, and public resources routed in stewardship order (Tribe
  first, then federal, then state).
- **View presets** organize the layer stack around a question instead of
  asking you to build one: five question-first chips ("Right now", "This
  week", "Season ahead", "Fire risk", "Whose land") set the stack for
  the question being asked, without locking it.

Every layer reports an honest status (`loading`, `live`,
`live (partial)`, `unavailable`, `no data`, `zoom in to load`); a failure
or truncation shows an honest pill, never a silent blank or an
unqualified `live`.

---

## Quick start

Use Node.js 24 from the Active LTS line. The repository `.nvmrc` pins the
exact runtime (24.20.0) that every validation workflow uses; match it
locally with `nvm use` or `fnm use`.

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
self-hosting run `npm run build` and serve `dist/` from any static web
host.

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
in `src/state/url.ts`, pinned by the URL-state and legacy-link browser
tests. Old shared links keep working: `tribal` is still a valid key (now
the deployer-data slot, off by default; naming it in `layers` turns it
on), and legacy layer lists resolve deterministically.

Because condition surfaces render one at a time, a `layers` list naming
several surfaces resolves deterministically to the first surface named.

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
| `hms-smoke` | Smoke plumes | event | NOAA OSPO FeatureServer (live) |
| `nws-alerts` | Heat & Fire Weather Alerts | event | NOAA NWS MapServer (live) |
| `telemetry` | Telemetry Stations | stations | USGS, NRCS, USBR, USACE, NIFC, NOAA CO-OPS, Iowa State IEM (live) |
| `power-infrastructure` | Power Lines & Plants | reference | archived HIFLD transmission lines and live EIA plants, default-off |

(The British Columbia drought-levels surface swaps in for the US Drought
Monitor inside the `british_columbia` framing; it has no separate layer
key. Table aligned with the runtime registry on 2026-08-20.)

The framing minimap derives its colors from the current monthly
[North American Drought Monitor](https://www.drought.gov/data-maps-tools/north-american-drought-monitor-nadm).
Each authored framing computes an approximate cosine-latitude-weighted
ordinal mean of assessed land, from white `None` through dark-red `D4`,
for its fill; a separate outline carries the total D1-D4 share so the
mean cannot hide material drought extent. NADM does not publish its exact
analyzed-area mask, so the minimap excludes Nunavut using a Statistics
Canada 2021 Digital Boundary File as an analysis-mask proxy and reports
the northern framing as `live (partial)`. The proxy is used only for
calculation, never rendered as boundary or jurisdictional geometry.

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
their publishing federal services at view time and redistribute nothing:
responses are held in session memory only, requested with
`cache: 'no-store'`, and never bundled, baked, or written to disk. Each
popup names its publishing agency, vintage, and representation caveat.
Both layers are on by default.

Sovereign boundary data is governed by the Nation it represents, not by
this repository.

The `tribal` and `treaty` keys are the DEPLOYER slots: bundled empty
`FeatureCollection` placeholders (in `public/data/`), off by default,
that a deployer may populate with its own authorized data under its own
governance. No catalog row or search result names them until a
`?layers=tribal` / `?layers=treaty` URL (or a deployer's own
configuration) turns them on; popups label the data as deployer-provided.
If a slot overlaps a live federal layer, toggle that live layer off in
your embed links so the viewer sees one boundary rather than a confusing
double-draw; the two are deliberately separate so deployer data never
silently replaces or blends with a federal representation. Conversion
commands and population instructions are in
[`public/data/README.md`](public/data/README.md).

### About the basemap and hydrography

The product-default basemap shows recent satellite imagery from
[NOAA NESDIS merged GOES East and West GeoColor](https://www.nesdis.noaa.gov/imagery/satellite-maps)
and its rolling 24-hour archive. The lifecycle selects the newest frame
passing a known-data image probe, pins all tiles to it, displays the exact
UTC observation range, and checks every 10 minutes. A failed refresh keeps
the last good frame; if initial activation fails, the URL reverts honestly
to `default`. The Satellite control turns imagery on and off;
`basemap=default` records the satellite-off choice, showing subdued
OpenStreetMap ground. OpenStreetMap also remains underneath because GOES
coverage ends near 76 degrees north and imagery can contain clouds or
gaps. GeoColor is context only: daytime areas approximate true color,
nighttime areas use infrared and static reference lights.

Explicit Fire and Wildfire controls may request recent GeoColor as part of
their governed scene, but unrelated layer or horizon changes do not
override a visitor's manual basemap choice. Future satellite-derived
products belong in separately named layers with their own status,
timestamp, caveat, and legend; recoloring an existing layer would let a
display claim what its source does not. Hydrography queries the
volunteer-run Overpass API (three-mirror failover, viewport-driven, dormant
below zoom 7); institutional deployments expecting heavy concurrency should
plan for the planned National Hydrography Dataset PMTiles bundle.

### The desktop 3D Fire view

The Fire view offers a 3D toggle on desktop widths: terrain relief from
the bundled Pacific Northwest USGS 3DEP archive under a pitched camera,
NOAA HMS smoke plumes re-presented as a stylized volume (vertical extent
encodes the issuer's density class, never measured plume height), and
issuer-published landscape context draped over the relief. When the NIFC
perimeter layer is live, each wildfire perimeter stands as a low ribbon
along its edge (constant on-screen height, not flame height or intensity;
centered on the published edge, neither enlarging nor shrinking the mapped
perimeter), pulsing in step with the flat outline. The first context layer
is USFS Wildfire Hazard Potential 2023, baked with the issuer's categorical
colors and nearest-neighbor sampling so class boundaries never acquire
invented colors. It is a long-term hazard context, not an incident
forecast.

Power infrastructure is a separate, default-off catalog layer usable in
flat or 3D views, not activated automatically by Fire 3D. Its transmission
lines come from the ARCHIVED federal HIFLD dataset (baked once, last data
update 2024-09-30, with that currency caveat always in the legend), and
its live power plants come from the U.S. Energy Information
Administration, labeled with the issuer's own reporting period. Substations
and distribution lines are absent: substation locations are withheld by
publishing agencies for security reasons, and no authoritative public
national distribution-circuit dataset exists.

Building structures come from the Overture Maps Foundation buildings theme
(ODbL), extruded over the terrain from zoom 13: footprints with an
issuer-published height rise to it; the rest draw in a visibly dimmer tone
at a disclosed placeholder height. The committed bake covers the central
Oregon region framing only; a full Pacific Northwest bake was projected
from the measured per-building tile rate at roughly 240 MB for z14-only
tiles (about 380 MB at the shipped z13-14 scheme, 9.16 million footprints
either way) and cannot ride the same-origin hosting path, so the extract
script's `--bbox` parameter is the documented route for a deployer to bake
their own region (see `public/data/README.md`).

The view is a 3D context view, deliberately not a "digital twin": that
phrase names systems bundling physics-based fire simulation with rendering,
and this module runs no simulation. The control carries two always-visible
notes: the terrain coverage statement, and a non-prediction disclosure
stating that nothing in the view shows or implies fire spread, ignition,
or an all-clear. Wildland fire science context for reading terrain is
published in NWCG's *Introduction to Wildland Fire Behavior* (S-190); the
module states no such inference about any specific incident.

### The Cloudflare Worker proxy (optional)

Most sources serve the browser directly. The Worker in `workers/proxy/` is
a CORS shim with a strict allow-list (the authoritative set is in
`workers/proxy/src/index.ts`, mirrored in the `wrangler.toml` header): it
permits only the exact AWDB, AgriMet, Hydromet, NWRFC, USFS Wildfire
Hazard Potential, US Drought Monitor DSCI, and `api.weather.gov` reads
used by the application, returning upstream bytes unchanged with
browser-facing CORS headers. Deploy with `wrangler` and set
`URLS.workerProxy` to enable those sources; without it, the module still
runs and reports those values honestly as unavailable.

---

## Architecture invariants

Architecture encodes values. These seven commitments govern how the code
behaves, so a person reading the interface can trust what it says and a
deployer keeps control of the deployment.

- **No backend.** The `dist/` folder is the entire deployment; the optional
  Worker is a CORS shim, not application logic.
- **URL-as-state.** Region, active layers, selection, and the embed flag
  round-trip through the URL.
- **One surface at a time.** Condition surfaces are mutually exclusive by
  construction; place, events, and stations stack over the active surface.
- **Lazy loading with honest status.** Layers load on first toggle-on; a
  data failure keeps the layer checked with an honest pill (a shared link
  never silently loses a layer), and a truncated response reads
  `live (partial)`, never an unqualified `live`.
- **Cancellable network operations.** Master abort signal plus per-call
  timeout on every non-trivial fetch; late responses to superseded
  operations are dropped, not rendered.
- **Live-fetch stewardship.** Sovereign-jurisdiction geometry is fetched
  live per session, never redistributed; deployer slots ship empty.
- **Mobile and accessibility.** Outside embed mode, the map-first phone
  view at 720 pixels and narrower uses footer navigation and a three-detent
  bottom sheet. Controls retain 44-pixel targets, accessible names,
  keyboard focus, safe-area seating, reduced-motion behavior, and arrow-key
  region navigation; status changes announce through a polite live region;
  embed semantics remain owned by the separate embed shell.

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
Cloudflare Worker. `npm run gate` runs the static build and product
checks; `npm run test:serial` runs the full browser suite. Public release
history is in [`docs/RELEASE_NOTES.md`](docs/RELEASE_NOTES.md) and the
generated coverage record in
[`docs/COVERAGE_MATRIX.md`](docs/COVERAGE_MATRIX.md). Design-document
authority and the durable convergence doctrine are in
[`docs/design/README.md`](docs/design/README.md). Setup, architecture,
layer, testing, and release guidance is in [`DEVELOPER.md`](DEVELOPER.md).

### Dependency overrides

`package.json` pins two `overrides` so the full `npm audit` (dev
dependencies included) reports zero vulnerabilities. Both target the
dev-only `mapshaper` chain, used exclusively by four offline maintainer-run
artifact builders (`scripts/build-states.mjs`,
`scripts/build-minimap-geometry.mjs`, `scripts/build-cdm-snapshot.mjs`,
`scripts/build-ecoregion-tiles.mjs`) and never ships in the bundle.

- `adm-zip: ^0.6.0` lifts mapshaper's zip helper past
  GHSA-xcpc-8h2w-3j85; 0.6.0 keeps the `.zip` read/write export shape.
  Both directions are exercised by regenerating the committed minimap
  artifact after any mapshaper upgrade.
- `@ngageoint/geopackage: npm:noop2@^2.0.0` replaces the GeoPackage
  subtree with an empty module. That subtree pins `image-size` 0.8.x
  (GHSA-w3rx-r6r6-pgpr, GHSA-5p2g-fcmc-qvqq, no fixed release exists)
  and a vulnerable `file-type`, so the only honest fix is removing it.
  mapshaper requires it lazily for `.gpkg` I/O only (guarded require
  sites in `mapshaper.js`: `importGeoPackage` and `exportGeoPackage`),
  and every pipeline here feeds mapshaper GeoJSON buffers or
  fflate-unzipped shapefile members, never `.gpkg`. A `.gpkg` request
  now stops with mapshaper's own "GeoPackage library is not loaded"
  message. Drop this override if a pipeline ever needs GeoPackage I/O
  and the upstream chain has a patched `image-size`.

## Browser support

This section is the canonical statement of the map renderer and browser
floor; `vite.config.ts` and `DEVELOPER.md` point here, and
`npm run check:renderer` fails when the build configuration and this
section disagree.

The map renderer is MapLibre GL JavaScript 6.6.0, pinned exactly in
`package.json` and matched by the lockfile and the installed tree.

Any evergreen desktop browser (Chrome, Edge, Firefox, Safari). The
supported floors are Safari 15.5 or newer on iPhone and iPad, and
Chrome 100 or newer on Android; the production build target is
`es2020, safari15.5, ios15.5, chrome100`, so those floors are a build
claim, not a moving default. MapLibre GL JavaScript 6 requires WebGL 2,
which both floors enable by default; a browser without it shows the
sidebar and an honest not-rendering notice instead of a map. Compiling to
a floor lowers syntax; it does not supply missing runtime APIs, so a
real-device check per release is the proof rather than the target line.

Node.js 24 is the toolchain that builds the application, not a browser
requirement.

## Acknowledgements

The module reads what the agencies, institutions, and contributors below
publish. They are named by issuing office, because each product carries
its own clock, method, and caveats.

**NOAA** (National Oceanic and Atmospheric Administration)

- **NIDIS** (National Integrated Drought Information System): gridded SPI
  drought-index tiles
- **NWS** (National Weather Service): active weather alerts, point
  forecasts, USDM weekly change, heat and fire-weather warnings
- **NWS / Weather Prediction Center**: HeatRisk index
- **NCEI** (National Centers for Environmental Information): North American
  Drought Monitor and continental base mask
- **CPC** (Climate Prediction Center): Seasonal Drought Outlook,
  temperature and precipitation outlooks (6-to-10-day, 8-to-14-day), ENSO
  index snapshots and diagnostic discussion
- **SPC** (Storm Prediction Center): Fire Weather Outlook
- **NESDIS** (National Environmental Satellite, Data, and Information
  Service): merged GOES GeoColor satellite imagery
- **OSPO** (Office of Satellite and Product Operations): HMS satellite
  smoke plumes
- **CO-OPS** (Center for Operational Oceanographic Products and Services):
  tide and current station metadata
- **NWRFC** (Northwest River Forecast Center): water-supply forecast
  reports

**National Drought Mitigation Center** (NOAA, USDA, and University of
Nebraska-Lincoln)

- **NDMC**: US Drought Monitor current conditions, weekly archive, and
  DSCI data services

**DOI** (Department of the Interior)

- **USGS**: 3DEP elevation tiles, instantaneous-values streamflow,
  Watershed Boundary Dataset
- **Bureau of Indian Affairs**: AIAN-LAR reservation boundaries and
  LARNAME crosswalk
- **USBR** (Bureau of Reclamation): Hydromet daily values and AgriMet
  site registry

**USDA** (Department of Agriculture)

- **Forest Service**: Wildfire Hazard Potential 2023 (ImageServer and
  baked PMTiles)
- **NRCS** (Natural Resources Conservation Service): SNOTEL and SCAN
  station data via AWDB
- **Farm Service Agency**: drought-relief and disaster-assistance resource
  links

**Census Bureau** (Geography Division)

- **TIGERweb**: AIANNH Tribal legal and statistical areas
- Cartographic boundary files (states)

**NIFC** (National Interagency Fire Center)

- **WFIGS**: current mapped fire perimeters
- **RAWS**: fire-weather station metadata and observations

**USACE** (Army Corps of Engineers)

- **CWMS**: reservoir and water-control data

**Government of Canada**

- **Agriculture and Agri-Food Canada**: Canadian Drought Monitor monthly
  snapshot
- **Statistics Canada**: 2021 Digital Boundary Files (provincial
  boundaries, Nunavut analysis mask)

**Province of British Columbia**

- **GeoBC / Water Management Branch**: drought levels by water basin

**EPA** (Environmental Protection Agency)

- **Office of Research and Development**: Omernik Level III and Level IV
  ecoregion boundaries

**NASA**

- **EOSDIS GIBS**: GHRSST sea-surface temperature anomaly tiles

**OpenStreetMap contributors**

- Standard raster basemap
- **Overpass API**: waterway and hydrography features

**Natural Earth**

- **Natural Earth Data project**: populated places and physical land/lake
  boundaries

**HIFLD** (Homeland Infrastructure Foundation-Level Data, archived)

- US electric power transmission lines (archived; last data update
  2024-09-30)

**EIA** (Energy Information Administration)

- Power plant locations and attributes (Forms 860 / 860M)

**Overture Maps Foundation**

- Building footprints (central Oregon extract, ODbL)

**Iowa State University**

- **Iowa Environmental Mesonet**: CoCoRaHS network metadata

**Federal Register** (National Archives and Records Administration)

- Indian Entities Recognized by and Eligible to Receive Services from BIA

## Attribution and licensing

Copyright (c) 2026 ATNI Climate, The Affiliated Tribes of Northwest Indians
(ATNI). This project is licensed under the DDM Community License, Version
1.0 (see `LICENSE`): permitted for anyone for noncommercial use, with any
redistribution or modification released under this same license,
share-alike; no commercial use is permitted, and this document offers no
path to one.

Every use must cite ATNI Climate and Patrick A. Freeland, the Developer;
carry provenance (source, issuer, retrieval date, terms) for every dataset
shown and every dataset a deployer adds; and follow the [Tiered Sovereign
Data Framework](https://github.com/atniclimate/TieredSovereignDataFramework)
for sovereign, Tribal, or Indigenous data, never redistributing sovereign
boundary or place data beyond what the source and Nation concerned permit.
This tool serves Tribes and Indigenous Peoples and must not be used against
Tribal sovereignty, treaty rights, or Indigenous data sovereignty; it can,
and should, help any community with access to it.

See `LICENSE` for full terms, `CITATION.cff` to cite this project, and
`llms.txt` for machine-readable use notes. Data layers from sovereign Tribal
Nations, state, provincial, and federal entities retain their own
public-domain or specific-use licenses (see `LICENSE` Part B); confirm
authorization before redistributing any bundled reference polygons.
