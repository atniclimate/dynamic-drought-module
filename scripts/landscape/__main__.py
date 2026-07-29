"""Command-line interface for the landscape-signature build.

Usage (from the repository root, through the pinned project environment):
  .venv/Scripts/python.exe -m scripts.landscape --smoke
      Run the North Cascades terrain smoke path.
  .venv/Scripts/python.exe -m scripts.landscape
      Build all accepted families for Level III and Level IV ecoregions.
  .venv/Scripts/python.exe -m scripts.landscape --only terrain --level 3
      Restrict a build for a focused receipt or fixture capture.

The default full build uses Contract B acquisition for terrain and
land-cover/fuels, consumes soil only from the digest-bound FY2025
intermediates, runs the Soil Data Access vintage drift check, and emits one
closed snapshot. ``--retrieved`` (or DDM_RETRIEVED_DATE) pins the top-level
artifact stamp for byte reproducibility. Per-source acquisition dates always
come from the checked cache or intermediate identity record.
"""
from __future__ import annotations

import argparse
import ctypes
import ctypes.wintypes as wintypes
import hashlib
import json
import math
import os
import re
import shutil
import time
from pathlib import Path

from scripts.landscape import core
from scripts.landscape.adapters import landcover_fuels, soil, terrain


FAMILY_ORDER = ("terrain", "soil", "landcoverFuels")
SOIL_INTERMEDIATES = (
    core.REPO_ROOT
    / "scripts"
    / "landscape"
    / "intermediates"
    / "soil"
    / "FY2025"
)
BUILD_CEILINGS = {
    "soilweb-wcs": 0,
    "sda-post": 3,
    "lfps-exportimage": 100,
    "mrlc-wcs": 90,
    "rds-whp-zip": 3,
    "landfire-bulk-zip": 4,
    "epa-s3": 4,
    "metadata": 10,
}
# Full-extent ceiling: the measured first full-PNW baseline is 25,217
# requests (build 4, 2026-07-25, post-hoc log count); 32,000 gives the
# contract's standard headroom. The prior 6,000 was calibrated on the
# North Cascades smoke extent under a same-extent premise later proven
# false; the contract row carries both measurements.
TNM_VSICURL_CEILING = 32000
_DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes((json.dumps(value, indent=2) + "\n").encode("utf-8"))


def _peak_working_set_bytes() -> int | None:
    """Return the Win32 process high-water mark with a correctly typed handle."""
    if os.name != "nt":
        return None

    class ProcessMemoryCounters(ctypes.Structure):
        _fields_ = [
            ("cb", wintypes.DWORD),
            ("PageFaultCount", wintypes.DWORD),
            ("PeakWorkingSetSize", ctypes.c_size_t),
            ("WorkingSetSize", ctypes.c_size_t),
            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
            ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
            ("PagefileUsage", ctypes.c_size_t),
            ("PeakPagefileUsage", ctypes.c_size_t),
        ]

    kernel32 = ctypes.windll.kernel32
    kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    query = kernel32.K32GetProcessMemoryInfo
    query.argtypes = [
        wintypes.HANDLE,
        ctypes.POINTER(ProcessMemoryCounters),
        wintypes.DWORD,
    ]
    query.restype = wintypes.BOOL
    counters = ProcessMemoryCounters()
    counters.cb = ctypes.sizeof(counters)
    handle = kernel32.GetCurrentProcess()
    if not query(handle, ctypes.byref(counters), counters.cb):
        return None
    return int(counters.PeakWorkingSetSize)


def _normalize_families(raw: list[str]) -> list[str]:
    aliases = {
        "terrain": "terrain",
        "soil": "soil",
        "fuels": "landcoverFuels",
        "landcover": "landcoverFuels",
        "landcoverfuels": "landcoverFuels",
        "landcover-fuels": "landcoverFuels",
    }
    selected = set()
    for value in raw:
        key = value.strip().lower()
        if key not in aliases:
            raise ValueError(
                f"unknown family {value!r}; choose terrain, soil, fuels, "
                "landcover, or landcoverFuels"
            )
        selected.add(aliases[key])
    return [family for family in FAMILY_ORDER if family in selected]


def _levels(value: str) -> list[int]:
    return [3] if value == "3" else [4] if value == "4" else [3, 4]


def _union_bounds(gdfs) -> tuple[float, float, float, float] | None:
    boxes = []
    for gdf in gdfs:
        nonempty = gdf[~(gdf.geometry.is_empty | gdf.geometry.isna())]
        if not nonempty.empty:
            boxes.append(nonempty.total_bounds)
    if not boxes:
        return None
    return (
        min(box[0] for box in boxes),
        min(box[1] for box in boxes),
        max(box[2] for box in boxes),
        max(box[3] for box in boxes),
    )


def _resolve_retrieved(override: str | None, run_info: dict) -> str:
    pinned = core.retrieved_date(override)
    if override or core.RETRIEVED_ENV in os.environ:
        return pinned
    acquired = sorted({
        value
        for key, value in run_info.items()
        if key.endswith("Acquired")
        and isinstance(value, str)
        and _DATE_RE.fullmatch(value)
    })
    return acquired[-1] if acquired else pinned


def _source_config(families: list[str]) -> dict[str, dict]:
    sources: dict[str, dict] = {}
    if "terrain" in families:
        sources["terrain"] = terrain.SOURCE
    if "soil" in families:
        sources["soilMukey"] = soil.SOURCE_MUKEY
        sources["soilSda"] = soil.SOURCE_SDA
    if "landcoverFuels" in families:
        sources["fuelsFbfm40"] = landcover_fuels.SOURCE_FBFM40
        sources["fuelsEvt"] = landcover_fuels.SOURCE_EVT
        sources["landcoverNlcd"] = landcover_fuels.SOURCE_NLCD
        sources["hazardWhp"] = landcover_fuels.SOURCE_WHP
    return sources


def _provenance(run_info: dict, families: list[str]) -> dict[str, dict]:
    def raster(stem: str) -> dict:
        return {
            "acquired": run_info.get(f"{stem}Acquired"),
            "materializedRasterSha256": run_info.get(f"{stem}RasterSha256"),
        }

    provenance: dict[str, dict] = {}
    if "terrain" in families:
        provenance["terrain"] = raster("terrain")
    if "soil" in families:
        provenance["soilMukey"] = raster("soilMukey")
        provenance["soilSda"] = raster("soilSda")
    if "landcoverFuels" in families:
        provenance["fuelsFbfm40"] = raster("fuelsFbfm40")
        provenance["fuelsEvt"] = raster("fuelsEvt")
        provenance["landcoverNlcd"] = raster("landcoverNlcd")
        provenance["hazardWhp"] = raster("hazardWhp")
    return provenance


def _load_soil_manifest() -> dict:
    try:
        value = json.loads(
            (SOIL_INTERMEDIATES / "MANIFEST.json").read_text(encoding="utf-8")
        )
    except (OSError, json.JSONDecodeError) as exc:
        raise soil.SoilValidationError(
            f"soil MANIFEST is unavailable: {exc}"
        ) from exc
    return soil.validate_manifest(value)


def _prime_epa_cache(manifest: dict) -> None:
    """Copy only digest-validated capture ZIPs into core's shared cache."""
    for level in ("l3", "l4"):
        record = manifest["epaBoundaryZips"][level]
        filename = record["filename"]
        expected = record["sha256"]
        captured = core.CACHE_DIR / "soil" / filename
        shared = core.CACHE_DIR / filename
        if shared.is_file():
            if _sha256_file(shared) != expected:
                raise RuntimeError(
                    f"shared {filename} cache identity differs from the "
                    "committed soil MANIFEST"
                )
            continue
        if not captured.is_file() or _sha256_file(captured) != expected:
            raise RuntimeError(
                f"captured {filename} cache identity differs from the "
                "committed soil MANIFEST"
            )
        shared.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(captured, shared)
        if _sha256_file(shared) != expected:
            shared.unlink(missing_ok=True)
            raise RuntimeError(f"copied {filename} failed its digest check")


def _combined_spend_counts(*budgets) -> dict[str, int]:
    counts = {key: 0 for key in BUILD_CEILINGS}
    for budget in budgets:
        for key, value in budget.counts.items():
            counts[key] = counts.get(key, 0) + value
    for key, ceiling in BUILD_CEILINGS.items():
        if counts.get(key, 0) > ceiling:
            raise RuntimeError(
                f"combined request count for {key} is {counts[key]}, above "
                f"the section 8 ceiling {ceiling}"
            )
    return counts


def _sum_within(values: list[float], label: str) -> None:
    tolerance = len(values) * 0.0005 + 1e-9
    if abs(math.fsum(values) - 1.0) > tolerance:
        raise ValueError(
            f"{label} serialized partition sums to {math.fsum(values)}, "
            f"outside tolerance {tolerance}"
        )


def validate_snapshot_invariants(
    snapshot: dict,
    families: list[str],
) -> None:
    """Fail closed on the cross-field arithmetic the JSON schema cannot do."""
    required_sources = {
        "terrain": {"terrain"},
        "soil": {"soilMukey", "soilSda"},
        "landcoverFuels": {
            "fuelsFbfm40",
            "fuelsEvt",
            "landcoverNlcd",
            "hazardWhp",
        },
    }
    for family in families:
        missing = required_sources[family] - set(snapshot["sources"])
        if missing:
            raise ValueError(f"{family} is missing source rows {sorted(missing)}")
    for key, source in snapshot["sources"].items():
        if not isinstance(source.get("vintage"), str) or not source["vintage"]:
            raise ValueError(f"source {key} is missing its pinned vintage")
        resolution = source.get("resolutionMeters")
        if key == "soilSda":
            if resolution is not None:
                raise ValueError("soilSda resolutionMeters must be null")
        elif not isinstance(resolution, (int, float)) or resolution <= 0:
            raise ValueError(f"source {key} has invalid resolutionMeters")

    for code, bundle in snapshot["bundles"].items():
        for family in families:
            if family not in bundle:
                raise ValueError(f"bundle {code} is missing selected family {family}")
        ledger = bundle.get("unavailable")
        if (
            not isinstance(ledger, list)
            or ledger != sorted(set(ledger))
            or any(not isinstance(item, str) for item in ledger)
        ):
            raise ValueError(f"bundle {code} unavailable ledger is not canonical")

        terrain_value = bundle.get("terrain")
        if isinstance(terrain_value, dict) and "elevBands" in terrain_value:
            _sum_within(terrain_value["elevBands"], f"{code} terrain elevBands")
            distribution = terrain_value["aspectDistribution"]
            _sum_within(
                list(distribution.values()),
                f"{code} terrain aspectDistribution",
            )

        soil_value = bundle.get("soil")
        if isinstance(soil_value, dict) and not soil_value.get("unavailable"):
            _sum_within(
                [
                    soil_value["ssurgoFraction"],
                    soil_value["statsgo2Fraction"],
                ],
                f"{code} soil provenance",
            )

        family_value = bundle.get("landcoverFuels")
        if not isinstance(family_value, dict) or family_value.get("unavailable"):
            continue
        fbfm = family_value["fbfm40"]
        if not fbfm.get("unavailable"):
            fractions = [
                fbfm["nonburnableFraction"],
                *(item["fraction"] for item in fbfm["classes"]),
                fbfm["otherBurnableFraction"],
            ]
            _sum_within(fractions, f"{code} FBFM40")
        landcover = family_value["landcover"]
        if not landcover.get("unavailable"):
            subsets = [
                landcover["forestFraction"],
                landcover["croplandFraction"],
                landcover["wetlandFraction"],
                landcover["openWaterFraction"],
            ]
            if math.fsum(subsets) > 1.0 + len(subsets) * 0.0005 + 1e-9:
                raise ValueError(f"{code} NLCD disjoint subset sum exceeds one")
        whp = family_value["whp"]
        if not whp.get("unavailable"):
            _sum_within(
                list(whp["classFractions"].values()),
                f"{code} WHP",
            )


def run_smoke(output: Path | None, retrieved: str | None) -> int:
    core.log("SMOKE TEST: North Cascades (Level III) terrain via 3DEP + exactextract")
    started = time.time()
    gdf = core.load_ecoregions(3)
    nc = gdf[gdf["US_L3NAME"] == "North Cascades"]
    if nc.empty:
        core.log("  ERROR: North Cascades not found")
        return 1
    bounds = _union_bounds([nc])
    if bounds is None:
        core.log("  ERROR: North Cascades has no nonempty geometry")
        return 1
    budget = terrain.RequestBudget({"metadata": BUILD_CEILINGS["metadata"]})
    prepared = terrain.acquire(bounds, core.CACHE_DIR, budget)
    run_info: dict = {}
    result = terrain.aggregate(
        nc,
        "US_L3CODE",
        prepared=prepared,
        run_info=run_info,
    )
    if output is not None:
        snapshot = core.build_snapshot(
            levels=[3],
            only=["terrain"],
            sources=_source_config(["terrain"]),
            family_results={3: {"terrain": result}},
            gdfs={3: nc},
            retrieved=_resolve_retrieved(retrieved, run_info),
            provenance=_provenance(run_info, ["terrain"]),
            diagnostics=run_info,
        )
        validate_snapshot_invariants(snapshot, ["terrain"])
        core.write_snapshot(snapshot, output)
    core.log(f"SMOKE TEST OK ({time.time() - started:.1f}s total)")
    return 0


def _full_build(
    families: list[str],
    levels: list[int],
    output: Path,
    retrieved: str | None,
    receipt_path: Path | None,
) -> int:
    started = time.perf_counter()
    soil_manifest = (
        _load_soil_manifest()
        if {"soil", "landcoverFuels"} & set(families)
        else None
    )
    if soil_manifest is not None:
        _prime_epa_cache(soil_manifest)

    gdfs = {level: core.load_ecoregions(level) for level in levels}
    union_bounds = _union_bounds(gdfs.values())
    if union_bounds is None:
        raise RuntimeError("selected ecoregions have no nonempty geometry")

    terrain_budget = terrain.RequestBudget(
        {"metadata": BUILD_CEILINGS["metadata"]}
    )
    soil_budget = soil.RequestBudget({
        "soilweb-wcs": BUILD_CEILINGS["soilweb-wcs"],
        "sda-post": BUILD_CEILINGS["sda-post"],
        "epa-s3": BUILD_CEILINGS["epa-s3"],
        "metadata": BUILD_CEILINGS["metadata"],
    })
    landcover_budget = landcover_fuels.RequestBudget({
        "lfps-exportimage": BUILD_CEILINGS["lfps-exportimage"],
        "mrlc-wcs": BUILD_CEILINGS["mrlc-wcs"],
        "rds-whp-zip": BUILD_CEILINGS["rds-whp-zip"],
        "landfire-bulk-zip": BUILD_CEILINGS["landfire-bulk-zip"],
        "epa-s3": BUILD_CEILINGS["epa-s3"],
        "metadata": BUILD_CEILINGS["metadata"],
    })
    run_info: dict = {}
    prepared_terrain = None
    prepared_landcover = None
    drift = None

    if "terrain" in families:
        prepared_terrain = terrain.acquire(
            union_bounds,
            core.CACHE_DIR,
            terrain_budget,
        )
    if "landcoverFuels" in families:
        analysis_bounds = (
            tuple(soil_manifest["tileGrid"]["snappedBounds5070"])
            if soil_manifest is not None
            else union_bounds
        )
        prepared_landcover = landcover_fuels.acquire(
            analysis_bounds,
            core.CACHE_DIR,
            landcover_budget,
        )
    if "soil" in families:
        drift = soil.drift_check(SOIL_INTERMEDIATES, soil_budget)
        if drift["drift"]:
            core.log(
                "  WARNING: Soil Data Access vintage drift detected; pinned "
                "FY2025 remains in use pending section 3 review"
            )
        run_info["soilSdaAcquired"] = soil_manifest["captureDates"]["sdaPull"]
        run_info["soilSdaRasterSha256"] = None

    family_results: dict[int, dict[str, dict]] = {}
    for level in levels:
        code_field = "US_L3CODE" if level == 3 else "US_L4CODE"
        result: dict[str, dict] = {}
        if prepared_terrain is not None:
            result["terrain"] = terrain.aggregate(
                gdfs[level],
                code_field,
                prepared=prepared_terrain,
                run_info=run_info,
            )
        if "soil" in families:
            result["soil"] = soil.aggregate_from_intermediates(
                SOIL_INTERMEDIATES,
                level,
                run_info=run_info,
            )
        if prepared_landcover is not None:
            result["landcoverFuels"] = landcover_fuels.aggregate(
                gdfs[level],
                code_field,
                prepared=prepared_landcover,
                run_info=run_info,
            )
        family_results[level] = result

    snapshot = core.build_snapshot(
        levels=levels,
        only=families,
        sources=_source_config(families),
        family_results=family_results,
        gdfs=gdfs,
        retrieved=_resolve_retrieved(retrieved, run_info),
        provenance=_provenance(run_info, families),
        diagnostics=run_info,
    )
    validate_snapshot_invariants(snapshot, families)
    core.write_snapshot(snapshot, output)

    spend_counts = _combined_spend_counts(
        terrain_budget,
        soil_budget,
        landcover_budget,
    )
    if spend_counts["soilweb-wcs"] != 0:
        raise RuntimeError(
            "soilweb-wcs count is nonzero; section 5.1.7 requires the "
            "zero-refetch intermediates path"
        )
    if receipt_path is not None:
        ledger_entries = sum(
            len(bundle["unavailable"])
            for bundle in snapshot["bundles"].values()
        )
        receipt = {
            "unit": "T-S1-4",
            "contractRevision": 14,
            "exit": 0,
            "wallSeconds": time.perf_counter() - started,
            "peakWorkingSetBytes": _peak_working_set_bytes(),
            "families": families,
            "levels": levels,
            "spendRequestCounts": spend_counts,
            "spendRequestCeilings": BUILD_CEILINGS,
            "tnmS3Vsicurl": {
                "enforcement": "instrumented post-run receipt",
                # The in-process build cannot count GDAL-internal requests;
                # the post-run instrument (the retained CPL_CURL_VERBOSE log,
                # counted by the L1 rule) replaces this block. Measurement
                # state is never implicit: null count is only valid beside
                # the explicit not-measured status.
                "requestCount": None,
                "measurementStatus": "not-measured-in-process",
                "ceiling": TNM_VSICURL_CEILING,
            },
            "soilDrift": drift,
            "artifact": str(output.resolve()),
            "artifactBytes": output.stat().st_size,
            "artifactSha256": _sha256_file(output),
            "bundleCount": len(snapshot["bundles"]),
            "unavailableLedgerEntryCount": ledger_entries,
            "soilUnresolvedByCode": run_info.get(
                "soilUnresolvedByCode",
                {},
            ),
        }
        _write_json(receipt_path, receipt)
    return 0


def _soil_drift_check() -> int:
    """Run the standing Soil Data Access vintage row with its frozen bound."""
    budget = soil.RequestBudget({
        "soilweb-wcs": 0,
        "sda-post": BUILD_CEILINGS["sda-post"],
        "epa-s3": 0,
        "metadata": 0,
    })
    result = soil.drift_check(SOIL_INTERMEDIATES, budget)
    print(json.dumps({
        "row": "landscapeSoilVintage",
        "pinned": soil.SOURCE_SDA["vintage"],
        "requestCounts": budget.counts,
        **result,
    }, separators=(",", ":")))
    return 0


def main(argv: list[str] | None = None, prog: str | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog=prog,
        description="Build the Pacific Northwest landscape signature.",
    )
    ap.add_argument(
        "--smoke",
        action="store_true",
        help="validate the terrain path on North Cascades",
    )
    ap.add_argument(
        "--soil-drift-check",
        action="store_true",
        help="run only the bounded Soil Data Access vintage drift row",
    )
    ap.add_argument(
        "--output",
        type=Path,
        default=None,
        help="write to this path instead of the default public artifact",
    )
    ap.add_argument(
        "--receipt",
        type=Path,
        default=None,
        help="write a machine-readable full-build receipt",
    )
    ap.add_argument(
        "--only",
        nargs="*",
        default=list(FAMILY_ORDER),
        help="families to run (terrain soil fuels landcover)",
    )
    ap.add_argument(
        "--level",
        choices=["3", "4", "both"],
        default="both",
        help="ecoregion level(s)",
    )
    ap.add_argument(
        "--retrieved",
        default=None,
        help="pin the artifact retrieval stamp (YYYY-MM-DD)",
    )
    args = ap.parse_args(argv)

    if args.soil_drift_check:
        if args.smoke or args.output is not None or args.receipt is not None:
            ap.error(
                "--soil-drift-check cannot be combined with --smoke, "
                "--output, or --receipt"
            )
        return _soil_drift_check()
    if args.smoke:
        if args.receipt is not None:
            ap.error("--receipt is available on the full build path only")
        return run_smoke(args.output, args.retrieved)
    try:
        families = _normalize_families(args.only)
    except ValueError as exc:
        ap.error(str(exc))
    if not families:
        ap.error("--only must select at least one family")
    output = args.output or core.OUT_PATH
    return _full_build(
        families,
        _levels(args.level),
        output,
        args.retrieved,
        args.receipt,
    )


if __name__ == "__main__":
    raise SystemExit(main(prog="python -m scripts.landscape"))
