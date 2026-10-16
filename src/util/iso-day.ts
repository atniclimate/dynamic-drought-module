/**
 * The local calendar day of a Date as ISO 8601 YYYY-MM-DD. The one formatter
 * for claim dates and request dates, so they always agree on the day.
 */
export function isoDayLocal(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * A HeatRisk frame time as "Jul 30, 2026, 12:00 UTC": the one rendering the
 * briefing claim, the map stamp and the sequence panel share.
 */
export function heatRiskMoment(time: number): string {
  // found-104: U+00A0 between the time and its zone word, so the zone never wraps alone.
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
    timeZoneName: 'short'
  }).format(new Date(time))
    .replace(/(\d) (?=[A-Z]{2,5}$)/, '$1 ');
}
