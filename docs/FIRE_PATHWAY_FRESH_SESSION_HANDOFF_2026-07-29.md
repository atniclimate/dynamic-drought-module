# Fresh-session handoff: resume the DDM successor pathway

Resume work in:

`I:\dynamic-drought-module`

The first task is a short retrospective and repository-alignment pass. Confirm
what H2 delivered, reconcile current project prose with evidence, and verify
that the next bounded milestone still advances the successor pathway. Do not
begin with a broad design pass or assume that the next fire gap is already
known.

Patrick has noted that the published application still needs design work.
Keep that observation visible, but apply design improvements incrementally
when a user-visible milestone reaches the relevant surface. The established
near-term product direction remains the source-fenced fire expansion.

## Read first

Read these files completely before changing anything:

1. `I:\dynamic-drought-module\AGENTS.md`
2. `I:\dynamic-drought-module\docs\SUCCESSOR_PLAN.md`
3. `I:\dynamic-drought-module\POST_MORTEM.md`
4. This handoff

Treat `src/config/layers.ts` and runtime code as authoritative when old prose
disagrees. The older
`docs/H2_CLOSE_FRESH_SESSION_HANDOFF_2026-07-29.md` is a historical record,
not an active instruction source.

## Expected repository and release state

Expected local state:

- Branch: `feature/heatrisk-legibility`
- Working tree: clean after the handoff commit
- Latest published documentation commit before this handoff: `e1a9084`
- Release merge: `83fa417`
- H2 implementation: `6f90be5`
- Worker release correction: `451275b`
- Application proxy activation: `45539e9`
- No configured local Git remote

Start with:

```powershell
Set-Location I:\dynamic-drought-module
git status --short --branch
git log --oneline --decorate -15
git remote -v
git diff --check
```

If the working tree is unexpectedly dirty, preserve the changes and inspect
them before writing. Do not reset, clean, stash, or discard user work.

Expected external state:

- GitHub repository: `atniclimate/dynamic-drought-module`
- GitHub `main`: `e1a9084`
- Public application:
  `https://atniclimate.github.io/dynamic-drought-module/`
- Successful Pages workflow: `30513860839`
- Public entry receipt: `e1a9084`
- Worker: `https://ddm-proxy.atniclimate.workers.dev`
- Worker revision: `2026-07-29-nws-point-heat-v2`
- Worker Cloudflare version:
  `db84d0d3-454f-4fa0-bbb5-6c068025ddf9`

An earlier owner-only Sites deployment exists but is not the publication
target. Do not use, modify, expose, or delete it without explicit
authorization.

## Progress to look back upon

The successor now has a coherent public path rather than only a local release
candidate:

1. The main-screen shell, hazard clusters, time controls, response summaries,
   URL state, embed behavior, and iframe operation are established.
2. HeatRisk uses issuer-accurate categories, exact-frame identification, and a
   seven-day selected-place sequence.
3. Exact Pacific Northwest ecoregion landscape context carries dated terrain,
   soil, land-cover, fuels, provenance, and honest absence.
4. H2 point heat uses canonical selected-place geography and independent
   per-source capability. It does not activate unrelated regional synthesis.
5. National Weather Service point discovery, grid series, observations,
   forecasts, and alerts are bounded, cancellable, cached only after success,
   and protected against stale results.
6. Observation and grid values remain separate, raw issuer intervals survive,
   and the synthesis does not invent a DDM heat class or threshold.
7. The Worker allowlists only `api.weather.gov`, identifies the application,
   revalidates redirects, preserves response bodies, and caps completed
   response edge caching at 60 seconds.
8. The Worker and GitHub Pages application are deployed, and the release is
   publicly reachable at the established ATNI URL.

Latest durable receipts:

- `npm run gate`: passed
- Critical heat, cancellation, Worker-policy, embed, and URL-state coverage:
  52 passed
- `npm run test:serial`: 649 passed
- GitHub Pages host, font, embed-guard, and hillshade coverage: 10 passed
- Pages workflow `30513860839`: passed
- Public root and entry asset: 200
- Public build receipt: `e1a9084`
- Worker typecheck: passed
- Worker audit: zero findings
- Eager application payload: 47.2 kB gzip
- Point-heat activation closure: 24.2 kB gzip under the 25 kB cap
- Full NWS point-heat path: at most six requests

## Required first sequence

### A. Reconstruct and reconcile

Before implementation:

1. Read the required files and inspect the current Git history.
2. Review the public H2 outcome against `docs/SUCCESSOR_PLAN.md`, `README.md`,
   `docs/COVERAGE_MATRIX.md`, and the runtime source contracts.
3. Use read-only checks to confirm GitHub `main`, the Pages workflow result,
   the public URL, the public build receipt, Worker health, and Worker
   revision. Do not treat changing live data values as deterministic tests.
4. Search current project prose for stale claims that H2 is uncommitted,
   undeployed, or unpublished. Historical dated documents may remain when
   clearly marked historical.
5. Update only active project files whose claims or next priorities are
   demonstrably stale. Do not create a second roadmap, ledger, phase clock, or
   review queue.
6. Commit a small alignment change if files needed correction. If nothing is
   stale, report that plainly instead of churning prose.

This alignment pass is local work. It does not authorize a push, deployment,
publication, access change, or external-service mutation.

### B. Confirm the next bounded milestone

The next established direction is to apply the H2 source fence to fire. Start
by inspecting existing behavior rather than adding a new fire framework:

- `src/config/geography.ts`
- `src/config/source-capability.ts`
- `src/impact/source-policy.ts`
- `src/impact/sources.ts`
- `src/impact/fire-context.ts`
- `src/impact/hydrate.ts`
- `src/config/clusters.ts`
- `src/config/presets.ts`
- `src/layers/nifc-fires.ts`
- `src/layers/hms-smoke.ts`
- `src/layers/nws-alerts.ts`
- `src/layers/spc-fire-weather.ts`
- `src/layers/usfs-whp.ts`

Compare the current fire path with these required properties:

- canonical selected-place geography;
- independent per-source capability;
- explicit spatial support and temporal meaning;
- cancellable, time-bounded requests through body consumption;
- bounded completed-response caching with no failed or aborted promotion;
- stale-result protection;
- issuer-preserving synthesis;
- critical-first mobile and embed reporting;
- honest `unavailable` and `no data` behavior.

Keep the source meanings separate:

- NIFC perimeters are observed incidents;
- HMS smoke plumes are satellite-derived observations or interpretations;
- NWS alerts and SPC outlooks are alerts or forecasts;
- Wildfire Hazard Potential and landscape fuels are long-term context;
- drought and vegetation are contributing conditions, not ignition
  predictions.

Do not create a DDM fire-risk score, combine sources into a new severity
class, call absence an all-clear, or promote an entire regional capability
because one source works nationally.

After the audit, define one user-visible fire milestone with a concise outcome
and acceptance criteria. Prefer the smallest missing seam that lets a selected
place receive a source-honest fire read. Reuse the heat source contract rather
than building a separate fire architecture.

### C. Keep design work on the pathway

Patrick has explicitly identified design work as necessary. During the first
review:

1. Record concrete usability evidence, not a general redesign wish list.
2. Preserve the current responsive viewports and iframe behavior.
3. If the chosen fire milestone touches a weak surface, include the smallest
   design correction needed for comprehension and verify it visually.
4. Defer unrelated visual polish to a later bounded milestone.

Do not begin with a broad CSS cleanup, navigation redesign, or component
refactor.

## Verification and release boundaries

Use narrow checks while auditing or implementing. For a fire change, run its
focused tests first, affected mobile and embed coverage next, `npm run gate`
near completion, and `npm run test:serial` once at final closeout when shared
navigation, map lifecycle, state, or release readiness changed.

Report exactly what ran. A green suite proves code behavior, not live upstream
reliability or real-user comprehension.

No future deployment is pre-authorized. Do not push GitHub `main`, deploy the
Worker, change Pages, change access, or modify the earlier Sites deployment
without a new explicit instruction.

## Desired fresh-session handback

The fresh session should return:

- the progress and release state it confirmed;
- active project files it updated, or a clear statement that none were stale;
- the evidence that the work remains on the successor pathway;
- the one proposed or implemented fire milestone;
- design observations kept in or out of that milestone, with reasons;
- exact verification results;
- final Git status;
- any external action that still requires authorization.
