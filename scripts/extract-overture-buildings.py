# One-time extract of Overture Maps Foundation building footprints for the
# 3D Fire structures context bake (scripts/build-structures-tiles.mjs reads
# the output NDJSON plus the .meta.json sidecar this script writes).
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
# Provenance contract: the sidecar (<out>.meta.json) is the ONLY source of
# the release id, retrieval date, bbox, and feature count downstream; the
# bake refuses to run without it, so a re-pinned or re-scoped extract can
# never ship a stale hand-typed vintage.
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
#   # (see public/data/README.md for the full list of constants to update)

import argparse
import datetime
import json
import os
import re
import sys
import time

import duckdb

DEFAULT_RELEASE = "2026-07-22.0"
# The committed default bake: the central_oregon region framing's bounds
# (src/config/regions.ts), 189,769 buildings at extract time 2026-08-19 UTC.
# A full-PNW bake was PROJECTED and rejected, never run: 9,160,813
# footprints at the measured 26 bytes per building for z14-only tiles is
# roughly 240 MB, and roughly 380 MB at the shipped z13-14 scheme's
# measured 42 bytes per building; either is far past same-origin Pages
# hosting, so the pilot region plus this parameterized deployer path is
# the honest scope.
DEFAULT_BBOX = "-122.0,43.5,-120.3,45.65"


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract Overture buildings to NDJSON")
    parser.add_argument("--release", default=DEFAULT_RELEASE)
    parser.add_argument("--bbox", default=DEFAULT_BBOX, help="minLon,minLat,maxLon,maxLat")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    # The release id and output path are interpolated into SQL; constrain
    # both to shapes that cannot break out of the statement.
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}\.\d+", args.release):
        print(f"refusing release id {args.release!r}; expected YYYY-MM-DD.N", file=sys.stderr)
        return 2
    if "'" in args.out:
        print("refusing an output path containing a single quote", file=sys.stderr)
        return 2

    try:
        x0, y0, x1, y1 = (float(v) for v in args.bbox.split(","))
    except ValueError:
        print(f"refusing bbox {args.bbox!r}; expected four numbers", file=sys.stderr)
        return 2
    if not (-180 <= x0 < x1 <= 180 and -90 <= y0 < y1 <= 90):
        print(
            f"refusing bbox {args.bbox!r}; expected minLon<maxLon and minLat<maxLat in WGS 84",
            file=sys.stderr,
        )
        return 2

    out_dir = os.path.dirname(os.path.abspath(args.out))
    os.makedirs(out_dir, exist_ok=True)

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
    if count == 0:
        print("extract returned 0 footprints; wrong bbox or release", file=sys.stderr)
        return 1

    summary = {
        "release": args.release,
        "bbox": [x0, y0, x1, y1],
        "features": count,
        "retrieved": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d"),
        "elapsedSeconds": round(time.time() - started),
    }
    with open(f"{args.out}.meta.json", "w", encoding="utf-8") as handle:
        json.dump(summary, handle, indent=2)
        handle.write("\n")
    print(json.dumps(summary))
    return 0


if __name__ == "__main__":
    sys.exit(main())
