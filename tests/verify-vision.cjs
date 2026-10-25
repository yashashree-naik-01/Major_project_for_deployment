const vm = require('node:vm');
const fs = require('node:fs');
const assert = require('node:assert/strict');

function canvas() {
  return {
    width: 0, height: 0, offsetWidth: 300, offsetHeight: 300,
    getContext: () => ({
      drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray() }),
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
const context = { window, document, console, setTimeout, clearTimeout, Date, performance };
vm.createContext(context);
for (const file of ['visionConfig.js', 'sceneState.js', 'guidanceManager.js', 'tracker.js', 'depthEstimation.js', 'surfaceSegmentation.js', 'hazardDetector.js', 'freeSpaceAnalyzer.js', 'riskEngine.js', 'objectDetection.js']) {
  vm.runInContext(fs.readFileSync(`dist/${file}`, 'utf8'), context, { filename: file });
}

const detection = (x, score = 0.9, label = 'person') => ({ class: label, score, bbox: [x, 20, 40, 80] });

(async () => {
  // Rectangular 2→1→2 association used to index outside the padded matrix.
  const tracker = new window.ByteTracker();
  assert.equal(tracker.update([detection(10), detection(160)]).length, 0);
  const one = tracker.update([detection(12)]);
  assert.equal(one.length, 1);
  const firstId = one[0].id;
  const two = tracker.update([detection(14), detection(162)]);
  assert.equal(two.length, 2);
  assert(two.some(track => track.id === firstId), 'matched track ID remains stable');
  assert(two.every(track => track.bbox.every(Number.isFinite)));
  assert.doesNotThrow(() => tracker.update([null, { score: NaN, bbox: [] }, detection(18)]));

  // Size fallback is explicitly uncertain and never fabricates metric distance.
  const distance = window.depthAPI.getDistanceForBBox([20, 20, 220, 220], 300, 300, 1);
  assert.equal(distance.source, 'size-heuristic');
  assert.equal(distance.uncertain, true);
  assert(!/\b\d+(?:\.\d+)?\s*m(?:etre)?s?\b/i.test(distance.detail));

  // A new central obstacle must be raised on the first frame, not after EMA lag.
  const video = { videoWidth: 300, videoHeight: 300 };
  const central = { id: 4, label: 'chair', bbox: [120, 200, 60, 100], distInfo: { zone: 'danger' } };
  const free = window.freeSpaceAPI.analyze(video, [central]);
  const nearCentre = free.grid.find(cell => cell.r === 2 && cell.c === 2);
  assert.equal(nearCentre.status, 'obstacle');
  assert(!/safe to walk/i.test(free.advice.speech));

  // Risk history and direction decisions: two-frame confirmation for non-urgent
  // changes, but complete blockage must stop immediately.
  window.riskAPI.reset();
  const blankGrid = Array.from({ length: 15 }, (_, i) => ({ r: Math.floor(i / 5), c: i % 5, status: 'clear', occupancy: 0 }));
  const baseline = window.riskAPI.computeSafeDir([], { grid: blankGrid }, 300, 300);
  assert.equal(baseline.direction, 'center');
  const medium = [{ id: 7, label: 'chair', bbox: [130, 170, 40, 90], risk: { score: 45, level: 'medium' }, motion: { trajectory: 'stationary' }, distInfo: { zone: 'close' } }];
  const leftFavoured = blankGrid.map(cell => ({ ...cell, status: cell.c >= 2 ? 'obstacle' : 'clear', occupancy: cell.c >= 2 ? 1 : 0 }));
  assert.equal(window.riskAPI.computeSafeDir(medium, { grid: leftFavoured }, 300, 300).direction, 'center');
  assert.equal(window.riskAPI.computeSafeDir(medium, { grid: leftFavoured }, 300, 300).direction, 'left');
  const blocked = blankGrid.map(cell => ({ ...cell, status: 'obstacle', occupancy: 1 }));
  const stopped = window.riskAPI.computeSafeDir([], { grid: blocked }, 300, 300);
  assert.equal(stopped.direction, 'stop');
  assert.match(stopped.speech, /stop/i);

  // The shared scene snapshot is immutable, normalized, and complete enough for
  // overlays, voice questions, and visual guidance to consume the same frame.
  window.sceneStateAPI.begin();
  const scene = window.sceneStateAPI.publish({
    frameId: 3, timestamp: Date.now(), videoWidth: 300, videoHeight: 200,
    tracks: [{ id: 9, label: 'person', score: 0.88, bbox: [205, 20, 60, 130],
      distInfo: { zone: 'close', label: 'near', source: 'relative-depth', relativeDepth: 0.7 },
      motion: { trajectory: 'approaching', approachRate: 0.2 }, risk: { score: 81, level: 'high' } }],
    safeDir: { direction: 'left', speech: 'Person ahead. Move left.', zones: {
      left: { freePct: 90, riskLevel: 'low', safetyScore: 85 },
      center: { freePct: 30, riskLevel: 'high', safetyScore: -10 },
      right: { freePct: 55, riskLevel: 'medium', safetyScore: 35 }
    } }, processingMs: 44
  });
  assert.equal(scene.objects[0].position, 'right');
  assert.equal(scene.objects[0].riskLevel, 'high');
  assert.equal(scene.recommendedDirection, 'left');
  assert(Object.isFrozen(scene) && Object.isFrozen(scene.objects) && Object.isFrozen(scene.objects[0].bbox));

  // A high-priority cue interrupts a lower one and is played before queued work.
  const played = [];
  let currentResolve;
  window.guidanceAPI.configure({
    player: text => { played.push(text); return new Promise(resolve => { currentResolve = resolve; }); },
    cancel: () => { const resolve = currentResolve; currentResolve = null; resolve?.(false); }
  });
  const low = window.guidanceAPI.announce('Low cue', { priority: 20 });
  const queued = window.guidanceAPI.announce('Queued cue', { priority: 30 });
  const high = window.guidanceAPI.announce('Stop now', { priority: 90, interrupt: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(played, ['Low cue', 'Stop now']);
  currentResolve(true);
  await high;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(played, ['Low cue', 'Stop now']);
  assert.equal(await queued, false, 'stale lower-priority cue is dropped after interruption');
  await low;

  // ── 1. Drop-off detection: identifies ground discontinuities ────
  const dw = 40, dh = 40;
  const flatData = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      flatData[y * dw + x] = 0.2 + (y / dh) * 0.7; // baseline gradient 0.2 (far) to 0.9 (near)
    }
  }

  // Uncertain drop-off (modest depth drop on walking cells)
  const uncertainDropData = new Float32Array(flatData);
  for (let y = Math.floor(dh * 0.67); y < dh; y++) {
    for (let x = Math.floor(dw * 0.4); x < Math.floor(dw * 0.6); x++) {
      uncertainDropData[y * dw + x] = 0.58; // depth drops below baseline ~0.78 by delta ~0.28
    }
  }
  const dmUncertain = { data: uncertainDropData, width: dw, height: dh, sceneMin: 0.2, sceneMax: 0.9 };
  window.depthAPI = { getDepthMap: () => dmUncertain, getDistanceForBBox: () => ({ zone: 'medium', label: 'mid-range', source: 'size-heuristic', uncertain: true }) };
  const uncertainRes = window.freeSpaceAPI.analyze({ videoWidth: 300, videoHeight: 300 }, []);
  assert(uncertainRes.hazard, 'drop-off hazard detected');
  assert.equal(uncertainRes.hazard.type, 'dropoff');
  assert.equal(uncertainRes.hazard.confidence, 'uncertain');
  assert.match(uncertainRes.advice.speech, /Possible drop-off ahead/i, 'says Possible drop-off ahead when confidence is uncertain');

  // Confident drop-off (severe depth drop across walking corridor)
  const confidentDropData = new Float32Array(flatData);
  for (let y = Math.floor(dh * 0.60); y < dh; y++) {
    for (let x = Math.floor(dw * 0.25); x < Math.floor(dw * 0.75); x++) {
      confidentDropData[y * dw + x] = 0.22; // severe floor drop
    }
  }
  const dmConfident = { data: confidentDropData, width: dw, height: dh, sceneMin: 0.2, sceneMax: 0.9 };
  window.depthAPI.getDepthMap = () => dmConfident;
  const confidentRes = window.freeSpaceAPI.analyze({ videoWidth: 300, videoHeight: 300 }, []);
  assert.equal(confidentRes.hazard?.type, 'dropoff');
  assert.equal(confidentRes.hazard?.confidence, 'confident');
  assert.match(confidentRes.advice.speech, /Drop-off detected ahead/i);

  // ── 2. Downward-stair detection: tests whether stair edges can be identified reliably ──
  const stairDownData = new Float32Array(flatData);
  for (let y = Math.floor(dh * 0.40); y < Math.floor(dh * 0.55); y++) {
    for (let x = 0; x < dw; x++) stairDownData[y * dw + x] = 0.40;
  }
  for (let y = Math.floor(dh * 0.55); y < Math.floor(dh * 0.72); y++) {
    for (let x = 0; x < dw; x++) stairDownData[y * dw + x] = 0.55;
  }
  for (let y = Math.floor(dh * 0.72); y < dh; y++) {
    for (let x = 0; x < dw; x++) stairDownData[y * dw + x] = 0.75;
  }
  const dmStairsDown = { data: stairDownData, width: dw, height: dh, sceneMin: 0.2, sceneMax: 0.9 };
  const stairDownTest = window.freeSpaceAPI.detectDownwardStairs(dmStairsDown);
  assert.equal(stairDownTest.isStairs, true, 'identifies descending stair edges reliably');
  assert(stairDownTest.edgeCount >= 2, 'detects multiple horizontal step edges');

  // ── 3. Upward-stair detection: validates step-pattern analysis ──
  const stairUpData = new Float32Array(flatData);
  for (let y = Math.floor(dh * 0.25); y < Math.floor(dh * 0.45); y++) {
    for (let x = 0; x < dw; x++) stairUpData[y * dw + x] = 0.65;
  }
  for (let y = Math.floor(dh * 0.45); y < Math.floor(dh * 0.65); y++) {
    for (let x = 0; x < dw; x++) stairUpData[y * dw + x] = 0.78;
  }
  const dmStairsUp = { data: stairUpData, width: dw, height: dh, sceneMin: 0.2, sceneMax: 0.9 };
  const stairUpTest = window.freeSpaceAPI.detectUpwardStairs(dmStairsUp, [], []);
  assert.equal(stairUpTest.isStairs, true, 'validates step-pattern analysis');
  assert(stairUpTest.edgeCount >= 2, 'detects upward step risers');

  // ── 4. Voice and UI alerts: connects validated detections to warning system ──
  // Uncertain drop-off warning in riskEngine
  const uncertainSafeDir = window.riskAPI.computeSafeDir([], { grid: blankGrid, hazard: { type: 'dropoff', confidence: 'uncertain', cells: [{ c: 2 }] } }, 300, 300);
  assert.match(uncertainSafeDir.speech, /Possible drop-off ahead/i, 'risk speech must say Possible drop-off ahead when uncertain');
  assert.doesNotMatch(uncertainSafeDir.speech, /\bMove (?:left|right)\b/i, 'drop-off advice must not issue unconditional movement commands');

  // Confident drop-off warning in riskEngine
  const confidentSafeDir = window.riskAPI.computeSafeDir([], { grid: blankGrid, hazard: { type: 'dropoff', confidence: 'confident', cells: [{ c: 2 }] } }, 300, 300);
  assert.match(confidentSafeDir.speech, /Drop-off detected ahead/i);
  assert.doesNotMatch(confidentSafeDir.speech, /\bMove (?:left|right)\b/i);

  // Confident descending stairs in riskEngine: concise stop alert, rawDir is 'stop', no lateral steering
  const stairsDownConfidentSafeDir = window.riskAPI.computeSafeDir([], { grid: blankGrid, hazard: { type: 'stairs-down', confidence: 'confident', cells: [{ c: 2 }] } }, 300, 300);
  assert.equal(stairsDownConfidentSafeDir.speech, 'Descending stairs ahead. Stop and check your step.');
  assert.equal(stairsDownConfidentSafeDir.rawDirection, 'stop', 'confident descending stairs must command stop');
  assert.doesNotMatch(stairsDownConfidentSafeDir.speech, /\bMove (?:left|right)\b/i, 'must not give lateral movement instructions on stairs');

  // Uncertain descending stairs in riskEngine: concise alert, no lateral steering
  const stairsDownUncertainSafeDir = window.riskAPI.computeSafeDir([], { grid: blankGrid, hazard: { type: 'stairs-down', confidence: 'uncertain', cells: [{ c: 2 }] } }, 300, 300);
  assert.equal(stairsDownUncertainSafeDir.speech, 'Possible descending stairs ahead. Stop and check.');
  assert.doesNotMatch(stairsDownUncertainSafeDir.speech, /\bMove (?:left|right)\b/i);

  // Confident ascending stairs in riskEngine: concise alert
  const stairsUpConfidentSafeDir = window.riskAPI.computeSafeDir([], { grid: blankGrid, hazard: { type: 'stairs-up', confidence: 'confident', cells: [{ c: 2 }] } }, 300, 300);
  assert.equal(stairsUpConfidentSafeDir.speech, 'Stairs ahead leading up. Approach carefully.');
  assert.doesNotMatch(stairsUpConfidentSafeDir.speech, /\bMove (?:left|right)\b/i);

  // Uncertain ascending stairs in riskEngine: concise alert
  const stairsUpUncertainSafeDir = window.riskAPI.computeSafeDir([], { grid: blankGrid, hazard: { type: 'stairs-up', confidence: 'uncertain', cells: [{ c: 2 }] } }, 300, 300);
  assert.equal(stairsUpUncertainSafeDir.speech, 'Possible steps ahead. Approach cautiously.');

  // Ambiguous stairs structure in riskEngine
  const stairsAmbiguousSafeDir = window.riskAPI.computeSafeDir([], { grid: blankGrid, hazard: { type: 'stairs-ambiguous', confidence: 'uncertain', cells: [{ c: 2 }] } }, 300, 300);
  assert.equal(stairsAmbiguousSafeDir.speech, 'Possible steps ahead. Approach cautiously.');

  // Scene state preservation of hazard including location metadata
  const hazardScene = window.sceneStateAPI.publish({
    frameId: 4, timestamp: Date.now(), videoWidth: 300, videoHeight: 200, tracks: [],
    freeSpace: {
      hazard: {
        type: 'stairs-down', confidence: 'uncertain', label: 'Possible descending stairs ahead',
        location: { side: 'center', row: 'mid', yStartNorm: 0.40, yEndNorm: 0.72 }
      }
    },
    safeDir: { direction: 'stop', speech: 'Possible descending stairs ahead. Stop and check.' }
  });
  assert.equal(hazardScene.hazard?.type, 'stairs-down');
  assert.equal(hazardScene.hazard?.confidence, 'uncertain');
  assert.equal(hazardScene.hazard?.location?.side, 'center');
  assert.equal(hazardScene.hazard?.location?.row, 'mid');
  assert(Object.isFrozen(hazardScene.hazard.location), 'hazard location must be frozen');

  // ── 5. Enhanced Drop-off, Stairs, & Priority Integration Tests ──────────
  // 5a. Multi-column drop-off across walking corridor (Row 1 ledge 2.5m ahead)
  window.freeSpaceAPI.reset();
  const multiColumnDropData = new Float32Array(flatData);
  for (let y = Math.floor(dh * 0.33); y < Math.floor(dh * 0.67); y++) {
    for (let x = Math.floor(dw * 0.20); x < Math.floor(dw * 0.80); x++) {
      multiColumnDropData[y * dw + x] = 0.22; // severe mid-row floor drop across walking path
    }
  }
  const dmMultiCol = { data: multiColumnDropData, width: dw, height: dh, sceneMin: 0.2, sceneMax: 0.9 };
  window.depthAPI.getDepthMap = () => dmMultiCol;
  const multiColRes = window.freeSpaceAPI.analyze({ videoWidth: 300, videoHeight: 300 }, []);
  assert(multiColRes.hazard, 'multi-column drop-off must be detected without baseline collapse');
  assert.equal(multiColRes.hazard.type, 'dropoff');

  // 5b. False-positive rejection: continuous flat ground, floor patterns & shadows
  window.freeSpaceAPI.reset();
  const dmFlat = { data: flatData, width: dw, height: dh, sceneMin: 0.2, sceneMax: 0.9 };
  window.depthAPI.getDepthMap = () => dmFlat;
  const flatRes = window.freeSpaceAPI.analyze({ videoWidth: 300, videoHeight: 300 }, []);
  assert.equal(flatRes.hazard, null, 'continuous flat ground must not be classified as drop-off or stairs');
  assert.doesNotMatch(flatRes.advice.speech, /drop-off|stairs|steps/i);
  assert.equal(window.freeSpaceAPI.detectDownwardStairs(dmFlat).isStairs, false, 'flat floor has zero stair edge detections');
  assert.equal(window.freeSpaceAPI.detectUpwardStairs(dmFlat, [], []).isStairs, false, 'flat floor has zero upward stair detections');

  // 5c. False-positive rejection: side railing outside walking corridor
  const sideRailingData = new Float32Array(flatData);
  for (let y = Math.floor(dh * 0.20); y < Math.floor(dh * 0.90); y++) {
    for (let x = 0; x < Math.floor(dw * 0.15); x++) {
      sideRailingData[y * dw + x] = 0.85; // vertical railing along left wall margin only
    }
  }
  const dmRailing = { data: sideRailingData, width: dw, height: dh, sceneMin: 0.2, sceneMax: 0.9 };
  assert.equal(window.freeSpaceAPI.detectDownwardStairs(dmRailing).isStairs, false, 'lateral railing must not trigger downward stairs');
  assert.equal(window.freeSpaceAPI.detectUpwardStairs(dmRailing, [], []).isStairs, false, 'lateral railing must not trigger upward stairs');

  // 5d. End-to-end ascending stairs via analyze()
  window.freeSpaceAPI.reset();
  window.depthAPI.getDepthMap = () => dmStairsUp;
  const stairsUpRes = window.freeSpaceAPI.analyze({ videoWidth: 300, videoHeight: 300 }, []);
  assert(stairsUpRes.hazard, 'ascending stairs must be detected by analyze()');
  assert.equal(stairsUpRes.hazard.type, 'stairs-up');
  assert.equal(stairsUpRes.hazard.location?.side, 'center');
  assert.equal(stairsUpRes.advice.direction, 'slow');
  assert.match(stairsUpRes.advice.speech, /stairs ahead leading up|possible steps ahead/i);

  // 5e. End-to-end descending stairs via analyze()
  window.freeSpaceAPI.reset();
  window.depthAPI.getDepthMap = () => dmStairsDown;
  const stairsDownRes = window.freeSpaceAPI.analyze({ videoWidth: 300, videoHeight: 300 }, []);
  assert(stairsDownRes.hazard, 'descending stairs must be detected by analyze()');
  assert.equal(stairsDownRes.hazard.type, 'stairs-down');
  assert.equal(stairsDownRes.hazard.location?.side, 'center');
  assert.equal(stairsDownRes.advice.direction, 'stop');
  assert.match(stairsDownRes.advice.speech, /descending stairs ahead/i);

  // 5f. Ambiguous stair structure (detected edges without elevated ground or drop-off)
  const stairAmbiguousData = new Float32Array(flatData);
  for (let y = Math.floor(dh * 0.40); y < Math.floor(dh * 0.52); y++) {
    for (let x = Math.floor(dw * 0.30); x < Math.floor(dw * 0.70); x++) stairAmbiguousData[y * dw + x] = 0.56;
  }
  for (let y = Math.floor(dh * 0.60); y < Math.floor(dh * 0.72); y++) {
    for (let x = Math.floor(dw * 0.30); x < Math.floor(dw * 0.70); x++) stairAmbiguousData[y * dw + x] = 0.68;
  }
  const dmAmbiguous = { data: stairAmbiguousData, width: dw, height: dh, sceneMin: 0.2, sceneMax: 0.9 };
  const ambiguousUpTest = window.freeSpaceAPI.detectUpwardStairs(dmAmbiguous, [], []);
  if (ambiguousUpTest.isStairs) {
    assert.equal(ambiguousUpTest.confidence, 'uncertain', 'ambiguous step pattern is classified as uncertain');
  }

  // 5g. Imminent hazard prioritization over routine object descriptions in guidance
  const guidanceCalls = [];
  window.guidanceAPI.announce = (msg, opts) => { guidanceCalls.push({ msg, opts }); return Promise.resolve(true); };
  window.riskAPI.reset();
  const highRiskTrack = [{ id: 12, label: 'chair', score: 0.95, bbox: [120, 150, 60, 100], risk: { score: 75, level: 'high' }, motion: { trajectory: 'approaching' } }];
  const stairHazardSafeDir = {
    direction: 'stop',
    speech: 'Possible descending stairs ahead. Stop and check.',
    hazard: { type: 'stairs-down', confidence: 'uncertain', location: { side: 'center', row: 'mid' } }
  };
  window.objectDetectionAPI.announceScene(highRiskTrack, stairHazardSafeDir, 300);
  assert.equal(guidanceCalls.length, 1, 'guidance announcement triggered for hazard');
  assert.equal(guidanceCalls[0].msg, 'Possible descending stairs ahead. Stop and check.', 'hazard announcement must not be prefixed with routine chair description');
  assert.equal(guidanceCalls[0].opts.priority, 100, 'imminent hazard has top priority (100)');
  assert.equal(guidanceCalls[0].opts.interrupt, true, 'imminent hazard interrupts routine speech');

  // 5h. Repetition avoidance: immediate first alert, suppressed repeated alert across frames
  window.riskAPI.reset();
  const stairHazard = { type: 'stairs-down', confidence: 'uncertain', cells: [{ c: 2 }] };
  assert.equal(window.riskAPI.shouldAnnounceDir('stop', stairHazard), true, 'first detection of descending stairs announced immediately');
  window.riskAPI.markDirSent('stop', stairHazard);
  assert.equal(window.riskAPI.shouldAnnounceDir('stop', stairHazard), false, 'repeated frame with same stair hazard is suppressed to avoid voice spam');
  console.log('PASS: tracker rectangular matching, honest relative range, immediate hazards, direction hysteresis, blocked-scene stop, normalized scene state, ground drop-off detection, downward/upward stair detection, ambiguous step handling, false-positive rejection, hazard location metadata, imminent hazard speech priority, and repetition throttling.');
})().catch(error => { console.error(error); process.exitCode = 1; });
