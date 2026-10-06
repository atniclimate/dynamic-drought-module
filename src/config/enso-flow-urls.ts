// ENSO optional ocean-current samples (the DR-161 interim until the RTOFS
// work; ENSO-FLOW-PLAN owner question 4), verified 2026-09-13: anonymous
// JSON, HTTP 200 and wildcard CORS at the exact /v1 path. Open-Meteo is an
// open-source intermediary; CC-BY 4.0 data. Its free hosted API permits
// nonprofit/educational, noncommercial use only, below 10,000 calls/day,
// 5,000/hour, 600/minute. Commercial embeddings need another deployment.
// Each location counts towards the quota, even in one batched request.
// Runtime requests at most 40 fixed grid samples on explicit activation
// or Update area; no automatic polling. No point from selected places or
// Tribal boundaries is sent. The model is pinned by name, valid times are
// read from the response, and land/missing cells remain absent.
// Wind and waves no longer read Open-Meteo: they read NOAA NODD through
// src/layers/flow/ (ENSO-FLOW-PLAN E2-1; DR-115).
// Terms: https://open-meteo.com/en/terms
// Data: https://open-meteo.com/en/docs/marine-weather-api
export const OPEN_METEO_MARINE_URL = 'https://marine-api.open-meteo.com/v1/marine';
