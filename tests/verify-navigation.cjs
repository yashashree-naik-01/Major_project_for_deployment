const vm = require('vm');
const fs = require('fs');
const assert = require('assert/strict');

let success, failure, freshSuccess, freshFailure, cleared = null;
let locationOptions, freshOptions;
const geo = {
  getCurrentPosition(ok, bad, options) { freshSuccess = ok; freshFailure = bad; freshOptions = options; },
  watchPosition(ok, bad, options) { success = ok; failure = bad; locationOptions = options; assert.equal(options.enableHighAccuracy, true); return 17; },
  clearWatch(id) { cleared = id; }
};
const window = { VisionGuideNavigation: {}, fetch: async () => { throw new Error('not mocked'); } };
const context = { window, navigator: { geolocation: geo }, console, Date, Math, Promise, AbortController, setTimeout, clearTimeout };
vm.createContext(context);
for (const file of ['locationService.js', 'destinationSearch.js', 'routingService.js', 'routeTracker.js', 'navigationEngine.js'])
  vm.runInContext(fs.readFileSync(`dist/${file}`, 'utf8'), context);

(async () => {
  const N = window.VisionGuideNavigation;
  const locations = [];
  const service = new N.LocationService({ geolocation: geo, windowSize: 3 });
  service.subscribe(point => locations.push(point));
  const pending = service.start();
  assert.strictEqual(service.start(), pending, 'concurrent callers share one GPS permission request');
  let resolved = false; pending.then(() => { resolved = true; });
  assert.equal(freshOptions.enableHighAccuracy, true, 'a fresh high-accuracy one-shot fix is attempted first');
  assert.equal(freshOptions.maximumAge, 0);
  freshSuccess({ timestamp: Date.now(), coords: { latitude: 18, longitude: 73.8, accuracy: 5000, heading: null, speed: null } });
  await Promise.resolve();
  assert.equal(resolved, false, 'a coarse Wi-Fi/IP position must not be accepted as the live origin');
  assert.equal(locations.at(-1).usable, false, 'reported coarse accuracy remains visible while a better fix is awaited');
  success({ timestamp: Date.now(), coords: { latitude: 19, longitude: 72.8, accuracy: 12, heading: null, speed: null } });
  const first = await pending;
  assert.equal(first.latitude, 19);
  assert.equal(locationOptions.maximumAge, 0, 'cached browser positions are disabled');
  const acceptedCount = locations.length;
  success({ timestamp: Date.now() + 500, coords: { latitude: 20, longitude: 74, accuracy: 8, heading: null, speed: null } });
  assert.equal(locations.length, acceptedCount, 'an implausible high-speed GPS jump is ignored');
  success({ timestamp: Date.now() + 1000, coords: { latitude: 19.00001, longitude: 72.80001, accuracy: 8, heading: 45, speed: 1.2 } });
  assert.equal(locations.at(-1).heading, 45);
  assert.equal(locations.at(-1).speed, 1.2);
  service.stop(); assert.equal(cleared, 17, 'watchPosition is cleaned up');

  let deniedWatchCalls = 0;
  const deniedService = new N.LocationService({
    geolocation: { watchPosition() { deniedWatchCalls++; return 29; }, clearWatch() {} },
    permissions: { query: async () => ({ state: 'denied' }) }
  });
  await assert.rejects(() => deniedService.start(), error => /permission is blocked/i.test(error.message));
  assert.equal(deniedWatchCalls, 0, 'a pre-blocked permission does not start or re-prompt a GPS watcher');

  const unavailableService = new N.LocationService({ geolocation: null });
  await assert.rejects(() => unavailableService.start(), error => error.code === 'UNSUPPORTED');

  let grantedFix, grantedWatch;
  const grantedService = new N.LocationService({
    permissions: { query: async () => ({ state: 'granted' }) },
    geolocation: {
      getCurrentPosition(ok) { grantedFix = ok; }, watchPosition(ok) { grantedWatch = ok; return 30; }, clearWatch() {}
    }
  });
  const grantedPending = grantedService.start();
  for (let attempt = 0; attempt < 5 && !grantedFix; attempt++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(typeof grantedFix, 'function');
  grantedFix({ timestamp: Date.now(), coords: { latitude: 19, longitude: 72.8, accuracy: 11 } });
  await grantedPending;
  assert.equal(typeof grantedWatch, 'function');
  const grantedDiagnostics = grantedService.getDiagnostics();
  assert.equal(grantedDiagnostics.secureContext, true); assert.equal(grantedDiagnostics.supported, true);
  assert.equal(grantedDiagnostics.permissionState, 'granted'); assert.equal(grantedDiagnostics.watching, true);
  assert.equal(grantedDiagnostics.bestAccuracy, 11); assert(grantedDiagnostics.currentAgeMs < 1000);
  grantedService.stop();

  let temporarySuccess, temporaryFailure;
  const recoveringService = new N.LocationService({ geolocation: {
    watchPosition(ok, bad) { temporarySuccess = ok; temporaryFailure = bad; return 31; }, clearWatch() {}
  }});
  const recoveringPending = recoveringService.start();
  temporarySuccess({ timestamp: Date.now(), coords: { latitude: 19, longitude: 72.8, accuracy: 10 } });
  await recoveringPending;
  temporaryFailure({ code: 2 });
  temporarySuccess({ timestamp: Date.now() + 1000, coords: { latitude: 19.00001, longitude: 72.80001, accuracy: 9 } });
  assert.equal(recoveringService.isWatching(), true, 'a temporary positioning error does not destroy the GPS watcher');
  recoveringService.stop();

  let timeoutSuccess, timeoutFailure;
  const timeoutErrors = [];
  const timeoutService = new N.LocationService({ geolocation: {
    watchPosition(ok, bad) { timeoutSuccess = ok; timeoutFailure = bad; return 32; }, clearWatch() {}
  }});
  timeoutService.subscribe(null, error => timeoutErrors.push(error));
  const timeoutPending = timeoutService.start();
  timeoutFailure({ code: 3 });
  assert.equal(timeoutService.isWatching(), true, 'a recoverable browser timeout keeps the watcher alive');
  timeoutSuccess({ timestamp: Date.now(), coords: { latitude: 19, longitude: 72.8, accuracy: 10 } });
  await timeoutPending;
  assert(timeoutErrors.some(error => error.code === 'POSITION_TIMEOUT'));
  timeoutService.stop();

  const searchFetch = async url => ({ ok: true, json: async () => ({ results: [{ id: 1, name: 'Library', displayName: 'Library, Mumbai', latitude: 19.1, longitude: 72.9 }] }) });
  const search = new N.DestinationSearch({ fetch: searchFetch });
  const matches = await search.search('Library');
  assert.equal(matches[0].address, 'Library, Mumbai');
  await assert.rejects(() => search.search('x'), /three characters/);

  let routeRequest;
  const routing = new N.RoutingService({ fetch: async (_url, options) => {
    routeRequest = JSON.parse(options.body);
    return { ok: true, json: async () => ({ distance: 222, time: 180000,
      coordinates: [[72.8, 19], [72.801, 19], [72.802, 19]],
      steps: [{ text: 'Continue straight', sign: 0, interval: [0, 1] }, { text: 'Turn right', sign: 2, interval: [1, 2] }] }) };
  }});
  const route = await routing.route({ latitude: 19, longitude: 72.8 }, { latitude: 19, longitude: 72.802 });
  assert.equal(routeRequest.from.latitude, 19);
  assert.equal(route.steps[1].text, 'Turn right');
  const invalidRouting = new N.RoutingService({ fetch: async () => ({ ok: true, json: async () => ({
    distance: 1, time: 1, coordinates: [[72.8, 19], ['bad', 19]], steps: []
  }) }) });
  await assert.rejects(() => invalidRouting.route({ latitude: 19, longitude: 72.8 }, { latitude: 19, longitude: 72.9 }), /invalid longitude\/latitude/i);

  const tracker = new N.RouteTracker(route);
  const onRoute = tracker.update({ latitude: 19, longitude: 72.8005, accuracy: 8 });
  assert(onRoute.progress > 0 && onRoute.progress < 1);
  assert.equal(onRoute.shouldReroute, false);
  for (let i = 0; i < 2; i++) assert.equal(tracker.update({ latitude: 19.001, longitude: 72.8005, accuracy: 8 }).shouldReroute, false);
  assert.equal(tracker.update({ latitude: 19.001, longitude: 72.8005, accuracy: 8 }).shouldReroute, true,
    'three accurate off-route readings are required before rerouting');
  tracker.resetOffRoute();
  tracker.update({ latitude: 19.001, longitude: 72.8005, accuracy: 8 });
  tracker.update({ latitude: 19.001, longitude: 72.8005, accuracy: 500 });
  assert.equal(tracker.update({ latitude: 19.001, longitude: 72.8005, accuracy: 8 }).shouldReroute, false,
    'an inaccurate fix resets off-route evidence');

  let locationListener;
  const fakeLocation = {
    current: { latitude: 19, longitude: 72.8, accuracy: 8, timestamp: Date.now() },
    subscribe(fn) { locationListener = fn; }, start() { return Promise.resolve(this.current); }, stop() {}, isWatching() { return true; }
  };
  const announcements = [];
  const engine = new N.NavigationEngine({ location: fakeLocation, search,
    routing: { route: async () => route }, announce: async (text, options) => { announcements.push({ text, options }); return true; } });
  await engine.chooseDestination({ name: 'Library', latitude: 19, longitude: 72.802 });
  await engine.start();
  locationListener({ latitude: 19, longitude: 72.8009, accuracy: 8, heading: 90, speed: 1, timestamp: Date.now(), usable: true });
  await Promise.resolve();
  assert.equal(engine.getState().active, true);
  assert(announcements.some(item => item.options.priority === 75), 'an immediate turn uses navigation priority 75');

  const inaccurateLocation = { subscribe() {}, start: async () => ({ latitude: 19, longitude: 72.8, accuracy: 50000 }), stop() {} };
  const guardedEngine = new N.NavigationEngine({ location: inaccurateLocation, search, routing: { route: async () => route } });
  await assert.rejects(() => guardedEngine.chooseDestination({ name: 'Approximate origin', latitude: 19.1, longitude: 72.9 }), /precise live location/i);
  assert.match(guardedEngine.getState().routeError, /precise live location/i);

  const manualLocation = { subscribe() {}, start: async () => { throw new Error('No GPS'); }, stop() {} };
  const previewEngine = new N.NavigationEngine({ location: manualLocation, search, routing: { route: async () => route } });
  previewEngine.useManualOrigin({ name: 'Airoli Station', address: 'Airoli, Navi Mumbai', latitude: 19, longitude: 72.8 });
  await previewEngine.chooseDestination({ name: 'Library', latitude: 19, longitude: 72.802 });
  assert.equal(previewEngine.getState().routeStatus, 'ready');
  assert.match(previewEngine.getState().routeWarning, /route preview only/i);
  await assert.rejects(() => previewEngine.start(), /cannot start from a manually selected location/i);

  let transitionListener, transitionError;
  const livePoint = { latitude: 19.001, longitude: 72.801, accuracy: 14, timestamp: Date.now(), usable: true };
  const transitionLocation = {
    subscribe(fn, onError) { transitionListener = fn; transitionError = onError; }, stop() {}, isWatching() { return true; },
    async refresh() { await transitionListener(livePoint); return livePoint; }, async start() { return this.refresh(); }
  };
  const routedOrigins = [];
  const transitionEngine = new N.NavigationEngine({ location: transitionLocation, search,
    routing: { route: async origin => { routedOrigins.push({ ...origin }); return route; } } });
  transitionEngine.useManualOrigin({ name: 'Manual Start', latitude: 19, longitude: 72.8 });
  await transitionEngine.chooseDestination({ name: 'Library', latitude: 19, longitude: 72.802 });
  assert.equal(transitionEngine.canStart(), false, 'manual preview cannot enable live navigation');
  await transitionEngine.enableLocation({ refresh: true });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(transitionEngine.getState().routeOrigin.source, 'gps', 'manual preview is recalculated from the real GPS fix');
  assert.equal(routedOrigins.at(-1).latitude, livePoint.latitude);
  assert.equal(transitionEngine.canStart(), true, 'fresh usable GPS plus a GPS-origin route enables navigation');
  transitionError({ code: 'STALE_POSITION', message: 'GPS stale' });
  assert.equal(transitionEngine.getState().locationStatus, 'stale');
  assert.equal(transitionEngine.canStart(), false, 'position loss immediately disables navigation readiness');
  await transitionListener({ ...livePoint, timestamp: Date.now() });
  assert.equal(transitionEngine.getState().locationStatus, 'ready', 'a later valid fix recovers live readiness');
  assert.equal(transitionEngine.canStart(), true);

  let delayedListener;
  const delayedLocation = {
    subscribe(fn) { delayedListener = fn; }, stop() {}, isWatching() { return true; },
    async start() { const error = { code: 'ACQUISITION_TIMEOUT', message: 'No usable fix yet' }; throw error; }
  };
  const delayedEngine = new N.NavigationEngine({ location: delayedLocation, search, routing: { route: async () => route } });
  await assert.rejects(() => delayedEngine.chooseDestination({ name: 'Library', latitude: 19, longitude: 72.802 }),
    error => /No usable fix yet/.test(error.message));
  await delayedListener({ ...livePoint, timestamp: Date.now() });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(delayedEngine.getState().routeStatus, 'ready', 'a later good fix automatically retries the pending destination route');
  assert.equal(delayedEngine.canStart(), true);

  const objectSource = fs.readFileSync('dist/objectDetection.js', 'utf8');
  assert.match(objectSource, /urgent \? 100/);
  assert(100 > 75, 'camera danger priority is higher than immediate navigation turns');
  const serverSource = fs.readFileSync('server.cjs', 'utf8');
  assert(serverSource.includes("profile: 'foot'"));
  assert(!fs.readFileSync('dist/routingService.js', 'utf8').includes('GRAPHHOPPER_API_KEY'), 'the browser bundle contains no GraphHopper key');
  console.log('PASS: real geolocation acquisition lifecycle, permission/error/recovery states, manual-to-live route transition, GPS readiness, progress/rerouting, turn guidance, and Camera Guide speech priority.');
})().catch(error => { console.error(error); process.exitCode = 1; });
