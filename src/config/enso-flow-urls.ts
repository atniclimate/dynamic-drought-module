// ENSO optional direction samples, verified 2026-09-13: anonymous JSON,
// HTTP 200 and wildcard CORS at both exact /v1 paths. Open-Meteo is an
// open-source intermediary; CC-BY 4.0 data. Its free hosted API permits
// nonprofit/educational, noncommercial use only, below 10,000 calls/day,
// 5,000/hour, 600/minute. Commercial embeddings need another deployment.
// Each location counts towards the quota, even in one batched request.
// Runtime requests at most 40 fixed grid samples on explicit activation
// or Update area; no automatic polling. No point from selected places or
// Tribal boundaries is sent. Models are pinned by name, valid times are
// read from the response, and land/missing cells remain absent.
// Terms: https://open-meteo.com/en/terms
// Data: https://open-meteo.com/en/docs/marine-weather-api
export const OPEN_METEO_MARINE_URL = 'https://marine-api.open-meteo.com/v1/marine';
export const OPEN_METEO_WEATHER_URL = 'https://api.open-meteo.com/v1/forecast';
