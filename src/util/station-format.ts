/**
 * The one number rule for a station reading, shared by the sidebar row and
 * the station popup (head and chart summary), always in en-US so a reading
 * reads the same in every browser locale. Storage rounds to whole acre-feet;
 * discharge keeps USGS's 0.01 cfs so a low creek never reads "0 cfs"; any
 * other parameter prints the value as served.
 */
export function formatStationNumber(value: number | null, parameter?: string): string {
  const fractionDigits =
    parameter === 'reservoir_storage_acft' ? 0 : parameter === 'discharge_cfs' ? 2 : null;
  return fractionDigits === null || value === null
    ? String(value)
    : value.toLocaleString('en-US', { maximumFractionDigits: fractionDigits });
}
