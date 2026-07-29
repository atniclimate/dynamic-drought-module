"""Capture the CORRECTED parity baseline (T-M0-2 and later intentional fixes).

Runs the CURRENT scripts/landscape package against the same tiny synthetic
fixtures the legacy baseline was captured from, and records its exact
outputs under fixtures/corrected/ with LF newlines plus a MANIFEST.json
carrying the capture provenance.

Relationship to legacy/: legacy/ is IMMUTABLE (the monolith's pinned
behavior); corrected/ is the pinned CURRENT behavior and is regenerated,
via this script, whenever an intentional fix changes outputs. The parity
suite (tests/test_parity.py) then enforces two things: the live package
reproduces corrected/ byte-for-byte, and the legacy-vs-corrected diff
matches, occurrence by occurrence with exact values, the pins
hand-committed in fixtures/delta-manifest.json. Regenerating corrected/
with changed values therefore fails tests until the manifest pins are
deliberately edited to match: every behavior change stays a reviewed act.

Run: .venv/Scripts/python.exe scripts/landscape/tests/fixtures/capture_corrected.py
"""
from __future__ import annotations

import hashlib
import importlib.metadata
import json
import platform
import subprocess
import sys
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
sys.path.insert(0, str(REPO))

import geopandas as gpd  # noqa: E402

from scripts.landscape import core  # noqa: E402
from scripts.landscape.adapters import terrain  # noqa: E402
from scripts.landscape.__main__ import main as landscape_main  # noqa: E402

CORRECTED_DIR = HERE / "corrected"
SYNTH = HERE / "synthetic"

# Determinism-seam constants shared VERBATIM with the parity suite (see
# fixtures/seams.py for the rationale).
from scripts.landscape.tests.fixtures.seams import (  # noqa: E402
    FIXED_DATE,
    SENTINEL_SHA256,
)
PINNED_PACKAGES = (
    "rasterio", "exactextract", "geopandas", "pyproj", "numpy", "requests",
    "shapely", "pandas", "pyogrio",
)


def write_lf(path: Path, text: str) -> None:
    path.write_bytes(text.encode("utf-8"))


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    import tempfile

    gdf = gpd.read_file(SYNTH / "ecoregions_l3.gpkg", layer="ecoregions")
    CORRECTED_DIR.mkdir(parents=True, exist_ok=True)

    # 1) The terrain aggregation alone (the core zonal path).
    with tempfile.TemporaryDirectory() as tmp:
        result = terrain.aggregate(
            gdf, "US_L3CODE",
            dem_path=str(SYNTH / "dem.tif"), cache_dir=Path(tmp))
    write_lf(CORRECTED_DIR / "terrain_l3.json",
             json.dumps(result, indent=2) + "\n")
    print(f"wrote {CORRECTED_DIR / 'terrain_l3.json'}")

    # 2) The full snapshot writer path (terrain only, Level III, fixed date),
    # through the real command-line entry with the same injection seams the
    # parity tests use.
    with tempfile.TemporaryDirectory() as tmp:
        out_path = Path(tmp) / "snapshot.json"
        with mock.patch.object(core, "load_ecoregions", lambda level: gdf), \
             mock.patch.object(terrain, "DEM_VRT", str(SYNTH / "dem.tif")), \
             mock.patch.object(core, "CACHE_DIR", Path(tmp)), \
             mock.patch.object(core, "OUT_PATH", out_path), \
             mock.patch.object(core, "_acquisition_stamp",
                               lambda: FIXED_DATE), \
             mock.patch.object(core, "materialized_sha256",
                               lambda path: SENTINEL_SHA256):
            rc = landscape_main(["--only", "terrain", "--level", "3",
                                 "--retrieved", FIXED_DATE])
        if rc != 0:
            print(f"landscape main() exited {rc}", file=sys.stderr)
            return rc
        snapshot_text = out_path.read_text(encoding="utf-8")
    write_lf(CORRECTED_DIR / "snapshot_terrain_l3.json", snapshot_text)
    print(f"wrote {CORRECTED_DIR / 'snapshot_terrain_l3.json'}")

    head = subprocess.check_output(
        ["git", "-C", str(REPO), "rev-parse", "HEAD"], text=True).strip()
    manifest = {
        "capturedFrom": "the working tree (the current scripts/landscape package)",
        "headCommitAtCapture": head,
        "fixedRetrievedDate": FIXED_DATE,
        "python": sys.version,
        "platform": platform.platform(),
        "packages": {
            name: importlib.metadata.version(name) for name in PINNED_PACKAGES
        },
        "sha256": {
            "corrected/terrain_l3.json": sha256_of(
                CORRECTED_DIR / "terrain_l3.json"),
            "corrected/snapshot_terrain_l3.json": sha256_of(
                CORRECTED_DIR / "snapshot_terrain_l3.json"),
        },
    }
    write_lf(CORRECTED_DIR / "MANIFEST.json",
             json.dumps(manifest, indent=2) + "\n")
    print(f"wrote {CORRECTED_DIR / 'MANIFEST.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
