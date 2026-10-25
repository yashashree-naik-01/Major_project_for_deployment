// ═══════════════════════════════════════════════════════════════════
//  VisionGuide — YOLOv8 Custom ONNX Stair Detector
//
//  Detects stair structures from camera frames using a custom trained
//  YOLOv8n ONNX model (Input: [1, 3, 416, 416], Output: [1, 6, 3549]).
//
//  Key Architectural Features:
//    1. Letterbox Preprocessing (aspect-ratio preserved padding to 416x416).
//    2. Planar NCHW Float32 Normalization ([0..255] -> [0.0..1.0]).
//    3. Model Output Decoding (center-x, center-y, width, height, class probs).
//    4. Greedy Non-Maximum Suppression (IoU >= 0.45 suppression).
//    5. Multi-Modal Depth Fusion:
//       • A 2D bounding box alone NEVER determines ascending vs descending!
//       • Fused with relative depth geometry to distinguish:
//         - 'stairs-down' (critical hazard -> STOP)
//         - 'stairs-up' (high hazard -> CAUTION)
//         - 'stairs-ambiguous' (uncertain -> CAUTIOUS WARNING)
//    6. Pure functions decoupled from DOM/WebGL for Node.js unit testing.
//
//  Exposes: window.stairDetectorAPI
// ═══════════════════════════════════════════════════════════════════
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.stairDetectorAPI = factory();
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  /* ─── Model Specifications ───────────────────────────────────── */
  const TARGET_SIZE = 416;
  const NUM_ANCHORS = 3549;
  const CLASS_STAIRS_IDX = 1; // Class 0: 'object', Class 1: 'stairs'
  const DEFAULT_CONF_THRESHOLD = 0.25;
  const CONFIDENT_THRESHOLD = 0.45;
  const DEFAULT_IOU_THRESHOLD = 0.45;
  const MODEL_PATH = '/models/stairs-yolov8n.onnx';

  /* ─── State ─────────────────────────────────────────────────── */
  let ortSession = null;
  let modelLoading = false;
  let modelLoaded = false;
  let modelError = null;
  let loadPromise = null;
  let scratchCanvas = null;
  let scratchCtx = null;

  /* ═══════════════════════════════════════════════════════════════
     1. PURE PREPROCESSING: LETTERBOX GEOMETRY
  ═══════════════════════════════════════════════════════════════ */
  /**
   * Calculates aspect-ratio preserving letterbox dimensions and offsets.
   *
   * @param {number} srcW - Source image width
   * @param {number} srcH - Source image height
   * @param {number} targetSize - Model input dimension (416)
   * @returns {{ r: number, scaledW: number, scaledH: number, dx: number, dy: number, targetSize: number }}
   */
  function preprocessLetterbox(srcW, srcH, targetSize = TARGET_SIZE) {
    if (!srcW || !srcH || srcW <= 0 || srcH <= 0) {
      return { r: 1, scaledW: targetSize, scaledH: targetSize, dx: 0, dy: 0, targetSize };
    }
    const r = Math.min(targetSize / srcW, targetSize / srcH);
    const scaledW = Math.round(srcW * r);
    const scaledH = Math.round(srcH * r);
    const dx = Math.floor((targetSize - scaledW) / 2);
    const dy = Math.floor((targetSize - scaledH) / 2);
    return { r, scaledW, scaledH, dx, dy, targetSize };
  }

  /**
   * Converts ImageData RGBA buffer (HWC) into planar RGB Float32Array (NCHW).
   *
   * @param {Uint8ClampedArray|Uint8Array} rgba - Flat RGBA pixel buffer
   * @param {number} width - 416
   * @param {number} height - 416
   * @returns {Float32Array} - Planar NCHW [1, 3, 416, 416] normalized to [0..1]
   */
  function rgbaToPlanarRgbFloat32(rgba, width = TARGET_SIZE, height = TARGET_SIZE) {
    const planeSize = width * height;
    const float32 = new Float32Array(3 * planeSize);
    let p = 0;
    for (let i = 0; i < planeSize; i++) {
      float32[i] = rgba[p] / 255.0;                   // R plane
      float32[planeSize + i] = rgba[p + 1] / 255.0;   // G plane
      float32[2 * planeSize + i] = rgba[p + 2] / 255.0;// B plane
      p += 4;
    }
    return float32;
  }

  /* ═══════════════════════════════════════════════════════════════
     2. PURE OUTPUT DECODING & COORDINATE RESCALING
  ═══════════════════════════════════════════════════════════════ */
  /**
   * Decodes raw YOLOv8 output tensor of shape [1, 6, 3549].
   *
   * @param {Float32Array|Array<number>} tensorData - Flat output array of length 6 * numAnchors
   * @param {number} numAnchors - Number of anchor locations (3549)
   * @param {number} confThreshold - Minimum stair confidence to accept (0.25)
   * @param {number} srcW - Original image width for rescaling
   * @param {number} srcH - Original image height for rescaling
   * @param {Object} padInfo - Letterbox padding parameters { r, dx, dy }
   * @returns {Array<Object>} List of candidate bounding boxes
   */
  function decodeYOLOv8Output(tensorData, numAnchors = NUM_ANCHORS, confThreshold = DEFAULT_CONF_THRESHOLD, srcW = TARGET_SIZE, srcH = TARGET_SIZE, padInfo = null) {
    if (!tensorData || tensorData.length < 6 * numAnchors) {
      return [];
    }

    const { r = 1, dx = 0, dy = 0 } = padInfo || preprocessLetterbox(srcW, srcH, TARGET_SIZE);
    const candidates = [];

    // Rows in YOLOv8 output tensor:
    // Row 0: cx, Row 1: cy, Row 2: w, Row 3: h, Row 4: class 0 (object), Row 5: class 1 (stairs)
    const rowCx = 0;
    const rowCy = numAnchors;
    const rowW = 2 * numAnchors;
    const rowH = 3 * numAnchors;
    const rowStairs = (4 + CLASS_STAIRS_IDX) * numAnchors;

    for (let i = 0; i < numAnchors; i++) {
      const score = tensorData[rowStairs + i];
      if (score < confThreshold || !Number.isFinite(score)) {
        continue;
      }

      const cx = tensorData[rowCx + i];
      const cy = tensorData[rowCy + i];
      const w = tensorData[rowW + i];
      const h = tensorData[rowH + i];

      if (w <= 1 || h <= 1) continue;

      // 416 space corners
      const x1_416 = cx - w / 2;
      const y1_416 = cy - h / 2;
      const x2_416 = cx + w / 2;
      const y2_416 = cy + h / 2;

      // Unpad and scale back to source coordinates
      const x1 = Math.max(0, Math.min(srcW, (x1_416 - dx) / r));
      const y1 = Math.max(0, Math.min(srcH, (y1_416 - dy) / r));
      const x2 = Math.max(0, Math.min(srcW, (x2_416 - dx) / r));
      const y2 = Math.max(0, Math.min(srcH, (y2_416 - dy) / r));

      const boxW = x2 - x1;
      const boxH = y2 - y1;

      if (boxW < 6 || boxH < 6) continue;

      candidates.push({
        bbox: [Math.round(x1), Math.round(y1), Math.round(boxW), Math.round(boxH)],
        score,
        confidence: score >= CONFIDENT_THRESHOLD ? 'confident' : 'uncertain',
        class: 'stairs',
        classId: CLASS_STAIRS_IDX
      });
    }

    return candidates;
  }

  /* ═══════════════════════════════════════════════════════════════
     3. PURE NON-MAXIMUM SUPPRESSION (NMS)
  ═══════════════════════════════════════════════════════════════ */
  /**
   * Greedy Non-Maximum Suppression for bounding boxes.
   *
   * @param {Array<Object>} candidates - Decoded candidate boxes
   * @param {number} iouThreshold - IoU threshold for overlap suppression (0.45)
   * @returns {Array<Object>} Suppressed, non-overlapping boxes
   */
  function runNMS(candidates, iouThreshold = DEFAULT_IOU_THRESHOLD) {
    if (!candidates || candidates.length <= 1) return candidates || [];

    // Sort descending by score
    const sorted = [...candidates].sort((a, b) => b.score - a.score);
    const selected = [];
    const suppressed = new Uint8Array(sorted.length);

    for (let i = 0; i < sorted.length; i++) {
      if (suppressed[i]) continue;
      const a = sorted[i];
      selected.push(a);

      const [ax1, ay1, aw, ah] = a.bbox;
      const ax2 = ax1 + aw;
      const ay2 = ay1 + ah;
      const areaA = aw * ah;

      for (let j = i + 1; j < sorted.length; j++) {
        if (suppressed[j]) continue;
        const b = sorted[j];
        const [bx1, by1, bw, bh] = b.bbox;
        const bx2 = bx1 + bw;
        const by2 = by1 + bh;
        const areaB = bw * bh;

        // Intersection box
        const ix1 = Math.max(ax1, bx1);
        const iy1 = Math.max(ay1, by1);
        const ix2 = Math.min(ax2, bx2);
        const iy2 = Math.min(ay2, by2);
        const iw = Math.max(0, ix2 - ix1);
        const ih = Math.max(0, iy2 - iy1);
        const interArea = iw * ih;

        if (interArea > 0) {
          const unionArea = areaA + areaB - interArea;
          const iou = unionArea > 0 ? interArea / unionArea : 0;
          if (iou >= iouThreshold) {
            suppressed[j] = 1;
          }
        }
      }
    }

    return selected;
  }

  /* ═══════════════════════════════════════════════════════════════
     4. MULTI-MODAL DEPTH FUSION
     CRITICAL SAFETY INVARIANT:
     A 2D bounding box alone NEVER determines ascending vs descending!
     Depth evidence must resolve whether treads fall away (down) or climb (up).
  ═══════════════════════════════════════════════════════════════ */
  /**
   * Fuses a detected stair bounding box with scene depth geometry.
   *
   * @param {Object} stairBox - Bounding box detection { bbox, score, confidence }
   * @param {Object} depthMap - Relative depth map { data, width, height, sceneMin, sceneMax }
   * @param {Array<number>} floorBaseline - Per-row ground disparity baseline
   * @param {number} range - Scene depth dynamic range
   * @param {number} vw - Frame width
   * @param {number} vh - Frame height
   * @returns {Object} Fused stair hazard object
   */
  function fuseStairsWithDepth(stairBox, depthMap, floorBaseline, range, vw, vh) {
    const [bx, by, bw, bh] = stairBox.bbox;
    const cx = bx + bw / 2;
    const side = cx < 0.38 * vw ? 'left' : (cx > 0.62 * vw ? 'right' : 'center');
    const bottomY = by + bh;
    const row = bottomY > 0.65 * vh ? 'near' : (bottomY > 0.35 * vh ? 'mid' : 'far');
    const isNear = row === 'near';

    let category = 'stairs-ambiguous';
    let riskLevel = 'medium';
    let alertMessage = 'Possible stairs ahead. Stop and check before proceeding.';
    let isDescending = false;
    let isAscending = false;

    if (depthMap && depthMap.data && range && range > 0.05 && floorBaseline) {
      const { data, width: dw, height: dh } = depthMap;

      // Sample interior depth of the bounding box
      const x0 = Math.max(0, Math.floor((bx / vw) * dw));
      const x1 = Math.min(dw - 1, Math.floor(((bx + bw) / vw) * dw));
      const y0 = Math.max(0, Math.floor((by / vh) * dh));
      const y1 = Math.min(dh - 1, Math.floor(((by + bh) / vh) * dh));

      const midSamples = [];
      const lowerSamples = [];
      const stepX = Math.max(1, Math.floor((x1 - x0) / 10));
      const stepY = Math.max(1, Math.floor((y1 - y0) / 10));
      const boxMidY = Math.floor((y0 + y1) / 2);

      for (let sy = y0; sy <= y1; sy += stepY) {
        for (let sx = x0; sx <= x1; sx += stepX) {
          const val = data[sy * dw + sx];
          if (Number.isFinite(val)) {
            // Expected depth at this specific normalized Y
            const normY = sy / dh; // 0 (far) to 1 (near)
            const expectedAtY = (floorBaseline[0] || 0.35) * (1 - normY) + (floorBaseline[2] || 0.80) * normY;
            const deltaAtY = (val - expectedAtY) / range;
            if (sy <= boxMidY) midSamples.push(deltaAtY);
            else lowerSamples.push(deltaAtY);
          }
        }
      }

      if (midSamples.length + lowerSamples.length >= 4) {
        const allDeltas = [...midSamples, ...lowerSamples].sort((a, b) => a - b);
        const medianDelta = allDeltas[Math.floor(allDeltas.length / 2)];
        const midDelta = midSamples.length ? midSamples.reduce((a, b) => a + b, 0) / midSamples.length : medianDelta;
        const lowerDelta = lowerSamples.length ? lowerSamples.reduce((a, b) => a + b, 0) / lowerSamples.length : medianDelta;

        // Downward stairs: lower/mid depths plunge below the ground baseline (void / drop-off)
        if (medianDelta <= -0.12 || lowerDelta <= -0.15) {
          isDescending = true;
        } else if (medianDelta >= 0.08 || midDelta >= 0.08) {
          // Upward stairs: mid ground steps rise closer to camera than flat floor continuation
          isAscending = true;
        }
      }
    }

    if (isDescending) {
      category = 'stairs-down';
      riskLevel = 'critical';
      alertMessage = stairBox.confidence === 'confident'
        ? 'Descending stairs ahead. Stop and check your step.'
        : 'Possible descending stairs ahead. Stop and check.';
    } else if (isAscending) {
      category = 'stairs-up';
      riskLevel = 'high';
      alertMessage = stairBox.confidence === 'confident'
        ? 'Stairs ahead leading up. Approach carefully.'
        : 'Possible steps ahead. Approach cautiously.';
    } else {
      category = 'stairs-ambiguous';
      riskLevel = 'medium';
      alertMessage = 'Possible stairs ahead. Stop and check before proceeding.';
    }

    return {
      category,
      type: category,
      label: category === 'stairs-down' ? 'Descending stairs' : (category === 'stairs-up' ? 'Ascending stairs' : 'Possible stairs'),
      riskLevel,
      confidence: stairBox.confidence,
      score: stairBox.score,
      bbox: stairBox.bbox,
      side,
      row,
      proximity: isNear ? 'immediate' : 'close',
      alertMessage,
      source: 'yolov8-stair-detector'
    };
  }

  /* ═══════════════════════════════════════════════════════════════
     5. BROWSER ONNX RUNTIME SESSION & DETECTION LOOP
  ═══════════════════════════════════════════════════════════════ */
  async function loadModel(options = {}) {
    if (modelLoaded) return ortSession;
    if (loadPromise) return loadPromise;

    modelLoading = true;
    modelError = null;

    loadPromise = (async () => {
      try {
        // Look for locally served ONNX Runtime Web first, fallback to window.ort
        const ort = typeof window !== 'undefined' ? window.ort : null;
        if (!ort || !ort.InferenceSession) {
          throw new Error('ONNX Runtime Web is not loaded. Ensure /vendor/onnxruntime/ort.all.min.js is included.');
        }

        const modelUrl = options.modelPath || MODEL_PATH;
        const preferredExecution = options.executionProviders || (navigator.gpu ? ['webgpu', 'wasm'] : ['wasm']);

        try {
          ortSession = await ort.InferenceSession.create(modelUrl, {
            executionProviders: preferredExecution,
            graphOptimizationLevel: 'all'
          });
        } catch (backendErr) {
          // Fallback to pure WASM if WebGPU is unsupported or fails initialization
          ortSession = await ort.InferenceSession.create(modelUrl, {
            executionProviders: ['wasm'],
            graphOptimizationLevel: 'all'
          });
        }

        modelLoaded = true;
        modelLoading = false;
        if (typeof window !== 'undefined' && window.VisionGuideConfig?.debug) {
          console.info('[VisionGuide StairDetector] YOLOv8 stair detection model ready.');
        }
        return ortSession;
      } catch (err) {
        modelError = err.message || 'Failed to load YOLOv8 stair model';
        modelLoading = false;
        if (typeof window !== 'undefined' && window.VisionGuideConfig?.debug) {
          console.warn('[VisionGuide StairDetector] Model load failed:', err);
        }
        return null;
      } finally {
        loadPromise = null;
      }
    })();

    return loadPromise;
  }

  /**
   * Runs inference on a live video or canvas element.
   *
   * @param {HTMLVideoElement|HTMLCanvasElement|Object} videoOrCanvas
   * @param {Object} depthMap
   * @param {Array<number>} floorBaseline
   * @param {number} range
   * @returns {Promise<Array<Object>>} Detected stair hazards fused with depth
   */
  async function detect(videoOrCanvas, depthMap = null, floorBaseline = null, range = 1) {
    if (!ortSession || !videoOrCanvas) {
      return [];
    }

    const vw = videoOrCanvas.videoWidth || videoOrCanvas.width;
    const vh = videoOrCanvas.videoHeight || videoOrCanvas.height;
    if (!vw || !vh) return [];

    // Reusable offscreen canvas for letterbox preprocessing
    if (!scratchCanvas && typeof document !== 'undefined') {
      scratchCanvas = document.createElement('canvas');
      scratchCanvas.width = TARGET_SIZE;
      scratchCanvas.height = TARGET_SIZE;
      scratchCtx = scratchCanvas.getContext('2d', { willReadFrequently: true });
    }

    if (!scratchCtx) return [];

    const padInfo = preprocessLetterbox(vw, vh, TARGET_SIZE);
    scratchCtx.fillStyle = 'rgb(114, 114, 114)';
    scratchCtx.fillRect(0, 0, TARGET_SIZE, TARGET_SIZE);
    scratchCtx.drawImage(videoOrCanvas, 0, 0, vw, vh, padInfo.dx, padInfo.dy, padInfo.scaledW, padInfo.scaledH);

    const imgData = scratchCtx.getImageData(0, 0, TARGET_SIZE, TARGET_SIZE);
    const float32Data = rgbaToPlanarRgbFloat32(imgData.data, TARGET_SIZE, TARGET_SIZE);

    const ort = window.ort;
    const inputTensor = new ort.Tensor('float32', float32Data, [1, 3, TARGET_SIZE, TARGET_SIZE]);

    const feeds = { images: inputTensor };
    const results = await ortSession.run(feeds);
    const outputTensor = results.output0 || results[Object.keys(results)[0]];

    const candidates = decodeYOLOv8Output(outputTensor.data, NUM_ANCHORS, DEFAULT_CONF_THRESHOLD, vw, vh, padInfo);
    const nmsBoxes = runNMS(candidates, DEFAULT_IOU_THRESHOLD);

    return nmsBoxes.map(b => fuseStairsWithDepth(b, depthMap, floorBaseline, range, vw, vh));
  }

  /* ─── Public Module API ───────────────────────────────────────── */
  return {
    preprocessLetterbox,
    rgbaToPlanarRgbFloat32,
    decodeYOLOv8Output,
    runNMS,
    fuseStairsWithDepth,
    loadModel,
    detect,
    isModelLoaded: () => modelLoaded,
    isModelLoading: () => modelLoading,
    getModelError: () => modelError,
    TARGET_SIZE,
    NUM_ANCHORS,
    CLASS_STAIRS_IDX,
    reset: () => {
      ortSession = null;
      modelLoading = false;
      modelLoaded = false;
      modelError = null;
      loadPromise = null;
    }
  };
});
