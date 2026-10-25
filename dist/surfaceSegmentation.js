// ═══════════════════════════════════════════════════════════════════
//  VisionGuide — Surface Segmentation Module
//
//  Evaluated lightweight segmentation options:
//    1. SegFormer-B0 (ADE20K - 512×512) [SELECTED]:
//       • Size: ~3.8 MB quantized ONNX, ~14.8 MB fp32.
//       • Classes: 150 ADE20K classes including road (6), sidewalk (11),
//         stairs (53/12), wall (0), floor (3), earth/ground (13), path (52).
//       • Latency: ~30–65 ms on WebGPU, ~150–350 ms on WASM.
//       • Runtime: ONNX Runtime Web via @huggingface/transformers.
//       • License: NVIDIA Source Code License (Research/Evaluation).
//    2. SegFormer-B0 (Cityscapes):
//       • Lacks stairs and indoor floor classes; rejected for comprehensive navigation.
//    3. DeepLabv3 (MobileNetV2 / V3):
//       • Pascal VOC lacks road/sidewalk/stairs. ADE20K variants on TF.js require
//         large WebGL buffers (6–18 MB) that compete with MapLibre GL contexts.
//
//  CRITICAL SAFETY NOTICE:
//  Surface segmentation distinguishes terrain and structural types, but
//  sidewalk or road segmentation ALONE NEVER GUARANTEES A SAFE ROUTE.
//  Walking surfaces frequently contain drop-offs, potholes, steps, street furniture,
//  bicycles, and dynamic obstacles. Surface cues MUST fuse with obstacle detection
//  and depth discontinuity analysis.
//
//  Exposes: window.surfaceSegmentationAPI
// ═══════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  const CFG = window.VisionGuideConfig?.surface || {};

  /* ─── Standardized Surface Categories ────────────────────────── */
  const CATEGORIES = Object.freeze([
    'footpath',   // Designated pedestrian surface (sidewalk, path, walkway)
    'road',       // Vehicular roadway (road, street, highway)
    'stairs',     // Step/stairway structures (stairs, step)
    'wall',       // Non-walkable vertical barriers (wall, building, fence)
    'floor',      // Indoor ground walking surface
    'terrain',    // Natural ground (earth, grass, dirt, sand)
    'unknown'     // Unmapped, low confidence, ambiguous, or sky
  ]);

  /* ─── Class Label to Category Mapping Dictionary ─────────────── */
  // Supports both ADE20K (150 classes) and Cityscapes (19 classes) label strings.
  const LABEL_MAP = {
    // Footpaths / Sidewalks
    'sidewalk': 'footpath',
    'footpath': 'footpath',
    'path': 'footpath',
    'pavement': 'footpath',
    'walkway': 'footpath',
    'pathway': 'footpath',
    'walk': 'footpath',
    'pedestrian': 'footpath',

    // Vehicular roads
    'road': 'road',
    'street': 'road',
    'highway': 'road',
    'carriageway': 'road',
    'lane': 'road',
    'runway': 'road',

    // Stairs / Steps
    'stairs': 'stairs',
    'stairway': 'stairs',
    'step': 'stairs',
    'steps': 'stairs',
    'stair': 'stairs',
    'escalator': 'stairs',

    // Walls / Barriers / Structures
    'wall': 'wall',
    'building': 'wall',
    'fence': 'wall',
    'barrier': 'wall',
    'railing': 'wall',
    'curtain-wall': 'wall',
    'column': 'wall',
    'pillar': 'wall',
    'door': 'wall',

    // Indoor floor
    'floor': 'floor',
    'flooring': 'floor',
    'indoor-floor': 'floor',
    'rug': 'floor',
    'carpet': 'floor',

    // Natural terrain
    'earth': 'terrain',
    'ground': 'terrain',
    'grass': 'terrain',
    'dirt': 'terrain',
    'sand': 'terrain',
    'gravel': 'terrain',
    'field': 'terrain',
    'lawn': 'terrain',
    'soil': 'terrain',
    'land': 'terrain',

    // Non-ground elements mapped to unknown / obstacle
    'sky': 'unknown',
    'tree': 'unknown',
    'plant': 'unknown',
    'vegetation': 'unknown',
    'person': 'unknown',
    'car': 'unknown',
    'pole': 'unknown',
    'sign': 'unknown',
    'ceiling': 'unknown'
  };

  /* ─── State ─────────────────────────────────────────────────── */
  let modelPipeline   = null;
  let modelLoading    = false;
  let modelLoaded     = false;
  let modelError      = null;
  let loadPromise     = null;
  let activeDevice    = 'none';

  let surfaceMap      = null;   // latest processed surface summary
  let surfaceTimestamp = 0;
  let lastLatencyMs   = 0;

  // Background loop state
  let loopActive      = false;
  let loopTimer       = null;
  let loopVideo       = null;
  let loopGeneration  = 0;
  const LOOP_INTERVAL = CFG.intervalMs || 3500;

  // Reusable scratch canvas
  let scratchCanvas   = null;
  let scratchCtx      = null;

  /* ─── Public API ─────────────────────────────────────────────── */
  window.surfaceSegmentationAPI = {
    loadModel,
    startSurfaceLoop,
    stopSurfaceLoop,
    getSurfaceMap: () => surfaceMap && surfaceTimestamp && (Date.now() - surfaceTimestamp <= (CFG.staleAfterMs || 7000)) ? surfaceMap : null,
    getSurfaceAge: () => surfaceTimestamp ? Date.now() - surfaceTimestamp : Infinity,
    isLoaded:      () => modelLoaded,
    isLoading:     () => modelLoading,
    getError:      () => modelError,
    getDevice:     () => activeDevice,
    isActive:      () => loopActive,
    mapLabelToCategory,
    parseSegmentationOutput,
    measureLatency,
    reset: () => {
      stopSurfaceLoop();
      surfaceMap = null;
      surfaceTimestamp = 0;
      lastLatencyMs = 0;
    }
  };

  /* ═══════════════════════════════════════════════════════════════
     CLASS MAPPING & UNKNOWN REGION HANDLING
  ═══════════════════════════════════════════════════════════════ */
  /**
   * Maps model output label and confidence score to a verified navigation category.
   * Distinguishes unknown regions from known surfaces.
   */
  function mapLabelToCategory(label, score = 1.0) {
    if (!label || typeof label !== 'string') return 'unknown';
    const minConf = CFG.confidenceThreshold ?? 0.40;
    if (Number.isFinite(score) && score < minConf) return 'unknown';

    const normalized = label.toLowerCase().trim().replace(/[-_\s]+/g, '-');
    if (LABEL_MAP[normalized]) return LABEL_MAP[normalized];

    // Token-based fallback for compound label names (e.g. "stone-stairs", "brick-sidewalk")
    const tokens = normalized.split('-');
    for (let i = tokens.length - 1; i >= 0; i--) {
      const token = tokens[i];
      if (LABEL_MAP[token] && LABEL_MAP[token] !== 'unknown') {
        return LABEL_MAP[token];
      }
    }

    return 'unknown';
  }

  /* ═══════════════════════════════════════════════════════════════
     MODEL LOADING & HARDWARE FALLBACK (WebGPU -> WASM)
  ═══════════════════════════════════════════════════════════════ */
  async function loadModel(options = {}) {
    if (modelLoaded) return modelPipeline;
    if (loadPromise) return loadPromise;

    modelLoading = true;
    modelError = null;
    _updateBadge('⏳ Loading surface model…', 'od-badge-loading');

    loadPromise = (async () => {
      try {
        const transformers = await import(
          'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2/dist/transformers.esm.min.js'
        );
        const { pipeline, env } = transformers;

        env.allowLocalModels = false;
        env.useBrowserCache  = true;
        env.backends.onnx.wasm.proxy = false;

        const modelId = options.modelId || CFG.modelId || 'Xenova/segformer-b0-finetuned-ade-512-512';
        const preferredDevice = options.device || (navigator.gpu ? 'webgpu' : 'wasm');

        _updateBadge('⏳ Downloading surface model…', 'od-badge-loading');

        try {
          if (preferredDevice === 'webgpu') {
            modelPipeline = await pipeline('image-segmentation', modelId, {
              dtype: 'fp32',
              device: 'webgpu'
            });
            activeDevice = 'webgpu';
          } else {
            throw new Error('Fallback to WASM requested');
          }
        } catch (gpuErr) {
          if (window.VisionGuideConfig?.debug) {
            console.info('[VisionGuide Surface] WebGPU unavailable or failed, falling back to WASM:', gpuErr.message);
          }
          modelPipeline = await pipeline('image-segmentation', modelId, {
            dtype: 'q8',
            device: 'wasm'
          });
          activeDevice = 'wasm';
        }

        modelLoaded = true;
        modelLoading = false;
        _updateBadge(`✅ Surface ready (${activeDevice.toUpperCase()})`, 'od-badge-ready');
        if (window.VisionGuideConfig?.debug) {
          console.info(`[VisionGuide Surface] SegFormer model loaded on ${activeDevice}`);
        }
        return modelPipeline;

      } catch (err) {
        modelError = err.message || 'Surface segmentation failed to load';
        modelLoaded = false;
        modelLoading = false;
        activeDevice = 'none';
        _updateBadge('Surface model unavailable · heuristic fallback', 'od-badge-error');
        if (window.VisionGuideConfig?.debug) {
          console.warn('[VisionGuide Surface] Load failed — continuing with depth & obstacle analysis:', err.message);
        }
        return null;
      } finally {
        loadPromise = null;
      }
    })();

    return loadPromise;
  }

  // Pre-allocated accumulator pool (eliminates GC allocations during mask parsing)
  const _parsedGridCells = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 5; c++) {
      _parsedGridCells.push({
        r, c,
        pixels: 0,
        counts: { footpath: 0, road: 0, stairs: 0, wall: 0, floor: 0, terrain: 0, unknown: 0 },
        confSum: 0
      });
    }
  }

  /* ═══════════════════════════════════════════════════════════════
     PARSING MODEL OUTPUTS & GRID AGGREGATION
  ═══════════════════════════════════════════════════════════════ */
  /**
   * Parses raw segmentation output into per-category coverage and 5x3 navigation grid shares.
   *
   * @param {Array|Object} rawResult  — pipeline segments or tensor masks
   * @param {number}       width      — source image width
   * @param {number}       height     — source image height
   * @returns {Object} SurfaceMap
   */
  function parseSegmentationOutput(rawResult, width, height) {
    const W = Math.max(1, Number(width) || 300);
    const H = Math.max(1, Number(height) || 300);
    const COLS = 5;
    const ROWS = 3;

    // Output category area accumulators
    const categoryPixels = {
      footpath: 0, road: 0, stairs: 0, wall: 0, floor: 0, terrain: 0, unknown: 0
    };

    // Reset pre-allocated 5x3 grid cell accumulators in-place
    for (let i = 0; i < _parsedGridCells.length; i++) {
      const g = _parsedGridCells[i];
      g.pixels = 0;
      g.confSum = 0;
      g.counts.footpath = 0;
      g.counts.road = 0;
      g.counts.stairs = 0;
      g.counts.wall = 0;
      g.counts.floor = 0;
      g.counts.terrain = 0;
      g.counts.unknown = 0;
    }
    const gridCells = _parsedGridCells;

    const segments = Array.isArray(rawResult) ? rawResult : (rawResult ? [rawResult] : []);
    let totalMaskPixels = 0;

    segments.forEach(segment => {
      const label = segment.label || 'unknown';
      const score = Number.isFinite(segment.score) ? segment.score : 0.8;
      const category = mapLabelToCategory(label, score);
      const mask = segment.mask;

      if (!mask || !mask.data) return;

      const maskData = mask.data;
      const mw = mask.width || W;
      const mh = mask.height || H;

      const scaleX = mw / W;
      const scaleY = mh / H;

      for (let r = 0; r < ROWS; r++) {
        const y0 = Math.floor((r / ROWS) * H);
        const y1 = Math.floor(((r + 1) / ROWS) * H);
        const my0 = Math.min(mh - 1, Math.floor(y0 * scaleY));
        const my1 = Math.min(mh, Math.ceil(y1 * scaleY));

        for (let c = 0; c < COLS; c++) {
          const x0 = Math.floor((c / COLS) * W);
          const x1 = Math.floor(((c + 1) / COLS) * W);
          const mx0 = Math.min(mw - 1, Math.floor(x0 * scaleX));
          const mx1 = Math.min(mw, Math.ceil(x1 * scaleX));

          const cell = gridCells[r * COLS + c];
          let matched = 0;

          // Sample pixels in this grid cell block
          const stepY = Math.max(1, Math.floor((my1 - my0) / 10));
          const stepX = Math.max(1, Math.floor((mx1 - mx0) / 10));

          for (let my = my0; my < my1; my += stepY) {
            for (let mx = mx0; mx < mx1; mx += stepX) {
              const val = maskData[my * mw + mx];
              if (val > 0) matched++;
            }
          }

          if (matched > 0) {
            cell.counts[category] += matched;
            cell.pixels += matched;
            cell.confSum += matched * score;
            categoryPixels[category] += matched;
            totalMaskPixels += matched;
          }
        }
      }
    });

    // Compute shares and primary category per cell
    const cellSummary = gridCells.map(cell => {
      const total = cell.pixels || 1;
      const shares = {
        footpath: cell.counts.footpath / total,
        road:     cell.counts.road / total,
        stairs:   cell.counts.stairs / total,
        wall:     cell.counts.wall / total,
        floor:    cell.counts.floor / total,
        terrain:  cell.counts.terrain / total,
        unknown:  cell.counts.unknown / total
      };

      // Determine top category
      let primaryCategory = 'unknown';
      let maxShare = 0;
      for (const [cat, share] of Object.entries(shares)) {
        if (share > maxShare) {
          maxShare = share;
          primaryCategory = cat;
        }
      }

      // If no strong confidence or coverage, default to unknown
      if (maxShare < 0.35 || cell.pixels === 0) {
        primaryCategory = 'unknown';
      }

      const avgConfidence = cell.pixels ? cell.confSum / cell.pixels : 0;
      return {
        r: cell.r,
        c: cell.c,
        primaryCategory,
        confidence: Math.round(avgConfidence * 100) / 100,
        shares
      };
    });

    // Compute zone summaries (Left: c=0,1; Center: c=2; Right: c=3,4)
    const computeZone = colRange => {
      const zoneCells = cellSummary.filter(c => c.c >= colRange[0] && c.c <= colRange[1]);
      const agg = { footpath: 0, road: 0, stairs: 0, wall: 0, floor: 0, terrain: 0, unknown: 0 };
      zoneCells.forEach(cell => {
        for (const [k, v] of Object.entries(cell.shares)) agg[k] += v;
      });
      const count = zoneCells.length || 1;
      const pct = cat => Math.round((agg[cat] / count) * 100);

      let top = 'unknown', topShare = 0;
      for (const [k, v] of Object.entries(agg)) {
        if (v > topShare) { topShare = v; top = k; }
      }
      return {
        primaryCategory: topShare / count >= 0.30 ? top : 'unknown',
        footpathPct: pct('footpath'),
        roadPct:     pct('road'),
        stairsPct:   pct('stairs'),
        wallPct:     pct('wall'),
        floorPct:    pct('floor'),
        terrainPct:  pct('terrain')
      };
    };

    const totalCalculated = Math.max(1, totalMaskPixels);
    const overallShares = {
      footpath: Math.round((categoryPixels.footpath / totalCalculated) * 100),
      road:     Math.round((categoryPixels.road / totalCalculated) * 100),
      stairs:   Math.round((categoryPixels.stairs / totalCalculated) * 100),
      wall:     Math.round((categoryPixels.wall / totalCalculated) * 100),
      floor:    Math.round((categoryPixels.floor / totalCalculated) * 100),
      terrain:  Math.round((categoryPixels.terrain / totalCalculated) * 100)
    };

    return {
      timestamp: Date.now(),
      width: W,
      height: H,
      device: activeDevice,
      overallShares,
      cells: cellSummary,
      zones: {
        left:   computeZone([0, 1]),
        center: computeZone([2, 2]),
        right:  computeZone([3, 4])
      }
    };
  }

  /* ═══════════════════════════════════════════════════════════════
     SURFACE EXECUTION LOOP
  ═══════════════════════════════════════════════════════════════ */
  function startSurfaceLoop(videoEl) {
    if (loopActive) {
      loopVideo = videoEl;
      return;
    }

    loopVideo = videoEl;
    loopActive = true;
    loopGeneration++;

    if (!scratchCanvas) {
      scratchCanvas = document.createElement('canvas');
      scratchCtx = scratchCanvas.getContext('2d', { alpha: false });
    }

    if (!modelLoaded && !modelLoading) {
      loadModel();
    }

    _scheduleNext();
  }

  function stopSurfaceLoop() {
    loopActive = false;
    clearTimeout(loopTimer);
    loopTimer = null;
    loopVideo = null;
    surfaceMap = null;
    surfaceTimestamp = 0;
    loopGeneration++;
  }

  function _scheduleNext(delay = LOOP_INTERVAL) {
    if (!loopActive) return;
    clearTimeout(loopTimer);
    loopTimer = setTimeout(_runSurfaceFrame, delay);
  }

  async function _runSurfaceFrame() {
    if (!loopActive) return;
    const generation = loopGeneration;
    const frameVideo = loopVideo;

    if (!modelLoaded || !frameVideo || frameVideo.readyState < 2 || frameVideo.videoWidth === 0) {
      _scheduleNext();
      return;
    }

    // Cooperative scheduling: If depth or other heavy model is running, postpone!
    if (window.VisionGuidePipelineBusy) {
      _scheduleNext(350);
      return;
    }

    window.VisionGuidePipelineBusy = true;
    const t0 = performance.now();
    try {
      const vw = frameVideo.videoWidth;
      const vh = frameVideo.videoHeight;
      const maxEdge = CFG.maxInputEdge || 384;
      const scale = Math.min(1, maxEdge / Math.max(vw, vh));
      const inW = Math.max(1, Math.round(vw * scale));
      const inH = Math.max(1, Math.round(vh * scale));

      if (scratchCanvas.width !== inW) scratchCanvas.width = inW;
      if (scratchCanvas.height !== inH) scratchCanvas.height = inH;
      scratchCtx.drawImage(frameVideo, 0, 0, inW, inH);

      const rawResult = await modelPipeline(scratchCanvas);
      if (!loopActive || generation !== loopGeneration) return;

      const parsed = parseSegmentationOutput(rawResult, vw, vh);
      lastLatencyMs = Math.round(performance.now() - t0);
      parsed.latencyMs = lastLatencyMs;

      surfaceMap = parsed;
      surfaceTimestamp = Date.now();

    } catch (err) {
      if (window.VisionGuideConfig?.debug) {
        console.warn('[VisionGuide Surface] Frame inference error:', err.message);
      }
    } finally {
      window.VisionGuidePipelineBusy = false;
    }

    _scheduleNext();
  }

  /* ═══════════════════════════════════════════════════════════════
     LATENCY BENCHMARKING
  ═══════════════════════════════════════════════════════════════ */
  async function measureLatency(options = {}) {
    const runs = options.runs || 3;
    const testCanvas = scratchCanvas || document.createElement('canvas');
    testCanvas.width = options.width || 512;
    testCanvas.height = options.height || 512;
    const ctx = testCanvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, testCanvas.width, testCanvas.height);

    if (!modelLoaded) {
      await loadModel(options);
    }
    if (!modelPipeline) {
      return { success: false, error: modelError || 'Model not loaded', device: 'none' };
    }

    const durations = [];
    for (let i = 0; i < runs; i++) {
      const start = performance.now();
      await modelPipeline(testCanvas);
      durations.push(performance.now() - start);
    }

    const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
    return {
      success: true,
      device: activeDevice,
      averageMs: Math.round(avg),
      runs: durations.map(d => Math.round(d))
    };
  }

  /* ─── Helpers ────────────────────────────────────────────────── */
  function _updateBadge(text, cls) {
    const el = document.getElementById('surface-status-badge');
    if (el) {
      el.textContent = text;
      el.className = `surface-status-badge ${cls}`;
    }
  }

})();
