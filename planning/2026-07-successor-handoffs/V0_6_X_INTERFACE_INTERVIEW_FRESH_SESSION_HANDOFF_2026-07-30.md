# Fresh-session handoff: interview and plan the next 0.6.x interface microtasks

Resume work in:

`I:\dynamic-drought-module`

The next session begins with an interview with Patrick about the interface
design work he wants to complete in the `0.6.x` line. Do not begin by editing
code, inventing a polish backlog, publishing `v0.6.25`, or starting a feature.

The interview outcome is a finite, easy-to-follow phase plan made of small
interface microtasks. The emphasis is fine-tuning the existing product, not
adding capability. Present the proposed plan to Patrick before implementation.
Proceed into code only if Patrick asks to continue after reviewing it.

The main agent owns the interview and product synthesis. Patrick has asked that
subagents handle much of the later work, so after the plan is approved,
delegate bounded read-only audits, non-overlapping implementation microtasks,
and focused verification where that reduces context load. Do not delegate the
interview itself or split product decisions across agents.

## Read first

Read these files completely before the interview:

1. `I:\dynamic-drought-module\AGENTS.md`
2. `I:\dynamic-drought-module\ORIGIN.md`
3. `I:\dynamic-drought-module\docs\SUCCESSOR_PLAN.md`
4. `I:\dynamic-drought-module\docs\COVERAGE_MATRIX.md`
5. `I:\dynamic-drought-module\docs\RELEASE_NOTES.md`
6. This handoff

The completed checkpoint handoff,
`docs/V0_6_X_CLOSEOUT_FRESH_SESSION_HANDOFF_2026-07-30.md`, is historical
execution evidence. Do not repeat its completed version reconciliation,
verification, or release-candidate work.

Treat `src/config/layers.ts`, `src/config/capability-matrix.ts`,
`src/config/source-capability.ts`, `src/impact/source-policy.ts`, runtime code,
and the rendered application as authoritative when old prose disagrees.

## Exact local baseline

Application checkpoint and expected starting state:

- Branch: `feature/heatrisk-legibility`.
- Verified application checkpoint:
  `05767d4a3ee3e7e023c40aaff1b6f241dfea410d`
  (`release: establish the v0.6.25 stabilization checkpoint`).
- The expected session head is a docs-only descendant with subject
  `docs: hand off the 0.6.x interface interview`.
- Worktree: clean.
- The active branch has no upstream.
- No Git remote is configured.
- Local `main` remains
  `b20489ae1a592c4f6e25d59df964bd05eb347a44`.
- Retained reference `github-pages-source/main` remains
  `d7257f18a7fbc50d60fd606d35342228a8f70cb8`; it is not a configured remote.
- Published successor receipt
  `e1a9084ca86b1de3fa484cc78bea872781c350fe` is an ancestor of the active
  branch.
- No tag points at `05767d4`.
- No local `v0.6.24` or `v0.6.25` tag exists.
- The latest local semantic version tag remains `v0.6.23`.

Local version identity is aligned:

- `package.json`: `0.6.25`;
- both root `package-lock.json` version fields: `0.6.25`;
- application footer: `v0.6.25`.

The local `v0.6.25` checkpoint is implemented, verified, and committed. It is
not published or tagged. The public state recorded by the active documents
remains Git receipt `e1a9084` with footer `v0.6.24`; verify that externally
before relying on it if publication work is later authorized.

Start with read-only checks:

```powershell
Set-Location I:\dynamic-drought-module
git status --short --branch
git log --oneline --decorate -8
git remote -v
git branch -a -vv
git tag --sort=-version:refname
git diff --check
git fsck --no-dangling
```

Do not reset, clean, stash, discard, or overwrite an unexpected change.

## v0.6.25 checkpoint receipt

The committed local checkpoint records:

- `npm run gate`: passed;
- `npm run test:serial`: 649 passed;
- focused point-heat and popup rerun: 2 passed;
- standard and 200-pixel embed viewport specification: 5 passed;
- root-host and deployment-subpath static-host specification: 1 passed;
- package, lockfile, and footer identity aligned at `0.6.25`;
- no reproducible runtime interface defect requiring an application change;
- one date-sensitive point-heat browser test fixed by pinning its clock;
- no new source, source capability, engine, Worker change, or National
  Interagency Fire Center implementation;
- no new manual visual-browser inspection claimed.

The current eager application payload remains 47.2 kB gzip. Point heat remains
under its 25 kB first-activation budget.

Do not rerun the full serial suite just to begin the interview. Verification
should follow the microtasks Patrick actually selects.

## External boundary

The interview and local planning do not authorize any external mutation.

Still unauthorized:

- publishing or pushing a commit;
- updating public GitHub `main`;
- creating or pushing `v0.6.25`;
- deploying the static application or Cloudflare Worker;
- aligning local `main` with another reference;
- adding or changing a remote;
- changing repository access.

Do not make publication a prerequisite for conducting the interview or writing
the local plan. If Patrick later authorizes publication, return to the
publication order in the completed checkpoint handoff and verify the exact
commit that would be published.

## Product direction

The `0.6.x` interface line remains open. `v0.6.25` is a stable checkpoint, not
the final `0.6.x` release.

The next work is user-directed interface fine-tuning. Patrick's explicit design
preference is valid product evidence for this stage. Translate that preference
into observable acceptance rather than requiring every adjustment to begin as
a functional defect.

Fine-tuning may address:

- visual hierarchy and what draws attention first;
- typography, spacing, density, rhythm, borders, shadows, and color tokens;
- control size, placement, alignment, consistency, and affordance;
- labels, helper text, progressive disclosure, and comprehension;
- map, sidebar, briefing, navigation, time-control, and source balance;
- responsive containment and priority on desktop, mobile, and embeds;
- keyboard order, visible focus, focus restoration, contrast, touch targets,
  motion, and semantics;
- presentation of source, valid time, units, geographic support, and honest
  source state.

This authority does not silently expand into a redesign or feature program.

## Interview protocol

Conduct the interview conversationally. Ask one small group of questions at a
time. After each group, summarize what you heard and let Patrick correct it
before moving on.

Do not turn the list below into one large questionnaire. Adapt follow-up
questions to Patrick's answers and skip questions already resolved.

### Round 1: desired outcome

Begin with:

> When you look at the current module, which three interface areas feel most
> unfinished or irritating, and what feels wrong about each one?

Then establish:

1. Which existing journey needs attention first:
   - opening the module;
   - exploring layers;
   - searching for and selecting a place;
   - reading the selected-place briefing;
   - using time controls or HeatRisk;
   - reviewing sources and attribution;
   - another existing journey.
2. Which users should benefit most and what should become easier for them.
3. Which parts already feel right and must not drift.
4. What should feel noticeably better when this `0.6.x` work is successful,
   without adding a capability.

### Round 2: screen-by-screen review

Walk through the rendered application if the browser surface is available. If
it is not, use Patrick's descriptions or attached screenshots and state that
limitation. Do not claim a visual inspection that did not occur.

Ask:

1. On the bare opening screen, what should draw the eye first, second, and
   third?
2. Do the map, sidebar, navigation doors, and controls have the right visual
   balance? What should gain or lose emphasis?
3. Which layer controls or labels feel crowded, inconsistent, unclear, or
   detached from what they affect?
4. Where does place search or selection feel awkward or insufficiently
   obvious?
5. In the selected-place briefing, what must stay immediately visible, what
   should become quieter, and what should move into progressive disclosure?
6. Do the time controls and HeatRisk sequence distinguish current conditions,
   future guidance, and issuer intervals clearly enough?
7. Are source links, provenance, qualifications, and source states visible
   enough without competing with the primary read?

### Round 3: visual direction

Ask:

1. How should the interface feel overall: calm, compact, operational,
   editorial, map-forward, data-dense, or something else?
2. Which qualities need the most attention:
   - typography;
   - spacing and rhythm;
   - density;
   - color and contrast;
   - borders and shadows;
   - control shapes;
   - icon consistency;
   - map prominence.
3. Where does the type hierarchy fail to separate headings, findings,
   qualifications, metadata, and actions?
4. Where is the interface too dense, and where does it waste space?
5. Are there products, screenshots, or references to draw from? Identify the
   exact qualities to borrow and the qualities to avoid.
6. Which existing colors, shapes, labels, or interaction patterns should be
   preserved exactly?

### Round 4: responsive and inclusive behavior

Review the established viewports:

- desktop: `1440x900`;
- mobile: `390x844`;
- standard embed: `400x600`;
- embed width floor: `200x600`.

Ask:

1. What desktop layout or hierarchy change would provide the greatest
   improvement?
2. What feels cramped, overly long, hard to reach, or easy to lose on mobile?
3. What information must remain immediately usable in embeds, and what may be
   progressively disclosed?
4. Are the navigation doors, bottom sheet, long labels, attribution, source
   links, and selected-place report behaving as expected on small screens?
5. Has Patrick noticed keyboard order, visible-focus, focus-restoration,
   touch-target, contrast, motion, or screen-reader wording problems?
6. Should any requested fine-tuning behave differently by viewport?

### Round 5: scope and priority lock

Ask:

1. Which requested changes are presentation or comprehension changes, and
   which might introduce new behavior, information, or navigation?
2. Which single adjustment should be completed first?
3. What observable before-and-after result would make it complete?
4. Which related adjustments solve one user-visible problem and belong
   together?
5. Which changes should remain separate because they can be accepted or
   reverted independently?
6. What must stay out of the remaining `0.6.x` interface work?
7. Should every microtask receive its own commit, or should a tightly related
   group share one checkpoint?

## Interview output

Before implementation, return a concise synthesis containing:

1. Patrick's desired overall interface character, in his terms.
2. The strongest user journeys and pain points.
3. Elements that must be preserved.
4. Explicit non-goals.
5. A prioritized microtask list.
6. A proposed phase plan.
7. The exact first microtask, its acceptance, and its verification.
8. Questions or conflicts that still need Patrick's decision.

Do not quietly resolve contradictory preferences. Point out the conflict and
ask Patrick which outcome has priority.

## Converting answers into microtasks

Each microtask must have:

- one existing user-visible problem or design outcome;
- one concise result;
- the exact existing surfaces affected;
- the applicable viewports;
- observable acceptance criteria;
- accessibility acceptance where relevant;
- invariants that must remain unchanged;
- focused verification;
- explicit exclusions and a stop condition.

Split a candidate when it:

- changes unrelated surfaces;
- requires different acceptance evidence;
- crosses from presentation into new behavior;
- touches a risky interaction seam that can be isolated;
- could be reverted independently.

Keep changes together only when separation would leave the same user-visible
problem half-solved.

A good microtask should usually be small enough for:

- one coherent user-visible adjustment;
- a narrow set of production files;
- one focused test group;
- viewport reinspection of only the affected surfaces;
- one durable local commit.

Do not assign several active microtasks. Keep one ordered list and activate only
the first item.

## Phase-plan format

Patrick asked for an easy-to-follow phase plan. Create plain numbered execution
groups, not a phase harness or second project-management system.

Use this structure:

```text
Phase N: user-visible outcome

Goal:
Microtasks:
Existing surfaces:
Applicable viewports:
Acceptance evidence:
Focused verification:
Explicit exclusions:
Stop condition:
```

The interview determines the actual order. A provisional skeleton is:

1. Interview, evidence capture, and scope lock.
2. Highest-impact visual hierarchy and shell fine-tuning.
3. Existing interaction and control-consistency fine-tuning.
4. Selected-place, time, source, and progressive-disclosure comprehension.
5. Mobile and embed containment adjustments.
6. Accessibility and cross-viewport coherence review.
7. One integrated `0.6.x` release candidate and release verification.

Accessibility and responsive integrity are acceptance criteria in every phase,
not cleanup reserved for the end.

The plan must not add:

- a status table;
- task IDs or a parallel numbering system;
- owners or review queues;
- a change ledger;
- a dependency graph for its own sake;
- a parallel release clock;
- a second roadmap.

After Patrick accepts the plan, keep the concise active priority in
`docs/SUCCESSOR_PLAN.md`. Use an ordinary issue and Git history for
implementation detail and durable completion evidence.

## Scope fence

In scope after interview approval:

- bounded changes to existing interface presentation and comprehension;
- CSS custom-property tuning;
- narrow markup or configuration changes needed for the chosen interface
  result;
- responsive, embed, focus, keyboard, touch, and contrast corrections;
- targeted regression coverage for the selected microtask.

Out of scope unless Patrick separately changes direction:

- a new data source or source capability;
- a new engine, score, classification, or selected-place content block;
- National Interagency Fire Center selected-place implementation;
- Climate Prediction Center extremes work;
- Worker or data-pipeline changes;
- a new navigation model or information-architecture rewrite;
- broad visual redesign detached from the interview;
- general CSS cleanup;
- component refactoring for its own sake;
- analytics, tracking, authentication, or proprietary tiles;
- publication, deployment, tagging, branch alignment, or version selection.

Do not automatically assign `v0.6.26`. Choose a later checkpoint identity only
after the agreed microtasks and release boundary make that decision necessary.

## Product invariants

Every phase and microtask must preserve:

- the static application model;
- `?embed=true` and iframe operation;
- URL-as-state behavior;
- existing sidebar controls and the mobile navigation model;
- the six honest states:
  - `loading`;
  - `live`;
  - `live (partial)`;
  - `unavailable`;
  - `no data`;
  - `zoom in to load`;
- observation, forecast, alert, HeatRisk, and current/future distinctions;
- source, time, unit, and geographic-support meaning;
- cancellation and time bounds for non-trivial network work;
- Tribal sovereignty and Treaty representation caveats;
- empty deployer-owned sovereign-jurisdiction placeholders;
- attribution and source access;
- no tracking, analytics, authentication, or proprietary tile provider.

Capitalize Tribe, Tribal, and Treaty when referring to Tribal Nations or Treaty
rights. Do not abbreviate the formal name of a Tribal Nation. Do not author the
U+2014 em dash.

## Verification strategy

During implementation:

1. Inspect the exact current surface before changing it.
2. Capture the interview-defined before-and-after outcome.
3. Make the smallest coherent change.
4. Run the narrowest relevant check.
5. Run affected Playwright specifications.
6. Reinspect every affected viewport.
7. Commit a verified microtask before activating the next one.

For cross-cutting application changes, run `npm run gate`.

When shared navigation, map lifecycle, state, or release readiness changes, run
targeted Playwright coverage and then `npm run test:serial` once for the
integrated release candidate. Do not run the serial suite after every
microtask.

Use the browser skill for a visual review when it is available. If it is not
available, use deterministic Playwright geometry and behavior coverage, inspect
failure artifacts when relevant, and state the missing manual visual evidence.

Do not use changing live values as fixed assertions.

## Subagent coordination

After Patrick accepts the plan:

- keep the main agent responsible for product decisions, scope integration,
  final diff review, and user communication;
- delegate read-only audits by surface or viewport;
- delegate implementation only when file ownership does not overlap;
- delegate targeted verification separately where useful;
- give every subagent exact paths and an explicit no-external-action boundary;
- do not let subagents create competing plans or interpret Patrick's design
  preferences independently;
- inspect every shared-worktree change before committing it.

## Stop conditions

Stop and return to Patrick before implementation when:

- the requested design outcome is still ambiguous;
- two preferences conflict materially;
- a microtask would introduce a feature or new information;
- the change would rewrite navigation or information architecture;
- an external mutation becomes necessary;
- a new version or publication decision is required.

Stop fine-tuning a microtask when its agreed acceptance passes. Do not continue
polishing to fill a phase.

## Desired next-session handback

Return:

- the interview summary in Patrick's terms;
- the agreed design principles;
- the prioritized microtask list;
- the finite phase plan;
- the exact first microtask and acceptance criteria;
- the verification planned for that microtask;
- explicit non-goals and deferred items;
- any decision still needed from Patrick;
- confirmation that no feature, National Interagency Fire Center work,
  publication, deployment, tag, remote, or branch alignment occurred during
  the interview and planning stage.
