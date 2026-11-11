import { test, expect } from './offline-test';

import { gotoApp, search } from './helpers';

/**
 * Old links: an earlier build wrote a `basemap=` token. The token is no
 * longer read or written. An incoming one is ignored without an error, the
 * canonical URL drops it, and the one OpenStreetMap ground still draws with
 * its credit.
 */

test.describe('U4d: a legacy basemap token in an old link', () => {
  for (const token of ['satellite', 'default', 'bogus']) {
    test(`basemap=${token} is ignored silently and dropped from the canonical URL`, async ({
      page
    }) => {
      const problems: string[] = [];
      page.on('pageerror', (error) => problems.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error' && !/https?:\/\//.test(message.text())) {
          problems.push(message.text());
        }
      });

      await gotoApp(page, `?view=console&basemap=${token}`);
      await expect(page.locator('#map-osm-credit')).toContainText('OpenStreetMap');
      expect(await search(page)).not.toContain('basemap=');
      expect(problems).toEqual([]);
    });
  }
});
