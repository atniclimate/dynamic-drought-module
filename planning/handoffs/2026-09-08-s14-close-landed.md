# S14 handoff: close what has landed (2026-09-08)

Session S14 on branch `feature/close-landed-s14` from `96aba35` (main, pushed 2026-09-08
before this session). Unpushed. Nothing merged, tagged, published, or scheduled. The
concurrent session S15 wrote in `I:\dynamic-drought-module-wt\acceptance-proposals` on
`planning/stub-acceptances-2026-09-08`; S14 touched neither of its paths.

## Next action

Owner: read the eight verdicts below, rule on the seven owner calls, then land
`feature/close-landed-s14` on `main` by a `--no-ff` merge commit (nine commits, one per
step). The branch changes no product behavior except the DDM-P14-T02 residuals (a
try/finally around the sidebar wiring, and the Brief door hiding the Quick views panel
through the boot window on the desktop shell) and one release-note reword.

## Commits, in order

| Step | Commit | Subject |
|---|---|---|
| 2 | b2c59bd | close: surface continuity (DDM-P8-T05) |
| 2 | fb79b0b | close: capability honesty (DDM-P9-T02) |
| 2 | 9fad958 | close: gridded index (DDM-P13-T03) |
| 3 | a404638 | close: tablet band (DDM-P10-T01) |
| 3 | 1ba44d4 | close: platform hosting end state (DDM-P15-T01) |
| 4 | d86da75 | close: boot honesty (DDM-P14-T02) |
| 5 | d0615d6 | plan: ratify DR-071, amend DR-070, attach time-bar owners |
| 6 | fe4ade8 | plan: TRACE counts and header, handoff_entry, roster S14 and S15 |
| 7 | 4d223a2 | docs: ROADMAP.md against ROADMAP.yaml |
| 8 | (closing commit) | plan: close S14 (close what has landed) |

## The eight tasks

Verdict rule (owner R1): a task flips only when every clause of its acceptance sentence
has a receipt from this session, a spec run whose log is on disk or a path:line read.
Logs are under `%TEMP%\ddm-s14\`.

| Task | Verdict | Receipt per clause |
|---|---|---|
| DDM-P8-T05 surface continuity | DONE | `tests/temporal-axis.spec.ts:479-560`, one test per clause, 2 passed (p8t05-temporal-axis.log); `tests/heat-h1-heatrisk.spec.ts:361` x10 passed (p8t05-heat-h1-repeat10.log) |
| DDM-P9-T02 capability honesty | DONE | clause 1: the task gate 41 passed before and after the reword (p9t02-gate.log, p9t02-gate-after.log), `tests/fire3d-mode.spec.ts:224-261`, `:1360-1396`; clause 2: `src/map/fire3d.ts:656-667` read (watchContextLoss to failScene). Reword: 5 claims VERIFIED by ddm-science-verifier |
| DDM-P13-T03 gridded index | DONE | `tests/legend.spec.ts:85-137`, three clauses in one test, 4 passed after the five-option wait (p13t03-legend.log) |
| DDM-P10-T01 tablet band | DONE | `tests/interface-responsive.spec.ts:701-960`, ten viewports x three conditions plus the embed and fluid-sidebar cases, 12 passed (p10t01-tablet.log). Figures 217/264/984 derived from app.css:330, :160-168 |
| DDM-P15-T01 hosting end state | DONE | `DEVELOPER.md:580-582` (interim host), `:590-637` (seven seams), `:639-658` (evidence classes); inside docs/: `docs/ROADMAP.yaml` gate DDM-D10 and the release note's hosting entry |
| DDM-P14-T02 boot honesty | DONE | `tests/boot-without-map.spec.ts:51-108` (notice text, visible chrome, and since S14 the disabled controls, note and no-map stamp), 2 passed (p14t02-boot-after.log); 25 passed with e1-calm and s4-shell (p14t02-boot.log); `src/main.ts:244-255`, `:312-336` read |
| DDM-P7-T03 fire cells | NOT LANDED (open) | register :180 says S02g "UNBLOCKS" T03; `src/impact/matrix.ts:144-153` cells read "not wired into this briefing"; DR-022 a decided, unexecuted. DR-072 (pending) records why a not-wired absence is not "read unavailable" |
| DDM-P15-T05 lint burn-down | NOT LANDED (open) | S02a created the task (register :178); `biome.jsonc` includes `src/**/*.ts` and app.css only; 17 errors over the 11 `.tsx` islands measured with a scratch config (biome-islands-tsx.log); ruling A5 open |

Also DDM-P8-T02: TRACE status done under ruling R5 (d0615d6); ROADMAP had flipped it on
2026-09-08 (S13).

## Residuals done (foundations plan F1 rows, v2 rulings A2 and A3)

- P9-T02: `src/ui/island/fire3d-control.tsx:25-33` and the release note say the no-WebGL-2
  refusal is unreachable in a browser (the island mounts only with a live map; MapLibre 6
  builds none without WebGL 2) and point at the boot renderer notice.
- P13-T03: `tests/legend.spec.ts` waits for five options before the one-shot read.
- P10-T01: `src/styles/app.css:3953-3958` and the release note carry 217/264/984; the
  floor-only comment at :7121 names its one exception; the desktop-unchanged sentence
  is qualified to a fine pointer.
- P14-T02 (58 changed lines in src/ and tests/): gating assertions; the share-button
  comment corrected (`src/ui/sidebar.ts:283-287`); A3, `buildSidebar` wraps `wireSidebar`
  and enables the controls in a `finally`; A2, `buildSidebarShell` stamps
  `data-ddm-boot-view` and app.css:970-980 hides `#panel-quick-views` in Brief until
  `data-ddm-controls="ready"` on the desktop shell; the release note narrowed to the
  NIDIS demonstration.

## Ledger repairs

- Register: DR-071 decided (owner, via the S14 prompt); DR-070 `amended_2026_09_08`
  (HeatRisk claim in force is outlook register in the briefing too; routed to
  DDM-P7-T05, no src/impact file touched); DR-072 added, pending; updated line 72 / 51 / 21.
- TRACE: seven flips; merge --stat files and acceptance specs attached by `repair:S14`;
  counts regenerated from the body (90 tasks: 58 open, 27 done, 5 superseded; 50 with
  files, 41 with tests, 40 neither; 11 done claims without a test, DDM-P15-T01 added;
  122 orphans, 75 with coverage); `repairs_through: 96aba35`.
- ROADMAP.yaml: six closed sentences; `handoff_entry: planning/handoffs/`; `updated_on`
  2026-09-08. ROADMAP.md rewritten against it (commit 4d223a2 names every line).
- Roster: S14 (done) and S15 (planned) entries; S14-S19 is S16-S21 and S20-S24 is S22-S26
  with DDM-P7-T03 joining Wave 3; per-task model and effort on every tier line;
  `s14_verdict_2026_09_08` on S02a-S02h and S13; `owner_calls.s14_2026_09_08`.
- .gitignore: the S12 handoff (already tracked) and this handoff negated by name.

## Gates

| Gate | Result | Log |
|---|---|---|
| verify:quick baseline on 96aba35 | exit 0 | quick-baseline.log |
| verify:quick after each residual and ledger step | exit 0 each time | quick-p8t05, quick-p9t02, quick-p13t03, quick-p10t01, quick-p15t01, quick-p14t02, quick-p14t02b, quick-step7 |
| per-task specs | see the table above | p8t05-*, p9t02-*, p13t03-*, p10t01-*, p14t02-* |
| check:public-tree | clean (563 tracked files), exit 0 | public-tree.log |
| verify:smoke once at close | exit 0, 135 passed, 1 skipped (the tests/ux1-surfaces.spec.ts quarantine), 5.5m, on the working tree at 4d223a2 plus the staged handoff | smoke.log |
| U+2014 hand scan of the ledgers touched | zeros on the roster, the register, this handoff, ROADMAP.yaml, ROADMAP.md and .gitignore; TRACE.yaml carried one from the scout pass (present at 96aba35, line 3157), replaced in the closing commit, now zero | emdash-planning.log |

## Owner calls, numbered (also at `.planning/SESSION_ROSTER.yaml` owner_calls.s14_2026_09_08)

1. `src/styles/app.css:7229-7232`: the `.maplibregl-popup-close-button` 44 px rule.
   Foundations plan v1 row 7 and question 4 default to deleting it (it covers the popup
   title and falsifies the `src/ui/popup-viewport.ts:163-174` derivation); plan v2 B1.
   A design call, not made.
2. `src/styles/app.css:7142-7145`: `.view-switch button` `padding-inline: 12px`, the
   one non-floor declaration in the touch-floor block (now named at :7121). Plan v2 B1.
3. `docs/ROADMAP.yaml:584-590` DDM-P15-T04 is status open while the register's
   platform_ddm_p15_close line (:178) says satisfied and `npm run lint` exists. Outside
   S14's eight; flip with a closed sentence, or refute.
4. DR-072 (`planning/decisions/2026-09-02-decision-register.yaml`, group
   G-session-2026-09-08-s14): ratify option a (DDM-P7-T03 stays open until the DR-022
   outlooks are wired) or rule b.
5. DDM-P15-T05 and ruling A5: 17 island a11y errors (biome-islands-tsx.log), the islands
   and tests/ outside `biome.jsonc:30`.
6. `src/ui/sidebar.ts:283-287`: the share button is inert until map ready and is not in
   the disabled set; S14 corrected the comment only. Add it to `mapDependentControls()`
   or leave it.
7. The S14 prompt's precondition 6 (DEPLOY_STATE for 96aba35) was left as a placeholder;
   the deploy receipt is unrecorded in this ledger.

## Not done, by design

- No push, merge, tag, publish, schedule, or workflow edit. The two held branches
  (`feature/nifc-perimeter-evidence`, `map/dr-063-whp-ramp`) untouched. No src/impact
  file touched (DR-070 routed away). S15's two paths untouched.
- DDM-P8-T03 stays as S12 left it (partial).
