/**
 * The `verify:pure` fast lane (DR-052 b, ruled 2026-09-02; built 2026-09-03).
 *
 * The shared browser-free spec roster never requests `page`, `browser`,
 * `context` or `request`: they import from `src/` and assert on returned
 * values. The main config excludes these files from its browser matrix;
 * this config runs them once through the gate without its `webServer`:
 * no build, no preview, no port, answering in seconds.
 *
 * What this lane proves: the pure logic under `src/` that these files
 * cover. What it does not prove: anything the built bundle or a browser
 * would show; the browser checks follow the ladder in tests/README.md.
 *
 * Membership rule, enforced by `tests/pure-lane-inventory.test.mjs` under
 * `check:all`: a file may be listed in PURE_SPECS only while its body mentions
 * none of the fixture names and none of the boot helpers. A file that grows a
 * browser case leaves the list (the main config still runs it), and the
 * inventory test says so before the lane silently starts needing a server
 * it does not have.
 */

import { defineConfig } from '@playwright/test';

import base, { PURE_SPECS } from './playwright.config';

export { PURE_SPECS } from './playwright.config';

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
