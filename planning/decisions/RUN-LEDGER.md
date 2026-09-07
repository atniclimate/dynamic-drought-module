# Run ledger, DDM long run, 2026-09-03

Started from the launch prompt of 2026-09-03. Orchestrator-owned: only the
orchestrator writes to this file. Lane agents report to the orchestrator and write
only into `logs/` and `evidence/`.

**Recovery contract.** This file plus `git log` is how the run recovers if context
is compacted. Append a block after every step, as the step ends. Never compose this
file at the end and never reconstruct it by re-reading the tree.

**What lives in this directory**

| Path | What it is | Owner |
| --- | --- | --- |
| `RUN-LEDGER.md` | This file. One block per step, appended as the run goes | orchestrator |
| `decision-clear-inventory.md` | Leg 3a. Every open DDM-P7 through P14 task with a verdict and a receipt, and the queue for what this run does not reach | orchestrator, written by the inventory lane |
| `subagent-brief-common.md` | The brief every lane agent reads. Two session-specific lines filled at Leg 0 | orchestrator |
| `logs/` | Full command output, referenced by path from a ledger block, never pasted into context | any lane |
| `evidence/` | Screenshots and measurements a register entry cites, with a README naming each file and its citing entry | any lane, indexed at Leg 5 |

`planning/` is gitignored, so nothing here enters the repository, a build, or a CI
artifact. Confirm once with `git check-ignore -v` before the first write.

**Block shape.** One per step:

```
## <leg>.<step> <short name>, <clock time>
Ran: what happened, in one or two sentences.
Branch and SHA: <branch> at <sha>, pushed or not.
Verified: exactly which commands ran, with pass and fail counts and durations.
Skipped: what did not run and why.
Budget: any activation budget rebalanced, with the reason.
Open: any question for the owner, or "none".
```

---

## State at launch, from HANDOFF.md of 2026-09-03 14:55 PDT

Verify each of these in Preconditions before acting on it. They are recorded here
so that recovery from this ledger alone is possible.

- `main` = `cd1d061` = `origin/main`. Live and proven: deploy 33790475391 and
  verify-live 33791444498, both green, 2026-09-03 18:35 UTC. Version 0.6.26,
  untagged.
- Landing in Leg 1, in this order: `chore/housekeeping-2026-09-03` at `5f5c2c4`,
  `map/dr-064-perimeter-ribbon` at `95b5736`,
  `docs/roadmap-gate-transcription-2026-09-03` at `b67b6f2`. Only the ribbon
  touches `src/`, so only it deploys.
- Held, not landing this run: `map/dr-063-whp-ramp` at `68b33c1`.
- Register: `planning/decisions/2026-09-02-decision-register.yaml`, 68 entries,
  46 decided, 22 pending, `updated` stamp 2026-09-03T14:45.
- Launch rulings: `planning/decisions/2026-09-03-launch-rulings.md`. DR-067 b
  conditional, DR-068 b, DR-069 created, map-free sidebar yes bounded, Asana
  prepare only.

---

## 0.1 Machinery reconciliation

<!-- Append the first block here. Do not edit anything above this line except to
correct a fact that Preconditions proved wrong, and say in the block that you did. -->
