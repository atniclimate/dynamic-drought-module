import { expect, test } from '@playwright/test';

import { gotoApp } from './helpers';
import { stubDeepTerrainArchive, stubWildfireFeeds } from './wildfire-fixtures';

/**
 * DDM-P2-T04: the Fire 3D controller chunk is fetched only once eligibility
 * is real, never on a bare desktop Drought boot that has no way to reach the
 * scene. src/main.ts's fire3d block gates the dynamic import
 * (`import('./map/fire3d')`) on the committed cluster becoming 'wildfire' or
 * the boot URL naming the mode; this proves the network-request consequence
 * at the wire, following the request-INITIATION pattern of
 * tests/telemetry-raws-gate.spec.ts (counted independently of whether the
 * request ever resolves).
 *
 * The chunk-name pattern below excludes the two sibling chunks that also
 * start with `fire3d-` but are not the controller: `fire3d-presentation-*.js`
 * (the config constants the control's own lazy render always needs) and
 * `fire3d-context-*.js` (the context-layer companion). Only a bare
 * alphanumeric/underscore hash directly after `fire3d-` identifies
 * src/map/fire3d.ts itself (dist/.vite/manifest.json:
 * "src/map/fire3d.ts": "assets/fire3d-<hash>.js"); the sibling names insert
 * a hyphenated word first, which the pattern's `\w+` cannot cross.
 */
// The deferred Fire 3D controller chunk, `assets/fire3d-<hash>.js`. The hash
// is Vite's base64url alphabet, which includes `-` and `_`, so `\w+` is not
// enough: it was silently unable to match any build whose hash happened to
// contain a hyphen, and this test then counted zero requests forever and
// failed while the product was correct (DDM-P7-T03 landing, S21: the build's
// hash became `BKOq_V-I`). The two sibling chunks `fire3d-context-<hash>.js`
// and `fire3d-presentation-<hash>.js` are NOT this chunk and were excluded
// before only as an accident of `\w` rejecting their hyphen, so they are
// excluded explicitly now that the hash class allows one.
const FIRE3D_CHUNK_PATTERN =
  /\/assets\/fire3d-(?!context-|presentation-)[A-Za-z0-9_-]+\.js(?:[?#]|$)/;

function fire3dStamp(page: import('@playwright/test').Page): Promise<string | undefined> {
  return page.evaluate(() => document.documentElement.dataset['ddmFire3d']);
}

test.describe('Fire 3D controller deferral (DDM-P2-T04)', () => {
  test('a bare desktop Drought boot never requests the Fire 3D chunk', async ({
    page
  }) => {
    let fire3dRequests = 0;
    page.on('request', (req) => {
      if (FIRE3D_CHUNK_PATTERN.test(req.url())) fire3dRequests += 1;
    });

    await gotoApp(page, '');

    expect(
      fire3dRequests,
      'a bare Drought boot has no way to reach the Fire 3D scene and must not fetch its controller chunk'
    ).toBe(0);
  });

  test('switching to Wildfire on desktop requests the Fire 3D chunk and enters the scene', async ({
    page
  }) => {
    test.setTimeout(120_000);
    await stubWildfireFeeds(page);
    await stubDeepTerrainArchive(page);

    let fire3dRequests = 0;
    page.on('request', (req) => {
      if (FIRE3D_CHUNK_PATTERN.test(req.url())) fire3dRequests += 1;
    });

    // Bare Drought boot: no eligibility, no fetch (mirrors the previous case
    // so this test also proves the defect is gone from the exact starting
    // point a desktop-to-Wildfire switch begins from).
    await gotoApp(page, '');
    expect(fire3dRequests).toBe(0);

    await page.locator('.shell-cluster-btn[data-cluster="wildfire"]').click();

    // The commit to 'wildfire' is the eligibility signal
    // (src/state/cluster-service.ts's committed snapshot); the chunk request
    // must follow it without a page reload.
    await expect
      .poll(() => fire3dRequests, { timeout: 15_000 })
      .toBeGreaterThan(0);

    const control = page.locator('#shell-fire3d');
    await expect(control).toBeVisible({ timeout: 15_000 });

    // Enter the scene: proves the deferred loader wired
    // initFire3DController(map) before the control's own status read
    // (fire3d-control.tsx:208-223), so the toggle is not left driving an
    // inert controller.
    await page.locator('.shell-fire3d-btn').click();
    await expect
      .poll(() => fire3dStamp(page), { timeout: 30_000 })
      .toBe('active');
    await expect(
      page.locator('[data-fire3d-status]')
    ).toHaveAttribute('data-fire3d-status', 'active');
  });

  test('a fire3d=true wildfire deep link boots with the scene active', async ({
    page
  }) => {
    test.setTimeout(60_000);
    // The full contract for this URL (round-trip preservation across an
    // unrelated write, aria-pressed, etc.) is proven at
    // tests/fire3d-mode.spec.ts:1174, "a shared fire3d link boots active and
    // ordinary URL writes preserve the flag"; this case proves only this
    // task's clause 2a, that the deferred loader still lets the deep link
    // win the race to an active scene.
    await stubWildfireFeeds(page);
    await stubDeepTerrainArchive(page);
    await gotoApp(page, '?cluster=wildfire&fire3d=true');

    await expect
      .poll(() => fire3dStamp(page), { timeout: 30_000 })
      .toBe('active');
  });
});
