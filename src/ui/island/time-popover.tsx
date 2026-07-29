/**
 * The compact WHEN row and the "More time" popover (S4c; the S4 design
 * record section 3: "the compact/detail TimeBarSpec facade + the 'More
 * time' popover").
 *
 * COMPACT: the shell's WHEN row shows only the register stamp headline
 * (the smallest honest date statement, same doctrine as the embed date
 * chip) plus one "More time" door. DETAIL: the popover renders the full
 * temporal controls (rail, mode chips, jumps, play) FROM the exact
 * TimeBarSpec the owning surface installed, driving the SAME callbacks,
 * so the compact and detail surfaces can never disagree with the layer
 * modules about dates or capabilities. The affordance honesty carries
 * over verbatim: a Play control renders only when the spec declares one
 * (continuous fields), never on authored stepped products.
 *
 * When no surface owns a spec the row says so honestly rather than
 * hiding: "No dated product is displayed."
 *
 * Focus: opening moves focus into the popover (the native popover
 * light-dismiss keeps Escape working); closing restores focus to the
 * "More time" button (the S4c focus-restoration contract).
 */

import { useEffect, useRef } from 'preact/hooks';
import type { ReadonlySignal } from '@preact/signals';

import { getTimeBarSpec } from '../time-bar';
import type { TimeBarSpec } from '../time-bar';
import { wireShellPopover } from './popover-discipline';

export interface TimeCompactProps {
  /** Bumped by the shell on every onTimeBarSpecChange notification. */
  readonly specTick: ReadonlySignal<number>;
}

function DetailControls({ spec }: { spec: TimeBarSpec }) {
  const rail = spec.rail;
  return (
    <div class="shell-time-detail">
      <div class="shell-time-detail-stamp" data-register={spec.stamp.register}>
        <span class="shell-time-detail-headline">{spec.stamp.headline}</span>
        <span class="shell-time-detail-line">{spec.stamp.detail}</span>
      </div>
      {rail && (
        <div class="shell-time-detail-rail">
          <button
            type="button"
            class="time-bar-step"
            aria-label="Previous date"
            disabled={rail.index <= 0}
            onClick={() => {
              const r = getTimeBarSpec()?.rail;
              if (r && r.index > 0) r.onStep(r.index - 1);
            }}
          >
            {'<'}
          </button>
          <input
            type="range"
            class="time-bar-rail"
            min={0}
            max={rail.count - 1}
            step={1}
            value={rail.index}
            aria-label="Date"
            aria-valuetext={rail.valueText(rail.index)}
            onChange={(event) => {
              const v = Number((event.currentTarget as HTMLInputElement).value);
              const r = getTimeBarSpec()?.rail;
              if (r && Number.isInteger(v)) r.onStep(v);
            }}
          />
          <button
            type="button"
            class="time-bar-step"
            aria-label="Next date"
            disabled={rail.index >= rail.count - 1}
            onClick={() => {
              const r = getTimeBarSpec()?.rail;
              if (r && r.index < r.count - 1) r.onStep(r.index + 1);
            }}
          >
            {'>'}
          </button>
        </div>
      )}
      {spec.modes && (
        <div class="shell-time-detail-modes" role="group" aria-label="View mode">
          {spec.modes.options.map((m) => (
            <button
              type="button"
              key={m.key}
              class={`time-bar-mode${m.key === spec.modes?.activeKey ? ' active' : ''}`}
              title={m.title}
              aria-pressed={m.key === spec.modes?.activeKey}
              disabled={m.disabled === true}
              onClick={() => {
                const s = getTimeBarSpec();
                if (s?.modes && m.key !== s.modes.activeKey) s.modes.onSelect(m.key);
              }}
            >
              {m.label}
            </button>
          ))}
        </div>
      )}
      {spec.jumps && (
        <div class="shell-time-detail-jumps">
          {spec.jumps.options.map((j) => (
            <button
              type="button"
              key={j.key}
              class={`time-bar-jump${j.hatched ? ' hatched' : ''}`}
              title={j.title}
              onClick={() => getTimeBarSpec()?.jumps?.onJump(j.key)}
            >
              {j.label}
            </button>
          ))}
        </div>
      )}
      {spec.play && (
        <button
          type="button"
          class="time-bar-play"
          disabled={spec.play.disabled}
          onClick={() => getTimeBarSpec()?.play?.onToggle()}
        >
          {spec.play.playing ? 'Pause' : 'Play'}
        </button>
      )}
    </div>
  );
}

export function TimeCompact({ specTick }: TimeCompactProps) {
  // Reading the signal subscribes this component to spec changes.
  void specTick.value;
  const spec = getTimeBarSpec();
  const moreRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const pop = popRef.current;
    if (!pop) return;
    // The shared popover discipline: focus in on open, restore to the
    // door on close (falling back to the WHEN row itself when the door
    // unmounted with its spec), and consume the light-dismissing pointer
    // gesture so it never clicks through to the map.
    return wireShellPopover(
      pop,
      () => moreRef.current,
      () => document.getElementById('shell-time')
    );
  }, []);

  // The owning surface can clear its spec WHILE the popover is open (a
  // cluster switch deactivates the layer, a terminal failure tears it
  // down). An open detail card over a spec that no longer exists would
  // be a blank claim, and the door it would restore focus to is gone;
  // close it now, so the discipline above restores focus to the row's
  // honest "No dated product is displayed" state instead of dropping it.
  useEffect(() => {
    const pop = popRef.current;
    if (spec === null && pop?.matches(':popover-open')) {
      pop.hidePopover();
    }
  }, [spec]);

  // tabIndex -1 on the row: a programmatic focus target for the
  // discipline's fallback when the More time door unmounts with its spec.
  return (
    <div class="shell-time" id="shell-time" data-has-spec={spec !== null} tabIndex={-1}>
      {spec === null ? (
        <span class="shell-time-empty">No dated product is displayed.</span>
      ) : (
        <>
          <span class="shell-time-headline" data-register={spec.stamp.register}>
            {spec.stamp.headline}
          </span>
          <button
            type="button"
            id="shell-time-more"
            class="shell-popover-door"
            ref={moreRef}
            popovertarget="shell-time-popover"
            title={spec.stamp.detail}
          >
            More time
          </button>
        </>
      )}
      <div
        popover="auto"
        id="shell-time-popover"
        class="shell-popover"
        ref={popRef}
        aria-label="Temporal controls"
      >
        {spec !== null && <DetailControls spec={spec} />}
      </div>
    </div>
  );
}
