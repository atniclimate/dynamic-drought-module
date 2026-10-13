/**
 * The local calendar day of a Date as ISO 8601 YYYY-MM-DD. The one formatter
 * for claim dates and request dates, so they always agree on the day.
 */
export function isoDayLocal(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}
