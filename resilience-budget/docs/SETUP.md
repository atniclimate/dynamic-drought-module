# Resilience Budget: Setup and Initialization (v0.1 runbook)

Versions below were checked against the npm registry and crates.io on
2026-09-21. Pin to these or newer patch releases.

| Tool or package | Version |
|---|---|
| Node.js | 22 LTS |
| Rust (rustup, stable, MSVC host on Windows) | 1.94 |
| create-tauri-app | 4.7.4 |
| @tauri-apps/cli, @tauri-apps/api | 2.11 |
| tauri (crate) | 2.11 |
| React | 19.3 |
| Vite | 8.3 |
| TypeScript | 7.0 |
| d3 | 7.9 |
| rusqlite | 0.40 (feature `bundled`; `bundled-sqlcipher` in v0.5) |
| rusqlite_migration | 2.6 |
| specta / tauri-specta / specta-typescript | 1.0 / 1.0 / 0.0.12 |

## 1. Prerequisites

### Windows 11 (PowerShell, run as your normal user)

```powershell
# Rust toolchain. Choose the default host triple x86_64-pc-windows-msvc in the installer.
winget install --id Rustlang.Rustup -e
rustup default stable-msvc

# Microsoft C++ Build Tools with the "Desktop development with C++" workload.
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

# Node.js LTS and Git.
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Git.Git -e

# WebView2 ships with Windows 10 1803+ and Windows 11. Verify it is present:
Get-ItemProperty "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" | Select-Object pv
```

Open a new terminal, then verify:

```powershell
rustc --version; cargo --version; node --version; npm --version
```

### macOS

```bash
xcode-select --install
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
brew install node@22
```

### Linux (Debian or Ubuntu)

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

## 2. Scaffold the Tauri + React + TypeScript project

Two placements are possible. The commands are the same after the first line.

Path A (recommended): a new private repository named `resilience-budget`.

```powershell
npm create tauri-app@latest resilience-budget -- --template react-ts --manager npm --identifier com.resiliencebudget.app --yes
cd resilience-budget
```

Path B: inside this repository, where `resilience-budget/` already holds the
planning files. The scaffolder is never pointed at a non-empty directory, so
scaffold beside it and move the generated files in.

```powershell
# from the repository root
npm create tauri-app@latest rb-scaffold -- --template react-ts --manager npm --identifier com.resiliencebudget.app --yes
robocopy rb-scaffold resilience-budget /E /MOVE
cd resilience-budget
```

On macOS or Linux the move is `rsync -a rb-scaffold/ resilience-budget/ && rm -rf rb-scaffold`.

The identifier `com.resiliencebudget.app` is a placeholder in reverse-domain
form. Change it in `src-tauri/tauri.conf.json` before the first signed build.

Then:

```powershell
npm install
npm run tauri dev
```

The first Rust compile takes several minutes. Done criteria: a window titled
`resilience-budget` opens with the template greeting; closing it exits cleanly.

## 3. Convert to a Cargo workspace and create the module crates

From `resilience-budget/`:

```powershell
# Root workspace manifest (src-tauri keeps its own Cargo.toml as a member).
@"
[workspace]
resolver = "2"
members = ["src-tauri", "crates/*"]

[workspace.package]
edition = "2024"
license = "MIT"

[workspace.dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
thiserror = "2"
uuid = { version = "1", features = ["v7", "serde"] }
time = { version = "0.3", features = ["serde", "formatting", "parsing", "macros"] }
"@ | Set-Content -Encoding utf8 Cargo.toml

cargo new --lib --vcs none crates/rb-core
cargo new --lib --vcs none crates/rb-intake
cargo new --lib --vcs none crates/rb-analysis
cargo new --lib --vcs none crates/rb-tax
cargo new --lib --vcs none crates/rb-output
cargo new --lib --vcs none crates/rb-storage
cargo new --lib --vcs none crates/rb-pipeline
```

Internal edges (only these; see ARCHITECTURE.md section 2):

```powershell
cargo add --path crates/rb-core -p rb-tax
cargo add --path crates/rb-core -p rb-intake
cargo add --path crates/rb-core -p rb-analysis
cargo add --path crates/rb-tax  -p rb-analysis
cargo add --path crates/rb-core -p rb-output
cargo add --path crates/rb-tax  -p rb-output
cargo add --path crates/rb-core -p rb-storage
foreach ($c in "rb-core","rb-intake","rb-analysis","rb-tax","rb-output","rb-storage") { cargo add --path "crates/$c" -p rb-pipeline }
cargo add --path crates/rb-pipeline -p resilience-budget
cargo add --path crates/rb-core     -p resilience-budget
```

External crates, added when the phase that needs them starts (v0.2 for all of
these except the analysis extras):

```powershell
cargo add -p rb-core     serde thiserror uuid time
cargo add -p rb-storage  rusqlite --features bundled
cargo add -p rb-storage  rusqlite_migration
cargo add -p rb-intake   csv blake3 toml regex
cargo add -p rb-analysis rust_decimal regex
cargo add -p rb-tax      toml rust_decimal
cargo add -p resilience-budget specta tauri-specta specta-typescript
cargo add -p resilience-budget tauri-plugin-dialog tauri-plugin-fs tauri-plugin-log
npm install @tauri-apps/plugin-dialog @tauri-apps/plugin-fs @tauri-apps/plugin-log d3 zustand @tanstack/react-query
npm install --save-dev @types/d3 vitest eslint
```

Done criteria for the workspace step:

```powershell
cargo build --workspace
cargo test --workspace
npm run build
npm run tauri dev
```

## 4. Ignore rules to add to `.gitignore`

```
node_modules/
dist/
target/
*.db
*.db-wal
*.db-shm
data/
fixtures/real/
.env
```

Real statements never enter the repository. Test fixtures are synthetic and
live under `crates/rb-intake/tests/fixtures/`.

## 5. Dev map

`dev_map.html` has no build step. Open it directly in a browser. Progress is
edited in the `DEV_STATE` object at the top of its script block; nothing else
in the file needs to change between milestones.
