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
  navigator: { gpu: null } // simulate browser without WebGPU by default
};
vm.createContext(context);

// Load vision modules in sequence
for (const file of [
  'visionConfig.js',
  'sceneState.js',
  'guidanceManager.js',
  'tracker.js',
  'depthEstimation.js',
  'surfaceSegmentation.js',
  'freeSpaceAnalyzer.js',
  'riskEngine.js'
]) {
  vm.runInContext(fs.readFileSync(`dist/${file}`, 'utf8'), context, { filename: file });
}

(async () => {
  const surfaceAPI = window.surfaceSegmentationAPI;
  assert(surfaceAPI, 'surfaceSegmentationAPI must be exposed on window');

  // ── 1. Semantic Class Mapping & Unknown Region Handling ──────────
  // Verified labels mapping to standard categories
  assert.equal(surfaceAPI.mapLabelToCategory('sidewalk'), 'footpath');
  assert.equal(surfaceAPI.mapLabelToCategory('pavement'), 'footpath');
  assert.equal(surfaceAPI.mapLabelToCategory('pathway'), 'footpath');
  assert.equal(surfaceAPI.mapLabelToCategory('road'), 'road');
  assert.equal(surfaceAPI.mapLabelToCategory('highway'), 'road');
  assert.equal(surfaceAPI.mapLabelToCategory('stairs'), 'stairs');
  assert.equal(surfaceAPI.mapLabelToCategory('stairway'), 'stairs');
  assert.equal(surfaceAPI.mapLabelToCategory('steps'), 'stairs');
  assert.equal(surfaceAPI.mapLabelToCategory('wall'), 'wall');
  assert.equal(surfaceAPI.mapLabelToCategory('fence'), 'wall');
  assert.equal(surfaceAPI.mapLabelToCategory('floor'), 'floor');
  assert.equal(surfaceAPI.mapLabelToCategory('flooring'), 'floor');
  assert.equal(surfaceAPI.mapLabelToCategory('grass'), 'terrain');
  assert.equal(surfaceAPI.mapLabelToCategory('earth'), 'terrain');

  // Unknown handling: ambiguous, non-ground, unmapped, or low confidence
  assert.equal(surfaceAPI.mapLabelToCategory('sky'), 'unknown');
  assert.equal(surfaceAPI.mapLabelToCategory('alien-creature'), 'unknown');
  assert.equal(surfaceAPI.mapLabelToCategory('mysterious-anomaly'), 'unknown');
  assert.equal(surfaceAPI.mapLabelToCategory('brick-sidewalk'), 'footpath');
  assert.equal(surfaceAPI.mapLabelToCategory('stone-stairs'), 'stairs');
  assert.equal(surfaceAPI.mapLabelToCategory(''), 'unknown');
  assert.equal(surfaceAPI.mapLabelToCategory(null), 'unknown');
  // Score below threshold (< 0.40) must be classified as unknown
  assert.equal(surfaceAPI.mapLabelToCategory('sidewalk', 0.25), 'unknown', 'low confidence sidewalk must be classified as unknown');
  assert.equal(surfaceAPI.mapLabelToCategory('stairs', 0.38), 'unknown', 'low confidence stairs must be classified as unknown');

  // ── 2. Output Parsing & 5x3 Grid Aggregation ─────────────────────
  const W = 300, H = 300;
  const mockMask = new Uint8Array(W * H);
  // Fill lower half with sidewalk
  for (let y = Math.floor(H * 0.5); y < H; y++) {
    for (let x = 0; x < W; x++) {
      mockMask[y * W + x] = 255;
    }
  }

  const rawSegments = [
    { label: 'sidewalk', score: 0.92, mask: { data: mockMask, width: W, height: H } }
  ];

  const parsed = surfaceAPI.parseSegmentationOutput(rawSegments, W, H);
  assert(parsed && parsed.cells && parsed.cells.length === 15, 'must parse into 15 grid cells (5x3)');
  assert(parsed.overallShares.footpath >= 40, 'must detect footpath share in overall summary');

  // Row 2 (bottom row) center cell must be classified as footpath
  const nearCenter = parsed.cells.find(c => c.r === 2 && c.c === 2);
  assert.equal(nearCenter.primaryCategory, 'footpath');
  assert(nearCenter.shares.footpath >= 0.80);

  // Row 0 (top row) center cell must be classified as unknown (since mask was only in bottom half)
  const farCenter = parsed.cells.find(c => c.r === 0 && c.c === 2);
  assert.equal(farCenter.primaryCategory, 'unknown', 'top row with no mask must be classified as unknown');

  // Robustness with corrupt / empty segments
  const emptyParsed = surfaceAPI.parseSegmentationOutput([], W, H);
  assert(emptyParsed && emptyParsed.cells.length === 15);
  assert.equal(emptyParsed.cells[0].primaryCategory, 'unknown');
  assert.doesNotThrow(() => surfaceAPI.parseSegmentationOutput(null, W, H));
  assert.doesNotThrow(() => surfaceAPI.parseSegmentationOutput([{ label: 'invalid' }], W, H));

  // ── 3. Safety Rule: Sidewalk NEVER overrides Obstacles or Drop-offs ─
  const blankGrid = Array.from({ length: 15 }, (_, i) => ({
    r: Math.floor(i / 5), c: i % 5,
    status: 'clear', zone: null, src: null, label: null
  }));

  // Create grid with an existing detected obstacle (e.g. bicycle or chair on the sidewalk)
  const obstacleGrid = blankGrid.map(cell => ({ ...cell }));
  obstacleGrid[12].status = 'obstacle'; // row 2, col 2 has obstacle
  obstacleGrid[12].zone = 'danger';
  obstacleGrid[12].src = 'det';
  obstacleGrid[12].label = 'chair';

  const mockFootpathMap = {
    cells: blankGrid.map(c => ({
      r: c.r, c: c.c,
      primaryCategory: 'footpath',
      confidence: 0.95,
      shares: { footpath: 1, road: 0, stairs: 0, wall: 0, floor: 0, terrain: 0, unknown: 0 }
    }))
  };

  // Fuse surfaces
  window.freeSpaceAPI.applySurfaces(obstacleGrid, mockFootpathMap, W, H, null);

  // The obstacle MUST NOT be downgraded or cleared!
  assert.equal(obstacleGrid[12].status, 'obstacle', 'sidewalk classification must NEVER downgrade an obstacle');
  assert.equal(obstacleGrid[12].label, 'chair');
  assert.equal(obstacleGrid[12].surfaceCategory, 'footpath');

  // Create grid with an existing drop-off hazard (e.g. sidewalk curb / edge drop)
  const dropoffGrid = blankGrid.map(cell => ({ ...cell }));
  dropoffGrid[12].status = 'dropoff';
  dropoffGrid[12].zone = 'danger';
  dropoffGrid[12].src = 'depth-drop';

  window.freeSpaceAPI.applySurfaces(dropoffGrid, mockFootpathMap, W, H, { type: 'dropoff', confidence: 'confident' });
  assert.equal(dropoffGrid[12].status, 'dropoff', 'sidewalk classification must NEVER clear a ground drop-off');

  // ── 4. Structural Wall / Barrier Detection ────────────────────────
  const wallGrid = blankGrid.map(cell => ({ ...cell }));
  const mockWallMap = {
    cells: blankGrid.map(c => ({
      r: c.r, c: c.c,
      primaryCategory: c.c === 0 ? 'wall' : 'footpath',
      confidence: 0.90,
      shares: {
        footpath: c.c === 0 ? 0 : 1,
        road: 0, stairs: 0,
        wall: c.c === 0 ? 0.90 : 0,
        floor: 0, terrain: 0, unknown: 0
      }
    }))
  };

  window.freeSpaceAPI.applySurfaces(wallGrid, mockWallMap, W, H, null);
  const wallCell = wallGrid.find(c => c.r === 2 && c.c === 0);
  assert.equal(wallCell.status, 'obstacle', 'wall surface must be marked as obstacle');
  assert.equal(wallCell.src, 'surface-wall');

  // ── 5. Semantic Stairs Confirmation & Depth Fusion ───────────────
  const stairsGrid = blankGrid.map(cell => ({ ...cell }));
  const mockStairsMap = {
    cells: blankGrid.map(c => ({
      r: c.r, c: c.c,
      primaryCategory: c.c === 2 ? 'stairs' : 'footpath',
      confidence: 0.88,
      shares: {
        footpath: c.c === 2 ? 0.1 : 0.9,
        road: 0,
        stairs: c.c === 2 ? 0.80 : 0,
        wall: 0, floor: 0, terrain: 0, unknown: 0
      }
    }))
  };

  const initialStairsHazard = {
    type: 'stairs-down',
    confidence: 'uncertain',
    label: 'Possible descending stairs ahead',
    edgeCount: 2
  };

  const elevatedHazard = window.freeSpaceAPI.applySurfaces(stairsGrid, mockStairsMap, W, H, initialStairsHazard);
  assert.equal(elevatedHazard.type, 'stairs-down');
  assert.equal(elevatedHazard.confidence, 'confident', 'semantic stairs confirmation elevates uncertain depth hazard to confident');
  assert.equal(elevatedHazard.surfaceConfirmed, true);

  // ── 6. Roadway Caution ───────────────────────────────────────────
  const roadGrid = blankGrid.map(cell => ({ ...cell }));
  const mockRoadMap = {
    cells: blankGrid.map(c => ({
      r: c.r, c: c.c,
      primaryCategory: c.c === 2 && c.r >= 1 ? 'road' : 'footpath',
      confidence: 0.90,
      shares: {
        footpath: c.c === 2 && c.r >= 1 ? 0 : 1,
        road: c.c === 2 && c.r >= 1 ? 0.90 : 0,
        stairs: 0, wall: 0, floor: 0, terrain: 0, unknown: 0
      }
    }))
  };

  window.freeSpaceAPI.applySurfaces(roadGrid, mockRoadMap, W, H, null);
  const roadCell = roadGrid.find(c => c.r === 2 && c.c === 2);
  assert.equal(roadCell.status, 'caution', 'roadway surface in walking path must be marked caution');
  assert.equal(roadCell.src, 'surface-road');

  // ── 7. Graceful Fallback Handling & Lifecycle ────────────────────
  surfaceAPI.reset();
  assert.equal(surfaceAPI.isLoaded(), false);
  assert.equal(surfaceAPI.getSurfaceMap(), null);
  assert.equal(surfaceAPI.getSurfaceAge(), Infinity);

  // Fallback when network/model unavailable
  const fallbackResult = await surfaceAPI.loadModel({ modelId: 'non-existent-model-id-for-testing' });
  assert.equal(fallbackResult, null, 'must return null on load failure rather than crashing');
  assert.equal(surfaceAPI.isLoaded(), false);
  assert(surfaceAPI.getError(), 'must set error message');

  // Calling freeSpaceAPI.analyze when surface model is absent continues without failure
  window.freeSpaceAPI.reset();
  const testVideo = { videoWidth: 300, videoHeight: 300 };
  const fallbackAnalysis = window.freeSpaceAPI.analyze(testVideo, []);
  assert(fallbackAnalysis && fallbackAnalysis.grid.length === 15, 'pipeline continues gracefully in absence of surface model');
  assert.equal(fallbackAnalysis.surface, null);

  // ── 8. Scene State Snapshot Preservation ─────────────────────────
  const publishedScene = window.sceneStateAPI.publish({
    frameId: 10,
    timestamp: Date.now(),
    videoWidth: 300,
    videoHeight: 300,
    tracks: [],
    surface: parsed
  });
  assert(publishedScene.surface, 'scene state must retain surface snapshot');
  assert.equal(publishedScene.surface.available, true);
  assert.equal(publishedScene.surface.primaryCategory, 'footpath');
  assert(Object.isFrozen(publishedScene.surface), 'surface metadata must be frozen');

  console.log('PASS: surface-segmentation class mapping, unknown region rejection, 5x3 grid aggregation, sidewalk safety rule (never overrides obstacles or drop-offs), wall barrier detection, stairs semantic fusion, road surface caution, graceful load failure fallback, and scene state preservation.');
})().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
