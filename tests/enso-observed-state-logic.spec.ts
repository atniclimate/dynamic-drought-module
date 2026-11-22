// Page-free tests moved from tests/enso-observed-state.spec.ts so they run in the pure lane (npm run verify:pure).

import { test, expect } from './offline-test';
import { readSnapshot } from './enso-snapshot-fixture';

/**
 * Observed-state El Nino / Southern Oscillation (ENSO) repair
 * (0.8.0 U-ENSO-REPAIR). Assertions are structural: current phases and values
 * deliberately remain unpinned because the committed snapshot refreshes.
 */
test.describe('ENSO observed-state repair', () => {
  test('bundled snapshot carries four sourced series and bounded preliminary flags', () => {
    const snapshot = readSnapshot();

    expect(snapshot.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const sources = [
      ['roni', snapshot.roni],
      ['oni', snapshot.oni],
      ['nino34', snapshot.nino34],
      ['soi', snapshot.soi]
    ] as const;
    for (const [key, series] of sources) {
      expect(series, `${key} series must be present`).toBeTruthy();
      expect(series.published).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(series.sourceUrl).toMatch(/^https:\/\/www\.cpc\.ncep\.noaa\.gov\//);
      expect(series.values.length).toBeGreaterThan(0);
    }

    for (const series of [snapshot.roni, snapshot.oni]) {
      const values = series.values;
      expect(values.slice(-2).every((point) => point.preliminary === true)).toBe(true);
      expect(values.slice(0, -2).every((point) => point.preliminary === false)).toBe(true);
    }
    expect(snapshot.nino34.latest.preliminary).toBeUndefined();
    expect(snapshot.soi.block).toBe('standardized');
    expect(JSON.stringify(snapshot.soi)).not.toContain('-999.9');
    expect(snapshot.probabilities).toBeUndefined();
  });

  /**
   * ENSOSCI-01. CPC publishes two rules that answer different questions: the
   * onset rule on the newest three-month season (current conditions) and the
   * five-consecutive-overlapping-season rule that classifies a historical
   * episode. The builder emitted only the second and the headline reported
   * it in the present tense, so the application said "ENSO is currently
   * neutral" through a standing NOAA El Nino Advisory. The snapshot now
   * carries both, plus the derived `emerging` label and the CPC pages that
   * define each rule.
   */
  test('the bundled snapshot separates current conditions from the historical episode rule', () => {
    const snapshot = readSnapshot();
    const phases = ['el-nino', 'la-nina', 'neutral'];

    for (const [key, series] of [
      ['roni', snapshot.roni],
      ['oni', snapshot.oni]
    ] as const) {
      const state = series.state;
      expect(state, `${key} must carry a state block`).toBeTruthy();
      if (!state) continue;
      expect(phases).toContain(state.conditions);
      expect(phases).toContain(state.episode);
      expect(['strengthening', 'weakening', 'steady']).toContain(state.direction);
      // The legacy key stays an alias of the historical rule, so an older
      // consumer keeps loading and cannot silently gain a new meaning.
      expect(series.phase).toBe(state.episode);
      // `emerging` is derived, never a fourth state word.
      expect(state.emerging).toBe(state.conditions !== 'neutral' && state.episode === 'neutral');
      // Conditions follow CPC's onset rule on the newest season alone.
      const anom = series.latest.anom as number;
      const expected =
        anom >= state.threshold ? 'el-nino' : anom <= -state.threshold ? 'la-nina' : 'neutral';
      expect(state.conditions).toBe(expected);
      expect(state.conditionsRule).toMatch(/^https:\/\/www\.cpc\.ncep\.noaa\.gov\//);
      expect(state.episodeRule).toMatch(/^https:\/\/www\.cpc\.ncep\.noaa\.gov\//);
    }

    // The verbatim CPC definitions travel with the artifact, each with the
    // page it was read from, so the file states the rules it was built under.
    expect(snapshot.sourceQuotes?.length ?? 0).toBeGreaterThan(0);
    for (const quote of snapshot.sourceQuotes ?? []) {
      expect(quote.text.length).toBeGreaterThan(0);
      expect(quote.url).toMatch(/^https:\/\//);
    }
  });
});
