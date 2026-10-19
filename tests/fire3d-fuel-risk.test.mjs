import assert from 'node:assert/strict';
import test from 'node:test';

const { FLAT_FUEL_RISK_KEY, FUEL_RISK_TITLE, fireKeySections, fuelRiskKeepsConsole, fuelRiskSwitch, revealScroll, sceneEntryAppliesRecipe, shouldRevealScroll } =
  await import('../src/ui/fire3d-fuel-risk.ts');

test('Fuel risk on adds its section to the Wildfire key instead of replacing it', () => {
  const keys = (...k) => new Set(k);
  // Wildfire plus Fuel risk: the perimeters stay in the key beside the fuel risk section.
  assert.deepEqual(fireKeySections(keys('nifc-fires', 'hms-smoke', 'usfs-whp')), { fire: true, whp: true });
  assert.deepEqual(fireKeySections(keys('spc-fire-weather', 'nifc-fires', 'usfs-whp')), { fire: true, whp: true });
  // Long Range: the potential layer alone keeps its own key.
  assert.deepEqual(fireKeySections(keys('usfs-whp')), { fire: false, whp: true });
  assert.deepEqual(fireKeySections(keys('spc-fire-weather')), { fire: true, whp: false });
  // The Layer studio's issuer-coloured row keeps the same section, alone or over Wildfire.
  assert.deepEqual(fireKeySections(keys('usfs-whp-classes')), { fire: false, whp: true });
  assert.deepEqual(fireKeySections(keys('nifc-fires', 'usfs-whp-classes')), { fire: true, whp: true });
  // Neither the outlook nor the potential layer: the later surfaces keep their precedence.
  assert.equal(fireKeySections(keys('nifc-fires', 'hms-smoke')), null);
  assert.equal(fireKeySections(keys('usdm', 'nifc-fires')), null);
  // One feature, one name a person can follow from the button to the key and the layer list.
  assert.match(FUEL_RISK_TITLE, /^Fuel risk: .*Wildfire Hazard Potential$/);
});

test('the one Fuel risk switch acts on the 3D drape only while it is mounted, else on the flat fuel-risk layer', () => {
  const base = { sceneActive: false, drapeMounted: false, recipeHasFlat: false };
  // The flat Wildfire map: the switch turns the white fuel-risk layer on.
  assert.equal(fuelRiskSwitch(base), 'flat');
  // Wildfire 3D with its white drape mounted: the switch shows or hides that drape.
  assert.equal(fuelRiskSwitch({ ...base, sceneActive: true, drapeMounted: true }), 'drape');
  // A drape event outlives the scene for a moment; the scene decides.
  assert.equal(fuelRiskSwitch({ ...base, drapeMounted: true }), 'flat');
  // The 3D scene without a drape (archive unavailable, or the flat layer already on): the flat layer.
  assert.equal(fuelRiskSwitch({ ...base, sceneActive: true }), 'flat');
  // Long Range: the committed recipe IS the flat layer, so there is nothing to switch.
  assert.equal(fuelRiskSwitch({ ...base, recipeHasFlat: true }), null);
  // The 3D drape still answers to the switch at Long Range.
  assert.equal(fuelRiskSwitch({ ...base, sceneActive: true, drapeMounted: true, recipeHasFlat: true }), 'drape');
  assert.equal(FLAT_FUEL_RISK_KEY, 'usfs-whp');
});

test('entering 3D re-applies the Wildfire recipe unless the display already is that recipe', () => {
  const base = { cluster: 'wildfire', flatOn: false, recipeHasFlat: false };
  // Wildfire as recipe: nothing to reset.
  assert.equal(sceneEntryAppliesRecipe(base), false);
  // Wildfire plus the optional flat Fuel risk at Current: reset, so the masked 3D drape mounts.
  assert.equal(sceneEntryAppliesRecipe({ ...base, flatOn: true }), true);
  // Long Range: the recipe itself holds the flat layer, so it stays.
  assert.equal(sceneEntryAppliesRecipe({ ...base, flatOn: true, recipeHasFlat: true }), false);
  // A custom display always goes back to the recipe.
  assert.equal(sceneEntryAppliesRecipe({ ...base, cluster: 'custom' }), true);
  assert.equal(sceneEntryAppliesRecipe({ ...base, cluster: 'custom', flatOn: true }), true);
});

test('the Wildfire console stays offered over Wildfire, and nowhere else', () => {
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

test('the block never reveal-scrolls on its first run, so page load leaves the horizon chips in view', () => {
  const quiet = { firstRun: false, sceneRequested: false, fuelRowChanged: false };
  // Page load, with or without a stored 3D choice or a Fuel risk row.
  for (const sceneRequested of [false, true]) {
    for (const fuelRowChanged of [false, true]) {
      assert.equal(shouldRevealScroll({ firstRun: true, sceneRequested, fuelRowChanged }), false);
    }
  }
  // After load: the person turned 3D on, or Fuel risk changed a row.
  assert.equal(shouldRevealScroll({ ...quiet, sceneRequested: true }), true);
  assert.equal(shouldRevealScroll({ ...quiet, fuelRowChanged: true }), true);
  // Without 3D, a block that merely appears or changes status stays where it is.
  assert.equal(shouldRevealScroll(quiet), false);
});
