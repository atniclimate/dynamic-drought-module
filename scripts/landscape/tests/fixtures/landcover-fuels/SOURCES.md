# SOURCES: land-cover + fuels lane fixtures (T-S1-3)

Captured 2026-07-22 by capture.py in this directory, under the frozen capture budget of S1_LANE_CONTRACT.md revision 13 section 6.3. All requests were foreground and spend()-governed; the counts below are TRUE CUMULATIVE totals across capture invocations (persisted in the cache sidecar).

## Window (contract 6.3, frozen derivation)

- Target polygon: the North Cascades Level III ecoregion (Environmental Protection Agency (EPA) Region 10 unsimplified source, loaded via core.load_ecoregions(3) at capture time; 3 parts).
- Largest part area: 28851134690.6 m2; representative point: (-1854656.586552, 3042738.988750) European Petroleum Survey Group (EPSG) registry code 5070.
- Computed corner: ulx = -1856175.0, uly = 3044265.0 (the frozen floor/ceil formulas).
- 30 m window bounds (EPSG:5070): [-1856175.0, 3041265.0, -1853175.0, 3044265.0] = 100 x 100 analysis cells.
- Wildfire Hazard Potential (WHP) covering window (minimal 270 m-aligned on the SOURCE grid): [-1856385.000000001, 3041144.999999998, -1853145.000000001, 3044384.999999998] = 12 x 12 cells at 270 m.

## Sources, pinned vintages, licenses

### LANDFIRE LF2023 Scott and Burgan 40 Fire Behavior Fuel Models (FBFM40) and Existing Vegetation Type (EVT) (fuels-fbfm40, fuels-evt, fuels-evt-attributes)

- Vintage pin: LANDFIRE release code 240 (LF2023) (contract 3).
- exportImage requests (one per layer, EPSG:5070 in and out, S16, nearest neighbor, materialization-padded size 108,108):
  - https://lfps.usgs.gov/arcgis/rest/services/Landfire_LF2023/LF2023_FBFM40_CONUS/ImageServer/exportImage?bbox=-1856295.0,3041145.0,-1853055.0,3044385.0&bboxSR=5070&imageSR=5070&size=108,108&format=tiff&pixelType=S16&interpolation=RSP_NearestNeighbor&f=image
  - https://lfps.usgs.gov/arcgis/rest/services/Landfire_LF2023/LF2023_EVT_CONUS/ImageServer/exportImage?bbox=-1856295.0,3041145.0,-1853055.0,3044385.0&bboxSR=5070&imageSR=5070&size=108,108&format=tiff&pixelType=S16&interpolation=RSP_NearestNeighbor&f=image
- EVT attribute table attempt: https://lfps.usgs.gov/arcgis/rest/services/Landfire_LF2023/LF2023_EVT_CONUS/ImageServer/rasterAttributeTable?f=pjson. Service metadata declared hasRasterAttributeTable=false and the response was empty, so contract 4.6's dominantName-null path applies.
- License: LANDFIRE data are public domain (United States Geological Survey / United States Forest Service (USFS) / Department of the Interior product).
- Checksum posture: no server checksum published. Content-Length and Last-Modified were not retained for either exportImage response. Per revision 13, this absence is explicit; both fields will be captured at the next budgeted contact with this endpoint during the T-S1-4 full build. Each fixture's locally computed Secure Hash Algorithm 256-bit (SHA-256) remains recorded below.
- fuels-fbfm40 nodata/padding mask before the valid-cell domain assertion: mask values [-9999, 0]; service metadata field 'noDataValue' declared -9999; staging nodata 0. ArcGIS exportImage out-of-extent padding value allowed by S1_LANE_CONTRACT.md 4.3 revision 10.
- fuels-fbfm40 exact metadata-grid assertion: well-known identifier (WKID) 5070; pixel sizes [30, 30]; origin edges [-2362395, 3267405]; lattice distances [0.0, 0.0] m within 1e-06 m: PASS.
- fuels-evt nodata/padding mask before the valid-cell domain assertion: mask values [-9999, 0]; service metadata field 'noDataValue' declared -9999; staging nodata 0. ArcGIS exportImage out-of-extent padding value allowed by S1_LANE_CONTRACT.md 4.3 revision 10.
- fuels-evt exact metadata-grid assertion: well-known identifier (WKID) 5070; pixel sizes [30, 30]; origin edges [-2362395, 3267405]; lattice distances [0.0, 0.0] m within 1e-06 m: PASS.

### Multi-Resolution Land Characteristics (MRLC) Annual National Land Cover Database (NLCD) (landcover-nlcd)

- Vintage pin: TIME=2024-01-01 plus collection 'Annual NLCD Collection 1.1' (contract 3).
- Coverage identifier (verified against GetCapabilities at capture): mrlc_Land-Cover-Native_conus_year_data:Land-Cover-Native_conus_year_data
- GetCoverage request: https://dmsdata.cr.usgs.gov/geoserver/mrlc_Land-Cover-Native_conus_year_data/wcs?service=WCS&version=1.0.0&request=GetCoverage&coverage=mrlc_Land-Cover-Native_conus_year_data:Land-Cover-Native_conus_year_data&crs=EPSG:5070&response_crs=EPSG:5070&bbox=-1856295.0,3041145.0,-1853055.0,3044385.0&time=2024-01-01&width=108&height=108&format=GeoTIFF
- License: public domain (United States Geological Survey).
- Checksum posture: no server checksum. Content-Length and Last-Modified were not retained for the GetCoverage response. Per revision 13, this absence is explicit; both fields will be captured at the next budgeted contact with this endpoint during the T-S1-4 full build. The fixture's locally computed SHA-256 is below.

### United States Forest Service (USFS) Wildfire Hazard Potential (WHP) edition 4 (hazard-whp)

- Vintage pin: edition 4 (2023 classified), Digital Object Identifier (DOI) 10.2737/RDS-2015-0047-4 (REQUIRED citation, contract 3).
- Citation: Dillon, Gregory K.; Gilbertson-Day, Julie W. 2023. Wildfire Hazard Potential for the United States (270-m), version 2023. 4th Edition. Fort Collins, CO: Forest Service Research Data Archive. https://doi.org/10.2737/RDS-2015-0047-4
- Bulk download (one ZIP, cached and RETAINED per contract 3.1 insurance): https://www.fs.usda.gov/rds/archive/products/RDS-2015-0047-4/RDS-2015-0047-4_Data.zip
- Retention record: Content-Length 368424961, Last-Modified 'Tue, 16 Jul 2024 22:10:13 GMT', locally computed SHA-256 7f10f1f8dd97551b8be1458fe0ec924df60b2cea7ece2d1af4c3c1166d1895ab (ZIP retained at scripts/.cache/landcover-fuels/RDS-2015-0047-4_Data.zip).
- License: United States public domain (USFS Research Data Archive).
- Revision 10 lossless dtype staging: uint8 to int16 with integer nodata 255, then an exact float32 materialization view with nodata Not a Number (NaN) for core's masked read. Valid-value identity: PASS for every valid pixel; nodata-mask identity: PASS for every pixel. Core was not edited.

### Revision 10 lossless staging for 30 m categorical sources

Declaring nodata exposes core's integer masked-array NaN fill limitation for all three service rasters. Each cache-only float32 view preserves every valid integer exactly, maps only declared nodata to NaN, and is the source passed to core.materialize_raster. Core was not edited.
- fuels-fbfm40: int16 with nodata 0 to float32 with nodata NaN; valid-value identity PASS for every valid pixel; mask identity PASS for every pixel.
- fuels-evt: int16 with nodata 0 to float32 with nodata NaN; valid-value identity PASS for every valid pixel; mask identity PASS for every pixel.
- landcover-nlcd: uint8 with nodata 250 to float32 with nodata NaN; valid-value identity PASS for every valid pixel; mask identity PASS for every pixel.

## Congruence results

### Contract 2.2 (native 30 m sources, asserted in acquire())

- fuels-fbfm40: Coordinate Reference System (CRS) EPSG:5070; pixel sizes [30.0, -30.0]; observed absolute pixel-size deviations [0.0, 0.0] m (limit 0.0001 m); origin edge offsets from the anchor [636870.0, -265740.0]; observed lattice distances [0.0, 0.0] m (limit 0.02 m): PASS (service-returned transform asserted per contract 2.2 revision 10)
- fuels-evt: Coordinate Reference System (CRS) EPSG:5070; pixel sizes [30.0, -30.0]; observed absolute pixel-size deviations [0.0, 0.0] m (limit 0.0001 m); origin edge offsets from the anchor [636870.0, -265740.0]; observed lattice distances [0.0, 0.0] m (limit 0.02 m): PASS (service-returned transform asserted per contract 2.2 revision 10)
- landcover-nlcd: Coordinate Reference System (CRS) EPSG:5070; pixel sizes [29.9999999620098, -29.9999999624151]; observed absolute pixel-size deviations [3.799020120709429e-08, 3.758490052518937e-08] m (limit 0.0001 m); origin edge offsets from the anchor [636870.0023596806, -265739.9912477345]; observed lattice distances [0.002359680598601699, 0.008752265479415655] m (limit 0.02 m): PASS (service-returned transform asserted per contract 2.2 revision 10)

### Contract 5.3 WHP precondition (congruence-or-stop): PASSED

All four geometric facts were checked at capture on the extracted CONUS raster; MODE materialization is therefore equivalent to the doctrine's nearest-neighbor rule for THIS checked case (every 30 m target cell lies inside exactly one 270 m source cell). No equivalence is claimed beyond it.

1. CRS: EPSG:5070 (EPSG 5070); required EPSG:5070.
2. Rotation/shear terms (b, d): [0.0, 0.0] (required exactly 0).
3. Pixel sizes (a, e): [270.0, -270.0] (required abs 270 within 1e-6 m).
4. Origin edge offsets from the anchor: [130409.99999999907, -42330.00000000186]; lattice distances to the nearest 30 m multiple: [9.313225746154785e-10, 1.862645149230957e-09] (required <= 1e-6 m).

## Observed categorical ranges (contract 4.3 record)

- fuels-fbfm40: observed [98, 187] within the asserted domain [91, 204] (windowed observation only; no claim beyond the asserted data).
- fuels-evt: observed [7038, 9826] within the asserted domain [7008, 9994] (windowed observation only; no claim beyond the asserted data).
- landcover-nlcd: observed [11, 95] within the asserted domain [0, 95] (windowed observation only; no claim beyond the asserted data).
- hazard-whp: observed [2, 7] within the asserted domain [1, 7] (windowed observation only; no claim beyond the asserted data).

## Cumulative request URL ledger

Every unique URL attempted in this capture decision is listed. The first 100 x 100 service windows and first JSON attribute attempt belong to the stopped revision 8 draft; their counts remain binding even though the revision 10 padded requests produced the committed fixtures.

- Environmental Protection Agency ecoregion archive, 1 attempt: https://dmap-prod-oms-edc.s3.us-east-1.amazonaws.com/ORD/Ecoregions/reg10/reg10_eco_l3.zip
- National Land Cover Database GetCapabilities, 2 attempts: https://dmsdata.cr.usgs.gov/geoserver/mrlc_Land-Cover-Native_conus_year_data/wcs?service=WCS&version=1.0.0&request=GetCapabilities
- fuels-fbfm40 service metadata, 1 attempt: https://lfps.usgs.gov/arcgis/rest/services/Landfire_LF2023/LF2023_FBFM40_CONUS/ImageServer?f=json
- fuels-fbfm40 original 100 x 100 exportImage, 1 attempt: https://lfps.usgs.gov/arcgis/rest/services/Landfire_LF2023/LF2023_FBFM40_CONUS/ImageServer/exportImage?bbox=-1856175.0,3041265.0,-1853175.0,3044265.0&bboxSR=5070&imageSR=5070&size=100,100&format=tiff&pixelType=S16&interpolation=RSP_NearestNeighbor&f=image
- fuels-fbfm40 revision 10 padded exportImage, 1 attempt: https://lfps.usgs.gov/arcgis/rest/services/Landfire_LF2023/LF2023_FBFM40_CONUS/ImageServer/exportImage?bbox=-1856295.0,3041145.0,-1853055.0,3044385.0&bboxSR=5070&imageSR=5070&size=108,108&format=tiff&pixelType=S16&interpolation=RSP_NearestNeighbor&f=image
- fuels-evt service metadata, 1 attempt: https://lfps.usgs.gov/arcgis/rest/services/Landfire_LF2023/LF2023_EVT_CONUS/ImageServer?f=json
- fuels-evt original 100 x 100 exportImage, 1 attempt: https://lfps.usgs.gov/arcgis/rest/services/Landfire_LF2023/LF2023_EVT_CONUS/ImageServer/exportImage?bbox=-1856175.0,3041265.0,-1853175.0,3044265.0&bboxSR=5070&imageSR=5070&size=100,100&format=tiff&pixelType=S16&interpolation=RSP_NearestNeighbor&f=image
- fuels-evt revision 10 padded exportImage, 1 attempt: https://lfps.usgs.gov/arcgis/rest/services/Landfire_LF2023/LF2023_EVT_CONUS/ImageServer/exportImage?bbox=-1856295.0,3041145.0,-1853055.0,3044385.0&bboxSR=5070&imageSR=5070&size=108,108&format=tiff&pixelType=S16&interpolation=RSP_NearestNeighbor&f=image
- Existing Vegetation Type attribute operation, 1 original attempt: https://lfps.usgs.gov/arcgis/rest/services/Landfire_LF2023/LF2023_EVT_CONUS/ImageServer/rasterAttributeTable?f=json
- Existing Vegetation Type attribute operation, 1 corrected attempt: https://lfps.usgs.gov/arcgis/rest/services/Landfire_LF2023/LF2023_EVT_CONUS/ImageServer/rasterAttributeTable?f=pjson
- National Land Cover Database original 100 x 100 GetCoverage, 1 attempt: https://dmsdata.cr.usgs.gov/geoserver/mrlc_Land-Cover-Native_conus_year_data/wcs?service=WCS&version=1.0.0&request=GetCoverage&coverage=mrlc_Land-Cover-Native_conus_year_data:Land-Cover-Native_conus_year_data&crs=EPSG:5070&response_crs=EPSG:5070&bbox=-1856175.0,3041265.0,-1853175.0,3044265.0&time=2024-01-01&width=100&height=100&format=GeoTIFF
- National Land Cover Database revision 10 padded GetCoverage, 1 attempt: https://dmsdata.cr.usgs.gov/geoserver/mrlc_Land-Cover-Native_conus_year_data/wcs?service=WCS&version=1.0.0&request=GetCoverage&coverage=mrlc_Land-Cover-Native_conus_year_data:Land-Cover-Native_conus_year_data&crs=EPSG:5070&response_crs=EPSG:5070&bbox=-1856295.0,3041145.0,-1853055.0,3044385.0&time=2024-01-01&width=108&height=108&format=GeoTIFF
- Wildfire Hazard Potential edition-4 archive, 1 attempt: https://www.fs.usda.gov/rds/archive/products/RDS-2015-0047-4/RDS-2015-0047-4_Data.zip

## Fixture provenance and digests

Requests to files: the two exportImage requests produced fbfm40-window.tif and evt-window.tif; the GetCoverage request produced nlcd-window.tif; whp-window.tif was cut locally from the retained edition-4 continental United States (CONUS) raster (no extra request). The unavailable rasterAttributeTable response produced no usable rows, so capture.py wrote the structurally valid empty evt-attributes.json that drives contract 4.6's honest null. expected-landcoverfuels-block.json was generated offline from byte-identical class-array copies of the fixture files on strict exact local transforms through the real acquire + aggregate path (zero spends, asserted).

SHA-256 of every fixture file except SOURCES.md is pinned here and in test_landcover_fuels.py. Revision 13 explicitly excludes SOURCES.md from its own hash table because self-hashing has no stable fixpoint; capture.py is included.

- `capture.py`: `37e9d88c69bf302f62bb9fc4d80554a6dbcd5bf2627e6bd34f514a90e289884d`
- `evt-attributes.json`: `e3566b3a06430868d71e9287dfd6c6c520a3da027aabea01951d407ee131dc2f`
- `evt-window.tif`: `efba073629a6b7650a08ea9f7da63943b881ef48a893e6db99987e185f1ad48c`
- `expected-landcoverfuels-block.json`: `e6dd32ed3f98ca401edd52f1fee08795e56699734c9b0d10aacb69fb741431d1`
- `fbfm40-window.tif`: `d476adb915524ffd4e3071c154a9485d7de859836ab68b5735fb95d0494f7ef4`
- `nlcd-window.tif`: `29f93d74353537b6b38c8c3db2a4fd761a4eb0642b361ee5cc401673571b5483`
- `whp-window.tif`: `ccaeb01fe589d889f1a794da199501ee789531cfa5cf00e44ea39980882938df`

## Cumulative request counts (RequestBudget.counts vs 6.3 ceilings)

- epa-s3: 1 of 4
- lfps-exportimage: 4 of 12
- metadata: 6 of 8
- mrlc-wcs: 2 of 6
- rds-whp-zip: 1 of 2

## dominantName null reasons (contract 4.6 recording home)

The corrected single rasterAttributeTable retry remained unavailable: rasterAttributeTable response missing fields/features; top-level keys: []; service metadata hasRasterAttributeTable=False. The contract 4.6 dominantName-null path is required. Contract 4.6 therefore keeps the EVT sub-block available with dominantName null. This reason is not serialized.
