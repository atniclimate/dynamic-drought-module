# Dynamic Drought Module (DDM)

`atniclimate/dynamic-drought-module` · v0.2.1

An embeddable, serverless web map for seeing drought conditions anywhere
in the United States and understanding what they mean for a place: current
drought status, wildfire and extreme heat risk, water and snowpack
telemetry, and the public resources that address the impacts, routed by
the place a user selects. Built by ATNI Climate (Affiliated Tribes of
Northwest Indians) with a Pacific Northwest (PNW) focus and a national
framing.

**For a deployer, the module is a static folder.** Build it once, serve it
from any web host, embed it in any page with an `<iframe>`. There is no
backend, no account, no tracking, no analytics, and no proprietary tile
provider. Every view is a shareable URL.

**Stewardship comes first.** The module is built so each deployer (a
Tribal Nation, a state agency, a partner) controls its own copy on its own
infrastructure. Sovereign-jurisdiction data is never redistributed by this
repository: the Tribal Lands and Treaty Areas layers ship as empty
placeholders that each deployer populates under its own authorizations.

> **Treaty boundaries.** Agency polygons are a representation of Treaty
> cession areas, not a definitive depiction of Tribal jurisdiction. Treaty
> rights and Tribal sovereignty are matters of sovereign authority. Verify
> with the relevant Tribal Nation before using these polygons for any
> decision-making.

License: Creative Commons Attribution-NonCommercial-ShareAlike 4.0
International (CC BY-NC-SA 4.0).

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
  Level IV ecoregions, Tribal Lands, Treaty Areas, Bureau of Indian
  Affairs (BIA) reservation boundaries (live from the authoritative
  AIAN-LAR service), and rivers.
- **Events**: active wildfire perimeters (National Interagency Fire
  Center) and active National Weather Service (NWS) heat and fire-weather
  alerts.
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
`unavailable`, `no data`, `zoom in to load`); a failed upstream shows an
honest pill, never a silent blank.

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

The deployed site lives at
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
| `region` | `washington_state`, `columbia_snake_basin`, `cascades`, `central_oregon`, `southwest_washington`, `south_puget_sound`, `national`, `alaska`, `hawaii` | `washington_state` |
| `layers` | comma-separated keys from the table below | `usdm,tribal,telemetry` |
| `select` | `state:<postal code>` (for example `state:WA`): opens the map focused on that boundary with its impact briefing open; applied once, then dropped from the URL | none |
| `embed` | `true` or `1` (hides the sidebar for clean iframe presentation) | `false` |

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
| `drought` | Seasonal Drought Outlook | surface | NOAA CPC WMS (live) |
| `heatrisk` | HeatRisk · Today (Experimental) | surface | NOAA NWS/WPC ImageServer (live) |
| `spc-fire-weather` | Fire Weather Outlook (Day 1) | surface | NOAA SPC MapServer (live) |
| `usfs-whp` | Wildfire Hazard Potential | surface | USFS GeoPlatform ImageServer (live) |
| `states` | State Boundaries | reference | US Census, bundled GeoJSON |
| `ecoregions` | Ecoregions (Level III/IV) | reference | EPA Omernik, bundled PMTiles |
| `tribal` | Tribal Lands | reference | bundled GeoJSON, EMPTY PLACEHOLDER |
| `treaty` | Treaty Areas | reference | bundled GeoJSON, EMPTY PLACEHOLDER |
| `bia-reservations` | Reservation Boundaries | reference | BIA AIAN-LAR FeatureServer (live) |
| `hydrography` | Rivers | reference | OpenStreetMap via Overpass (live) |
| `nifc-fires` | Active Wildfires | event | NIFC WFIGS FeatureServer (live) |
| `nws-alerts` | Heat & Fire Weather Alerts | event | NOAA NWS MapServer (live) |
| `telemetry` | Telemetry Stations | stations | USGS, NRCS, USBR, USACE (live) |

Every live endpoint in `src/config/urls.ts` carries a verification
metadata block (HTTP status, content type, CORS posture, response-shape
caveats, verification date). Read it before touching a fetcher.

### About the placeholders

Tribal Lands and Treaty Areas load from bundled GeoJSON in `public/data/`
and ship as empty `FeatureCollection` placeholders, so the application is
functional on first deploy without redistributing any sovereign-
jurisdiction data. To enable a layer, replace the corresponding file with
authoritative GeoJSON under your own authorization. Conversion commands
and download URLs are documented in
[`public/data/README.md`](public/data/README.md). The BIA reservation
layer takes the other path: it fetches the authoritative federal service
live and redistributes nothing.

### About the basemap and hydrography

The basemap is OpenStreetMap standard raster tiles, subdued via raster
paint so the condition surfaces dominate. No proprietary tile providers,
ever. Hydrography queries the volunteer-run Overpass API (three-mirror
failover, viewport-driven, dormant below zoom 7); institutional
deployments expecting heavy concurrency should plan for the National
Hydrography Dataset PMTiles bundle tracked in
[`ROADMAP.md`](ROADMAP.md).

### The Cloudflare Worker proxy (optional)

Most sources serve the browser directly. Two do not (USBR Hydromet and
the NWRFC water-supply CSV have no CORS), and one is flaky enough to want
a retry path (NRCS AWDB). The Worker in `workers/proxy/` is a CORS shim
with a strict allow-list; it adds a header and changes nothing else.
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
  report five canonical states; a data failure keeps the layer checked
  with an honest `unavailable` pill (a shared link never silently loses a
  layer because an upstream blipped).
- **Cancellable network operations.** Master abort signal plus per-call
  timeout on every non-trivial fetch; late responses to superseded
  operations are dropped, not rendered.
- **Empty-placeholder stewardship.** Sovereign-jurisdiction layers ship
  empty; deployers populate them under their own authorizations.
- **Mobile and accessibility.** The sidebar stacks above the map below
  720 pixels; region selection is arrow-key navigable; status changes are
  announced through a polite live region; embed semantics survive
  collapse and expand.

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

## Project documents

- [`docs/PHASE_PLAN_090.md`](docs/PHASE_PLAN_090.md): the ratified phase
  plan to the 0.9.0 pre-release (one minor version per phase).
- [`ROADMAP.md`](ROADMAP.md): what remains, organized by phase.
- [`CHANGES.md`](CHANGES.md): the session-by-session change log.
- [`TODO.md`](TODO.md): deferred items, bucketed by phase.
- `CLAUDE.md`: authoritative project context and hard rules.
- [`SKILLS_SUITE.md`](SKILLS_SUITE.md): the agent-and-skills architecture
  behind the scout-and-verify sourcing pipeline.

## Browser support

Any evergreen browser (Chrome, Edge, Firefox, Safari 14 or newer).
MapLibre GL JavaScript requires WebGL 1.

## Attribution and licensing

This project is licensed CC BY-NC-SA 4.0: free to copy, redistribute,
remix, and build upon; give appropriate credit to ATNI Climate, link the
license, indicate changes; no commercial use; distribute remixes under the
same license.

Data layers provided by sovereign Tribal Nations, state agencies, and
federal entities retain their respective public-domain or specific-use
licenses. Ensure you have authorization to redistribute any bundled
reference polygons.
