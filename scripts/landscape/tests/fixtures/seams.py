"""Shared determinism-seam constants for fixture capture AND parity
enforcement (T-M0-3). Both capture_corrected.py and tests/test_parity.py
import these so the pipeline that captures the corrected/ fixtures and the
pipeline that enforces them are patched identically; a drift between the
two would otherwise let capture and enforcement disagree silently.

- FIXED_DATE pins the artifact retrieval stamp AND the acquisition clock
  (core._acquisition_stamp), so the REAL sidecar-to-snapshot acquisition
  flow runs deterministically in fixtures.
- SENTINEL_SHA256 replaces core.materialized_sha256's return value in
  fixture runs: 64 hex zeros, obviously not a real digest, declared in
  delta-manifest.json as an injected fixture-stability constant. This
  keeps the byte-pinned fixtures independent of platform GeoTIFF encoder
  bytes; the real sidecar-sha linkage is covered by dedicated unittests
  (tests/test_core.py), not by fixture byte-pins.
"""

FIXED_DATE = "2026-01-01"
SENTINEL_SHA256 = "0" * 64
