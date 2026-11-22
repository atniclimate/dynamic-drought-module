// The source-level pin of enso-plume-omission.spec.ts, moved here because it opens no page and so runs in the pure lane.
import { test, expect } from './offline-test';
import { execFileSync } from 'node:child_process';

test.describe('ENSO plume omission (indices-only snapshot)', () => {
  test('no scraper identifier survives at source level (anti-scrape pin)', () => {
    // Source-level regression pin (review finding 2): the artifact/UI checks
    // below would not catch a reintroduced scraper whose snapshot was not yet
    // regenerated. Reject the removed identifiers across the live trees.
    const banned = [
      'fetchProbabilities',
      'PROBABILITIES_URL',
      'probabilities-table',
      'analysis_monitoring/enso/roni/probabilities'
    ];
    for (const needle of banned) {
      let out = '';
      try {
        // -l: list matching files; -F: fixed string. Exit 1 = no matches.
        out = execFileSync(
          'git',
          ['grep', '-lF', needle, '--', 'scripts', 'src', 'public',
           ':(exclude)tests/enso-plume-omission.spec.ts'],
          { encoding: 'utf8' }
        );
      } catch {
        // git grep exits non-zero when nothing matches: the desired state.
      }
      expect(out.trim(), `"${needle}" must not reappear in scripts/src/public`).toBe('');
    }
  });
});
