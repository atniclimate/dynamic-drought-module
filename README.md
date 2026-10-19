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
Tribal boundaries and Tribal place names on this map are public data, T0
under the Tiered Sovereignty Data Framework. Every one comes from a public
source: Tribal Lands from the U.S. Census Bureau's AIANNH service,
Reservation Boundaries from the Bureau of Indian Affairs AIAN-LAR service,
and the names of federally recognized Tribes from the Bureau's Federal
Register roster. They are open for all to see and are shown with respect for
where they come from: the source is named, and each boundary is described as
a representation, not a definitive depiction of Tribal jurisdiction. The map
reads them live from the publishing service at view time rather than keeping
its own copy, so the source stays the authority (see Live Tribal geography
below). The more protected tiers are for what describes sacred sites or
places that could be harmed; this project holds no such data and does not
seek it. Two deployer-owned slots (`tribal`, `treaty`) ship as empty
placeholders a deployer may populate with its own authorized data; they
appear only when turned on by URL.

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

See the [release notes](docs/RELEASE_NOTES.md) for release history and verification evidence.

## What the module shows

The module shows five kinds of information, and each mode opens with the
layers that answer it. Each kind answers a different question about conditions and place.

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

The **Share view** button copies the current view as a URL that works
directly or in an iframe. Common parameters:

| Parameter | Example | Purpose |
| --- | --- | --- |
| `region` | `region=washington_state` | Choose the starting region |
| `cluster` | `cluster=wildfire` | Open Wildfire; `heat` and `enso` are also available |
| `select` | `select=state:WA` | Focus a state and open its impact briefing |
| `embed` | `embed=true` | Use the iframe presentation |

See the [full URL reference](DEVELOPER.md#url-parameters-url-as-state)
for layer lists, views, time controls, defaults, and legacy links.

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
| `usfs-whp-classes` | Wildfire Hazard Potential (USFS colors) | surface | USFS GeoPlatform ImageServer (live) |
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

The framing minimap uses the North American Drought Monitor and a
Statistics Canada analysis mask. The [method and source notice](DEVELOPER.md#framing-minimap-and-nunavut-proxy)
explain the derived colors and partial northern coverage.

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

Recent NOAA NESDIS GOES GeoColor imagery provides context over an
OpenStreetMap basemap; clouds and coverage gaps can obscure the ground.
The Satellite control turns imagery on and off. Rivers come from
OpenStreetMap via Overpass. See the [developer guide](DEVELOPER.md#about-the-basemap-and-hydrography)
for refresh behavior and service limits.

### The desktop 3D Fire view

Terrain relief covers the Pacific Northwest; areas outside that coverage
do not have the same terrain detail.

This is a context view, not a prediction: nothing in it shows or implies
fire spread, ignition, or an all-clear. See the [developer guide](DEVELOPER.md#the-desktop-3d-fire-view)
for sources, rendering, and coverage details.

## Development

See [DEVELOPER.md](DEVELOPER.md) for setup, architecture, customization,
the optional Worker proxy, dependency overrides, testing, and releases.
The [design guide](docs/design/README.md) records interface principles;
the [coverage matrix](docs/COVERAGE_MATRIX.md) records supported capabilities.

## Browser support

This section is the canonical statement of the map renderer and browser
floor; `vite.config.ts` and `DEVELOPER.md` point here, and
`npm run check:renderer` fails when the build configuration and this
section disagree.

The map renderer is MapLibre GL JavaScript 6.14.0, pinned exactly in
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

- Building footprints (central Oregon extract, ODbL, https://opendatacommons.org/licenses/odbl/1-0/)

**Iowa State University**

- **Iowa Environmental Mesonet**: CoCoRaHS network metadata

**Federal Register** (National Archives and Records Administration)

- Indian Entities Recognized by and Eligible to Receive Services from BIA

## Attribution and licensing

Copyright (c) 2026 ATNI Climate, The Affiliated Tribes of Northwest Indians
(ATNI). This project is licensed under the DDM Community License, Version
1.0 (see [LICENSE](LICENSE)): noncommercial use only. Redistribution must
carry the license; distributed derived works must use the same license
as a whole (share-alike).

Every copy or derived work must credit ATNI Climate, Patrick A. Freeland
as Developer, the project name, and its [source repository](https://github.com/atniclimate/dynamic-drought-module).
Deployments must carry provenance (source, issuer, retrieval date, terms) for every dataset
shown and every dataset a deployer adds; and follow the [Tiered Sovereign
Data Framework](https://github.com/atniclimate/TieredSovereignDataFramework)
for sovereign, Tribal, or Indigenous data, never redistributing sovereign
boundary or place data beyond what the source and Nation concerned permit.
This tool serves Tribes and Indigenous Peoples and must not be used against
Tribal sovereignty, Treaty rights, or Indigenous data sovereignty; it can,
and should, help any community with access to it.

See `LICENSE` for full terms, `CITATION.cff` to cite this project, and
`llms.txt` for machine-readable use notes. Data layers from sovereign Tribal
Nations, state, provincial, and federal entities retain their own
public-domain or specific-use licenses (see `LICENSE` Part B); confirm
authorization before redistributing any bundled reference polygons.
