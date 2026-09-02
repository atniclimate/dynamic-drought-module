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

The Worker-health row of `check:drift` now compares the live `/healthz`
revision to the `WORKER_REVISION` constant read from
`workers/proxy/src/index.ts`, not a hand-pinned string, so drift is
source-vs-live rather than live-vs-live. Between a reviewed source revision
bump and the owner's publish, the daily `upstream-monitor` run opens exactly
one `upstream-drift` issue naming the mismatch, which is the design working
as intended, and it closes automatically on the first run after the publish.

Run the cross-cutting gate after application, configuration, build, generated
data, or broadly shared documentation changes:

```powershell
npm run gate
```

Run a targeted Playwright file before the full serial suite:

```powershell
npx playwright test tests/boot.spec.ts --workers=1
npm run test:serial
```

The verification ladder is three commands a person types (measured durations on
the owner's machine):

```powershell
npm run verify:quick    # typecheck, em-dash scan, vocabulary, coverage: about 5 s
npm run verify:smoke    # gate plus twelve smoke specs, serial: about 6 min
npm run test:serial     # the whole suite, one worker: 50 to 55 min
```

Two underlying checks sit beneath them, run directly when you want just the
deterministic backbone:

```powershell
npm run gate            # build, bundle and activation budgets, then check:all: about 40 s
npm run gate:nobuild    # typecheck plus check:all, the steps that need no dist/: about 20 s
```

`check:all` is the shared step list both gates run, so the list exists once.
`gate` adds `build`, `check:bundle` and `check:activation`, the only steps that
read `dist/`; `gate:nobuild` swaps `build` for `tsc --noEmit` and is what a
worker on a shared tree runs.

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
readiness changes require the serial suite. A narrow documentation-only change
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
on every response including its 405. Revision `2026-08-29-options-policy-v4`
is the published revision (2026-08-29, Cloudflare version
`10af1660-5b74-4520-80a1-32c80108fc48`); the daily upstream monitor derives
the expected revision from this source file through
`scripts/lib/worker-revision.mjs`, so a published Worker older than reviewed
source fails that monitor by design until the deployer runs the two-phase
publish again.

Typecheck Worker changes from its directory. Publishing the Worker is a
separate external operation and should include pre-deploy and post-deploy
revision, route-rejection, body-hash, CORS, deadline, and rate-limit checks.

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
static, cache-busted endpoint.

Two design points are load-bearing. Each row asserts the HTTP status AND the
Worker's own JSON error code, because a 403 that arrives from somewhere
further along is not the same answer as a 403 the route policy produced, and
a receipt that read only the status would score that as a pass. And byte
transparency is proved across the whole table before publishing, on
synthetic bytes in `tests/worker-proxy-policy.spec.ts`; live it is one
static endpoint with a fresh cache-busting query on both legs, because a
direct-versus-relay hash false-fails on a dynamic upstream or on a response
held in the Worker's 60-second edge cache.

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

Integration-branch workflow (September 2026 window): product work lands on
one long-lived branch, `integration/2026-09`, which is pushed to origin with
NO pull request open, because `validate.yml` is `on: pull_request` and a
branch without one runs zero CI on every push (a draft pull request still
triggers the event, so a draft is not the escape hatch). Verification is
local-first: `npm run typecheck` per edit, the narrowest Playwright spec plus
`npm run gate` per session, and `npm run test:serial` before landing. When
the owner says go, rebase on `origin/main`, re-run the gate, and open ONE
pull request; `Validate` is the only check that must be green, and `deploy`
and `verify-live` are consequences of the merge rather than gates on it.

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
`verify-live.yml` gives the job 50 minutes so a cache-miss Chromium provision
(up to 10), the bounded propagation poll (up to 12), the 16 minute verifier,
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
polls the live site for the deployed sha for up to 10 minutes, so a slow CDN
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
