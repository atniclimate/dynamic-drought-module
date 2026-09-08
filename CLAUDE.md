# CLAUDE.md

Dynamic Drought Module (DDM): an embeddable static TypeScript + MapLibre web map of
drought, wildfire, and water conditions, built by ATNI Climate. This file is a map to
the sources of truth. It restates none of them. When it and a source disagree, the
source wins and this file is the bug.

## Read in this order

0. `docs/PROJECT_GUIDE.md` is the human-readable map of every file below and of how a
   session runs; a returning reader starts there, then at the newest handoff in
   `planning/handoffs/`.
1. `docs/ROADMAP.yaml` is the planning authority. `plan_rules:` at lines 78 to 87 holds
   the nine product invariants; read them there. The `authority:` block names the
   tracked ledgers and the id rule that says which id schemes may be cited and never
   redefined. An id not registered in `.planning/PLANNING_AUTHORITY.md` section 2 is a
   reason to stop and ask.
2. `.planning/SESSION_ROSTER.yaml` is the session plan: which session runs next, on
   which model and effort, behind which gate, and which owner calls are still open
   (`owner_calls:`). Read it before starting work. The owner updates a session's
   `status` and `outcome` unless the session prompt says otherwise.
3. `DEVELOPER.md` for setup and architecture. `docs/design/README.md` before any
   interface or interaction work.
4. `AGENTS.md` and `HANDOFF.md` are currently gitignored and local to the owner's
   machine. AGENTS.md is the Codex sibling of this file: the same project
   read for Codex sessions on this machine. HANDOFF.md is the newest owner handoff.
   Nothing in this file depends on either. Owner direction given in the session
   outranks both.

## Verification

The ladder is the `verify:quick`, `verify:smoke`, `gate`, and `check:all` scripts in
`package.json`; read them there. The default completion gate is `default_verification:`
in `docs/ROADMAP.yaml`, unless a task's own `verification:` key or its roster entry
overrides it. One Playwright runner at a time. No completion claim without the pasted
output of the assigned gate. Report exactly what ran and what was skipped.

## Git, landing, and session conduct

The session conduct rules live in `.planning/PLANNING_AUTHORITY.md` section 8 and are
read there, not here: commits and trailers, U+2014, heredocs, push and landing, schedules
and workflows, the Playwright runner and the completion gate, receipts, one writing
session per checkout, the public-tree check, and what a session does when a
precondition is unmet.

## Read caps

`context_hazards:` in `.planning/SESSION_ROSTER.yaml` lists the files never to read
whole: `src/styles/app.css`, `src/config/urls.ts`, `EXPLAIN_NPM.html`. Locate hunks by
grep and read ranges.

## Local tooling

`.claude/` is gitignored. Hooks live in `.claude/hooks/`, agents in `.claude/agents/`;
their model and effort assignments are recorded in the roster's `defaults.agents:`
block. Do not edit installed hooks; the owner installs them from drafts.
