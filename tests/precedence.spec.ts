import { isExternalHttp } from './offline-test';
import { test, expect } from './offline-test';
import {
  gotoApp,
  regionSelect,
  search,
  stubHeatRiskCatalog,
  waitForLayerSettled
} from './helpers';

/**
 * S30D D1's precedence spec (DDM-P10-T13, DR-109; the "precedence spec" named
 * in the checkpoint's own gate). Pins the URL, Reset and embed precedence
 * rules from `planning/2026-09-25-desktop-pass/design/precedence.md` rows A1,
 * D1 to D3, G1 and G4, and the Q6 fix to `selectRegion`'s
 * closeImpactPanel guard (`src/ui/sidebar.ts:558-564`).
 *
 * DR-109: `DEFAULT_REGION` moves from `washington_state` to `national`. Every
 * case below that names `region:national` fails on the pre-flip tree, where
 * a bare boot still frames Washington.
 */
test.describe('precedence: boot, Reset and embed defaults (DR-109)', () => {
  test('a bare desktop boot frames the nation, opens the sidebar, and writes no mode, 3D, imagery or sidebar token', async ({
    page
  }) => {
    await gotoApp(page);

    await expect(regionSelect(page)).toHaveValue('region:national');
    await expect(page.locator('#app')).not.toHaveClass(/\bsidebar-collapsed\b/);
    await expect(page.locator('#sidebar')).toBeVisible();

    const params = new URLSearchParams(await search(page));
    // Drought is the default mode, encoded by the ABSENCE of `cluster=`
    // (src/config/clusters.ts: drought's urlToken is null).
    expect(params.has('cluster')).toBe(false);
    // Neither 3D key exists in this URL yet (D4 has not shipped).
    expect(params.has('terrain3d')).toBe(false);
    expect(params.has('fire3d')).toBe(false);
    // No imagery view or sidebar-collapse token: every default is absence.
    expect(params.has('basemap')).toBe(false);
    expect(params.has('sidebar')).toBe(false);
  });

  test('Reset under the national default keeps the typed place and an open briefing', async ({
    page
  }) => {
    // Where a user can press Reset with a briefing open: the phone. On the
    // desktop the briefing is a modal dialog seated over the right edge
    // (`.impact-panel` is fixed top/right/bottom above the map controls,
    // aria-modal="true" with a Tab trap, src/ui/impact-panel.ts:176-192,
    // :266), so #reset-btn sits under it and no pointer or keyboard reaches
    // it until the briefing closes. On the phone the briefing is hosted in
    // the sheet, non-modal, at the half detent, and the right-side map
    // controls stay reachable beside it (tests/hazard-rail.spec.ts, "the
    // rail stays reachable beside open panels").
    await page.setViewportSize({ width: 390, height: 844 });
    // select=state:WA opens the impact briefing at boot; the boot's silent
    // region fit (national, DR-109) runs first and sets STATE.currentRegion.
    await gotoApp(page, '?select=state:WA');

    const app = page.locator('#app');
    const panel = page.locator('#impact-panel');
    await expect(page.locator('#sheet-report .impact-panel')).toHaveCount(1, { timeout: 15_000 });
    await expect(app).toHaveAttribute('data-sheet-detent', 'half');
    await expect(panel).toHaveClass(/\bopen\b/);
    await expect(panel.locator('#impact-panel-title')).toHaveText('Washington');
    await expect(regionSelect(page)).toHaveValue('region:national');

    // Reset re-selects the SAME region (national). Before the Q6 fix,
    // selectRegion's closeImpactPanel guard fires unconditionally whenever
    // the target region's impactSynthesis is 'none' (which national's is,
    // src/config/capability-matrix.ts:124-127), closing the just-opened
    // briefing even though the region never changed.
    await page.locator('#reset-btn').click();

    await expect(regionSelect(page)).toHaveValue('region:national');
    await expect(panel).toHaveClass(/\bopen\b/);
    // The briefing the Reset left open is the one the full report shows:
    // raise it and read it, visible, still on the typed place.
    await page.locator('#sheet-report-door').click();
    await expect(app).toHaveAttribute('data-sheet-detent', 'full');
    await expect(panel).toBeVisible();
    await expect(panel.locator('#impact-panel-title')).toHaveText('Washington');
  });

  test('Reset returns a framing boot to the national default', async ({ page }) => {
    await gotoApp(page, '?framing=arid-west');
    await expect
      .poll(async () => new URLSearchParams(await search(page)).get('framing'))
      .toBe('arid-west');

    await page.locator('#reset-btn').click();

    // The legacy region fit under the framing boot is DEFAULT_REGION
    // (national after DR-109); an explicit region click clears framing=.
    await expect(regionSelect(page)).toHaveValue('region:national');
    await expect
      .poll(async () => new URLSearchParams(await search(page)).get('framing'))
      .toBeNull();
  });

  test('Reset changes only the camera claim', async ({ page }) => {
    await gotoApp(page, '?layers=usdm,tribal&view=console');
    await waitForLayerSettled(page, 'usdm');

    const before = new URLSearchParams(await search(page));
    expect(before.get('region')).toBe('national');

    await page.locator('#reset-btn').click();

    const after = new URLSearchParams(await search(page));
    expect(after.get('region')).toBe('national');
    for (const key of ['layers', 'view']) {
      expect(after.get(key), `${key} unchanged by Reset`).toBe(before.get(key));
    }
  });

  test('an embed pinned to region=washington_state&view=brief keeps the Washington framing and the Brief door', async ({
    page
  }) => {
    await gotoApp(page, '?embed=true&region=washington_state&view=brief');

    await expect(page.locator('#app')).toHaveClass(/\bembed\b/);
    await expect(regionSelect(page)).toHaveValue('region:washington_state');

    const params = new URLSearchParams(await search(page));
    expect(params.get('view')).toBe('brief');
    // The Brief door never mounts the console catalog island (headroom C1;
    // src/ui/sidebar.ts's isBriefEmbed boot decision). `#catalog-search` is
    // a static container in index.html that every boot carries, so the
    // island's absence is read from what it renders: no layer checkbox at
    // all (tests/boundary-stubs.spec.ts, "the brief embed").
    await expect(page.locator('input[data-layer-key]')).toHaveCount(0);
  });

  test.describe('G1: duplicate and invalid tokens (pin today\'s behaviour, pass before and after)', () => {
    test('a duplicated region resolves first-wins (pinned)', async ({ page }) => {
      await gotoApp(page, '?region=central_oregon&region=cascades');
      await expect(regionSelect(page)).toHaveValue('region:central_oregon');
    });

    test('temporal tokens resolve first-wins and invalid reads as now', async ({ page }) => {
      // horizon=: a duplicated key resolves via URLSearchParams.get, which
      // returns only the first occurrence (the same rule week, dmode, sst
      // and outlook follow). The bare-cluster boot now composes the Drought
      // recipe at the winning horizon (found-030), which reaches the CPC
      // outlook layer, so this boot needs the stub too.
      await stubCpcDroughtOutlook(page);
      await gotoApp(page, '?horizon=weeks-ahead&horizon=season-ahead');
      expect(new URLSearchParams(await search(page)).get('horizon')).toBe('weeks-ahead');

      // An invalid token reads as the default ("now"/current), which is
      // absence in the canonical URL.
      await gotoApp(page, '?horizon=bogus');
      expect(new URLSearchParams(await search(page)).get('horizon')).toBeNull();
    });

    test('heatday and spi duplicates are rejected, never resolved by position', async ({
      page
    }) => {
      await gotoApp(page, '?cluster=heat&heatday=3&heatday=6');
      expect(new URLSearchParams(await search(page)).get('heatday')).toBeNull();

      await gotoApp(page, '?spi=30&spi=60');
      expect(new URLSearchParams(await search(page)).get('spi')).toBeNull();
    });
  });

  // A6 (D1 M6, 2026-09-27; found-009, DDM-P10-T09): a deep link to a horizon
  // the mode cannot show boots on Current Conditions. Outside G1 on purpose:
  // G1 pins behaviour that passes before and after, and this row is red
  // before its fix. Extreme Heat's season-ahead recipe is empty
  // (src/config/clusters.ts: no verified surface exists yet), so the deep
  // link used to commit that empty horizon anyway and press the very chip
  // `horizonDisabledReason` (src/ui/island/shell.tsx) disables. The parser
  // now boots it on `current` (src/state/url.ts's resolveHorizonForCluster).
  test('a deep link to a horizon the mode cannot show boots on Current Conditions', async ({
    page
  }) => {
    // The redirected boot shows Extreme Heat's current recipe (HeatRisk and
    // the WWA notices): both answered locally.
    await stubHeatRiskCatalog(page);
    await page.route(
      (url) => url.pathname.endsWith('/watch_warn_adv/MapServer/1/query'),
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/geo+json',
          body: JSON.stringify({ type: 'FeatureCollection', features: [] })
        })
    );
    await gotoApp(page, '?view=console&cluster=heat&horizon=season-ahead');

    const current = page.locator('.shell-horizon-btn[data-horizon="current"]');
    const season = page.locator('.shell-horizon-btn[data-horizon="season-ahead"]');
    await expect(current).toHaveAttribute('aria-pressed', 'true');
    expect(await current.getAttribute('aria-disabled')).toBeNull();
    // The unshowable horizon stays unpressed AND disabled with its reason.
    expect(await season.getAttribute('aria-pressed')).toBe('false');
    expect(await season.getAttribute('aria-disabled')).toBe('true');
    // horizon=current is absence in the canonical URL; the mode survives.
    const params = new URLSearchParams(await search(page));
    expect(params.get('horizon')).toBeNull();
    expect(params.get('cluster')).toBe('heat');
    // The redirect lands on a real surface, not a reference-only read.
    await expect(page.locator('input[data-layer-key="heatrisk"]')).toBeChecked();
  });
});

// ---------------------------------------------------------------------------
// D1 M7: the `sidebar=` key (DDM-P10-T07 D1 half, owner item 1a; DR-139;
// precedence.md section 2.2 and rows F1 to F8, A3, J1; the Codex Tier 2
// disposition's records S1, S2, S3 and S4+S6). The imports sit here, above
// the describe they serve, so this block and the boot describe above can be
// edited independently.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Frame, Page, Route } from './offline-test';
import {
  SIDEBAR_DESKTOP_QUERY,
  normalizeSidebarParam,
  parseEmbedParam,
  parseSidebarParam,
  parseUrlParams
} from '../src/state/url';
import { installFakeBrowser } from './map-harness';
import { installBoundaryStubs } from './tribal-fixtures';
import { installMinimapAnalysisStubs } from './minimap-fixtures';
import { stubRecentSatellite } from './satellite-fixture';
import { installDefaultNifcStub } from './wildfire-fixtures';
import { stubCpcSeasonalTempOutlook, stubSpcFireOutlook } from './helpers';
import { stubCpcDroughtOutlook } from './cpc-outlook-fixtures';
import { DEFAULT_REGION, REGIONS } from '../src/config/regions';
import { VIEW_PRESETS, type ViewPreset } from '../src/config/presets';

const M7_DESKTOP = { width: 1280, height: 720 } as const;
const M7_PHONE = { width: 390, height: 844 } as const;
/** The inline classic bootstrap's id in index.html (S1). */
const SIDEBAR_BOOT_ID = 'ddm-sidebar-boot';
/** A synthesized same-origin host document that frames the app (F7, F8, S6). */
const HOST_PATH = '/ddm-precedence-host.html';
/** A synthesized same-origin page the real bfcache case navigates away to. */
const AWAY_PATH = '/ddm-precedence-away.html';
/**
 * The Pages-like subpath mount: GitHub Pages serves the artifact beneath the
 * repository name, the seat tests/deployment-subpath.spec.ts and
 * tests/static-host-paths.spec.ts mount it at.
 */
const PAGES_MOUNT = '/dynamic-drought-module/';
/** Both mounts the first-paint cases run against (the Codex M7 review, F1). */
const M7_MOUNTS: ReadonlyArray<{ readonly label: string; readonly path: string }> = [
  { label: 'root mount', path: '/' },
  { label: 'Pages-like subpath mount', path: PAGES_MOUNT }
];
type M7Studio = 'layers' | 'place';
/** The map document and the two studio documents (`studio=`'s vocabulary,
 * src/state/url.ts parseStudioParam). */
const M7_DOCUMENTS: ReadonlyArray<{ readonly label: string; readonly studio: M7Studio | null }> = [
  { label: 'map document', studio: null },
  { label: 'Layers studio document', studio: 'layers' },
  { label: 'Place studio document', studio: 'place' }
];

/** A document path at a mount: the query, plus the studio token for a studio
 * document. `query` carries no leading `?`. */
function mountedDocumentPath(mountPath: string, studio: M7Studio | null, query: string): string {
  return `${mountPath}?${studio === null ? query : `${query}&studio=${studio}`}`;
}

/**
 * Serve the Pages-like subpath from the preview's root: the mounting
 * technique of tests/deployment-subpath.spec.ts. Register it BEFORE any
 * narrower route (gotoApp's stubs, a held entry): Playwright runs the most
 * recently registered matching route first, so those still win.
 */
async function installPagesMount(page: Page): Promise<void> {
  await page.route(`**${PAGES_MOUNT}**`, async (route) => {
    const requested = new URL(route.request().url());
    const mountedPath = requested.pathname.slice(PAGES_MOUNT.length - 1) || '/';
    const previewUrl = new URL(`${mountedPath}${requested.search}`, requested.origin);
    try {
      if (isExternalHttp(new URL(route.request().url()))) return route.fallback();
      const response = await route.fetch({ url: previewUrl.href });
      await route.fulfill({ response });
    } catch {
      // The page moved on or closed while the preview answered.
      await route.abort('failed').catch(() => undefined);
    }
  });
}

interface SidebarChrome {
  readonly collapsed: boolean;
  readonly embed: boolean;
  /** The column is painted: not visibility:hidden and wider than one pixel. */
  readonly exposed: boolean;
}

async function sidebarChrome(target: Page | Frame): Promise<SidebarChrome> {
  return target.evaluate(() => {
    const app = document.getElementById('app');
    const sidebar = document.getElementById('sidebar');
    const style = sidebar ? getComputedStyle(sidebar) : null;
    const width = sidebar ? sidebar.getBoundingClientRect().width : 0;
    return {
      collapsed: app?.classList.contains('sidebar-collapsed') ?? false,
      embed: app?.classList.contains('embed') ?? false,
      exposed:
        style !== null &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        width > 1
    };
  });
}

async function sidebarTokens(target: Page | Frame): Promise<string[]> {
  return target.evaluate(() =>
    new URLSearchParams(window.location.search).getAll('sidebar')
  );
}

/** Two animation frames: every media-query change event queued by a resize
 * is dispatched before the first frame's callbacks run. */
async function afterFrames(target: Page | Frame): Promise<void> {
  await target.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      })
  );
}

/**
 * The suite-wide stubs `gotoApp` installs, installed by hand for the boots
 * below that cannot go through `gotoApp` (a held entry module never reaches
 * DOMContentLoaded, and a framed app never builds the top page's chips).
 * NADM is module-private in tests/helpers.ts, so its empty answer is routed
 * here.
 */
async function installRawBootStubs(page: Page): Promise<void> {
  await stubRecentSatellite(page);
  await installBoundaryStubs(page, 'fixture');
  await installMinimapAnalysisStubs(page);
  await stubCpcSeasonalTempOutlook(page);
  await stubSpcFireOutlook(page);
  await installDefaultNifcStub(page, 'fixture');
  await page.route('**/NADM-current.geojson', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: JSON.stringify({ type: 'FeatureCollection', features: [] })
    })
  );
  await page.route(
    (url) => url.pathname === HOST_PATH,
    (route) => {
      const url = new URL(route.request().url());
      const width = Number(url.searchParams.get('w') ?? '1024');
      const src = (url.searchParams.get('src') ?? '/').replace(/&/g, '&amp;');
      return route.fulfill({
        contentType: 'text/html',
        body: [
          '<!doctype html>',
          '<html><head><meta charset="utf-8">',
          '<style>html,body{margin:0}',
          `iframe{display:block;border:0;width:${width}px;height:680px}</style>`,
          '</head><body>',
          `<iframe title="Framed DDM" src="${src}"></iframe>`,
          '</body></html>'
        ].join('')
      });
    }
  );
}

/** The one navigation in this block that bypasses `gotoApp`. */
async function rawNavigate(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'commit' });
}

/** The framed app of the host document, once its map-dependent half is wired.
 * `previous` is a frame the caller has just replaced, never returned. */
async function framedApp(page: Page, previous?: Frame): Promise<Frame> {
  let frame: Frame | undefined;
  await expect
    .poll(() => {
      frame = page
        .frames()
        .find(
          (f) => f.parentFrame() === page.mainFrame() && !f.isDetached() && f !== previous
        );
      return frame !== undefined;
    })
    .toBe(true);
  await expect(frame!.locator('html')).toHaveAttribute('data-ddm-controls', 'ready', {
    timeout: 30_000
  });
  return frame!;
}

async function bootFramed(page: Page, src: string, width: number): Promise<Frame> {
  await rawNavigate(page, `${HOST_PATH}?w=${width}&src=${encodeURIComponent(src)}`);
  return framedApp(page);
}

/**
 * Recreate the host's iframe from its ORIGINAL `src` attribute (F8): a new
 * element, not a reload of the old one. In-frame history writes never touch
 * the parent's attribute, so the returned `src` is what the embedder wrote.
 */
async function recreateFrame(
  page: Page,
  previous: Frame
): Promise<{ readonly frame: Frame; readonly src: string }> {
  const src = await page.evaluate(() => {
    const old = document.querySelector('iframe');
    if (!old) throw new Error('the host document has no iframe');
    const original = old.getAttribute('src') ?? '';
    const next = document.createElement('iframe');
    next.title = old.title;
    next.setAttribute('src', original);
    old.replaceWith(next);
    return original;
  });
  return { frame: await framedApp(page, previous), src };
}

/**
 * One in-frame canonical write: a region choice through the region select's
 * own change handler (src/ui/sidebar.ts buildRegionSelect, then selectRegion
 * and pushUrl). Dispatched in the frame because the select sits in a hidden
 * column in an embed and a collapsed sidebar alike.
 */
async function chooseRegionIn(target: Page | Frame, key: string): Promise<void> {
  await target.evaluate((value: string) => {
    const select = document.getElementById('region-select');
    if (!(select instanceof HTMLSelectElement)) throw new Error('no #region-select');
    select.value = value;
    select.dispatchEvent(new Event('change'));
  }, `region:${key}`);
  await expect
    .poll(() => target.evaluate(() => new URLSearchParams(window.location.search).get('region')), {
      message: `the region write to ${key}`
    })
    .toBe(key);
}

/**
 * Record every clipboard write in every document of the page, frames
 * included (src/ui/share.ts copies `window.location.href` through
 * src/util/clipboard.ts's navigator.clipboard path).
 */
async function installClipboardRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const copies: string[] = [];
    (window as unknown as { __ddmCopies: string[] }).__ddmCopies = copies;
    Object.defineProperty(Navigator.prototype, 'clipboard', {
      configurable: true,
      get: () => ({
        writeText: async (text: string): Promise<void> => {
          copies.push(text);
        }
      })
    });
  });
}

/** Press Share in `target` and return the exact text it copied. */
async function copiedShareHref(target: Page | Frame): Promise<string> {
  const before = await target.evaluate(
    () => (window as unknown as { __ddmCopies: string[] }).__ddmCopies.length
  );
  await target.evaluate(() => {
    (document.getElementById('share-btn') as HTMLElement | null)?.click();
  });
  let copied: string | undefined;
  await expect
    .poll(async () => {
      copied = await target.evaluate(
        (count: number) =>
          (window as unknown as { __ddmCopies: string[] }).__ddmCopies[count],
        before
      );
      return copied !== undefined;
    })
    .toBe(true);
  return copied!;
}

test.describe('D1 M7: the sidebar= key (DDM-P10-T07, DR-139)', () => {
  test('only a single sidebar=closed closes the sidebar (pure)', () => {
    // Section 2.2: closed only when the key appears exactly once with the
    // exact value `closed`; everything else is the open default and is dropped
    // on the next write. An embed ignores the key (rule 5).
    const cases: ReadonlyArray<readonly [string, boolean]> = [
      ['', false],
      ['sidebar=closed', true],
      ['sidebar=open', false],
      ['sidebar=x', false],
      ['sidebar=', false],
      ['sidebar=CLOSED', false],
      ['sidebar=closed%20', false],
      ['sidebar=closed&sidebar=closed', false],
      ['sidebar=closed&sidebar=open', false],
      ['sidebar=open&sidebar=closed', false]
    ];
    for (const [query, closed] of cases) {
      expect(parseSidebarParam(new URLSearchParams(query)), query).toBe(closed);
      const params = new URLSearchParams(`region=national&${query}&view=brief`);
      normalizeSidebarParam(params);
      expect(params.getAll('sidebar'), `normalized ${query}`).toEqual(closed ? ['closed'] : []);
      expect(params.get('region'), `normalized ${query} keeps its neighbours`).toBe('national');
      expect(params.get('view'), `normalized ${query} keeps its neighbours`).toBe('brief');
    }
    // Embed outranks the key: the embed grammar is first-wins `true` or `1`.
    const embedCases: ReadonlyArray<readonly [string, boolean]> = [
      ['embed=true&sidebar=closed', false],
      ['embed=1&sidebar=closed', false],
      ['embed=false&sidebar=closed', true],
      ['embed=TRUE&sidebar=closed', true],
      ['embed=true&embed=false&sidebar=closed', false],
      ['embed=false&embed=true&sidebar=closed', true]
    ];
    for (const [query, kept] of embedCases) {
      const params = new URLSearchParams(query);
      normalizeSidebarParam(params);
      expect(params.getAll('sidebar'), query).toEqual(kept ? ['closed'] : []);
      expect(params.getAll('embed'), `${query} keeps embed`).toEqual(
        new URLSearchParams(query).getAll('embed')
      );
    }
  });

  test('only a single sidebar=closed closes the sidebar (browser)', async ({ page }) => {
    await page.setViewportSize(M7_DESKTOP);
    const cases: ReadonlyArray<readonly [string, boolean]> = [
      ['?sidebar=closed', true],
      ['?sidebar=open', false],
      ['?sidebar=CLOSED', false],
      ['?sidebar=', false],
      ['?sidebar=closed&sidebar=closed', false]
    ];
    for (const [query, closed] of cases) {
      await gotoApp(page, query);
      const chrome = await sidebarChrome(page);
      expect(chrome.collapsed, `${query}: collapsed`).toBe(closed);
      expect(chrome.exposed, `${query}: painted`).toBe(!closed);
      // The canonical write keeps only the one emitted form.
      await expect
        .poll(() => sidebarTokens(page), { message: `${query}: canonical sidebar=` })
        .toEqual(closed ? ['closed'] : []);
    }
  });

  test('a desktop first load opens the sidebar', async ({ page }) => {
    // F1: no sidebar= at 721 CSS px and wider, not an embed. Landed with M1
    // (index.html no longer ships the collapsed class); pinned here at the
    // breakpoint itself and at the default desktop width.
    for (const width of [721, M7_DESKTOP.width]) {
      await page.setViewportSize({ width, height: 800 });
      await gotoApp(page);
      const chrome = await sidebarChrome(page);
      expect(chrome.collapsed, `${width}: collapsed`).toBe(false);
      expect(chrome.exposed, `${width}: painted`).toBe(true);
      expect(await sidebarTokens(page), `${width}: no sidebar token`).toEqual([]);
    }
  });

  test('closing the sidebar round-trips through the URL, a reload and a studio Back', async ({
    page
  }) => {
    // F2 and H4's sidebar clause. Before M7 the collapse handler wrote
    // nothing, so the first poll below stayed empty.
    await page.setViewportSize(M7_DESKTOP);
    await gotoApp(page, '?view=brief&layers=places');
    const app = page.locator('#app');
    const historyLength = (): Promise<number> => page.evaluate(() => window.history.length);
    const lengthBefore = await historyLength();

    await page.locator('#sidebar-collapse').click();
    await expect(app).toHaveClass(/\bsidebar-collapsed\b/);
    await expect.poll(() => sidebarTokens(page)).toEqual(['closed']);
    // replaceState (ruling R5 a): the toggle adds no history step.
    expect(await historyLength()).toBe(lengthBefore);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('html')).toHaveAttribute('data-ddm-controls', 'ready');
    await expect(app).toHaveClass(/\bsidebar-collapsed\b/);
    expect(await sidebarTokens(page)).toEqual(['closed']);
    expect((await sidebarChrome(page)).exposed).toBe(false);

    // A studio entry pushed from the map carries the key, and Back through it
    // returns to a map entry that still carries it. The entry control lives
    // in the collapsed column, so it is invoked directly.
    await expect(page.locator('#layers-studio-entry')).toHaveCount(1);
    await page.evaluate(() => {
      (document.getElementById('layers-studio-entry') as HTMLElement | null)?.click();
    });
    await expect(page.locator('#layers-studio-root')).toBeVisible();
    expect(new URLSearchParams(await search(page)).get('studio')).toBe('layers');
    expect(await sidebarTokens(page)).toEqual(['closed']);

    await page.goBack();
    await expect(page.locator('#layers-studio-root')).toHaveCount(0);
    await expect.poll(async () => new URLSearchParams(await search(page)).has('studio')).toBe(false);
    expect(await sidebarTokens(page)).toEqual(['closed']);
    await expect(app).toHaveClass(/\bsidebar-collapsed\b/);

    await page.goForward();
    await expect(page.locator('#layers-studio-root')).toBeVisible();
    await expect.poll(() => sidebarTokens(page)).toEqual(['closed']);
    await page.goBack();
    await expect(page.locator('#layers-studio-root')).toHaveCount(0);

    // Expand removes the key, again without a history step, and a reload
    // then opens.
    const lengthAtMap = await historyLength();
    await page.locator('#sidebar-expand').click();
    await expect(app).not.toHaveClass(/\bsidebar-collapsed\b/);
    await expect.poll(() => sidebarTokens(page)).toEqual([]);
    expect(await historyLength()).toBe(lengthAtMap);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('html')).toHaveAttribute('data-ddm-controls', 'ready');
    await expect(app).not.toHaveClass(/\bsidebar-collapsed\b/);
    expect(await sidebarTokens(page)).toEqual([]);
  });

  test('an embed ignores and drops sidebar=, and its exit opens the sidebar', async ({ page }) => {
    // F4: embed outranks sidebar=closed; the key is dropped on the embed's
    // first write; the exit opens the sidebar with the key absent. The embed
    // contract never stamps sidebar-collapsed (studio-embed-isolation).
    await page.setViewportSize(M7_DESKTOP);
    await gotoApp(page, '?embed=true&sidebar=closed');
    const app = page.locator('#app');
    await expect(app).toHaveClass(/\bembed\b/);
    await expect(app).not.toHaveClass(/\bsidebar-collapsed\b/);
    await expect.poll(() => sidebarTokens(page)).toEqual([]);
    expect(new URLSearchParams(await search(page)).get('embed')).toBe('true');

    // The embed's full-site link-out carries neither embed nor the dropped key.
    const layersLink = page
      .locator('#studio-linkout-pair')
      .getByRole('link', { name: 'Open layer controls on the full site' });
    const href = new URL((await layersLink.getAttribute('href')) ?? '');
    expect(href.searchParams.has('embed')).toBe(false);
    expect(href.searchParams.has('sidebar')).toBe(false);

    await page.locator('#sidebar-expand').click();
    await expect(app).not.toHaveClass(/\bembed\b/);
    await expect(app).not.toHaveClass(/\bsidebar-collapsed\b/);
    await expect(page.locator('#sidebar')).toBeVisible();
    await expect.poll(async () => new URLSearchParams(await search(page)).has('embed')).toBe(false);
    expect(await sidebarTokens(page)).toEqual([]);
  });

  test('a phone boot preserves sidebar= without applying it', async ({ page }) => {
    // F5, phone half: the mobile shell governs; the key is not applied (no
    // class, no expand control over the rail) but every write keeps it.
    await page.setViewportSize(M7_PHONE);
    await gotoApp(page, '?sidebar=closed');
    const app = page.locator('#app');
    await expect(app).not.toHaveClass(/\bsidebar-collapsed\b/);
    await expect(page.locator('#sidebar-expand')).toBeHidden();
    await expect.poll(() => sidebarTokens(page)).toEqual(['closed']);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('html')).toHaveAttribute('data-ddm-controls', 'ready');
    await expect(app).not.toHaveClass(/\bsidebar-collapsed\b/);
    await expect(page.locator('#sidebar-expand')).toBeHidden();
    await expect.poll(() => sidebarTokens(page)).toEqual(['closed']);
  });

  test('phone writes preserve the desktop preference and first widening applies it', async ({
    page
  }) => {
    // S2 and F5's phone-to-desktop half. The boot's canonical writes at phone
    // width (the silent region fit and the post-settle write) rebuild the
    // query from scratch; the preference rides them. The first widening then
    // applies it once, and applying it writes nothing.
    await page.setViewportSize(M7_PHONE);
    await gotoApp(page, '?sidebar=closed');
    await expect.poll(() => sidebarTokens(page)).toEqual(['closed']);
    await expect(page.locator('#app')).not.toHaveClass(/\bsidebar-collapsed\b/);
    const lengthBefore = await page.evaluate(() => window.history.length);

    await page.setViewportSize(M7_DESKTOP);
    await expect(page.locator('#app')).toHaveClass(/\bsidebar-collapsed\b/);
    await expect.poll(async () => (await sidebarChrome(page)).exposed).toBe(false);
    expect(await sidebarTokens(page)).toEqual(['closed']);
    expect(await page.evaluate(() => window.history.length)).toBe(lengthBefore);
  });

  test('explicit desktop choices survive repeated breakpoint crossings and bfcache: breakpoint crossings', async ({
    page
  }) => {
    const app = page.locator('#app');

    // Phone boot asking for closed, widened (applied once), then an explicit
    // desktop open: later crossings never re-close it.
    await page.setViewportSize(M7_PHONE);
    await gotoApp(page, '?sidebar=closed');
    await page.setViewportSize(M7_DESKTOP);
    await expect(app).toHaveClass(/\bsidebar-collapsed\b/);
    await page.locator('#sidebar-expand').click();
    await expect(app).not.toHaveClass(/\bsidebar-collapsed\b/);
    await expect.poll(() => sidebarTokens(page)).toEqual([]);
    for (let crossing = 0; crossing < 2; crossing++) {
      await page.setViewportSize(M7_PHONE);
      await afterFrames(page);
      await page.setViewportSize(M7_DESKTOP);
      await afterFrames(page);
      await expect(app, `crossing ${crossing + 1}`).not.toHaveClass(/\bsidebar-collapsed\b/);
      expect(await sidebarTokens(page), `crossing ${crossing + 1}`).toEqual([]);
    }

    // A desktop boot closed explicitly stays closed across the same crossings.
    await gotoApp(page);
    await page.locator('#sidebar-collapse').click();
    await expect.poll(() => sidebarTokens(page)).toEqual(['closed']);
    for (let crossing = 0; crossing < 2; crossing++) {
      await page.setViewportSize(M7_PHONE);
      await afterFrames(page);
      await page.setViewportSize(M7_DESKTOP);
      await afterFrames(page);
      await expect(app, `closed crossing ${crossing + 1}`).toHaveClass(/\bsidebar-collapsed\b/);
      expect(await sidebarTokens(page), `closed crossing ${crossing + 1}`).toEqual(['closed']);
    }
  });

  test('synthetic persisted-pageshow reconciliation test: a dispatched persisted pageshow re-applies the live desktop preference (no real bfcache restore)', async ({
    page
  }) => {
    // SYNTHETIC, by name (the Codex M7 review, F2): no document is cached or
    // restored here, so this proves only the pageshow handler's
    // reconciliation (src/ui/sidebar.ts wireTopLevelEvents), never a real
    // bfcache lifecycle; the real restore is the next case. It emulates the
    // case the reconcile exists for: a document restored from the cache that
    // missed the viewport change while it was frozen. Every change listener
    // on the desktop-width query is dropped, then a persisted pageshow is
    // dispatched by hand.
    await page.addInitScript((query: string) => {
      const normalize = (media: string): string => media.replace(/\s+/g, '');
      const original = MediaQueryList.prototype.addEventListener;
      MediaQueryList.prototype.addEventListener = function (
        this: MediaQueryList,
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions
      ): void {
        if (type === 'change' && normalize(this.media) === normalize(query)) return;
        original.call(this, type, listener, options);
      } as unknown as typeof MediaQueryList.prototype.addEventListener;
    }, SIDEBAR_DESKTOP_QUERY);
    const persistedPageshow = (): Promise<void> =>
      page.evaluate(() => {
        window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      });
    const app = page.locator('#app');

    await page.setViewportSize(M7_PHONE);
    await gotoApp(page, '?sidebar=closed');
    await page.setViewportSize(M7_DESKTOP);
    await afterFrames(page);
    // The widening was missed, as a frozen document would miss it.
    await expect(app).not.toHaveClass(/\bsidebar-collapsed\b/);

    await persistedPageshow();
    await expect(app).toHaveClass(/\bsidebar-collapsed\b/);
    expect(await sidebarTokens(page)).toEqual(['closed']);

    // An explicit choice made after the reconcile survives the next restore.
    // Invoked directly: every desktop-width change listener was dropped
    // above, so the rest of the chrome may still be seated for a phone and
    // could sit over the control.
    await page.evaluate(() => {
      (document.getElementById('sidebar-expand') as HTMLElement | null)?.click();
    });
    await expect(app).not.toHaveClass(/\bsidebar-collapsed\b/);
    await expect.poll(() => sidebarTokens(page)).toEqual([]);
    await persistedPageshow();
    await afterFrames(page);
    await expect(app).not.toHaveClass(/\bsidebar-collapsed\b/);
    expect(await sidebarTokens(page)).toEqual([]);
  });

  test('explicit desktop choices survive a real bfcache restore with a viewport change while away', async ({
    page
  }) => {
    // The Codex M7 review, F2 (review:96, adopted at disposition:84): a REAL
    // persisted restore, observed through a trusted pageshow that an init
    // script records, with the document's identity retained across the away
    // navigation. Playwright launches Chromium with
    // --disable-back-forward-cache (playwright-core's default switches), so
    // a runner that reloads the document on Back instead is DETECTED here and
    // the case is skipped with that reason: an unsupported result, never a
    // pass on a synthetic event.
    interface DocumentRead {
      readonly id: string | null;
      readonly path: string;
      readonly restores: number;
    }
    await page.addInitScript(() => {
      const w = window as unknown as {
        __ddmDocId: string;
        __ddmRestores: number;
      };
      w.__ddmDocId = `${performance.timeOrigin}:${Math.random()}`;
      w.__ddmRestores = 0;
      window.addEventListener('pageshow', (event) => {
        if (event.isTrusted && event.persisted) w.__ddmRestores += 1;
      });
    });
    await page.route(
      (url) => url.pathname === AWAY_PATH,
      (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><html><head><title>Away</title></head><body><p>Away</p></body></html>'
        })
    );
    const readDocument = async (): Promise<DocumentRead | null> => {
      try {
        return await page.evaluate(() => {
          const w = window as unknown as { __ddmDocId?: string; __ddmRestores?: number };
          return {
            id: w.__ddmDocId ?? null,
            path: window.location.pathname,
            restores: w.__ddmRestores ?? 0
          };
        });
      } catch {
        // The execution context is being replaced by the navigation.
        return null;
      }
    };
    const app = page.locator('#app');

    await page.setViewportSize(M7_PHONE);
    await gotoApp(page, '?sidebar=closed');
    await expect.poll(() => sidebarTokens(page)).toEqual(['closed']);
    await expect(app).not.toHaveClass(/\bsidebar-collapsed\b/);
    const appPath = new URL(page.url()).pathname;
    const booted = await readDocument();
    expect(booted?.id, 'the init script stamped the app document').toBeTruthy();

    /** Away, the caller's viewport change, then Back; skip if not restored. */
    const awayAndBack = async (
      whileAway: () => Promise<void>,
      restoresExpected: number,
      moment: string
    ): Promise<void> => {
      await rawNavigate(page, AWAY_PATH);
      expect(new URL(page.url()).pathname, `${moment}: away`).toBe(AWAY_PATH);
      await whileAway();
      await page.goBack({ waitUntil: 'commit' });
      await expect
        .poll(async () => (await readDocument())?.path ?? null, {
          message: `${moment}: the app document is back`
        })
        .toBe(appPath);
      const back = await readDocument();
      const restored = back !== null && back.id === booted?.id;
      test.skip(
        !restored,
        'UNSUPPORTED: this runner reloaded the document on Back instead of restoring it from ' +
          'the back-forward cache (Playwright launches Chromium with --disable-back-forward-cache). ' +
          'Real persisted-restore verification remains outstanding; the synthetic ' +
          'persisted-pageshow reconciliation test covers only the handler.'
      );
      await expect
        .poll(async () => (await readDocument())?.restores ?? -1, {
          message: `${moment}: a trusted persisted pageshow`
        })
        .toBe(restoresExpected);
    };

    // Phone closed boot, widened while away: the restored desktop document
    // shows the closed presentation and still carries the key.
    await awayAndBack(() => page.setViewportSize(M7_DESKTOP), 1, 'first restore');
    await expect(app).toHaveClass(/\bsidebar-collapsed\b/);
    await expect.poll(async () => (await sidebarChrome(page)).exposed).toBe(false);
    expect(await sidebarTokens(page)).toEqual(['closed']);

    // An explicit desktop open, then a second restore with the viewport
    // moved while away: the live open choice wins, never the inbound
    // sidebar=closed the document booted with.
    await page.locator('#sidebar-expand').click();
    await expect(app).not.toHaveClass(/\bsidebar-collapsed\b/);
    await expect.poll(() => sidebarTokens(page)).toEqual([]);
    await awayAndBack(
      async () => {
        await page.setViewportSize(M7_PHONE);
        await page.setViewportSize(M7_DESKTOP);
      },
      2,
      'second restore'
    );
    await expect(app).not.toHaveClass(/\bsidebar-collapsed\b/);
    await expect.poll(async () => (await sidebarChrome(page)).exposed).toBe(true);
    expect(await sidebarTokens(page)).toEqual([]);
  });

  test('a framed document without embed=true follows the viewport sidebar default', async ({
    page
  }) => {
    // F7: a physical iframe without embed= keeps the full chrome; the sidebar
    // default follows the frame's own viewport. F7 governs only the
    // no-token case: a sidebar=closed src in a non-embed frame is honoured.
    // Treating every iframe as an embed must go red here.
    await page.setViewportSize(M7_DESKTOP);
    await installRawBootStubs(page);

    const wide = await bootFramed(page, '/?view=brief', 1024);
    let chrome = await sidebarChrome(wide);
    expect(chrome.embed, 'desktop-width frame: embed').toBe(false);
    expect(chrome.collapsed, 'desktop-width frame: collapsed').toBe(false);
    expect(chrome.exposed, 'desktop-width frame: painted').toBe(true);

    const narrow = await bootFramed(page, '/?view=brief', 400);
    chrome = await sidebarChrome(narrow);
    expect(chrome.embed, 'phone-width frame: embed').toBe(false);
    expect(chrome.collapsed, 'phone-width frame: collapsed').toBe(false);

    const closed = await bootFramed(page, '/?view=brief&sidebar=closed', 1024);
    chrome = await sidebarChrome(closed);
    expect(chrome.embed, 'closed frame: embed').toBe(false);
    expect(chrome.collapsed, 'closed frame: collapsed').toBe(true);
    await expect.poll(() => sidebarTokens(closed)).toEqual(['closed']);
  });

  test('an iframe src reload restores sidebar= by F4 for embed and F7 for a non-embed frame', async ({
    page
  }) => {
    // F8 (as amended 2026-09-27): the iframe src is the restorable claim.
    await page.setViewportSize(M7_DESKTOP);
    await installRawBootStubs(page);

    let frame = await bootFramed(page, '/?embed=true&sidebar=closed', 1024);
    for (let load = 0; load < 2; load++) {
      const chrome = await sidebarChrome(frame);
      expect(chrome.embed, `embed src, load ${load + 1}`).toBe(true);
      expect(chrome.collapsed, `embed src, load ${load + 1}`).toBe(false);
      expect(chrome.exposed, `embed src, load ${load + 1}`).toBe(false);
      await expect.poll(() => sidebarTokens(frame)).toEqual([]);
      await page.reload({ waitUntil: 'domcontentloaded' });
      frame = await framedApp(page);
    }

    frame = await bootFramed(page, '/?view=brief&sidebar=closed', 1024);
    for (let load = 0; load < 2; load++) {
      const chrome = await sidebarChrome(frame);
      expect(chrome.embed, `framed src, load ${load + 1}`).toBe(false);
      expect(chrome.collapsed, `framed src, load ${load + 1}`).toBe(true);
      await expect.poll(() => sidebarTokens(frame)).toEqual(['closed']);
      await page.reload({ waitUntil: 'domcontentloaded' });
      frame = await framedApp(page);
    }
  });

  test('copied Share links obey explicit embed and full-chrome iframe rules', async ({ page }) => {
    // S6 and DR-139: Share copies the current URL verbatim (src/ui/share.ts),
    // so a closed sidebar reaches the recipient; an embed has already dropped
    // the key; a non-embed physical frame keeps the full chrome and the key.
    // The recipients of a copied link are the table-driven case below.
    await installClipboardRecorder(page);
    const share = async (target: Page | Frame): Promise<URL> =>
      new URL(await copiedShareHref(target));
    await page.setViewportSize(M7_DESKTOP);

    // Top level, full chrome: the sharer's collapsed sidebar travels.
    await gotoApp(page, '?view=brief');
    await page.locator('#sidebar-collapse').click();
    await expect.poll(() => sidebarTokens(page)).toEqual(['closed']);
    let copied = await share(page);
    expect(copied.searchParams.getAll('sidebar')).toEqual(['closed']);
    expect(copied.searchParams.has('embed')).toBe(false);

    // Top level, explicit embed: the key is gone, embed stays.
    await gotoApp(page, '?embed=true&sidebar=closed');
    await expect.poll(() => sidebarTokens(page)).toEqual([]);
    copied = await share(page);
    expect(copied.searchParams.has('sidebar')).toBe(false);
    expect(copied.searchParams.get('embed')).toBe('true');

    // A full-chrome iframe (no embed=): the key travels in Share and in the
    // full-site link-out alike.
    await installRawBootStubs(page);
    const framed = await bootFramed(page, '/?view=brief&sidebar=closed', 1024);
    await expect.poll(() => sidebarTokens(framed)).toEqual(['closed']);
    copied = await share(framed);
    expect(copied.searchParams.getAll('sidebar')).toEqual(['closed']);
    expect(copied.searchParams.has('embed')).toBe(false);
    const framedLink = framed
      .locator('#studio-linkout-pair')
      .getByRole('link', { name: 'Open layer controls on the full site' });
    const framedHref = new URL((await framedLink.getAttribute('href')) ?? '');
    expect(framedHref.searchParams.getAll('sidebar')).toEqual(['closed']);

    // An embedded iframe: Share and the link-out both drop the key.
    const embedded = await bootFramed(page, '/?embed=true&sidebar=closed', 1024);
    await expect.poll(() => sidebarTokens(embedded)).toEqual([]);
    copied = await share(embedded);
    expect(copied.searchParams.has('sidebar')).toBe(false);
    expect(copied.searchParams.get('embed')).toBe('true');
    const embeddedLink = embedded
      .locator('#studio-linkout-pair')
      .getByRole('link', { name: 'Open layer controls on the full site' });
    const embeddedHref = new URL((await embeddedLink.getAttribute('href')) ?? '');
    expect(embeddedHref.searchParams.has('sidebar')).toBe(false);
    expect(embeddedHref.searchParams.has('embed')).toBe(false);
  });

  // The Codex M7 review, F3 (review:100): the RECIPIENTS of an actual copied
  // closed Share link. The iframe src is the copied text itself (an embedder
  // adds `embed=true` to it as text); each recipient writes inside the frame,
  // exits the embed where there is one, and is then recreated from the
  // original src. Rows: F4 (embed ignores and drops the key; its exit opens
  // with the key absent), F7 (a non-embed frame honours a valid key, applied
  // only at desktop width, preserved at phone width) and F8 (the src is the
  // restorable claim).
  interface FramedSidebar {
    readonly embed: boolean;
    readonly collapsed: boolean;
    /** Checked only at desktop width, where the column is a column. */
    readonly exposed: boolean | null;
    readonly tokens: readonly string[];
  }
  const expectFramedSidebar = async (
    frame: Frame,
    expected: FramedSidebar,
    moment: string
  ): Promise<void> => {
    await expect
      .poll(() => sidebarTokens(frame), { message: `${moment}: sidebar=` })
      .toEqual([...expected.tokens]);
    await expect
      .poll(
        async () => {
          const chrome = await sidebarChrome(frame);
          return { embed: chrome.embed, collapsed: chrome.collapsed };
        },
        { message: `${moment}: embed and collapsed classes` }
      )
      .toEqual({ embed: expected.embed, collapsed: expected.collapsed });
    if (expected.exposed !== null) {
      await expect
        .poll(async () => (await sidebarChrome(frame)).exposed, {
          message: `${moment}: the column painted`
        })
        .toBe(expected.exposed);
    }
    const embedParam = await frame.evaluate(() =>
      new URLSearchParams(window.location.search).getAll('embed')
    );
    expect(embedParam, `${moment}: embed=`).toEqual(expected.embed ? ['true'] : []);
  };
  const SHARE_RECIPIENT_WIDTHS = [
    { label: 'desktop-width frame', width: 1024, desktop: true },
    { label: 'phone-width frame', width: M7_PHONE.width, desktop: false }
  ] as const;
  const SHARE_RECIPIENTS = SHARE_RECIPIENT_WIDTHS.flatMap((frameWidth) =>
    [false, true].map((embed) => ({ ...frameWidth, embed }))
  );
  for (const recipient of SHARE_RECIPIENTS) {
    test(`a copied closed Share link restores by F4, F7 and F8 as an iframe src (${recipient.label}, ${
      recipient.embed ? 'with' : 'without'
    } explicit embed=true)`, async ({ page }) => {
      test.setTimeout(120_000);
      await installClipboardRecorder(page);
      await page.setViewportSize(M7_DESKTOP);

      // The sharer: a desktop full-chrome document with the sidebar closed.
      await gotoApp(page, '?view=brief');
      await page.locator('#sidebar-collapse').click();
      await expect.poll(() => sidebarTokens(page)).toEqual(['closed']);
      const copied = await copiedShareHref(page);
      expect(new URL(copied).searchParams.getAll('sidebar'), 'the copied link').toEqual(['closed']);
      expect(new URL(copied).searchParams.has('embed'), 'the copied link').toBe(false);
      const src = recipient.embed
        ? `${copied}${new URL(copied).search === '' ? '?' : '&'}embed=true`
        : copied;
      // An in-frame write target the src does not already name.
      const copiedRegion = new URL(copied).searchParams.get('region');
      const writeRegion = (Object.keys(REGIONS) as Array<keyof typeof REGIONS>).find(
        (key) => key !== DEFAULT_REGION && key !== copiedRegion
      );
      expect(writeRegion, 'REGIONS names a region besides the default').toBeDefined();

      const boot: FramedSidebar = recipient.embed
        ? { embed: true, collapsed: false, exposed: recipient.desktop ? false : null, tokens: [] }
        : {
            embed: false,
            collapsed: recipient.desktop,
            exposed: recipient.desktop ? false : null,
            tokens: ['closed']
          };
      const exited: FramedSidebar = {
        embed: false,
        collapsed: false,
        exposed: recipient.desktop ? true : null,
        tokens: []
      };

      await installRawBootStubs(page);
      const frame = await bootFramed(page, src, recipient.width);
      await expectFramedSidebar(frame, boot, 'the recipient boot');

      await chooseRegionIn(frame, writeRegion!);
      await expectFramedSidebar(frame, boot, 'after an in-frame write');

      if (recipient.embed) {
        await frame.evaluate(() => {
          (document.getElementById('sidebar-expand') as HTMLElement | null)?.click();
        });
        await expectFramedSidebar(frame, exited, 'after the embed exit');
        // A later write never re-emits the closed key the src once carried.
        await chooseRegionIn(frame, DEFAULT_REGION);
        await expectFramedSidebar(frame, exited, 'after a write that follows the exit');
      }

      const recreated = await recreateFrame(page, frame);
      expect(recreated.src, 'in-frame writes never rewrite the parent src').toBe(src);
      await expectFramedSidebar(recreated.frame, boot, 'recreated from the original src');
      expect(
        await recreated.frame.evaluate(() =>
          new URLSearchParams(window.location.search).get('region')
        ),
        'the recreated frame restores the src, not the in-frame history'
      ).not.toBe(writeRegion);
    });
  }

  test('view=console boots with the console catalog visible on desktop', async ({ page }) => {
    // A3: with the sidebar open by default the Console door shows its
    // catalog; no expand is needed.
    await page.setViewportSize(M7_DESKTOP);
    await gotoApp(page, '?view=console');
    await expect(page.locator('#app')).not.toHaveClass(/\bsidebar-collapsed\b/);
    await expect(page.locator('#layer-toggles .layer-group').first()).toBeVisible();
    expect(new URLSearchParams(await search(page)).get('view')).toBe('console');
  });

  test('view= composes with sidebar=closed', async ({ page }) => {
    // J1: an explicit view keeps its door, and sidebar=closed composes with
    // either; expanding shows the door the view named.
    await page.setViewportSize(M7_DESKTOP);
    for (const view of ['brief', 'console'] as const) {
      await gotoApp(page, `?view=${view}&sidebar=closed`);
      await expect(page.locator('#app'), view).toHaveClass(/\bsidebar-collapsed\b/);
      await expect.poll(() => sidebarTokens(page), { message: view }).toEqual(['closed']);
      expect(new URLSearchParams(await search(page)).get('view'), view).toBe(view);
      await page.locator('#sidebar-expand').click();
      await expect(page.locator('#app'), view).not.toHaveClass(/\bsidebar-collapsed\b/);
      expect(new URLSearchParams(await search(page)).get('view'), view).toBe(view);
      if (view === 'console') {
        await expect(page.locator('#layer-toggles .layer-group').first()).toBeVisible();
      }
    }
  });

  // The Codex M7 review, Q5: M6 (the horizon a mode can show, and the quick
  // views that commit a horizon) and M7 share the URL writers. A horizon
  // write must carry the live sidebar preference, never erase it.
  const horizonChip = (page: Page, key: string) =>
    page.locator(`.shell-horizon-btn[data-horizon="${key}"]`);

  test('an unsupported cluster and horizon boot with sidebar=closed normalizes the horizon and keeps the sidebar closed', async ({
    page
  }) => {
    // Extreme Heat's current recipe (HeatRisk and the WWA notices), both
    // answered locally, as in M6's A6 case above.
    await stubHeatRiskCatalog(page);
    await page.route(
      (url) => url.pathname.endsWith('/watch_warn_adv/MapServer/1/query'),
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/geo+json',
          body: JSON.stringify({ type: 'FeatureCollection', features: [] })
        })
    );
    await page.setViewportSize(M7_DESKTOP);
    const app = page.locator('#app');
    await gotoApp(page, '?cluster=heat&horizon=season-ahead&sidebar=closed');

    for (const moment of ['boot', 'reload'] as const) {
      // M6: the unshowable horizon boots on Current Conditions.
      await expect(horizonChip(page, 'current'), moment).toHaveAttribute('aria-pressed', 'true');
      await expect(horizonChip(page, 'season-ahead'), moment).toHaveAttribute(
        'aria-disabled',
        'true'
      );
      await expect(horizonChip(page, 'season-ahead'), moment).toHaveAttribute(
        'aria-pressed',
        'false'
      );
      await expect(page.locator('input[data-layer-key="heatrisk"]'), moment).toBeChecked();
      await expect
        .poll(async () => new URLSearchParams(await search(page)).get('horizon'), {
          message: `${moment}: horizon=`
        })
        .toBeNull();
      expect(new URLSearchParams(await search(page)).get('cluster'), moment).toBe('heat');
      // M7: the normalizing write carried the preference.
      expect(await sidebarTokens(page), `${moment}: sidebar=`).toEqual(['closed']);
      await expect(app, moment).toHaveClass(/\bsidebar-collapsed\b/);
      expect((await sidebarChrome(page)).exposed, `${moment}: painted`).toBe(false);
      if (moment === 'boot') {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(page.locator('html')).toHaveAttribute('data-ddm-controls', 'ready');
      }
    }
  });

  test('Season ahead then Right now while the sidebar is closed keeps it closed through a reload', async ({
    page
  }) => {
    test.setTimeout(120_000);
    // The quick views are the two VIEW_PRESETS entries that declare these
    // horizons (enumerated from src/config/presets.ts, not named here).
    const presetFor = (horizon: string): ViewPreset => {
      const found = VIEW_PRESETS.find((preset) => preset.horizon === horizon);
      if (!found) throw new Error(`no VIEW_PRESETS entry declares horizon ${horizon}`);
      return found;
    };
    const seasonAhead = presetFor('season-ahead');
    const rightNow = presetFor('current');
    // The CPC Drought Outlook the season-ahead quick view shows (the shared
    // M6 stub), and the live station-value sources the current quick view's
    // telemetry reaches, answered with a local failure as M6's
    // tests/preset-toggle-cycles.spec.ts stubStationValueSources does.
    // Registered before gotoApp, so every stub gotoApp installs still wins.
    await stubCpcDroughtOutlook(page);
    for (const pattern of [
      '**/waterservices.usgs.gov/**',
      '**/wcc.sc.egov.usda.gov/**',
      '**/cwms-data.usace.army.mil/**',
      '**/www.usbr.gov/**',
      '**/www.nwrfc.noaa.gov/**',
      '**/api.tidesandcurrents.noaa.gov/**',
      '**/mesonet.agron.iastate.edu/**',
      '**/ddm-proxy.atniclimate.workers.dev/**'
    ]) {
      await page.route(pattern, (route) => route.abort('failed'));
    }
    await page.setViewportSize(M7_DESKTOP);
    const app = page.locator('#app');
    await gotoApp(page, '?view=console&sidebar=closed');
    await waitForLayerSettled(page, 'nadm-drought');
    await expect(app).toHaveClass(/\bsidebar-collapsed\b/);

    // The chip row lives in the collapsed column. Opening it through the
    // expand control is itself the explicit open choice that drops the key,
    // so the chips are pressed through their own click handlers in the page
    // (the same handler a tap reaches) while the column stays closed.
    const pressQuickView = async (preset: ViewPreset): Promise<void> => {
      await page.evaluate((label: string) => {
        const chip = Array.from(document.querySelectorAll('#preset-chips .preset-chip')).find(
          (element) => element.textContent === label
        );
        if (!(chip instanceof HTMLElement)) throw new Error(`no quick-view chip "${label}"`);
        chip.click();
      }, preset.label);
    };

    await pressQuickView(seasonAhead);
    await expect(horizonChip(page, 'season-ahead')).toHaveAttribute('aria-pressed', 'true', {
      timeout: 25_000
    });
    await expect
      .poll(async () => new URLSearchParams(await search(page)).get('horizon'))
      .toBe('season-ahead');
    expect(await sidebarTokens(page), 'after Season ahead').toEqual(['closed']);
    await expect(app, 'after Season ahead').toHaveClass(/\bsidebar-collapsed\b/);

    await pressQuickView(rightNow);
    await expect
      .poll(async () => new URLSearchParams(await search(page)).get('horizon'))
      .toBeNull();
    await expect(horizonChip(page, 'current')).toHaveAttribute('aria-pressed', 'true');
    expect(await sidebarTokens(page), 'after Right now').toEqual(['closed']);
    await expect(app, 'after Right now').toHaveClass(/\bsidebar-collapsed\b/);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('html')).toHaveAttribute('data-ddm-controls', 'ready');
    await expect(app, 'reload').toHaveClass(/\bsidebar-collapsed\b/);
    await expect(horizonChip(page, 'current'), 'reload').toHaveAttribute('aria-pressed', 'true');
    expect(new URLSearchParams(await search(page)).get('horizon'), 'reload').toBeNull();
    await expect.poll(() => sidebarTokens(page), { message: 'reload: sidebar=' }).toEqual([
      'closed'
    ]);
    expect((await sidebarChrome(page)).exposed, 'reload: painted').toBe(false);

    // Closed until the explicit expand, which drops the key and keeps the
    // normalized horizon.
    await page.locator('#sidebar-expand').click();
    await expect(app).not.toHaveClass(/\bsidebar-collapsed\b/);
    await expect.poll(() => sidebarTokens(page)).toEqual([]);
    expect(new URLSearchParams(await search(page)).get('horizon')).toBeNull();
  });

  test('the first URL mutation normalizes sidebar', async ({ page }) => {
    // S3 (the literal next-write rule, decision 1): every replaceState and
    // pushState from navigation start is recorded. A direct studio boot's
    // first mutation is the studio route's synthesized predecessor
    // (src/state/studio-route.ts), which clones the raw URL; an embed's first
    // write drops the key.
    await page.addInitScript(() => {
      const writes: string[] = [];
      (window as unknown as { __ddmUrlWrites: string[] }).__ddmUrlWrites = writes;
      for (const name of ['replaceState', 'pushState'] as const) {
        const original = History.prototype[name];
        History.prototype[name] = function (
          this: History,
          data: unknown,
          unused: string,
          url?: string | URL | null
        ): void {
          if (url !== undefined && url !== null) writes.push(String(url));
          original.call(this, data, unused, url);
        };
      }
    });
    await page.route('**/gibs.earthdata.nasa.gov/**', (route) =>
      route.fulfill({ status: 503, contentType: 'text/plain', body: 'Synthetic offline response' })
    );
    await page.setViewportSize(M7_DESKTOP);
    const cases: ReadonlyArray<{ readonly query: string; readonly expected: readonly string[] }> = [
      { query: '?view=brief&layers=places&sidebar=closed&sidebar=closed&studio=layers', expected: [] },
      { query: '?view=brief&layers=places&sidebar=open&studio=layers', expected: [] },
      { query: '?view=brief&layers=places&sidebar=closed&studio=layers', expected: ['closed'] },
      { query: '?embed=true&sidebar=closed', expected: [] },
      { query: '?view=brief&sidebar=closed&sidebar=x', expected: [] }
    ];
    for (const { query, expected } of cases) {
      await gotoApp(page, query);
      const writes = await page.evaluate(
        () => (window as unknown as { __ddmUrlWrites: string[] }).__ddmUrlWrites
      );
      expect(writes.length, `${query}: at least one URL write`).toBeGreaterThan(0);
      writes.forEach((write, index) => {
        const url = new URL(write, page.url());
        expect(url.searchParams.getAll('sidebar'), `${query}: write ${index + 1} (${write})`).toEqual(
          [...expected]
        );
      });
    }
  });

  test('inline and runtime sidebar grammar agree', () => {
    // S1: the inline classic bootstrap cannot import the runtime parser, so
    // parity is pinned by running both over the same inputs.
    const html = readFileSync(join(process.cwd(), 'index.html'), 'utf8');
    const opening = html.match(new RegExp(`<script id="${SIDEBAR_BOOT_ID}"[^>]*>`))?.[0];
    expect(opening, 'index.html carries the inline sidebar bootstrap').toBeDefined();
    // A classic inline script: never deferred, never a module, never external.
    expect(opening).not.toMatch(/\btype=|\bsrc=|\bdefer\b|\basync\b/);
    const appAt = html.indexOf('<div id="app"');
    const bootAt = html.indexOf(opening!);
    const sidebarAt = html.indexOf('<aside id="sidebar"');
    expect(appAt, 'the bootstrap runs inside #app').toBeLessThan(bootAt);
    expect(bootAt, 'the bootstrap runs before #sidebar is parsed').toBeLessThan(sidebarAt);
    const body = html.slice(bootAt + opening!.length, html.indexOf('</script>', bootAt));
    const runInline = new Function('window', 'document', body) as (
      window: unknown,
      document: unknown
    ) => void;

    const sidebarForms: ReadonlyArray<readonly string[]> = [
      [],
      ['closed'],
      ['open'],
      ['x'],
      [''],
      ['CLOSED'],
      ['closed '],
      ['closed', 'closed'],
      ['closed', 'open'],
      ['open', 'closed']
    ];
    const embedForms: ReadonlyArray<readonly string[]> = [
      [],
      ['true'],
      ['1'],
      ['false'],
      ['TRUE'],
      [''],
      ['true', 'false'],
      ['false', 'true'],
      ['0', '1']
    ];
    /**
     * Run the inline bootstrap and the runtime parser over one raw query
     * string (`searchText` is `location.search`, a leading `?` included, and
     * is never re-serialized), assert they agree, and return the agreed
     * result.
     */
    const compare = (
      searchText: string,
      desktop: boolean
    ): { readonly embed: boolean; readonly collapsed: boolean } => {
      const label = `${desktop ? 'desktop' : 'phone'} ${searchText || '(bare)'}`;
      const params = new URLSearchParams(searchText);

      const classes = new Set<string>();
      const fakeApp = {
        classList: {
          add: (name: string) => {
            classes.add(name);
          },
          remove: (name: string) => {
            classes.delete(name);
          },
          toggle: (name: string, force?: boolean) => {
            const on = force ?? !classes.has(name);
            if (on) classes.add(name);
            else classes.delete(name);
            return on;
          },
          contains: (name: string) => classes.has(name)
        }
      };
      runInline(
        {
          location: { search: searchText },
          matchMedia: (media: string) => ({
            matches: desktop && media === SIDEBAR_DESKTOP_QUERY,
            media
          })
        },
        { getElementById: (id: string) => (id === 'app' ? fakeApp : null) }
      );

      const browser = installFakeBrowser({ search: searchText, desktop });
      let parsed: ReturnType<typeof parseUrlParams>;
      try {
        parsed = parseUrlParams();
      } finally {
        browser.restore();
      }
      // The runtime applier (src/ui/sidebar.ts) collapses only above the
      // desktop query and never in an embed; ParsedUrlParams already folds
      // the embed rule into sidebarClosed.
      const runtimeCollapsed = parsed.sidebarClosed && desktop;
      expect(classes.has('embed'), `${label}: embed class`).toBe(parsed.embed);
      expect(classes.has('sidebar-collapsed'), `${label}: collapsed class`).toBe(
        runtimeCollapsed
      );
      expect(parseEmbedParam(params), `${label}: parseEmbedParam`).toBe(parsed.embed);
      expect(
        parseSidebarParam(params) && !parsed.embed,
        `${label}: parseSidebarParam`
      ).toBe(parsed.sidebarClosed);
      // The next-write normalizer keeps exactly what the parser honours.
      const normalized = new URLSearchParams(searchText);
      normalizeSidebarParam(normalized);
      expect(normalized.getAll('sidebar'), `${label}: normalizeSidebarParam`).toEqual(
        parsed.sidebarClosed ? ['closed'] : []
      );
      return { embed: parsed.embed, collapsed: runtimeCollapsed };
    };

    let desktopCasesClosed = 0;
    for (const desktop of [true, false]) {
      for (const sidebar of sidebarForms) {
        for (const embed of embedForms) {
          const params = new URLSearchParams();
          for (const value of embed) params.append('embed', value);
          for (const value of sidebar) params.append('sidebar', value);
          const query = params.toString();
          if (compare(query === '' ? '' : `?${query}`, desktop).collapsed) desktopCasesClosed++;
        }
      }
    }
    // The matrix reached the closed branch, so the desktop query literal
    // was exercised against SIDEBAR_DESKTOP_QUERY.
    expect(desktopCasesClosed).toBeGreaterThan(0);

    // The Codex M7 review, Q2 (review:93's decoded names and values): raw
    // percent-encoded query TEXT, appended as written, never through a
    // URLSearchParams setter (which would re-encode it). Each row pins the
    // desktop result too, so an encoded row that reaches the closed or the
    // embed branch is known to have reached it.
    const rawRows: ReadonlyArray<{
      readonly search: string;
      readonly embed: boolean;
      readonly collapsed: boolean;
    }> = [
      // Encoded name and value: one sidebar=closed.
      { search: '?side%62ar=cl%6Fsed', embed: false, collapsed: true },
      { search: '?%73%69%64%65%62%61%72=%63%6C%6F%73%65%64', embed: false, collapsed: true },
      { search: '?view=brief&side%62ar=closed', embed: false, collapsed: true },
      // Encoded-name duplicates: two sidebar values, the open default.
      { search: '?sidebar=closed&side%62ar=closed', embed: false, collapsed: false },
      { search: '?side%62ar=closed&sidebar=open', embed: false, collapsed: false },
      { search: '?sidebar=cl%6Fsed&side%62ar=cl%6Fsed', embed: false, collapsed: false },
      // Encoded values that decode to something other than `closed`.
      { search: '?side%62ar=CLOSED', embed: false, collapsed: false },
      { search: '?side%62ar=closed%20', embed: false, collapsed: false },
      { search: '?sidebar=closed+', embed: false, collapsed: false },
      { search: '?sidebar=closed%26', embed: false, collapsed: false },
      { search: '?sidebar%3Dclosed', embed: false, collapsed: false },
      { search: '?side%62ar', embed: false, collapsed: false },
      // Names are case-sensitive before and after decoding.
      { search: '?Sidebar=closed', embed: false, collapsed: false },
      { search: '?%53idebar=closed', embed: false, collapsed: false },
      // Encoded embed tokens: first wins, `true` or `1` only.
      { search: '?emb%65d=true&sidebar=closed', embed: true, collapsed: false },
      { search: '?embed=tru%65&side%62ar=closed', embed: true, collapsed: false },
      { search: '?embed=%31&sidebar=closed', embed: true, collapsed: false },
      { search: '?emb%65d=1&emb%65d=false&side%62ar=cl%6Fsed', embed: true, collapsed: false },
      { search: '?embed=false&emb%65d=true&side%62ar=closed', embed: false, collapsed: true },
      { search: '?emb%65d=true&embed=false&sidebar=closed', embed: true, collapsed: false },
      { search: '?embed=TRU%45&sidebar=closed', embed: false, collapsed: true },
      { search: '?EMBED=true&sidebar=closed', embed: false, collapsed: true }
    ];
    for (const row of rawRows) {
      expect(compare(row.search, true), `desktop ${row.search}`).toEqual({
        embed: row.embed,
        collapsed: row.collapsed
      });
      // A phone never collapses; the embed class is width-independent.
      expect(compare(row.search, false), `phone ${row.search}`).toEqual({
        embed: row.embed,
        collapsed: false
      });
    }
  });

  for (const mount of M7_MOUNTS) {
    for (const document_ of M7_DOCUMENTS) {
      test(`a sidebar=closed boot paints no frame with the sidebar open (${mount.label}, ${document_.label})`, async ({
        page
      }) => {
        await sampleClosedBootFrames(page, mount.path, document_.studio);
      });
    }
  }

  for (const mount of M7_MOUNTS) {
    test(`closed and embed boots never expose the sidebar while the entry module is held (${mount.label})`, async ({
      page,
      request,
      baseURL
    }) => {
      // S1: only the entry chunk is held (never answered until the end), so
      // no application module runs; the HTML, its inline bootstrap and the
      // stylesheet arrive normally. gotoApp cannot express this, because a
      // held module script also holds DOMContentLoaded. The Codex M7 review,
      // F1: at both mounts, and for the map, Layers and Place documents, with
      // the entry resolved against the mounted document URL itself.
      expect(baseURL, 'playwright.config.ts sets baseURL').toBeDefined();
      const indexHtml = await (await request.get('/')).text();
      const entryHref = indexHtml.match(
        /<script\b(?=[^>]*\btype="module")[^>]*\bsrc="([^"]+)"/i
      )?.[1];
      expect(entryHref).toMatch(/\.js$/);
      const held: Route[] = [];
      const heldPaths = new Set<string>();
      await installRawBootStubs(page);
      if (mount.path !== '/') await installPagesMount(page);
      // Registered after the mount, so it answers the entry first.
      await page.route(
        (url) => heldPaths.has(url.pathname),
        (route) => {
          held.push(route);
        }
      );

      const cases: ReadonlyArray<{
        readonly viewport: { readonly width: number; readonly height: number };
        readonly query: string;
        readonly collapsed: boolean;
        readonly embed: boolean;
        readonly exposed: boolean | null;
      }> = [
        { viewport: M7_DESKTOP, query: 'sidebar=closed', collapsed: true, embed: false, exposed: false },
        { viewport: M7_DESKTOP, query: 'embed=1', collapsed: false, embed: true, exposed: false },
        { viewport: M7_DESKTOP, query: 'embed=true&sidebar=closed', collapsed: false, embed: true, exposed: false },
        { viewport: M7_DESKTOP, query: 'sidebar=closed&sidebar=closed', collapsed: false, embed: false, exposed: true },
        { viewport: M7_DESKTOP, query: 'sidebar=CLOSED', collapsed: false, embed: false, exposed: true },
        // A phone never applies the key (F5); the mobile shell governs.
        { viewport: M7_PHONE, query: 'sidebar=closed', collapsed: false, embed: false, exposed: null }
      ];
      try {
        for (const document_ of M7_DOCUMENTS) {
          for (const scenario of cases) {
            const documentUrl = new URL(
              mountedDocumentPath(mount.path, document_.studio, scenario.query),
              baseURL
            );
            // The entry this document loads: the HTML's relative src resolved
            // against THIS document's URL, and exactly that path is held.
            const entryPath = new URL(entryHref!, documentUrl).pathname;
            heldPaths.add(entryPath);
            const label = `${scenario.viewport.width} ${documentUrl.pathname}${documentUrl.search}`;
            const heldBefore = held.length;
            await page.setViewportSize(scenario.viewport);
            await rawNavigate(page, documentUrl.href);
            expect(page.url(), `${label}: the mounted document`).toBe(documentUrl.href);
            await page.waitForSelector('#sidebar', { state: 'attached' });
            await page.waitForSelector('script[type="module"][src]', { state: 'attached' });
            const resolvedEntry = await page.evaluate(() => {
              const script = document.querySelector('script[type="module"][src]');
              return script instanceof HTMLScriptElement ? new URL(script.src).pathname : null;
            });
            expect(resolvedEntry, `${label}: the entry the document resolved`).toBe(entryPath);
            await expect
              .poll(
                () =>
                  page.evaluate(() =>
                    Array.from(document.querySelectorAll('link[rel="stylesheet"]')).every(
                      (link) => link instanceof HTMLLinkElement && link.sheet !== null
                    )
                  ),
                { message: `${label}: stylesheet applied` }
              )
              .toBe(true);
            // Positive interception: THIS document's entry request is the one
            // held, so a mount-relative miss fails here instead of booting.
            await expect
              .poll(
                () =>
                  held
                    .slice(heldBefore)
                    .some((route) => new URL(route.request().url()).pathname === entryPath),
                { message: `${label}: entry held at ${entryPath}` }
              )
              .toBe(true);
            // No application module has run.
            expect(await page.locator('html').getAttribute('data-ddm-controls'), label).toBeNull();
            await expect(page.locator('#preset-chips .preset-chip'), label).toHaveCount(0);

            const chrome = await sidebarChrome(page);
            expect(chrome.collapsed, `${label}: collapsed`).toBe(scenario.collapsed);
            expect(chrome.embed, `${label}: embed`).toBe(scenario.embed);
            if (scenario.exposed !== null) {
              expect(chrome.exposed, `${label}: painted`).toBe(scenario.exposed);
            }
          }
        }
      } finally {
        // An empty module body: the held boots end without running the app,
        // so nothing after this test can reach a service.
        for (const route of held) {
          await route
            .fulfill({ status: 200, contentType: 'text/javascript', body: '' })
            .catch(() => undefined);
        }
      }
    });
  }
});

/**
 * The first-paint sampler (S1), shared by the mount-by-document matrix above:
 * an init script samples every animation frame from navigation start (frames
 * never run while the stylesheet still blocks rendering), from the first
 * frame that has a #sidebar, and the boot then runs through gotoApp at the
 * mounted document path.
 */
async function sampleClosedBootFrames(
  page: Page,
  mountPath: string,
  studio: M7Studio | null
): Promise<void> {
  await page.addInitScript(() => {
    const frames: boolean[] = [];
    (window as unknown as { __ddmSidebarFrames: boolean[] }).__ddmSidebarFrames = frames;
    const sample = (): void => {
      const sidebar = document.getElementById('sidebar');
      if (sidebar) {
        const style = getComputedStyle(sidebar);
        frames.push(
          style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            sidebar.getBoundingClientRect().width > 1
        );
      }
      if (frames.length < 900) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  // A studio document may request imagery tiles; answered locally, as in
  // "the first URL mutation normalizes sidebar".
  await page.route('**/gibs.earthdata.nasa.gov/**', (route) =>
    route.fulfill({ status: 503, contentType: 'text/plain', body: 'Synthetic offline response' })
  );
  // Before gotoApp, so every stub gotoApp installs still wins over the mount.
  if (mountPath !== '/') await installPagesMount(page);
  await page.setViewportSize(M7_DESKTOP);
  for (const query of ['sidebar=closed', 'embed=1&sidebar=closed']) {
    const path = mountedDocumentPath(mountPath, studio, query);
    await gotoApp(page, path);
    expect(new URL(page.url()).pathname, `${path}: booted at its mount`).toBe(mountPath);
    const frames = await page.evaluate(
      () => (window as unknown as { __ddmSidebarFrames: boolean[] }).__ddmSidebarFrames
    );
    expect(frames.length, `${path}: sampled frames`).toBeGreaterThan(0);
    expect(
      frames.filter((open) => open).length,
      `${path}: frames painted with the sidebar open`
    ).toBe(0);
    expect((await sidebarChrome(page)).exposed, `${path}: settled`).toBe(false);
  }
}

test.describe('found-083: the desktop expand control stays on desktop', () => {
  // REGISTER found-083 (Codex's M7 review, F4; DDM-P10-T07). The collapsed
  // class carries the retained desktop preference across a crossing (M7), so
  // it can be on at phone width; the desktop expand control must not show
  // over the phone rail there, the rail must keep working, and a widening
  // must find the closed desktop column again. A phone embed keeps its exit.
  // Measured 2026-09-27 (gates/f083-measure.log): these held at a828605
  // before any change, because src/styles/mobile-panels.css:8 hides the
  // control whenever the phone sheet is active, and the sheet is active at
  // phone width on every non-embed page once the controls are ready
  // (mobile-sheet.ts shouldBeActive). The register's app.css reading was
  // right about app.css alone and not about the page. These cases guard it.

  /** The phone rail works: the Place door opens a painted panel and closes it. */
  async function expectPhoneRailWorks(page: Page, label: string): Promise<void> {
    const app = page.locator('#app');
    const rail = page.locator('#mobile-footer-nav');
    const place = rail.locator('button[data-tab="place"]');
    await expect(app, `${label}: the phone shell is active`).toHaveAttribute(
      'data-sheet-detent',
      'closed'
    );
    await expect(rail, `${label}: the rail`).toBeVisible();
    await place.click();
    await expect(app, `${label}: Place opens the panel`).toHaveAttribute('data-sheet-detent', 'half');
    await expect(page.locator('#sidebar'), `${label}: the panel`).toBeVisible();
    const panelWidth = await page
      .locator('#sidebar')
      .evaluate((element) => element.getBoundingClientRect().width);
    expect(panelWidth, `${label}: the panel is painted wider than the collapsed column`).toBeGreaterThan(
      100
    );
    await place.click();
    await expect(app, `${label}: a second press closes it`).toHaveAttribute(
      'data-sheet-detent',
      'closed'
    );
  }

  async function expectClosedDesktopRetained(page: Page, label: string): Promise<void> {
    const app = page.locator('#app');
    await expect(app, `${label}: the closed desktop preference is retained`).toHaveClass(
      /\bsidebar-collapsed\b/
    );
    expect(await sidebarTokens(page), `${label}: sidebar=closed kept`).toEqual(['closed']);
    await expect(page.locator('#sidebar-expand'), `${label}: the desktop expand control`).toBeVisible();
    expect((await sidebarChrome(page)).exposed, `${label}: the column stays closed`).toBe(false);
  }

  test('a desktop collapse then a narrowing hides the desktop expand control and keeps the rail', async ({
    page
  }) => {
    await page.setViewportSize(M7_DESKTOP);
    await gotoApp(page);
    const app = page.locator('#app');
    await page.locator('#sidebar-collapse').click();
    await expect(app).toHaveClass(/\bsidebar-collapsed\b/);
    await expect.poll(() => sidebarTokens(page)).toEqual(['closed']);
    await expect(page.locator('#sidebar-expand')).toBeVisible();

    await page.setViewportSize(M7_PHONE);
    await afterFrames(page);
    // The class stays on (it carries the preference); only its desktop
    // control leaves.
    await expect(app).toHaveClass(/\bsidebar-collapsed\b/);
    await expect(page.locator('#sidebar-expand'), 'phone: no desktop expand control').toBeHidden();
    await expectPhoneRailWorks(page, 'desktop collapse, narrowed');
    await expect(page.locator('#sidebar-expand'), 'phone, after the rail').toBeHidden();

    await page.setViewportSize(M7_DESKTOP);
    await afterFrames(page);
    await expectClosedDesktopRetained(page, 'widened again');
  });

  test('a phone sidebar=closed boot, widened then narrowed, hides the desktop expand control and keeps the rail', async ({
    page
  }) => {
    await page.setViewportSize(M7_PHONE);
    await gotoApp(page, '?sidebar=closed');
    const app = page.locator('#app');
    await expect(app).not.toHaveClass(/\bsidebar-collapsed\b/);
    await expect(page.locator('#sidebar-expand')).toBeHidden();

    await page.setViewportSize(M7_DESKTOP);
    await afterFrames(page);
    await expectClosedDesktopRetained(page, 'first widening');

    await page.setViewportSize(M7_PHONE);
    await afterFrames(page);
    await expect(app).toHaveClass(/\bsidebar-collapsed\b/);
    await expect(page.locator('#sidebar-expand'), 'phone: no desktop expand control').toBeHidden();
    await expectPhoneRailWorks(page, 'phone boot, widened, narrowed');
    await expect(page.locator('#sidebar-expand'), 'phone, after the rail').toBeHidden();

    await page.setViewportSize(M7_DESKTOP);
    await afterFrames(page);
    await expectClosedDesktopRetained(page, 'widened again');
  });

  test('a phone embed still shows its exit', async ({ page }) => {
    await page.setViewportSize(M7_PHONE);
    await gotoApp(page, '?embed=true');
    const app = page.locator('#app');
    await expect(page.locator('html')).toHaveAttribute('data-ddm-controls', 'ready');
    await expect(app).toHaveClass(/\bembed\b/);
    const expand = page.locator('#sidebar-expand');
    await expect(expand, 'the phone embed exit').toBeVisible();

    await expand.click();
    await expect(app).not.toHaveClass(/\bembed\b/);
    await expect(app).not.toHaveClass(/\bsidebar-collapsed\b/);
    await expect(app).toHaveAttribute('data-sheet-detent', 'closed');
    await expect(page.locator('#mobile-footer-nav')).toBeVisible();
    await expect(expand).toBeHidden();
    await expect.poll(async () => new URLSearchParams(await search(page)).has('embed')).toBe(false);
  });
});
