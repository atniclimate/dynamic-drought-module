// The pure narrative selector case of place-studio-brief.spec.ts, moved here because it opens no page and so runs in the pure lane.
import { expect, test } from './offline-test';

import { createBriefingSkeleton } from '../src/impact/briefing';
import { selectBriefNarrativeLine } from '../src/impact/brief-narrative-selector';
import { makeClaim } from '../src/impact/evidence';
import type { BoundarySelectionContext } from '../src/impact/types';

test.describe('PS-BRIEF pure narrative selector', () => {
  test('selects only the first current briefing claim', () => {
    const context: BoundarySelectionContext = {
      kind: 'state',
      title: 'Washington',
      properties: { STUSPS: 'WA' },
      lngLat: { lng: -120.5, lat: 47.5 },
      regionKey: null,
      // Washington's own STUSPS: the honest containing answer for a state
      // boundary's own postal code (see `containingFromProperties`,
      // src/impact/context.ts).
      containing: { state: 'WA', basis: 'feature-property' },
      place: { scheme: 'state', code: 'WA' }
    };
    const briefing = createBriefingSkeleton(context);
    expect(selectBriefNarrativeLine(briefing)).toBeNull();

    briefing.horizons.current.claims = [
      makeClaim({
        text: 'Existing selected-place line.',
        source: 'Existing source',
        // Generic stand-in for an already-settled current-horizon claim, not
        // one real product; `usdm` is the current-horizon lane's own product
        // (DDM-P14-T05 microtask 2).
        product: 'usdm',
        evidence: 'observed',
        dates: { retrieved: '2026-07-21' }
      }),
      makeClaim({
        text: 'Later current claim.',
        source: 'Existing source',
        product: 'usdm',
        evidence: 'observed',
        dates: { retrieved: '2026-07-21' }
      })
    ];
    expect(selectBriefNarrativeLine(briefing)).toBe(
      'Existing selected-place line.'
    );
  });
});
