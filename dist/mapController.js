(function () {
  'use strict';

  const empty = geometry => ({
    type: 'FeatureCollection',
    features: geometry ? [{ type: 'Feature', properties: {}, geometry }] : []
  });

  const validCoordinate = coordinate => Array.isArray(coordinate)
    && coordinate.length >= 2
    && Number.isFinite(Number(coordinate[0]))
    && Number.isFinite(Number(coordinate[1]))
    && Number(coordinate[0]) >= -180
    && Number(coordinate[0]) <= 180
    && Number(coordinate[1]) >= -90
    && Number(coordinate[1]) <= 90;

  const coordinate = location => {
    if (!location) return null;
    const value = [Number(location.longitude), Number(location.latitude)];
    return validCoordinate(value) ? value : null;
  };

  const routeCoordinates = route => (Array.isArray(route?.coordinates) ? route.coordinates : [])
    .filter(validCoordinate)
    .map(value => [Number(value[0]), Number(value[1])]);

  class MapController {
    constructor() {
      this.map = null;
      this.container = null;
      this.fittedRoute = null;
      this.latestState = null;
    }

    mount(container, state) {
      if (!container || !window.maplibregl) return false;
      this.latestState = state;
      if (this.container !== container) {
        this.destroy();
        this.container = container;
        this.latestState = state;
        const initialLocation = coordinate(state.locationCandidate || state.location);
        this.map = new window.maplibregl.Map({
          container,
          style: {
            version: 8,
            sources: {
              osm: {
                type: 'raster',
                tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
                tileSize: 256,
                attribution: '&copy; OpenStreetMap contributors'
              }
            },
            layers: [{ id: 'osm', type: 'raster', source: 'osm' }]
          },
          center: initialLocation || [72.8347, 19.0607],
          zoom: initialLocation ? 16 : 12
        });
        this.map.addControl(new window.maplibregl.NavigationControl({ showCompass: true }), 'top-right');
        const styleReady = () => this._handleStyleReady();
        this.map.on('load', styleReady);
        this.map.on('style.load', styleReady);
      } else {
        this.update(state);
      }
      this._resize();
      return true;
    }

    _handleStyleReady() {
      if (!this.map) return;
      this._addLayers();
      this.update(this.latestState || {}, true);
      this._resize();
    }

    _addLayers() {
      if (!this.map) return;
      const addSource = id => {
        if (!this.map.getSource(id)) this.map.addSource(id, { type: 'geojson', data: empty() });
      };
      ['vg-route', 'vg-progress', 'vg-user', 'vg-destination'].forEach(addSource);

      const addLayer = layer => {
        if (!this.map.getLayer?.(layer.id)) this.map.addLayer(layer);
      };
      addLayer({ id: 'vg-route-casing', type: 'line', source: 'vg-route', paint: { 'line-color': '#ffffff', 'line-width': 12, 'line-opacity': 0.9 } });
      addLayer({ id: 'vg-route', type: 'line', source: 'vg-route', paint: { 'line-color': '#253cec', 'line-width': 8, 'line-opacity': 0.95 } });
      addLayer({ id: 'vg-progress', type: 'line', source: 'vg-progress', paint: { 'line-color': '#19865c', 'line-width': 9, 'line-opacity': 1 } });
      addLayer({ id: 'vg-destination', type: 'circle', source: 'vg-destination', paint: { 'circle-radius': 9, 'circle-color': '#172334', 'circle-stroke-width': 3, 'circle-stroke-color': '#fff' } });
      addLayer({ id: 'vg-user-accuracy', type: 'circle', source: 'vg-user', paint: { 'circle-radius': 18, 'circle-color': '#253cec', 'circle-opacity': 0.14 } });
      addLayer({ id: 'vg-user', type: 'circle', source: 'vg-user', paint: { 'circle-radius': 8, 'circle-color': '#253cec', 'circle-stroke-width': 3, 'circle-stroke-color': '#fff' } });
    }

    update(state, forceFit = false) {
      this.latestState = state;
      if (!this.map?.isStyleLoaded?.()) return;
      this._addLayers();
      const point = value => empty(value ? { type: 'Point', coordinates: value } : null);
      const line = values => empty(values.length > 1 ? { type: 'LineString', coordinates: values } : null);
      const displayedLocation = state.locationCandidate && state.location?.source !== 'manual'
        ? state.locationCandidate
        : state.location;
      const user = coordinate(displayedLocation);
      const destination = coordinate(state.destination);
      const route = routeCoordinates(state.route);
      this.map.getSource('vg-user')?.setData(point(user));
      this.map.getSource('vg-destination')?.setData(point(destination));
      this.map.getSource('vg-route')?.setData(line(route));

      const progressIndex = Number.isInteger(state.progress?.nearestIndex)
        ? Math.min(Math.max(state.progress.nearestIndex, 0), route.length - 1)
        : -1;
      const completed = progressIndex >= 1 ? route.slice(0, progressIndex + 1) : [];
      this.map.getSource('vg-progress')?.setData(line(completed));

      if (user && state.active) {
        const reliableHeading = Number.isFinite(Number(displayedLocation.heading))
          ? Number(displayedLocation.heading)
          : 0;
        this.map.easeTo({ center: user, bearing: reliableHeading, zoom: 17, duration: 500 });
      }

      if (route.length > 1 && (forceFit || state.route !== this.fittedRoute)) {
        const bounds = route.reduce(
          (box, value) => box.extend(value),
          new window.maplibregl.LngLatBounds(route[0], route[0])
        );
        this.map.fitBounds(bounds, { padding: 55, maxZoom: 17, duration: 0 });
        this.fittedRoute = state.route;
      } else if (!route.length) {
        this.fittedRoute = null;
        if (user && forceFit) this.map.jumpTo({ center: user, zoom: 16 });
      }
      this._resize();
    }

    _resize() {
      if (!this.map?.resize) return;
      const schedule = window.requestAnimationFrame || (callback => callback());
      schedule(() => this.map?.resize?.());
    }

    destroy() {
      this.map?.remove?.();
      this.map = null;
      this.container = null;
      this.fittedRoute = null;
      this.latestState = null;
    }
  }

  window.VisionGuideNavigation = { ...(window.VisionGuideNavigation || {}), MapController };
})();
