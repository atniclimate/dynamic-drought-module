import { test, expect } from '@playwright/test';
import { gotoApp, layerCheckbox, regionButton, DEFAULT_ON, ROLE_GROUPS } from './helpers';

/**
 * Boot smoke: the app comes up in a headless software-WebGL browser, the map
 * reaches `load`, and the sidebar builds. This is the linchpin the rest of
 * the suite depends on; if the map cannot get a WebGL2 context the sidebar
 * never builds and this spec fails first, with a clear cause.
 */
test.describe('boot', () => {
  test('map loads and the sidebar builds the four role groups', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await gotoApp(page);

    // The four role groups render in order with their headings.
    const headings = page.locator('#layer-toggles .layer-group-title');
    await expect(headings).toHaveCount(ROLE_GROUPS.length);
    for (let i = 0; i < ROLE_GROUPS.length; i++) {
      await expect(headings.nth(i)).toContainText(ROLE_GROUPS[i]!.title);
    }

    // The default-on set is checked at boot, EXACTLY: every catalog row is
    // asserted positively or negatively against the DEFAULT_ON mirror, so a
    // regression that silently broadens the boot set (a demoted deployer
    // slot flipping back on, a new layer defaulting on unratified) fails
    // here rather than passing a positive-only loop (Codex Unit E
    // finding 4). Telemetry left the set 2026-07-09 (0.7.0 H4); the
    // deployer slots tribal/treaty left it with the Tribal Nations umbrella
    // build (D-0.7.0-033); the current default carries the two live federal
    // Tribal-geography layers.
    for (const key of DEFAULT_ON) {
      await expect(layerCheckbox(page, key)).toBeChecked();
    }
    const allRows = page.locator('#layer-toggles input[data-layer-key]');
    const rowStates = await allRows.evaluateAll((els) =>
      els.map((el) => ({
        key: el.getAttribute('data-layer-key') ?? '',
        checked: (el as HTMLInputElement).checked
      }))
    );
    expect(rowStates.length).toBeGreaterThan(0);
    for (const row of rowStates) {
      expect(
        row.checked,
        `layer "${row.key}" boot state must mirror DEFAULT_ON exactly`
      ).toBe((DEFAULT_ON as readonly string[]).includes(row.key));
    }

    // The default region (washington_state) is the active radio.
    await expect(regionButton(page, 'washington_state')).toHaveAttribute('aria-checked', 'true');

    // UX-3 framing pass: the sidebar carries domain vocabulary, not GIS jargon.
    const titles = page.locator('.sidebar-scroll .panel-title');
    await expect(titles.filter({ hasText: 'Quick views' })).toHaveCount(1);
    await expect(titles.filter({ hasText: 'Water & Snow' })).toHaveCount(1);
    await expect(
      page.locator('label.layer-toggle:has(input[data-layer-key="telemetry"]) .layer-toggle-name')
    ).toHaveText('Monitoring stations');

    // No WebGL-context or boot-time script error slipped through. (Failed
    // network fetches log their own honest status and are not console errors.)
    const fatal = consoleErrors.filter((t) => /webgl|failed to (compile|link|initialize)/i.test(t));
    expect(fatal, `unexpected fatal console errors:\n${fatal.join('\n')}`).toHaveLength(0);
  });
});
