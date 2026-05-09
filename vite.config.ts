import { defineConfig } from 'vite';

/**
 * Vite configuration for the Dynamic Drought Module (DDM).
 *
 * The deployed site lives at:
 *   https://atniclimate.github.io/dynamic-drought-module/
 *
 * The `base` setting is critical for GitHub Pages: without it, asset
 * URLs in the built HTML resolve to the domain root (atniclimate.github.io)
 * and 404 because the project is served from a subpath. With it set
 * correctly, assets resolve to /dynamic-drought-module/assets/...
 *
 * If the repository is ever renamed or moved to a custom domain, update
 * `base` accordingly (a custom domain on the apex would use base: '/').
 */
export default defineConfig({
  base: '/dynamic-drought-module/',

  build: {
    // Default outDir is 'dist'. The GitHub Actions workflow expects this.
    outDir: 'dist',

    // Source maps in production make field-debugging possible without
    // dramatically inflating bundle size for the kinds of bugs that
    // show up in this codebase (network handlers, layer lifecycle).
    sourcemap: true,

    // Vite's default chunkSizeWarningLimit is 500 kB. MapLibre GL JS is
    // larger than that by itself, so the warning fires on every build
    // even though the situation is fine. Bumping the limit avoids
    // alarmism in the build log without changing behavior.
    chunkSizeWarningLimit: 1000,
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
    // smoke-testing before pushing.
    port: 4173,
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
