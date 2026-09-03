# Release notes

## Unreleased (after v0.6.26)

Merged to `main` after the `v0.6.26` tag. No new package version or tag has
been assigned to this work.

### 2026-08-31: heat readings in plain language (pull request 53, `5e0a889`)

The impact briefing rendered National Weather Service point-heat payloads
exactly as the issuer sent them, so a grid temperature could read
`22.77777777777778` next to an untouched ISO 8601 interval, and a "live" pill
repeated on every metric row. Heat values now read US-customary-led with the
metric value secondary, percents whole, distances miles-first, and timestamps
and intervals in local calendar time; one state pill covers a grid section
instead of one per row. The raw issuer value, its unit code, and the untouched
ISO 8601 interval stay reachable in `title` and `datetime` attributes, and
input the formatter cannot parse is echoed back unchanged rather than turned
into an invented reading. The formatting is a new pure module,
`src/impact/point-heat-format.ts`, shared by the impact panel, the brief
narrative selector, and the heat synthesis.

### 2026-08-31: credits move into the map-information panel (pull request 54, `d5aaac1`)

The persistent attribution strip and MapLibre's compact attribution control are
gone from every shell. The round question-mark disclosure is now the single
credits surface: a Credits line in the map-information panel renders the live
per-source attribution strings, license links included, read from the map
style, so a source added by a lazy layer chunk credits itself as soon as it
exists. Embeds seat that question-mark button in the corner the attribution
control used to occupy, at every size, so an iframe still has a reachable
OpenStreetMap credit. The satellite control steps above the new seat, and the
pre-1.0 preview badge moves to bottom center on desktop.

### 2026-09-01: scheduled probes paused through 2026-09-11 (pull request 55, `2e98493`)

The `schedule` triggers on `upstream-monitor.yml`, `source-health.yml`, and
`verify-live.yml` are commented out in place through an active development
window ending 2026-09-11, so they can be restored by uncommenting.
`workflow_dispatch` stays live on all three for hand checks, and
`verify-live.yml` keeps its post-deploy `workflow_run` proof, so every merge to
`main` still earns its live receipt. Nothing was replaced with a green no-op: a
run that checks nothing must not exist as a receipt.

### 2026-09-02: the September integration wave (pull request 57, merge commit from `integration/2026-09`)

The 2026-09-01 deep dive (eleven read-only audits, four science passes, a
dependency review) was fixed on one integration branch, verified locally on
the ladder, and landed as one merge commit that keeps the wave's own commits.

Science and honesty. The El Nino Southern Oscillation headline now follows
the NOAA Climate Prediction Center's onset and advisory rules with verbatim
citations: conditions lead, the five-season episode rule is secondary, and an
emerging state exists, so the app can no longer read "neutral" while the
Center has an El Nino Advisory in force (it did, against the 13 August 2026
discussion). A `check:enso` gate cross-checks the Center's status page when it
is reachable. "Impact Briefing" replaces "Drought Impact Briefing" wherever the
briefing is named. Issuer dates are carried and shown: the U.S. Drought
Monitor map date, the Climate Prediction Center issued and valid span, and the
drought.gov `info.json` valid date in the gridded-index legend. A NOAA HTTP 200
error envelope now reads `unavailable`, not `no data`. The Drought Severity
and Coverage Index trend band and the nearest-station ceiling are labeled DDM
conventions; a DDM-authored heat-coupling sentence is removed and three
briefing sentences are relabeled as derived pending citation.

Time and horizons. Time-bar fallbacks, sea-surface-temperature frame
prefetch, one horizon chip label table, an `spi=` URL parameter, and a
humanized British Columbia stamp.

Architecture. Bounded caches and fetches, a catalog index, fire-control
strings in the six honest states, a nearest-station ceiling, `maxPitch` 85,
and a lazily loaded hydrate path that keeps the point-heat briefing closure
under its activation budget.

Interface. Design tokens for z-index and motion, the missing spinner
keyframe, `--fg-3` contrast, tablet panel and dock geometry with a first
721 to 1024 pixel band, 44 pixel minimap doors, minimap work gated off phones,
an ENSO map-key family, and a pointer hit box.

Delivery. `verify-live` proves the pull request 54 contract (issue 56 was a
false positive), a bounded stamp poll with a severity split, `gh` retries,
upstream-monitor build-tier tolerance, docs `paths-ignore`, the browser suite
advisory on pushes to `main` with one marker issue, and a weekly Monday
suite. The verification ladder is documented (`verify:quick`, `verify:smoke`,
`test:serial`). The roadmap is slimmed to a product plan with the canonical
plan in `docs/ROADMAP.yaml` (phases DDM-P7 to DDM-P15). The README states
MapLibre's WebGL 2 first, WebGL 1 fallback behavior. Node.js moves to the 24
line, pinned exactly in `.nvmrc`, which every workflow already reads.

### 2026-09-02: MapLibre GL JS 6.6.0 (merge commit `993f5ca` from `maplibre-6/step-1-style-spec-casts`)

The renderer moves from MapLibre GL JS 4.7.1 directly to 6.6.0, skipping the
5 line by owner ruling (gate DDM-D01 in `docs/ROADMAP.yaml` records the
decision and its measured cost). WebGL 2 is now required, which supersedes
the WebGL 1 fallback sentence above; the supported phone and tablet floors,
Safari 15.5 and Chrome 100 on Android, are pinned as the Vite build target
and stated in the README. The style-spec escape casts became typed
expressions, the 70 default imports became namespace imports, the render
worker ships as one relative asset registered once at boot, and the
`queryRenderedFeatures` overscale default is pinned to the 4.x behavior so
that change can arrive separately and visibly. A `check:renderer` gate proves
the pin, the lockfile, and the installed package agree.

Four rulings ride with it. The interface boots whether or not the map does: a
WebGL 2 probe runs before the map is constructed, and a GPU initialization
error or a load that has not arrived within eight seconds shows one honest
notice that clears if the map arrives later, with no layer left `loading`.
The Fire 3D entry gate adds a height floor (landscape phones stay out, a DDM
convention) and a lost WebGL context exits the scene to a 2D map through the
existing failure ladder. The map key and the telemetry adapters load lazily,
taking the entry chunk from 43.4 to 33.6 kB gzip, with four activation
budgets rebalanced and the reason recorded. Fire 3D evidence capture and its
live boundary fetch run only when opted into, so routine local runs stay
offline-safe and assert the build stamp against the tree's own head.

Verified before landing: gate clean, `verify:smoke` 86 green, the Fire 3D
contract 21 green, and the serial suite 869 passed in 25.4 minutes. Deploy
run 33725341105 and verify-live run 33726016220 succeeded on `993f5ca`. The
docs merge `4cfc3a9` that preceded it decided gate DDM-D03, closed
`DDM-P2-T02` and `DDM-P12-T01`, and recorded the 2026-09-02 decision session
in `docs/session-briefing-2026-09-03.md`.

### 2026-09-03: the MapLibre 6 follow-ups (merge commit from `v6-followups/2026-09-03`)

The four loose ends the 6.6.0 landing left open, plus one stale premise found
on the way.

The 3D Fire control now agrees with the map. The map-side entry gate has
asked three questions since DR-025 a (wide enough, tall enough, WebGL 2
present), but the control in the shell island still showed itself on width
alone, so a landscape phone was offered a button whose scene the gate would
refuse. The control now reads the same height floor and the same probe result
and withdraws on a landscape phone, restoring itself when the viewport turns
tall again; a new browser contract pins that. The probe itself is measured
once per page and shared by the boot path, the gate, and the control, where
before each ran its own and allocated its own graphics context.

The URL catalog leaves the entry chunk (the third module of DR-008 a). The
seventy-entry service catalog was the single largest source in the entry
chunk, read at boot by two modules for two values: the OpenStreetMap tile
template and the bundled state boundaries. Those two now live in a small boot
slice, `src/config/urls-boot.ts`, which the catalog re-exports under the old
keys, so every lazy reader and every script that scans the catalog still sees
one whole table. The featured-station table takes the same path: the Water &
Snow list is built on the first reveal or the first station-layer activation,
never at first paint. The entry chunk falls from 33.6 to 29.7 kB gzip and the
eager app total from 49.9 to 45.8; the 2.7 kB catalog chunk now arrives with
the first layer activation instead, in parallel with the default-on layers'
own chunks, so total boot transfer is unchanged and the critical path is
shorter. Eight activation budgets are rebalanced with that reason recorded,
and the activation gate now forbids both catalogs from the initial static set
so a new eager import fails the gate rather than quietly undoing the split.
The link audit and the upstream-drift monitor read the boot slice beside the
catalog, so the basemap probe did not disappear with the move.

Two records corrected. The station-layer contract booted without the station
layer, which left the default-on set in H4, and so had been passing against a
list nothing hydrated; it now activates the layer, waits for the list, and
waits for hydration to begin. The clear-sky specification hand-copy was
re-inspected against the installed 6.6.0 bundle and is unchanged, and the
inspection is recorded where the contract asks for it. The terrain transport
on the 3D view was re-measured after the split and is the same 6,394,061 bytes
over 36 ranged requests recorded on gate DDM-D01.

### 2026-09-03: two briefing sentences made true (merge commit from `briefing/dr-024-058-wording`)

The Impact Briefing's fire-perimeter sentence said "N current mapped NIFC fire
perimeters intersect this area" while the query behind it covered a bounding
box around the selection, capped at 50 records. A box is wider than a
boundary, so a positive count over the box was not a count over the place,
and a full page was silently a floor. The sentence now names what was
queried, "the bounding box around this selection", and when the service
returns its 50-record maximum it says the count is a lower bound (DR-024 b;
the polygon-exact query stays backed up on origin at `905671d`). When every
perimeter is one category the sentence carries one count instead of
repeating it, and mixed categories still keep wildfire, Prescribed fire, and
unclassified records distinct (DR-058 a). No area figure is claimed.

The USDM wildfire read's lineage line no longer quotes internal vocabulary
("the ddm-drought-impact-modeling causal-chain reads") in public text. It
reads in plain language, and the doctrine id rides a `title` attribute on
the lineage line, machine-readable and one hover away. Claims gained an
optional `lineageRef` for that purpose.

## v0.6.26

`v0.6.26` is the package version and, since 2026-08-29, the release tag. One
product change: the mobile sheet now re-measures its camera padding when its
height transition actually ends (pull request 50), so a renderer stalled by a
long task can no longer leave the map padded short and the region framed too
low. Everything else in this release is verification and delivery
infrastructure, landed as one reviewed wave on 2026-08-29 (pull requests 35
through 45, 50, 51, and 41, merged in the order 40, 38, 35, 39, 36, 37, 45,
50, 42, 43, 51, 41).

### 2026-08-29: the Worker publish and the wave

The optional Cloudflare Worker now serves revision
`2026-08-29-options-policy-v4` (Cloudflare version
`10af1660-5b74-4520-80a1-32c80108fc48`, published 23:15 UTC from `f0a9092`).
It relays only the exact routes the application reads, route-validates
preflight, refuses POST, and advertises `GET, OPTIONS` on `/healthz`;
`npm run verify:worker` passes 34 of 34 rows against the public hostname, and
the daily upstream monitor now derives the expected revision from source
instead of a hand-pinned string. Workers Logs are declared off in reviewed
source (DDM-D07).

Continuous integration retains a pixel-free Playwright trace on a shard's
first retry for three days; screenshots stay off. The Census AIANNH and BIA
AIAN-LAR boundary queries are answered from synthetic fixtures in every CI
boot, and, as federal public cartographic products published under federal
open-data policy, those layers may appear in a retained artifact when a spec
opts into them; Tribally-held boundary data never enters the repository, a
build, an artifact, a trace, or a Worker cache.

The live-proof oracle gained a nonce set, freshness and expected-layer
checks, and a light scheduled mode; the browser suite runs eight shards over
three Playwright projects with one retry and an unconditional per-shard
report; Dependabot proposes Action SHA updates. DDM-D01 is answered: the
MapLibre 5 prerequisite is accepted in principle for desktop and tablet, with
mobile 3D deferred to DDM-P2-T01 and the upgrade itself in a later gated
session.

## v0.6.25

`v0.6.25` was the package version and release tag from 2026-08-28 until
`v0.6.26` on 2026-08-29: the annotated tag `v0.6.25` points at `4d55845a9e245c48fd16f9da403e659393044568`
(pull request 29), the last commit that changed product behavior. Every
commit since is verification and continuous-integration infrastructure, not
a new release; see the current source baseline below for what is live
today. `v0.6.24` was never assigned. The August 18 application runtime
merged as `eed7967dea2e9f34214794ca158eb65eebc30113` and deployed through
the normal Pages workflow; the August 13 and August 18 refinements assigned
no tag of their own.

Owner decisions recorded 2026-08-28: continuous-integration runs keep no
Playwright traces or screenshots until every CI boot stubs the Census AIANNH
and BIA AIAN-LAR sources (roadmap task DDM-P1-T08); the thirteen merged
branches were deleted and `feature/maplibre-v5` stays until DDM-P0-T03.

Source baseline as observed on 2026-08-29: `main` is at
`56dd46a882a587a96e0840b5c81681c9da5f8583`. Pull requests 31 to 34 merged
2026-08-29 and were each deployed and verified live: PR 31 (`1d82b59`)
deploy 33240003166 / verify 33240334529; PR 32 (`214c26e`) deploy
33246342317 / verify 33246642822 / hand-dispatch 33246718167; PR 33
(`8ffebba`) deploy 33246816424 / verify 33247208523; PR 34 (`56dd46a`)
deploy 33247634954 / verify 33247959936. The earlier 2026-08-28 baseline
was `c7a5574449e833939c7a0d59a9b056a648ea9852` (pull request 28) with nonce
`33228785543`. The 2026-08-20 divergence recorded here earlier closed when
the 2026-08-24 scheduled ENSO refresh deployed
`a5c27c3b630349bfd93ee13c66e7cfe6305ce3c9` with its full browser suite. The
hosted build nonce was the local fallback `dev` until pull request 27 made
each hosted build attributable to its run.

### 2026-08-29: the upstream drift monitor compares live to reviewed source

check:drift now derives the expected Worker revision from workers/proxy/src/index.ts instead of a hand-pinned string, so a published Worker that lags reviewed source fails the daily monitor until the owner publishes.

### 2026-08-29: Dependabot proposes Action SHA updates

Roadmap task DDM-P0-T07 required that automated dependency updates can
propose later SHA changes for review; `.github/dependabot.yml` now does
that for the `github-actions` ecosystem, weekly, covering both
`.github/workflows` and the `.github/actions/playwright-chromium` composite
action. The npm ecosystem stays out of this file because application
dependency upgrades change the shipped bundle and remain a separate owner
decision.

### 2026-08-29: CI retains a pixel-free trace on the first retry

Owner decision, recorded 2026-08-29 at 03:41 PDT: the DDM-P1-T08 flip is
ratified. That is the external authorization the roadmap task requires, and
it supersedes the 2026-08-28 decision recorded above that continuous
integration keeps no Playwright traces or screenshots until every CI boot
stubs the Census AIANNH and BIA AIAN-LAR sources. Those boots are stubbed
now, so the condition attached to the earlier decision is met.

An adversarial review the same morning found the ratified diff safe in its
response bodies but not in its pixels, and the shipped change is narrower
than the one ratified. Traces are on; screenshots are not. In continuous
integration `trace` is the object form `{ mode: 'on-first-retry',
screenshots: false, snapshots: true, sources: false, attachments: false }`,
`screenshot` stays `off`, and `video` stays `off`. `attachments` defaults to
true, and a spec that reads pixels back with `page.screenshot()` for its own
assertions would otherwise hand that image to the trace, so it is switched off
by configuration rather than left safe by convention. A retained trace therefore carries request
and response records, document snapshots, console output, and timings, and
carries no rendered map frame and no spec source text. Locally nothing
changed: traces keep their frames and screenshots stay on failure, in
gitignored directories.

A shard that fails or passes only on retry now uploads two artifacts, its
HTML report and the raw `test-results/` tree, each for three days instead of
the report's previous seven. This repository is public and its artifacts are
downloadable by any GitHub user, so the shortened retention limits exposure
without being what makes the content safe. What makes it safe is that every
boot answers the two sovereign boundary queries from synthetic rectangles.

Three conditions were closed to get there. The suite-wide boundary stub moved
from the page to the browser context and became fail-closed, so a page this
suite never opened inherits it and an unrecognized request is answered rather
than forwarded, and the live mode now throws whenever `CI` is set. The
always-mounted minimap's two continental analysis inputs, NCEI's North
America country base and a Statistics Canada province boundary, were fetched
live on nearly every boot and are now answered from the same rectangles
`tests/s4-minimap.spec.ts` already used. `waEcologyCededLands` in
`src/config/urls.ts`, a Washington State Department of Ecology
Treaty-ceded-areas layer with no runtime caller, gained the provenance and
stewardship docblock every other entry in that file carries, including the
publisher's own statement that the layer is a generalized visual guide rather
than an accurate boundary.

One waiver is deliberate. The fire3d evidence captures, which the owner reads
to judge whether real Tribal-geography cartography draws honestly in the 3D
scene, ask for live boundaries again, and only when the run is local and
nothing is retained. The synthetic fixtures had silently replaced the
cartography those captures exist to show.

Inspecting the first real trace artifacts also showed that the sentence "no
live external geometry reaches a retained trace" is not yet true in full: a
boot naming `layers=` or `cluster=` still fetches `NADM-current.geojson` live,
and one 2.5 MB public-domain NOAA drought body was retained. That is not
sovereign geometry and breaks no hard rule, but it is recorded in
`tests/README.md` with its evidence, and closing it is follow-up work rather
than part of this change.

Deferred, and named as deferred: a synthetic basemap for artifact-bearing
runs, which is the precondition for turning any pixels back on; a licensing
review of the other public agency geometry and raster tile bodies a trace may
carry; and `retain-on-failure`, which would record the original failing
attempt rather than the retry.


### 2026-08-29: every suite boot answers the sovereign boundary queries from synthetic fixtures

Roadmap task DDM-P1-T08 asks for three things; pull request 34 (`56dd46a`)
delivers the first two and leaves the trace/screenshot flip to the owner.
Twenty specs moved onto the shared boot helper (`gotoApp` in
`tests/helpers.ts`), which now answers every boot from the synthetic
fixture bodies in `tests/tribal-fixtures.ts`; their duplicate per-spec
routes were deleted. `tests/boundary-stubs.spec.ts` and
`tests/boundary-boot-inventory.test.mjs` (`npm run test:boundary-boots`,
part of the gate) guard it, with the mechanism documented in DEVELOPER.md.
Trace and screenshot retention stays off pending the owner decision that
is DDM-P1-T08's remaining output; a local `--trace on` run against a
deliberately failed boot confirmed the retained trace carried no response
body from either service.

### 2026-08-29: continuous-integration hardening from the slice A audit

Pull request 33 (`8ffebba`) fixed three findings from the platform-truth
audit: the Playwright browser cache now saves only from a run outside a
pull request, so it can no longer evict the shared `main` cache entry it
also depends on; three specs that silenced a by-design `console.warn`
degrade path now capture and assert the exact warning text; and the
upstream monitor and snapshot refresh now find their own open issue by
marker comment across every label page, so a labeled pull request is never
commented on and a second issue can never shadow the real one.

### 2026-08-29: main and live are compared on a schedule

Pull request 32 (`214c26e`) closes a gap in DDM-P0-T04: the post-deploy
proof only fires after a successful deploy, so a failed or cancelled
deploy left `main` and live silently diverged with no receipt.
`verify-live.yml` now also runs daily at 14:15 UTC and on
`workflow_dispatch`, comparing `main` against live directly (verdict logic
in DEVELOPER.md), covered by `tests/live-receipts.test.mjs` in
`npm run gate`. A rode-along fix stopped Playwright's test collection from
importing the `node --test` suites into every browser worker;
`playwright test --list` still reports 830 tests in 106 files. The
hand-dispatched run (33246718167, for `214c26e`) proved the shared code
path and the `verify` verdict the same day the workflow merged; no
`schedule`-event run of `verify-live.yml` has fired yet, so the first
scheduled receipt is still owed. What the compare still does not prove:
anything about the hours between two daily compares.

### 2026-08-29: the live proof survives a newer push

Pull request 31 (`1d82b59`) moved post-deploy verification into its own
`verify-live.yml` workflow with its own concurrency group, so a newer push
to `main` no longer cancels an in-flight verification for the build still
live. The residual gap this left, a deploy cancelled during publish
getting no receipt either way, closed one pull request later when pull
request 32 added the scheduled compare. First receipt: deploy 33240003166,
verify 33240334529.

### 2026-08-28: the deploy proves the live build, and the sources get a daily receipt

Pull request 29 (`4d55845`, tagged `v0.6.25`) followed pull request 28's
sharded seven-runner Playwright split (Validate 13 minutes instead of 48)
to deliver the post-deploy and daily receipts roadmap tasks DDM-P0-T04,
T08, and the proposed T12 ask for (mechanism in DEVELOPER.md).
`verify-live.mjs` now runs after every successful deploy; a daily
`source-health` workflow records the runtime's own upstream requests per
catalog layer, opening one issue per breaching row (on the day WFIGS
geometry grew it would have flagged the perimeter layer `unavailable` at
42 MB against its 15 s budget). Zoom-gated layers, selection-driven
queries, and satellite tiles are reported as not measured, and one
observation per day can be a warm-cache path. The upstream drift monitor
now fails on a missing ArcGIS `outFields` field across 19 covered layer
paths, the kind of check that would have caught `attr_DailyAcres` going
unserved for months, and every requested field was present on 2026-08-28;
not extracted, and recorded by reason instead: lists passed as positional
arguments, including the CPC 6-10 and 8-14 day point query `cat,prob` and
the USDM, NIFC, and watershed lists in `src/impact/sources.ts` and
`src/state/watershed-geometry.ts`, plus the watershed HUC code field, a
template token. `docs/ROADMAP.yaml` proposed `DDM-P0-T12` for owner
ratification.

### 2026-08-28: the Fire view gets its perimeters back, and the embed corner unstacks

Pull request 27 (`ce13436`) fixed three issues found in a desktop and
mobile discovery pass. The NIFC WFIGS current-perimeter query was
requesting every attribute at full-precision geometry, 42.75 MB in 41.6 s
for 243 perimeters against a 15 s budget; naming the nine attributes the
application reads and asking the service to generalize the outline (about
37 to 56 m across mapped US latitudes) cut that to 1.90 MB in 6.1 s for 239
perimeters, and the legend, popup, and on-map key now say the outline is
generalized and not for evacuation, parcel, or tactical decisions. In
embeds, the brand pill, attribution button, key strip, and loading pulse
each overlapped a MapLibre control at one or more widths from 200px to
1280px; embed-specific CSS scoping fixed all four, hit-tested at five
widths. Hosted builds began carrying `DDM_BUILD_SHA` and a
run-attributable `DDM_BUILD_NONCE`, the foundation the later T04/T08 build
checks rely on.

### 2026-08-19: the smoke volume gets height, and an empty sky gets a sentence

[Pull request 23](https://github.com/atniclimate/dynamic-drought-module/pull/23)
answered the owner's report that volumetric smoke "doesn't seem to work".
It was working. Two separate things made it unreadable, and both are fixed.

- When the issuer returns no plumes, which is an ordinary correct answer
  from a daytime satellite analysis product, the 3D control now says so
  directly instead of leaving the sidebar pill to carry it several
  sections away. The line is derived from the smoke layer's own status, so
  the two surfaces cannot disagree.
- The stylized extrusion heights rose from 320 / 680 / 1320 m to
  800 / 1700 / 3300 m. The reason is measured, not assumed: 25 live plumes
  in the Pacific Northwest averaged 205 to 635 km across, so a Heavy plume
  was a 278:1 sheet standing about 18 percent as tall as the apparent
  terrain relief it had to read against. It now stands about 46 percent,
  and still below the highest terrain, so a stylized density encoding
  never towers over real mountains.
- The heights are now derived once from the scale and the veil opacities
  rather than hand-typed in the paint and again in the legend, so a future
  scale change cannot leave the legend describing a rise the map is not
  drawing. The qualification is unchanged and still refuses the
  measurement reading.

Validation: `npm run gate` clean; the 3D mode and wildfire-semantics
specs green at one worker.

### 2026-08-19: the 3D scene drapes hazard instead of fuel models

[Pull request 22](https://github.com/atniclimate/dynamic-drought-module/pull/22)
answered the owner's request for "only the yellow through red colors to
indicate risk" by changing the issuer rather than the colors.

- The LANDFIRE FBFM40 fuel-model drape left the 3D Fire scene, replaced by
  USFS Wildfire Hazard Potential 2023 from the same service the flat
  `usfs-whp` layer already uses. FBFM40 is a fuel-model classification, not
  a hazard scale, so recoloring its 44 classes into a risk ramp would have
  fabricated a claim its issuer never made. WHP already publishes a
  green-through-red hazard scale; a central Oregon sample measured 86
  percent of pixels in the yellow, orange, and red band.
- The bake found a shipped honesty defect and closed it. The in-app WHP key
  listed five classes in a ColorBrewer ramp while the service renders seven
  classes in different colors, so the key described a different image than
  the map, and the two non-hazard classes (non-burnable land and water)
  painted pixels with no legend entry at all. The key now mirrors the
  issuer's own legend, and the bake re-fetches that legend on every run and
  refuses to build when the two disagree.
- The drape draws with nearest-neighbor resampling. A categorical raster
  blended between classes produces colors that appear in no legend, which
  at the scene's over-zoom would be most of the visible boundary pixels.
- Deploy weight fell by about 12 MB: the 25.7 MB fuel-model archive left
  the tree and the 13.6 MB hazard archive replaced it. The fuels builder
  stays as a restore path, and its upstream drift pin dropped to a warning
  tier so an unmaintained upstream for an unrendered layer cannot fail a
  build.

Validation: `npm run gate` clean, including the new archive against its
16 MB ceiling; the 3D mode, wildfire-semantics, WHP, and view-contract
specs green at one worker.

### 2026-08-19: power infrastructure becomes a layer a person can turn on

[Pull request 21](https://github.com/atniclimate/dynamic-drought-module/pull/21)
answered the owner's second review item. The power context had been a
companion of the 3D Fire scene, which made it always on there, unavailable
everywhere else, unreadable at regional framing, and silent on click.

- It is now an ordinary catalog row, off by default, governed by one toggle
  in every view including the 3D scene. That is a deliberate default
  change: the 3D scene no longer brings power up on its own, and its
  context stamp says so.
- Nothing is fetched below zoom 6; the layer reports the canonical `zoom in
  to load` there rather than painting a continental smear. Above the gate
  the plant points group with their count printed, in a dimmed variant of
  the plant color so a group never reads as one large plant, and a cluster
  click zooms to where the issuer's own records separate.
- Both surfaces answer a click with the issuer's published fields. The
  issuer's unknown sentinels stay unknowns: a `-999999` voltage and a
  `NOT AVAILABLE` owner print as "not published".
- The absence statement grew a reason. Substations and distribution
  circuits are absent because no authoritative public national source
  publishes them, and the interface now says whose decision that is and
  that absence is not evidence that none are present.
- The transmission archive was rebaked from zoom 10 to zoom 11
  (3,827,596 bytes, 3,816 tiles). It stopped there because the shared
  PMTiles writer emits a single root directory, and at zoom 12 that
  directory runs past the 16,384 bytes every reader fetches first,
  producing an archive that opens nowhere. The writer now refuses to write
  such a file; every shipped archive was audited and all are safe.

Validation: `npm run typecheck` and `npm run gate` clean; the power,
3D mode, view-contract, and layer-order specs green at one worker.

### 2026-08-19: map chrome seats, heavier perimeters, honest satellite edges

[Pull request 18](https://github.com/atniclimate/dynamic-drought-module/pull/18)
carried seven presentation changes from the owner's review. Nothing here
changes what a layer claims.

- NIFC perimeter outlines doubled to 3 / 2.8 / 2.4 pixels with their
  ratios intact, so the ranking that separates a mapped wildfire from a
  prescribed burn from an unclassified record is unchanged and only
  legibility moved. Terrain exaggeration in the 3D Fire view doubled to
  2.4; the stylized smoke heights and the issuer's published building
  heights deliberately do not scale with it.
- The satellite toggle and the on-map key joined Share and Reset in the
  desktop top-right column, which is where the E2 ruling already said the
  map buttons belonged as one family. Both are node rehosts through one
  helper, so live content, listeners, control state, and focus ride
  along, and both are desktop-only: the phone shell and the embed keep
  the seats their layouts were designed around.
- The desktop bottom-right corner now reads, right to left: a
  question-mark circle (this application's map-information disclosure,
  which was built for it and only lacked a desktop seat), MapLibre's
  compact attribution circle, and the pre-1.0 preview badge. The
  attribution keeps its own reachable seat, and the badge yields while
  that disclosure is expanded rather than covering it.
- Six live probes replaced a guess about the satellite basemap: areas
  outside coverage were never painting white, they were fully transparent
  with the base map showing through, and the source bounds already
  matched the issuer's declared extent. The real footprint is two GOES
  disks whose union wraps the antimeridian and cannot be one rectangle,
  so the interface states what the edges mean instead of culling tiles
  that might carry data.

Validation: `npm run typecheck` and `npm run gate` clean; the responsive,
embed, satellite, map-information, and wildfire-semantics specs green at
one worker.

### 2026-08-19: a cross-view contract net for the shell

[Pull request 17](https://github.com/atniclimate/dynamic-drought-module/pull/17)
added `tests/view-contracts.yaml` and its runner: a matrix of view
transitions asserting what must stay true as a person moves between the
views, rather than what each view does in isolation.

- Each row is a start URL, an ordered walk (commit a cluster, enter 3D,
  jump a region, reload), and the invariants that must hold at the end:
  URL parameters, which hazard button reads pressed, the document-element
  3D stamps, catalog checkbox state, and chrome presence. Everything
  asserted is production-observable, so the rows bind to the deployed
  artifact.
- The first nine rows caught one belief that was wrong: a granular
  `?layers=` deep link commits no cluster at all. The display is
  `custom` and every hazard button reads unpressed, which is the honest
  chrome for a URL that never claimed a view. The row records the real
  contract.
- The wildfire upstream stubs moved into `tests/wildfire-fixtures.ts`
  so the 3D mode spec and the contract matrix drive one hermetic world.
  No dependency was added.

Validation: `npm run gate` clean; the 3D mode spec and the new matrix
ran 29 passed at one worker, real exit 0.

### 2026-08-19: Overture building structures pilot for the 3D Fire view

[Pull request 15](https://github.com/atniclimate/dynamic-drought-module/pull/15)
added the third issuer-published context layer to the desktop 3D Fire mode:
building structures from the Overture Maps Foundation buildings theme
(ODbL), extruded over the terrain from zoom 13 as a central Oregon pilot.

- The bundled archive is 7,950,204 bytes (189,769 footprints, z13-14,
  release 2026-07-22.0). Two fill-extrusion layers keep height honesty
  visible: footprints with an issuer-published height (72 percent of the
  bake) rise to it in the measured tone; the rest draw visibly dimmer at a
  disclosed placeholder rule. Nothing estimates a height the issuer did
  not publish.
- Provenance flows instead of being hand-typed: the extract writes a
  sidecar the bake requires, the attribution is built entirely from the
  sidecar, and the bake hard-fails if the in-app qualification drifts from
  the extract. A test reads the committed archive's attribution and
  asserts the qualification, coverage note, and embed line agree with it.
- The pilot scope is stated in the coverage note and the legend; the
  full-PNW alternative was declined as a projection of roughly 240 MB of
  z14 tiles (roughly 380 MB at the shipped z13-14 scheme) from the
  measured per-building rate. `scripts/extract-overture-buildings.py
  --bbox` is the documented deployer path for any other region, and the
  pinned release objects expire from the Overture bucket 2026-09-21.

Validation: `npm run gate` clean; the fire3d and wildfire-source-semantics
specs passed 38/38 serially including the archive-vs-disclosures cross-gate
test; the full serial browser run at this stack head reported 792 passed
with only the known SPC preset flake, recorded on the pull request before
merge.

### 2026-08-19: power infrastructure context for the 3D Fire view

[Pull request 14](https://github.com/atniclimate/dynamic-drought-module/pull/14)
added the second issuer-published context layer set to the desktop 3D Fire
mode: transmission lines baked from the archived federal HIFLD dataset plus
live EIA power plants, riding the same `fire3d` activation as non-fatal
companions of the fuels drape.

- The transmission lines are a bundled 2,580,885-byte vector PMTiles archive
  (6,941 features, z0-10), a one-time bake of the ARCHIVED HIFLD dataset via
  the public Esri Federal User Community copy (the HIFLD Open program was
  discontinued 2025-08-26; the item states it is archived, unmaintained,
  last updated 2024-09-30). The in-app qualification carries the mandatory
  currency caveat, the mixed operational-status disclosure, and the honest
  absence statement for substations and distribution lines. Line width
  follows the issuer's seven voltage classes in a single color; unknown
  voltage draws dashed at the thinnest width so missing issuer data never
  reads as a definite low-voltage line.
- Power plants come live from the independently maintained EIA layer in one
  bounded, cancellable request, and the legend prints the issuer's reporting
  Period computed across all features, never the word "live". The EIA layer
  joined the upstream-drift monitor with a content tripwire.
- Every disclosure is composed from what actually rendered: a partial
  degrade names only its live half, in the legend and the embed chip alike.
  Both surfaces seat in a new context-overlay band between condition
  surfaces and event overlays.
- A California-only CPUC High Fire Threat District layer was evaluated and
  declined on license and framing grounds, recorded in
  [`design/fire3d-context.md`](design/fire3d-context.md).

Validation: `npm run gate` clean; the fire3d and wildfire-source-semantics
specs passed 35/35 serially; the full serial browser run at the stack head
reported 792 passed with only the known SPC preset flake, recorded on the
pull request before merge.

### 2026-08-18: LANDFIRE fuel-model drape for the 3D Fire view

[Pull request 12](https://github.com/atniclimate/dynamic-drought-module/pull/12)
added the first issuer-published context layer to the desktop 3D Fire mode
(itself merged earlier the same day in `5679477`): a LANDFIRE 2024 Scott and
Burgan 40 fuel-model (FBFM40) drape over the 3D terrain.

- The drape is a bundled 25,749,464-byte PNG PMTiles archive (z0-8, 512 px)
  whose pixels were rendered by the LANDFIRE ImageServer's own class colors;
  the module chooses no palette and computes nothing from the classes. The
  in-app legend lists the issuer's full 44-class key with a
  snapshot-not-a-prediction qualification, and the bake refuses
  all-opaque-black tiles (the unpopulated-mosaic signature that made LF2025
  unsafe to bake before its December 2026 completion).
- Context layers ride the existing `fire3d` activation as non-fatal
  companions; the active set is observable at `data-ddm-fire3d-context`.
- The 3D Fire control now carries an always-visible non-prediction
  disclosure beside the coverage note, and "digital twin" and "simulation"
  joined the surface-vocabulary banned list. The durable honesty doctrine
  for the context view is tracked in
  [`design/fire3d-context.md`](design/fire3d-context.md).

Validation: `npm run gate` clean; the fire3d and wildfire-source-semantics
specs passed (17 and 15 tests); the full serial browser run before merge is
recorded on the pull request.

### 2026-08-18: mobile map interface refinement

[Pull request 7](https://github.com/atniclimate/dynamic-drought-module/pull/7)
merged the owner-annotated phone refinement to `main` as `eed7967`.

- The mobile Fire key is now a safe-area-aware `#004040` glass card with
  stacked source categories and an overflow-only disclosure.
- Share and Reset form the upper utility stack. ENSO, Fire, Drought, Heat,
  and the one authoritative Satellite control form the lower quick-view
  spine without introducing parallel state.
- The two live MapLibre scale calculations remain dynamic but now read as
  transparent rulers. A non-modal information region derives its content
  from active key, source, status, basemap, and governed Tribal-geography
  state.
- Current Wildfire and Wildfire Complex perimeters share one restrained
  layer-level color pulse. Prescribed and other or unclassified perimeters
  remain static, and reduced motion uses the static midpoint color.

Validation passed `npm run gate`; the serial browser run reported 761 tests
passed plus four geometry checks; and the focused mobile, information,
Satellite, responsive, and wildfire matrix reported 36 tests passed. The
implementation run itself did not deploy. After the pull request merged, the
normal Pages workflow successfully deployed `eed7967` in run
[`32158224612`](https://github.com/atniclimate/dynamic-drought-module/actions/runs/32158224612).

### 2026-08-13: annotated interface refinement

[Pull request 6](https://github.com/atniclimate/dynamic-drought-module/pull/6)
merged two owner-annotation rounds to `main` as `300703e`.

- The Brief shell removes redundant visible summary copy, keeps the current
  condition receipt pinned, and exposes the categorical map key through a
  compact keyboard-accessible disclosure.
- The framing minimap uses hazard-specific fills for both cluster and granular
  URL compositions, keeps Hawaii legible, and presents the drought mean and
  affected-share channels distinctly.
- Recent NOAA GeoColor became the product-default basemap. An absent
  `basemap` parameter selects satellite, while `basemap=default` records the
  explicit satellite-off choice and leaves subdued OpenStreetMap visible.
  This superseded the initial v0.6.25 historical EOX ground treatment.
- Metric and imperial scale controls were joined visually while retaining
  MapLibre's live distance calculations.

Validation passed `npm run gate` and the serial browser run reported 748
passed with 1 intentionally skipped, followed by visual review at desktop,
compact desktop, and phone viewports.

### 2026-08-10: interface integration publication

The initial `v0.6.25` interface release was merged to `main` in `9c35bbf` and
deployed to GitHub Pages on 2026-08-10.

That checkpoint integrated Drought and Wildfire into one responsive Brief rail,
while preserving URL state, mobile behavior, embeds, sidebar controls, and the
six honest layer states. It added disclosed EOX Sentinel-2 2016 historical
ground over an OpenStreetMap fallback, a Natural Earth physical-land framing
minimap, an approximate North American Drought Monitor navigation summary, and
a source-fenced Wildfire overview. The Wildfire overview checks current mapped
National Interagency Fire Center perimeter representations first and may show
qualified static 2023 Wildfire Hazard Potential context only after a verified
zero count. It never treats a failed perimeter request as an all-clear.

At that initial publication, recent NOAA GeoColor imagery was contextual and
opt-in. Hazard Mapping System smoke kept its own source time and meaning.
Follow-up fixes scoped
raster settlement to the selected source, kept the mobile imagery disclosure
clear of controls, and prevented late HeatRisk hydration from overwriting a
user-selected day.

The feature runtime was accepted at
`7b19a9b733c65ed1fe8eeed69427461997fe3f70`. The merged `main` release passed
`npm ci`, `npm run gate`, and `npm run test:serial -- --reporter=dot` with 746
passed, 1 intentionally skipped, and 0 failed across 747 tests in 101 files.
The GitHub Pages workflow repeated the release gate before deployment.

The published application includes regional NIFC framing counts but not the
deferred selected-place NIFC briefing engine. Opening that engine remains a
separately authorized product milestone.
