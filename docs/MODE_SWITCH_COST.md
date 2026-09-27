# Mode-switch cost report

<!-- GENERATED FILE. Do not edit by hand: this table is produced by scripts/mode-switch-cost-report.mjs from the mode-switch cost spec (tests/mode-switch-cost.spec.ts, run via `npm run measure:mode-switch`); run that to regenerate it. -->

Data reads, tile requests, and time to quiescence (read from `window.__ddm`) for each of the twelve ordered switches among Drought, Heat, Wildfire, and ENSO, at one desktop viewport with stubbed upstreams (DDM-P14-T08).

The regression gate below compares data reads, not the raw request count: almost all of a switch's traffic is raster map tiles, and a tile count depends on viewport timing and on how much of the previous mode's tile streaming was still in flight, not on what the app did differently. Measured evidence: on one unchanged commit, `enso->drought` counted 42 requests on one run and 14 on the next, entirely from tile-timing variance. Data reads and tile requests are both recorded below; only data reads gate.

Each measurement profile has its own section below, and every switch in a profile boots at that profile's region (Washington: `region=washington_state`; CONUS: `region=national`). A profile's candidate is compared only against the same profile's baseline, never across profiles, because the profiles frame different regions.

## Washington profile (`region=washington_state`)

| From | To | Data reads | Tiles | Requests | Time to quiescence (ms) | Candidate data reads | Candidate tiles | Candidate requests | Candidate ms | Delta |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| drought | heat | 3 | 16 | 19 | 3300 | 3 | 9 | 12 | 1806 | 0 |
| drought | wildfire | 11 | 9 | 20 | 528 | 11 | 0 | 11 | 2029 | 0 |
| drought | enso † | 3 | 16 | 19 | 142 | 2 | 32 | 34 | 516 | -1 |
| heat | drought | 1 | 0 | 1 | 1187 | 1 | 0 | 1 | 877 | 0 |
| heat | wildfire | 2 | 0 | 2 | 451 | 2 | 0 | 2 | 3177 | 0 |
| heat | enso † | 1 | 16 | 17 | 131 | 1 | 32 | 33 | 520 | 0 |
| wildfire | drought | 1 | 0 | 1 | 1305 | 1 | 0 | 1 | 1125 | 0 |
| wildfire | heat | 3 | 25 | 28 | 2595 | 3 | 9 | 12 | 1784 | 0 |
| wildfire | enso † | 1 | 16 | 17 | 309 | 1 | 32 | 33 | 682 | 0 |
| enso | drought | 1 | 14 | 15 | 1378 | 1 | 0 | 1 | 929 | 0 |
| enso | heat | 3 | 26 | 29 | 2353 | 3 | 9 | 12 | 1517 | 0 |
| enso | wildfire | 2 | 12 | 14 | 868 | 2 | 0 | 2 | 2723 | 0 |

† `drought->enso`, `heat->enso`, `wildfire->enso`: recorded with no layer pending at the start of the switch, so the boot-idle seam declared quiescence immediately; the recorded time is a lower bound, not a measured settle time. The run records that nothing was pending, not why.

Run `baseline` (commit `0c27ab1`): at this commit the SST anomaly layer reported `'ready'` at activation, before any tile was fetched (src/layers/sst-anomaly.ts:575 at 0c27ab1), which explains its empty `->enso` rows.

Run `baseline`: commit `0c27ab1`, recorded 2026-09-11T23:51:31.897Z, viewport 1280x800, dirty unknown.
Run `candidate`: commit `02d97d7`, recorded 2026-09-27T20:04:15.382Z, viewport 1280x800, dirty 0.

<details>
<summary>Counted data reads per switch (baseline, 0c27ab1)</summary>

- `drought->heat`:
  - https://mapservices.weather.noaa.gov/eventdriven/rest/services/WWA/watch_warn_adv/MapServer/1/query?where=prod_type+IN+%28%27Extreme+Heat+Warning%27%2C%27Exc... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/query?where=category%3D1&outFields=name%2Cidp_validtime&returnGeomet... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer?f=json (1)
- `drought->wildfire`:
  - https://services3.arcgis.com/T4QMspbfLg3qTGWY/ArcGIS/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query (9)
  - https://services2.arcgis.com/C8EMgrsFcRFL6LrL/arcgis/rest/services/NOAA_Satellite_Smoke_Detection_(v1)/FeatureServer/0/query?where=Start+LIKE+%272026254%25%2... (1)
  - https://services3.arcgis.com/T4QMspbfLg3qTGWY/ArcGIS/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query?where=1%3D1&outFields=attr_Inci... (1)
- `drought->enso`:
  - /data/enso-indices.json (2)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/wmts.cgi?SERVICE=WMTS&REQUEST=DescribeDomains&VERSION=1.0.0&LAYER=GHRSST_L4_MUR_Sea_Surface_Temperature_An... (1)
- `heat->drought`:
  - https://www.ncei.noaa.gov/pub/data/nidis/geojson/na/nadm/NADM-current.geojson (1)
- `heat->wildfire`:
  - https://services2.arcgis.com/C8EMgrsFcRFL6LrL/arcgis/rest/services/NOAA_Satellite_Smoke_Detection_(v1)/FeatureServer/0/query?where=Start+LIKE+%272026254%25%2... (1)
  - https://services3.arcgis.com/T4QMspbfLg3qTGWY/ArcGIS/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query?where=1%3D1&outFields=attr_Inci... (1)
- `heat->enso`:
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/wmts.cgi?SERVICE=WMTS&REQUEST=DescribeDomains&VERSION=1.0.0&LAYER=GHRSST_L4_MUR_Sea_Surface_Temperature_An... (1)
- `wildfire->drought`:
  - https://www.ncei.noaa.gov/pub/data/nidis/geojson/na/nadm/NADM-current.geojson (1)
- `wildfire->heat`:
  - https://mapservices.weather.noaa.gov/eventdriven/rest/services/WWA/watch_warn_adv/MapServer/1/query?where=prod_type+IN+%28%27Extreme+Heat+Warning%27%2C%27Exc... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/query?where=category%3D1&outFields=name%2Cidp_validtime&returnGeomet... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer?f=json (1)
- `wildfire->enso`:
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/wmts.cgi?SERVICE=WMTS&REQUEST=DescribeDomains&VERSION=1.0.0&LAYER=GHRSST_L4_MUR_Sea_Surface_Temperature_An... (1)
- `enso->drought`:
  - https://www.ncei.noaa.gov/pub/data/nidis/geojson/na/nadm/NADM-current.geojson (1)
- `enso->heat`:
  - https://mapservices.weather.noaa.gov/eventdriven/rest/services/WWA/watch_warn_adv/MapServer/1/query?where=prod_type+IN+%28%27Extreme+Heat+Warning%27%2C%27Exc... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/query?where=category%3D1&outFields=name%2Cidp_validtime&returnGeomet... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer?f=json (1)
- `enso->wildfire`:
  - https://services2.arcgis.com/C8EMgrsFcRFL6LrL/arcgis/rest/services/NOAA_Satellite_Smoke_Detection_(v1)/FeatureServer/0/query?where=Start+LIKE+%272026254%25%2... (1)
  - https://services3.arcgis.com/T4QMspbfLg3qTGWY/ArcGIS/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query?where=1%3D1&outFields=attr_Inci... (1)

</details>

<details>
<summary>Tile requests per switch (baseline, 0c27ab1)</summary>

- `drought->heat`:
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13149614.849955441,5322463.153553393,-12836528.782... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13149614.849955441,5635549.221409474,-12836528.782... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13149614.849955441,5948635.289265558,-12836528.782... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13149614.849955441,6261721.357121639,-12836528.782... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13462700.917811524,5322463.153553393,-13149614.849... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13462700.917811524,5635549.221409474,-13149614.849... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13462700.917811524,5948635.289265558,-13149614.849... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13462700.917811524,6261721.357121639,-13149614.849... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13775786.985667605,5322463.153553393,-13462700.917... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13775786.985667605,5635549.221409474,-13462700.917... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13775786.985667605,5948635.289265558,-13462700.917... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13775786.985667605,6261721.357121639,-13462700.917... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-14088873.053523686,5322463.153553393,-13775786.985... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-14088873.053523686,5635549.221409474,-13775786.985... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-14088873.053523686,5948635.289265558,-13775786.985... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-14088873.053523686,6261721.357121639,-13775786.985... (1)
- `drought->wildfire`:
  - /data/hillshade-dem-pnw.pmtiles (9)
- `drought->enso`:
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/43/19.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/43/20.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/43/21.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/43/22.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/44/19.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/44/20.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/44/21.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/44/22.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/45/19.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/45/20.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/45/21.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/45/22.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/46/19.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/46/20.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/46/21.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/46/22.png (1)
- `heat->drought`:
  - (no tile requests recorded)
- `heat->wildfire`:
  - (no tile requests recorded)
- `heat->enso`:
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/43/19.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/43/20.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/43/21.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/43/22.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/44/19.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/44/20.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/44/21.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/44/22.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/45/19.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/45/20.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/45/21.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/45/22.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/46/19.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/46/20.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/46/21.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/46/22.png (1)
- `wildfire->drought`:
  - (no tile requests recorded)
- `wildfire->heat`:
  - /data/hillshade-dem-pnw.pmtiles (9)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13149614.849955441,5322463.153553393,-12836528.782... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13149614.849955441,5635549.221409474,-12836528.782... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13149614.849955441,5948635.289265558,-12836528.782... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13149614.849955441,6261721.357121639,-12836528.782... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13462700.917811524,5322463.153553393,-13149614.849... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13462700.917811524,5635549.221409474,-13149614.849... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13462700.917811524,5948635.289265558,-13149614.849... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13462700.917811524,6261721.357121639,-13149614.849... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13775786.985667605,5322463.153553393,-13462700.917... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13775786.985667605,5635549.221409474,-13462700.917... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13775786.985667605,5948635.289265558,-13462700.917... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13775786.985667605,6261721.357121639,-13462700.917... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-14088873.053523686,5322463.153553393,-13775786.985... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-14088873.053523686,5635549.221409474,-13775786.985... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-14088873.053523686,5948635.289265558,-13775786.985... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-14088873.053523686,6261721.357121639,-13775786.985... (1)
- `wildfire->enso`:
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/43/19.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/43/20.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/43/21.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/43/22.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/44/19.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/44/20.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/44/21.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/44/22.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/45/19.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/45/20.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/45/21.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/45/22.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/46/19.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/46/20.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/46/21.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/46/22.png (1)
- `enso->drought`:
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-06/GoogleMapsCompatible_Level7/7/43/19.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-06/GoogleMapsCompatible_Level7/7/43/20.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-06/GoogleMapsCompatible_Level7/7/43/21.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-06/GoogleMapsCompatible_Level7/7/43/22.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-06/GoogleMapsCompatible_Level7/7/44/19.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-06/GoogleMapsCompatible_Level7/7/44/22.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-06/GoogleMapsCompatible_Level7/7/45/19.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-06/GoogleMapsCompatible_Level7/7/45/20.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-06/GoogleMapsCompatible_Level7/7/45/21.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-06/GoogleMapsCompatible_Level7/7/45/22.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-06/GoogleMapsCompatible_Level7/7/46/19.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-06/GoogleMapsCompatible_Level7/7/46/20.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-06/GoogleMapsCompatible_Level7/7/46/21.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-06/GoogleMapsCompatible_Level7/7/46/22.png (1)
- `enso->heat`:
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-06/GoogleMapsCompatible_Level7/7/43/19.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-06/GoogleMapsCompatible_Level7/7/43/22.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-06/GoogleMapsCompatible_Level7/7/44/19.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-06/GoogleMapsCompatible_Level7/7/44/22.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-06/GoogleMapsCompatible_Level7/7/45/19.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-06/GoogleMapsCompatible_Level7/7/45/22.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-06/GoogleMapsCompatible_Level7/7/46/19.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-06/GoogleMapsCompatible_Level7/7/46/20.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-06/GoogleMapsCompatible_Level7/7/46/21.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-06/GoogleMapsCompatible_Level7/7/46/22.png (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13149614.849955441,5322463.153553393,-12836528.782... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13149614.849955441,5635549.221409474,-12836528.782... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13149614.849955441,5948635.289265558,-12836528.782... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13149614.849955441,6261721.357121639,-12836528.782... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13462700.917811524,5322463.153553393,-13149614.849... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13462700.917811524,5635549.221409474,-13149614.849... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13462700.917811524,5948635.289265558,-13149614.849... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13462700.917811524,6261721.357121639,-13149614.849... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13775786.985667605,5322463.153553393,-13462700.917... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13775786.985667605,5635549.221409474,-13462700.917... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13775786.985667605,5948635.289265558,-13462700.917... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13775786.985667605,6261721.357121639,-13462700.917... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-14088873.053523686,5322463.153553393,-13775786.985... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-14088873.053523686,5635549.221409474,-13775786.985... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-14088873.053523686,5948635.289265558,-13775786.985... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-14088873.053523686,6261721.357121639,-13775786.985... (1)
- `enso->wildfire`:
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-06/GoogleMapsCompatible_Level7/7/43/19.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-06/GoogleMapsCompatible_Level7/7/43/20.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-06/GoogleMapsCompatible_Level7/7/43/21.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-06/GoogleMapsCompatible_Level7/7/43/22.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-06/GoogleMapsCompatible_Level7/7/44/19.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-06/GoogleMapsCompatible_Level7/7/44/22.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-06/GoogleMapsCompatible_Level7/7/45/19.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-06/GoogleMapsCompatible_Level7/7/45/22.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-06/GoogleMapsCompatible_Level7/7/46/19.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-06/GoogleMapsCompatible_Level7/7/46/20.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-06/GoogleMapsCompatible_Level7/7/46/21.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-06/GoogleMapsCompatible_Level7/7/46/22.png (1)

</details>

<details>
<summary>Counted data reads per switch (candidate, 02d97d7)</summary>

- `drought->heat`:
  - https://mapservices.weather.noaa.gov/eventdriven/rest/services/WWA/watch_warn_adv/MapServer/1/query?where=prod_type+IN+%28%27Extreme+Heat+Warning%27%2C%27Exc... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/query?where=category%3D1&outFields=name%2Cidp_validtime&returnGeomet... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer?f=json (1)
- `drought->wildfire`:
  - https://services3.arcgis.com/T4QMspbfLg3qTGWY/ArcGIS/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query (9)
  - https://services2.arcgis.com/C8EMgrsFcRFL6LrL/arcgis/rest/services/NOAA_Satellite_Smoke_Detection_(v1)/FeatureServer/0/query?where=Start+LIKE+%272026270%25%2... (1)
  - https://services3.arcgis.com/T4QMspbfLg3qTGWY/ArcGIS/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query?where=1%3D1&outFields=attr_Inci... (1)
- `drought->enso`:
  - /data/enso-indices.json (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/wmts.cgi?SERVICE=WMTS&REQUEST=DescribeDomains&VERSION=1.0.0&LAYER=GHRSST_L4_MUR_Sea_Surface_Temperature_An... (1)
- `heat->drought`:
  - https://www.ncei.noaa.gov/pub/data/nidis/geojson/na/nadm/NADM-current.geojson (1)
- `heat->wildfire`:
  - https://services2.arcgis.com/C8EMgrsFcRFL6LrL/arcgis/rest/services/NOAA_Satellite_Smoke_Detection_(v1)/FeatureServer/0/query?where=Start+LIKE+%272026270%25%2... (1)
  - https://services3.arcgis.com/T4QMspbfLg3qTGWY/ArcGIS/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query?where=1%3D1&outFields=attr_Inci... (1)
- `heat->enso`:
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/wmts.cgi?SERVICE=WMTS&REQUEST=DescribeDomains&VERSION=1.0.0&LAYER=GHRSST_L4_MUR_Sea_Surface_Temperature_An... (1)
- `wildfire->drought`:
  - https://www.ncei.noaa.gov/pub/data/nidis/geojson/na/nadm/NADM-current.geojson (1)
- `wildfire->heat`:
  - https://mapservices.weather.noaa.gov/eventdriven/rest/services/WWA/watch_warn_adv/MapServer/1/query?where=prod_type+IN+%28%27Extreme+Heat+Warning%27%2C%27Exc... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/query?where=category%3D1&outFields=name%2Cidp_validtime&returnGeomet... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer?f=json (1)
- `wildfire->enso`:
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/wmts.cgi?SERVICE=WMTS&REQUEST=DescribeDomains&VERSION=1.0.0&LAYER=GHRSST_L4_MUR_Sea_Surface_Temperature_An... (1)
- `enso->drought`:
  - https://www.ncei.noaa.gov/pub/data/nidis/geojson/na/nadm/NADM-current.geojson (1)
- `enso->heat`:
  - https://mapservices.weather.noaa.gov/eventdriven/rest/services/WWA/watch_warn_adv/MapServer/1/query?where=prod_type+IN+%28%27Extreme+Heat+Warning%27%2C%27Exc... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/query?where=category%3D1&outFields=name%2Cidp_validtime&returnGeomet... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer?f=json (1)
- `enso->wildfire`:
  - https://services2.arcgis.com/C8EMgrsFcRFL6LrL/arcgis/rest/services/NOAA_Satellite_Smoke_Detection_(v1)/FeatureServer/0/query?where=Start+LIKE+%272026270%25%2... (1)
  - https://services3.arcgis.com/T4QMspbfLg3qTGWY/ArcGIS/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query?where=1%3D1&outFields=attr_Inci... (1)

</details>

<details>
<summary>Tile requests per switch (candidate, 02d97d7)</summary>

- `drought->heat`:
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13149614.849955441,5009377.085697312,-12523442.714... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13149614.849955441,5635549.221409474,-12523442.714... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13149614.849955441,6261721.357121639,-12523442.714... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13775786.985667605,5009377.085697312,-13149614.849... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13775786.985667605,5635549.221409474,-13149614.849... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13775786.985667605,6261721.357121639,-13149614.849... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-14401959.12137977,5009377.085697312,-13775786.9856... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-14401959.12137977,5635549.221409474,-13775786.9856... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-14401959.12137977,6261721.357121639,-13775786.9856... (1)
- `drought->wildfire`:
  - (no tile requests recorded)
- `drought->enso`:
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/7/43/19.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/7/43/20.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/7/43/21.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/7/43/22.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/7/44/19.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/7/44/20.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/7/44/21.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/7/44/22.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/7/45/19.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/7/45/20.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/7/45/21.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/7/45/22.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/7/46/19.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/7/46/20.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/7/46/21.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/7/46/22.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/43/19.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/43/20.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/43/21.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/43/22.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/44/19.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/44/20.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/44/21.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/44/22.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/45/19.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/45/20.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/45/21.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/45/22.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/46/19.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/46/20.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/46/21.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/46/22.png (1)
- `heat->drought`:
  - (no tile requests recorded)
- `heat->wildfire`:
  - (no tile requests recorded)
- `heat->enso`:
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/7/43/19.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/7/43/20.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/7/43/21.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/7/43/22.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/7/44/19.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/7/44/20.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/7/44/21.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/7/44/22.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/7/45/19.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/7/45/20.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/7/45/21.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/7/45/22.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/7/46/19.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/7/46/20.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/7/46/21.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/7/46/22.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/43/19.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/43/20.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/43/21.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/43/22.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/44/19.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/44/20.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/44/21.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/44/22.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/45/19.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/45/20.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/45/21.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/45/22.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/46/19.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/46/20.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/46/21.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/46/22.png (1)
- `wildfire->drought`:
  - (no tile requests recorded)
- `wildfire->heat`:
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13149614.849955441,5009377.085697312,-12523442.714... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13149614.849955441,5635549.221409474,-12523442.714... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13149614.849955441,6261721.357121639,-12523442.714... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13775786.985667605,5009377.085697312,-13149614.849... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13775786.985667605,5635549.221409474,-13149614.849... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13775786.985667605,6261721.357121639,-13149614.849... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-14401959.12137977,5009377.085697312,-13775786.9856... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-14401959.12137977,5635549.221409474,-13775786.9856... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-14401959.12137977,6261721.357121639,-13775786.9856... (1)
- `wildfire->enso`:
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/7/43/19.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/7/43/20.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/7/43/21.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/7/43/22.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/7/44/19.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/7/44/20.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/7/44/21.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/7/44/22.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/7/45/19.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/7/45/20.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/7/45/21.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/7/45/22.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/7/46/19.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/7/46/20.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/7/46/21.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/7/46/22.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/43/19.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/43/20.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/43/21.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/43/22.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/44/19.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/44/20.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/44/21.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/44/22.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/45/19.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/45/20.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/45/21.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/45/22.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/46/19.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/46/20.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/46/21.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/7/46/22.png (1)
- `enso->drought`:
  - (no tile requests recorded)
- `enso->heat`:
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13149614.849955441,5009377.085697312,-12523442.714... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13149614.849955441,5635549.221409474,-12523442.714... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13149614.849955441,6261721.357121639,-12523442.714... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13775786.985667605,5009377.085697312,-13149614.849... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13775786.985667605,5635549.221409474,-13149614.849... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-13775786.985667605,6261721.357121639,-13149614.849... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-14401959.12137977,5009377.085697312,-13775786.9856... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-14401959.12137977,5635549.221409474,-13775786.9856... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-14401959.12137977,6261721.357121639,-13775786.9856... (1)
- `enso->wildfire`:
  - (no tile requests recorded)

</details>

Washington profile, `candidate` against `baseline`: no switch's data-read count rose.

## CONUS profile (`region=national`)

| From | To | Data reads | Tiles | Requests | Time to quiescence (ms) |
| --- | --- | --- | --- | --- | --- |
| drought | heat | 3 | 12 | 15 | 1741 |
| drought | wildfire | 11 | 0 | 11 | 3627 |
| drought | enso | 2 | 24 | 26 | 392 |
| heat | drought | 1 | 0 | 1 | 961 |
| heat | wildfire | 2 | 0 | 2 | 4174 |
| heat | enso | 1 | 24 | 25 | 485 |
| wildfire | drought | 1 | 0 | 1 | 822 |
| wildfire | heat | 3 | 12 | 15 | 1733 |
| wildfire | enso | 1 | 24 | 25 | 455 |
| enso | drought | 1 | 0 | 1 | 866 |
| enso | heat | 3 | 12 | 15 | 1728 |
| enso | wildfire | 2 | 0 | 2 | 3880 |

Run `conusBaseline`: commit `02d97d7`, recorded 2026-09-27T20:04:15.382Z, viewport 1280x800, dirty 0.

<details>
<summary>Counted data reads per switch (conusBaseline, 02d97d7)</summary>

- `drought->heat`:
  - https://mapservices.weather.noaa.gov/eventdriven/rest/services/WWA/watch_warn_adv/MapServer/1/query?where=prod_type+IN+%28%27Extreme+Heat+Warning%27%2C%27Exc... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/query?where=category%3D1&outFields=name%2Cidp_validtime&returnGeomet... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer?f=json (1)
- `drought->wildfire`:
  - https://services3.arcgis.com/T4QMspbfLg3qTGWY/ArcGIS/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query (9)
  - https://services2.arcgis.com/C8EMgrsFcRFL6LrL/arcgis/rest/services/NOAA_Satellite_Smoke_Detection_(v1)/FeatureServer/0/query?where=Start+LIKE+%272026270%25%2... (1)
  - https://services3.arcgis.com/T4QMspbfLg3qTGWY/ArcGIS/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query?where=1%3D1&outFields=attr_Inci... (1)
- `drought->enso`:
  - /data/enso-indices.json (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/wmts.cgi?SERVICE=WMTS&REQUEST=DescribeDomains&VERSION=1.0.0&LAYER=GHRSST_L4_MUR_Sea_Surface_Temperature_An... (1)
- `heat->drought`:
  - https://www.ncei.noaa.gov/pub/data/nidis/geojson/na/nadm/NADM-current.geojson (1)
- `heat->wildfire`:
  - https://services2.arcgis.com/C8EMgrsFcRFL6LrL/arcgis/rest/services/NOAA_Satellite_Smoke_Detection_(v1)/FeatureServer/0/query?where=Start+LIKE+%272026270%25%2... (1)
  - https://services3.arcgis.com/T4QMspbfLg3qTGWY/ArcGIS/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query?where=1%3D1&outFields=attr_Inci... (1)
- `heat->enso`:
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/wmts.cgi?SERVICE=WMTS&REQUEST=DescribeDomains&VERSION=1.0.0&LAYER=GHRSST_L4_MUR_Sea_Surface_Temperature_An... (1)
- `wildfire->drought`:
  - https://www.ncei.noaa.gov/pub/data/nidis/geojson/na/nadm/NADM-current.geojson (1)
- `wildfire->heat`:
  - https://mapservices.weather.noaa.gov/eventdriven/rest/services/WWA/watch_warn_adv/MapServer/1/query?where=prod_type+IN+%28%27Extreme+Heat+Warning%27%2C%27Exc... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/query?where=category%3D1&outFields=name%2Cidp_validtime&returnGeomet... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer?f=json (1)
- `wildfire->enso`:
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/wmts.cgi?SERVICE=WMTS&REQUEST=DescribeDomains&VERSION=1.0.0&LAYER=GHRSST_L4_MUR_Sea_Surface_Temperature_An... (1)
- `enso->drought`:
  - https://www.ncei.noaa.gov/pub/data/nidis/geojson/na/nadm/NADM-current.geojson (1)
- `enso->heat`:
  - https://mapservices.weather.noaa.gov/eventdriven/rest/services/WWA/watch_warn_adv/MapServer/1/query?where=prod_type+IN+%28%27Extreme+Heat+Warning%27%2C%27Exc... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/query?where=category%3D1&outFields=name%2Cidp_validtime&returnGeomet... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer?f=json (1)
- `enso->wildfire`:
  - https://services2.arcgis.com/C8EMgrsFcRFL6LrL/arcgis/rest/services/NOAA_Satellite_Smoke_Detection_(v1)/FeatureServer/0/query?where=Start+LIKE+%272026270%25%2... (1)
  - https://services3.arcgis.com/T4QMspbfLg3qTGWY/ArcGIS/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query?where=1%3D1&outFields=attr_Inci... (1)

</details>

<details>
<summary>Tile requests per switch (conusBaseline, 02d97d7)</summary>

- `drought->heat`:
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-10018754.171394622,0,-7514065.628545966,2504688.54... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-10018754.171394622,2504688.542848654,-7514065.6285... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-10018754.171394622,5009377.085697312,-7514065.6285... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-12523442.714243278,0,-10018754.171394622,2504688.5... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-12523442.714243278,2504688.542848654,-10018754.171... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-12523442.714243278,5009377.085697312,-10018754.171... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-15028131.257091932,0,-12523442.714243278,2504688.5... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-15028131.257091932,2504688.542848654,-12523442.714... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-15028131.257091932,5009377.085697312,-12523442.714... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-7514065.628545966,0,-5009377.085697312,2504688.542... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-7514065.628545966,2504688.542848654,-5009377.08569... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-7514065.628545966,5009377.085697312,-5009377.08569... (1)
- `drought->wildfire`:
  - (no tile requests recorded)
- `drought->enso`:
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/4/5/2.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/4/5/3.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/4/5/4.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/4/5/5.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/4/6/2.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/4/6/3.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/4/6/4.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/4/6/5.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/4/7/2.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/4/7/3.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/4/7/4.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/4/7/5.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/4/5/2.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/4/5/3.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/4/5/4.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/4/5/5.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/4/6/2.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/4/6/3.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/4/6/4.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/4/6/5.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/4/7/2.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/4/7/3.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/4/7/4.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/4/7/5.png (1)
- `heat->drought`:
  - (no tile requests recorded)
- `heat->wildfire`:
  - (no tile requests recorded)
- `heat->enso`:
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/4/5/2.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/4/5/3.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/4/5/4.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/4/5/5.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/4/6/2.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/4/6/3.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/4/6/4.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/4/6/5.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/4/7/2.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/4/7/3.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/4/7/4.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/4/7/5.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/4/5/2.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/4/5/3.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/4/5/4.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/4/5/5.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/4/6/2.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/4/6/3.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/4/6/4.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/4/6/5.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/4/7/2.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/4/7/3.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/4/7/4.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/4/7/5.png (1)
- `wildfire->drought`:
  - (no tile requests recorded)
- `wildfire->heat`:
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-10018754.171394622,0,-7514065.628545966,2504688.54... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-10018754.171394622,2504688.542848654,-7514065.6285... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-10018754.171394622,5009377.085697312,-7514065.6285... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-12523442.714243278,0,-10018754.171394622,2504688.5... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-12523442.714243278,2504688.542848654,-10018754.171... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-12523442.714243278,5009377.085697312,-10018754.171... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-15028131.257091932,0,-12523442.714243278,2504688.5... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-15028131.257091932,2504688.542848654,-12523442.714... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-15028131.257091932,5009377.085697312,-12523442.714... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-7514065.628545966,0,-5009377.085697312,2504688.542... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-7514065.628545966,2504688.542848654,-5009377.08569... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-7514065.628545966,5009377.085697312,-5009377.08569... (1)
- `wildfire->enso`:
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/4/5/2.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/4/5/3.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/4/5/4.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/4/5/5.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/4/6/2.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/4/6/3.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/4/6/4.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/4/6/5.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/4/7/2.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/4/7/3.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/4/7/4.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/2026-09-24/GoogleMapsCompatible_Level7/4/7/5.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/4/5/2.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/4/5/3.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/4/5/4.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/4/5/5.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/4/6/2.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/4/6/3.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/4/6/4.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/4/6/5.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/4/7/2.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/4/7/3.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/4/7/4.png (1)
  - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/4/7/5.png (1)
- `enso->drought`:
  - (no tile requests recorded)
- `enso->heat`:
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-10018754.171394622,0,-7514065.628545966,2504688.54... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-10018754.171394622,2504688.542848654,-7514065.6285... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-10018754.171394622,5009377.085697312,-7514065.6285... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-12523442.714243278,0,-10018754.171394622,2504688.5... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-12523442.714243278,2504688.542848654,-10018754.171... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-12523442.714243278,5009377.085697312,-10018754.171... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-15028131.257091932,0,-12523442.714243278,2504688.5... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-15028131.257091932,2504688.542848654,-12523442.714... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-15028131.257091932,5009377.085697312,-12523442.714... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-7514065.628545966,0,-5009377.085697312,2504688.542... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-7514065.628545966,2504688.542848654,-5009377.08569... (1)
  - https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/exportImage?bbox=-7514065.628545966,5009377.085697312,-5009377.08569... (1)
- `enso->wildfire`:
  - (no tile requests recorded)

</details>
