# Design documentation

This directory holds the owner's design input alongside current presentation
contracts and implementation history. None of it replaces the roadmap.
Runtime source, state contracts, accessibility behavior, and tests are
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
| [`mobile-map-chrome.md`](mobile-map-chrome.md) | Current presentation contract for the map-first phone chrome implemented by pull request 7. Sections marked "Superseded 2026-11-09" record the sprint's owner direction (DR-pending) and what it built. |
| [`fire3d-context.md`](fire3d-context.md) | Honesty framing for the desktop 3D Fire context view: the no-fire-behavior-modeling line, the "not a digital twin" naming decision, and the in-interface non-prediction disclosure. |
| [`fire3d-entry.md`](fire3d-entry.md) | Proposed entry contract for the 3D Fire scene: staged loading, the deferred loading screen, cancel, and the honest sidebar state (S28, 2026-09-11). "On phones" records what the sprint built (2026-11-09). |
| [`ddm_interface-edits_1.json`](ddm_interface-edits_1.json) and [`ddm_interface-edits_2.json`](ddm_interface-edits_2.json) | Immutable owner-annotation captures that informed pull request 6. They preserve the input as received; they are not an active plan, literal pixel specification, or current completion checklist. |

Owner markup carries hierarchy, relationship, emphasis, and intended
interaction. Its sketch colors and geometry are not automatically literal UI
colors or fixed coordinates. Translating that intent through the application's
data, state, responsive, accessibility, and stewardship contracts is the work
of respect, not dilution.

Merged product changes and observed deployment facts belong in
[`../RELEASE_NOTES.md`](../RELEASE_NOTES.md). The roadmap defines planned
scope, Asana carries execution state, and runtime plus tests define implemented
behavior. Do not duplicate those roles in this design index.

## Current direction, recorded 2026-09-01

By owner direction the briefing is named the Impact Briefing and extended from
its drought-only framing to synthesize Drought, Fire, Heat, and ENSO. The
eventual host for the module is a local full-service server; GitHub Pages
remains the static host for now. Work converges on one integration branch and
lands as one pull request, replacing per-action continuous integration
receipts.

## Standing interface invariants and decisions

These constraints and decisions were lifted on 2026-09-01 from the closed
2026-08-10 interface-integration ledger, now archived. They live here because
nothing else tracked records them, and the shipped runtime still enforces
every one. Where a runtime file owns the constraint it is named, and each
named path was confirmed to exist on 2026-09-01.

### Invariants

- The Tribal boundaries shown are public data (T0), read live from their
  public sources; no boundary geometry is copied into the repository.
- Tribal and Treaty representation caveats remain intact, and those outlines
  stay above the condition surfaces (`src/map/layer-order.ts`).
  - Amended 2026-09-26 (DR-131): a water-quality criterion is quoted only where
    the state's own designated-use layer covers the reach, never inferred from
    an agency Tribal or Treaty polygon; every such line adds "Other standards,
    including Tribal water quality standards, may apply"; DDM never says a
    reading "exceeds" a standard.
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
  - An agency-published polygon product derived from hotspots with a stated
    method (for example CWFIS Fire M3) is not a hotspot feed under this
    line; it may be shown as a labeled estimate layer, never as an incident
    and never counted active (DR-104, 2026-09-25).
  - Amended 2026-09-26 (DR-128): a model smoke field drawn at the model's
    heights is neither an incident claim nor a fire score; it is labelled model
    guidance and its legibility over the perimeters is proven by a pixel test.
    (Layered beneath the 2026-09-25 DR-104 note above.)
- Repository-authored text contains no U+2014 em dash.

### Decisions

- **DDM-UI-002** (amended 2026-09-25, DR-105). Recent satellite imagery is the
  product default in every 2D mode, encoded by absence in the URL;
  `basemap=default` records the explicit off choice and the legacy `satellite`
  token stays valid. Each mode has its own default view with a legend in real
  units (Drought and Wildfire GeoColor; Heat clean infrared; ENSO water vapour).
  The Wildfire 3D scene never requests imagery: its ground is the WHP drape over
  a plant-stress layer. Drought, Heat and ENSO 3D drape a cloud-free image
  (`src/map/satellite.ts`, `src/state/basemap-store.ts`).
  - Amended 2026-09-26 (DR-124, DR-133; layered on the 2026-09-25 DR-105
    amendment above, which gives each mode its own default view with a legend in
    real units): ENSO's default is GOES-West Clean IR Band 13 in degrees C; the
    water-vapour mosaic is a console option while its legend is counts;
    GeoColor's colour-meaning key is the real-units legend for Drought and
    Wildfire; Heat's Band 13 comes from GOES-West alone with a viewing-geometry
    sentence; the cloud-free 3D drape is NASA GIBS Blue Marble, August 2004,
    stated.
- **DDM-UI-003.** The shell, cluster service, URL sync, and region command are
  reused through named adapters rather than reimplemented per surface
  (`src/ui/island/shell.tsx`, `src/state/cluster-service.ts`).
- **DDM-UI-004.** Drought receives a backed NADM mean-severity and
  outline-share summary. Wildfire receives a strict current-WFIGS-first
  summary, with static WHP thresholds used only after a successful zero count.
  Heat and ENSO land framings stay explicitly neutral; a custom view reads
  the hazard it was made from
  (`src/state/minimap-drought.ts`, `src/state/minimap-wildfire.ts`).
- **DDM-UI-006.** Prescribed fire is split from wildfire within the existing
  WFIGS perimeter source (`src/layers/nifc-fires.ts`).
- **DDM-UI-007.** HMS smoke density renders through the owner's warm taupe ramp
  and opacity; unknown remains explicitly unclassified (`src/layers/hms-smoke.ts`).
  - Amended 2026-10-19 (owner walk): density renders through the owner's warm
    taupe ramp (Light #aa9c8d, Medium #908477, Heavy #766d62) with the same
    opacities; unknown stays neutral slate and unclassified.
  - Amended 2026-09-26 (DR-128): the HMS presentation is draped and feathered
    from the issuer's three classes and never draws or states a height
    (DDM-P5-T08). A separate NOAA HRRR-Smoke model volume may draw smoke at the
    model's own heights, labelled model guidance with its run and valid time,
    never blended with HMS and never recolouring it; two products, two clocks.
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

Amended 2026-09-26 (DR-125): EOX Sentinel-2 cloudless is served (2016 to
2025), not retired; it is excluded as a non-government issuer, CC BY-NC-SA
from 2018, with on-map attribution required.

## Priority view of the Impact Briefing

Recorded 2026-11-09, owner direction 2026-11-09 (sprint), DR-pending.

The Impact Briefing has two presentations of the same claims. The full detail
is the matrix: four hazards at three horizons, never reordered. The priority
view reads the same cells in a different order and draws them as gauges. It
adds no source, fetches nothing and computes no value
(`src/ui/briefing-lead.ts`).

**What leads.** The current and near-term reads that hold a class in the
reading order, as tiles: the hazard word, the issuer's class in the issuer's
words, a gauge on the issuer's own scale where the issuer has one (an NWS
product wears the issuer's map colour beside its name instead), the source,
the date and the evidence class. The first four lead; any further ranked
reads follow as the same tiles under "Next in the reading order". Every tile
is built the same way: first in the order is read first, it is not drawn
larger.

**The one rule.** The order comes from one table (`PRIORITY_ROWS`,
`src/impact/priority.ts`): by row, then by the issuer's own class order inside
the row, then by the fixed hazard order Drought, Fire, Heat, ENSO. The rows
are an NWS product in effect at the point, a current mapped wildfire
perimeter, the U.S. Drought Monitor category, the NWS HeatRisk level, the SPC
Day 1 or Day 2 category, the SPC Days 3 to 8 probability, and El Nino or La
Nina conditions. It is a reading order, not a severity score: nothing is
added, weighted or compared across hazards. The view says so on its surface
and the rule is rendered from the table at the head of Technical information,
one tap away ("How this is ordered").

**Absence is not ranked.** A read with no class in the table (no polygon, no
area drawn, no product in effect, an issuer's lowest class) is listed under
"Other reads and gaps" in the issuer's words. A cell that was not read is
listed there under its own state with the reason. Neither is an all-clear, and
no hazard is dropped.

**Gauges** (`src/ui/gauges.ts`). The class gauge draws the whole issuer scale
in the issuer's colours and marks the read class by position (a caret and a
taller block) and an ink keyline, never by colour alone. The index gauge draws
a signed index against the issuer's thresholds. The day strip draws a short
run of days on one issuer clock. A gauge with no read never draws a value:
`loading...` is the empty outlined scale (on the day strip its frames are
dashed, because an empty solid day frame is itself a read: "no area drawn"),
`unavailable` is a hatched plate, `no data` is the empty scale with a short
bar in every slot. None marks one class, so there is no zero to misread.

**Present together.** Hazards that hold a ranked read for the same moment are
joined on a rail with one node each. The rail has no direction: it states
co-occurrence in place and time, never that one hazard leads to another.

**The evidence chain** (`src/ui/evidence-chain.ts`) is the one shared
component for laying separate claims one after another as links, down the
column at every width. Each link is its own claim on its own clock with its
own evidence class; each joint is a labelled relationship, never a cause; a
link with no read keeps its place under its state word.

**Reaching the matrix.** A two-way switch, Priority and Full detail, sits at
the top of the briefing. Any tile or row opens that hazard's own cells in the
matrix (the federal text, each claim's method and source link) with doors to
Technical information and Acknowledgements; "Priority view" returns. Phones
open on the priority view; every other shell opens on the full detail with
the switch above it. The choice is presentation state and never enters the
URL. Paper carries the full detail only: the priority view does not print.

## The ENSO chain and its Guide door

Owner direction 2026-11-09 (sprint), DR-pending.

While the sea surface temperature surface is on the map, the ENSO mode lays
five separate claims side by side, from the tropical Pacific to a place, with
the shared evidence chain: the observed index, the ocean surface the map
draws, the jet-level wind as model guidance, the published seasonal outlook at
the chosen place, and what is observed there now
(`src/ui/enso-chain-model.ts`, `src/ui/enso-chain.ts`).

**Each link is its own claim.** It wears its own source, clock and evidence
class. A link with no read says which state it is in and why. A link whose
view was never asked for (the overlay off, no place chosen) is idle in plain
words: never `unavailable`, never a zero, never an all-clear. An overview
strip over the links draws a read as a disc in its evidence tier and no read
as an open square under a state word.

**The words between links** name a relationship the repository can cite
("computed from the boxed region of", "historically tends to shift") or say only
that two reads sit side by side ("one model instant, read beside a season",
"read beside"). None is a cause and none is an arrow.

**The nested truth** is one tap under the caption, and its lead is on screen
before any tap: "This is a shift in the odds, not a forecast." Open, it
carries the odds sentence, NOAA CPC's own sentence on single storms, the
regional tendency claim, the index claim and the pointer to CPC's official
status, each with its source and date, in the words `src/impact/enso.ts`
governs.

**The chain is the mode's table of contents.** Pressing a link takes the map
to that link's view through a door the interface already has: the ocean view,
the flow overlay's kind, the horizon, the place's briefing, the Place studio.
The link is then in the address bar, and the chain holds no view state. A
press replaces the current history entry, as every mode, horizon and layer
change does; only the Place studio adds one. Where a press shows another
outlook layer than the link reads, the link names the layer the map draws.

**Seats.** On the desktop shell the chain is a panel of the sidebar. On the
phone shell it is the content of the sheet behind a fifth door, Guide, which
rides the right-edge column's panel group only while the chain exists. The
sheet stays closed until that door is pressed. The door exposes
`aria-controls` and `aria-expanded` and inverts when open; Escape closes the
sheet and returns focus to it. The guide's open state is presentation and
never enters the URL.

**Lazy and still.** The sea surface temperature layer loads the chain when it
activates and removes it when it deactivates. An embed loads none of it. If
the chain fails to load, a short notice says the guide is unavailable and that
the map and its key are unaffected; the next activation asks for it again
under a new address, its stylesheets first, because a browser replays a failed
import of the same address without asking the network
(`src/util/chunk-retry.ts`, `src/util/chunk-stylesheets.ts`). The guide is
never drawn without its stylesheet. The two place links ask their sources only
while some of the panel is on screen, and once per chosen place: a place
chosen with the phone guide closed costs no request until the guide is opened.
If the links' reader fails to load, each link says so, and the next showing of
the panel asks for it again under a new address. Nothing in it moves, so
reduced motion shows the same picture.

## Locate

Owner direction 2026-11-09 (sprint), DR-pending.

Locate finds the person's own position and opens the place they are standing
in. That position is the most sensitive value the application holds, so the
design starts from what never happens to it
(`src/state/geolocate.ts`, `src/ui/locate-runtime.ts`,
`src/ui/locate-place.ts`).

**What never happens.** The position is held in memory only. It is never
written to storage, never placed in the address bar or a shared link, and
never sent in a request. The camera never centres on it: a node test reads
the Locate modules as text and fails unless their camera calls are exactly two
fits of a box (`tests/geolocate.test.mjs`). The one value Locate stores is the
word `yes` or `no`, the answer to "Find my place when I open the map"
(`src/state/locate-preference.ts`).

**Asking.** A page load never raises the browser's permission question. On
the phone shell a first launch makes an offer, a card with "Locate me" and
"Not now"; the browser asks only after "Locate me" or a press of the Locate
cell. A later launch locates by itself only when the stored answer is `yes`
and the browser reports the permission as already granted. A shared
`select=` link or a studio makes no offer: the link is the ask. Desktop and
embed sessions show no Locate cell and no offer (`src/ui/locate-control.ts`).

**Every outcome is its own state.** Waiting for the answer, finding (twelve
seconds, with a bar that empties), found, found with low accuracy, blocked by
the browser, not allowed this time, no position, timed out (with one retry),
an insecure page, and a browser without location each have their own card,
cell state and polite announcement. A late answer after a cancel or a timeout
is discarded.

**The answer is local first.** The state is read from the Census outlines the
page already holds, with no request. The card says only what that coarse
outline supports. The device's accuracy radius is widened by two kilometres
(a DDM margin for the 1:20,000,000 outline, not an issuer figure): "You are in
Washington" when that whole disc is inside one state, "at the edge of" or
"near the line" when it reaches a drawn line, and "outside the states this map
names" when it reaches none. Only the first opens a briefing by itself,
through the door a shared link uses, so the map frames the state and never
the person. At an edge or a line the card offers each state within reach by
name and waits for a press; outside, it offers the Place door.

**Tribal lands are a named step.** "Check Tribal lands near you" first shows
three sentences: the map moves to a grid square of half a degree that contains
the position and loads Tribal boundaries there from the agencies whose layers
are on; the map's sources see that square and not the position in it; and a
position the check places inside an area opens that area. The test then runs
in the browser against the boundaries the live layers hold. Nothing is fetched
for the point and no boundary is stored. Only a whole accuracy disc inside an
area names it as the person's, with the agency that draws it. A layer that is
off is reported as not checked, one that failed as unavailable, and "not
inside any area" always carries the boundary popups' sentence that absence
from a layer is not absence of a Nation or of its rights. Where the
accuracy disc reaches past the area that was loaded, no layer is called
checked.

**The marker** is a person on a stem with an accuracy ring in true ground
metres, white on rich black: dashed and hollow-footed when the position is
approximate, never a hazard colour and never the platform's blue dot
(`src/map/locate-marker.ts`). It settles once on arrival and not at all under
reduced motion. Removing the position removes the marker, its ring and
everything read for it.

**Seats.** The cell is the last of the right-edge column's view tools and
inverts while a position is shown. The card stands in the map's dock above
the sheet and folds to its title; on a short screen unfolding it lowers or
closes the sheet, so the two never share a pixel. Everything but the cell and
the launch check is one lazy chunk, loaded on the first press or the first
eligible launch. A chunk that fails to load is asked for again, under a new
address, by the next press, its stylesheet first, and the card is never
drawn without its stylesheet (`src/util/chunk-retry.ts`,
`src/util/chunk-stylesheets.ts`). A press whose chunk arrives after the
phone shell has gone starts nothing.

## The Place and Layer studios

Owner direction 2026-11-09 (sprint), DR-pending.

The two studios are full-screen surfaces behind the `studio=` route. The
route, Back, Escape, focus return and the inert scope are unchanged; what
each studio shows was redrawn for a phone first
(`src/ui/island/place-studio.tsx`, `src/ui/island/layers-studio.tsx`,
`src/styles/studios.css`).

**Place studio: search first, action last, one screen.** One search looks
through every loaded list at once (Tribal Nations, States, Ecoregions,
Watersheds) with the shared search's matcher. Five chips narrow it: All, then
the four types. They wrap and never run off the screen. The list is the page:
full-width rows with the kind in plain words under each name, and one
scroller at every width. A list that could not be read says so in its place,
with a retry.

**The selection bar** stands at the bottom edge once a place is chosen: its
kind, its formal name whole, one sentence on what can be opened, and two
actions in plain verbs. "Open briefing" is the hand-off the studio has always
made. "Show on map" selects the place, frames it clear of the phone chrome
and marks its boundary, and opens no briefing: a Tribal Nation with the
located overlay, any other kind with a neutral dashed boundary, never the
Tribal family colour (`src/ui/island/place-on-map.ts`). For a Tribal Nation
the bar carries the representation caveat in full, never folded, and the
sentence "Its boundary is read live each time. DDM does not store it." The
boundary read has its own states: reading, available, could not be read
(with a retry), nothing came back, and no matched boundary. A Nation with no
matched boundary shows no caveat, because nothing is represented, and the bar
says that in a sentence.

**After "Show on map" on a phone** the sheet's at-hand block names the
selected place, and its one door reads "Open briefing". The block states no
condition until a briefing is read (`src/ui/mobile-sheet.ts`).

**Layer studio: what is on the map, then what can be added.** "On the map
now" lists each active layer with its role, its name, its state word and
"Turn off"; a failed layer also offers "Try again". Under it, conditions are
one choice in semantics and in look: a radio group whose chosen row inverts
whole. A pointer press on the chosen condition turns it off; a key never
does. Overlays stay checkboxes whose mark inverts. Each group folds behind
Hide or Show and keeps its count. The sidebar's own catalog is unchanged.

**Honest failure.** A studio whose stylesheet did not load never mounts
unstyled: it shows the existing "Studio unavailable" state, whose retry
reloads.

## Convergence doctrine

DDM is not merely a map. It is an instrument for making claims responsibly
about conditions that can shape decisions during drought, wildfire, heat, and
other climate stress. There is no neutral display; design quality therefore
includes the honesty of what the instrument says, what it cannot say, and how
visibly it draws the line between them.

### Truthfulness is interface design

The interface may compress, sequence, group, or progressively disclose a
source claim. It must not broaden the claim's meaning, time, geography,
completeness, or certainty. `no data`, `unavailable`, `live (partial)`, and a
verified absence remain different states. A visual summary must carry a path
to its source, update time, qualification, and provenance.

Amended 2026-09-26 (DR-132): a named display treatment that copies an issuer's
class to neighbouring pixels up to a stated coastline (the SST coastal fill) is
a presentation stated in the legend and reviewed like a method, never a new
value, never a value over land, and never a product of DDM's own.

### Design for a field instrument

DDM must work for a person in bright light, on a small screen, with one hand,
intermittent source availability, and limited attention. The first read is
glanceable. Touch targets, focus, contrast, safe areas, and reduced-motion
behavior are core design inputs. Progressive disclosure adds depth; it never
hides the condition, source, or status a decision depends on.

### Emphasis must be ethical

Color, contrast, scale, hierarchy, and motion may foreground a condition only
when the underlying evidence and class warrant that emphasis. Motion never
upgrades evidence, turns a representation into an incident claim, or implies a
forecast. The reduced-motion presentation must communicate the same meaning
without animation. Urgency comes from clear prioritization, not alarm styling.

Amended 2026-09-26 (DR-092; DR-123): the committed mode's briefing emphasis is
a tint plus a small "your mode" word, never an edge line and never a hazard
colour; it marks the reader's mode, not a severity, and rows are never
reordered. In the Wildfire 3D scene motion belongs to the flame edge on
issuer-active records only; the perimeter fill holds its colour and a null
status is static (DR-128).

Amended 2026-11-09 (owner direction 2026-11-09 (sprint), DR-pending): the
matrix rows still are never reordered. A separate priority view of the same
briefing may lead with reads in one published reading order over issuer
classes; see "Priority view of the Impact Briefing" above.

### Creativity comes from truthful arrangement

Creative range lives in how governed facts are framed, layered, juxtaposed,
sequenced, and connected through interaction; it does not extend to inventing a
severity score, blending hazard claims, implying an all-clear, telling a causal
story, or adding a capability the sources do not provide. A novel arrangement
succeeds when it helps a person see a truthful relationship sooner. A product
DDM computes from agency data where no agency feed exists (DR-103, 2026-09-25)
is such an arrangement only when it is labeled as DDM's computation, its inputs
and method are published in the technical section, it was reviewed before
shipping, and it states no forecast, probability, causal story or blended score.

Amended 2026-09-26 (DR-117, DR-129; layered after the 2026-09-25 DR-103 sentence
above): a build-time join that labels road segments by the issuer's own hazard
class and a sampling of an issuer raster along a perimeter edge are display
rules over issuer values, labelled so; they compute no new claim.

### Urgency raises the standard

Time pressure does not waive attribution, accessibility, cancellation,
failure handling, responsive verification, or source qualification. The more
urgent the use case, the more it matters that the display fail honestly and
preserve the person's state. Work moves in bounded visible slices, with
limitations and verification reported directly, not hidden behind process
ceremony.

### Co-creation is translation with receipts

The owner supplies purpose, lived priorities, annotations, and acceptance
judgment. Implementation reconciles that intent with the application's real
data and state contracts, shared design primitives, browser constraints,
accessibility, and Tribal stewardship. When a constraint requires adaptation,
the implementation preserves the owner's relationship and hierarchy, records
the reason, and returns a visible working result for review. Tests and
screenshots are evidence of the translation, not substitutes for owner
judgment.

Neither side is complete on its own, and neither is a vendor to the other.
The owner sees community context, consequences, institutional relationships,
and meaning no repository reveals. The implementation partner sees cross-file
coupling, lifecycle hazards, browser behavior, and verification seams the
owner should not have to enumerate. Respect means both forms of knowledge can
change the work, and that a meaning-changing assumption returns to the owner
instead of being hidden inside code.

### Convergence is systems alignment

Convergence systems architecture is the working name for this method. It
treats interface, data, state, stewardship, and verification as one
claim-bearing system rather than separate finishing passes; each layer keeps
its own integrity while the distance between them narrows.

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

These six questions are lenses a designer carries through the work, not boxes
ticked before shipping:

1. What decision or first-glance understanding improves for the person
   using it?
2. Which source and state contracts support every visible claim?
3. Does emphasis match evidence without overstating urgency or certainty?
4. Does the same meaning survive mobile, desktop, embed, keyboard, source
   failure, and reduced motion?
5. Which reusable token or component carries the pattern, and which exception
   is semantically necessary?
6. What test, inspection, or screenshot demonstrates the result and its known
   limits?

This is a design-quality check, not a phase gate or parallel project ledger.
