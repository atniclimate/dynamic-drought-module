/**
 * Human-facing formatting for NWS point-heat values (owner decision
 * 2026-08-31: US-customary-led display, metric secondary).
 *
 * NWS grid and observation payloads carry temperatures as unrounded doubles
 * (typically a whole-degree Fahrenheit product the issuer converted to
 * Celsius), so a value like 22.77777777777778 is a conversion artifact, not
 * measured precision. Rounding to whole degrees removes false precision; it
 * never broadens the issuer's claim. Callers that build markup keep the raw
 * issuer value, unit code, and untouched ISO 8601 validity interval available
 * for datetime and title attributes, so the machine-readable truth stays one
 * hover or inspect away.
 *
 * Every formatter here is pure and DOM-free so the impact panel runtime, the
 * brief narrative selector, and the heat synthesis can share one composition.
 */

interface TimeFormatOptions {
  /**
   * IANA time zone for rendering. Defaults to the environment's zone (the
   * browser at runtime). Tests pass an explicit zone for determinism.
   */
  readonly timeZone?: string;
}

/** "90 °F (32 °C)" for temperatures; "48%" for percents; rounded otherwise. */
export function formatPointHeatValue(value: number, unitCode: string): string {
  const unit = unitCode.split(':').at(-1) ?? unitCode;
  if (unit === 'degC') {
    const fahrenheit = Math.round((value * 9) / 5 + 32);
    return `${fahrenheit} °F (${Math.round(value)} °C)`;
  }
  if (unit === 'degF') {
    const celsius = Math.round(((value - 32) * 5) / 9);
    return `${Math.round(value)} °F (${celsius} °C)`;
  }
  if (unit === 'percent') {
    return `${Math.round(value)}%`;
  }
  const rounded = Math.round(value * 10) / 10;
  return `${rounded} ${unit}`;
}

/** "3.0 mi (4.9 km)" from a kilometre distance. */
export function formatDistanceKm(distanceKm: number): string {
  const miles = distanceKm * 0.621371;
  return `${miles.toFixed(1)} mi (${distanceKm.toFixed(1)} km)`;
}

/**
 * Newer ICU builds separate "1:57" and "PM" with U+202F (narrow no-break
 * space), and which build renders varies by browser and Node version.
 * Normalize to a plain space so the interface and its tests read one way
 * everywhere.
 */
function plainSpaces(text: string): string {
  return text.replace(/[\u202f\u2009]/g, ' ');
}

function dateFormatter(timeZone?: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    ...(timeZone ? { timeZone } : {})
  });
}

function timeFormatter(
  timeZone: string | undefined,
  withZone: boolean
): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    ...(withZone ? { timeZoneName: 'short' } : {}),
    ...(timeZone ? { timeZone } : {})
  });
}

/** "Jul 30, 5:00 AM PDT" from an ISO timestamp; the input echoes back unchanged when unparsable. */
export function formatPointHeatTimestamp(
  iso: string,
  options: TimeFormatOptions = {}
): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  const date = new Date(parsed);
  const day = dateFormatter(options.timeZone).format(date);
  const time = timeFormatter(options.timeZone, true).format(date);
  return plainSpaces(`${day}, ${time}`);
}

/**
 * "Jul 30, 5:00 AM to 8:00 AM PDT" for a same-day interval,
 * "Jul 30, 11:00 PM to Jul 31, 2:00 AM PDT" across days, and
 * "from Jul 30, 5:00 AM PDT" when the issuer gave no end. Unparsable input
 * echoes back unchanged rather than inventing a reading.
 */
export function formatPointHeatInterval(
  startTime: string,
  endTime: string | undefined,
  options: TimeFormatOptions = {}
): string {
  const startParsed = Date.parse(startTime);
  if (!Number.isFinite(startParsed)) return startTime;
  const start = new Date(startParsed);
  const day = dateFormatter(options.timeZone);
  const bare = timeFormatter(options.timeZone, false);
  const zoned = timeFormatter(options.timeZone, true);
  const endParsed = endTime === undefined ? NaN : Date.parse(endTime);
  if (!Number.isFinite(endParsed)) {
    return plainSpaces(`from ${day.format(start)}, ${zoned.format(start)}`);
  }
  const end = new Date(endParsed);
  const sameDay = day.format(start) === day.format(end);
  const endLabel = sameDay
    ? zoned.format(end)
    : `${day.format(end)}, ${zoned.format(end)}`;
  return plainSpaces(`${day.format(start)}, ${bare.format(start)} to ${endLabel}`);
}
