import { test, expect } from '@playwright/test';

import { deriveDisplaySummary } from '../src/state/display-summary';
import type {
  DisplaySummaryInput,
  TimelineSnapshot
} from '../src/types/display-summary';
import type { LayerStatus } from '../src/types/layer';
import { LAYER_DEFS } from '../src/config/layers';
import { STATUS_PILL_TEXT } from '../src/ui/island/pill-text';

/**
 * S3: the pure display-summary derivation (D-0.7.0-041 part 2; the S3
 * handoff section 4). Pure Node assertions in the established
 * s1-substrate / s2-url-migration pattern: the derivation is pure over
 * its input snapshot precisely so the grammar is testable without a
 * browser. (The handoff names Vitest; this repository's one test
 * runner is Playwright, and new dependencies are fenced out, so these
 * ride the same pure-Node describe shape every state module uses.)
 */

const NOW: TimelineSnapshot = {
  usdmWeek: null,
  usdmMode: 'absolute',
  sstDate: null,
  outlookRange: 'seasonal'
};

/** The persistent reference set (default-on, non-surface). */
const REFERENCE_KEYS = LAYER_DEFS.filter(
  (def) => def.defaultOn && def.role !== 'surface'
).map((def) => def.key);
const USDM_NO_DATA_LABEL = LAYER_DEFS.find(
  (def) => def.key === 'usdm'
)?.noDataLabel;
if (!USDM_NO_DATA_LABEL) {
  throw new Error('US Drought Monitor must define its canonical no-data label.');
}

function input(
  keys: readonly string[],
  statuses: Readonly<Record<string, LayerStatus>>,
  overrides: Partial<DisplaySummaryInput> = {}
): DisplaySummaryInput {
  return {
    cluster: 'drought',
    framing: null,
    intendedKeys: new Set(keys),
    statuses: new Map(Object.entries(statuses)),
    timeline: NOW,
    ...overrides
  };
}

/** Every intended key ready. */
function allReady(keys: readonly string[]): Record<string, LayerStatus> {
  const out: Record<string, LayerStatus> = {};
  for (const key of keys) out[key] = 'ready';
  return out;
}

const DROUGHT_KEYS = [...REFERENCE_KEYS, 'usdm'];

test.describe('S3 display summary: the Showing sentence', () => {
  test('everything ready yields one Showing sentence, surface first, and no caveat', () => {
    const summary = deriveDisplaySummary(input(DROUGHT_KEYS, allReady(DROUGHT_KEYS)));
    expect(summary.primary.startsWith('Showing US Drought Monitor with ')).toBe(true);
    expect(summary.primary).toContain('Tribal Lands');
    expect(summary.primary).toContain('Reservation Boundaries');
    expect(summary.primary).toContain('State Boundaries');
    expect(summary.primary.endsWith('.')).toBe(true);
    expect(summary.caveat).toBeNull();
  });

  test('the summary is status-derived, never intent-derived: a non-ready surface never claims Showing', () => {
    for (const status of ['loading', 'error', 'no-data', 'zoom-in'] as const) {
      const summary = deriveDisplaySummary(
        input(DROUGHT_KEYS, { ...allReady(REFERENCE_KEYS), usdm: status })
      );
      expect(summary.primary).not.toContain('US Drought Monitor');
      expect(summary.caveat).not.toBeNull();
    }
  });

  test('an intended key with NO recorded status reads as pending, not displayed', () => {
    const summary = deriveDisplaySummary(input(['usdm'], {}));
    expect(summary.primary).toBe('No layers are displayed yet.');
    expect(summary.caveat).toContain('Loading US Drought Monitor');
  });
});

test.describe('S3 display summary: the six ruled statuses', () => {
  test('ready: included in Showing', () => {
    const summary = deriveDisplaySummary(input(['usdm'], { usdm: 'ready' }));
    expect(summary.primary).toBe('Showing US Drought Monitor.');
    expect(summary.caveat).toBeNull();
  });

  test('degraded: named live with partial coverage in the caveat', () => {
    const summary = deriveDisplaySummary(
      input(DROUGHT_KEYS, { ...allReady(DROUGHT_KEYS), usdm: 'degraded' })
    );
    expect(summary.caveat).toContain('US Drought Monitor is live with partial coverage');
    expect(summary.primary).not.toContain('US Drought Monitor');
  });

  test('loading: excluded from Showing; Loading X caveat', () => {
    const summary = deriveDisplaySummary(
      input(DROUGHT_KEYS, { ...allReady(DROUGHT_KEYS), usdm: 'loading' })
    );
    expect(summary.caveat).toContain('Loading US Drought Monitor');
  });

  test('error: X is unavailable', () => {
    const summary = deriveDisplaySummary(
      input(DROUGHT_KEYS, { ...allReady(DROUGHT_KEYS), usdm: 'error' })
    );
    expect(summary.caveat).toContain('US Drought Monitor is unavailable');
  });

  test('no-data reuses the canonical pill wording: live zero-feature vs deployer placeholder stay distinct', () => {
    // A LIVE viewport-queried layer (usdm carries the live label).
    const live = deriveDisplaySummary(
      input(DROUGHT_KEYS, { ...allReady(DROUGHT_KEYS), usdm: 'no-data' })
    );
    expect(live.caveat).toContain(`US Drought Monitor: ${USDM_NO_DATA_LABEL}`);
    expect(live.caveat).not.toContain('data/README.md');

    // A bundled deployer placeholder keeps the canonical wording.
    const keys = [...DROUGHT_KEYS, 'tribal'];
    const placeholder = deriveDisplaySummary(
      input(keys, { ...allReady(DROUGHT_KEYS), tribal: 'no-data' })
    );
    expect(placeholder.caveat).toContain(
      `Tribal Lands (your own data): ${STATUS_PILL_TEXT['no-data']}`
    );
  });

  test('zoom-in: X appears after you zoom in', () => {
    const keys = [...DROUGHT_KEYS, 'telemetry'];
    const summary = deriveDisplaySummary(
      input(keys, { ...allReady(DROUGHT_KEYS), telemetry: 'zoom-in' })
    );
    expect(summary.caveat).toContain('Monitoring stations appears after you zoom in');
  });

  test('several problems still make ONE caveat string, never a dashboard', () => {
    const summary = deriveDisplaySummary(
      input(DROUGHT_KEYS, {
        ...allReady(REFERENCE_KEYS),
        usdm: 'error',
        hillshade: 'loading'
      })
    );
    expect(summary.caveat).toContain('Loading Terrain Shading');
    expect(summary.caveat).toContain('US Drought Monitor is unavailable');
    // One string, semicolon-joined clauses, one terminal period.
    expect(summary.caveat?.endsWith('.')).toBe(true);
    expect(summary.caveat?.indexOf('.')).toBe((summary.caveat?.length ?? 0) - 1);
  });
});

test.describe('S3 display summary: coverage honesty (the framing caveat)', () => {
  test('Mexico framing over a ready US-scoped surface states the display does not cover Mexico', () => {
    const summary = deriveDisplaySummary(
      input(DROUGHT_KEYS, allReady(DROUGHT_KEYS), { framing: 'mexico' })
    );
    expect(summary.caveat).toContain('The current display layers do not cover Mexico');
  });

  test('a ready status over an out-of-coverage framing never reads as unqualified coverage', () => {
    const summary = deriveDisplaySummary(
      input(DROUGHT_KEYS, allReady(DROUGHT_KEYS), { framing: 'boreal-arctic' })
    );
    expect(summary.caveat).not.toBeNull();
  });

  test('an events-only US-scoped display (wildfire at current) still triggers the Mexico coverage caution', () => {
    // The wildfire 'current' recipe has no condition surface, only the
    // NIFC/HMS event pair; NIFC WFIGS is US-scoped, so the framing
    // caution applies to display LAYERS, not only surfaces.
    const keys = [...REFERENCE_KEYS, 'nifc-fires', 'hms-smoke'];
    const summary = deriveDisplaySummary(
      input(keys, allReady(keys), { cluster: 'wildfire', framing: 'mexico' })
    );
    expect(summary.primary).toContain(
      'Active Wildfires (National Interagency Fire Center, NIFC)'
    );
    expect(summary.caveat).toContain('The current display layers do not cover Mexico');
  });

  test('a substantive second coverage clause survives (Alaska & Northwest); authoring guidance is still dropped', () => {
    const alaska = deriveDisplaySummary(
      input(DROUGHT_KEYS, allReady(DROUGHT_KEYS), { framing: 'alaska-northwest' })
    );
    expect(alaska.caveat).toContain('US display layers cover Alaska variably');
    expect(alaska.caveat).toContain(
      'Yukon and British Columbia are outside US-scoped sources'
    );

    // The guidance tails (naming the shell or the status machinery)
    // never surface to the user.
    const mexico = deriveDisplaySummary(
      input(DROUGHT_KEYS, allReady(DROUGHT_KEYS), { framing: 'mexico' })
    );
    expect(mexico.caveat).not.toContain('the shell');
    const boreal = deriveDisplaySummary(
      input(DROUGHT_KEYS, allReady(DROUGHT_KEYS), { framing: 'boreal-arctic' })
    );
    expect(boreal.caveat).toContain('Mostly outside US-scoped display sources');
    expect(boreal.caveat).not.toContain('per-layer status');
  });

  test('a globally-scoped surface (Ocean Temperature Anomaly) does not trigger the US-coverage caution', () => {
    const keys = [...REFERENCE_KEYS, 'sst-anomaly'];
    const summary = deriveDisplaySummary(
      input(keys, allReady(keys), { cluster: 'enso', framing: 'mexico' })
    );
    expect(summary.primary).toContain('Ocean Temperature Anomaly');
    expect(summary.caveat).toBeNull();
  });

  test('a framing without a coverage note adds no caveat', () => {
    const summary = deriveDisplaySummary(
      input(DROUGHT_KEYS, allReady(DROUGHT_KEYS), { framing: 'arid-west' })
    );
    expect(summary.caveat).toBeNull();
  });
});

test.describe('S3 display summary: the empty recipe and honest labels', () => {
  test('the empty heat/season-ahead recipe yields the honest no-verified-surface primary', () => {
    const summary = deriveDisplaySummary(
      input(REFERENCE_KEYS, allReady(REFERENCE_KEYS), { cluster: 'heat' })
    );
    expect(summary.primary).toBe(
      'No verified Extreme Heat surface is available at this horizon; showing reference layers only.'
    );
  });

  test('honest labels only: never a marine-heatwave or refined multi-source claim, no em dashes', () => {
    const scenarios: DisplaySummaryInput[] = [
      input(DROUGHT_KEYS, allReady(DROUGHT_KEYS)),
      input(DROUGHT_KEYS, allReady(DROUGHT_KEYS), { framing: 'mexico' }),
      input(REFERENCE_KEYS, allReady(REFERENCE_KEYS), { cluster: 'heat' }),
      input([...REFERENCE_KEYS, 'sst-anomaly'], allReady([...REFERENCE_KEYS, 'sst-anomaly']), {
        cluster: 'enso'
      }),
      input(DROUGHT_KEYS, { ...allReady(REFERENCE_KEYS), usdm: 'error', hillshade: 'zoom-in' })
    ];
    for (const scenario of scenarios) {
      const summary = deriveDisplaySummary(scenario);
      for (const text of [summary.primary, summary.caveat ?? '']) {
        expect(text).not.toContain('\u2014');
        expect(text.toLowerCase()).not.toContain('marine heatwave');
        expect(text.toLowerCase()).not.toContain('multi-source');
      }
    }
  });

  test('first-use acronym expansion in prose: CPC, NIFC, and HMS spell out (DG-080 finding 7, r2 finding 5)', () => {
    const droughtOutlook = deriveDisplaySummary(
      input([...REFERENCE_KEYS, 'drought'], allReady([...REFERENCE_KEYS, 'drought']))
    );
    // The parent agency spells out too: a bare "NOAA" would itself be an
    // unexpanded first use in the summary prose.
    expect(droughtOutlook.primary).toContain(
      'Drought Outlook (National Oceanic and Atmospheric Administration Climate Prediction Center, CPC)'
    );
    expect(droughtOutlook.primary).not.toContain('(NOAA Climate');
    const smoke = deriveDisplaySummary(
      input(['hms-smoke'], { 'hms-smoke': 'ready' }, { cluster: 'custom' })
    );
    expect(smoke.primary).toContain('Smoke Plumes (Hazard Mapping System, HMS)');
  });

  test('cluster custom with nothing intended is honest about an empty display', () => {
    const summary = deriveDisplaySummary(input([], {}, { cluster: 'custom' }));
    expect(summary.primary).toBe('No layers are displayed yet.');
    expect(summary.caveat).toBeNull();
  });
});
