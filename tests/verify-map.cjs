const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class FakeSource {
  constructor(data) { this.data = data; }
  setData(data) { this.data = data; }
}

class FakeMap {
  constructor(options) {
    this.options = options;
    this.handlers = new Map();
    this.sources = new Map();
    this.layers = [];
    this.styleLoaded = false;
    this.fitCalls = [];
    this.resizeCalls = 0;
    FakeMap.instance = this;
  }
  addControl() {}
  on(event, handler) { this.handlers.set(event, handler); }
  emit(event) { this.handlers.get(event)?.(); }
  isStyleLoaded() { return this.styleLoaded; }
  addSource(id, definition) { this.sources.set(id, new FakeSource(definition.data)); }
  getSource(id) { return this.sources.get(id); }
  addLayer(layer) { this.layers.push(layer); }
  getLayer(id) { return this.layers.find(layer => layer.id === id); }
  fitBounds(bounds, options) { this.fitCalls.push({ bounds, options }); }
  jumpTo(options) { this.jump = options; }
  easeTo(options) { this.ease = options; }
  resize() { this.resizeCalls += 1; }
  remove() { this.removed = true; }
}

class FakeBounds {
  constructor(sw, ne) { this.coordinates = [sw, ne]; }
  extend(value) { this.coordinates.push(value); return this; }
}

const window = {
  maplibregl: {
    Map: FakeMap,
    NavigationControl: class {},
    LngLatBounds: FakeBounds
  },
  requestAnimationFrame: callback => callback()
};
const context = vm.createContext({ window, console });
vm.runInContext(
  fs.readFileSync(path.join(__dirname, '..', 'dist', 'mapController.js'), 'utf8'),
  context,
  { filename: 'mapController.js' }
);

const MapController = window.VisionGuideNavigation.MapController;
const controller = new MapController();
const initialState = { location: null, destination: null, route: null, progress: null, active: false };
controller.mount({}, initialState);
const map = FakeMap.instance;

const route = {
  distance: 300,
  time: 180000,
  coordinates: [
    [72.8347, 19.0607],
    ['72.8350', '19.0610'],
    [999, 19.0612],
    [72.8353, 19.0613]
  ],
  steps: []
};
const routeState = {
  location: { longitude: 72.8347, latitude: 19.0607, source: 'manual' },
  destination: { longitude: 72.8353, latitude: 19.0613 },
  route,
  progress: null,
  active: false
};

// A route may arrive while MapLibre is still loading. The latest state must win.
controller.update(routeState);
map.styleLoaded = true;
map.emit('load');

const routeData = map.getSource('vg-route').data;
assert.equal(routeData.features[0].geometry.type, 'LineString');
assert.deepEqual(JSON.parse(JSON.stringify(routeData.features[0].geometry.coordinates)), [
  [72.8347, 19.0607],
  [72.835, 19.061],
  [72.8353, 19.0613]
]);
assert.equal(map.getSource('vg-progress').data.features.length, 0, 'preview does not mark an untravelled segment complete');
assert.deepEqual(
  map.layers.map(layer => layer.id),
  ['vg-route-casing', 'vg-route', 'vg-progress', 'vg-destination', 'vg-user-accuracy', 'vg-user']
);
assert.equal(map.getLayer('vg-route').paint['line-opacity'], 0.95);
assert.equal(map.fitCalls.length, 1);
assert.equal(map.fitCalls[0].options.padding, 55);
assert(map.resizeCalls > 0);

controller.update({ ...routeState, progress: { nearestIndex: 2 } });
assert.equal(map.getSource('vg-progress').data.features[0].geometry.coordinates.length, 3);

// MapLibre discards custom sources and layers on a style replacement.
map.sources.clear();
map.layers = [];
map.emit('style.load');
assert(map.getLayer('vg-route-casing'));
assert(map.getLayer('vg-route'));
assert.equal(map.getSource('vg-route').data.features[0].geometry.coordinates.length, 3);

controller.update({ ...routeState, route: null, progress: null });
assert.equal(map.getSource('vg-route').data.features.length, 0);
assert.equal(map.getSource('vg-progress').data.features.length, 0);

console.log('PASS: MapLibre keeps the newest route across load/style reloads, validates GeoJSON, draws visible route/progress layers, fits bounds, resizes, and clears stale geometry.');
