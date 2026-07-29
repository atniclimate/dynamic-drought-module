"""Capture the LEGACY parity baseline for the T-M0-1 extraction.

Runs the ORIGINAL monolithic build_landscape_signature.py, loaded from git
history at a RECORDED commit (never from the working tree, which now holds
the delegating shim), against the tiny synthetic fixtures, and records its
exact outputs under fixtures/legacy/ with LF newlines plus a MANIFEST.json
carrying the provenance: the source commit, the toolchain, and sha256
hashes of every synthetic input and captured output.

The captured files are IMMUTABLE once committed (WORKPLAN T-M0-1): the
extracted package must reproduce them (tests/test_parity.py compares bytes;
the one documented exception is the corrected slope-method provenance
string), and every intentional behavior change after this point (T-M0-2
defect fixes) must show up as a visible diff against them. The manifest
hashes are asserted by the test suite, so silent edits to the baseline fail
tests.

Run ONCE (it refuses to overwrite a non-empty legacy/):
  .venv/Scripts/python.exe scripts/landscape/tests/fixtures/capture_legacy.py <commit-ish>
where <commit-ish> names a commit whose scripts/build_landscape_signature.py
is still the legacy monolith.
"""
from __future__ import annotations

import hashlib
import importlib.metadata
import json
import platform
import subprocess
import sys
import types
from pathlib import Path

import geopandas as gpd

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
LEGACY_DIR = HERE / "legacy"
SYNTH = HERE / "synthetic"

FIXED_DATE = "2026-01-01"
PINNED_PACKAGES = (
    "rasterio", "exactextract", "geopandas", "pyproj", "numpy", "requests",
    "shapely", "pandas", "pyogrio",
)


def load_legacy_module(commit: str) -> tuple[types.ModuleType, str]:
    """Exec the monolith exactly as recorded at the given commit."""
    sha = subprocess.check_output(
        ["git", "-C", str(REPO), "rev-parse", commit], text=True
    ).strip()
    source = subprocess.check_output(
        ["git", "-C", str(REPO), "show", f"{sha}:scripts/build_landscape_signature.py"],
        text=True,
    )
    if "def aggregate_terrain" not in source:
        raise SystemExit(
            f"{sha}:scripts/build_landscape_signature.py is not the legacy "
            "monolith (no aggregate_terrain); pass a pre-extraction commit."
        )
    mod = types.ModuleType("legacy_build_landscape_signature")
    mod.__file__ = str(REPO / "scripts" / "build_landscape_signature.py")
    exec(compile(source, mod.__file__, "exec"), mod.__dict__)
    return mod, sha


def write_lf(path: Path, text: str) -> None:
    path.write_bytes(text.encode("utf-8"))


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    if LEGACY_DIR.exists() and any(LEGACY_DIR.iterdir()):
        print("fixtures/legacy/ already exists and is non-empty; refusing to "
              "overwrite (the baseline is immutable).", file=sys.stderr)
        return 1

    mod, sha = load_legacy_module(sys.argv[1])
    gdf = gpd.read_file(SYNTH / "ecoregions_l3.gpkg", layer="ecoregions")

    # Point the legacy code at the fixtures instead of the network.
    mod.DEM_VRT = str(SYNTH / "dem.tif")
    mod.load_ecoregions = lambda level: gdf
    mod._today = lambda: FIXED_DATE
    out_path = HERE / "_capture_snapshot.json"
    mod.DATA_DIR = HERE
    mod.OUT_PATH = out_path

    LEGACY_DIR.mkdir(parents=True, exist_ok=True)

    # 1) The terrain aggregation alone (the core zonal path).
    terrain = mod.aggregate_terrain(gdf, "US_L3CODE")
    write_lf(LEGACY_DIR / "terrain_l3.json",
             json.dumps(terrain, indent=2) + "\n")
    print(f"wrote {LEGACY_DIR / 'terrain_l3.json'}")

    # 2) The full snapshot writer path (terrain only, Level III, fixed date).
    argv = sys.argv
    sys.argv = ["build_landscape_signature.py", "--only", "terrain", "--level", "3"]
    try:
        rc = mod.main()
    finally:
        sys.argv = argv
    if rc != 0:
        print(f"legacy main() exited {rc}", file=sys.stderr)
        return rc
    # The legacy writer used platform text mode; normalize the stored
    # baseline to LF bytes (the byte policy the parity tests enforce).
    snapshot_text = out_path.read_text(encoding="utf-8")
    write_lf(LEGACY_DIR / "snapshot_terrain_l3.json", snapshot_text)
    out_path.unlink()
    print(f"wrote {LEGACY_DIR / 'snapshot_terrain_l3.json'}")

    manifest = {
        "capturedFromCommit": sha,
        "capturedFile": "scripts/build_landscape_signature.py",
        "fixedRetrievedDate": FIXED_DATE,
        "python": sys.version,
        "platform": platform.platform(),
        "packages": {
            name: importlib.metadata.version(name) for name in PINNED_PACKAGES
        },
        "sha256": {
            "synthetic/dem.tif": sha256_of(SYNTH / "dem.tif"),
            "synthetic/ecoregions_l3.gpkg": sha256_of(SYNTH / "ecoregions_l3.gpkg"),
            "legacy/terrain_l3.json": sha256_of(LEGACY_DIR / "terrain_l3.json"),
            "legacy/snapshot_terrain_l3.json": sha256_of(
                LEGACY_DIR / "snapshot_terrain_l3.json"
            ),
        },
    }
    write_lf(LEGACY_DIR / "MANIFEST.json", json.dumps(manifest, indent=2) + "\n")
    print(f"wrote {LEGACY_DIR / 'MANIFEST.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
