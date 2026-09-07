# S03: cut plan for the src/impact/enso.ts cycle (DDM-D12)

Session S03, .planning/SESSION_ROSTER.yaml:553-586. Planner output; no code changed. Tree: main
5b40dfb, after merge 6a070eb (S02g). Edge ledger: %TEMP%\ddm-s03\edges.md. Input to DDM-D12: it
recommends, the owner decides.

Method for every edge below, re-derived on this tree by the RECONCILIATION.md section 6 rules:
direct imports only, hub files excluded, shared-file edges dropped. `import type` forms no edge; a
dynamic `await import()` does, and did before S02g as well (3289354:src/impact/hydrate.ts:88).
docs/ROADMAP.yaml:684-697 states DDM-D12 against a tree S02g has since changed.

## 1. The cut

The candidate cut is the right file and it is not sufficient. Two cuts are needed. Cut 1, the file
seam: `src/impact/enso.ts`. Cut 2, the hub line: extend hub exclusion from ten files to twenty,
taking RECONCILIATION.md:601-604's own "next ten, for the owner's judgement on where to draw the
line".

### Receipt for cut 1

Inbound, exactly two files in src/ import src/impact/enso.ts, both dynamically, plus one type-only
reference that forms no edge. Outbound, enso.ts forms two non-hub edges:

    IN   src/impact/hydrate.ts:101      const { fetchEnsoClaims } = await import('./enso');
    IN   src/ui/island/minimap.tsx:594  const { readEnsoPhaseLabel } = await import('../../impact/enso');
    none src/ui/island/minimap.tsx:94   import type { EnsoPhaseLabel } from '../../impact/enso';
    OUT  src/impact/enso.ts:33          import { oniLineSvg, ensoPlumeSvg, ... } from '../ui/charts';
    OUT  src/impact/enso.ts:34          import { makeClaim } from './evidence';

src/ui/charts.ts is attached to DDM-P7-T02 and DDM-P13-T02; src/impact/evidence.ts to DDM-P7-T01
(done). enso.ts:35 and :36 are `import type`; :30 to :32 reach hub files. The ENSO loop is
therefore exactly two arcs:

    DDM-P7-T02      <- DDM-P12-T02, DDM-P12-T03   via hydrate.ts -> enso.ts
    DDM-P12-T02/T03 <- DDM-P7-T02                 via enso.ts -> src/ui/charts.ts

Cut 1 alone does not break the cycle. Lifting DDM-P12-T02 and DDM-P12-T03 out takes the component
from eleven tasks to nine: { P1-T02, P1-T04, P7-T02, P7-T05, P8-T02, P8-T03, P9-T05, P11-T01,
P14-T03 }. RECONCILIATION.md:652-654 says the cut "would drop three tasks out of the cycle" and
SESSION_ROSTER.yaml:576 repeats it. Both are true. Neither says the remainder is acyclic, and it
is not.

### Receipt for cut 2

Five shared files hold the nine-task remainder together, none of which any of the nine is about.
In-degree on this tree, and the group 2 tasks attaching each per TRACE.yaml:

    file                              in-deg   group 2 tasks attaching it
    src/state/cluster-service.ts        9      DDM-P7-T02
    src/state/timeline.ts               9      DDM-P8-T03      (also P8-T01, done)
    src/ui/island/bridge.ts             9      DDM-P1-T04
    src/ui/layer-toggle-command.ts      9      DDM-P1-T02
    src/ui/popups.ts                    9      DDM-P9-T05

Each has exactly ONE group 2 owner, so cut 2 costs no shared-file edit collision inside group 2: no
two of the nine will write the same reclassified file. What cut 2 gives up is ordering, not
separation; the five stay high in-degree files many other tasks READ, so a change to any still has
reach, and cut 2 only stops that reach from reading as a task-level order. All five sit inside
RECONCILIATION.md:601-604's "next ten", and the line at ten lands mid-plateau: rank 10
(wildfire-presentation.ts, 12) ties rank 11 (ui/overlay.ts, 12). Cut 2 changes an analysis
parameter, not code.

### Result

    hub line 10, all eleven ....... SCC of 11   reproduces RECONCILIATION
    hub line 10, cut 1 ............ SCC of 9
    hub line 10, either arc alone . SCC of 11 or 9, no help
    hub line 20, all eleven ....... SCC of 3    { P12-T02, P12-T03, P7-T02 }
    hub line 20, cut 1 ............ ACYCLIC

Both cuts are load-bearing; neither works alone. Robustness check: attaching matrix.ts to
DDM-P12-T02 (which DR-031 will require, section 5) leaves the result ACYCLIC, because matrix.ts has
no value imports and so adds no edge. If the owner declines cut 2, group 2 has no import-derived
order and is entirely owner order; nothing else in this plan changes.

## 2. The groups

Group 1, the ENSO seam. Both tasks attach one file, src/impact/enso.ts.

    DDM-P12-T02  Give the ENSO horizons distinct source-backed meanings
    DDM-P12-T03  Cite and correct the regional tilt statements

Group 2, the briefing and state core.

    DDM-P14-T03  Take the first paint down to what it needs
    DDM-P1-T02   Complete the layer cancellation seam
    DDM-P9-T05   Read the RAWS fire-weather values the issuer already serves
    DDM-P8-T02   Give Fire and Extreme Heat a time bar
    DDM-P7-T05   Make the Heat claims independent of the map layer, add the season
    DDM-P7-T02   Give the briefing one four-hazard by three-horizon structure
                 LANDED BY S02g (merge 6a070eb); ledger status pending owner
    DDM-P8-T03   Make every horizon chip and every stamp honest and uniform
    DDM-P11-T01  Give every hazard minimap a condition or a navigation-only statement
    DDM-P1-T04   Isolate core sidebar loading from optional search

Eleven tasks, each once. DDM-P7-T03 is NOT a member (absent from docs/ROADMAP.yaml:686-687
`needed_by`); it also landed in S02g, see section 5.

## 3. Order within each group

### Group 1: owner order

Both attach src/impact/enso.ts and nothing else (TRACE.yaml, `coverage: files-no-tests`), so no
import edge runs between them. Owner order. One fact, offered as fact and not as an order: they
touch disjoint regions. P12-T03's subject is `tendency()`, enso.ts:474-503; P12-T02's is the
horizon assignment, enso.ts:869-990 plus the ENSO entries in matrix.ts (lines 100, 143-144).

### Group 2: graph layer and effective layer

The graph layer is the topological layer under cut 2. The effective layer is the same computation
with DDM-P7-T02 removed as landed and its two outbound edges treated as satisfied: P7-T02 <- P8-T02
(spent; P7-T02 landed ahead of P8-T02) and P11-T01 <- P7-T02 (predecessor is in tree).

    task           graph layer   effective layer
    DDM-P14-T03         1              1
    DDM-P1-T02          1              1
    DDM-P8-T02          2              2
    DDM-P7-T02          3          (leaves the ordering; landed)
    DDM-P7-T05          3              3
    DDM-P8-T03          4              4
    DDM-P11-T01         4              1     <-- moves
    DDM-P1-T04          5              3     <-- moves
    DDM-P9-T05      owner order    owner order

Three changes, nothing else moves. P7-T02 leaves the ordering. P11-T01 moves from layer 4 to
effective layer 1, because its only predecessor was P7-T02, so it is startable now. P1-T04 moves
from 5 to 3, because with P11-T01 at effective layer 1 its binding predecessor becomes P8-T02.

One sentence per edge, receipt first:

- P8-T02 <- P14-T03, layers/heatrisk.ts -> state/url.ts. The HeatRisk layer the time bar drives
  reads its frame out of URL state, and P14-T03 decides what boot pulls from that module eagerly.
- P7-T02 <- P8-T02, impact/sources.ts -> ui/heatrisk-sequence.ts. The briefing's HeatRisk claim
  reads the sequence the time bar owns. Spent: P7-T02 landed ahead of P8-T02, the
  sequencing_conflict at SESSION_ROSTER.yaml:437-444.
- P7-T05 <- P8-T02, same import. The near-term heat claim reads the same sequence P8-T02 reshapes.
- P8-T03 <- P8-T02, ui/map-key.ts -> ui/heatrisk-sequence.ts. The chips and stamps read the
  sequence the time bar establishes.
- P8-T03 <- P7-T05, same file pair, which P7-T05 also attaches: the chip grammar follows whatever
  P7-T05 makes the near-term heat evidence.
- P11-T01 <- P7-T02, ui/island/minimap.tsx -> state/display-summary.ts. The minimap's condition read
  takes the display summary the composer publishes. Satisfied.
- P1-T04 <- P1-T02, ui/sidebar.ts -> state/layer-controller.ts. The core loading path retries
  through the controller whose cancellation seam P1-T02 completes.
- P1-T04 <- P14-T03, ui/sidebar.ts -> state/url.ts. Splitting core from optional search moves what
  the entry chunk pulls, so the budget settles first or the split moves against a moving line.
- P1-T04 <- P8-T02, ui/island/shell.tsx -> ui/time-bar.ts. The shell mounts the time bar, so the bar
  reaches its final shape before the shell is split.
- P1-T04 <- P11-T01, ui/island/shell.tsx -> ui/island/minimap.tsx. Same, for the minimap.
- P9-T05: owner order. Its single attached file, ui/popups.ts, is one of cut 2's five, so it forms
  no edge either way. Under cut 1 alone it sits on P7-T02 -> P9-T05 -> P1-T02 (popups.ts ->
  charts.ts, and layers/aiannh.ts -> popups.ts).

## 4. Gate and verifier per task

Resolution order: the task's own `verification:` key, else the roster entry, else
`default_verification` at docs/ROADMAP.yaml:6. Only one of the eleven carries its own key. Tiers are
the roster's, SESSION_ROSTER.yaml:702-712.

    task           gate            source of the gate                        tier  verifier
    DDM-P12-T02    verify:smoke    default_verification, ROADMAP.yaml:6       T2    no
    DDM-P12-T03    verify:quick    own key, ROADMAP.yaml:467                  T2    YES
    DDM-P14-T03    verify:smoke    default_verification                       T2    no
    DDM-P1-T02     verify:smoke    default_verification                       T3    no
    DDM-P9-T05     verify:smoke    default_verification                       T2    no
    DDM-P8-T02     verify:smoke    default_verification, plus the step below  T3    no
    DDM-P7-T05     verify:smoke    default_verification, plus the step below  T2    no
    DDM-P7-T02     verify:smoke    default_verification; see the note below   T3    no
    DDM-P8-T03     verify:smoke    default_verification                       T3    no
    DDM-P11-T01    verify:smoke    default_verification                       T2    no
    DDM-P1-T04     verify:smoke    default_verification                       T3    no

DDM-P7-T02's row, said plainly: its acceptance has NOT been verified by any gate run on main. The
only receipts are verify:smoke, exit 0, 101 passed, at the pre-merge baseline 3289354 and again
post-merge at 6a070eb (SESSION_ROSTER.yaml:447 and :453). The count is identical across a merge that
added a 334-line spec, because verify:smoke names twelve specs at package.json:48 and
tests/briefing-matrix.spec.ts is not among them (grep for `briefing-matrix` in package.json returns
nothing). That spec carries P7-T02's acceptance sentence verbatim in its header and today runs only
under `test:serial`, which sweeps all 113 .spec.ts files under tests/ (playwright.config.ts:98,
`testDir: './tests'`).

A task landing across a spent edge therefore runs the landed downstream task's acceptance spec as an
explicit extra step, because the gate it inherits will not pick it up. For DDM-P8-T02 and DDM-P7-T05
that step is, verbatim:

    npx playwright test --workers=1 tests/briefing-matrix.spec.ts

run after `npm run verify:smoke`, not instead of it, one runner at a time. The form matches the only
per-task `verification:` override of this shape in the ledger, docs/ROADMAP.yaml:378. `verify:quick`
and `verify:smoke` are package.json:46 and :48; verify:smoke runs `gate` first, and `gate` runs
`check:bundle` (scripts/check-bundle-size.mjs), the script P14-T03's acceptance names.

ddm-science-verifier: only DDM-P12-T03, per SESSION_ROSTER.yaml:710, "Needs ddm-science-verifier:
the acceptance requires each of four tilt sentences to cite a published source." No other
per_task_tier note names it. Two candidates for extending that list are in section 6.

## 5. What S02g already consumed

- DDM-P7-T02, whole acceptance: "Every one of the twelve hazard-by-horizon cells renders either a
  sourced claim or a named unavailable state, and no cell inherits another hazard's issuer or
  clock." Receipts: matrix.ts:127-154 (CELL_ABSENCE gives all twelve a named absence), :167-185,
  :234-284 (fillCell recomputes each cell from only the lanes LANE_PLACEMENT declares for it),
  types.ts:171-197 (HazardCell owns its claims, status and note), impact-panel-runtime.ts:222-223
  (one row per hazard), tests/briefing-matrix.spec.ts; register receipt
  planning/decisions/2026-09-02-decision-register.yaml:180, `impact_ddm_p7_t02`.
  docs/ROADMAP.yaml:276-281 carries no `status: done`. Landed in code, open in the ledger, and
  unverified by any gate on main (section 4).
- DDM-P7-T05, second clause only: "the long-range heat cell cites the CPC seasonal outlook or reads
  unavailable." The second branch is met at matrix.ts:150-151. The first clause, "The near-term heat
  claim states its evidence whether or not the HeatRisk layer is on," is NOT met: S02g gave that
  cell two declared lanes (matrix.ts:94-95, heatRisk and nwsForecast), the structure for it and not
  the proof of it. S02g also deleted src/impact/heat-horizon.ts, one of P7-T05's eight traced files.
- DDM-P12-T02, second clause partly: "Every visible ENSO horizon activates evidence no other horizon
  shows, or is absent, and no horizon implies a forecast the app does not have." Current and
  long-range now hold different claims under their own clocks (enso.ts:874, :900, :917, :950, :984
  carry the five `horizon:` tags; matrix.ts:97-100 declares the lane across two horizons), and
  near-term is a named absence (matrix.ts:143-144). BUT DR-031 is ratified option (a), "wire the
  weekly Nino 3.4 observation, labeled an observation and not a forecast," and the absence S02g
  shipped is option (b) behavior. Two new assertions pin it and must move with the task:
  tests/briefing-matrix.spec.ts:149-153 fixes the unwired-cell list as exactly
  ['nearTerm:fire','nearTerm:enso','longRange:fire','longRange:heat'], and :220 asserts the ENSO
  near-term cell holds no claims.
- DDM-P7-T03, not a cycle member: "The Fire near-term and long-range cells each state one issuer's
  outlook with its valid window and geography, or read unavailable, and neither presents a static
  hazard raster as a forecast." Satisfied through the second branch at matrix.ts:140-141 and
  :148-149, both naming the product not read (SPC Days 1 to 8; NIFC Predictive Services Months 1 to
  4) and citing DR-022. Landed in code, open in the ledger, same as P7-T02.
- No other task among the eleven had an acceptance clause touched: of the 17 files in
  `git show --stat 6a070eb`, none is attached in TRACE.yaml to P1-T02, P1-T04, P8-T02, P8-T03,
  P9-T05, P11-T01 or P14-T03.

## 6. Open owner calls this plan does not answer

1. The ledger status of DDM-P7-T02 and DDM-P7-T03. Both landed in S02g; neither carries
   `status: done` at docs/ROADMAP.yaml:276-287. For P7-T02 the flip would be made against an
   acceptance no gate on main has run.
2. Cut 2 itself, a judgement RECONCILIATION.md:601-604 explicitly reserved for the owner.
3. Group 1's internal order, and DDM-P9-T05's position inside group 2. No import evidence orders
   either.
4. DR-030 does not name the two over-claiming sentences it says exist, and docs/ROADMAP.yaml:466
   makes DDM-P12-T03's acceptance depend on that naming; RECONCILIATION.md:713 flagged it, "Requires
   DR-030 to name them." The acceptance also says four Pacific Northwest tilt sentences while
   `tendency()` at enso.ts:474-503 has three branches; which four are meant is undecided.
5. How much of DDM-P12-T03 commit 46f98f4 already did. `git log -L 474,503:src/impact/enso.ts` shows
   the cited `tendency()` block arrived in 46f98f4, DDM-P12-T01's own closure commit; each branch
   carries `source`, `sourceUrl` and `lineage`, and enso.ts:470-472 states the uncited fine-fuels
   sentence was deleted and the snowpack counter-evidence added, DR-030 option (a) as written.
   Whether P12-T03 is a verification pass rather than a rewrite is the owner's read.
6. Whether ddm-science-verifier extends past DDM-P12-T03. Two candidates: DDM-P12-T02, because
   DR-031 (a) introduces a new NOAA product and a new register label, and DDM-P7-T05, whose
   long-range clause cites the CPC seasonal outlook. The roster names neither.
7. Three TRACE.yaml attachments S02g invalidated, all outside this session's write scope:
   heat-horizon.ts is deleted but still claimed by DDM-P7-T05; overlap-engine.ts moved to
   src/ui/island/, so DDM-P9-T03 claims a path that no longer exists and the new path is unattached;
   and matrix.ts, the 315-line module that IS the matrix, is attached to no task.
8. Whether tests/briefing-matrix.spec.ts joins the verify:smoke list. Section 4 works around its
   absence with a per-task extra step, a workaround and not a fix. The fix edits the spec list at
   package.json:48, a scripts change outside S03's write scope and arguably outside Wave 2's task
   list, since none of the eleven acceptance sentences is about the gate's composition. Related and
   NOT audited here: verify:smoke names twelve specs while tests/ holds 113, so an acceptance spec
   outside the smoke list is unlikely to be the only one. Whether the other Wave 2 acceptance specs
   are inside it is a one-pass audit this plan recommends and does not perform.
9. Whether DDM-D12's membership should be restated. Re-derived on this tree with no hub line raised
   and DDM-P15-T04 included, the component is twenty tasks, because DDM-P15-T04 ("Add a linter for
   the code and the stylesheet") attaches 122 src files and fuses everything it touches. Excluding it
   alone gives twelve, the eleven plus DDM-P9-T03. docs/ROADMAP.yaml:686-687 names eleven, and this
   plan cuts the eleven it names; restating membership is the owner's call.
