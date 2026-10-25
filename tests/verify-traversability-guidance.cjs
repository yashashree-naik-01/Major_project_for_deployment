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
let mockTime = 300000;
const window = {};
const context = {
  window, document, console, setTimeout, clearTimeout,
  Date: class MockDate {
    constructor() { return new global.Date(mockTime); }
    static now() { return mockTime; }
  },
  performance: { now: () => mockTime },
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
  'riskEngine.js',
  'objectDetection.js'
]) {
  vm.runInContext(fs.readFileSync(`dist/${file}`, 'utf8'), context, { filename: file });
}

(async () => {
  console.log('--- VisionGuide Traversability & Cautious Directional Guidance Verification ---');

  const riskAPI = window.riskAPI;
  assert(riskAPI, 'riskAPI must be exposed on window');
  assert.equal(typeof riskAPI.computeSafeDir, 'function', 'computeSafeDir available');
  assert.equal(typeof riskAPI.validateLateralPath, 'function', 'validateLateralPath available');
  assert.equal(typeof riskAPI.estimateTraversability, 'function', 'estimateTraversability available');

  const odAPI = window.objectDetectionAPI;
  const freeSpaceAPI = window.freeSpaceAPI;
  const sceneStateAPI = window.sceneStateAPI;
  const W = 300, H = 300;
  const COLS = 5, ROWS = 3;

  function buildGrid(defaultCat = 'footpath', defaultConf = 0.85) {
    const grid = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        grid.push({
          r, c,
          status: 'clear',
          occupancy: 0,
          surfaceCategory: defaultCat,
          surfaceConfidence: defaultConf,
          depthGroundConfirmed: true,
          surfaceGroundConfirmed: defaultCat === 'footpath' || defaultCat === 'floor',
          traversable: (defaultCat === 'footpath' || defaultCat === 'floor') ? 'walkable' : 'unknown',
          verifiedWalkable: defaultCat === 'footpath' || defaultCat === 'floor',
          uncertainty: (defaultCat === 'footpath' || defaultCat === 'floor') ? 0.15 : 0.85
        });
      }
    }
    return grid;
  }

  // ═══════════════════════════════════════════════════════════════
  // REQUIREMENT 1: Divide Camera View into Left, Center, Right Regions
  // ═══════════════════════════════════════════════════════════════
  console.log('1. Testing View Division into Left, Center, Right Regions...');
  riskAPI.reset();
  const sampleGrid = buildGrid('footpath');
  const dirResult = riskAPI.computeSafeDir([], { grid: sampleGrid }, W, H);
  const zones = dirResult.zones;
  assert(zones.left && zones.center && zones.right, 'must provide left, center, and right zones');
  assert.equal(zones.left.colRange[0], 0);
  assert.equal(zones.left.colRange[1], 2);
  assert.equal(zones.center.colRange[0], 2);
  assert.equal(zones.center.colRange[1], 3);
  assert.equal(zones.right.colRange[0], 3);
  assert.equal(zones.right.colRange[1], 5);
  assert.equal(zones.left.xRange[1], W / 3, 'left x-bound is 1/3 of width');
  assert.equal(zones.center.xRange[0], W / 3, 'center x-start is 1/3 of width');
  assert.equal(zones.center.xRange[1], W * 2 / 3, 'center x-end is 2/3 of width');
  assert.equal(zones.right.xRange[0], W * 2 / 3, 'right x-start is 2/3 of width');
  console.log('   ✓ View division into Left, Center, and Right corridors verified.');

  // ═══════════════════════════════════════════════════════════════
  // REQUIREMENT 2: Obstacle Identification in Each Region
  // ═══════════════════════════════════════════════════════════════
  console.log('2. Testing Obstacle Identification & Region Descriptions...');
  const obsLeft = {
    id: 1,
    label: 'obstacle',
    bbox: [70, 100, 40, 80], // normX = 90/300 = 0.30 -> ahead, slightly to your left
    risk: { score: 55, level: 'medium' },
    distInfo: { source: 'size-heuristic', uncertain: true }
  };
  const descLeft = odAPI.formatObjectDescription(obsLeft, W);
  assert.equal(descLeft, 'Obstacle ahead, slightly to your left.',
    'must format obstacle description matching prompt requirement');

  const obsRight = {
    id: 2,
    label: 'obstacle',
    bbox: [210, 100, 40, 80], // normX = 230/300 = 0.766 -> ahead, slightly to your right
    risk: { score: 55, level: 'medium' },
    distInfo: { source: 'size-heuristic', uncertain: true }
  };
  const descRight = odAPI.formatObjectDescription(obsRight, W);
  assert.equal(descRight, 'Obstacle ahead, slightly to your right.');

  // Classified object
  const personLeft = {
    id: 3,
    label: 'person',
    bbox: [70, 100, 40, 80],
    risk: { score: 75, level: 'high' },
    distInfo: { source: 'size-heuristic', uncertain: true }
  };
  assert.equal(odAPI.formatObjectDescription(personLeft, W), 'A person is ahead, slightly to your left.');

  // Verify that computeSafeDir aggregates obstacles per region
  const dirWithObs = riskAPI.computeSafeDir([obsLeft, obsRight], { grid: sampleGrid }, W, H);
  assert.equal(dirWithObs.zones.left.obstacles.length, 1, 'left zone identified obstacle');
  assert.equal(dirWithObs.zones.right.obstacles.length, 1, 'right zone identified obstacle');
  assert.equal(dirWithObs.zones.center.obstacles.length, 0, 'center zone has 0 obstacles');
  console.log('   ✓ Obstacle identification and "Obstacle ahead, slightly to your left" verified.');

  // ═══════════════════════════════════════════════════════════════
  // REQUIREMENT 3: Semantic Segmentation Distinguishing Surface Classes
  // ═══════════════════════════════════════════════════════════════
  console.log('3. Testing Semantic Surface Distinctions (footpath, road, stairs, wall)...');
  const segAPI = window.surfaceSegmentationAPI;
  assert(segAPI, 'surfaceSegmentationAPI is available');
  assert.equal(segAPI.mapLabelToCategory('sidewalk'), 'footpath');
  assert.equal(segAPI.mapLabelToCategory('road'), 'road');
  assert.equal(segAPI.mapLabelToCategory('stairs'), 'stairs');
  assert.equal(segAPI.mapLabelToCategory('wall'), 'wall');
  assert.equal(segAPI.mapLabelToCategory('floor'), 'floor');
  assert.equal(segAPI.mapLabelToCategory('grass'), 'terrain');
  assert.equal(segAPI.mapLabelToCategory('sky'), 'unknown');

  // Verify road surface penalty: walking into roadway is discouraged
  const roadGrid = buildGrid('footpath');
  roadGrid.forEach(c => {
    if (c.c <= 1) { // Left corridor is vehicular road
      c.surfaceCategory = 'road';
      c.surfaceConfidence = 0.90;
    }
  });
  const roadDir = riskAPI.computeSafeDir([], { grid: roadGrid }, W, H);
  assert(roadDir.zones.left.safetyScore < roadDir.zones.center.safetyScore, 'roadway corridor penalized in safety score');
  const isLeftRoadValid = riskAPI.validateLateralPath('left', roadDir.zones, { grid: roadGrid });
  assert.equal(isLeftRoadValid, false, 'roadway corridor must fail lateral path validation');
  console.log('   ✓ Semantic classes correctly mapped and road corridor protected.');

  // ═══════════════════════════════════════════════════════════════
  // REQUIREMENT 4: Combining Surface, Depth, Obstacles & Uncertainty
  // ═══════════════════════════════════════════════════════════════
  console.log('4. Testing Multi-Modal Fusion and Uncertainty Metric...');
  const fusionGrid = buildGrid('footpath');
  // Add obstacle to center
  fusionGrid.forEach(c => {
    if (c.c === 2 && c.r >= 1) {
      c.status = 'obstacle';
      c.occupancy = 1;
    }
  });
  const fusionDir = riskAPI.computeSafeDir([], { grid: fusionGrid }, W, H);
  assert(Number.isFinite(fusionDir.zones.left.uncertainty), 'uncertainty score computed');
  assert(Number.isFinite(fusionDir.zones.center.uncertainty), 'center uncertainty score computed');
  assert(fusionDir.zones.left.traversability.hasSupportingEvidence, 'left has supporting evidence (footpath + clear)');
  assert(!fusionDir.zones.center.traversability.hasSupportingEvidence, 'center lacks supporting evidence (blocked)');
  console.log('   ✓ Multi-modal fusion and uncertainty scoring confirmed.');

  // ═══════════════════════════════════════════════════════════════
  // REQUIREMENT 5: Tracking Hazards Across Frames to Reduce Unstable Decisions
  // ═══════════════════════════════════════════════════════════════
  console.log('5. Testing Multi-Frame Persistence & Direction Hysteresis...');
  riskAPI.reset();
  const baselineGrid = buildGrid('footpath');
  const baseRes = riskAPI.computeSafeDir([], { grid: baselineGrid }, W, H);
  assert.equal(baseRes.direction, 'center', 'baseline established center');

  const leftFavouredGrid = buildGrid('footpath').map(cell => ({
    ...cell,
    status: cell.c >= 2 ? 'obstacle' : 'clear',
    occupancy: cell.c >= 2 ? 1 : 0
  }));
  const mediumTrack = [{
    id: 10, label: 'chair', bbox: [130, 170, 40, 90],
    risk: { score: 45, level: 'medium' }, motion: { trajectory: 'stationary' }, distInfo: { zone: 'close' }
  }];

  // Frame 1: Non-urgent change preserves stable center before confirmation
  const f1 = riskAPI.computeSafeDir(mediumTrack, { grid: leftFavouredGrid }, W, H);
  assert.equal(f1.direction, 'center', 'frame 1 preserves stable center before confirmation');

  // Frame 2: Confirmed direction flips cleanly
  const f2 = riskAPI.computeSafeDir(mediumTrack, { grid: leftFavouredGrid }, W, H);
  assert.equal(f2.direction, 'left', 'frame 2 switches direction after confirmation');
  console.log('   ✓ Temporal hysteresis prevents flickering directional decisions.');

  // ═══════════════════════════════════════════════════════════════
  // REQUIREMENT 6 & 7: Mark Unobserved/Uncertain as Unknown, Not Safe
  // Clear Image Region is NOT Proof That Ground is Walkable
  // ═══════════════════════════════════════════════════════════════
  console.log('6 & 7. Testing Unknown Marking & Clear Region Safety Rule...');
  const unverifiedGrid = buildGrid('unknown', 0.10).map(cell => ({
    ...cell,
    depthGroundConfirmed: false,
    surfaceGroundConfirmed: false,
    traversable: 'unknown',
    verifiedWalkable: false,
    uncertainty: 0.90
  }));

  // When corridor has no surface confirmation and no depth confirmation:
  const isLateralUnverifiedValid = riskAPI.validateLateralPath('left', {
    left: { freePct: 90, riskLevel: 'low', safetyScore: 70, tracks: [], traversability: { hasSupportingEvidence: false } }
  }, { grid: unverifiedGrid });
  assert.equal(isLateralUnverifiedValid, false, 'unverified corridor without supporting evidence must NOT validate');
  console.log('   ✓ Unobserved/uncertain regions treated as unknown, not assumed safe.');

  // ═══════════════════════════════════════════════════════════════
  // REQUIREMENT 8: Cautious Lateral Directional Guidance
  // Only suggest left/right when proposed corridor has sufficient evidence
  // ═══════════════════════════════════════════════════════════════
  console.log('8. Testing Cautious Lateral Phrasing...');
  riskAPI.reset();
  const clearRightGrid = buildGrid('footpath', 0.90).map(cell => {
    // Block center and left
    if (cell.c <= 2) return { ...cell, status: 'obstacle', occupancy: 1 };
    return cell; // right side is clear footpath
  });

  const obstacleCenter = [{
    id: 15,
    label: 'obstacle',
    bbox: [120, 140, 60, 90],
    risk: { score: 75, level: 'high' },
    motion: { trajectory: 'stationary' }
  }];

  // Frame 1
  riskAPI.computeSafeDir(obstacleCenter, { grid: clearRightGrid }, W, H);
  // Frame 2
  const rightAdvice = riskAPI.computeSafeDir(obstacleCenter, { grid: clearRightGrid }, W, H);
  assert.equal(rightAdvice.direction, 'right', 'chooses right when right corridor is verified');
  assert(
    rightAdvice.speech.includes('The area to your right appears clearer, but the route is not fully verified.') ||
    rightAdvice.speech.includes('The right side appears clearer, but the route is not fully verified.'),
    `speech contains cautious phrasing: got "${rightAdvice.speech}"`
  );
  assert.doesNotMatch(rightAdvice.speech, /safe path guaranteed/i, 'must not guarantee absolute safety');
  console.log(`   ✓ Cautious lateral guidance verified: "${rightAdvice.speech}"`);

  // Clear Left corridor
  riskAPI.reset();
  const clearLeftGrid = buildGrid('footpath', 0.90).map(cell => {
    // Block center and right
    if (cell.c >= 2) return { ...cell, status: 'obstacle', occupancy: 1 };
    return cell; // left side is clear footpath
  });
  riskAPI.computeSafeDir(obstacleCenter, { grid: clearLeftGrid }, W, H);
  const leftAdvice = riskAPI.computeSafeDir(obstacleCenter, { grid: clearLeftGrid }, W, H);
  assert.equal(leftAdvice.direction, 'left');
  assert(
    leftAdvice.speech.includes('The area to your left appears clearer, but the route is not fully verified.') ||
    leftAdvice.speech.includes('The left side appears clearer, but the route is not fully verified.'),
    `speech contains cautious phrasing: got "${leftAdvice.speech}"`
  );
  console.log(`   ✓ Cautious lateral guidance verified: "${leftAdvice.speech}"`);

  // ═══════════════════════════════════════════════════════════════
  // REQUIREMENT 9: If No Direction Can Be Confidently Established, Stop & Seek Assistance
  // ═══════════════════════════════════════════════════════════════
  console.log('9. Testing Surface Unassessed Halt & Assistance Cue...');
  riskAPI.reset();
  const unassessedResult = {
    grid: buildGrid('unknown', 0.05),
    hazard: null,
    surfaceUnassessed: true
  };
  const unassessedDir = riskAPI.computeSafeDir([], unassessedResult, W, H);
  assert.equal(unassessedDir.direction, 'stop', 'must command stop when walking surface cannot be assessed');
  assert.equal(
    unassessedDir.speech,
    'Unable to assess the walking surface. Stop and proceed only after checking with an established mobility aid or a sighted assistant.',
    'matches exact prompt requirement for unassessed walking surface'
  );
  console.log(`   ✓ Surface unassessed stop verified: "${unassessedDir.speech}"`);

  // ═══════════════════════════════════════════════════════════════
  // REQUIREMENT 10: Prioritize Drop-offs, Descending Stairs & Imminent Hazards
  // ═══════════════════════════════════════════════════════════════
  console.log('10. Testing Imminent Hazard Priority Over Routine Cues...');
  riskAPI.reset();

  // 10A: Drop-off ahead (Uncertain) -> "Possible drop-off ahead. Stop."
  const uncertainDropResult = riskAPI.computeSafeDir([], {
    grid: buildGrid('footpath').map(cell => ({ ...cell, status: 'dropoff', occupancy: 1 })), // all dropoff
    hazard: { category: 'dropoff', type: 'dropoff', confidence: 'uncertain' }
  }, W, H);
  assert.equal(uncertainDropResult.direction, 'stop');
  assert.equal(uncertainDropResult.speech, 'Possible drop-off ahead. Stop.',
    'matches prompt example: "Possible drop-off ahead. Stop."');

  // 10B: Descending stairs ahead -> "Descending stairs ahead. Stop and check your step."
  const descStairsResult = riskAPI.computeSafeDir([], {
    grid: buildGrid('footpath'),
    hazard: { category: 'stairs-down', type: 'stairs-down', confidence: 'confident' }
  }, W, H);
  assert.equal(descStairsResult.direction, 'stop');
  assert.equal(descStairsResult.speech, 'Descending stairs ahead. Stop and check your step.');

  // 10C: Object detection scene announcement prioritizes drop-off over routine chair
  const routineChair = [{
    id: 99, label: 'chair', bbox: [120, 100, 50, 70],
    risk: { score: 60, level: 'medium' }, distInfo: { zone: 'close' }
  }];
  let announcedCues = [];
  const origAnnounce = window.guidanceAPI.announce;
  window.guidanceAPI.announce = (text, opts) => {
    announcedCues.push({ text, opts });
    return origAnnounce(text, opts);
  };

  odAPI.announceScene(routineChair, uncertainDropResult, W);
  assert.equal(announcedCues.length, 1);
  assert.equal(announcedCues[0].text, 'Possible drop-off ahead. Stop.',
    'drop-off hazard must take absolute precedence over routine chair description');
  assert.equal(announcedCues[0].opts.priority, 100, 'imminent hazard priority');
  window.guidanceAPI.announce = origAnnounce;
  console.log('   ✓ Hazard priority and "Possible drop-off ahead. Stop." verified.');

  // ═══════════════════════════════════════════════════════════════
  // REQUIREMENT 11: Quantitative Outdoor Sequence Simulation & Latency Benchmark
  // ═══════════════════════════════════════════════════════════════
  console.log('11. Simulating 50-Frame Outdoor Sequence & Measuring Metrics...');
  let falseSafeCount = 0;
  let missedHazardCount = 0;
  let falseAlarmCount = 0;
  riskAPI.reset();
  const startBenchmark = Date.now();

  for (let f = 0; f < 50; f++) {
    // Frames 0-14: Clear urban sidewalk
    if (f < 15) {
      const g = buildGrid('footpath', 0.90);
      const res = riskAPI.computeSafeDir([], { grid: g }, W, H);
      if (res.direction === 'stop') falseAlarmCount++;
    }
    // Frames 15-24: Obstacle on left (parked bicycle)
    else if (f < 25) {
      const g = buildGrid('footpath', 0.90).map(c => c.c <= 1 ? { ...c, status: 'obstacle' } : c);
      const res = riskAPI.computeSafeDir([{ id: 20, label: 'bicycle', bbox: [50, 80, 50, 80], risk: { score: 50, level: 'medium' } }], { grid: g }, W, H);
      if (res.direction === 'left') falseSafeCount++; // Walked into obstacle!
    }
    // Frames 25-34: Drop-off ahead across walking corridor
    else if (f < 35) {
      const g = buildGrid('footpath', 0.90).map(c => c.r === 2 ? { ...c, status: 'dropoff' } : c);
      const res = riskAPI.computeSafeDir([], {
        grid: g,
        hazard: { category: 'dropoff', type: 'dropoff', confidence: 'confident' }
      }, W, H);
      if (res.direction !== 'stop') missedHazardCount++;
    }
    // Frames 35-44: Camera tilted up into sky (unassessed surface)
    else if (f < 45) {
      const g = buildGrid('unknown', 0.05);
      const res = riskAPI.computeSafeDir([], { grid: g, surfaceUnassessed: true }, W, H);
      if (res.direction !== 'stop') falseSafeCount++; // Walked on unverified surface!
    }
    // Frames 45-49: Ascending stairs
    else {
      const g = buildGrid('stairs', 0.90);
      const res = riskAPI.computeSafeDir([], {
        grid: g,
        hazard: { category: 'stairs-up', type: 'stairs-up', confidence: 'confident', alertMessage: 'Stairs ahead leading up. Approach carefully.' }
      }, W, H);
      if (res.speech.includes('Move left') || res.speech.includes('Move right')) falseAlarmCount++;
    }
  }

  const durationMs = Date.now() - startBenchmark;
  const avgLatency = (durationMs / 50).toFixed(2);

  assert.equal(falseSafeCount, 0, 'zero false-safe decisions across 50 frames');
  assert.equal(missedHazardCount, 0, 'zero missed hazards across 50 frames');
  assert.equal(falseAlarmCount, 0, 'zero false alarms across 50 frames');

  console.log(`   ✓ Benchmark: 50 outdoor frames evaluated in ${durationMs}ms (average ${avgLatency}ms / frame)`);
  console.log(`   ✓ Performance: False-safe rate = 0%, Missed hazard rate = 0%, False alarm rate = 0%`);

  console.log('\nAll 11 Traversability & Cautious Directional Guidance Scenarios PASSED cleanly.\n');
})();
