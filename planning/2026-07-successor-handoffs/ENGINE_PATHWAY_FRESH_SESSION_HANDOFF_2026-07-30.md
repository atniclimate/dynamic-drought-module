# Fresh-session handoff: recover and complete the engine-planning checkpoint

Resume work in:

`I:\dynamic-drought-module`

This session was interrupted when Patrick changed physical locations. Treat
the uncommitted files and any surviving development processes as potentially
incomplete until they are inspected. Preserve the worktree exactly as found.
Do not reset, clean, stash, discard, or overwrite the pending changes.

The immediate task is to recover, verify, finish, and commit the planning
checkpoint described below. Do not begin the selected-place NIFC implementation
until that checkpoint is clean. Afterward, the next implementation remains the
bounded selected-place NIFC active-perimeter read.

Patrick has directed the successor to develop its underlying drought, heat,
fire, water, and usability engines further before additional broad design or
publication. Preserve the current responsive shell and apply only semantic or
accessibility corrections needed to understand the active engine milestone.

## Read first

Read these files completely before changing anything:

1. `I:\dynamic-drought-module\AGENTS.md`
2. `I:\dynamic-drought-module\docs\SUCCESSOR_PLAN.md`
3. `I:\dynamic-drought-module\docs\IDEAS.md`
4. `I:\dynamic-drought-module\docs\SOURCES_CATALOG.yaml`
5. `I:\dynamic-drought-module\docs\COVERAGE_MATRIX.md`
6. This handoff

Treat `src/config/layers.ts`, `src/config/capability-matrix.ts`, and runtime
code as authoritative when prose disagrees. The July 29 H2 and fire-pathway
handoffs are historical records, not active instruction sources.

## Expected repository state

Expected local state:

- Branch: `feature/heatrisk-legibility`
- Latest committed checkpoint:
  `bdbdf78 docs: align the post-H2 fire pathway`
- Working tree expected to be dirty with this interrupted planning draft:
  - modified `docs/SUCCESSOR_PLAN.md`;
  - untracked `docs/IDEAS.md`;
  - untracked `docs/SOURCES_CATALOG.yaml`;
  - untracked
    `docs/ENGINE_PATHWAY_FRESH_SESSION_HANDOFF_2026-07-30.md`.
- No configured local Git remote

Start with:

```powershell
Set-Location I:\dynamic-drought-module
git status --short --branch
git log --oneline --decorate -10
git remote -v
git diff --name-status
git ls-files --others --exclude-standard
git diff --check
git fsck --no-dangling
```

Confirm that the pending path list matches the expectation above. Read every
pending file completely and inspect `git diff`. If a file is missing,
truncated, malformed, unexpectedly modified, or contains conflict markers,
stop and reconstruct only that draft from this handoff and the committed
baseline. Do not treat unexpected changes as disposable.

No long-running project process was intentionally left running. Check
read-only process and port state before starting a server or test:

```powershell
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -like '*dynamic-drought-module*' } |
  Select-Object ProcessId, Name, CommandLine
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -in 4173, 5173 }
```

Do not terminate a process unless its command line proves it belongs to this
workspace and it conflicts with the required verification.

Expected external state remains:

- GitHub repository: `atniclimate/dynamic-drought-module`
- GitHub `main`: `e1a9084`
- Public application:
  `https://atniclimate.github.io/dynamic-drought-module/`
- Successful Pages workflow: `30513860839`
- Public build receipt: `e1a9084`
- Worker: `https://ddm-proxy.atniclimate.workers.dev`
- Worker revision: `2026-07-29-nws-point-heat-v2`

No deployment or publication is authorized by this handoff.

## Interrupted planning task

Patrick asked to:

1. Log
   `https://www.cpc.ncep.noaa.gov/products/predictions/threats/extremesTool.php`
   as a potential source.
2. Preserve advanced drought, heat, fire, water, and usability components in
   the post-0.7.x direction.
3. Postpone additional broad design and publication until the underlying
   engines are further developed.
4. Update the active planning documents and YAML source records.
5. Use one subagent for the first planning and ideas audit and a second
   subagent for an independent final pass.
6. Prepare this fresh-session handoff.

Both requested subagent reviews completed read-only before the interruption.
The first audit identified the engine gaps and the absence of a current ideas
file or source-catalog YAML. The second review found the draft coherent except
for one remaining legacy phase-clock issue:

- `src/config/capability-matrix.ts` still uses `N3` in the CONUS
  selectable-place note and `N6` in the transboundary display note.
- Because `docs/COVERAGE_MATRIX.md` is generated, replace those identifiers
  with plain capability language in the TypeScript source and run
  `npm run build:coverage-matrix`.

No other second-pass finding remained. The reviewer confirmed that the draft:

- retains drought, heat, fire, water, and shared usability engine directions;
- keeps selected-place NIFC as the only next implementation;
- defers broad design and publication while retaining semantic and
  accessibility acceptance;
- records the CPC source as candidate-only without runtime or capability
  claims;
- introduces no phase clock, review queue, or second delivery roadmap.

Before the interruption, these checks passed against the draft:

- `git diff --check`;
- a Node YAML parse and candidate-only shape assertion for
  `docs/SOURCES_CATALOG.yaml`;
- `npm run scan:emdash`.

They must be rerun because the physical move may have interrupted file or
process state.

## Planning state after recovery

The repository-alignment pass is complete in `bdbdf78`. It confirmed the H2
public release, corrected the Worker allow-list description, removed obsolete
phase promises, audited the fire path, and selected one bounded next milestone.
Do not repeat that pass.

The active successor plan now preserves post-0.7.x engine directions for:

- drought: independently gated sources and a verified selected-place gridded
  index seam without a new drought class;
- heat: issuer-separated point heat plus remaining time, unit, action, and
  week-2 guidance comprehension;
- fire: observed perimeters first, followed later by separately qualified
  alerts, smoke, outlooks, and long-term context;
- water: correct parsing and date semantics, exact basin or station support,
  independent capability, and bounded completed caching;
- shared usability: critical-first source rows, plain time and units,
  progressive provenance, honest source states, and appropriate next actions.

These directions are not parallel work and are not a phase clock. Promote only
one bounded milestone at a time.

The CPC Week-2 Probabilistic Extremes Tool is logged as a candidate in
`docs/SOURCES_CATALOG.yaml` and `docs/IDEAS.md`. It is not a runtime URL,
supported capability, Worker host, deployment dependency, or release
commitment. Do not implement it until a separate source-verification milestone
resolves the machine endpoint, schema, cadence, coverage, missing data, CORS,
terms, and issuer qualifications.

## Complete the checkpoint

After the integrity checks:

1. Remove `N3` and `N6` from `src/config/capability-matrix.ts` using plain
   current-capability wording.
2. Run `npm run build:coverage-matrix` and inspect the generated diff.
3. Confirm `docs/SUCCESSOR_PLAN.md` points to this handoff and contains one
   active implementation priority.
4. Confirm `docs/IDEAS.md` is a compact candidate bank, not a status ledger or
   second roadmap.
5. Confirm `docs/SOURCES_CATALOG.yaml` parses and keeps the CPC record at
   `status: candidate`, with every activation flag false.
6. Recheck the official CPC landing and description pages only if the draft
   evidence appears corrupt. The prior read-only review found calibrated
   week-2 GEFS guidance, not an official hazards outlook; runtime transport
   remains unverified.
7. Run the final verification below.
8. Commit the coherent local checkpoint. Do not push or publish.

## Next bounded milestone

Outcome:

> A person opening a selected place receives a concise, independently gated
> NIFC active-perimeter read before longer context, with honest spatial support,
> temporal meaning, absence, partial coverage, and failure.

Use the acceptance criteria in `docs/SUCCESSOR_PLAN.md`. The main seams already
confirmed by audit are:

1. `src/impact/source-policy.ts` still gates NIFC through broad regional drought
   synthesis.
2. `src/impact/hydrate.ts` exits the current horizon when that broad synthesis
   is unavailable.
3. `src/impact/sources.ts` caps the NIFC result at 50, does not validate the
   complete response before absence, does not report transfer-limit partial
   coverage, and has no completed-response cache.
4. `src/layers/nifc-fires.ts` also casts unvalidated JSON and can convert a
   malformed response into no data.
5. The selected-place NIFC claim currently sits inside Drought impact after
   point heat and landscape context, so it is not critical-first on mobile or
   in embeds.

Reuse the existing canonical geography, per-source capability, bounded cache,
and cancellation contracts. Do not create a separate fire architecture.

Keep source meanings separate:

- NIFC perimeters are observed mapped incidents.
- HMS smoke is satellite-derived observation or interpretation.
- NWS fire-weather products are alerts.
- SPC products are outlooks.
- Wildfire Hazard Potential and landscape fuels are long-term context.
- Drought and vegetation are contributing conditions, not ignition
  predictions.

Do not create a DDM fire-risk score, infer containment or exposure, or call
absence an all-clear.

## Later engine findings to preserve

Do not fix these inside the NIFC milestone, but do not lose them:

- The gridded SPI surface does not feed selected-place drought analysis.
- Several non-heat sources still inherit one broad regional impact-synthesis
  flag rather than independent capability.
- The water-supply parser can convert blank numeric fields to zero.
- The water-supply path labels an echoed requested date as an issue date.
- Water-supply selection uses representative state points and refetches the
  complete report without a bounded completed-response cache.
- Heat still needs local human-readable time before raw intervals, tested unit
  presentation, next-action usefulness, and real-user comprehension evidence.

Promote one of these only after the NIFC milestone closes cleanly.

## Design and release boundary

- Do not begin a broad visual redesign, navigation rewrite, CSS cleanup, or
  component refactor.
- Include only the smallest layout, wording, semantic, or accessibility change
  required for the active engine read to be understandable.
- Preserve desktop, mobile, `?embed=true`, the 200-pixel embed floor, URL state,
  sidebar controls, and iframe operation.
- Do not push GitHub `main`, deploy the Worker, change Pages, modify Sites,
  change access, or publish without a new explicit instruction.

## Verification

For the interrupted planning checkpoint:

1. Parse `docs/SOURCES_CATALOG.yaml` and assert its candidate-only activation
   flags.
2. Run `npm run scan:emdash`.
3. Run `npm run check:coverage`.
4. Run `npm run gate` because the final cleanup changes the generated
   capability source and active cross-engine planning.
5. Run `git diff --check`, inspect the final diff and status, and commit the
   checkpoint locally.

Do not run `npm run test:serial` for documentation and capability-note changes
alone.

During the later NIFC implementation:

1. Run focused source-policy, response-validation, cancellation, cache,
   partial-response, no-data, and stale-result tests.
2. Run affected selected-place desktop, mobile, and embed Playwright coverage.
3. Run `npm run gate` near completion.
4. Run `npm run test:serial` once at final closeout because the milestone changes
   shared briefing hydration and responsive release behavior.

Report exactly what ran. A green suite proves code behavior, not changing live
fire conditions, upstream reliability, or real-user comprehension.

## Desired handback

Return:

- the user-visible NIFC outcome;
- the source-policy and geography behavior implemented;
- spatial and temporal support shown to the user;
- cancellation, cache, response-validation, partial, absence, and stale-result
  evidence;
- mobile and embed comprehension evidence;
- exact verification results;
- final Git status;
- any external action that still requires authorization.
