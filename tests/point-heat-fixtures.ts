// NWS fixtures shared by the page-free cases in heat-h2-point-heat-logic.spec.ts and the
// browser stub in heat-h2-point-heat.spec.ts, so the two cannot drift apart.
import { URLS } from '../src/config/urls';

export const POINT_URL = 'https://api.weather.gov/points/38.5,-97.5';
export const GRID_URL = 'https://api.weather.gov/gridpoints/TOP/31,80';
export const STATIONS_URL =
  'https://api.weather.gov/gridpoints/TOP/31,80/stations';
export const FORECAST_URL =
  'https://api.weather.gov/gridpoints/TOP/31,80/forecast';
export const NEAR_STATION_URL = 'https://api.weather.gov/stations/KNEAR';
export const LATEST_URL = `${NEAR_STATION_URL}/observations/latest`;

export function nwsUpstreamUrl(requestUrl: string): string {
  const request = new URL(requestUrl);
  const worker = new URL(URLS.workerProxy);
  const upstream = request.searchParams.get('url');
  if (
    request.origin !== worker.origin ||
    request.pathname !== '/proxy' ||
    upstream === null ||
    !upstream.startsWith(`${URLS.nwsApi}/`)
  ) {
    throw new Error(`Expected a Worker-wrapped NWS URL, received ${requestUrl}`);
  }
  return upstream;
}

export const POINT_PAYLOAD = {
  properties: {
    forecastGridData: GRID_URL,
    observationStations: STATIONS_URL,
    forecast: FORECAST_URL,
    cwa: 'TOP',
    gridId: 'TOP',
    gridX: 31,
    gridY: 80
  }
};

export const GRID_PAYLOAD = {
  properties: {
    updateTime: '2026-07-29T10:00:00+00:00',
    temperature: {
      uom: 'wmoUnit:degC',
      values: [
        {
          validTime: '2026-07-29T00:00:00+00:00/P2D',
          value: 31
        },
        {
          validTime: '2026-07-30T00:00:00+00:00/PT1H',
          value: null
        }
      ]
    },
    apparentTemperature: {
      uom: 'wmoUnit:degC',
      values: [
        {
          validTime: '2026-07-30T12:00:00+00:00/PT3H',
          value: 34
        }
      ]
    },
    heatIndex: {
      uom: 'wmoUnit:degC',
      values: [
        {
          validTime: '2026-07-30T12:00:00+00:00/PT3H',
          value: 36
        }
      ]
    },
    wetBulbGlobeTemperature: {
      uom: 'wmoUnit:degC',
      values: []
    }
  }
};

export const STATIONS_PAYLOAD = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-100, 40] },
      properties: {
        stationIdentifier: 'KFAR',
        name: 'Far Station',
        '@id': 'https://api.weather.gov/stations/KFAR'
      }
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-97.49, 38.51] },
      properties: {
        stationIdentifier: 'KNEAR',
        name: 'Near Station',
        '@id': NEAR_STATION_URL
      }
    }
  ]
};

export const OBSERVATION_PAYLOAD = {
  properties: {
    timestamp: '2026-07-29T12:05:00+00:00',
    temperature: { unitCode: 'wmoUnit:degC', value: 32 },
    relativeHumidity: { unitCode: 'wmoUnit:percent', value: 48 },
    heatIndex: { unitCode: 'wmoUnit:degC', value: 35 }
  }
};

export const FORECAST_PAYLOAD = {
  properties: {
    // Real api.weather.gov gridpoint forecast fields (DDM-P2-T11 M2b): the
    // product's own issue time and each period's own span, so a claim built
    // from this fixture can state a product date rather than only a fetch
    // date.
    updateTime: '2026-07-29T11:00:00+00:00',
    periods: [
      {
        name: 'This Afternoon',
        startTime: '2026-07-29T12:00:00-06:00',
        endTime: '2026-07-29T18:00:00-06:00',
        temperature: 91,
        temperatureUnit: 'F',
        shortForecast: 'Sunny'
      }
    ]
  }
};
