import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import base from '../playwright.config';
import smoke from '../playwright.smoke.config';

const scripts = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  scripts: Record<string, string>;
}).scripts;

// Follow the actual npm script graph so an extra build in a nested script
// cannot silently restore the duplicate-build cost.
function commands(command: string): string[] {
  return command.split(' && ').flatMap((part) => {
    const name = /^npm run ([\w:-]+)$/.exec(part)?.[1];
    return name ? commands(scripts[name]!) : [part];
  });
}

test('smoke builds once and completes the artifact checks before preview', () => {
  const server = smoke.webServer;
  expect(server && !Array.isArray(server)).toBeTruthy();
  if (!server || Array.isArray(server)) throw new Error('Missing smoke server');
  const sequence = commands(server.command);
  expect(sequence.filter((part) => part === 'vite build')).toHaveLength(1);
  const build = sequence.indexOf('vite build');
  const preview = sequence.findIndex((part) => part.startsWith('npm run preview '));
  expect(preview).toBe(sequence.length - 1);
  expect(sequence.slice(0, preview)).toEqual(commands('npm run gate'));
  for (const check of ['node scripts/check-bundle-size.mjs', 'node scripts/check-activation-budget.mjs']) {
    expect(sequence.indexOf(check)).toBeGreaterThan(build);
    expect(sequence.indexOf(check)).toBeLessThan(preview);
  }
  expect(sequence).toContain(scripts['verify:pure']);
  expect(sequence).toContain('biome lint');
  // No gate outside Playwright: its owned server already performs that gate.
  expect(scripts['verify:smoke']).toMatch(/^playwright test -c playwright\.smoke\.config\.ts /);
});

test('smoke keeps server isolation and every browser project unchanged', () => {
  const server = smoke.webServer;
  const original = base.webServer;
  if (!server || Array.isArray(server) || !original || Array.isArray(original)) {
    throw new Error('Expected a single production server');
  }
  expect(server.reuseExistingServer).toBe(false);
  expect(server.url).toBe(original.url);
  expect(server.command).toContain('--host 127.0.0.1 --strictPort');
  expect(smoke.projects).toEqual(base.projects);
  expect(smoke.use).toEqual(base.use);
});
