import assert from 'node:assert/strict';
import test from 'node:test';

const { FLAT_FUEL_RISK_KEY, fuelRiskKeepsConsole, fuelRiskSwitch, revealScroll } =
  await import('../src/ui/fire3d-fuel-risk.ts');

test('the one Fuel risk switch acts on the 3D drape only while it is mounted, else on the flat issuer layer', () => {
  const base = { sceneActive: false, drapeMounted: false, cluster: 'wildfire', flatOn: false };
  // The flat Wildfire map: the switch turns the issuer-coloured layer on.
  assert.equal(fuelRiskSwitch(base), 'flat');
  // Wildfire 3D with its white drape mounted: the switch shows or hides that drape.
  assert.equal(fuelRiskSwitch({ ...base, sceneActive: true, drapeMounted: true }), 'drape');
  // A drape event outlives the scene for a moment; the scene decides.
  assert.equal(fuelRiskSwitch({ ...base, drapeMounted: true }), 'flat');
  // The 3D scene without a drape (archive unavailable, or the flat layer already on): the flat layer.
  assert.equal(fuelRiskSwitch({ ...base, sceneActive: true }), 'flat');
  // The flat switch turned on: the display is custom and the switch reads pressed from the same layer.
  assert.equal(fuelRiskSwitch({ ...base, cluster: 'custom', flatOn: true }), 'flat');
  // Long Range: the committed recipe IS the flat layer, so there is nothing to switch.
  assert.equal(fuelRiskSwitch({ ...base, flatOn: true }), null);
  assert.equal(FLAT_FUEL_RISK_KEY, 'usfs-whp');
});

test('the Wildfire console stays offered on the custom display the flat fuel risk switch makes, and nowhere else', () => {
  assert.equal(fuelRiskKeepsConsole('wildfire', 'wildfire', false), true);
  assert.equal(fuelRiskKeepsConsole('custom', 'wildfire', true), true);
  // Any other customization of Wildfire, or fuel risk reached from another mode, keeps today's answer.
  assert.equal(fuelRiskKeepsConsole('custom', 'wildfire', false), false);
  assert.equal(fuelRiskKeepsConsole('custom', 'drought', true), false);
  assert.equal(fuelRiskKeepsConsole('drought', 'drought', false), false);
});

test('revealing the console scrolls its panel just enough to show the bottom, never past the top', () => {
  const box = { top: 125, bottom: 843 };
  // Already in view: no scroll.
  assert.equal(revealScroll({ top: 300, bottom: 400 }, box), 0);
  // Half below the fold (the owner's screenshot): scroll by the hidden part.
  assert.equal(revealScroll({ top: 812, bottom: 900 }, box), 57);
  // Taller than the panel: the top lands at the panel's top and no further.
  assert.equal(revealScroll({ top: 700, bottom: 1700 }, box), 575);
  // Above the panel's top: this helper never scrolls up.
  assert.equal(revealScroll({ top: 50, bottom: 100 }, box), 0);
});
