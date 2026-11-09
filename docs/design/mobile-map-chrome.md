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

- Glass surfaces use `#004040`, `rgba(0, 64, 64, 0.30)` when backdrop blur is
  supported, a 15px blur, a subtle matching border, and the existing 4px small
  radius.
- Rectangular map controls share a 52px visual size, 8px edge inset, 8px gap,
  and 4px radius. Compact-height phones reduce the visual size to 44px and the
  gap to 6px. The touch target never falls below 44px.
- Safe-area insets participate in every top, right, left, and bottom seat.

## Panel rail

Brief, Place, Layers, and Alerts form one vertical rail along the right edge,
aligned with the Share, Reset, and hazard controls. Open panels sit to its left.
Each button remains at least 44px square and exposes `aria-controls` and
`aria-expanded`. Pressing a closed door raises its sheet. Pressing the active
door again, or pressing Escape, closes it. Escape restores focus to the active
door.

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
- The scale rulers and the dock (notices and the OpenStreetMap credit) ride
  the sheet's top edge at peek and half. Camera fits made for a briefing keep
  the half band clear; the map's own padding stays zero.
- In a short landscape window inside the phone shell (at most 480px tall) the
  same element is a drawer from the left edge: one open seat at full height,
  closed by its close control, Escape, its door, or a drag to the left.

Panel state is presentation only and is never written to the URL.

Embed mode has no rail. Exiting an embed restores the closed mobile shell.
Phone views do not load or present the 3D Fire controls.

## Right control spine

The upper utility zone is Share followed by Reset. The lower quick-view zone
is ENSO, Fire, Drought, Heat, and Satellite. The first four controls use mobile
view presets; Satellite remains the one `BasemapSwitcherControl` backed by the
basemap store. Icon-only presentation never replaces accessible names,
`aria-pressed`, or focus treatment.

The lower zone remains reachable while a panel is open when the available width
can preserve a readable panel. Very narrow phones yield those controls until
the panel closes.

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

The circular information control opens a non-modal glass region across the map
stage. It blocks pointer interaction with the map canvas, while the persistent
right controls and the information toggle stay above it. Its content is
derived from the active key, canonical layer definitions, registry statuses,
basemap state, and the governed Tribal geography provenance note. Open state is
presentation-only and is never written to the URL.

## Motion

Ordinary interface transitions honor reduced motion. Current NIFC Wildfire and
Wildfire Complex perimeter layers share one restrained MapLibre paint pulse.
Prescribed and unclassified perimeters remain static. Reduced motion uses the
canonical static wildfire color.
