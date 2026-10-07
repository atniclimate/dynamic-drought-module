import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Smoke owns one fresh production build: gate builds and checks it, then
// Playwright serves that same output. No persistent cache or skip-build flag.
// A failed gate prevents preview startup; the base config still rejects an
// existing listener and keeps the production build identity assertions.
if (!base.webServer || Array.isArray(base.webServer)) {
  throw new Error('Smoke requires the single production webServer from the base config');
}

export default defineConfig({
  ...base,
  webServer: {
    ...base.webServer,
    command: 'npm run gate && npm run preview -- --host 127.0.0.1 --strictPort'
  }
});
