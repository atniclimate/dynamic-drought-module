/**
 * The compact WHEN row (S4c; the S4 design record section 3).
 *
 * The shell's WHEN row shows only the pressed horizon and the register
 * stamp headline (the smallest honest date statement, same doctrine as the
 * embed date chip), FROM the exact TimeBarSpec the owning surface installed.
 * The full temporal controls (rail, mode chips, jumps, play) live in the
 * `#time-bar` rail, which Console and mobile keep; Brief states the date
 * and nothing more.
 *
 * When no surface owns a spec the row says so honestly rather than
 * hiding: "No dated product is displayed."
 */

import type { ReadonlySignal } from '@preact/signals';

import type { TemporalHorizonKey } from '../../config/clusters';
import { HORIZON_CHROME, SHELL_HORIZON_KEY } from '../../impact/horizon-chrome';
import { dateTok } from '../../util/text-tokens';
import { getTimeBarSpec } from '../time-bar';
import type { TimeBarStamp } from '../time-bar';

export interface TimeCompactProps {
  /** Bumped by the shell on every onTimeBarSpecChange notification. */
  readonly specTick: ReadonlySignal<number>;
  /**
   * The shell's committed (pressed) horizon chip, from `shell.tsx`'s own
   * snapshot (found-014, DDM-P10-T11): the heading names THIS horizon, in
   * `HORIZON_CHROME`'s words, not the surface's own declared `stamp.horizon`
   * (a HeatRisk day not yet begun answers Near Term even while Current
   * Conditions is pressed, by design, `src/layers/heatrisk.ts`). Naming the
   * pressed chip here keeps chip and card agreeing; the surface's own
   * outlook day still states itself in the headline detail beside it,
   * so nothing honest is lost, only which fact is the HEADING.
   */
  readonly pressedHorizon: TemporalHorizonKey;
}

/**
 * The feed-freshness words (found-015): built locally from the stamp's own
 * `checkedAt` ISO instant with `dateTok` (R5 a, month-name dates) rather
 * than importing `time-bar.ts`'s `freshnessLabel`/`freshnessDate`, whose
 * non-month-name format (`time-bar.ts:104-119`) is `#time-bar`'s (the Brief
 * sidebar bar's) own choice, not owned here.
 */
function freshnessText(stamp: TimeBarStamp): string {
  const freshness = stamp.freshness;
  if (!freshness) return '';
  if (freshness.state === 'current') return 'Current feed check';
  if (freshness.state === 'loading') return 'Checking current conditions';
  const checkedAt = freshness.checkedAt;
  const date = checkedAt && Number.isFinite(Date.parse(checkedAt)) ? dateTok(checkedAt) : null;
  return date ? `Last successful feed check ${date}` : 'Current feed check unavailable';
}

export function TimeCompact({ specTick, pressedHorizon }: TimeCompactProps) {
  // Reading the signal subscribes this component to spec changes.
  void specTick.value;
  const spec = getTimeBarSpec();
  const pressedChrome = HORIZON_CHROME[SHELL_HORIZON_KEY[pressedHorizon]];

  return (
    <div class="shell-time" id="shell-time" data-has-spec={spec !== null}>
      {spec === null ? (
        <span class="shell-time-headline shell-time-empty">No dated product is displayed.</span>
      ) : (
        <span
          class="shell-time-headline"
          data-register={spec.stamp.register}
          // The CSS reserves a fixed two-line box and clamps beyond it
          // only as a defensive backstop (app.css .shell-time-headline);
          // this title carries the full, untruncated text so that backstop
          // can never hide the issuer's date behind an ellipsis with no way
          // to read the rest.
          title={
            spec.stamp.freshness
              ? freshnessText(spec.stamp)
              : `${pressedChrome.title} · ${spec.stamp.headline}`
          }
        >
          {/* found-014: the heading names the PRESSED horizon chip, in
              HORIZON_CHROME's own words, in every mode; the surface's own
              headline/detail (Heat's "Outlook valid ... Day 1 of 7") still
              states what issuer day it shows, right beside it. */}
          <span class="shell-time-headline-horizon">{pressedChrome.title}</span>
          {spec.stamp.freshness ? (
            <span class="feed-current" aria-label={freshnessText(spec.stamp)}>
              <span class="feed-freshness-dot" data-freshness={spec.stamp.freshness.state} aria-hidden="true" />
              {spec.stamp.freshness.state === 'stale' && <span> · {dateTok(spec.stamp.freshness.checkedAt ?? '')}</span>}
              {spec.stamp.freshness.state === 'unavailable' && <span> · Unavailable</span>}
              {spec.stamp.freshness.state === 'loading' && <span class="sr-only">Checking</span>}
            </span>
          ) : (
            <span class="shell-time-headline-detail"> · {spec.stamp.headline}</span>
          )}
        </span>
      )}
    </div>
  );
}
