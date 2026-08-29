# DDM smoke suite

A Playwright suite that builds the production bundle, serves it with
`vite preview`, drives it in a real browser, and asserts what a user would
see.

## Running it

```powershell
# PowerShell (from the repository root)
npm test                 # build, preview, run the suite headless
npm run test:report      # open the HTML report from the last run
```

The `webServer` block in `playwright.config.ts` runs `npm run build && npm run
preview`, so a stale `dist/` can never be verified and a build failure fails
the run. The general suite uses `http://127.0.0.1:4173/`. A focused
`deployment-subpath.spec.ts` case maps the same production artifact to
`/dynamic-drought-module/`, the GitHub Pages repository seat, and verifies
that its relative entry assets and application boot work there.

Every run owns that preview process. If another process is already listening
on port 4173, the suite fails instead of reusing an unattributed build.

## What it asserts, and what it deliberately does not

Two doctrines shape the coverage.

1. **Production build, never the dev server.** The deployed site serves
   `dist/`; dev-only behavior would be a false pass.

2. **Deterministic backbone only.** The suite asserts structure and behavior
   that do not depend on live agency data:

   - `boot.spec.ts` - the map reaches its WebGL `load` and the sidebar builds.
   - `ux1-surfaces.spec.ts` - the four role groups render in order; condition
     surfaces are mutually exclusive; an old multi-surface link resolves to
     the first surface named; a deactivated surface clears its pill.
   - `ux2-presets.spec.ts` - the five preset chips render in order; a preset
     replaces the active layer set and holds the one-surface-at-a-time rule.
   - `url-state.spec.ts` - region and layers restore from a deep link; a
     toggle round-trips through the URL and a second toggle-on reuses the
     cached lazy-loaded module; embed mode survives a re-sync; expanding the
     sidebar in embed mode deliberately exits embed.
   - `telemetry.spec.ts` - every wired station row reaches a terminal state
     (never stuck on `loading...`); the link-only station stays empty.
   - `conditions-strip.spec.ts` - the three metrics render in order; off
     layers read an honest off state; the drought and fires tiles reflect the
     map when their layers render (the fires assertion skips honestly when
     the upstream is down rather than failing a correct app).
   - `legend.spec.ts` - one unified legend panel: sections order as surface,
     then events, then reference; a surface swap replaces only the surface
     section; the panel hides when the last legend layer turns off.
   - `hover-inspector.spec.ts` - the what-is-under-the-cursor readout names a
     feature from an active layer and clears on mouseout.
   - `fonts.spec.ts` - the brand fonts load from same-origin and no request
     reaches a font CDN (the self-hosting stewardship guarantee, enforced).

**Exact live values stay out of the gate.** Assertions like "Forebay 75.4 ft"
or "83 percent forecast" are flaky against live upstreams and belong in the
manual `ddm-ui-verifier` lane, where a blipping agency endpoint is a human
judgment call rather than a red CI run. The telemetry spec here asserts only
the honest-status contract (terminal, not a specific number), which is what a
regression would actually break.

Pull requests run the deterministic root gate and Worker typecheck (without
deploying the optional Worker) beside the browser suite; the Pages workflow
runs the root gate and build beside the same browser suite, and deploys only
when both have passed. Run
focused affected specs during development and `npm run test:serial` when a
change affects shared navigation, map lifecycle, state, or release readiness.

## How CI runs the suite

`playwright.config.ts` defines two projects. `chromium` holds every spec but
two; `chromium-3d` holds `fire3d-mode.spec.ts` and `view-contracts.spec.ts`,
the two files whose 3D cases build terrain, a sky, a smoke volume, and
context tiles on the software renderer and carry their own 120 to 180 second
budgets (the Node-level cases in `fire3d-mode` and the three non-3D contract
rows ride along; the split is by file, and both projects use the same
browser settings). Locally, `npm test` and `npm run test:serial` run both
projects, so coverage is the same in either seat.

In CI (`.github/workflows/browser-suite.yml`, called by both Validate and the
Pages deploy) each project is sliced with `--shard=i/n` onto its own runners,
one worker each: four shards for `chromium`, three for `chromium-3d`. Each
runner builds and serves its own `dist/`, so no shard reads another's state.
Each page is its own software-GL MapLibre context, so more runners is the
lever; more workers per runner is not (see the `workers` note in the config).
The shard counts were fitted to the 2026-08-28 idle serial baseline (general
16.4 minutes over 798 tests, 3D 13.7 minutes over 32) so every shard lands
near eleven minutes on the 2-core runner; re-fit them when the suite grows.

Every shard writes a job summary (passed, failed, flaky, skipped, and the
`file:line` of each failed or flaky test) from its JSON report through
`scripts/summarize-playwright-shard.mjs`. A shard that fails, or passes only
on retry, uploads two three-day artifacts named for the shard: its HTML
report (`playwright-report-*`) and the raw `test-results/` tree
(`playwright-traces-*`). A clean shard uploads nothing.

Since 2026-08-29 those artifacts carry **Playwright traces**, which they
never did before. The owner ratified the change; an adversarial review then
narrowed it, and the narrowed shape is what shipped. In CI the trace is
captured `on-first-retry` as an explicit object with `screenshots: false`,
`sources: false`, and `attachments: false`; `screenshot` stays `off` and
`video` stays `off`. `attachments` is the one of those that defaults to ON: a
spec that grabs `page.screenshot()` for its own pixel analysis
(`m-breadth-heatrisk-days.spec.ts` does) would otherwise hand that image to
the trace. The gate records every `page.screenshot()` site and bans
`toHaveScreenshot()` and `attach()` outright. So a
retained trace holds request and response records, DOM snapshots, console
output, and timings, and **no rendered pixels and no spec source text**.
Retention is three days on both artifacts. Retention shortens exposure; it is
not what makes the content safe. Artifacts on this repository are
world-readable: the repository is public, and any GitHub user can list and
download every retained artifact, so the content has to be safe on its own.

The explicit evidence captures in `fire3d-mode.spec.ts` (`fire3d-evidence/`,
gitignored) are still skipped under `CI`. Locally, traces keep their frames,
screenshots stay `only-on-failure`, and the evidence captures run, all into
gitignored directories.

When `DDM_BUILD_SHA` or `DDM_BUILD_NONCE` is set in the environment (CI sets
both), `gotoApp` asserts the `<html>` build stamp on every boot it drives,
so each shard proves it exercised the build this run made.

Browser provisioning (the Playwright browser cache and its miss and hit
paths) is a composite action, `.github/actions/playwright-chromium`, shared
with the post-deploy verification workflow (`verify-live.yml`, which runs
`scripts/verify-live.mjs`) and the daily source-health probe
(`scripts/source-health.mjs`). Those two
scripts drive Chromium directly, outside this suite, and import it from
`@playwright/test` (the declared dependency). Their pure evaluators
are unit-tested by `tests/live-receipts.test.mjs` and
`tests/source-health.test.mjs`, which run in the gate with the other
`node:test` files and register no Playwright tests.

The Node-level specs that deliberately drive a degrade path (a corrupt
archive, three tile errors in the rolling window, a dead fetch, a sibling
request cancelled after its headers arrived, one failed framing count, an
invalid or transfer-truncated ArcGIS body) capture the runtime's
`console.warn` through `captureWarnings()` in `tests/map-harness.ts` and
assert the exact list of warnings, so the honest reason is part of the
contract and its stack trace stays out of the shard log; the captured text
is kept as a `console.warn` annotation on the test result, so a failure
still carries the evidence. That helper is the only way a spec may quiet a
warning: a hand-rolled `console.warn = () => undefined` silences the reason
instead of asserting it, and a warning the runtime stops issuing would then
pass unnoticed.

## The sovereign boundary sources, and why CI still keeps nothing

Since 2026-08-29 (roadmap task DDM-P1-T08) **every boot this suite drives
answers the Census AIANNH and BIA AIAN-LAR queries from synthetic fixtures**.
`gotoApp` installs the route pair before it navigates, locally and in CI
alike, so a local green and a CI green mean the same thing; the bodies are
the hand-authored rectangles with obviously synthetic names in
`tests/tribal-fixtures.ts`, and no real sovereign-boundary polygon can enter
a test artifact (the project's hard rule 1; see the NON-REDISTRIBUTION GUARD
in `src/layers/aiannh.ts`). A spec that needs a different response (an empty
collection, an abort, a truncated body, an ArcGIS error, a geography-keyed
answer) registers its own handler through `routeBoundary`, which wins because
Playwright checks Page routes before context routes.
`gotoApp(page, query, { boundaries: 'empty' })` serves the honest live-zero
collection.

The stub is registered on the browser **context**, not on the page, and it is
**fail-closed**. Context routing means a Page this suite never opened, a
popup or a `context.newPage()`, inherits it; fail-closed means the handler
fulfills from the fixture rather than falling back, because a fallback from
the last context handler puts the request on the wire. `{ boundaries: 'live' }`
is the one path to a real agency response, and `installBoundaryStubs`
**throws when `CI` is set**, so no alias, wrapper, or computed option can put
a live sovereign-geometry body into a public artifact. That runtime refusal,
not a source scan, is the enforcement.

The live mode has exactly one caller, and it is a deliberate waiver.
`tests/fire3d-mode.spec.ts` writes the owner's visual-review captures to the
gitignored `fire3d-evidence/`; the owner reads them to judge whether real
Tribal-geography cartography draws honestly in the 3D scene, and a picture of
two invented rectangles cannot answer that. Its three evidence-bearing boots
therefore ask for `live` exactly when `CAPTURE_EVIDENCE` is true, which is
exactly when the run is local and nothing is retained. Under `CI` those boots
use the fixture like every other boot. Routine liveness of the two services
is proven separately by the daily source-health probe
(`scripts/source-health.mjs`), which drives Chromium outside this suite.

The always-mounted minimap is stubbed the same way and for a related reason.
`retainMinimapDrought` fetches NCEI's North America country base and a
Statistics Canada province boundary on every non-brief-embed boot, and until
2026-08-29 both went live on nearly every boot. Neither is sovereign
geometry, both are open-licensed analysis masks the application never
renders, but "no live external geometry reaches a retained trace" should be
true in fact rather than true only for the two hosts anyone thought to check.
`tests/minimap-fixtures.ts` now serves both from the rectangles
`tests/s4-minimap.spec.ts` already used, on the context, for every boot. They
were stubbed rather than waived. That includes the six modules that boot
themselves: each installs the minimap stub by hand beside its
`routeAllTribalFixtures` call, and the gate checks the two requirements
separately so one cannot stand in for the other.

Checks keep that true, and they cover different halves of the claim.

`tests/boundary-stubs.spec.ts` proves the `gotoApp` shells DYNAMICALLY. It
boots the bare Brief door, the wildfire cluster, the console, the wildfire
cluster inside an embed, the brief embed, and the phone viewport; for each it
compares every request the page made to either host against the requests the
stub actually answered, and fails on one that escaped. Read the claim
precisely: the application still ISSUES these requests and the trace records
their URLs. What the stub guarantees is that **no request leaves the browser**
and no agency ever sends a body. Where the catalog
mounts it also asserts both boundary pills reach `live`, which can only come
from the fixture body. It does not observe the boots that navigate
themselves: those answer from their own `routeAllTribalFixtures` handlers, so
their requests never enter the suite-wide stub's log.

`tests/boundary-boot-inventory.test.mjs` covers those STATICALLY, and guards
the seams. It runs in the gate with the other `node:test` files
(`npm run test:boundary-boots`) and walks every module under `tests/` at any
depth (`.ts`, `.tsx`, `.mjs`, `.js`; Playwright's `testDir` is recursive, so
a top-level-only scan would let a nested spec escape). It fails when a module
navigates outside `gotoApp` without a recorded reason and its own stub, when
a module opens a second Page or awaits a popup without a recorded reason,
when a module registers or unroutes a boundary or minimap route outside its
shared helper, when the live mode appears outside the one recorded fire3d
allowance or that allowance loses its `CI` guard, when `gotoApp` stops
installing either stub before it navigates, when a raw boot installs the
boundary stub but not the minimap one, when either stub stops routing the
context, when any module calls `page.unroute` or `page.unrouteAll` outside two
recorded literal-pattern sites, when a module uses `toHaveScreenshot()` or
`attach()`, when an unrecorded `page.screenshot()` site appears, when the CI
trace object loses any of its four pixel and source switches, when a service path drifts so the route globs stop matching, or
when either deployer-owned slot (`public/data/tribal-lands.geojson`,
`public/data/treaty-areas.geojson`) stops holding zero features. Those two
are same-origin, so no route stub stands between them and a trace; an empty
committed file is what makes a same-origin trace safe. The recorded raw-boot
counts are brittle on purpose: an unrelated new `.goto(` or `.setContent(`
fails the gate, which is the moment to ask whether it needs the stub
installed by hand.

Be clear about what that file is. A source scan cannot see a navigation
driven from inside `page.evaluate` or an option assembled at runtime. It is a
tripwire that makes an unusual thing visible in review. The guarantee is the
context-level fail-closed routing and the runtime refusal of the live mode
under `CI`, neither of which depends on the scan being exhaustive.

### Accepted exposures in a retained trace

The claim is not "a retained trace contains nothing". It is this list, and it
should be read before anything is added to what CI keeps.

**Cannot appear.** Sovereign geometry of any kind: Census AIANNH, BIA
AIAN-LAR, and the deployer-owned Tribal and Treaty slots. The first two are
answered from synthetic rectangles on every boot; the last two are asserted
empty by the gate. No rendered pixels, from any source, because trace frames,
screenshots, and video are all off in CI. No spec source text (`sources:
false`).

**May appear, and is accepted.** Response bodies from the other public
agency sources a boot touches: NIFC and WFIGS fire perimeters, drought
polygons (NADM, USDM, CDM), NOAA weather alerts, HMS smoke, EPA ecoregions,
watersheds, station telemetry. OpenStreetMap raster tile bodies from the live
basemap.

One of those is not hypothetical, and it is worth naming with its evidence.
`gotoApp` stubs `NADM-current.geojson` only when the query carries neither
`layers=` nor `cluster=`, so a boot that names either fetches it live, and the
minimap fetches it live on the same boots. Inspecting the first real CI trace
artifacts (Validate run 33250251205) found a **2.5 MB live NADM body from
`ncei.noaa.gov`** stored in `playwright-traces-chromium-3-of-4`. That is
public-domain NOAA drought data, not sovereign geometry, so it breaks no hard
rule and it sits inside the accepted list above. It does mean the sentence
"no live external geometry reaches a retained trace" is **not** true today,
only "no live SOVEREIGN geometry" is. Making the NADM stub context-level the
way the boundary and minimap stubs are would close it, and is deliberately
left as follow-up rather than folded into the retention change. Request and response headers, cookies, request URLs with their
coordinates and place names, DOM snapshots including any Tribal Nation name
from the committed `public/data/tribal-roster.json`, and console output.
Nothing there is sovereign geometry, and nothing there is undisclosed by a
`git clone` of this public repository, but a licensing and redistribution
review of the agency and raster content has **not** been done and is open
work.

**Deferred, deliberately.** A synthetic or blank basemap for artifact-bearing
runs, which is the precondition for turning pixels back on: it is what would
stop a screenshot from embedding live place labels, and what would stop a
frame of synthetic rectangles from reading as real Tribal boundaries once it
is detached from its test. Until that exists, screenshots stay off in CI.
Also deferred: `retain-on-failure` in place of `on-first-retry`, which would
capture the original failing attempt rather than the retry.

## Headless WebGL

MapLibre GL needs a WebGL2 context. Headless Chromium has no GPU, so the
`chromium` project forces ANGLE over SwiftShader (pure-software GL) via launch
flags in `playwright.config.ts`. Without them the map never fires `load` and
the sidebar never builds.

## When you change a config table

The canonical strings the specs assert against (preset labels, role-group
headings, the pill vocabulary, default-on keys) are mirrored in
`tests/helpers.ts`. If you rename a preset or relabel a role group, update the
mirror there; the mismatch will otherwise surface as a failing spec, which is
the point.
