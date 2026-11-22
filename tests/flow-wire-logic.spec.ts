// Page-free tests moved from tests/flow-wire.spec.ts so they run in the pure lane (npm run verify:pure).

import { expect, test } from './offline-test';

import { FLOW_WORDS, flowLiveLine, flowStaleLine } from '../src/layers/enso-flow-data';
import { FLOW_SOURCES } from '../src/layers/flow/source';
import { FIXTURE_CYCLE, FIXTURE_VALID, FRAME_CLOCK, FRAME_RUN, FRAME_VALID } from './flow-wire-fixtures';

test.describe('E2-1 flow words', () => {
  /** Every flow sentence: the table's leaves plus each composed line. */
  function flowStrings(): string[] {
    expect(FLOW_WORDS, 'the one table of flow words (src/layers/enso-flow-data.ts)').toBeDefined();
    const out: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === 'string') out.push(value);
      else if (value && typeof value === 'object') for (const v of Object.values(value)) walk(v);
    };
    walk(FLOW_WORDS);
    for (const kind of Object.keys(FLOW_SOURCES) as (keyof typeof FLOW_SOURCES)[]) out.push(flowLiveLine('live', kind, FIXTURE_CYCLE, FIXTURE_VALID), flowLiveLine('live (partial)', kind, FIXTURE_CYCLE, FIXTURE_VALID));
    for (const kind of Object.keys(FLOW_SOURCES) as (keyof typeof FLOW_SOURCES)[]) out.push(flowStaleLine(kind, FIXTURE_CYCLE));
    // The currents frame's own lines: its dated line with its age (the grid boxes read in Technical information).
    out.push(flowLiveLine('live', 'currents', FRAME_RUN, FRAME_VALID, FRAME_CLOCK), flowLiveLine('live (partial)', 'currents', FRAME_RUN, FRAME_VALID, FRAME_VALID));
    return out;
  }

  test('no flow string contains now, right now, currently, real-time, latest or today', () => {
    const strings = flowStrings();
    expect(strings.length).toBeGreaterThan(20);
    for (const s of strings) {
      expect(s, s).not.toMatch(/\bnow\b|\bright now\b|\bcurrently\b|\breal-time\b|\blatest\b|\btoday\b/i);
      expect(s, s).not.toMatch(/\bforecasts?\b|\bwill\b|\bexpected\b|\bpredict/i);
    }
  });

  test("no flow string contains trajectory, carries, drift, where the wind goes, travels to or path of", () => {
    const strings = flowStrings();
    for (const s of strings) {
      expect(s, s).not.toMatch(/\btrajector(?:y|ies)\b|\bcarries\b|\bdrift|where the wind goes|\btravels to\b/i);
    }
    const pathOf = strings.filter((s) => /\bpath of\b/i.test(s));
    // The one negation that holds "path of" left the key for the Impact Briefing, where
    // tests/terrain-coverage.test.mjs holds it to this rule; no panel or key string has the words.
    expect(pathOf).toEqual([]);
  });
});
