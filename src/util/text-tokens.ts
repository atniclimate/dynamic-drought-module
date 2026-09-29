/**
 * Text tokens: small formatters whose output is tied with U+00A0 so the
 * pieces of one token never break across a line (interface-chrome-popups-
 * text.md section 4.2, "Tokens, not luck"). Issuer text is only ever tied
 * here, never reworded; a token formats a date, a quantity, a class or an
 * identifier THIS app already renders, not a copy of an issuer's sentence.
 *
 * M12 adds `dateTok` only (the time door's dates, R5 a: month-name form,
 * `interface-chrome-popups-text.md` section 10). `qtyTok`, `classTok` and
 * `idTok` are M23 to M27's (D1.md section 3: "M23 to M26 consume it, M27
 * extends it").
 *
 * Kept import-free and small: every consumer, eager or lazy, can afford
 * this module without pulling anything else in behind it.
 */

/** One part of a formatted date, read off `Intl.DateTimeFormat`. */
function part(parts: readonly Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((p) => p.type === type)?.value ?? '';
}

/**
 * "Sep 26, 2026, 08:00 UTC": month-name date, 24-hour clock (no AM/PM to
 * disambiguate), the zone always named. `timeZone` is optional; omitted, the
 * runtime's own zone is used and still named (`timeZoneName: 'short'` names
 * whichever zone `Intl` resolves to). Every space in the result is U+00A0,
 * so the whole token is one unbreakable unit (section 4.2: "U+00A0 ties the
 * parts of each token").
 */
export function dateTok(input: number | string | Date, timeZone?: string): string {
  const date = input instanceof Date ? input : new Date(input);
  const options: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short'
  };
  if (timeZone) options.timeZone = timeZone;
  const parts = new Intl.DateTimeFormat('en-US', options).formatToParts(date);
  const text =
    `${part(parts, 'month')} ${part(parts, 'day')}, ${part(parts, 'year')}, ` +
    `${part(parts, 'hour')}:${part(parts, 'minute')} ${part(parts, 'timeZoneName')}`;
  return text.replace(/ /g, ' ');
}
