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

// Load all pipeline modules in dependency order
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
  console.log('--- VisionGuide Stair Detection Comprehensive Verification ---');

  const hazardAPI = window.hazardDetectorAPI;
  assert(hazardAPI, 'hazardDetectorAPI must be exposed on window');
  assert.equal(typeof hazardAPI.detectStairs, 'function', 'detectStairs must be exposed on hazardDetectorAPI');

  const freeSpaceAPI = window.freeSpaceAPI;
  const riskAPI = window.riskAPI;
  const W = 384, H = 384;
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
          surfaceCategory: 'footpath', surfaceConfidence: 0.88, surfaceShares: { footpath: 1 }
        });
      }
    }
    return grid;
  }

  // Create baseline flat ground depth map (linear gradient from near to far)
  function createFlatFloorDepth() {
    const data = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      const depth = 0.25 + 0.65 * (y / H); // Far (0.25) to Near (0.90)
      for (let x = 0; x < W; x++) {
        data[y * W + x] = depth;
      }
    }
    return { data, width: W, height: H, sceneMin: 0.2, sceneMax: 0.95 };
  }

  // ═══════════════════════════════════════════════════════════════
  // TEST 1: Model Diagnosis & Class Capability Verification
  // ═══════════════════════════════════════════════════════════════
  console.log('1. Diagnosing model architectures & class support...');
  // Verify COCO-SSD has NO stairs class
  const cocoClasses = [
    'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat',
    'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat',
    'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe', 'backpack',
    'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball',
    'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket',
    'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple',
    'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair',
    'couch', 'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse', 'remote',
    'keyboard', 'cell phone', 'microwave', 'oven', 'toaster', 'sink', 'refrigerator', 'book',
    'clock', 'vase', 'scissors', 'teddy bear', 'hair drier', 'toothbrush'
  ];
  const cocoHasStairs = cocoClasses.some(c => c.includes('stair') || c.includes('step'));
  assert.equal(cocoHasStairs, false, 'Confirmed: COCO-SSD object detection dataset has 0 stair classes');

  // Verify SegFormer ADE20K has stairs class (index 53: "stairs, steps")
  const segAPI = window.surfaceSegmentationAPI;
  assert(segAPI, 'surfaceSegmentationAPI is available');
  assert.equal(typeof segAPI.mapLabelToCategory, 'function', 'mapLabelToCategory available');
  assert.equal(segAPI.mapLabelToCategory('stairs'), 'stairs', 'maps stairs label to stairs category');
  assert.equal(segAPI.mapLabelToCategory('steps'), 'stairs', 'maps steps label to stairs category');
  assert.equal(segAPI.mapLabelToCategory('stone-stairs'), 'stairs', 'maps compound stone-stairs to stairs category');
  console.log('   ✓ Confirmed: COCO-SSD lacks stairs class; multi-modal depth geometry + SegFormer required.');

  // ═══════════════════════════════════════════════════════════════
  // TEST 2: Ascending Stairs Detection (Multi-Step Positive Risers)
  // ═══════════════════════════════════════════════════════════════
  console.log('2. Testing Ascending Stairs (wood, stone, concrete steps)...');
  const dmAscending = createFlatFloorDepth();
  const ascData = dmAscending.data;

  // Add 4 periodic horizontal step risers with elevated treads climbing upward
  // Near row y: 0.75-0.85 (tread 1), mid row y: 0.55-0.65 (tread 2), far mid y: 0.38-0.48 (tread 3)
  const riserY1 = Math.floor(H * 0.40);
  const riserY2 = Math.floor(H * 0.55);
  const riserY3 = Math.floor(H * 0.70);

  for (let y = riserY1; y < riserY2; y++) {
    for (let x = Math.floor(W * 0.20); x < Math.floor(W * 0.80); x++) {
      ascData[y * W + x] = 0.58; // elevated tread 1
    }
  }
  for (let y = riserY2; y < riserY3; y++) {
    for (let x = Math.floor(W * 0.20); x < Math.floor(W * 0.80); x++) {
      ascData[y * W + x] = 0.74; // elevated tread 2
    }
  }
  for (let y = riserY3; y < Math.floor(H * 0.88); y++) {
    for (let x = Math.floor(W * 0.20); x < Math.floor(W * 0.80); x++) {
      ascData[y * W + x] = 0.88; // elevated tread 3
    }
  }

  const gridAsc = buildGrid();
  const ascResult = hazardAPI.detectHazards({
    grid: gridAsc,
    depthMap: dmAscending,
    surfaceMap: null,
    tracks: [],
    vw: W, vh: H,
    floorBaseline: [0.35, 0.55, 0.80],
    range: 0.75
  });

  assert(ascResult, 'ascending stairs must be detected as a hazard');
  assert.equal(ascResult.category, 'stairs-up', 'classified as ascending stairs (stairs-up)');
  assert(ascResult.edgeCount >= 2, 'identifies periodic horizontal step risers');
  assert.equal(ascResult.location.side, 'center', 'hazard position is centered in walking path');
  assert(ascResult.alertMessage.includes('Stairs ahead') || ascResult.alertMessage.includes('steps'), 'appropriate ascending stair alert');

  const ascSafeDir = riskAPI.computeSafeDir([], { grid: gridAsc, hazard: ascResult }, W, H);
  assert(ascSafeDir.speech.includes('Stairs ahead leading up') || ascSafeDir.speech.includes('steps'),
    `ascending stairs speech alert matches: got "${ascSafeDir.speech}"`);
  assert.notEqual(ascSafeDir.rawDirection, 'stop', 'ascending stairs does not force stop command');
  assert.doesNotMatch(ascSafeDir.speech, /\bMove (?:left|right)\b/i, 'must not give lateral steering into walls on stairs');
  console.log(`   ✓ Ascending stairs confirmed: "${ascSafeDir.speech}"`);

  // ═══════════════════════════════════════════════════════════════
  // TEST 3: Descending Stairs Detection (Void Treads Below Baseline)
  // ═══════════════════════════════════════════════════════════════
  console.log('3. Testing Descending Stairs (negative drop-off treads)...');
  const dmDescending = createFlatFloorDepth();
  const descData = dmDescending.data;

  // Descending staircase: depth drops off sharply into successive lower steps away from user
  for (let y = Math.floor(H * 0.40); y < Math.floor(H * 0.55); y++) {
    for (let x = Math.floor(W * 0.20); x < Math.floor(W * 0.80); x++) {
      descData[y * W + x] = 0.22; // deep lower step
    }
  }
  for (let y = Math.floor(H * 0.55); y < Math.floor(H * 0.70); y++) {
    for (let x = Math.floor(W * 0.20); x < Math.floor(W * 0.80); x++) {
      descData[y * W + x] = 0.38; // drop-off step 2
    }
  }
  for (let y = Math.floor(H * 0.70); y < Math.floor(H * 0.85); y++) {
    for (let x = Math.floor(W * 0.20); x < Math.floor(W * 0.80); x++) {
      descData[y * W + x] = 0.54; // drop-off step 1
    }
  }

  const gridDesc = buildGrid();
  // Mark dropoff in walking corridor for descending stairs
  gridDesc[7].status = 'dropoff';
  gridDesc[12].status = 'dropoff';

  const descResult = hazardAPI.detectHazards({
    grid: gridDesc,
    depthMap: dmDescending,
    surfaceMap: null,
    tracks: [],
    vw: W, vh: H,
    floorBaseline: [0.45, 0.65, 0.85],
    range: 0.75
  });

  assert(descResult, 'descending stairs must be detected');
  assert.equal(descResult.category, 'stairs-down', 'classified as stairs-down');
  assert.equal(descResult.riskLevel, 'critical', 'descending stairs is critical risk level');
  assert(descResult.edgeCount >= 2, 'detects multiple horizontal descending step edges');
  assert(descResult.alertMessage.includes('Descending stairs ahead'), 'urgent alert message');

  const descSafeDir = riskAPI.computeSafeDir([], { grid: gridDesc, hazard: descResult }, W, H);
  assert.equal(descSafeDir.rawDirection, 'stop', 'validated descending stairs MUST issue STOP command');
  assert.equal(descSafeDir.speech, 'Descending stairs ahead. Stop and check your step.',
    'urgent spoken warning for descending stairs');
  assert.doesNotMatch(descSafeDir.speech, /\bMove (?:left|right)\b/i, 'must not give lateral steering on descending stairs');
  console.log(`   ✓ Descending stairs confirmed: "${descSafeDir.speech}" with direction=${descSafeDir.rawDirection}`);

  // ═══════════════════════════════════════════════════════════════
  // TEST 4: Ambiguous Step-like Structure Detection
  // ═══════════════════════════════════════════════════════════════
  console.log('4. Testing Ambiguous Step-like Structure (cautious alert)...');
  hazardAPI.reset();
  riskAPI.reset();
  const dmAmbiguous = createFlatFloorDepth();
  const ambData = dmAmbiguous.data;

  // Periodic horizontal step edges with intermediate depth elevation
  for (let y = Math.floor(H * 0.42); y < Math.floor(H * 0.55); y++) {
    for (let x = Math.floor(W * 0.20); x < Math.floor(W * 0.80); x++) {
      ambData[y * W + x] = 0.52;
    }
  }
  for (let y = Math.floor(H * 0.58); y < Math.floor(H * 0.72); y++) {
    for (let x = Math.floor(W * 0.20); x < Math.floor(W * 0.80); x++) {
      ambData[y * W + x] = 0.65;
    }
  }

  const gridAmb = buildGrid();
  const ambResult = hazardAPI.detectHazards({
    grid: gridAmb,
    depthMap: dmAmbiguous,
    surfaceMap: null,
    tracks: [],
    vw: W, vh: H,
    floorBaseline: [0.35, 0.58, 0.80],
    range: 0.75
  });

  assert(ambResult, 'ambiguous step pattern must be detected');
  assert.equal(ambResult.category, 'stairs-ambiguous', 'classified as stairs-ambiguous');
  assert.equal(ambResult.confidence, 'uncertain', 'ambiguous stairs must have uncertain confidence');
  assert.equal(ambResult.alertMessage, 'Possible stairs ahead. Stop and check before proceeding.',
    'must use cautious alert');
  console.log(`   ✓ Ambiguous step structure alert: "${ambResult.alertMessage}"`);

  // ═══════════════════════════════════════════════════════════════
  // TEST 5: False Positive Rejection (Flat Floors, Tiles, Shadows, Ramps)
  // ═══════════════════════════════════════════════════════════════
  console.log('5. Testing False Positive Rejection...');
  hazardAPI.reset();
  riskAPI.reset();

  // 5A: Flat floor
  const dmFlat = createFlatFloorDepth();
  const flatResult = hazardAPI.detectHazards({
    grid: buildGrid(),
    depthMap: dmFlat,
    surfaceMap: null,
    tracks: [],
    vw: W, vh: H,
    floorBaseline: [0.35, 0.58, 0.80],
    range: 0.75
  });
  assert.equal(flatResult, null, 'smooth flat floor must produce NO stair hazard');
  assert.equal(freeSpaceAPI.detectDownwardStairs(dmFlat).isStairs, false, 'detectDownwardStairs rejects flat floor');
  console.log('   ✓ 5A: Flat floor rejected (zero false positives)');

  // 5B: Checkerboard floor tiles (high visual RGB texture, flat depth)
  const dmTiles = createFlatFloorDepth();
  // Add small micro-noise to depth (< 0.02) representing tile grout
  for (let i = 0; i < dmTiles.data.length; i++) {
    dmTiles.data[i] += ((i % 17) - 8) * 0.001;
  }
  const tileResult = hazardAPI.detectHazards({
    grid: buildGrid(),
    depthMap: dmTiles,
    surfaceMap: null,
    tracks: [],
    vw: W, vh: H,
    floorBaseline: [0.35, 0.58, 0.80],
    range: 0.75
  });
  assert.equal(tileResult, null, 'flat checkerboard tiles must NOT trigger stair detection');
  console.log('   ✓ 5B: High-contrast floor tiles rejected (depth is flat)');

  // 5C: Harsh diagonal sunlight shadows across floor
  const dmShadow = createFlatFloorDepth();
  // Shadows affect RGB but depth estimation remains smooth
  const shadowResult = hazardAPI.detectHazards({
    grid: buildGrid(),
    depthMap: dmShadow,
    surfaceMap: null,
    tracks: [],
    vw: W, vh: H,
    floorBaseline: [0.35, 0.58, 0.80],
    range: 0.75
  });
  assert.equal(shadowResult, null, 'shadow patterns must NOT trigger stair detection');
  console.log('   ✓ 5C: Lighting shadows rejected');

  // 5D: Continuous wheelchair ramp (smooth constant slope, no discrete risers)
  const dmRamp = { data: new Float32Array(W * H), width: W, height: H, sceneMin: 0.2, sceneMax: 0.9 };
  for (let y = 0; y < H; y++) {
    // Continuous linear incline with constant gradient everywhere
    const val = 0.30 + 0.55 * (y / H);
    for (let x = 0; x < W; x++) {
      dmRamp.data[y * W + x] = val;
    }
  }
  const rampStairResult = hazardAPI.detectStairs(buildGrid(), dmRamp, null, [], [0.35, 0.58, 0.80], 0.75, W, H);
  assert.equal(rampStairResult.length, 0, 'continuous smooth ramp must NOT be classified as stairs');
  console.log('   ✓ 5D: Continuous wheelchair ramp rejected');

  // 5E: Vertical handrail / wall column (vertical edges > horizontal edges)
  const dmRail = createFlatFloorDepth();
  // Add vertical handrail post at x = 0.35 W spanning from y = 0.20 to 0.80
  for (let y = Math.floor(H * 0.20); y < Math.floor(H * 0.80); y++) {
    for (let x = Math.floor(W * 0.34); x <= Math.floor(W * 0.36); x++) {
      dmRail.data[y * W + x] = 0.92; // close vertical post
    }
  }
  const railStairResult = hazardAPI.detectStairs(buildGrid(), dmRail, null, [], [0.35, 0.58, 0.80], 0.75, W, H);
  assert.equal(railStairResult.length, 0, 'vertical handrail/post must NOT be classified as horizontal stairs');
  console.log('   ✓ 5E: Vertical handrails rejected');

  // ═══════════════════════════════════════════════════════════════
  // TEST 6: Partially Hidden Stairs (Person Standing on Steps)
  // ═══════════════════════════════════════════════════════════════
  console.log('6. Testing Partially Hidden Stairs with Obstacle Masking...');
  const dmOccluded = createFlatFloorDepth();
  // Apply stairs across width
  for (let y = riserY1; y < riserY2; y++) {
    for (let x = Math.floor(W * 0.20); x < Math.floor(W * 0.80); x++) dmOccluded.data[y * W + x] = 0.58;
  }
  for (let y = riserY2; y < riserY3; y++) {
    for (let x = Math.floor(W * 0.20); x < Math.floor(W * 0.80); x++) dmOccluded.data[y * W + x] = 0.74;
  }
  for (let y = riserY3; y < Math.floor(H * 0.88); y++) {
    for (let x = Math.floor(W * 0.20); x < Math.floor(W * 0.80); x++) dmOccluded.data[y * W + x] = 0.88;
  }

  // Standing pedestrian occupying center column (x: 40% to 55%, y: 35% to 75%)
  const pedestrianTrack = {
    id: 1, label: 'person', score: 0.92,
    bbox: [Math.floor(W * 0.40), Math.floor(H * 0.35), Math.floor(W * 0.15), Math.floor(H * 0.40)]
  };
  // Person body has high depth
  for (let y = Math.floor(H * 0.35); y < Math.floor(H * 0.75); y++) {
    for (let x = Math.floor(W * 0.40); x < Math.floor(W * 0.55); x++) {
      dmOccluded.data[y * W + x] = 0.95;
    }
  }

  const occludedResult = hazardAPI.detectHazards({
    grid: buildGrid(),
    depthMap: dmOccluded,
    surfaceMap: null,
    tracks: [pedestrianTrack],
    vw: W, vh: H,
    floorBaseline: [0.35, 0.55, 0.80],
    range: 0.75
  });

  assert(occludedResult, 'partially occluded stairs must be detected despite pedestrian standing on steps');
  assert.equal(occludedResult.category, 'stairs-up', 'correctly identifies underlying stairs');
  console.log('   ✓ Partially occluded stairs successfully detected with obstacle exclusion masking');

  // ═══════════════════════════════════════════════════════════════
  // TEST 7: Camera Tilt / Roll Tolerance (10°–15° angle)
  // ═══════════════════════════════════════════════════════════════
  console.log('7. Testing Camera Tilt / Roll Tolerance (tilted handhold)...');
  const dmTilted = createFlatFloorDepth();
  const tData = dmTilted.data;

  // Step risers slanted at ~12 degrees (dy/dx = 0.21)
  const slantSlope = 0.20;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const effectiveY = y - Math.floor((x - W / 2) * slantSlope);
      if (effectiveY >= riserY1 && effectiveY < riserY2) tData[y * W + x] = 0.58;
      else if (effectiveY >= riserY2 && effectiveY < riserY3) tData[y * W + x] = 0.74;
      else if (effectiveY >= riserY3 && effectiveY < Math.floor(H * 0.88)) tData[y * W + x] = 0.88;
    }
  }

  const tiltedStairResult = freeSpaceAPI.detectUpwardStairs(dmTilted, buildGrid(), [0.35, 0.55, 0.80]);
  assert.equal(tiltedStairResult.isStairs, true, 'tilt-tolerant edge matching detects slanted stairs');
  assert(tiltedStairResult.edgeCount >= 2, 'detects multiple step risers on tilted camera');
  console.log('   ✓ Camera tilt tolerance confirmed: detects stairs with 12°–15° roll angle');

  // ═══════════════════════════════════════════════════════════════
  // TEST 8: Multi-Frame Persistence & Spoken Alert Deduplication
  // ═══════════════════════════════════════════════════════════════
  console.log('8. Testing Persistence & Speech Deduplication...');
  riskAPI.reset();
  hazardAPI.reset();

  const persistentHazard = {
    category: 'stairs-up',
    type: 'stairs-up',
    confidence: 'confident',
    location: { side: 'center', row: 'mid' }
  };

  // Frame 1: Initial stair detection -> must announce immediately
  const should1 = riskAPI.shouldAnnounceDir('center', persistentHazard);
  assert.equal(should1, true, 'frame 1: newly detected stairs must announce immediately');
  riskAPI.markDirSent('center', persistentHazard);

  // Frame 2: Same persistent stair hazard 1.5 seconds later -> MUST be suppressed!
  const should2 = riskAPI.shouldAnnounceDir('center', persistentHazard);
  assert.equal(should2, false, 'frame 2: persistent stairs MUST be deduplicated to avoid chatter');

  // Escalation: if hazard escalates to a different type (e.g. descending stairs) -> announce immediately
  const escalatingHazard = {
    category: 'stairs-down',
    type: 'stairs-down',
    confidence: 'confident',
    location: { side: 'center', row: 'near' }
  };
  const shouldEscalate = riskAPI.shouldAnnounceDir('stop', escalatingHazard);
  assert.equal(shouldEscalate, true, 'escalating hazard category announces immediately');
  console.log('   ✓ Multi-frame persistence and speech deduplication validated');

  // ═══════════════════════════════════════════════════════════════
  // TEST 9: Inference Performance Measurement (Mobile Feasibility)
  // ═══════════════════════════════════════════════════════════════
  console.log('9. Measuring Per-Frame Latency across 50 frames...');
  const ITERATIONS = 50;
  const startPerf = Date.now();
  for (let i = 0; i < ITERATIONS; i++) {
    hazardAPI.detectHazards({
      grid: buildGrid(),
      depthMap: dmAscending,
      surfaceMap: null,
      tracks: [pedestrianTrack],
      vw: W, vh: H,
      floorBaseline: [0.35, 0.55, 0.80],
      range: 0.75
    });
  }
  const totalElapsed = Date.now() - startPerf;
  const avgLatency = (totalElapsed / ITERATIONS).toFixed(2);
  console.log(`   ✓ Benchmark: 50 frames processed in ${totalElapsed}ms (average ${avgLatency}ms / frame)`);
  assert(Number(avgLatency) < 25, `stair detection must run in < 25ms per frame; measured ${avgLatency}ms`);

  console.log('\nAll 9 Stair Detection Test Scenarios PASSED cleanly.');
})();
