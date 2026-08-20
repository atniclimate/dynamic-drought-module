# Dynamic Drought Module roadmap

DDM is moving from a strong Pacific Northwest foundation toward a more
reliable, calmer, and more field-ready climate and hazard instrument. The next
work starts with release convergence and lifecycle correctness, then improves
responsive interaction, Fire and ENSO interpretation, and carefully bounded
smoke-altitude research.

The canonical task definitions, stable IDs, dependencies, decision gates,
component tags, non-goals, and acceptance evidence are in
[`docs/ROADMAP.yaml`](docs/ROADMAP.yaml). Asana carries live execution status,
assignees, and due dates. GitHub issues, pull requests, Git history, validation
workflows, release notes, and the deployed build marker provide completion
evidence. The YAML therefore contains no mutable status fields and is not a
second project tracker.

## Delivered foundation

The v0.6.25 source baseline includes the answer-first Brief and console views,
map-first phone controls, URL-governed state, iframe operation, responsive and
accessibility contracts, governed Fire 3D context, a USFS Wildfire Hazard
Potential drape, independent power infrastructure context, a bounded building
structures pilot, and a stylized HMS smoke-density volume. The smoke display
is not measured plume altitude or concentration, and the Fire view is not a
simulation or forecast.

Historical release details and their verification receipts are in
[`docs/RELEASE_NOTES.md`](docs/RELEASE_NOTES.md).

## Development phases

### P0: Release convergence and platform truth

Make source, CI evidence, GitHub Pages, and the optional Cloudflare Worker
agree before treating new capability as released. This phase addresses
deterministic Playwright provisioning, repeatable browser failures, the
MapLibre 5 cost decision, source-to-live drift detection, Worker revision
convergence, failure artifacts, and immutable workflow action references. It
also proves or declines globe projection and a separately named global
low-zoom NASA GIBS context layer, then publishes and verifies the accepted
Pages build under separate release authorization.

### P1: Network lifecycle and failure honesty

Keep weak-network behavior bounded and visible. Work covers full response-body
deadlines, activation cancellation, durable unavailable states, optional
sidebar chunk isolation, internal layer-key typing, and Fire data-query scope.
It also reviews the landscape-signature pipeline's LANDFIRE and Annual NLCD
source pins without silently changing its byte-stable contract.

### P2: Responsive and cross-view interaction coherence

Define the tablet contract, give active Fire 3D an honest exit path, establish
a shareable Pacific camera for ENSO, lazy-load Fire 3D only when eligible, and
verify real tasks across phone, tablet, desktop, embed, keyboard, and reduced
motion.

### P3: Fire evidence and visual hierarchy

Make current evidence calmer and more actionable before adding more visual
weight. The phase adds a shared source and time receipt, subordinates broad
rasters, and evaluates individually qualified EPA AirNow monitor points, NASA
GIBS VIIRS thermal-anomaly detections, selected-place fire evidence, and
infrastructure language. No sources are blended into a DDM severity score.

### P4: ENSO observed-state product

Make ENSO answer one clear current-state question well. Start with observed
RONI, ONI, Nino 3.4, and SOI evidence, season-aware regional interpretation,
an index-first small-screen experience, and an offline Pacific Hovmoller
prototype. Forecast probabilities remain gated on an official,
machine-readable source and a reviewed user question.

### P5: Smoke altitude and volume research

Test a bounded offline HRRR-Smoke artifact for one event and region. Compare
vertical curtains with sparse altitude shells, publish model initialization,
valid time, lead, units, and uncertainty, and enforce artifact and device
budgets. NEXRAD is limited to a research case study because polarimetric
signatures are not smoke-specific. AIRS or CLIMCAPS, CALIPSO, and MISR are
validation and education sources, not operational vertical truth.

### P6: Field capability, coverage, and release readiness

Choose and complete one bounded reach or field outcome, then produce measured
delivery and release evidence. Candidate outcomes include offline use, export,
saved places, gridded drought, vegetation, snow, fire potential, marine heat,
or a specific coverage expansion. This phase also resolves PMTiles archive
limits, source-map policy, and whether any hosting experiment is justified by
field measurements.

## Sequencing and decisions

P0 comes first. P1 and P2 establish the lifecycle and interaction foundation
needed by P3 and P4. P5 follows the calmer Fire hierarchy, and P6 selects one
product outcome after the preceding evidence is available.

Owner decisions are explicit gates, not hidden implementation assumptions.
They include the MapLibre 5 value and cost tradeoff, tablet behavior, Fire 3D
custom-state behavior, ENSO camera and basemap policy, Fire improvement order,
ENSO forecast-source standards, provider log policy, smoke pilot scope, the P6
outcome, and production source-map and hosting policy. See the `decision_gates`
section of the canonical YAML for the exact questions and dependent task IDs.

## Acceptance principles

Every shipped slice must preserve source, time, geography, limitations,
accessibility, responsive behavior, URL state, iframe operation, cancellation,
and the six layer states. A phase exits only with the specific deterministic,
browser, visual, scientific, or live-delivery evidence named in
[`docs/ROADMAP.yaml`](docs/ROADMAP.yaml).
