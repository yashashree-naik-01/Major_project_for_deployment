const assert = require('node:assert/strict');
const stairDetector = require('../dist/stairDetector.js');

console.log('--- VisionGuide Standalone YOLOv8 Stair Detector Verification ---');

// ═══════════════════════════════════════════════════════════════
// TEST 1: Letterbox Preprocessing & Coordinate Reversal Geometry
// ═══════════════════════════════════════════════════════════════
console.log('1. Testing Letterbox Preprocessing & Coordinate Reversal...');
const srcW = 1280;
const srcH = 720;
const targetSize = 416;

const padInfo = stairDetector.preprocessLetterbox(srcW, srcH, targetSize);
assert.equal(padInfo.targetSize, 416);
// For 1280x720, aspect ratio is 16:9. Scale is 416 / 1280 = 0.325.
// scaledW = 416, scaledH = 720 * 0.325 = 234.
// dy = (416 - 234) / 2 = 91, dx = 0.
assert.equal(padInfo.scaledW, 416);
assert.equal(padInfo.scaledH, 234);
assert.equal(padInfo.dx, 0);
assert.equal(padInfo.dy, 91);
console.log(`   ✓ Letterbox scale calculated: scale=${padInfo.r.toFixed(4)}, dx=${padInfo.dx}, dy=${padInfo.dy}`);

// ═══════════════════════════════════════════════════════════════
// TEST 2: Raw YOLOv8 Tensor Output Decoding
// ═══════════════════════════════════════════════════════════════
console.log('2. Testing Output Decoding from [1, 6, 3549] Tensor...');
const NUM_ANCHORS = stairDetector.NUM_ANCHORS; // 3549
const rawData = new Float32Array(6 * NUM_ANCHORS);

// Synthesize 2 detections in rawData:
// Detection A (Anchor 100): Confident stairs in center
// cx = 208, cy = 208, w = 150, h = 100 in 416 space.
// class 0 (object) = 0.05, class 1 (stairs) = 0.88
rawData[0 * NUM_ANCHORS + 100] = 208;
rawData[1 * NUM_ANCHORS + 100] = 208;
rawData[2 * NUM_ANCHORS + 100] = 150;
rawData[3 * NUM_ANCHORS + 100] = 100;
rawData[4 * NUM_ANCHORS + 100] = 0.05;
rawData[5 * NUM_ANCHORS + 100] = 0.88;

// Detection B (Anchor 500): Uncertain stairs
// cx = 100, cy = 150, w = 80, h = 60
// class 1 (stairs) = 0.35 (uncertain threshold between 0.25 and 0.45)
rawData[0 * NUM_ANCHORS + 500] = 100;
rawData[1 * NUM_ANCHORS + 500] = 150;
rawData[2 * NUM_ANCHORS + 500] = 80;
rawData[3 * NUM_ANCHORS + 500] = 60;
rawData[4 * NUM_ANCHORS + 500] = 0.10;
rawData[5 * NUM_ANCHORS + 500] = 0.35;

// Detection C (Anchor 800): Low confidence below threshold
// class 1 (stairs) = 0.18 (< 0.25) -> MUST BE DISCARDED
rawData[0 * NUM_ANCHORS + 800] = 250;
rawData[1 * NUM_ANCHORS + 800] = 300;
rawData[2 * NUM_ANCHORS + 800] = 100;
rawData[3 * NUM_ANCHORS + 800] = 100;
rawData[4 * NUM_ANCHORS + 800] = 0.02;
rawData[5 * NUM_ANCHORS + 800] = 0.18;

const decoded = stairDetector.decodeYOLOv8Output(rawData, NUM_ANCHORS, 0.25, srcW, srcH, padInfo);
assert.equal(decoded.length, 2, 'must decode exactly 2 candidates (discarding below 0.25)');
assert.equal(decoded[0].confidence, 'confident', 'detection A has confident score (0.88 >= 0.45)');
assert.equal(decoded[1].confidence, 'uncertain', 'detection B has uncertain score (0.25 <= 0.35 < 0.45)');

// Verify coordinate unpadding:
// Anchor 100: cx=208, cy=208, w=150, h=100.
// x1_416 = 208 - 75 = 133, x2_416 = 208 + 75 = 283
// x1_orig = 133 / 0.325 = 409, x2_orig = 283 / 0.325 = 871
// y1_416 = 208 - 50 = 158, y2_416 = 208 + 50 = 258
// y1_orig = (158 - 91) / 0.325 = 206, y2_orig = (258 - 91) / 0.325 = 514
const [bx, by, bw, bh] = decoded[0].bbox;
assert(Math.abs(bx - 409) <= 2, `expected bx near 409, got ${bx}`);
assert(Math.abs(by - 206) <= 2, `expected by near 206, got ${by}`);
assert(bw > 0 && bh > 0, 'valid box width and height');
console.log(`   ✓ Raw output decoded with coordinate reversal: bbox=[${bx}, ${by}, ${bw}, ${bh}]`);

// ═══════════════════════════════════════════════════════════════
// TEST 3: Non-Maximum Suppression (NMS)
// ═══════════════════════════════════════════════════════════════
console.log('3. Testing Non-Maximum Suppression (NMS)...');
const candidateBoxes = [
  { bbox: [100, 100, 200, 200], score: 0.90, confidence: 'confident', class: 'stairs' },
  // Duplicate overlapping box (IoU > 0.80) with lower score -> MUST BE SUPPRESSED
  { bbox: [105, 102, 195, 198], score: 0.85, confidence: 'confident', class: 'stairs' },
  // Distinct stair box on right side -> MUST BE PRESERVED
  { bbox: [500, 100, 150, 150], score: 0.75, confidence: 'confident', class: 'stairs' }
];

const nmsResult = stairDetector.runNMS(candidateBoxes, 0.45);
assert.equal(nmsResult.length, 2, 'NMS must suppress duplicate overlapping box');
assert.equal(nmsResult[0].score, 0.90, 'top scoring box preserved');
assert.equal(nmsResult[1].score, 0.75, 'distinct non-overlapping box preserved');
console.log(`   ✓ NMS correctly reduced 3 boxes to 2 non-overlapping detections`);

// ═══════════════════════════════════════════════════════════════
// TEST 4: Multi-Modal Depth Fusion (Descending Stairs)
// ═══════════════════════════════════════════════════════════════
console.log('4. Testing Depth Fusion: Descending Stairs (stairs-down)...');
// Create depth map where lower stairs drop below floor baseline
const depthW = 60, depthH = 60;
const descDepthData = new Float32Array(depthW * depthH);
// Baseline: row 0 = 0.35, row 1 = 0.55, row 2 = 0.80
const floorBaseline = [0.35, 0.55, 0.80];
const depthRange = 0.75;

// Fill flat gradient
for (let y = 0; y < depthH; y++) {
  for (let x = 0; x < depthW; x++) {
    descDepthData[y * depthW + x] = 0.35 + 0.45 * (y / depthH);
  }
}
// Carve deep descending tread drop in center lower half
for (let y = 35; y < 55; y++) {
  for (let x = 15; x < 45; x++) {
    descDepthData[y * depthW + x] = 0.40; // baseline for near is 0.80 -> delta = -0.40 / 0.75 = -0.53
  }
}

const descStairBox = {
  bbox: [Math.floor(srcW * 0.25), Math.floor(srcH * 0.50), Math.floor(srcW * 0.50), Math.floor(srcH * 0.40)],
  score: 0.88,
  confidence: 'confident'
};

const descHazard = stairDetector.fuseStairsWithDepth(
  descStairBox,
  { data: descDepthData, width: depthW, height: depthH, sceneMin: 0.2, sceneMax: 0.95 },
  floorBaseline, depthRange, srcW, srcH
);

assert.equal(descHazard.category, 'stairs-down', 'must be classified as stairs-down from negative depth disparity');
assert.equal(descHazard.riskLevel, 'critical', 'descending stairs is critical risk');
assert.equal(descHazard.alertMessage, 'Descending stairs ahead. Stop and check your step.', 'urgent stop alert');
assert.equal(descHazard.side, 'center', 'centered corridor');
console.log(`   ✓ Descending stairs depth fusion confirmed: "${descHazard.alertMessage}"`);

// ═══════════════════════════════════════════════════════════════
// TEST 5: Multi-Modal Depth Fusion (Ascending Stairs)
// ═══════════════════════════════════════════════════════════════
console.log('5. Testing Depth Fusion: Ascending Stairs (stairs-up)...');
const ascDepthData = new Float32Array(depthW * depthH);
for (let y = 0; y < depthH; y++) {
  for (let x = 0; x < depthW; x++) {
    ascDepthData[y * depthW + x] = 0.30 + 0.40 * (y / depthH);
  }
}
// Elevated steps climbing upward in mid region
for (let y = 20; y < 45; y++) {
  for (let x = 15; x < 45; x++) {
    ascDepthData[y * depthW + x] = 0.72; // baseline for mid row is 0.55 -> delta = +0.17 / 0.75 = +0.22
  }
}

const ascStairBox = {
  bbox: [Math.floor(srcW * 0.25), Math.floor(srcH * 0.30), Math.floor(srcW * 0.50), Math.floor(srcH * 0.45)],
  score: 0.85,
  confidence: 'confident'
};

const ascHazard = stairDetector.fuseStairsWithDepth(
  ascStairBox,
  { data: ascDepthData, width: depthW, height: depthH, sceneMin: 0.2, sceneMax: 0.95 },
  floorBaseline, depthRange, srcW, srcH
);

assert.equal(ascHazard.category, 'stairs-up', 'must be classified as stairs-up from elevated disparity');
assert.equal(ascHazard.riskLevel, 'high', 'ascending stairs is high risk');
assert.equal(ascHazard.alertMessage, 'Stairs ahead leading up. Approach carefully.', 'approach cautiously alert');
console.log(`   ✓ Ascending stairs depth fusion confirmed: "${ascHazard.alertMessage}"`);

// ═══════════════════════════════════════════════════════════════
// TEST 6: Ambiguous / Flat Depth (Safe Fallback to Cautious Warning)
// ═══════════════════════════════════════════════════════════════
console.log('6. Testing Fallback: Ambiguous Depth -> Cautious Alert...');
// Inconclusive/flat depth or absent depth map
const ambStairBox = {
  bbox: [Math.floor(srcW * 0.25), Math.floor(srcH * 0.40), Math.floor(srcW * 0.50), Math.floor(srcH * 0.30)],
  score: 0.38,
  confidence: 'uncertain'
};

const ambHazard = stairDetector.fuseStairsWithDepth(
  ambStairBox,
  null, // No depth map available
  null, 1, srcW, srcH
);

assert.equal(ambHazard.category, 'stairs-ambiguous', '2D box alone without depth must be stairs-ambiguous');
assert.equal(ambHazard.alertMessage, 'Possible stairs ahead. Stop and check before proceeding.',
  'must issue cautious stop warning when depth cannot confirm direction');
console.log(`   ✓ Ambiguous depth fallback confirmed: "${ambHazard.alertMessage}"`);

// ═══════════════════════════════════════════════════════════════
// TEST 7: Safety Rule: Missing YOLO Detection Never Implies Safe Path
// ═══════════════════════════════════════════════════════════════
console.log('7. Testing Safety Invariant: Empty YOLO Detections...');
const emptyTensor = new Float32Array(6 * NUM_ANCHORS); // All zeros
const emptyCandidates = stairDetector.decodeYOLOv8Output(emptyTensor, NUM_ANCHORS, 0.25, srcW, srcH);
assert.equal(emptyCandidates.length, 0, 'zero detections returned');

// Verify API contract: detect returns empty array gracefully when uninitialized
stairDetector.reset();
assert.equal(stairDetector.isModelLoaded(), false);
stairDetector.detect(null).then(res => {
  assert.deepEqual(res, [], 'detect returns empty array when model is unloaded or video is null');
  console.log('   ✓ Safe empty fallback validated.');
  console.log('\nAll 7 YOLOv8 Stair Detection Unit Tests PASSED cleanly.');
});
