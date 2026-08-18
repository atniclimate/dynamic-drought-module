# Mobile map chrome

This note records the presentation contract for the map-first phone view. It
applies only when the mobile sheet is active at 720 CSS pixels or narrower.
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

## Right control spine

The upper utility zone is Share followed by Reset. The lower quick-view zone
is ENSO, Fire, Drought, Heat, and Satellite. The first four controls use mobile
view presets; Satellite remains the one `BasemapSwitcherControl` backed by the
basemap store. Icon-only presentation never replaces accessible names,
`aria-pressed`, or focus treatment.

The lower zone is visible only at the existing closed and peek sheet detents.
Half and full sheet behavior is unchanged.

## Information surfaces

The compact Fire key owns the upper-left column and reserves the right control
column through relational width calculations. Its two source sections stack
vertically. A disclosure is rendered only when the measured key content
actually exceeds its collapsed capacity, and expansion is bounded above the
sheet and footer.

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
