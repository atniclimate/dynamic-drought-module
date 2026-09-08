# Dynamic Drought Module: project guide

A plain-language map of this repository for a person returning after time away, or for
someone being handed the project. It says where things are and how work happens. It does
not restate the plan: the current state lives in the newest handoff and the plan in the
ledgers named below. Written 2026-09-08 by session S16; keep it short and keep it true.

## What this is

The Dynamic Drought Module (DDM) is an embeddable static web map of drought, wildfire,
heat, water and ocean conditions for the Pacific Northwest and the Tribal Nations of the
region, built by ATNI Climate. It is TypeScript and MapLibre GL, built by Vite, served from
GitHub Pages, with one optional Cloudflare Worker proxy (`workers/proxy`) for sources that
lack CORS. There is no backend and no telemetry. The product invariants (sovereign
boundaries never redistributed, representation not jurisdiction, URL as state, six layer
states, cancellable network work, and the rest) are `plan_rules` in `docs/ROADMAP.yaml`.

## Picking it back up, in order

1. Read the newest file in `planning/handoffs/` (newest by filename date). It opens with
   the next action, lists the branch and its commits, and names what is open.
2. If there is a local `docs/README-RESUME.md`, read it next: it is the owner's own
   plain-language status and resume checklist, written for the pause it describes.
3. Check the tree: `git status --short --branch`, `git worktree list`,
   `git branch --no-merged main`. Unlanded session branches are landed by the owner with a
   `--no-ff` merge; nothing is pushed by a session.
4. Start the next session from `.planning/SESSION_ROSTER.yaml`: the next entry with
   `status: planned` names the task, the model, the effort, the gate and the open owner
   calls. The prompt shape is described under "How work happens" below.

## The critical files

| File | What it is | Tracked |
|---|---|---|
| `docs/ROADMAP.yaml` | The planning authority: phases, task ids, one testable acceptance sentence per task, decision gates, done claims recorded in place. When any other document disagrees with it, it wins. | yes |
| `ROADMAP.md` | The prose reading of the YAML for people. Rewritten against the YAML when the YAML changes shape. | yes |
| `.planning/SESSION_ROSTER.yaml` | The session plan: one entry per session (S01 onward) with task, model, effort, gate, status and outcome, plus the `owner_calls` blocks that hold every decision waiting on the owner. | yes |
| `.planning/TRACE.yaml` | Which source files and tests serve each task id, with evidence lines, and a census of files no task claims. Counts of open and done tasks live in its header. | yes |
| `.planning/RECONCILIATION.md` | The 2026-09-07 audit of what the roadmap claims against what the tree proves; section 7 lists acceptance patterns that cannot be verified as written. | yes |
| `.planning/PLANNING_AUTHORITY.md` | Which planning folders are authority, history, or parked; the registry of id schemes (section 2); the ten session-conduct rules (section 8). | yes |
| `planning/decisions/2026-09-02-decision-register.yaml` | The decision register, DR-001 onward: question, options, recommendation, default, ruling. The YAML wins over any Markdown reading of it. | yes |
| `planning/qa/feature-errors.yaml` | The defect ledger (FE-, EF-IB-, EF-MM- ids). | yes |
| `planning/user-research/` | User research inputs the plan cites. | yes |
| `planning/handoffs/` | One handoff per session, newest by filename date is the entry point. Each is negated by name in `.gitignore`. | yes |
| `.planning/2026-09-07-s03-enso-cut-plan.md` | Why the Wave 2 cycle runs in the order it does (section 3) and the gate per task (section 4). Beside it, the edge ledger and the recon report from the same pass. | yes |
| `.planning/BRANCH_REPORT.md` | The 2026-09-07 branch audit. Its worktree paths are stale by design. | yes |
| `docs/RELEASE_NOTES.md` | Release history with deploy and verify-live receipts. | yes |
| `DEVELOPER.md` | Setup, architecture, the hosting end state and its seams. | yes |
| `docs/design/README.md` | Read before any interface or interaction work. | yes |
| `tests/README.md` | What the smoke suite asserts, why the sovereign boundary sources are stubbed in CI, how to run it. | yes |
| `planning/2026-09-01-deep-dive/` | The eighteen deep-dive reports from 2026-09-01 (architecture, briefing, fire 3D, time and forecasts, ENSO, interface, CI, tests, science sources, popups, dependencies) with `00-MASTER-FINDINGS.md` on top. Parked: history, not authority. Only the hook drafts under `claude-tooling/` are tracked. | mostly local |
| `planning/2026-09-03-foundations/FOUNDATIONS-PLAN-v2.md` | The foundations plan and its rulings A1 to C5. Parked. | local |
| `docs/README-RESUME.md`, `docs/claude-ai-handoff.md`, `docs/claude-code-pickup-prompt.md` | The owner's pause notes: status in plain words, the prompt for a new Claude.ai chat, and a read-only Claude Code pickup prompt that produces a verified state report. | local |
| `.claude/hooks/`, `.claude/settings.local.json` | The guards every writing session runs under (no heredocs, no U+2014, a stop-time verify). Local; copy the folder into any new worktree. Tracked drafts live under the deep-dive `claude-tooling/hooks/`. | local |

Id schemes, all registered in `PLANNING_AUTHORITY.md` section 2: `DDM-P<n>-T<m>` tasks
and `DDM-P<n>` phases, `DDM-D<nn>` decision gates, `DR-<nnn>` decisions, `FE-`, `EF-IB-`
and `EF-MM-` defects, `S<nn>` sessions. An id is cited, never redefined; an unregistered id
is a reason to stop and ask.

## How work happens

One task per session, one branch per session, one handoff per session. The roster assigns
the model and effort (T3 tasks on Fable 5.1 or Opus 5, T2 on Sonnet 5 high) and the gate.
The owner writes the session prompt in a fixed shape: read-this-first and scope, the
purpose, preconditions with receipts (clean tree, the base commit, worktrees, guards, one
date, a verify:quick baseline), authority and contract state, numbered owner rulings,
an execution order with one checkpoint and one commit per step, standing authorizations,
and the deliverable. A prompt never contains a placeholder; what is unknown becomes a
precondition the session verifies or a stated "unrecorded".

A session commits at its checkpoints and never pushes, merges, tags, deploys or publishes
(rule 4). It writes its ledger edits in a closing commit (ROADMAP status and closed
sentence, TRACE attachments and counts, its roster entry, any decision it proposes as a
pending DR entry, its handoff negated by name in `.gitignore`). A task flips to done only
when every clause of its acceptance sentence has a receipt from a spec run whose log is on
disk. The owner reads the handoff, rules on the owner calls, and lands the branch.

Two sessions may write at the same time only on TRACE-disjoint files, one on the main
checkout and one in a worktree under `I:\dynamic-drought-module-wt\`; the worktree session
leaves every ledger edit to its handoff or its deliverable file. One Playwright runner at a
time, whichever session holds it.

The ten conduct rules are `.planning/PLANNING_AUTHORITY.md` section 8. In one breath:
commit on go, never author U+2014, no heredocs, nothing leaves the machine without the
owner, no schedules or workflow edits, the assigned gate with pasted output, a receipt for
every load-bearing claim, one writing session per checkout, `check:public-tree` whenever a
path is added, and stop when a precondition is unmet.

## Verification

The ladder is in `package.json`: `verify:quick` (typecheck, U+2014 scan, vocabulary,
coverage matrix; seconds), `verify:smoke` (build, bundle and activation budgets, every
static check, then the smoke specs; about six minutes; the default completion gate),
`verify:fire` (about twenty) and `verify:full` (fifty to fifty-five). `check:public-tree`
runs whenever a session adds or negates a path. The suite verifies the production build,
never the dev server, and reaches no live agency: sovereign boundary geometry is answered
by synthetic fixtures on every boot so a retained CI artifact can never carry it.

## Sharing this project

For someone without repository access, share in this order: `ROADMAP.md`, this guide, the
newest handoff in `planning/handoffs/`, and `docs/RELEASE_NOTES.md`. The YAML ledgers are
written for sessions and are best read in the repository. The deployed site carries a
build marker that the release notes tie to a commit, so "what is live" is always
answerable from the notes.

## Where things stood when this was written (2026-09-08)

`main` is at 0c09081, the S14 merge, pushed and deployed. Session S16 completed the layer
cancellation seam (DDM-P1-T02) on `feature/cancel-layer-loads-p1t02`, unlanded; its handoff
is `planning/handoffs/2026-09-08-s16-cancel-layer-loads.md` and its one pending decision is
DR-073. Session S15 (acceptance proposals for the twenty-two title-only stubs, in the
worktree) ran concurrently; its deliverable, if it closed, is
`planning/decisions/2026-09-08-stub-acceptance-proposals.md`. The next work is the rest of
the Wave 2 cycle in the S03 order, recorded in the roster's S17-S21 block.
