# Scaffold origin

This repository was scaffolded on 2026-07-29 from the working application
in `C:\dev\dynamic-drought-module`.

## Donor baseline

- Branch: `main`
- Commit: `2813898`
- Application version: `0.6.24`
- Donor treatment: read-only
- History treatment: no donor `.git` directory or commit history copied

The donor working tree had one pre-existing modification:
`post-mortem/POST_MORTEM.md`. It was outside the application allowlist.
The `POST_MORTEM.md` already present in this workspace was preserved.

## Included

- Root build and editor configuration
- `src/`
- `public/`
- `tests/`, except the old release-orchestrator integrity spec
- `schema/`
- Product validation and data-building scripts
- `workers/proxy/`, without local Wrangler state
- Generated `docs/COVERAGE_MATRIX.md`
- The ATNI license and public README

## Deliberately excluded

- Donor Git history and remotes
- `harness/`, `.claude/`, handoffs, review archives, and process ledgers
- Historical roadmaps, change ledgers, phase plans, and archived designs
- Donor deployment and release scripts tied to `C:\dev\ddm-public`
- The process-only harness gate and pickup helper
- The standalone Montana Climate Office transport spike
- The hillshade builder that wrote its report into the old harness
- Dependencies, builds, reports, caches, Python environments, local
  Wrangler state, staging tiles, and other machine-local artifacts
- Unmerged feature branches, including the main-screen and heat lanes

Those exclusions are boundaries, not disposal decisions. The donor remains
available as a read-only estate for later, explicit feature imports.
