import { test, expect, type Page } from '@playwright/test';
import { gotoApp, layerPill, PILL, search, stubHeatRiskCatalog } from './helpers';
import { isNwsWwaRequestUrl, NWS_WWA_EMPTY, nwsWwaStubLog } from './nws-wwa-fixtures';

/**
 * S30D D1 M11 (register item owner-1h; task DDM-P10-T11; design record
 * interface-chrome-popups-text.md section 2.6 "Drawers", "Sections for N
 * modes"; DR-113): the Key drawer holds open across mode, horizon,
 * loading and selection changes and re-renders for the new state; a
 * per-cluster section (HeatRisk first) moves the SAME node into it on
 * the desktop shell outside embeds; the drawer never intersects the
 * column, the 3D seat or the scale bars, and it moves no seat; a popup
 * near its edge clears it; phones and embeds keep every section's node
 * in `#map-bottom-dock`.
 *
 * Predicted reds (pre-M11 tree): `#heatrisk-sequence` never leaves
 * `#map-bottom-dock` (no seat watcher moves it); the drawer closes on
 * every mode switch (`map-key.ts`'s `if (nextFamily !== family)
 * setDetailsOpen(false)`, the "automatic close" the design record names
 * for removal); a popup near the drawer clamps only to the plain 12px
 * edge margin, not the drawer's own right edge; there is no fallback
 * sentence for "no place selected".
 */

const DESKTOP_VIEWPORT = { width: 1440, height: 900 } as const;

async function openKeyDrawer(page: Page): Promise<void> {
  const toggle = page.locator('#map-key-details-toggle');
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
  await expect(page.locator('#map-key-content')).toBeVisible();
}

test.describe('the Key drawer (S30D D1 M11)', () => {
  test('on desktop #heatrisk-sequence moves into its Key drawer section as the same node, and a redundant raster-status event keeps its DOM and focus (DDM-UI-011)', async ({
    page
  }) => {
    // Capture every ddm:heatrisk-frames dispatch before the app's own
    // module code runs, so a later replay can reuse the EXACT frames
    // array reference a real redundant raster-status tick would carry
    // (applyFrameDetail's own bail-out compares `detail.frames === frames`
    // by identity).
    await page.addInitScript(() => {
      const w = window as unknown as { __ddmCapturedFrameDetails: unknown[] };
      w.__ddmCapturedFrameDetails = [];
      const originalDispatch = window.dispatchEvent.bind(window);
      window.dispatchEvent = (event: Event): boolean => {
        if (
          event instanceof CustomEvent &&
          event.type === 'ddm:heatrisk-frames' &&
          event.detail
        ) {
          w.__ddmCapturedFrameDetails.push(event.detail);
        }
        return originalDispatch(event);
      };
    });

    await page.setViewportSize(DESKTOP_VIEWPORT);
    await stubHeatRiskCatalog(page);
    await gotoApp(page, '?view=console&cluster=heat&select=state:WA');

    // The design record (section 2.6, "HeatRisk first"): "A closed drawer
    // hides the drawer, not the host." The moved sequence sits inside the
    // Key drawer's section host on desktop, so it is correctly hidden
    // until the drawer opens through its own trigger; open it here before
    // asserting the sequence is visible.
    await openKeyDrawer(page);

    const sequence = page.locator('#heatrisk-sequence');
    await expect(sequence).toBeVisible();
    const cells = sequence.locator('[data-heatrisk-sequence-day]');
    await expect(cells).toHaveCount(7);

    // THE MOVE: the same node id sits inside its Key drawer section, not
    // the dock, once the desktop seat watcher has placed it.
    const seat = await page.evaluate(() => {
      const node = document.getElementById('heatrisk-sequence');
      const section = document.getElementById('detail-section-heatrisk-sequence');
      const dock = document.getElementById('map-bottom-dock');
      return {
        inSection: Boolean(node && section && section.contains(node)),
        inDock: Boolean(node && dock && dock.contains(node) && !section?.contains(node))
      };
    });
    expect(seat.inSection, 'the sequence node is not inside its drawer section').toBe(true);
    expect(seat.inDock, 'the sequence node is still (also) parented under the dock directly').toBe(false);

    // SAME NODE: a reference captured now still resolves to the live node.
    await page.evaluate(() => {
      (window as unknown as { __ddmSeqRef?: Element | null }).__ddmSeqRef =
        document.getElementById('heatrisk-sequence');
    });

    // Focus a sequence cell, then replay a captured frames event with the
    // SAME detail object a genuine redundant raster-status tick would
    // resend (unchanged frames array reference, unchanged selectedDay):
    // DDM-UI-011 says the DOM and focus survive it.
    const targetCell = sequence.locator('[data-heatrisk-sequence-day="3"]');
    await targetCell.focus();
    await expect(targetCell).toBeFocused();

    await page.evaluate(() => {
      const w = window as unknown as { __ddmCapturedFrameDetails: unknown[] };
      const last = w.__ddmCapturedFrameDetails.at(-1);
      if (!last) throw new Error('no ddm:heatrisk-frames event was captured to replay');
      window.dispatchEvent(new CustomEvent('ddm:heatrisk-frames', { detail: last }));
    });

    const after = await page.evaluate(() => ({
      sameNode:
        document.getElementById('heatrisk-sequence') ===
        (window as unknown as { __ddmSeqRef?: Element | null }).__ddmSeqRef,
      focusedDay: document.activeElement?.getAttribute('data-heatrisk-sequence-day') ?? null,
      cellCount: document.querySelectorAll('#heatrisk-sequence [data-heatrisk-sequence-day]').length
    }));
    expect(after.sameNode, 'a redundant raster-status event rebuilt the sequence node').toBe(true);
    expect(after.focusedDay, 'a redundant raster-status event dropped focus off the cell').toBe('3');
    expect(after.cellCount).toBe(7);
  });

  test('the Key drawer stays open across a mode switch and re-renders for the new mode', async ({
    page
  }) => {
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await stubHeatRiskCatalog(page);
    await gotoApp(page, '?view=console');

    await openKeyDrawer(page);
    // The default boot (Drought, Current) reads the tri-national NADM
    // key, not the USDM key (nadmKey vs droughtKey; the latter serves
    // only the outlook horizons).
    await expect(page.locator('#map-key-details-toggle')).toHaveText('North America drought');

    const heatButton = page.locator('.shell-cluster-btn[data-cluster="heat"]');
    await heatButton.click();
    await expect(heatButton).toHaveAttribute('data-pending', 'false', { timeout: 30_000 });

    // Persistence (design record section 2.6): the drawer never closed.
    await expect(page.locator('#map-key-details-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#map-key-content')).toBeVisible();
    // Re-render for the new mode: the toggle's own label text follows the
    // new KeySpec (Heat), not the mode it opened under.
    await expect(page.locator('#map-key-details-toggle')).toHaveText('HeatRisk');
  });

  test('Escape closes the Key drawer and returns focus to its trigger', async ({ page }) => {
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await gotoApp(page, '?view=console');

    await openKeyDrawer(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('#map-key-details-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#map-key-content')).toBeHidden();
    await expect(page.locator('#map-key-details-toggle')).toBeFocused();
  });

  test('the HeatRisk day select works with no place selected, and a hidden section host shows the fallback sentence', async ({
    page
  }) => {
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await stubHeatRiskCatalog(page);
    await gotoApp(page, '?view=console&cluster=heat');

    await openKeyDrawer(page);

    // The legend's own day select is the only day control with nothing
    // selected (the sequence host stays hidden until a selection).
    const daySelect = page.locator('#map-key [data-heatrisk-day]');
    await expect(daySelect).toBeVisible();
    await expect(daySelect.locator('option')).toHaveCount(7);
    await daySelect.selectOption('4');
    await expect
      .poll(async () => new URLSearchParams(await search(page)).get('heatday'))
      .toBe('4');

    // The declared section is revealed for Heat (DR-113 gating), and its
    // fallback sentence is exactly the check:vocabulary-clean string
    // (D1.md M11 Notes); the moved sequence node stays hidden (no place
    // selected).
    const section = page.locator('#detail-section-heatrisk-sequence');
    await expect(section).toBeVisible();
    await expect(page.locator('#heatrisk-sequence')).toBeHidden();
    await expect(section.locator('[data-detail-section-fallback]')).toHaveText(
      'Select a place on the map to see its HeatRisk for each of the next seven days.'
    );
  });

  test('with the Key drawer open, a popup committed near the left edge renders at or beyond the drawer plus 8 px', async ({
    page
  }) => {
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await gotoApp(page, '?view=console');
    await openKeyDrawer(page);

    // A synthetic MapLibre-shaped popup (src/ui/popup-viewport.ts wires
    // ANY `.maplibregl-popup` addition under document.body, real or not),
    // committed 100px from the map container's own left edge -- the
    // "committed at x 100" case popup-viewport.ts:216's drawer-aware left
    // bound exists for.
    await page.evaluate(() => {
      const mapEl = document.querySelector('.maplibregl-map');
      if (!mapEl) throw new Error('no .maplibregl-map to host the probe popup');
      const popup = document.createElement('div');
      popup.className = 'maplibregl-popup maplibregl-popup-anchor-bottom';
      popup.style.position = 'absolute';
      popup.style.top = '0';
      popup.style.left = '0';
      popup.style.transform = 'translate(100px, 300px)';
      popup.style.zIndex = '10';
      const tip = document.createElement('div');
      tip.className = 'maplibregl-popup-tip';
      const content = document.createElement('div');
      content.className = 'maplibregl-popup-content';
      content.style.width = '260px';
      content.textContent =
        'S30D D1 M11 drawer-clamp probe: content long enough to carry a real width and height.';
      popup.append(tip, content);
      mapEl.appendChild(popup);
    });

    await expect
      .poll(() =>
        page.evaluate(() => {
          const drawer = document.getElementById('map-key-content');
          const popupContent = document.querySelector('.maplibregl-popup-content');
          if (!drawer || !popupContent) return null;
          return {
            drawerRight: drawer.getBoundingClientRect().right,
            popupLeft: popupContent.getBoundingClientRect().left
          };
        })
      )
      .not.toBeNull();

    const geometry = await page.evaluate(() => {
      const drawer = document.getElementById('map-key-content')!;
      const popupContent = document.querySelector('.maplibregl-popup-content')!;
      // The SETTLED right edge (S30D D1 M11 repair round 2): the drawer's
      // entrance animation (app.css:6123-6137, "map-key-drawer-in") may
      // still be sliding in when this measurement runs, and its
      // getBoundingClientRect() reads the in-flight, translated box.
      // offsetLeft/offsetWidth are layout-box measurements a CSS
      // transform never moves, so the nearest positioned ancestor's live
      // left edge plus the drawer's own offsetLeft and offsetWidth is
      // the settled edge regardless of animation progress. This is a
      // value-only tightening: the settled edge is always >= the live,
      // possibly-translated one, so the required bound only gets
      // stricter, never looser.
      const offsetParent = drawer.offsetParent as HTMLElement | null;
      const parentLeft = offsetParent ? offsetParent.getBoundingClientRect().left : 0;
      const settledRight = parentLeft + drawer.offsetLeft + drawer.offsetWidth;
      return {
        drawerRight: settledRight,
        popupLeft: popupContent.getBoundingClientRect().left
      };
    });
    expect(
      geometry.popupLeft,
      `the popup (left ${geometry.popupLeft}) does not clear the drawer's settled right edge (${geometry.drawerRight}) plus 8px`
    ).toBeGreaterThanOrEqual(geometry.drawerRight + 8 - 1);
  });

  test('with the Key drawer frozen at the start of its slide-in, a popup committed near the left edge clears the SETTLED drawer edge, not the translated one', async ({
    page
  }) => {
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await gotoApp(page, '?view=console');

    // Open the drawer and freeze its entrance animation at its very
    // first frame (transform: translateX(-8px), app.css:6128-6137) in
    // the SAME evaluate as the click, so no real time passes for the
    // --dur-fast slide to progress or finish before the freeze takes
    // hold. This is a deterministic stand-in for "a popup committed
    // while the drawer is still sliding in": the m11-wt gate's own 3px
    // miss was timing-dependent, and this case must not depend on real
    // animation timing to prove the fix.
    const frozen = await page.evaluate(() => {
      const toggleEl = document.getElementById('map-key-details-toggle');
      if (!(toggleEl instanceof HTMLElement)) {
        throw new Error('no #map-key-details-toggle to open the drawer');
      }
      toggleEl.click();
      const drawer = document.getElementById('map-key-content');
      if (!drawer) throw new Error('no #map-key-content after opening');
      // A freshly-matching CSS animation is only guaranteed to exist as
      // a queryable Animation object after a style recalculation; force
      // one synchronously (a computed-style read) before asking for it,
      // so this never races the browser's own rendering schedule.
      void getComputedStyle(drawer).transform;
      const anim = drawer
        .getAnimations()
        .find(
          (candidate) =>
            (candidate as unknown as { animationName?: string }).animationName ===
            'map-key-drawer-in'
        );
      if (!anim) return { found: false, transform: getComputedStyle(drawer).transform };
      anim.pause();
      anim.currentTime = 0;
      return { found: true, transform: getComputedStyle(drawer).transform };
    });
    expect(frozen.found, 'the drawer entrance animation (map-key-drawer-in) was not found to freeze').toBe(
      true
    );
    expect(
      frozen.transform,
      'the frozen drawer is not carrying its start-of-slide transform (translateX(-8px))'
    ).not.toBe('none');

    await expect(page.locator('#map-key-content')).toBeVisible();

    // The same synthetic MapLibre-shaped popup probe as the case above,
    // committed while the drawer is held at its translated start frame.
    await page.evaluate(() => {
      const mapEl = document.querySelector('.maplibregl-map');
      if (!mapEl) throw new Error('no .maplibregl-map to host the probe popup');
      const popup = document.createElement('div');
      popup.className = 'maplibregl-popup maplibregl-popup-anchor-bottom';
      popup.style.position = 'absolute';
      popup.style.top = '0';
      popup.style.left = '0';
      popup.style.transform = 'translate(100px, 300px)';
      popup.style.zIndex = '10';
      const tip = document.createElement('div');
      tip.className = 'maplibregl-popup-tip';
      const content = document.createElement('div');
      content.className = 'maplibregl-popup-content';
      content.style.width = '260px';
      content.textContent =
        'S30D D1 M11 drawer-clamp probe (frozen mid-slide): content long enough to carry a real width and height.';
      popup.append(tip, content);
      mapEl.appendChild(popup);
    });

    await expect
      .poll(() =>
        page.evaluate(() => {
          const popupContent = document.querySelector('.maplibregl-popup-content');
          return popupContent ? popupContent.getBoundingClientRect().left : null;
        })
      )
      .not.toBeNull();

    const geometry = await page.evaluate(() => {
      const drawer = document.getElementById('map-key-content')!;
      const popupContent = document.querySelector('.maplibregl-popup-content')!;
      const offsetParent = drawer.offsetParent as HTMLElement | null;
      const parentLeft = offsetParent ? offsetParent.getBoundingClientRect().left : 0;
      const settledRight = parentLeft + drawer.offsetLeft + drawer.offsetWidth;
      return {
        settledRight,
        liveRight: drawer.getBoundingClientRect().right,
        popupLeft: popupContent.getBoundingClientRect().left
      };
    });

    // Prove the freeze actually held (the drawer is visibly short of its
    // settled edge): otherwise this case is not exercising the animated
    // state it exists to prove.
    expect(
      geometry.liveRight,
      'the drawer is not actually translated; the freeze did not take'
    ).toBeLessThan(geometry.settledRight - 1);

    expect(
      geometry.popupLeft,
      `the popup (left ${geometry.popupLeft}) does not clear the drawer's SETTLED right edge (${geometry.settledRight}) plus 8px; it only cleared the translated live edge (${geometry.liveRight})`
    ).toBeGreaterThanOrEqual(geometry.settledRight + 8 - 1);

    // Release the frozen animation: it was put under direct JS control,
    // so nothing else un-pauses it.
    await page.evaluate(() => {
      const drawer = document.getElementById('map-key-content');
      const anim = drawer?.getAnimations()[0];
      anim?.finish();
    });
  });

  test('at 390x844 and in an embed the sequence stays in #map-bottom-dock', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await stubHeatRiskCatalog(page);
    await gotoApp(page, '?cluster=heat&select=state:WA');
    const sequence = page.locator('#heatrisk-sequence');
    await expect(sequence).toBeVisible();
    const phoneSeat = await page.evaluate(() => {
      const node = document.getElementById('heatrisk-sequence');
      const dock = document.getElementById('map-bottom-dock');
      const section = document.getElementById('detail-section-heatrisk-sequence');
      return {
        inDock: Boolean(node && dock && dock.contains(node)),
        inSection: Boolean(node && section && section.contains(node))
      };
    });
    expect(phoneSeat.inDock, 'phone: the sequence left the dock').toBe(true);
    expect(phoneSeat.inSection, 'phone: the sequence entered the drawer section').toBe(false);

    await page.setViewportSize(DESKTOP_VIEWPORT);
    await gotoApp(page, '?embed=true&view=console&cluster=heat&select=state:WA');
    await expect(sequence).toBeVisible();
    const embedSeat = await page.evaluate(() => {
      const node = document.getElementById('heatrisk-sequence');
      const dock = document.getElementById('map-bottom-dock');
      const section = document.getElementById('detail-section-heatrisk-sequence');
      return {
        inDock: Boolean(node && dock && dock.contains(node)),
        inSection: Boolean(node && section && section.contains(node))
      };
    });
    expect(embedSeat.inDock, 'embed: the sequence left the dock').toBe(true);
    expect(embedSeat.inSection, 'embed: the sequence entered the drawer section').toBe(false);
  });
});

/**
 * S30D P2-CI: `cluster=heat` turns the NWS alerts layer on, and the layer
 * reads NOAA's WWA MapServer with a 15 s budget while `gotoApp` waits 10 s
 * for boot-idle, so a slow NOAA answer failed the first case above on
 * GitHub (`pending layer keys = ["nws-alerts"]`). `gotoApp` now answers that
 * service from `tests/nws-wwa-fixtures.ts`, like NADM and NIFC. These cases
 * hold the default honest.
 *
 * The backstop is a CONTEXT route registered BEFORE the first boot. A later
 * route outranks an earlier one, so the default (registered inside `gotoApp`)
 * answers first; the backstop sees only a WWA request that no stub answered,
 * records it, and answers it with the same empty body so no case touches
 * NOAA. Predicted red on the pre-change tree: the backstop sees the layer's
 * one query.
 */
function installWwaBackstop(page: Page): Promise<string[]> {
  const reached: string[] = [];
  return page
    .context()
    .route(
      (url) => isNwsWwaRequestUrl(url),
      (route) => {
        reached.push(route.request().url());
        return route.fulfill({
          status: 200,
          contentType: 'application/geo+json',
          body: JSON.stringify(NWS_WWA_EMPTY)
        });
      }
    )
    .then(() => reached);
}

test.describe('the NWS WWA default stub (S30D P2-CI)', () => {
  test('a cluster=heat boot answers the WWA MapServer locally: the default stub answers the layer query and none reaches the backstop', async ({
    page
  }) => {
    const reached = await installWwaBackstop(page);
    await stubHeatRiskCatalog(page);
    await gotoApp(page, '?view=console&cluster=heat');

    expect(reached, 'WWA requests no stub answered').toEqual([]);
    const answers = nwsWwaStubLog(page).map((entry) => entry.answer);
    expect(answers.length, 'the default stub answered the layer query').toBeGreaterThan(0);
    expect(
      answers.every((answer) => answer === 'features'),
      'every answered WWA request was the layer query'
    ).toBe(true);
    // The empty answer is the layer's honest "no active alerts" result, not
    // an error: the pill is the tree's own no-features label.
    await expect(layerPill(page, 'nws-alerts')).toContainText('no features');
  });

  test('a spec that routes WWA itself still wins over the default, which then answers nothing', async ({
    page
  }) => {
    const reached = await installWwaBackstop(page);
    await page.route(
      (url) => isNwsWwaRequestUrl(url),
      (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
    );
    await stubHeatRiskCatalog(page);
    await gotoApp(page, '?view=console&cluster=heat');

    await expect(layerPill(page, 'nws-alerts')).toHaveText(PILL.unavailable);
    expect(nwsWwaStubLog(page), 'the default answered a routed request').toEqual([]);
    expect(reached, 'WWA requests no stub answered').toEqual([]);
  });

  test('the explicit nwsWwa: live opt-out installs a pass-through, so the request reaches whatever route the spec registered earlier', async ({
    page
  }) => {
    const reached = await installWwaBackstop(page);
    await stubHeatRiskCatalog(page);
    await gotoApp(page, '?view=console&cluster=heat', { nwsWwa: 'live' });

    expect(reached.length, 'the pass-through reached the earlier route').toBeGreaterThan(0);
    expect(nwsWwaStubLog(page), 'the default answered under the opt-out').toEqual([]);
  });
});
