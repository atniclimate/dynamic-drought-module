/**
 * Telemetry station: a marker on the map representing a real agency
 * monitoring station. Most stations expose either a `usgsSite` (live data
 * via USGS Water Services Instantaneous Values API) or an `awdbStation`
 * (NRCS Snow Telemetry); some have neither and surface only deep links to
 * the agency portal.
 *
 * Coordinates are `[latitude, longitude]` to match the bounding-box convention
 * from the vanilla baseline; conversion to MapLibre's `[lng, lat]` happens at
 * the boundary in src/layers/telemetry.ts.
 */
export interface TelemetryLink {
  readonly label: string;
  readonly url: string;
}

export interface TelemetryStation {
  readonly id: string;
  readonly name: string;
  readonly coords: readonly [number, number];
  readonly region: string;
  readonly type: string;
  readonly agency: string;
  readonly color: string;
  readonly description: string;
  readonly awdbStation?: string;
  readonly usgsSite?: string;
  readonly links: ReadonlyArray<TelemetryLink>;
}
