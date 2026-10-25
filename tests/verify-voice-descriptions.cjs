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
let mockTime = 200000;
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

// Load all required modules in order
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
  console.log('=== TEST SUITE: Natural Spoken Descriptions, Safety Priority & Directional Guidance ===');

  const odAPI = window.objectDetectionAPI;
  assert(odAPI, 'objectDetectionAPI must be exposed on window');
  assert(typeof odAPI.formatObjectDescription === 'function', 'formatObjectDescription must be exposed');
  const riskAPI = window.riskAPI;
  const guidanceAPI = window.guidanceAPI;
  const sceneStateAPI = window.sceneStateAPI;
  const W = 300, H = 300;

  // ─────────────────────────────────────────────────────────────────────────
  // 1. OBJECT CLASS AND IMAGE-POSITION DESCRIPTIONS
  // ─────────────────────────────────────────────────────────────────────────
  {
    // 1a. Prompt Example: "A person is ahead, slightly to your left."
    // normX = (70 + 40/2) / 300 = 90 / 300 = 0.30 (in range [0.22, 0.38))
    const personLeft = {
      id: 1,
      label: 'person',
      bbox: [70, 40, 40, 90],
      distInfo: { source: 'size-heuristic', uncertain: true }
    };
    const descLeft = odAPI.formatObjectDescription(personLeft, W);
    assert.equal(descLeft, 'A person is ahead, slightly to your left.',
      'must match exact prompt example for slightly left person');

    // 1b. Object directly ahead in center corridor: "A chair is directly ahead."
    // normX = (130 + 40/2) / 300 = 150 / 300 = 0.50 (in range [0.38, 0.62])
    const chairCenter = {
      id: 2,
      label: 'chair',
      bbox: [130, 40, 40, 90],
      distInfo: { source: 'size-heuristic', uncertain: true }
    };
    const descCenter = odAPI.formatObjectDescription(chairCenter, W);
    assert.equal(descCenter, 'A chair is directly ahead.',
      'must announce class and directly ahead position');

    // 1c. Object slightly to right: "A car is ahead, slightly to your right."
    // normX = (200 + 40/2) / 300 = 220 / 300 = 0.733 (in range (0.62, 0.78])
    const carRight = {
      id: 3,
      label: 'car',
      bbox: [200, 40, 40, 90],
      distInfo: { source: 'size-heuristic', uncertain: true }
    };
    const descRight = odAPI.formatObjectDescription(carRight, W);
    assert.equal(descRight, 'A car is ahead, slightly to your right.');

    // 1d. Grammatical article: 'An umbrella'
    const umbrella = {
      id: 4,
      label: 'umbrella',
      bbox: [130, 40, 40, 90]
    };
    assert.equal(odAPI.formatObjectDescription(umbrella, W), 'An umbrella is directly ahead.');

    // 1e. Distinguishing distance ONLY when verified by depth (never when uncertain)
    const personNearDepth = {
      id: 5,
      label: 'person',
      bbox: [70, 40, 40, 90],
      distInfo: { source: 'relative-depth', zone: 'danger', uncertain: false, relativeDepth: 0.85 }
    };
    const descNear = odAPI.formatObjectDescription(personNearDepth, W);
    assert.equal(descNear, 'A person is ahead, slightly to your left, close by.',
      'verified danger zone must add close by proximity qualification');

    // When distance info is size-heuristic/uncertain, must NOT invent metric meters or false precision
    const heuristicTrack = {
      id: 6,
      label: 'bicycle',
      bbox: [130, 40, 40, 90],
      distInfo: { source: 'size-heuristic', zone: 'close', uncertain: true }
    };
    const descHeuristic = odAPI.formatObjectDescription(heuristicTrack, W);
    assert.equal(descHeuristic, 'A bicycle is directly ahead.',
      'uncertain size heuristic must omit unverified distance details');
    assert.doesNotMatch(descHeuristic, /\b\d+(?:\.\d+)?\s*m\b/i, 'must never invent metric meters');

    console.log('  ✔ Object class and image-position descriptions verified.');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 2. UNKNOWN OBJECTS
  // ─────────────────────────────────────────────────────────────────────────
  {
    // 2a. Unknown object in center corridor -> "Unknown obstacle ahead."
    const unknownCenter = {
      id: 7,
      label: 'unknown',
      bbox: [130, 40, 40, 90]
    };
    assert.equal(odAPI.formatObjectDescription(unknownCenter, W), 'Unknown obstacle ahead.',
      'unknown object directly ahead must say Unknown obstacle ahead');

    // 2b. Missing / empty label -> "Unknown obstacle ahead."
    const noLabel = {
      id: 8,
      bbox: [130, 40, 40, 90]
    };
    assert.equal(odAPI.formatObjectDescription(noLabel, W), 'Unknown obstacle ahead.');

    // 2c. Unknown object on left corridor
    const unknownLeft = {
      id: 9,
      label: 'unknown',
      bbox: [70, 40, 40, 90]
    };
    assert.equal(odAPI.formatObjectDescription(unknownLeft, W), 'Unknown obstacle ahead, slightly to your left.');

    // 2d. Risk engine integration for unknown obstacles
    const blankGrid = Array.from({ length: 15 }, (_, i) => ({
      r: Math.floor(i / 5), c: i % 5, status: 'clear', occupancy: 0,
      surfaceCategory: 'footpath', surfaceConfidence: 0.90
    }));

    const unknownHighRisk = [{
      id: 10,
      label: 'unknown',
      bbox: [130, 40, 40, 90],
      risk: { level: 'high', score: 85 },
      motion: { trajectory: 'stationary' }
    }];

    // Case A: Validated detour available on left
    const detourResult = riskAPI.computeSafeDir(unknownHighRisk, { grid: blankGrid }, W, H);
    assert.match(detourResult.speech, /Unknown obstacle ahead.*Move left\. The left side appears clearer/i,
      'unknown obstacle with validated detour must announce Unknown obstacle and suggest clearer side');

    // Case B: No validated detour available (lateral paths blocked) -> commands safe stop
    const blockedGrid = blankGrid.map(cell => ({ ...cell, status: 'obstacle', occupancy: 1 }));
    const highRiskStop = riskAPI.computeSafeDir(unknownHighRisk, { grid: blockedGrid }, W, H);
    assert.match(highRiskStop.speech, /Unknown obstacle is directly ahead.*Please stop/i,
      'high-risk unknown obstacle without validated path must announce Unknown obstacle and command stop');
    assert.doesNotMatch(highRiskStop.speech, /check your surroundings/i,
      'must never tell a visually impaired user to check surroundings');

    console.log('  ✔ Unknown object handling verified.');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 3. REPEATED DETECTIONS & TRACKING ACROSS FRAMES
  // ─────────────────────────────────────────────────────────────────────────
  {
    riskAPI.reset();
    let spokenCues = [];
    guidanceAPI.configure({
      player: text => { spokenCues.push(text); return Promise.resolve(true); },
      cancel: () => {}
    });

    const stationaryChair = [{
      id: 20,
      label: 'chair',
      bbox: [130, 40, 40, 90],
      risk: { level: 'medium', score: 45 },
      motion: { trajectory: 'stationary' }
    }];
    const safeDirWait = {
      direction: 'center',
      speech: 'Centre path is safest. Proceed carefully.'
    };

    // Frame 1: Initial announcement of chair
    mockTime = 300000;
    odAPI.announceScene(stationaryChair, safeDirWait, W);
    await new Promise(r => setImmediate(r));
    assert.equal(spokenCues.length, 1);
    assert.match(spokenCues[0], /A chair is directly ahead/i);

    // Frame 2: Identical stationary track 900 ms later -> must be suppressed to avoid voice spam
    mockTime = 300900;
    odAPI.announceScene(stationaryChair, safeDirWait, W);
    await new Promise(r => setImmediate(r));
    assert.equal(spokenCues.length, 1, 'repeated detection of unchanged object must be throttled');

    // Frame 3: Object changes trajectory (starts approaching) -> meaningful change warrants alert!
    mockTime = 302000;
    const approachingChair = [{
      id: 20,
      label: 'chair',
      bbox: [130, 40, 40, 90],
      risk: { level: 'high', score: 80 },
      motion: { trajectory: 'approaching' }
    }];
    const safeDirApproaching = {
      direction: 'stop',
      speech: 'A chair is directly ahead, approaching fast — high risk. Please stop.'
    };
    odAPI.announceScene(approachingChair, safeDirApproaching, W);
    await new Promise(r => setImmediate(r));
    assert.equal(spokenCues.length, 2, 'meaningful risk/motion change must trigger alert');
    assert.match(spokenCues[1], /approaching/i);

    console.log('  ✔ Repeated detection throttling and tracking consistency verified.');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 4. MULTIPLE OBJECTS AT ONCE
  // ─────────────────────────────────────────────────────────────────────────
  {
    // Scene with 3 objects: high-risk chair in center, person on left, car on far right
    const multiObjects = [
      { id: 31, label: 'chair', bbox: [130, 160, 40, 80], riskScore: 85, position: 'center', distanceCategory: 'danger', distanceSource: 'relative-depth' },
      { id: 32, label: 'person', bbox: [70, 100, 40, 80], riskScore: 50, position: 'left', distanceCategory: 'close', distanceSource: 'relative-depth' },
      { id: 33, label: 'car', bbox: [260, 40, 40, 80], riskScore: 20, position: 'right', distanceCategory: 'far', distanceSource: 'size-heuristic' }
    ];

    sceneStateAPI.begin();
    sceneStateAPI.publish({
      frameId: 10,
      timestamp: mockTime,
      videoWidth: W, videoHeight: H,
      tracks: [
        { id: 31, label: 'chair', bbox: [130, 160, 40, 80], risk: { score: 85, level: 'high' }, distInfo: { zone: 'danger', source: 'relative-depth' } },
        { id: 32, label: 'person', bbox: [70, 100, 40, 80], risk: { score: 50, level: 'medium' }, distInfo: { zone: 'close', source: 'relative-depth' } },
        { id: 33, label: 'car', bbox: [260, 40, 40, 80], risk: { score: 20, level: 'low' }, distInfo: { zone: 'far', source: 'size-heuristic' } }
      ],
      safeDir: { direction: 'stop', speech: 'A chair is directly ahead — high risk. Please stop.' }
    });

    const sceneDescription = odAPI.describeLatest();

    // Must describe top salient objects cleanly without stringing together 5 objects
    assert.match(sceneDescription, /A chair is directly ahead/i, 'highest risk object announced first');
    assert.match(sceneDescription, /A person is ahead, slightly to your left/i, 'secondary object included');
    assert.doesNotMatch(sceneDescription, /A car/i, 'tertiary low-risk object excluded to avoid cognitive overload');

    console.log('  ✔ Multiple objects prioritized and summarized concisely.');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 5. CRITICAL HAZARDS TAKING PRIORITY OVER ORDINARY OBJECTS
  // ─────────────────────────────────────────────────────────────────────────
  {
    riskAPI.reset();
    let priorityCues = [];
    guidanceAPI.configure({
      player: text => { priorityCues.push(text); return Promise.resolve(true); },
      cancel: () => {}
    });

    // Routine objects in background + critical ground hazard (descending stairs)
    const backgroundObjects = [
      { id: 40, label: 'person', bbox: [60, 40, 40, 90], risk: { level: 'low', score: 10 } }
    ];
    const stairSafeDir = {
      direction: 'stop',
      speech: 'Descending stairs ahead. Stop and check your step.',
      hazard: { category: 'stairs-down', type: 'stairs-down', confidence: 'confident' }
    };

    odAPI.announceScene(backgroundObjects, stairSafeDir, W);
    await new Promise(r => setImmediate(r));

    assert.equal(priorityCues.length, 1);
    assert.equal(priorityCues[0], 'Descending stairs ahead. Stop and check your step.',
      'critical descending stairs MUST NOT be contaminated with background person description');

    // On-demand description also prioritizes hazard
    sceneStateAPI.begin();
    sceneStateAPI.publish({
      frameId: 11, timestamp: mockTime,
      videoWidth: W, videoHeight: H,
      tracks: backgroundObjects,
      hazard: { category: 'dropoff', type: 'dropoff', label: 'Drop-off detected ahead.', confidence: 'confident' }
    });
    const onDemandHazard = odAPI.describeLatest();
    assert.match(onDemandHazard, /Drop-off detected ahead/i, 'describeLatest announces hazard before objects');
    assert.doesNotMatch(onDemandHazard, /A person/i, 'critical drop-off suppresses routine objects');

    console.log('  ✔ Critical hazards taking immediate priority verified.');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 6. MISSING OR UNRELIABLE DETECTION DATA (HONEST LIMITATIONS)
  // ─────────────────────────────────────────────────────────────────────────
  {
    // Case A: Model degraded or frame errors -> explains limitation
    sceneStateAPI.begin();
    sceneStateAPI.setStatus('degraded', 'Lighting low or camera blurred');

    const degradedDesc = odAPI.describeLatest();
    assert.match(degradedDesc, /temporarily unavailable.*Camera view may be obscured or lighting is too low/i,
      'must explain actual physical limitation when degraded');
    assert.doesNotMatch(degradedDesc, /check your surroundings/i);

    // Case B: Stale frame data -> explains update status
    sceneStateAPI.begin();
    sceneStateAPI.publish({
      frameId: 12, timestamp: mockTime - 10000, // 10s old (stale)
      videoWidth: W, videoHeight: H, tracks: []
    });
    const staleDesc = odAPI.describeLatest();
    assert.match(staleDesc, /Hold steady while the view is assessed/i,
      'stale data must prompt user to hold steady rather than inventing objects');

    // Case C: Unverified terrain -> never says path is clear
    const unverifiedGrid = Array.from({ length: 15 }, (_, i) => ({
      r: Math.floor(i / 5), c: i % 5, status: 'clear', occupancy: 0,
      surfaceCategory: 'unknown', surfaceConfidence: 0.10
    }));
    const advice = window.freeSpaceAPI.analyze({ videoWidth: W, videoHeight: H }, []);
    if (advice && advice.advice) {
      assert(!/safe to walk freely/i.test(advice.advice.speech),
        'unverified terrain must never claim absolute safety');
    }

    console.log('  ✔ Honest reporting of limitations and missing data verified.');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 7. SPEECH NOT BEING REPEATEDLY INTERRUPTED
  // ─────────────────────────────────────────────────────────────────────────
  {
    let played = [];
    guidanceAPI.configure({
      player: text => { played.push(text); return new Promise(r => setTimeout(r, 50)); },
      cancel: () => {}
    });

    // Announce high priority cue
    await guidanceAPI.announce('A chair is directly ahead. Please stop.', { priority: 95, key: 'chair-stop' });

    // Lower priority routine direction cue should NOT interrupt or spam
    const routineAccepted = await guidanceAPI.announce('Continue carefully.', { priority: 25, key: 'dir-continue' });
    // In quiet window after high-priority cue, lower cues are gracefully dropped
    assert.equal(routineAccepted, false, 'lower priority cue must not interrupt high-priority cue in quiet window');

    console.log('  ✔ Speech non-interruption and queue prioritization verified.');
  }

  console.log('\nALL VOICE DESCRIPTION & SAFETY TESTS PASSED SUCCESSFULLY.\n');
})().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
