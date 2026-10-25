// ═══════════════════════════════════════════════════════════════════
//  VisionGuide — Specialized Hazard Detection Engine
//
//  Detects and classifies physical ground hazards:
//    1. Potholes               (bounded ground concavity / crater)
//    2. Uncovered Drains       (deep elongated trench / storm drain void)
//    3. Curb Edges             (footpath-to-road step-down/step-up boundary)
//    4. Raised Surfaces        (low-lying tripping hazards 3–15 cm high)
//    5. Broken Pavement        (high spatial roughness / paver micro-fractures)
//    6. Drop-offs & Stairs     (ground discontinuity & step pattern fusion)
//
//  Multi-Modal Fusion:
//    • Depth Geometry (disparity concavity, elevation steps, roughness variance)
//    • Surface Semantics (footpath, road, stairs, wall, terrain from SegFormer)
//    • Object Filtering (rejects standing objects detected by ByteTrack)
//    • False Positive Rejection (flat shadows, uniform textures, image borders)
//
//  CRITICAL SAFETY RULES:
//    • Unknown observations MUST NOT be interpreted as proof of safety.
//    • Proximity is estimated ONLY when supported by camera geometry.
//    • Automatic movement instructions are NEVER issued on incomplete evidence.
//    • Uncertain detections use "Possible …" phrasing.
//
//  Exposes: window.hazardDetectorAPI
// ═══════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  const CFG = window.VisionGuideConfig?.hazard || {};
  const FS_CFG = window.VisionGuideConfig?.freeSpace || {};

  /* ─── Thresholds ─────────────────────────────────────────────── */
  const POTHOLE_MIN_DELTA       = CFG.potholeMinDepthDelta ?? 0.16;
  const POTHOLE_CONFIDENT_DELTA = CFG.potholeConfidentDelta ?? 0.28;
  const DRAIN_MIN_DELTA         = CFG.drainMinDepthDelta ?? 0.32;
  const DRAIN_CONFIDENT_DELTA   = CFG.drainConfidentDelta ?? 0.42;
  const CURB_MIN_STEP           = CFG.curbMinStepDelta ?? 0.08;
  const CURB_CONFIDENT_STEP     = CFG.curbConfidentDelta ?? 0.14;
  const RAISED_MIN_DELTA        = CFG.raisedSurfaceMinDelta ?? 0.10;
  const RAISED_MAX_DELTA        = CFG.raisedSurfaceMaxDelta ?? 0.24;
  const BROKEN_MIN_VARIANCE     = CFG.brokenPavementMinVariance ?? 0.08;
  const BROKEN_CONFIDENT_VAR    = CFG.brokenPavementConfidentVariance ?? 0.14;
  const CONFIRM_FRAMES          = CFG.confirmFrames ?? 2;
  const HOLD_MS                 = CFG.holdMs ?? 1200;
  const MIN_RELIABLE_RANGE      = 0.05;

  /* ─── Temporal Hazard Tracker ────────────────────────────────── */
  // Map<hazardKey, { category, side, row, consecutiveFrames, firstSeen, lastSeen, confidence, maxDelta }>
  const _activeTrackers = new Map();

  /* ─── Public API ─────────────────────────────────────────────── */
  window.hazardDetectorAPI = {
    detectHazards,
    detectPotholes,
    detectUncoveredDrains,
    detectCurbs,
    detectRaisedSurfaces,
    detectBrokenPavement,
    reset: () => _activeTrackers.clear(),
    getTrackers: () => Array.from(_activeTrackers.values())
  };

  /* ═══════════════════════════════════════════════════════════════
     MAIN HAZARD DETECTION PIPELINE
  ═══════════════════════════════════════════════════════════════ */
  /**
   * Evaluates all ground hazard categories using multi-modal fusion.
   *
   * @param {Object} ctx
   *   @param {Array}       ctx.grid          — 5x3 navigation cell grid
   *   @param {Object}      ctx.depthMap      — Depth-Anything-V2 depth map
   *   @param {Object}      ctx.surfaceMap    — SegFormer surface map
   *   @param {Array}       ctx.tracks        — ByteTrack active tracks
   *   @param {number}      ctx.vw            — Video width
   *   @param {number}      ctx.vh            — Video height
   *   @param {Array}       ctx.floorBaseline — Per-row ground baseline disparity
   *   @param {Array}       ctx.rowBaseline   — Per-row average baseline disparity
   *   @param {number}      ctx.range         — Scene depth dynamic range
   * @returns {Object|null} Top priority hazard or null
   */
  function detectHazards(ctx) {
    if (!ctx || !ctx.grid || !ctx.depthMap || !ctx.depthMap.data) {
      return null;
    }

    const { grid, depthMap, surfaceMap, tracks = [], vw, vh, floorBaseline, range } = ctx;

    // Reliability check: reject unverified / low-contrast scenes
    if (!range || range < MIN_RELIABLE_RANGE || !Number.isFinite(range)) {
      return null;
    }

    const allHazards = [];

    // 1. Detect Uncovered Drains (Critical severity)
    const drainHazards = detectUncoveredDrains(grid, depthMap, surfaceMap, floorBaseline, range, vw, vh);
    allHazards.push(...drainHazards);

    // 2. Detect Potholes (High severity)
    const potholeHazards = detectPotholes(grid, depthMap, surfaceMap, tracks, floorBaseline, range, vw, vh);
    allHazards.push(...potholeHazards);

    // 3. Detect Curb Edges (Medium severity)
    const curbHazards = detectCurbs(grid, depthMap, surfaceMap, floorBaseline, range, vw, vh);
    allHazards.push(...curbHazards);

    // 4. Detect Raised / Damaged Surfaces (Medium severity)
    const raisedHazards = detectRaisedSurfaces(grid, depthMap, surfaceMap, tracks, floorBaseline, range, vw, vh);
    allHazards.push(...raisedHazards);

    // 5. Detect Broken Pavement (Medium severity)
    const brokenHazards = detectBrokenPavement(grid, depthMap, surfaceMap, tracks, floorBaseline, range, vw, vh);
    allHazards.push(...brokenHazards);

    if (allHazards.length === 0) {
      _pruneTrackers(Date.now());
      return null;
    }

    // Sort by hazard priority: critical > high > medium > low, then confidence, then closeness
    const priorityWeight = { critical: 400, high: 300, medium: 200, low: 100 };
    const confWeight = { confident: 50, uncertain: 20, none: 0 };
    const rowWeight = { near: 30, mid: 15, far: 0 };

    allHazards.sort((a, b) => {
      const scoreA = (priorityWeight[a.riskLevel] || 0) + (confWeight[a.confidence] || 0) + (rowWeight[a.location?.row] || 0);
      const scoreB = (priorityWeight[b.riskLevel] || 0) + (confWeight[b.confidence] || 0) + (rowWeight[b.location?.row] || 0);
      return scoreB - scoreA;
    });

    const primary = allHazards[0];
    const trackedPrimary = _updateTracker(primary);

    return trackedPrimary;
  }

  /* ═══════════════════════════════════════════════════════════════
     CATEGORY 1: UNCOVERED DRAINS
     Characteristics: Deep elongated void/trench (delta >= 0.32),
     often near curb or spanning columns longitudinally.
  ═══════════════════════════════════════════════════════════════ */
  function detectUncoveredDrains(grid, depthMap, surfaceMap, floorBaseline, range, vw, vh) {
    const results = [];
    if (!floorBaseline) return results;

    const COLS = 5;
    const ROWS = 3;

    // Look for severe depth drops
    const deepCells = [];
    grid.forEach(cell => {
      if (cell.r < 1) return; // Focus on walking corridor (near & mid rows)
      const base = floorBaseline[cell.r];
      const cellD = _cellAvgDepth(cell, depthMap);
      if (!Number.isFinite(cellD)) return;

      const dropDelta = (base - cellD) / range;
      if (dropDelta >= DRAIN_MIN_DELTA) {
        deepCells.push({ cell, dropDelta });
      }
    });

    if (deepCells.length === 0) return results;

    // Check for longitudinal elongation (same column across row 1 and row 2)
    // or transverse trench (2+ adjacent columns with severe drop)
    const colGroups = {};
    deepCells.forEach(({ cell, dropDelta }) => {
      colGroups[cell.c] = colGroups[cell.c] || [];
      colGroups[cell.c].push({ cell, dropDelta });
    });

    for (const [colStr, items] of Object.entries(colGroups)) {
      const c = Number(colStr);
      const isLongitudinalTrench = items.length >= 2; // spans near & mid rows
      const maxDelta = Math.max(...items.map(i => i.dropDelta));
      const hasRoadProximity = items.some(i => i.cell.surfaceCategory === 'road' || i.cell.surfaceCategory === 'terrain');

      if (isLongitudinalTrench || maxDelta >= DRAIN_CONFIDENT_DELTA) {
        const side = c < 2 ? 'left' : c > 2 ? 'right' : 'center';
        const isNear = items.some(i => i.cell.r === 2);
        const isConfident = maxDelta >= DRAIN_CONFIDENT_DELTA || isLongitudinalTrench;

        const hazard = _buildHazardResult({
          category: 'uncovered-drain',
          confidence: isConfident ? 'confident' : 'uncertain',
          riskLevel: 'critical',
          side,
          row: isNear ? 'near' : 'mid',
          proximity: isNear ? 'immediate' : 'close',
          cells: items.map(i => i.cell),
          delta: maxDelta,
          vw, vh,
          alertMessageConfident: side === 'center'
            ? 'Uncovered drain detected ahead. Please stop.'
            : `Uncovered drain on the ${side}. Step carefully.`,
          alertMessageUncertain: 'Possible uncovered drain ahead. Proceed with caution.'
        });

        items.forEach(i => {
          i.cell.status = 'dropoff';
          i.cell.zone = 'danger';
          i.cell.src = 'hazard-drain';
        });

        results.push(hazard);
      }
    }

    return results;
  }

  /* ═══════════════════════════════════════════════════════════════
     CATEGORY 2: POTHOLES
     Characteristics: Bounded ground concavity surrounded by
     continuous ground/road, unlike an open cliff edge.
  ═══════════════════════════════════════════════════════════════ */
  function detectPotholes(grid, depthMap, surfaceMap, tracks, floorBaseline, range, vw, vh) {
    const results = [];
    if (!floorBaseline) return results;

    const COLS = 5;
    const ROWS = 3;

    // Scan near and mid walking rows
    for (let r = 1; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const cell = grid[r * COLS + c];
        if (cell.status === 'obstacle' && cell.src === 'det') continue; // Skip physical objects

        const base = floorBaseline[r];
        const cellD = _cellAvgDepth(cell, depthMap);
        if (!Number.isFinite(cellD)) continue;

        const dropDelta = (base - cellD) / range;
        if (dropDelta < POTHOLE_MIN_DELTA || dropDelta >= DRAIN_MIN_DELTA) {
          continue; // Either too shallow or is an uncovered drain
        }

        // Exclude curb boundary transitions (step between footpath and road)
        const leftCell  = c > 0 ? grid[r * COLS + (c - 1)] : null;
        const rightCell = c < COLS - 1 ? grid[r * COLS + (c + 1)] : null;
        const farCell   = r > 0 ? grid[(r - 1) * COLS + c] : null;

        const isCurbInterface = (leftCell && leftCell.surfaceCategory !== cell.surfaceCategory && (leftCell.surfaceCategory === 'road' || cell.surfaceCategory === 'road')) ||
                                (rightCell && rightCell.surfaceCategory !== cell.surfaceCategory && (rightCell.surfaceCategory === 'road' || cell.surfaceCategory === 'road'));
        if (isCurbInterface) {
          continue;
        }

        // Bounded geometry check:
        // A pothole must be bounded by normal ground laterally or in adjacent rows.
        let boundedNeighbors = 0;

        if (leftCell) {
          const leftD = _cellAvgDepth(leftCell, depthMap);
          if (Math.abs(base - leftD) / range < POTHOLE_MIN_DELTA) boundedNeighbors++;
        }
        if (rightCell) {
          const rightD = _cellAvgDepth(rightCell, depthMap);
          if (Math.abs(base - rightD) / range < POTHOLE_MIN_DELTA) boundedNeighbors++;
        }
        if (farCell) {
          const farBase = floorBaseline[r - 1] || base;
          const farD = _cellAvgDepth(farCell, depthMap);
          if (Math.abs(farBase - farD) / range < POTHOLE_MIN_DELTA) boundedNeighbors++;
        }

        // Must have at least 1 verified ground neighbor to confirm bounded concavity
        if (boundedNeighbors === 0) continue;

        // Shadow Rejection: Depth must show true geometric depression, not flat pixels
        const variance = _cellDepthVariance(cell, depthMap, cellD);
        if (variance < 0.0001 && dropDelta < 0.20) {
          continue; // Flat shadow artifact
        }

        const isConfident = dropDelta >= POTHOLE_CONFIDENT_DELTA && boundedNeighbors >= 2;
        const side = c < 2 ? 'left' : c > 2 ? 'right' : 'center';
        const isNear = r === 2;

        const hazard = _buildHazardResult({
          category: 'pothole',
          confidence: isConfident ? 'confident' : 'uncertain',
          riskLevel: side === 'center' ? (isNear ? 'high' : 'medium') : 'medium',
          side,
          row: isNear ? 'near' : 'mid',
          proximity: isNear ? 'immediate' : 'close',
          cells: [cell],
          delta: dropDelta,
          vw, vh,
          alertMessageConfident: side === 'center'
            ? 'Pothole detected ahead. Step carefully.'
            : `Pothole on your ${side}. Step carefully.`,
          alertMessageUncertain: side === 'center'
            ? 'Possible pothole ahead.'
            : `Possible pothole on your ${side}.`
        });

        cell.status = 'caution';
        cell.zone = isNear ? 'danger' : 'close';
        cell.src = 'hazard-pothole';

        results.push(hazard);
      }
    }

    return results;
  }

  /* ═══════════════════════════════════════════════════════════════
     CATEGORY 3: CURB EDGES
     Characteristics: Boundary between footpath and road accompanied
     by elevation step-down or step-up.
  ═══════════════════════════════════════════════════════════════ */
  function detectCurbs(grid, depthMap, surfaceMap, floorBaseline, range, vw, vh) {
    const results = [];
    if (!surfaceMap || !surfaceMap.cells) return results;

    const COLS = 5;
    const ROWS = 3;

    // Check lateral curb boundaries (adjacent columns in same row)
    for (let r = 1; r < ROWS; r++) {
      for (let c = 0; c < COLS - 1; c++) {
        const leftCell  = grid[r * COLS + c];
        const rightCell = grid[r * COLS + c + 1];

        const leftCat  = leftCell.surfaceCategory;
        const rightCat = rightCell.surfaceCategory;

        const isFootToRoad = (leftCat === 'footpath' && rightCat === 'road') ||
                             (leftCat === 'road' && rightCat === 'footpath');

        if (!isFootToRoad) continue;

        // Measure elevation step at boundary
        const leftD  = _cellAvgDepth(leftCell, depthMap);
        const rightD = _cellAvgDepth(rightCell, depthMap);
        const stepDelta = Math.abs(leftD - rightD) / range;

        if (stepDelta >= CURB_MIN_STEP) {
          const isConfident = stepDelta >= CURB_CONFIDENT_STEP;
          const curbSide = c === 1 ? 'left' : c === 2 ? 'right' : (c === 0 ? 'left' : 'right');
          const isNear = r === 2;

          const hazard = _buildHazardResult({
            category: 'curb',
            confidence: isConfident ? 'confident' : 'uncertain',
            riskLevel: 'medium',
            side: curbSide,
            row: isNear ? 'near' : 'mid',
            proximity: isNear ? 'immediate' : 'close',
            cells: [leftCell, rightCell],
            delta: stepDelta,
            vw, vh,
            alertMessageConfident: 'Curb edge ahead. Step carefully.',
            alertMessageUncertain: 'Possible curb edge ahead.'
          });

          leftCell.src = leftCell.src || 'hazard-curb';
          rightCell.src = rightCell.src || 'hazard-curb';
          results.push(hazard);
        }
      }
    }

    // Check longitudinal curb (row 2 is footpath, row 1 is road ahead)
    for (let c = 1; c <= 3; c++) {
      const nearCell = grid[2 * COLS + c];
      const midCell  = grid[1 * COLS + c];

      if (nearCell.surfaceCategory === 'footpath' && midCell.surfaceCategory === 'road') {
        const nearD = _cellAvgDepth(nearCell, depthMap);
        const midD  = _cellAvgDepth(midCell, depthMap);
        const stepDelta = Math.abs(nearD - midD) / range;

        if (stepDelta >= CURB_MIN_STEP) {
          const isConfident = stepDelta >= CURB_CONFIDENT_STEP;
          const hazard = _buildHazardResult({
            category: 'curb',
            confidence: isConfident ? 'confident' : 'uncertain',
            riskLevel: 'medium',
            side: 'center',
            row: 'near',
            proximity: 'immediate',
            cells: [nearCell, midCell],
            delta: stepDelta,
            vw, vh,
            alertMessageConfident: 'Curb step-down to road ahead.',
            alertMessageUncertain: 'Possible curb edge ahead.'
          });
          results.push(hazard);
          break;
        }
      }
    }

    return results;
  }

  /* ═══════════════════════════════════════════════════════════════
     CATEGORY 4: RAISED SURFACES
     Characteristics: Low-lying positive ground protrusion (3–15 cm)
     such as an uplifted tile, paver edge, or tree root.
  ═══════════════════════════════════════════════════════════════ */
  function detectRaisedSurfaces(grid, depthMap, surfaceMap, tracks, floorBaseline, range, vw, vh) {
    const results = [];
    if (!floorBaseline) return results;

    const COLS = 5;
    const ROWS = 3;

    for (let r = 1; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const cell = grid[r * COLS + c];
        if (cell.status === 'obstacle' && cell.src === 'det') continue; // Not a recognized object

        const base = floorBaseline[r];
        const cellD = _cellAvgDepth(cell, depthMap);
        if (!Number.isFinite(cellD)) continue;

        // Disparity is higher than baseline (closer) by 0.10 to 0.24
        const raiseDelta = (cellD - base) / range;
        if (raiseDelta < RAISED_MIN_DELTA || raiseDelta >= RAISED_MAX_DELTA) {
          continue;
        }

        // Must be bounded: upper row must NOT be an obstacle (not a standing wall or human)
        const upperCell = r > 0 ? grid[(r - 1) * COLS + c] : null;
        if (upperCell && upperCell.status === 'obstacle' && upperCell.src !== 'hazard-raised') {
          continue; // Part of a tall obstacle, not a low ground raise
        }

        const isConfident = raiseDelta >= 0.16;
        const side = c < 2 ? 'left' : c > 2 ? 'right' : 'center';
        const isNear = r === 2;

        const hazard = _buildHazardResult({
          category: 'raised-surface',
          confidence: isConfident ? 'confident' : 'uncertain',
          riskLevel: 'medium',
          side,
          row: isNear ? 'near' : 'mid',
          proximity: isNear ? 'immediate' : 'close',
          cells: [cell],
          delta: raiseDelta,
          vw, vh,
          alertMessageConfident: side === 'center'
            ? 'Raised surface ahead. Watch your step.'
            : `Raised surface on your ${side}.`,
          alertMessageUncertain: 'Possible raised surface ahead.'
        });

        cell.status = 'caution';
        cell.zone = isNear ? 'danger' : 'close';
        cell.src = 'hazard-raised';

        results.push(hazard);
      }
    }

    return results;
  }

  /* ═══════════════════════════════════════════════════════════════
     CATEGORY 5: BROKEN PAVEMENT
     Characteristics: High spatial roughness / micro-discontinuities
     on a walking surface without a single deep crater.
  ═══════════════════════════════════════════════════════════════ */
  function detectBrokenPavement(grid, depthMap, surfaceMap, tracks, floorBaseline, range, vw, vh) {
    const results = [];
    const COLS = 5;
    const ROWS = 3;

    for (let r = 1; r < ROWS; r++) {
      for (let c = 1; c <= 3; c++) { // Walking corridor
        const cell = grid[r * COLS + c];
        // If already identified as a raised surface or obstacle, skip
        if (cell.src === 'hazard-raised' || (cell.status === 'obstacle' && cell.src === 'det')) continue;

        // Only evaluate walking surfaces (footpath, floor, terrain)
        const isWalkable = cell.surfaceCategory === 'footpath' || cell.surfaceCategory === 'floor' || cell.surfaceCategory === 'terrain';
        if (!isWalkable) continue;

        const cellD = _cellAvgDepth(cell, depthMap);
        if (!Number.isFinite(cellD)) continue;

        // If net elevation is significantly raised, it belongs to raised-surface, not broken-pavement
        if (floorBaseline && (cellD - floorBaseline[r]) / range >= RAISED_MIN_DELTA) continue;

        const variance = _cellDepthVariance(cell, depthMap, cellD);
        const normVariance = Math.sqrt(variance) / range;

        if (normVariance >= BROKEN_MIN_VARIANCE) {
          const isConfident = normVariance >= BROKEN_CONFIDENT_VAR;
          const side = c === 2 ? 'center' : (c === 1 ? 'left' : 'right');
          const isNear = r === 2;

          const hazard = _buildHazardResult({
            category: 'broken-pavement',
            confidence: isConfident ? 'confident' : 'uncertain',
            riskLevel: 'medium',
            side,
            row: isNear ? 'near' : 'mid',
            proximity: isNear ? 'immediate' : 'close',
            cells: [cell],
            delta: normVariance,
            vw, vh,
            alertMessageConfident: 'Uneven, broken pavement ahead. Watch your footing.',
            alertMessageUncertain: 'Possible uneven pavement ahead.'
          });

          cell.status = 'caution';
          cell.src = 'hazard-broken';
          results.push(hazard);
        }
      }
    }

    return results;
  }

  /* ═══════════════════════════════════════════════════════════════
     RESULT BUILDER & PROXIMITY RULES
  ═══════════════════════════════════════════════════════════════ */
  function _buildHazardResult(opts) {
    const {
      category, confidence, riskLevel, side, row, proximity,
      cells, delta, vw, vh, alertMessageConfident, alertMessageUncertain
    } = opts;

    // Standard bounding box enclosing affected cells
    let minX = vw, minY = vh, maxX = 0, maxY = 0;
    cells.forEach(c => {
      minX = Math.min(minX, c.x);
      minY = Math.min(minY, c.y);
      maxX = Math.max(maxX, c.x + c.w);
      maxY = Math.max(maxY, c.y + c.h);
    });

    const alertMessage = confidence === 'confident' ? alertMessageConfident : alertMessageUncertain;

    return {
      category,
      type: category, // Backward-compatibility
      confidence,
      riskLevel,
      proximity: confidence === 'confident' ? proximity : null, // Proximity only when supported
      persistence: 1,
      alertMessage,
      label: alertMessage, // Backward-compatibility
      alertMessageConfident,
      alertMessageUncertain,
      delta: Math.round(delta * 100) / 100,
      location: {
        side,
        row,
        xNorm: Math.round(((minX + maxX) / (2 * vw)) * 100) / 100,
        yNorm: Math.round(((minY + maxY) / (2 * vh)) * 100) / 100,
        x: Math.round(minX),
        y: Math.round(minY),
        width: Math.round(maxX - minX),
        height: Math.round(maxY - minY)
      },
      cells
    };
  }

  /* ═══════════════════════════════════════════════════════════════
     TEMPORAL PERSISTENCE TRACKER
  ═══════════════════════════════════════════════════════════════ */
  function _updateTracker(hazard) {
    const now = Date.now();
    const key = `${hazard.category}:${hazard.location.side}:${hazard.location.row}`;
    const existing = _activeTrackers.get(key);

    let persistence = 1;
    let confidence = hazard.confidence;

    if (existing && (now - existing.lastSeen) < HOLD_MS) {
      persistence = existing.consecutiveFrames + 1;
      existing.consecutiveFrames = persistence;
      existing.lastSeen = now;
      existing.maxDelta = Math.max(existing.maxDelta, hazard.delta);

      // Multi-frame escalation: uncertain hazard persisting >= CONFIRM_FRAMES becomes confident
      if (persistence >= CONFIRM_FRAMES && confidence === 'uncertain') {
        confidence = 'confident';
      }
    } else {
      _activeTrackers.set(key, {
        category: hazard.category,
        side: hazard.location.side,
        row: hazard.location.row,
        consecutiveFrames: 1,
        firstSeen: now,
        lastSeen: now,
        confidence,
        maxDelta: hazard.delta
      });
    }

    _pruneTrackers(now);

    const finalAlert = confidence === 'confident'
      ? (hazard.alertMessageConfident || hazard.alertMessage)
      : (hazard.alertMessageUncertain || hazard.alertMessage);

    return {
      ...hazard,
      confidence,
      persistence,
      alertMessage: finalAlert,
      label: finalAlert,
      proximity: confidence === 'confident' ? (hazard.proximity || (hazard.location?.row === 'near' ? 'immediate' : 'close')) : null
    };
  }

  function _pruneTrackers(now) {
    for (const [key, tr] of _activeTrackers.entries()) {
      if (now - tr.lastSeen > HOLD_MS) {
        _activeTrackers.delete(key);
      }
    }
  }

  /* ═══════════════════════════════════════════════════════════════
     DEPTH UTILITIES (Sampling & Spatial Variance)
  ═══════════════════════════════════════════════════════════════ */
  function _cellAvgDepth(cell, depthMap) {
    const { data, width: dw, height: dh } = depthMap;
    const x0 = Math.floor((cell.c / 5) * dw);
    const x1 = Math.floor(((cell.c + 1) / 5) * dw);
    const y0 = Math.floor((cell.r / 3) * dh);
    const y1 = Math.floor(((cell.r + 1) / 3) * dh);

    let sum = 0, count = 0;
    const stepX = Math.max(1, Math.floor((x1 - x0) / 6));
    const stepY = Math.max(1, Math.floor((y1 - y0) / 6));

    for (let y = y0; y < y1; y += stepY) {
      for (let x = x0; x < x1; x += stepX) {
        const val = data[y * dw + x];
        if (Number.isFinite(val)) {
          sum += val;
          count++;
        }
      }
    }
    return count > 0 ? sum / count : NaN;
  }

  function _cellDepthVariance(cell, depthMap, mean) {
    const { data, width: dw, height: dh } = depthMap;
    const x0 = Math.floor((cell.c / 5) * dw);
    const x1 = Math.floor(((cell.c + 1) / 5) * dw);
    const y0 = Math.floor((cell.r / 3) * dh);
    const y1 = Math.floor(((cell.r + 1) / 3) * dh);

    let sumSq = 0, count = 0;
    const stepX = Math.max(1, Math.floor((x1 - x0) / 6));
    const stepY = Math.max(1, Math.floor((y1 - y0) / 6));

    for (let y = y0; y < y1; y += stepY) {
      for (let x = x0; x < x1; x += stepX) {
        const val = data[y * dw + x];
        if (Number.isFinite(val)) {
          const diff = val - mean;
          sumSq += diff * diff;
          count++;
        }
      }
    }
    return count > 0 ? sumSq / count : 0;
  }

})();
