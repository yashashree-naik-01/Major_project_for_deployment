const vm = require('node:vm');
const fs = require('node:fs');
const assert = require('node:assert/strict');

function canvas(w = 640, h = 480) {
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

async function runBenchmark() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  VisionGuide AI — Performance & Bottleneck Profiling Suite    ');
  console.log('═══════════════════════════════════════════════════════════════');

  const results = {
    modelLoading: {},
    perFrameLatency: {},
    allocationsPerFrame: {},
    duplicateJobs: {},
    mainThreadBlocking: {},
    lifecycleCleanup: {}
  };

  // 1. MODEL LOADING & STARTUP OVERHEAD
  {
    console.log('\n[1] Measuring Model Loading & Startup Latency...');
    const t0 = global.performance.now();
    // Simulate loading mock models and initialization
    const m0 = process.memoryUsage().heapUsed;

    // Load ByteTracker
    const tracker = new window.ByteTracker();
    const tTracker = global.performance.now() - t0;
    const mTracker = process.memoryUsage().heapUsed - m0;

    results.modelLoading.trackerLoadMs = tTracker;
    results.modelLoading.trackerMemoryBytes = mTracker;
    console.log(`  • Tracker initialization: ${tTracker.toFixed(2)} ms, Memory: ${(mTracker / 1024).toFixed(1)} KB`);
  }

  // 2. PER-FRAME INFERENCE LATENCY (Hazard & Navigation Pipeline)
  {
    console.log('\n[2] Measuring Per-Frame Processing Latency (50 frames)...');
    const hazardAPI = window.hazardDetectorAPI;
    const freeSpaceAPI = window.freeSpaceAPI;
    const riskAPI = window.riskAPI;

    const W = 300, H = 300;
    const dw = 60, dh = 60;
    const depthMap = {
      data: new Float32Array(dw * dh),
      width: dw, height: dh,
      sceneMin: 0.2, sceneMax: 1.0
    };
    for (let y = 0; y < dh; y++) {
      for (let x = 0; x < dw; x++) {
        depthMap.data[y * dw + x] = 0.2 + (y / dh) * 0.7;
      }
    }

    const mockTracks = [
      { id: 1, label: 'person', bbox: [100, 120, 60, 140], score: 0.92, distInfo: { zone: 'close' } },
      { id: 2, label: 'chair', bbox: [20, 150, 40, 80], score: 0.85, distInfo: { zone: 'medium' } }
    ];

    const surfaceMap = {
      cells: Array.from({ length: 15 }, (_, i) => ({
        r: Math.floor(i / 5), c: i % 5,
        surfaceCategory: 'footpath', surfaceConfidence: 0.85
      }))
    };

    window.depthAPI.getDepthMap = () => depthMap;
    window.surfaceSegmentationAPI.getSurfaceMap = () => surfaceMap;

    const latencies = [];
    const memoryBefore = process.memoryUsage().heapUsed;

    for (let frame = 0; frame < 50; frame++) {
      mockTime += 100;
      const tStart = global.performance.now();

      // Step A: Risk enrichment
      const enriched = riskAPI.enrich(mockTracks, W, H);

      // Step B: Free space & hazard analysis
      const freeSpace = freeSpaceAPI.analyze({ videoWidth: W, videoHeight: H }, enriched);

      // Step C: Safe direction computation
      const safeDir = riskAPI.computeSafeDir(enriched, freeSpace, W, H);

      // Step D: Scene state publication
      window.sceneStateAPI.publish({
        frameId: frame + 1, timestamp: mockTime,
        tracks: enriched, freeSpace, safeDir,
        videoWidth: W, videoHeight: H, processingMs: 0
      });

      const tEnd = global.performance.now();
      latencies.push(tEnd - tStart);
    }

    const memoryAfter = process.memoryUsage().heapUsed;
    const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const maxLatency = Math.max(...latencies);
    const minLatency = Math.min(...latencies);
    const p95Latency = latencies.slice().sort((a,b)=>a-b)[Math.floor(latencies.length * 0.95)];
    const totalAllocBytes = Math.max(0, memoryAfter - memoryBefore);
    const allocPerFrame = totalAllocBytes / 50;

    results.perFrameLatency = { avgLatency, maxLatency, minLatency, p95Latency };
    results.allocationsPerFrame = { totalAllocBytes, allocPerFrame };

    console.log(`  • Average pipeline latency: ${avgLatency.toFixed(3)} ms`);
    console.log(`  • 95th percentile latency:  ${p95Latency.toFixed(3)} ms`);
    console.log(`  • Max frame spike:          ${maxLatency.toFixed(3)} ms`);
    console.log(`  • Net heap growth (50 frames): ${(totalAllocBytes / 1024).toFixed(1)} KB (~${(allocPerFrame / 1024).toFixed(2)} KB/frame)`);
  }

  // 3. SEGMENTATION & DEPTH PARSING OVERHEAD
  {
    console.log('\n[3] Measuring Surface & Depth Extraction Bottlenecks...');
    const surfaceAPI = window.surfaceSegmentationAPI;
    const mockMask = new Uint8Array(512 * 512);
    // Fill realistic segmentation labels
    for (let i = 0; i < mockMask.length; i++) {
      mockMask[i] = i > mockMask.length * 0.5 ? 11 : 0; // sidewalk vs wall
    }

    const tParseStart = global.performance.now();
    for (let i = 0; i < 20; i++) {
      const summary = surfaceAPI.parseSegmentationOutput(mockMask, 512, 512, 5, 3);
      assert(summary && summary.cells);
    }
    const tParseEnd = global.performance.now();
    const avgParseMs = (tParseEnd - tParseStart) / 20;
    console.log(`  • 512×512 surface mask aggregation to 5×3 grid: ${avgParseMs.toFixed(3)} ms/frame`);
  }

  // 4. DUPLICATE INFERENCE & ASYNC SCHEDULING INVESTIGATION
  {
    console.log('\n[4] Investigating Duplicate Inference & Scheduling Conflicts...');
    // Inspect config intervals:
    const cfg = window.VisionGuideConfig;
    console.log(`  • Detection interval:   ${cfg.detection.intervalMs} ms (~${(1000/cfg.detection.intervalMs).toFixed(1)} Hz)`);
    console.log(`  • Depth interval:       ${cfg.depth.intervalMs} ms (~${(1000/cfg.depth.intervalMs).toFixed(1)} Hz)`);
    console.log(`  • Surface interval:     ${cfg.surface.intervalMs} ms (~${(1000/cfg.surface.intervalMs).toFixed(1)} Hz)`);

    // In current implementation, detection, depth, and surface each run in completely uncoordinated setTimeout loops!
    // Every ~3000ms, all 3 loops collide on the main JavaScript thread simultaneously!
    const collisionPeriodMs = 3000;
    console.log(`  • Collision analysis: Every ${collisionPeriodMs} ms, up to 3 models trigger concurrently on the main thread.`);
  }

  // 5. LIFECYCLE CLEANUP & LEAK PROFILE
  {
    console.log('\n[5] Investigating Lifecycle & Memory Cleanup...');
    const mBefore = process.memoryUsage().heapUsed;
    window.objectDetectionAPI.startDetection(canvas(), canvas());
    window.depthAPI.startDepthLoop(canvas());
    window.surfaceSegmentationAPI.startSurfaceLoop(canvas());

    // Stop all loops
    window.objectDetectionAPI.stopDetection();
    window.depthAPI.stopDepthLoop();
    window.surfaceSegmentationAPI.stopSurfaceLoop();
    window.guidanceAPI.reset();

    const mAfter = process.memoryUsage().heapUsed;
    const retainedBytes = Math.max(0, mAfter - mBefore);
    console.log(`  • Post-stop retained memory: ${(retainedBytes / 1024).toFixed(1)} KB`);
    console.log(`  • Detection active: ${window.objectDetectionAPI.isActive()}`);
    console.log(`  • Depth loop active: ${window.depthAPI.isActive()}`);
    console.log(`  • Surface loop active: ${window.surfaceSegmentationAPI.isActive()}`);
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  Baseline Performance Measurement Complete                   ');
  console.log('═══════════════════════════════════════════════════════════════\n');
  return results;
}

runBenchmark().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
