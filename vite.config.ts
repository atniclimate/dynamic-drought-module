import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';

/**
 * The source commit this build was produced from, embedded so a browser
 * run can PROVE which build it is exercising (T1-0 receipt integrity,
 * 2026-07-28: verification suites have twice tested the wrong server;
 * an exit code is not attributable to a build without this). Resolution
 * order: an explicit DDM_BUILD_SHA (CI/publish can inject), else the
 * local git HEAD plus a dirty marker when the working tree differs, else
 * 'unknown' (never fail the build over it).
 */
function buildSha(): string {
  if (process.env.DDM_BUILD_SHA) return process.env.DDM_BUILD_SHA;
  try {
    const head = execSync('git rev-parse HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const status = execSync('git status --porcelain --untracked-files=normal', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return status.length > 0 ? `${head}-dirty` : head;
  } catch {
    return 'unknown';
  }
}

/**
 * Vite configuration for the Dynamic Drought Module (DDM).
 *
 * Production hosts may serve the static folder at a domain root or at the
 * historical `/dynamic-drought-module/` subpath. Relative asset URLs work in
 * both positions and keep a copied iframe deployment self-contained.
 */
export default defineConfig({
  base: './',

  define: {
    __DDM_BUILD_SHA__: JSON.stringify(buildSha()),
    // A per-run nonce (T1-0 hardening, final-check finding 3): the SHA
    // alone cannot distinguish two servers built from the same commit,
    // so a release verifier can inject a fresh random nonce per run and
    // assert both values. Local builds use 'dev'.
    __DDM_BUILD_NONCE__: JSON.stringify(process.env.DDM_BUILD_NONCE ?? 'dev'),
  },

  build: {
    // Default outDir is 'dist'. The GitHub Actions workflow expects this.
    outDir: 'dist',

    // The promised browser floors, pinned so they are a build claim and not
    // Vite's moving default (Vite 8's `baseline-widely-available` resolves to
    // Safari 16.4, which would quietly narrow the README's promise). Ruled
    // 2026-09-02 (DR-009 as amended): Safari 15.5 and iOS Safari 15.5 for
    // iPhones and iPads, Chrome 100 and later for Android phones and tablets
    // (2022 devices forward). The bundler lowers SYNTAX to these targets; it
    // does not polyfill runtime APIs, so a real-device check per release is
    // the proof, not this line. MapLibre GL JS 6 needs WebGL 2, which both
    // floors ship enabled by default.
    target: ['es2020', 'safari15.5', 'ios15.5', 'chrome100'],

    // Source maps in production make field-debugging possible without
    // dramatically inflating bundle size for the kinds of bugs that
    // show up in this codebase (network handlers, layer lifecycle).
    sourcemap: true,

    // Emit dist/.vite/manifest.json. The activation gate
    // (scripts/check-activation-budget.mjs, T-P0-7) needs the import
    // EDGES between chunks: sourcemaps prove what is folded INTO a
    // chunk, the manifest proves what a chunk IMPORTS, and the gate
    // needs both to compute the eager closure and per-feature
    // activation closures. Turning this off breaks that gate loudly.
    manifest: true,

    // Split the large, rarely-changing vendor libraries into their own chunks
    // so an app-code change does not invalidate them in a returning visitor's
    // (or an embedding page's) browser cache. MapLibre GL is roughly 788 kB by
    // itself and the PMTiles protocol handler is separate; both are stable
    // across app edits, while the app chunk changes on nearly every commit. On
    // a repeat load only the small app chunk is re-fetched.
    //
    // Vite 8 ships Rolldown as the bundler; the Rollup-era
    // `rollupOptions.output.manualChunks` object form was removed, and
    // `codeSplitting.groups` is its more flexible replacement. The @maplibre
    // scope is matched explicitly so the style-spec helper packages ride in
    // the maplibre chunk rather than falling to default chunking.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'maplibre', test: /node_modules[\\/](maplibre-gl|@maplibre)[\\/]/ },
            { name: 'pmtiles', test: /node_modules[\\/]pmtiles[\\/]/ }
          ]
        }
      }
    },

    // The `maplibre` vendor chunk is legitimately large (a WebGL map renderer):
    // that is expected and cache-friendly, not a code-health signal. With the
    // vendor libraries split out the app chunk sits well under Vite's 500 kB
    // default; keep the limit just high enough that the known vendor chunk does
    // not cry wolf on every build.
    chunkSizeWarningLimit: 900,
  },

  server: {
    // Local dev port. Vite picks the next available port if 5173 is
    // taken, so this mostly matters for documentation.
    port: 5173,

    // Uncomment to proxy Cloudflare Worker requests during local dev,
    // assuming `wrangler dev` is running on localhost:8787. This lets
    // the same /proxy URLs work in both dev and production without a
    // build-time conditional.
    //
    // proxy: {
    //   '/proxy': {
    //     target: 'http://localhost:8787',
    //     changeOrigin: true,
    //   },
    // },
  },

  preview: {
    // `npm run preview` serves the production build locally for
    // smoke-testing before pushing. strictPort (final-check finding 3):
    // a raced or occupied 4173 must FAIL LOUDLY, never silently shift
    // ports, or a verification suite can attach to the wrong server.
    port: 4173,
    strictPort: true,
  },

  // Path aliases are commented out. To enable, uncomment below AND add
  // a matching "paths" entry under "compilerOptions" in tsconfig.json:
  //
  //   "baseUrl": ".",
  //   "paths": { "@/*": ["src/*"] }
  //
  // Without both sides matching, TypeScript will complain about imports
  // that Vite happily resolves at build time.
  //
  // resolve: {
  //   alias: {
  //     '@': '/src',
  //   },
  // },
});
