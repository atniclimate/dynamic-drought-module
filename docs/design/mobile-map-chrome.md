# Mobile map chrome

This note records the presentation contract for the map-first phone view. It
applies only when the mobile panel shell is active at 720 CSS pixels or narrower.
Desktop and embed placement remain owned by their existing shells.

Implemented by
[pull request 7](https://github.com/atniclimate/dynamic-drought-module/pull/7),
merged as `eed7967` on 2026-08-18. Runtime code and tests remain authoritative
when implementation details change. The design-corpus authority and durable
convergence doctrine are recorded in [`README.md`](README.md).

## Tokens

Superseded 2026-11-09 (owner direction, sprint; DR-pending). The teal glass
(`#004040`) and the per-stack control sizes are retired. The phone chrome
tokens are one block in `src/styles/app.css`, headed PHONE CHROME TOKENS.

- Glass is rich black, never a hue: `--glass-fill` where the browser can blur
  and `--glass-fill-solid` where it cannot, with one edge (`--glass-edge`) and
  one shadow. Colour on this instrument belongs to the data.
- Corners are tight. A glass body (the sheet, the drawer, a capsule in the
  right-edge column, the report card) takes `--glass-radius`, which is the
  scale's large step (`--radius-lg`, 8px): the radius the phone panel had
  before the sheet. A control inside a body sits one step in. Nothing on the
  phone is rounder than that.
- Selected inverts, in every shell. A control that is on wears the ink as its
  face (`--face-selected`) and the surface colour as its label
  (`--ink-on-selected`). Its outline is even on all four sides; no side
  carries a bar. This replaces the pressed plate and its leading bar.
  `aria-pressed`, `aria-expanded`, and `aria-checked` still carry the state;
  the face only shows it.
- Focus on a selected control keeps the 2px ring and its 4px casing and adds a
  2px rich-black ring just inside the white face (`--selected-focus-inset`),
  so the ring never merges with the face.
- A layer row is a checklist row, not a button: on desktop a row that is on
  keeps its leading mark.
- The touch target never falls below 44px. Safe-area insets participate in
  every top, right, left, and bottom seat.

## The right-edge column

Superseded 2026-11-09 (owner direction, sprint; DR-pending). The doors were
anchored from the top and the hazard views from the bottom, so the two stacks
met on a short screen. Every right-edge control now sits in one column that
one manager owns (`src/ui/edge-column.ts`), arranged by one pure planner
(`src/config/edge-column.ts`) and drawn by `src/styles/edge-column.css`.

- Groups, top to bottom: map tools (Share, Reset, Map information), the four
  doors (Brief, Place, Layers, Alerts), the four hazard views (ENSO, Fire,
  Drought, Heat), then the view tools (Satellite, then Locate). Each group is
  one glass capsule, and each cell shows an icon over one short word.
- The planner prefers the largest cell with every control displayed: one
  track at 52px (on viewports at least 380px wide), then 48px, then 44px; then
  44px with the map tools folded behind one cell; in portrait, with the hazard
  views folded as well; then two tracks; then two tracks with groups folded.
  A folded group is one cell that opens its controls as a row beside it.
  Nothing is dropped, and two controls never share a pixel.
- A cell is a tile inside its capsule. The selected tile inverts: the open
  door, the hazard view that is on, Satellite when on, Locate while a position
  is shown, and Map information when open.
- Each door exposes `aria-controls` and `aria-expanded`. Pressing a closed
  door raises its sheet. Pressing the open door again, or pressing Escape,
  closes it, and Escape restores focus to that door.
- A raised sheet always shows its door. A sheet that no door raised (a map
  selection, a shared link, Locate) lights the door whose word its title
  reads: Brief while the report is open at full, Layers in the console view,
  otherwise Place. Pressing that lit door closes the sheet, as it does for a
  door that was pressed. A sheet that names itself, the ENSO guide, lights
  only its own door (owner direction 2026-11-09 (sprint), DR-pending).
- The first four hazard cells use the mobile view presets; Satellite remains
  the one `BasemapSwitcherControl` backed by the basemap store. A short word
  never replaces an accessible name, `aria-pressed`, or focus treatment.
- The same elements move between their desktop seats and the column when the
  shell changes, so focus order equals visual order in both.
- Map information rides the column while the map leads (the sheet closed or
  at peek) and waits while a panel is open.
- A mode may seat one more door in the panel group while its own guide
  exists. The ENSO mode seats Guide, after Alerts, for as long as the sea
  surface temperature surface is on the map; the planner counts it like any
  other cell (owner direction 2026-11-09 (sprint), DR-pending; see "The ENSO
  chain and its Guide door" in [`README.md`](README.md)).
- Locate is the last cell of the view tools, on the phone shell only. Its
  card stands in the map's dock above the sheet and never under the column
  (owner direction 2026-11-09 (sprint), DR-pending; see "Locate" in
  [`README.md`](README.md)).

## The sheet

Superseded 2026-11-09 (owner direction, sprint; DR-pending). The panel was
top-anchored, with no grabber and no drawer form. It is now one glass sheet
that rises from the bottom edge, docked beside the right-edge column so the two
never share a pixel. `src/styles/mobile-panels.css` owns its form,
`src/ui/mobile-sheet.ts` its state, `src/ui/sheet-motion.ts` its motion, and
`src/config/sheet-detents.ts` its landing rules.

- Stops. The detent names are real heights again: closed (off screen), peek
  (the header and the first lines, 136px above the bottom safe area), half
  (half the dynamic viewport), and full (up to the key chip). Peek and half
  show the same content, so a drag between them never swaps what is under the
  finger; full adds the standalone report in Brief and the whole catalog stack
  in console.
- Doors. Place, Layers, and Alerts open at half. Brief opens at full when
  there is a briefing to read and at half while no place is chosen.
- Header. A grabber, the open door's own word as the title, and a 44px close
  control. The grabber is a real control: Enter, Space, or a tap steps to the
  next stop; ArrowUp and ArrowDown step up and down. Stop changes are announced
  through the polite live region.
- Touch. The header drags the sheet, and so does the content when it has
  nothing to scroll that way (at peek, when it fits, or at its top with the
  finger moving down). The sheet follows the finger, rubber-bands past full,
  and on release settles on the nearest stop from the finger's speed. A flick
  down from peek, or a drag well below it, closes the sheet; a flick from half
  or full only lowers it.
- Motion is transform only, on the shared settle spring. Under reduced motion
  a stop change lands at once on the same end state.
- The report opens over the at-hand answer as its own card, a second layer;
  its close control, or pulling the sheet down to half, is the way back.
- The at-hand block never says "Pick a place" under a map that marks one. A
  place that is selected with no briefing read yet (shown from the Place
  studio, or chosen while the console view was up) is named there, in one
  line that states no condition, and the block's one door reads "Open
  briefing". Once a briefing is read the door is "Read the full report"
  (owner direction 2026-11-09 (sprint), DR-pending).
- The scale rulers and the dock (notices and the OpenStreetMap credit) ride
  the sheet's top edge at peek and half. Camera fits made for a briefing keep
  the half band clear; the map's own padding stays zero.
- In a short landscape window inside the phone shell (at most 480px tall) the
  same element is a drawer from the left edge: one open seat at full height,
  closed by its close control, Escape, its door, or a drag to the left.

Panel state is presentation only and is never written to the URL.

Embed mode has no rail. Exiting an embed restores the closed mobile shell.

## 3D on phones

Superseded 2026-11-09 (owner direction, sprint; DR-pending). This note said
"Phone views do not load or present the 3D Fire controls." A phone may now
enter the 3D Fire view, through one explicit control and on these terms.

- The 3D cell sits in the right-edge column's view tools, under Satellite.
  It exists only where a press means something: Fire is the hazard view, the
  renderer probe found WebGL 2, and the screen is at least 360px wide and
  600px tall. Anywhere else the cell is absent, never disabled, so the column
  never shows a dead control. `src/config/fire3d-phone.ts` states the
  measurement behind each floor.
- A press sets the same durable preference as the desktop console's button
  (`fire3d=true`), after committing the Wildfire view as that button does,
  so one link opens the same way on a phone and on a desk. Unlike that
  button it leaves the basemap alone: the rail's Fire view opens on imagery,
  the scene holds imagery off while it is opening or open, and leaving the
  scene brings it back. The selected cell inverts. Pressing it again is the way out, and Cancel while the scene is
  still loading. Leaving the Fire view ends the scene.
- The two statements stand on the map. A phone has no sidebar beside the
  scene, so the terrain coverage statement and the non-prediction disclosure
  are one glass card under the key chip for as long as the scene is asked
  for, in the words of `src/config/fire3d-presentation.ts`. The card has no
  close control while the scene is on. The scene's gate admits a phone only
  while that card is mounted. No sheet stop covers it: the full stop ends
  under the card, and the half stop leaves room below the card for the
  credit and the scale rulers that ride the sheet's top edge. An open key
  drawer pushes the card down instead of covering it, and closes when a
  panel rises.
- The same card is the entry's loading surface: it names the step the scene
  is waiting on, shows an indeterminate bar, and offers Cancel. A failure
  leaves the flat map and states its reason on the card until it is closed,
  retried or left.
- Touch camera control is two layers. Two-finger tilt and two-finger rotate
  are on while the scene's chrome is mounted, and what was found before is
  put back when it leaves. A plus of five 44px keys beside the column gives
  the same with one thumb: tilt up, tilt down, rotate left, rotate right,
  and a compass that shows which way the view faces and returns north-up at
  the opening tilt. The pad waits while a panel leads, while the key or Map
  information is open, and wherever it would meet the card. Reduced motion
  jumps. Camera state is presentation and is never written to the URL.
- A phone that cannot hold the scene but was sent a `fire3d=true` link gets
  no cell and one sentence, once. The preference is kept, as it is on a
  short desktop window.
- A phone that drops under a floor while the scene is on (turned on its
  side, for example) loses the scene, the card and the pad, hears the same
  one sentence, and gets the flat map back at the camera the scene found.
  The preference is kept, so the scene returns when the screen can hold it
  again. The restore is finished by a jump if another camera call cuts its
  ease short (`fire3d-entry.md`, "Leaving, on any screen").
- The scene's code stays lazy: the entry chunk carries the cell and its
  decision, and a phone that did not ask downloads nothing more.

## Information surfaces

The compact Fire key owns the upper-left column and reserves the right control
column through relational width calculations. Its two source sections stack
vertically. A disclosure is rendered only when the measured key content
actually exceeds its collapsed capacity, and expansion is bounded within the
visible map stage.

The phone Fire quick view deliberately composes the SPC Day 1 fire-weather
outlook alongside the current NIFC perimeters and HMS smoke plumes. The
desktop Wildfire cluster separates those products by temporal horizon
(perimeters plus smoke at Current; the outlook joins at Next seven days),
but the phone shell has no horizon control, so its one Fire read carries
the outlook as well. This is a governed, intended divergence from the
desktop current-horizon recipe, not drift; both compositions are recorded
in `src/config/clusters.ts` and `src/config/presets.ts`.

The Map information control (Info in the right-edge column) opens a non-modal
glass region across the map stage. It blocks pointer interaction with the map canvas, while the persistent
right controls and the information toggle stay above it. Its content is
derived from the active key, canonical layer definitions, registry statuses,
basemap state, and the governed Tribal geography provenance note. Open state is
presentation-only and is never written to the URL.

## Motion

Ordinary interface transitions honor reduced motion. Current NIFC Wildfire and
Wildfire Complex perimeter layers share one restrained MapLibre paint pulse.
Prescribed and unclassified perimeters remain static. Reduced motion uses the
canonical static wildfire color.
