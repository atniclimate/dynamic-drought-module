# Dynamic Drought Module fresh-session handoff

Updated 2026-08-10.

## Start here

The Dynamic Drought Module (DDM) is an embeddable static MapLibre map for
Tribal Nations, state agencies, federal partners, and researchers.

The completed and pushed `0.6.25` feature checkpoint is
`feature/heatrisk-legibility` at runtime acceptance SHA
`7b19a9b733c65ed1fe8eeed69427461997fe3f70`. A later documentation-only
true-up commit is the pushed branch tip; reproduce runtime acceptance from
the SHA above.

The final integration sequence is:

- `f29aa79` `feat: integrate drought and wildfire interface`
- `4dab788` `fix: settle raster status per source`
- `2c67637` `fix: keep imagery chip clear of map controls`
- `10c13de` `fix: preserve HeatRisk sequence interactions`
- `7b19a9b` `fix: clear live imagery copy on mobile`

This is a feature checkpoint and runtime acceptance point, not a release.
There is no pull request, merge to `main`, tag, deployment, or version
change authorized or completed by this true-up.

## Completed product outcome

### Integrated interface

- The real desktop Brief shell now carries committed hazard and time-horizon
  controls backed by the existing cluster and timeline services. It reports
  committed, status-derived display truth rather than optimistic button state.
- Drought and Wildfire are distinct compositions. Horizon changes re-resolve
  the committed recipe coherently, while a custom granular layer set remains
  custom and is not relabeled as a clean hazard composition.
- The responsive and embed seams retain their existing hosts and URL behavior.
  Explicit mobile Fire and quick Fire risk actions use the same bounded
  Wildfire scene policy as the desktop action.

### Drought truth and minimap

- Weekly United States Drought Monitor rendering no longer turns an empty
  D0-D4 polygon result into an all-clear. The visible claim is the literal
  `No D0-D4 polygon rendered here.` unless a source-supported analyzed-area
  statement is available.
- Drought products remain separately named and timed. Weekly USDM, monthly
  NADM and CDM, Province of British Columbia basin levels, and CPC outlooks
  are not blended into one invented drought score.
- The North America minimap retains the authored editorial framing geometry,
  clips its presentation to pinned Natural Earth 1:50m physical land and
  lakes, and uses monthly NADM polygons for an explicitly approximate
  area-weighted navigation summary. It labels the result as an inference,
  keeps `None`, missing, and not analyzed distinct, exposes the Nunavut proxy
  exclusion as partial coverage, and adds a non-color D1-D4 impact channel.

### Wildfire truth and minimap

- NIFC Wildfire, Wildfire complex, Prescribed fire, and other mapped incident
  types are classified and presented without painting prescribed fire as an
  active wildfire.
- HMS smoke uses distinct Light, Medium, Heavy, and unclassified presentation.
  Missing or unknown density no longer falls through to Light, and smoke
  opacity is disclosed as presentation rather than ground-level air quality.
- SPC remains a Day 1 fire-weather outlook with its own valid period. United
  States Forest Service Wildfire Hazard Potential remains static 2023,
  270-meter United States strategic context, including its separately
  published Alaska and Hawaii coverage, not current conditions or a forecast.
- The Wildfire minimap first checks current mapped NIFC wildfire perimeters
  for each authored framing, excluding prescribed fire. An unresolved current
  check stays unknown and does not silently substitute WHP. Only after a
  resolved zero-perimeter check may the display use qualified WHP context;
  zero mapped perimeters never means no wildfire.
- WHP percentages are scoped to classified United States land. Cross-border
  framing and no-coverage states remain explicit.

### Historical and recent imagery

- The default shared ground is disclosed as EOX Sentinel-2 2016 historical
  context, with subdued OpenStreetMap underneath and an honest fallback if the
  bounded probe or requested tiles do not succeed.
- Recent imagery is opt-in NOAA NESDIS merged GOES GeoColor. Activation
  validates a bounded recent catalog, probes candidates newest first, and pins
  the selected object and observation time so one viewport cannot mix frames.
- An explicit desktop Wildfire, mobile Fire, or quick Fire risk action requests
  recent GeoColor. A bare URL restore, boot-time cluster inference, horizon
  change, or layer-status change does not silently override a visitor's
  basemap choice. Manually turning Recent off remains authoritative.
- If recent imagery fails, the default map is restored without dropping the
  requested Wildfire layer intent.
- NOAA GeoColor is contextual imagery. HMS smoke remains a separate,
  independently timed analyst-drawn plume product and is never inferred from
  the basemap.
- Historical and recent imagery chips are polite atomic status regions and
  remain clear of map controls in the verified responsive layouts.

### Raster status and HeatRisk

- Completeness-aware raster status can settle from target-source
  `sourcedata` evidence without waiting for unrelated global map idle. It
  still requires selected-frame request evidence and distinguishes complete,
  partial, and failed cycles.
- The HeatRisk seven-day sequence no longer rebuilds its live buttons for a
  status-only raster event while an identify read is pending or cached. A
  native click therefore reaches the live delegated handler, the URL-selected
  day advances, and late superseded hydration cannot restore the old
  classification.
- Existing HeatRisk source honesty remains intact: exact advertised frame
  times, exact-time identify reads, experimental labeling, no-data handling,
  activation generations, cancellation, and valid-period copy.

## Fresh-clone runtime acceptance

The following receipts were collected from a clean fresh clone at
`7b19a9b733c65ed1fe8eeed69427461997fe3f70`:

- `npm ci`: PASS, 281 packages installed. npm reported 5 known
  vulnerabilities: 1 moderate and 4 high.
- `npm run gate`: PASS.
- `npm run test:serial -- --reporter=dot`: PASS, 746 passed, 1 intentionally
  skipped, and 0 failed across 747 tests in 101 files, 1095.9 seconds command
  wall time (18.2 minutes reported by Playwright).

The dependency advisories are recorded facts, not resolved by this checkpoint.
Do not restate this acceptance as a zero-vulnerability result.

Final in-app browser receipts are retained under
`.playwright-cli/interface-integration/true-up-7b19a9b/`. They cover the
desktop Drought scene and physical minimap, explicit Wildfire entry with live
NOAA GeoColor and independently timed HMS smoke, the Atlantic ocean door and
ENSO camera transition, and the 390 by 844 mobile Fire scene. The live mobile
copy has a measured 10 pixel gap from `Recent` and does not intersect the
expanded attribution disclosure.

During that browser pass, the live NIFC perimeter request exhausted its
bounded request twice. The app retained NOAA and HMS evidence, demoted the
composition to a custom partial display, and did not invent a red region or a
WHP fallback. This is honest failure behavior and current upstream-availability
evidence, not a deterministic-suite failure.

## Next-session decision

Patrick makes the next product decision before more implementation:

1. close `0.6.x` and separately authorize pull-request and release review; or
2. name one more bounded, visible product outcome.

Choosing to close `0.6.x` does not by itself authorize a pull request, merge,
tag, deployment, Worker change, or version change. Those remain separate
decisions. If Patrick names another outcome, keep it to one visible milestone
with explicit target surfaces and acceptance criteria.

## Git and publication boundary

- The accepted runtime is `7b19a9b733c65ed1fe8eeed69427461997fe3f70`,
  pushed on `feature/heatrisk-legibility`; the later documentation-only tip
  carries this true-up record.
- `origin/main` advanced separately to scheduled ENSO snapshot commit
  `81f2c71b2a8eae2b5a52738a09046d215d5398b1`. At runtime acceptance,
  `origin/main...7b19a9b` was 2 commits unique to main and 12 unique to the
  feature, with merge base `e1a9084`. No reconciliation was performed.
- Do not push `main`, open a pull request, merge, tag, deploy Pages, deploy
  the Worker, or change the package version without explicit authorization.
- `planning/Dynamic_Drought_Module_UI_Integration_Long_Run_Prompt_2026-08-09.md`
  is user-supplied execution input. It remains intentionally untracked and
  must stay excluded from commits.

## Read before changing code

| Path | Authority |
| --- | --- |
| `AGENTS.md` | Stewardship, product, engineering, and verification rules. |
| `src/config/layers.ts` | Authoritative layer definitions and source names. |
| `src/config/clusters.ts` | Drought and Wildfire horizon recipes and explicit recent-imagery preference. |
| `src/state/cluster-service.ts` | Committed hazard, horizon, intended-layer, and status snapshot. |
| `src/ui/island/shell.tsx` | Integrated desktop Brief controls and rehost lifecycle. |
| `src/ui/island/minimap.tsx` | Drought and Wildfire navigation overview. |
| `src/state/minimap-drought.ts` | Monthly NADM framing summaries and coverage semantics. |
| `src/state/minimap-wildfire.ts` | Current mapped-perimeter checks and qualified WHP fallback. |
| `src/config/wildfire-presentation.ts` | NIFC, HMS, and WHP presentation contracts. |
| `src/map/historical-ground.ts` | Disclosed historical ground and fallback lifecycle. |
| `src/map/satellite.ts` | Recent pinned NOAA GeoColor selection and refresh lifecycle. |
| `src/map/basemap-switcher.ts` | Explicit basemap request and failure-reversion seam. |
| `src/ui/heatrisk-sequence.ts` | HeatRisk sequence interaction and generation safety. |
| `src/util/raster-status.ts` | Shared raster request-cycle status evidence. |
| `docs/SUCCESSOR_PLAN.md` | Product sequence and longer-term engine boundaries. |
| `docs/design/interface-integration/MODULE_TRACKING.yaml` | Integration scope, evidence, and module tracking. |

## Non-negotiables

- Do not redistribute Tribal, Treaty, or other sovereign-jurisdiction
  polygons. Keep deployer-owned sovereign files empty without explicit
  authorization.
- Preserve agency Treaty representation caveats.
- Keep the application static and the optional Worker an allowlisted,
  body-transparent Cross-Origin Resource Sharing shim.
- Add no proprietary tile provider, authentication, tracking, analytics,
  telemetry, or embedded secret.
- Preserve `?embed=true`, URL state, sidebar controls, mobile behavior,
  iframe operation, attribution, and the six layer states.
- Keep non-trivial network work cancellable and time-bounded.
- Keep sovereign-reference outlines visible above condition surfaces.
- Capitalize Tribe, Tribal, and Treaty appropriately. Do not author the U+2014
  em dash.
- Preserve strict TypeScript, named exports, CSS custom-property tokens, and
  ordinary Git history.
