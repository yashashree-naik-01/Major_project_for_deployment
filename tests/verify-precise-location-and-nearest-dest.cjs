const vm = require('vm');
const fs = require('fs');
const assert = require('assert/strict');

// Mock DOM environment
function createElement(tag, id = '', className = '') {
  return {
    tagName: tag.toUpperCase(),
    id,
    className,
    value: '',
    textContent: '',
    innerHTML: '',
    dataset: {},
    disabled: false,
    focused: false,
    focus() { this.focused = true; },
    setAttribute(k, v) { this[k] = v; },
    getAttribute(k) { return this[k]; },
    closest() { return null; },
    querySelectorAll() { return []; },
    querySelector() { return null; }
  };
}

const elements = {
  'navigation-map': createElement('div', 'navigation-map'),
  'origin-search': createElement('input', 'origin-search'),
  'destination-search': createElement('input', 'destination-search'),
  'navigation-results': createElement('div', 'navigation-results'),
  'navigation-origin-results': createElement('div', 'navigation-origin-results'),
  'nav-origin-name': createElement('strong', 'nav-origin-name'),
  'nav-origin-copy': createElement('strong', 'nav-origin-copy'),
  'nav-location-copy': createElement('span', 'nav-location-copy'),
  'nav-location-error': createElement('span', 'nav-location-error'),
  'nav-gps-quality': createElement('span', 'nav-gps-quality'),
  'nav-destination-name': createElement('h2', 'nav-destination-name'),
  'nav-destination-copy': createElement('strong', 'nav-destination-copy'),
  'nav-distance': createElement('strong', 'nav-distance'),
  'nav-time': createElement('strong', 'nav-time'),
  'nav-remaining': createElement('strong', 'nav-remaining'),
  'nav-instruction': createElement('h2', 'nav-instruction'),
  'nav-instruction-distance': createElement('p', 'nav-instruction-distance'),
  'nav-route-status': createElement('div', 'nav-route-status')
};

const pageNavigate = createElement('div', '', 'page-navigate');

const document = {
  getElementById(id) { return elements[id] || null; },
  querySelector(sel) {
    if (sel === '.page-navigate') return pageNavigate;
    if (sel.startsWith('#')) return elements[sel.slice(1)] || null;
    return null;
  },
  querySelectorAll() { return []; },
  addEventListener() {}
};

let spoken = [];
const helpers = {
  speak: async (text, options) => { spoken.push({ text, options }); return true; },
  toast: () => {},
  go: () => {},
  esc: s => String(s),
  icon: () => ''
};

let geoSuccess, geoError;
const geo = {
  getCurrentPosition(ok, bad) { geoSuccess = ok; geoError = bad; },
  watchPosition(ok, bad) { geoSuccess = ok; geoError = bad; return 1; },
  clearWatch() {}
};

const window = {
  VisionGuideNavigation: {},
  document,
  navigator: { geolocation: geo },
  fetch: async () => ({ ok: true, json: async () => ({}) }),
  addEventListener() {}
};

const context = {
  window,
  document,
  navigator: window.navigator,
  console,
  Date,
  Math,
  Promise,
  AbortController,
  setTimeout,
  clearTimeout
};

vm.createContext(context);
for (const file of [
  'locationService.js',
  'destinationSearch.js',
  'routingService.js',
  'routeTracker.js',
  'navigationEngine.js',
  'mapController.js',
  'navigationController.js',
  'voiceCommands.js'
]) {
  vm.runInContext(fs.readFileSync(`dist/${file}`, 'utf8'), context);
}

(async () => {
  const ui = window.navigationUI;
  assert(ui, 'navigationUI must be defined');

  // Test 1: Configure UI
  ui.configure(helpers);

  // Test 2: Auto-select precise location on mount
  assert.equal(ui._autoLocationAttempted, false);
  ui.mount();
  assert.equal(ui._autoLocationAttempted, true, 'Mount automatically attempts to select precise location');
  assert.equal(ui.engine.getState().locationStatus, 'requesting', 'Status becomes requesting while acquiring location');

  // Simulate successful precise GPS fix (Bandra West coords: 19.055, 72.830, accuracy 8m)
  geoSuccess({
    timestamp: Date.now(),
    coords: { latitude: 19.055, longitude: 72.830, accuracy: 8, heading: null, speed: null }
  });
  await new Promise(r => setTimeout(r, 10));

  const stateWithGps = ui.engine.getState();
  assert.equal(stateWithGps.locationStatus, 'ready');
  assert.equal(stateWithGps.location.source, 'gps');
  assert.equal(stateWithGps.location.latitude, 19.055);
  assert.equal(spoken.length, 0, 'No failure voice prompt when precise location is obtained successfully');

  // Test 3: Spoken destination selection finds and directly selects NEAREST to precise location
  // Mock search results: multiple matching results at various distances from user's location (19.055, 72.830)
  // Result 0: Far location (e.g., 19.200, 72.830 ~ 16 km away)
  // Result 1: Nearest location (e.g., 19.056, 72.831 ~ 150 m away)
  // Result 2: Medium location (e.g., 19.090, 72.830 ~ 3.9 km away)
  const mockCandidates = [
    { id: '1', name: 'Coffee Shop Borivali', displayName: 'Coffee Shop Borivali, Mumbai', latitude: 19.200, longitude: 72.830 },
    { id: '2', name: 'Coffee Shop Bandra', displayName: 'Coffee Shop Bandra, Mumbai', latitude: 19.056, longitude: 72.831 },
    { id: '3', name: 'Coffee Shop Juhu', displayName: 'Coffee Shop Juhu, Mumbai', latitude: 19.090, longitude: 72.830 }
  ];

  ui.engine.searchDestinations = async query => {
    ui.engine.state.searchResults = mockCandidates;
    return mockCandidates;
  };
  ui.engine.routing.route = async (from, to) => ({
    distance: 180,
    time: 150000,
    coordinates: [[from.longitude, from.latitude], [to.longitude, to.latitude]],
    steps: [{ text: `Walk straight to ${to.name}`, sign: 0, interval: [0, 1] }]
  });

  spoken = [];
  // User speaks a place name: "Coffee Shop"
  await ui.navigateToName('Coffee Shop');

  // Verify: destination box was filled with query
  assert.equal(elements['destination-search'].value, 'Coffee Shop');

  // Verify: Result 1 ("Coffee Shop Bandra", nearest to 19.055, 72.830) was chosen directly
  const selectedDest = ui.engine.getState().destination;
  assert.equal(selectedDest.id, '2');
  assert.equal(selectedDest.name, 'Coffee Shop Bandra');

  // Verify: Did NOT ask to choose options ("I found 3 matches... Say select result 1...")
  assert.equal(spoken.some(s => s.text.includes('Say select result')), false, 'Must not ask to choose options');
  assert.equal(spoken.some(s => s.text.includes('Walking route to Coffee Shop Bandra is ready')), true, 'Informs walking route is ready');

  // Test 4: When precise location is NOT getting, instruct with voice:
  // "Precise location unable to detect, please enter your location"
  ui.unmountMap(); // reset
  spoken = [];
  ui.engine.state.location = null;
  ui.engine.state.locationStatus = 'idle';

  // Mount navigate again, but this time simulate location acquisition failure
  ui.mount();
  geoError({ code: 1, message: 'User denied Geolocation' });
  await new Promise(r => setTimeout(r, 10));

  assert.equal(spoken.some(s => s.text === 'Precise location unable to detect, please enter your location.'), true,
    'Instructs with exact voice: Precise location unable to detect, please enter your location.');
  assert.equal(elements['origin-search'].focused, true, 'Origin input is focused so user can enter location');

  console.log('PASS: Auto-select precise location on navigate mount, voice fallback on failure, and nearest destination selection without asking options.');
})().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
