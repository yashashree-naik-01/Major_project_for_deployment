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
let mockTime = 100000;
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
  'riskEngine.js',
  'objectDetection.js'
]) {
  vm.runInContext(fs.readFileSync(`dist/${file}`, 'utf8'), context, { filename: file });
}

(async () => {
  const guidanceAPI = window.guidanceAPI;
  assert(guidanceAPI, 'guidanceAPI must be exposed on window');
  const riskAPI = window.riskAPI;
  assert(riskAPI, 'riskAPI must be exposed on window');
  const objectDetectionAPI = window.objectDetectionAPI;
  assert(objectDetectionAPI, 'objectDetectionAPI must be exposed on window');

  console.log('=== TEST SUITE: Guidance Manager, Alert Prioritization & Safety Rules ===');

  // ─────────────────────────────────────────────────────────────────────────
  // 1. ALERT PRIORITY HIERARCHY & INTERRUPTION
  // ─────────────────────────────────────────────────────────────────────────
  {
    guidanceAPI.reset();
    const spoken = [];
    let activeResolver = null;

    guidanceAPI.configure({
      player: text => {
        spoken.push(text);
        return new Promise(resolve => { activeResolver = resolve; });
      },
      cancel: () => {
        const r = activeResolver;
        activeResolver = null;
        r?.(false);
      }
    });

    // Start with a routine low-priority cue
    const pLow = guidanceAPI.announce('Bench on your right', { priority: 30, key: 'bench' });
    assert.equal(spoken.length, 1);
    assert.equal(spoken[0], 'Bench on your right');
    assert.equal(guidanceAPI.getState().speaking, true);

    // Enqueue an OCR reading (priority 45)
    const pOcr = guidanceAPI.announce('Entrance door text', { priority: 45, key: 'ocr-door' });

    // Urgent hazard arrives with interrupt: true (priority 100)
    const pUrgent = guidanceAPI.announce('Possible descending stairs ahead. Stop and check.', {
      priority: 100, interrupt: true, key: 'stairs-down-uncertain'
    });

    await new Promise(r => setImmediate(r));

    // Routine speech was interrupted, and urgent warning took over immediately
    assert.equal(spoken.length, 2);
    assert.equal(spoken[1], 'Possible descending stairs ahead. Stop and check.');

    // Stale lower-priority queued item (OCR) was purged by the interrupt
    assert.equal(await pOcr, false, 'lower priority queued items must be purged upon urgent interrupt');

    // Finish urgent warning
    activeResolver?.(true);
    await pUrgent;
    await pLow;
    assert.equal(guidanceAPI.getState().speaking, false);
    console.log('  ✔ Alert priority interruption and lower-queue eviction verified.');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 2. URGENT WARNING PROTECTION & QUIET WINDOW
  // ─────────────────────────────────────────────────────────────────────────
  {
    guidanceAPI.reset();
    const spoken = [];
    let activeResolver = null;

    guidanceAPI.configure({
      player: text => {
        spoken.push(text);
        return new Promise(resolve => { activeResolver = resolve; });
      },
      cancel: () => {
        const r = activeResolver;
        activeResolver = null;
        r?.(false);
      }
    });

    // Speak urgent warning (priority 100)
    const pUrgent = guidanceAPI.announce('Drop-off detected ahead. Stop and check your step.', {
      priority: 110, interrupt: true, key: 'dropoff-urgent'
    });

    assert.equal(spoken.length, 1);
    assert.equal(spoken[0], 'Drop-off detected ahead. Stop and check your step.');

    // While urgent warning is active, ordinary object cue (priority 30) must be rejected
    const rejectedDuringActive = await guidanceAPI.announce('Chair on your left', { priority: 30, key: 'chair-routine' });
    assert.equal(rejectedDuringActive, false, 'ordinary object cues must not interrupt active urgent warning');

    // Complete the urgent alert
    activeResolver?.(true);
    await pUrgent;

    // Immediately after alert finishes, Quiet Window (3000ms) is active
    assert.equal(guidanceAPI.getState().quietWindowActive, true, 'quiet window must be active after urgent alert');

    // In quiet window: ordinary object cues and OCR must be suppressed to hear surroundings
    const rejectedInQuietWindow = await guidanceAPI.announce('Bottle ahead', { priority: 30, key: 'bottle-cue' });
    assert.equal(rejectedInQuietWindow, false, 'ordinary speech must be suppressed in quiet window to protect ambient hearing');

    const ocrInQuietWindow = await guidanceAPI.announce('Shop name sign', { priority: 45, key: 'ocr-sign' });
    assert.equal(ocrInQuietWindow, false, 'OCR text reading must be suppressed in quiet window');

    // But another critical or urgent alert CAN still get through during quiet window!
    const criticalThroughQuiet = guidanceAPI.announce('Approaching vehicle ahead — high risk.', {
      priority: 110, interrupt: true, key: 'vehicle-danger'
    });
    assert.equal(spoken.length, 2, 'critical hazards must bypass quiet window suppression');
    assert.equal(spoken[1], 'Approaching vehicle ahead — high risk.');
    activeResolver?.(true);
    await criticalThroughQuiet;

    // Advance mock time past the quiet window (3000ms + 500ms)
    mockTime += 3500;
    assert.equal(guidanceAPI.getState().quietWindowActive, false);

    // Now ordinary cues are allowed through again
    const acceptedAfterQuiet = guidanceAPI.announce('Bench on your right', { priority: 30, key: 'bench-post-quiet' });
    assert.equal(spoken.length, 3);
    assert.equal(spoken[2], 'Bench on your right');
    activeResolver?.(true);
    await acceptedAfterQuiet;

    console.log('  ✔ Urgent warning protection and ambient hearing quiet window verified.');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 3. ADAPTIVE DEDUPLICATION & PROGRESSIVE REPETITION BACKOFF
  // ─────────────────────────────────────────────────────────────────────────
  {
    guidanceAPI.reset();
    const spoken = [];

    guidanceAPI.configure({
      player: text => {
        spoken.push(text);
        return Promise.resolve(true);
      },
      cancel: () => {}
    });

    const hazardKey = 'hazard:pothole:confident:stop';
    const alertText = 'Pothole detected ahead. Step carefully.';

    // 1st detection: speaks immediately
    const a1 = await guidanceAPI.announce(alertText, { key: hazardKey, priority: 85 });
    assert.equal(a1, true);
    assert.equal(spoken.length, 1);

    // Immediate repeat within 2 seconds: suppressed (1st backoff = 5000ms)
    mockTime += 2000;
    const a2 = await guidanceAPI.announce(alertText, { key: hazardKey, priority: 85 });
    assert.equal(a2, false, 'rapid duplicate alert must be suppressed');
    assert.equal(spoken.length, 1);

    // After 5.1s: 2nd announcement permitted (escalates backoff index to 12000ms)
    mockTime += 3100; // total 5100ms
    const a3 = await guidanceAPI.announce(alertText, { key: hazardKey, priority: 85 });
    assert.equal(a3, true, 'alert permitted after first backoff interval (5s)');
    assert.equal(spoken.length, 2);

    // Repeat after only 8 seconds: suppressed because backoff increased to 12s!
    mockTime += 8000;
    const a4 = await guidanceAPI.announce(alertText, { key: hazardKey, priority: 85 });
    assert.equal(a4, false, 'suppressed because backoff interval increased to 12s');
    assert.equal(spoken.length, 2);

    // After 12.5s: 3rd announcement permitted (escalates backoff index to 25000ms)
    mockTime += 4500; // total 12500ms since last spoken
    const a5 = await guidanceAPI.announce(alertText, { key: hazardKey, priority: 85 });
    assert.equal(a5, true, 'alert permitted after 12s backoff interval');
    assert.equal(spoken.length, 3);

    console.log('  ✔ Adaptive deduplication and progressive exponential backoff verified.');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 4. COMPETING HAZARDS & ANNOUNCE SCENE PRIORITIZATION
  // ─────────────────────────────────────────────────────────────────────────
  {
    guidanceAPI.reset();
    riskAPI.reset();
    const announcedCues = [];

    // Spy on guidanceAPI.announce
    const originalAnnounce = guidanceAPI.announce;
    guidanceAPI.announce = (text, opts) => {
      announcedCues.push({ text, opts });
      return originalAnnounce(text, opts);
    };

    // Scenario: Routine chair is in scene, but descending stairs is detected ahead
    const tracks = [
      { id: 4, label: 'chair', bbox: [120, 140, 50, 90], risk: { score: 72, level: 'high' }, distInfo: { zone: 'close' }, motion: { trajectory: 'stationary' } }
    ];
    const stairsSafeDir = {
      direction: 'stop',
      speech: 'Descending stairs ahead. Stop and check your step.',
      hazard: { category: 'stairs-down', type: 'stairs-down', confidence: 'confident', proximity: 'immediate' }
    };

    objectDetectionAPI.announceScene(tracks, stairsSafeDir, 300);

    assert.equal(announcedCues.length, 1);
    const cue = announcedCues[0];
    assert.equal(cue.text, 'Descending stairs ahead. Stop and check your step.',
      'critical hazard must NOT be contaminated by routine chair description');
    assert.equal(cue.opts.priority, 110, 'confident descending stairs must have critical priority (110)');
    assert.equal(cue.opts.interrupt, true, 'critical hazard must interrupt active speech');

    // Restore spy
    guidanceAPI.announce = originalAnnounce;
    console.log('  ✔ Competing hazards correctly prioritized over routine scene objects.');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 5. PATH VALIDATION & AVOIDANCE OF UNCONDITIONAL LATERAL COMMANDS
  // ─────────────────────────────────────────────────────────────────────────
  {
    riskAPI.reset();
    const blankGrid = Array.from({ length: 15 }, (_, i) => ({
      r: Math.floor(i / 5), c: i % 5, status: 'clear', occupancy: 0,
      surfaceCategory: 'footpath', surfaceConfidence: 0.90
    }));

    // Case A: Left corridor has a drop-off or obstacle -> Lateral path NOT validated!
    const unvalidatedGrid = blankGrid.map(cell => {
      if (cell.r === 2 && cell.c === 0) return { ...cell, status: 'dropoff' };
      return cell;
    });

    const zonesUnvalidated = {
      left: { freePct: 70, riskLevel: 'low', safetyScore: 50, tracks: [] },
      center: { freePct: 20, riskLevel: 'high', safetyScore: -20, tracks: [
        { id: 1, label: 'person', risk: { level: 'high' }, motion: { trajectory: 'approaching' } }
      ] },
      right: { freePct: 20, riskLevel: 'high', safetyScore: -20, tracks: [] }
    };

    const isLeftValid = riskAPI.validateLateralPath('left', zonesUnvalidated, { grid: unvalidatedGrid });
    assert.equal(isLeftValid, false, 'lateral corridor containing dropoff cell must not be validated');

    // computeSafeDir speech must NOT say "Move left" when the lateral path is unvalidated!
    const unvalidatedDir = riskAPI.computeSafeDir([], {
      grid: unvalidatedGrid,
      hazard: { type: 'pothole', category: 'pothole', confidence: 'confident', cells: [{ r: 2, c: 2 }] }
    }, 300, 300);

    assert.doesNotMatch(unvalidatedDir.speech, /\bMove left\b/i,
      'must not issue unconditional "Move left" command into unvalidated corridor');
    assert.doesNotMatch(unvalidatedDir.speech, /left side appears clearer/i,
      'must not claim lateral side is clearer when that corridor is blocked by hazard');

    // Case B: Road or wall in lateral corridor -> Lateral path NOT validated!
    const roadCorridorGrid = blankGrid.map(cell => {
      if (cell.c <= 1) return { ...cell, surfaceCategory: 'road', surfaceConfidence: 0.85 };
      return cell;
    });
    const isRoadValid = riskAPI.validateLateralPath('left', zonesUnvalidated, { grid: roadCorridorGrid });
    assert.equal(isRoadValid, false, 'lateral corridor stepping into road must not be validated');

    // Case C: Truly clear and validated corridor -> Lateral direction permitted
    const validatedGrid = blankGrid.map(cell => ({ ...cell }));
    const isLeftReallyValid = riskAPI.validateLateralPath('left', zonesUnvalidated, { grid: validatedGrid });
    assert.equal(isLeftReallyValid, true, 'clear corridor with verified footpath must validate');

    console.log('  ✔ Lateral path validation and unconditional steering suppression verified.');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 6. CAUTIOUS WORDING FOR UNCERTAIN VS CONFIDENT DETECTIONS
  // ─────────────────────────────────────────────────────────────────────────
  {
    riskAPI.reset();
    const blankGrid = Array.from({ length: 15 }, (_, i) => ({
      r: Math.floor(i / 5), c: i % 5, status: 'clear', occupancy: 0,
      surfaceCategory: 'footpath', surfaceConfidence: 0.90
    }));

    // Uncertain drop-off with validated side
    const uncertainDrop = riskAPI.computeSafeDir([], {
      grid: blankGrid,
      hazard: { type: 'dropoff', confidence: 'uncertain', cells: [{ c: 2 }] }
    }, 300, 300);
    assert.match(uncertainDrop.speech, /Possible drop-off ahead/i, 'uncertain drop-off must use cautious wording');
    assert.doesNotMatch(uncertainDrop.speech, /\bMove (?:left|right)\b/i, 'drop-off advice must never issue unconditional movement commands');

    // Confident drop-off
    const confidentDrop = riskAPI.computeSafeDir([], {
      grid: blankGrid,
      hazard: { type: 'dropoff', confidence: 'confident', cells: [{ c: 2 }] }
    }, 300, 300);
    assert.match(confidentDrop.speech, /Drop-off detected ahead/i, 'confident drop-off must use confident warning');
    assert.doesNotMatch(confidentDrop.speech, /\bMove (?:left|right)\b/i);

    // Uncertain uncovered drain
    const uncertainDrain = riskAPI.computeSafeDir([], {
      grid: blankGrid,
      hazard: { type: 'uncovered-drain', category: 'uncovered-drain', confidence: 'uncertain', cells: [{ c: 2 }] }
    }, 300, 300);
    assert.equal(uncertainDrain.speech, 'Possible uncovered drain ahead. Proceed with caution.');

    // Confident uncovered drain
    const confidentDrain = riskAPI.computeSafeDir([], {
      grid: blankGrid,
      hazard: { type: 'uncovered-drain', category: 'uncovered-drain', confidence: 'confident', cells: [{ c: 2 }] }
    }, 300, 300);
    assert.equal(confidentDrain.speech, 'Uncovered drain detected ahead. Please stop.');

    console.log('  ✔ Cautious wording for uncertain detections verified.');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 7. SYSTEM FAILURE & VISIBILITY NOTIFICATIONS
  // ─────────────────────────────────────────────────────────────────────────
  {
    guidanceAPI.reset();
    const statusAnnouncements = [];
    guidanceAPI.configure({
      player: text => {
        statusAnnouncements.push(text);
        return Promise.resolve(true);
      },
      cancel: () => {}
    });

    // Report model failure
    await guidanceAPI.reportSystemStatus({
      type: 'model',
      level: 'error',
      message: 'Live visual analysis is unavailable. Do not rely on camera guidance.'
    });

    assert.equal(statusAnnouncements.length, 1);
    assert.equal(statusAnnouncements[0], 'Live visual analysis is unavailable. Do not rely on camera guidance.');
    assert.equal(guidanceAPI.getSystemHealth().model.level, 'error');

    // Advance time and report poor visibility
    mockTime += 26000;
    await guidanceAPI.reportSystemStatus({
      type: 'visibility',
      level: 'poor',
      message: 'Surface visibility is limited. Proceed with caution.'
    });

    assert.equal(statusAnnouncements.length, 2);
    assert.equal(statusAnnouncements[1], 'Surface visibility is limited. Proceed with caution.');
    assert.equal(guidanceAPI.getSystemHealth().visibility.level, 'poor');

    // Advance time and report delayed depth estimation
    mockTime += 26000;
    await guidanceAPI.reportSystemStatus({
      type: 'depth_stale'
    });

    assert.equal(statusAnnouncements.length, 3);
    assert.equal(statusAnnouncements[2], 'Depth estimation is delayed. Proceed with extra caution.');

    console.log('  ✔ System health and visibility degradation reporting verified.');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 8. PRESERVATION OF EXISTING FEATURES (OCR, VOICE, GPS, CLEAR RULES)
  // ─────────────────────────────────────────────────────────────────────────
  {
    guidanceAPI.reset();
    const spoken = [];
    guidanceAPI.configure({
      player: text => {
        spoken.push(text);
        return Promise.resolve(true);
      },
      cancel: () => {}
    });

    // OCR reading works
    await guidanceAPI.announce('Platform 3 Express', { priority: 45, key: 'ocr:platform-3' });
    assert.equal(spoken[0], 'Platform 3 Express');

    // Voice command feedback works
    await guidanceAPI.announce('Navigation started.', { priority: 70, key: 'voice:cmd' });
    assert.equal(spoken[1], 'Navigation started.');

    // GPS turn guidance works
    await guidanceAPI.announce('Turn right onto Main Street.', { priority: 75, key: 'gps:turn:1' });
    assert.equal(spoken[2], 'Turn right onto Main Street.');

    // Partial queue clear (belowPriority: 89) retains critical hazards
    guidanceAPI.clear({ belowPriority: 89, cancelActive: true });
    assert.equal(guidanceAPI.getState().queued, 0);

    console.log('  ✔ Existing accessibility features (OCR, voice commands, GPS) preserved.');
  }

  console.log('\nALL GUIDANCE MANAGER VERIFICATION TESTS PASSED SUCCESSFULLY.');
})().catch(err => {
  console.error('TEST FAILURE:', err);
  process.exitCode = 1;
});
