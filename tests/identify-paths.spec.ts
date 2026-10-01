import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { gotoApp, waitForLayerSettled } from './helpers';
import {
  BUILDERS,
  LEGACY_ALLOWANCE,
  NO_POPUP_SITES,
  POPUP_BOUNDARIES,
  eligibleBuilders,
  legacyLayerIds,
  migratedBuilders,
  popupSiteFindings,
  scanPopupSites,
  stripComments
} from './identify-paths-manifest';
import { serializePopupFrame } from '../src/ui/popup-frame';
import type { PopupModel } from '../src/ui/popup-frame';
import { CENSUS_FIXTURES } from './frame-fixtures';

/**
 * S30D D1 M23: "every identify path" (DDM-P11-T04), as the Codex Tier 2
 * review's PF5 and PF6 and the N2 brief corrections C3, C4 and C7 shape it.
 *
 *   1. An import-aware inventory of Popup construction and content setters
 *      over src/, with COUNTED narrow boundaries (the coordinator's one
 *      construction and one setDOMContent; telemetry.ts's one construction
 *      and one setHTML until M26), a self-check that the scan bites, the
 *      declared no-popup modules, and the frame's laziness (neither the
 *      coordinator nor main.ts imports it).
 *   2. The census: `#map-container[data-ddm-click-targets]`, after boots
 *      that activate every browser-eligible builder, EQUALS the manifest's
 *      targets for the activated layers, both ways; every builder outside
 *      LEGACY_ALLOWANCE must yield a frame (none at M23, and the count is
 *      asserted, so the empty branch is declared, not accidental).
 *   3. An init-script MutationObserver over the map popups AND the panel
 *      foot host, failing any response that is neither framed nor an
 *      allowance member: a coordinated response by its stamp, the adopted
 *      external popup by the mark adoptExternalResponse writes (never by a
 *      missing stamp). Every later mutation inside a sink audits it again.
 *   4. Serialized frame payloads stay inert in a booted document, and the
 *      ONE structural frame validator (shared by the observer and every
 *      fixture assertion) accepts a real frame and rejects an empty marker.
 *
 * Offline: every external request is answered 503 by a context route
 * registered before gotoApp, so gotoApp's own context stubs (registered
 * later, checked first) keep their fixtures and no live service decides a
 * result. Registration happens on a layer's first activation, before its
 * fetch, so the census does not depend on any fetch succeeding.
 *
 * Honest limit at M23: no builder is framed yet, so the framed-content
 * coordinator paths (the region split, root ownership, the late door in the
 * actions slot, the host width cap) get their browser proof when M24 and
 * M25 migrate a builder and the migrated branch below starts running.
 */

const ROOT = process.cwd();

// ---------------------------------------------------------------------------
// 1. The static inventory
// ---------------------------------------------------------------------------

/** Declared with no click popup (interface-chrome-popups-text.md 3.5), each with its reason. */
const NO_POPUP_MODULES: Readonly<Record<string, string>> = {
  'src/layers/sst-anomaly.ts': 'a no-op bindPopups',
  'src/layers/usfs-whp.ts': 'a no-op bindPopups',
  'src/layers/heatrisk.ts': 'the Key drawer carries it',
  'src/layers/heatrisk-coverage.ts': 'the Key drawer carries it',
  'src/layers/hydrography.ts': 'hover only',
  'src/ui/hover-inspector.ts': 'a hover readout, never a click response'
};

function sourceFiles(dir = join(ROOT, 'src'), out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

function repoPath(full: string): string {
  return relative(ROOT, full).split(sep).join('/');
}

function readSource(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

test.describe('identify paths: the static inventory', () => {
  test('no Popup construction or content setter outside the counted coordinator and telemetry boundaries', () => {
    const files = sourceFiles().map(repoPath);
    expect(files.length, 'the scan reached src/').toBeGreaterThan(100);
    for (const boundary of Object.keys(POPUP_BOUNDARIES)) {
      expect(files, `the counted boundary ${boundary} exists`).toContain(boundary);
    }
    const findings: string[] = [];
    for (const file of files) {
      findings.push(...popupSiteFindings(file, scanPopupSites(file, readSource(file))));
    }
    expect(findings).toEqual([]);
  });

  test('the inventory scanner catches aliases, factories, subclasses and computed setters (self-check)', () => {
    const cases: ReadonlyArray<{ name: string; source: string; constructions: number; problem: boolean }> = [
      { name: 'aliased named import', source: "import { Popup as P } from 'maplibre-gl';\nexport const make = () => new P({});", constructions: 1, problem: false },
      { name: 'factory in another namespace', source: "import * as ml from 'maplibre-gl';\nexport function popup() { return new ml.Popup(); }", constructions: 1, problem: false },
      { name: 'multi-line named import', source: "import {\n  Popup,\n  Map\n} from 'maplibre-gl';\nexport const p = new Popup();", constructions: 1, problem: false },
      { name: 'default import', source: "import mgl from 'maplibre-gl';\nnew mgl.Popup();", constructions: 1, problem: false },
      { name: 'constructor alias', source: "import * as maplibregl from 'maplibre-gl';\nconst Ctor = maplibregl.Popup;\nnew Ctor();", constructions: 0, problem: true },
      { name: 'subclass', source: "import * as maplibregl from 'maplibre-gl';\nclass Mine extends maplibregl.Popup {}", constructions: 0, problem: true },
      { name: 'namespace alias', source: "import * as maplibregl from 'maplibre-gl';\nconst lib = maplibregl;", constructions: 0, problem: true },
      { name: 'dynamic import', source: "export const lib = () => import('maplibre-gl');", constructions: 0, problem: true },
      { name: 'computed setter', source: "declare const x: Record<string, (v: string) => void>;\nx['setHTML']('y');", constructions: 0, problem: true },
      { name: 'type-only use (clean)', source: "import type * as maplibregl from 'maplibre-gl';\nlet p: maplibregl.Popup | null = null;\nexport function f(q: maplibregl.Popup): maplibregl.Popup { return q; }", constructions: 0, problem: false },
      { name: 'typed value import (one construction)', source: "import * as maplibregl from 'maplibre-gl';\nlet p: maplibregl.Popup | null = null;\nconst o: maplibregl.PopupOptions = {};\nexport const q = new maplibregl.Popup(o);", constructions: 1, problem: false }
    ];
    for (const c of cases) {
      const scan = scanPopupSites(c.name, c.source);
      expect(scan.constructions, `${c.name}: constructions`).toBe(c.constructions);
      expect(scan.problems.length > 0, `${c.name}: flagged`).toBe(c.problem);
    }
    // A second construction in an allowed file breaks its count.
    const coordinator = readSource('src/map/interaction-coordinator.ts');
    const doubled = scanPopupSites('coordinator', `${coordinator}\nconst extra = new maplibregl.Popup({});\n`);
    expect(doubled.constructions).toBe(POPUP_BOUNDARIES['src/map/interaction-coordinator.ts']!.constructions + 1);
    // Setters count by call, whatever the receiver.
    expect(scanPopupSites('setters', 'a.setHTML(x); b . setDOMContent (y); c.setText(z);')).toMatchObject({
      setHTML: 1,
      setDOMContent: 1,
      setText: 1
    });
    // The escapes of the Codex ultra diff review (2026-09-30, finding 2):
    // each is flagged in a file outside the counted boundaries.
    const escapes: ReadonlyArray<{ name: string; source: string }> = [
      {
        name: 'factory object and a parenthesized setter (the review\'s example)',
        source:
          "import { Popup as P } from 'maplibre-gl';\nconst factory = { ctor: P };\nconst popup = new factory.ctor();\n(popup.setHTML)('<b>x</b>').addTo(map);"
      },
      { name: 'the alias passed as an argument', source: "import { Popup as P } from 'maplibre-gl';\nf(a, P);" },
      { name: 'the alias as an operand', source: "import { Popup as P } from 'maplibre-gl';\nconst C = x || P;" },
      { name: 'the namespace Popup in an object literal', source: "import * as ml from 'maplibre-gl';\nconst factory = { ctor: ml.Popup };" },
      { name: 'the alias through a ternary', source: "import { Popup as P } from 'maplibre-gl';\nconst C = flag ? Other : P;" },
      {
        name: 'the namespace in a factory object (the r1 re-check\'s example)',
        source: "import * as maplibregl from 'maplibre-gl';\nconst factory = { lib: maplibregl };\nexport const make = () => new factory.lib.Popup();"
      },
      { name: 'the namespace passed as a second argument', source: "import * as maplibregl from 'maplibre-gl';\nregister(a, maplibregl);" },
      { name: 'a namespace barrel (the r2 re-check\'s example)', source: "export * as ml from 'maplibre-gl';" },
      { name: 'a star barrel', source: "export * from 'maplibre-gl';" },
      { name: 'a namespace barrel with a Unicode alias (the r3 re-check)', source: "export * as mlπ from 'maplibre-gl';" },
      { name: 'a namespace barrel with a string alias (the r3 re-check)', source: "export * as \"ml\" from 'maplibre-gl';" },
      { name: 'a named Popup barrel', source: "export {\n  Popup as P\n} from 'maplibre-gl';" },
      { name: 'an optional-call setter', source: 'popup.setHTML?.(x);' },
      { name: 'a setter through call', source: 'popup.setHTML.call(popup, x);' },
      { name: 'a destructured setter', source: 'const { setHTML } = popup;\nsetHTML(x);' }
    ];
    for (const c of escapes) {
      expect(popupSiteFindings(c.name, scanPopupSites(c.name, c.source), NO_POPUP_SITES), `${c.name}: flagged`).not.toEqual([]);
    }
    // The narrow type set still reads the real tree's annotations as types.
    const typed = scanPopupSites(
      'typed',
      "import * as maplibregl from 'maplibre-gl';\nlet current: maplibregl.Popup | null = null;\nexport function adopt(popup: maplibregl.Popup): void {}\nasync function door(\n  map: maplibregl.Map,\n  popup: maplibregl.Popup,\n  head: HTMLElement\n): Promise<void> {}\nconst all = new Map<string, maplibregl.Popup>();\nexport type { PopupOptions } from 'maplibre-gl';"
    );
    expect(typed.problems).toEqual([]);
    expect(typed.constructions).toBe(0);
  });

  test('the declared no-popup modules register no click target and bind no click', () => {
    const findings: string[] = [];
    for (const [file, reason] of Object.entries(NO_POPUP_MODULES)) {
      const code = stripComments(readSource(file));
      if (/\bregisterClickTarget\s*\(/.test(code)) findings.push(`${file} (${reason}) registers a click target`);
      if (/\.on\(\s*['"]click['"]|addEventListener\(\s*['"]click['"]/.test(code)) {
        findings.push(`${file} (${reason}) binds a click`);
      }
    }
    expect(findings).toEqual([]);
  });

  test('neither interaction-coordinator.ts nor main.ts imports the popup frame', () => {
    for (const file of ['src/map/interaction-coordinator.ts', 'src/main.ts']) {
      const code = stripComments(readSource(file));
      expect(
        /from\s*['"][^'"]*popup-frame['"]|import\s*\(\s*['"][^'"]*popup-frame['"]\s*\)|import\s*['"][^'"]*popup-frame['"]/.test(code),
        `${file} imports popup-frame`
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Browser checks
// ---------------------------------------------------------------------------

/**
 * Answer every external request 503 on the CONTEXT, registered before the
 * first gotoApp: gotoApp's own context stubs, registered later, are checked
 * first and keep their fixtures; page routes win over both.
 */
async function holdExternalNetwork(page: Page): Promise<void> {
  await page.context().route(
    (url) => url.protocol.startsWith('http') && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost',
    (route) => route.fulfill({ status: 503, contentType: 'text/plain', body: 'Synthetic offline response' })
  );
}

interface PopupAudit {
  readonly seen: string[];
  readonly violations: string[];
}

interface AuditWindow {
  __ddmPopupAudit?: PopupAudit;
  __ddmFrameCheck?: (root: Element, sink: Element) => string | null;
}

/**
 * The init-script observer (page context; self-contained). It installs the
 * ONE structural frame validator on `window.__ddmFrameCheck` and audits
 * every map popup and every panel-foot response as it appears, one task
 * after insertion (so an adopted popup's mark, written in a microtask, is
 * in place).
 */
function installPopupAudit(allow: { legacyLayerIds: string[]; external: boolean }): void {
  const audit: PopupAudit = { seen: [], violations: [] };
  const w = window as unknown as AuditWindow;
  w.__ddmPopupAudit = audit;
  const slots = ['title', 'issuer', 'value', 'clock', 'source'];
  const frameCheck = (root: Element, sink: Element): string | null => {
    if (sink.querySelectorAll('[data-popup-frame]').length !== 1) return 'not exactly one frame root';
    if (!root.hasAttribute('data-popup-frame') || root.parentElement !== sink) {
      return 'the displayed response is not the frame root';
    }
    const head = root.children[0];
    const body = root.children[1];
    if (root.children.length !== 2 || !head || !body) return 'the frame root holds other than its two regions';
    // Text counts too (the Codex r2 re-check, finding 3): beside the two
    // regions the root holds only whitespace text.
    for (const node of Array.from(root.childNodes)) {
      if (node === head || node === body) continue;
      if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() === '') continue;
      return 'the frame root holds other than its two regions';
    }
    const coordinated = root.classList.contains('coordinated-response');
    if (head.getAttribute('data-popup-region') !== 'head' || (coordinated && !head.classList.contains('coordinated-response-head'))) {
      return 'the displayed head is not the frame head region';
    }
    if (body.getAttribute('data-popup-region') !== 'body' || (coordinated && !body.classList.contains('coordinated-response-body'))) {
      return 'the displayed body is not the frame body region';
    }
    for (const node of Array.from(sink.childNodes)) {
      if (node === root) continue;
      if (node instanceof Element && node.classList.contains('maplibregl-popup-close-button')) continue;
      if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() === '') continue;
      return 'displayed content sits outside the frame root';
    }
    for (const slot of slots) {
      const el = head.querySelector(`:scope > [data-popup-slot="${slot}"]`);
      if (!el || (el.textContent ?? '').trim() === '') return `the head slot ${slot} is missing or empty`;
    }
    return null;
  };
  w.__ddmFrameCheck = frameCheck;

  const auditSink = (sink: Element, where: string, external: boolean): void => {
    const shown = Array.from(sink.children).filter((c) => !c.classList.contains('maplibregl-popup-close-button'));
    const root = shown.length === 1 ? shown[0]! : null;
    if (external) {
      if (root?.hasAttribute('data-popup-frame')) {
        const verdict = frameCheck(root, sink);
        if (verdict) audit.violations.push(`${where} external: ${verdict}`);
      } else if (!allow.external) {
        audit.violations.push(`${where}: an unframed adopted external popup outside the legacy allowance`);
      }
      audit.seen.push(`${where}:external`);
      return;
    }
    const layerId = root?.classList.contains('coordinated-response') ? root.getAttribute('data-ddm-response') : null;
    if (!root || !layerId) {
      audit.violations.push(`${where}: a response that is neither a stamped coordinated response nor an adopted external popup`);
      return;
    }
    if (root.hasAttribute('data-popup-frame')) {
      const verdict = frameCheck(root, sink);
      if (verdict) audit.violations.push(`${where} ${layerId}: ${verdict}`);
    } else if (!allow.legacyLayerIds.includes(layerId)) {
      audit.violations.push(`${where}: an unframed response for ${layerId}, outside the legacy allowance`);
    }
    audit.seen.push(`${where}:${layerId}`);
  };

  const pending = new Set<Element>();
  const flush = (): void => {
    for (const el of pending) {
      if (!el.isConnected) continue;
      if (el.classList.contains('maplibregl-popup')) {
        const content = el.querySelector('.maplibregl-popup-content');
        if (content) auditSink(content, 'map', el.hasAttribute('data-ddm-external-response'));
        else audit.violations.push('map: a popup with no content box');
      } else if (el.children.length > 0) {
        auditSink(el, 'panel', false);
      }
    }
    pending.clear();
  };
  const observer = new MutationObserver((records) => {
    const before = pending.size;
    for (const record of records) {
      // Every mutation re-audits the sink it happened in (M23 repair round
      // 1, Codex ultra finding 3): an append, a replaced region or a removed
      // slot inside an already-audited response is audited again with the
      // same validator. A removed node's former parent is `record.target`,
      // so the walk from the target covers removals too. A text edit's
      // target is its text node, so it resolves through the parent element
      // (the Codex r1 re-check, finding 3); an attribute edit's target is
      // the element itself.
      const target = record.target;
      const element = target instanceof Element ? target : target.parentElement;
      const sink = element ? element.closest('.maplibregl-popup, .panel-response-host') : null;
      if (sink) pending.add(sink);
      for (const node of Array.from(record.addedNodes)) {
        if (!(node instanceof Element)) continue;
        if (node.classList.contains('maplibregl-popup')) pending.add(node);
        for (const popup of Array.from(node.querySelectorAll('.maplibregl-popup'))) pending.add(popup);
        for (const host of Array.from(node.querySelectorAll('.panel-response-host'))) {
          if (host.children.length > 0) pending.add(host);
        }
      }
    }
    if (pending.size > before) setTimeout(flush, 0);
  });
  // Child lists, text, and the attributes the validator reads: the frame,
  // region and slot markers, the coordinator's and adoption's stamps, and
  // `class` (the coordinated-response classes on a framed root's regions).
  observer.observe(document, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['class', 'data-popup-frame', 'data-popup-region', 'data-popup-slot', 'data-ddm-response', 'data-ddm-external-response']
  });
}

async function readAudit(page: Page): Promise<PopupAudit> {
  return page.evaluate(() => {
    const audit = (window as unknown as AuditWindow).__ddmPopupAudit;
    return { seen: [...(audit?.seen ?? [])], violations: [...(audit?.violations ?? [])] };
  });
}

/** Click the map center until the audit has recorded the wanted entry. */
async function clickCenterUntilSeen(page: Page, wanted: string): Promise<void> {
  const box = await page.locator('#map').boundingBox();
  if (!box) throw new Error('map container has no box');
  await expect(async () => {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect.poll(async () => (await readAudit(page)).seen, { timeout: 1500 }).toContain(wanted);
  }).toPass({ timeout: 20_000 });
}

/**
 * The census boots: one surface per boot (surfaces are exclusive) and
 * every other eligible layer in the first. The held BC edition is never
 * asked for (DR-160); its target must never be stamped.
 */
const CENSUS_BOOTS: readonly (readonly string[])[] = [
  ['usdm', 'states', 'aiannh', 'bia-reservations', 'tribal', 'treaty', 'ecoregions', 'nifc-fires', 'nws-alerts', 'hms-smoke', 'places', 'power-infrastructure', 'telemetry'],
  ['nadm-drought'],
  ['cdm-drought'],
  ['drought'],
  ['spc-fire-weather']
];

test.describe('identify paths: the census', () => {
  test('the stamped click targets equal the manifest targets of the activated layers, both ways', async ({
    page,
    context
  }) => {
    // The five registration boots, then one minute per migrated builder's fixture.
    test.setTimeout(180_000 + 60_000 * migratedBuilders().length);
    const booted = new Set(CENSUS_BOOTS.flat());
    expect(
      eligibleBuilders()
        .filter((b) => b.path === 'coordinated' && !booted.has(b.layerKey))
        .map((b) => b.id),
      'every browser-eligible coordinated builder is activated by a census boot'
    ).toEqual([]);
    expect(BUILDERS.filter((b) => b.held !== undefined && LEGACY_ALLOWANCE.includes(b.id)).map((b) => b.id), 'a held builder holds no allowance line').toEqual([]);
    expect(LEGACY_ALLOWANCE.filter((id) => !BUILDERS.some((b) => b.id === id)), 'every allowance line names a builder').toEqual([]);

    await holdExternalNetwork(page);
    let stamped = 0;
    const readStamp = async (): Promise<string[]> =>
      ((await page.locator('#map-container').getAttribute('data-ddm-click-targets')) ?? '')
        .split(' ')
        .filter((entry) => entry !== '')
        .sort();
    for (const layers of CENSUS_BOOTS) {
      // Registration runs on each layer's first activation, BEFORE its fetch,
      // so the census waits on the stamp itself rather than on every fetch
      // settling (bootIdle: false; the stamp is polled to its final value).
      await gotoApp(page, `?region=washington_state&view=console&layers=${layers.join(',')}`, { bootIdle: false });
      const expected = eligibleBuilders()
        .filter((b) => layers.includes(b.layerKey))
        .flatMap((b) => b.targets)
        .sort();
      await expect
        .poll(readStamp, { message: `the stamp after layers=${layers.join(',')}`, timeout: 20_000 })
        .toEqual(expected);
      stamped += (await readStamp()).length;
    }
    expect(stamped, 'the census read a nonzero number of stamped targets').toBeGreaterThan(0);

    // Builders outside the allowance must yield a frame: each migrated
    // builder runs its click fixture from tests/frame-fixtures.ts, which
    // asserts window.__ddmFrameCheck on its response (five non-empty head
    // slots; the frame owns the displayed content). Each fixture gets a
    // fresh page with the observer installed, so one fixture's routes and
    // viewport never reach the next, and the context answers any external
    // request offline. The count is asserted, so an empty loop is declared.
    const migrated = migratedBuilders();
    expect(migrated.length).toBe(eligibleBuilders().length - LEGACY_ALLOWANCE.length);
    if (migrated.length > 0) await holdExternalNetwork(page);
    for (const builder of migrated) {
      const fixture = CENSUS_FIXTURES[builder.id];
      if (!fixture) throw new Error(`${builder.id} left LEGACY_ALLOWANCE without a census click fixture`);
      const fixturePage = await context.newPage();
      try {
        await fixturePage.addInitScript(installPopupAudit, {
          legacyLayerIds: legacyLayerIds(),
          external: LEGACY_ALLOWANCE.includes('telemetry')
        });
        await fixture(fixturePage, { clickCenterUntilSeen, readAudit });
      } finally {
        await fixturePage.close();
      }
    }
  });
});

test.describe('identify paths: the observer over both sinks', () => {
  test('the observer passes only framed responses, stamped allowance responses and the adopted external popup', async ({
    page
  }) => {
    test.setTimeout(120_000);
    await holdExternalNetwork(page);
    await page.addInitScript(installPopupAudit, {
      legacyLayerIds: legacyLayerIds(),
      external: LEGACY_ALLOWANCE.includes('telemetry')
    });

    // The map sink: a coordinated (legacy, allowance) response. Each boot
    // re-runs the init script, so each part reads its own audit.
    await gotoApp(page, '?region=washington_state&view=console&layers=bia-reservations');
    await waitForLayerSettled(page, 'bia-reservations');
    await clickCenterUntilSeen(page, 'map:bia-reservations-fill');
    expect((await readAudit(page)).violations).toEqual([]);

    // The map sink again: the adopted station popup, identified by the mark
    // adoptExternalResponse writes (C4), never by a missing stamp.
    await gotoApp(page, '?region=washington_state&view=console&layers=telemetry');
    await waitForLayerSettled(page, 'telemetry');
    const marker = page.locator('.telemetry-marker[data-telemetry-station-id="ihr"]');
    await expect(marker).toHaveCount(1);
    await expect(async () => {
      await marker.click();
      await expect.poll(async () => (await readAudit(page)).seen, { timeout: 1500 }).toContain('map:external');
    }).toPass({ timeout: 20_000 });
    expect((await readAudit(page)).violations).toEqual([]);

    // The panel-foot sink: a place-bearing click in the Brief shell.
    await gotoApp(page, '?region=washington_state&view=brief&layers=bia-reservations');
    await waitForLayerSettled(page, 'bia-reservations');
    await clickCenterUntilSeen(page, 'panel:bia-reservations-fill');
    await expect(page.locator('#panel-response .panel-response-host > .coordinated-response')).toHaveCount(1);
    const panelAudit = await readAudit(page);
    expect(panelAudit.violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Inert payloads and the shared validator
// ---------------------------------------------------------------------------

const PAYLOAD = '"><img src=x onerror="window.__ddmPwned=1"><svg onload="window.__ddmPwned=2">';

const PAYLOAD_MODEL: PopupModel = {
  kind: 'surface',
  title: PAYLOAD,
  issuer: { role: 'issued-by', name: `Fish & Wildlife ${PAYLOAD}`, productKey: 'usdm' },
  value: [{ label: PAYLOAD, text: PAYLOAD, items: [PAYLOAD], issuer: PAYLOAD }],
  clocks: [
    { kind: 'point', meaning: 'observed', label: PAYLOAD, at: { precision: 'supplied', text: PAYLOAD, explanation: PAYLOAD } }
  ],
  source: { link: { label: PAYLOAD, href: 'https://droughtmonitor.unl.edu/' } },
  details: [
    { kind: 'row', label: PAYLOAD, text: PAYLOAD },
    { kind: 'chart', label: PAYLOAD, chartKey: PAYLOAD, summary: PAYLOAD, data: [1, 2], options: { title: PAYLOAD }, unit: PAYLOAD, attribution: PAYLOAD }
  ],
  qualifications: [PAYLOAD],
  actions: [{ kind: 'briefing', place: PAYLOAD }]
};

const GROUP_MODEL: PopupModel = {
  kind: 'group',
  group: {
    groupKey: 'g:0001',
    computedAt: Date.UTC(2026, 8, 26, 21, 5),
    zone: 'America/Los_Angeles',
    issuers: ['nifc', 'bcws'],
    records: [
      {
        key: PAYLOAD,
        issuer: 'bcws',
        identifier: PAYLOAD,
        sizes: [{ label: PAYLOAD, text: PAYLOAD }],
        status: { from: 'issuer', text: PAYLOAD },
        clocks: [{ kind: 'not-stated', label: PAYLOAD, reason: PAYLOAD }],
        links: [{ label: PAYLOAD, href: 'https://wildfiresituation.nrs.gov.bc.ca/map' }]
      },
      {
        key: 'NIFC-A',
        issuer: 'nifc',
        identifier: '2026-WAFIX-000123',
        sizes: [],
        clocks: [{ kind: 'not-stated', label: 'Perimeter date', reason: 'Fixture reason.' }],
        links: []
      }
    ]
  }
};

test.describe('identify paths: inert payloads and the shared validator', () => {
  test('text and attribute payloads stay inert, and the frame validator accepts a frame and rejects an empty marker', async ({
    page
  }) => {
    await holdExternalNetwork(page);
    await page.addInitScript(installPopupAudit, { legacyLayerIds: legacyLayerIds(), external: true });
    await gotoApp(page, '?region=washington_state&view=console&layers=states');
    const markups = [serializePopupFrame(PAYLOAD_MODEL), serializePopupFrame(GROUP_MODEL)];
    const result = await page.evaluate(async (htmls) => {
      const w = window as unknown as AuditWindow & { __ddmPwned?: number };
      const check = w.__ddmFrameCheck!;
      const hosts = htmls.map((html) => {
        const host = document.createElement('div');
        host.innerHTML = html;
        document.body.appendChild(host);
        return host;
      });
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
      const text = hosts.map((host) => host.textContent ?? '').join(' ');
      const inert = {
        pwned: w.__ddmPwned ?? 0,
        unsafe: hosts.reduce((n, host) => n + host.querySelectorAll('img, svg, script, iframe, [onerror], [onload]').length, 0),
        literal: text.includes('<img src=x onerror='),
        ampersand: text.includes('Fish & Wildlife'),
        doubleEscaped: text.includes('&lt;') || text.includes('&amp;') || text.includes('&quot;'),
        hrefs: hosts.flatMap((host) => Array.from(host.querySelectorAll('a')).map((a) => a.getAttribute('href')))
      };

      // The validator, on the frame as the coordinator presents it: the
      // article is the displayed root and its regions carry the classes.
      const present = (html: string): { sink: HTMLElement; root: Element } => {
        const sink = document.createElement('div');
        sink.innerHTML = html;
        const root = sink.firstElementChild!;
        root.classList.add('coordinated-response');
        root.children[0]!.classList.add('coordinated-response-head');
        root.children[1]!.classList.add('coordinated-response-body');
        return { sink, root };
      };
      const good = present(htmls[0]!);
      const stray = present(htmls[0]!);
      stray.sink.appendChild(document.createElement('p')).textContent = 'stray unframed content';
      const emptySlot = present(htmls[0]!);
      emptySlot.root.querySelector('[data-popup-slot="title"]')!.textContent = '';
      const marker = document.createElement('div');
      marker.innerHTML = '<div class="coordinated-response"><div class="popup-title">Legacy</div><span data-popup-frame></span></div>';
      for (const host of hosts) host.remove();
      return {
        inert,
        verdicts: {
          good: check(good.root, good.sink),
          stray: check(stray.root, stray.sink),
          emptySlot: check(emptySlot.root, emptySlot.sink),
          emptyMarker: check(marker.firstElementChild!, marker)
        }
      };
    }, markups);

    expect(result.inert.unsafe, 'an executable node or handler attribute was parsed from a payload').toBe(0);
    expect(result.inert.pwned, 'a payload handler ran').toBe(0);
    expect(result.inert.literal, 'the payload shows as its own text').toBe(true);
    expect(result.inert.ampersand, 'an ampersand shows once').toBe(true);
    expect(result.inert.doubleEscaped, 'an entity shows double-escaped').toBe(false);
    expect(result.inert.hrefs).toEqual(['https://droughtmonitor.unl.edu/', 'https://droughtmonitor.unl.edu/', 'https://wildfiresituation.nrs.gov.bc.ca/map']);
    expect(result.verdicts.good).toBeNull();
    expect(result.verdicts.stray).not.toBeNull();
    expect(result.verdicts.emptySlot).not.toBeNull();
    expect(result.verdicts.emptyMarker).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. Later mutations (M23 repair round 1, Codex ultra finding 3)
// ---------------------------------------------------------------------------

test.describe('identify paths: the observer re-audits later mutations', () => {
  test('a stray node, root text, an emptied title or a removed region marker after the first audit fails; the late door and a telemetry hydration pass', async ({ page }) => {
    await holdExternalNetwork(page);
    await page.addInitScript(installPopupAudit, { legacyLayerIds: legacyLayerIds(), external: true });
    await gotoApp(page, '?region=washington_state&view=console&layers=states');
    const layerId = legacyLayerIds()[0]!;
    const seenCount = async (): Promise<number> => (await readAudit(page)).seen.length;

    // Three map-popup fixtures, shaped as the coordinator and telemetry
    // present them: a framed coordinated response, a legacy (allowance)
    // coordinated response, and an adopted external popup.
    await page.evaluate(
      ({ framed, layer }) => {
        const popup = (html: string, fixture: string, external = false): HTMLElement => {
          const el = document.createElement('div');
          el.className = 'maplibregl-popup';
          el.dataset.fixture = fixture;
          if (external) el.setAttribute('data-ddm-external-response', '');
          el.innerHTML = `<div class="maplibregl-popup-content">${html}<button class="maplibregl-popup-close-button" type="button">x</button></div>`;
          return el;
        };
        const framedPopup = popup(framed, 'framed');
        const root = framedPopup.querySelector('[data-popup-frame]')!;
        root.classList.add('coordinated-response');
        root.setAttribute('data-ddm-response', layer);
        root.children[0]!.classList.add('coordinated-response-head');
        root.children[1]!.classList.add('coordinated-response-body');
        const legacyPopup = popup(
          `<div class="coordinated-response" data-ddm-response="${layer}"><div class="coordinated-response-head"><h3 class="popup-title">Fixture legacy title</h3></div><div class="coordinated-response-body"><p>Fixture body</p></div></div>`,
          'legacy'
        );
        const externalPopup = popup('<div class="fixture-telemetry">Fixture skeleton</div>', 'external', true);
        const host = document.createElement('div');
        host.append(framedPopup, legacyPopup, externalPopup);
        document.body.appendChild(host);
      },
      { framed: serializePopupFrame(PAYLOAD_MODEL), layer: layerId }
    );
    await expect
      .poll(async () => (await readAudit(page)).seen.filter((s) => s === `map:${layerId}` || s === 'map:external').length)
      .toBe(3);
    expect((await readAudit(page)).violations, 'the three fixtures pass their first audit').toEqual([]);

    // The two legitimate later changes: the late briefing door (the framed
    // actions slot; the legacy head directly after the title) and a
    // telemetry hydration of the adopted popup. Each is audited again and
    // none reports a violation.
    const before = await seenCount();
    await page.evaluate(() => {
      const door = (): HTMLButtonElement => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'popup-impact-btn';
        button.setAttribute('data-ddm-impact-trigger', '');
        button.textContent = 'Fixture door';
        return button;
      };
      document.querySelector('[data-fixture="framed"] [data-popup-slot="actions"]')!.appendChild(door());
      document.querySelector('[data-fixture="legacy"] .popup-title')!.after(door());
      const hydrated = document.createElement('p');
      hydrated.textContent = 'Fixture hydrated reading';
      document.querySelector('[data-fixture="external"] .fixture-telemetry')!.appendChild(hydrated);
    });
    await expect.poll(seenCount, { message: 'each later change is audited again' }).toBeGreaterThanOrEqual(before + 3);
    expect((await readAudit(page)).violations, 'the late door and a hydration are legitimate').toEqual([]);

    // A stray node inside the already-audited frame: re-audited and failed.
    await page.evaluate(() => {
      const stray = document.createElement('p');
      stray.textContent = 'Fixture stray unframed content';
      document.querySelector('[data-fixture="framed"] [data-popup-frame]')!.appendChild(stray);
    });
    await expect
      .poll(async () => (await readAudit(page)).violations)
      .toContain(`map ${layerId}: the frame root holds other than its two regions`);
    const strayOnly = (await readAudit(page)).violations.length;

    // A text edit and an attribute edit after the first audit (the Codex r1
    // re-check, finding 3), each on a fresh framed fixture that first passes.
    const seenBefore = await seenCount();
    await page.evaluate(
      ({ framed, layer }) => {
        const host = document.createElement('div');
        for (const fixture of ['framed-title', 'framed-region', 'framed-text']) {
          const el = document.createElement('div');
          el.className = 'maplibregl-popup';
          el.dataset.fixture = fixture;
          el.innerHTML = `<div class="maplibregl-popup-content">${framed}<button class="maplibregl-popup-close-button" type="button">x</button></div>`;
          const root = el.querySelector('[data-popup-frame]')!;
          root.classList.add('coordinated-response');
          root.setAttribute('data-ddm-response', layer);
          root.children[0]!.classList.add('coordinated-response-head');
          root.children[1]!.classList.add('coordinated-response-body');
          host.appendChild(el);
        }
        document.body.appendChild(host);
      },
      { framed: serializePopupFrame(PAYLOAD_MODEL), layer: layerId }
    );
    await expect.poll(seenCount, { message: 'the fresh fixtures are audited' }).toBeGreaterThanOrEqual(seenBefore + 3);
    expect((await readAudit(page)).violations.length, 'the fresh fixtures pass their first audit').toBe(strayOnly);

    await page.evaluate(() => {
      const title = document.querySelector('[data-fixture="framed-title"] [data-popup-slot="title"]')!;
      (title.firstChild as Text).data = '';
      document.querySelector('[data-fixture="framed-region"] [data-popup-region="head"]')!.removeAttribute('data-popup-region');
      // Visible text directly under the frame root, outside both regions.
      document.querySelector('[data-fixture="framed-text"] [data-popup-frame]')!.append(document.createTextNode('Fixture unframed visible text'));
    });
    await expect
      .poll(async () => (await readAudit(page)).violations)
      .toEqual(
        expect.arrayContaining([
          `map ${layerId}: the head slot title is missing or empty`,
          `map ${layerId}: the displayed head is not the frame head region`
        ])
      );
    // The stray-element fixture reported this once; the root text is the second.
    await expect
      .poll(async () => (await readAudit(page)).violations.filter((v) => v === `map ${layerId}: the frame root holds other than its two regions`).length)
      .toBeGreaterThanOrEqual(2);
  });
});
