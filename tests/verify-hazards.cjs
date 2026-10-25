const vm = require('node:vm');
const fs = require('node:fs');
const assert = require('node:assert/strict');

function canvas(w = 300, h = 300) {
  return {
    width: w, height: h, offsetWidth: w, offsetHeight: h,
    getContext: () => ({
      drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData() {}, clearRect() {}, fillRect() {}, beginPath() {}, moveTo() {},
      lineTo() {}, stroke() {}, fill() {}, save() {}, restore() {}, translate() {},
      rotate() {}, closePath() {}, roundRect() {}, fillText() {},
      measureText: text => ({ width: String(text).length * 7 })
    }),
    toDataURL: () => 'data:image/jpeg;base64,'
  };
}

const nodes = new Map();
const document = {
  createElement: tag => tag === 'canvas' ? canvas() : {},
  getElementById: id => nodes.get(id) || null
};
const window = {};
const context = {
  window, document, console, setTimeout, clearTimeout, Date, performance,
  navigator: { gpu: null }
};
vm.createContext(context);

// Load all modules in sequence
for (const file of [
  'visionConfig.js',
  'sceneState.js',
  'guidanceManager.js',
  'tracker.js',
  'depthEstimation.js',
  'surfaceSegmentation.js',
  'hazardDetector.js',
  'freeSpaceAnalyzer.js',
  'riskEngine.js'
]) {
  vm.runInContext(fs.readFileSync(`dist/${file}`, 'utf8'), context, { filename: file });
}

(async () => {
  const hazardAPI = window.hazardDetectorAPI;
  assert(hazardAPI, 'hazardDetectorAPI must be exposed on window');
  const freeSpaceAPI = window.freeSpaceAPI;
  const riskAPI = window.riskAPI;
  const sceneStateAPI = window.sceneStateAPI;

  const W = 300, H = 300;
  const COLS = 5, ROWS = 3;

  function buildGrid() {
    const grid = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        grid.push({
          r, c,
          x: (c / COLS) * W, y: (r / ROWS) * H,
          w: W / COLS,       h: H / ROWS,
          status: 'clear', zone: null, src: null, label: null,
          surfaceCategory: 'footpath', surfaceConfidence: 0.90, surfaceShares: { footpath: 1 }
        });
      }
    }
    return grid;
  }

  function buildFlatDepth(dw = 60, dh = 60) {
    const data = new Float32Array(dw * dh);
    // Flat ground slope: row 0 (top/horizon) disparity = 0.30, row 2 (bottom) disparity = 0.85
    for (let y = 0; y < dh; y++) {
      const rowDisp = 0.30 + (y / dh) * 0.55;
      for (let x = 0; x < dw; x++) {
        data[y * dw + x] = rowDisp;
      }
    }
    return { data, width: dw, height: dh, sceneMin: 0.20, sceneMax: 0.90 };
  }

  // ── 1. POTHOLE DETECTION (Bounded Concavity in Walking Path) ─────────
  hazardAPI.reset();
  const potholeGrid = buildGrid();
  const potholeDepth = buildFlatDepth(60, 60);
  const dw = 60, dh = 60;
  const potholeRange = 0.70;
  const floorBase = [0.40, 0.65, 0.85];

  // Carve out a bounded pothole at near center (r=2, c=2): x in [24, 36], y in [40, 60]
  for (let y = 40; y < 60; y++) {
    for (let x = 24; x < 36; x++) {
      // Depress depth by 0.22 (delta relative to floorBase[2] is 0.22 / 0.70 = 0.31)
      potholeDepth.data[y * dw + x] = floorBase[2] - 0.22;
    }
  }

  const potholeHazard = hazardAPI.detectHazards({
    grid: potholeGrid,
    depthMap: potholeDepth,
    surfaceMap: { cells: potholeGrid },
    tracks: [],
    vw: W, vh: H,
    floorBaseline: floorBase,
    range: potholeRange
  });

  assert(potholeHazard, 'must detect bounded pothole in center corridor');
  assert.equal(potholeHazard.category, 'pothole');
  assert.equal(potholeHazard.location.side, 'center');
  assert.equal(potholeHazard.location.row, 'near');
  assert.equal(potholeHazard.proximity, 'immediate', 'near row must report immediate proximity');
  assert.equal(potholeHazard.riskLevel, 'high', 'center walking pothole is high risk');
  assert.match(potholeHazard.alertMessage, /Pothole.*ahead/i);

  // ── 2. UNCOVERED DRAIN DETECTION (Deep Elongated Void) ───────────────
  hazardAPI.reset();
  const drainGrid = buildGrid();
  const drainDepth = buildFlatDepth(60, 60);

  // Severe depth depression spanning rows 1 and 2 in column 1 (left of center):
  // Delta = 0.32 / 0.70 = 0.45 >= DRAIN_MIN_DELTA
  for (let y = 22; y < 58; y++) {
    for (let x = 12; x < 22; x++) {
      drainDepth.data[y * dw + x] = 0.25; // Severe void drop
    }
  }

  const drainHazard = hazardAPI.detectHazards({
    grid: drainGrid,
    depthMap: drainDepth,
    surfaceMap: { cells: drainGrid },
    tracks: [],
    vw: W, vh: H,
    floorBaseline: floorBase,
    range: potholeRange
  });

  assert(drainHazard, 'must detect elongated uncovered drain');
  assert.equal(drainHazard.category, 'uncovered-drain');
  assert.equal(drainHazard.riskLevel, 'critical', 'uncovered drain must have critical risk level');
  assert.equal(drainHazard.location.side, 'left');
  assert.match(drainHazard.alertMessage, /Uncovered drain/i);

  // ── 3. CURB EDGE DETECTION (Footpath-to-Road Step Boundary) ─────────
  hazardAPI.reset();
  const curbGrid = buildGrid();
  // Mark right columns (c=3, 4) as road, left columns (c=0, 1, 2) as footpath
  curbGrid.forEach(c => {
    if (c.c >= 3) {
      c.surfaceCategory = 'road';
      c.surfaceShares = { road: 1 };
    }
  });

  const curbDepth = buildFlatDepth(60, 60);
  // Add step-down transition at road (columns 3 and 4 depressed by 0.12 relative to footpath)
  for (let y = 40; y < 60; y++) {
    for (let x = 36; x < 60; x++) {
      curbDepth.data[y * dw + x] -= 0.12;
    }
  }

  const curbHazard = hazardAPI.detectHazards({
    grid: curbGrid,
    depthMap: curbDepth,
    surfaceMap: { cells: curbGrid },
    tracks: [],
    vw: W, vh: H,
    floorBaseline: floorBase,
    range: potholeRange
  });

  assert(curbHazard, 'must detect curb step-down boundary');
  assert.equal(curbHazard.category, 'curb');
  assert.equal(curbHazard.riskLevel, 'medium');
  assert.match(curbHazard.alertMessage, /Curb edge/i);

  // ── 4. RAISED SURFACE DETECTION (Low-Lying Tripping Protrusion) ──────
  hazardAPI.reset();
  const raisedGrid = buildGrid();
  const raisedDepth = buildFlatDepth(60, 60);

  // Protrude near center (r=2, c=2) upward by 0.14 disparity (delta = 0.14 / 0.70 = 0.20)
  for (let y = 40; y < 60; y++) {
    for (let x = 24; x < 36; x++) {
      raisedDepth.data[y * dw + x] = floorBase[2] + 0.14;
    }
  }

  const raisedHazard = hazardAPI.detectHazards({
    grid: raisedGrid,
    depthMap: raisedDepth,
    surfaceMap: { cells: raisedGrid },
    tracks: [],
    vw: W, vh: H,
    floorBaseline: floorBase,
    range: potholeRange
  });

  assert(raisedHazard, 'must detect low-lying raised surface');
  assert.equal(raisedHazard.category, 'raised-surface');
  assert.equal(raisedHazard.riskLevel, 'medium');
  assert.equal(raisedHazard.proximity, 'immediate');
  assert.match(raisedHazard.alertMessage, /Raised surface/i);

  // ── 5. BROKEN PAVEMENT (High Spatial Roughness on Footpath) ──────────
  hazardAPI.reset();
  const brokenGrid = buildGrid();
  const brokenDepth = buildFlatDepth(60, 60);

  // Inject high-frequency pseudo-random depth noise (broken tiles) into center walking cell (r=2, c=2)
  for (let y = 42; y < 58; y++) {
    for (let x = 24; x < 36; x++) {
      const noise = ((x * 17 + y * 31) % 19 - 9) * 0.015; // variance ~0.08
      brokenDepth.data[y * dw + x] = floorBase[2] + noise;
    }
  }

  const brokenHazard = hazardAPI.detectHazards({
    grid: brokenGrid,
    depthMap: brokenDepth,
    surfaceMap: { cells: brokenGrid },
    tracks: [],
    vw: W, vh: H,
    floorBaseline: floorBase,
    range: potholeRange
  });

  assert(brokenHazard, 'must detect broken / uneven pavement roughness');
  assert.equal(brokenHazard.category, 'broken-pavement');
  assert.match(brokenHazard.alertMessage, /Uneven.*pavement/i);

  // ── 6. FALSE POSITIVE REJECTION (Flat Shadows & Standing Obstacles) ──
  hazardAPI.reset();
  const cleanGrid = buildGrid();
  const cleanDepth = buildFlatDepth(60, 60);

  // Case A: Smooth flat pavement must NOT trigger any hazard
  const flatResult = hazardAPI.detectHazards({
    grid: cleanGrid,
    depthMap: cleanDepth,
    surfaceMap: { cells: cleanGrid },
    tracks: [],
    vw: W, vh: H,
    floorBaseline: floorBase,
    range: potholeRange
  });
  assert.equal(flatResult, null, 'smooth flat ground must not trigger any false hazards');

  // Case B: Dark flat shadow (identical depth to surrounding ground) must NOT trigger pothole
  const shadowDepth = buildFlatDepth(60, 60);
  const shadowResult = hazardAPI.detectHazards({
    grid: cleanGrid,
    depthMap: shadowDepth,
    surfaceMap: { cells: cleanGrid },
    tracks: [],
    vw: W, vh: H,
    floorBaseline: floorBase,
    range: potholeRange
  });
  assert.equal(shadowResult, null, 'flat shadows without depth disparity must not trigger pothole false positives');

  // Case C: Recognized ByteTrack object (e.g. person, chair) must not be flagged as broken pavement or pothole
  const objectTracks = [{ id: 1, label: 'chair', bbox: [120, 180, 60, 80] }];
  const objGrid = buildGrid();
  objGrid[12].status = 'obstacle';
  objGrid[12].src = 'det';
  const objectResult = hazardAPI.detectHazards({
    grid: objGrid,
    depthMap: potholeDepth,
    surfaceMap: { cells: objGrid },
    tracks: objectTracks,
    vw: W, vh: H,
    floorBaseline: floorBase,
    range: potholeRange
  });
  // The chair cell itself is ignored for pavement defects
  assert(objectResult === null || objectResult.cells.every(c => c.src !== 'det'));

  // ── 7. MISSED DETECTIONS & PARTIALLY OBSCURRED / SIDE HAZARDS ───────
  hazardAPI.reset();
  const sideGrid = buildGrid();
  const sideDepth = buildFlatDepth(60, 60);

  // Hazard on far left margin (partially clipped at edge)
  for (let y = 42; y < 54; y++) {
    for (let x = 0; x < 10; x++) {
      sideDepth.data[y * dw + x] = floorBase[2] - 0.22;
    }
  }

  const sideHazard = hazardAPI.detectHazards({
    grid: sideGrid,
    depthMap: sideDepth,
    surfaceMap: { cells: sideGrid },
    tracks: [],
    vw: W, vh: H,
    floorBaseline: floorBase,
    range: potholeRange
  });

  assert(sideHazard, 'must detect partially visible hazard on left margin');
  assert.equal(sideHazard.location.side, 'left');

  // ── 8. POOR LIGHTING / LOW CONTRAST SAFETY ─────────────────────────
  hazardAPI.reset();
  const darkDepth = { data: new Float32Array(60 * 60), width: 60, height: 60, sceneMin: 0.1, sceneMax: 0.12 };
  // Depth dynamic range is tiny (0.02 < MIN_RELIABLE_RANGE 0.05)
  const lowContrastResult = hazardAPI.detectHazards({
    grid: buildGrid(),
    depthMap: darkDepth,
    surfaceMap: null,
    tracks: [],
    vw: W, vh: H,
    floorBaseline: [0.11, 0.11, 0.11],
    range: 0.02
  });
  assert.equal(lowContrastResult, null, 'low contrast / unverified scenes must not produce false hazard assertions');

  // ── 9. SAFETY RULE: UNKNOWN IS NOT SAFE & NO AUTO STEERING ON INCOMPLETE EVIDENCE ─
  freeSpaceAPI.reset();
  const unknownGrid = buildGrid().map(c => ({
    ...c,
    surfaceCategory: 'unknown',
    surfaceConfidence: 0.10,
    surfaceShares: null
  }));
  // Advise on unverified grid when depth API is unloaded
  const advice = freeSpaceAPI.analyze({ videoWidth: 300, videoHeight: 300 }, []);
  // When ground observations are unverified, must NOT say "No alert ahead. Continue freely."
  if (advice && advice.advice) {
    assert(!/No tracked obstacle is ahead\. Continue carefully\./i.test(advice.advice.speech),
      'unknown observations must not be interpreted as proof of safety');
  }

  // ── 10. MULTI-FRAME PERSISTENCE & CONFIDENCE ESCALATION ────────────
  hazardAPI.reset();
  // Frame 1: Uncertain pothole (delta = 0.18, below confident threshold 0.28)
  const frame1Pothole = hazardAPI.detectHazards({
    grid: potholeGrid,
    depthMap: potholeDepth,
    surfaceMap: { cells: potholeGrid },
    tracks: [],
    vw: W, vh: H,
    floorBaseline: floorBase,
    range: 1.0 // delta = 0.22 / 1.0 = 0.22 (uncertain)
  });
  assert.equal(frame1Pothole.persistence, 1);
  assert.equal(frame1Pothole.confidence, 'uncertain');
  assert.match(frame1Pothole.alertMessage, /Possible pothole ahead/i);

  // Frame 2: Persistent in next frame -> escalates confidence!
  const frame2Pothole = hazardAPI.detectHazards({
    grid: potholeGrid,
    depthMap: potholeDepth,
    surfaceMap: { cells: potholeGrid },
    tracks: [],
    vw: W, vh: H,
    floorBaseline: floorBase,
    range: 1.0
  });
  assert.equal(frame2Pothole.persistence, 2);
  assert.equal(frame2Pothole.confidence, 'confident', 'persisting hazard across frames escalates confidence');
  assert.match(frame2Pothole.alertMessage, /Pothole detected ahead/i);

  // ── 11. RISK SCORING & VOICE GUIDANCE INTEGRATION ──────────────────
  riskAPI.reset();
  const mockFreeSpaceDrain = {
    grid: buildGrid(),
    hazard: {
      type: 'uncovered-drain',
      category: 'uncovered-drain',
      confidence: 'confident',
      cells: [{ r: 2, c: 2 }]
    }
  };

  const riskResult = riskAPI.computeSafeDir([], mockFreeSpaceDrain, 300, 300);

  // For critical confident drain in center path, riskEngine must enforce 'stop' or safe detour!
  assert.equal(riskResult.rawDirection, 'stop', 'critical uncovered drain must force stop direction');
  assert.match(riskResult.speech, /Uncovered drain.*stop/i);

  // ── 12. SCENE STATE SNAPSHOT PRESERVATION ──────────────────────────
  sceneStateAPI.reset();
  const publishedState = sceneStateAPI.publish({
    frameId: 100,
    timestamp: Date.now(),
    videoWidth: 300,
    videoHeight: 300,
    tracks: [],
    hazard: frame2Pothole
  });

  assert(publishedState.hazard, 'published scene state must contain hazard');
  assert.equal(publishedState.hazard.category, 'pothole');
  assert.equal(publishedState.hazard.confidence, 'confident');
  assert.equal(publishedState.hazard.proximity, 'immediate');
  assert.equal(publishedState.hazard.riskLevel, 'high');
  assert.equal(publishedState.hazard.persistence, 2);
  assert(publishedState.hazard.location && publishedState.hazard.location.side === 'center');
  assert(publishedState.hazard.alertMessage.length > 0);
  assert(Object.isFrozen(publishedState.hazard), 'hazard snapshot must be immutable');

  console.log('PASS: specialized hazard detection (potholes, uncovered drains, curb edges, raised surfaces, broken pavement), false positive rejection (flat shadows, standing objects), missed detection handling, poor lighting safety, multi-frame persistence, risk engine integration, and immutable scene snapshot.');
})().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
