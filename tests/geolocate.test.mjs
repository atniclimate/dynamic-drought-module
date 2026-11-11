import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * Locate's pure core (owner direction 2026-11-09 (sprint), DR-pending):
 * src/state/geolocate.ts and src/state/locate-preference.ts, and the rules
 * the rest of the lane's modules are held to as text (no storage, no URL,
 * no request of their own).
 *
 * The person's point is the most sensitive value this application holds, so
 * the rules that protect it are proven here without a browser: a late answer
 * never revives a cancelled or timed-out attempt, each state has its own
 * sentence, the frame the camera takes is a function of the grid square and
 * not of the point, containment is claimed only when the whole accuracy disc
 * supports it, and the one stored value is the word yes or the word no.
 *
 * Runs under plain `node --test`: both modules are import-free, so Node 24's
 * type stripping loads them with no resolve hook.
 */

const ROOT = new URL('..', import.meta.url);
const core = await import(new URL('src/state/geolocate.ts', ROOT).href);
const pref = await import(new URL('src/state/locate-preference.ts', ROOT).href);
const {
  IDLE_STATE,
  LOCATE_TIMEOUT_MS,
  GOOD_FIX_M,
  LOW_ACCURACY_M,
  LOCATE_CELL_DEG,
  STATE_OUTLINE_MARGIN_M,
  LEGAL_AIANNH_CODES,
  reduceLocate,
  isInFlight,
  isLocated,
  phaseCopy,
  plainDistance,
  coarseCell,
  cellSizeKm,
  discRing,
  discInsideEnvelope,
  pointInGeometry,
  edgeDistanceM,
  classifyDisc,
  findStates,
  findTribalHits,
  tribalVerdict,
  generalizationM,
  accuracyLine,
  locatedCopy,
  drawnBy,
  tribalDisclosure,
  tribalCopy,
  NO_AREA_CAVEAT
} = core;

const source = async (path) => readFile(new URL(path, ROOT), 'utf8');

const start = (attempt, over = {}) => ({
  type: 'start',
  attempt,
  supported: true,
  secure: true,
  permission: 'prompt',
  ...over
});
const GOOD = { lng: -120.5, lat: 47.25, accuracy: 20 };
const COARSE = { lng: -120.5, lat: 47.25, accuracy: 5000 };
const run = (events, from = IDLE_STATE) => events.reduce(reduceLocate, from);

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

test('a press asks, an allowed press locates, and a good fix is taken at once', () => {
  const asking = run([start(1)]);
  assert.equal(asking.phase, 'asking');
  assert.equal(asking.fix, null);
  const locating = run([{ type: 'permission', attempt: 1, permission: 'granted' }], asking);
  assert.equal(locating.phase, 'locating');
  const located = run([{ type: 'fix', attempt: 1, fix: GOOD }], locating);
  assert.equal(located.phase, 'located');
  assert.deepEqual(located.fix, GOOD);
  assert.equal(run([start(2, { permission: 'granted' })]).phase, 'locating');
  assert.ok(isInFlight('asking') && isInFlight('locating') && !isInFlight('located'));
  assert.ok(isLocated('located') && isLocated('located-low') && !isLocated('timeout'));
});

test('learning that the browser is asking sharpens the wording and nothing else', () => {
  const unsure = run([start(1, { permission: 'unknown' })]);
  assert.match(phaseCopy(unsure).body, /may be asking/);
  const sure = run([{ type: 'permission', attempt: 1, permission: 'prompt' }], unsure);
  assert.equal(sure.phase, 'asking');
  assert.match(phaseCopy(sure).body, /is asking/);
  assert.equal(reduceLocate(sure, { type: 'permission', attempt: 1, permission: 'prompt' }), sure);
});

test('a fix while the permission reading is unknown still locates', () => {
  const state = run([start(1, { permission: 'unknown' }), { type: 'fix', attempt: 1, fix: GOOD }]);
  assert.equal(state.phase, 'located');
});

test('a coarse first fix waits for a better one, then is taken as low accuracy', () => {
  const waiting = run([start(1, { permission: 'granted' }), { type: 'fix', attempt: 1, fix: COARSE }]);
  assert.equal(waiting.phase, 'locating', 'a coarse fix is held, not shown');
  assert.deepEqual(waiting.pending, COARSE);
  assert.equal(waiting.fix, null);
  // A worse fix never replaces a better pending one.
  const worse = run([{ type: 'fix', attempt: 1, fix: { ...COARSE, accuracy: 9000 } }], waiting);
  assert.equal(worse.pending.accuracy, 5000);
  // A good fix inside the window wins.
  assert.equal(run([{ type: 'fix', attempt: 1, fix: GOOD }], waiting).phase, 'located');
  // The settle clock takes what there is.
  const low = run([{ type: 'settle', attempt: 1 }], waiting);
  assert.equal(low.phase, 'located-low');
  assert.equal(low.fix.accuracy, 5000);
  assert.equal(low.pending, null);
  // So does the deadline, and so does a device timeout: a held fix beats "no position".
  assert.equal(run([{ type: 'deadline', attempt: 1 }], waiting).phase, 'located-low');
  assert.equal(run([{ type: 'error', attempt: 1, code: 3 }], waiting).phase, 'located-low');
  assert.ok(COARSE.accuracy > LOW_ACCURACY_M && GOOD.accuracy <= GOOD_FIX_M);
});

test('denied, unavailable and timeout are three different states with three reasons', () => {
  const inFlight = run([start(1, { permission: 'granted' })]);
  const denied = run([{ type: 'error', attempt: 1, code: 1 }], inFlight);
  const noFix = run([{ type: 'error', attempt: 1, code: 2 }], inFlight);
  const timedOut = run([{ type: 'error', attempt: 1, code: 3 }], inFlight);
  const watchdog = run([{ type: 'deadline', attempt: 1 }], inFlight);
  assert.equal(denied.phase, 'denied');
  assert.equal(noFix.phase, 'unavailable');
  assert.equal(noFix.reason, 'no-fix');
  assert.equal(timedOut.phase, 'timeout');
  assert.equal(watchdog.phase, 'timeout');
  assert.equal(run([start(2, { supported: false })]).reason, 'unsupported');
  assert.equal(run([start(2, { secure: false })]).reason, 'insecure');
  assert.equal(run([start(2, { secure: false })]).phase, 'unavailable');
  // Already refused: no in-flight state at all, so nothing can prompt.
  assert.equal(run([start(2, { permission: 'denied' })]).phase, 'denied');
  // A refusal while the sheet is up.
  assert.equal(run([start(3), { type: 'permission', attempt: 3, permission: 'denied' }]).phase, 'denied');
  for (const state of [denied, noFix, timedOut]) assert.equal(state.fix, null);
});

test('a refusal says blocked only when the browser reads blocked', () => {
  const asking = run([start(1)]);
  // The question was closed or answered no, and the browser still reads `prompt`: not a block.
  const closed = run([{ type: 'error', attempt: 1, code: 1, permission: 'prompt' }], asking);
  assert.equal(closed.phase, 'denied');
  assert.equal(closed.permission, 'prompt');
  assert.match(phaseCopy(closed).title, /not allowed/);
  assert.doesNotMatch(`${phaseCopy(closed).title} ${phaseCopy(closed).body}`, /blocked|will not ask/);
  // The browser now reads `denied`: blocked, and the way back is its settings.
  const blocked = run([{ type: 'error', attempt: 1, code: 1, permission: 'denied' }], asking);
  assert.equal(blocked.permission, 'denied');
  assert.match(phaseCopy(blocked).title, /blocked/);
  // The same through the Permissions API's own change event, and when it was blocked before the press.
  assert.match(phaseCopy(run([{ type: 'permission', attempt: 1, permission: 'denied' }], asking)).title, /blocked/);
  assert.match(phaseCopy(run([start(2, { permission: 'denied' })])).title, /blocked/);
  // With no reading after the refusal, the reading the attempt began with stands.
  assert.match(phaseCopy(run([{ type: 'error', attempt: 1, code: 1 }], asking)).title, /not allowed/);
  // Both say how to allow it, and neither nags.
  for (const state of [closed, blocked]) {
    assert.match(phaseCopy(state).body, /allow Location/);
    assert.equal(phaseCopy(state).next, 'Close');
  }
});

test('a late answer never revives a cancelled, timed-out or superseded attempt', () => {
  const lateFix = { type: 'fix', attempt: 1, fix: GOOD };
  const cancelled = run([start(1, { permission: 'granted' }), { type: 'cancel' }]);
  assert.equal(cancelled.phase, 'idle');
  assert.equal(reduceLocate(cancelled, lateFix), cancelled, 'same object: nothing happened');
  assert.equal(reduceLocate(cancelled, { type: 'error', attempt: 1, code: 1 }), cancelled);

  const timedOut = run([start(1, { permission: 'granted' }), { type: 'deadline', attempt: 1 }]);
  assert.equal(reduceLocate(timedOut, lateFix), timedOut);
  assert.equal(reduceLocate(timedOut, { type: 'settle', attempt: 1 }), timedOut);

  const second = run([start(1, { permission: 'granted' }), start(2, { permission: 'granted' })]);
  assert.equal(second.attempt, 2);
  assert.equal(reduceLocate(second, lateFix), second, 'attempt 1 no longer counts');
  assert.equal(reduceLocate(second, { type: 'deadline', attempt: 1 }), second);
  assert.equal(reduceLocate(second, { type: 'fix', attempt: 2, fix: GOOD }).phase, 'located');

  // A located state ignores further answers for its own attempt too.
  const located = run([start(1, { permission: 'granted' }), lateFix]);
  assert.equal(reduceLocate(located, { type: 'error', attempt: 1, code: 3 }), located);
  // An attempt number never goes backwards.
  assert.equal(reduceLocate(second, start(1)), second);
});

test('clear removes the point, dismiss closes a failure, and neither does the other job', () => {
  const located = run([start(1, { permission: 'granted' }), { type: 'fix', attempt: 1, fix: GOOD }]);
  assert.equal(reduceLocate(located, { type: 'dismiss' }), located);
  assert.equal(reduceLocate(located, { type: 'cancel' }), located);
  const cleared = reduceLocate(located, { type: 'clear' });
  assert.equal(cleared.phase, 'idle');
  assert.equal(cleared.fix, null, 'the point is gone from the state');
  const denied = run([start(2, { permission: 'denied' })]);
  assert.equal(reduceLocate(denied, { type: 'clear' }), denied);
  assert.equal(reduceLocate(denied, { type: 'dismiss' }).phase, 'idle');
});

test('a timeout offers one retry, and the retry offers none', () => {
  const first = run([start(1, { permission: 'granted' }), { type: 'deadline', attempt: 1 }]);
  assert.equal(first.retriesLeft, 1);
  assert.equal(phaseCopy(first).next, 'Try again');
  const second = run([start(2, { permission: 'granted', retry: true }), { type: 'deadline', attempt: 2 }], first);
  assert.equal(second.phase, 'timeout');
  assert.equal(second.retriesLeft, 0);
  assert.equal(phaseCopy(second).next, 'Close');
  // A fresh press is a fresh flow.
  assert.equal(run([start(3)], second).retriesLeft, 1);
});

test('an invalid fix is not a position', () => {
  const inFlight = run([start(1, { permission: 'granted' })]);
  for (const fix of [
    { lng: NaN, lat: 47, accuracy: 10 },
    { lng: -120, lat: 95, accuracy: 10 },
    { lng: -120, lat: 47, accuracy: -1 },
    { lng: -120, lat: 47, accuracy: Infinity }
  ]) {
    assert.equal(reduceLocate(inFlight, { type: 'fix', attempt: 1, fix }), inFlight);
  }
});

test('every state that is not a located one has its own plain line and a next step', () => {
  const states = [
    run([start(1)]),
    run([start(1, { permission: 'unknown' })]),
    run([start(1, { permission: 'granted' })]),
    run([start(1, { permission: 'denied' })]),
    run([start(1), { type: 'error', attempt: 1, code: 1, permission: 'prompt' }]),
    run([start(1, { permission: 'granted' }), { type: 'deadline', attempt: 1 }]),
    run([start(1, { permission: 'granted', retry: true }), { type: 'deadline', attempt: 1 }]),
    run([start(1, { permission: 'granted' }), { type: 'error', attempt: 1, code: 2 }]),
    run([start(1, { secure: false })]),
    run([start(1, { supported: false })])
  ];
  const lines = states.map((state) => phaseCopy(state));
  for (const copy of lines) {
    assert.ok(copy && copy.title.length > 0 && copy.body.length > 0 && copy.next, JSON.stringify(copy));
    // Surface vocabulary (B9) and the em dash rule (B10), on Locate's own words.
    assert.doesNotMatch(`${copy.title} ${copy.body}`, /\b(warn|alert|forecast|simulat)/i);
    assert.ok(!`${copy.title} ${copy.body}`.includes(String.fromCharCode(0x2014)));
  }
  assert.equal(new Set(lines.map((copy) => copy.body)).size, lines.length, 'no two states share a sentence');
  assert.equal(new Set(lines.map((copy) => copy.title)).size, lines.length - 1, 'the two asking lines share a title');
  // The stated bound is the real one.
  assert.equal(LOCATE_TIMEOUT_MS, 12_000);
  assert.match(phaseCopy(states[2]).body, /12 seconds/);
  assert.match(phaseCopy(states[5]).title, /12 seconds/);
  // Located states are worded from the place, not here; idle says nothing.
  assert.equal(phaseCopy(IDLE_STATE), null);
  assert.equal(phaseCopy(run([start(1, { permission: 'granted' }), { type: 'fix', attempt: 1, fix: GOOD }])), null);
});

// ---------------------------------------------------------------------------
// The one stored value
// ---------------------------------------------------------------------------

test('the launch preference is the word yes or no, and storage failure is survivable', () => {
  const memory = new Map();
  const store = () => ({
    getItem: (key) => (memory.has(key) ? memory.get(key) : null),
    setItem: (key, value) => void memory.set(key, value)
  });
  assert.equal(pref.readLaunchPreference(store), 'unset');
  assert.equal(pref.writeLaunchPreference('yes', store), true);
  assert.equal(pref.readLaunchPreference(store), 'yes');
  assert.equal(pref.writeLaunchPreference('no', store), true);
  assert.equal(pref.readLaunchPreference(store), 'no');
  assert.deepEqual([...memory.keys()], [pref.LAUNCH_PREFERENCE_KEY], 'one key');
  // Anything else in the slot reads as no choice made.
  memory.set(pref.LAUNCH_PREFERENCE_KEY, '47.25,-120.5');
  assert.equal(pref.readLaunchPreference(store), 'unset');
  // Private browsing: reading the property itself can throw.
  const refuses = () => {
    throw new Error('SecurityError');
  };
  assert.equal(pref.readLaunchPreference(refuses), 'unavailable');
  assert.equal(pref.writeLaunchPreference('yes', refuses), false);
});

test('the browser suite seeds the same key, with a value the app reads as declined', async () => {
  // tests/helpers.ts stores an answer before a routine boot, so no spec meets
  // the first-launch offer unless it asks for it. A drifted key would seed
  // nothing and the offer would return to every phone boot unannounced.
  const helpers = await source('tests/helpers.ts');
  const key = helpers.match(/export const LOCATE_LAUNCH_STORAGE_KEY = '([^']+)';/)?.[1];
  assert.equal(key, pref.LAUNCH_PREFERENCE_KEY);
  assert.match(
    helpers,
    /if \(window\.localStorage\.getItem\(key\) === null\) window\.localStorage\.setItem\(key, 'no'\);/,
    'the seed writes the word no, and only where nothing is stored'
  );
  const memory = new Map([[key, 'no']]);
  const store = () => ({ getItem: (name) => memory.get(name) ?? null, setItem: () => undefined });
  assert.equal(pref.readLaunchPreference(store), 'no');
});

const LOCATE_MODULES = [
  'src/state/geolocate.ts',
  'src/state/locate-preference.ts',
  'src/ui/locate-control.ts',
  'src/ui/locate-runtime.ts',
  'src/ui/locate-card.ts',
  'src/ui/locate-place.ts',
  'src/map/locate-marker.ts'
];
const code = async (file) =>
  (await source(file)).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

test('no Locate module writes anything but the preference, and none builds a URL from the point', async () => {
  for (const file of LOCATE_MODULES) {
    const text = await code(file);
    const storageWrites = text.match(/\b(?:localStorage|sessionStorage|indexedDB)\b|document\.cookie|\.setItem\(/g) ?? [];
    if (file === 'src/state/locate-preference.ts') {
      assert.deepEqual(storageWrites.sort(), ['.setItem(', 'localStorage'], file);
    } else {
      assert.deepEqual(storageWrites, [], `${file} touches storage`);
    }
    // The point never enters history, a link or a request built here.
    assert.doesNotMatch(text, /history\.(pushState|replaceState)|replaceQuery|syncUrl|location\.(href|search|hash|assign|replace)/, `${file} writes the URL`);
    assert.doesNotMatch(text, /\bfetch\(|XMLHttpRequest|sendBeacon|new WebSocket|new Image\(|navigator\.share|clipboard/, `${file} opens a request of its own`);
    assert.doesNotMatch(text, /URLSearchParams|encodeURIComponent|new URL\(/, `${file} builds a URL`);
  }
  // The one read the lane starts is the bundled state outlines: a same-origin file, no parameters.
  const reads = [];
  for (const file of LOCATE_MODULES) {
    for (const match of (await code(file)).matchAll(/\b(fetch[A-Za-z]*)\(\s*([^)]*?)\)/g)) reads.push(`${file}: ${match[1]}`);
  }
  assert.deepEqual(reads, ['src/ui/locate-place.ts: fetchSharedJsonWithBudget']);
  assert.match(await code('src/ui/locate-place.ts'), /fetchSharedJsonWithBudget\(\s*US_STATES_SHARED_KEY,\s*BOOT_URLS\.usStatesLocal,\s*null,/);
  // Only the preference module is asked to store, and only the two words.
  const writes = [];
  for (const file of LOCATE_MODULES) {
    for (const match of (await code(file)).matchAll(/writeLaunchPreference\(([^)]*)\)/g)) writes.push(match[1].trim());
  }
  assert.ok(writes.length > 0);
  for (const argument of writes) assert.match(argument, /^(value|'yes'|'no')\b/, argument);
});

test('a briefing is opened for the place, never at the position', async () => {
  const place = await code('src/ui/locate-place.ts');
  // The state path hands over a code and nothing else; the opener takes the state's own point.
  assert.match(place, /openStateBriefing\(map, state\.code, \{/);
  // The Tribal path reads at a point of the area's geometry and says so.
  assert.match(place, /representativePoint\(geometry, bbox\)/);
  assert.match(place, /pointInsidePlace: true/);
  // The fix is used for exactly three things there: the local test, the square and the disc.
  const uses = [...place.matchAll(/\bfix\.(lng|lat|accuracy)\b/g)].length;
  const allowed = [...place.matchAll(/(?:coarseCell|discInsideEnvelope)\(fix\.lng, fix\.lat[^)]*\)/g)]
    .map((match) => [...match[0].matchAll(/\bfix\.(lng|lat|accuracy)\b/g)].length)
    .reduce((a, b) => a + b, 0);
  assert.equal(uses, allowed, 'locate-place.ts reads the position somewhere this test does not know');
  // The camera is never moved to the position. The lane makes two camera calls, both fits of a box
  // (the grid square, an area's own box), and hands the position to the map once, for the marker.
  const cameraCalls = [];
  for (const file of LOCATE_MODULES) {
    for (const match of (await code(file)).matchAll(
      /\.(flyTo|easeTo|jumpTo|panTo|panBy|setCenter|setZoom|zoomTo|fitBounds|fitScreenCoordinates|setLngLat)\(/g
    )) {
      cameraCalls.push(`${file}: ${match[1]}`);
    }
  }
  assert.deepEqual(cameraCalls.sort(), [
    'src/map/locate-marker.ts: setLngLat',
    'src/ui/locate-place.ts: fitBounds',
    'src/ui/locate-place.ts: fitBounds'
  ]);
  // Every frame goes through the one padding rule; the card only widens it.
  assert.match(await source('src/state/deep-link.ts'), /export function briefingCameraPadding\(/);
  assert.equal([...place.matchAll(/fitBounds\(/g)].length, 2);
  assert.match(place, /clearOfCard\(briefingCameraPadding\(/);
  assert.match(place, /padding: clearOfCard\b/);
});

test('the dock seat the card-aware padding assumes is the stylesheets\' own', async () => {
  const px = (text, name) => Number(new RegExp(`${name}:\\s*(\\d+)px`).exec(text)?.[1]);
  const panels = await source('src/styles/mobile-panels.css');
  const app = await source('src/styles/app.css');
  const seat = px(app, '--mobile-map-edge') + px(panels, '--mobile-scale-block') + px(panels, '--sheet-rider-gap');
  assert.equal(seat, 58);
  assert.match(await source('src/ui/locate-place.ts'), new RegExp(`DOCK_SEAT_PX = ${seat};`));
});

// ---------------------------------------------------------------------------
// Plain units
// ---------------------------------------------------------------------------

test('distances read in plain units, metric first', () => {
  assert.equal(plainDistance(20), '20 m (65 ft)');
  assert.equal(plainDistance(3), '5 m (15 ft)');
  assert.equal(plainDistance(65), '70 m (250 ft)');
  assert.equal(plainDistance(350), '350 m (1,100 ft)');
  assert.equal(plainDistance(990), '1 km (0.6 mi)');
  assert.equal(plainDistance(1500), '1.5 km (0.9 mi)');
  assert.equal(plainDistance(5000), '5 km (3.1 mi)');
  assert.equal(plainDistance(25000), '25 km (16 mi)');
});

// ---------------------------------------------------------------------------
// The grid square: a function of the square, never of the point
// ---------------------------------------------------------------------------

test('the frame is the grid square, the same for every point inside it', () => {
  const cell = coarseCell(-120.31, 46.38);
  assert.deepEqual(cell, [-120.5, 46, -120, 46.5]);
  assert.equal(LOCATE_CELL_DEG, 0.5);
  // Many points, one square: nothing about the point survives the snap.
  for (let i = 0; i < 400; i += 1) {
    const lng = -120.5 + ((i * 37) % 400) / 800 + 0.0001;
    const lat = 46 + ((i * 91) % 400) / 800 + 0.0001;
    assert.deepEqual(coarseCell(lng, lat), cell, `${lng}, ${lat}`);
  }
  // The square always contains the point, on every side of zero.
  for (const [lng, lat] of [[-0.01, -0.01], [0.01, 0.01], [179.99, 71.2], [-179.99, 51.9], [-157.86, 21.31]]) {
    const [w, s, e, n] = coarseCell(lng, lat);
    assert.ok(w <= lng && lng < e && s <= lat && lat < n, `${lng}, ${lat} in ${[w, s, e, n]}`);
    assert.equal(e - w, 0.5);
    assert.equal(n - s, 0.5);
  }
  // The size the interface states is the square's real ground size.
  assert.deepEqual(cellSizeKm(cell), { widthKm: 38, heightKm: 56 });
  assert.deepEqual(cellSizeKm(coarseCell(-150, 61.2)), { widthKm: 27, heightKm: 56 });
});

test('the accuracy ring is a true ground-metre circle', () => {
  const R = 6_371_008.8;
  const haversine = (a, b) => {
    const rad = Math.PI / 180;
    const dLat = (b[1] - a[1]) * rad;
    const dLng = (b[0] - a[0]) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };
  for (const [lng, lat, radius] of [[-120.5, 47.25, 20], [-120.5, 47.25, 5000], [-150, 64.8, 25000], [-157.86, 21.31, 800]]) {
    const ring = discRing(lng, lat, radius);
    assert.equal(ring.length, 97);
    assert.deepEqual(ring[0], ring[96], 'closed');
    for (const point of ring) {
      assert.ok(Math.abs(haversine([lng, lat], point) - radius) < radius * 1e-6 + 1e-6, `${radius} m at ${lat}`);
    }
  }
});

// ---------------------------------------------------------------------------
// A disc against a boundary
// ---------------------------------------------------------------------------

const square = (w, s, e, n) => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });

test('containment is claimed only when the whole disc supports it', () => {
  const area = square(-121, 46, -120, 47);
  // 0.01 degrees of longitude at 46.5 N is about 766 m.
  const edge = edgeDistanceM(-120.99, 46.5, area);
  assert.ok(Math.abs(edge - 766) < 5, String(edge));
  assert.equal(classifyDisc(-120.5, 46.5, 20, area).relation, 'inside');
  assert.equal(classifyDisc(-120.99, 46.5, 20, area).relation, 'inside');
  assert.equal(classifyDisc(-120.99, 46.5, 5000, area).relation, 'straddles', 'the ring crosses the line');
  assert.equal(classifyDisc(-121.01, 46.5, 5000, area).relation, 'straddles', 'from outside too');
  assert.equal(classifyDisc(-121.01, 46.5, 20, area).relation, 'outside');
  assert.equal(classifyDisc(-121.01, 46.5, 20, area).centreInside, false);
  assert.equal(classifyDisc(-120.99, 46.5, 5000, area).centreInside, true);
  // A hole is not the place.
  const holed = { type: 'Polygon', coordinates: [...area.coordinates, square(-120.6, 46.4, -120.4, 46.6).coordinates[0]] };
  assert.equal(pointInGeometry(-120.5, 46.5, holed), false);
  assert.equal(classifyDisc(-120.5, 46.5, 20, holed).relation, 'outside');
  assert.equal(classifyDisc(-120.8, 46.5, 20, holed).relation, 'inside');
  // A non-areal geometry contains nothing and has no edge.
  assert.equal(classifyDisc(-120.5, 46.5, 20, { type: 'Point', coordinates: [-120.5, 46.5] }).relation, 'outside');
  assert.equal(edgeDistanceM(-120.5, 46.5, null), Infinity);
  // The loaded-coverage test.
  assert.equal(discInsideEnvelope(-120.5, 46.5, 5000, [-121, 46, -120, 47]), true);
  assert.equal(discInsideEnvelope(-120.99, 46.5, 5000, [-121, 46, -120, 47]), false);
});

// ---------------------------------------------------------------------------
// Which state, from the bundled outlines
// ---------------------------------------------------------------------------

test('the state is resolved from the bundled outlines, and a state line is not guessed', async () => {
  const states = JSON.parse(await source('public/data/us-states.geojson'));
  const at = (lng, lat, accuracy = 20) => findStates(states, { lng, lat, accuracy });
  // Well inside Washington.
  assert.deepEqual(at(-120.31, 46.38), { kind: 'in', state: { code: 'WA', name: 'Washington' } });
  // Low accuracy, still wholly inside: the ring supports the claim.
  assert.deepEqual(at(-120.31, 46.38, 5000), { kind: 'in', state: { code: 'WA', name: 'Washington' } });
  // About 1 km from the Oregon line as the coarse outline draws it: both, the holder first.
  const river = at(-122.67, 45.63);
  assert.equal(river.kind, 'edge');
  assert.deepEqual(river.states.map((s) => s.code), ['WA', 'OR']);
  // On the coast, inside the margin: at the edge of one state, no second candidate.
  const coast = at(-124.62, 48.37);
  assert.equal(coast.kind, 'edge');
  assert.deepEqual(coast.states.map((s) => s.code), ['WA']);
  // The same inland point becomes a line case when the ring grows to reach Idaho.
  assert.equal(at(-117.43, 47.66).kind, 'in');
  assert.deepEqual(at(-117.43, 47.66, 30000).states.map((s) => s.code), ['WA', 'ID']);
  // Outside every outline the map carries.
  assert.deepEqual(at(-123.12, 49.28), { kind: 'outside' });
  assert.deepEqual(at(2.35, 48.86), { kind: 'outside' });
  assert.equal(STATE_OUTLINE_MARGIN_M, 2000);
  // The scale the margin is reasoned from is the one the build script states.
  assert.match(await source('scripts/build-states.mjs'), /1:20,000,000/);
});

// ---------------------------------------------------------------------------
// Which Tribal land area, from boundaries already loaded
// ---------------------------------------------------------------------------

const feature = (properties, geometry) => ({ type: 'Feature', properties, geometry });
const collection = (...features) => ({ type: 'FeatureCollection', features });
const BIG = square(-123.5, 46, -118, 48.6);
const LOADED = [
  {
    source: 'aiannh',
    collection: collection(
      feature({ NAME: 'Synthetic Legal Fixture Area', AIANNHCC: 'D1' }, BIG),
      feature({ NAME: 'Synthetic Statistical Fixture Area (OTSA)', AIANNHCC: 'D6' }, square(-118, 46, -117.2, 48.6))
    )
  },
  { source: 'bia-reservation', collection: collection(feature({ LARNAME: 'Synthetic Reservation Fixture', LARID: '99001' }, BIG)) }
];
const ON = [
  { key: 'aiannh', status: 'ready' },
  { key: 'bia-reservations', status: 'ready' },
  { key: 'tribal', status: 'off' }
];

test('a loaded area is named only when the whole disc is inside it, by the ruled precedence', () => {
  const hits = findTribalHits(LOADED, GOOD, 150);
  assert.equal(hits.length, 2);
  const verdict = tribalVerdict(ON, hits, true);
  assert.equal(verdict.kind, 'inside');
  // A Census legal entity outranks the BIA land area, and keeps its name beside it.
  assert.equal(verdict.hit.source, 'aiannh');
  assert.equal(verdict.hit.name, 'Synthetic Legal Fixture Area');
  assert.equal(verdict.biaLandArea, 'Synthetic Reservation Fixture');

  // The BIA land area outranks a Census statistical entity.
  const statistical = collection(feature({ NAME: 'Synthetic Statistical Fixture Area (OTSA)', AIANNHCC: 'D6' }, BIG));
  const second = tribalVerdict(ON, findTribalHits([{ source: 'aiannh', collection: statistical }, LOADED[1]], GOOD, 150), true);
  assert.equal(second.hit.source, 'bia-reservation');
  assert.equal(second.biaLandArea, null);
  // Deployer data outranks both.
  const own = { source: 'tribal', collection: collection(feature({ NAME: 'Synthetic Own Data Area' }, BIG)) };
  assert.equal(tribalVerdict(ON, findTribalHits([...LOADED, own], GOOD, 150), true).hit.source, 'tribal');
  // An unknown or missing subtype takes the statistical rank, the safer one.
  const unknown = collection(feature({ NAME: 'Synthetic Unknown Subtype' }, BIG));
  assert.equal(tribalVerdict(ON, findTribalHits([{ source: 'aiannh', collection: unknown }, LOADED[1]], GOOD, 150), true).hit.source, 'bia-reservation');
  // A feature with no name is never a place.
  assert.deepEqual(findTribalHits([{ source: 'aiannh', collection: collection(feature({}, BIG)) }], GOOD, 150), []);
});

test('a disc that reaches an edge claims neither side', () => {
  // 1.5 km inside the west edge with a 5 km radius.
  const nearEdge = { lng: -123.48, lat: 47.3, accuracy: 5000 };
  const verdict = tribalVerdict(ON, findTribalHits(LOADED, nearEdge, 150), true);
  assert.equal(verdict.kind, 'near');
  assert.deepEqual(verdict.hits.map((hit) => hit.source), ['aiannh', 'bia-reservation']);
  assert.ok(verdict.hits.every((hit) => hit.reading.centreInside));
  // The same point with a good fix is inside: the ring is what changed.
  assert.equal(tribalVerdict(ON, findTribalHits(LOADED, { ...nearEdge, accuracy: 20 }, 150), true).kind, 'inside');
  // And a good fix within the drawing tolerance of the edge is not claimed either.
  const onTheLine = { lng: -123.499, lat: 47.3, accuracy: 20 };
  assert.equal(tribalVerdict(ON, findTribalHits(LOADED, onTheLine, 150), true).kind, 'near');
});

test('"none" is said only when every layer that is on loaded fully and covers the disc', () => {
  const away = { lng: -110, lat: 44, accuracy: 20 };
  const hits = findTribalHits(LOADED, away, 150);
  assert.deepEqual(hits, []);
  assert.deepEqual(tribalVerdict(ON, hits, true), { kind: 'none', tested: ['aiannh', 'bia-reservations'] });
  // A live-zero layer was tested too.
  assert.equal(tribalVerdict([{ key: 'aiannh', status: 'no-data' }], hits, true).kind, 'none');
  // The disc reaches past what was loaded.
  assert.equal(tribalVerdict(ON, hits, false).kind, 'too-wide');
  // Unavailable, partial, still loading and zoom-in to load are each "not tested".
  for (const status of ['error', 'degraded', 'loading', 'zoom-in']) {
    const verdict = tribalVerdict([{ key: 'aiannh', status: 'ready' }, { key: 'bia-reservations', status }], hits, true);
    assert.equal(verdict.kind, 'incomplete', status);
    assert.deepEqual(verdict.tested, ['aiannh']);
    assert.deepEqual(verdict.untested, [{ key: 'bia-reservations', status }]);
    assert.equal(verdict.covered, true, status);
  }
  // A failed layer AND a disc past what was loaded: still incomplete, and it
  // carries `covered` so its words never call the loaded layer checked (R2-2).
  const pastLoaded = tribalVerdict([{ key: 'aiannh', status: 'ready' }, { key: 'bia-reservations', status: 'error' }], hits, false);
  assert.equal(pastLoaded.kind, 'incomplete');
  assert.equal(pastLoaded.covered, false);
  // Nothing on: nothing tested, and the verdict says so instead of guessing.
  const off = [{ key: 'aiannh', status: 'off' }, { key: 'bia-reservations', status: 'off' }];
  assert.deepEqual(tribalVerdict(off, [], true), { kind: 'layers-off' });
  // A partial layer can still support "inside": the area that did load is whole.
  const partial = [{ key: 'aiannh', status: 'degraded' }, { key: 'bia-reservations', status: 'error' }];
  assert.equal(tribalVerdict(partial, findTribalHits([LOADED[0]], GOOD, 150), true).kind, 'inside');
});

test('the mirrors of location identity and the boundary layers still match their sources', async () => {
  const identity = await source('src/state/location-identity.ts');
  const declared = /LEGAL_AIANNH_CODES = new Set\(\[([^\]]+)\]\)/.exec(identity);
  assert.ok(declared, 'location-identity.ts no longer declares LEGAL_AIANNH_CODES as a Set literal');
  assert.deepEqual([...declared[1].matchAll(/'([^']+)'/g)].map((m) => m[1]), [...LEGAL_AIANNH_CODES]);
  // The precedence sentence this module quotes.
  assert.match(identity, /deployer data, Census AIANNH legal entity, BIA LAR, then\s+\*?\s*Census AIANNH statistical entity/);
  // Half a screen pixel at the integer zoom, in both live boundary layers.
  for (const file of ['src/layers/aiannh.ts', 'src/layers/bia-reservations.ts']) {
    const text = await source(file);
    assert.match(text, /const OFFSET_PIXEL_TOLERANCE = 0\.5;/, file);
    assert.match(text, /360 \/ \(512 \* Math\.pow\(2, zoomBucket\)\)/, file);
    assert.match(text, /Math\.floor\(map\.getZoom\(\)\)/, file);
    // The request is the view's envelope and nothing else about the person.
    assert.match(text, /buildQueryEnvelope\(map\.getBounds\(\)\)/, file);
  }
  assert.ok(Math.abs(generalizationM(8) - 153) < 1, String(generalizationM(8)));
  assert.ok(Math.abs(generalizationM(9) - 76.4) < 1, String(generalizationM(9)));
});

// ---------------------------------------------------------------------------
// The words of a located position
// ---------------------------------------------------------------------------

test('a located card says what the outlines support and nothing more', async () => {
  const states = JSON.parse(await source('public/data/us-states.geojson'));
  const say = (lng, lat, accuracy = 20) => {
    const fix = { lng, lat, accuracy };
    return locatedCopy(fix, findStates(states, fix));
  };
  const inside = say(-120.31, 46.38);
  assert.equal(inside.title, 'You are in Washington');
  assert.equal(inside.certain, true, 'the whole disc is inside: the briefing may open without asking');
  assert.deepEqual(inside.states.map((s) => s.code), ['WA']);
  assert.equal(say(-77.03, 38.9).title, 'You are in the District of Columbia');
  // A state line: both are offered, neither is claimed, nothing opens by itself.
  const river = say(-122.67, 45.63);
  assert.equal(river.title, 'You are near the Washington and Oregon line');
  assert.equal(river.certain, false);
  assert.deepEqual(river.states.map((s) => s.code), ['WA', 'OR']);
  assert.match(river.qualifier, /too coarse to pick a side/);
  assert.match(say(-117.43, 47.66, 30000).qualifier, /reaches more than one state/);
  // The edge of one state, and nowhere this map names.
  const coast = say(-124.62, 48.37);
  assert.equal(coast.title, 'You are at the edge of Washington');
  assert.equal(coast.certain, false);
  const abroad = say(-123.12, 49.28);
  assert.equal(abroad.title, 'You are outside the states this map names');
  assert.deepEqual(abroad.states, []);
  // The count the line states is the bundled file's own.
  assert.match(abroad.qualifier, /50 states, the District of Columbia and Puerto Rico/);
  const codes = states.features.map((f) => f.properties.STUSPS);
  assert.equal(codes.length, 52);
  assert.ok(codes.includes('DC') && codes.includes('PR'));
  // Outlines that could not be read are said as that, never as "nowhere".
  const unread = locatedCopy(GOOD, null);
  assert.match(unread.title, /not named/);
  assert.equal(unread.certain, false);
  // The radius is stated in plain units, and a coarse one is called approximate.
  assert.equal(accuracyLine(GOOD), 'Good to about 20 m (65 ft).');
  assert.equal(accuracyLine(COARSE), 'Approximate: good to about 5 km (3.1 mi).');
});

test('the line shown before the frame names only who is asked, and what they learn', async () => {
  const cell = coarseCell(-120.4127, 47.2531);
  const both = tribalDisclosure([drawnBy('aiannh'), drawnBy('bia-reservation')], cell);
  assert.match(both, /about 38 by 56 km/);
  assert.match(both, /from the U\.S\. Census Bureau and the Bureau of Indian Affairs\./);
  // Every by-view source is asked for the same view, so the sentence is not about the two agencies alone.
  assert.match(both, /Your exact position is not sent: the map's sources see that square, not where you are in it\./);
  // The square is not the last word: a position placed inside an area opens that area, and the note says so first.
  assert.match(both, /If the check places you inside an area, the map opens that area, and its sources see the area asked for\.$/);
  const runtime = await source('src/ui/locate-runtime.ts');
  assert.match(runtime, /if \(inside && words\) void openArea\(mine, inside\.hit, words\);/);
  assert.match(runtime, /await openTribalBriefingFor\(map, hit, named, \(\) => located === mine\);/);
  assert.match(
    await source('src/ui/locate-place.ts'),
    /map\.fitBounds\(bboxToContinuousBounds\(bbox\), \{ padding: clearOfCard\(briefingCameraPadding\(true\)\) \}\);/
  );
  const one = tribalDisclosure([drawnBy('bia-reservation')], cell);
  assert.doesNotMatch(one, /Census/);
  // The same line for every point of the square: nothing in it is the point's.
  assert.equal(tribalDisclosure([drawnBy('aiannh'), drawnBy('bia-reservation')], coarseCell(-120.0933, 47.4011)), both);
  // The two agencies are named as the acknowledgements name them.
  const credits = await source('src/config/acknowledgements.ts');
  assert.match(credits, /'U\.S\. Census Bureau'/);
  assert.match(credits, /'Bureau of Indian Affairs'/);
  // What the line claims about the request is what both layers do.
  for (const file of ['src/layers/aiannh.ts', 'src/layers/bia-reservations.ts']) {
    assert.match(await source(file), /const envelope = buildQueryEnvelope\(map\.getBounds\(\)\);/, file);
  }
});

test('every Tribal verdict is its own sentence, and only "inside" names a place as the position\'s', async () => {
  const names = (key) => ({ aiannh: 'Tribal Lands (US Census)', 'bia-reservations': 'Reservation Boundaries (BIA)' })[key] ?? key;
  const inside = tribalCopy(tribalVerdict(ON, findTribalHits(LOADED, GOOD, 150), true), names);
  assert.equal(inside.title, 'You are within Synthetic Legal Fixture Area');
  assert.equal(inside.qualifier, 'As the U.S. Census Bureau draws it.');
  const near = tribalCopy(tribalVerdict(ON, findTribalHits(LOADED, { lng: -123.48, lat: 47.3, accuracy: 5000 }, 150), true), names);
  assert.equal(near.title, 'You are near the edge of Synthetic Legal Fixture Area');
  assert.match(near.qualifier, /does not place you inside or outside it/);
  assert.match(near.detail[0], /Synthetic Reservation Fixture/);
  const away = { lng: -110, lat: 44, accuracy: 20 };
  const none = tribalCopy(tribalVerdict(ON, findTribalHits(LOADED, away, 150), true), names);
  assert.equal(none.title, null, 'no place is claimed: the state title stands');
  assert.equal(none.qualifier, 'Not inside any area drawn by Tribal Lands (US Census) and Reservation Boundaries (BIA).');
  // "None" always carries the sentence that keeps it from reading as an all-clear, verbatim from the popups.
  assert.deepEqual(none.detail, [NO_AREA_CAVEAT]);
  assert.ok((await source('src/ui/popups.ts')).includes(NO_AREA_CAVEAT));
  const partial = tribalCopy(
    tribalVerdict([{ key: 'aiannh', status: 'ready' }, { key: 'bia-reservations', status: 'error' }], [], true),
    names
  );
  assert.equal(partial.qualifier, 'Tribal lands check incomplete.');
  assert.deepEqual(partial.detail, [
    'Not checked: Reservation Boundaries (BIA) (unavailable).',
    'Checked, and you are not inside any area it draws: Tribal Lands (US Census).'
  ]);
  // The same layers with the disc reaching past what was loaded: no layer is
  // called checked, and each says why (review finding R2-2).
  const partialWide = tribalCopy(
    tribalVerdict([{ key: 'aiannh', status: 'ready' }, { key: 'bia-reservations', status: 'error' }], [], false),
    names
  );
  assert.equal(partialWide.qualifier, 'Tribal lands check incomplete.');
  assert.deepEqual(partialWide.detail, [
    'Not checked: Reservation Boundaries (BIA) (unavailable) and Tribal Lands (US Census) (the position reaches past the area that was loaded).'
  ]);
  assert.ok(!partialWide.detail.some((line) => /not inside/.test(line)), 'no absence is claimed past the loaded area');
  // The six layer states keep their own words.
  for (const [status, word] of [['degraded', 'live (partial)'], ['loading', 'still loading'], ['zoom-in', 'zoom in to load']]) {
    const copy = tribalCopy(tribalVerdict([{ key: 'aiannh', status }], [], true), names);
    assert.match(copy.detail[0], new RegExp(word.replace(/[()]/g, '\\$&')), status);
  }
  const wide = tribalCopy(tribalVerdict(ON, [], false), names);
  assert.match(wide.qualifier, /could not be checked/);
  const off = tribalCopy(tribalVerdict([{ key: 'aiannh', status: 'off' }], [], true), names);
  assert.match(off.qualifier, /no Tribal boundary layer is on/);
  const all = [inside, near, none, partial, wide, off];
  assert.equal(new Set(all.map((copy) => copy.qualifier)).size, all.length);
  // Surface vocabulary (B9) and the em dash rule (B10), on every line.
  for (const copy of all) {
    const text = [copy.title ?? '', copy.qualifier, ...copy.detail].join(' ');
    assert.doesNotMatch(text, /\b(warn|alert|forecast|simulat)/i);
    assert.ok(!text.includes(String.fromCharCode(0x2014)));
  }
});
