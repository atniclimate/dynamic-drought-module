import type { Page } from '@playwright/test';

/**
 * The ONE shared stub for the NOAA CPC Drought Outlook vector service
 * (D1 M6, 2026-09-27; found-005 and found-009): the `drought` layer's two
 * registers, `MapServer/1` (Monthly, the Near Term horizon) and
 * `MapServer/4` (Seasonal, the Long Range horizon), read by
 * src/layers/drought.ts through `fetchJsonWithBudget` from
 * `URLS.cpcDroughtOutlookVectorMapServer`.
 *
 * Each register answers one Persistence polygon over the Pacific Northwest
 * with the same `fcst_date` and a register-specific `target`, the shape the
 * older per-file copies use (tests/s4-shell.spec.ts's `cpcFixture`,
 * tests/temporal-axis.spec.ts's `stubOutlook`), so a stamp can tell the two
 * registers apart. Any other layer index of the same service answers the
 * honest empty collection (a verified `no data` day, never a failure).
 *
 * This is NOT the seasonal TEMPERATURE outlook (`cpc_sea_temp_outlk`), which
 * `tests/helpers.ts`'s `stubCpcSeasonalTempOutlook` answers on every
 * `gotoApp` boot.
 *
 * De-duplicated per page (the `stubCpcSeasonalTempOutlook` pattern): a
 * second call on the same page is a no-op, so a case and a helper can both
 * ask for it without stacking two routes.
 */

/** The `target` field each register's fixture carries. */
export const CPC_OUTLOOK_TARGET = Object.freeze({
  monthly: 'Jul 2026',
  seasonal: 'September 30'
});

/** The `fcst_date` both registers' fixtures carry (`MM/DD/YYYY`). */
export const CPC_OUTLOOK_FCST_DATE = '06/30/2026';

/** The REST service path only: the raster `cpcDroughtWMS` entry
 * (`vector/services/.../WMSServer`) is not REST and is never answered here. */
const OUTLOOK_SERVICE_FRAGMENT = 'rest/services/outlooks/cpc_drought_outlk/MapServer/';

/** One Persistence polygon (No_Drought features are dropped by the layer,
 * so a Persistence feature is the smallest body that renders). */
export function cpcOutlookFixture(target: string): unknown {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { outlook: 'Persistence', fcst_date: CPC_OUTLOOK_FCST_DATE, target },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-120, 42],
              [-116, 42],
              [-116, 46],
              [-120, 46],
              [-120, 42]
            ]
          ]
        }
      }
    ]
  };
}

const stubbedPages = new WeakSet<Page>();

/**
 * Answer every CPC Drought Outlook request on this page from the fixtures
 * above. Register it before `gotoApp` (or before the action that first
 * reaches the outlook); Playwright prefers the most recently registered
 * route, so a case that needs a failure arm or a held response for one
 * register registers its own route AFTER this one.
 */
export async function stubCpcDroughtOutlook(page: Page): Promise<void> {
  if (stubbedPages.has(page)) return;
  stubbedPages.add(page);
  await page.route(
    (url) => url.href.includes(OUTLOOK_SERVICE_FRAGMENT),
    (route) => {
      const href = route.request().url();
      const body = href.includes(`${OUTLOOK_SERVICE_FRAGMENT}1/`)
        ? cpcOutlookFixture(CPC_OUTLOOK_TARGET.monthly)
        : href.includes(`${OUTLOOK_SERVICE_FRAGMENT}4/`)
          ? cpcOutlookFixture(CPC_OUTLOOK_TARGET.seasonal)
          : { type: 'FeatureCollection', features: [] };
      return route.fulfill({
        status: 200,
        contentType: 'application/geo+json',
        body: JSON.stringify(body)
      });
    }
  );
}
