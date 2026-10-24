(function () {
  'use strict';

  class LocationService {
    constructor(options = {}) {
      this.geolocation = Object.prototype.hasOwnProperty.call(options, 'geolocation') ? options.geolocation :
        (typeof navigator !== 'undefined' ? navigator.geolocation : null);
      this.windowSize = Math.max(2, options.windowSize || 5);
      this.maxAcceptableAccuracy = Math.max(10, options.maxAcceptableAccuracy || 300);
      this.maxSampleAge = Math.max(1000, options.maxSampleAge || 15000);
      this.acquisitionTimeout = Math.max(5000, options.acquisitionTimeout || 30000);
      this.singleFixTimeout = Math.max(3000, options.singleFixTimeout || 10000);
      this.staleAfter = Math.max(this.maxSampleAge, options.staleAfter || 20000);
      this.maxJumpSpeed = Math.max(3, options.maxJumpSpeed || 15);
      this.permissions = options.permissions || (typeof navigator !== 'undefined' ? navigator.permissions : null) || null;
      this.secureContext = options.secureContext !== undefined ? Boolean(options.secureContext) :
        (typeof window === 'undefined' || window.isSecureContext !== false);
      this.watchId = null;
      this.startPromise = null;
      this.acquisitionTimer = null;
      this.staleTimer = null;
      this.requestGeneration = 0;
      this.pendingResolve = null;
      this.pendingReject = null;
      this.permissionState = 'unknown';
      this.samples = [];
      this.current = null;
      this.lastObserved = null;
      this.bestCandidate = null;
      this.lastRaw = null;
      this.listeners = new Set();
      this.errorListeners = new Set();
    }

    subscribe(listener, onError) {
      if (listener) this.listeners.add(listener);
      if (onError) this.errorListeners.add(onError);
      return () => { this.listeners.delete(listener); this.errorListeners.delete(onError); };
    }

    start() {
      if (!this.secureContext) {
        const error = { code: 'INSECURE_CONTEXT', message: 'Live location requires HTTPS or localhost. Open VisionGuide from a secure address and try again.' };
        this._error(error); return Promise.reject(error);
      }
      if (!this.geolocation) {
        const error = { code: 'UNSUPPORTED', message: 'Live location is unavailable in this browser.' };
        this._error(error);
        return Promise.reject(error);
      }
      if (this.current && this._isFresh(this.current)) return Promise.resolve(this.current);
      if (this.startPromise) return this.startPromise;
      this.startPromise = this._createAcquisitionPromise();
      if (this.watchId === null) void this._beginAcquisition(this.requestGeneration);
      return this.startPromise;
    }

    refresh() {
      this.stop();
      return this.start();
    }

    stop() {
      this.requestGeneration++;
      if (this.watchId !== null && this.geolocation) this.geolocation.clearWatch(this.watchId);
      if (this.acquisitionTimer !== null) clearTimeout(this.acquisitionTimer);
      if (this.staleTimer !== null) clearTimeout(this.staleTimer);
      if (this.pendingReject) {
        const error = new Error('Location request was cancelled.'); error.name = 'AbortError';
        this.pendingReject(error);
      }
      this.acquisitionTimer = null;
      this.staleTimer = null;
      this.watchId = null;
      this.startPromise = null;
      this.pendingResolve = null;
      this.pendingReject = null;
      this.samples = [];
      this.current = null;
      this.lastObserved = null;
      this.bestCandidate = null;
      this.lastRaw = null;
    }

    isWatching() { return this.watchId !== null; }
    getCurrent() { return this.current; }
    getDiagnostics() {
      return {
        secureContext: this.secureContext,
        supported: Boolean(this.geolocation),
        permissionState: this.permissionState,
        watching: this.isWatching(),
        bestAccuracy: Number.isFinite(Number(this.bestCandidate?.accuracy)) ? Number(this.bestCandidate.accuracy) : null,
        currentAgeMs: this.current ? Math.max(0, Date.now() - this.current.timestamp) : null
      };
    }

    _createAcquisitionPromise() {
      const promise = new Promise((resolve, reject) => {
        this.pendingResolve = resolve; this.pendingReject = reject;
        this.acquisitionTimer = setTimeout(() => {
          const accuracy = Number(this.bestCandidate?.accuracy);
          const detail = Number.isFinite(accuracy) ? ` The best reading was accurate to about ${Math.round(accuracy)} metres.` : '';
          const error = { code: Number.isFinite(accuracy) ? 'LOW_ACCURACY' : 'ACQUISITION_TIMEOUT',
            message: `A usable live location was not obtained in time.${detail} VisionGuide will keep listening for a better GPS fix.` };
          this._error(error); this._rejectPending(error);
        }, this.acquisitionTimeout);
      });
      return promise;
    }

    async _beginAcquisition(generation) {
      if (this.permissions?.query) {
        try {
          const status = await this.permissions.query({ name: 'geolocation' });
          this.permissionState = status.state;
          if (generation !== this.requestGeneration) return;
          if (status.state === 'denied') {
            this._terminalError({ code: 'PERMISSION_DENIED', message: 'Location permission is blocked. Enable it in browser site settings and Windows Location settings, then try again.' });
            return;
          }
        } catch (_) {}
      }
      if (generation !== this.requestGeneration) return;
      if (typeof this.geolocation.getCurrentPosition === 'function') {
        this.geolocation.getCurrentPosition(
          position => { if (generation === this.requestGeneration) this._handlePosition(position); },
          raw => {
            if (generation !== this.requestGeneration) return;
            const error = this._friendlyError(raw);
            if (error.code === 'PERMISSION_DENIED') this._terminalError(error);
            else this._error(error);
          },
          { enableHighAccuracy: true, maximumAge: 0, timeout: this.singleFixTimeout }
        );
      }
      this._ensureWatcher(generation);
    }

    _ensureWatcher(generation) {
      if (generation !== this.requestGeneration || this.watchId !== null) return;
      if (typeof this.geolocation.watchPosition !== 'function') {
        this._terminalError({ code: 'UNSUPPORTED', message: 'Continuous location tracking is unavailable in this browser.' });
        return;
      }
      this.watchId = this.geolocation.watchPosition(
        position => { if (generation === this.requestGeneration) this._handlePosition(position); },
        raw => {
          if (generation !== this.requestGeneration) return;
          const error = this._friendlyError(raw);
          if (error.code === 'PERMISSION_DENIED') this._terminalError(error);
          else this._error(error);
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: Math.min(this.acquisitionTimeout, 15000) }
      );
    }

    _handlePosition(position) {
      const sample = this._normalise(position);
      if (!sample) { this._error({ code: 'INVALID_POSITION', message: 'The browser returned invalid location coordinates.' }); return; }
      const age = Math.abs(Date.now() - sample.timestamp);
      if (age > this.maxSampleAge) { this._error({ code: 'STALE_POSITION', message: `The browser returned a stale location from ${Math.round(age / 1000)} seconds ago. Waiting for a fresh fix.` }); return; }
      this.lastObserved = sample;
      if (!this.bestCandidate || sample.accuracy < this.bestCandidate.accuracy) this.bestCandidate = sample;
      if (!Number.isFinite(sample.accuracy) || sample.accuracy > this.maxAcceptableAccuracy) {
        const observed = { ...sample, usable: false };
        this.listeners.forEach(listener => listener(observed));
        this._error({ code: 'INACCURATE_POSITION', message: `Location detected, but accuracy is only about ${Math.round(sample.accuracy)} metres. Waiting for a better fix.` });
        return;
      }
      if (this._isImplausibleJump(sample)) {
        this._error({ code: 'IMPLAUSIBLE_JUMP', message: 'An implausible location jump was ignored while waiting for a stable GPS reading.' });
        return;
      }
      this.lastRaw = sample;
      this.permissionState = 'granted';
      this.current = { ...this._smooth(sample), usable: true };
      this._armStaleTimer();
      this.listeners.forEach(listener => listener(this.current));
      this._resolvePending(this.current);
    }

    _resolvePending(point) {
      if (!this.pendingResolve) return;
      if (this.acquisitionTimer !== null) clearTimeout(this.acquisitionTimer);
      const resolve = this.pendingResolve;
      this.acquisitionTimer = null; this.pendingResolve = null; this.pendingReject = null; this.startPromise = null;
      resolve(point);
    }

    _rejectPending(error) {
      if (!this.pendingReject) return;
      if (this.acquisitionTimer !== null) clearTimeout(this.acquisitionTimer);
      const reject = this.pendingReject;
      this.acquisitionTimer = null; this.pendingResolve = null; this.pendingReject = null; this.startPromise = null;
      reject(error);
    }

    _terminalError(error) {
      if (error.code === 'PERMISSION_DENIED') this.permissionState = 'denied';
      this._error(error); this._rejectPending(error);
      if (this.watchId !== null && this.geolocation) this.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }

    _normalise(position) {
      const c = position?.coords;
      const latitude = Number(c?.latitude), longitude = Number(c?.longitude);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
      return {
        latitude, longitude,
        accuracy: Number.isFinite(Number(c.accuracy)) ? Number(c.accuracy) : Infinity,
        heading: c.heading !== null && c.heading !== undefined && Number.isFinite(Number(c.heading)) ? Number(c.heading) : null,
        speed: c.speed !== null && c.speed !== undefined && Number.isFinite(Number(c.speed)) ? Math.max(0, Number(c.speed)) : null,
        timestamp: Number(position.timestamp) || Date.now()
      };
    }

    _smooth(sample) {
      this.samples.push(sample);
      if (this.samples.length > this.windowSize) this.samples.shift();
      let latitude = 0, longitude = 0, total = 0;
      this.samples.forEach((point, index) => {
        const recency = (index + 1) / this.samples.length;
        const weight = recency / Math.max(5, Math.min(point.accuracy, 100));
        latitude += point.latitude * weight;
        longitude += point.longitude * weight;
        total += weight;
      });
      const previous = this.current;
      let heading = sample.heading, speed = sample.speed;
      if (previous && (!Number.isFinite(heading) || !Number.isFinite(speed))) {
        const seconds = Math.max(.1, (sample.timestamp - previous.timestamp) / 1000);
        const distance = LocationService.distance(previous, sample);
        if (!Number.isFinite(speed)) speed = seconds <= 15 ? distance / seconds : null;
        if (!Number.isFinite(heading) && distance >= 2) heading = LocationService.bearing(previous, sample);
      }
      return { ...sample, latitude: latitude / total, longitude: longitude / total, heading, speed };
    }

    _isImplausibleJump(sample) {
      if (!this.lastRaw) return false;
      const seconds = (sample.timestamp - this.lastRaw.timestamp) / 1000;
      if (!(seconds > 0 && seconds <= 30)) return false;
      const metres = LocationService.distance(this.lastRaw, sample);
      const uncertainty = Math.max(75, (Number(this.lastRaw.accuracy) + Number(sample.accuracy)) * 2);
      return metres > uncertainty && metres / seconds > this.maxJumpSpeed;
    }

    _armStaleTimer() {
      if (this.staleTimer !== null) clearTimeout(this.staleTimer);
      this.staleTimer = setTimeout(() => {
        this.staleTimer = null;
        this._error({ code: 'STALE_POSITION', message: 'Live GPS updates paused. Waiting for a fresh location fix.' });
      }, this.staleAfter);
    }

    _friendlyError(error) {
      const messages = {
        1: 'Location permission was not allowed. Enable it in your browser site settings and Windows Location settings, then try again.',
        2: 'Your current location could not be determined. Move to an open area and try again.',
        3: 'Getting your location took too long. VisionGuide is still listening for a fresh GPS fix.'
      };
      const codes = { 1: 'PERMISSION_DENIED', 2: 'POSITION_UNAVAILABLE', 3: 'POSITION_TIMEOUT' };
      return { code: codes[error?.code] || 'UNKNOWN', message: messages[error?.code] || 'Live location was temporarily interrupted. VisionGuide will keep listening.' };
    }

    _isFresh(point) { return Math.abs(Date.now() - Number(point?.timestamp)) <= this.maxSampleAge; }

    _error(error) { this.errorListeners.forEach(listener => listener(error)); }

    static distance(a, b) {
      const rad = Math.PI / 180, earth = 6371000;
      const dLat = (b.latitude - a.latitude) * rad;
      const dLon = (b.longitude - a.longitude) * rad;
      const lat1 = a.latitude * rad, lat2 = b.latitude * rad;
      const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
      return 2 * earth * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
    }

    static bearing(a, b) {
      const rad = Math.PI / 180;
      const y = Math.sin((b.longitude - a.longitude) * rad) * Math.cos(b.latitude * rad);
      const x = Math.cos(a.latitude * rad) * Math.sin(b.latitude * rad) -
        Math.sin(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.cos((b.longitude - a.longitude) * rad);
      return (Math.atan2(y, x) / rad + 360) % 360;
    }
  }

  window.VisionGuideNavigation = { ...(window.VisionGuideNavigation || {}), LocationService };
})();
