// Page-free tests moved from tests/url-state.spec.ts so they run in the pure lane (npm run verify:pure).

import { test, expect } from './offline-test';
import { HAZARD_CLUSTER_KEYS, HAZARD_CLUSTERS } from '../src/config/clusters';
import {
  syncFire3dParam,
  syncHeatRiskDayParam,
  syncSpiWindowParam,
  syncUrl
} from '../src/state/url';
import {
  parseEnsoFlowParams,
  syncEnsoFlowParams,
  writeEnsoFlowParams,
  type EnsoFlowKind
} from '../src/state/enso-flow';
import * as ensoFlowState from '../src/state/enso-flow';
import { readFileSync } from 'node:fs';
import type { HazardClusterDef, HazardClusterKey } from '../src/config/clusters';
import { fullSiteLayersStudioUrl, fullSitePlaceStudioUrl } from '../src/state/studio-route';
import { installFakeBrowser } from './map-harness';

/** Inbound sidebar= forms and whether the one emitted form survives a write. */
const SIDEBAR_INBOUND: ReadonlyArray<{ readonly query: string; readonly kept: boolean }> = [
  { query: 'sidebar=closed', kept: true },
  { query: 'sidebar=closed&sidebar=closed', kept: false },
  { query: 'sidebar=open', kept: false },
  { query: 'sidebar=', kept: false },
  { query: 'sidebar=CLOSED', kept: false },
  { query: 'embed=true&sidebar=closed', kept: false },
  { query: 'embed=1&sidebar=closed', kept: false },
  { query: 'embed=false&sidebar=closed', kept: true }
];

/** The additive writers: each clones the current query and changes one key. */
const ADDITIVE_WRITERS: ReadonlyArray<{
  readonly name: string;
  readonly key: string;
  readonly value: string;
  readonly write: () => void;
}> = [
  { name: 'syncHeatRiskDayParam', key: 'heatday', value: '3', write: () => syncHeatRiskDayParam(3) },
  { name: 'syncSpiWindowParam', key: 'spi', value: '30', write: () => syncSpiWindowParam(30) },
  { name: 'syncFire3dParam', key: 'fire3d', value: 'true', write: () => syncFire3dParam(true) },
  {
    name: 'syncEnsoFlowParams',
    key: 'flow',
    value: 'wind',
    write: () => syncEnsoFlowParams({ kind: 'wind', ink: 'light' })
  }
];

/** A fake `window` carrying only `location.href`, for the link-out builders. */
function withLocationHref<T>(href: string, run: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { href } }
  });
  try {
    return run();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

test.describe('D1 M7: every URL writer normalizes sidebar= (S3)', () => {
  test('the heatday, spi, fire3d and flow writers preserve one sidebar=closed and drop every other form', () => {
    for (const writer of ADDITIVE_WRITERS) {
      for (const inbound of SIDEBAR_INBOUND) {
        const label = `${writer.name} over ?cluster=wildfire&${inbound.query}`;
        const browser = installFakeBrowser({ search: `?cluster=wildfire&${inbound.query}` });
        try {
          writer.write();
          const params = new URLSearchParams(browser.search());
          expect(params.getAll('sidebar'), label).toEqual(inbound.kept ? ['closed'] : []);
          expect(params.get(writer.key), `${label}: its own key`).toBe(writer.value);
          expect(params.get('cluster'), `${label}: a neighbour`).toBe('wildfire');
          expect(params.getAll('embed'), `${label}: embed untouched`).toEqual(
            new URLSearchParams(inbound.query).getAll('embed')
          );
        } finally {
          browser.restore();
        }
      }
    }
  });

  test('the canonical write emits sidebar=closed only from the live preference, never in an embed', () => {
    const cases: ReadonlyArray<{
      readonly inbound: string;
      readonly sidebarClosed: boolean | undefined;
      readonly embed: boolean;
      readonly expected: readonly string[];
    }> = [
      // The canonical write rebuilds from state: the inbound token is irrelevant.
      { inbound: '?sidebar=closed', sidebarClosed: true, embed: false, expected: ['closed'] },
      { inbound: '?sidebar=closed', sidebarClosed: false, embed: false, expected: [] },
      { inbound: '?sidebar=closed&sidebar=closed', sidebarClosed: undefined, embed: false, expected: [] },
      { inbound: '', sidebarClosed: true, embed: false, expected: ['closed'] },
      { inbound: '?sidebar=closed', sidebarClosed: true, embed: true, expected: [] }
    ];
    for (const { inbound, sidebarClosed, embed, expected } of cases) {
      const label = `${inbound || '(bare)'} sidebarClosed=${String(sidebarClosed)} embed=${embed}`;
      const browser = installFakeBrowser({ search: inbound });
      try {
        syncUrl({
          region: 'national',
          layers: new Set(['places']),
          embed,
          view: 'brief',
          ...(sidebarClosed === undefined ? {} : { sidebarClosed })
        });
        const params = new URLSearchParams(browser.search());
        expect(params.getAll('sidebar'), label).toEqual([...expected]);
        expect(params.get('embed'), label).toBe(embed ? 'true' : null);
      } finally {
        browser.restore();
      }
    }
  });

  test('the full-site link-outs normalize sidebar= before they drop embed', () => {
    const origin = 'http://127.0.0.1:4173/';
    for (const build of [fullSiteLayersStudioUrl, fullSitePlaceStudioUrl]) {
      for (const inbound of SIDEBAR_INBOUND) {
        const href = withLocationHref(`${origin}?view=brief&${inbound.query}`, build);
        const params = new URL(href).searchParams;
        expect(params.getAll('sidebar'), `${build.name} ${inbound.query}`).toEqual(
          inbound.kept ? ['closed'] : []
        );
        expect(params.has('embed'), `${build.name} ${inbound.query}: embed dropped`).toBe(false);
        expect(params.get('view'), `${build.name} ${inbound.query}: a neighbour`).toBe('brief');
      }
    }
  });
});

/**
 * ENSO-FLOW-PLAN E1-5 (block E1): the `flow=off` token and the `flowDefault`
 * cluster field (C-fit.md 1.4). A mode whose definition carries `flowDefault`
 * opens with that kind when its link names no `flow=`; `flow=off` is the new
 * token that keeps it off, written only where that default is on. Block E1
 * set `flowDefault` on no cluster; E2-4 (DR-111, precedence.md 2.4) sets it
 * on ENSO alone, as wind, so ENSO opens with wind on. The default-on cases
 * here still pass a synthetic cluster table or an explicit default, so they
 * hold whatever a real cluster carries.
 */
test.describe('E1-5: flow=off and the flowDefault cluster field', () => {
  /** Parse, then write back over the same query, as the cloning writer does. */
  function roundTrip(query: string, modeDefault: EnsoFlowKind): {
    readonly kind: EnsoFlowKind;
    readonly ink: string;
    readonly written: string;
  } {
    const params = new URLSearchParams(query);
    const preference = parseEnsoFlowParams(params, modeDefault);
    writeEnsoFlowParams(params, preference, modeDefault);
    return { kind: preference.kind, ink: preference.ink, written: params.toString() };
  }

  test('flow=off parses and round-trips where the mode default is on', () => {
    // Default on (DR-111's wind, precedence.md 2.4): no flow= key opens it.
    expect(parseEnsoFlowParams(new URLSearchParams('cluster=enso'), 'wind')).toEqual({ kind: 'wind', ink: 'light' });
    // flow=off parses to off and is written back as itself.
    expect(roundTrip('cluster=enso&flow=off', 'wind')).toEqual({
      kind: 'off',
      ink: 'light',
      written: 'cluster=enso&flow=off'
    });
    // A second round trip is stable.
    expect(roundTrip(roundTrip('cluster=enso&flow=off', 'wind').written, 'wind').written).toBe('cluster=enso&flow=off');
    // flowink is not carried beside flow=off (nothing draws to ink).
    expect(roundTrip('cluster=enso&flow=off&flowink=dark', 'wind').written).toBe('cluster=enso&flow=off');
    // The default kind writes no flow key, so a boot with no key stays clean;
    // its ink still round-trips.
    expect(roundTrip('cluster=enso', 'wind').written).toBe('cluster=enso');
    expect(roundTrip('cluster=enso&flow=wind&flowink=dark', 'wind')).toEqual({
      kind: 'wind',
      ink: 'dark',
      written: 'cluster=enso&flowink=dark'
    });
    expect(roundTrip('cluster=enso&flowink=dark', 'wind')).toEqual({
      kind: 'wind',
      ink: 'dark',
      written: 'cluster=enso&flowink=dark'
    });
    // Another kind is still named (every 2026-09-13 link keeps its kind).
    expect(roundTrip('cluster=enso&flow=currents', 'wind').written).toBe('cluster=enso&flow=currents');
    expect(roundTrip('cluster=enso&flow=waves', 'wind').written).toBe('cluster=enso&flow=waves');
    // Where the default is off, flow=off is off and is never written.
    expect(roundTrip('layers=sst-anomaly&flow=off', 'off')).toEqual({
      kind: 'off',
      ink: 'light',
      written: 'layers=sst-anomaly'
    });
    expect(roundTrip('layers=sst-anomaly&flow=wind', 'off').written).toBe('layers=sst-anomaly&flow=wind');
  });

  test('a duplicate or unknown flow resolves to off', () => {
    const offInputs = [
      'flow=wind&flow=waves',
      'flow=wind&flow=wind',
      'flow=rainbow',
      'flow=',
      'flow=OFF',
      'flow=Wind',
      'flow=off&flow=wind'
    ];
    for (const input of offInputs) {
      // Where the default is on, the writer rewrites it as flow=off
      // (moving-paths section 12), so the link keeps meaning off.
      expect(roundTrip(`cluster=enso&${input}`, 'wind'), `${input} beside a default-on mode`).toEqual({
        kind: 'off',
        ink: 'light',
        written: 'cluster=enso&flow=off'
      });
      // Where the default is off, it resolves to off and is dropped.
      expect(roundTrip(`layers=sst-anomaly&${input}`, 'off'), `${input} where the default is off`).toEqual({
        kind: 'off',
        ink: 'light',
        written: 'layers=sst-anomaly'
      });
    }
  });

  test('flowDefault is read from the cluster definition, never a cluster literal', () => {
    const withDefault = (
      key: HazardClusterKey,
      flowDefault: HazardClusterDef['flowDefault']
    ): Record<HazardClusterKey, HazardClusterDef> => ({
      ...HAZARD_CLUSTERS,
      [key]: { ...HAZARD_CLUSTERS[key], flowDefault }
    });

    // E2-4 sets it on ENSO alone (DR-111 wind): ENSO opens with wind, the
    // other modes open with flow off, and an off ENSO link writes flow=off.
    for (const key of HAZARD_CLUSTER_KEYS) {
      const token = HAZARD_CLUSTERS[key].urlToken;
      expect(HAZARD_CLUSTERS[key].flowDefault, `${key}'s flowDefault`).toBe(token === 'enso' ? 'wind' : undefined);
    }
    expect(ensoFlowState.ensoFlowModeDefault(new URLSearchParams('cluster=enso'))).toBe('wind');
    expect(ensoFlowState.ensoFlowModeDefault(new URLSearchParams('cluster=wildfire'))).toBe('off');
    expect(ensoFlowState.ensoFlowModeDefault(new URLSearchParams('view=console'))).toBe('off');
    expect(parseEnsoFlowParams(new URLSearchParams('cluster=enso'))).toEqual({ kind: 'wind', ink: 'light' });
    expect(parseEnsoFlowParams(new URLSearchParams('cluster=enso&flow=off'))).toEqual({ kind: 'off', ink: 'light' });
    const enso = new URLSearchParams('cluster=enso');
    writeEnsoFlowParams(enso, { kind: 'off', ink: 'light' });
    expect(enso.toString()).toBe('cluster=enso&flow=off');
    const ensoWindDefault = new URLSearchParams('cluster=enso');
    writeEnsoFlowParams(ensoWindDefault, { kind: 'wind', ink: 'light' });
    expect(ensoWindDefault.toString()).toBe('cluster=enso');

    // The field decides, whichever cluster carries it.
    const ensoWind = withDefault('enso', 'wind');
    expect(ensoFlowState.ensoFlowModeDefault(new URLSearchParams('cluster=enso'), ensoWind)).toBe('wind');
    expect(ensoFlowState.ensoFlowModeDefault(new URLSearchParams('cluster=wildfire'), ensoWind)).toBe('off');
    expect(ensoFlowState.ensoFlowModeDefault(new URLSearchParams(''), ensoWind)).toBe('off');
    // layers= outranks cluster= (parseShellParams): a granular display is no mode.
    expect(ensoFlowState.ensoFlowModeDefault(new URLSearchParams('cluster=enso&layers=sst-anomaly'), ensoWind)).toBe('off');
    const wildfireWaves = withDefault('wildfire', 'waves');
    expect(ensoFlowState.ensoFlowModeDefault(new URLSearchParams('cluster=wildfire'), wildfireWaves)).toBe('waves');
    // ENSO keeps its own field (wind) beside the synthetic Wildfire default.
    expect(ensoFlowState.ensoFlowModeDefault(new URLSearchParams('cluster=enso'), wildfireWaves)).toBe('wind');
    // Drought's URL truth is absence, so a default on Drought reads from no token.
    expect(ensoFlowState.ensoFlowModeDefault(new URLSearchParams('view=console'), withDefault('drought', 'currents'))).toBe('currents');

    // And no cluster literal stands in for the field in the state module.
    const source = readFileSync(new URL('../src/state/enso-flow.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(source).toContain('flowDefault');
    expect(source).not.toMatch(/['"`](?:enso|drought|wildfire|heat)['"`]/);
  });
});
