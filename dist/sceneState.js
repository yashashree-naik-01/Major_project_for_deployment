(function () {
  'use strict';

  const listeners = new Set();
  let sessionId = 0;
  let state = _empty('idle');

  function _empty(status) {
    return Object.freeze({
      sessionId,
      frameId: 0,
      timestamp: 0,
      status,
      error: null,
      objects: Object.freeze([]),
      freeSpace: Object.freeze({ left: null, center: null, right: null }),
      recommendedDirection: null,
      guidanceMessage: '',
      processingMs: 0,
      source: Object.freeze({ width: 0, height: 0 }),
      depth: Object.freeze({ available: false, ageMs: null, relative: true }),
      surface: Object.freeze({ available: false, ageMs: null, primaryCategory: 'unknown', shares: null, device: 'none' })
    });
  }

  function begin() {
    sessionId++;
    state = _empty('starting');
    _notify();
    return sessionId;
  }

  function setStatus(status, error = null) {
    state = Object.freeze({ ...state, status, error: error ? String(error) : null });
    _notify();
  }

  function publish(input) {
    const width = Number(input.videoWidth) || 0;
    const height = Number(input.videoHeight) || 0;
    const objects = (input.tracks || []).map(track => {
      const [x, y, w, h] = track.bbox || [0, 0, 0, 0];
      const centre = width ? (x + w / 2) / width : 0.5;
      return Object.freeze({
        trackId: track.id,
        class: track.label,
        confidence: track.score,
        bbox: Object.freeze([x, y, w, h]),
        position: centre < 0.38 ? 'left' : centre > 0.62 ? 'right' : 'center',
        relativeDepth: track.distInfo?.relativeDepth ?? null,
        distanceCategory: track.distInfo?.zone || 'unknown',
        distanceLabel: track.distInfo?.label || 'unknown',
        distanceSource: track.distInfo?.source || 'unknown',
        motion: track.motion?.trajectory || 'unknown',
        approachRate: track.motion?.approachRate || 0,
        riskScore: track.risk?.score || 0,
        riskLevel: track.risk?.level || 'low'
      });
    });
    const zones = input.safeDir?.zones || {};
    const freeSpace = Object.freeze({
      left: _zone(zones.left),
      center: _zone(zones.center),
      right: _zone(zones.right)
    });
    const depthAge = window.depthAPI?.getDepthAge?.();
    const surfaceMap = input.surface || input.freeSpace?.surface || window.surfaceSegmentationAPI?.getSurfaceMap?.() || null;
    const surfaceAge = window.surfaceSegmentationAPI?.getSurfaceAge?.();
    const frozenSurface = surfaceMap ? Object.freeze({
      available: true,
      ageMs: Number.isFinite(surfaceAge) ? Math.round(surfaceAge) : null,
      primaryCategory: surfaceMap.zones?.center?.primaryCategory || 'unknown',
      shares: surfaceMap.overallShares ? Object.freeze({ ...surfaceMap.overallShares }) : null,
      device: surfaceMap.device || 'none'
    }) : Object.freeze({ available: false, ageMs: null, primaryCategory: 'unknown', shares: null, device: 'none' });
    const hazard = input.freeSpace?.hazard || input.safeDir?.hazard || input.hazard || null;
    const frozenHazard = hazard && (hazard.type || hazard.category) ? Object.freeze({
      type: hazard.type || hazard.category,
      category: hazard.category || hazard.type,
      confidence: hazard.confidence || 'none',
      label: hazard.label || hazard.alertMessage || '',
      alertMessage: hazard.alertMessage || hazard.label || '',
      riskLevel: hazard.riskLevel || 'medium',
      proximity: hazard.proximity || null,
      persistence: Number(hazard.persistence ?? hazard.consecutiveFrames ?? 1),
      edgeCount: Number(hazard.edgeCount) || 0,
      delta: Number(hazard.delta) || 0,
      location: hazard.location ? Object.freeze({ ...hazard.location }) : null,
      surfaceConfirmed: Boolean(hazard.surfaceConfirmed)
    }) : null;
    state = Object.freeze({
      sessionId,
      frameId: Number(input.frameId) || state.frameId + 1,
      timestamp: Number(input.timestamp) || Date.now(),
      status: 'active',
      error: null,
      objects: Object.freeze(objects),
      freeSpace,
      hazard: frozenHazard,
      recommendedDirection: input.safeDir?.direction || null,
      guidanceMessage: input.safeDir?.speech || input.freeSpace?.advice?.speech || '',
      processingMs: Math.max(0, Math.round(Number(input.processingMs) || 0)),
      source: Object.freeze({ width, height }),
      depth: Object.freeze({
        available: Number.isFinite(depthAge),
        ageMs: Number.isFinite(depthAge) ? Math.round(depthAge) : null,
        relative: true
      }),
      surface: frozenSurface
    });
    _notify();
    return state;
  }

  function _zone(zone) {
    if (!zone) return null;
    return Object.freeze({
      freePercent: zone.freePct ?? null,
      riskLevel: zone.riskLevel || 'low',
      safetyScore: Number.isFinite(zone.safetyScore) ? Math.round(zone.safetyScore) : null
    });
  }

  function reset() {
    sessionId++;
    state = _empty('idle');
    _notify();
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function _notify() {
    listeners.forEach(listener => {
      try { listener(state); } catch (error) {
        if (window.VisionGuideConfig?.debug) console.warn('[VisionGuide scene listener]', error);
      }
    });
  }

  window.sceneStateAPI = { begin, publish, setStatus, reset, subscribe, getSnapshot: () => state };
})();
