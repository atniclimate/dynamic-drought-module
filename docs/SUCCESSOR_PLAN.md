# DDM successor plan

Updated 2026-08-10.

This is the concise product plan for the successor repository. It is not a
phase ledger, review queue, or second implementation clock. Ordinary Git
history remains the durable record of completed work.

## Product objective

Help a person answer:

> What does this mean for us, here, now?

The Dynamic Drought Module (DDM) must remain static, embeddable, mobile-first,
source-honest, and maintainable by a small team. Tribal sovereignty, Treaty
representation caveats, source provenance, cancellation, URL state, and the
six canonical layer states remain invariants.

## Current successor state

### Accepted pushed 0.6.25 interface integration

The `0.6.25` interface integration is complete, accepted, and pushed on branch
`feature/heatrisk-legibility` at runtime acceptance receipt
`7b19a9b733c65ed1fe8eeed69427461997fe3f70`.

The accepted commit sequence is:

- `f29aa79 feat: integrate drought and wildfire interface`
- `4dab788 fix: settle raster status per source`
- `2c67637 fix: keep imagery chip clear of map controls`
- `10c13de fix: preserve HeatRisk sequence interactions`
- `7b19a9b fix: clear live imagery copy on mobile`

This checkpoint delivers:

- One unified desktop Brief rail in the established decision order: hazard
  view, conditions in view, current region, map context, time, share, and
  refinement. It rehosts the existing controls and state rather than creating
  a parallel controller.
- Historical ground from EOxCloudless Sentinel-2 2016, with subdued
  OpenStreetMap beneath it as disclosed fallback and gap context. Historical
  ground is explicitly not current conditions.
- A recognizable North America minimap clipped to bundled Natural Earth 1:50m
  physical land. It retains the existing ATNI-authored editorial subregions,
  does not draw state or Province boundaries, keeps Hawaii as an inset, and
  makes the Atlantic, Pacific, and Arctic ocean controls explicit.
- A Drought minimap whose fill is an approximate cosine-latitude-weighted
  North American Drought Monitor ordinal mean, with exact half-step ties kept
  at the less severe class. A separate impact outline carries the D1 through
  D4 share so the mean fill cannot hide meaningful drought extent. Mode,
  distribution, partial coverage, and not-analyzed qualifications remain
  available.
- A Wildfire minimap with strict source precedence. A positive current mapped
  National Interagency Fire Center (NIFC) wildfire-perimeter count is the red
  condition. Only a verified zero count may fall through to the static 2023
  United States Forest Service Wildfire Hazard Potential overview. A failed
  NIFC count remains unavailable and never becomes a hazard-potential claim.
  The static fallback uses strict greater-than thresholds and carries United
  States-only partial or no-coverage states.
- Recent National Oceanic and Atmospheric Administration (NOAA) Geostationary
  Operational Environmental Satellite GeoColor context only after an explicit
  user action that requests it. Boot, URL restore, horizon reconciliation, and
  direct layer toggles do not infer that basemap choice. Hazard Mapping System
  smoke keeps its own source clock and meaning; satellite-ground time never
  substitutes for smoke time.
- Raster settlement scoped to the source being observed, so unrelated raster
  errors cannot falsely degrade or retire the selected source.
- HeatRisk sequence interactions preserved while current-place hydration is
  pending. A superseded initial read can no longer overwrite the user's chosen
  day.
- The existing mobile bottom sheet, compact and 200-pixel embeds, URL-as-state,
  framing links, hazard and horizon controls, accessible names, cancellation,
  and teardown behavior preserved through the integration.

No pull request, `main` update, tag, deployment, publication, Worker change,
or version change was performed or authorized by this checkpoint.

### Exact fresh-clone acceptance receipts

The final runtime receipt was verified from a clean fresh clone at
`7b19a9b733c65ed1fe8eeed69427461997fe3f70`:

- `npm ci`: PASS.
- `npm run gate`: PASS.
- `npm run test:serial -- --reporter=dot`: PASS, 746 passed, 1
  intentionally skipped, and 0 failed across 747 tests in 101 files. Command
  wall time was 1095.9 seconds; Playwright reported 18.2 minutes.
- The acceptance clone remained clean after verification.

Final in-app browser receipts are retained at
`.playwright-cli/interface-integration/true-up-7b19a9b/`. They cover 1440,
721, 720, 390 by 844, 844 by 390, 400 by 600 embed, and 200 by 600 embed
surfaces; desktop Drought and Wildfire; the physical minimap; an Atlantic
ocean-to-ENSO camera transition; and the live mobile imagery qualification.
The settled 390-pixel scene has no imagery-chip intersection with attribution
or `Recent`, and preserves a 10 pixel gap from that control.

The browser pass also recorded two bounded live NIFC perimeter timeouts. The
app did not turn them into a red minimap claim or unlock static WHP. That is
honest failure behavior and upstream-availability evidence, not a failure of
the deterministic acceptance suite.

### External state carried forward, not reverified in this true-up

The following facts are unchanged historical deployment records. The final
local true-up did not reverify or alter them:

- The public GitHub Pages application remains `v0.6.24` at
  `https://atniclimate.github.io/dynamic-drought-module/`. Pages workflow run
  `30513860839` published receipt `e1a9084`, containing release merge
  `83fa417` and its corrected publication record.
- The live Cloudflare Worker remains revision
  `2026-07-29-nws-point-heat-v2` at
  `https://ddm-proxy.atniclimate.workers.dev`, Cloudflare version
  `db84d0d3-454f-4fa0-bbb5-6c068025ddf9`.
- The local `2026-08-09-route-hardening-v3` Worker candidate remains
  undeployed. It narrows policy to exact runtime paths, bounds body
  consumption, and hardens header, redirect, and cache handling.
- GitHub `main` advanced independently to scheduled ENSO snapshot commit
  `81f2c71b2a8eae2b5a52738a09046d215d5398b1`. At runtime acceptance,
  `origin/main...7b19a9b` was 2 commits unique to main and 12 unique to the
  feature, with merge base `e1a9084`. This work did not reconcile or push
  `main`.

## Next-session decision fork

There is no automatic continuation from the accepted `0.6.25` checkpoint.
Patrick must choose one of two bounded paths:

1. Explicitly close the `0.6.x` interface line and separately authorize a
   pull-request and release review of the accepted checkpoint.
2. Name one bounded, visible `0.6.x` outcome, with its target surface,
   supported viewports, state contract, and acceptance evidence.

Closing the interface line does not itself authorize a pull request, merge,
tag, Worker deployment, Pages deployment, publication, or version assignment.
Those remain separate external actions.

The selected-place NIFC active-perimeter briefing remains deferred to
`v0.7.0`. It does not open until Patrick explicitly closes `0.6.x`, and it is
not implied by a release review of `0.6.25`.

## Accepted source and presentation boundaries

Keep the final interface behavior source-honest:

- Weekly United States Drought Monitor, monthly North American Drought
  Monitor, monthly Canadian Drought Monitor, Province of British Columbia
  levels, Climate Prediction Center outlooks, and gridded indices remain
  separately named and timed.
- The Drought minimap mean is an explicitly approximate navigation overview,
  not an issuer-published regional class or a local drought determination.
- NIFC perimeters are current mapped incident representations. A zero count is
  not an all-clear, and an unavailable count cannot unlock the static fallback.
- Wildfire Hazard Potential is long-term strategic context reflecting the
  source edition's landscape inputs. It is not current fire conditions or a
  forecast.
- Hazard Mapping System smoke, NIFC incidents, Storm Prediction Center
  outlooks, NOAA satellite ground context, fuels, vegetation, and drought
  retain independent clocks, coverage, legends, and absence states.
- The minimap subregions remain ATNI-authored editorial camera framings, not
  administrative, jurisdictional, Tribal, Treaty, or ecological boundaries.
- Natural Earth physical land supplies coastline presentation only. Do not add
  state, Province, or other administrative boundary clutter to the minimap.
- The six honest layer states remain `loading`, `live`, `live (partial)`,
  `unavailable`, `no data`, and `zoom in to load`.

## Deferred v0.7.0 selected-place NIFC milestone

If Patrick explicitly opens `v0.7.0`, the first bounded engine milestone is a
selected-place NIFC active-perimeter briefing. It must remain independent of
the regional minimap metric delivered in `0.6.25`.

Required boundaries:

- Resolve support from canonical selected-place geography and an independent
  per-source capability contract.
- State the queried spatial support and the current-perimeter temporal
  meaning. Label a point buffer as an area around the point, never as the
  selected boundary.
- Keep requests cancellable and time-bounded through body consumption. Cache
  only completed validated responses in a bounded, short-lived cache.
- Validate completeness before reporting absence. Treat transfer limits or
  incomplete selection as partial.
- Drop superseded selections. Report unsupported geography and source failure
  as unavailable; report zero intersecting mapped perimeters as no data, never
  as safety or containment.
- Do not activate smoke, alerts, outlooks, drought, vegetation, fuels, or
  long-term hazard context as a side effect, and do not create a DDM fire-risk
  score.
- Verify desktop, mobile, embed, and 200-pixel embed presentation, plus focused
  cancellation, cache, partial, absence, and source-isolation cases.

## Longer-term engine directions

These remain directional backlog, not authorization to develop in parallel.

Drought:

- Give each drought product independent geography, time, capability, and
  honest absence.
- Add selected-place gridded values only after support, native time step,
  missing-value behavior, and transport are verified. Preserve issuer units
  rather than converting the result into a DDM class.

Heat:

- Preserve the separation among National Weather Service observations, grid
  guidance, forecasts, alerts, and HeatRisk.
- Show local human-readable time before raw issuer intervals and keep action,
  provenance, and uncertainty available through progressive disclosure.
- Keep Climate Prediction Center week-two extremes guidance a candidate until
  transport, schema, cadence, coverage, and qualifications are verified.

Fire:

- After the deferred selected-place NIFC milestone, source-fence alerts,
  smoke, outlooks, and Wildfire Hazard Potential independently.
- Do not infer ignition, containment, exposure, or an all-clear from one
  source's absence.

Water:

- Correct blank numeric parsing and issuer-date labeling before expanding
  water-supply presentation.
- Replace silent representative-point substitution with explicit basin or
  named-station support.
- Keep telemetry, snow water equivalent, precipitation, soil moisture,
  reservoir state, and forecasts separate.

## Development and operations rules

- Work on one user-visible milestone at a time.
- Use one ordinary issue with an outcome and acceptance criteria, not a new
  harness or review system.
- Make small, coherent commits at durable checkpoints.
- Run direct tests while implementing, affected Playwright coverage next,
  `npm run gate` near completion, and the full serial suite for a release
  candidate.
- Treat screenshots, conformance notes, and test output as receipts, not as a
  parallel status system.
- Do not carry a large uncommitted cross-cutting change into the next
  milestone.
- Do not publish, deploy, tag, change external services, or assign a new
  version without explicit authorization.
- Preserve strict TypeScript, named contracts, lazy activation, cancellation,
  and output escaping at every upstream-data rendering boundary.
- Keep proprietary providers, authentication, analytics, telemetry, and
  tracking out of the static application.

## Confidence and validation focus

High confidence at the accepted runtime:

- fixture-backed regression behavior;
- source-scoped raster settlement;
- cancellation and stale-result protection;
- Drought and Wildfire minimap source precedence;
- explicit-action satellite policy and independent smoke time;
- HeatRisk day-selection preservation;
- URL, mobile, and embed contracts covered by the green 747-test matrix.

Still needs evidence:

- real-device behavior across the full responsive matrix;
- upstream reliability after publication;
- nationwide selection flows outside the Pacific Northwest;
- user comprehension with Tribal natural-resource staff, emergency managers,
  and agency users.

A green suite is evidence for code behavior, not proof of upstream
reliability, production configuration, or user comprehension.

## Acronym reference

- CPC: Climate Prediction Center
- CSS: Cascading Style Sheets
- DDM: Dynamic Drought Module
- HMS: Hazard Mapping System
- NIFC: National Interagency Fire Center
- NOAA: National Oceanic and Atmospheric Administration
- NWS: National Weather Service
- SPC: Storm Prediction Center
- USDM: United States Drought Monitor
- URL: Uniform Resource Locator

## Current boundaries

- Start the next session from the accepted runtime receipt and this decision
  fork. Do not reopen completed interface integration by default.
- Do not begin the selected-place NIFC engine until Patrick explicitly closes
  `0.6.x` and opens the `v0.7.0` milestone.
- Do not add a DDM severity score, blended hazard score, ignition prediction,
  or all-clear.
- Do not redistribute Tribal, Treaty, or other sovereign-jurisdiction
  polygons. Preserve all sovereignty and representation caveats.
- Do not add administrative boundaries to the physical-land minimap.
- Do not perform a broad redesign, navigation rewrite, CSS cleanup, or module
  refactor without a bounded visible outcome.
- Do not create a phase clock, review queue, change ledger, process harness,
  or parallel status system.
- No pull request, `main` push, tag, deployment, publication, Worker change,
  or version change is authorized by this plan.
