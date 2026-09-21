# Resilience Budget: Project State

External memory for the long-run build. Every session starts here: read this
file, then `docs/ARCHITECTURE.md`, then open `dev_map.html`. Every session ends
by updating the three of them.

| Field | Value |
|---|---|
| Current version | v0.1, The Spine |
| Phase step | 1 of 5, Goal setting and interview (questions asked, answers pending) |
| Last updated | 2026-09-21 |
| Location | `resilience-budget/` in `atniclimate/dynamic-drought-module`, branch `claude/resilience-budget-v0-1-vn2zq1` |
| Dev map | `resilience-budget/dev_map.html` is the source of truth; published copy: https://claude.ai/artifact/KdaoLHYQEq4wv8AdRPhJsW |
| Waiting on | Owner answers to Q1 to Q3 below; owner decision on the repository home |

## Phase lifecycle (every version)

1. Goal setting and interview
2. Research and architecture
3. Implementation
4. Validation and review
5. Milestone assessment and state saving

A phase does not advance until its done criteria are met and the owner confirms.

## Roadmap

| Version | Scope | Status |
|---|---|---|
| v0.1 | The Spine: architecture, file structure, scaffolding plan, dev tracker | active, step 1 of 5 |
| v0.2 | Secure data intake and DB setup: schema, SQLite, CSV (and OFX) parsing, US/CA tax scaffold | gated on v0.1 close and interview answers |
| v0.3 | Analysis pipeline: categorization, tagging, interest separation, splits | planned |
| v0.4 | Interface spine: typed IPC, mock backend, glass shell, D3 Euler diagrams | planned |
| v0.5 | Hardening and security: encryption at rest, secure exports, capabilities | planned |
| v0.6 | UI polish and speed: motion, virtualized ledger, regression views, performance budget | planned (owner may re-slice v0.6 to v0.8) |
| v0.7 | Projections: savings goals, debt schedules, credit score engine | planned |
| v0.8 | Tax readiness and reports: US and CA exports, dual-status year, reports | planned |
| v0.9 | Activation: real batch imports, manual refresh sync, bug hunt | planned |
| v1.0 | Stable offline application: signed builds, macOS and Linux, docs | planned |

## Completed tasks

### v0.1

- [x] Architecture and module boundaries defined (`docs/ARCHITECTURE.md`, sections 1 and 2)
- [x] File tree published with the pipeline stages and the database layer marked (`docs/ARCHITECTURE.md`, section 3)
- [x] Stage contracts drafted (`docs/ARCHITECTURE.md`, section 4)
- [x] Draft data model listed for the v0.2 schema (`docs/ARCHITECTURE.md`, section 6)
- [x] `project_state.md` created (this file)
- [x] `dev_map.html` created: pipeline logic map, phase gauges, task lists, milestone log
- [x] Initialization runbook with checked versions (`docs/SETUP.md`)
- [x] Interview questions Q1 to Q3 asked

## Pending tasks

### v0.1, to close the phase

- [ ] Owner answers Q1 to Q3; answers logged under "Interview" below and turned into decisions
- [ ] Owner decides the repository home (Path A, new private repository, recommended; or Path B, this repository)
- [ ] Execute `docs/SETUP.md` section 2: scaffold boots with `npm run tauri dev`
- [ ] Execute `docs/SETUP.md` section 3: workspace crates exist and `cargo build --workspace` passes
- [ ] Milestone review: gauges updated in `dev_map.html`, state saved here, owner confirms v0.1 done

### v0.2, not started (gated)

- [ ] Migration 0001: accounts, import batches, raw records, transactions, splits, categories, rules, classifications, tags, earning contexts, tax profiles, tax line map, fx rates, settings
- [ ] `rb-storage`: open, migrate, typed repositories, integrity and migration tests
- [ ] `rb-core`: Money, ids, models, contracts
- [ ] `rb-intake`: CSV adapter with institution profiles and header sniffing
- [ ] `rb-intake`: OFX/QFX adapter (if Q1 confirms availability)
- [ ] `rb-intake`: normalizer and fingerprint dedup; batches with raw-row provenance
- [ ] `rb-pipeline`: `ImportStatement` use case (preview, commit)
- [ ] `rb-tax`: jurisdiction enum and year-versioned rule tables (US 2026, CA 2027 draft)
- [ ] Dependency-edge check script and ESLint import rule in CI
- [ ] Synthetic fixtures and import tests (never real data)

## Interview (v0.1 to v0.2 gate)

Answers are logged here verbatim when they arrive, then converted to decisions.

**Q1. Intake sources and duplicates.**
(a) Which institutions' exports come first, and in which formats (CSV, OFX/QFX/QBO, PDF)? A header row plus one or two rows with the numbers blanked fixes the first adapter profiles.
(b) Do those banks or card issuers offer OFX/QFX/QBO downloads? If yes, OFX becomes the primary adapter (each transaction carries a FITID, so re-import dedup is exact) and CSV is the fallback with fingerprint dedup.
(c) When an import overlaps an earlier one, drop duplicates silently with a count in the summary (recommended), or show them in a review step?
(d) Is there existing categorized history (a spreadsheet or a SQLite file from earlier tax preparation) to migrate once through its own adapter?
Answer: pending.

**Q2. Credit card interest model.**
Is transaction-level separation enough for v0.3 (the pipeline detects interest, fee and payment lines on card statements and marks their kind, so purchases never mix with interest in any total; recommended), or is per-payment allocation across principal and interest also required, which makes statements (period, closing balance, minimum payment, APRs, interest charged) a first-class table? If the latter, do the cards carry more than one APR (purchase, cash advance, promotional)?
Answer: pending.

**Q3. Tax entities and the 2027 move.**
Proposal: one household; several earning contexts (W-2 employment, self-employment or 1099, personal); every transaction or split attributed to one context; one tax profile per year with jurisdiction and residency dates so 2027 is a dual-status year (US until the move, CA after); accounts carry their own currency; reporting currency USD until the move, CAD after, with daily rates from the Bank of Canada and the Federal Reserve stored in `fx_rates`.
(a) Is a second person (spouse or partner) or a separate business entity with its own books needed?
(b) Which side of the border does the self-employment income sit on after the move?
(c) Is the reporting-currency rule right?
Answer: pending.

## Core architectural decisions

| Id | Decision | Status |
|---|---|---|
| ADR-001 | Stack: Tauri 2 (Rust) + React 19 + TypeScript + Vite; local SQLite; no cloud dependency | decided (owner constraint) |
| ADR-002 | Layout: one npm package and one Cargo workspace; crates `rb-core`, `rb-intake`, `rb-analysis`, `rb-tax`, `rb-output`, `rb-storage`, `rb-pipeline`; app crate `src-tauri` | decided |
| ADR-003 | Stage isolation and dependency direction per `ARCHITECTURE.md` section 2; stages do no database I/O; only `rb-pipeline` touches storage; enforced by a check script from v0.2 | decided |
| ADR-004 | Database access only in Rust through `rusqlite` (`bundled`); `tauri-plugin-sql` rejected because it would put SQL in the webview and bypass the pipeline; migrations are append-only SQL files applied by `rusqlite_migration` | decided |
| ADR-005 | Money is an integer count of minor units plus an ISO 4217 code; rates and APRs use `rust_decimal`; floats never carry money | decided |
| ADR-006 | Ids are UUIDv7 text; dates are `YYYY-MM-DD`; timestamps are RFC 3339 UTC | decided |
| ADR-007 | Provenance-first intake: every import is a batch with a source hash; every raw row is kept verbatim; duplicates are detected by external id when present, else by fingerprint | decided; OFX adapter pending Q1 |
| ADR-008 | Typed IPC: bindings generated from Rust by `tauri-specta`; `src/api` is the only TypeScript that imports `@tauri-apps/*`; a `MockBackend` serves browser-only development and tests | decided |
| ADR-009 | Tax rules are data tables in `rb-tax` keyed by jurisdiction and tax year; earning contexts and per-year tax profiles with residency ranges support the 2027 dual-status year; account currency plus an `fx_rates` table | proposed, pending Q3 |
| ADR-010 | Credit card interest is separated at transaction level by kind detection (interest, fee, payment, purchase); statement-level payment allocation only if Q2 asks for it | proposed, pending Q2 |
| ADR-011 | Encryption at rest through the `bundled-sqlcipher` feature in v0.5 (no API change); passphrase through Argon2id; exports encrypted by default | decided, implemented in v0.5 |
| ADR-012 | Visualization with D3 v7 and an own Euler solver in `src/viz`; glassmorphism delivered CSS-first with own tokens; a glass component library is evaluated in v0.4 only as a thin dependency; the motion library is chosen in v0.6 | decided |
| ADR-013 | Privacy rule: no real financial data, no real vendor names, no personal rule sets are ever committed; fixtures are synthetic; the app's long-term home should be a private repository | decided (rule); home pending owner |
| ADR-014 | Roadmap slice of v0.6 to v0.8: polish and speed, projections, tax readiness and reports | proposed (owner may re-slice) |
| ADR-015 | `dev_map.html` is self-contained; its `DEV_STATE` object is the only thing edited between milestones; it is republished as an artifact at each milestone; this file stays the ledger | decided |

## Session protocol

1. Read this file, then `docs/ARCHITECTURE.md`, then open `dev_map.html`.
2. Confirm the phase step with the owner before doing work that belongs to a later step.
3. Work in the current phase only. New ideas for later phases go to Pending under their version, not into code.
4. Before ending: update the tables above, move finished items to Completed, edit `DEV_STATE` in `dev_map.html`, add a Milestone log line, commit.
5. Commit messages follow the repository rule in `DEVELOPER.md`: subject and body only, no trailers.

## Milestone log

- 2026-09-21, v0.1 step 1: spine delivered (architecture, file tree, contracts, draft data model, state ledger, dev map, setup runbook with checked versions); interview Q1 to Q3 open; repository home pending.
