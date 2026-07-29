import { test, expect, type Page } from '@playwright/test';
import { gotoApp } from './helpers';

/**
 * S4a: the rendered layout spike (the S4 design record section 5). The
 * no-scroll contract is set by a rendered measurement, not arithmetic:
 * at the 340 px panel width, after font load, with the full
 * representation caveat and a long full-formal Tribal Nation name
 * present in the response foot, the panel must show everything it owns
 * without scrolling at the >=700 and 600-699 height bands; below 600
 * the honest scroll returns.
 *
 * MEASURED RESULT (2026-07-24, re-measured after the DG-080 review):
 * the settled default Brief column carries ~1206 px of content
 * (conditions strip ~114 + brief head ~180 + shell ~480 + refine ~172 +
 * legend ~253) against ~601 px of region at the 700 band, and the
 * overflow persists to ~1774 px of viewport once the response foot is
 * open. The no-scroll acceptance is therefore NOT MET by composition
 * alone at ANY realistic height; the design-sanctioned resolutions are
 * a panel-inventory subtraction (pre-S4 Brief surfaces leaving the
 * column: a conductor ruling this lane does not own) or an explicit
 * threshold raise (the measured ~1774/~1300 numbers, which would move
 * the band boundaries beyond every real screen; also a design ruling).
 *
 * REHOST FEASIBILITY (2026-07-25, the r3 pass, measured on the built
 * app; DG-080 r2 finding 2 conductor ruling "rehost the pre-S4 Brief
 * inventory behind a door"): the arithmetic does not close without a
 * maintainer call. The band-1 region is 601 px and the shell band is
 * fixed at 480 px (inline minimap 219 per the ruled band shape),
 * leaving a 121 px budget. The pre-S4 surfaces that OTHER ratified
 * contracts pin visible on the default desktop Brief measure: the one
 * place search 72 (u3i / view-mode / the design's own acceptance
 * inventory), the Tribal Nations action row 62 (the umbrella
 * visibility guarantee: umbrella.spec "a bare desktop boot shows the
 * compact action"), the studio door pair 28 (left-panel-option1 /
 * studio-a11y), plus legend 253 (legend.spec), conditions strip 114
 * (conditions-strip.spec), and the ENSO driver 35 (enso-driver.spec).
 * Even the smallest honest variant (search + Tribal action + one door
 * row ~= 174 px) exceeds the 121 px budget, so EVERY fitting rehost
 * must demote at least one ratified-pinned surface (the sovereignty-
 * adjacent Tribal Nations action among the candidates) and rewrite
 * the pins across roughly ten suites. Which surfaces lose default
 * visibility is a design and stewardship prioritization this lane does
 * not own; the finding is STOPPED and surfaced to the maintainer with
 * these numbers (the conductor ruling's named infeasibility branch).
 *
 * RULED 2026-07-27 (maintainer, in session): the no-scroll acceptance is
 * DROPPED, not deferred. The arithmetic never closed and the price of
 * closing it was too high: a 121 px budget (the 601 px band-1 region less
 * the fixed 480 px shell band) against 564 px of surfaces that OTHER
 * ratified contracts pin visible. Demoting the legend, conditions strip,
 * and ENSO driver still leaves 174 px against 121, so the remaining three
 * must be cut into; of those, only removing the place search (72) or the
 * Tribal Nations action row (62) actually fits, and the Tribal Nations row
 * is the protected last candidate for a door. Buying no-scroll therefore
 * meant demoting five of six ratified surfaces and rewriting pins across
 * roughly ten suites, to win a layout property. The honest scroll is the
 * shipped contract instead.
 *
 * The two former `test.fail()` acceptance tests are accordingly RETIRED,
 * their band-shape assertions folded into the honest-scroll tests below.
 * The fallback contract (overflow never clipped out of reach) and the
 * stewardship pair (the caveat scrolls uncut; the frozen head stays
 * visible) were always the genuinely passing assertions and now carry the
 * band alone.
 * The fallback contract (overflow is never clipped out of reach) and
 * the stewardship pair (the caveat scrolls uncut within the bounded
 * foot; the frozen head stays visible) are separate, genuinely passing
 * assertions.
 *
 * The response fixture is injected DOM (the real sink is driven by map
 * clicks, covered in s4-response-time.spec.ts); the spike measures the
 * CSS contract, so representative content is the honest instrument.
 */

const LONG_NAME =
  'Confederated Tribes and Bands of the Yakama Nation of the Yakama Reservation, Washington';

const REPRESENTATION_CAVEAT =
  'Boundary shown is the Bureau of Indian Affairs Land Area Representation, a cartographic ' +
  'representation of the exterior extent of land areas, not a definitive depiction of Tribal ' +
  'jurisdiction. Treaty boundaries shown anywhere in this module are representations of Treaty ' +
  'cession areas and are not a definitive depiction of Tribal jurisdiction; Treaty rights and ' +
  'Tribal sovereignty are matters of sovereign authority. Land-area labels come from the agency ' +
  'source and are not a Tribal Nation’s own name for itself. Consult the Tribal Nation ' +
  'directly for authoritative boundary and jurisdiction information.';

async function injectResponseFixture(page: Page): Promise<void> {
  await page.evaluate(
    ([name, caveat]) => {
      const host = document.getElementById('panel-response');
      if (!host) throw new Error('no #panel-response host');
      host.toggleAttribute('data-open', true);
      const card = document.createElement('section');
      card.className = 'panel-response-card';
      card.id = 's4-spike-card';
      const bar = document.createElement('div');
      bar.className = 'panel-response-bar';
      const ctx = document.createElement('span');
      ctx.className = 'panel-response-context';
      ctx.textContent = 'Drought view · Current';
      bar.appendChild(ctx);
      const hostDiv = document.createElement('div');
      hostDiv.className = 'panel-response-host';
      const resp = document.createElement('div');
      resp.className = 'coordinated-response';
      const head = document.createElement('div');
      head.className = 'coordinated-response-head';
      const title = document.createElement('div');
      title.className = 'popup-title';
      title.textContent = name ?? '';
      const door = document.createElement('button');
      door.type = 'button';
      door.textContent = 'Open drought impact briefing';
      head.append(title, door);
      const body = document.createElement('div');
      body.className = 'coordinated-response-body';
      const p = document.createElement('p');
      p.textContent = caveat ?? '';
      body.appendChild(p);
      resp.append(head, body);
      hostDiv.appendChild(resp);
      card.append(bar, hostDiv);
      host.appendChild(card);
    },
    [LONG_NAME, REPRESENTATION_CAVEAT]
  );
}

interface Measurement {
  sidebarWidth: number;
  sidebarFits: boolean;
  scrollRegionFits: boolean;
  caveatScrolls: boolean;
  caveatVisibleTitle: boolean;
}

async function measure(page: Page): Promise<Measurement> {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  return page.evaluate(() => {
    const sidebar = document.getElementById('sidebar');
    const scroll = document.querySelector('.sidebar-scroll');
    const body = document.querySelector(
      '#s4-spike-card .coordinated-response-body'
    );
    const title = document.querySelector('#s4-spike-card .popup-title');
    if (!sidebar || !scroll || !body || !title) throw new Error('spike DOM missing');
    const titleRect = title.getBoundingClientRect();
    return {
      sidebarWidth: sidebar.clientWidth,
      sidebarFits: sidebar.scrollHeight <= sidebar.clientHeight,
      scrollRegionFits: scroll.scrollHeight <= scroll.clientHeight,
      caveatScrolls: body.scrollHeight > body.clientHeight,
      caveatVisibleTitle: titleRect.height > 0 && titleRect.bottom <= window.innerHeight
    };
  });
}

async function settleAndInject(page: Page): Promise<void> {
  await gotoApp(page);
  await expect(page.locator('.shell-cluster-btn')).toHaveCount(4);
  // Measure the maximal steady state: the settled default display can
  // bring the legend and conditions strip with it.
  await expect(
    page.locator('.shell-cluster-btn[data-cluster="drought"]')
  ).toHaveAttribute('data-pending', 'false', { timeout: 45_000 });
  await injectResponseFixture(page);
}

async function assertHonestScrollFallback(page: Page): Promise<void> {
  // The fallback contract (design record section 5): overflow is NEVER
  // clipped out of reach; an honest scrollbar governs.
  const overflowY = await page.evaluate(() => {
    const scroll = document.querySelector('.sidebar-scroll');
    if (!scroll) throw new Error('no .sidebar-scroll');
    return window.getComputedStyle(scroll).overflowY;
  });
  expect(overflowY).toBe('auto');
}

test.describe('band 1: >= 700px height', () => {
  test.use({ viewport: { width: 1024, height: 700 } });

  test('band shape, honest scroll, and stewardship: the caveat scrolls uncut within the foot', async ({
    page
  }) => {
    await settleAndInject(page);
    // The full inline minimap belongs to this band (carried from the
    // retired no-scroll acceptance test, which the ruling dissolved).
    await expect(page.locator('.shell-minimap-map .shell-minimap-canvas')).toBeVisible();
    const m = await measure(page);
    // Tolerant width: clientWidth rounds and excludes the border, so the
    // 340 px design width can measure 339 (a strict equality here masked
    // the band's real fit result on clean builds).
    expect(m.sidebarWidth).toBeGreaterThanOrEqual(336);
    expect(m.sidebarWidth).toBeLessThanOrEqual(344);
    await assertHonestScrollFallback(page);
    // The stewardship line: the long caveat is PRESENT and scrolls within
    // the foot's bounded body; the frozen head (the full formal name)
    // stays visible. Never truncation to win the layout.
    expect(m.caveatScrolls).toBe(true);
    expect(m.caveatVisibleTitle).toBe(true);
  });
});

test.describe('band 2: 600-699px height', () => {
  test.use({ viewport: { width: 1024, height: 600 } });

  test('the minimap collapses to its door; honest scroll governs; the caveat pair holds', async ({
    page
  }) => {
    await settleAndInject(page);
    await expect(page.locator('#shell-minimap-door')).toBeVisible();
    await expect(page.locator('.shell-minimap-map .shell-minimap-canvas')).toBeHidden();
    const m = await measure(page);
    await assertHonestScrollFallback(page);
    expect(m.caveatScrolls).toBe(true);
    expect(m.caveatVisibleTitle).toBe(true);
  });
});

test.describe('band 3: < 600px height', () => {
  test.use({ viewport: { width: 1024, height: 560 } });

  test('honest scroll returns; nothing is clipped', async ({ page }) => {
    await gotoApp(page);
    await expect(page.locator('.shell-cluster-btn')).toHaveCount(4);
    await assertHonestScrollFallback(page);
  });
});
