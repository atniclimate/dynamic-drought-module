/** Identity only. No source registration, active-state inference or new clocks. */
export interface PerimeterIssuerIdentity {
  readonly id: string;
  recordId(properties: Readonly<Record<string, unknown>>): string | null;
  fireYear(properties: Readonly<Record<string, unknown>>): number | null;
  sourceVersion(properties: Readonly<Record<string, unknown>>): string | null;
}
const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;
const year = (value: unknown): number | null => {
  const raw = typeof value === 'number' ? String(value) : text(value);
  return raw && /^[1-9][0-9]{3}$/.test(raw) ? Number(raw) : null;
};
export const FIRE_PERIMETER_ISSUERS: readonly PerimeterIssuerIdentity[] = [
  {
    id: 'nifc',
    recordId(p) {
      const primary = text(p['attr_UniqueFireIdentifier']);
      if (primary) return encodeURIComponent(primary.toUpperCase());
      const irwin = text(p['attr_IrwinID'])?.replace(/[{}]/g, '').toLowerCase();
      return irwin ? 'irwin:' + encodeURIComponent(irwin) : null;
    },
    fireYear(p) {
      const prefix = text(p['attr_UniqueFireIdentifier'])?.match(/^([1-9][0-9]{3})-/)?.[1];
      if (prefix) return Number(prefix);
      // ArcGIS epoch milliseconds only. Never treat null or an arbitrary string as a date.
      const discovery = p['attr_FireDiscoveryDateTime'];
      if (typeof discovery !== 'number' || !Number.isFinite(discovery)) return null;
      const result = new Date(discovery).getUTCFullYear();
      return Number.isInteger(result) && result >= 1000 && result <= 9999 ? result : null;
    },
    // A perimeter-date field has not been admitted as a stable version clock.
    sourceVersion: () => null
  },
  {
    id: 'bcws',
    recordId(p) {
      const y = year(p['FIRE_YEAR']); const number = text(p['FIRE_NUMBER']);
      return y !== null && number ? y + '-' + encodeURIComponent(number.toUpperCase()) : null;
    },
    // BC catalogue cdfc2d7b-c046-4bf0-90ac-4897232619e1 defines FIRE_YEAR
    // as April-March fiscal identity. It is not a comparable discovery year.
    fireYear: () => null,
    sourceVersion(p) {
      const value = p['VERSION_NUMBER'];
      return typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : text(value);
    }
  }
];
