"""Clip FEMA USA Structures state files to the central Oregon pilot box.

Step one of the 3D Fire buildings pipeline; scripts/sample-gba-heights.py
(a height per footprint, from the GBA.Height raster) is step two and
scripts/build-structures-tiles.mjs is step three. Each input is one state's USA Structures zip (an Esri File
Geodatabase plus its FGDC metadata), kept OUTSIDE the repository. The script
hashes every zip, reads the release date and credit from the zip's own
metadata, clips the footprints to the pilot box and writes newline-delimited
GeoJSON holding the outline and HEIGHT only (no occupancy, address, parcel or
population field leaves the file), plus a .meta.json sidecar the bake requires.

Which edition: decision DR-126 allows only the 2023 edition that Oak Ridge
National Laboratory published on Figshare under CC0:
  Oregon      https://doi.org/10.6084/m9.figshare.24428884.v1  Deliverable20230526OR.zip
  Washington  https://doi.org/10.6084/m9.figshare.24428845.v1  Deliverable20230831WA.zip
The box crosses the Columbia River, so both states are needed. The bake pins
each zip by SHA-256 in the SOURCES table of scripts/build-structures-tiles.mjs
and records what it read and wrote in scripts/data/structures-tiles-receipt.json.

Usage (the repository .venv has pyogrio; -I keeps the downloads' folder off the
import path):
  .venv/Scripts/python.exe -I scripts/extract-fema-structures.py \
      --zip <path>/Deliverable20230526OR.zip --zip <path>/Deliverable20230831WA.zip
"""

import argparse
import datetime
import hashlib
import json
import os
import re
import tempfile
import zipfile

import numpy as np
import pyogrio
from pyogrio.raw import read, write

# The central_oregon region framing (src/config/regions.ts); the bake refuses any other box.
BBOX = (-122.0, 43.5, -120.3, 45.65)
DEFAULT_OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache", "fema-structures-central-oregon.ndjson")


def sha256_of(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def tag(text, name):
    match = re.search(rf"<{name}>(.*?)</{name}>", text, re.S)
    assert match, f"the metadata carries no <{name}>"
    return match.group(1).strip()


def read_state(zip_path, workdir):
    """One state zip: its receipt fields, and the footprints inside BBOX."""
    with zipfile.ZipFile(zip_path) as archive:
        names = [n for n in archive.namelist() if not n.startswith("__MACOSX/")]
        metadata = [n for n in names if n.endswith("_metadata.xml") and ".gdb/" not in n]
        assert len(metadata) == 1, f"expected one metadata file in {zip_path}, found {metadata}"
        xml = archive.read(metadata[0]).decode("utf-8", "replace")
        gdbs = sorted({n[: n.index(".gdb/") + 4] for n in names if ".gdb/" in n})
        assert len(gdbs) == 1, f"expected one geodatabase in {zip_path}, found {gdbs}"
        archive.extractall(workdir, [n for n in names if n.startswith(gdbs[0] + "/")])
    gdb = os.path.join(workdir, gdbs[0])
    layer = pyogrio.list_layers(gdb)[0][0]
    meta, _fids, geometry, fields = read(gdb, layer=layer, bbox=BBOX, columns=["HEIGHT"])
    assert "4326" in str(meta["crs"]), f"unexpected crs {meta['crs']} in {zip_path}"
    assert "Polygon" in str(meta["geometry_type"]), f"unexpected geometry {meta['geometry_type']}"
    height = np.asarray(fields[list(meta["fields"]).index("HEIGHT")], dtype="float64")
    mtime = datetime.datetime.fromtimestamp(os.path.getmtime(zip_path), datetime.timezone.utc)
    receipt = {
        "file": os.path.basename(zip_path),
        "sha256": sha256_of(zip_path),
        "bytes": os.path.getsize(zip_path),
        "retrieved": mtime.date().isoformat(),
        "release": tag(xml, "pubdate"),
        "credit": tag(xml, "datacred"),
        "useConstraints": tag(xml, "useconst"),
        "layer": layer,
        "footprintsInState": int(pyogrio.read_info(gdb, layer=layer)["features"]),
        "footprintsInBox": int(len(geometry)),
    }
    return receipt, meta, geometry, height


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--zip", action="append", required=True, help="a state USA Structures zip; repeat per state")
    parser.add_argument("--out", default=DEFAULT_OUT)
    args = parser.parse_args()

    inputs, geometries, heights, meta = [], [], [], None
    for zip_path in args.zip:
        # ignore_cleanup_errors: Windows can hold a geodatabase handle a moment past the read.
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as workdir:
            receipt, meta, geometry, height = read_state(zip_path, workdir)
        print(json.dumps(receipt))
        inputs.append(receipt)
        geometries.append(geometry)
        heights.append(height)

    geometry = np.concatenate(geometries)
    height = np.concatenate(heights)
    count = len(geometry)
    assert count > 0, "no footprints in the pilot box"
    with_height = int((np.isfinite(height) & (height > 0)).sum())

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    write(args.out, geometry, [height], ["HEIGHT"], driver="GeoJSONSeq", geometry_type="MultiPolygon", crs=meta["crs"])
    with open(args.out, "rb") as handle:
        lines = sum(1 for _ in handle)
    assert lines == count, f"wrote {lines} lines for {count} footprints"
    sidecar = {
        "bbox": list(BBOX),
        "features": count,
        "withHeight": with_height,
        "extractSha256": sha256_of(args.out),
        "extractBytes": os.path.getsize(args.out),
        "inputs": inputs,
    }
    with open(args.out + ".meta.json", "w", encoding="utf-8") as handle:
        json.dump(sidecar, handle, indent=2)
        handle.write("\n")
    print(f"wrote {args.out}: {count} footprints, {with_height} with a published height")


if __name__ == "__main__":
    main()
