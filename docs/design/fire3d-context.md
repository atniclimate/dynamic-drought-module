# The 3D Fire context view: honesty framing

Durable design doctrine for the desktop 3D Fire mode and the context
layers draped into it (fuels, and any later structure or infrastructure
context). This note records naming and disclosure decisions and their
evidence; the runtime and its tests remain the functional truth.

## Show context; never model behavior

The 3D view exists so a person can see mapped fire representations in
their landscape: relief, fuels, and (in later slices) structures and
infrastructure, each retaining its own issuer, vintage, and legend. The
line it must never cross: no DDM-computed spread ellipse, rate of spread,
flame length, ignition probability, structures-at-risk count,
time-to-impact estimate, or any layer whose value or legend blends more
than one issuer's source. One issuer, one number, one legend, per layer.
The moment a layer blends fuel plus wind plus terrain plus structures
into anything, it has become a fire-behavior-modeling system, which is
out of scope by owner invariant and would require a defensible method,
calibration, and backtest this project has never adopted.

General wildland-fire science may be cited as prose, sourced to an
authority and distinct from any claim about a specific incident. The
citable source is the National Wildfire Coordinating Group's
*Introduction to Wildland Fire Behavior* (S-190): fires tend to spread
faster uphill because convective and radiant heat preheats the fuels
upslope, making them more receptive to ignition. State the principle,
cited; compute and render nothing from it.

## Never "digital twin"

In the wildfire-visualization field, "digital twin" is a term of art for
systems that bundle physics-based fire simulation with 3D rendering
(NASA's Wildfire Digital Twin program, the FIRETWIN project). Using the
phrase for a simulation-free context viewer would overclaim exactly what
this feature must disclaim. Every surface calls this a 3D context view or
3D exploration; never "digital twin", "simulation", or "forecast". The
surface-vocabulary gate (`scripts/check-surface-vocabulary.mjs`) enforces
the banned phrases in rendered copy, with the same pragma-and-reason
allowance as the existing banned words for verbatim upstream product
names.

## The disclosure lives in the interface

Interview research after two real wildfires (Edgeley et al., "Five social
and ethical considerations for using wildfire visualizations as a
communication tool," *Fire Ecology* 20:45, 2024,
DOI 10.1186/s42408-024-00278-8) found viewers consistently over-trust
fire visualizations even when a physics model produced them, and warned
that a self-service web page is where that correction "cannot occur or
can be overlooked" if it lives only in documentation. Consequently the 3D
Fire control renders an always-visible non-prediction disclosure
(`FIRE3D_NON_PREDICTION_NOTE`) beside the always-visible coverage note,
never a dismissible tooltip and never documentation-only.

Embeds are the sharpest case: they hide the sidebar chrome (the control's
notes and the legend panel) while a URL-named `fire3d=true` still drives
the scene, and embedding is exactly the third-party distribution context
where the correction is most likely to be absent. While the mode is
active in an embed, the orchestrator therefore prints the disclosure, the
coverage note, and each active context layer's vintage line directly on
the map surface (`#fire3d-embed-note`, non-interactive, never
dismissible).

## Context-layer contract

Context layers are presentation companions owned by the fire3d context
orchestrator (`src/map/fire3d-context.ts`), riding the one `fire3d`
activation on desktop: no catalog rows, no per-layer toggles, no eager
code. Each layer is non-fatal by contract (a missing archive degrades
that layer alone), carries its issuer's own palette and an explicit
vintage-and-caveat legend, and appears in the production-observable
`data-ddm-fire3d-context` stamp only when actually in the scene.

The power context specifically: transmission lines come from the ARCHIVED
federal HIFLD dataset (the HIFLD Open program was discontinued
2025-08-26; the surviving public Esri Federal User Community copy states
plainly that it is archived, unmaintained, and last updated 2024-09-30),
so DDM bakes a one-time extract rather than adding an orphaned archive to
the live-fetch registry, and the qualification carries the currency
caveat wherever the lines render. Line width follows the issuer's own
voltage classes with the unknown sentinel drawn thinnest, and one color
for every line so the layer never reads as a severity ramp. Plants come
live from the independently maintained EIA layer, labeled with the
issuer's reporting period. Substations and distribution-voltage circuits
are deliberately absent: both EIA and the former HIFLD program withhold
substation locations for security reasons, no unified public national
distribution source exists, and the qualification says so instead of
letting the absence imply their nonexistence. A California-only CPUC High
Fire Threat District layer was evaluated and declined: its license is a
use-scoped regulatory disclaimer (Decision D.17-12-024), not an
affirmative open-data grant, and an uncaptioned state-specific layer
would falsely imply lower risk where the true difference is that no
equivalent dataset exists elsewhere.

The fuels drape specifically: LANDFIRE LF2024 FBFM40, chosen over EVT
(thousands of classes with no readable legend) and over LF2025 (a phased
mosaic that renders silent all-black pixels in unreleased GeoAreas until
December 2026). LANDFIRE's canopy bulk density and canopy base height
layers are deliberately unused anywhere: LANDFIRE documents them as
inputs to fire-behavior-prediction systems, and DDM computes nothing
from fuels data. The bake refuses all-opaque-black tiles (the
unpopulated-mosaic signature) and proves the issuer palette with a
canary tile before writing the archive.
