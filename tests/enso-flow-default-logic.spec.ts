// Page-free tests moved from tests/enso-flow-default.spec.ts so they run in the pure lane (npm run verify:pure).

import { readFileSync } from 'node:fs';

import { expect, test } from './offline-test';

import { HAZARD_CLUSTERS } from '../src/config/clusters';
import { syncUrl } from '../src/state/url';
import { installFakeBrowser } from './map-harness';
import { FLOW_MOTION_STORAGE_KEY } from './helpers';

test.describe('E2-4 pure: the default is the cluster field, and the hold names the loop key', () => {
  test('ENSO carries flowDefault wind and no other mode carries one', () => {
    const carriers = Object.entries(HAZARD_CLUSTERS)
      .filter(([, def]) => def.flowDefault !== undefined)
      .map(([key, def]) => [key, def.flowDefault]);
    expect(carriers).toEqual([['enso', 'wind']]);
  });

  test('the helper hold writes the key the motion loop reads', () => {
    // Read from the source text: importing the loop would pull the time bar into a Node spec.
    const source = readFileSync(new URL('../src/layers/flow/motion-loop.ts', import.meta.url), 'utf8');
    expect(/export const MOTION_STORAGE_KEY = '([^']+)';/.exec(source)?.[1]).toBe(FLOW_MOTION_STORAGE_KEY);
  });

  test('entering ENSO from a link with no flow key writes no flow key', () => {
    // The write that follows a click on the ENSO tile reads the current link
    // (a mode with no default) and writes the new one (ENSO, default wind).
    for (const inbound of ['?region=washington_state&view=brief', '?cluster=wildfire&region=national', '?layers=places&view=console']) {
      const browser = installFakeBrowser({ search: inbound });
      try {
        syncUrl({ region: null, layers: new Set(['sst-anomaly']), embed: false, view: 'console', cluster: 'enso', ocean: 'pacific' });
        const params = new URLSearchParams(browser.search());
        expect(params.get('cluster'), `${inbound}: the cluster`).toBe('enso');
        expect(params.get('flow'), `${inbound}: no flow key beside the ENSO default`).toBeNull();
      } finally {
        browser.restore();
      }
    }
  });

  test('with the flow panel mounted, the ENSO tile keeps what the panel shows; before it mounts, the entered default applies', () => {
    // The panel parses the link once, when it mounts, and keeps that preference
    // (a custom display already showing SST stays active through an ENSO press),
    // so with the panel mounted the link must keep saying what it shows. A switch
    // from a mode without SST writes the granular SST link first, before the
    // panel exists: that link must not read as a custom display.
    const enso = { region: null, layers: new Set(['sst-anomaly']), embed: false, view: 'console', cluster: 'enso', ocean: 'pacific' } as const;
    for (const [inbound, panelMounted, expected] of [
      ['?layers=sst-anomaly,usdm&view=console', true, 'off'],
      ['?layers=sst-anomaly&view=console', true, 'off'],
      ['?layers=sst-anomaly,usdm&flow=waves', true, 'waves'],
      ['?cluster=enso', true, null],
      ['?layers=sst-anomaly&view=console', false, null],
      ['?region=washington_state&layers=hillshade,sst-anomaly&view=brief', false, null],
      ['?layers=usdm&view=console', false, null]
    ] as const) {
      const browser = installFakeBrowser({ search: inbound });
      const document = globalThis.document as unknown as { querySelector?: (selector: string) => unknown };
      document.querySelector = (selector: string) => (panelMounted && selector === '.enso-flow' ? {} : null);
      try {
        syncUrl(enso);
        const params = new URLSearchParams(browser.search());
        expect(params.get('cluster'), `${inbound}: the cluster`).toBe('enso');
        expect(params.get('flow'), `${inbound} (panel ${panelMounted ? 'mounted' : 'not mounted'})`).toBe(expected);
      } finally {
        browser.restore();
      }
    }
  });

  test('moving from ENSO to the granular display keeps the wind it was showing', () => {
    // The new display has no default, so the link being replaced still decides.
    for (const [inbound, expected] of [['?cluster=enso', 'wind'], ['?cluster=enso&flow=off', 'off'], ['?cluster=enso&flow=waves', 'waves']] as const) {
      const browser = installFakeBrowser({ search: inbound });
      try {
        syncUrl({ region: null, layers: new Set(['sst-anomaly', 'places']), embed: false, view: 'console' });
        const params = new URLSearchParams(browser.search());
        expect(params.get('cluster'), `${inbound}: granular`).toBeNull();
        // Wind is not the granular default (off), so it is named; off is the default, so it is not.
        expect(params.get('flow'), inbound).toBe(expected === 'off' ? null : expected);
      } finally {
        browser.restore();
      }
    }
  });

  test('entering ENSO from a link that names flow=off or a kind keeps it', () => {
    for (const [inbound, expected] of [['?cluster=enso&flow=off', 'off'], ['?cluster=enso&flow=waves', 'waves']] as const) {
      const browser = installFakeBrowser({ search: inbound });
      try {
        syncUrl({ region: null, layers: new Set(['sst-anomaly']), embed: false, view: 'console', cluster: 'enso', ocean: 'pacific' });
        expect(new URLSearchParams(browser.search()).get('flow'), inbound).toBe(expected);
      } finally {
        browser.restore();
      }
    }
  });
});
