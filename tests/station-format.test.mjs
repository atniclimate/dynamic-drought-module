import assert from 'node:assert/strict';
import test from 'node:test';

const { formatStationNumber } = await import(new URL('../src/util/station-format.ts', import.meta.url).href);

// Audit 7 item 5: one number rule for the sidebar row and the station popup, always en-US.
test('station readings share one en-US number rule', () => {
  assert.equal(formatStationNumber(1250, 'discharge_cfs'), '1,250');
  assert.equal(formatStationNumber(0.014, 'discharge_cfs'), '0.01');
  assert.equal(formatStationNumber(12345.6, 'reservoir_storage_acft'), '12,346');
  assert.equal(formatStationNumber(12.5, 'snow_water_equivalent_in'), '12.5');
  assert.equal(formatStationNumber(3.2), '3.2');
  assert.equal(formatStationNumber(null, 'discharge_cfs'), 'null');
});
