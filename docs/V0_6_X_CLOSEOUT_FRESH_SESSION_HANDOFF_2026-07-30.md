# Fresh-session handoff: establish the v0.6.25 stabilization checkpoint

Resume work in:

`I:\dynamic-drought-module`

The immediate task is to complete a bounded current-interface stabilization,
reconcile the release identity, and prepare `v0.6.25` as a verified
stabilization checkpoint. This is not the final `0.6.x` release. Further
evidence-driven interface tweaks and adjustments remain in the `0.6.x` line.
Do not begin the selected-place National Interagency Fire Center implementation
until the interface line is explicitly closed.

This is a release checkpoint, not a redesign. Inspect the current application
before changing it. For `v0.6.25`, fix only demonstrated functional,
comprehension, accessibility, responsive, embed, URL-state, or
honest-source-state defects. Do not invent visual work to fill the milestone.

## Read first

Read these files completely before changing anything:

1. `I:\dynamic-drought-module\AGENTS.md`
2. `I:\dynamic-drought-module\ORIGIN.md`
3. `I:\dynamic-drought-module\docs\SUCCESSOR_PLAN.md`
4. `I:\dynamic-drought-module\docs\COVERAGE_MATRIX.md`
5. `I:\dynamic-drought-module\docs\IDEAS.md`
6. `I:\dynamic-drought-module\docs\SOURCES_CATALOG.yaml`
7. This handoff

Treat `src/config/layers.ts`, `src/config/capability-matrix.ts`,
`src/config/source-capability.ts`, `src/impact/source-policy.ts`, runtime code,
and the rendered application as authoritative when prose disagrees.

The July 29 heat and fire handoffs and the July 30 engine-pathway handoff are
historical records. Do not use them to restore National Interagency Fire Center
work as the current priority.

## Starting repository state

The following local state was captured before planning checkpoint `4518038`
was committed. It is retained as historical execution context, not as the
expected current release-candidate state:

- Branch: `feature/heatrisk-legibility`
- Head:
  `6374e05 docs: preserve the engine-first successor pathway`
- Captured pending paths:
  - modified `docs/SUCCESSOR_PLAN.md`;
  - untracked
    `docs/V0_6_X_CLOSEOUT_FRESH_SESSION_HANDOFF_2026-07-30.md`.
- No other pending path was expected.
- No configured local Git remote.
- Local `main` still points to the clean successor baseline
  `b20489a scaffold: establish clean DDM v0.6.24 baseline`.
- The retained `github-pages-source/main` reference points to the earlier
  public `v0.6.24` commit `d7257f1`; it is not a configured remote.
- The active branch contains published successor receipt `e1a9084` as an
  ancestor.

The planning checkpoint was committed locally as
`4518038 docs: plan the final 0.6.x closeout`. Its historical subject is
superseded by this handoff's checkpoint direction and does not close the
`0.6.x` interface line.

At the start of a resumed session, inspect the current state with:

```powershell
Set-Location I:\dynamic-drought-module
git status --short --branch
git log --oneline --decorate -12
git remote -v
git branch -a -vv
git tag --sort=-version:refname
git diff --name-status
git ls-files --others --exclude-standard
git diff --check
git fsck --no-dangling
```

Compare the current state with this historical context and the active
`v0.6.25` candidate diff. Read every pending file completely, inspect the full
diff, and scan for conflict markers. Do not reset, clean, stash, discard, or
overwrite an unexpected change.

At the captured starting point, the required sequence was:

1. Run `npm run scan:emdash`.
2. Run `git diff --check`.
3. Commit only the two planning paths as a local planning checkpoint.
4. Do not push, deploy, publish, tag, or change a remote.

The suggested commit subject was:

`docs: plan the v0.6.25 stabilization checkpoint`

That sequence is complete. Do not create a second planning checkpoint commit.

## Process and port recovery

No long-running project process is intentionally part of this handoff.
Before starting a server or browser verification, check:

```powershell
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -like '*dynamic-drought-module*' } |
  Select-Object ProcessId, Name, CommandLine

Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -in 4173, 5173 } |
  Select-Object LocalAddress, LocalPort, OwningProcess
```

Do not terminate a process unless its command line proves it belongs to this
workspace and it conflicts with the required verification.

## Current external state

Treat this as the expected external state until read-only verification proves
otherwise:

- GitHub repository:
  `atniclimate/dynamic-drought-module`
- GitHub `main`:
  `e1a9084`
- Public application:
  `https://atniclimate.github.io/dynamic-drought-module/`
- Successful GitHub Pages workflow:
  `30513860839`
- Public build receipt:
  `e1a9084`
- Public footer:
  `v0.6.24`
- Cloudflare Worker:
  `https://ddm-proxy.atniclimate.workers.dev`
- Worker revision:
  `2026-07-29-nws-point-heat-v2`

No external mutation is authorized by this handoff. Read-only public
verification is allowed when needed. A push, deployment, publication, tag
push, remote change, or access change requires a new explicit instruction.

## Why v0.6.25 exists

The starting release identity was not fully synchronized:

- `package.json` said `0.6.24`;
- both root version fields in `package-lock.json` said `0.6.23`;
- the application footer said `v0.6.24`;
- the latest local version tag was `v0.6.23`;
- the earlier public application and the materially expanded successor were
  both published under the human-readable `v0.6.24` label.

The current local candidate now aligns `package.json`, both root version fields
in `package-lock.json`, and the application footer at `0.6.25`, `0.6.25`, and
`v0.6.25`, respectively. It is not published or tagged. The public footer
remains `v0.6.24`, and the latest local version tag remains `v0.6.23`.

Do not rewrite or retroactively relabel that history. Exact Git receipt
`e1a9084` preserves the published successor identity.

The checkpoint creates one new, unique release:

> `v0.6.25`: current successor interface stabilization and release-identity
> reconciliation, with no new engine or source capability.

It does not close the `0.6.x` line. Further evidence-driven interface tweaks
and adjustments remain in `0.6.x`. The selected-place National Interagency
Fire Center perimeter read opens the `v0.7.0` development line only after the
interface line is explicitly closed.

Historical `D-0.7.0`, `D-0.8.0`, and similar identifiers in comments are
decision and planning references. They do not determine the application
version.

## Checkpoint outcome

A person can use the current successor across desktop, mobile, and embed
layouts without a known high-impact:

- functional defect;
- misleading first read;
- inaccessible control or broken focus path;
- responsive overflow, collision, or hidden control;
- embed or iframe regression;
- URL-state restoration failure;
- dishonest or ambiguous source state.

The exact published artifact then has:

- one human-readable version, `v0.6.25`;
- one exact Git commit receipt;
- a matching version tag on that receipt;
- aligned local and public `main` references after authorized publication.

## Scope fence

An interface correction is in scope only when evidence shows that it affects
at least one of:

- function;
- comprehension;
- accessibility;
- responsive layout;
- embed or iframe integrity;
- URL state;
- an honest source state;
- source, time, unit, or geographic-support meaning.

The following are out of scope:

- broad visual redesign;
- navigation or information-architecture rewrite;
- general Cascading Style Sheets cleanup;
- component refactoring for its own sake;
- new data sources;
- new source capability;
- National Interagency Fire Center selected-place implementation;
- Climate Prediction Center extremes implementation;
- new drought, heat, fire, or water scores;
- wholesale migration from the C-drive estate;
- import of the old harness, phase machinery, review queues, or handoff
  archives.

If the current interface passes an acceptance item, record the evidence and
leave it unchanged.

## Interface acceptance matrix

### Desktop

Use the established `1440x900` viewport and inspect:

- the bare opening state;
- map and sidebar containment;
- layer exploration and source states;
- place search and selection;
- selected-place briefing;
- time controls and the seven-day HeatRisk sequence;
- opening and closing the primary interface areas;
- source access and attribution;
- keyboard order;
- visible focus;
- focus return after dialogs, popovers, or sheets close;
- long source names, valid times, and provenance disclosure.

### Mobile

Use the established `390x844` viewport and inspect:

- the map-first opening;
- the mobile navigation doors;
- the hazard rail and selected state;
- place search and selection;
- selected-place briefing open, close, and return behavior;
- bottom-sheet containment and scrolling;
- safe-area behavior;
- primary touch targets;
- long labels, units, and time intervals;
- keyboard focus where applicable;
- absence of content hidden under fixed controls.

### Embed and iframe

Inspect both:

- standard embed: `400x600`;
- minimum width floor: `200x600`.

Use `?embed=true` and confirm:

- iframe-safe opening;
- no mobile navigation leakage;
- attribution remains reachable;
- source links remain usable;
- selected-place information remains understandable;
- URL state restores the same view;
- the embed does not claim unsupported space;
- no control or critical text is clipped or covered.

### Meaning and source honesty

Confirm that a person can distinguish:

- an observation from a forecast;
- a forecast from an alert;
- HeatRisk from National Weather Service point heat;
- current conditions from future guidance;
- complete results from partial coverage;
- `unavailable` from `no data`;
- a selected boundary from an area around a point;
- issuer content from Dynamic Drought Module synthesis;
- a failed source from an absence of conditions.

Preserve the six canonical layer states:

- `loading`;
- `live`;
- `live (partial)`;
- `unavailable`;
- `no data`;
- `zoom in to load`.

Do not use changing live values as fixed visual assertions.

## Audit and repair sequence

1. Establish the clean planning checkpoint.
2. Run `npm run gate` to confirm the inherited build baseline.
3. Inspect the current interface through the acceptance matrix.
4. Record only concrete reproducible findings.
5. Classify each finding as:
   - must fix for `v0.6.25`;
   - already covered and passing;
   - defer because it is redesign, a future engine seam, or unsupported by
     evidence.
6. Implement the smallest correction for each must-fix finding.
7. Run the narrowest relevant test after each correction.
8. Run affected Playwright specifications after each coherent group.
9. Repeat the relevant viewport inspection.
10. Do not continue polishing once the acceptance matrix passes.

Do not add a defect ledger, review queue, phase clock, or screenshot archive.
Concise notes in the final handback and ordinary Git history are sufficient.

## Version and release-document update

Only after the interface is stable:

1. Change the root version in `package.json` from `0.6.24` to `0.6.25`.
2. Change both root version fields in `package-lock.json` from `0.6.23` to
   `0.6.25`.
3. Change the application footer in `index.html` from `v0.6.24` to `v0.6.25`.
4. Add or update one concise release-note surface identifying `v0.6.25` as the
   verified stabilization checkpoint, not the final `0.6.x` release.
5. Describe only behavior actually included and verification actually run.
6. Do not change historical `v0.6.24` records in `ORIGIN.md`,
   `POST_MORTEM.md`, old handoffs, or existing commit history.
7. Do not create the `v0.6.25` tag before the exact published commit is known.

Use `apply_patch` for these file changes. Do not use package-manager version
commands that implicitly commit or tag.

## Local release-candidate verification

Run focused tests for every corrected interface area. At minimum, preserve
coverage for:

- desktop opening and selected-place behavior;
- mobile navigation and briefing behavior;
- standard and minimum-width embeds;
- keyboard and focus behavior;
- URL round trips;
- point heat;
- HeatRisk sequence;
- the six source states;
- static assets on root and subpath hosts.

Near completion, run:

```powershell
npm run gate
npm run test:serial
git diff --check
git status --short --branch
```

Inspect the complete diff and confirm that it contains only:

- evidence-driven checkpoint corrections;
- synchronized `0.6.25` version metadata;
- the concise release note;
- necessary tests for the corrections.

Do not run the full serial suite repeatedly. Run direct and affected tests
while developing, then the serial suite once for the final `v0.6.25`
candidate.

Create small coherent local commits at durable checkpoints. The final local
release candidate should have a clean worktree and a release commit such as:

`release: establish the v0.6.25 stabilization checkpoint`

Do not claim the candidate is deployed or published.

## Publication and tag boundary

Stop at a verified local release candidate unless Patrick explicitly
authorizes publication.

After explicit authorization, use this order:

1. Confirm the exact reviewed release commit.
2. Deploy the Cloudflare Worker only if its code or revision changed. No Worker
   change is expected for an interface-only checkpoint.
3. Publish the reviewed commit to public GitHub `main`.
4. Wait for the GitHub Pages workflow to complete successfully.
5. Verify the public subpath, entry asset, iframe behavior, URL state, point
   heat, source states, and exact build receipt.
6. Create the matching `v0.6.25` tag on the exact published commit.
7. Push the tag only if that external action is explicitly authorized.
8. Align local `main` and public GitHub `main` to the same commit without
   rewriting history.
9. Record the publication receipt without creating a second release identity.

Never force-push, reset history, rewrite a tag, or change a remote.

## Definition of done

The `v0.6.25` stabilization checkpoint is complete only when:

- the acceptance matrix has no known high-impact defect;
- desktop, mobile, and embed behavior are coherent;
- keyboard and focus behavior pass;
- the six honest source states remain intact;
- URL state and iframe operation pass;
- package metadata, package-lock metadata, and the footer all say `0.6.25`;
- the release note describes the actual checkpoint;
- `npm run gate` passes;
- `npm run test:serial` passes;
- the local release candidate is committed with a clean worktree;
- after authorization, the public artifact reports the exact reviewed commit;
- the `v0.6.25` tag points to that exact published commit;
- local and public `main` identify the same release baseline;
- no National Interagency Fire Center implementation entered the release.

Completing this checkpoint does not close the `0.6.x` interface line. Continue
subsequent evidence-driven interface tweaks and adjustments in `0.6.x`. An
explicit decision to close that line is required before `v0.7.0` work begins.

## Items that do not block v0.6.25

Do not delay the checkpoint for:

- the full historical source-catalog migration;
- national selected-place proof outside the Pacific Northwest;
- the National Interagency Fire Center selected-place report;
- Climate Prediction Center extremes research;
- water-supply parser corrections;
- a selected-place gridded drought-index read;
- broad external user research;
- a broad visual redesign;
- migration of old reviews, handoffs, or process records.

The old C-drive repository and its knowledge estate remain read-only. Recover a
source receipt, build tool, or design artifact only when a later active
milestone demonstrates that it is needed.

## Development after the v0.6.25 checkpoint

After `v0.6.25` is published, tagged, and established as the baseline,
continue bounded, evidence-driven interface work in `0.6.x`. Do not treat this
checkpoint as automatic authorization to open `v0.7.0`.

After the interface line is explicitly closed:

> Begin `v0.7.0` with one bounded milestone: a concise, independently gated
> National Interagency Fire Center active-perimeter read for a selected place.

Use the acceptance criteria preserved in `docs/SUCCESSOR_PLAN.md`. Do not begin
that implementation while the `0.6.x` interface line remains open.

## Acronym reference

- CPC: Climate Prediction Center
- CSS: Cascading Style Sheets
- DDM: Dynamic Drought Module
- NIFC: National Interagency Fire Center
- NWS: National Weather Service
- URL: Uniform Resource Locator

## Desired handback

Return:

- the concrete interface findings and which were corrected;
- evidence for desktop, mobile, standard embed, and minimum-width embed;
- accessibility and focus evidence;
- the final version values in `package.json`, `package-lock.json`, and
  `index.html`;
- the release-note path;
- exact focused-test results;
- exact `npm run gate` result;
- exact `npm run test:serial` result;
- the final local release-candidate commit and Git status;
- whether publication, tag creation, tag push, or branch alignment still
  requires authorization;
- confirmation that no National Interagency Fire Center implementation entered
  `v0.6.25`.
