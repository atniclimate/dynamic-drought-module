# CLAUDE.md

Dynamic Drought Module (DDM): an embeddable static TypeScript + MapLibre web map of
drought, wildfire, and water conditions, built by ATNI Climate. This file is a map to
the sources of truth. It restates none of them. When it and a source disagree, the
source wins and this file is the bug.

## Read in this order

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

## Git and landing

- Commit only when the owner says go. Show the diff and the add-list first.
- No attribution trailers on any commit, ever.
- Never author U+2014. `scripts/scan-emdash.mjs` and the edit hook in `.claude/hooks/`
  enforce this.
- Landing a branch is the owner's call and happens as a `--no-ff` merge commit on
  `main` when it does. Do not push, open a landing PR, merge, deploy, tag, publish the
  Worker, mutate Asana, force-push, or delete branches without the owner's say. No new
  cron jobs (DR-061 in `planning/decisions/`).
- One writing session per checkout, counting Codex sessions: a Claude Code session and
  a Codex session open on the same checkout is a violation. Unexplained dirty files or
  a moved `origin/main` belong to the owner working concurrently: report, never stage
  or revert.

## Read caps

`context_hazards:` in `.planning/SESSION_ROSTER.yaml` lists the files never to read
whole: `src/styles/app.css`, `src/config/urls.ts`, `EXPLAIN_NPM.html`. Locate hunks by
grep and read ranges.

## Local tooling

`.claude/` is gitignored. Hooks live in `.claude/hooks/`, agents in `.claude/agents/`;
their model and effort assignments are recorded in the roster's `defaults.agents:`
block. Do not edit installed hooks; the owner installs them from drafts.
