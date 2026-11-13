"""Cut public/fonts/ddm-nation-names.woff2: the face the map draws a Nation's own-language name with.

Run by hand when a curated name needs a letter the face lacks (tests/font-coverage.test.mjs says so):

    python -X utf8 -B scripts/cut-nation-names-font.py <path to NotoSans-Regular.ttf>

Needs Python with fontTools and brotli (not an npm dependency; the 2026-11-13 cut used fontTools 4.66.1,
brotli 1.2.0). The source is Noto Sans Regular (SIL Open Font License 1.1, public/fonts/OFL-noto-orthography.txt),
the file public/fonts/MANIFEST.json records under sourceRetrievals; its SHA-256 is checked below.

The face holds Basic Latin, Latin-1 and Latin Extended-A whole, the letters and marks North American Latin
orthographies add to them (LETTERS), and every character of every curated name in
public/data/tribal-own-names.json, so a new row can never outrun the face once it is re-cut. Mark positioning
(ccmp, mark, mkmk) is kept: MapLibre draws a letter with its marks as one cluster through the browser, which
places the marks from these tables. A whole-range cut of the same blocks measured 154,908 bytes; this one is
printed at the end and recorded in the manifest.
"""

import hashlib
import json
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
SOURCE_SHA256 = 'b85c38ecea8a7cfb39c24e395a4007474fa5a4fc864f6ee33309eb4948d232d5'
DEST = ROOT / 'public' / 'fonts' / 'ddm-nation-names.woff2'
NAMES = ROOT / 'public' / 'data' / 'tribal-own-names.json'
MANIFEST = ROOT / 'public' / 'fonts' / 'ddm-nation-names.json'

BLOCKS = [(0x0020, 0x007E), (0x00A0, 0x017F)]
# Beyond those blocks: Latin Extended-B and IPA letters, modifier letters, combining marks, Greek letters used as
# consonants, superscript letters, dotted and underlined letters, the typographic apostrophes and the saltillo.
LETTERS = (
    'ƚƛǧǩǫǭǰǵȟȽɁɂɑɔəɛɣɨɫɬʉʌʔʕ'
    'ʰʷʸʻʼʽˀˈˌːˑˣ'
    'θλχ'
    'ᵁᵘᶻ'
    'ḌḍḎḏḤḥḲḳḴḵḶḷḺḻṄṅṆṇṈṉṢṣṬṭṮṯẔẕẖ'
    '‐‑‒–‘’“”'
    'Ꞌꞌ'
)
MARKS = [*range(0x0300, 0x030D), 0x0313, 0x0315, 0x0323, 0x0325, 0x0327, 0x0328, 0x032D, 0x032E, 0x0331, 0x0332]

source = Path(sys.argv[1])
if hashlib.sha256(source.read_bytes()).hexdigest() != SOURCE_SHA256:
    sys.exit(f'{source} is not the Noto Sans Regular file the manifest records (SHA-256 differs)')

rows = json.loads(NAMES.read_text(encoding='utf-8'))['rows'] if NAMES.exists() else []
wanted = {cp for lo, hi in BLOCKS for cp in range(lo, hi + 1)} | {ord(c) for c in LETTERS} | set(MARKS)
wanted |= {ord(c) for row in rows for c in row['ownName']}

font = TTFont(source, recalcTimestamp=False)  # the same letters cut the same bytes
missing = sorted(wanted - set(font.getBestCmap()))
named = sorted(cp for cp in missing if any(chr(cp) in row['ownName'] for row in rows))
if named:
    sys.exit('Noto Sans Regular has no glyph for ' + ' '.join(f'U+{cp:04X}' for cp in named) + ', used by a curated name')

options = subset.Options()
options.flavor = 'woff2'
options.layout_features = ['ccmp', 'mark', 'mkmk', 'kern', 'locl']
options.name_IDs = [1, 2, 3, 4, 6]
options.notdef_outline = True
options.hinting = False
subsetter = subset.Subsetter(options)
subsetter.populate(unicodes=wanted)
subsetter.subset(font)
for record in font['name'].names:
    if record.nameID in (1, 4):
        record.string = 'DDM Nation Names'
    elif record.nameID == 6:
        record.string = 'DDMNationNames-Regular'
font.save(DEST)

covered = sorted(TTFont(DEST).getBestCmap())
MANIFEST.write_text(
    json.dumps(
        {
            'file': DEST.name,
            'family': 'DDM Nation Names',
            'source': 'NotoSans-Regular.ttf',
            'sourceSha256': SOURCE_SHA256,
            'licence': 'OFL-noto-orthography.txt',
            'bytes': DEST.stat().st_size,
            'sha256': hashlib.sha256(DEST.read_bytes()).hexdigest(),
            'layoutFeatures': options.layout_features,
            'command': 'python -X utf8 -B scripts/cut-nation-names-font.py NotoSans-Regular.ttf',
            'codepoints': [f'U+{cp:04X}' for cp in covered],
        },
        indent=1,
    )
    + '\n',
    encoding='utf-8',
)
print(f'{DEST.name}: {DEST.stat().st_size} bytes, {len(covered)} codepoints, {len(rows)} curated names read')
