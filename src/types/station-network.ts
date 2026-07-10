import type { StationValue, TelemetryStation } from './station';

export type StationNetworkKey = Extract<
  StationValue['source'],
  | 'usgs-iv'
  | 'nrcs-awdb'
  | 'usace-cwms'
  | 'usbr-hydromet'
  | 'raws'
  | 'noaa-coops'
  | 'usbr-agrimet'
  | 'cocorahs'
  | 'nwrfc'
>;

export type PrimaryParameterCategory =
  | 'streamflow'
  | 'stage'
  | 'snowpack'
  | 'precipitation'
  | 'soil-climate'
  | 'fire-weather'
  | 'reservoir-storage'
  | 'evapotranspiration'
  | 'temperature'
  | 'forecast'
  | 'unknown';

export interface StationNetworkHandles {
  readonly usgsSite?: string;
  readonly awdbStation?: string;
  readonly cwmsOffice?: string;
  readonly cwmsTsId?: string;
  readonly hydrometSite?: string;
  readonly rawsStationId?: string;
  readonly noaaCoopsId?: string;
  readonly agrimetSite?: string;
  readonly cocorahsSid?: string;
  readonly nwrfcId?: string;
}

export interface StationDiscoveryRecord {
  readonly network: StationNetworkKey;
  readonly station: TelemetryStation;
  readonly value: StationValue;
  readonly primaryParameterCategory: PrimaryParameterCategory;
  readonly handles: StationNetworkHandles;
}

export interface StationNetworkAdapter<TRawRecord = unknown> {
  readonly toDiscoveryRecord: (rawRecord: TRawRecord) => StationDiscoveryRecord | null;
}

export interface StationNetwork<TRawRecord = unknown> {
  readonly key: StationNetworkKey;
  readonly label: string;
  readonly refreshWindowMs: number;
  /** Honest human update cadence for this network, surfaced in the popup
   * custody block ("Updates: about every 6 minutes"). Distinct from
   * refreshWindowMs, which is the staleness window for the freshness pill. */
  readonly cadence: string;
  readonly adapter: StationNetworkAdapter<TRawRecord>;
}

export interface StationRegistryEntry {
  readonly station: TelemetryStation;
  readonly values: readonly StationValue[];
  readonly primaryParameterCategory: PrimaryParameterCategory;
  readonly handles: StationNetworkHandles;
  readonly networks: readonly StationNetworkKey[];
  readonly isCuratedSeed: boolean;
}

export interface ViewportBounds {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

export interface StationViewportDiscoveryRequest {
  readonly bounds: ViewportBounds;
  readonly center: readonly [number, number];
  readonly signal: AbortSignal | null;
}

export type StationViewportDiscoveryResult =
  | {
      readonly status: 'ok';
      readonly records: readonly StationDiscoveryRecord[];
      readonly queriedBounds: ViewportBounds;
      /** Labels of discovery sources that failed non-abort (0.7.0 H4); any
       * failure makes the telemetry pill read `degraded` ("live (partial)"),
       * never a bare `live` and never a structural `error` (the curated
       * seeds still render and the layer stays active). */
      readonly failedSources: readonly string[];
    }
  | {
      /** The viewport is wider than the discovery area cap (D-0.7.0-007):
       * no discovery queries were fired; the layer reads "zoom in to load". */
      readonly status: 'zoom-in';
      readonly records: readonly StationDiscoveryRecord[];
    };
