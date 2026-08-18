# Design documentation

This directory preserves owner input, current presentation contracts, and
historical implementation receipts without turning any of them into a second
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
| [`mobile-map-chrome.md`](mobile-map-chrome.md) | Current presentation contract for the map-first phone chrome implemented by pull request 7. |
| [`ddm_interface-edits_1.json`](ddm_interface-edits_1.json) and [`ddm_interface-edits_2.json`](ddm_interface-edits_2.json) | Immutable owner-annotation captures that informed pull request 6. They preserve the input as received; they are not an active plan, literal pixel specification, or current completion checklist. |
| `interface-integration/MODULE_TRACKING.yaml`, when present in a local stewardship workspace | Local-only historical scope and acceptance receipt for the August 10 interface-integration checkpoint. Its branch, commit, test, and publication state are frozen historical facts and must not be extended as a current status system. |

Owner markup communicates hierarchy, relationships, emphasis, and intended
interaction. Its sketch colors and geometry are not automatically literal UI
colors or fixed coordinates. A shipped implementation translates that intent
through the current data, state, responsive, accessibility, and stewardship
contracts.

Completed and deployed changes belong in
[`../RELEASE_NOTES.md`](../RELEASE_NOTES.md). Local handoff, successor-plan,
and idea-bank documents are separate working records that are intentionally
excluded from the published design corpus. Do not duplicate their status here.

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
-> true-up
```

True-up closes the loop by separating current authority from historical
receipts, recording known limits, and leaving one coherent foundation for the
next bounded decision.

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
