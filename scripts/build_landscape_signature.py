"""Compatibility shim: the landscape-signature build now lives in the
scripts/landscape package (T-M0-1 extraction; parity pinned in
scripts/landscape/tests/fixtures/legacy/).

Preferred invocation:
  .venv/Scripts/python.exe -m scripts.landscape [--smoke [--output <path>]]
This shim keeps the historical entry point working:
  .venv/Scripts/python.exe scripts/build_landscape_signature.py ...
"""
from __future__ import annotations

import sys
from pathlib import Path

# Running as a plain script means the repository root may not be on sys.path;
# add it so the scripts.landscape package resolves.
REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts.landscape.__main__ import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
