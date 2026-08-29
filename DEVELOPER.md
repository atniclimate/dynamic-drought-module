# DDM developer guide

This guide explains how to set up, understand, change, verify, and publish the
Dynamic Drought Module. It is intended for maintainers and contributors who
need more implementation detail than the product README.

DDM is a static TypeScript application built with Vite and MapLibre GL JS. It
has no application backend. An optional Cloudflare Worker provides only an
allowlisted, body-transparent Cross-Origin Resource Sharing shim for a small
set of public upstream services.

## Prerequisites and local setup

- Node.js 22.12 or newer
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

The production build is written to `dist/`. Vite uses relative asset paths so
the same output works at a domain root, under the historical
`/dynamic-drought-module/` subpath, and inside an iframe.

## Product and planning authority

Read these sources in order when they disagree:

1. Current owner direction defines product intent for the requested work.
2. Runtime code, especially `src/config/layers.ts`, defines implemented
   behavior.
3. Tests define asserted behavior and provide regression evidence.
4. [`docs/design/README.md`](docs/design/README.md) defines durable design and
   interaction doctrine.
5. [`docs/ROADMAP.yaml`](docs/ROADMAP.yaml) defines future scope,
   dependencies, decisions, and acceptance evidence.
6. [`docs/RELEASE_NOTES.md`](docs/RELEASE_NOTES.md) records merged product
   history.

Asana owns mutable execution state such as status, assignee, and due date. The
roadmap YAML intentionally omits those fields so the repository does not
maintain a competing clock.

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

DDM serves public agency data and deployer-owned placeholders. The empty
`public/data/tribal-lands.geojson` and `public/data/treaty-areas.geojson`
files must remain empty unless the relevant sovereign authority authorizes
data for that deployment. Do not copy Tribal, Treaty, or other
sovereign-jurisdiction polygons into the repository.

Capitalize Tribe, Tribal, and Treaty when referring to Tribal Nations or
Treaty rights. Agency boundary products are representations, not definitive
jurisdictional truth, and must retain the existing caveats.

Do not add proprietary tile services, credentials, tracking, analytics, or
telemetry. Public upstream invocation logs can contain full query URLs, so
provider logging policy is also a privacy decision.

The inventory and rebuild notes for committed data are in
[`public/data/README.md`](public/data/README.md). Builders must preserve
provenance, pinned source versions when appropriate, expected feature or byte
bands, and semantic canaries. Generated artifacts should be changed through
their authoritative builder, never by hand.

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
`ARCGIS_FIELD_PROBES` (nineteen today), fetches the layer schema and fails
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

Run the cross-cutting gate after application, configuration, build, generated
data, or broadly shared documentation changes:

```powershell
npm run gate
```

Run a targeted Playwright file before the full serial suite:

```powershell
npx playwright test tests/s4-shell.spec.ts --workers=1
npm run test:serial
```

Shared navigation, map lifecycle, state, responsive behavior, and release
readiness changes require the serial suite. A narrow documentation-only change
normally needs documentation checks, YAML validation when applicable, the
public-tree gate, and a clean Git diff rather than the full browser suite.

Always report the exact commands and results. Do not hide a failure by piping a
command through another process, increasing a timeout without diagnosis, or
rerunning until a flaky result happens to pass. Keep Playwright traces and
reports for actionable CI failures.

## Optional Worker

The Worker source is in `workers/proxy/` and has its own package metadata. It
may relay only exact reviewed routes over HTTPS, using the configured method,
request headers, response checks, byte limits, and deadline. It must not become
a general proxy, transform upstream bodies, collect analytics, or hold product
state.

Typecheck Worker changes from its directory. Publishing the Worker is a
separate external operation and should include pre-deploy and post-deploy
revision, route-rejection, body-hash, CORS, deadline, and rate-limit checks.

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
nothing said about it. The same workflow therefore also runs daily at 14:15
UTC and on `workflow_dispatch`, and compares `main` against the live build
from the other direction. `scripts/resolve-live-expectation.mjs`, whose
judgment is the pure `resolveLiveExpectation` in
`scripts/lib/live-receipts.mjs` (unit-tested in
`tests/live-receipts.test.mjs`), reads the event, the head of `main`, that
commit's committer date, and the last thirty `deploy.yml` runs for `main`,
and returns one of three verdicts:

- `verify`: run the same live proof. For a post-deploy event the expected
  commit and nonce are the deploy run's own; for a scheduled or dispatched
  compare they are the head of `main` and the latest successful deploy run
  of that head.
- `in-flight`: a deploy of the head is queued or running, or the head is
  younger than the 30 minute grace period and has no successful deploy yet.
  The run records the reason and ends green without verifying and without
  touching issues, because a release under way is not a divergence. The
  grace period covers a normal green push (gate, sharded browser suite, and
  `deploy-pages` take about 15 minutes) with room for a slow runner.
- `undeployed`: the head is past the grace period with no successful deploy.
  The run names the latest deploy run for that commit and its conclusion,
  appends to or opens the same single `deploy-divergence` issue (same marker
  comment, so a scheduled finding and a post-deploy finding are never two
  issues), and fails.

A scheduled compare queues behind an in-flight post-deploy proof rather than
cancelling it; only a newer post-deploy proof supersedes a running one. What
the compare still does not prove: that Pages served a particular build to a
particular reader at a particular moment, or anything about the hours
between two daily runs. It proves what the site answers when it is asked.

The daily `source-health` workflow records the runtime's own upstream
requests at the default camera (status, bytes, seconds, record count, cache
headers, failed requests) and opens one issue per catalog row that breaches
its budget; neither job writes a response body, trace, or screenshot.

GitHub Pages is already a range-capable CDN. Benchmark field performance before
moving hosting. Cloudflare Pages is not a direct replacement while an artifact
exceeds its per-file limit; moving large archives to R2 would introduce a new
service, state, cost, and governance decision.

## Documentation changes

Keep public documents factual and durable:

- update `README.md` for current user-visible behavior;
- update `DEVELOPER.md` for stable maintainer practice;
- update `docs/ROADMAP.yaml` for planned scope or dependencies, without
  adding live status fields;
- update `ROADMAP.md` only when its human-readable phase projection changes;
- update `docs/design/` for durable design doctrine;
- update `docs/RELEASE_NOTES.md` for merged history and observed deployment
  facts; and
- regenerate `docs/COVERAGE_MATRIX.md` from
  `src/config/capability-matrix.ts` rather than editing it manually.

Never publish credentials, workstation paths, private notes, research prompts,
or session records. Keep implementation claims tied to runtime and tests, and
keep release claims tied to observed workflow and live-build evidence.

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
