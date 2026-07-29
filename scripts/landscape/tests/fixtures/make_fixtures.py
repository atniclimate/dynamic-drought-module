"""Generate the tiny synthetic fixtures for the landscape package tests.

The CONTENT is deterministic by construction (a fixed analytic surface, no
randomness). The committed files are still the frozen reference, not the
generator: the GeoPackage embeds a live creation timestamp, so a re-run
reproduces identical values and geometry but not identical bytes. The
authoritative fixture identity is the sha256 set recorded in
legacy/MANIFEST.json by capture_legacy.py.

Outputs (committed to the repository; small on purpose):
  synthetic/dem.tif             80x80 float32 elevation grid, 30 m, EPSG:5070,
                                nodata -9999 in a rectangular notch
  synthetic/ecoregions_l3.gpkg  five small Level III-shaped polygons exercising
                                partial pixels, a nodata overlap, an interior
                                ring, an empty geometry, and a duplicate code
                                (the legacy last-write-wins behavior is pinned
                                on purpose; fixing it must be a visible diff)

Run: .venv/Scripts/python.exe scripts/landscape/tests/fixtures/make_fixtures.py
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import geopandas as gpd
import rasterio
from rasterio.transform import from_origin
from shapely.geometry import Polygon, box

HERE = Path(__file__).resolve().parent
SYNTH = HERE / "synthetic"

CRS = "EPSG:5070"
RES = 30.0
SIZE = 80                      # 80 x 80 cells = 2400 m x 2400 m
# Top-left corner, plausible Pacific Northwest Albers, ALIGNED to the
# NLCD/LANDFIRE-anchored analysis grid (core.GRID_ANCHOR_X/Y = -2493045,
# 3310005; grid lines sit at 15 mod 30): the offsets from the anchor are
# exact multiples of 30 m, so the fixture sits on the grid
# materialize_raster targets and the identity-warp parity holds.
X0, Y0 = -1_900_005.0, 2_900_055.0
NODATA = -9999.0


def build_dem() -> None:
    rows, cols = np.mgrid[0:SIZE, 0:SIZE]
    # A gentle tilted plane with a trig ripple; float32 for parity with the
    # production read path.
    elev = (
        500.0
        + 0.9 * cols
        + 1.7 * rows
        + 50.0 * np.sin(cols / 7.0) * np.cos(rows / 9.0)
    ).astype("float32")
    # Nodata notch: rows 10..20, cols 50..60 (inclusive-exclusive).
    elev[10:20, 50:60] = NODATA
    profile = {
        "driver": "GTiff",
        "height": SIZE,
        "width": SIZE,
        "count": 1,
        "dtype": "float32",
        "crs": CRS,
        "transform": from_origin(X0, Y0, RES, RES),
        "nodata": NODATA,
    }
    SYNTH.mkdir(parents=True, exist_ok=True)
    with rasterio.open(SYNTH / "dem.tif", "w", **profile) as ds:
        ds.write(elev, 1)
    print(f"wrote {SYNTH / 'dem.tif'}")


def build_polygons() -> None:
    # Offsets deliberately misaligned with the 30 m grid to exercise
    # exactextract partial-pixel weights.
    feats = [
        {
            "US_L3CODE": "1",
            "US_L3NAME": "Synthetic Flats",
            "geometry": box(X0 + 307.0, Y0 - 1211.0, X0 + 907.0, Y0 - 611.0),
        },
        {
            # Duplicate code: legacy aggregation is last-write-wins per feature
            # row; pinned as-is so a future dissolve fix is a visible diff.
            "US_L3CODE": "1",
            "US_L3NAME": "Synthetic Flats North",
            "geometry": box(X0 + 1513.0, Y0 - 405.5, X0 + 1813.0, Y0 - 205.5),
        },
        {
            "US_L3CODE": "2",
            "US_L3NAME": "Nodata Notch",
            "geometry": box(X0 + 1443.3, Y0 - 750.0, X0 + 1950.0, Y0 - 250.0),
        },
        {
            "US_L3CODE": "3",
            "US_L3NAME": "Holey Ridge",
            "geometry": Polygon(
                shell=[
                    (X0 + 350.0, Y0 - 1500.0),
                    (X0 + 1350.0, Y0 - 1500.0),
                    (X0 + 1350.0, Y0 - 2100.0),
                    (X0 + 350.0, Y0 - 2100.0),
                ],
                holes=[[
                    (X0 + 650.0, Y0 - 1700.0),
                    (X0 + 1050.0, Y0 - 1700.0),
                    (X0 + 1050.0, Y0 - 1900.0),
                    (X0 + 650.0, Y0 - 1900.0),
                ]],
            ),
        },
        {
            "US_L3CODE": "4",
            "US_L3NAME": "Empty Void",
            "geometry": Polygon(),
        },
    ]
    gdf = gpd.GeoDataFrame(feats, crs=CRS)
    out = SYNTH / "ecoregions_l3.gpkg"
    gdf.to_file(out, layer="ecoregions", driver="GPKG")
    print(f"wrote {out}")


if __name__ == "__main__":
    build_dem()
    build_polygons()
