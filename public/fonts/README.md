# Self-hosted map glyphs

MapLibre symbol layers (map text labels) fetch glyph files in Protocol
Buffer (PBF) format, 256 codepoints per file. Serving them from this
directory keeps the module serverless and self-contained: no third-party
font host sees the deployment's traffic (0.7.0 U0a; the no-tracking
posture in CLAUDE.md section 4 rule 3).

## Contents

- `glyphs/Noto Sans Regular/0-255.pbf` and `256-511.pbf`: the Basic Latin
  and Latin Extended ranges of Noto Sans Regular, which cover every map
  label the module currently renders (the Nino 3.4 region label). New
  labels that use other scripts need their ranges added here; a missing
  range fails visibly (the label does not draw), never silently.
- `glyphs/Noto Sans Regular/512-767.pbf`: the Spacing Modifier Letters
  range carrying the okina (U+02BB), needed by the GNIS-official Hawaiian
  municipal names (D-0.7.0-030, ruled 2026-07-14; today only Līhuʻe).
  Downloaded 2026-07-14 from the same MapLibre demotiles endpoint
  (95,728 bytes, matching the stage-2 audit figure). Lazy at runtime:
  MapLibre fetches a range file only when a rendered label needs it.

## Provenance and license

The PBF files were downloaded 2026-07-10 from the MapLibre demotiles
glyph endpoint (`https://demotiles.maplibre.org/font/`), which serves
glyphs generated from the Noto Sans typeface. Noto Sans is licensed
under the SIL Open Font License 1.1, which permits redistribution and
bundling. The application points at this directory through the `glyphs`
template in `src/map/style.ts`.
