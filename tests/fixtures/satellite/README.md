# Recorded NOAA GeoColor answers

Real answers from NOAA NESDIS's merged GOES East and West GeoColor image service
(`MERGEDGC_Last_24hr/ImageServer/exportImage`, 256 px, `format=jpgpng`, `transparent=true`, the frame
pinned by `lockRasterIds` and `time`, exactly as `src/map/satellite.ts` builds them). NOAA imagery is
U.S. public domain. `tests/satellite-guard.test.mjs` reads them; `tests/satellite-fixture.ts` serves
`placeholder-tile.jpg` as the browser stub's placeholder.

| File | What it is | Request |
| --- | --- | --- |
| `placeholder-probe.jpg` | The service's black and white placeholder, answering the app's own probe | the probe box `-12523442.7142433,5009377.08569731,-10018754.1713946,7514065.62854597`, newest frame, 2026-11-11 13:46 Pacific |
| `placeholder-tile.jpg` | The same placeholder answering a zoom 2 tile; its cells are resampled per request, so cell edges are mid-grey | box `-20037508.342789244,0,-10018754.171394622,10018754.171394622`, same time |
| `night-ocean.jpg` | Real night imagery over the open tropical Pacific, mostly near-black grey with a little cloud | zoom 4 tile x 2 y 8, frame `MERGEDGC.10-minute.20261111_1110.color`, fetched 2026-11-12 00:12 UTC |
| `night-convection.jpg` | Real night imagery of deep convection over the tropical Pacific, the real tile nearest the placeholder rule in a 228-tile sample | zoom 6 tile x 7 y 30, the frame nearest 10:00 UTC on 2026-11-11 |
| `day-probe.jpg` | Real day imagery answering the probe box | frame `MERGEDGC.10-minute.20261111_2350.color`, fetched 2026-11-12 00:12 UTC |
