// Page-free tests moved from horizon-chips.spec.ts: they never open a page, so they run in the pure lane.
import { expect, test } from './offline-test';

import { CLAIM_REGISTER_TAG, makeClaim } from '../src/impact/evidence';
import { SHELL_HAZARD_KEY } from '../src/impact/horizon-chrome';
import { HAZARD_KEYS } from '../src/impact/matrix';
import type { EvidenceClass } from '../src/impact/types';
import { renderClaim } from '../src/ui/claim-render';
import { HAZARD_CLUSTER_KEYS } from '../src/config/clusters';

// ---------------------------------------------------------------------------
// DDM-P2-T07: SHELL_HAZARD_KEY is a total bijection, cluster to briefing row
// ---------------------------------------------------------------------------

test.describe('DDM-P2-T07: SHELL_HAZARD_KEY maps every cluster to exactly one briefing row', () => {
  test('every cluster key has a row, and that row is a real HazardKey', () => {
    for (const cluster of HAZARD_CLUSTER_KEYS) {
      const row = SHELL_HAZARD_KEY[cluster];
      expect(row, `cluster "${cluster}" has no row in SHELL_HAZARD_KEY; add one`).not.toBeUndefined();
      expect(
        HAZARD_KEYS.includes(row),
        `SHELL_HAZARD_KEY["${cluster}"] is "${row}", not a member of HAZARD_KEYS`
      ).toBe(true);
    }
  });

  test('every briefing row is the image of exactly one cluster: onto, and no two clusters collide', () => {
    const rows = HAZARD_CLUSTER_KEYS.map((cluster) => SHELL_HAZARD_KEY[cluster]);
    for (const hazard of HAZARD_KEYS) {
      const matches = rows.filter((row) => row === hazard);
      expect(
        matches.length,
        `briefing row "${hazard}" has ${matches.length} clusters mapped to it; it must have exactly one`
      ).toBe(1);
    }
  });

  test('HAZARD_CLUSTER_KEYS and HAZARD_KEYS are the same length', () => {
    expect(
      HAZARD_CLUSTER_KEYS.length,
      'HAZARD_CLUSTER_KEYS and HAZARD_KEYS must be the same length for SHELL_HAZARD_KEY to be a bijection; a cluster has no row'
    ).toBe(HAZARD_KEYS.length);
    expect(
      HAZARD_KEYS.length,
      'HAZARD_CLUSTER_KEYS and HAZARD_KEYS must be the same length for SHELL_HAZARD_KEY to be a bijection; a row has no cluster'
    ).toBe(HAZARD_CLUSTER_KEYS.length);
  });

  test('SHELL_HAZARD_KEY has no keys beyond HAZARD_CLUSTER_KEYS', () => {
    const declaredKeys = Object.keys(SHELL_HAZARD_KEY);
    for (const key of declaredKeys) {
      expect(
        (HAZARD_CLUSTER_KEYS as readonly string[]).includes(key),
        `SHELL_HAZARD_KEY has an extra key "${key}" that is not in HAZARD_CLUSTER_KEYS; remove it`
      ).toBe(true);
    }
  });
});

/** Every evidence class a claim in this app is built with as of this ruling
 * (src/impact/evidence.ts: modeled and modeled-analysis are unused). */
const USED_EVIDENCE: readonly EvidenceClass[] = [
  'observed',
  'analyzed',
  'classified',
  'derived',
  'outlook'
];

function registerTagIn(html: string): string | null {
  const m = html.match(/<span class="impact-claim-register">([^<]*)<\/span>/);
  return m ? m[1]! : null;
}

test.describe('DDM-P8-T03: every rendered claim carries exactly one observed/outlook tag', () => {
  test('R3: the literal ruling, evidence to tag', () => {
    // "evidence 'outlook' renders \"outlook\"; 'analyzed' and 'derived'
    // render \"observed\"." (R3, owner ruling 2026-09-07)
    expect(CLAIM_REGISTER_TAG.outlook).toBe('outlook');
    expect(CLAIM_REGISTER_TAG.analyzed).toBe('observed');
    expect(CLAIM_REGISTER_TAG.derived).toBe('observed');
    // The identity case R3 does not need to spell out, and this session's
    // extension for 'classified' (not named in R3; same 'observation' tone
    // EVIDENCE_PRESENTATION already gives it).
    expect(CLAIM_REGISTER_TAG.observed).toBe('observed');
    expect(CLAIM_REGISTER_TAG.classified).toBe('observed');
  });

  test('every used evidence class renders exactly one register tag, matching the ruling', () => {
    for (const evidence of USED_EVIDENCE) {
      const claim = makeClaim({
        text: `A ${evidence} statement for the register-tag check.`,
        source: 'Test source',
        // Generic stand-in exercising the register-tag mapping across every
        // evidence class, not one lane; `usdm` is an arbitrary valid catalog
        // key (DDM-P14-T05 microtask 2).
        product: 'usdm',
        evidence,
        dates: { retrieved: '2026-09-07' }
      });
      const html = renderClaim(claim);
      const occurrences = html.split('impact-claim-register').length - 1;
      expect(occurrences, `${evidence} claim tag count`).toBe(1);
      expect(registerTagIn(html), `${evidence} claim tag text`).toBe(
        CLAIM_REGISTER_TAG[evidence]
      );
    }
  });

  test('no register tag word contains "forecast"', () => {
    for (const tag of Object.values(CLAIM_REGISTER_TAG)) {
      expect(tag, `register tag "${tag}"`).not.toMatch(/forecast/i);
    }
  });
});
