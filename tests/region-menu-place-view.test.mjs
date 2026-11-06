import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

// The region menu's place view (src/ui/sidebar.ts), run from its shipped
// function bodies against a recording map whose moveend order matches
// MapLibre's: the sidebar's own moveend listener (registered at wiring) runs
// before a settle registered later with `once`.
const SIDEBAR = new URL('../src/ui/sidebar.ts', import.meta.url);

function functionBody(source, name) {
  const body = source.match(new RegExp(`^(?:export )?(?:async )?function ${name}\\([\\s\\S]*?^}`, 'm'))?.[0];
  assert.ok(body, `${name} is still a source function with its own closing line`);
  return stripTypeScriptTypes(body.replace(/^export\s+/, ''));
}

function setup() {
  const source = readFileSync(SIDEBAR, 'utf8');
  const names = ['dropPlaceView', 'noteViewLeftRegion', 'dropMovedPlaceView', 'syncRegionSelect'];
  const bodies = names.map((name) => functionBody(source, name)).join('\n');
  class HTMLSelectElement { value = ''; }
  const select = new HTMLSelectElement();
  const later = [];
  const map = {
    camera: 'region:national',
    moving: false,
    isMoving() { return this.moving; },
    once(type, fn) { assert.equal(type, 'moveend'); later.push(fn); },
    getZoom() { return 5; },
    easeTo() { this.moving = true; }
  };
  const dependencies = {
    mapRef: map,
    document: { getElementById: (id) => (id === 'region-select' ? select : null) },
    HTMLSelectElement,
    STATE: { currentRegion: 'national' },
    DEFAULT_REGION: 'national',
    getOceanFraming: () => null,
    getFraming: () => null,
    committedCameraTarget: () => 'region:national',
    cameraMatchesTarget: (m, target) => m.camera === target,
    readCameraState: (m) => m.camera,
    cameraStateUnchanged: (m, state) => m.camera === state
  };
  const fns = new Function(
    ...Object.keys(dependencies),
    `let placeView = null;\nlet placeViewGen = 0;\n${bodies}\nreturn { noteViewLeftRegion, dropMovedPlaceView };`
  )(...Object.values(dependencies));
  const moveend = () => {
    map.moving = false;
    fns.dropMovedPlaceView(map);
    for (const fn of later.splice(0)) fn();
  };
  return {
    select,
    map,
    noteViewLeftRegion: () => fns.noteViewLeftRegion(map),
    land(camera) {
      map.camera = camera;
      moveend();
    },
    // A search result: the fit starts, then the place is set, then the flight lands.
    search(camera) {
      map.moving = true;
      fns.noteViewLeftRegion(map);
      map.camera = camera;
      moveend();
    },
    pan(camera) {
      map.camera = camera;
      moveend();
    }
  };
}

test('every consecutive place search leaves the menu on Selected place, not every second one', () => {
  const h = setup();
  for (const place of ['state:CO', 'state:AK', 'state:OR', 'state:TX']) {
    h.search(place);
    assert.equal(h.select.value, 'view:place', place);
  }
});

test('a hand pan off the place, or a search that lands on the committed view, names the region', () => {
  const h = setup();
  h.search('state:CO');
  assert.equal(h.select.value, 'view:place');
  h.pan('somewhere else');
  assert.equal(h.select.value, 'region:national');
  h.search('state:AK');
  assert.equal(h.select.value, 'view:place');
  h.search('region:national');
  assert.equal(h.select.value, 'region:national');
});

// Audit round 4: a city sets no place, so only the console catalog's own
// wrapper told the menu; the Brief head and the phone sheet left it on the old
// region. selectResult, which every host shares, now announces the city view.
test('a city chosen from any search host leaves the menu on Selected place', () => {
  const h = setup();
  const sidebar = readFileSync(SIDEBAR, 'utf8');
  assert.ok(
    sidebar.includes("window.addEventListener('ddm:city-view', () => noteViewLeftRegion(map));"),
    'the sidebar answers the city view'
  );
  const controller = readFileSync(new URL('../src/ui/search-controller.ts', import.meta.url), 'utf8');
  const deps = {
    window: { dispatchEvent: (event) => { if (event.type === 'ddm:city-view') h.noteViewLeftRegion(); } },
    nextBriefingIntent: () => 0,
    setPlaceSelection: () => {},
    cityCoords: new Map([['seattle', [-122.33, 47.61]]])
  };
  const selectResult = new Function(
    ...Object.keys(deps),
    `let locateAbort = null;\n${functionBody(controller, 'selectResult')}\nreturn selectResult;`
  )(...Object.values(deps));
  selectResult(h.map, { kind: 'city', id: 'seattle', label: 'Seattle' });
  h.land('city:seattle');
  assert.equal(h.select.value, 'view:place');
});
