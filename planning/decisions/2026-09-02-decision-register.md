# Decision register, 2026-09-02 (reading copy)

> Refreshed 2026-09-04 11:20 PDT by the foundations true-up, from the YAML: still 69 entries, 49 decided, 20 pending; NO entry was ruled this session, so the Pending and Decided sections below are unchanged. The YAML gained a top-level `foundations_pass_2026_09_03` block pointing at `planning/2026-09-03-foundations/FOUNDATIONS-PLAN-v2.md`, whose section 9 is the ruling packet the owner answers by number (A1 to A7 for the pre-session slice, B1 to B7 before the session ends, C1 to C5 later). Rulings that touch entries here: A6 closes DR-065 as option a; B2 rules DR-066; B4 rules DR-062 as amended; B6 reconciles DR-061 with two live weekly crons; C1 authorizes DR-067's colour half or not; C2 rules DR-020 and a batch of fifteen parked entries by their recommended defaults. Facts corrected in the YAML's `updated` note: deployed bytes are 2835091 (5be15f5 is a docs-only successor); v0.6.26 is tagged; DR-069 is unexecuted on main. The previous refresh note follows.
>
> Refreshed 2026-09-03 20:05 PDT by the long run, from the YAML: 69 entries, 49 decided, 20 pending. DR-067 and DR-068 moved from Pending to Decided and DR-069 was created, all three on the 2026-09-03 launch rulings. DR-065 gained a `fix_2026_09_03` field recording the studio flake falling from 6 of 16 and 5 of 16 to 0 of 16. `branch_state` gained `landed_2026_09_03_pm` and `awaiting_go_2026_09_03_pm`. NOTE: no generator script exists for this file; the counts and the moved rows below were produced mechanically from the YAML, the surrounding prose was not regenerated, and the YAML remains the record.

**[`2026-09-02-decision-register.yaml`](2026-09-02-decision-register.yaml) is the record.** This file is a snapshot rendering of it for reading. Answers go in the YAML (`decided`, `decision`, `status`); if the two ever disagree, the YAML wins and this file is stale. The YAML also carries `already_decided`, `branch_state` (now including its `landed_2026_09_03`, `awaiting_go_2026_09_03` and `asana_2026_09_03` sub-keys), the new top-level `gate_drift_2026_09_03`, `visual_pass_index`, `user_research_2026_09_02`, the per-entry `implementation_2026_09_03` field on DR-063 and DR-064, the per-entry `reproduction_2026_09_03` field on DR-065, and the full options, costs, risks, sources and no-answer defaults that this file deliberately does not restate.

DR-063's ruling stands as a presentation decision: a black-to-white ramp with calibrated transparency is still the answer to what the Wildfire Hazard Potential layer should look like. It could not be executed client-side, because MapLibre GL JS 6.6.0 has no raster-color property and both WHP surfaces arrive already rendered by the issuer, which is why DR-067 and DR-068 exist.

Rulings came in three batches on 2026-09-02: the 07:42 ten-decision batch, the landing-day ratifications (DR-045, DR-047, DR-049, DR-007), and the 22:38 packet rulings recorded from `cc-prompt-decision-packet-2026-09-03.md` (Part 1 by id, all twenty-one Part 2 defaults, DR-061 deferred, the Safari floor amended on DR-009, DR-062 held). Settled rulings are not re-litigated.

## Pending (20)

Seventeen are parked by the packet and carry the owner's 2026-09-02 leaning; DR-062 is held; DR-065 and DR-066 came from the user research; DR-067 and DR-068 were raised by the DR-063 implementation attempt on 2026-09-03.

### DR-013 The briefing name on every door
*G3 Impact Briefing structure and copy.*

**Question.** Confirm what the popup trigger, the sidebar region trigger, the index.html Brief door and the mobile at-hand kicker each say now that the rename is executed, and whether the in-panel per-hazard headings stay and a per-screen title such as WILDFIRE BRIEFING (owner annotation 1-7) is still wanted.

**Recommendation: (a)** one name on all four doors, per-hazard section headings kept inside the panel, no per-screen title

**Why.** One name on every door is what makes four surfaces read as one panel, and the hazard is already visible in the section the panel opens on.

**If nobody answers.** the doors keep whatever wording the rename left behind

**Owner leaning (2026-09-02).** Parked, not decided. People have not called the briefing anything specific; no evidence to flip the default; leaning toward the recommended single name. Source: planning/decisions/cc-prompt-decision-packet-2026-09-03.md (owner rulings, 2026-09-02 22:38 PDT)

**Unblocks.** eleven user-facing strings and two specs; MM-11 the briefing door label.

### DR-017 The horizon chip when two horizons share one recipe
*G4 Forecast uniformity and time.*

**Question.** On Heat and ENSO the horizon chip is a no-op because the two recipes are identical. Should it be disabled with an honest reason, hidden for that hazard, or kept enabled and bound to a within-surface change such as the HeatRisk day band?

**Recommendation: (a)** enabled and bound to a real within-surface change where one exists, disabled with a stated reason where none does

**Why.** It is the only option that gives every hazard screen a working near-term and long-range register without inventing a product, and a disabled chip with a stated reason stays honest where nothing is published.

**If nobody answers.** the chip silently does nothing on two of four screens

**Owner leaning (2026-09-02).** Parked, not decided. No observation of anyone pressing the horizon chip. No evidence yet. Source: planning/decisions/cc-prompt-decision-packet-2026-09-03.md (owner rulings, 2026-09-02 22:38 PDT)

**Unblocks.** TIME-02; uniform hazard screens; DR-020.

### DR-018 Drought current recipe and where the rail lives
*G4 Forecast uniformity and time.*

**Question.** Should the USDM 52-week rail become Drought's current recipe with NADM demoted to continental context, and should the rail and step arrows be promoted into the compact WHEN row instead of living behind the More time popover on the default desktop view?

**Recommendation: (b)** promote the rail to Drought current, keep it in the More time popover

**Why.** The rail is the only place the observed horizon has real history and it belongs on the drought screen, but promoting it into a row that already fails its no-scroll acceptance would trade one honesty problem for a layout one; the promotion can follow DR-036.

**If nobody answers.** drought's current recipe keeps fetching NADM for a view that discards it

**Owner leaning (2026-09-02).** Parked, not decided. No observation of users finding or missing the drought history. No evidence yet. Source: planning/decisions/cc-prompt-decision-packet-2026-09-03.md (owner rulings, 2026-09-02 22:38 PDT)

**Unblocks.** TIME-08 wasted NADM fetch; the only real time control on the observed horizon.

### DR-020 What the Fire and Heat time bars show
*G4 Forecast uniformity and time.*

**Question.** Fire and Heat have no time bar at all (all six setTimeBar callers are drought or ocean), and the Heat shell says No dated product is displayed while the HeatRisk legend on the same screen shows a valid date and a snapshot time.

**Recommendation: (a)** Heat steps the HeatRisk day band (seven daily granules at 12Z) and Fire steps the SPC day index once DR-022 lands, each stamped with the issuer's own validity

**Why.** Both hazards already display dated products, so a time control describes what is on screen rather than adding a claim, and it removes a contradiction a user can see today.

**If nobody answers.** two hazard screens keep no time bar and Heat keeps contradicting its own legend

**Owner leaning (2026-09-02).** Parked, not decided. Awaits the MapLibre 6 landing and the DR-022 fire tier. Source: planning/decisions/cc-prompt-decision-packet-2026-09-03.md (owner rulings, 2026-09-02 22:38 PDT)

**Unblocks.** TIME-01; VP-17; the time controls on two of four hazard screens.

### DR-023 WFIGS incident points beside perimeters
*G5 Fire and 3D.*

**Question.** Perimeter-only mapping undercounts new starts (558 incident points against 210 perimeters today). Add the points as their own layer, or keep perimeters only?

**Recommendation: (a)** add points as a distinct layer with its own legend and status, perimeters unchanged, and restate every count string to say which it counts

**Why.** A new start with no mapped perimeter is exactly the fire a user needs to see, and a separate layer keeps the two claims distinct instead of merging them into one number.

**If nobody answers.** perimeters only, with no surface saying so

**Owner leaning (2026-09-02).** Parked, not decided. Awaits the MapLibre 6 landing. Source: planning/decisions/cc-prompt-decision-packet-2026-09-03.md (owner rulings, 2026-09-02 22:38 PDT)

**Unblocks.** SCI-04 undercount; every fire count in the briefing, the tiles and the minimap.

### DR-026 Fire view emphasis, basemap and perimeter contrast
*G5 Fire and 3D.*

**Question.** Keep preferredBasemap satellite in the Fire view while the GOES day and night patchwork fills the upper 3D frame, and do live NIFC perimeters get a heavier outline or halo so observed incidents keep contrast against red WHP fill plus the selection tint?

**Recommendation: (a)** fall back to the dark base in the Fire view until a global daily imagery layer lands, and add a perimeter halo

**Why.** Emphasis must match evidence: a live perimeter is an observed incident and WHP is 2023 potential, and a day and night seam is a rendering artifact competing with the subject of the screen.

**If nobody answers.** the patchwork stands and perimeters stay lower contrast than the hazard fill

**Owner leaning (2026-09-02).** Parked, not decided. Awaits the MapLibre 6 landing. Source: planning/decisions/cc-prompt-decision-packet-2026-09-03.md (owner rulings, 2026-09-02 22:38 PDT)

**Unblocks.** VP-13; the Fire 3D first read.

### DR-027 Fire context layer scope
*G5 Fire and 3D.*

**Question.** The nearest-station registry covers 16.6 percent of a Pacific Northwest grid at the 50 mile ceiling and RAWS points are drawn with null values although the service serves relative humidity, wind and fuel moisture. Expand the registry or keep ten stations with the honest absence branch, and do the structures pilot and the retired fuels table stay, expand or retire?

**Recommendation: (a)** render the served RAWS values, keep ten stations with the honest absence branch, retire the fuels table, keep the structures pilot labeled a pilot

**Why.** The values are already served, so drawing them adds no claim; expanding the registry is real work with no deadline attached, and an honest absence beats a station drawn with nothing in it.

**If nobody answers.** stations keep drawing null values and the coverage dial stays unstated

**Owner leaning (2026-09-02).** Parked, not decided. The user research strongly supports fuel risk beside active perimeters (Reuben Martinez sessions; the DR-022 owner addition). Leaning toward a scope that includes fuel-condition context layers alongside live perimeters. Source: planning/decisions/cc-prompt-decision-packet-2026-09-03.md (owner rulings, 2026-09-02 22:38 PDT)

**Unblocks.** FIRE-07 stations drawn with no values; the fire context view's coverage honesty.

### DR-032 A persistent ENSO state panel on the ENSO screen
*G6 ENSO and marine.*

**Question.** Should the ENSO cluster screen carry a persistent ENSO state panel? This partially reinstates something like the retired enso-driver, whose absence is pinned by tests/enso-observed-state.spec.ts lines 96 to 101.

**Recommendation: (a)** yes, with that spec updated in the same change and a written statement of what is different this time

**Why.** After DR-029 the app holds a correct dated ENSO state, and the one screen named for it is where a user looks; the retired panel was removed for its content, not for the idea of a state readout.

**If nobody answers.** the ENSO screen shows an ocean raster and no ENSO state

**Owner leaning (2026-09-02).** Parked, not decided. No observation of users asking what ENSO is doing on that screen. No evidence yet; the DR-029 correctness fix may surface it. Source: planning/decisions/cc-prompt-decision-packet-2026-09-03.md (owner rulings, 2026-09-02 22:38 PDT)

**Unblocks.** ENSO-03 (no ENSO state on the ENSO screen); the visibility of DR-029.

### DR-033 The marine side, SST source and marine heatwaves
*G6 ENSO and marine.*

**Question.** Does the ENSO ocean surface stay on NASA GIBS MUR, whose baseline is unverifiable at GIBS and at PO.DAAC, or move to a documented-baseline source so the legend can carry magnitude anchors; and does a Hobday marine-heatwave category product join it?

**Recommendation: (a)** move the ocean surface to OISST v2.1 and give the legend real magnitude anchors, hold the marine-heatwave category raster for a later window, and take the cited El Nino to marine heatwave and salmon sentence now

**Why.** A 1971-2000 baseline is what the ENSO literature the rest of the module cites is built on, and only a documented baseline lets a legend say what an anomaly means; the category raster needs a host, vocabulary and issuer relationship this window cannot verify.

**If nobody answers.** the SST legend stays three qualitative classes over an undocumented baseline

**Owner leaning (2026-09-02).** Parked, not decided. Awaits the DR-019 issuer-product scouting. Source: planning/decisions/cc-prompt-decision-packet-2026-09-03.md (owner rulings, 2026-09-02 22:38 PDT)

**Unblocks.** VP-18 (the legend cannot get honest magnitude anchors on the current source); ENSO-06.

### DR-037 Hazard screen uniformity, key and naming
*G7 Interface.*

**Question.** Two of the six divergences across the four hazard screens are the owner's: does the desktop on-map key appear on all four hazards or none (Drought's is deleted on desktop and tests/interface-responsive.spec.ts line 228 pins the asymmetry), and do the desktop names and order unify with the phone rail, whose order is recorded as intentional in docs/design/mobile-map-chrome.md?

**Recommendation: (a)** key on all four, names unified across shells, phone order kept as documented and the divergence recorded

**Why.** A key is how a color surface stays readable, so all four is the honest direction, and the phone order has a recorded design reason while the two shortened names do not.

**If nobody answers.** one of four screens keeps a key and the two shells keep two vocabularies

**Owner leaning (2026-09-02).** Parked, not decided. No observation of a reader failing to read a color. No evidence yet. Source: planning/decisions/cc-prompt-decision-packet-2026-09-03.md (owner rulings, 2026-09-02 22:38 PDT)

**Unblocks.** UI-14; the section headings under DR-012; the four-screen uniformity target.

### DR-038 The 9px type floor
*G7 Interface.*

**Question.** Raising 8, 8.5, 9 and 9.5px type to a 10px floor grows the minimap ocean-door labels (8px), the Hawaii label (8px), the preview badge (9px) and the point-heat series code (8.5px). Accept the growth, shorten those labels, or exempt the minimap?

**Recommendation: (a)** 10px floor everywhere, minimap labels shortened to fit

**Why.** The instrument is read in bright light at arm's length, and a label too small to read is not a label; shortening keeps both legibility and the fixed-aspect minimap.

**If nobody answers.** 8px labels ship

**Owner leaning (2026-09-02).** Parked, not decided. Reuben Martinez reported mobile crowding but not unreadable labels; the Powell River iPad session had no legibility complaint. No strong evidence yet. Source: planning/decisions/cc-prompt-decision-packet-2026-09-03.md (owner rulings, 2026-09-02 22:38 PDT)

**Unblocks.** UI-10; the accessibility pass items A1 and A2.

### DR-039 Motion on the big overlays
*G7 Interface.*

**Question.** The large overlays appear in one frame and there are no motion tokens. For the popup container, is opacity-only entry motion acceptable, or is a transform accepted with the risk that the viewport clamp measures getBoundingClientRect on the content box?

**Recommendation: (a)** opacity-only on popups, transforms allowed on surfaces no clamp measures, all behind motion tokens and a reduced-motion branch

**Why.** popup-viewport.ts carries the most carefully written contract in the repository and measures a box a transform would move, while every other overlay can move freely.

**If nobody answers.** overlays keep appearing in one frame and the new motion tokens go unused

**Owner leaning (2026-09-02).** Parked, not decided. Awaits the MapLibre 6 landing. Source: planning/decisions/cc-prompt-decision-packet-2026-09-03.md (owner rulings, 2026-09-02 22:38 PDT)

**Unblocks.** UI-07 across the map-information panel, studio routes, popups and popovers.

### DR-040 Heat and ENSO minimap metrics, and the horizon
*G8 Minimap and popups.*

**Question.** Heat and ENSO minimaps carry no condition at all. Accept a per-framing count of active National Weather Service heat notices for Heat and the bundled RONI phase for ENSO, choose different metrics, or accept navigation-only as the honest answer; and should the minimap follow the temporal horizon or caption which time it describes?

**Recommendation: (a)** heat alert counts by framing and the bundled ENSO phase, plus a caption naming the time each metric describes

**Why.** Both metrics use sources already inside those recipes, so no new claim class appears, and a caption is the honest cheap way to say which time the minimap describes without pretending it follows the chip.

**If nobody answers.** two minimaps stay neutral and the other two silently describe the present

**Owner leaning (2026-09-02).** Parked, not decided. No observation of users treating the minimap as data. Source: planning/decisions/cc-prompt-decision-packet-2026-09-03.md (owner rulings, 2026-09-02 22:38 PDT)

**Unblocks.** MM-01; MM-03; the owner target that the minimap reflects actual conditions on every screen.

### DR-041 Fire minimap red threshold and the static fallback
*G8 Minimap and popups.*

**Question.** Region-contains-any-perimeter shading turns the whole national wildfire minimap red in fire season, and when no perimeter intersects a framing the color shown is a static 2023 Wildfire Hazard Potential read of pre-2021 fuels. Is that the emphasis the evidence warrants, and should the static fallback get a visually distinct treatment?

**Recommendation: (b)** keep the one-perimeter threshold and change only the fallback treatment

**Why.** At least one current mapped perimeter is a decided honest claim (DDM-UI-010) and raising the threshold would narrow it; the misleading part is the static fallback wearing the same color language, which is fixable without touching the claim.

**If nobody answers.** a 28-month-old landscape read keeps looking like today's conditions

**Owner leaning (2026-09-02).** Parked, not decided. No observation of fire season reading as alarm. Source: planning/decisions/cc-prompt-decision-packet-2026-09-03.md (owner rulings, 2026-09-02 22:38 PDT)

**Unblocks.** VP-12; MM-02; the fire minimap first read.

### DR-042 Condition-surface clicks opening the briefing
*G8 Minimap and popups.*

**Question.** May a click on a condition surface (drought category, fire perimeter, smoke plume, alert) establish a place selection and open the Impact Briefing for the clicked point using the existing resolveLocationIdentity stack? Today only boundary clicks can.

**Recommendation: (a)** yes for all condition surfaces, resolved the same way a boundary click resolves

**Why.** The briefing is the product's synthesis surface and the user's question is about the place under the cursor; the identity stack already exists, so this is a question of permission rather than new machinery.

**If nobody answers.** the briefing opens only from boundary popups

**Owner leaning (2026-09-02).** Parked, not decided. No observation of organic discovery: Reuben Martinez reached the briefing via the slide-out, the NIDIS team saw it on a screen share. Worth watching. Source: planning/decisions/cc-prompt-decision-packet-2026-09-03.md (owner rulings, 2026-09-02 22:38 PDT)

**Unblocks.** MM-10; the briefing's reachability from the map.

### DR-044 Ocean doors on the non-ENSO minimaps
*G8 Minimap and popups.*

**Question.** Do the ocean doors belong on the Drought, Fire and Heat minimaps at all, given that clicking one leaves the current hazard screen?

**Recommendation: (a)** keep them on all four with the label naming the destination

**Why.** DDM-UI-009 makes each ocean door an accessible control that commits ENSO plus its camera and URL in one transaction; the fix is a label that names the destination, not removing a navigation the four screens share.

**If nobody answers.** the doors stay and keep moving users off the screen without warning

**Owner leaning (2026-09-02).** Parked, not decided. No observation of accidental screen changes in the field. Source: planning/decisions/cc-prompt-decision-packet-2026-09-03.md (owner rulings, 2026-09-02 22:38 PDT)

**Unblocks.** MM-07; minimap consistency across the four screens.

### DR-060 The six walkthrough looks never covered
*G12 Visual-pass carryover.*

**Question.** Walkthrough items D1, M1, M2, E1, A1 and A2 are look items still pending: the desktop credits corner, the phone chrome at about 390 by 844, the mobile briefing, the embed shells at 400 by 600 and the 200 by 600 floor, reduced motion, and deep keyboard traversal. Do they get a live owner-present session before the landing, an agent pass with captures, or do they wait until after?

**Recommendation: (a)** an agent pass with a visible Chrome window before the landing, owner review of the captures afterwards

**Why.** The wave changed panel and dock geometry, motion tokens and a type token, so the shells that were never walked are exactly where those changes could break; captures let the owner judge without spending a session driving the browser.

**If nobody answers.** mobile, embed and accessibility stay uncovered through the landing

**Owner leaning (2026-09-02).** Parked, not decided. Awaits the MapLibre 6 landing. Source: planning/decisions/cc-prompt-decision-packet-2026-09-03.md (owner rulings, 2026-09-02 22:38 PDT)

**Unblocks.** the mobile, embed and accessibility passes the 2026-08-31 session could not run.

### DR-062 Process diet
*G-packet Added by the 2026-09-03 decision packet after adversarial review.*

**Question.** Adopt the five process rules proposed in the packet's Part 4: an open-decision cap of ten with defaults beyond it; one entry document per session with reports archived when folded; decisions recorded by default unless objected in-session; one verified landing on main per session before new planning; subagent reports capped at 600 words ending in a decision or a diff?

**Recommendation: (b)** adopt with amendments named in-session

**Why.** The rules bound process to the owner's review bandwidth, which is the real constraint, while leaving room to amend the cap and the landing rule.

**If nobody answers.** current practice continues

**Owner leaning (2026-09-02).** Held, no formal decision (planning/decisions/cc-prompt-decision-packet-2026-09-03.md (owner rulings, 2026-09-02 22:38 PDT)). Leanings: (1) cap of ten, sympathetic, the register grew to sixty; (2) one entry document per session, sympathetic; (3) decision by default unless objected, already demonstrated by this packet's Part 2 and it works, leaning toward adopting it as standard; (4) one landing per session before new planning, sympathetic, product over process; (5) subagent reports capped at 600 words ending in a decision or a diff, sympathetic. May be decided in a future session or adopted informally.

**Unblocks.** how every later decision is recorded.

### DR-065 Layer studio and place studio stability before the Convention
*G-session-2026-09-02 Added by the 2026-09-02 evening decision session (owner addendum and user-research intake).*

**Question.** Three independent observations (a community member on an iPad, the NIDIS demonstration, ATNI Energy staff) saw the layer studio and place studio fail or lose their state during use. If they go to the Convention they must work. Fix them, hide them behind a development flag, or leave them as they are?

**Recommendation: (a)** reproduce the three failure modes, fix them, and put each under a browser contract

**Why.** The owner's DR-015 panel vision replaces the studios' container in time; until then the honest choice is a working studio or a hidden one, never a broken one on stage. Option b is the fallback if a cannot land before the Convention.

**If nobody answers.** option b before the Convention build

**Unblocks.** the Convention share-out; independent exploration after demonstrations.

### DR-066 Wellness and crisis support resources beside hazard information
*G-session-2026-09-02 Added by the 2026-09-02 evening decision session (owner addendum and user-research intake).*

**Question.** A Tribal community leader who lived through the Colville and Spokane area fires said "People need help now" and asked for trauma, emotional and mental health resources alongside drought and fire information. What is the minimal honest response, and where does the heart-icon concept go?

**Recommendation: (a)** a static link set in the resource catalog under "wellness and crisis support" (per state or region), and the heart-icon concept parked in IDEAS.md pending sensitivity testing

**Why.** The need is grounded and direct; the minimal version is a link set, and the icon concept needs testing with people who have experienced fire trauma before it ships.

**If nobody answers.** option a is scoped into the resource catalog work

**Unblocks.** the resource routing scope (impact_and_place component).

## Decided (49)

| DR | Title | Decided | Decision |
| --- | --- | --- | --- |
| DR-001 | How the September work lands | 2026-09-02 | b: Merge commit preserving the wave commits. Owner addition: merge often; do not let integration/2026-09 drift far from main. |
| DR-002 | What CI does after 2026-09-11 | 2026-09-02 | a: Browser suite advisory on push; no ruleset on main; refresh-snapshots unchanged; source-health weekly at snooze expiry; upstream-monitor weekly only after CI-04; verify-live cron stays off. CI must prove but never block. |
| DR-003 | Install the drafted Claude Code hooks | 2026-09-02 | a: Install P1, P2, P3, P4 into settings.local.json: Stop hook may block (U+2014, machine-checkable rules); push-to-main guard warns, does not block; Asana write denies; DDM_STOP_LEVEL=fast. |
| DR-004 | Asana's role under the one-branch posture | 2026-09-02 | b: phase-level only, refreshed at each landing, description corrected off v0.6.22. Recorded as the packet Part 2 default; the owner accepted all twenty-one by id with no objection. |
| DR-005 | Dependabot and dependency-audit scope | 2026-09-02 | a, minus the merged half (Dependabot 48 and 49 merged behind PR 57): extend Dependabot to workers/proxy and .github/actions, add the Worker audit step. Recorded as the packet Part 2 default; the owner accepted all twenty-one by id with no objection. |
| DR-006 | Shape of the eventual local full-service server | 2026-09-02 | a: record the same-origin end state (app and relay on one origin) in the roadmap now. Recorded as the packet Part 2 default; the owner accepted all twenty-one by id with no objection. |
| DR-007 | Node pin and lint tooling | 2026-09-02 | b: move to the Node 24 line. .nvmrc pins the exact patch (24.20.0), engines.node becomes an open floor >=24.0.0, @types/node moves to the 24 line, README and DEVELOPER state Node 24; no workflow edits because all seven already read .nvmrc via node-version-f... |
| DR-008 | Entry-chunk budget | 2026-09-02 | a: make the map key, telemetry adapters and URL catalog lazy; keep the 45 kB line. None of the three is needed for first paint; the budget stays honest and imports earn their way in. |
| DR-009 | MapLibre version, browser floor, and timing | 2026-09-02 | override: Adopt MapLibre 6.6.0 directly, skip v5 (69 default imports, setWorkerUrl, 18 queryRenderedFeatures sites, WebGL2 path). Browser floor Safari 15.5 pinned in vite.config.ts. |
| DR-010 | Worker compatibility date and nodejs_compat | 2026-09-02 | a: set no_nodejs_compat, republish the Worker, record the rollback handle. Recorded as the packet Part 2 default; the owner accepted all twenty-one by id with no objection. |
| DR-011 | Overture re-pin before 2026-09-21 | 2026-09-02 | a: re-pin Overture buildings to the current release before 2026-09-21. Recorded as the packet Part 2 default; the owner accepted all twenty-one by id with no objection. |
| DR-012 | Briefing structure, four by three or three by four | 2026-09-02 | b: Three horizon sections by four hazard rows; time-leading layout for the field instrument. |
| DR-014 | Rows whose source does not cover the selection | 2026-09-02 | a: outside the Pacific Northwest the ENSO row shows a national-scale ENSO state with the regional tilt prose removed (not unavailable); the near-term heat claim fetches HeatRisk independently with its own status and stamp so it does not vanish when the map... |
| DR-015 | Where the overlap engine lives | 2026-09-02 | a: move the overlap engine from src/impact/ to src/ui/island/ while the briefing restructure has the files open. |
| DR-016 | What near-term means across four screens | 2026-09-02 | a: Generic chip wording (Near-term); each screen stamps its own validity window from HorizonProduct.validity.validLabel. |
| DR-019 | Adopt the CPC monthly and seasonal outlooks | 2026-09-02 | a: Adopt CPC monthly and seasonal outlooks; ENSO season-ahead bound with copy that it is a CPC seasonal outlook, not an ENSO forecast. Owner addition: scout additional issuer products for long-range context; verify, do not pre-commit. |
| DR-021 | Outlook badge and jump-chip wording | 2026-09-02 | a: badge the card OUTLOOK, rename the chip to name its destination. Recorded as the packet Part 2 default; the owner accepted all twenty-one by id with no objection. |
| DR-022 | Does Fire get a real forecast tier | 2026-09-02 | a: SPC Days 1 to 8 near-term, NIFC Months 1 to 4 season-ahead; WHP retired from the horizon recipe and kept as an explicitly static context layer; live perimeters in every horizon. Owner addition: fire-in-context-of-fuel-conditions (WHP beside a live perime... |
| DR-024 | The unmerged perimeter-evidence branch | 2026-09-02 | b: close feature/nifc-perimeter-evidence; correct the wording in place (the briefing calls a 50-record envelope an area; the string change is carried by DR-058). The branch stays backed up on origin at 905671d. The MapLibre 6 migration raises the rebase cos... |
| DR-025 | Tablet and phone 3D policy, and fire3d in the URL | 2026-09-02 | a: width floor plus a capability probe with webglcontextlost handling; tablet allowed; landscape phone excluded; fire3d stripped on cluster change. |
| DR-028 | NASA FIRMS MAP_KEY against hard rule 3 | 2026-09-02 | a: no free federal key; NASA FIRMS stays out; rule 3 stands. Recorded as the packet Part 2 default; the owner accepted all twenty-one by id with no objection. |
| DR-029 | Three-state ENSO model, the live correctness blocker | 2026-09-02 | a: Three-state model with CPC advisory semantics; conditions lead the headline, five-season episode rule secondary; enso-indices.json v2. |
| DR-030 | The four Pacific Northwest tilt sentences | 2026-09-02 | a: adopt all four Pacific Northwest tilt sentences with a source URL on each. Recorded as the packet Part 2 default; the owner accepted all twenty-one by id with no objection. |
| DR-031 | Weekly Nino 3.4 in the Weeks ahead register | 2026-09-02 | a: wire the weekly Nino 3.4 observation, labeled an observation and not a forecast. Recorded as the packet Part 2 default; the owner accepted all twenty-one by id with no objection. |
| DR-034 | Snapshot additions and the transcription ruling | 2026-09-02 | a: add the Multivariate ENSO Index v2 and the Pacific Decadal Oscillation, no transcription; the plume tombstone stands. Recorded as the packet Part 2 default; the owner accepted all twenty-one by id with no objection. |
| DR-035 | Boot tolerance for a stalled renderer | 2026-09-02 | a: after a bounded wait, boot the chrome without the map, show an honest not-yet-rendering state, and add a WebGL probe and a map error handler. Built once, as the MapLibre 6 GPUInitializationError branch (briefing section 6.6 step 6). |
| DR-036 | Does tablet get its own band | 2026-09-02 | a: Real third band 721 to 1024 px, fluid sidebar, 44 px touch floor. Tablet is touch-first: phone simplest, tablet more capable but touch-native, desktop full pointer controls. |
| DR-043 | The completeness sentence on two more popups | 2026-09-02 | a: add the completeness sentence to the deployer Tribal-Lands popup and the Treaty popup. Recorded as the packet Part 2 default; the owner accepted all twenty-one by id with no objection. |
| DR-045 | The DSCI trend band | 2026-09-02 | b as applied on the branch (a DDM-convention labeled band split into an analyzed value plus a derived trend, window derived from dates). Ratified by the owner instruction 'Merge to main' 2026-09-02 08:10 PDT, which ships the applied state. |
| DR-046 | The water-supply bands | 2026-09-02 | a: drop the invented water-supply percent bands; keep the number and its uncertainty. Recorded as the packet Part 2 default; the owner accepted all twenty-one by id with no objection. |
| DR-047 | The DDM-authored causal sentences | 2026-09-02 | a as applied on the branch (heat-coupling sentence removed; the three briefing sentences relabeled derived pending citation). Ratified by the owner instruction 'Merge to main' 2026-09-02 08:10 PDT, which ships the applied state. |
| DR-048 | The USDM impact strings | 2026-09-02 | a: relabel the Drought Monitor impact strings as derived with an archive citation; link the state impacts tool. Recorded as the packet Part 2 default; the owner accepted all twenty-one by id with no objection. |
| DR-049 | How far the gridded-index selector expands | 2026-09-02 | a as applied on the branch (info.json read first for a true date and zoom limit; SPI only for now). Ratified by the owner instruction 'Merge to main' 2026-09-02 08:10 PDT; selector expansion (b) stays open as a later product item. |
| DR-050 | Completeness accounting on the two raster surfaces | 2026-09-02 | a: adopt the completeness sentence on gridded-index and sea-surface anomaly. Recorded as the packet Part 2 default; the owner accepted all twenty-one by id with no objection. |
| DR-051 | What a local run does by default | 2026-09-02 | a: evidence capture behind DDM_CAPTURE_EVIDENCE=1, and build identity asserted locally. |
| DR-052 | The shape of the test suite | 2026-09-02 | b with guidance: ratify the 180 s budgets; add a verify:pure fast lane; do not do the 255-case pure migration (9 s saved). chromium-3d stays in the routine loop (7.8 min is the price of knowing the DDM's most important demonstration feature works). |
| DR-053 | Roadmap slimming and release-notes posture | 2026-09-02 | a, ratifying what eb6c4f3 already did to docs/ROADMAP.yaml, plus product-led release notes. Recorded as the packet Part 2 default; the owner accepted all twenty-one by id with no objection. |
| DR-054 | Skills, agents and commands | 2026-09-02 | a: dormant files marked dormant, a project-local pickup wrapper, no automated merge. Recorded as the packet Part 2 default; the owner accepted all twenty-one by id with no objection. |
| DR-055 | Where the ignored working artifacts live | 2026-09-02 | a: installers beside the settings they install; a tracked dated citation table under docs/. Recorded as the packet Part 2 default; the owner accepted all twenty-one by id with no objection. |
| DR-056 | Conditions tiles, scope and the zero-during-load claim | 2026-09-02 | a: a visible in-view qualifier and a loading state in place of the 0 during load. Recorded as the packet Part 2 default; the owner accepted all twenty-one by id with no objection. |
| DR-057 | The SAT toggle and studio labeling | 2026-09-02 | a: fix all four (satellite toggle state, caption, dots, the two source lines). Recorded as the packet Part 2 default; the owner accepted all twenty-one by id with no objection. |
| DR-058 | Two briefing sentences | 2026-09-02 | a: plain-language lineage kept machine-readable in an attribute; one fire count with its source. Carries the wording half of DR-024. Recorded as the packet Part 2 default; the owner accepted all twenty-one by id with no objection. |
| DR-059 | The preview badge in embeds and on phones | 2026-09-02 | b: keep the preview badge bottom center on desktop only (current behavior). Recorded as the packet Part 2 default; the owner accepted all twenty-one by id with no objection. |
| DR-061 | Pre-processing pipeline scope | 2026-09-02 | DEFERRED, owner ruling (not option a, b or c as written): no cron jobs before the Convention or in the near term. Normalization is updated manually as part of major sprint landings (a phase close, a significant feature merge), never on a schedule. The norma... |
| DR-063 | Wildfire Hazard Potential fuel-risk ramp and transparency | 2026-09-02 | a, owner design decision: a black-to-white ramp with calibrated transparency that composes with both the terrain layer and the perimeter symbology. The class breaks, class labels and the legend's issuer attribution stay the issuer's; only the presentation r... |
| DR-064 | Fire perimeter ribbon in the 3D scene | 2026-09-02 | a, owner rendering specification: opaque at the bottom where the perimeter meets the terrain; transparent at the top with a logarithmic fade (opacity drops quickly near the top, a flickering flame-like impression); not too tall, just enough vertical extent... |
| DR-067 | How the Wildfire Hazard Potential ramp reaches the screen | 2026-09-03 | Option b, CONDITIONAL. The ramp reaches the screen by sending a rendering rule to the issuer's ImageServer exportImage call and carrying the new route through the Worker allowlist, so the flat layer and the 3D drape keep one color language. The owner attach... |
| DR-068 | Water and Non-burnable on a lightness ramp | 2026-09-03 | Option b. Water and Non-burnable get a treatment visibly outside the lightness sequence, named in the legend as carrying no hazard level. Not drawn as nothing, and not placed on the ramp. The issuer's classes stay intact and stay the issuer's; only the trea... |
| DR-069 | Production source maps while GitHub Pages is the host | 2026-09-03 | Option a. Production builds publish no source maps while GitHub Pages is the host. If the current build emits any, remove them and record the reason in DEVELOPER.md. Revisit when the local full-service server lands. |

Entries with an `owner_notes`, `widened_2026_09_02` or `amended_2026_09_02` field in the YAML (DR-009, DR-025, DR-035, DR-051, DR-052, DR-015, DR-061) carry owner expansions that this table truncates; read the YAML for the full text.

## Index of all entries by group

**G1 Posture and platform.** DR-001 (decided); DR-002 (decided); DR-003 (decided); DR-004 (decided); DR-005 (decided); DR-006 (decided); DR-007 (decided); DR-008 (decided).

**G2 MapLibre and dependencies.** DR-009 (decided); DR-010 (decided); DR-011 (decided).

**G3 Impact Briefing structure and copy.** DR-012 (decided); DR-013 (pending); DR-014 (decided); DR-015 (decided).

**G4 Forecast uniformity and time.** DR-016 (decided); DR-017 (pending); DR-018 (pending); DR-019 (decided); DR-020 (pending); DR-021 (decided).

**G5 Fire and 3D.** DR-022 (decided); DR-023 (pending); DR-024 (decided); DR-025 (decided); DR-026 (pending); DR-027 (pending); DR-028 (decided).

**G6 ENSO and marine.** DR-029 (decided); DR-030 (decided); DR-031 (decided); DR-032 (pending); DR-033 (pending); DR-034 (decided).

**G7 Interface.** DR-035 (decided); DR-036 (decided); DR-037 (pending); DR-038 (pending); DR-039 (pending).

**G8 Minimap and popups.** DR-040 (pending); DR-041 (pending); DR-042 (pending); DR-043 (decided); DR-044 (pending).

**G9 Science defensibility.** DR-045 (decided); DR-046 (decided); DR-047 (decided); DR-048 (decided); DR-049 (decided); DR-050 (decided).

**G10 Tests and evidence capture.** DR-051 (decided); DR-052 (decided).

**G11 Docs and planning.** DR-053 (decided); DR-054 (decided); DR-055 (decided).

**G12 Visual-pass carryover.** DR-056 (decided); DR-057 (decided); DR-058 (decided); DR-059 (decided); DR-060 (pending).

**G-packet Added by the 2026-09-03 decision packet after adversarial review.** DR-061 (decided); DR-062 (pending).

**G-session-2026-09-02 Added by the 2026-09-02 evening decision session (owner addendum and user-research intake).** DR-063 (decided); DR-064 (decided); DR-065 (pending); DR-066 (pending).

**G-session-2026-09-03 Added by the 2026-09-03 implementation session (raised by execution, not by review).** DR-067 (decided); DR-068 (decided); DR-069 (decided).
