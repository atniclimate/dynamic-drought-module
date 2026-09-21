# Resilience Budget: Architecture (v0.1, The Spine)

Status: the spine is defined; no application code is compiled yet. This document
is the map the code must follow. It changes only through a numbered decision
recorded in `project_state.md`.

Companion documents: `project_state.md` (external memory, decisions, tasks) and
`docs/SETUP.md` (prerequisites and initialization commands). The live picture
of the pipeline and phase progress is `dev_map.html`.

## 1. Shape in one picture

```
+---------------------------------------------------------------------------+
|  UI  (React + TypeScript, src/)                                            |
|  features/*  .  components  .  viz (D3: Euler overlap, regressions)        |
|        |  the UI calls the Backend interface only (src/api)                |
+--------+------------------------------------------------------------------+
|  IPC   |  typed Tauri commands; TS bindings generated from Rust            |
+--------+------------------------------------------------------------------+
|  APP   v  src-tauri: command -> DTO -> one pipeline use case               |
+---------------------------------------------------------------------------+
|  PIPELINE  crates/rb-pipeline: use cases; the only crate that touches      |
|            storage                                                         |
|                                                                            |
|   INTAKE  --Transaction[]-->  ANALYSIS  --Classification[]-->  OUTPUT      |
|   rb-intake                   rb-analysis (+ rb-tax)           rb-output   |
|                                                                            |
+---------------------------------------------------------------------------+
|  FOUNDATION   rb-core (types, contracts)   rb-storage (SQLite)   rb-tax    |
+---------------------------------------------------------------------------+
```

Three stages, one orchestrator, one storage layer, one typed boundary to the
UI. Upstream never knows downstream exists.

## 2. Decoupling rules (the contract every phase must keep)

1. Stages talk only through types defined in `rb-core::contracts`. Intake never
   imports analysis; analysis never imports intake or output; output never
   imports intake or analysis.
2. Stage crates do no database I/O. They take slices in and return values out.
   Only `rb-pipeline` reads and writes `rb-storage`. This keeps every stage
   unit-testable with plain fixtures and lets storage change (encryption in
   v0.5) without touching a single stage.
3. `src-tauri` holds no business logic. A command validates its input, calls
   one pipeline use case, and maps the result to a DTO. Errors are mapped
   before they cross IPC and never leak file paths or SQL.
4. The frontend imports `@tauri-apps/*` only inside `src/api/`. Everything
   else codes against the `Backend` interface, so the UI runs in a plain
   browser against `MockBackend` and inside the app against `TauriBackend`.
5. A new intake source (OCR receipts, pay stubs) is a new folder under
   `crates/rb-intake/src/adapters/` plus one registry line. Downstream sees
   `Transaction` values, not files, so nothing downstream changes.
6. Tax rules are data tables plus small pure functions in `rb-tax`, versioned
   by jurisdiction and tax year. Analysis and output call `rb-tax`; `rb-tax`
   calls nobody.

Allowed dependency edges. From v0.2 a check script reads `cargo metadata` and
fails the build on any other edge; an ESLint `no-restricted-imports` rule does
the same for `@tauri-apps/*` on the TypeScript side.

| Crate | May depend on |
|---|---|
| `rb-core` | external crates only |
| `rb-tax` | `rb-core` |
| `rb-intake` | `rb-core` |
| `rb-analysis` | `rb-core`, `rb-tax` |
| `rb-output` | `rb-core`, `rb-tax` |
| `rb-storage` | `rb-core` |
| `rb-pipeline` | all of the above |
| `src-tauri` | `rb-pipeline`, `rb-core` |

## 3. File tree

`resilience-budget/` is one npm package and one Cargo workspace. The crate
prefix is `rb-`. Annotations mark where the modular pipeline lives (STAGE) and
where the database layer lives (DB).

```
resilience-budget/
|-- project_state.md                 external memory: version, tasks, decisions
|-- dev_map.html                     visual dev tracker (open in a browser)
|-- docs/
|   |-- ARCHITECTURE.md              this document
|   |-- SETUP.md                     prerequisites and init commands
|   `-- adr/                         one file per decision, from v0.2 on
|-- package.json                     scripts: dev, build, tauri, test, lint, check:deps
|-- vite.config.ts
|-- tsconfig.json
|-- index.html                       Vite entry
|-- Cargo.toml                       [workspace] members = ["src-tauri", "crates/*"]
|-- Cargo.lock
|-- .gitignore                       node_modules, dist, target, *.db*, data/, fixtures/real/
|
|-- src/                             FRONTEND. Knows nothing about SQLite or Rust internals.
|   |-- main.tsx
|   |-- App.tsx
|   |-- api/                         THE ONLY folder that imports @tauri-apps/*
|   |   |-- bindings.ts              generated by tauri-specta (never hand-edited)
|   |   |-- backend.ts               Backend interface: the contract the UI codes against
|   |   |-- tauri-backend.ts         implementation over invoke() via bindings
|   |   |-- mock-backend.ts          implementation over in-memory fixtures (browser dev, tests)
|   |   `-- index.ts                 picks Tauri when present, otherwise mock
|   |-- app/                         shell: routing, layout, theme provider, error boundary
|   |-- features/                    one folder per screen; each owns its components and hooks
|   |   |-- dashboard/
|   |   |-- import/                  file picker, adapter choice, preview, duplicate review
|   |   |-- transactions/            ledger, categorize, split, tag
|   |   |-- categories/              taxonomy editor, rules
|   |   |-- analytics/               Euler overlap, regressions, trends (uses viz/)
|   |   |-- projections/             savings goals, debt schedules, credit score engine
|   |   |-- tax/                     jurisdiction and year profiles, tax-ready export
|   |   `-- settings/                encryption, backups, adapters
|   |-- viz/                         D3 modules: pure functions (data -> SVG), no app state
|   |   |-- euler.ts
|   |   |-- regression.ts
|   |   `-- timeline.ts
|   |-- components/                  shared UI: GlassPanel, Gauge, DataTable, Sparkline
|   |-- state/                       query hooks and stores, all over src/api
|   |-- lib/                         money formatting, dates, currency helpers
|   |-- styles/                      tokens.css (glass, motion, palette), global.css
|   `-- types/                       UI-only types (backend types come from api/bindings.ts)
|
|-- src-tauri/                       APP CRATE: composition root, no business logic
|   |-- Cargo.toml                   depends on rb-pipeline, rb-core
|   |-- tauri.conf.json              window, bundle, CSP, identifier
|   |-- capabilities/default.json    least-privilege permission set
|   |-- icons/
|   |-- build.rs
|   `-- src/
|       |-- main.rs
|       |-- lib.rs                   builder, plugins, managed state (AppServices)
|       |-- commands/                thin adapters: parse args -> pipeline use case -> DTO
|       |   |-- mod.rs
|       |   |-- import.rs
|       |   |-- transactions.rs
|       |   |-- analysis.rs
|       |   |-- tax.rs
|       |   `-- system.rs            app data dir, db status, backup, restore
|       |-- dto.rs                   IPC types (specta), mapped from rb-core
|       `-- error.rs                 domain error -> IPC error (no paths, no SQL)
|
`-- crates/                          DOMAIN + PIPELINE. Pure Rust, zero Tauri dependency.
    |-- rb-core/                     domain model and stage contracts (zero I/O)
    |   `-- src/
    |       |-- lib.rs
    |       |-- money.rs             Money { minor: i64, currency }  (never floats)
    |       |-- ids.rs               UUIDv7 newtypes: AccountId, TransactionId, ...
    |       |-- model/               Account, Transaction, Split, Category, Tag,
    |       |                        Classification, EarningContext, TaxProfile
    |       |-- contracts.rs         IntakeAdapter, Analyzer, Exporter, stage payloads
    |       `-- error.rs
    |-- rb-intake/                   STAGE 1: files -> RawRecord -> Transaction candidates
    |   |-- src/
    |   |   |-- lib.rs
    |   |   |-- adapters/
    |   |   |   |-- mod.rs           registry: adapter id -> implementation
    |   |   |   |-- csv/             generic CSV plus institution profiles
    |   |   |   |-- ofx/             OFX/QFX (pending interview Q1)
    |   |   |   |-- ocr/             future: receipt scanning (feature-gated)
    |   |   |   `-- paystub/         future: pay stub monitoring (feature-gated)
    |   |   |-- normalize.rs         dates, signs, descriptions, merchants
    |   |   |-- fingerprint.rs       duplicate detection hash
    |   |   `-- batch.rs             ImportBatch and provenance
    |   |-- profiles/                institution CSV profiles (*.toml), no account data
    |   `-- tests/fixtures/          synthetic statements only, never real data
    |-- rb-analysis/                 STAGE 2: Transaction -> Classification, metrics, projections
    |   `-- src/
    |       |-- lib.rs
    |       |-- categorize/          rules engine: patterns, priorities, confidence
    |       |-- tagging.rs
    |       |-- interest.rs          purchase vs interest vs fee separation
    |       |-- splits.rs            business/personal allocations
    |       |-- regression.rs        category trend regressions
    |       |-- projections/         savings goals, debt schedules, credit score heuristics
    |       `-- metrics.rs           income, spend, debt time series
    |-- rb-tax/                      jurisdiction rules (US, CA), versioned by tax year
    |   |-- src/
    |   |   |-- lib.rs
    |   |   |-- jurisdiction.rs
    |   |   |-- us/                  Schedule C lines, 1099 income, Form 8829 home office
    |   |   |-- ca/                  T2125, T777 and home office, CAD conversion rules
    |   |   `-- mapping.rs           category -> tax line, keyed by (jurisdiction, year)
    |   `-- rules/                   data tables: us-2026.toml, ca-2027.toml, ...
    |-- rb-output/                   STAGE 3: read models, exports
    |   `-- src/
    |       |-- lib.rs
    |       |-- read_models.rs       dashboard and analytics view models for the UI
    |       |-- tax_package.rs       tax-ready CSV/JSON bundles per jurisdiction and year
    |       |-- reports.rs
    |       `-- encrypted_export.rs  v0.5
    |-- rb-storage/                  DB: SQLite via rusqlite (bundled)
    |   |-- migrations/              0001_init.sql, 0002_... (append-only)
    |   `-- src/
    |       |-- lib.rs               Database::open(path, key), migrate()
    |       |-- schema.rs
    |       |-- repos/               typed queries per aggregate
    |       `-- encryption.rs        v0.5: SQLCipher key handling
    `-- rb-pipeline/                 ORCHESTRATION: use cases; the only crate touching rb-storage
        `-- src/
            |-- lib.rs
            |-- services.rs          AppServices { db, adapter registry, rule sets }
            |-- import_statement.rs  intake -> persist raw rows and transactions
            |-- run_analysis.rs      load -> analyze -> persist classifications
            |-- build_tax_package.rs load -> rb-output
            `-- events.rs            progress events for the UI
```

Future, not scaffolded in v0.1: `crates/rb-cli/` (headless batch runs of the same
use cases, useful for v0.9 activation) and `tests/e2e/` (WebDriver through
`tauri-driver`).

## 4. Stage contracts (draft, `rb-core::contracts`)

These are the seams. They are illustrative Rust; the exact signatures are
settled in v0.2 after the interview answers.

```rust
/// One row of a source file, kept verbatim for provenance.
pub struct RawRecord {
    pub batch_id: ImportBatchId,
    pub row_index: u32,
    pub fields: BTreeMap<String, String>,
    pub content_hash: Hash,
}

/// What intake hands to the pipeline. Not yet persisted, not yet classified.
pub struct TransactionCandidate {
    pub account_id: AccountId,
    pub posted_on: Date,
    pub effective_on: Option<Date>,
    pub amount: Money,                 // signed, minor units, account currency
    pub description_raw: String,
    pub description_norm: String,
    pub external_id: Option<String>,   // OFX FITID or bank reference when present
    pub kind_hint: Option<TxnKind>,    // purchase | payment | interest | fee | refund | transfer | income
    pub fingerprint: Hash,             // dedup key when no external_id exists
    pub raw_record: RawRecordRef,
}

pub trait IntakeAdapter: Send + Sync {
    fn id(&self) -> &'static str;
    /// How confident this adapter is that it can read the sample (header sniffing).
    fn sniff(&self, sample: &[u8]) -> Option<Confidence>;
    fn parse(&self, input: &mut dyn Read, profile: Option<&Profile>) -> Result<Vec<RawRecord>, IntakeError>;
}

pub struct Classification {
    pub transaction_id: TransactionId,
    pub category_id: CategoryId,
    pub confidence: Confidence,
    pub source: ClassificationSource,  // Rule(RuleId) | Manual | Model
}

pub trait Analyzer: Send + Sync {
    fn analyze(&self, txns: &[Transaction], ctx: &AnalysisContext) -> AnalysisReport;
}

pub trait Exporter: Send + Sync {
    fn export(&self, model: &ExportModel, sink: &mut dyn Write) -> Result<(), OutputError>;
}
```

## 5. End-to-end flow: importing a statement

1. UI: the user picks a file through the dialog plugin and calls
   `api.imports.preview(path)`.
2. Command `import_preview` calls the pipeline use case `ImportStatement::preview`:
   sniff adapters, parse to `RawRecord`s, normalize to candidates, compute
   fingerprints, compare with storage, return counts of new, duplicate and
   unmapped rows plus a sample.
3. UI shows the preview; the user confirms with `import_commit(batch_token)`.
4. The pipeline persists the batch, the raw rows and the transactions in one
   SQLite transaction and emits progress events.
5. The pipeline runs `RunAnalysis` on the new transactions: category, tags,
   kind (purchase, interest, fee, payment), suggested splits. Results are
   persisted with their confidence and source.
6. UI refetches read models from `rb-output`; the dashboard updates.

## 6. Data model (draft; finalized in v0.2 after the interview)

Conventions: money as integer minor units plus an ISO 4217 code; dates as
`YYYY-MM-DD` text; timestamps as RFC 3339 UTC text; ids as UUIDv7 text;
migrations append-only; history-bearing rows use a status column instead of
hard deletes.

| Table | Purpose | Owner stage |
|---|---|---|
| `accounts` | name, institution, kind (checking, savings, credit_card, loan, cash, investment), currency, jurisdiction | core |
| `import_batches` | adapter id, profile id, source name, source sha256, row count, imported_at, status | intake |
| `raw_records` | batch id, row index, fields as JSON, content hash | intake |
| `transactions` | account, raw record ref, posted_on, effective_on, amount_minor, currency, description raw and normalized, merchant, kind, external_id, fingerprint (unique per account), status | intake |
| `transaction_splits` | allocations of one transaction across categories and earning contexts | analysis |
| `categories` | tree (parent id), slug, kind (expense, income, transfer, liability), system flag | analysis |
| `rules` | priority, matcher (contains, regex, amount range, combination), target category, tags, kind override, enabled, hit count | analysis |
| `classifications` | one per transaction: category, confidence, source, rule id, reviewed_at | analysis |
| `tags`, `transaction_tags` | free-form and system tags (interest, fee, transfer, reimbursable) | analysis |
| `earning_contexts` | W-2 employment, self-employment (1099), personal, other; active date range; jurisdiction | tax |
| `tax_profiles` | per tax year: jurisdiction, residency date range, filing status, base currency | tax |
| `tax_line_map` | category -> form and line, keyed by jurisdiction and tax-year range, deductible percent | tax |
| `fx_rates` | date, base, quote, rate, source (Bank of Canada, Federal Reserve) | tax |
| `statements` | card statement periods: closing balance, minimum payment, APRs, interest charged (pending Q2) | analysis |
| `goals`, `debts`, `schedules` | projections (v0.7) | analysis |
| `settings`, `schema_meta` | app settings, schema version and integrity | storage |

## 7. Frontend notes

- `src/api` is generated bindings plus two adapters. `features` own screens.
  `viz` is pure D3 (data in, SVG out) so charts are unit-testable and reusable
  in exports.
- Glass tokens live in `styles/tokens.css`. Components consume tokens and never
  hard-code colors. Motion honors `prefers-reduced-motion`.
- Euler diagrams: set overlaps such as business, software, subscription are
  computed from tags and categories and laid out by an own circle solver in
  `viz/euler.ts` (MDS initial placement plus a small optimizer), so the app
  does not depend on an unmaintained library.
- Glassmorphism is delivered CSS-first with own tokens; a third-party glass
  component library is evaluated in v0.4 and adopted only if it stays a thin
  dependency.

## 8. Security posture (targets; v0.5 implements)

- Local only. The Tauri capability set grants no network permission; the app
  never phones home and has no telemetry.
- The database lives in the OS app-data directory. From v0.5 it is a SQLCipher
  database (rusqlite `bundled-sqlcipher`), keyed by a passphrase run through
  Argon2id, optionally cached in the OS keychain.
- Exports are encrypted by default (authenticated encryption with a passphrase);
  plain exports are an explicit choice with a warning.
- Strict CSP, no remote content, IPC commands allow-listed per window.
- Logs never contain amounts, descriptions or paths. Errors crossing IPC are
  mapped to safe messages.
- Dependency hygiene in CI: `cargo audit`, `cargo deny`, `npm audit`.

## 9. Testing strategy

- Rust: unit tests per crate with synthetic fixtures; property tests for
  normalization and fingerprints; a migration test that applies every
  migration to a fresh database and to a database at the previous version.
- TypeScript: vitest for `lib`, `viz` and `state`; component tests against the
  mock backend; end-to-end through `tauri-driver` from v0.6.
- Architecture tests: the dependency-edge check and a "no real data" check that
  refuses fixtures containing account-number-shaped or card-number-shaped
  strings.

## 10. Non-goals for v0.x

No cloud sync, no accounts, no telemetry, no bank API aggregators, no mobile
until the desktop app is stable (iOS remains a later Tauri 2 target).
