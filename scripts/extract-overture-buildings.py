# One-time extract of Overture Maps Foundation building footprints for the
# 3D Fire structures context bake (scripts/build-structures-tiles.mjs reads
# the output).
#
# Runs in the project's .venv with duckdb (scripts/requirements-structures.txt;
# the duckdb wheel has no dependencies, so the exactly-pinned landscape
# toolchain in requirements-landscape.txt is untouched).
#
# License: ODbL. The Overture buildings theme fuses OpenStreetMap (highest
# priority), Esri Community Maps, Microsoft ML Building Footprints, Google
# Open Buildings, and other open sources; the bake ships with
# "(c) Overture Maps Foundation, (c) OpenStreetMap contributors"
# attribution and the derived archive stays under ODbL-compatible terms.
#
# The release bucket enforces a 60-day retention lifecycle (verified live
# 2026-08-18: the pinned 2026-07-22.0 objects expire 2026-09-21 and are the
# only release present), so re-running this extract after that date
# requires re-pinning --release to the newest monthly id.
#
# Usage (from the repo root):
#   .venv/Scripts/python.exe scripts/extract-overture-buildings.py \
#     --out scripts/.cache/overture-buildings-central-oregon.json
#   # a deployer baking another region passes --bbox minLon,minLat,maxLon,maxLat

import argparse
import json
import sys
import time

import duckdb

DEFAULT_RELEASE = "2026-07-22.0"
# The committed default bake: the central_oregon region framing's bounds
# (src/config/regions.ts), 189,769 buildings at extract time 2026-08-19 UTC.
# A full-PNW bake was measured and rejected: 9,160,813 footprints at the
# empirical 26 bytes per building (z14 vector tiles) is roughly 240 MB,
# far past same-origin Pages hosting; the pilot region plus this
# parameterized deployer path is the honest scope.
DEFAULT_BBOX = "-122.0,43.5,-120.3,45.65"


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract Overture buildings to NDJSON")
    parser.add_argument("--release", default=DEFAULT_RELEASE)
    parser.add_argument("--bbox", default=DEFAULT_BBOX, help="minLon,minLat,maxLon,maxLat")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    x0, y0, x1, y1 = (float(v) for v in args.bbox.split(","))

    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial;")
    con.execute("SET s3_region='us-west-2';")
    src = (
        f"s3://overturemaps-us-west-2/release/{args.release}/"
        "theme=buildings/type=building/*"
    )
    started = time.time()
    con.execute(f"""
    COPY (
      SELECT id, height, num_floors, ST_AsGeoJSON(geometry) AS geom
      FROM read_parquet('{src}', hive_partitioning=1)
      WHERE bbox.xmin <= {x1} AND bbox.xmax >= {x0}
        AND bbox.ymin <= {y1} AND bbox.ymax >= {y0}
    ) TO '{args.out}' (FORMAT JSON)
    """)
    with open(args.out, "r", encoding="utf-8") as handle:
        count = sum(1 for _ in handle)
    print(json.dumps({
        "release": args.release,
        "bbox": [x0, y0, x1, y1],
        "features": count,
        "elapsedSeconds": round(time.time() - started),
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
