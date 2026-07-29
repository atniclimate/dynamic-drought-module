"""Capture the frozen Willamette fixture and full soil-family intermediates.

This script is the soil lane's only capture entry point. It is deliberately
resumable: successful downloads and Soil Data Access responses are digest
indexed, and request counts are persisted before each Hypertext Transfer
Protocol (HTTP) attempt. All requests execute through the adapter's frozen
``acquire`` surface. Tests do not invoke this file and never fetch network data.
"""
from __future__ import annotations

import gc
import hashlib
import json
import math
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

import geopandas as gpd
import numpy as np
import rasterio
from exactextract import exact_extract
from rasterio.merge import merge
from rasterio.transform import from_origin
from rasterio.warp import transform_bounds
from shapely.geometry import box


REPO_ROOT = Path(__file__).resolve().parents[5]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts.landscape import core  # noqa: E402
from scripts.landscape.adapters import soil  # noqa: E402


FIXTURE_DIR = Path(__file__).resolve().parent
CACHE_DIR = REPO_ROOT / "scripts" / ".cache" / "soil"
STAGED_DIR = CACHE_DIR / "staged"
PARTS_DIR = CACHE_DIR / "histogram-parts"
BUDGET_PATH = CACHE_DIR / "request-budget.json"
REGISTRY_PATH = CACHE_DIR / "capture-registry.json"
SUMMARY_PATH = CACHE_DIR / "capture-summary.json"

CEILINGS = {
    "soilweb-wcs": 90,
    "sda-post": 25,
    "epa-s3": 4,
    "metadata": 5,
}
TILE_SIZE_CELLS = 5000
CELL_SIZE_M = 30
SIZE_GUARD_BYTES = 25_000_000
SDA_BATCH_SIZE = 2880
CAPTURE_SCHEMA_VERSION = "1"
OVERFLOW_BINDING_NAME = "INPUT-BINDING.json"
DATA_NAMES = ("histogram-l3.json", "histogram-l4.json", "sda-rows.json")
_TRANSPORT_BOUNDS = (
    core.GRID_ANCHOR_X,
    core.GRID_ANCHOR_Y - 30.0,
    core.GRID_ANCHOR_X + 30.0,
    core.GRID_ANCHOR_Y,
)


def _load_json(path: Path, default):
    if not path.is_file():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def _budget() -> soil.RequestBudget:
    prior = _load_json(BUDGET_PATH, {})
    if prior and prior.get("ceilings") != CEILINGS:
        raise RuntimeError(
            f"persistent capture ceilings differ from revision 10: {prior.get('ceilings')}"
        )
    return soil.RequestBudget(
        CEILINGS,
        counts=prior.get("counts") if prior else None,
        state_path=BUDGET_PATH,
    )


def _registry() -> dict:
    value = _load_json(
        REGISTRY_PATH,
        {"downloads": {}, "sdaResponses": {}, "captureDates": {}},
    )
    if set(value) != {"downloads", "sdaResponses", "captureDates"}:
        raise RuntimeError("capture registry shape differs")
    return value


def _save_registry(value: dict) -> None:
    soil.write_json(REGISTRY_PATH, value)


def _cached_file(record: dict | None, destination: Path) -> bool:
    return bool(
        isinstance(record, dict)
        and destination.is_file()
        and record.get("sha256") == soil.sha256_file(destination)
    )


def _download_get(
    key: str,
    url: str,
    destination: Path,
    endpoint: str,
    budget: soil.RequestBudget,
    registry: dict,
) -> tuple[Path, str]:
    record = registry["downloads"].get(key)
    if _cached_file(record, destination) and record.get("url") == url:
        return destination, record["sha256"]
    destination.parent.mkdir(parents=True, exist_ok=True)
    last_error: Exception | None = None
    for attempt in range(2):
        try:
            request = soil.CaptureRequest(
                method="GET",
                url=url,
                endpoint_key=endpoint,
                destination=destination,
            )
            soil.acquire(
                _TRANSPORT_BOUNDS, CACHE_DIR, budget, sources=request
            )
            if request.error is not None:
                raise request.error
            if request.sha256 is None:
                raise RuntimeError("adapter capture request returned no digest")
            record = {
                "url": url,
                "path": str(destination.relative_to(CACHE_DIR)),
                "sha256": request.sha256,
            }
            if request.response_headers:
                record["responseHeaders"] = request.response_headers
            registry["downloads"][key] = record
            registry["captureDates"].setdefault(endpoint, date.today().isoformat())
            _save_registry(registry)
            return destination, request.sha256
        except soil.BudgetExceededError:
            raise
        except Exception as exc:  # noqa: BLE001 - retry is counted before send
            last_error = exc
            if attempt == 1:
                raise RuntimeError(f"download failed after two attempts for {url}: {exc}") from exc
    raise RuntimeError(str(last_error))


def _fetch_sda(
    query: str,
    index: int,
    budget: soil.RequestBudget,
    registry: dict,
) -> bytes:
    query_sha = hashlib.sha256(query.encode("utf-8")).hexdigest()
    destination = CACHE_DIR / "sda-responses" / f"batch-{index:03d}-{query_sha[:16]}.json"
    key = f"batch-{index:03d}-{query_sha}"
    record = registry["sdaResponses"].get(key)
    if _cached_file(record, destination) and record.get("querySha256") == query_sha:
        content = destination.read_bytes()
        soil._parse_sda_response(content)
        return content
    destination.parent.mkdir(parents=True, exist_ok=True)
    last_error: Exception | None = None
    for attempt in range(2):
        try:
            request = soil.CaptureRequest(
                method="POST",
                url=soil.SDA_URL,
                endpoint_key="sda-post",
                destination=destination,
                json_body={"query": query, "format": "JSON+COLUMNNAME"},
            )
            soil.acquire(
                _TRANSPORT_BOUNDS, CACHE_DIR, budget, sources=request
            )
            if request.error is not None:
                raise request.error
            content = destination.read_bytes()
            soil._parse_sda_response(content)
            digest = hashlib.sha256(content).hexdigest()
            registry["sdaResponses"][key] = {
                "querySha256": query_sha,
                "path": str(destination.relative_to(CACHE_DIR)),
                "sha256": digest,
            }
            registry["captureDates"].setdefault("sda-post", date.today().isoformat())
            _save_registry(registry)
            return content
        except soil.BudgetExceededError:
            raise
        except Exception as exc:  # noqa: BLE001 - retry is count-governed
            response = getattr(exc, "response", None)
            status = getattr(response, "status_code", None)
            body = getattr(response, "text", "")[:1000] if response is not None else ""
            if status is not None and status < 500:
                raise RuntimeError(
                    f"SDA batch {index} nontransient HTTP {status}: {body}"
                ) from exc
            last_error = exc
            if attempt == 1:
                raise RuntimeError(
                    f"SDA batch {index} failed after two attempts: {exc}; {body}"
                ) from exc
    raise RuntimeError(str(last_error))


def _grid() -> dict:
    projected = transform_bounds(
        "EPSG:4326", "EPSG:5070", *core.PNW_BBOX, densify_pts=21
    )

    def down(value: float, anchor: float) -> float:
        return anchor + math.floor((value - anchor) / CELL_SIZE_M) * CELL_SIZE_M

    def up(value: float, anchor: float) -> float:
        return anchor + math.ceil((value - anchor) / CELL_SIZE_M) * CELL_SIZE_M

    snapped = (
        down(projected[0], core.GRID_ANCHOR_X),
        down(projected[1], core.GRID_ANCHOR_Y),
        up(projected[2], core.GRID_ANCHOR_X),
        up(projected[3], core.GRID_ANCHOR_Y),
    )
    width = round((snapped[2] - snapped[0]) / CELL_SIZE_M)
    height = round((snapped[3] - snapped[1]) / CELL_SIZE_M)
    tiles_x = math.ceil(width / TILE_SIZE_CELLS)
    tiles_y = math.ceil(height / TILE_SIZE_CELLS)
    ruled = (-2365695.0, 2146425.0, -1061745.0, 3265845.0)
    if snapped != ruled or (width, height, tiles_x, tiles_y) != (43465, 37314, 9, 8):
        raise RuntimeError(
            "revision 10 full-pull grid known answer differs: "
            f"{snapped}, {width}x{height}, {tiles_x}x{tiles_y}"
        )
    return {
        "projectedBounds5070": list(projected),
        "snappedBounds5070": list(snapped),
        "tileSizeCells": TILE_SIZE_CELLS,
        "tilesX": tiles_x,
        "tilesY": tiles_y,
        "widthCells": width,
        "heightCells": height,
    }


def _tile_bounds(grid: dict, ix: int, iy: int) -> tuple[float, float, float, float]:
    west, south, east, north = grid["snappedBounds5070"]
    tile_west = west + ix * TILE_SIZE_CELLS * CELL_SIZE_M
    tile_east = min(east, tile_west + TILE_SIZE_CELLS * CELL_SIZE_M)
    tile_north = north - iy * TILE_SIZE_CELLS * CELL_SIZE_M
    tile_south = max(south, tile_north - TILE_SIZE_CELLS * CELL_SIZE_M)
    return tile_west, tile_south, tile_east, tile_north


def _load_ecoregions(
    budget: soil.RequestBudget,
    registry: dict,
) -> tuple[gpd.GeoDataFrame, gpd.GeoDataFrame, dict]:
    receipts = {}
    for level, filename in ((3, core.ECO_L3_ZIP), (4, core.ECO_L4_ZIP)):
        path, digest = _download_get(
            f"epa-l{level}",
            core.EPA_S3_ROOT + filename,
            CACHE_DIR / filename,
            "epa-s3",
            budget,
            registry,
        )
        receipts[f"l{level}"] = {"filename": path.name, "sha256": digest}
    original = core.CACHE_DIR
    core.CACHE_DIR = CACHE_DIR
    try:
        level3 = core.load_ecoregions(3)
        level4 = core.load_ecoregions(4)
    finally:
        core.CACHE_DIR = original
    return level3, level4, receipts


def _dissolve(gdf: gpd.GeoDataFrame, code_field: str) -> gpd.GeoDataFrame:
    subset = gdf[[code_field, "geometry"]].copy()
    if subset[code_field].duplicated().any():
        subset = subset.dissolve(by=code_field, as_index=False)
    return subset.sort_values(code_field).reset_index(drop=True)


def _materialize_tile(
    raw_path: Path,
    bounds: tuple[float, float, float, float],
    ix: int,
    iy: int,
) -> tuple[Path, dict, dict]:
    expected_width = round((bounds[2] - bounds[0]) / CELL_SIZE_M)
    expected_height = round((bounds[3] - bounds[1]) / CELL_SIZE_M)
    deviations = soil.raster_congruence(raw_path, returned_service_raster=True)
    source_observations = soil.inspect_mukey_raster(raw_path)
    with rasterio.open(raw_path) as dataset:
        actual = dataset.bounds
        tolerance = 0.02
        if (
            actual.left < bounds[0] - tolerance
            or actual.bottom < bounds[1] - tolerance
            or actual.right > bounds[2] + tolerance
            or actual.top > bounds[3] + tolerance
            or actual.right <= bounds[0]
            or actual.top <= bounds[1]
            or actual.left >= bounds[2]
            or actual.bottom >= bounds[3]
        ):
            raise soil.SoilValidationError(
                "service-returned tile extent is not an in-bounds clip of the "
                f"frozen request: got {tuple(actual)}, requested {bounds}"
            )
        clipped = (dataset.width, dataset.height) != (expected_width, expected_height)
    if clipped:
        source_observations["maskValues"].append(float("nan"))
        source_observations["maskSources"].append(
            "out-of-extent area absent after WCS response clipping and treated as nodata"
        )
    return raw_path, deviations, source_observations


def _download_tiles(
    grid: dict,
    budget: soil.RequestBudget,
    registry: dict,
) -> tuple[list[dict], set[int], dict]:
    tiles: list[dict] = []
    all_mukeys: set[int] = set()
    observations = {
        "maximum": 0,
        "pixelSizeMaxDeviationM": 0.0,
        "originMaxDeviationM": 0.0,
        "originXMaxDeviationM": 0.0,
        "originYMaxDeviationM": 0.0,
        "maskRecords": set(),
    }
    for iy in range(grid["tilesY"]):
        for ix in range(grid["tilesX"]):
            bounds = _tile_bounds(grid, ix, iy)
            url = soil.wcs_url(bounds)
            raw, digest = _download_get(
                f"wcs-{iy:02d}-{ix:02d}",
                url,
                CACHE_DIR / "tiles" / f"tile-{iy:02d}-{ix:02d}.tif",
                "soilweb-wcs",
                budget,
                registry,
            )
            staged, deviations, raster_obs = _materialize_tile(raw, bounds, ix, iy)
            all_mukeys.update(raster_obs["mukeys"])
            observations["maximum"] = max(observations["maximum"], raster_obs["maximum"])
            observations["pixelSizeMaxDeviationM"] = max(
                observations["pixelSizeMaxDeviationM"],
                deviations["pixelSizeMaxDeviationM"],
            )
            observations["originMaxDeviationM"] = max(
                observations["originMaxDeviationM"],
                deviations["originMaxDeviationM"],
            )
            observations["originXMaxDeviationM"] = max(
                observations["originXMaxDeviationM"],
                deviations["originXDeviationM"],
            )
            observations["originYMaxDeviationM"] = max(
                observations["originYMaxDeviationM"],
                deviations["originYDeviationM"],
            )
            for mask_value, mask_source in zip(
                raster_obs["maskValues"], raster_obs["maskSources"], strict=True
            ):
                rendered = "NaN" if isinstance(mask_value, float) and math.isnan(mask_value) \
                    else repr(mask_value)
                observations["maskRecords"].add((rendered, mask_source))
            tiles.append({
                "ix": ix,
                "iy": iy,
                "sha256": digest,
                "url": url,
                "rawPath": raw,
                "stagedPath": staged,
                "bounds": bounds,
            })
            print(
                f"tile {iy * grid['tilesX'] + ix + 1}/"
                f"{grid['tilesX'] * grid['tilesY']} ready; "
                f"{len(all_mukeys)} distinct mukeys",
                flush=True,
            )
    observations["maskRecords"] = sorted(observations["maskRecords"])
    return tiles, all_mukeys, observations


def _tile_histogram_part(
    tile: dict,
    gdf: gpd.GeoDataFrame,
    code_field: str,
    level: int,
    boundary_sha: str,
) -> dict:
    cache_path = PARTS_DIR / (
        f"l{level}-{tile['iy']:02d}-{tile['ix']:02d}-"
        f"{tile['sha256'][:12]}-{boundary_sha[:12]}.json"
    )
    if cache_path.is_file():
        return json.loads(cache_path.read_text(encoding="utf-8"))
    tile_box = box(*tile["bounds"])
    subset = gdf[gdf.geometry.intersects(tile_box)].copy()
    if subset.empty:
        soil.write_json(cache_path, {})
        return {}
    with rasterio.open(tile["stagedPath"]) as dataset:
        frame = exact_extract(
            dataset,
            subset,
            ["unique", "frac", "count"],
            include_cols=[code_field],
            output="pandas",
        )
    part = {}
    for index, (_, source_row) in enumerate(subset.iterrows()):
        row = frame.iloc[index]
        raw_count = row.get("count")
        count = 0.0 if raw_count is None or not math.isfinite(float(raw_count)) \
            else float(raw_count)
        valid_area = count * 900.0
        areas = []
        uniques = row.get("unique")
        fractions = row.get("frac")
        if uniques is not None and fractions is not None:
            for mukey, fraction in zip(uniques, fractions, strict=True):
                areas.append({
                    "mukey": int(round(float(mukey))),
                    "areaM2": float(fraction) * valid_area,
                })
        part[str(source_row[code_field])] = {
            "validAreaM2": valid_area,
            "effectiveCellCount": count,
            "entries": sorted(areas, key=lambda item: item["mukey"]),
        }
    soil.write_json(cache_path, part)
    return part


def _full_histogram(
    tiles: list[dict],
    raw_gdf: gpd.GeoDataFrame,
    code_field: str,
    level: int,
    boundary_sha: str,
) -> dict:
    gdf = _dissolve(raw_gdf, code_field)
    accum = {
        str(row[code_field]): {
            "totalAreaM2": float(row.geometry.area),
            "validAreaM2": 0.0,
            "effectiveCellCount": 0.0,
            "areas": defaultdict(float),
        }
        for _, row in gdf.iterrows()
    }
    for tile_number, tile in enumerate(tiles, start=1):
        part = _tile_histogram_part(
            tile, gdf, code_field, level, boundary_sha
        )
        for code, values in part.items():
            accum[code]["validAreaM2"] += float(values["validAreaM2"])
            accum[code]["effectiveCellCount"] += float(values["effectiveCellCount"])
            for entry in values["entries"]:
                accum[code]["areas"][int(entry["mukey"])] += float(entry["areaM2"])
        print(f"histogram level {level}: tile {tile_number}/{len(tiles)}", flush=True)
    output = {}
    for code in sorted(accum):
        values = accum[code]
        total = values["totalAreaM2"]
        valid = values["validAreaM2"]
        entries = [
            {
                "mukey": mukey,
                "areaM2": area,
                "fraction": area / valid,
            }
            for mukey, area in sorted(values["areas"].items())
        ] if valid > 0 else []
        output[code] = {
            "totalAreaM2": total,
            "validAreaM2": valid,
            "nodataAreaM2": max(0.0, total - valid),
            "effectiveCellCount": values["effectiveCellCount"],
            "entries": entries,
        }
    soil.validate_histogram(output)
    return output


def _largest_part_corner(level3: gpd.GeoDataFrame) -> tuple[float, float, object]:
    names = level3["US_L3NAME"].astype(str).str.casefold()
    matches = level3[names == "willamette valley"]
    if matches.empty:
        raise RuntimeError("expected at least one Willamette Valley row, found 0")
    parts = []
    for geometry in matches.geometry:
        if geometry.geom_type == "MultiPolygon":
            parts.extend(geometry.geoms)
        else:
            parts.append(geometry)
    indexed = list(enumerate(parts))
    indexed.sort(
        key=lambda item: (
            -item[1].area,
            item[1].bounds[0],
            item[1].bounds[1],
            item[0],
        )
    )
    part = indexed[0][1]
    point = part.representative_point()
    ulx = core.GRID_ANCHOR_X + math.floor(
        (point.x - 1500.0 - core.GRID_ANCHOR_X) / 30.0
    ) * 30.0
    uly = core.GRID_ANCHOR_Y + math.ceil(
        (point.y + 1500.0 - core.GRID_ANCHOR_Y) / 30.0
    ) * 30.0
    return ulx, uly, point


def _write_fixture_raster(
    tiles: list[dict],
    ulx: float,
    uly: float,
) -> Path:
    bounds = (ulx, uly - 3000.0, ulx + 3000.0, uly)
    sources = [rasterio.open(tile["stagedPath"]) for tile in tiles]
    try:
        data, transform = merge(
            sources,
            bounds=bounds,
            res=(30.0, 30.0),
            nodata=np.nan,
            dtype="float32",
            method="first",
        )
    finally:
        for source in sources:
            source.close()
    if data.shape != (1, 100, 100) or transform != from_origin(ulx, uly, 30, 30):
        raise RuntimeError(
            f"fixture window shape/transform differs: {data.shape}, {transform}"
        )
    path = FIXTURE_DIR / "mukey-window.tif"
    profile = {
        "driver": "GTiff",
        "height": 100,
        "width": 100,
        "count": 1,
        "dtype": "float32",
        "crs": "EPSG:5070",
        "transform": transform,
        "nodata": float("nan"),
        "tiled": True,
        "blockxsize": 32,
        "blockysize": 32,
        "compress": "deflate",
        "predictor": 3,
    }
    with rasterio.open(path, "w", **profile) as output:
        output.write(data)
    soil.raster_congruence(path)
    soil.inspect_mukey_raster(path)
    return path


def _fixture_mukeys(path: Path) -> set[int]:
    return soil.inspect_mukey_raster(path)["mukeys"]


def _write_fixture_outputs(
    tiles: list[dict],
    rows: dict,
    level3: gpd.GeoDataFrame,
) -> dict:
    ulx, uly, point = _largest_part_corner(level3)
    raster_path = _write_fixture_raster(tiles, ulx, uly)
    fixture_mukeys = _fixture_mukeys(raster_path)
    fixture_rows = soil.subset_sda_rows(rows, fixture_mukeys)
    rows_path = FIXTURE_DIR / "sda-rows.json"
    soil.write_json(rows_path, fixture_rows)
    window = gpd.GeoDataFrame(
        {"US_L3CODE": ["fixture"]},
        geometry=[box(ulx, uly - 3000.0, ulx + 3000.0, uly)],
        crs="EPSG:5070",
    )
    prepared = {
        "soil-mukey": {
            "kind": "raster",
            "path": raster_path,
            "error": None,
            "acquired": date.today().isoformat(),
            "sha256": soil.sha256_file(raster_path),
        },
        "soil-sda": {
            "kind": "table",
            "path": rows_path,
            "error": None,
            "acquired": date.today().isoformat(),
            "sha256": soil.sha256_file(rows_path),
        },
    }
    block = soil.aggregate(window, "US_L3CODE", prepared=prepared)["fixture"]
    expected_path = FIXTURE_DIR / "expected-soil-block.json"
    soil.write_json(expected_path, block)
    return {
        "ulx": ulx,
        "uly": uly,
        "representativePoint": [point.x, point.y],
        "raster": raster_path,
        "rows": rows_path,
        "expected": expected_path,
        "mukeys": sorted(fixture_mukeys),
        "mukeyCount": len(fixture_mukeys),
        "sourceTiles": [
            [tile["ix"], tile["iy"]]
            for tile in tiles
            if tile["bounds"][0] <= ulx
            and tile["bounds"][1] <= uly - 3000.0
            and tile["bounds"][2] >= ulx + 3000.0
            and tile["bounds"][3] >= uly
        ],
    }


def _unresolved_summary(hist3: dict, hist4: dict, rows: dict) -> dict:
    run_info = {}
    soil.soil_blocks_from_histogram(hist3, rows, level=3, run_info=run_info)
    soil.soil_blocks_from_histogram(hist4, rows, level=4, run_info=run_info)
    levels = run_info.get("soilUnresolvedByCode", {})
    return {
        str(level): {
            "polygonCount": len(values),
            "uniqueMukeyCount": len({
                mukey for entry in values.values() for mukey in entry["mukeys"]
            }),
            "occurrenceCount": sum(entry["count"] for entry in values.values()),
        }
        for level, values in levels.items()
    }


def _write_sources(
    manifest: dict,
    tiles: list[dict],
    observations: dict,
    fixture: dict,
    cross_check: dict,
    discriminator: dict,
    unresolved: dict,
    directory_size: int,
    data_file_sizes: dict[str, int],
    overflow_dir: Path | None,
) -> None:
    fixture_hashes = {
        "mukey-window.tif": soil.sha256_file(FIXTURE_DIR / "mukey-window.tif"),
        "sda-rows.json": soil.sha256_file(FIXTURE_DIR / "sda-rows.json"),
        "expected-soil-block.json": soil.sha256_file(
            FIXTURE_DIR / "expected-soil-block.json"
        ),
        "capture.py": soil.sha256_file(Path(__file__)),
    }
    lines = [
        "# Soil fixture and full-pull sources",
        "",
        "Capture date: 2026-07-22 Pacific local time. Hypertext Transfer Protocol "
        "response dates may be 2026-07-23 Coordinated Universal Time.",
        "",
        "## Pinned source and license",
        "",
        f"- SoilWeb Web Coverage Service (WCS) URL: `{soil.SOILWEB_WCS_URL}`",
        f"- Soil Data Access (SDA) URL: `{soil.SDA_URL}`",
        f"- Pinned fiscal year (FY) vintage: `{manifest['fyLabel']}` from the captured Soil Data "
        "Access sacatalog evidence tuple.",
        f"- Evidence tuple: saverestMax `{manifest['saverestMax']}`, saverestMin "
        f"`{manifest['saverestMin']}`, saverestCount `{manifest['saverestCount']}`.",
        f"- Raster vintage assumption: `{manifest['rasterVintageAssumption']}`.",
        "- Unit realization: S1 lane contract revision 14 confirms that "
        "muaggatt.aws0150wta is centimeters of available water storage (AWS). "
        "The adapter applies "
        "exactly one 10x conversion when deriving awsRootZoneMm, awsP10, and "
        "awsP90. The MANIFEST sdaQueries response digests and finalized "
        "sda-rows.json digest preserve the source provenance for that conversion.",
        "- Texture schema realization: S1 lane contract revision 12, using "
        "chorizon.chkey to chtexturegrp (representative value (RV)-preferred) "
        "to chtexture.texcl; this is the dated correction recorded in "
        "architecture decision record (ADR) P9-002.",
        "- Provenance terms: Soil Survey Geographic Database (SSURGO) and State "
        "Soil Geographic Database version 2 (STATSGO2).",
        "- License: underlying gridded National Soil Survey Geographic Database "
        "(gNATSGO) and Soil Data Access data are United States Government works "
        "and public domain.",
        "- Required citation: Soil Survey Staff, Natural Resources Conservation "
        "Service, United States Department of Agriculture, gNATSGO and Soil Data "
        "Access; raster courtesy of SoilWeb, California Soil Resource Lab, "
        "University of California, Davis / University of California Agriculture "
        "and Natural Resources.",
        "- Checksum posture: the dynamic services publish no content checksum. "
        "Every response and retained raster tile is locally checked with Secure "
        "Hash Algorithm 256-bit (SHA-256); the Environmental Protection Agency "
        "ZIP archives likewise use local SHA-256.",
        "- Dynamic coverage header posture: Content-Length and Last-Modified "
        "were not retained during this capture. No refetch was made against the "
        "remaining request budget; the next vintage's annual full pull is the "
        "next budgeted SoilWeb contact and records them. The current per-tile "
        "headers are unrecoverable post-hoc and remain explicitly absent.",
        "",
        "## Full family pull receipts",
        "",
        f"- Projected bounds in European Petroleum Survey Group (EPSG) 5070: "
        f"`{json.dumps(manifest['tileGrid']['projectedBounds5070'])}`",
        f"- Snapped bounds in EPSG:5070: `{json.dumps(manifest['tileGrid']['snappedBounds5070'])}`",
        f"- Tile grid: `{manifest['tileGrid']['tilesX']} x "
        f"{manifest['tileGrid']['tilesY']}` at "
        f"`{manifest['tileGrid']['tileSizeCells']}` cells per interior tile.",
        f"- Cumulative RequestBudget counts: `{json.dumps(manifest['requestCounts'], sort_keys=True)}`",
        f"- Observed valid mukey maximum: `{observations['maximum']}`; all valid "
        "values were integral and no greater than 2^24.",
        f"- Service-returned pixel-size maximum deviation: "
        f"`{observations['pixelSizeMaxDeviationM']:.12g}` m.",
        f"- Service-returned origin-edge maximum deviation: "
        f"`{observations['originMaxDeviationM']:.12g}` m; X maximum "
        f"`{observations['originXMaxDeviationM']:.12g}` m; Y maximum "
        f"`{observations['originYMaxDeviationM']:.12g}` m.",
        "- Congruence result: PASS under contract section 2.2 returned-raster "
        "tolerances. Full-pull histograms consume these verified native 30 m "
        "tiles directly under section 2.1's same-resolution equivalence scope.",
        f"- Nodata and padding masks, value plus metadata source: "
        f"`{json.dumps(observations['maskRecords'])}`. Masks were applied before "
        "the categorical domain assertion.",
        "- Lossless dtype staging: not needed. SoilWeb returned float32 mukeys, "
        "which the core materialization path accepts without widening; valid "
        "values were integer-identity checked before histogram use.",
        f"- SSURGO/STATSGO2 discriminator counts: `{json.dumps(discriminator, sort_keys=True)}`; sanity result PASS.",
        f"- Unresolved mukey summary by level: `{json.dumps(unresolved, sort_keys=True)}`.",
        f"- Unit cross-check: `{cross_check['verdict']}` with "
        f"`{cross_check['passingCount']}/{cross_check['selectedCount']}` within "
        "15 percent; symmetric systematic near-10x / near-0.1x guard false.",
        f"- Unit cross-check full record: `{json.dumps(cross_check, sort_keys=True)}`",
        f"- Intermediates directory size: `{directory_size}` bytes versus the "
        f"`{SIZE_GUARD_BYTES}` byte guard.",
        "- Intermediates file sizes for plain JavaScript Object Notation (JSON): "
        f"`{json.dumps(data_file_sizes, sort_keys=True)}`.",
        (
            "- 25 MB guard result: TRIGGERED. The three data files remain at "
            f"`{overflow_dir.relative_to(REPO_ROOT).as_posix()}/`; only "
            "MANIFEST.json remains in the durable FY home, where its files map "
            "pins their finalized identities. Post-guard retention and this "
            "insurance posture escalate to T-S1-4 and the maintainer under "
            "contract section 9 item 3."
            if overflow_dir is not None else
            "- 25 MB guard result: PASS; all four files remain in the durable FY home."
        ),
        "",
        "## Willamette Valley fixture",
        "",
        f"- Largest-part representative point: `{json.dumps(fixture['representativePoint'])}`.",
        f"- Frozen upper-left corner: `({fixture['ulx']}, {fixture['uly']})`; "
        "window is 100 x 100 analysis cells.",
        f"- Fixture distinct mukeys: `{fixture['mukeyCount']}`.",
        "- `mukey-window.tif` comes from the retained full-pull tiles over that "
        "window; `sda-rows.json` is the frozen nine-table closure for its "
        "mukeys; `expected-soil-block.json` is the capture snapshot.",
        f"- Fixture-to-request mapping, raster: `mukey-window.tif` was cut wholly "
        f"from Web Coverage Service tile(s) `{json.dumps(fixture['sourceTiles'])}`; "
        f"their request URLs and response digests are listed below.",
        f"- Fixture-to-request mapping, table: all `{fixture['mukeyCount']}` "
        f"fixture mukeys occur in Soil Data Access batch(es) "
        f"`{json.dumps(fixture['sdaBatches'])}`; their exact queries and response "
        "digests are listed below.",
        "- `expected-soil-block.json` was derived offline from `mukey-window.tif` "
        "and `sda-rows.json`; `capture.py` and `SOURCES.md` are authored records "
        "and do not map to a source request.",
        "- `SOURCES.md` is not self-hashed to avoid a circular digest. Its exact "
        "bytes are independently pinned in test_soil.py.",
        "",
        "Fixture file sha256 values:",
        "",
    ]
    lines.extend(f"- `{name}`: `{digest}`" for name, digest in fixture_hashes.items())
    lines.extend(["", "## Exact WCS requests", ""])
    for tile in tiles:
        lines.append(
            f"- tile ({tile['ix']}, {tile['iy']}), sha256 `{tile['sha256']}`: "
            f"`{tile['url']}`"
        )
    lines.extend(["", "## Environmental Protection Agency boundaries", ""])
    for level in ("l3", "l4"):
        item = manifest["epaBoundaryZips"][level]
        lines.append(
            f"- `{core.EPA_S3_ROOT}{item['filename']}`, local sha256 "
            f"`{item['sha256']}`."
        )
    lines.extend(["", "## Soil Data Access queries", ""])
    for index, item in enumerate(manifest["sdaQueries"]):
        lines.append(
            f"- Batch {index}, response sha256 `{item['responseSha256']}`:"
        )
        lines.append("  ```sql")
        lines.extend("  " + line for line in item["query"].splitlines())
        lines.append("  ```")
    (FIXTURE_DIR / "SOURCES.md").write_bytes(("\n".join(lines) + "\n").encode("utf-8"))


def _manifest_input_identity(manifest: dict) -> dict:
    return {
        key: manifest[key]
        for key in (
            "fyLabel", "saverestMax", "saverestMin", "saverestCount",
            "rasterVintageAssumption", "tileGrid", "tiles",
            "epaBoundaryZips", "sdaQueries",
        )
    }


def _overflow_binding_record(manifest: dict) -> dict:
    return {
        "bindingSchemaVersion": "1",
        "captureSchemaVersion": CAPTURE_SCHEMA_VERSION,
        "methodVersion": soil.SOURCE["methodVersion"],
        "inputIdentity": _manifest_input_identity(manifest),
        "files": manifest["files"],
    }


def _load_bound_overflow(
    overflow: Path,
    vintage_dir: Path,
    current_identity: dict,
) -> tuple[dict, dict, dict, dict]:
    """Load overflow only when its manifest and input binding are exact."""
    present = [(overflow / name).is_file() for name in DATA_NAMES]
    if any(present) and not all(present):
        raise soil.SoilValidationError(
            "guard overflow is partial; all three data files are required"
        )
    if not all(present):
        raise soil.SoilValidationError("guard overflow data files are missing")
    manifest_path = vintage_dir / "MANIFEST.json"
    if not manifest_path.is_file():
        raise soil.SoilValidationError(
            "guard overflow cannot be reused without its durable MANIFEST.json"
        )
    manifest = soil.validate_manifest(_load_json(manifest_path, None))
    if _manifest_input_identity(manifest) != current_identity:
        raise soil.SoilValidationError(
            "guard overflow input identity differs from current capture inputs"
        )
    expected_binding = _overflow_binding_record(manifest)
    binding_path = overflow / OVERFLOW_BINDING_NAME
    if not binding_path.is_file():
        raise soil.SoilValidationError(
            "guard overflow binding sidecar is missing; fresh capture is required"
        )
    recorded_binding = _load_json(binding_path, None)
    if recorded_binding != expected_binding:
        raise soil.SoilValidationError(
            "guard overflow binding sidecar differs from recorded manifest inputs"
        )
    for name in DATA_NAMES:
        if soil.sha256_file(overflow / name) != manifest["files"][name]:
            raise soil.SoilValidationError(
                f"guard overflow {name} digest differs from MANIFEST.json"
            )
    histogram_l3 = json.loads(
        (overflow / "histogram-l3.json").read_text(encoding="utf-8")
    )
    histogram_l4 = json.loads(
        (overflow / "histogram-l4.json").read_text(encoding="utf-8")
    )
    rows = json.loads((overflow / "sda-rows.json").read_text(encoding="utf-8"))
    soil.validate_histogram(histogram_l3)
    soil.validate_histogram(histogram_l4)
    soil.validate_sda_rows(rows)
    recorded_evidence = {
        key: manifest[key]
        for key in ("fyLabel", "saverestMax", "saverestMin", "saverestCount")
    }
    if soil.vintage_evidence(rows["sacatalog"]) != recorded_evidence:
        raise soil.SoilValidationError(
            "guard overflow sda-rows vintage differs from MANIFEST.json"
        )
    return manifest, histogram_l3, histogram_l4, rows


def main() -> int:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    budget = _budget()
    registry = _registry()
    grid = _grid()
    level3, level4, epa_receipts = _load_ecoregions(budget, registry)
    tiles, mukeys, observations = _download_tiles(grid, budget, registry)
    if not mukeys:
        raise RuntimeError("full-pull raster contained no valid mukeys")
    batches = math.ceil(len(mukeys) / SDA_BATCH_SIZE)
    remaining = budget.ceilings["sda-post"] - budget.counts["sda-post"]
    cached_batches = sum(
        1 for record in registry["sdaResponses"].values()
        if isinstance(record, dict)
    )
    if max(0, batches - cached_batches) > remaining:
        raise soil.BudgetExceededError(
            f"SDA requires {batches} total batches for {len(mukeys)} mukeys but "
            f"only {remaining} attempts remain under contract sections 4.5/6.3"
        )

    def fetch(query: str, index: int) -> bytes:
        return _fetch_sda(query, index, budget, registry)

    rows, sda_receipts = soil.build_sda_rows(
        mukeys, fetch, batch_size=SDA_BATCH_SIZE
    )
    evidence = soil.vintage_evidence(rows["sacatalog"])
    vintage_dir = (
        REPO_ROOT / "scripts" / "landscape" / "intermediates" / "soil"
        / evidence["fyLabel"]
    )
    overflow = CACHE_DIR / "intermediates-overflow" / evidence["fyLabel"]
    current_identity = {
        **evidence,
        "rasterVintageAssumption": soil.RASTER_VINTAGE_ASSUMPTION,
        "tileGrid": {
            key: grid[key] for key in (
                "projectedBounds5070", "snappedBounds5070", "tileSizeCells",
                "tilesX", "tilesY",
            )
        },
        "tiles": [
            {"ix": tile["ix"], "iy": tile["iy"], "sha256": tile["sha256"]}
            for tile in tiles
        ],
        "epaBoundaryZips": epa_receipts,
        "sdaQueries": sda_receipts,
    }
    overflow_presence = [(overflow / name).is_file() for name in DATA_NAMES]
    if any(overflow_presence) and not all(overflow_presence):
        raise soil.SoilValidationError(
            "guard overflow is partial; refusing unbound regeneration"
        )
    reuse_overflow = all(overflow_presence)
    if reuse_overflow:
        del rows
        gc.collect()
        _, histogram_l3, histogram_l4, rows = _load_bound_overflow(
            overflow, vintage_dir, current_identity
        )
        print(f"reusing guard overflow at {overflow}", flush=True)
    else:
        if (overflow / OVERFLOW_BINDING_NAME).exists():
            raise soil.SoilValidationError(
                "guard overflow binding exists without its three data files"
            )
        histogram_l3 = _full_histogram(
            tiles, level3, "US_L3CODE", 3, epa_receipts["l3"]["sha256"]
        )
        histogram_l4 = _full_histogram(
            tiles, level4, "US_L4CODE", 4, epa_receipts["l4"]["sha256"]
        )
    cross_check = soil.unit_cross_check(rows)
    discriminator = soil.discriminator_counts(mukeys, rows)
    unresolved = _unresolved_summary(histogram_l3, histogram_l4, rows)

    vintage_dir.mkdir(parents=True, exist_ok=True)
    data = {
        "histogram-l3.json": histogram_l3,
        "histogram-l4.json": histogram_l4,
        "sda-rows.json": rows,
    }
    if not reuse_overflow:
        for name, value in data.items():
            soil.write_json(vintage_dir / name, value)
    data_paths = {
        name: (overflow / name if reuse_overflow else vintage_dir / name)
        for name in data
    }
    manifest = {
        "manifestSchemaVersion": "1",
        **evidence,
        "rasterVintageAssumption": soil.RASTER_VINTAGE_ASSUMPTION,
        "tileGrid": {
            key: grid[key] for key in (
                "projectedBounds5070", "snappedBounds5070", "tileSizeCells",
                "tilesX", "tilesY",
            )
        },
        "tiles": [
            {"ix": tile["ix"], "iy": tile["iy"], "sha256": tile["sha256"]}
            for tile in tiles
        ],
        "epaBoundaryZips": epa_receipts,
        "sdaQueries": sda_receipts,
        "files": {
            name: soil.sha256_file(data_paths[name]) for name in data
        },
        "captureDates": {
            "wcsPull": registry["captureDates"]["soilweb-wcs"],
            "sdaPull": registry["captureDates"]["sda-post"],
        },
        "requestCounts": dict(budget.counts),
    }
    soil.validate_manifest(manifest)
    soil.write_json(vintage_dir / "MANIFEST.json", manifest)
    data_file_sizes = {
        name: data_paths[name].stat().st_size for name in data
    }
    data_file_sizes["MANIFEST.json"] = (vintage_dir / "MANIFEST.json").stat().st_size
    directory_size = sum(data_file_sizes.values())
    guard_overflow = None
    if directory_size > SIZE_GUARD_BYTES:
        overflow.mkdir(parents=True, exist_ok=True)
        if not reuse_overflow:
            for name in data:
                (vintage_dir / name).replace(overflow / name)
            soil.write_json(
                overflow / OVERFLOW_BINDING_NAME,
                _overflow_binding_record(manifest),
            )
        guard_overflow = overflow
        print(
            f"25 MB intermediates guard triggered: {directory_size} bytes; "
            "data files retained in the local cache and only MANIFEST.json committed",
            flush=True,
        )

    fixture = _write_fixture_outputs(tiles, rows, level3)
    mukey_positions = {
        value: index for index, value in enumerate(sorted(mukeys))
    }
    fixture["sdaBatches"] = sorted({
        mukey_positions[value] // SDA_BATCH_SIZE
        for value in fixture["mukeys"]
    })
    if fixture["sourceTiles"] != [[1, 3]] or fixture["sdaBatches"] != [0]:
        raise soil.SoilValidationError(
            "Willamette fixture request mapping differs from the frozen capture"
        )
    _write_sources(
        manifest, tiles, observations, fixture, cross_check, discriminator,
        unresolved, directory_size, data_file_sizes, guard_overflow,
    )
    summary = {
        "fyLabel": evidence["fyLabel"],
        "evidence": evidence,
        "requestCounts": dict(budget.counts),
        "directorySizeBytes": directory_size,
        "sizeGuardBytes": SIZE_GUARD_BYTES,
        "dataFileSizes": data_file_sizes,
        "overflowDirectory": (
            guard_overflow.relative_to(REPO_ROOT).as_posix()
            if guard_overflow is not None else None
        ),
        "unitCrossCheck": cross_check,
        "discriminator": discriminator,
        "unresolved": unresolved,
        "mukeyMaximum": observations["maximum"],
        "congruence": {
            key: observations[key] for key in (
                "pixelSizeMaxDeviationM", "originMaxDeviationM",
                "originXMaxDeviationM", "originYMaxDeviationM",
            )
        },
        "fixtureCorner": [fixture["ulx"], fixture["uly"]],
    }
    soil.write_json(SUMMARY_PATH, summary)
    print(json.dumps(summary, indent=2), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
