# Dynamic Drought Module fresh-session handoff

Updated 2026-08-09.

## Start here

The Dynamic Drought Module (DDM) is an embeddable static MapLibre map for
Tribal Nations, state agencies, federal partners, and researchers. The current
checkpoint combines the North American drought minimap, bounded NOAA satellite
context, lifecycle and status corrections, and a locally hardened Cloudflare
Worker candidate.

The user-selected next focus is:

1. integrate one new interface component into the real application;
2. improve the Drought display through that verified interface pattern;
3. improve the Wildfire display as a separate source-honest pass.

Work on one visible milestone at a time. The exact component, reference, target
surface, and supported viewports have not been supplied. Ask for those before
implementation rather than guessing.

## Read before changing code

| Path | Authority |
| --- | --- |
| `AGENTS.md` | Stewardship, product, engineering, and verification rules. |
| `src/config/layers.ts` | Authoritative layer definitions and source names. |
| `src/config/clusters.ts` | Drought and Wildfire horizon recipes. |
| `src/state/cluster-service.ts` | Committed hazard, horizon, intended-layer, status, timeline, and summary snapshot. |
| `src/state/display-summary.ts` | Status-derived user-facing display truth. |
| `src/ui/island/shell.tsx` | Preferred desktop Brief seam for a new Preact component. |
| `src/ui/island/index.tsx` | Lazy island boundary and alternate component host orchestration. |
| `src/ui/island/minimap.tsx` | Monthly North American Drought Monitor overview and camera controls. |
| `src/ui/island/strip-metrics.ts` | Existing compact Drought and fire metrics requiring absence review. |
| `src/ui/map-key.ts` | Existing map legend selection and refresh behavior. |
| `src/ui/sidebar.ts` | Legacy sidebar boot, URL synchronization, and mobile behavior. |
| `src/styles/app.css` | Existing responsive tokens and desktop, mobile, and embed boundaries. |
| `src/layers/nadm-drought.ts` | Good pattern for validated and atomic layer installation. |
| `src/layers/nifc-fires.ts` | NIFC wildfire and prescribed-fire perimeter behavior. |
| `src/layers/hms-smoke.ts` | HMS smoke plume display. |
| `src/layers/spc-fire-weather.ts` | Storm Prediction Center Day 1 outlook display. |
| `src/layers/usfs-whp.ts` | Static Wildfire Hazard Potential context. |
| `src/impact/fire-context.ts` | Existing selected-place fire context and its semantic limits. |
| `docs/SUCCESSOR_PLAN.md` | Current product sequence and longer-term engine boundaries. |

The July handoffs under `planning/2026-07-successor-handoffs/` are historical
records, not current instructions.

## Verified checkpoint

- The NADM minimap covers the United States, Canada, and Mexico without claiming
  classifications outside the source domain. It distinguishes `None`, missing,
  and not analyzed, and labels the Nunavut proxy exclusion `live (partial)`.
- `framing=all` is durable URL state. Alaska uses one valid antimeridian fit
  helper shared by boot and minimap interactions.
- NOAA GeoColor is opt-in contextual imagery. It is bounded, cancellable,
  validated before install, URL-sticky, and never presented as drought, smoke,
  fire, or heat diagnosis.
- Shared response-body reads are cancellable and time-bounded. Raster status
  waits for a complete load cycle or deadline, and Wildfire Hazard Potential
  does not report live before a tile succeeds.
- Basemap subscriptions release correctly, Playwright always uses a fresh
  preview build, and deployment CI runs the project gate.
- Worker candidate `2026-08-09-route-hardening-v3` uses exact host and path
  routes, redirect revalidation, bounded body reads, byte-transparent
  responses, strict Cross-Origin Resource Sharing, and bounded safe caching.
- Production still runs Worker v2. Live Cloudflare checks and direct-versus-
  proxy byte hashes passed for AWDB, AgriMet, Hydromet, NWRFC, USDM DSCI, WHP,
  and NWS. Wrangler OAuth works; this Worker requires no API secrets. Worker v3
  was not deployed.

Verification against the current tree:

- `npm run gate`: passed.
- `npm run test:serial -- --reporter=dot`: 686 of 686 passed on a fresh server.
- Focused Worker policy suite: 14 of 14 passed.
- Root and Worker typechecks: passed.
- Worker deployment dry run and local health, allowed-route, and rejected-route
  probes: passed.
- Browser checks for default state, Hawaii, `framing=all` reload, embed mode,
  satellite mode, and live WHP: passed without console warnings.
- Root production audit and complete Worker audit: zero vulnerabilities.
- `git diff --check` and drift-checker syntax: passed.

Known external limits:

- The aggregate drift command remains nonzero when unrelated USGS or NLCD
  services time out and because optional soil overflow intermediates exceed
  422 MB and are absent locally. Cloudflare-specific rows passed.
- Five development-only advisories remain through `mapshaper`; npm offers only
  a breaking forced downgrade.
- GitHub issue 5 tracks the scheduled upstream monitor's missing Python
  environment. It is not a Cloudflare failure.

## Next milestone: new interface component

First obtain the component reference or specification and settle:

- whether it is a control or readout;
- desktop Brief, mobile sheet, embed, studio, selected-place panel, or map
  control placement;
- selected-place, viewport, framing, or national scope;
- whether any choice is durable URL state;
- external code, font, license, network, authentication, or tracking
  implications.

For a desktop Brief component, prefer a named Preact child of
`src/ui/island/shell.tsx`. Consume `CommittedShellSnapshot` and call existing
service doors such as `requestCluster` and `requestHorizon`. Do not own a
second layer-state machine or render optimistic intent as live data. Keep the
component within an existing band or popover unless the user explicitly
accepts more permanent density.

The desktop shell is hidden on mobile and in embeds. If the component must
appear there, design those hosts explicitly rather than assuming the shell
placement covers them. A durable choice must survive URL reload, Back, embed,
and canonical boot synchronization. Ephemeral disclosure and focus state
should remain local.

Minimum acceptance:

- all six canonical states render distinctly;
- source, edition, time, coverage, and qualifications remain visible;
- keyboard, focus restoration, touch target, reduced-motion, and live-region
  behavior match existing controls;
- no broad navigation, CSS, or component rewrite;
- network work, if any, validates unknown data and is cancellable,
  time-bounded, and unable to revive after teardown;
- the lazy bundle boundary and activation budgets remain green.

## Drought display pass

Use the new component pattern to make the active Drought product easier to
understand without blending products:

- Keep weekly USDM, monthly NADM, monthly CDM, Province of British Columbia
  basin levels, CPC outlooks, and gridded indices separately named and timed.
- Keep the minimap specifically monthly NADM. Do not recolor it for Wildfire or
  derive a regional severity from a selected hazard button.
- Do not convert zero rendered USDM polygons into a confident `None` claim
  without an explicit analyzed-area mask. Prefer a literal statement such as
  "No D0 through D4 polygon rendered here."
- Drive the readout and legend from committed status-derived truth. A loading,
  unavailable, partial, or no-data layer must not receive a confident
  "Showing" claim.

Choose one bounded Drought display outcome with the user before editing.

## Wildfire display pass

Preserve the distinct meanings and horizons:

- NIFC perimeters are observed incidents. Separate or filter prescribed fire
  rather than painting it as an active wildfire.
- HMS smoke is an analyst-derived plume product. Unknown density must not be
  silently presented as Light smoke.
- SPC Day 1 is an outlook. Show its valid window and explain or reject unknown
  categories.
- WHP is static 2023, 270-meter, conterminous-United-States potential context,
  not current conditions, an incident, or a forecast.
- Source-specific no-data copy must describe what the national feed returned,
  not imply the current viewport is safe.
- Do not create a combined DDM fire score, ignition prediction, containment
  claim, or all-clear.

Presentation work in this pass does not automatically authorize the deferred
selected-place NIFC engine or a `v0.7.0` release.

## Verification for the next session

Run the narrowest component and source tests while developing. At minimum,
cover the new view model across all six states, malformed and delayed data,
retry and cancellation, URL reload, and `?embed=true` where relevant.

Likely focused suites include:

- `tests/s4-shell.spec.ts`
- `tests/display-summary.spec.ts`
- `tests/island-premount.spec.ts`
- `tests/url-state.spec.ts`
- `tests/s2-url-migration.spec.ts`
- `tests/s4-minimap.spec.ts` only when the minimap changes
- affected Drought, NIFC, HMS, SPC, WHP, mobile, and embed specifications

Finish any shared navigation, map lifecycle, state, or release-readiness
change with `npm run gate` and `npm run test:serial`.

## Git true-up boundary

The intended upstream is
`https://github.com/atniclimate/dynamic-drought-module.git`. Local
`feature/heatrisk-legibility` contains six unpublished commits beyond the
shared `e1a9084` base. GitHub `main` has one independent scheduled ENSO
snapshot commit, `9983251`.

This checkpoint must be published only to
`origin/feature/heatrisk-legibility`. Do not push `main`, tag, deploy Pages,
or deploy the Worker. Before new feature work, confirm the worktree is clean
and the feature branch tracks its remote. Reconcile `origin/main` only as a
separate clean-tree step and rerun the gate afterward.

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
  ordinary Git history. Do not add a review harness, phase clock, queue, or
  parallel status ledger.
