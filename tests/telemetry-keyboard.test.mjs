import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

// Exercise the shipped function bodies with recording DOM/map dependencies.
// Only the sidebar's dynamic import is replaced by a controllable promise;
// the real browser cases cover MapLibre's event and camera ordering.
function functionBody(path, name) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const body = source.match(new RegExp(`^(?:export )?function ${name}\\([\\s\\S]*?^}`, 'm'))?.[0];
  assert.ok(body, `${name} is still a source function with its own closing line`);
  return stripTypeScriptTypes(body.replace(/^export\s+/, ''));
}

const bindSource = functionBody('../src/layers/telemetry.ts', 'bindPopups');
const flySource = functionBody('../src/layers/telemetry.ts', 'flyToStation');
const listSource = functionBody('../src/ui/sidebar.ts', 'buildTelemetryList')
  .replace("import('../layers/telemetry')", 'loadTelemetry()');

function setup(reducedMotion = false) {
  const adopted = [];
  const openHandlers = [];
  const pendingMoves = [];
  const markerElement = { kind: 'marker' };
  const popup = { on(type, fn) { if (type === 'open') openHandlers.push(fn); } };
  let opens = true;
  const marker = {
    getElement: () => markerElement,
    getPopup: () => popup,
    getLngLat: () => ({ lng: -120, lat: 47 }),
    togglePopup: () => { if (opens) for (const fn of openHandlers) fn(); }
  };
  const markersByStationId = new Map([['fixture', marker]]);
  const document = {
    activeElement: { kind: 'body' },
    createElement: () => ({ handlers: {}, addEventListener(type, fn) { this.handlers[type] = fn; } }),
    getElementById: () => ({ appendChild(item) { document.item = item; } })
  };
  const map = {
    getZoom: () => 8,
    flyTo: () => { if (reducedMotion) for (const fn of pendingMoves.splice(0)) fn(); },
    once(type, fn) { assert.equal(type, 'moveend'); pendingMoves.push(fn); }
  };
  let resolveImport;
  const loading = new Promise((resolve) => { resolveImport = resolve; });
  const dependencies = {
    activeMarkers: [marker], markersByStationId, popupOrigins: new WeakMap(),
    stationByMarker: new WeakMap([[marker, { id: 'fixture' }]]),
    abortControllers: new WeakMap(), document, AbortController,
    adoptExternalResponse: (...args) => { adopted.push(args); return { paint() {} }; },
    buildTelemetryPopupModel: () => ({}), hydrateTelemetryPopup: async () => null,
    prefersReducedMotion: () => reducedMotion, ensureTelemetryActive() {}, escapeHtml: (text) => text,
    loadTelemetry: () => loading
  };
  const functions = new Function(...Object.keys(dependencies), `${bindSource}\n${flySource}\n${listSource}\nreturn { bindPopups, flyToStation, buildTelemetryList };`)(...Object.values(dependencies));
  functions.bindPopups(map);
  return {
    ...functions, adopted, document, map, markerElement, markersByStationId,
    nativeOpen: () => { for (const fn of openHandlers) fn(); },
    moveend: () => { for (const fn of pendingMoves.splice(0)) fn(); },
    closeInstead: () => { opens = false; },
    resolveImport: () => resolveImport({ flyToStation: functions.flyToStation })
  };
}

test('the Water & Snow click retains its exact button across a delayed telemetry import and map movement', async () => {
  const h = setup();
  h.buildTelemetryList(h.map, [{ id: 'fixture', name: 'Fixture', color: '#000', agency: 'Fixture', type: 'fixture', description: 'Fixture' }]);
  const item = h.document.item;
  h.document.activeElement = item;
  item.handlers.click();
  h.document.activeElement = { kind: 'another control while import is pending' };
  h.resolveImport();
  await Promise.resolve();
  h.document.activeElement = { kind: 'another control while camera is moving' };
  h.moveend();
  assert.equal(h.adopted.length, 1);
  assert.ok(h.adopted[0][2] === item, 'the adoption retains the initiating Water & Snow button');
  h.nativeOpen();
  assert.ok(h.adopted[1][2] === h.markerElement, 'a later native open does not inherit the list opener');
});

test('a list toggle that only closes the popup does not leak its opener into a later native open', () => {
  const h = setup();
  const item = { kind: 'list button' };
  h.closeInstead();
  h.flyToStation(h.map, 'fixture', item);
  h.moveend();
  assert.equal(h.adopted.length, 0);
  h.nativeOpen();
  assert.ok(h.adopted[0][2] === h.markerElement);
});

test('a station removed during the flight does not open or adopt a popup', () => {
  const h = setup();
  h.flyToStation(h.map, 'fixture', { kind: 'list button' });
  h.markersByStationId.clear();
  h.moveend();
  assert.equal(h.adopted.length, 0);
});

test('a reduced-motion flight opens after its synchronous camera movement', () => {
  const h = setup(true);
  const item = { kind: 'list button' };
  h.flyToStation(h.map, 'fixture', item);
  assert.equal(h.adopted.length, 1);
  assert.ok(h.adopted[0][2] === item);
  h.moveend();
  assert.equal(h.adopted.length, 1, 'no delayed opener survives the jump');
});

function renderSetup() {
  const activeMarkers = [];
  const markersByStationId = new Map();
  const abortControllers = new WeakMap();
  const bound = [];
  class Marker {
    constructor({ element }) { this.element = element; this.removed = false; }
    setLngLat() { return this; }
    addTo() { return this; }
    setPopup(popup) { this.popup = popup; return this; }
    getPopup() { return this.popup; }
    remove() { this.removed = true; this.popup.open = false; }
  }
  const dependencies = {
    activeMarkers, markersByStationId, abortControllers,
    stationByMarker: new WeakMap(), markerViews: new WeakMap(), popupOrigins: new WeakMap(),
    document: { createElement: () => ({ dataset: {}, style: { setProperty() {} }, setAttribute() {}, appendChild() {} }) },
    maplibregl: { Marker, Popup: class { open = false; } },
    markerAccessibleLabel: () => 'Fixture', glyphEligibleWind: () => null, readRawsWindFields: () => null,
    bindPopups: (_map, markers = activeMarkers) => { bound.push(...markers); }, showStationLegend() {}
  };
  const source = readFileSync(new URL('../src/layers/telemetry.ts', import.meta.url), 'utf8');
  // On the red base removal is inline in clearMarkers; after the repair it is shared.
  const remove = source.includes('function removeMarker(') ? functionBody('../src/layers/telemetry.ts', 'removeMarker') : '';
  const functions = new Function(...Object.keys(dependencies), `${remove}\n${functionBody('../src/layers/telemetry.ts', 'clearMarkers')}\n${functionBody('../src/layers/telemetry.ts', 'renderStations')}\nreturn { renderStations, clearMarkers };`)(...Object.values(dependencies));
  const station = { id: 'fixture', coords: [47, -120], color: '#000' };
  const view = { station, freshness: 'unknown', primaryParameterCategory: 'water', networkLabel: 'Fixture' };
  const render = (views) => functions.renderStations({}, views);
  render([view]);
  const marker = markersByStationId.get(station.id);
  marker.popup.open = true;
  const controller = new AbortController();
  abortControllers.set(marker, controller);
  return { ...functions, render, view, marker, controller, activeMarkers, markersByStationId, bound };
}

test('an unchanged station keeps its open popup, pending read and single binding through refresh', () => {
  const h = renderSetup();
  h.render([{ ...h.view }]);
  assert.ok(h.markersByStationId.get('fixture') === h.marker);
  assert.equal(h.marker.popup.open, true);
  assert.equal(h.controller.signal.aborted, false);
  assert.deepEqual(h.bound, [h.marker]);
  h.clearMarkers();
  assert.equal(h.controller.signal.aborted, true);
  assert.equal(h.marker.removed, true);
  assert.equal(h.activeMarkers.length, 0);
  assert.equal(h.markersByStationId.size, 0);
});

test('an absent station is removed and its pending popup read is aborted', () => {
  const h = renderSetup();
  h.render([]);
  assert.equal(h.controller.signal.aborted, true);
  assert.equal(h.marker.removed, true);
  assert.equal(h.activeMarkers.length, 0);
  assert.equal(h.markersByStationId.size, 0);
});

for (const change of ['station', 'freshness', 'primaryParameterCategory', 'networkLabel']) {
  test(`a changed ${change} replaces the marker and aborts its obsolete popup read`, () => {
    const h = renderSetup();
    const value = change === 'station' ? { ...h.view.station, usgsSite: 'new-handle' } : 'changed';
    h.render([{ ...h.view, [change]: value }]);
    const replacement = h.markersByStationId.get('fixture');
    assert.notEqual(replacement, h.marker);
    assert.equal(h.controller.signal.aborted, true);
    assert.equal(h.marker.removed, true);
    assert.deepEqual(h.activeMarkers, [replacement]);
    assert.deepEqual(h.bound, [h.marker, replacement]);
  });
}
