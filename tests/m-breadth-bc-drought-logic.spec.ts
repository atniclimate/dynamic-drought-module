// Page-free tests moved from tests/m-breadth-bc-drought.spec.ts so they run in the pure lane (npm run verify:pure).

import { expect, test } from './offline-test';
import { readdirSync } from 'node:fs';

test.describe('U7 British Columbia basin drought display', () => {
  test('no British Columbia source geometry is committed under public data', () => {
    const names = readdirSync('public/data');
    expect(names.filter((name) => /(?:british.?columbia|bc-drought)/i.test(name)))
      .toEqual([]);
  });
});
