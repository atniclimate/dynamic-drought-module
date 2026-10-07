import { NWS_ALERT_COLORS } from '../config/palette';
import { WILDFIRE_STATIC_COLOR } from '../config/wildfire-presentation';

/** Decoration only: callers retain their existing warning eligibility rules. */
export function briefingDoorColor(warningLabel: string): string {
  if (warningLabel === 'Mapped wildfire perimeter') return WILDFIRE_STATIC_COLOR;
  return Object.hasOwn(NWS_ALERT_COLORS, warningLabel)
    ? NWS_ALERT_COLORS[warningLabel]!
    : 'var(--ink-strong)';
}
