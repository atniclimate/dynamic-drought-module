"""Soil adapter for gridded National Soil Survey Geographic Database data.

The adapter implements Contract B from the frozen S1 lane contract. Network
access over Hypertext Transfer Protocol (HTTP) is confined to ``acquire`` and
``drift_check``. Aggregation is offline and accepts either checked prepared
artifacts or the durable histogram and Soil Data Access intermediates captured
for the pinned fiscal-year vintage.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import shutil
import time
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path
from typing import Callable, Iterable
from urllib.parse import urlencode

import geopandas as gpd
import numpy as np
import rasterio
import requests
from exactextract import exact_extract
from rasterio.warp import transform_bounds

from scripts.landscape import core


SOILWEB_WCS_URL = (
    "https://casoilresource.lawr.ucdavis.edu/cgi-bin/mapserv"
    "?map=/data1/website/wcs/mukey-grids.map"
)
SDA_URL = "https://SDMDataAccess.sc.egov.usda.gov/Tabular/post.rest"

# Immutable method-version history. A method's numerics, semantics, and any
# canonical serialization are part of its version and require a new entry if
# changed. Published entries are never edited or removed.
METHOD_VERSIONS: dict[int, str] = {
    1: (
        "exactextract partial-pixel mukey area weights on the 30m European "
        "Petroleum Survey Group (EPSG) 5070 "
        "analysis grid; Soil Data Access muaggatt centimeter available water "
        "storage converted once to serialized millimeters with step-function "
        "weighted percentiles; component-weighted root "
        "depth, dominant-component surface texture, and Soil Survey Geographic "
        "Database (SSURGO) / State Soil Geographic Database version 2 "
        "(STATSGO2) provenance"
    ),
}

CANONICAL_SERIALIZATION: dict[int, str] = {}

SOURCE_MUKEY = {
    "source": (
        "United States Department of Agriculture Natural Resources Conservation "
        "Service (USDA NRCS) gridded National Soil Survey Geographic Database "
        "via SoilWeb Web Coverage Service (WCS)"
    ),
    "sourceUrl": SOILWEB_WCS_URL,
    "vintage": "FY2025",
    "resolutionMeters": 30,
    "method": METHOD_VERSIONS[1],
    "methodVersion": 1,
}

SOURCE_SDA = {
    "source": "USDA NRCS Soil Data Access (SDA)",
    "sourceUrl": SDA_URL,
    "vintage": "FY2025",
    "resolutionMeters": None,
    "method": METHOD_VERSIONS[1],
    "methodVersion": 1,
}

# The family-level static provenance follows the raster sub-source. The table
# sub-source travels separately as SOURCE_SDA so its distinct URL is never lost.
SOURCE = dict(SOURCE_MUKEY)

SDA_COLUMNS: dict[str, tuple[str, ...]] = {
    "sacatalog": ("areasymbol", "saverest"),
    "muaggatt": ("mukey", "aws0150wta", "drclassdcd"),
    "component": ("mukey", "cokey", "comppct_r", "majcompflag"),
    "chorizon": ("cokey", "chkey", "hzdept_r", "hzdepb_r", "awc_r"),
    "chtexturegrp": ("chkey", "chtgkey", "texture", "rvindicator"),
    "chtexture": ("chtgkey", "chtkey", "texcl"),
    "corestrictions": ("cokey", "resdept_r"),
    "mapunit": ("mukey", "lkey"),
    "legend": ("lkey", "areasymbol"),
}
SDA_TABLES = tuple(SDA_COLUMNS)
SOIL_CAPTURE_ENDPOINTS = ("soilweb-wcs", "sda-post", "epa-s3", "metadata")
RASTER_VINTAGE_ASSUMPTION = (
    "same-FY mirror per SoilWeb's published mirroring relationship"
)
AWS_CM_TO_MM = 10.0
_DIGEST_RE = re.compile(r"[0-9a-f]{64}")
_DATE_RE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
_FY_RE = re.compile(r"FY[0-9]{4}")
OVERFLOW_BINDING_NAME = "INPUT-BINDING.json"
OVERFLOW_BINDING_SCHEMA_VERSION = "1"
CAPTURE_SCHEMA_VERSION = "1"
INTERMEDIATE_DATA_NAMES = (
    "histogram-l3.json",
    "histogram-l4.json",
    "sda-rows.json",
)


class BudgetExceededError(RuntimeError):
    """Raised before an HTTP attempt that would exceed a frozen ceiling."""


class SoilValidationError(RuntimeError):
    """A fail-closed soil contract validation error."""


class CaptureRequest(dict[str, str]):
    """A capture transport request executed only by ``acquire``.

    The object is a dictionary subclass so the frozen ``sources`` parameter
    remains unchanged. It carries no artifact-key overrides; capture.py uses it
    only to ask the adapter's acquisition surface to retain one raw response.
    """

    def __init__(
        self,
        *,
        method: str,
        url: str,
        endpoint_key: str,
        destination: Path,
        json_body: dict | None = None,
        timeout: int = 300,
    ) -> None:
        super().__init__()
        if method not in {"GET", "POST"}:
            raise ValueError("capture request method must be GET or POST")
        self.method = method
        self.url = url
        self.endpoint_key = endpoint_key
        self.destination = destination
        self.json_body = json_body
        self.timeout = timeout
        self.sha256: str | None = None
        self.response_headers: dict[str, str] = {}
        self.error: Exception | None = None


class RequestBudget:
    """Count-before-send request ceilings with optional persistent counts."""

    def __init__(
        self,
        ceilings: dict[str, int],
        *,
        counts: dict[str, int] | None = None,
        state_path: Path | None = None,
    ) -> None:
        if not ceilings or any(
            not isinstance(k, str)
            or not isinstance(v, int)
            or isinstance(v, bool)
            or v < 0
            for k, v in ceilings.items()
        ):
            raise ValueError("request ceilings must be nonnegative integers by key")
        supplied = counts or {}
        unknown = set(supplied) - set(ceilings)
        if unknown:
            raise ValueError(f"request counts contain unknown keys: {sorted(unknown)}")
        self.ceilings = dict(ceilings)
        self.counts = {key: int(supplied.get(key, 0)) for key in ceilings}
        if any(value < 0 for value in self.counts.values()):
            raise ValueError("request counts must be nonnegative")
        self.state_path = state_path
        self._persist()

    def _persist(self) -> None:
        if self.state_path is None:
            return
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.state_path.with_suffix(self.state_path.suffix + ".tmp")
        payload = {"ceilings": self.ceilings, "counts": self.counts}
        tmp.write_bytes((json.dumps(payload, indent=2) + "\n").encode("utf-8"))
        tmp.replace(self.state_path)

    def spend(self, endpoint_key: str) -> None:
        if endpoint_key not in self.ceilings:
            raise BudgetExceededError(
                f"unknown request endpoint key {endpoint_key!r}; frozen S1 lane "
                "contract sections 4.5/8 require an explicit ceiling"
            )
        next_count = self.counts[endpoint_key] + 1
        ceiling = self.ceilings[endpoint_key]
        if next_count > ceiling:
            raise BudgetExceededError(
                f"request budget exceeded for {endpoint_key}: ceiling {ceiling}; "
                "frozen S1 lane contract sections 4.5/8 require a hard stop"
            )
        self.counts[endpoint_key] = next_count
        self._persist()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes((json.dumps(value, indent=2) + "\n").encode("utf-8"))
    tmp.replace(path)


def _artifact(kind: str, path: Path | None = None, error: str | None = None,
              acquired: str | None = None, sha256: str | None = None) -> dict:
    if (path is None) == (error is None):
        raise ValueError("prepared artifact requires exactly one of path or error")
    return {
        "kind": kind,
        "path": path,
        "error": error,
        "acquired": acquired,
        "sha256": sha256,
    }


def _today() -> str:
    return date.today().isoformat()


def _number(value: object) -> float | None:
    if value is None or value == "":
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _integer_key(value: object) -> tuple[int, int | str]:
    try:
        return (0, int(str(value)))
    except (TypeError, ValueError):
        return (1, str(value))


def _edge_deviation(value: float, anchor: float, lattice: float = 30.0) -> float:
    offset = value - anchor
    return abs(offset - round(offset / lattice) * lattice)


def raster_congruence(
    path: Path,
    *,
    returned_service_raster: bool = False,
) -> dict[str, float]:
    """Validate a native 30 m raster against contract section 2.2."""
    pixel_tolerance = 1e-4 if returned_service_raster else 1e-6
    origin_tolerance = 0.02 if returned_service_raster else 1e-6
    with rasterio.open(path) as dataset:
        if dataset.crs is None or dataset.crs.to_epsg() != 5070:
            raise SoilValidationError(
                "S1 lane contract section 2.2: raster CRS is not EPSG:5070"
            )
        transform = dataset.transform
        if abs(transform.b) > pixel_tolerance or abs(transform.d) > pixel_tolerance:
            raise SoilValidationError(
                "S1 lane contract section 2.2: raster is rotated or sheared"
            )
        pixel_deviation = max(abs(abs(transform.a) - 30.0),
                              abs(abs(transform.e) - 30.0))
        origin_x = _edge_deviation(transform.c, core.GRID_ANCHOR_X)
        origin_y = _edge_deviation(transform.f, core.GRID_ANCHOR_Y)
        origin_deviation = max(origin_x, origin_y)
        if pixel_deviation > pixel_tolerance:
            raise SoilValidationError(
                "S1 lane contract section 2.2: raster pixel size is not 30 m "
                f"within {pixel_tolerance} m (deviation {pixel_deviation} m)"
            )
        if origin_deviation > origin_tolerance:
            raise SoilValidationError(
                "S1 lane contract section 2.2: raster origin is not congruent "
                f"within {origin_tolerance} m (deviation {origin_deviation} m)"
            )
    return {
        "pixelSizeMaxDeviationM": pixel_deviation,
        "originMaxDeviationM": origin_deviation,
        "originXDeviationM": origin_x,
        "originYDeviationM": origin_y,
    }


def inspect_mukey_raster(path: Path) -> dict:
    """Assert the valid mukey domain and return observations for receipts."""
    observed: set[int] = set()
    mask_values: list[object] = []
    mask_sources: list[str] = []
    maximum = 0
    with rasterio.open(path) as dataset:
        if dataset.nodata is not None:
            mask_values.append(dataset.nodata)
            mask_sources.append("GeoTIFF nodata tag returned by the service")
        for _, window in dataset.block_windows(1):
            band = dataset.read(1, window=window, masked=True)
            values = np.asarray(band.compressed())
            if dataset.nodata is None and values.size:
                zero_mask = values == 0
                if bool(np.any(zero_mask)):
                    values = values[~zero_mask]
                    if 0 not in mask_values:
                        mask_values.append(0)
                        mask_sources.append(
                            "contract section 4.3 out-of-extent padding default"
                        )
            if not values.size:
                continue
            if not bool(np.all(np.isfinite(values))):
                raise SoilValidationError(
                    "S1 lane contract section 4.3: non-finite valid mukey"
                )
            rounded = np.rint(values)
            if not bool(np.all(values == rounded)):
                sample = values[values != rounded][:5].tolist()
                raise SoilValidationError(
                    "S1 lane contract section 4.3: non-integral mukey values "
                    f"observed: {sample}"
                )
            block_max = int(np.max(rounded))
            if block_max > 2 ** 24:
                raise SoilValidationError(
                    "S1 lane contract section 4.3: observed mukey exceeds 2^24 "
                    f"({block_max})"
                )
            ints = rounded.astype("int64")
            if bool(np.any(ints < 0)):
                raise SoilValidationError(
                    "S1 lane contract section 4.3: negative valid mukey observed"
                )
            maximum = max(maximum, block_max)
            observed.update(int(value) for value in np.unique(ints))
    return {
        "mukeys": observed,
        "maximum": maximum,
        "maskValues": mask_values,
        "maskSources": mask_sources,
    }


def wcs_url(bounds_5070: tuple[float, float, float, float]) -> str:
    west, south, east, north = bounds_5070
    query = urlencode(
        [
            ("SERVICE", "WCS"),
            ("VERSION", "2.0.1"),
            ("REQUEST", "GetCoverage"),
            ("COVERAGEID", "gnatsgo"),
            ("FORMAT", "image/tiff"),
            ("SUBSET", f"x({west:.6f},{east:.6f})"),
            ("SUBSET", f"y({south:.6f},{north:.6f})"),
        ]
    )
    return f"{SOILWEB_WCS_URL}&{query}"


def _local_path(source: str) -> Path | None:
    if source.startswith("file://"):
        return Path(source[7:])
    if re.match(r"^https?://", source, flags=re.IGNORECASE):
        return None
    return Path(source)


def _parse_sda_response(content: bytes) -> list[list[dict]]:
    try:
        payload = json.loads(content)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SoilValidationError(f"invalid SDA JSON response: {exc}") from exc
    if not isinstance(payload, dict):
        raise SoilValidationError("SDA response is not a JSON object")
    packed = payload.get("Table")
    packed_header = ["table_name", "c1", "c2", "c3", "c4", "c5", "c6"]
    if (
        isinstance(packed, list)
        and packed
        and packed[0] == packed_header
        and set(payload) == {"Table"}
    ):
        routed: dict[str, list[dict]] = {table: [] for table in SDA_TABLES}
        for values in packed[1:]:
            if not isinstance(values, list) or len(values) != len(packed_header):
                raise SoilValidationError("SDA packed row width differs")
            table = values[0]
            if table not in SDA_COLUMNS:
                raise SoilValidationError(f"SDA packed row names unknown table {table!r}")
            columns = SDA_COLUMNS[table]
            routed[table].append(dict(zip(columns, values[1:1 + len(columns)], strict=True)))
        return [routed[table] for table in SDA_TABLES]

    if (
        isinstance(packed, list)
        and len(packed) == 2
        and packed[0] == list(SDA_TABLES)
        and set(payload) == {"Table"}
    ):
        decoded: list[list[dict]] = []
        for table, raw_json in zip(SDA_TABLES, packed[1], strict=True):
            try:
                rows = json.loads(raw_json)
            except (TypeError, json.JSONDecodeError) as exc:
                raise SoilValidationError(
                    f"SDA packed JSON for {table} is invalid: {exc}"
                ) from exc
            if not isinstance(rows, list):
                raise SoilValidationError(f"SDA packed JSON for {table} is not a list")
            decoded.append(rows)
        return decoded

    tables: list[list[dict]] = []
    for index, expected in enumerate(SDA_TABLES):
        key = "Table" if index == 0 else f"Table{index}"
        raw = payload.get(key)
        if not isinstance(raw, list) or not raw:
            raise SoilValidationError(
                f"SDA response missing non-empty result set {key} for {expected}"
            )
        header = raw[0]
        if list(header) != list(SDA_COLUMNS[expected]):
            raise SoilValidationError(
                f"SDA {expected} columns differ: {header!r}"
            )
        rows: list[dict] = []
        for values in raw[1:]:
            if not isinstance(values, list) or len(values) != len(header):
                raise SoilValidationError(f"SDA {expected} row width differs")
            rows.append(dict(zip(header, values, strict=True)))
        tables.append(rows)
    unknown = set(payload) - {
        "Table" if i == 0 else f"Table{i}" for i in range(len(SDA_TABLES))
    }
    if unknown:
        raise SoilValidationError(f"SDA response has unknown result sets: {sorted(unknown)}")
    return tables


def sda_batch_query(mukeys: Iterable[int]) -> str:
    ordered = sorted(set(int(value) for value in mukeys))
    if not ordered:
        raise ValueError("cannot build an SDA query for an empty mukey set")
    values = ",".join(f"({value})" for value in ordered)

    def packed_json(
        table: str,
        fields: list[tuple[str, str]],
        source: str,
        order_by: str,
    ) -> str:
        projection = ", ".join(
            f"CAST({expression} AS nvarchar(255)) AS {column}"
            for expression, column in fields
        )
        return (
            f"(SELECT {projection} FROM {source} ORDER BY {order_by} "
            f"FOR JSON PATH, INCLUDE_NULL_VALUES) AS {table}"
        )

    result_columns = [
        packed_json(
            "sacatalog",
            [("s.areasymbol", "areasymbol"), ("s.saverest", "saverest")],
            "sacatalog s WHERE s.areasymbol IN (SELECT DISTINCT l.areasymbol "
            "FROM legend l INNER JOIN mapunit m ON l.lkey = m.lkey "
            "INNER JOIN wanted w ON m.mukey = w.mukey)",
            "s.areasymbol, s.saverest",
        ),
        packed_json(
            "muaggatt",
            [("a.mukey", "mukey"), ("a.aws0150wta", "aws0150wta"),
             ("a.drclassdcd", "drclassdcd")],
            "muaggatt a INNER JOIN wanted w ON a.mukey = w.mukey",
            "a.mukey",
        ),
        packed_json(
            "component",
            [("c.mukey", "mukey"), ("c.cokey", "cokey"),
             ("c.comppct_r", "comppct_r"), ("c.majcompflag", "majcompflag")],
            "component c INNER JOIN wanted w ON c.mukey = w.mukey",
            "c.mukey, c.cokey",
        ),
        packed_json(
            "chorizon",
            [("h.cokey", "cokey"), ("h.chkey", "chkey"),
             ("h.hzdept_r", "hzdept_r"), ("h.hzdepb_r", "hzdepb_r"),
             ("h.awc_r", "awc_r")],
            "chorizon h INNER JOIN component c ON h.cokey = c.cokey "
            "INNER JOIN wanted w ON c.mukey = w.mukey",
            "h.cokey, h.chkey",
        ),
        packed_json(
            "chtexturegrp",
            [("g.chkey", "chkey"), ("g.chtgkey", "chtgkey"),
             ("g.texture", "texture"), ("g.rvindicator", "rvindicator")],
            "chtexturegrp g INNER JOIN chorizon h ON g.chkey = h.chkey "
            "INNER JOIN component c ON h.cokey = c.cokey "
            "INNER JOIN wanted w ON c.mukey = w.mukey",
            "g.chkey, g.chtgkey",
        ),
        packed_json(
            "chtexture",
            [("t.chtgkey", "chtgkey"), ("t.chtkey", "chtkey"),
             ("t.texcl", "texcl")],
            "chtexture t INNER JOIN chtexturegrp g ON t.chtgkey = g.chtgkey "
            "INNER JOIN chorizon h ON g.chkey = h.chkey "
            "INNER JOIN component c ON h.cokey = c.cokey "
            "INNER JOIN wanted w ON c.mukey = w.mukey",
            "t.chtgkey, t.chtkey",
        ),
        packed_json(
            "corestrictions",
            [("r.cokey", "cokey"), ("r.resdept_r", "resdept_r")],
            "corestrictions r INNER JOIN component c ON r.cokey = c.cokey "
            "INNER JOIN wanted w ON c.mukey = w.mukey",
            "r.cokey, r.resdept_r",
        ),
        packed_json(
            "mapunit",
            [("m.mukey", "mukey"), ("m.lkey", "lkey")],
            "mapunit m INNER JOIN wanted w ON m.mukey = w.mukey",
            "m.mukey, m.lkey",
        ),
        packed_json(
            "legend",
            [("l.lkey", "lkey"), ("l.areasymbol", "areasymbol")],
            "legend l WHERE l.lkey IN (SELECT DISTINCT m.lkey FROM mapunit m "
            "INNER JOIN wanted w ON m.mukey = w.mukey)",
            "l.lkey, l.areasymbol",
        ),
    ]
    return (
        "WITH wanted(mukey) AS (SELECT mukey FROM (VALUES " + values
        + ") AS wanted_values(mukey))\nSELECT\n  "
        + ",\n  ".join(result_columns)
    )


def build_sda_rows(
    mukeys: Iterable[int],
    fetch_response: Callable[[str, int], bytes],
    *,
    batch_size: int = 3000,
) -> tuple[dict[str, list[dict]], list[dict]]:
    """Fetch and merge exact frozen SDA projections in deterministic batches."""
    ordered = sorted(set(int(value) for value in mukeys))
    if not ordered:
        return {table: [] for table in SDA_TABLES}, []
    merged: dict[str, dict[str, dict]] = {table: {} for table in SDA_TABLES}
    mapunit_rows: list[dict] = []
    receipts: list[dict] = []
    for index, start in enumerate(range(0, len(ordered), batch_size)):
        query = sda_batch_query(ordered[start:start + batch_size])
        content = fetch_response(query, index)
        parsed = _parse_sda_response(content)
        receipts.append({
            "query": query,
            "responseSha256": hashlib.sha256(content).hexdigest(),
        })
        for table, rows in zip(SDA_TABLES, parsed, strict=True):
            for row in rows:
                if table == "mapunit":
                    mapunit_rows.append(row)
                    continue
                canonical = json.dumps(row, sort_keys=True, separators=(",", ":"))
                merged[table][canonical] = row

    out: dict[str, list[dict]] = {}
    for table, columns in SDA_COLUMNS.items():
        values = mapunit_rows if table == "mapunit" else merged[table].values()
        out[table] = sorted(
            values,
            key=lambda row: tuple(_integer_key(row.get(column)) for column in columns),
        )
    validate_sda_rows(out)
    _index_rows(out)
    return out, receipts


def validate_sda_rows(value: object) -> dict[str, list[dict]]:
    if not isinstance(value, dict) or set(value) != set(SDA_TABLES):
        got = sorted(value) if isinstance(value, dict) else type(value).__name__
        raise SoilValidationError(
            "S1 lane contract section 4.7: soil-sda top-level tables differ "
            f"({got})"
        )
    for table, columns in SDA_COLUMNS.items():
        rows = value[table]
        if not isinstance(rows, list):
            raise SoilValidationError(
                f"S1 lane contract section 4.7: {table} is not a row list"
            )
        for row in rows:
            if not isinstance(row, dict) or set(row) != set(columns):
                raise SoilValidationError(
                    f"S1 lane contract section 4.7: {table} row columns differ"
                )
    return value  # type: ignore[return-value]


def _read_checked_table(entry: dict) -> dict[str, list[dict]]:
    if entry.get("kind") != "table":
        raise SoilValidationError("soil-sda prepared artifact kind must be table")
    path = entry.get("path")
    digest = entry.get("sha256")
    if not isinstance(path, Path):
        path = Path(path) if isinstance(path, str) else None
    if path is None or not path.is_file():
        raise SoilValidationError("soil-sda prepared artifact path is missing")
    if not isinstance(digest, str) or sha256_file(path) != digest:
        raise SoilValidationError("soil-sda prepared artifact sha256 mismatch")
    try:
        rows = json.loads(path.read_text(encoding="utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SoilValidationError(f"soil-sda JSON is invalid: {exc}") from exc
    return validate_sda_rows(rows)


def acquire(
    bounds_5070: tuple[float, float, float, float],
    cache_dir: Path,
    budget: RequestBudget,
    *,
    sources: dict[str, str] | None = None,
) -> dict[str, dict]:
    """Acquire and materialize the checked mukey raster and SDA row table."""
    if isinstance(sources, CaptureRequest):
        request = sources
        temporary = request.destination.with_suffix(
            request.destination.suffix + ".part"
        )
        request.destination.parent.mkdir(parents=True, exist_ok=True)
        try:
            budget.spend(request.endpoint_key)
            if request.method == "GET":
                with requests.get(
                    request.url,
                    headers={"User-Agent": core.USER_AGENT},
                    timeout=request.timeout,
                    stream=True,
                ) as response:
                    response.raise_for_status()
                    with open(temporary, "wb") as output:
                        for chunk in response.iter_content(1 << 20):
                            if chunk:
                                output.write(chunk)
                    request.response_headers = {
                        key: response.headers[key]
                        for key in ("Content-Length", "Last-Modified")
                        if key in response.headers
                    }
            else:
                response = requests.post(
                    request.url,
                    json=request.json_body,
                    headers={"User-Agent": core.USER_AGENT},
                    timeout=request.timeout,
                )
                response.raise_for_status()
                temporary.write_bytes(response.content)
                request.response_headers = {
                    key: response.headers[key]
                    for key in ("Content-Length", "Last-Modified")
                    if key in response.headers
                }
            temporary.replace(request.destination)
            request.sha256 = sha256_file(request.destination)
        except BudgetExceededError:
            temporary.unlink(missing_ok=True)
            raise
        except Exception as exc:  # noqa: BLE001 - source failure is returned
            temporary.unlink(missing_ok=True)
            request.error = exc
        message = (
            "capture transport completed without prepared artifacts"
            if request.error is None else f"capture transport failed: {request.error}"
        )
        return {
            "soil-mukey": _artifact("raster", error=message),
            "soil-sda": _artifact("table", error=message),
        }

    overrides = sources or {}
    prepared: dict[str, dict] = {}
    source_raster: Path | None = None
    mukeys: set[int] = set()

    try:
        raster_source = overrides.get("soil-mukey")
        local = _local_path(raster_source) if raster_source is not None else None
        if local is not None:
            if not local.is_file():
                raise FileNotFoundError(local)
            source_raster = local
            returned = False
        else:
            url = raster_source or wcs_url(bounds_5070)
            budget.spend("soilweb-wcs")
            response = requests.get(
                url,
                headers={"User-Agent": core.USER_AGENT},
                timeout=180,
            )
            response.raise_for_status()
            source_raster = cache_dir / "soil-mukey-source.tif"
            source_raster.parent.mkdir(parents=True, exist_ok=True)
            source_raster.write_bytes(response.content)
            returned = True
        raster_congruence(source_raster, returned_service_raster=returned)
        observations = inspect_mukey_raster(source_raster)
        mukeys = observations["mukeys"]
        materialized = core.materialize_raster(
            str(source_raster), bounds_5070, cache_dir, "soil-mukey",
            categorical=True,
        )
        prepared["soil-mukey"] = _artifact(
            "raster",
            path=materialized,
            acquired=core.acquisition_date(materialized),
            sha256=core.materialized_sha256(materialized),
        )
    except BudgetExceededError:
        raise
    except SoilValidationError as exc:
        prepared["soil-mukey"] = _artifact("raster", error=str(exc))
    except Exception as exc:  # noqa: BLE001 - explicit source unavailability
        prepared["soil-mukey"] = _artifact(
            "raster", error=f"soil-mukey acquisition failed: {exc}"
        )

    try:
        table_source = overrides.get("soil-sda")
        local_table = _local_path(table_source) if table_source is not None else None
        if local_table is not None:
            if not local_table.is_file():
                raise FileNotFoundError(local_table)
            rows = validate_sda_rows(json.loads(local_table.read_text(encoding="utf-8")))
            table_path = local_table
        else:
            if not mukeys:
                raise SoilValidationError(
                    "soil-sda acquisition requires valid mukeys from soil-mukey"
                )

            def fetch(query: str, _index: int) -> bytes:
                budget.spend("sda-post")
                response = requests.post(
                    SDA_URL,
                    json={"query": query, "format": "JSON+COLUMNNAME"},
                    headers={"User-Agent": core.USER_AGENT},
                    timeout=300,
                )
                response.raise_for_status()
                return response.content

            rows, _ = build_sda_rows(mukeys, fetch)
            table_path = cache_dir / "soil-sda.json"
            write_json(table_path, rows)
        prepared["soil-sda"] = _artifact(
            "table",
            path=table_path,
            acquired=_today(),
            sha256=sha256_file(table_path),
        )
    except BudgetExceededError:
        raise
    except Exception as exc:  # noqa: BLE001 - explicit source unavailability
        prepared["soil-sda"] = _artifact(
            "table", error=f"soil-sda acquisition failed: {exc}"
        )
    return prepared


def _index_rows(rows: dict[str, list[dict]]) -> dict:
    mapunits: dict[str, list[dict]] = defaultdict(list)
    components: dict[str, list[dict]] = defaultdict(list)
    horizons: dict[str, list[dict]] = defaultdict(list)
    restrictions: dict[str, list[dict]] = defaultdict(list)
    texture_groups: dict[str, list[dict]] = defaultdict(list)
    textures: dict[str, list[dict]] = defaultdict(list)
    muaggatt: dict[str, list[dict]] = defaultdict(list)
    legends: dict[str, list[dict]] = defaultdict(list)
    for row in rows["mapunit"]:
        mapunits[str(row["mukey"])].append(row)
    for mukey, found in mapunits.items():
        if len(found) > 1:
            raise SoilValidationError(
                "S1 lane contract section 5.1.4: mukey resolves to more than "
                f"one mapunit row ({mukey}, {len(found)} rows)"
            )
    for row in rows["component"]:
        components[str(row["mukey"])].append(row)
    for row in rows["chorizon"]:
        horizons[str(row["cokey"])].append(row)
    for row in rows["corestrictions"]:
        restrictions[str(row["cokey"])].append(row)
    for row in rows["chtexturegrp"]:
        texture_groups[str(row["chkey"])].append(row)
    for row in rows["chtexture"]:
        textures[str(row["chtgkey"])].append(row)
    for row in rows["muaggatt"]:
        muaggatt[str(row["mukey"])].append(row)
    for row in rows["legend"]:
        legends[str(row["lkey"])].append(row)
    return {
        "mapunits": mapunits,
        "components": components,
        "horizons": horizons,
        "restrictions": restrictions,
        "texture_groups": texture_groups,
        "textures": textures,
        "muaggatt": muaggatt,
        "legends": legends,
    }


def _dominant_component(mukey: str, index: dict) -> dict | None:
    candidates = [
        row for row in index["components"].get(mukey, [])
        if _number(row.get("comppct_r")) is not None
    ]
    if not candidates:
        return None
    major = [row for row in candidates if row.get("majcompflag") == "Yes"]
    pool = major or candidates
    return min(
        pool,
        key=lambda row: (-float(_number(row["comppct_r"])),
                         _integer_key(row["cokey"])),
    )


def _mukey_root_depth(mukey: str, index: dict) -> float | None:
    weighted: list[tuple[float, float]] = []
    for component in index["components"].get(mukey, []):
        weight = _number(component.get("comppct_r"))
        if weight is None:
            continue
        cokey = str(component["cokey"])
        restriction_depths = [
            value for value in (
                _number(row.get("resdept_r"))
                for row in index["restrictions"].get(cokey, [])
            ) if value is not None
        ]
        if restriction_depths:
            depth = min(restriction_depths)
        else:
            bottoms = [
                value for value in (
                    _number(row.get("hzdepb_r"))
                    for row in index["horizons"].get(cokey, [])
                ) if value is not None
            ]
            if not bottoms:
                continue
            depth = max(bottoms)
        weighted.append((weight, depth))
    denominator = sum(weight for weight, _ in weighted)
    if denominator <= 0:
        return None
    return sum(weight * depth for weight, depth in weighted) / denominator


def _mukey_texture(mukey: str, index: dict) -> str | None:
    component = _dominant_component(mukey, index)
    if component is None:
        return None
    candidates = []
    for row in index["horizons"].get(str(component["cokey"]), []):
        top = _number(row.get("hzdept_r"))
        bottom = _number(row.get("hzdepb_r"))
        if top is None or bottom is None:
            continue
        chkey = str(row.get("chkey"))
        groups = index["texture_groups"].get(chkey, [])
        preferred = [group for group in groups if group.get("rvindicator") == "Yes"]
        pool = preferred or groups
        resolved = []
        for group in pool:
            for texture in index["textures"].get(str(group.get("chtgkey")), []):
                texcl = texture.get("texcl")
                if not isinstance(texcl, str) or not texcl:
                    continue
                resolved.append((
                    _integer_key(group.get("chtgkey")),
                    _integer_key(texture.get("chtkey")),
                    texcl,
                ))
        if not resolved:
            continue
        texture = min(resolved)[2]
        candidates.append((top, bottom, _integer_key(row.get("chkey")), texture))
    if not candidates:
        return None
    return min(candidates)[:][-1]


def weighted_percentile(values: list[tuple[float, float]], percentile: float) -> float:
    """Smallest value whose cumulative positive weight reaches percentile."""
    usable = sorted((value, weight) for value, weight in values if weight > 0)
    total = sum(weight for _, weight in usable)
    if not usable or total <= 0:
        raise ValueError("weighted percentile requires positive total weight")
    target = percentile * total
    cumulative = 0.0
    for value, weight in usable:
        cumulative += weight
        if cumulative + 1e-15 >= target:
            return value
    return usable[-1][0]


def _aws_value(mukey: str, index: dict) -> float | None:
    candidates = [
        _number(row.get("aws0150wta"))
        for row in index["muaggatt"].get(mukey, [])
    ]
    usable = [value for value in candidates if value is not None]
    if not usable:
        return None
    if any(value != usable[0] for value in usable[1:]):
        raise SoilValidationError(f"conflicting muaggatt AWS rows for mukey {mukey}")
    return usable[0]


def _provenance(mukey: str, index: dict) -> str:
    mapunit_rows = index["mapunits"].get(mukey, [])
    if len(mapunit_rows) != 1:
        raise SoilValidationError(f"cannot classify provenance for mukey {mukey}")
    legends = index["legends"].get(str(mapunit_rows[0]["lkey"]), [])
    symbols = {row.get("areasymbol") for row in legends}
    if len(symbols) != 1:
        raise SoilValidationError(f"ambiguous legend provenance for mukey {mukey}")
    return "statsgo2" if next(iter(symbols)) == "US" else "ssurgo"


def _update_unresolved(run_info: dict | None, level: int, value: dict) -> None:
    if run_info is None:
        return
    all_levels = run_info.setdefault("soilUnresolvedByCode", {})
    if not isinstance(all_levels, dict):
        raise SoilValidationError("run_info soilUnresolvedByCode must be a dict")
    all_levels[level] = value


def soil_blocks_from_histogram(
    histograms: dict[str, dict],
    rows: dict[str, list[dict]],
    *,
    level: int,
    run_info: dict | None = None,
) -> dict:
    validate_sda_rows(rows)
    validate_histogram(histograms)
    index = _index_rows(rows)
    result: dict = {}
    unresolved_by_code: dict = {}
    for code, histogram in histograms.items():
        total_area = float(histogram["totalAreaM2"])
        entries = histogram["entries"]
        unresolved: list[int] = []
        aws_items: list[tuple[float, float, str]] = []
        root_items: list[tuple[float, float]] = []
        texture_areas: dict[str, float] = defaultdict(float)
        ssurgo_area = 0.0
        statsgo_area = 0.0
        for entry in entries:
            mukey_int = int(entry["mukey"])
            mukey = str(mukey_int)
            area = float(entry["areaM2"])
            mapunit_rows = index["mapunits"].get(mukey, [])
            if not mapunit_rows:
                unresolved.append(mukey_int)
                continue
            aws_cm = _aws_value(mukey, index)
            if aws_cm is not None:
                provenance = _provenance(mukey, index)
                aws_items.append((AWS_CM_TO_MM * aws_cm, area, provenance))
                if provenance == "statsgo2":
                    statsgo_area += area
                else:
                    ssurgo_area += area
            root = _mukey_root_depth(mukey, index)
            if root is not None:
                root_items.append((root, area))
            texture = _mukey_texture(mukey, index)
            if texture is not None:
                texture_areas[texture] += area

        if unresolved:
            ordered = sorted(set(unresolved))
            unresolved_by_code[code] = {"count": len(ordered), "mukeys": ordered}

        joined_area = sum(area for _, area, _ in aws_items)
        if joined_area <= 0 or total_area <= 0:
            result[code] = {"unavailable": True, "reason": "no usable soil join"}
            continue
        mean = sum(value * area for value, area, _ in aws_items) / joined_area
        percentile_items = [(value, area) for value, area, _ in aws_items]
        root_area = sum(area for _, area in root_items)
        root_value = (
            sum(value * area for value, area in root_items) / root_area
            if root_area > 0 else None
        )
        texture_area = sum(texture_areas.values())
        dominant_texture = (
            min(texture_areas, key=lambda value: (-texture_areas[value], value))
            if texture_areas else None
        )
        provenance_area = ssurgo_area + statsgo_area
        ssurgo_fraction = ssurgo_area / provenance_area
        statsgo_fraction = statsgo_area / provenance_area
        if abs(ssurgo_fraction + statsgo_fraction - 1.0) > 1e-9:
            raise SoilValidationError("soil provenance fractions do not sum to one")
        cell_count = float(histogram["effectiveCellCount"])
        result[code] = {
            "soil": {
                "awsRootZoneMm": core.round_or_none(mean, 1),
                "awsP10": core.round_or_none(
                    weighted_percentile(percentile_items, 0.10), 1
                ),
                "awsP90": core.round_or_none(
                    weighted_percentile(percentile_items, 0.90), 1
                ),
                "rootZoneDepthCm": core.round_or_none(root_value, 1),
                "dominantTexture": dominant_texture,
                "ssurgoFraction": core.round_or_none(ssurgo_fraction, 3),
                "statsgo2Fraction": core.round_or_none(statsgo_fraction, 3),
                "coveragePct": core.round_or_none(100.0 * joined_area / total_area, 1),
                "rootZoneCoveragePct": core.round_or_none(
                    100.0 * root_area / total_area, 1
                ),
                "textureCoveragePct": core.round_or_none(
                    100.0 * texture_area / total_area, 1
                ),
                "cellCount": core.round_or_none(cell_count, 1),
                "coarse": cell_count < 30.0,
                "generalized": statsgo_fraction > 0.5,
            }
        }
    _update_unresolved(run_info, level, unresolved_by_code)
    return result


def _histograms_from_prepared_raster(
    path: Path,
    gdf: gpd.GeoDataFrame,
    code_field: str,
) -> dict[str, dict]:
    nonempty = gdf[~(gdf.geometry.is_empty | gdf.geometry.isna())]
    if nonempty.empty:
        return {}
    with rasterio.open(path) as dataset:
        frame = exact_extract(
            dataset,
            nonempty,
            ["unique", "frac", "count"],
            include_cols=[code_field],
            output="pandas",
        )
    histograms: dict[str, dict] = {}
    for row_index, (_, source_row) in enumerate(nonempty.iterrows()):
        extracted = frame.iloc[row_index]
        code = source_row[code_field]
        total_area = float(source_row.geometry.area)
        count_value = extracted.get("count")
        count = 0.0 if count_value is None or not math.isfinite(float(count_value)) \
            else float(count_value)
        valid_area = count * 900.0
        uniques = extracted.get("unique")
        fractions = extracted.get("frac")
        entries: list[dict] = []
        if uniques is not None and fractions is not None:
            for mukey, fraction in zip(uniques, fractions, strict=True):
                value = float(mukey)
                if not math.isfinite(value) or value != round(value) or value > 2 ** 24:
                    raise SoilValidationError(
                        "S1 lane contract section 4.3: invalid mukey during aggregation"
                    )
                entries.append({
                    "mukey": int(round(value)),
                    "areaM2": float(fraction) * valid_area,
                    "fraction": float(fraction),
                })
        entries.sort(key=lambda entry: entry["mukey"])
        histograms[code] = {
            "totalAreaM2": total_area,
            "validAreaM2": valid_area,
            "nodataAreaM2": max(0.0, total_area - valid_area),
            "effectiveCellCount": count,
            "entries": entries,
        }
    validate_histogram(histograms)
    return histograms


def aggregate(
    gdf: gpd.GeoDataFrame,
    code_field: str,
    *,
    prepared: dict[str, dict],
    run_info: dict | None = None,
) -> dict:
    """Aggregate prepared mukey and SDA artifacts into per-polygon blocks."""
    level = 3 if code_field == "US_L3CODE" else 4 if code_field == "US_L4CODE" else 3
    raster_entry = prepared.get("soil-mukey")
    table_entry = prepared.get("soil-sda")
    if run_info is not None and isinstance(raster_entry, dict):
        run_info["soilMukeyAcquired"] = raster_entry.get("acquired")
        run_info["soilMukeyRasterSha256"] = raster_entry.get("sha256")

    artifact_error: str | None = None
    rows: dict[str, list[dict]] | None = None
    raster_path: Path | None = None
    if not isinstance(raster_entry, dict):
        artifact_error = "missing required soil-mukey artifact"
    elif raster_entry.get("error") is not None:
        artifact_error = str(raster_entry["error"])
    elif raster_entry.get("kind") != "raster":
        artifact_error = "soil-mukey prepared artifact kind must be raster"
    else:
        raw_path = raster_entry.get("path")
        raster_path = Path(raw_path) if isinstance(raw_path, (str, Path)) else None
        try:
            if raster_path is None or not raster_path.is_file():
                raise SoilValidationError("soil-mukey prepared raster path is missing")
            raster_congruence(raster_path, returned_service_raster=False)
        except SoilValidationError as exc:
            artifact_error = str(exc)
    if artifact_error is None:
        if not isinstance(table_entry, dict):
            artifact_error = "missing required soil-sda artifact"
        elif table_entry.get("error") is not None:
            artifact_error = str(table_entry["error"])
        else:
            try:
                rows = _read_checked_table(table_entry)
            except SoilValidationError as exc:
                artifact_error = str(exc)

    if artifact_error is not None:
        out = {}
        for _, row in gdf.iterrows():
            geometry = row.geometry
            reason = "empty geometry" if geometry is None or geometry.is_empty \
                else artifact_error
            out[row[code_field]] = {"unavailable": True, "reason": reason}
        _update_unresolved(run_info, level, {})
        return out

    assert raster_path is not None and rows is not None
    histograms = _histograms_from_prepared_raster(raster_path, gdf, code_field)
    blocks = soil_blocks_from_histogram(
        histograms, rows, level=level, run_info=run_info
    )
    for _, row in gdf.iterrows():
        geometry = row.geometry
        if geometry is None or geometry.is_empty:
            blocks[row[code_field]] = {"unavailable": True, "reason": "empty geometry"}
    return blocks


def _finite_nonnegative(value: object, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise SoilValidationError(f"{label} must be a finite nonnegative number")
    parsed = float(value)
    if not math.isfinite(parsed) or parsed < 0:
        raise SoilValidationError(f"{label} must be a finite nonnegative number")
    return parsed


def validate_histogram(value: object) -> dict[str, dict]:
    if not isinstance(value, dict):
        raise SoilValidationError("S1 lane contract section 5.1.6: histogram is not an object")
    required = {
        "totalAreaM2", "validAreaM2", "nodataAreaM2",
        "effectiveCellCount", "entries",
    }
    for code, item in value.items():
        if not isinstance(code, str) or not isinstance(item, dict) or set(item) != required:
            raise SoilValidationError(
                "S1 lane contract section 5.1.6: histogram entry shape differs"
            )
        total = _finite_nonnegative(item["totalAreaM2"], "totalAreaM2")
        valid = _finite_nonnegative(item["validAreaM2"], "validAreaM2")
        nodata = _finite_nonnegative(item["nodataAreaM2"], "nodataAreaM2")
        count = _finite_nonnegative(item["effectiveCellCount"], "effectiveCellCount")
        entries = item["entries"]
        if not isinstance(entries, list):
            raise SoilValidationError("histogram entries must be a list")
        if abs(valid + nodata - total) > 1e-6 * max(total, 1.0):
            raise SoilValidationError("histogram valid plus nodata area invariant failed")
        if abs(count - valid / 900.0) > 1e-6 * max(count, 1.0):
            raise SoilValidationError("histogram effective cell count invariant failed")
        last = -1
        area_sum = 0.0
        fraction_sum = 0.0
        for entry in entries:
            if not isinstance(entry, dict) or set(entry) != {"mukey", "areaM2", "fraction"}:
                raise SoilValidationError("histogram mukey entry shape differs")
            mukey = entry["mukey"]
            if isinstance(mukey, bool) or not isinstance(mukey, int) or mukey <= last:
                raise SoilValidationError("histogram mukeys must be unique ascending integers")
            if mukey > 2 ** 24:
                raise SoilValidationError("histogram mukey exceeds 2^24")
            last = mukey
            area = _finite_nonnegative(entry["areaM2"], "entry areaM2")
            fraction = _finite_nonnegative(entry["fraction"], "entry fraction")
            if fraction > 1:
                raise SoilValidationError("histogram fraction is outside [0, 1]")
            area_sum += area
            fraction_sum += fraction
            expected = area / valid if valid > 0 else 0.0
            if abs(fraction - expected) > 1e-9:
                raise SoilValidationError("histogram fraction denominator invariant failed")
        if abs(area_sum - valid) > 1e-6 * max(valid, 1.0):
            raise SoilValidationError("histogram entry area sum invariant failed")
        if valid > 0:
            if not entries or abs(fraction_sum - 1.0) > 1e-9:
                raise SoilValidationError("histogram fraction sum invariant failed")
        elif entries:
            raise SoilValidationError("zero-valid-area histogram must have no entries")
    return value  # type: ignore[return-value]


def _date_string(value: object, label: str) -> str:
    if not isinstance(value, str) or _DATE_RE.fullmatch(value) is None:
        raise SoilValidationError(f"{label} must use YYYY-MM-DD")
    try:
        date.fromisoformat(value)
    except ValueError as exc:
        raise SoilValidationError(f"{label} is not a real date") from exc
    return value


def _digest(value: object, label: str) -> str:
    if not isinstance(value, str) or _DIGEST_RE.fullmatch(value) is None:
        raise SoilValidationError(f"{label} must be a lowercase sha256")
    return value


def _bounds(value: object, label: str) -> list[float]:
    if not isinstance(value, list) or len(value) != 4:
        raise SoilValidationError(f"{label} must be a four-number list")
    parsed = []
    for number in value:
        if isinstance(number, bool) or not isinstance(number, (int, float)) \
                or not math.isfinite(float(number)):
            raise SoilValidationError(f"{label} must contain finite numbers")
        parsed.append(float(number))
    if parsed[0] >= parsed[2] or parsed[1] >= parsed[3]:
        raise SoilValidationError(f"{label} ordering is invalid")
    return parsed


def validate_manifest(value: object) -> dict:
    required = {
        "manifestSchemaVersion", "fyLabel", "saverestMax", "saverestMin",
        "saverestCount", "rasterVintageAssumption", "tileGrid", "tiles",
        "epaBoundaryZips", "sdaQueries", "files", "captureDates",
        "requestCounts",
    }
    if not isinstance(value, dict) or set(value) != required:
        raise SoilValidationError(
            "S1 lane contract section 5.1.6: MANIFEST top-level keys differ"
        )
    if value["manifestSchemaVersion"] != "1":
        raise SoilValidationError("MANIFEST manifestSchemaVersion must be 1")
    if not isinstance(value["fyLabel"], str) or _FY_RE.fullmatch(value["fyLabel"]) is None:
        raise SoilValidationError("MANIFEST fyLabel format differs")
    _date_string(value["saverestMax"], "saverestMax")
    _date_string(value["saverestMin"], "saverestMin")
    count = value["saverestCount"]
    if isinstance(count, bool) or not isinstance(count, int) or count < 1:
        raise SoilValidationError("MANIFEST saverestCount must be an integer >= 1")
    if value["rasterVintageAssumption"] != RASTER_VINTAGE_ASSUMPTION:
        raise SoilValidationError("MANIFEST raster vintage assumption differs")

    grid = value["tileGrid"]
    grid_keys = {
        "projectedBounds5070", "snappedBounds5070", "tileSizeCells",
        "tilesX", "tilesY",
    }
    if not isinstance(grid, dict) or set(grid) != grid_keys:
        raise SoilValidationError("MANIFEST tileGrid shape differs")
    projected = _bounds(grid["projectedBounds5070"], "projectedBounds5070")
    snapped = _bounds(grid["snappedBounds5070"], "snappedBounds5070")
    expected_projected = list(transform_bounds(
        "EPSG:4326", "EPSG:5070", *core.PNW_BBOX, densify_pts=21
    ))
    if projected != expected_projected:
        raise SoilValidationError(
            "MANIFEST projectedBounds5070 differs from frozen transform_bounds"
        )
    preliminary_width = (snapped[2] - snapped[0]) / 30.0
    preliminary_height = (snapped[3] - snapped[1]) / 30.0
    if preliminary_width != round(preliminary_width) \
            or preliminary_height != round(preliminary_height):
        raise SoilValidationError("MANIFEST snapped grid cell counts are non-integral")
    if any(
        _edge_deviation(value, anchor) > 1e-9
        for value, anchor in zip(
            snapped,
            (core.GRID_ANCHOR_X, core.GRID_ANCHOR_Y,
             core.GRID_ANCHOR_X, core.GRID_ANCHOR_Y),
            strict=True,
        )
    ):
        raise SoilValidationError(
            "MANIFEST snappedBounds5070 edges are not anchor-congruent"
        )
    expected_snapped = [
        core.GRID_ANCHOR_X + math.floor(
            (expected_projected[0] - core.GRID_ANCHOR_X) / 30.0
        ) * 30.0,
        core.GRID_ANCHOR_Y + math.floor(
            (expected_projected[1] - core.GRID_ANCHOR_Y) / 30.0
        ) * 30.0,
        core.GRID_ANCHOR_X + math.ceil(
            (expected_projected[2] - core.GRID_ANCHOR_X) / 30.0
        ) * 30.0,
        core.GRID_ANCHOR_Y + math.ceil(
            (expected_projected[3] - core.GRID_ANCHOR_Y) / 30.0
        ) * 30.0,
    ]
    if snapped != expected_snapped:
        raise SoilValidationError(
            "MANIFEST snappedBounds5070 differs from frozen outward snap"
        )
    if isinstance(grid["tileSizeCells"], bool) \
            or not isinstance(grid["tileSizeCells"], int) \
            or grid["tileSizeCells"] != 5000:
        raise SoilValidationError("MANIFEST tileSizeCells must be 5000")
    width_float = (snapped[2] - snapped[0]) / 30.0
    height_float = (snapped[3] - snapped[1]) / 30.0
    width = round(width_float)
    height = round(height_float)
    if width_float != width or height_float != height:
        raise SoilValidationError("MANIFEST snapped grid cell counts are non-integral")
    expected_x = math.ceil(width / 5000)
    expected_y = math.ceil(height / 5000)
    if any(
        isinstance(grid[key], bool) or not isinstance(grid[key], int)
        for key in ("tilesX", "tilesY")
    ):
        raise SoilValidationError("MANIFEST tilesX and tilesY must be integers")
    if grid["tilesX"] != expected_x or grid["tilesY"] != expected_y:
        raise SoilValidationError("MANIFEST tile counts differ from snapped bounds")

    tiles = value["tiles"]
    if not isinstance(tiles, list) or len(tiles) != expected_x * expected_y:
        raise SoilValidationError("MANIFEST tiles list length differs")
    expected_pairs = [(ix, iy) for iy in range(expected_y) for ix in range(expected_x)]
    actual_pairs = []
    for tile in tiles:
        if not isinstance(tile, dict) or set(tile) != {"ix", "iy", "sha256"}:
            raise SoilValidationError("MANIFEST tile entry shape differs")
        if any(isinstance(tile[key], bool) or not isinstance(tile[key], int)
               for key in ("ix", "iy")):
            raise SoilValidationError("MANIFEST tile coordinates must be integers")
        actual_pairs.append((tile["ix"], tile["iy"]))
        _digest(tile["sha256"], "tile sha256")
    if actual_pairs != expected_pairs:
        raise SoilValidationError("MANIFEST tiles are not unique row-major coordinates")

    zips = value["epaBoundaryZips"]
    if not isinstance(zips, dict) or set(zips) != {"l3", "l4"}:
        raise SoilValidationError("MANIFEST epaBoundaryZips shape differs")
    for level in ("l3", "l4"):
        item = zips[level]
        if not isinstance(item, dict) or set(item) != {"filename", "sha256"} \
                or not isinstance(item["filename"], str) or not item["filename"]:
            raise SoilValidationError("MANIFEST EPA ZIP entry shape differs")
        _digest(item["sha256"], "EPA ZIP sha256")

    queries = value["sdaQueries"]
    if not isinstance(queries, list):
        raise SoilValidationError("MANIFEST sdaQueries must be a list")
    for item in queries:
        if not isinstance(item, dict) or set(item) != {"query", "responseSha256"} \
                or not isinstance(item["query"], str) or not item["query"]:
            raise SoilValidationError("MANIFEST SDA query entry shape differs")
        _digest(item["responseSha256"], "SDA response sha256")

    files = value["files"]
    expected_files = {"histogram-l3.json", "histogram-l4.json", "sda-rows.json"}
    if not isinstance(files, dict) or set(files) != expected_files:
        raise SoilValidationError("MANIFEST files map differs")
    for name, digest in files.items():
        _digest(digest, f"{name} sha256")

    dates = value["captureDates"]
    if not isinstance(dates, dict) or set(dates) != {"wcsPull", "sdaPull"}:
        raise SoilValidationError("MANIFEST captureDates shape differs")
    _date_string(dates["wcsPull"], "wcsPull")
    _date_string(dates["sdaPull"], "sdaPull")

    request_counts = value["requestCounts"]
    if not isinstance(request_counts, dict) or set(request_counts) != set(SOIL_CAPTURE_ENDPOINTS):
        raise SoilValidationError("MANIFEST requestCounts keys differ")
    for endpoint, endpoint_count in request_counts.items():
        if isinstance(endpoint_count, bool) or not isinstance(endpoint_count, int) \
                or endpoint_count < 0:
            raise SoilValidationError(f"MANIFEST request count invalid for {endpoint}")
    return value


def _read_json(path: Path, label: str) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SoilValidationError(f"{label} is unreadable JSON: {exc}") from exc


def _manifest_input_identity(manifest: dict) -> dict:
    return {
        key: manifest[key]
        for key in (
            "fyLabel",
            "saverestMax",
            "saverestMin",
            "saverestCount",
            "rasterVintageAssumption",
            "tileGrid",
            "tiles",
            "epaBoundaryZips",
            "sdaQueries",
        )
    }


def _overflow_binding_record(manifest: dict) -> dict:
    """The exact cache-to-committed-manifest identity record from capture."""
    return {
        "bindingSchemaVersion": OVERFLOW_BINDING_SCHEMA_VERSION,
        "captureSchemaVersion": CAPTURE_SCHEMA_VERSION,
        "methodVersion": SOURCE["methodVersion"],
        "inputIdentity": _manifest_input_identity(manifest),
        "files": manifest["files"],
    }


def _intermediate_data_dir(intermediates_dir: Path, manifest: dict) -> Path:
    """Resolve the 25 MB guard's cache overflow without weakening identity.

    The committed vintage directory is preferred when it contains all three
    data files. When the guard moved those files to the ruled cache path, the
    cache is usable only when its binding record exactly matches the committed
    MANIFEST and every data-file digest matches. A partial or stale cache is a
    hard stop, never a refetch or a newly minted binding.
    """
    present = [
        (intermediates_dir / name).is_file()
        for name in INTERMEDIATE_DATA_NAMES
    ]
    if all(present):
        return intermediates_dir
    if any(present):
        raise SoilValidationError(
            "S1 lane contract section 5.1.7: committed intermediate data "
            "files are partial"
        )
    overflow = (
        core.CACHE_DIR
        / "soil"
        / "intermediates-overflow"
        / manifest["fyLabel"]
    )
    overflow_present = [
        (overflow / name).is_file()
        for name in INTERMEDIATE_DATA_NAMES
    ]
    if not all(overflow_present):
        state = "partial" if any(overflow_present) else "missing"
        raise SoilValidationError(
            "S1 lane contract section 5.1.7: guard overflow data files are "
            f"{state}; soilweb-wcs ceiling 0 forbids a replacement pull"
        )
    binding_path = overflow / OVERFLOW_BINDING_NAME
    if not binding_path.is_file():
        raise SoilValidationError(
            "S1 lane contract section 5.1.7: guard overflow binding sidecar "
            "is missing"
        )
    binding = _read_json(binding_path, OVERFLOW_BINDING_NAME)
    if binding != _overflow_binding_record(manifest):
        raise SoilValidationError(
            "S1 lane contract section 5.1.7: guard overflow binding sidecar "
            "differs from the committed MANIFEST inputs"
        )
    for name in INTERMEDIATE_DATA_NAMES:
        if sha256_file(overflow / name) != manifest["files"][name]:
            raise SoilValidationError(
                "S1 lane contract section 5.1.7: guard overflow "
                f"{name} digest differs from MANIFEST.json"
            )
    return overflow


def _checked_intermediate(
    directory: Path,
    name: str,
    expected_digest: str,
    validator: Callable[[object], object],
) -> object:
    path = directory / name
    if not path.is_file() or sha256_file(path) != expected_digest:
        raise SoilValidationError(
            f"S1 lane contract section 5.1.7: {name} sha256 mismatch"
        )
    value = _read_json(path, name)
    try:
        return validator(value)
    except SoilValidationError as exc:
        raise SoilValidationError(
            f"S1 lane contract section 5.1.7: {name} structural failure: {exc}"
        ) from exc


def aggregate_from_intermediates(
    intermediates_dir: Path,
    level: int,
    *,
    run_info: dict | None = None,
) -> dict:
    if level not in (3, 4):
        raise SoilValidationError("soil intermediate level must be 3 or 4")
    manifest_value = _read_json(intermediates_dir / "MANIFEST.json", "MANIFEST.json")
    try:
        manifest = validate_manifest(manifest_value)
    except SoilValidationError as exc:
        raise SoilValidationError(
            f"S1 lane contract section 5.1.7: MANIFEST structural failure: {exc}"
        ) from exc
    data_dir = _intermediate_data_dir(intermediates_dir, manifest)
    checked: dict[str, object] = {}
    for name, validator in (
        ("histogram-l3.json", validate_histogram),
        ("histogram-l4.json", validate_histogram),
        ("sda-rows.json", validate_sda_rows),
    ):
        checked[name] = _checked_intermediate(
            data_dir, name, manifest["files"][name], validator
        )
    if run_info is not None:
        run_info["soilMukeyAcquired"] = manifest["captureDates"]["wcsPull"]
        run_info["soilMukeyRasterSha256"] = None
    return soil_blocks_from_histogram(
        checked[f"histogram-l{level}.json"],  # type: ignore[arg-type]
        checked["sda-rows.json"],  # type: ignore[arg-type]
        level=level,
        run_info=run_info,
    )


def vintage_evidence(rows: Iterable[dict]) -> dict:
    dates = []
    for row in rows:
        raw = row.get("saverest")
        if not isinstance(raw, str) or not raw.strip():
            raise SoilValidationError("sacatalog saverest is missing or malformed")
        stamp = None
        if len(raw) >= 10:
            candidate = raw[:10]
            try:
                stamp = date.fromisoformat(candidate).isoformat()
            except ValueError:
                pass
        if stamp is None:
            for pattern in (
                "%b %d %Y %I:%M%p",
                "%b %d %Y",
                "%m/%d/%Y %I:%M:%S %p",
                "%m/%d/%Y",
            ):
                try:
                    stamp = datetime.strptime(raw.strip(), pattern).date().isoformat()
                    break
                except ValueError:
                    continue
        if stamp is None:
            raise SoilValidationError(
                f"sacatalog saverest is missing or malformed: {raw!r}"
            )
        dates.append(stamp)
    if not dates:
        raise SoilValidationError("sacatalog evidence sample is empty")
    maximum = max(dates)
    minimum = min(dates)
    parsed = date.fromisoformat(maximum)
    fiscal_year = parsed.year + (1 if parsed.month >= 10 else 0)
    return {
        "fyLabel": f"FY{fiscal_year}",
        "saverestMax": maximum,
        "saverestMin": minimum,
        "saverestCount": len(dates),
    }


def drift_check(intermediates_dir: Path, budget: RequestBudget) -> dict:
    manifest_value = _read_json(intermediates_dir / "MANIFEST.json", "MANIFEST.json")
    try:
        manifest = validate_manifest(manifest_value)
    except SoilValidationError as exc:
        raise SoilValidationError(
            f"S1 lane contract section 5.1.7: MANIFEST structural failure: {exc}"
        ) from exc
    data_dir = _intermediate_data_dir(intermediates_dir, manifest)
    rows = _checked_intermediate(
        data_dir,
        "sda-rows.json",
        manifest["files"]["sda-rows.json"],
        validate_sda_rows,
    )
    recorded = {
        key: manifest[key]
        for key in ("fyLabel", "saverestMax", "saverestMin", "saverestCount")
    }
    derived = vintage_evidence(rows["sacatalog"])  # type: ignore[index]
    if derived != recorded:
        raise SoilValidationError(
            "S1 lane contract section 5.1.7: MANIFEST vintage tuple does not "
            "match captured sda-rows.json"
        )
    area_symbols = sorted({
        str(row["areasymbol"]) for row in rows["sacatalog"]  # type: ignore[index]
    })
    quoted = ",".join("'" + value.replace("'", "''") + "'" for value in area_symbols)
    query = (
        "SELECT areasymbol, saverest FROM sacatalog "
        f"WHERE areasymbol IN ({quoted}) ORDER BY areasymbol, saverest"
    )
    budget.spend("sda-post")
    response = requests.post(
        SDA_URL,
        json={"query": query, "format": "JSON+COLUMNNAME"},
        headers={"User-Agent": core.USER_AGENT},
        timeout=300,
    )
    response.raise_for_status()
    content = response.content
    try:
        payload = json.loads(content)
        raw = payload["Table"]
        if raw[0] != ["areasymbol", "saverest"]:
            raise ValueError("column header differs")
        current_rows = [dict(zip(raw[0], values, strict=True)) for values in raw[1:]]
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise SoilValidationError(f"invalid drift-check SDA response: {exc}") from exc
    current = vintage_evidence(current_rows)
    return {"recorded": recorded, "current": current, "drift": current != recorded}


def unit_cross_check(rows: dict[str, list[dict]]) -> dict:
    """Run the mandatory chorizon-to-muaggatt centimeter unit check."""
    validate_sda_rows(rows)
    index = _index_rows(rows)
    ordered: list[tuple[float, str]] = []
    for mukey, candidates in index["muaggatt"].items():
        aws = _aws_value(mukey, index)
        if aws is not None:
            ordered.append((aws, mukey))
    ordered.sort(key=lambda item: (item[0], _integer_key(item[1])))

    profiles: dict[str, dict] = {}
    for _, mukey in ordered:
        component_values = []
        for component in index["components"].get(mukey, []):
            weight = _number(component.get("comppct_r"))
            if weight is None:
                continue
            usable_horizons = []
            profile_cm = 0.0
            for horizon in index["horizons"].get(str(component["cokey"]), []):
                awc = _number(horizon.get("awc_r"))
                top = _number(horizon.get("hzdept_r"))
                bottom = _number(horizon.get("hzdepb_r"))
                if awc is None or top is None or bottom is None:
                    continue
                thickness = max(0.0, min(bottom, 150.0) - min(top, 150.0))
                contribution = awc * thickness
                profile_cm += contribution
                usable_horizons.append({
                    "chkey": horizon["chkey"],
                    "awc_r": awc,
                    "hzdept_r": top,
                    "hzdepb_r": bottom,
                    "contributionCm": contribution,
                })
            if usable_horizons:
                component_values.append({
                    "cokey": component["cokey"],
                    "comppct_r": weight,
                    "profileAwsCm": profile_cm,
                    "horizons": usable_horizons,
                })
        denominator = sum(item["comppct_r"] for item in component_values)
        if denominator > 0:
            derived_cm = sum(
                item["comppct_r"] * item["profileAwsCm"]
                for item in component_values
            ) / denominator
            profiles[mukey] = {
                "derivedCm": derived_cm,
                "components": component_values,
            }

    if not ordered:
        raise SoilValidationError(
            "S1 lane contract section 5.1.3: insufficient unit cross-check sample"
        )
    raw_indices = [math.floor(k * (len(ordered) - 1) / 9) for k in range(10)]
    selected_indices = list(dict.fromkeys(raw_indices))
    chosen: list[int] = []
    chosen_mukeys: set[str] = set()
    skipped: list[dict] = []
    for selected in selected_indices:
        replacement = None
        for position in range(selected, len(ordered)):
            mukey = ordered[position][1]
            if mukey in profiles and mukey not in chosen_mukeys:
                replacement = position
                break
        if replacement is None:
            skipped.append({"selectedMukey": ordered[selected][1], "reason": "no next usable mukey"})
            continue
        if replacement != selected:
            skipped.append({
                "selectedMukey": ordered[selected][1],
                "reason": "unusable horizons",
                "replacementMukey": ordered[replacement][1],
            })
        chosen.append(replacement)
        chosen_mukeys.add(ordered[replacement][1])

    sample = []
    passing = 0
    ratios = []
    for position in chosen:
        aws, mukey = ordered[position]
        derived_cm = profiles[mukey]["derivedCm"]
        within = derived_cm == 0.0 if aws == 0.0 else abs(derived_cm - aws) / abs(aws) <= 0.15
        passing += int(within)
        ratio = None if aws == 0 else derived_cm / aws
        if ratio is not None:
            ratios.append(ratio)
        sample.append({
            "mukey": int(mukey),
            "aws0150wtaCm": aws,
            "derivedProfileCm": derived_cm,
            "ratioDerivedCmToMuaggatt": ratio,
            "within15Pct": within,
            "components": profiles[mukey]["components"],
        })
    verdict = len(sample) >= 8 and passing >= 8
    near_tenfold_or_tenth = bool(ratios) and (
        sum(0.08 <= ratio <= 0.12 or 8.0 <= ratio <= 12.0 for ratio in ratios)
        >= max(1, math.ceil(0.8 * len(ratios)))
    )
    receipt = {
        "orderedCandidateCount": len(ordered),
        "usableProfileCount": len(profiles),
        "selectedCount": len(sample),
        "passingCount": passing,
        "systematicNear10xOr0_1x": near_tenfold_or_tenth,
        "skipped": skipped,
        "sample": sample,
        "verdict": "PASS" if verdict and not near_tenfold_or_tenth else "FAIL",
    }
    if receipt["verdict"] != "PASS":
        raise SoilValidationError(
            "S1 lane contract section 5.1.3: unit cross-check failed "
            f"({passing}/{len(sample)} within 15 percent, "
            f"near10xOr0.1x={near_tenfold_or_tenth})"
        )
    return receipt


def discriminator_counts(mukeys: Iterable[int], rows: dict[str, list[dict]]) -> dict:
    index = _index_rows(rows)
    counts = {"ssurgo": 0, "statsgo2": 0, "unresolved": 0}
    for value in sorted(set(int(item) for item in mukeys)):
        mukey = str(value)
        if not index["mapunits"].get(mukey):
            counts["unresolved"] += 1
            continue
        counts[_provenance(mukey, index)] += 1
    if counts["ssurgo"] == 0 or counts["statsgo2"] == 0:
        raise SoilValidationError(
            "S1 lane contract section 5.1.4: SSURGO/STATSGO2 discriminator "
            f"sanity check failed ({counts})"
        )
    return counts


def subset_sda_rows(rows: dict[str, list[dict]], mukeys: Iterable[int]) -> dict[str, list[dict]]:
    """Restrict the frozen table closure to a fixture mukey set."""
    wanted = {str(int(value)) for value in mukeys}
    mapunit = [row for row in rows["mapunit"] if str(row["mukey"]) in wanted]
    lkeys = {str(row["lkey"]) for row in mapunit}
    legend = [row for row in rows["legend"] if str(row["lkey"]) in lkeys]
    symbols = {str(row["areasymbol"]) for row in legend}
    component = [row for row in rows["component"] if str(row["mukey"]) in wanted]
    cokeys = {str(row["cokey"]) for row in component}
    horizons = [row for row in rows["chorizon"] if str(row["cokey"]) in cokeys]
    chkeys = {str(row["chkey"]) for row in horizons}
    texture_groups = [
        row for row in rows["chtexturegrp"] if str(row["chkey"]) in chkeys
    ]
    chtgkeys = {str(row["chtgkey"]) for row in texture_groups}
    subset = {
        "sacatalog": [row for row in rows["sacatalog"] if str(row["areasymbol"]) in symbols],
        "muaggatt": [row for row in rows["muaggatt"] if str(row["mukey"]) in wanted],
        "component": component,
        "chorizon": horizons,
        "chtexturegrp": texture_groups,
        "chtexture": [
            row for row in rows["chtexture"] if str(row["chtgkey"]) in chtgkeys
        ],
        "corestrictions": [row for row in rows["corestrictions"] if str(row["cokey"]) in cokeys],
        "mapunit": mapunit,
        "legend": legend,
    }
    validate_sda_rows(subset)
    return subset
