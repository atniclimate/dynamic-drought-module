# S03 edge ledger, post-S02g

Tree: main 5b40dfb (2026-09-07), after merge 6a070eb (S02g).
Method: `.planning/RECONCILIATION.md` section 6 rules, re-run on this tree.
An `import type` statement forms no edge (imports.json excludes them); a dynamic
`await import()` DOES form one (imports.json records hydrate.ts -> enso.ts, and
that import was already dynamic at 3289354, pre-S02g).

Columns: importer path | imported path | exported symbol | task edge(s) served

## Source 6, src/impact/enso.ts (999 lines) -- OUTBOUND

- src/impact/enso.ts:30 | src/config/urls.ts | URLS (ensoIndicesLocal, urls.ts:985) | none, hub rank 2
- src/impact/enso.ts:31 | src/util/fetch.ts | fetchWithBudget | none, hub rank 1
- src/impact/enso.ts:32 | src/util/guards.ts | isObject | none, hub rank 9
- src/impact/enso.ts:33 | src/ui/charts.ts | oniLineSvg, ensoPlumeSvg | P12-T02 <- P7-T02; P12-T03 <- P7-T02; P12-T02 <- P13-T02; P12-T03 <- P13-T02
- src/impact/enso.ts:34 | src/impact/evidence.ts | makeClaim | P12-T02 <- P7-T01 (done); P12-T03 <- P7-T01 (done)
- src/impact/enso.ts:35 | src/impact/sources.ts | type SourceResult | NO EDGE, type-only
- src/impact/enso.ts:36 | src/impact/types.ts | type BoundarySelectionContext | NO EDGE, type-only

## Source 6, src/impact/enso.ts -- INBOUND (only two importers in all of src/)

- src/impact/hydrate.ts:101 | src/impact/enso.ts | fetchEnsoClaims (dynamic) | P7-T02 <- P12-T02; P7-T02 <- P12-T03; P7-T03/T04/T05/T06 <- P12-T02, P12-T03
- src/ui/island/minimap.tsx:594 | src/impact/enso.ts | readEnsoPhaseLabel (dynamic) | P11-T01 <- P12-T02; P11-T01 <- P12-T03
- src/ui/island/minimap.tsx:94 | src/impact/enso.ts | type EnsoPhaseLabel | NO EDGE, type-only

## Source 7, src/impact/matrix.ts (315 lines, NEW in S02g) -- OUTBOUND

- src/impact/matrix.ts:27 | src/config/source-capability.ts | type BriefingSourceKey | NO EDGE, type-only
- src/impact/matrix.ts:28 | src/impact/types.ts | type HazardCell, HazardKey, Horizon, HorizonKey, HorizonStatus, SourcedClaim | NO EDGE, type-only

matrix.ts has ZERO value imports, so it forms no outbound edge at all.
It is also UNATTACHED in .planning/TRACE.yaml: no task claims it.

## Source 7, src/impact/matrix.ts -- INBOUND

- src/impact/briefing.ts:18 | src/impact/matrix.ts | createHorizonCells | no task edge (matrix.ts unattached)
- src/impact/hydrate.ts:44-48 | src/impact/matrix.ts | applyMatrix, markHorizonCells, MATRIX_LANE_KEYS, type MatrixLaneKey | no task edge (matrix.ts unattached)
- src/ui/impact-panel-runtime.ts:30 | src/impact/matrix.ts | HAZARD_KEYS, markHorizonCells | no task edge (matrix.ts unattached)
- tests/briefing-matrix.spec.ts:33 | src/impact/matrix.ts | (spec) | not in the module graph
- tests/heat-h1-heatrisk.spec.ts:9-10 | src/impact/matrix.ts | fillCell, types | not in the module graph

## Source 7, src/impact/hydrate.ts (324 lines, reshaped by S02g) -- OUTBOUND

- src/impact/hydrate.ts:31-40 | src/impact/sources.ts | fetchCpcOutlookClaims, fetchDsciTrendClaims, fetchHeatRiskClaims, fetchNifcClaims, fetchNwsAlertClaims, fetchNwsForecastClaims, fetchUsdmClaims | shared file, both endpoints P7-*: dropped by the shared-file rule
- src/impact/hydrate.ts:41 | src/impact/evidence.ts | makeClaim | P7-T02/T03/T04/T05/T06 <- P7-T01 (done)
- src/impact/hydrate.ts:42 | src/impact/heat-synthesis.ts | synthesizeHeatSources | shared file (P7-T05): dropped for P7-T05, real for P7-T02/T03/T04/T06
- src/impact/hydrate.ts:43-48 | src/impact/matrix.ts | applyMatrix, markHorizonCells, MATRIX_LANE_KEYS | none, matrix.ts unattached
- src/impact/hydrate.ts:49 | src/impact/nws-point.ts | createNwsRequestSession | P7-* <- P15-T04
- src/impact/hydrate.ts:50 | src/impact/source-policy.ts | sourceMayRun | P7-* <- P7-T01 (done)
- src/impact/hydrate.ts:51 | src/impact/water-supply.ts | fetchWaterSupplyClaims | P7-* <- P7-T04
- src/impact/hydrate.ts:101 | src/impact/enso.ts | fetchEnsoClaims (dynamic) | see above
- src/impact/hydrate.ts:225 | src/impact/point-heat.ts | fetchPointHeat (dynamic) | P7-T02/T03/T04/T06 <- P7-T05
- src/impact/hydrate.ts:52-56 | src/impact/types.ts | type BoundarySelectionContext, ImpactBriefing, SourcedClaim | NO EDGE, type-only

## The eleven DDM-D12 members: in-edges on THIS tree

    DDM-P1-T02   <- P1-T04, P9-T05
    DDM-P1-T04   <- P1-T02, P7-T02, P8-T02, P8-T03, P11-T01, P14-T03
    DDM-P7-T02   <- P1-T02, P1-T04, P8-T02, P8-T03, P12-T02, P12-T03
    DDM-P7-T05   <- P8-T02, P12-T02, P12-T03
    DDM-P8-T02   <- P1-T02, P7-T02, P8-T03, P14-T03
    DDM-P8-T03   <- P7-T05, P8-T02
    DDM-P9-T05   <- P7-T02
    DDM-P11-T01  <- P7-T02, P12-T02, P12-T03
    DDM-P12-T02  <- P7-T02
    DDM-P12-T03  <- P7-T02
    DDM-P14-T03  <- P7-T02, P8-T03

Identical to RECONCILIATION.md:610-630 restricted to the eleven, with ONE
addition: `DDM-P7-T05 <- DDM-P8-T02`, receipt
`src/impact/sources.ts -> src/ui/heatrisk-sequence.ts`.

## Nine-task remainder after the enso.ts cut: the back edges and their files

    DDM-P1-T02   <- P1-T04   src/ui/layer-toggle-command.ts -> src/ui/island/bridge.ts
    DDM-P1-T02   <- P9-T05   src/layers/aiannh.ts -> src/ui/popups.ts
    DDM-P1-T04   <- P1-T02   src/ui/sidebar.ts -> src/ui/layer-toggle-command.ts
    DDM-P1-T04   <- P11-T01  src/ui/island/shell.tsx -> src/ui/island/minimap.tsx
    DDM-P1-T04   <- P14-T03  src/ui/sidebar.ts -> src/state/url.ts
    DDM-P1-T04   <- P7-T02   src/ui/sidebar.ts -> src/state/cluster-service.ts
    DDM-P1-T04   <- P8-T02   src/ui/island/shell.tsx -> src/ui/time-bar.ts
    DDM-P1-T04   <- P8-T03   src/ui/sidebar.ts -> src/state/timeline.ts
    DDM-P11-T01  <- P7-T02   src/ui/island/minimap.tsx -> src/state/display-summary.ts
    DDM-P14-T03  <- P7-T02   src/state/url.ts -> src/state/cluster-service.ts
    DDM-P14-T03  <- P8-T03   src/state/url.ts -> src/state/timeline.ts
    DDM-P7-T02   <- P1-T02   src/state/cluster-service.ts -> src/ui/layer-toggle-command.ts
    DDM-P7-T02   <- P1-T04   src/state/cluster-service.ts -> src/ui/island/bridge.ts
    DDM-P7-T02   <- P8-T02   src/impact/sources.ts -> src/ui/heatrisk-sequence.ts
    DDM-P7-T02   <- P8-T03   src/state/cluster-service.ts -> src/state/timeline.ts
    DDM-P7-T05   <- P8-T02   src/impact/sources.ts -> src/ui/heatrisk-sequence.ts
    DDM-P8-T02   <- P1-T02   src/layers/drought.ts -> src/ui/layer-toggle-command.ts
    DDM-P8-T02   <- P14-T03  src/layers/heatrisk.ts -> src/state/url.ts
    DDM-P8-T02   <- P7-T02   src/layers/drought.ts -> src/state/cluster-service.ts
    DDM-P8-T02   <- P8-T03   src/layers/drought.ts -> src/state/timeline.ts
    DDM-P8-T03   <- P7-T05   src/ui/map-key.ts -> src/ui/heatrisk-sequence.ts
    DDM-P8-T03   <- P8-T02   src/ui/map-key.ts -> src/ui/heatrisk-sequence.ts
    DDM-P9-T05   <- P7-T02   src/ui/popups.ts -> src/ui/charts.ts

Five files carry almost all of it: cluster-service.ts (9), timeline.ts (9),
bridge.ts (9), layer-toggle-command.ts (9), popups.ts (9). All five are in
RECONCILIATION.md:604-608's "next ten, for the owner's judgement on where to
draw the line."

## SCC results (Tarjan, over the same open-task node set)

    hub line at 10, all eleven            SCC 11   (matches RECONCILIATION)
    hub line at 10, enso.ts cut           SCC 9    <-- the candidate cut does NOT break the cycle
    hub line at 10, hydrate->enso arc cut SCC 11   (no help alone)
    hub line at 10, enso->charts arc cut  SCC 9
    hub line at 20, all eleven            SCC 3    {P12-T02, P12-T03, P7-T02}
    hub line at 20, enso.ts cut           ACYCLIC  <-- both cuts together

    hub line at 20 + enso.ts cut + matrix.ts attached to P12-T02: still ACYCLIC
    (matrix.ts has no value imports, so widening the seam adds no edge)
