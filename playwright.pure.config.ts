/**
 * The `verify:pure` fast lane (DR-052 b, ruled 2026-09-02; built 2026-09-03).
 *
 * The browser-free spec files below never request `page`, `browser`,
 * `context` or `request`: they import from `src/` and assert on returned
 * values. Inside the main config they already run at browser-free speed
 * (Playwright creates no browser for a case that asks for no fixture), but
 * they still wait behind the main config's `webServer`, which builds and
 * serves `dist/` before any spec collects. That wait is the whole cost of
 * running them, so this config drops it: same specs, same runner, no
 * build, no preview, no port, answering in seconds.
 *
 * What this lane proves: the pure logic under `src/` that these files
 * cover. What it does not prove: anything the built bundle or a browser
 * would show; `verify:quick` stays the typecheck rung and `verify:smoke`
 * the first browser rung (tests/README.md).
 *
 * Membership rule, enforced by `tests/pure-lane-inventory.test.mjs` under
 * `check:all`: a file may be listed here only while its body mentions none
 * of the fixture names and none of the boot helpers. A file that grows a
 * browser case leaves the list (the main config still runs it), and the
 * inventory test says so before the lane silently starts needing a server
 * it does not have.
 */

import { defineConfig } from '@playwright/test';

import base from './playwright.config';

/** The browser-free spec files, alphabetical. */
export const PURE_SPECS = [
  'tests/capability-matrix.spec.ts',
  'tests/display-summary.spec.ts',
  'tests/gl-capability.spec.ts',
  'tests/location-identity.spec.ts',
  'tests/minimap-drought.spec.ts',
  'tests/minimap-wildfire.spec.ts',
  'tests/nadm-shared-payload.spec.ts',
  'tests/point-in-polygon.spec.ts',
  'tests/s1-substrate.spec.ts',
  'tests/satellite-source.spec.ts',
  'tests/umbrella-config.spec.ts',
  'tests/usfs-whp.spec.ts'
] as const;

const { webServer: _webServer, projects: _projects, ...inherited } = base;

export default defineConfig({
  ...inherited,
  // Report locally, always: this lane is the save-and-think loop.
  reporter: 'list',
  projects: [
    {
      name: 'pure',
      testMatch: PURE_SPECS.map((file) => `**/${file.replace(/^tests\//, '')}`),
      testIgnore: ['**/*.test.mjs']
    }
  ]
});
