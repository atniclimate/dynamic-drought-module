# Self-hosted map glyphs

MapLibre symbol layers (map text labels) fetch glyph files in Protocol
Buffer (PBF) format, 256 codepoints per file. Serving them from this
directory keeps the module serverless and self-contained: no third-party
font host sees the deployment's traffic. This preserves the project's
no-tracking and self-hosted static architecture.

## Contents

- `glyphs/Noto Sans Regular/0-255.pbf` and `256-511.pbf`: the Basic Latin
  and Latin Extended ranges of Noto Sans Regular, which cover every map
  label the module currently renders (place labels, power cluster counts
  and the Nino 3.4 region label). New
  labels that use other scripts need their ranges added here; since
  MapLibre 6.7 a missing range is drawn in the viewer's system font with
  one console warning, so the look depends on the machine until the range
  is added.
- `ddm-nation-names.woff2` (receipt: `ddm-nation-names.json`): the face the
  Tribal Lands labels draw a Nation's own-language name with, cut from Noto
  Sans Regular by `scripts/cut-nation-names-font.py` and named in the map
  style's `font-faces` (`src/map/style.ts`). It is fetched only when such a
  name is on screen. It is a font file and not a glyph range because
  MapLibre draws a letter with its combining marks as one cluster through
  the browser, and the file's mark tables place the marks. A curated name
  with a letter the face lacks fails `tests/font-coverage.test.mjs`; re-cut
  the face with the script.
- `glyphs/Noto Sans Regular/512-767.pbf`: the Spacing Modifier Letters
  range carrying the okina (U+02BB), needed by the GNIS-official Hawaiian
  municipal names (as of 2026-07-14, only Līhuʻe).
  Downloaded 2026-07-14 from the same MapLibre demotiles endpoint
  (95,728 bytes). Lazy at runtime:
  MapLibre fetches a range file only when a rendered label needs it.
- `glyphs/Noto Sans Regular/8192-8447.pbf`: the General Punctuation range,
  carrying the right single quotation mark (U+2019) that Natural Resources
  Canada's Atlas of Canada place names use in Dene names such as Sambaa K’e,
  and the en dash (U+2013) in merged Quebec municipality names. Downloaded
  2026-11-12 from the same MapLibre demotiles endpoint (34,070 bytes, 111
  glyphs), so the base map draws these names as published.

## Provenance and license

The PBF files were downloaded 2026-07-10 from the MapLibre demotiles
glyph endpoint (`https://demotiles.maplibre.org/font/`), which serves
glyphs generated from the Noto Sans typeface. Noto Sans is licensed
under the SIL Open Font License 1.1, which permits redistribution and
bundling. The application points at this directory through the `glyphs`
template in `src/map/style.ts`. The licence notice for these glyph files
is `OFL-noto-sans.txt` in this directory (DR-165).
