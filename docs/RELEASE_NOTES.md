# Release notes

## v0.6.25

`v0.6.25` is the package version and, since 2026-08-28, the release tag: the
annotated tag `v0.6.25` points at `4d55845a9e245c48fd16f9da403e659393044568`
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

Current source baseline, observed 2026-08-29: `main` is at
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

### 2026-08-29: every suite boot answers the sovereign boundary queries from synthetic fixtures

Roadmap task DDM-P1-T08 asks for three things; pull request 34 (`56dd46a`)
delivers the first two and leaves the trace/screenshot flip to the owner.
Twenty specs moved onto the shared `gotoApp` boundary stub
(`tests/tribal-fixtures.ts`) and their duplicate per-spec routes were
deleted; `tests/boundary-stubs.spec.ts` and
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
schedule's first real receipt was a hand-dispatched run (33246718167, for
`214c26e`), taken the same day the workflow merged.

### 2026-08-29: the live proof survives a newer push

Pull request 31 (`1d82b59`) moved post-deploy verification into its own
`verify-live.yml` workflow with its own concurrency group, so a newer push
to `main` no longer cancels an in-flight verification for the build still
live. The residual gap this left, a deploy cancelled during publish
getting no receipt either way, closed two pull requests later when pull
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
42 MB against its 15 s budget); and the upstream drift monitor now fails
on a missing ArcGIS `outFields` field across 19 covered layer paths, the
kind of check that would have caught `attr_DailyAcres` going unserved for
months. `docs/ROADMAP.yaml` proposed `DDM-P0-T12` for owner ratification.

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
