// Page-free tests moved from tests/precedence.spec.ts so they run in the pure lane (npm run verify:pure).

import { test, expect } from './offline-test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SIDEBAR_DESKTOP_QUERY,
  normalizeSidebarParam,
  parseEmbedParam,
  parseSidebarParam,
  parseUrlParams
} from '../src/state/url';
import { installFakeBrowser } from './map-harness';

/** The inline classic bootstrap's id in index.html (S1). */
const SIDEBAR_BOOT_ID = 'ddm-sidebar-boot';

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
});
