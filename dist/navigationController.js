(function () {
  'use strict';

  const N = window.VisionGuideNavigation;
  const ui = {
    engine: null, map: new N.MapController(), helpers: {}, places: [], query: '', originQuery: '', originResults: [], originError: '', originLoading: false, mounted: false,
    _autoLocationAttempted: false,
    _locationFailedSpoken: false,

    configure(helpers = {}) {
      this.helpers = helpers;
      if (!this.engine) {
        this.engine = new N.NavigationEngine({ announce: (text, options) => helpers.speak(text, options) });
        this.engine.subscribe(state => {
          this.update(state);
          if (document.querySelector('.page-navigate') && !state.active && !state.location && ['denied', 'unavailable', 'lost'].includes(state.locationStatus)) {
            this._announceLocationFailed();
          }
        });
      }
      if (!this.mounted) {
        document.addEventListener('submit', event => {
          if (event.target?.id === 'navigation-search-form') {
            event.preventDefault(); void this.search(event.target.elements.destination?.value);
          }
          if (event.target?.id === 'navigation-origin-form') {
            event.preventDefault(); void this.searchOrigin(event.target.elements.origin?.value);
          }
        });
        document.addEventListener('click', event => {
          const button = event.target.closest?.('[data-nav-action]');
          if (!button) return;
          const action = button.dataset.navAction;
          if (action === 'location') void this.enableLocation();
          if (action === 'origin-result') void this.selectOriginResult(Number(button.dataset.index));
          if (action === 'microphone') this.microphone();
          if (action === 'result') void this.selectResult(Number(button.dataset.index));
          if (action === 'place') void this.selectPlace(Number(button.dataset.id));
          if (action === 'start') void this.start();
          if (action === 'stop') this.stop();
          if (action === 'repeat') void this.engine.repeat();
        });
        window.addEventListener?.('pagehide', () => this.engine.stop({ announce: false }));
        this.mounted = true;
      }
      return this;
    },

    render(context = {}) {
      this.places = context.places || this.places;
      const state = this.engine?.getState() || {};
      const esc = this.helpers.esc || (value => String(value));
      const icon = this.helpers.icon || (() => '');
      const manualOrigin = state.location?.source === 'manual';
      const candidate = state.locationCandidate;
      const locationText = candidate && state.locationStatus === 'inaccurate'
        ? `${candidate.latitude.toFixed(6)}, ${candidate.longitude.toFixed(6)} · detected ±${Math.round(candidate.accuracy)} m · waiting for better accuracy`
        : state.location
        ? manualOrigin ? state.location.address || state.location.name : `${state.location.latitude.toFixed(6)}, ${state.location.longitude.toFixed(6)} · live GPS ±${Math.round(state.location.accuracy)} m`
        : state.locationStatus === 'requesting' ? 'Waiting for a fresh, precise GPS position…' : 'Precise location permission not requested';
      const destinationText = state.destination ? esc(state.destination.address || state.destination.name) : 'No destination selected';
      const startDisabled = !this.engine?.canStart?.();
      return `<div class="page-heading"><div><h1>Navigate</h1><p>Live walking directions, one clear step at a time.</p></div><span class="pill">${icon('navigate')} ${state.active ? 'Navigation active' : 'Walking mode'}</span></div>
        <div class="navigate-layout">
          <section class="card navigation-search-card" aria-labelledby="nav-trip-heading">
            <h2 id="nav-trip-heading">Plan your walk</h2>
            <div class="nav-field-block"><span class="eyebrow">From</span><strong id="nav-origin-name">${manualOrigin ? 'Manually selected start' : 'Current Location'}</strong><span id="nav-location-copy" class="nav-field-detail">${esc(locationText)}</span>
              <button type="button" class="text-button nav-inline-action" data-nav-action="location" ${state.locationStatus === 'requesting' ? 'disabled' : ''}>${manualOrigin ? 'Try precise GPS again' : state.location ? 'Refresh precise GPS' : 'Use my precise location'}</button>
              <span id="nav-location-error" class="nav-error" role="alert">${esc(state.locationError || '')}</span>
            </div>
            <form id="navigation-origin-form" class="nav-field-block nav-origin-fallback">
              <label class="eyebrow" for="origin-search">GPS unavailable? Set start for preview</label>
              <div class="nav-search-row nav-origin-row"><input class="search" id="origin-search" name="origin" autocomplete="off" minlength="3" maxlength="160" required placeholder="Your street, landmark, or station" value="${esc(this.originQuery)}"><button type="submit">Find start</button></div>
              <small>This creates a route preview. Live turn-by-turn progress still requires precise device GPS.</small>
              <div id="navigation-origin-results" class="nav-results" aria-live="polite">${this.originResultsMarkup()}</div>
            </form>
            <form id="navigation-search-form" class="nav-field-block">
              <label class="eyebrow" for="destination-search">To</label>
              <div class="nav-search-row"><input class="search" id="destination-search" name="destination" autocomplete="off" minlength="3" maxlength="160" required placeholder="Search destination…" value="${esc(this.query)}">
                <button type="button" data-nav-action="microphone" class="nav-microphone" aria-label="Speak destination">${icon('voice')}</button>
                <button type="submit" class="primary">Search</button></div>
              <small>Search runs only when submitted; there is no rapid autocomplete.</small>
            </form>
            <div class="nav-suggestions"><h3>Suggested destinations</h3><div class="chips">${this.places.slice(0, 4).map(place => `<button type="button" data-nav-action="place" data-id="${Number(place.id)}">${icon(place.home ? 'home' : 'pin')} ${esc(place.name)}</button>`).join('')}</div></div>
            <div id="navigation-results" class="nav-results" aria-live="polite">${this.resultsMarkup(state)}</div>
          </section>
          <section class="card navigation-route-card">
            <div class="row"><div><span class="eyebrow">Map</span><h2 id="nav-destination-name">${state.destination ? esc(state.destination.name) : 'Your walking route'}</h2></div><span id="nav-gps-quality" class="nav-gps-quality">${this.gpsQuality(state.location)}</span></div>
            <div id="navigation-map" class="navigation-map" role="application" aria-label="Interactive walking route map"><div class="map-fallback">Map loads when MapLibre is available.</div></div>
            <p class="map-attribution-note">Map data © OpenStreetMap contributors</p>
            <div class="nav-endpoints"><div><span>FROM</span><strong id="nav-origin-copy">${manualOrigin ? esc(state.location.name || 'Selected start') : 'Current Location'}</strong></div><div><span>TO</span><strong id="nav-destination-copy">${destinationText}</strong></div></div>
            <div class="route-summary" aria-label="Walking route summary"><div><strong id="nav-distance">${this.formatDistance(state.route?.distance)}</strong><small>Distance</small></div><div><strong id="nav-time">${this.formatTime(state.route?.time)}</strong><small>Estimated time</small></div><div><strong id="nav-remaining">${this.formatDistance(state.progress?.remaining ?? state.route?.distance)}</strong><small>Remaining</small></div></div>
            <section class="nav-instruction" aria-live="polite"><span class="eyebrow">Current / next direction</span><h2 id="nav-instruction">${esc(state.instruction || 'Choose a destination to begin.')}</h2><p id="nav-instruction-distance">${state.progress ? `${this.formatDistance(state.progress.distanceToManeuver)} to the next direction` : ''}</p></section>
            <div id="nav-route-status" class="nav-route-status" role="status">${this.routeStatus(state)}</div>
            <div class="nav-actions"><button type="button" class="primary" data-nav-action="start" ${startDisabled ? 'disabled' : ''}>START NAVIGATION</button><button type="button" data-nav-action="stop" ${state.active ? '' : 'disabled'}>STOP NAVIGATION</button><button type="button" class="text-button" data-nav-action="repeat" ${state.route ? '' : 'disabled'}>${icon('voice')} Repeat direction</button></div>
          </section>
        </div>
        <div class="notice">${icon('shield')} GPS and map guidance can be inaccurate. Camera Guide handles immediate obstacles and has voice priority over navigation cues.</div>`;
    },

    mount() {
      const container = document.getElementById('navigation-map');
      if (container) this.map.mount(container, this.engine.getState());
      this.update(this.engine.getState());
      this.autoSelectPreciseLocation();
    },
    unmountMap() {
      this.map.destroy();
      this.engine?.releaseLocationIfIdle?.();
      this._autoLocationAttempted = false;
      this._locationFailedSpoken = false;
    },

    autoSelectPreciseLocation() {
      const state = this.engine?.getState() || {};
      const hasFreshGps = state.location?.source === 'gps' && state.locationStatus === 'ready';
      if (hasFreshGps || state.locationStatus === 'requesting' || this._autoLocationAttempted) return;
      this._autoLocationAttempted = true;
      void this.enableLocation({ refresh: false, isAuto: true });
    },

    update(state) {
      const root = document.querySelector('.page-navigate');
      if (!root) { this.map.destroy(); return; }
      const set = (id, value) => { const element = document.getElementById(id); if (element) element.textContent = value; };
      const manualOrigin = state.location?.source === 'manual';
      const candidate = state.locationCandidate;
      set('nav-origin-name', manualOrigin ? 'Manually selected start' : 'Current Location');
      set('nav-origin-copy', manualOrigin ? state.location.name || 'Selected start' : 'Current Location');
      set('nav-location-copy', candidate && state.locationStatus === 'inaccurate'
        ? `${candidate.latitude.toFixed(6)}, ${candidate.longitude.toFixed(6)} · detected ±${Math.round(candidate.accuracy)} m · waiting for better accuracy`
        : state.location ? manualOrigin ? state.location.address || state.location.name : `${state.location.latitude.toFixed(6)}, ${state.location.longitude.toFixed(6)} · live GPS ±${Math.round(state.location.accuracy)} m`
          : state.locationStatus === 'requesting' ? 'Waiting for a fresh, precise GPS position…' : 'Precise location permission not requested');
      set('nav-location-error', state.locationError || '');
      set('nav-gps-quality', this.gpsQuality(state.location));
      set('nav-destination-name', state.destination?.name || 'Your walking route');
      set('nav-destination-copy', state.destination?.address || state.destination?.name || 'No destination selected');
      set('nav-distance', this.formatDistance(state.route?.distance));
      const remainingTime = state.progress && state.route?.distance > 0 ? state.route.time * (state.progress.remaining / state.route.distance) : state.route?.time;
      set('nav-time', this.formatTime(remainingTime));
      set('nav-remaining', this.formatDistance(state.progress?.remaining ?? state.route?.distance));
      set('nav-instruction', state.instruction || 'Choose a destination to begin.');
      set('nav-instruction-distance', state.progress ? `${this.formatDistance(state.progress.distanceToManeuver)} to the next direction` : '');
      set('nav-route-status', this.routeStatus(state));
      const results = document.getElementById('navigation-results');
      if (results) results.innerHTML = this.resultsMarkup(state);
      const locationButton = document.querySelector('[data-nav-action="location"]');
      if (locationButton) { locationButton.disabled = state.locationStatus === 'requesting'; locationButton.textContent = manualOrigin ? 'Try precise GPS again' : state.location ? 'Refresh precise GPS' : 'Use my precise location'; }
      const start = document.querySelector('[data-nav-action="start"]');
      if (start) start.disabled = !this.engine?.canStart?.();
      const stop = document.querySelector('[data-nav-action="stop"]');
      if (stop) stop.disabled = !state.active;
      this.map.mount(document.getElementById('navigation-map'), state);
      this.map.update(state);
    },

    resultsMarkup(state) {
      const esc = this.helpers.esc || (value => String(value));
      if (state.searchStatus === 'loading') return '<p class="muted">Searching for matching places…</p>';
      if (state.searchError) return `<p class="nav-error" role="alert">${esc(state.searchError)}</p>`;
      if (!state.searchResults?.length) return '';
      return `<h3>Matching locations</h3><div class="nav-result-list">${state.searchResults.map((result, index) => `<button type="button" data-nav-action="result" data-index="${index}"><span class="nav-result-number">${index + 1}</span><span><strong>${esc(result.name)}</strong><small>${esc(result.address)}</small></span></button>`).join('')}</div><p class="muted">Select by touch or say “select result 1”.</p>`;
    },

    originResultsMarkup() {
      const esc = this.helpers.esc || (value => String(value));
      if (this.originLoading) return '<p class="muted">Finding your starting place…</p>';
      if (this.originError) return `<p class="nav-error" role="alert">${esc(this.originError)}</p>`;
      if (!this.originResults.length) return '';
      return `<div class="nav-result-list">${this.originResults.map((result, index) => `<button type="button" data-nav-action="origin-result" data-index="${index}"><span class="nav-result-number">${index + 1}</span><span><strong>${esc(result.name)}</strong><small>${esc(result.address)}</small></span></button>`).join('')}</div>`;
    },

    refreshOriginResults() {
      const container = document.getElementById('navigation-origin-results');
      if (container) container.innerHTML = this.originResultsMarkup();
    },

    async searchOrigin(query) {
      this.originQuery = String(query || '').trim(); this.originLoading = true; this.originError = ''; this.originResults = [];
      this.refreshOriginResults();
      try {
        this.originResults = await this.engine.search.search(this.originQuery);
        if (!this.originResults.length) this.originError = 'No matching starting places were found. Enter a more specific street, landmark, or station.';
      } catch (error) { if (error.name !== 'AbortError') this.originError = error.message; }
      finally { this.originLoading = false; this.refreshOriginResults(); }
      return this.originResults;
    },

    async selectOriginResult(index) {
      const origin = this.originResults[index];
      if (!origin) return false;
      try {
        this.engine.useManualOrigin(origin);
        const destination = this.engine.getState().destination;
        if (destination) await this.engine.chooseDestination(destination);
        this.helpers.toast?.(`Route preview starts from ${origin.name}.`);
        return true;
      } catch (error) { this.helpers.toast?.(error.message); return false; }
    },

    async search(query, options = {}) {
      this.query = String(query || '').trim();
      const input = document.getElementById('destination-search');
      if (input && input.value !== this.query) input.value = this.query;
      try {
        const results = await this.engine.searchDestinations(this.query);
        if (options.fromVoice) {
          if (results.length > 0) {
            const nearestIndex = this.findNearestResultIndex(results);
            await this.selectResult(nearestIndex);
            const chosen = results[nearestIndex];
            if (chosen) {
              await this.helpers.speak?.(`Walking route to ${chosen.name} is ready.`, { priority: 45 });
            }
          } else {
            await this.helpers.speak?.(`I could not find ${this.query}. Try a more specific place or address.`, { priority: 45 });
          }
        }
        return results;
      } catch (error) {
        if (error.name !== 'AbortError') this.helpers.toast?.(error.message);
        return [];
      }
    },

    async enableLocation(options = {}) {
      this._locationFailedSpoken = false;
      try {
        const state = this.engine.getState();
        const shouldRefresh = options.refresh !== undefined ? options.refresh : Boolean(state.location?.source === 'gps');
        const point = await this.engine.enableLocation({ refresh: shouldRefresh, ...options });
        if (!point || point.usable === false) {
          this._announceLocationFailed();
          return null;
        }
        return point;
      } catch (error) {
        if (error.name !== 'AbortError') {
          this.helpers.toast?.(error.message);
          this._announceLocationFailed();
        }
        return null;
      }
    },

    _announceLocationFailed() {
      if (this._locationFailedSpoken) return;
      this._locationFailedSpoken = true;
      const message = 'Precise location unable to detect, please enter your location.';
      this.helpers.speak?.(message, { priority: 70, interrupt: true });
      const originInput = document.getElementById('origin-search');
      if (originInput) {
        try { originInput.focus({ preventScroll: true }); } catch (_) {}
      }
    },

    findNearestResultIndex(results) {
      if (!results || !results.length) return -1;
      if (results.length === 1) return 0;
      const state = this.engine?.getState() || {};
      const location = state.location;
      if (!location || !Number.isFinite(location.latitude) || !Number.isFinite(location.longitude)) {
        return 0;
      }
      let nearestIndex = 0;
      let minDistance = Infinity;
      for (let i = 0; i < results.length; i++) {
        const item = results[i];
        if (!Number.isFinite(item.latitude) || !Number.isFinite(item.longitude)) continue;
        const dist = window.VisionGuideNavigation?.LocationService?.distance
          ? window.VisionGuideNavigation.LocationService.distance(location, item)
          : Math.hypot(item.latitude - location.latitude, item.longitude - location.longitude);
        if (dist < minDistance) {
          minDistance = dist;
          nearestIndex = i;
        }
      }
      return nearestIndex;
    },

    microphone() {
      if (!window.voiceCommandAPI) { this.helpers.toast?.('Voice recognition is unavailable in this browser.'); return; }
      window.voiceCommandAPI.expectDestination?.();
      window.voiceCommandAPI.start();
      this.helpers.speak?.('Say your destination.', { priority: 35, interrupt: false });
    },
    async selectResult(index) {
      const result = this.engine.getState().searchResults[index];
      if (!result) return false;
      try { await this.engine.chooseDestination(result); this.helpers.toast?.(`Walking route to ${result.name} is ready.`); return true; }
      catch (error) { this.helpers.toast?.(error.message); return false; }
    },
    async selectPlace(id) {
      const place = this.places.find(item => Number(item.id) === Number(id));
      if (!place) return false;
      const input = document.getElementById('destination-search');
      if (input) input.value = place.name;
      if (Number.isFinite(place.latitude) && Number.isFinite(place.longitude)) {
        try {
          await this.engine.chooseDestination(place);
          this.helpers.toast?.(`Walking route to ${place.name} is ready.`);
          return true;
        } catch (error) {
          this.helpers.toast?.(error.message);
          return false;
        }
      }
      const results = await this.search(place.address || place.name, { fromVoice: true });
      return results.length > 0;
    },
    async selectVoiceResult(number) {
      const ok = await this.selectResult(Math.max(0, Number(number) - 1));
      if (!ok) this.helpers.speak?.('That search result is not available. Say a result number shown on screen.', { priority: 45 });
      return ok;
    },
    async navigateToName(name) {
      const query = String(name || '').trim();
      if (!query) return false;
      this.query = query;
      if (!document.querySelector('.page-navigate')) this.helpers.go?.('navigate');
      const input = document.getElementById('destination-search');
      if (input) input.value = query;
      const queryLower = query.toLowerCase();
      const saved = this.places.find(place => place.name.toLowerCase() === queryLower) ||
        this.places.find(place => `${place.name} ${place.address}`.toLowerCase().includes(queryLower));
      if (saved && Number.isFinite(saved.latitude) && Number.isFinite(saved.longitude)) {
        return this.selectPlace(saved.id);
      }
      const results = await this.search(query, { fromVoice: true });
      return results.length > 0;
    },
    async start() { try { await this.engine.start(); } catch (error) { this.helpers.toast?.(error.message); this.helpers.speak?.(error.message, { priority: 50 }); } },
    stop() { this.engine.stop(); },
    whereAmI() {
      const state = this.engine.getState(), location = state.location;
      if (!location) { this.helpers.speak?.('Live location is not available. Open Navigate and enable live GPS.', { priority: 45 }); return; }
      if (location.source === 'manual') {
        this.helpers.speak?.(`The selected route preview starts from ${location.name || location.address || 'the chosen location'}. This is not your live GPS position.`, { priority: 45 });
        return;
      }
      const route = state.active && state.destination ? ` You are navigating to ${state.destination.name}.` : '';
      this.helpers.speak?.(`Your location is ${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}, accurate to about ${Math.round(location.accuracy)} metres.${route}`, { priority: 45 });
    },
    currentInstruction() { return this.engine.repeat(); },
    isActive() { return Boolean(this.engine?.getState().active); },
    getState() { return this.engine?.getState(); },
    gpsQuality(location) { if (!location) return 'GPS waiting'; if (location.source === 'manual') return 'Manual preview'; if (location.accuracy <= 15) return 'GPS strong'; if (location.accuracy <= 40) return 'GPS fair'; if (location.accuracy <= 80) return 'GPS usable'; if (location.accuracy <= 300) return 'GPS approximate'; return 'GPS unusable for routing'; },
    formatDistance(value) { if (!Number.isFinite(Number(value))) return '—'; value = Math.max(0, Number(value)); return value >= 1000 ? `${(value / 1000).toFixed(1)} km` : `${Math.round(value)} m`; },
    formatTime(value) { if (!Number.isFinite(Number(value))) return '—'; return `${Math.max(1, Math.round(Number(value) / 60000))} min`; },
    routeStatus(state) { if (state.rerouting) return 'Off route · recalculating walking directions…'; if (state.locationStatus === 'denied') return state.locationError; if (state.locationStatus === 'inaccurate' && !state.active) return state.locationError; if (state.locationStatus === 'stale' || state.locationStatus === 'lost') return state.locationError; if (state.routeStatus === 'loading') return state.locationStatus === 'requesting' ? 'Waiting for GPS before calculating the route…' : 'Calculating walking route…'; if (state.routeError) return state.routeError; if (state.routeWarning) return state.routeWarning; if (state.active) return 'Live navigation is running.'; if (state.route && state.routeOrigin?.source === 'manual') return 'Route preview only. Obtain live GPS to recalculate before starting.'; if (state.route) return this.engine?.canStart?.() ? 'Walking route ready. Start when you are ready.' : 'Route ready, but a fresh usable live GPS fix is still required.'; return 'Choose a destination to calculate a route.'; }
  };

  window.navigationUI = ui;
})();
