# ddm-owner-decisions: 2026-09-02 decision packet ratification

Companion to the earlier ten-decision batch (cc-prompt-decision-ratification-2026-09-02.md).
This covers Parts 1 through 4 of the 2026-09-03 decision packet plus the appendix decisions.
These are settled. Do not re-litigate.

---

## Part 1: Eight decisions, ratified

### DR-035: Boot tolerance for a stalled renderer
**Decision: (a).** After a bounded wait, boot the chrome without the map. Add a WebGL probe
and a map error handler. The hidden-window hang has already cost a session, and MapLibre 6
introduces a GPUInitializationError branch that option (a) aligns with, so this builds
the handler once instead of twice.

### DR-008: Entry-chunk budget
**Decision: (a).** Make the map key, telemetry adapters, and URL catalog lazy. Keep the
45 kB line. None of these three modules is needed for first paint, and the current 1.53 kB
of headroom means the next eager import trips the gate. The budget stays honest; the
imports earn their way in when needed.

### DR-025: Tablet and phone 3D policy
**Decision: (a).** Width floor plus a capability probe with webglcontextlost handling.
Tablet allowed. Landscape phone excluded. fire3d stripped on cluster change.

**Owner correction and expansion:** The whole DDM map can be 3D. Three-dimensional terrain
is a map-level capability, not a fire-specific feature. What is fire-specific is volumetric
smoke, which is enabled by default in the fire view. The layer studio is the mechanism for
adding diverse 3D layers across any view.

The architecture is therefore three tiers:

1. **3D terrain (map-level).** MapLibre's terrain and globe projection. Available across
   all hazard views (drought, fire, heat, ENSO) on capable devices. The terrain drape,
   hillshade, and camera pitch are the base 3D experience. This is what makes the DDM a
   spatial instrument, not a flat tile viewer.
2. **Volumetric smoke (fire view default).** Enabled by default when the fire view is
   active on a capable device. This is the additive fire-specific 3D layer. It is the most
   GPU-intensive feature on the roadmap and the one that most benefits from the terrain
   context (smoke rising from terrain, plumes interacting with topography).
3. **Layer studio 3D layers (user-configured).** The layer studio can offer diverse 3D
   layers that the user adds. These are not limited to fire: snow depth visualization over
   terrain, precipitation accumulation, heat dome vertical profiles, or any volumetric data
   that benefits from the terrain context. The studio is the extensibility surface for 3D
   content beyond the fire default.

The capability probe therefore gates 3D terrain at the map level, not just the fire scene.
A width check alone cannot tell whether a device can render terrain mesh: a 2019 iPad
passes 721px but may stall on terrain plus perimeter extrusion plus volumetric smoke. The
probe does three things:

1. Tests whether the device can create a WebGL2 context before committing to 3D terrain.
2. Handles context loss gracefully. If the GPU runs out of memory mid-session, the user
   sees an honest message, not a frozen viewport. The map falls back to 2D, not to a
   broken state.
3. Provides a clean decision point for the tablet band. Tablets enter 3D terrain with the
   understanding that the experience may be simplified (fewer terrain detail levels,
   reduced smoke particle count if smoke is active) compared to desktop.

Landscape phones are excluded from 3D terrain even with sufficient width because the
viewport height is too compressed for the tilted camera to be useful, and phone GPUs are
the most constrained class of device.

The fire3d URL parameter and its stripping on cluster change remain as described in the
recommended option: the parameter controls whether volumetric smoke is active, not whether
the map has 3D terrain. Terrain can persist across views; smoke is contextual to fire.

**Connection to DDM-P0-T03:** The capability probe is the prerequisite for volumetric
smoke, but it also gates the broader 3D terrain that every view can use. The probe built
for DR-025 is the foundation for both the fire-specific smoke and the map-wide 3D
experience.

Also: the DDM-D03 gate in ROADMAP.yaml cites DR-025 but asks about Fire 3D exit behavior
after custom demotion, which is a different question. The subagent should note whether to
split the gate or widen this ruling.

### DR-024: The unmerged perimeter-evidence branch
**Decision: (b).** Close the branch. Correct the wording in place (the briefing calls a
50-record envelope an area; the fix is a string change that DR-058 already carries). The
branch is backed up at origin. The MapLibre 6 migration raises the rebase cost, and the
claim can be made true today with a wording correction.

### DR-051: Local run defaults and 3D fire evidence
**Decision: (a).** Evidence capture behind DDM_CAPTURE_EVIDENCE=1. Build identity asserted
locally.

**Owner expansion:** The current local run fetches live Census AIANNH and BIA AIAN-LAR
geometry and rewrites four review images on every pass. This is neither offline-safe nor
idempotent, which means:

- A local run on a plane or in a field setting fails on the network fetch.
- Every run changes files, so diffs include re-fetch artifacts mixed with real code changes.
- The fast verification path (typecheck, build, preview boot) pays the cost of the most
  expensive feature on every pass.

Making capture opt-in means routine local verification runs clean and fast. When 3D
evidence is specifically needed (terrain mesh loads across views, fire perimeter extrusion
renders, volume legend appears, volumetric smoke at target density, layer studio 3D layers
display correctly), the DDM_CAPTURE_EVIDENCE=1 flag triggers a deliberate capture pass.

**Connection to 3D terrain and volumetric smoke (DDM-P0-T03):** The 3D capabilities span
the entire map, not just the fire view (see DR-025 owner correction). As these capabilities
mature, the evidence surface grows across all views: terrain mesh rendering at different
zoom levels and camera pitches, the interaction between fire perimeters and volumetric
smoke plumes, snow depth visualization over terrain in the drought view, and any layer
studio 3D layers the user can configure. Each capture is GPU-dependent and takes time.
Bundling them into every routine run discourages frequent verification. Separating them
keeps the fast path fast (seconds) and the evidence path thorough (minutes). The capture
flag is also the natural gate for future evidence categories: when volumetric smoke ships,
its evidence specs run under DDM_CAPTURE_EVIDENCE=1 alongside terrain captures across all
views, not in the routine loop.

Build identity assertion ensures that a local run proves it booted the build just made, not
a cached previous build. This is the "did I actually test what I think I tested" check, and
it matters most during the MapLibre 6 migration when repeated local runs are the primary
verification method.

### DR-052: Test suite shape
**Decision: (b) with additional guidance.** Ratify the 180s budgets. Add a verify:pure
fast lane. Do not do the full 255-case pure migration (9 seconds saved for a large rewrite
is not worth the effort).

**Additional owner guidance on verification approach:** The owner is comfortable with a
longer build and verify sequence to get the suite right, rather than optimizing for speed
at the cost of coverage. For the MapLibre 6 migration verification specifically:

- Use an Opus 5 agent swarm with task-specific skills. The migration touches 69 imports,
  18 interaction handlers, and the setWorkerUrl configuration. Each of these is a bounded,
  verifiable task that can be assigned to a focused agent with a specific verification gate.
- The verification sequence for the migration should be: typecheck clean, build clean,
  verify:pure passes, verify:quick passes, full test:serial passes including chromium-3d.
  Each step gates the next. A failure at any step stops the sequence and reports.
- The 3D test project (chromium-3d) stays in the routine loop. Option (c) would hide the
  regressions the MapLibre 6 migration is likeliest to cause, and the 3D scene is the
  DDM's most important demonstration feature. The 7.8-minute cost of chromium-3d is the
  price of knowing it works.

### DR-014: Rows whose source does not cover the selection
**Decision: (a).** When a selection falls outside the Pacific Northwest, the ENSO row shows
a national-scale ENSO state with the regional tilt prose removed (not "unavailable"). Heat
fetches independently with its own status and stamp, so it does not vanish when the map
layer is toggled off.

The briefing describes the place, not the map. A layer toggle should not change what the
briefing says about the hazard conditions at the selected location.

### DR-015: Where the overlap engine lives
**Decision: (a).** Move the overlap engine from src/impact/ to src/ui/island/ while the
briefing restructure has the files open. The cost is near zero during the restructure and
high afterward.

**Owner UX vision (applies to DR-015 and the broader panel architecture):**

Rethink the place studio, layer studio, and briefing as slideout panels from the left side
of the screen. This is a unified interaction model replacing the current mix of right-slide
briefing panel, various studio panels, and mobile crowding.

**Desktop and tablet:**

- Place, layer, and briefing panels slide out from the left to cover the screen.
- Behind the panel, the map is visible but dimmed with a dark, blurred, transparent
  backdrop. The map is still there; it has receded to give the text focus.
- A button or gesture slides the panel back, returning focus to the map.
- The nav mode buttons (drought, fire, heat, ENSO) remain on the right side in
  contrasting colors for quick switching. Mode switching never requires dismissing a
  panel first.
- Left-to-right information hierarchy: detail panels on the left, map in the center,
  mode navigation on the right.

**Mobile (phone):**

- Instead of sliding, the panel fades in over a dark transparent screen. No slide
  animation competing for the narrow viewport.
- This is smoother and less jarring. The transition between "looking at data" and
  "looking at the map" is a fade, not a mechanical drawer.
- Nav buttons on the right remain visible in contrast colors for quick mode switching.
- The effect: focus when text options are needed, then focus on the map. Two states,
  clean transition between them.

**The shared principle:** The map is always the primary context. Everything else (briefing,
layer controls, place settings) is a temporary overlay that takes focus when needed and
returns it when done. The dark blurred backdrop is the visual signal: "you are in a detail
view now; the map is still here behind you."

This directly addresses the user research finding from Reuben Martinez ("the briefing
would be better as a drawer that fills the screen for readability") and the repeated
observation that the place studio and layer studio are unstable and crowded. A single
panel architecture replaces three competing slide-out patterns with one consistent model.

**Note for the subagent:** This UX vision is directional guidance for future implementation.
It does not change what DR-015 asks (move the overlap engine now). But the overlap engine's
new home in src/ui/island/ should be designed with this panel architecture in mind, since
the island module is where the panel rendering will eventually live.

---

## Part 2: Twenty-one defaults accepted

The owner accepts all Part 2 defaults as written. Recorded by id:

DR-004 (b), DR-005 (a, minus merged half), DR-006 (a), DR-010 (a), DR-011 (a),
DR-021 (a), DR-028 (a), DR-030 (a), DR-031 (a), DR-034 (a), DR-043 (a), DR-046 (a),
DR-048 (a), DR-050 (a), DR-053 (a), DR-054 (a), DR-055 (a), DR-056 (a), DR-057 (a),
DR-058 (a), DR-059 (b).

No objections.

---

## Part 3: Parked decisions, with directional leanings

These remain parked per the packet. No decision is recorded. The following notes capture
where the owner is leaning based on the user research observations written 2026-09-02.
These are not decisions; they are context for the person who opens each one later.

- **DR-013** (briefing name): people have not called it anything specific. No evidence to
  flip the default. Leaning toward the recommended single name.
- **DR-017** (horizon chip): no observation of anyone pressing it. No evidence yet.
- **DR-018** (weekly drought rail): no observation of users finding or missing the history.
  No evidence yet.
- **DR-020** (fire and heat time bars): awaits MapLibre 6 and DR-022 fire tier landing.
- **DR-023** (incident points): awaits MapLibre 6.
- **DR-026** (fire basemap contrast): awaits MapLibre 6.
- **DR-027** (fire context layer scope): the user research strongly supports fuel risk
  beside active perimeters (Reuben's observation, the owner's DR-022 expansion). Leaning
  toward a scope that includes fuel condition context layers alongside live perimeters.
- **DR-032** (ENSO state panel): no observation of users asking "what is ENSO doing" on
  that screen. No evidence yet, but the ENSO correctness fix (DR-029) may surface this.
- **DR-033** (SST and marine heatwaves): awaits DR-019 scouting.
- **DR-037** (hazard key uniformity): no observation of a reader failing to read a color.
  No evidence yet.
- **DR-038** (type floor): Reuben noted interface crowding on mobile but did not report
  unreadable labels specifically. The community member in Powell River had no legibility
  complaints on iPad. No strong evidence yet.
- **DR-039** (overlay motion): awaits MapLibre 6.
- **DR-040** (minimap metrics): no observation of users treating the minimap as data.
- **DR-041** (fire minimap red): no observation of fire season reading as alarm.
- **DR-042** (condition clicks to briefing): no observation of how people currently reach
  the briefing. Reuben found it via the slide-out; the NIDIS team saw it via screen share.
  Neither is organic discovery. Worth watching.
- **DR-044** (ocean doors): no observation of accidental screen changes in the field.
- **DR-060** (uncovered walkthrough looks): awaits MapLibre 6.

## Part 4: Process diet (DR-062), held with context

The five process proposals are held for now. The owner's leanings:

1. **Open-decision cap of ten:** Sympathetic. The register grew to sixty entries, which is
   unwieldy. A cap forces prioritization.
2. **One entry document per session:** Sympathetic. Reconciling multiple live documents is
   overhead.
3. **Decision by default unless objected:** The Part 2 approach in this packet already
   demonstrates this pattern. It works. Leaning toward adopting it as standard.
4. **One landing per session before new planning:** Sympathetic. Product over process.
5. **Subagent reports capped at 600 words:** Sympathetic. Reports that end in a decision
   or a diff are useful; reports that end in more questions are not.

No formal decision recorded. These can be decided in a future session or adopted
informally.

---

## Appendix decisions

### DR-061: Pre-processing pipeline
**Decision: DEFER. No cron jobs before the Convention or in the near term.**

The owner is uncomfortable with automated cron jobs at this stage. The pre-processing
pipeline is a real need, but the timing is wrong. The Convention is imminent, the
successor transition is in progress, and adding a nightly commit-to-main automation
introduces a maintenance surface that requires monitoring.

The approach: iterative, manual updates upon major sprints. When a major development push
lands (a new phase close, a significant feature merge), pre-processing can be updated as
part of that push. No automated schedule. The normalizer design work is still valuable as
input to the eventual local full-service server (DDM-P15-T01), but it ships as server
infrastructure, not as a cron job.

This is not option (b) from the packet (wait for the server). It is: do the normalization
work when the product work calls for it, not on a schedule. The three sources identified
in the packet's option (c) (USDM week index, NIDIS valid dates, CPC outlooks) are the
right first candidates when the time comes, but that time is after the Convention and after
the successor is oriented.

### Safari floor
**Decision: Target Safari AND Chrome/Chromium for Android.**

The two browser engines that matter for the DDM's audience are Safari (iPhones and iPads)
and Chrome/Chromium (Android phones and tablets). Meeting these two standards covers the
devices the DDM's users carry.

Specific approach:
- The Vite build target pin at Safari 15.5 / iOS 15.5 (already ratified in DR-009)
  covers the Safari syntax floor.
- Chrome/Chromium on Android is the other floor. The build target should also cover the
  Android Chrome version that corresponds to the same era (roughly Chrome 100+, which
  covers Android devices from 2022 forward).
- For verification: apply for BrowserStack's open-source grant (free) to get real-device
  testing on both Safari/iOS and Chrome/Android. One verified check per release on actual
  devices at the stated floor.
- The WebKit Playwright project on Ubuntu CI can be added as described in Appendix C,
  labeled honestly as "current WebKit regression, not the 15.5 floor," but it is secondary
  to the real-device checks.
- The README should state both floors: Safari 15.5+ and Chrome 100+ (or whatever the
  verified Android floor is).

---

## Instructions for Claude Code

### 1. Record all decisions in the register YAML

Update 2026-09-02-decision-register.yaml with:
- Part 1: DR-035 (a), DR-008 (a), DR-025 (a with expansion), DR-024 (b), DR-051 (a with
  expansion), DR-052 (b with guidance), DR-014 (a), DR-015 (a with UX vision)
- Part 2: all twenty-one defaults recorded as decided
- DR-061: deferred, no cron jobs
- Safari floor: Safari + Chrome/Android dual target

Mark all as decided with date 2026-09-02.

### 2. Note the UX vision

The slideout panel architecture (DR-015 owner expansion) is directional guidance, not a
task to build now. It should be:
- Noted in IDEAS.md as a shaped spark under a name like "unified panel architecture" or
  "focus-and-return interaction model"
- Referenced in the DR-015 decision notes as context for the overlap engine's new home
- Cross-referenced to the user research (Reuben's briefing drawer feedback, the layer/place
  studio instability pattern across three observations)

### 3. File the user research observations

Five user research observation files were written 2026-09-02 and are ready for
planning/user-research/. After filing, run the triage described in the decision packet
Part 0: check each observation against the fourteen parked decisions to see whether any
user evidence flips a default. Based on the owner's leanings noted above, none currently
flip, but the triage should confirm.

### 4. Update the session briefing

The next session briefing (docs/session-briefing-2026-09-03.md or equivalent) should
reflect:
- All Part 1 and Part 2 decisions as settled
- The MapLibre 6 migration as the next engineering task (unchanged)
- The DR-052 guidance on using an Opus 5 agent swarm for migration verification
- The DR-061 deferral (no cron jobs)
- The user research filed and triaged

### Constraints

- ddm-owner-decisions format: these are settled, do not re-litigate
- No cron jobs, no automated nightly processes
- The UX vision is directional, not a build task
- Verified reporting discipline on all claims

---

## Addendum: Fire layer visuals, 3D perimeter rendering, and two frontier sparks

### Fire potential (WHP) color scheme: owner design decision

The current Wildfire Hazard Potential color scheme makes active fire perimeters hard to
see against the fuel risk surface. The colors compete rather than compose.

**New color scheme:** Black (lowest fuel risk) to white (highest fuel risk). This makes
high-risk fuel areas very prominent against the terrain and against fire perimeters, which
are rendered in warm colors (red/orange). The contrast between white fuel risk and
red/orange fire perimeters creates immediate visual distinction: "this is where fuel risk
is highest" reads separately from "this is where fire is burning."

**Transparency:** The WHP surface should carry enough transparency that the underlying
terrain layer maintains continuity. The user should still read ridgelines, valleys, and
hydrography through the fuel risk surface. The 3D terrain context matters here: a fully
opaque WHP layer would erase the topographic information that makes fuel risk spatially
meaningful (fuel risk on a steep slope reads differently than the same risk on a flat
valley floor).

**Task:** An Opus 5 subagent can address the color ramp and transparency implementation.
The deliverable is a black-to-white ramp with calibrated transparency that composes
cleanly with both the terrain layer and the fire perimeter symbology.

### Fire perimeter ribbon in 3D mode: owner rendering specification

In fire3d mode, the pulsing fire perimeter should render as a vertical ribbon, not a flat
polygon outline. The ribbon specification:

- **Fully opaque at the bottom** (ground level), where the perimeter meets the terrain
  surface.
- **Transparent at the top**, fading out in a logarithmic gradient. The logarithmic curve
  means the opacity drops quickly near the top rather than linearly, which creates a
  flickering, flame-like visual impression.
- **Height:** Not too tall. Just enough vertical extent to offer clear distinction from the
  terrain surface. The ribbon should read as "fire is here" without dominating the scene
  or obscuring the terrain context behind it. The height should be proportional to the
  view scale so it reads consistently at different zoom levels.
- **The visual effect:** A low ribbon of light that pulses along the perimeter edge,
  opaque where it touches the ground and fading upward. This replicates the visual
  impression of a fire line flickering at the landscape edge without attempting
  photorealistic flame simulation.

This pairs with the volumetric smoke: the ribbon marks where the fire meets the ground,
and the smoke rises from within the perimeter above it. Together they create a composed
3D fire scene: terrain, fuel risk surface, perimeter ribbon at ground level, smoke above.

### Frontier sparks for IDEAS.md (parking lot, not scheduled)

Two new volumetric visualization concepts. These are ideas to be logged, not shaped or
scheduled. Each would need the full shaping treatment (costs, capability requirements,
data sources, coherence gate) before entering any phase.

**1. Heat dome volumetric visualization.** A 3D representation that fills in the actual
dome shape of a heat event. Rather than a flat raster showing temperature or HeatRisk
values, the dome would render as a translucent volume over the affected area, with the
dome's height corresponding to the atmospheric depth of the heat event. The visual
reads as a physical dome pressing down on the landscape. This could compose with the
terrain to show which valleys and basins are most trapped under the dome (lower terrain
inside the dome is more affected) and which ridgelines break through. Data source and
feasibility would need scouting: the dome shape requires vertical atmospheric profile
data, not just surface temperature.

**2. ENSO moisture and drought flow visualization.** A volumetric or animated flow
visualization showing where ENSO-driven moisture is directed and where it is withheld.
The concept: moisture pathways flowing from the equatorial Pacific toward regions where
flooding risk increases, and visually dry corridors over regions where drought
intensifies. The visualization would show both sides of the ENSO teleconnection at once:
"here is where the water goes, and here is where it does not go." This could help users
understand why a strong El Nino means flood risk in some areas and drought risk in
others, which is a question the current ENSO screen answers in text but not visually.
Data sources would include CPC seasonal precipitation outlooks and the ENSO
teleconnection patterns documented in the climate literature.

Both sparks belong in the IDEAS.md frontier section alongside the existing unshaped
concepts. They extend the 3D terrain capability beyond fire into the heat and ENSO
views, which aligns with the owner's correction that 3D is map-level, not fire-specific.

