import { test, expect, type Page, type Route } from './offline-test';
import { gotoApp, waitForLayerSettled } from './helpers';
import {
  BUILDERS,
  LEGACY_ALLOWANCE,
  eligibleBuilders,
  legacyLayerIds,
  migratedBuilders
} from './identify-paths-manifest';
import { serializePopupFrame } from '../src/ui/popup-frame';
import type { IssuedModel, PopupModel } from '../src/ui/popup-frame';
import { CENSUS_FIXTURES, type CensusFixture } from './frame-fixtures';
import { MAP_ROOT, PLACE_FRAME_FIXTURES, bootPlace, expectPlaceFields } from './frame-fixtures-places';

/**
 * S30D D1 M23: "every identify path" (DDM-P11-T04), as the Codex Tier 2
 * review's PF5 and PF6 and the N2 brief corrections C3, C4 and C7 shape it.
 *
 *   1. An import-aware inventory of Popup construction and content setters
 *      over src/, with COUNTED narrow boundaries (the coordinator's one
 *      construction and own popup setter; the lazy frame's adopted station
 *      first-paint setter; telemetry.ts's one construction
 *      and, since M26c, no setter), a self-check that the scan bites, the
 *      declared no-popup modules, and the frame's one caller (S30D
 *      P1-FRAME: the coordinator's one dynamic import; no static value
 *      import of popup-frame anywhere in src/, type-only imports allowed; no
 *      import() with a computed specifier but the retry loader's own; and
 *      main.ts holds the frame in no form, a type query included).
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
      if (slot === 'source' && !el) {
        // The head fits (S30D block 3): a feature with no source link has no
        // head source slot; its stated reason stands, linking nowhere, in the
        // body's source-fallback slot.
        const fallback = body.querySelector(':scope > [data-popup-slot="source-fallback"]');
        if (!fallback || (fallback.textContent ?? '').trim() === '' || fallback.querySelector('a[href]')) {
          return 'no head source and no stated no-source reason in the body';
        }
        continue;
      }
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
  ['spc-fire-weather'],
  ['sst-anomaly'],
  ['tropical-cyclones'],
  // The CPC outlooks are event-role overlays, not exclusive surfaces: one boot holds all six.
  ['cpc-seasonal-precip', 'cpc-seasonal-temp', 'cpc-610-precip', 'cpc-610-temp', 'cpc-814-precip', 'cpc-814-temp']
];

/** The adopted station popup's displayed frame root. */
const STATION_ROOT = '.maplibregl-popup[data-ddm-external-response] .maplibregl-popup-content > [data-popup-frame]';

/**
 * The external builders' census fixtures (S30D D1 M26c). The telemetry
 * station popup has no click target: a station is a DOM marker whose popup
 * MapLibre opens and the coordinator adopts, so its fixture opens the
 * curated Ice Harbor Dam marker (it renders with no network) and asserts the
 * frame on the adopted popup, first as painted and again after the live read
 * fails offline and the frame repaints with the unavailable state.
 */
const EXTERNAL_CENSUS_FIXTURES: Readonly<Record<string, CensusFixture>> = {
  telemetry: async (page, h) => {
    await gotoApp(page, '?region=washington_state&view=console&layers=telemetry');
    await waitForLayerSettled(page, 'telemetry');
    const marker = page.locator('.telemetry-marker[data-telemetry-station-id="ihr"]');
    await expect(marker).toHaveCount(1);
    await expect(async () => {
      await marker.click();
      await expect.poll(async () => (await h.readAudit(page)).seen, { timeout: 1500 }).toContain('map:external');
    }).toPass({ timeout: 20_000 });
    expect(await page.evaluate(frameVerdict, STATION_ROOT), 'the adopted station popup as painted').toBeNull();
    await expect(page.locator(`${STATION_ROOT} [data-popup-slot="value"] [data-state]`)).toHaveText('unavailable', { timeout: 20_000 });
    expect(await page.evaluate(frameVerdict, STATION_ROOT), 'the adopted station popup after its read failed').toBeNull();
    expect((await h.readAudit(page)).violations).toEqual([]);
  }
};

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
    // asserts window.__ddmFrameCheck on its response (the four non-empty
    // head slots, and a link-bearing head source or, with no link, the
    // body's stated no-source reason; the frame owns the displayed content).
    // Each fixture gets a fresh page with the observer installed, so one
    // fixture's routes and viewport never reach the next; each boots through
    // gotoApp's stubs. Network isolation: every fixture page opens in THIS
    // context, so the catch-all 503 backstop holdExternalNetwork installed
    // on the context above, before the first boot, answers each fixture
    // page's unrouted external requests too; gotoApp's context stubs,
    // registered later, and each fixture's page routes keep precedence over
    // it. (A second backstop registered here, after those boots, would
    // outrank gotoApp's context stubs, which is why none is added.) The
    // count is asserted, so an empty loop is declared.
    const migrated = migratedBuilders();
    expect(migrated.length).toBe(eligibleBuilders().length - LEGACY_ALLOWANCE.length);
    for (const builder of migrated) {
      // An external builder has no click target, so its fixture opens its own
      // popup; it lives beside the census (EXTERNAL_CENSUS_FIXTURES, M26c).
      const fixture = builder.path === 'external' ? EXTERNAL_CENSUS_FIXTURES[builder.id] : CENSUS_FIXTURES[builder.id];
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

/**
 * S30D D1 M24: "every place-kind click target yields the frame" (D1.md:424),
 * in the map popup (the Codex Tier 2 review :220, "frame root owns content":
 * a missing or empty marker or detached regions must fail). One test per
 * place builder of tests/frame-fixtures-places.ts. Each boots the Console
 * offline with the observer installed, so a response is audited as it
 * appears, then the ONE validator (window.__ddmFrameCheck) runs on the
 * displayed root and the builder's named fields are read from it. The
 * panel-foot half retired with the owner's 2026-11-13 ruling: in Brief a
 * place click opens the place's briefing, so no place response reaches the
 * panel foot.
 *
 * Red on a94eee5 once the six allowance lines are deleted: the observer
 * reports "map: an unframed response for <layer id>, outside the legacy
 * allowance" and no [data-popup-frame] root is displayed.
 */
function frameVerdict(selector: string): string | null {
  const root = document.querySelector(selector);
  const sink = root?.parentElement;
  const check = (window as unknown as AuditWindow).__ddmFrameCheck;
  if (!root || !sink) return `no framed response at ${selector}`;
  return check ? check(root, sink) : 'the observer is not installed';
}

test.describe('identify paths: every place builder yields the frame in the map popup (D1 M24)', () => {
  for (const fixture of Object.values(PLACE_FRAME_FIXTURES)) {
    test(`${fixture.id} yields the frame in the map popup`, async ({ page }) => {
      test.setTimeout(180_000);
      expect(migratedBuilders().map((b) => b.id), `${fixture.id} has left LEGACY_ALLOWANCE`).toContain(fixture.id);
      await holdExternalNetwork(page);
      await page.addInitScript(installPopupAudit, {
        legacyLayerIds: legacyLayerIds(),
        external: LEGACY_ALLOWANCE.includes('telemetry')
      });
      await fixture.prepare(page);
      for (const target of fixture.targets) {
        const label = `${fixture.id} ${target.layerId}`;
        // The map sink (console).
        await bootPlace(page, fixture, target, 'console');
        await clickCenterUntilSeen(page, `map:${target.layerId}`);
        expect((await readAudit(page)).violations, `${label}: map audit`).toEqual([]);
        expect(await page.evaluate(frameVerdict, MAP_ROOT), `${label}: map frame check`).toBeNull();
        await expectPlaceFields(page.locator(MAP_ROOT), target.expected, `${label} map`);
      }
    });
  }
});

test.describe('identify paths: the observer over the map popup', () => {
  test('the observer passes only framed responses, stamped allowance responses and the adopted external popup', async ({
    page
  }) => {
    test.setTimeout(120_000);
    await holdExternalNetwork(page);
    await page.addInitScript(installPopupAudit, {
      legacyLayerIds: legacyLayerIds(),
      external: LEGACY_ALLOWANCE.includes('telemetry')
    });

    // The map sink: a coordinated FRAMED response (BIA left the allowance at
    // D1 M24), audited through __ddmFrameCheck. Each boot re-runs the init
    // script, so each part reads its own audit.
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
    // The panel-foot part retired with the owner's 2026-11-13 ruling: a place
    // click in the Brief shell opens the place's briefing, so no place response
    // reaches the panel foot for the observer to pass.
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

/** A station popup as the coordinator paints it before the live read lands (M26c). */
const STATION_MODEL: IssuedModel = {
  kind: 'station',
  title: 'Fixture Station',
  issuer: { role: 'issued-by', name: 'Fixture agency', productKey: 'telemetry' },
  value: [{ text: 'Fixture live data', state: 'loading' }],
  clocks: [{ kind: 'not-stated', label: 'Observed', reason: 'loading' }],
  source: { link: { label: 'Fixture station page', href: 'https://waterdata.usgs.gov/' } }
};

/** The same station once its read landed: a genuine zero with its own issuer and time. */
const HYDRATED_STATION_MODEL: IssuedModel = {
  ...STATION_MODEL,
  value: [{ label: 'Fixture gauge', text: '0 ft', issuer: 'Fixture service' }],
  clocks: [{ kind: 'point', meaning: 'observed', label: 'Observed', at: { precision: 'instant', at: Date.UTC(2026, 9, 4, 17, 0), zone: 'UTC' } }]
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
    // A literal fixture layer id (S30D D1 M26b): the allowance is empty since
    // M26c, so legacyLayerIds() is empty; the observer is handed this one id
    // as its legacy pass list, so the legacy re-audit path keeps its proof.
    // The adopted external popup takes the allowance's own answer (none
    // since M26c): it must be framed.
    const layerId = 'fixture-legacy-fill';
    await page.addInitScript(installPopupAudit, { legacyLayerIds: [layerId], external: LEGACY_ALLOWANCE.includes('telemetry') });
    await gotoApp(page, '?region=washington_state&view=console&layers=states');
    const seenCount = async (): Promise<number> => (await readAudit(page)).seen.length;

    // Three map-popup fixtures, shaped as the coordinator and telemetry
    // present them: a framed coordinated response, a legacy (allowance)
    // coordinated response, and an adopted external popup (framed, M26c).
    await page.evaluate(
      ({ framed, station, layer }) => {
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
        const externalPopup = popup(station, 'external', true);
        const host = document.createElement('div');
        host.append(framedPopup, legacyPopup, externalPopup);
        document.body.appendChild(host);
      },
      { framed: serializePopupFrame(PAYLOAD_MODEL), station: serializePopupFrame(STATION_MODEL), layer: layerId }
    );
    await expect
      .poll(async () => (await readAudit(page)).seen.filter((s) => s === `map:${layerId}` || s === 'map:external').length)
      .toBe(3);
    expect((await readAudit(page)).violations, 'the three fixtures pass their first audit').toEqual([]);

    // The two legitimate later changes: the late briefing door (the framed
    // actions slot; the legacy head directly after the title) and a
    // telemetry hydration of the adopted popup (the coordinator replaces the
    // frame root whole with the hydrated model's, M26c). Each is audited
    // again and none reports a violation.
    const before = await seenCount();
    await page.evaluate((hydratedStation) => {
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
      const template = document.createElement('template');
      template.innerHTML = hydratedStation;
      document.querySelector('[data-fixture="external"] [data-popup-frame]')!.replaceWith(template.content.firstElementChild!);
    }, serializePopupFrame(HYDRATED_STATION_MODEL));
    await expect.poll(seenCount, { message: 'each later change is audited again' }).toBeGreaterThanOrEqual(before + 3);
    expect((await readAudit(page)).violations, 'the late door and a hydration are legitimate').toEqual([]);
    await expect(page.locator('[data-fixture="external"] [data-popup-slot="value"]')).toContainText('Fixture gauge 0 ft');

    // An adopted popup that loses its frame (the legacy station markup the
    // allowance carried until M26c) is re-audited and failed.
    await page.evaluate(() => {
      document.querySelector('[data-fixture="external"] [data-popup-frame]')!.replaceWith(
        Object.assign(document.createElement('div'), { className: 'popup-title', textContent: 'Fixture unframed station' })
      );
    });
    await expect
      .poll(async () => (await readAudit(page)).violations)
      .toEqual(['map: an unframed adopted external popup outside the legacy allowance']);

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

// ---------------------------------------------------------------------------
// S30D D1 M26a (block 4; register owner-1k, DDM-P11-T04): the NIFC perimeter
// (with its fire context) and the place-label targets have left
// LEGACY_ALLOWANCE. The census above runs their fixtures with every other
// migrated builder's; this case runs only these two, so their verdict reads
// on its own. Imported here, beside the case, so the block is an append.
// ---------------------------------------------------------------------------
import { FIRE_LABEL_CENSUS_FIXTURES } from './frame-fixtures-fires-labels';

/**
 * Red on 4c2afb4 once the 'nifc' and 'places' allowance lines are deleted:
 * the observer reports "map: an unframed response for nifc-fires-fill (or
 * us-places-labels), outside the legacy allowance" and the frame validator
 * finds no [data-popup-frame] root ("not exactly one frame root").
 */
test.describe('identify paths: the NIFC and place-label targets yield the frame (D1 M26a)', () => {
  for (const id of ['nifc', 'places'] as const) {
    test(`the census yields [data-popup-frame] for the ${id} target`, async ({ page }) => {
      test.setTimeout(120_000);
      expect(LEGACY_ALLOWANCE, `${id} has left LEGACY_ALLOWANCE`).not.toContain(id);
      expect(migratedBuilders().map((b) => b.id), `${id} is a migrated builder`).toContain(id);
      expect(Object.keys(CENSUS_FIXTURES), `${id} is registered in tests/frame-fixtures.ts`).toContain(id);
      await holdExternalNetwork(page);
      await page.addInitScript(installPopupAudit, {
        legacyLayerIds: legacyLayerIds(),
        external: LEGACY_ALLOWANCE.includes('telemetry')
      });
      await FIRE_LABEL_CENSUS_FIXTURES[id]!(page, { clickCenterUntilSeen, readAudit });
    });
  }
});

// ---------------------------------------------------------------------------
// S30D D1 M26b (block 5; register owner-1k, DDM-P11-T04): the NWS alert, SPC
// fire weather outlook, power plant and power line targets have left
// LEGACY_ALLOWANCE. The census above runs their fixtures with every other
// migrated builder's; these cases run only these four, so their verdict reads
// on its own. Imported here, beside the cases, so the block is an append.
// ---------------------------------------------------------------------------
import { EVENT_STATION_CENSUS_FIXTURES } from './frame-fixtures-events-stations';

/**
 * Red on bd8c1aa once the four allowance lines are deleted: the observer
 * reports "map: an unframed response for <layer id>, outside the legacy
 * allowance" and the frame validator finds no [data-popup-frame] root
 * ("not exactly one frame root").
 */
test.describe('identify paths: the NWS, SPC and power targets yield the frame (D1 M26b)', () => {
  for (const id of ['nws', 'spc', 'power-plant', 'power-line'] as const) {
    test(`the census yields [data-popup-frame] for the ${id} target`, async ({ page }) => {
      test.setTimeout(120_000);
      expect(LEGACY_ALLOWANCE, `${id} has left LEGACY_ALLOWANCE`).not.toContain(id);
      expect(migratedBuilders().map((b) => b.id), `${id} is a migrated builder`).toContain(id);
      expect(Object.keys(CENSUS_FIXTURES), `${id} is registered in tests/frame-fixtures.ts`).toContain(id);
      await holdExternalNetwork(page);
      await page.addInitScript(installPopupAudit, {
        legacyLayerIds: legacyLayerIds(),
        external: LEGACY_ALLOWANCE.includes('telemetry')
      });
      await EVENT_STATION_CENSUS_FIXTURES[id]!(page, { clickCenterUntilSeen, readAudit });
    });
  }
});

// ---------------------------------------------------------------------------
// S30D D1 M26c (block 6; register owner-1k, DDM-P11-T04): the telemetry
// station popup, the last builder outside the frame, renders through it. The
// station marker's popup stays MapLibre's and stays adopted (row 20 of
// interface-chrome-popups-text.md 3.5); telemetry.ts hands the coordinator a
// model, the coordinator paints it, and the live read repaints the whole
// frame (head value, head clock, state word and body together). Imported
// here, beside the cases, so the block is an append.
// ---------------------------------------------------------------------------

/** A CWMS timeseries window with one reading at 2026-10-04 17:00 UTC (the shape src/util/cwms.ts parses). */
function cwmsBody(value: number): string {
  return JSON.stringify({ units: 'ft', values: [[Date.UTC(2026, 9, 4, 17, 0), value, 0]] });
}

test.describe('identify paths: the telemetry station popup joins the frame (D1 M26c)', () => {
  /**
   * Red on 44fda65 (the allowance emptied): the adopted station popup is the
   * legacy skeleton, so the observer reports "map: an unframed adopted
   * external popup outside the legacy allowance" and the frame validator
   * finds no frame root.
   */
  test('the unmigrated list is empty and every click target yields the frame', async ({ page }) => {
    test.setTimeout(120_000);
    expect(LEGACY_ALLOWANCE, 'the unmigrated list').toEqual([]);
    expect(legacyLayerIds()).toEqual([]);
    expect(migratedBuilders().map((b) => b.id)).toEqual(eligibleBuilders().map((b) => b.id));
    // Every eligible builder has its census fixture: a click target's in
    // tests/frame-fixtures.ts, the external station popup's beside the census.
    expect(
      eligibleBuilders()
        .filter((b) => (b.path === 'external' ? EXTERNAL_CENSUS_FIXTURES : CENSUS_FIXTURES)[b.id] === undefined)
        .map((b) => b.id),
      'an eligible builder without a census fixture'
    ).toEqual([]);
    // The click targets run in the census above; the external path runs here
    // on its own, so its verdict reads alone.
    await holdExternalNetwork(page);
    await page.addInitScript(installPopupAudit, { legacyLayerIds: legacyLayerIds(), external: LEGACY_ALLOWANCE.includes('telemetry') });
    await EXTERNAL_CENSUS_FIXTURES['telemetry']!(page, { clickCenterUntilSeen, readAudit });
  });

  /**
   * The Codex Tier 2 review's row (2026-09-27_s30d-d1-tier2-designs.md :215,
   * :142): a skeleton-only migration would leave the head at loading, and an
   * old read must not mutate a reopened response. The station's live reads
   * are held; the first open is closed while its read is held, the station is
   * reopened, the first read answers late with a value no response may show,
   * and the current read answers. Red on 44fda65: no frame root is ever
   * displayed in the adopted popup.
   */
  test('telemetry updates head and body consistently and rejects obsolete hydration', async ({ page }) => {
    test.setTimeout(120_000);
    await holdExternalNetwork(page);
    await page.addInitScript(installPopupAudit, { legacyLayerIds: legacyLayerIds(), external: LEGACY_ALLOWANCE.includes('telemetry') });
    // Every head value a station popup showed, in order, from the first byte.
    await page.addInitScript(() => {
      const values: string[] = [];
      (window as unknown as { __ddmStationValues: string[] }).__ddmStationValues = values;
      new MutationObserver(() => {
        for (const slot of Array.from(document.querySelectorAll('.maplibregl-popup [data-popup-kind="station"] [data-popup-slot="value"]'))) {
          const text = (slot.textContent ?? '').replace(/\s+/g, ' ').trim();
          if (values[values.length - 1] !== text) values.push(text);
        }
      }).observe(document, { childList: true, subtree: true, characterData: true });
    });
    let holding = false;
    const held: Route[] = [];
    await page.route('**/cwms-data.usace.army.mil/**', async (route) => {
      if (holding) held.push(route);
      else await route.fulfill({ status: 200, contentType: 'application/json', body: cwmsBody(75.5) });
    });
    await gotoApp(page, '?region=washington_state&view=console&layers=telemetry');
    await waitForLayerSettled(page, 'telemetry');
    const marker = page.locator('.telemetry-marker[data-telemetry-station-id="ihr"]');
    await expect(marker).toHaveCount(1);
    const root = page.locator(STATION_ROOT);
    const head = root.locator(':scope > [data-popup-region="head"]');
    const body = root.locator(':scope > [data-popup-region="body"]');
    const headValue = head.locator(':scope > [data-popup-slot="value"]');

    // Layer settlement does not await sidebar hydration. Finish the two CWMS
    // setup reads before holding only the popup's independently owned reads.
    await expect(page.locator('[data-station-values="ihr"]')).toContainText('Forebay 75.5 ft');
    await expect(page.locator('[data-station-values="ihr"]')).toHaveCSS('font-family', /^"?DDM Heros"?,/);
    await expect(page.locator('[data-station-values="ihr"]')).toHaveCSS('font-variant-numeric', /^(?:lining-nums tabular-nums|tabular-nums lining-nums)$/);
    await expect(page.locator('[data-station-values="bono3"]')).toContainText('Forebay 75.5 ft');
    holding = true;
    const open = async (reads: number): Promise<void> => {
      await expect(async () => {
        if ((await root.count()) === 0) await marker.click();
        await expect(root).toBeVisible({ timeout: 1500 });
      }).toPass({ timeout: 20_000 });
      // The frame paints at once, its head stating the read is loading.
      await expect(headValue.locator('[data-state]')).toHaveText('loading');
      await expect(head.locator(':scope > [data-popup-slot="clock"]')).toContainText('Observed loading');
      await expect.poll(() => held.length, { message: 'each open asks for its own live read' }).toBe(reads);
    };

    await open(1);
    await page.locator('.maplibregl-popup[data-ddm-external-response] .maplibregl-popup-close-button').click();
    await expect(root).toHaveCount(0);
    await open(2);
    await page.evaluate((selector) => {
      (window as unknown as { __ddmLoadingRoot: Element | null }).__ddmLoadingRoot = document.querySelector(selector);
    }, STATION_ROOT);

    // The closed open's read answers late (its request was aborted with the
    // close, so the answer may find no request); then the current read.
    await held[0]!.fulfill({ status: 200, contentType: 'application/json', body: cwmsBody(111.11) }).catch(() => {});
    await held[1]!.fulfill({ status: 200, contentType: 'application/json', body: cwmsBody(222.22) });

    await expect(headValue).toContainText('Forebay 222.22 ft');
    // Head and body come from one model: one frame root, the loading root
    // gone whole, no state word left anywhere, the head clock the reading's
    // own time, the retrieval time in the body.
    await expect(page.locator('.maplibregl-popup[data-ddm-external-response] [data-popup-frame]')).toHaveCount(1);
    expect(await page.evaluate(() => (window as unknown as { __ddmLoadingRoot: Element | null }).__ddmLoadingRoot?.isConnected)).toBe(false);
    await expect(root.locator('[data-state]')).toHaveCount(0);
    await expect(head.locator(':scope > [data-popup-slot="clock"] time')).toHaveAttribute('datetime', '2026-10-04T17:00:00.000Z');
    await expect(body.locator(':scope > [data-popup-slot="more-clocks"]')).toContainText('Retrieved on');
    await expect(body.locator(':scope > [data-popup-slot="source-fallback"] a')).toHaveAttribute('href', 'https://www.nwd-wc.usace.army.mil/dd/common/dataquery/www/');
    expect(await page.evaluate(frameVerdict, STATION_ROOT)).toBeNull();

    // The obsolete read never reached any response.
    const values = await page.evaluate(() => (window as unknown as { __ddmStationValues: string[] }).__ddmStationValues);
    expect(values.filter((v) => v.includes('111.11')), `the head values shown: ${JSON.stringify(values)}`).toEqual([]);
    expect(values[values.length - 1]).toContain('222.22');
    expect((await readAudit(page)).violations).toEqual([]);
  });

});
