// ═══════════════════════════════════════════════════════════════════
//  VisionGuide — Free-Space / Safe Walking Area Analyzer
//
//  Inspired by YOLOP (drivable-area segmentation) adapted for
//  pedestrian navigation — no extra AI model needed.
//
//  Two obstacle sources fused into a 5×3 navigation grid:
//    1. ByteTrack detections  → named obstacles (person, chair …)
//    2. Depth-Anything-V2     → floor deviation → undetected objects
//
//  Visual outputs drawn on the existing od-overlay-canvas:
//    • Semi-transparent cell tints  (green=no alert, yellow=caution, red=obstacle)
//    • Navigation ribbon at bottom  (Left | Center | Right status)
//    • Direction arrow              (↑ forward, ↗ right, ↖ left, ✗ stop)
//
//  Voice outputs (separate from object detection speech):
//    "No tracked obstacle is ahead. Continue carefully."
//    "Obstacle directly ahead. The left side appears clearer."
//    "Path blocked on all sides. Please stop."
//
//  Exposes: window.freeSpaceAPI
// ═══════════════════════════════════════════════════════════════════
(function () {
  'use strict';
  const CFG = window.VisionGuideConfig?.freeSpace || {};

  /* ─── Grid config ────────────────────────────────────────────── */
  const COLS = CFG.columns || 5;
  const ROWS = CFG.rows || 3;

  /* ─── Thresholds ─────────────────────────────────────────────── */
  // Detected bbox must cover ≥ this fraction of a cell to mark it obstacle
  const DET_OVERLAP = CFG.detectionOverlap ?? 0.20;
  let _smoothedCells = [];
  let _lastFloorBaseline = null;
  let _lastRange = 1;
  let _hazardTracker = {
    type: null,
    confidence: 'none',
    consecutiveFrames: 0,
    lastSeen: 0,
    maxDelta: 0
  };

  /* ─── Announcement throttle ──────────────────────────────────── */
  let _prevSig = '';
  let _prevSigTime = 0;
  const REPEAT_CD = 5000;  // re-announce identical advice after 5 s
  const CHANGE_CD = 1500;  // announce changed advice after 1.5 s

  /* ─── Public API ─────────────────────────────────────────────── */
  window.freeSpaceAPI = {
    analyze,
    drawOverlay,
    shouldAnnounce,
    markSent,
    detectDownwardStairs: _detectDownwardStairs,
    detectUpwardStairs: _detectUpwardStairs,
    applySurfaces: _applySurfaces,
    reset: () => {
      _smoothedCells = [];
      _gridPool = null;
      _prevSig = '';
      _prevSigTime = 0;
      _lastFloorBaseline = null;
      _lastRange = 1;
      _hazardTracker = { type: null, confidence: 'none', consecutiveFrames: 0, lastSeen: 0, maxDelta: 0 };
      if (window.hazardDetectorAPI?.reset) window.hazardDetectorAPI.reset();
    },
  };

  /* ═══════════════════════════════════════════════════════════════
     MAIN ANALYSIS  (called each detection frame)
  ═══════════════════════════════════════════════════════════════ */
  /**
   * @param {HTMLVideoElement} videoEl  — live camera video
   * @param {Array}            tracks   — enriched ByteTrack output
   * @returns {{ grid, advice, hazard, surface, COLS, ROWS }} | null
   */
  function analyze(videoEl, tracks) {
    if (!videoEl || videoEl.videoWidth === 0) return null;

    const vw = videoEl.videoWidth;
    const vh = videoEl.videoHeight;

    const grid = _buildGrid(vw, vh);

    // ── Source 1: ByteTrack bounding boxes ────────────────────────
    if (tracks && tracks.length) _applyDetections(grid, tracks, vw, vh);

    // ── Source 2: Depth-Anything-V2 floor deviation ───────────────
    let hazard = null;
    const dm = window.depthAPI?.getDepthMap?.();
    if (dm && dm.data) hazard = _applyDepth(grid, dm, vw, vh);

    // ── Source 3: Surface Segmentation ────────────────────────────
    const sm = window.surfaceSegmentationAPI?.getSurfaceMap?.();
    if (sm) hazard = _applySurfaces(grid, sm, vw, vh, hazard);

    // ── Source 4: Specialized Hazard Detection Engine ─────────────
    if (window.hazardDetectorAPI && dm && dm.data) {
      const specialized = window.hazardDetectorAPI.detectHazards({
        grid, depthMap: dm, surfaceMap: sm, tracks, vw, vh,
        floorBaseline: _lastFloorBaseline, range: _lastRange
      });
      if (specialized) {
        if (!hazard) {
          hazard = specialized;
        } else if (hazard.type === 'dropoff') {
          hazard = {
            ...hazard,
            category: specialized.category,
            proximity: specialized.proximity,
            riskLevel: specialized.riskLevel || 'high',
            persistence: specialized.persistence,
            alertMessage: hazard.label || specialized.alertMessage
          };
        } else if (specialized.riskLevel === 'critical' || specialized.riskLevel === 'high') {
          hazard = specialized;
        } else if (!hazard.type.startsWith('stairs')) {
          hazard = specialized;
        }
      }
    }

    const smoothedGrid = _smoothGrid(grid);

    // Label each cell's traversability and uncertainty (Requirements 6 & 7)
    smoothedGrid.forEach(cell => {
      if (cell.status === 'obstacle') {
        cell.traversable = 'obstacle';
        cell.verifiedWalkable = false;
        cell.uncertainty = 0.1;
      } else if (cell.status === 'dropoff') {
        cell.traversable = 'hazard';
        cell.verifiedWalkable = false;
        cell.uncertainty = 0.1;
      } else if (cell.surfaceCategory === 'stairs' || cell.status === 'caution') {
        cell.traversable = 'caution';
        cell.verifiedWalkable = false;
        cell.uncertainty = 0.4;
      } else if (cell.surfaceCategory === 'road') {
        cell.traversable = 'road';
        cell.verifiedWalkable = false;
        cell.uncertainty = 0.3;
      } else if (cell.surfaceCategory === 'wall') {
        cell.traversable = 'obstacle';
        cell.verifiedWalkable = false;
        cell.uncertainty = 0.1;
      } else if (cell.depthGroundConfirmed || cell.surfaceGroundConfirmed) {
        cell.traversable = 'walkable';
        cell.verifiedWalkable = true;
        cell.uncertainty = 0.15;
      } else {
        // Clear image region is NOT proof that the ground is walkable!
        cell.traversable = 'unknown';
        cell.verifiedWalkable = false;
        cell.uncertainty = 0.85;
      }
    });

    const nearMidCells = smoothedGrid.filter(c => c.r >= 1);
    const hasAnyGroundEvidence = nearMidCells.some(c => c.verifiedWalkable || c.status === 'obstacle' || c.status === 'dropoff');
    const isModelLoaded = Boolean(window.depthAPI?.isLoaded?.() || window.surfaceSegmentationAPI?.isLoaded?.());
    const isCameraDegraded = window.sceneStateAPI?.getSnapshot?.()?.status === 'degraded';
    // Surface is unassessed when models are active or camera is degraded, but ground cannot be identified at all (e.g. covered lens, pitch darkness, looking at sky/ceiling)
    const surfaceUnassessed = Boolean((isCameraDegraded || (isModelLoaded && dm && dm.data)) && !hasAnyGroundEvidence);

    const advice = _computeAdvice(smoothedGrid, hazard);
    return { grid: smoothedGrid, advice, hazard, surface: sm, surfaceUnassessed, COLS, ROWS };
  }

  /* ═══════════════════════════════════════════════════════════════
     GRID CONSTRUCTION
  ═══════════════════════════════════════════════════════════════ */
  let _gridPool = null;
  function _buildGrid(vw, vh) {
    const total = ROWS * COLS;
    if (!_gridPool || _gridPool.length !== total) {
      _gridPool = new Array(total);
      for (let i = 0; i < total; i++) {
        const r = Math.floor(i / COLS);
        const c = i % COLS;
        _gridPool[i] = {
          r, c,
          x: 0, y: 0, w: 0, h: 0,
          status: 'clear', zone: null, src: null, label: null, trackId: null,
          surfaceCategory: 'unknown', surfaceConfidence: 0, surfaceShares: null,
          depthGroundConfirmed: false, surfaceGroundConfirmed: false
        };
      }
    }
    const cellW = vw / COLS;
    const cellH = vh / ROWS;
    for (let i = 0; i < total; i++) {
      const cell = _gridPool[i];
      cell.x = cell.c * cellW;
      cell.y = cell.r * cellH;
      cell.w = cellW;
      cell.h = cellH;
      cell.status = 'clear';
      cell.zone = null;
      cell.src = null;
      cell.label = null;
      cell.trackId = null;
      cell.surfaceCategory = 'unknown';
      cell.surfaceConfidence = 0;
      cell.surfaceShares = null;
      cell.depthGroundConfirmed = false;
      cell.surfaceGroundConfirmed = false;
    }
    return _gridPool;
  }

  /* ═══════════════════════════════════════════════════════════════
     SOURCE 1 — ByteTrack detection overlaps
  ═══════════════════════════════════════════════════════════════ */
  function _applyDetections(grid, tracks, vw, vh) {
    tracks.forEach(track => {
      const [bx, by, bw, bh] = track.bbox;
      const zone = track.distInfo?.zone || 'medium';
      const w = _zoneWeight(zone);

      grid.forEach(cell => {
        // Don't downgrade existing high-priority obstacle
        if (cell.status === 'obstacle' && _zoneWeight(cell.zone) >= w) return;

        const ix1 = Math.max(bx, cell.x);
        const iy1 = Math.max(by, cell.y);
        const ix2 = Math.min(bx + bw, cell.x + cell.w);
        const iy2 = Math.min(by + bh, cell.y + cell.h);
        const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);

        if (inter / (cell.w * cell.h) >= DET_OVERLAP) {
          cell.status = 'obstacle';
          cell.zone = zone;
          cell.src = 'det';
          cell.label = track.label;
          cell.trackId = track.id;
        }
      });
    });
  }

  /* ═══════════════════════════════════════════════════════════════
     SOURCE 2 — Depth-based floor deviation & ground hazards
     1. Positive obstacles (elevated floor protrusions)
     2. Drop-off detection (ground discontinuities / downward edges)
     3. Downward-stair detection (testing horizontal stair edges)
     4. Upward-stair detection (step-pattern gradient analysis)
  ═══════════════════════════════════════════════════════════════ */
  function _applyDepth(grid, dm, vw, vh) {
    const { data, width: dw, height: dh } = dm;
    const range = dm.sceneMax - dm.sceneMin;
    if (!data?.length || !dw || !dh || range < 1e-6) return null;

    // Depth Anything supplies relative inverse depth (larger = closer). Compare
    // each cell with peers and uncorrupted floor baselines.
    const cellDepth = grid.map(cell => _cellMedian(data, dw, dh, cell));
    const rowBaseline = Array.from({ length: ROWS }, (_, row) => {
      const values = grid.filter(cell => cell.r === row).map(cell => cellDepth[cell.r * COLS + cell.c]);
      return _median(values);
    });

    // Robust floor baseline calculation:
    // rowBaseline[r] is the lateral median across the 5 cells in row r.
    // If the floor collapses across multiple walking cells in row 2 or row 1:
    const floorBaseline = new Array(ROWS);

    // Row 2 (nearest walking ground)
    const r2Base = rowBaseline[2];
    const row2Values = grid.filter(c => c.r === 2).map(c => cellDepth[c.r * COLS + c.c]);
    const nearMax = Math.max(...row2Values);
    if (rowBaseline[1] && r2Base < rowBaseline[1]) {
      if (nearMax - r2Base >= 0.12 * range) {
        floorBaseline[2] = nearMax;
      } else if (r2Base < dm.sceneMin + 0.25 * range) {
        const expectedSlope = Math.max(0, rowBaseline[1] - (rowBaseline[0] ?? rowBaseline[1]));
        floorBaseline[2] = Math.min(dm.sceneMax ?? 1, Math.max(nearMax, rowBaseline[1] + expectedSlope));
      } else {
        floorBaseline[2] = r2Base;
      }
    } else if (r2Base < nearMax - 0.18 * range && nearMax >= dm.sceneMin + 0.40 * range) {
      floorBaseline[2] = nearMax;
    } else {
      floorBaseline[2] = r2Base;
    }

    // Row 1 (mid walking ground)
    const r1Base = rowBaseline[1];
    const row1Values = grid.filter(c => c.r === 1).map(c => cellDepth[c.r * COLS + c.c]);
    const midMax = Math.max(...row1Values);
    const normalSlope = Math.max(0.08 * range, (floorBaseline[2] - (rowBaseline[0] ?? (floorBaseline[2] - 0.25 * range))) * 0.5);
    const expectedRow1 = floorBaseline[2] - normalSlope;
    if (r1Base < expectedRow1 - 0.15 * range && floorBaseline[2] >= dm.sceneMin + 0.35 * range) {
      floorBaseline[1] = Math.max(midMax, expectedRow1);
    } else {
      floorBaseline[1] = r1Base;
    }

    // Row 0 (far background/horizon)
    floorBaseline[0] = rowBaseline[0];
    _lastFloorBaseline = floorBaseline;
    _lastRange = range;

    // ── 1. Positive obstacles (existing floor deviation) ──────────
    grid.forEach((cell, index) => {
      if (cell.status === 'obstacle') return;
      const normalizedDelta = (cellDepth[index] - rowBaseline[cell.r]) / range;
      if (normalizedDelta >= (CFG.depthObstacleDelta ?? 0.24)) {
        const closeness = (cellDepth[index] - dm.sceneMin) / range;
        cell.status = 'obstacle';
        cell.zone = closeness >= 0.78 ? 'danger' : closeness >= 0.58 ? 'close' : 'medium';
        cell.src = 'depth';
      } else if (normalizedDelta >= (CFG.depthCautionDelta ?? 0.12)) {
        cell.status = 'caution';
        cell.src = 'depth';
      }
    });

    // ── FEATURE 1: Drop-off detection (Ground Discontinuity) ────────
    const dropThreshold = CFG.dropoffDelta ?? 0.20;
    const confidentDropThreshold = CFG.dropoffConfidentDelta ?? 0.32;
    const dropCells = [];

    // Focus on near and mid walking rows (rows 1 and 2 in 3-row grid)
    grid.forEach((cell, index) => {
      if (cell.r < 1) return;

      // Do not classify detected objects as ground drop-offs.
      if (cell.status === 'obstacle' && cell.src === 'det') return;

      const baseline = floorBaseline[cell.r];

      // Ignore invalid depth or baseline values.
      if (!Number.isFinite(baseline) ||
        !Number.isFinite(cellDepth[index])) return;

      // In a drop-off, depth is significantly farther than baseline.
      const dropDelta = (baseline - cellDepth[index]) / range;

      if (dropDelta >= dropThreshold) {
        cell.status = 'dropoff';
        cell.zone = 'danger';
        cell.src = 'depth-drop';
        cell.dropDelta = dropDelta;
        if (!dropCells.includes(cell)) dropCells.push(cell);
      }
    });

    // ── Longitudinal Ground Discontinuity & Step Check ─────────────
    // Along each column, test whether the mid ground falls away below
    // the linear ground continuation between near ground (row 2) and far ground (row 0).
    for (let c = 0; c < COLS; c++) {
      const nearIdx = 2 * COLS + c;
      const midIdx = 1 * COLS + c;
      const farIdx = 0 * COLS + c;
      const nearVal = cellDepth[nearIdx];
      const midVal = cellDepth[midIdx];
      const farVal = cellDepth[farIdx];
      const isNearGround = (nearVal - dm.sceneMin) / range >= 0.40;
      if (isNearGround && Number.isFinite(farVal)) {
        // Linear ground plane expectation at mid row
        const expectedMid = (nearVal + farVal) / 2;
        // In a true drop-off, midVal plummets far below expectedMid
        const dropDeltaLong = (expectedMid - midVal) / range;
        if (dropDeltaLong >= dropThreshold) {
          const midCell = grid[midIdx];
          if (midCell.status !== 'obstacle' && midCell.status !== 'dropoff') {
            midCell.status = 'dropoff';
            midCell.zone = 'danger';
            midCell.src = 'depth-drop';
            midCell.dropDelta = Math.max(midCell.dropDelta || 0, dropDeltaLong);
            if (!dropCells.includes(midCell)) dropCells.push(midCell);
          }
        }
      }
    }

    // Evaluate ground confirmation for each cell against floor baseline
    grid.forEach((cell, index) => {
      if (cell.status === 'obstacle' || cell.status === 'dropoff') {
        cell.depthGroundConfirmed = false;
        return;
      }
      const deltaFromBaseline = Math.abs(cellDepth[index] - floorBaseline[cell.r]) / range;
      cell.depthGroundConfirmed = deltaFromBaseline < (CFG.depthGroundTolerance ?? 0.14);
    });

    let hazard = null;

    // ── Hazard Classification: Descending Stairs, Drop-off, Ascending Stairs ──
    const centerNear = _median([cellDepth[11], cellDepth[12], cellDepth[13]]);
    const centerMid = _median([cellDepth[6], cellDepth[7], cellDepth[8]]);
    const centerFar = _median([cellDepth[1], cellDepth[2], cellDepth[3]]);
    const expectedCenterMid = (centerNear + centerFar) / 2;
    const midElevation = (centerMid - expectedCenterMid) / range;

    const stairDown = _detectDownwardStairs(dm, dropCells, grid, dw, dh, range);
    const upward = _detectUpwardStairs(dm, grid, rowBaseline, dh, rowBaseline, range);

    if (dropCells.length === 0 && midElevation >= 0.08 && upward.isStairs) {
      // Confirmed Ascending Stairs: mid ground is elevated above linear ground continuation
      const isAmbiguous = Boolean(upward.isAmbiguous);
      const hazardType = isAmbiguous ? 'stairs-ambiguous' : 'stairs-up';
      const isConfident = !isAmbiguous && (upward.confidence === 'confident' || midElevation >= 0.14);
      hazard = {
        type: hazardType,
        confidence: isConfident ? 'confident' : 'uncertain',
        label: isConfident ? 'Stairs ahead (up)' : 'Possible steps ahead',
        edgeCount: upward.edgeCount,
        location: upward.location || { side: 'center', row: 'mid' },
        cells: upward.affectedCells
      };
      upward.affectedCells.forEach(cell => {
        if (cell.status === 'clear') {
          cell.status = 'caution';
          cell.zone = 'medium';
          cell.src = 'depth-stairs';
        }
      });
    } else if (dropCells.length > 0 || midElevation <= -0.06 || (stairDown.isStairs && !upward.isStairs)) {
      if (stairDown.isStairs) {
        const isConfident = stairDown.confidence === 'confident' || (dropCells.length >= 2 && stairDown.edgeCount >= 2);
        hazard = {
          type: 'stairs-down',
          confidence: isConfident ? 'confident' : 'uncertain',
          label: isConfident ? 'Descending stairs ahead' : 'Possible descending stairs ahead',
          edgeCount: stairDown.edgeCount,
          location: stairDown.location || { side: 'center', row: 'mid' },
          cells: dropCells.length ? dropCells : grid.filter(c => (c.r === 1 || c.r === 2) && c.c >= 1 && c.c <= 3)
        };
        hazard.cells.forEach(cell => {
          cell.status = 'dropoff';
          cell.zone = 'danger';
          cell.src = 'depth-stairs';
        });
      } else if (dropCells.length > 0) {
        // Single ground discontinuity / curb / drop-off
        const maxDelta = Math.max(...dropCells.map(c => c.dropDelta || 0));
        const centerDrop = dropCells.some(c => c.c >= 1 && c.c <= 3);
        const multiCell = dropCells.length >= 2;
        let isConfident = maxDelta >= confidentDropThreshold && (multiCell || centerDrop);

        // Temporal consistency: if uncertain drop-off persists across frames with consistent delta,
        // elevate to confident
        if (_hazardTracker.type === 'dropoff' && maxDelta >= dropThreshold + 0.05) {
          if (_hazardTracker.consecutiveFrames >= (CFG.dropoffConfirmFrames ?? 3)) {
            isConfident = true;
          }
        }

        hazard = {
          type: 'dropoff',
          confidence: isConfident ? 'confident' : 'uncertain',
          label: isConfident ? 'Drop-off ahead' : 'Possible drop-off ahead',
          maxDelta,
          location: {
            side: centerDrop ? 'center' : (dropCells[0]?.c < 2 ? 'left' : 'right'),
            row: dropCells.some(c => c.r === 2) ? 'near' : 'mid'
          },
          cells: dropCells
        };
      }
    } else if (upward.isStairs) {
      // Ambiguous stair structure (detected steps without confirmed elevation/depression)
      hazard = {
        type: 'stairs-ambiguous',
        confidence: 'uncertain',
        label: 'Possible steps ahead',
        edgeCount: upward.edgeCount,
        location: upward.location || { side: 'center', row: 'mid' },
        cells: upward.affectedCells
      };
      upward.affectedCells.forEach(cell => {
        if (cell.status === 'clear') {
          cell.status = 'caution';
          cell.zone = 'medium';
          cell.src = 'depth-stairs';
        }
      });
    }

    // Update temporal hazard tracker
    if (hazard && hazard.type) {
      if (_hazardTracker.type === hazard.type) {
        _hazardTracker.consecutiveFrames++;
      } else {
        _hazardTracker.type = hazard.type;
        _hazardTracker.consecutiveFrames = 1;
      }
      _hazardTracker.lastSeen = Date.now();
      _hazardTracker.confidence = hazard.confidence;
      _hazardTracker.maxDelta = hazard.maxDelta || 0;
    } else {
      _hazardTracker.type = null;
      _hazardTracker.confidence = 'none';
      _hazardTracker.consecutiveFrames = 0;
    }

    return hazard;
  }

  /* ═══════════════════════════════════════════════════════════════
     SOURCE 3 — Surface Segmentation Fusion
     1. Integrates semantic surface predictions with navigation grid
     2. Identifies structural walls and barriers
     3. Fuses semantic stairs confirmation with depth step analysis
     4. Marks roadway cautions
     5. Strict safety guarantee: sidewalk alone NEVER overrides
        an existing obstacle or depth drop-off!
  ═══════════════════════════════════════════════════════════════ */
  function _applySurfaces(grid, sm, vw, vh, existingHazard) {
    if (!sm || !sm.cells || !Array.isArray(sm.cells)) return existingHazard;
    let hazard = existingHazard;

    const wallThreshold = CFG.wallObstacleThreshold ?? 0.45;
    const stairsThreshold = CFG.stairsConfirmThreshold ?? 0.25;
    const roadThreshold = CFG.roadCautionThreshold ?? 0.40;

    let hasCenterStairSurface = false;

    grid.forEach(cell => {
      const match = sm.cells.find(sc => sc.r === cell.r && sc.c === cell.c);
      if (!match) return;

      cell.surfaceCategory = match.primaryCategory || 'unknown';
      cell.surfaceConfidence = match.confidence || 0;
      cell.surfaceShares = match.shares || null;

      const shares = match.shares || {};

      // ── 1. Wall / Barrier Obstacles ──────────────────────────────
      if (shares.wall >= wallThreshold || match.primaryCategory === 'wall') {
        if (cell.status !== 'obstacle') {
          cell.status = 'obstacle';
          cell.zone = cell.r === 2 ? 'danger' : cell.r === 1 ? 'close' : 'medium';
          cell.src = 'surface-wall';
          cell.label = 'Wall/Barrier';
        }
      }

      // ── 2. Stairs Semantic Confirmation ──────────────────────────
      if (shares.stairs >= stairsThreshold || match.primaryCategory === 'stairs') {
        if (cell.c >= 1 && cell.c <= 3) {
          hasCenterStairSurface = true;
          if (cell.status === 'clear') {
            cell.status = 'caution';
            cell.zone = 'medium';
            cell.src = 'surface-stairs';
          }
        }
      }

      // ── 3. Road Surface Caution ──────────────────────────────────
      if (shares.road >= roadThreshold || match.primaryCategory === 'road') {
        if (cell.c >= 1 && cell.c <= 3 && cell.r >= 1) {
          if (cell.status === 'clear') {
            cell.status = 'caution';
            cell.zone = cell.r === 2 ? 'close' : 'medium';
            cell.src = 'surface-road';
          }
        }
      }

      // ── 4. Footpath / Sidewalk (CRITICAL SAFETY RULE) ─────────────
      // Sidewalk or footpath alone NEVER overrides an obstacle or drop-off!
      // If cell.status is 'obstacle' or 'dropoff', we keep it strictly intact.
      if (shares.footpath >= 0.35 || match.primaryCategory === 'footpath' ||
        shares.floor >= 0.35 || match.primaryCategory === 'floor') {
        cell.surfaceGroundConfirmed = true;
      } else {
        cell.surfaceGroundConfirmed = false;
      }
    });

    // ── Fuse Semantic Stairs Evidence with Depth Hazards ──────────
    if (hasCenterStairSurface) {
      if (hazard && hazard.type) {
        if (hazard.type.startsWith('stairs')) {
          hazard = {
            ...hazard,
            confidence: 'confident',
            label: hazard.type === 'stairs-down'
              ? 'Descending stairs ahead'
              : (hazard.type === 'stairs-up' ? 'Stairs ahead (up)' : 'Stairs ahead'),
            surfaceConfirmed: true
          };
        }
      } else {
        hazard = {
          type: 'stairs-up',
          confidence: 'uncertain',
          label: 'Possible steps ahead',
          edgeCount: 1,
          location: { side: 'center', row: 'mid' },
          cells: grid.filter(c => (c.r === 1 || c.r === 2) && c.c >= 1 && c.c <= 3 && c.surfaceCategory === 'stairs'),
          surfaceConfirmed: true
        };
      }
    }

    return hazard;
  }

  /**
   * FEATURE 2: Downward-stair detection
   * Tests whether multiple descending horizontal stair edges can be identified reliably
   * in the depth map within the walking corridor.
   */
  function _detectDownwardStairs(dataOrDm, dropOrDw, dhOrGrid, maybeDw, maybeDh, maybeRange) {
    let data, dw, dh, range;
    if (dataOrDm && dataOrDm.data) {
      data = dataOrDm.data;
      dw = dataOrDm.width;
      dh = dataOrDm.height;
      range = Math.max(1e-6, (dataOrDm.sceneMax ?? 1) - (dataOrDm.sceneMin ?? 0));
    } else {
      data = dataOrDm;
      dw = maybeDw || dropOrDw;
      dh = maybeDh || dhOrGrid;
      range = maybeRange || 1;
    }

    if (!data?.length || !dw || !dh) return { isStairs: false, edgeCount: 0, confidence: 'none' };

    // Reject downward stairs if walking path mid-ground is elevated with no drop-off (confirms ascending stairs)
    const grid = Array.isArray(dhOrGrid) ? dhOrGrid : (Array.isArray(dropOrDw) ? dropOrDw : []);
    const dropCells = Array.isArray(dropOrDw) ? dropOrDw : [];
    const centerMidCells = grid.filter(c => c.r === 1 && c.c >= 1 && c.c <= 3);
    const hasElevatedMid = centerMidCells.some(cell => cell.status === 'obstacle' || cell.status === 'caution');
    if (hasElevatedMid && dropCells.length === 0) {
      return { isStairs: false, edgeCount: 0, confidence: 'none' };
    }

    const minEdges = CFG.stairEdgeMinCount ?? 2;
    const threshold = (CFG.stairEdgeThreshold ?? 0.08) * range;

    // Scan vertical columns across left-center, center, and right-center walking paths
    const xPositions = [
      Math.floor(dw * 0.35),
      Math.floor(dw * 0.50),
      Math.floor(dw * 0.65)
    ];

    const yStart = Math.floor(dh * 0.35);
    const yEnd = Math.floor(dh * 0.95);
    const stepY = Math.max(1, Math.floor(dh / 60));
    const tiltWindow = Math.max(2, Math.floor(dh / 30));

    const detectedEdges = [];
    let lastEdgeY = -100;
    const minEdgeSeparation = Math.max(5, Math.floor(dh / 10));

    for (let y = yStart; y < yEnd - stepY; y += stepY) {
      if (y - lastEdgeY < minEdgeSeparation) continue;

      const xc = xPositions[1];
      const c1 = data[y * dw + xc];
      const c2 = data[(y + stepY) * dw + xc];
      const c3 = data[Math.min(dh - 1, y + stepY * 2) * dw + xc];
      const centerEdge = (Number.isFinite(c1) && Number.isFinite(c2) && Math.abs(c1 - c2) >= threshold) ||
        (Number.isFinite(c1) && Number.isFinite(c3) && Math.abs(c1 - c3) >= threshold);

      if (!centerEdge) {
        const l1 = data[y * dw + xPositions[0]], l2 = data[(y + stepY) * dw + xPositions[0]];
        const r1 = data[y * dw + xPositions[2]], r2 = data[(y + stepY) * dw + xPositions[2]];
        const sideDirect = Number.isFinite(l1) && Number.isFinite(l2) && Math.abs(l1 - l2) >= threshold &&
          Number.isFinite(r1) && Number.isFinite(r2) && Math.abs(r1 - r2) >= threshold;
        if (!sideDirect) continue;
      }

      let matchingColumns = 1;
      for (const colX of [xPositions[0], xPositions[2]]) {
        let sideHasEdge = false;
        for (let ty = Math.max(yStart, y - tiltWindow); ty <= Math.min(yEnd - stepY, y + tiltWindow); ty += stepY) {
          const tv1 = data[ty * dw + colX];
          const tv2 = data[(ty + stepY) * dw + colX];
          if (Number.isFinite(tv1) && Number.isFinite(tv2) && Math.abs(tv1 - tv2) >= threshold * 0.85) {
            sideHasEdge = true;
            break;
          }
        }
        if (sideHasEdge) matchingColumns++;
      }

      if (matchingColumns >= 2) {
        detectedEdges.push({ y, strength: matchingColumns });
        lastEdgeY = y + tiltWindow;
      }
    }

    const isStairs = detectedEdges.length >= minEdges;
    const isConfident = detectedEdges.length >= 3;
    const firstY = detectedEdges[0]?.y ?? 0;
    const lastY = detectedEdges[detectedEdges.length - 1]?.y ?? 0;

    return {
      isStairs,
      confidence: isConfident ? 'confident' : (isStairs ? 'uncertain' : 'none'),
      edgeCount: detectedEdges.length,
      edges: detectedEdges,
      location: isStairs ? {
        side: 'center',
        row: lastY > dh * 0.67 ? 'near' : 'mid',
        yStartNorm: firstY / dh,
        yEndNorm: lastY / dh
      } : null
    };
  }

  /**
   * FEATURE 3: Upward-stair detection
   * Validates step-pattern analysis (periodic horizontal riser jumps and tread plateaus
   * with elevation rising steeper than flat ground).
   */
  function _detectUpwardStairs(dataOrDm, gridOrDw, dhOrBase, maybeDh, maybeBase, maybeRange) {
    let data, dw, dh, grid, rowBaseline, range;
    if (dataOrDm && dataOrDm.data) {
      data = dataOrDm.data;
      dw = dataOrDm.width;
      dh = dataOrDm.height;
      grid = Array.isArray(gridOrDw) ? gridOrDw : [];
      rowBaseline = Array.isArray(dhOrBase) ? dhOrBase : (Array.isArray(maybeBase) ? maybeBase : []);
      range = Math.max(1e-6, (dataOrDm.sceneMax ?? 1) - (dataOrDm.sceneMin ?? 0));
    } else {
      data = dataOrDm;
      dw = gridOrDw;
      dh = maybeDh || dhOrBase;
      grid = Array.isArray(maybeBase) ? maybeBase : [];
      range = maybeRange || 1;
      rowBaseline = [];
    }

    if (!data?.length || !dw || !dh) return { isStairs: false, edgeCount: 0, confidence: 'none', affectedCells: [] };

    const minRisers = CFG.stepPatternMinRisers ?? 2;
    const threshold = (CFG.stairEdgeThreshold ?? 0.08) * range;

    const xPositions = [
      Math.floor(dw * 0.35),
      Math.floor(dw * 0.50),
      Math.floor(dw * 0.65)
    ];

    const yStart = Math.floor(dh * 0.20);
    const yEnd = Math.floor(dh * 0.85);
    const stepY = Math.max(1, Math.floor(dh / 60));
    const tiltWindow = Math.max(2, Math.floor(dh / 30));

    const detectedRisers = [];
    let lastRiserY = -100;
    const minRiserSeparation = Math.max(5, Math.floor(dh / 10));

    for (let y = yStart; y < yEnd - stepY; y += stepY) {
      if (y - lastRiserY < minRiserSeparation) continue;

      const xc = xPositions[1];
      const c1 = data[y * dw + xc];
      const c2 = data[(y + stepY) * dw + xc];
      const c3 = data[Math.min(dh - 1, y + stepY * 2) * dw + xc];
      const centerEdge = (Number.isFinite(c1) && Number.isFinite(c2) && Math.abs(c1 - c2) >= threshold) ||
        (Number.isFinite(c1) && Number.isFinite(c3) && Math.abs(c1 - c3) >= threshold);

      if (!centerEdge) {
        const l1 = data[y * dw + xPositions[0]], l2 = data[(y + stepY) * dw + xPositions[0]];
        const r1 = data[y * dw + xPositions[2]], r2 = data[(y + stepY) * dw + xPositions[2]];
        const sideDirect = Number.isFinite(l1) && Number.isFinite(l2) && Math.abs(l1 - l2) >= threshold &&
          Number.isFinite(r1) && Number.isFinite(r2) && Math.abs(r1 - r2) >= threshold;
        if (!sideDirect) continue;
      }

      let matchingColumns = 1;
      for (const colX of [xPositions[0], xPositions[2]]) {
        let sideHasEdge = false;
        for (let ty = Math.max(yStart, y - tiltWindow); ty <= Math.min(yEnd - stepY, y + tiltWindow); ty += stepY) {
          const tv1 = data[ty * dw + colX];
          const tv2 = data[(ty + stepY) * dw + colX];
          if (Number.isFinite(tv1) && Number.isFinite(tv2) && Math.abs(tv1 - tv2) >= threshold * 0.85) {
            sideHasEdge = true;
            break;
          }
        }
        if (sideHasEdge) matchingColumns++;
      }

      if (matchingColumns >= 2) {
        detectedRisers.push({ y, strength: matchingColumns });
        lastRiserY = y + tiltWindow;
      }
    }

    const centerMidCells = Array.isArray(grid)
      ? grid.filter(c => c.r === 1 && c.c >= 1 && c.c <= 3)
      : [];
    const elevated = centerMidCells.some(cell => cell.status === 'obstacle' || cell.status === 'caution');

    const isStairs = detectedRisers.length >= minRisers;
    const isConfident = (detectedRisers.length >= 3) || (detectedRisers.length >= 2 && elevated);
    const isAmbiguous = isStairs && !isConfident;
    const affectedCells = Array.isArray(grid)
      ? grid.filter(c => (c.r === 1 || c.r === 2) && c.c >= 1 && c.c <= 3)
      : [];
    const firstY = detectedRisers[0]?.y ?? 0;
    const lastY = detectedRisers[detectedRisers.length - 1]?.y ?? 0;

    return {
      isStairs,
      confidence: isConfident ? 'confident' : (isStairs ? 'uncertain' : 'none'),
      isAmbiguous,
      edgeCount: detectedRisers.length,
      affectedCells,
      location: isStairs ? {
        side: 'center',
        row: 'mid',
        yStartNorm: firstY / dh,
        yEndNorm: lastY / dh
      } : null
    };
  }

  function _cellMedian(data, dw, dh, cell) {
    const x1 = Math.floor(cell.c / COLS * dw), x2 = Math.max(x1 + 1, Math.floor((cell.c + 1) / COLS * dw));
    const y1 = Math.floor(cell.r / ROWS * dh), y2 = Math.max(y1 + 1, Math.floor((cell.r + 1) / ROWS * dh));
    const stepX = Math.max(1, Math.floor((x2 - x1) / 12));
    const stepY = Math.max(1, Math.floor((y2 - y1) / 8));
    const values = [];
    for (let y = y1; y < y2; y += stepY) for (let x = x1; x < x2; x += stepX) {
      const value = data[y * dw + x]; if (Number.isFinite(value)) values.push(value);
    }
    return _median(values);
  }

  function _median(values) {
    if (!values.length) return 0;
    values.sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  }

  function _smoothGrid(grid) {
    const alpha = CFG.smoothing ?? 0.55;
    return grid.map((cell, index) => {
      const isDrop = cell.status === 'dropoff';
      const current = (cell.status === 'obstacle' || isDrop) ? 1 : cell.status === 'caution' ? 0.5 : 0;
      const previous = _smoothedCells[index];
      // Raise new hazards immediately; smooth only the decay to reduce flicker.
      const severity = !previous || current > previous.severity
        ? current
        : previous.severity * (1 - alpha) + current * alpha;
      const status = isDrop ? 'dropoff'
        : severity >= (CFG.obstacleThreshold ?? 0.62) ? 'obstacle'
          : severity >= (CFG.cautionThreshold ?? 0.26) ? 'caution' : 'clear';
      const next = {
        severity,
        status,
        zone: cell.zone || (status !== 'clear' ? previous?.zone : null),
        src: cell.src || (status !== 'clear' ? previous?.src : null)
      };
      _smoothedCells[index] = next;
      return { ...cell, status, zone: next.zone, src: next.src, occupancy: severity };
    });
  }

  /* ═══════════════════════════════════════════════════════════════
     NAVIGATION ADVICE
  ═══════════════════════════════════════════════════════════════ */
  function _computeAdvice(grid, hazard) {
    const isObs = c => c.status === 'obstacle' || c.status === 'dropoff';

    // Bottom row — visually nearest image region (not a metric distance)
    const near = grid.filter(c => c.r === ROWS - 1);
    // Middle row — intermediate image region
    const mid = grid.filter(c => c.r === ROWS - 2);

    const nL = near.filter(c => c.c < 2);
    const nC = near.filter(c => c.c === 2);
    const nR = near.filter(c => c.c > 2);
    const mC = mid.filter(c => c.c >= 1 && c.c <= 3);

    const lClear = nL.every(c => !isObs(c));
    const cClear = nC.every(c => !isObs(c)) && mC.every(c => !isObs(c));
    const rClear = nR.every(c => !isObs(c));
    const mcClear = mC.every(c => !isObs(c));

    // ── FEATURE 4: Hazard Advice Integration ──────────────────────
    if (hazard && hazard.type) {
      let speech = '', summary = '', direction = 'slow';

      if (hazard.type === 'dropoff') {
        if (hazard.confidence === 'uncertain') {
          speech = 'Possible drop-off ahead. Stop.';
          summary = 'Possible drop-off';
          direction = 'stop';
        } else {
          speech = 'Drop-off detected ahead. Stop and check your step.';
          summary = 'Drop-off ahead';
          direction = 'stop';
        }
        if (!cClear) {
          if (lClear && !rClear) speech = `${speech.replace(/\s*Stop\.?/i, '')} The area to your left appears clearer, but the route is not fully verified.`;
          else if (!lClear && rClear) speech = `${speech.replace(/\s*Stop\.?/i, '')} The area to your right appears clearer, but the route is not fully verified.`;
        }
        return { speech, summary, direction, lClear, cClear, rClear, hazard };
      }

      if (hazard.type === 'stairs-down') {
        if (hazard.confidence === 'uncertain') {
          // PROMPT REQUIREMENT: "Possible descending stairs ahead. Stop and check."
          speech = 'Possible descending stairs ahead. Stop and check.';
          summary = 'Possible descending stairs';
          direction = 'stop';
        } else {
          speech = 'Descending stairs ahead. Stop and check your step.';
          summary = 'Descending stairs';
          direction = 'stop';
        }
        return { speech, summary, direction, lClear, cClear, rClear, hazard };
      }

      if (hazard.type === 'stairs-up') {
        if (hazard.confidence === 'uncertain') {
          // PROMPT REQUIREMENT: "Possible steps ahead. Approach cautiously."
          speech = 'Possible steps ahead. Approach cautiously.';
          summary = 'Possible steps';
          direction = 'slow';
        } else {
          speech = 'Stairs ahead leading up. Approach carefully.';
          summary = 'Stairs up';
          direction = 'slow';
        }
        return { speech, summary, direction, lClear, cClear, rClear, hazard };
      }

      if (hazard.type === 'stairs-ambiguous') {
        speech = 'Possible steps ahead. Approach cautiously.';
        summary = 'Possible steps';
        direction = 'slow';
        return { speech, summary, direction, lClear, cClear, rClear, hazard };
      }

      if (hazard.type === 'uncovered-drain') {
        speech = hazard.confidence === 'uncertain'
          ? 'Possible uncovered drain ahead. Proceed with caution.'
          : 'Uncovered drain detected ahead. Please stop.';
        summary = hazard.confidence === 'uncertain' ? 'Possible drain' : 'Uncovered drain';
        direction = 'stop';
        return { speech, summary, direction, lClear, cClear, rClear, hazard };
      }

      if (hazard.type === 'pothole') {
        speech = hazard.confidence === 'uncertain'
          ? 'Possible pothole ahead.'
          : 'Pothole detected ahead. Step carefully.';
        summary = hazard.confidence === 'uncertain' ? 'Possible pothole' : 'Pothole ahead';
        direction = 'slow';
        if (!cClear && hazard.confidence === 'confident') {
          if (lClear && !rClear) speech += ' The left side appears clearer.';
          else if (!lClear && rClear) speech += ' The right side appears clearer.';
        }
        return { speech, summary, direction, lClear, cClear, rClear, hazard };
      }

      if (hazard.type === 'curb') {
        speech = hazard.confidence === 'uncertain'
          ? 'Possible curb edge ahead.'
          : 'Curb edge ahead. Step carefully.';
        summary = 'Curb edge';
        direction = 'slow';
        return { speech, summary, direction, lClear, cClear, rClear, hazard };
      }

      if (hazard.type === 'raised-surface') {
        speech = hazard.confidence === 'uncertain'
          ? 'Possible raised surface ahead.'
          : 'Raised surface ahead. Watch your step.';
        summary = 'Raised surface';
        direction = 'slow';
        return { speech, summary, direction, lClear, cClear, rClear, hazard };
      }

      if (hazard.type === 'broken-pavement') {
        speech = hazard.confidence === 'uncertain'
          ? 'Possible uneven pavement ahead.'
          : 'Uneven, broken pavement ahead. Watch your footing.';
        summary = 'Uneven pavement';
        direction = 'slow';
        return { speech, summary, direction, lClear, cClear, rClear, hazard };
      }
    }

    // Closest detected obstacle in center path
    const cObs = nC.find(isObs) || mC.find(isObs);
    const cZone = cObs?.zone || 'medium';

    let speech = '', summary = '', direction = 'forward';

    if (lClear && cClear && rClear && mcClear) {
      // Safety rule: Unknown observations must not be interpreted as proof of safety!
      const nearCells = grid.filter(c => c.r === ROWS - 1 && c.c >= 1 && c.c <= 3);
      const isUnverified = nearCells.every(c => c.surfaceCategory === 'unknown' && (!c.surfaceConfidence || c.surfaceConfidence < 0.25));
      if (isUnverified && (!window.depthAPI || !window.depthAPI.isLoaded?.())) {
        speech = 'Surface visibility is limited. Proceed with caution.';
        summary = 'Caution — limited visibility';
        direction = 'slow';
      } else {
        speech = 'No tracked obstacle is ahead. Continue carefully.';
        summary = 'No alert ahead';
        direction = 'forward';
      }

    } else if (cClear && mcClear) {
      summary = 'No center alert';
      direction = 'forward';
      speech = 'No tracked obstacle is in the center.';
      if (!lClear) speech += ' Obstacles to your left.';
      if (!rClear) speech += ' Obstacles to your right.';

    } else if (!cClear && lClear && !rClear) {
      summary = 'Turn left';
      direction = 'left';
      speech = `Obstacle directly ahead${cZone === 'danger' ? ', in the nearest range' : ''}. The left side appears clearer.`;

    } else if (!cClear && !lClear && rClear) {
      summary = 'Turn right';
      direction = 'right';
      speech = `Obstacle directly ahead${cZone === 'danger' ? ', in the nearest range' : ''}. The right side appears clearer.`;

    } else if (!cClear && lClear && rClear) {
      summary = 'Obstacle ahead';
      direction = 'split';
      speech = 'Obstacle directly ahead. Both sides currently have fewer alerts.';

    } else if (!cClear && !lClear && !rClear) {
      summary = 'Blocked';
      direction = 'stop';
      speech = 'Path blocked on all sides. Please stop.';

    } else {
      summary = 'Caution';
      direction = 'slow';
      speech = 'Caution ahead. Proceed slowly.';
    }

    return { speech, summary, direction, lClear, cClear, rClear };
  }

  /* ═══════════════════════════════════════════════════════════════
     CANVAS OVERLAY  (drawn BEFORE bounding boxes)
  ═══════════════════════════════════════════════════════════════ */
  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {{ grid, advice, COLS, ROWS }} result
   * @param {number} dw  — display canvas width (may differ from video width)
   * @param {number} dh  — display canvas height
   */
  function drawOverlay(ctx, result, dw, dh, safeDir) {
    if (!ctx || !result) return;
    const { grid, advice } = result;
    // safeDir from riskEngine overrides simple grid advice when available
    const dir = safeDir || advice;

    const cellW = dw / COLS;
    const cellH = dh / ROWS;

    // ── 1. Cell tints ─────────────────────────────────────────────
    grid.forEach(cell => {
      ctx.fillStyle = _cellColor(cell);
      ctx.fillRect(cell.c * cellW, cell.r * cellH, cellW, cellH);
    });

    // ── 2. Subtle grid lines (only near + mid rows) ────────────────
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 0.5;
    for (let r = 1; r < ROWS; r++) {
      ctx.beginPath();
      ctx.moveTo(0, r * cellH); ctx.lineTo(dw, r * cellH);
      ctx.stroke();
    }
    for (let c = 1; c < COLS; c++) {
      ctx.beginPath();
      ctx.moveTo(c * cellW, cellH); ctx.lineTo(c * cellW, dh);
      ctx.stroke();
    }

    // ── 3. Navigation ribbon (bottom strip) ───────────────────────
    _drawRibbon(ctx, dir, dw, dh);

    // ── 4. Direction arrow ────────────────────────────────────────
    _drawArrow(ctx, dir, dw, dh);
  }

  function _cellColor(cell) {
    if (cell.src === 'hazard-drain') return 'rgba(239,68,68,0.55)'; // Deep red for uncovered drain
    if (cell.src === 'hazard-pothole') return 'rgba(249,115,22,0.40)'; // Orange for pothole
    if (cell.src === 'hazard-curb') return 'rgba(234,179,8,0.35)'; // Yellow for curb step
    if (cell.src === 'hazard-raised') return 'rgba(245,158,11,0.35)'; // Amber for raised surface
    if (cell.src === 'hazard-broken') return 'rgba(217,119,6,0.30)'; // Brown-amber for broken pavement

    if (cell.status === 'dropoff') {
      return 'rgba(168,85,247,0.45)'; // Distinct purple/violet for drop-off discontinuity
    }
    if (cell.status === 'obstacle') {
      if (cell.src === 'surface-wall') return 'rgba(239,68,68,0.46)'; // Red for wall/barrier
      switch (cell.zone) {
        case 'danger': return 'rgba(248,113,113,0.42)';
        case 'close': return 'rgba(251,146,60,0.36)';
        default: return 'rgba(250,204,21,0.28)';
      }
    }
    if (cell.status === 'caution') {
      if (cell.src === 'surface-road') return 'rgba(245,158,11,0.32)'; // Amber for road caution
      return cell.src === 'depth-stairs' || cell.src === 'surface-stairs' ? 'rgba(251,146,60,0.25)' : 'rgba(250,204,21,0.16)';
    }
    // Clear — subtle green only on near+mid rows for verified footpath/floor
    if (cell.surfaceCategory === 'footpath' || cell.surfaceCategory === 'floor') {
      return cell.r >= 1 ? 'rgba(74,222,128,0.18)' : 'rgba(74,222,128,0.08)';
    }
    return cell.r >= 1 ? 'rgba(74,222,128,0.14)' : 'rgba(74,222,128,0.06)';
  }

  function _drawRibbon(ctx, advice, w, h) {
    const rH = 30;
    const y = h - rH;
    const t3 = w / 3;

    const centerLabel = !advice.cClear
      ? (advice.hazard?.type === 'uncovered-drain' ? '⚠️ Drain'
        : advice.hazard?.type === 'pothole' ? '🕳️ Pothole'
          : advice.hazard?.type === 'curb' ? '📐 Curb'
            : advice.hazard?.type === 'raised-surface' ? '⚡ Raised'
              : advice.hazard?.type === 'broken-pavement' ? '〰️ Uneven'
                : advice.hazard?.type === 'dropoff' ? '⚠️ Drop-off'
                  : advice.hazard?.type?.startsWith('stairs') ? '🪜 Stairs'
                    : '⛔ Obstacle')
      : '▲ No alert';

    const panels = [
      { x: 0, label: advice.lClear ? '← No alert' : '← Block', clear: advice.lClear },
      { x: t3, label: centerLabel, clear: advice.cClear },
      { x: t3 * 2, label: advice.rClear ? 'No alert →' : 'Block →', clear: advice.rClear },
    ];

    panels.forEach(p => {
      ctx.fillStyle = p.clear
        ? 'rgba(52,211,153,0.82)'
        : 'rgba(248,113,113,0.82)';
      ctx.fillRect(p.x, y, t3, rH);

      ctx.fillStyle = 'rgba(0,0,0,0.85)';
      ctx.font = 'bold 11px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.label, p.x + t3 / 2, y + rH / 2);
    });

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  function _drawArrow(ctx, advice, w, h) {
    // Position: 40% from bottom, centered horizontally
    const cx = w / 2;
    const cy = h * 0.56;
    const sz = Math.min(w, h) * 0.055;

    const DIR = {
      forward: { color: '#4ade80', angle: 0 },
      left: { color: '#60a5fa', angle: -Math.PI / 5 },
      right: { color: '#60a5fa', angle: Math.PI / 5 },
      split: { color: '#facc15', angle: 0 },
      slow: { color: '#facc15', angle: 0 },
      stop: { color: '#f87171', angle: null },
    };
    const d = DIR[advice.direction] || DIR.slow;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.shadowBlur = 18;
    ctx.shadowColor = d.color;

    if (d.angle === null) {
      // ✗ stop symbol
      ctx.strokeStyle = d.color;
      ctx.lineWidth = 4;
      ctx.globalAlpha = 0.88;
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(-sz, -sz); ctx.lineTo(sz, sz); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(sz, -sz); ctx.lineTo(-sz, sz); ctx.stroke();
    } else {
      ctx.rotate(d.angle);
      // Arrow chevron
      ctx.globalAlpha = 0.88;
      ctx.fillStyle = d.color;
      ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, -sz * 1.9);
      ctx.lineTo(sz, sz * 0.3);
      ctx.lineTo(sz * 0.38, sz * 0.3);
      ctx.lineTo(sz * 0.38, sz * 1.3);
      ctx.lineTo(-sz * 0.38, sz * 1.3);
      ctx.lineTo(-sz * 0.38, sz * 0.3);
      ctx.lineTo(-sz, sz * 0.3);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    ctx.restore();
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
  }

  /* ═══════════════════════════════════════════════════════════════
     ANNOUNCEMENT THROTTLE
  ═══════════════════════════════════════════════════════════════ */
  function shouldAnnounce(advice) {
    const now = Date.now();
    const elapsed = now - _prevSigTime;
    if (advice.summary !== _prevSig && elapsed > CHANGE_CD) return true;
    if (advice.summary === _prevSig && elapsed > REPEAT_CD) return true;
    return false;
  }

  function markSent(advice) {
    _prevSig = advice.summary;
    _prevSigTime = Date.now();
  }

  /* ─── Helpers ────────────────────────────────────────────────── */
  function _zoneWeight(z) {
    return { danger: 4, close: 3, medium: 2, far: 1 }[z] || 0;
  }

})();
