# Design documentation

This directory preserves owner input, current presentation contracts, and
historical implementation evidence without turning any of them into a second
roadmap. Runtime source, state contracts, accessibility behavior, and tests are
authoritative when an older artifact disagrees with the shipped application.
Current written owner direction, review comments, and direct corrections
govern the intended design change and outrank older annotations or receipts.
The runtime remains the functional truth until that change is implemented;
when intent and an existing contract conflict, surface the conflict rather
than silently treating either one as a veto.

## Artifact authority

| Artifact | Role |
| --- | --- |
| [`README.md`](README.md) | This index and the durable product-design doctrine. |
| [`../../ROADMAP.md`](../../ROADMAP.md) | Public phase synopsis and route to the canonical task definitions. |
| [`../ROADMAP.yaml`](../ROADMAP.yaml) | Canonical product plan: phases and tasks with stable ids, decision gates, component tags, and one acceptance sentence per open task. Execution status lives outside the repository. |
| [`mobile-map-chrome.md`](mobile-map-chrome.md) | Current presentation contract for the map-first phone chrome implemented by pull request 7. |
| [`fire3d-context.md`](fire3d-context.md) | Honesty framing for the desktop 3D Fire context view: the no-fire-behavior-modeling line, the "not a digital twin" naming decision, and the in-interface non-prediction disclosure. |
| [`ddm_interface-edits_1.json`](ddm_interface-edits_1.json) and [`ddm_interface-edits_2.json`](ddm_interface-edits_2.json) | Immutable owner-annotation captures that informed pull request 6. They preserve the input as received; they are not an active plan, literal pixel specification, or current completion checklist. |

Owner markup communicates hierarchy, relationships, emphasis, and intended
interaction. Its sketch colors and geometry are not automatically literal UI
colors or fixed coordinates. A shipped implementation translates that intent
through the current data, state, responsive, accessibility, and stewardship
contracts.

Merged product changes and observed deployment facts belong in
[`../RELEASE_NOTES.md`](../RELEASE_NOTES.md). The roadmap defines planned
scope, Asana carries execution state, and runtime plus tests define implemented
behavior. Do not duplicate those roles in this design index.

## Current direction, recorded 2026-09-01

By owner direction the briefing is named the Impact Briefing, and it is being
extended from its drought-only framing to synthesize Drought, Fire, Heat, and
ENSO. The eventual host for the module is a local full-service server; GitHub
Pages remains the static host for now. Per-action continuous integration
receipts are no longer the development posture: work converges on one
integration branch and lands as one pull request.

## Standing interface invariants and decisions

Lifted 2026-09-01 from the closed 2026-08-10 interface-integration ledger,
which is now archived. These are the constraints and decisions from that
migration that the shipped runtime still enforces, kept here because nothing
else tracked records them. Where a runtime file owns the constraint it is named,
and each named path was confirmed to exist on 2026-09-01.

### Invariants

- No sovereign-jurisdiction geometry is added or redistributed.
- Tribal and Treaty representation caveats remain intact, and those outlines
  stay above the condition surfaces (`src/map/layer-order.ts`).
- One MapLibre map and one exclusive condition surface remain authoritative
  (`src/state/layer-controller.ts`).
- URL-as-state, Back, reload, legacy links, `?embed=true`, and iframe operation
  remain valid (`src/state/url.ts`).
- `loading`, `live`, `live (partial)`, `unavailable`, `no data`, and
  `zoom in to load` remain six distinct states (`src/state/layer-controller.ts`).
- Non-trivial network work is cancellable and time-bounded, and a late response
  cannot revive torn-down state.
- A failed current WFIGS framing query never falls through to static Wildfire
  Hazard Potential (`src/state/minimap-wildfire.ts`).
- Ocean click targets are schematic ENSO navigation, not claims about ocean
  boundaries (`src/config/oceans.ts`).
- No hotspot feed, incident point feed, fire score, synthetic incident, or new
  selected-fire engine is added.
- Repository-authored text contains no U+2014 em dash.

### Decisions

- **DDM-UI-002.** `basemap=satellite` means recent NOAA imagery. Wildfire,
  hazard-fire, and fire-risk request it only on an explicit user action, never
  during boot or URL restoration (`src/map/satellite.ts`,
  `src/state/basemap-store.ts`).
- **DDM-UI-003.** The shell, cluster service, URL sync, and region command are
  reused through named adapters rather than reimplemented per surface
  (`src/ui/island/shell.tsx`, `src/state/cluster-service.ts`).
- **DDM-UI-004.** Drought receives a backed NADM mean-severity and
  outline-share summary. Wildfire receives a strict current-WFIGS-first
  summary, with static WHP thresholds used only after a successful zero count.
  Heat, ENSO land framings, and custom views stay explicitly neutral
  (`src/state/minimap-drought.ts`, `src/state/minimap-wildfire.ts`).
- **DDM-UI-006.** Prescribed fire is split from wildfire within the existing
  WFIGS perimeter source (`src/layers/nifc-fires.ts`).
- **DDM-UI-007.** HMS smoke density renders through one cool hue and opacity;
  unknown remains explicitly unclassified (`src/layers/hms-smoke.ts`).
- **DDM-UI-008.** Pinned Natural Earth 1:50m physical land and lakes supply
  presentation linework while ATNI-authored subregions stay the click geometry.
  No state or province boundaries are added (`src/config/minimap-geometry.ts`,
  `src/config/framing-shapes.ts`).
- **DDM-UI-009.** Pacific, Arctic, and Atlantic are separate accessible
  controls, and each click commits ENSO plus its ocean camera and URL state in
  one transaction (`src/config/oceans.ts`).
- **DDM-UI-010.** A red Wildfire minimap state means at least one current
  mapped WFIGS wildfire or incident-complex perimeter, not an incident total.
  Static WHP orange and yellow states are United States-only potential context
  and never imply current fire (`src/state/minimap-wildfire.ts`,
  `src/config/minimap-whp.ts`).
- **DDM-UI-011.** HeatRisk sequence DOM, focus, and delegated click targets
  survive redundant raster-status events while an identify read is pending or
  cached (`src/ui/heatrisk-sequence.ts`, `src/util/raster-status.ts`).

Two decisions from that ledger were not carried forward because the runtime no
longer matches them: DDM-UI-001 governed EOX 2016 historical imagery, which the
runtime no longer loads, and DDM-UI-005 deferred a 3D entry point that has
since shipped as the governed Fire 3D context view.

## Convergence doctrine

DDM is not merely a map. It is an instrument for making claims responsibly
about conditions that can shape decisions during drought, wildfire, heat, and
other climate stress. Its design quality therefore includes the honesty of
what it says, what it cannot say, and how visibly it preserves that boundary.

### Truthfulness is interface design

The interface may compress, sequence, group, or progressively disclose a
source claim. It must not broaden the claim's meaning, time, geography,
completeness, or certainty. `no data`, `unavailable`, `live (partial)`, and a
verified absence remain different states. A visual summary must retain a path
to its source, update time, qualification, and provenance.

### Design for a field instrument

DDM should work as an instrument used in bright light, on a small screen, with
one hand, intermittent source availability, and limited attention. The first
read should be glanceable. Touch targets, focus, contrast, safe areas, and
reduced-motion behavior are core design inputs. Progressive disclosure adds
depth without hiding the condition, source, or status a decision depends on.

### Emphasis must be ethical

Color, contrast, scale, hierarchy, and motion may foreground a condition only
when the underlying evidence and class warrant that emphasis. Motion never
upgrades evidence, turns a representation into an incident claim, or implies a
forecast. The reduced-motion presentation must communicate the same meaning
without animation. Urgency comes from clear prioritization, not alarm styling.

### Creativity comes from truthful arrangement

Creative range lives in how governed facts are framed, layered, juxtaposed,
sequenced, and connected through interaction. It does not require an invented
severity score, blended hazard claim, all-clear, causal story, or capability
the sources do not provide. A novel arrangement is successful when it helps a
person see a truthful relationship sooner.

### Urgency raises the standard

Time pressure does not waive attribution, accessibility, cancellation,
failure handling, responsive verification, or source qualification. The more
urgent the use case, the more important it is that the display fail honestly
and preserve the user's state. Work should move in bounded visible slices,
with limitations and verification reported directly rather than hidden behind
process ceremony.

### Co-creation is translation with receipts

The owner supplies purpose, lived priorities, annotations, and acceptance
judgment. Implementation reconciles that intent with the application's real
data and state contracts, shared design primitives, browser constraints,
accessibility, and Tribal stewardship. When those constraints require an
adaptation, preserve the owner's relationship and hierarchy, record the
reason, and return a visible working result for review. Tests and screenshots
are evidence of the translation, not substitutes for owner judgment.

Neither perspective is complete alone. The owner sees community context,
consequences, institutional relationships, and meaning that implementation
cannot infer from a repository. The implementation partner sees cross-file
coupling, lifecycle hazards, browser behavior, and verification seams that the
owner should not have to enumerate. Respect means both forms of knowledge can
change the work, and that a meaning-changing assumption returns to the owner
instead of being hidden inside code.

### Convergence is systems alignment

A working name for this alignment and development method is convergence
systems architecture. It treats interface, data, state, stewardship, and
verification as one claim-bearing system rather than separate finishing
passes.

A change converges when mission and stewardship, source evidence, application
state, URL truth, presentation, accessibility, lifecycle behavior, tests, and
the observed application tell the same story. A mismatch between those layers
is unfinished work even when each layer looks reasonable in isolation.

The working sequence is:

```text
purpose and stewardship
-> claim and source
-> state and URL
-> presentation and interaction
-> accessibility and failure behavior
-> tests and live observation
-> documentation and release evidence
```

Documentation and release evidence close the loop by separating current
authority from historical evidence, recording known limits, and leaving one
coherent foundation for the next bounded decision.

## Convergence check

A design is ready to ship when these questions have concrete answers:

1. What decision or first-glance understanding improves for the user?
2. Which source and state contracts support every visible claim?
3. Does emphasis match evidence without overstating urgency or certainty?
4. Does the same meaning survive mobile, desktop, embed, keyboard, source
   failure, and reduced motion?
5. Which reusable token or component carries the pattern, and which exception
   is semantically necessary?
6. What test, inspection, or screenshot demonstrates the result and its known
   limits?

This is a design-quality check, not a phase gate or parallel project ledger.
