// ═══════════════════════════════════════════════════════════════════
//  VisionGuide — Depth Estimation Module
//  Integrates Depth-Anything-V2 (via @huggingface/transformers ONNX)
//  for real-time monocular depth estimation.
//
//  Two-layer approach:
//    1. Bounding-box area heuristic → instant, always available
//    2. Depth-Anything-V2-Small    → relative inverse depth, after load
//
//  Exposes: window.depthAPI
// ═══════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  const CFG = window.VisionGuideConfig?.depth || {};

  /* ─── Distance Zone Definitions ─────────────────────────────── */
  const ZONES = {
    danger: {
      zone: 'danger',
      label: 'nearest range',
      detail: 'nearest range · relative estimate',
      speech: 'in the nearest relative range',
      color: '#f87171',
      barColor: '#dc2626',
      ring: 3,
    },
    close: {
      zone: 'close',
      label: 'near',
      detail: 'near · relative estimate',
      speech: 'in a near relative range',
      color: '#fb923c',
      barColor: '#ea580c',
      ring: 3,
    },
    medium: {
      zone: 'medium',
      label: 'mid-range',
      detail: 'mid-range · relative estimate',
      speech: 'at a middle relative range',
      color: '#facc15',
      barColor: '#ca8a04',
      ring: 2,
    },
    far: {
      zone: 'far',
      label: 'farther',
      detail: 'farther · relative estimate',
      speech: 'in a farther relative range',
      color: '#4ade80',
      barColor: '#16a34a',
      ring: 2,
    },
  };

  /* ─── State ─────────────────────────────────────────────────── */
  let depthPipeline   = null;
  let depthLoading    = false;
  let depthLoaded     = false;
  let depthError      = null;
  let depthLoadPromise = null;
  let activeDevice    = 'none';

  // Pre-allocated reusable quantile sampling buffer (4096 elements = 16KB, 0 GC churn)
  const sampledBuffer = new Float32Array(4096);

  // Current depth map data
  let depthData       = null;   // Reusable Float32Array from Depth-Anything-V2
  let depthW          = 0;
  let depthH          = 0;
  let depthSceneMin   = 0;
  let depthSceneMax   = 1;
  let depthTimestamp  = 0;      // when was the last depth map computed

  // Loop state
  let loopActive      = false;
  let loopTimer       = null;
  let loopVideo       = null;
  let loopGeneration  = 0;
  const LOOP_INTERVAL = CFG.intervalMs || 3000;

  // Scratch canvas for frame capture (reused)
  let frameCanvas     = null;
  let frameCtx        = null;
  const trackDepth    = new Map();

  /* ─── Public API ─────────────────────────────────────────────── */
  window.depthAPI = {
    loadModel:           loadModel,
    startDepthLoop:      startDepthLoop,
    stopDepthLoop:       stopDepthLoop,
    getDistanceForBBox:  getDistanceForBBox,
    getZones:            () => ZONES,
    isLoaded:            () => depthLoaded,
    isLoading:           () => depthLoading,
    getDevice:           () => activeDevice,
    hasDepthMap:         () => Boolean(depthData && depthTimestamp && Date.now() - depthTimestamp <= (CFG.staleAfterMs || 6500)),
    getDepthAge:         () => depthTimestamp ? Date.now() - depthTimestamp : Infinity,
    getError:            () => depthError,
    isActive:            () => loopActive,
    pruneTracks: ids => {
      const active = new Set(ids || []);
      trackDepth.forEach((_, id) => { if (!active.has(id)) trackDepth.delete(id); });
    },
    // Raw depth map for free-space analysis
    getDepthMap: () => depthData && depthTimestamp && Date.now() - depthTimestamp <= (CFG.staleAfterMs || 6500) ? {
      data:     depthData,
      width:    depthW,
      height:   depthH,
      sceneMin: depthSceneMin,
      sceneMax: depthSceneMax,
    } : null,
  };


  /* ═══════════════════════════════════════════════════════════════
     MODEL LOADING
  ═══════════════════════════════════════════════════════════════ */
  async function loadModel(options = {}) {
    if (depthLoaded) return depthPipeline;
    if (depthLoadPromise) return depthLoadPromise;
    depthLoading = true;
    depthError   = null;
    _updateStatus('loading');

    depthLoadPromise = (async () => { try {
      // Dynamic ESM import — works in all modern browsers
      const transformers = await import(
        'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2/dist/transformers.esm.min.js'
      );
      const { pipeline, env } = transformers;

      // Browser cache so model only downloads once
      env.allowLocalModels   = false;
      env.useBrowserCache    = true;
      env.backends.onnx.wasm.proxy = false;

      _updateStatus('downloading');

      const preferredDevice = options.device || CFG.device || (navigator.gpu ? 'webgpu' : 'wasm');
      const preferredDtype  = options.dtype || CFG.dtype || (preferredDevice === 'webgpu' ? 'fp32' : 'q8');

      try {
        if (preferredDevice === 'webgpu') {
          depthPipeline = await pipeline(
            'depth-estimation',
            'onnx-community/depth-anything-v2-small-hf',
            { dtype: 'fp32', device: 'webgpu' }
          );
          activeDevice = 'webgpu';
        } else {
          throw new Error('Fallback to WASM requested');
        }
      } catch (gpuErr) {
        if (window.VisionGuideConfig?.debug) {
          console.info('[VisionGuide Depth] WebGPU unavailable or failed, falling back to WASM q8:', gpuErr.message);
        }
        depthPipeline = await pipeline(
          'depth-estimation',
          'onnx-community/depth-anything-v2-small-hf',
          { dtype: preferredDtype || 'q8', device: 'wasm' }
        );
        activeDevice = 'wasm';
      }

      depthLoaded  = true;
      depthLoading = false;
      _updateStatus('ready');
      if (window.VisionGuideConfig?.debug) console.info(`[VisionGuide Depth] Depth-Anything-V2 ready on ${activeDevice}`);
      return depthPipeline;

    } catch (err) {
      depthError   = err.message || 'Model failed to load';
      depthLoading = false;
      activeDevice = 'none';
      _updateStatus('error');
      if (window.VisionGuideConfig?.debug) console.warn('[VisionGuide Depth] Model load failed — using heuristic:', err.message);
      return null;
    } finally {
      depthLoadPromise = null;
    }})();
    return depthLoadPromise;
  }

  /* ═══════════════════════════════════════════════════════════════
     DEPTH LOOP
  ═══════════════════════════════════════════════════════════════ */
  function startDepthLoop(videoEl) {
    if (loopActive) {
      loopVideo = videoEl;
      return;
    }

    loopVideo    = videoEl;
    loopActive   = true;
    loopGeneration++;
    if (!frameCanvas) {
      frameCanvas = document.createElement('canvas');
      frameCtx = frameCanvas.getContext('2d', { alpha: false });
    }

    // Kick off model if not yet started
    if (!depthLoaded && !depthLoading) loadModel();

    _scheduleDepth();
  }

  function stopDepthLoop() {
    loopActive = false;
    clearTimeout(loopTimer);
    loopTimer  = null;
    loopVideo  = null;
    depthData  = null;
    depthTimestamp = 0;
    trackDepth.clear();
    loopGeneration++;
  }

  function _scheduleDepth(delay = LOOP_INTERVAL) {
    if (!loopActive) return;
    clearTimeout(loopTimer);
    loopTimer = setTimeout(_runDepthFrame, delay);
  }

  async function _runDepthFrame() {
    if (!loopActive) return;
    const generation = loopGeneration;
    const frameVideo = loopVideo;

    if (!depthLoaded || !loopVideo ||
        loopVideo.readyState < 2 || loopVideo.videoWidth === 0) {
      _scheduleDepth();
      return;
    }

    // Cooperative scheduling: If surface segmentation or other heavy model is running, postpone!
    if (window.VisionGuidePipelineBusy) {
      _scheduleDepth(300);
      return;
    }

    window.VisionGuidePipelineBusy = true;
    try {
      // 1. Capture video frame (scale to mobile budget: 384 max edge)
      const vw = frameVideo.videoWidth;
      const vh = frameVideo.videoHeight;
      const maxEdge = CFG.maxInputEdge || 384;
      const scale = Math.min(1, maxEdge / Math.max(vw, vh));
      const inputW = Math.max(1, Math.round(vw * scale));
      const inputH = Math.max(1, Math.round(vh * scale));
      if (frameCanvas.width !== inputW) frameCanvas.width = inputW;
      if (frameCanvas.height !== inputH) frameCanvas.height = inputH;
      frameCtx.drawImage(frameVideo, 0, 0, inputW, inputH);

      // 2. Run Depth-Anything-V2
      const result = await depthPipeline(frameCanvas);
      if (!loopActive || generation !== loopGeneration) return;
      if (frameVideo !== loopVideo) { _scheduleDepth(); return; }

      if (result && result.predicted_depth) {
        const tensor = result.predicted_depth;
        const raw    = tensor.data;
        const dims   = tensor.dims || [];
        if (!raw?.length) { tensor.dispose?.(); throw new Error('Depth model returned an empty tensor'); }

        // Handle [H,W], [1,H,W], or [1,1,H,W].
        if (dims.length === 2) {
          depthH = dims[0]; depthW = dims[1];
        } else if (dims.length === 3) {
          depthH = dims[1]; depthW = dims[2];
        } else if (dims.length === 4) {
          depthH = dims[2]; depthW = dims[3];
        } else { tensor.dispose?.(); throw new Error('Depth model returned unsupported dimensions'); }
        if (!depthW || !depthH || depthW * depthH > raw.length) { tensor.dispose?.(); throw new Error('Depth tensor dimensions are invalid'); }

        // Robust per-frame normalization using reusable pre-allocated buffer (zero GC)
        const stride = Math.max(1, Math.floor(raw.length / 4096));
        let count = 0;
        for (let i = 0; i < raw.length && count < 4096; i += stride) {
          if (Number.isFinite(raw[i])) sampledBuffer[count++] = raw[i];
        }
        if (count === 0) { tensor.dispose?.(); throw new Error('Depth model returned no finite values'); }
        const slice = sampledBuffer.subarray(0, count).sort();
        const q = p => slice[Math.min(count - 1, Math.max(0, Math.floor((count - 1) * p)))];
        depthSceneMin = q(CFG.lowQuantile ?? 0.05);
        depthSceneMax = q(CFG.highQuantile ?? 0.95);

        // Reuse pre-allocated Float32Array to eliminate 1MB heap allocation on every frame
        if (!depthData || depthData.length !== raw.length) {
          depthData = new Float32Array(raw.length);
        }
        depthData.set(raw);
        depthTimestamp = Date.now();
        tensor.dispose?.();
      }
    } catch (err) {
      depthError = err.message || 'Depth inference failed';
      if (window.VisionGuideConfig?.debug) console.warn('[VisionGuide Depth] Frame error:', err.message);
    } finally {
      window.VisionGuidePipelineBusy = false;
    }

    _scheduleDepth();
  }

  /* ═══════════════════════════════════════════════════════════════
     DISTANCE ESTIMATION
  ═══════════════════════════════════════════════════════════════ */
  /**
   * Get distance zone for a detected object's bounding box.
   * @param {number[]} bbox   - [x, y, w, h] in video-stream pixels
   * @param {number}   videoW - video stream width
   * @param {number}   videoH - video stream height
   * @returns {object} zone info from ZONES
   */
  function getDistanceForBBox(bbox, videoW, videoH, trackId) {
    if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(Number.isFinite) || bbox[2] <= 0 || bbox[3] <= 0 || !videoW || !videoH) {
      return _withMeta(ZONES.medium, 'unknown', null, true);
    }

    // ── Relative Depth-Anything-V2 map ───────────────────────────
    const fresh = depthTimestamp && Date.now() - depthTimestamp <= (CFG.staleAfterMs || 6500);
    if (fresh && depthData && depthW > 0 && depthH > 0) {
      const normalizedDepth = _sampleDepthAtBBox(bbox, videoW, videoH);
      if (normalizedDepth !== null) {
        let smoothed = normalizedDepth;
        if (trackId !== undefined && trackId !== null) {
          const previous = trackDepth.get(trackId);
          const alpha = CFG.trackSmoothing ?? 0.55;
          smoothed = previous === undefined ? normalizedDepth : previous * (1-alpha) + normalizedDepth * alpha;
          trackDepth.set(trackId, smoothed);
        }
        return _withMeta(_normalizedDepthToZone(smoothed), 'relative-depth', smoothed, false);
      }
    }

    // ── Fallback: bounding-box area heuristic ────────────────────
    return _areaHeuristic(bbox, videoW, videoH);
  }

  /**
   * Sample depth tensor at bounding-box region using a 3×3 grid.
   * Returns median normalized depth value [0, 1], or null on failure.
   */
  function _sampleDepthAtBBox(bbox, videoW, videoH) {
    const [bx, by, bw, bh] = bbox;
    const samples = [];

    // Sample a 3×3 grid in the center 60% of the bounding box
    for (let fy = 0.2; fy <= 0.8; fy += 0.3) {
      for (let fx = 0.2; fx <= 0.8; fx += 0.3) {
        const nx = Math.max(0, Math.min(1, (bx + bw * fx) / videoW));
        const ny = Math.max(0, Math.min(1, (by + bh * fy) / videoH));
        const px = Math.min(depthW - 1, Math.floor(nx * depthW));
        const py = Math.min(depthH - 1, Math.floor(ny * depthH));
        const idx = py * depthW + px;
        if (idx >= 0 && idx < depthData.length) {
          samples.push(depthData[idx]);
        }
      }
    }

    if (samples.length === 0) return null;

    // Median (robust to outliers)
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)];

    // Normalize to [0, 1] within scene
    const range = depthSceneMax - depthSceneMin;
    if (range < 1e-6) return 0.5;
    return Math.max(0, Math.min(1, (median - depthSceneMin) / range));
  }

  /**
   * Map normalized inverse depth [0-1] to a relative distance zone.
   * Depth Anything V2 convention: higher prediction = closer object.
   */
  function _normalizedDepthToZone(nd) {
    if (nd >= 0.78) return ZONES.danger;
    if (nd >= 0.58) return ZONES.close;
    if (nd >= 0.34) return ZONES.medium;
    return ZONES.far;
  }

  /**
   * Fallback heuristic: larger bounding box → closer object.
   */
  function _areaHeuristic(bbox, videoW, videoH) {
    const [, , bw, bh] = bbox;
    const fraction = (bw * bh) / (videoW * videoH);
    if (fraction > 0.22) return _withMeta(ZONES.danger, 'size-heuristic', null, true);
    if (fraction > 0.08) return _withMeta(ZONES.close, 'size-heuristic', null, true);
    if (fraction > 0.02) return _withMeta(ZONES.medium, 'size-heuristic', null, true);
    return _withMeta(ZONES.far, 'size-heuristic', null, true);
  }

  function _withMeta(zone, source, relativeDepth, uncertain) {
    const qualifier = uncertain ? 'appears ' : '';
    return {
      ...zone,
      label: qualifier + zone.label,
      detail: qualifier + zone.detail,
      speech: qualifier + zone.speech,
      source,
      relativeDepth,
      uncertain
    };
  }

  /* ═══════════════════════════════════════════════════════════════
     UI STATUS BADGE
  ═══════════════════════════════════════════════════════════════ */
  function _updateStatus(status) {
    const badge = document.getElementById('depth-status-badge');
    if (!badge) return;

    const MAP = {
      loading:     { text: '⏳ Loading depth model…',         cls: 'depth-badge-loading'     },
      downloading: { text: '⬇ Downloading Depth-Anything-V2…', cls: 'depth-badge-downloading' },
      ready:       { text: 'Depth model ready',                cls: 'depth-badge-ready'       },
      error:       { text: 'Using size-based range',           cls: 'depth-badge-heuristic'   },
    };

    const info = MAP[status] || { text: status, cls: '' };
    badge.textContent = info.text;
    badge.className   = `depth-status-badge ${info.cls}`;
  }

})();
