# DDM developer guide

This guide is for maintainers and contributors who need to set up, understand,
change, verify, and publish the Dynamic Drought Module. The implementation
detail here matters because each deployer builds this application once and
owns its own copy, its own data, and its own deployment.

DDM is a static TypeScript application built with Vite and MapLibre GL JS. It
has no application backend. An optional Cloudflare Worker provides only an
allowlisted, body-transparent Cross-Origin Resource Sharing shim for a small
set of public upstream services.

## Prerequisites and local setup

- Node.js 24 (Active LTS); `.nvmrc` pins the exact patch, 24.20.0
- npm, using the committed `package-lock.json`
- A browser supported by Playwright for browser testing
- Python only for the offline landscape and Overture structures pipelines

Install and start the development server:

```powershell
npm ci
npm run dev
```

Vite normally serves the application at `http://localhost:5173`. Build and
preview the production output with:

```powershell
npm run build
npm run preview
```

For an introduction to npm, Vite, and Pages, read the
[tooling walkthrough](docs/tooling/EXPLAIN_NPM.md) or its
[slides](docs/tooling/EXPLAIN_NPM.html) ([Quarto source](docs/tooling/EXPLAIN_NPM.qmd)).

The production build is written to `dist/`. Vite uses relative asset paths so
the same output works at a domain root, under the historical
`/dynamic-drought-module/` subpath, and inside an iframe.

Node 24 is the toolchain that builds the application and is not a browser
floor; the two are different axes. The renderer version and the browser and
graphics floor are stated once, in README's "Browser support" section, and
`npm run check:renderer` proves that the pin, the lockfile, the installed tree,
and the build target in `vite.config.ts` still agree with it.

### Dependency overrides

`package.json` pins two `overrides` to remove vulnerable dependencies from
the dev-only `mapshaper` chain. Run `npm audit` for the current status;
these overrides do not establish that the full dependency tree is clean.
The chain is used exclusively by four offline maintainer-run
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

## Product and planning authority

Six sources carry authority in this project. Read them in this order when
they disagree:

1. Current owner direction defines product intent for the requested work.
2. Runtime code, especially `src/config/layers.ts`, defines implemented
   behavior.
3. Tests define asserted behavior and provide regression evidence.
4. [`docs/design/README.md`](docs/design/README.md) defines durable design and
   interaction doctrine.
5. The ATNI Climate planning record (private; not in this repository) defines
   future scope, dependencies, decisions, and acceptance evidence. Task and
   decision ids cited in comments and test docblocks (`DDM-P<n>-T<m>`,
   `DR-<nnn>`, `FE-<nn>`) refer to it.
6. [`docs/RELEASE_NOTES.md`](docs/RELEASE_NOTES.md) records merged product
   history.

Asana tracks status, assignee, and due date because those fields change
during execution. The planning record intentionally omits those fields so the
repository does not maintain a competing clock.

## Architecture

The application boots from `src/main.ts`. Its major responsibilities are
separated as follows:

| Area | Primary paths | Responsibility |
| --- | --- | --- |
| Product configuration | `src/config/` | Regions, layers, views, palettes, URLs, source metadata, and presentation copy |
| Map lifecycle | `src/map/` | Map creation, ordering, interactions, Fire 3D, popups, and map-level orchestration |
| Layer modules | `src/layers/` | Source-specific fetching, parsing, rendering, status, cancellation, legends, and cleanup |
| Governed state | `src/state/` | Registry, URL state, layer controller, basemap, view route, selected place, and map store |
| Interface | `src/ui/` | Sidebar, mobile sheet, studios, controls, legends, information, and accessibility surfaces |
| Impact summaries | `src/impact/` | Place-aware interpretation and evidence cards |
| Visual system | `src/styles/app.css` | CSS custom properties and responsive presentation |
| Offline pipelines | `scripts/` | Snapshot, vector, raster, validation, and documentation generators |
| Static data | `public/data/` | Reviewed browser-delivered artifacts and empty deployer slots |
| Browser contracts | `tests/` | Navigation, lifecycle, responsive, accessibility, embed, and release behavior |
| Optional proxy | `workers/proxy/` | Strictly allowlisted CORS relay behavior |

The layer registry is the source of truth for active layers. The URL is a
public state contract, not an export added after the fact. A change to view,
layer, region, basemap, selected place, horizon, or Fire 3D behavior must be
checked against share, reset, reload, browser history, and embed operation.

### Architecture invariants

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
- **Live-fetch stewardship.** Tribal boundaries are public data (T0), read
  live from their public sources each session; the two operator slots ship
  empty.
- **Mobile and accessibility.** Controls retain 44-pixel targets, accessible names,
  keyboard focus, safe-area seating, reduced-motion behavior, and arrow-key
  region navigation; status changes announce through a polite live region;
  embed semantics remain owned by the separate embed shell.

## Customization quick reference

| Want to change... | Edit in |
| ----------------- | ------- |
| Region bounds or names | `src/config/regions.ts` (`REGIONS`) |
| Layer registry and default-on set | `src/config/layers.ts` (`LAYER_DEFS`) |
| Phone hazard rail | `src/config/presets.ts` (`MOBILE_HAZARD_PRESETS`) |
| Colors and palettes | `src/config/palette.ts` |
| Telemetry stations | `src/config/telemetry.ts` |
| Endpoint URLs and the Worker base | `src/config/urls.ts` |
| Brand text and styles | `index.html` header, `src/styles/app.css` |

## URL parameters (URL-as-state)

The application reads `window.location.search` on load, both for direct
visits and for embedded iframes. The **Share view** button copies the
current URL.

| Param | Values | Default |
| ----- | ------ | ------- |
| `region` | `washington_state`, `columbia_snake_basin`, `cascades`, `central_oregon`, `southwest_washington`, `south_puget_sound`, `national`, `alaska`, `hawaii`, `british_columbia` | `national` (add `region=washington_state&view=brief` to keep the prior Washington framing) |
| `layers` | comma-separated keys from the [layer table](README.md#layers-and-data-sources) | `hillshade,nadm-drought,aiannh,bia-reservations,states` |
| `framing` | one of the nine ATNI-authored editorial framing keys, or `all` | none; `region` remains in control |
| `cluster` | `wildfire`, `heat`, or `enso`; an explicit `layers` list outranks it | Drought, encoded by absence |
| `ocean` | `pacific`, `arctic`, or `atlantic`, only with `cluster=enso` | none |
| `select` | `state:<postal code>` (for example `state:WA`): opens the map focused on that boundary with its impact briefing open; applied once, then dropped from the URL | none |
| `embed` | `true` or `1` (hides the sidebar for clean iframe presentation) | `false` |
| `view` | `brief` or `console` | `brief`; only `view=console` opens Console (an embed naming `layers`, `region`, `cluster`, `ocean` or `framing` without `select` still opens Console) |
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

## Layer contract

Layer definitions live in `src/config/layers.ts`. A definition has a stable
key, visible name, source description, semantic role, default state, and a
lazy module loader. Keep internal keys type-linked to the registry contract
and do not invent an ungoverned second activation system.

Each layer module must:

- preserve the issuer's claim, timestamp, units, geography, and limitations;
- use a distinct legend and attribution when the issuer or meaning differs;
- report one of the six supported states: `loading`, `live`,
  `live (partial)`, `unavailable`, `no data`, or `zoom in to load`;
- make non-trivial network work cancellable and time-bounded through response
  body consumption;
- ignore or abort late work after deactivation;
- clean up every source, visual layer, listener, timer, popup, and request it
  owns;
- preserve keyboard, reduced-motion, responsive, and embed meaning; and
- avoid turning missing data or missing coverage into an all-clear.

Add endpoint URLs and their verification metadata in `src/config/urls.ts`.
Verify method, response shape, CORS, authentication, licensing, freshness,
extent, coordinate reference system, pagination, rate behavior, and failure
semantics before integrating a source.

Do not combine multiple issuers into a DDM-derived severity score. Related
sources may be aligned in the interface, but their values, clocks, legends,
and qualifications stay distinct.

## Network and cancellation rules

Use the shared fetch utilities in `src/util/fetch.ts`. A timeout that ends when
headers arrive is not enough for JSON, text, or binary consumers; body parsing
must remain inside the deadline. Activation should expose a cancellation seam
so turning a layer off does not wait for a queued deactivation to reach a
request that is already in flight.

Failure must be visible and recoverable. A thrown import, request, parse, or
activation error must leave the layer unchecked, correct URL state, and retain
an `unavailable` status long enough for the interface to explain what
happened.

## Data and stewardship

Every decision about what data enters this repository is a governance
decision. DDM serves public agency data and deployer-owned placeholders. The
empty `public/data/tribal-lands.geojson` and
`public/data/treaty-areas.geojson` files must remain empty unless the
relevant sovereign authority authorizes data for that deployment. Do not copy
Tribal, Treaty, or other sovereign-jurisdiction polygons into the repository.
The Tribal boundaries the map shows are public data, T0 under the Tiered
Sovereignty Data Framework, from the Census AIANNH service, the Bureau of
Indian Affairs AIAN-LAR service, and the Bureau's Federal Register roster of
federally recognized Tribes. They are read live so the source stays the
authority and no copy goes stale; the instruction not to copy them exists for
provenance and currency, and because the two operator slots are for an
operator's own data.

Capitalize Tribe, Tribal, and Treaty when referring to Tribal Nations or
Treaty rights. This is accuracy, not courtesy. Agency boundary products are
representations, not definitive jurisdictional truth, and must retain the
existing caveats.

Do not add proprietary tile services, credentials, tracking, analytics, or
telemetry. Public upstream invocation logs can contain full query URLs, so
provider logging policy is also a privacy decision. A maintainer adding an
upstream is responsible for knowing what that provider logs and who can
read it.

The inventory and rebuild notes for committed data are in
[`public/data/README.md`](public/data/README.md). Builders must preserve
provenance, pinned source versions when appropriate, expected feature or byte
bands, and semantic canaries. Generated artifacts should be changed through
their authoritative builder, never by hand.

Workflow files pin every third-party GitHub Action to a full commit SHA the
same way; `.github/dependabot.yml` proposes SHA updates for those pins
weekly, and each proposal is reviewed like any other pull request, with
Validate running on it before merge.

Common builders include:

```powershell
npm run build:enso
npm run build:cdm
npm run build:places
npm run build:states
npm run build:ecoregion-tiles
npm run build:whp-tiles
npm run build:power-tiles
npm run build:structures-tiles
npm run build:coverage-matrix
```

Some builders fetch large upstream datasets or require a local Python
environment. Read the script header, source terms, expected cache paths, and
hard-fail checks before running one. Never assume a successful download proves
the artifact's semantics.

### Framing minimap and Nunavut proxy

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
(ODbL, https://opendatacommons.org/licenses/odbl/1-0/), extruded over the terrain from zoom 13: footprints with an
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

## Interface and responsive behavior

Read [`docs/design/README.md`](docs/design/README.md) before interface work.
Inspect the current application at the affected widths before editing it.
Reuse CSS custom properties and existing components where they carry the same
meaning.

Verify tasks, not only screenshots. At minimum, exercise selection, hazard or
view switching, status reading, information access, share, reset, and mode
exit. Check phone, tablet, desktop, iframe, keyboard, focus restoration,
screen-reader naming, safe areas, and reduced motion in proportion to the
change. A breakpoint passing a DOM assertion does not by itself prove that the
remaining map is usable.

## Verification

Use the narrowest relevant check while developing. Useful commands include:

```powershell
npm run typecheck
npm run build
npm run lint
npm run check:links
npm run scan:emdash
npm run check:public-tree
npm run check:activation
npm run check:coverage
npm run check:drift
npm run check:source-health -- --base http://127.0.0.1:4173/ --layers nifc-fires
npm run verify:live -- --expect-sha <sha> --expect-nonce <run id>
```

`check:drift` probes every upstream and, for each ArcGIS layer path in
`ARCGIS_FIELD_PROBES`, fetches the layer schema and fails
on a field missing from the `outFields` list read from the module source;
lists passed as positional function arguments are not extracted and are
recorded with their reason in `OUT_FIELDS_SENDERS_COVERED_ELSEWHERE`, which
a test keeps in step with `src/`. `check:source-health` boots a served
build (start `npm run preview` first) once as a control and once per
catalog layer at the default camera and records the requests the runtime
issues, with basemap tiles stubbed and the ambient boot requests replayed
from the control capture; the daily `source-health` workflow runs it on
`main`. `verify:live` is the post-deploy proof the Pages workflow runs; by
hand it needs the expected commit and run id and defaults to the public
site.

The Worker-health row of `check:drift` now compares the live `/healthz`
revision to the `WORKER_REVISION` constant read from
`workers/proxy/src/index.ts`, not a hand-pinned string, so drift is
source-vs-live rather than live-vs-live. Between a reviewed source revision
bump and the owner's publish, the daily `upstream-monitor` run opens exactly
one `upstream-drift` issue naming the mismatch, which is the design working
as intended, and it closes automatically on the first run after the publish.

Choose checks using the [local verification ladder](tests/README.md#the-local-verification-ladder).
Run focused source or browser tests while editing, `npm run gate` for build and
cross-cutting configuration changes, and optionally `npm run verify:smoke` when a
wider local signal is wanted before pushing. Smoke owns its gate and serves that
gate's single fresh build.

The full browser suite runs on GitHub in the `Validate` workflow; start it on a
branch without an open pull request with `gh workflow run validate.yml --ref
<branch>`. Reserve a local `npm run test:serial` (more than an hour) for when
GitHub is unavailable. Ending a session does not trigger another full suite.
Documentation-only and verification-tooling checks are scoped in the same
ladder. Report exactly what ran and what remains unverified.

`check:all` is the source-check list shared by `gate` and `gate:nobuild`.
`gate` adds the build, bundle and activation checks. `gate:nobuild` runs
typechecking and source checks without certifying a production artifact.

`npm run lint` is the one lint command, and `check:all` runs it, so both gates
name it. It is Biome (`biome.jsonc`) over `src/**/*.ts` and `src/styles/app.css`:
one tool for the TypeScript and the stylesheet, with no runtime dependencies and
no install scripts. DR-007 decided that lint is added; it did not name the tool,
and the four tools its question mentioned do not fit this tree. typescript-eslint
declares `typescript >=4.8.4 <6.1.0` while this tree pins TypeScript 7, and
ESLint cannot read TypeScript without it; a formatter would reflow a large share
of `src/` on its first pass, which is churn rather than improvement. The
configuration is a RATCHET: the recommended preset stays on, so every rule the
tree already satisfies is held at zero, and the thirteen rules that fire today
are switched off in `biome.jsonc` with their measured count and the reason
beside each. Burning those down, and widening the command to `tests/`, is
DDM-P15-T05.

Run the fire and 3D specs directly when fire or 3D changed (about 20 min):

```powershell
npx playwright test --workers=1 tests/fire3d-mode.spec.ts tests/view-contracts.spec.ts
```

Only one Playwright run at a time: the preview server pins port 4173. If a
killed run leaves the port held, Playwright refuses to start; find and stop
the orphan with:

```powershell
Get-NetTCPConnection -LocalPort 4173 -State Listen | Select-Object OwningProcess
Stop-Process -Id <pid> -Force
```

`npm run check:links` is documented here but is not part of `gate` or any
workflow; run it by hand when documentation links change.

Shared navigation, map lifecycle, state, responsive behavior, and release
readiness changes require the full suite to be green on GitHub, with the
affected specs run locally first. A narrow documentation-only change
normally needs documentation checks, YAML validation when applicable, the
public-tree gate, and a clean Git diff rather than the full browser suite.

When you write a browser spec, boot through `gotoApp`. It answers the Census
AIANNH and BIA AIAN-LAR queries from the synthetic fixtures in
`tests/tribal-fixtures.ts` on every boot, so no ordinary run reaches a live
sovereign-geography service. A spec that needs a different boundary response
registers it with `routeBoundary`, never a raw `page.route`; a spec that must
navigate itself calls `routeAllTribalFixtures` first and records why in
`tests/boundary-boot-inventory.test.mjs`, which the gate runs
(`npm run test:boundary-boots`). See `tests/README.md`.

Since 2026-08-29 a failed or flaky CI shard retains a **pixel-free** Playwright
trace (no screenshots, no video, no spec sources) and its HTML report for three
days as world-readable public artifacts, which is safe only because every boot
answers the sovereign boundary queries from synthetic fixtures; `tests/README.md`
lists what such a trace may and may not carry before you add anything to it.

Always report the exact commands and results. Do not hide a failure by piping a
command through another process, increasing a timeout without diagnosis, or
rerunning until a flaky result happens to pass. Keep Playwright traces and
reports for actionable CI failures.

## Optional Worker

Most sources serve the browser directly. The Worker in `workers/proxy/` is
a CORS shim with a strict allow-list (the authoritative set is in
`workers/proxy/src/index.ts`, mirrored in the `wrangler.toml` header): it
permits only the exact AWDB, AgriMet, Hydromet, NWRFC, USFS Wildfire
Hazard Potential, US Drought Monitor DSCI, and `api.weather.gov` reads
used by the application, returning upstream bytes unchanged with
browser-facing CORS headers. Deploy with `wrangler` and set
`URLS.workerProxy` to enable those sources; without it, the module still
runs and reports those values honestly as unavailable.

The Worker source is in `workers/proxy/` and has its own package metadata. It
may relay only exact reviewed routes over HTTPS, using the configured method,
request headers, response checks, byte limits, and deadline. It must not become
a general proxy, transform upstream bodies, collect analytics, or hold product
state.

Preflight is route-validated rather than blanket: an `OPTIONS` request meets
the same route policy the real request would, so an allow-listed target gets a
204 while an unknown path, an off-route target, an over-length `url`, or a
malformed one gets the same 404, 403, 414, or 400 a GET would get. Those
refusals keep their Cross-Origin Resource Sharing headers for non-browser
callers and for debugging, not for page script: a browser whose preflight is
refused raises a generic network error and never exposes the status or the
body. `/healthz` answers GET and its own preflight, advertising `GET, OPTIONS`
on every response including its 405. This guide names no revision, because a
copied one goes stale at the next publish: the reviewed source revision is
the `WORKER_REVISION` constant in `workers/proxy/src/index.ts`, and the
published one is whatever the live `/healthz` answers. The daily upstream monitor derives
the expected revision from this source file through
`scripts/lib/worker-revision.mjs`, so a published Worker older than reviewed
source fails that monitor by design until the deployer runs the two-phase
publish again.

Typecheck Worker changes from its directory. Publishing the Worker is a
separate external operation and should include pre-deploy and post-deploy
revision, route-rejection, body-hash, CORS, deadline, and rate-limit checks.

`wrangler.toml` now also pins `compatibility_flags = ["no_nodejs_compat",
"no_nodejs_compat_v2"]` (DR-010 a, 2026-09-02 decision register; the second
flag added 2026-10-09, because Cloudflare requires both to turn Node.js
compatibility off). The compatibility date `2026-05-09` predates the
2026-08-04 default, so the flags change nothing today: they guard a future
date bump, and a dry-run build is byte-identical with or without them. A
config-only change: it reaches the edge only through a Worker publish, which
needs the owner's say. The rollback handle for any publish is the version live just
before it: read its revision from the live `/healthz` and its Cloudflare
version id from the dashboard at publish time, and record both in that
publish's release note, not here. Rolling back to anything older drops the
hardening every later publish added.

`verify:worker` is the instrument for those edge checks. It is read-only
against the public Worker and writes a receipt:

```powershell
npm run verify:worker -- --expect-revision <revision>
npm run verify:worker -- --expect-revision <revision> --out worker-receipt.json --summary summary.md
```

It proves, by probing rather than by reading source, that the deployed edge
enforces the reviewed policy: the health endpoint names the expected
revision with the reviewed Cross-Origin Resource Sharing advertisement and
no caching; every allow-listed route family relays, not a sample of three,
which is all the daily upstream monitor covers; HEAD and OPTIONS answer only
for an allow-listed target; an unknown path, an off-route path of an allowed
host, a host that was never allow-listed, and a host the reviewed revision
removed are all refused; a POST is refused by the method gate; the request
bounds hold; and the relay hands back upstream bytes unchanged on one
static endpoint.

Two design points are load-bearing. Each row asserts the HTTP status AND the
Worker's own JSON error code, because a 403 that arrives from somewhere
further along is not the same answer as a 403 the route policy produced, and
a receipt that read only the status would score that as a pass. And byte
transparency is proved across the whole table before publishing, on
synthetic bytes in `tests/worker-proxy-policy.spec.ts`; live it is one
static endpoint fetched at its bare URL on both legs (the Worker pins that
route to no query names and refuses a cache-busting nonce), because a
direct-versus-relay hash false-fails on a dynamic upstream; a response held in
the Worker's 60-second edge cache is a byte copy, so it is still comparable.

Exit 0 when every row passed, 1 when any failed, 2 on a usage error. The
receipt holds statuses, header values, byte counts, digests, and
milliseconds; never a response body. `--expect-revision` is required, so the
receipt always asserts a named revision rather than whatever the edge
happens to be serving; `--expect-healthz-methods` names the method set the
health endpoint advertises, which is a narrower question than the relay's.
The health endpoint takes no body and offers no HEAD, so it names
`GET, OPTIONS` on its document, its preflight, and the `Allow` header of its
405, while the relay routes keep `GET, HEAD, OPTIONS`.
The judgment is the pure evaluators in `scripts/lib/worker-receipts.mjs`,
unit-tested in `tests/worker-receipts.test.mjs` against both the answers the
edge gives today and the answers the reviewed candidate must give, so the
receipt is known to fail before a publish and pass after one.

Running it against an edge older than reviewed source is expected to fail,
and that failing receipt is the drift evidence. It is a hand-run command
here: it is meant for the owner's pre-publish and post-publish steps in the
Worker convergence plan, and later for the daily monitor. No workflow runs
it, and the receipt is not committed.

## GitHub Pages and release evidence

The Pages workflow builds the static application from `main`. The build embeds
its source commit in `document.documentElement.dataset.ddmBuildSha`, allowing
a live probe to prove which source is running. A merged commit is not proof of
a successful deployment.

Before calling a release current, verify:

- required checks completed for the exact commit;
- the Pages workflow completed rather than being cancelled or superseded;
- the live build marker matches the intended commit;
- the build nonce is non-`dev` and identifies the completed workflow run;
- root, subpath, and embed boot behavior still work;
- large PMTiles assets support byte-range requests; and
- the Worker revision matches reviewed source when a Worker change is part of
  the release.

The `verify-live.yml` workflow checks the first six of these after every
successful deploy with `scripts/verify-live.mjs` and keeps its receipt as
the `live-receipt` artifact. It runs on the deploy workflow's completion,
checks out the commit that run deployed, and expects that commit and that
run id in the stamp; it has its own concurrency group, so a newer push to
`main` cannot cancel the receipt for the build still live (only a newer
successful deploy, which brings its own receipt, supersedes a running
verification). The deploy job first confirms its commit is still the head
of `main`, and a failure opens one `deploy-divergence` issue that the next
deploy verifying green while still the head of `main` closes.

That post-deploy proof only ever fires for a deploy that succeeded, so a
deploy that fails or is cancelled leaves `main` ahead of the live build with
nothing said about it. The same workflow therefore also compares `main`
against the live build from the other direction.

SNOOZE (PR 55, 2026-09-01): the daily 14:15 UTC schedule that ran that
compare is commented out, together with the `source-health` and
`upstream-monitor` crons, because their alerts were disrupting the active
development window. The restore date, 2026-09-11, is an owner decision, not
an automatic event: nothing reinstates these schedules on its own. The
post-deploy `workflow_run` proof is untouched and still verifies every
successful deploy, and `workflow_dispatch` stays live for hand checks. The
weekly `refresh-snapshots` cron was never snoozed. Until the restore, a
deploy that fails or is cancelled goes unnoticed by CI; GitHub still emails
the owner about the red run.

Branch workflow: each release is built on a short-lived branch cut from
`main`, and `main` changes only when the maintainer lands a release.
`validate.yml` is `on: pull_request`, so a branch without an open pull request
runs no CI on push; start it by hand with `gh workflow run validate.yml --ref
<branch>`. While developing, run `npm run typecheck` and the focused tests for
the change. When a piece of work is finished, run the focused tests again and
the browser-free checks (`npm run verify:quick`; `npm run gate:nobuild` or
`npm run gate` when the change is cross-cutting), then push the branch. The
full browser suite runs on GitHub in eight shards, once the release candidate
is frozen rather than on every push. Before a release, the full suite must be green on GitHub for the
frozen release candidate, and one independent review covers the release's whole
diff. A local `npm run test:serial` is the fallback when GitHub is unavailable.
`Validate` is the only check that must be green on the pull request, and
`deploy` and `verify-live` are consequences of the merge rather than gates on
it.

`scripts/resolve-live-expectation.mjs`, whose
judgment is the pure `resolveLiveExpectation` in
`scripts/lib/live-receipts.mjs` (unit-tested in
`tests/live-receipts.test.mjs`), reads the event, the head of `main`, that
commit's committer date, and the last hundred `deploy.yml` runs for `main`
merged with a second query filtered to the head itself (so no amount of
unrelated activity can evict that head's own runs from the window). The head
is read BEFORE the runs, so a push between the two calls can only add runs
the snapshot has not seen. It returns one of three verdicts:

- `verify`: run the same live proof. For a post-deploy event the expected
  commit and nonce are the deploy run's own; for a scheduled or dispatched
  compare the commit is the head of `main` and the expectation is the SET of
  every deploy run that published it, in creation order. More than one run
  can legitimately have published a commit and only the site can say which
  bytes it serves, so the proof accepts any member and the receipt records
  the one that matched.
- `in-flight`: a deploy of the head is queued or running inside the
  in-flight bound, or the head is younger than the grace period and has no
  successful deploy yet. The run records the reason and ends green without
  verifying and without touching issues, because a release under way is not
  a divergence.
- `undeployed`: the head is past the grace period with no successful deploy,
  or its deploy run is past the in-flight bound. The run names the latest
  deploy run for that commit and its conclusion, appends to or opens the same
  single `deploy-divergence` issue (same marker comment, so a scheduled
  finding and a post-deploy finding are never two issues), and fails.

Two envelopes, because "how long may a commit go undeployed" and "how long
may one deploy run take" are different questions:

- head grace, 30 minutes from the commit (`LIVE_COMPARE_GRACE_MS`): a normal
  green push takes about 15 minutes through the gate, the sharded browser
  suite, and `deploy-pages`, and this leaves room for a slow runner. The
  head's age is floored by its OLDEST deploy run's start, so a backdated
  committer date cannot skip the grace and a retry cannot reset a clock the
  head has already spent.
- in-flight bound, 60 minutes from the deploy run's creation
  (`LIVE_INFLIGHT_STUCK_MS`): the deploy's own envelope is longer than the
  head grace, since `browser-suite.yml` budgets 40 minutes per shard and
  `deploy.yml` adds a 15 minute gate before it. A run 45 minutes in is late,
  not stuck. Past the bound, a deploy parked in `queued` or `waiting`
  escalates rather than keeping the compare green forever.

Both are inputs the workflow passes, not constants buried in the library, and
`verify-live.yml` gives the job 45 minutes so a cache-miss Chromium provision
(up to 10), the bounded propagation poll (up to 7), the 16 minute verifier,
and the issue steps all fit inside it.

Every issue mutation, not only the close, refetches `main` immediately before
writing. A run whose commit is no longer the head files nothing, records
"superseded" in the job summary, and ends green.

A `verify` runs at one of two depths. The light half (`--light`) waits for
propagation, reads the build sha and nonce out of the shipped script, checks
every referenced asset answers 200, and range-checks each PMTiles archive
against the size of that file in the checked-out commit. It needs no browser
and no `node_modules`. The deep half adds the six boots. Which half runs was
keyed on the schedule until 2026-09-01; snoozing the cron made that branch
unreachable, so it is now the `mode` dispatch input. Everything runs deep
except a `workflow_dispatch` that asks for `mode: light`, and a light run
escalates to deep when its cheap checks fail.

What a light run gives up: browser-visible degradation with no deploy behind
it, such as a layer that stops reaching a terminal state against unchanged
bytes. That is acceptable for a hand check because `source-health` boots the
application against every catalog source and opens its own issues.

Only the BYTES make a verification red. Before any verdict, the workflow
polls the live site for the deployed sha for up to 5 minutes, so a slow CDN
edge cannot be reported as a divergence. After that, the run fails only for
a `stamp:`, `propagation:`, or `seat:` finding, or a poll that never saw the
sha. A product finding (a layer, an embed corner, a page error, a range)
opens or updates the one `deploy-divergence` issue and the run ends green,
because a product regression is not evidence that the deploy failed. Before
2026-09-01 any finding reddened `main`, and a single assertion in the proof
that had drifted from the runtime (the embed credits surface, PR 54) would
have done so on every deploy from then on.

The `node --test` suites live in `tests/` beside the Playwright specs but are
excluded from the `chromium` project (`testIgnore: '**/*.test.mjs'`), because
Playwright's default `testMatch` would otherwise import and execute them on
every collection and every worker while registering no Playwright test.

A deploy run counts as having published the head if ANY of its attempts
succeeded, not only the latest: a run that deployed and was then re-run into
a failure reads as `failure` in the run list while Pages still correctly
serves what the earlier attempt published, so the compare asks the attempts
API about exactly those runs. The run id is the build nonce either way,
because the stamp carries the run id, which is stable across attempts.

A scheduled compare queues behind an in-flight post-deploy proof rather than
cancelling it; only a newer post-deploy proof supersedes a running one, and
when it does, that day's scheduled `undeployed` finding (if there was one)
is dropped rather than filed, with the next scheduled run re-evaluating.
What the compare still does not prove: that Pages served a particular build
to a particular reader at a particular moment, or anything about the hours
between two runs of it. It proves what the site answers when it is asked,
and while the schedule is snoozed it is only asked after a deploy or by
hand.

The daily `source-health` workflow records the runtime's own upstream
requests at the default camera (status, bytes, seconds, record count, cache
headers, failed requests) and opens one issue per catalog row that breaches
its budget; neither job writes a response body, trace, or screenshot.

**Status truth.** Calling a roadmap task "Complete" requires a
clause-by-clause receipt: the exact commit SHA, the event type (unit,
dispatch, schedule, live, or owner-observed), the run id, and the retry
result for every acceptance line, not one aggregate claim. A hand-dispatched
workflow run proves the code path executes; it is not a schedule receipt. A
retry pass does not satisfy an acceptance line that requires passing without
depending on retries.

## Hosting: GitHub Pages now, one local origin later

GitHub Pages is the current static host, by owner direction. The end state is
ONE origin serving both the static application and the upstream relay, so
`URLS.workerProxy` becomes a same-origin path and the Cross-Origin Resource
Sharing shim disappears (owner ruling DR-006 a, 2026-09-02, recorded on gate
DDM-D10 in `docs/ROADMAP.yaml`). Nothing here schedules that move. This section
records the end state and names the seams it would replace, so the next hosting
conversation starts from the shape the runtime actually has.

The seams a local full-service server would replace:

1. **The relay origin.** `URLS.workerProxy` names a second origin, and seven
   runtime paths build `${workerProxy}/proxy?url=<encoded upstream>`:
   `src/util/awdb.ts`, `src/util/hydromet.ts`, `src/impact/water-supply.ts`,
   `src/impact/sources.ts`, `src/impact/nws-point.ts`, `src/layers/usfs-whp.ts`,
   and `src/config/station-registry.ts`. One origin serving both the
   application and the relay turns that into a same-origin path and retires the
   shim. The empty-`workerProxy` branch those call sites already carry, which
   gives a fork with no Worker an honest `unavailable` instead of a blind
   fetch, is not a Pages artifact and stays.
2. **Upstream allowlists keyed to the deployed origin.** Some upstreams decide
   by `Origin`: the federal GeoPlatform Wildfire Hazard Potential ImageServer
   echoes `Access-Control-Allow-Origin` for `https://atniclimate.github.io`
   under `Vary: Origin`, and does so intermittently, which is why that layer is
   proxied unconditionally rather than fetched directly
   (`src/layers/usfs-whp.ts`). A hosting move changes the browser's origin and
   re-opens every one of those judgments; a same-origin relay makes the
   browser's origin irrelevant, because the fetch happens server-side where
   Cross-Origin Resource Sharing does not apply.
3. **Response headers this repository cannot set.** GitHub Pages serves its own
   headers and takes no header configuration from this repository, so the
   deployment carries no Content-Security-Policy, no frame-ancestors or
   Cross-Origin-Resource-Policy statement for the `?embed=true` iframe
   audience, and no per-asset cache policy: the hashed, immutable bundle and a
   35 MB archive are treated alike. A server we run owns all three.
4. **Large archives ride the code deploy.** The PMTiles archives are committed
   under `public/data/` and republished with the site on every deploy:
   hillshade 35,252,210 bytes, Wildfire Hazard Potential 13.6 MB, structures
   7.9 MB, power lines 3.8 MB, ecoregions 2.5 MB. The host's limits already
   shape the product. The z9 hillshade build is a reproducible artifact that is
   deliberately not shipped, the full Pacific Northwest structures bake was
   projected at 240 to 380 MB and rejected, and the retired fuel-model drape
   was removed from the tree so it would stop riding every deploy. A host with
   its own storage separates data publication from code publication.
5. **A cross-origin fallback to somebody else's Pages copy.**
   `URLS.hillshadePmtilesFallback` hard-codes the ATNI Pages copy of the
   hillshade archive, used only after a deployer's bundled copy fails its
   bounded header probe. A deployer running a full-service server serves its
   own archive and the borrowed origin goes away.
6. **Byte-range reads are an assumption about the host.** The pmtiles protocol
   reads a header, a directory, and the visible tiles by HTTP range request.
   Pages answers ranges and `scripts/verify-live.mjs` proves it after every
   deploy; a replacement host has to prove the same before it can serve these
   archives at all.
7. **Publication is the only access control.** Everything in `dist/` is
   world-readable and nothing in this repository can say otherwise. That is the
   seam the source-map ruling below answers.

No hosting change is made without evidence, gathered before the move and not
after it:

- **Range.** The candidate answers a `Range` request for a 35 MB archive with
  `206`, a correct `Content-Range`, and `Accept-Ranges`, measured rather than
  assumed. The terrain and drape layers are unusable without it.
- **Cache.** Measured cache headers for the hashed bundle, for the archives,
  and for `index.html`, with a stated revalidation story for an embedding page.
- **Privacy.** Who can read request logs, how long they are kept, and what a
  viewer's address reaches. The move may not add tracking, analytics, or
  telemetry; that is a product invariant, not a hosting preference.
- **Cost.** The standing monthly cost and the cost of the worst traffic month
  the project would tolerate, archive egress included.
- **Rollback.** A named way back to the previously served build that does not
  depend on the new host being healthy, plus a post-deploy receipt equivalent
  to `verify-live.yml`.
- **Portability.** The copied-iframe deployment still works from a domain root
  and from the historical `/dynamic-drought-module/` subpath.

Two facts bound the options today. GitHub Pages is already a range-capable CDN,
so a replacement has to at least match it, and field performance should be
benchmarked before hosting moves. Cloudflare Pages is not a direct replacement
while an artifact exceeds its per-file limit, and moving large archives to R2
would introduce a new service, state, cost, and governance decision.

**That governance decision was taken on 2026-09-10 (DR-079), for the terrain
archive only.** The paragraph above stays true about what such a move costs;
what changed is that the project has now paid it once, deliberately and in a
bounded way. The 3D Fire scene's terrain needs about 27 m per pixel to answer
the question it exists to answer, a fire at the foot of a mountain, and the
bundled zoom 8 archive resolves about 212 m per pixel: measured in the running
scene, it reads the Mount Jefferson summit 931 m low while reading the Bend
valley floor within 19 m, because a coarse elevation model does not lower a
landscape, it flattens it. The same box at zoom 11 is over 1.1 GB, past the
GitHub Pages 1 GB site cap, and Git LFS is not usable with Pages, so no GitHub
plan reaches it. A deep archive therefore lives in a Cloudflare R2 bucket
behind a NEW Worker, `ddm-terrain`, never a widened route on `ddm-proxy`.

Three things bound that move and are not to be widened quietly. The bundled
zoom 8 archive stays shipped and stays the fallback the client probes down to,
so a static deployer is still self-contained and nothing new ships in `dist`.
Workers Logs stay off (DDM-D07) and R2 Data Access Logs stay off on the bucket,
because this tool serves Tribal Nations and request logging would be a
stewardship failure rather than a configuration detail. And the work stops at
the free tiers: R2 storage and egress are $0 inside 10 GB, and the Workers free
tier is 100,000 requests per day account-wide, shared with `ddm-proxy`; needing
Workers Paid is a reason to stop and ask, not a step to take.

**Production source maps.** Production builds publish no source maps while
GitHub Pages is the host (owner ruling DR-069, 2026-09-03: the second clause of
gate DDM-D10, which DR-006 does not answer). The repository being public is an
argument about the source, not about the build: a source map hands a reader the
exact built tree, including anything transient that never appears in a commit,
and while Pages is the host nothing here controls who fetches one. Nothing in
the product needs a published map, so the build's own output is the debugging
surface until a server we run can serve maps to somebody in particular. Revisit
when the local full-service server lands.

The execution is not the obvious one, and the obvious one is wrong. The
activation gate proves what is folded into each initial chunk by opening that
chunk's `.map`, and treats a missing or evidence-empty map on a non-exempt
initial chunk as a hard failure, so `build.sourcemap: false` would break
`npm run gate`, and `npm run verify:quick` with it. The ruling is about what is
published, not about what is generated. So `build.sourcemap` is `'hidden'`,
which keeps writing every map the gate reads while dropping the
`sourceMappingURL` comment from the emitted chunks, and
`npm run strip:sourcemaps` (`scripts/strip-published-sourcemaps.mjs`) deletes
the map files from `dist/` in the deploy workflow, after the gate has read them
and before `upload-pages-artifact` takes the folder. Measured at 5be15f5: 85
maps, 6,217,137 bytes, none of them published. The strip sits at the
publication boundary rather than inside the gate because the ruling governs
publication and a local gate run should still leave a debuggable `dist/`.
`deploy.yml` is the only workflow that publishes to Pages; a second publisher
would need the same step.

## Documentation changes

Keep public documents factual and durable:

- update `README.md` for current user-visible behavior;
- update `DEVELOPER.md` for stable maintainer practice;
- keep planned scope, dependencies, decisions and session records in the
  private planning record, never in this repository;
- update `docs/design/` for durable design doctrine;
- update `docs/RELEASE_NOTES.md` for merged history and observed deployment
  facts; and
- regenerate `docs/COVERAGE_MATRIX.md` from
  `src/config/capability-matrix.ts` rather than editing it manually.

Never publish credentials, workstation paths, private notes, research prompts,
or session records. Keep implementation claims tied to runtime and tests, and
keep release claims tied to observed workflow and live-build evidence.

## Commit messages

Authorship is recorded in git's author field and nowhere else. A commit message
carries a subject and, when useful, a body; it carries no `Co-Authored-By:`
trailer, no `*-Session:` link, and no "Generated with" line. The tracked hook in
`.githooks/commit-msg` rejects those lines. Enable it once per clone:

```powershell
git config core.hooksPath .githooks
```

Do not bypass it with `--no-verify`.

AI assistants and automation tools are not named as project contributors in
public credits, commit trailers, or pull-request text. Preserve the license's
required human and organizational attribution and all data-source credits.
Do not rewrite existing history or relabel bot commits as human work.

## Contribution scope

Prefer one bounded, visible outcome per branch. Preserve unrelated changes in
a shared working tree. Stage exact paths, inspect the complete staged diff,
run `git diff --check`, and avoid combining product changes with generated data
or dependency updates unless they are part of the same acceptance contract.

Use strict TypeScript, prefer named exports, and preserve existing module
contracts. Do not author the U+2014 em dash; verbatim upstream data is exempt.

Pull requests should state the user outcome, source and stewardship effect,
state and URL effect, responsive and accessibility effect, verification that
ran, skipped checks, and any owner decision still needed. Do not merge,
deploy, tag, or publish an external service merely because a branch passed its
checks.
