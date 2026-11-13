"""Sample one building height per FEMA footprint from the GBA.Height raster.

Step two of the 3D Fire buildings pipeline: scripts/extract-fema-structures.py
writes the footprints, this script gives each one a height, and
scripts/build-structures-tiles.mjs bakes both into the archive.

Source: GBA.Height, the height raster of GlobalBuildingAtlas (Zhu, Chen, Zhang,
Shi and Wang, Technical University of Munich; Earth System Science Data 17,
6647-6668, 2025, https://doi.org/10.5194/essd-17-6647-2025), published at
https://doi.org/10.14459/2025mp1782307 under CC BY-NC 4.0. The heights are
modeled from 2019 PlanetScope satellite imagery; they are not surveyed.

Only the raster is read. No footprint product of the issuer enters the chain,
not even as a join key: the outlines are the FEMA USA Structures extract alone.

How it is served: the record's data server holds one zip per 5 by 5 degree
tile (about 80 GB each for Oregon), and each zip holds one deflated GeoTIFF per
0.2 by 0.2 degree cell. `fetch` reads a zip's directory and then only the
cells a box needs, by HTTP range, through the record's public web share: no
account and no login. The share's name is not written here: `fetch` takes it
from DDM_GBA_HEIGHT_SHARE, and the record's page prints it as the data
server's name for the entire dataset. Every cell file is pinned by SHA-256.

Method, mirroring the issuer's own LoD1 step (make_lod1/main.py in
https://github.com/zhu-xlab/GlobalBuildingAtlas; its README: "The maximum
height value from the height map within the footprint is extracted and
assigned"): each cell raster (float32 metres, 3 m pixels, in its UTM zone) is
warped to EPSG:3857 with nearest-neighbour resampling, and a footprint's height
is the MAXIMUM of the raster cells its outline touches (rasterio's
all_touched). A cell file speaks only for the footprints whose outline
intersects its own 0.2 degree box, which is the issuer's rule too: each raster
overhangs its box by about 0.013 degrees a side, and the overhang's values
disagree with the cell that owns the ground. Where an outline crosses a cell
line the larger of the two maximums is kept. The raster is a height for every pixel of the cell, trees and ground
included, so the maximum can read a tree that overhangs a roof. A maximum that
is missing, zero or negative (the raster's nodata is -1; the issuer writes
-999 where a cell has no raster) is "no estimate".

What is written: one drawn height per footprint, in the extract's own order, as
whole metres. An estimate under 3 m is drawn 3 m; no estimate is written as
null and the app draws its stated placeholder height.

Usage (the repository .venv has rasterio and pyogrio; -I keeps the working
folder off the import path). Inputs live outside the repository, under
DDM_GBA_HEIGHT_CACHE (default I:/ddm-data-cache/gba-height):
  .venv/Scripts/python.exe -I scripts/sample-gba-heights.py fetch --box pilot   (16.7 GB, about 50 minutes)
  .venv/Scripts/python.exe -I scripts/sample-gba-heights.py sample
  .venv/Scripts/python.exe -I scripts/sample-gba-heights.py selftest
Checking the method against a lidar yardstick (prints numbers, writes nothing;
the yardstick is never an input to anything shipped):
  ... sample-gba-heights.py fetch --box salem
  ... sample-gba-heights.py validate --yardstick <path>/OR_Structures.gdb
"""

import argparse
import hashlib
import http.cookiejar
import io
import json
import math
import os
import re
import threading
import time
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import rasterio
import shapely
from pyogrio.raw import read
from rasterio import features
from rasterio.transform import from_origin
from rasterio.warp import Resampling, calculate_default_transform, reproject, transform_geom
from rasterio.warp import transform as warp_points

RECORD = "https://doi.org/10.14459/2025mp1782307"
SHARE_PAGE = "https://dataserv.ub.tum.de/index.php/s/{share}"
SHARE_FILES = "https://dataserv.ub.tum.de/public.php/dav/files/{share}/Height/northamerica/"
CACHE = os.environ.get("DDM_GBA_HEIGHT_CACHE", "I:/ddm-data-cache/gba-height")
HERE = os.path.dirname(os.path.abspath(__file__))
EXTRACT = os.path.join(HERE, ".cache", "fema-structures-central-oregon.ndjson")
OUT = os.path.join(HERE, ".cache", "gba-heights-central-oregon.json")

# pilot: the central_oregon region framing, the box the extract and the bake hold.
# salem: 0.2 degrees around Salem, Oregon, where FEMA's 2026 file carries lidar heights.
BOXES = {"pilot": (-122.0, 43.5, -120.3, 45.65), "salem": (-123.13, 44.84, -122.93, 45.04)}
MIN_DRAWN_M = 3
MAX_DRAWN_M = 200
STATISTIC = "maximum of the raster cells the outline touches"
CELL_NAME = re.compile(r"^(-?\d+\.\d)_(-?\d+\.\d)_(-?\d+\.\d)_(-?\d+\.\d)_sr_ss\.tif$")


def sha256_of(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def zip_names(box):
    """The 5 degree zips a box touches. shortcut: west of Greenwich and north of the
    equator only, as the issuer's northamerica folder is; widen with the first box elsewhere."""
    west, south, east, north = box
    assert east < 0 < south, "only the north-west quadrant is handled"
    names = []
    for lon in range(math.floor(west / 5) * 5, math.ceil(east / 5) * 5, 5):
        for lat in range(math.floor(south / 5) * 5, math.ceil(north / 5) * 5, 5):
            names.append(f"w{-lon:03d}_n{lat + 5:02d}_w{-(lon + 5):03d}_n{lat:02d}.zip")
    return names


class RangeFile(io.RawIOBase):
    """A remote file read by HTTP range, so zipfile can open a zip without downloading it."""

    def __init__(self, opener, url):
        self.opener, self.url, self.pos = opener, url, 0
        with self._open(urllib.request.Request(url, method="HEAD")) as response:
            self.size = int(response.headers["Content-Length"])
            self.modified = response.headers.get("Last-Modified")

    def _open(self, request):
        request.add_header("X-Requested-With", "XMLHttpRequest")
        return self.opener.open(request, timeout=120)

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, offset, whence=0):
        self.pos = offset + (0, self.pos, self.size)[whence]
        return self.pos

    def readinto(self, buffer):
        if self.pos >= self.size:
            return 0
        last = min(self.pos + len(buffer), self.size) - 1
        request = urllib.request.Request(self.url, headers={"Range": f"bytes={self.pos}-{last}"})
        for attempt in range(5):
            try:
                with self._open(request) as response:
                    assert response.status == 206, f"the server ignored the range ({response.status})"
                    data = response.read()
                assert len(data) == last - self.pos + 1, "short range read"
                break
            except (OSError, AssertionError):
                if attempt == 4:
                    raise
                time.sleep(5 * (attempt + 1))
        buffer[: len(data)] = data
        self.pos += len(data)
        return len(data)


def open_share():
    """The share's page hands any visitor an anonymous session; the file endpoint wants it."""
    share = os.environ.get("DDM_GBA_HEIGHT_SHARE")
    assert share, f"set DDM_GBA_HEIGHT_SHARE to the entire dataset's share name printed at {RECORD}"
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    opener.open(SHARE_PAGE.format(share=share), timeout=120).close()
    return opener, SHARE_FILES.format(share=share)


def open_zip(share, name):
    opener, files = share
    remote = RangeFile(opener, files + name)
    return remote, zipfile.ZipFile(io.BufferedReader(remote, buffer_size=8 << 20))


def cells_in(archive, box):
    west, south, east, north = box
    for info in archive.infolist():
        match = CELL_NAME.match(os.path.basename(info.filename))
        if match:
            xmin, ymax, xmax, ymin = map(float, match.groups())
            if xmin < east and xmax > west and ymin < north and ymax > south:
                yield info


def fetch(box_name, dry_run):
    share = open_share()
    index, jobs = [], []
    for name in zip_names(BOXES[box_name]):
        remote, archive = open_zip(share, name)
        for info in cells_in(archive, BOXES[box_name]):
            record = {
                "zip": name,
                "zipBytes": remote.size,
                "zipModified": remote.modified,
                "cell": os.path.basename(info.filename),
                "offset": info.header_offset,
                "compressedBytes": info.compress_size,
                "bytes": info.file_size,
                "crc32": f"{info.CRC:08x}",
            }
            index.append(record)
            jobs.append((name, info.filename, record))
    total = sum(record["compressedBytes"] for record in index)
    print(f"{box_name}: {len(index)} cell files, {total:,} bytes to transfer")
    if dry_run:
        return

    local = threading.local()

    def one(job):
        name, member, record = job
        folder = os.path.join(CACHE, "tiles", name[:-4])
        os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, record["cell"])
        if not (os.path.exists(path) and os.path.getsize(path) == record["bytes"]):
            if not hasattr(local, "zips"):
                local.zips = {}
            if name not in local.zips:
                local.zips[name] = open_zip(share, name)[1]
            started = time.time()
            # zipfile checks the CRC-32 at the end of the member and raises on a mismatch.
            with local.zips[name].open(member) as source, open(path + ".part", "wb") as target:
                for block in iter(lambda: source.read(4 << 20), b""):
                    target.write(block)
            os.replace(path + ".part", path)
            rate = record["compressedBytes"] / max(time.time() - started, 0.001) / 1e6
            print(f"  {name[:-4]}/{record['cell']}: {record['compressedBytes']:,} bytes at {rate:.1f} MB/s", flush=True)
        record["sha256"] = sha256_of(path)

    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(one, jobs))
    with open(os.path.join(CACHE, f"index-{box_name}.json"), "w", encoding="utf-8") as handle:
        json.dump(index, handle, indent=1)
        handle.write("\n")
    print(f"wrote {len(index)} pinned cell files under {CACHE}")


def to_mercator(dataset):
    """The issuer's own warp before it masks: EPSG:3857, default grid, nearest neighbour."""
    transform, width, height = calculate_default_transform(
        dataset.crs, "EPSG:3857", dataset.width, dataset.height, *dataset.bounds
    )
    grid = np.zeros((height, width), dtype=dataset.dtypes[0])
    reproject(
        rasterio.band(dataset, 1),
        grid,
        src_transform=dataset.transform,
        src_crs=dataset.crs,
        dst_transform=transform,
        dst_crs="EPSG:3857",
        resampling=Resampling.nearest,
    )
    return grid, transform


def owned_by(cell, shapes):
    """Which outlines (shapely, EPSG:3857) a cell file may speak for: those that intersect the
    cell's own 0.2 degree box. The issuer's rule (make_lod1/main.py boxes the cell's corners in
    EPSG:3857 and keeps `roi_geom.intersects(feat_geom)`); the raster itself reaches further."""
    xmin, ymax, xmax, ymin = map(float, CELL_NAME.match(cell).groups())
    xs, ys = warp_points("EPSG:4326", "EPSG:3857", [xmin, xmax], [ymin, ymax])
    return shapely.intersects(shapes, shapely.box(xs[0], ys[0], xs[1], ys[1]))


def sample_grid(grid, transform, geometries, bounds, best, eligible):
    """Raise best[i] to the maximum grid value under geometry i (EPSG:3857), all cells touched,
    for the geometries this grid may speak for (eligible, from owned_by)."""
    rows, cols = grid.shape
    cell = transform.a
    assert transform.e == -cell and transform.b == 0 and transform.d == 0, "the grid is not north-up and square"
    left, top = transform.c, transform.f
    hits = np.flatnonzero(
        eligible
        & (bounds[:, 2] > left)
        & (bounds[:, 0] < left + cols * cell)
        & (bounds[:, 3] > top - rows * cell)
        & (bounds[:, 1] < top)
    )
    for i in hits:
        xmin, ymin, xmax, ymax = bounds[i]
        c0 = max(int((xmin - left) // cell), 0)
        c1 = min(int((xmax - left) // cell) + 1, cols)
        r0 = max(int((top - ymax) // cell), 0)
        r1 = min(int((top - ymin) // cell) + 1, rows)
        if c0 >= c1 or r0 >= r1:
            continue
        window = grid[r0:r1, c0:c1]
        touched = features.geometry_mask(
            [geometries[i]],
            out_shape=window.shape,
            transform=from_origin(left + c0 * cell, top - r0 * cell, cell, cell),
            all_touched=True,
            invert=True,
        )
        if touched.any():
            best[i] = max(best[i], float(window[touched].max()))
    return len(hits)


def geometry_bounds(geometry):
    rings = geometry["coordinates"] if geometry["type"] == "Polygon" else [r for p in geometry["coordinates"] for r in p]
    points = np.array([point[:2] for ring in rings for point in ring])
    return (*points.min(axis=0), *points.max(axis=0))


def sample(geometries, box_name):
    """One estimate in metres per EPSG:4326 geometry (NaN where none), and the cell files read."""
    with open(os.path.join(CACHE, f"index-{box_name}.json"), encoding="utf-8") as handle:
        index = json.load(handle)
    mercator = transform_geom("EPSG:4326", "EPSG:3857", geometries)
    bounds = np.array([geometry_bounds(geometry) for geometry in mercator])
    shapes = shapely.from_geojson([json.dumps(geometry) for geometry in mercator])
    best = np.full(len(mercator), -np.inf)
    raster = None
    for record in index:
        path = os.path.join(CACHE, "tiles", record["zip"][:-4], record["cell"])
        assert sha256_of(path) == record["sha256"], f"{path} is not the file that was fetched"
        with rasterio.open(path) as dataset:
            described = {
                "driver": dataset.driver,
                "dtype": dataset.dtypes[0],
                "bands": dataset.count,
                "crs": dataset.crs.to_string(),
                "pixel": [round(abs(v), 6) for v in dataset.res],
                "nodata": dataset.nodata,
                "tiled": bool(dataset.profile.get("tiled")),
                "rowsPerStrip": dataset.block_shapes[0][0],
                "compression": dataset.compression.value if dataset.compression else None,
            }
            assert raster in (None, described), f"{path} is laid out differently: {described}"
            raster = described
            grid, transform = to_mercator(dataset)
        sample_grid(grid, transform, mercator, bounds, best, owned_by(record["cell"], shapes))
    estimate = np.where(np.isfinite(best) & (best > 0), best, np.nan)
    return estimate, index, raster


def drawn_heights(estimate):
    """Whole metres, at least MIN_DRAWN_M; None where there is no estimate."""
    drawn = np.maximum(np.floor(estimate + 0.5), MIN_DRAWN_M)
    return [None if math.isnan(value) else int(value) for value in drawn]


def summary(estimate):
    have = estimate[np.isfinite(estimate)]
    p5, p50, p95 = (round(float(v), 2) for v in np.percentile(have, [5, 50, 95]))
    return {
        "footprints": int(len(estimate)),
        "withEstimate": int(len(have)),
        "withoutEstimate": int(len(estimate) - len(have)),
        "p5": p5,
        "p50": p50,
        "p95": p95,
        "max": round(float(have.max()), 2),
        "under3m": int((have < MIN_DRAWN_M).sum()),
    }


def run_sample():
    with open(EXTRACT + ".meta.json", encoding="utf-8") as handle:
        meta = json.load(handle)
    assert tuple(meta["bbox"]) == BOXES["pilot"], "the extract is not the pilot box"
    assert sha256_of(EXTRACT) == meta["extractSha256"], "the extract does not match its sidecar; run the extract again"
    with open(EXTRACT, encoding="utf-8") as handle:
        geometries = [json.loads(line.lstrip("\x1e"))["geometry"] for line in handle if line.strip()]
    assert len(geometries) == meta["features"]
    estimate, index, raster = sample(geometries, "pilot")
    counts = summary(estimate)
    heights = drawn_heights(estimate)
    assert all(h is None or MIN_DRAWN_M <= h <= MAX_DRAWN_M for h in heights), "a drawn height is outside 3..200 m"
    result = {
        "source": "GBA.Height (GlobalBuildingAtlas)",
        "record": RECORD,
        "statistic": STATISTIC,
        "raster": raster,
        "extractSha256": meta["extractSha256"],
        "counts": counts,
        "cells": index,
        "heights": heights,
    }
    with open(OUT, "w", encoding="utf-8") as handle:
        json.dump(result, handle, separators=(",", ":"))
        handle.write("\n")
    print(json.dumps({"raster": raster, "counts": counts}, indent=1))
    print(f"wrote {OUT} (SHA-256 {sha256_of(OUT)})")


def run_validate(yardstick):
    """Compare the same sampling with lidar heights; the yardstick feeds nothing that ships."""
    meta, _fids, wkb, fields = read(yardstick, bbox=BOXES["salem"], columns=["HEIGHT"])
    assert "4326" in str(meta["crs"]), f"unexpected crs {meta['crs']}"
    lidar = np.asarray(fields[0], dtype="float64")
    keep = np.isfinite(lidar) & (lidar > 0)
    geometries = [json.loads(text) for text in shapely.to_geojson(shapely.from_wkb(wkb[keep]))]
    lidar = lidar[keep]
    estimate, index, _raster = sample(geometries, "salem")
    matched = np.isfinite(estimate)

    def row(label, values, truth):
        error = values - truth
        print(
            f"  {label}: matched {len(truth):,}, median {np.median(values):.2f} m, "
            f"RMSE {math.sqrt(float((error ** 2).mean())):.2f} m, within 2 m {100 * float((np.abs(error) <= 2).mean()):.1f}%"
        )

    print(f"salem: {len(lidar):,} footprints with a lidar height (median {np.median(lidar):.2f} m), {len(index)} cell files")
    row("sampled, as estimated", estimate[matched], lidar[matched])
    row("sampled, as drawn (whole metres, 3 m floor)", np.array(drawn_heights(estimate[matched]), dtype="float64"), lidar[matched])
    row("flat 4 m, same footprints", np.full(int(matched.sum()), 4.0), lidar[matched])
    row("flat 4 m, every footprint", np.full(len(lidar), 4.0), lidar)
    print(f"  correlation with lidar: {float(np.corrcoef(estimate[matched], lidar[matched])[0, 1]):.2f}")


def selftest():
    """The sampling rule on a grid small enough to check by eye."""
    grid = np.array([[1, 2, 0], [0, 9, 0], [0, 0, 7]], dtype="float32")
    transform = from_origin(0, 30, 10, 10)
    square = lambda x0, y0, x1, y1: {"type": "Polygon", "coordinates": [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]}
    shapes = [square(1, 21, 4, 24), square(1, 21, 14, 24), square(21, 11, 24, 24), square(41, 1, 44, 4), square(-5, -5, 35, 35)]
    bounds = np.array([geometry_bounds(s) for s in shapes])
    best = np.full(len(shapes), -np.inf)
    sample_grid(grid, transform, shapes, bounds, best, np.ones(len(shapes), dtype=bool))
    # inside one cell; touching two cells; fill only; off the grid; over everything
    assert best.tolist() == [1, 2, 0, -np.inf, 9], best
    # A grid speaks only for the outlines it owns, however far its pixels reach.
    owned = np.full(len(shapes), -np.inf)
    sample_grid(grid, transform, shapes, bounds, owned, np.array([False, True, True, True, False]))
    assert owned.tolist() == [-np.inf, 2, 0, -np.inf, -np.inf], owned
    # Three outlines near latitude 43.8: south of the line, in the southern raster's overhang
    # north of it, and across it. Each cell owns what intersects its own box and no more.
    lonlat = [square(-121.5, 43.79, -121.4999, 43.7901), square(-121.5, 43.805, -121.4999, 43.8051), square(-121.5, 43.7999, -121.4999, 43.8001)]
    outlines = shapely.from_geojson([json.dumps(g) for g in transform_geom("EPSG:4326", "EPSG:3857", lonlat)])
    assert owned_by("-121.6_43.8_-121.4_43.6_sr_ss.tif", outlines).tolist() == [True, False, True]
    assert owned_by("-121.6_44.0_-121.4_43.8_sr_ss.tif", outlines).tolist() == [False, True, True]
    estimate = np.where(np.isfinite(best) & (best > 0), best, np.nan)
    assert drawn_heights(np.array([0.2, 2.5, 3.49, 3.5, 17.98, np.nan])) == [3, 3, 3, 4, 18, None]
    assert drawn_heights(estimate) == [3, 3, None, None, 9]
    assert zip_names(BOXES["pilot"]) == ["w125_n45_w120_n40.zip", "w125_n50_w120_n45.zip"]
    print("selftest passed")


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("command", choices=["fetch", "sample", "validate", "selftest"])
    parser.add_argument("--box", choices=sorted(BOXES), default="pilot")
    parser.add_argument("--dry-run", action="store_true", help="fetch: list the cell files and their size only")
    parser.add_argument("--yardstick", help="validate: a FEMA geodatabase with lidar heights")
    args = parser.parse_args()
    if args.command == "fetch":
        fetch(args.box, args.dry_run)
    elif args.command == "sample":
        run_sample()
    elif args.command == "validate":
        run_validate(args.yardstick)
    else:
        selftest()


if __name__ == "__main__":
    main()
