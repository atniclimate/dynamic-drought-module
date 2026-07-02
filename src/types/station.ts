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

/**
 * A station's USACE CWMS Data API source: the office, the verified
 * timeseries id, and the catalog `like` pattern used for one discovery
 * retry when the id returns 200-with-empty (ids' version suffixes drift;
 * only the catalog confirms which sibling carries data).
 */
export interface CwmsSource {
  readonly office: string;
  readonly tsId: string;
  readonly catalogLike: string;
  /** Display label for the reading, for example 'Forebay'. */
  readonly label: string;
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
  /** USBR Hydromet/AgriMet daily parameters ("SITE PCODE"), primary first. */
  readonly hydrometParams?: readonly string[];
  /** USACE CWMS timeseries source. */
  readonly cwms?: CwmsSource;
  readonly links: ReadonlyArray<TelemetryLink>;
}

/**
 * Per-station per-parameter value freshness (the Tier 2 vocabulary from the
 * ddm-agency-data skill). Distinct from LayerStatus because a station list
 * stays rendered when one parameter fails; see the failure-mode preference
 * in the skill's tier-2 reference.
 *
 *   fresh        retrieved, timestamp within the parameter's refresh window
 *   stale        retrieved, but older than the refresh window
 *   unavailable  fetch failed or the station reports no data for the period
 *   unknown      not yet fetched this session (the render-time default)
 */
export type TelemetryFreshness = 'fresh' | 'stale' | 'unavailable' | 'unknown';

/**
 * Canonical normalized station value handed to sidebar and popup renderers.
 * The Worker and the agencies are pass-through; the consumer that fetched
 * the agency's native shape owns this normalization (ddm-agency-data,
 * "Output-shape contracts").
 */
export interface StationValue {
  /** Matches TELEMETRY_STATIONS[].id. */
  readonly stationId: string;
  /** Canonical parameter key, for example 'snow_water_equivalent_in'. */
  readonly parameter: string;
  /** Human-facing parameter label, for example 'Snow water equivalent'. */
  readonly label: string;
  /** Latest reading; null when the station reports no data for the period. */
  readonly value: number | null;
  readonly unit: string;
  /** ISO 8601 date or datetime of the latest reading. */
  readonly timestamp: string;
  readonly freshness: TelemetryFreshness;
  readonly source:
    | 'nrcs-awdb'
    | 'usace-cwms'
    | 'usace-dataquery'
    | 'usbr-hydromet'
    | 'nwrfc'
    | 'usgs-iv';
}
