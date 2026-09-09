/**
 * Synthetic NIFC RAWS FeatureServer fixtures (DDM-P9-T05).
 *
 * The station-registry viewport discovery query and the popup's per-station
 * hydration query (`fetchRawsStationConditions`, src/config/station-registry.ts)
 * both request `RAWS_OUT_FIELDS` and both parse an `f=geojson` response, so
 * ONE fixture shape answers both call sites: a `FeatureCollection` with a
 * single feature placed at Ice Harbor Dam's coordinates (src/config/telemetry.ts,
 * `id: 'ihr'`), inside the viewport `tests/telemetry-raws-gate.spec.ts`
 * already proves triggers RAWS discovery.
 *
 * No real RAWS station identity or reading appears here; every value is a
 * hand-authored, obviously synthetic fixture (hard rule 1 does not reach
 * telemetry stations, but the project convention of never faking a real
 * agency's reading still applies: DDMTEST01 is not a real StationID).
 */

/** Route pattern for the NIFC RAWS FeatureServer (both discovery and hydration). */
export const RAWS_ROUTE = '**/PublicView_RAWS/**';

/** A fixed observation instant, epoch milliseconds, matching the served
 * `ObservedDate` field's Esri date shape. Fixed (not `Date.now()`) so a
 * spec can assert the popup shows THIS time, never the wall clock. */
export const RAWS_FIXTURE_OBSERVED_MS = Date.UTC(2026, 8, 9, 18, 30, 0);

/** The synthetic station's id, as `station-registry.ts` derives
 * `raws-<StationID>` for the marker's `data-telemetry-station-id`. */
export const RAWS_FIXTURE_STATION_ID = 'DDMTEST01';
export const RAWS_FIXTURE_MARKER_ID = `raws-${RAWS_FIXTURE_STATION_ID}`;

/** Ice Harbor Dam's coordinates (src/config/telemetry.ts, `id: 'ihr'`), so a
 * fixture feature here sits inside the viewport the RAWS gate spec already
 * proves triggers discovery. */
const FIXTURE_LATITUDE = 46.2503;
const FIXTURE_LONGITUDE = -118.8783;

interface RawsFixtureFeature {
  readonly type: 'Feature';
  readonly properties: Readonly<Record<string, unknown>>;
  readonly geometry: { readonly type: 'Point'; readonly coordinates: readonly [number, number] };
}

function baseProperties(): Record<string, unknown> {
  return {
    StationName: 'DDM Test RAWS',
    StationID: RAWS_FIXTURE_STATION_ID,
    MesoWestStationID: 'TST01',
    Latitude: FIXTURE_LATITUDE,
    Longitude: FIXTURE_LONGITUDE,
    State: 'WA',
    Agency: 'Synthetic Fixture Agency',
    Status: 'A',
    ObservedDate: RAWS_FIXTURE_OBSERVED_MS
  };
}

function feature(properties: Record<string, unknown>): RawsFixtureFeature {
  return {
    type: 'Feature',
    properties,
    geometry: { type: 'Point', coordinates: [FIXTURE_LONGITUDE, FIXTURE_LATITUDE] }
  };
}

function collection(f: RawsFixtureFeature): unknown {
  return { type: 'FeatureCollection', features: [f] };
}

/** Every condition field served and populated, in the issuer's own served
 * shape (unit text embedded in the string). Verified live 2026-09-09 via
 * the FeatureServer's `?f=pjson`. */
export function rawsHappyBody(): unknown {
  return collection(
    feature({
      ...baseProperties(),
      RelativeHumidity: '21 % ',
      WindSpeedMPH: '5 mph',
      WindDirDegrees: '295 degrees ',
      WindSpeedPeak: '13 mph',
      WindDirPeak: '295 degrees',
      FuelMoisture: '7.3 (unk)'
    })
  );
}

/** Relative humidity and wind served; fuel moisture affirmatively `null`
 * (the live service's own representation of "the station reports no
 * reading for this field", verified live 2026-09-09). */
export function rawsAffirmativeNullBody(): unknown {
  return collection(
    feature({
      ...baseProperties(),
      RelativeHumidity: '94 % ',
      WindSpeedMPH: '0 mph',
      WindDirDegrees: '320 degrees ',
      WindSpeedPeak: '2 mph',
      WindDirPeak: '309 degrees',
      FuelMoisture: null
    })
  );
}

/** DDM-P9-T06: wind affirmatively `null` (both speed and direction), the
 * live service's own representation of "the station reports no wind
 * reading", so the marker draws no glyph and the popup's Wind row reads
 * "Station reported none". Relative humidity and fuel moisture stay real so
 * this fixture proves the null wind is independent of the station's other
 * readings. */
export function rawsNullWindBody(): unknown {
  return collection(
    feature({
      ...baseProperties(),
      RelativeHumidity: '60 % ',
      WindSpeedMPH: null,
      WindDirDegrees: null,
      WindSpeedPeak: null,
      WindDirPeak: null,
      FuelMoisture: '9.1 (unk)'
    })
  );
}

/** DDM-P9-T06 science verdict: a station serving a sustained speed but no
 * sustained direction, with a peak pair (WindSpeedPeak/WindDirPeak). Proves
 * `rawsWindText`'s corrected NWCG wording ("peak ... over the previous 60
 * minutes") and that `windGustDirection` (WindDirPeak), fetched since
 * DDM-P9-T05 but never rendered before this task, now appears beside it. */
export function rawsPeakOnlyWindBody(): unknown {
  return collection(
    feature({
      ...baseProperties(),
      RelativeHumidity: '45 % ',
      WindSpeedMPH: '3 mph',
      WindDirDegrees: null,
      WindSpeedPeak: '11 mph',
      WindDirPeak: '212 degrees',
      FuelMoisture: '6.0 (unk)'
    })
  );
}

/** A malformed body: not JSON, so `response.json()` rejects and the popup's
 * shared catch renders the honest "unavailable" fallback, never "reported
 * none". */
export const RAWS_MALFORMED_BODY = 'not json {';
