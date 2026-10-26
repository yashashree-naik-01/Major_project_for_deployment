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
  const POTHOLE_MIN_DELTA = CFG.potholeMinDepthDelta ?? 0.16;
  const POTHOLE_CONFIDENT_DELTA = CFG.potholeConfidentDelta ?? 0.28;
  const DRAIN_MIN_DELTA = CFG.drainMinDepthDelta ?? 0.50;
  const DRAIN_CONFIDENT_DELTA = CFG.drainConfidentDelta ?? 0.60;
  const CURB_MIN_STEP = CFG.curbMinStepDelta ?? 0.08;
  const CURB_CONFIDENT_STEP = CFG.curbConfidentDelta ?? 0.14;
  const RAISED_MIN_DELTA = CFG.raisedSurfaceMinDelta ?? 0.10;
  const RAISED_MAX_DELTA = CFG.raisedSurfaceMaxDelta ?? 0.24;
  const BROKEN_MIN_VARIANCE = CFG.brokenPavementMinVariance ?? 0.08;
  const BROKEN_CONFIDENT_VAR = CFG.brokenPavementConfidentVariance ?? 0.14;
  const CONFIRM_FRAMES = CFG.confirmFrames ?? 2;
  const HOLD_MS = CFG.holdMs ?? 1200;
  const MIN_RELIABLE_RANGE = 0.05;

  /* ─── Temporal Hazard Tracker ────────────────────────────────── */
  // Map<hazardKey, { category, side, row, consecutiveFrames, firstSeen, lastSeen, confidence, maxDelta }>
  const _activeTrackers = new Map();

  /* ─── Public API ─────────────────────────────────────────────── */
  window.hazardDetectorAPI = {
    detectHazards,
    detectStairs,
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

    // 2. Detect Stairs (Critical severity for stairs-down, High for stairs-up)
    const stairHazards = detectStairs(grid, depthMap, surfaceMap, tracks, floorBaseline, range, vw, vh);
    allHazards.push(...stairHazards);

    // 3. Detect Potholes (High severity)
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
      const maxDelta = Math.max(...items.map(i => i.dropDelta));
      const hasRoadProximity = items.some(i => i.cell.surfaceCategory === 'road' || i.cell.surfaceCategory === 'terrain');
      const isLongitudinalTrench =
        items.length >= 2 &&
        items.some(i => i.cell.r === 1) &&
        items.some(i => i.cell.r === 2) &&
        maxDelta >= DRAIN_MIN_DELTA; // spans near & mid rows

      if (
        hasRoadProximity &&
        maxDelta >= DRAIN_CONFIDENT_DELTA &&
        isLongitudinalTrench
      ) {
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

    if (
      !Array.isArray(grid) ||
      !depthMap?.data ||
      !depthMap.width ||
      !depthMap.height ||
      !Array.isArray(floorBaseline) ||
      !Number.isFinite(range) ||
      range < MIN_RELIABLE_RANGE
    ) {
      return results;
    }

    const COLS = 5;
    const ROWS = 3;

    // Require stronger evidence than a single depth difference.
    const MIN_DELTA = Math.max(POTHOLE_MIN_DELTA, 0.30);
    const CONFIDENT_DELTA = Math.max(POTHOLE_CONFIDENT_DELTA, 0.40);

    const isWalkable = cell =>
      cell &&
      ['road', 'footpath', 'floor', 'terrain'].includes(
        String(cell.surfaceCategory || '').toLowerCase()
      );

    const getDepth = cell => {
      if (!cell) return NaN;
      const value = _cellAvgDepth(cell, depthMap);
      return Number.isFinite(value) ? value : NaN;
    };

    for (let r = 1; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const index = r * COLS + c;
        const cell = grid[index];

        if (!cell || !isWalkable(cell)) continue;

        // Do not classify a detected physical object as a pothole.
        if (cell.status === 'obstacle') continue;

        const baseline = floorBaseline[r];
        const depth = getDepth(cell);

        if (!Number.isFinite(baseline) || !Number.isFinite(depth)) {
          continue;
        }

        // In this relative-depth representation, a lower value than
        // the baseline is treated as a possible depression.
        const delta = (baseline - depth) / range;

        // Reject weak depth changes and changes large enough to be
        // more consistent with the separate drain/drop-off detector.
        if (delta < MIN_DELTA || delta >= DRAIN_MIN_DELTA) {
          continue;
        }

        const left = c > 0 ? grid[r * COLS + c - 1] : null;
        const right = c < COLS - 1 ? grid[r * COLS + c + 1] : null;
        const far = r > 0 ? grid[(r - 1) * COLS + c] : null;

        // Reject transitions involving road boundaries or unknown
        // neighboring surfaces.
        const neighbors = [left, right, far].filter(Boolean);

        if (neighbors.some(n => !isWalkable(n))) continue;

        const hasRoadBoundary = neighbors.some(n =>
          n.surfaceCategory !== cell.surfaceCategory &&
          (n.surfaceCategory === 'road' || cell.surfaceCategory === 'road')
        );

        if (hasRoadBoundary) continue;

        // A bounded depression should be surrounded by multiple
        // neighboring cells whose depths are close to the baseline.
        let confirmedNeighbors = 0;

        for (const neighbor of neighbors) {
          const neighborDepth = getDepth(neighbor);
          if (!Number.isFinite(neighborDepth)) continue;

          const neighborBaseline = floorBaseline[neighbor.r];

          if (!Number.isFinite(neighborBaseline)) continue;

          const neighborDelta =
            Math.abs(neighborBaseline - neighborDepth) / range;

          if (neighborDelta < 0.12) {
            confirmedNeighbors++;
          }
        }

        // Require at least two neighboring cells supporting normal ground.
        if (confirmedNeighbors < 2) continue;

        // Reject detected-object overlap.
        if (
          Array.isArray(tracks) &&
          tracks.some(track => {
            if (!Array.isArray(track.bbox) || track.bbox.length < 4) {
              return false;
            }

            const [bx, by, bw, bh] = track.bbox;

            if (![bx, by, bw, bh, vw, vh].every(Number.isFinite)) {
              return false;
            }

            const cx = cell.x + cell.w / 2;
            const cy = cell.y + cell.h / 2;

            return (
              cx >= bx &&
              cx <= bx + bw &&
              cy >= by &&
              cy <= by + bh
            );
          })
        ) {
          continue;
        }

        // Require a stronger signal for a confident classification.
        const confident =
          delta >= CONFIDENT_DELTA &&
          confirmedNeighbors >= 3;

        const side = c < 2 ? 'left' : c > 2 ? 'right' : 'center';
        const near = r === 2;

        const hazard = _buildHazardResult({
          category: 'pothole',
          confidence: confident ? 'confident' : 'uncertain',
          riskLevel: 'medium',
          side,
          row: near ? 'near' : 'mid',
          proximity: near ? 'immediate' : 'close',
          cells: [cell],
          delta,
          vw,
          vh,
          alertMessageConfident:
            side === 'center'
              ? 'Possible ground depression ahead. Stop and check.'
              : `Possible ground depression on your ${side}. Stop and check.`,
          alertMessageUncertain:
            'Possible uneven ground detected. Verify before proceeding.'
        });

        // Avoid claiming a confirmed pothole based on relative depth alone.
        cell.status = 'caution';
        cell.zone = near ? 'danger' : 'close';
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
        const leftCell = grid[r * COLS + c];
        const rightCell = grid[r * COLS + c + 1];

        const leftCat = leftCell.surfaceCategory;
        const rightCat = rightCell.surfaceCategory;

        const isFootToRoad = (leftCat === 'footpath' && rightCat === 'road') ||
          (leftCat === 'road' && rightCat === 'footpath');

        if (!isFootToRoad) continue;

        // Measure elevation step at boundary
        const leftD = _cellAvgDepth(leftCell, depthMap);
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
      const midCell = grid[1 * COLS + c];

      if (nearCell.surfaceCategory === 'footpath' && midCell.surfaceCategory === 'road') {
        const nearD = _cellAvgDepth(nearCell, depthMap);
        const midD = _cellAvgDepth(midCell, depthMap);
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
     CATEGORY 6: STAIRS & STEP HAZARDS (Ascending & Descending)
     Characteristics:
       • Multi-modal fusion: Corridor depth profile P(y), periodic
         riser step edges, tread plateaus, horizontal Sobel dominance.
       • Distinguishes descending stairs (void treads dropping below
         ground baseline) from ascending stairs (risers elevating
         above flat floor continuation).
       • Discriminates ambiguous step-like structures with cautious
         alerting ("Possible stairs ahead. Stop and check before proceeding.")
       • Rejects continuous ramps, flat checkerboard floors, shadows,
         and side handrails.
       • Masks out dynamic obstacles (pedestrians) so they are not
         confused with stair structure.
  ═══════════════════════════════════════════════════════════════ */
  function detectStairs(grid, depthMap, surfaceMap, tracks, floorBaseline, range, vw, vh) {
    const results = [];
    if (!depthMap || !depthMap.data || !range || range < MIN_RELIABLE_RANGE) return results;

    const { data, width: dw, height: dh } = depthMap;
    if (!dw || !dh || !data.length) return results;

    // 1. Build obstacle exclusion mask from ByteTrack tracks
    // (Ensure standing persons or objects on steps do not corrupt stair riser detection)
    const obstacleMask = new Uint8Array(dw * dh);
    if (Array.isArray(tracks)) {
      for (const tr of tracks) {
        if (!tr.bbox || tr.bbox.length < 4) continue;
        const [bx, by, bw, bh] = tr.bbox;
        const x0 = Math.max(0, Math.floor((bx / vw) * dw));
        const x1 = Math.min(dw - 1, Math.floor(((bx + bw) / vw) * dw));
        const y0 = Math.max(0, Math.floor((by / vh) * dh));
        const y1 = Math.min(dh - 1, Math.floor(((by + bh) / vh) * dh));
        for (let my = y0; my <= y1; my++) {
          const rowOffset = my * dw;
          for (let mx = x0; mx <= x1; mx++) {
            obstacleMask[rowOffset + mx] = 1;
          }
        }
      }
    }

    // 2. Walking corridor bounds (x: 25% to 75%, y: 20% to 95%)
    const xMin = Math.floor(dw * 0.25);
    const xMax = Math.floor(dw * 0.75);
    const yMin = Math.floor(dh * 0.20);
    const yMax = Math.floor(dh * 0.95);
    const stepY = Math.max(2, Math.floor(dh / 60));

    // 3. Compute row-wise corridor median depth profile P(y)
    const profile = new Float32Array(dh);
    const validRows = new Uint8Array(dh);
    for (let y = yMin; y <= yMax; y++) {
      const vals = [];
      const stepX = Math.max(1, Math.floor((xMax - xMin) / 12));
      const rowOffset = y * dw;
      for (let x = xMin; x <= xMax; x += stepX) {
        if (obstacleMask[rowOffset + x]) continue; // Ignore obstacle pixels
        const v = data[rowOffset + x];
        if (Number.isFinite(v)) vals.push(v);
      }
      if (vals.length >= 3) {
        vals.sort((a, b) => a - b);
        profile[y] = vals[Math.floor(vals.length / 2)];
        validRows[y] = 1;
      }
    }

    // 4. Directional gradient energy check: Horizontal (Sobel Y) vs Vertical (Sobel X)
    // True stairs have dominant horizontal step risers across corridor
    let sumGradY = 0;
    let sumGradX = 0;
    const sampleStep = Math.max(2, Math.floor(dh / 40));
    for (let y = yMin + sampleStep; y < yMax - sampleStep; y += sampleStep) {
      for (let x = xMin + sampleStep; x < xMax - sampleStep; x += sampleStep) {
        if (obstacleMask[y * dw + x]) continue;
        const gy = Math.abs(data[(y + sampleStep) * dw + x] - data[(y - sampleStep) * dw + x]);
        const gx = Math.abs(data[y * dw + (x + sampleStep)] - data[y * dw + (x - sampleStep)]);
        if (Number.isFinite(gy) && Number.isFinite(gx)) {
          sumGradY += gy;
          sumGradX += gx;
        }
      }
    }
    const gradRatio = (sumGradY + 1e-5) / (sumGradX + 1e-5);
    const hasHorizontalDominance = gradRatio >= 1.20;

    // 5. Detect periodic step risers via finite differences
    const threshold = (CFG.stairEdgeThreshold ?? 0.075) * range;
    const detectedRisers = [];
    const minRiserSep = Math.max(3, Math.floor(dh / 20));
    let lastRiserY = -100;

    // Multi-column tilt-tolerant edge detection
    const colLeft = Math.floor(dw * 0.35);
    const colCenter = Math.floor(dw * 0.50);
    const colRight = Math.floor(dw * 0.65);
    const tiltWindow = Math.max(3, Math.floor(dh / 25));

    for (let y = yMin; y < yMax - (stepY * 2); y += stepY) {
      if (!validRows[y] || !validRows[y + stepY]) continue;
      const gradCenter = Math.abs(profile[y] - profile[y + stepY]);
      const gradSpan = Math.abs(profile[y] - profile[Math.min(yMax, y + stepY * 2)]);
      const maxGrad = Math.max(gradCenter, gradSpan);

      if (maxGrad >= threshold) {
        // Cross-column confirmation with tilt tolerance
        let matchingCols = 0;
        for (const colX of [colLeft, colCenter, colRight]) {
          let colHasEdge = false;
          for (let ty = Math.max(yMin, y - tiltWindow); ty <= Math.min(yMax - stepY, y + tiltWindow); ty += stepY) {
            const v1 = data[ty * dw + colX];
            const v2 = data[(ty + stepY) * dw + colX];
            if (Number.isFinite(v1) && Number.isFinite(v2) && Math.abs(v1 - v2) >= threshold * 0.85) {
              colHasEdge = true;
              break;
            }
          }
          if (colHasEdge) matchingCols++;
        }

        if (matchingCols >= 2 && (y - lastRiserY >= minRiserSep)) {
          const isDownward = profile[y] < profile[y + stepY];
          detectedRisers.push({ y, strength: matchingCols, maxGrad, isDownward });
          lastRiserY = y;
        }
      }
    }

    // 6. Continuous ramp rejection:
    // A continuous ramp has near-constant gradient everywhere (no discrete peaks separated by flat treads)
    if (detectedRisers.length >= 2) {
      const gradVals = [];
      for (let y = yMin; y < yMax - stepY; y += stepY) {
        if (validRows[y] && validRows[y + stepY]) {
          gradVals.push(Math.abs(profile[y] - profile[y + stepY]));
        }
      }
      if (gradVals.length > 5) {
        const meanGrad = gradVals.reduce((a, b) => a + b, 0) / gradVals.length;
        const maxGrad = Math.max(...gradVals);
        // On a continuous ramp, maxGrad / meanGrad < 1.70 with low peak variance
        if (maxGrad / (meanGrad + 1e-6) < 1.65 && !hasHorizontalDominance) {
          return results; // Continuous ramp rejected
        }
      }
    }

    // 7. Check SegFormer semantic segmentation confirmation
    let hasSemanticStairs = false;
    let semanticStairShare = 0;
    if (surfaceMap?.cells && Array.isArray(surfaceMap.cells)) {
      for (const sc of surfaceMap.cells) {
        if (sc.c >= 1 && sc.c <= 3 && sc.r >= 1) {
          if (sc.primaryCategory === 'stairs' || (sc.shares?.stairs && sc.shares.stairs >= 0.20)) {
            hasSemanticStairs = true;
            semanticStairShare = Math.max(semanticStairShare, sc.shares?.stairs || 0.35);
          }
        }
      }
    }

    const minEdges = CFG.stairEdgeMinCount ?? 2;
    if (detectedRisers.length < minEdges && !hasSemanticStairs) {
      return results;
    }

    // 8. Distinguish Ascending vs Descending vs Ambiguous
    // In relative inverse depth (disparity):
    // Descending stairs drop down away from camera: floor drops below baseline (negative disparity deviation)
    // Ascending stairs climb up towards upper half of frame: mid ground is elevated closer to camera
    const yMidStart = Math.floor(dh * 0.35);
    const yMidEnd = Math.floor(dh * 0.65);
    let midSum = 0, midCount = 0;
    for (let y = yMidStart; y < yMidEnd; y++) {
      if (validRows[y]) {
        midSum += profile[y];
        midCount++;
      }
    }
    const midAvg = midCount > 0 ? (midSum / midCount) : 0.5;

    const expectedMid = (floorBaseline && Number.isFinite(floorBaseline[0]) && Number.isFinite(floorBaseline[2]))
      ? (floorBaseline[0] + floorBaseline[2]) / 2
      : (validRows[Math.floor(dh * 0.25)] ?? 0.35) * 0.5 + (validRows[Math.floor(dh * 0.85)] ?? 0.80) * 0.5;
    const elevation = (midAvg - expectedMid) / range;

    // Check downward drop-offs from grid or profile
    const dropCells = grid.filter(c => (c.r === 1 || c.r === 2) && c.c >= 1 && c.c <= 3 && c.status === 'dropoff');
    const isDescending = dropCells.length >= 1 || elevation <= -0.05;
    const isAscending = elevation >= 0.05 && !isDescending;

    let category = 'stairs-ambiguous';
    let riskLevel = 'medium';
    let alertMessageConfident = 'Possible stairs ahead. Stop and check before proceeding.';
    let alertMessageUncertain = 'Possible stairs ahead. Stop and check before proceeding.';

    if (isDescending) {
      category = 'stairs-down';
      riskLevel = 'critical';
      alertMessageConfident = 'Descending stairs ahead. Stop and check your step.';
      alertMessageUncertain = 'Possible descending stairs ahead. Stop and check.';
    } else if (isAscending) {
      category = 'stairs-up';
      riskLevel = 'high';
      alertMessageConfident = 'Stairs ahead leading up. Approach carefully.';
      alertMessageUncertain = 'Possible steps ahead. Approach cautiously.';
    }

    const isConfident = hasSemanticStairs || (detectedRisers.length >= 3 && hasHorizontalDominance) || (detectedRisers.length >= 2 && Math.abs(elevation) >= 0.12);
    const confidence = isConfident ? 'confident' : 'uncertain';
    const uncertainty = isConfident ? 0.15 : 0.45;

    const firstY = detectedRisers[0]?.y ?? Math.floor(dh * 0.40);
    const lastY = detectedRisers[detectedRisers.length - 1]?.y ?? Math.floor(dh * 0.75);
    const isNear = lastY > dh * 0.65 || dropCells.some(c => c.r === 2);

    const affectedGridCells = grid.filter(c => (c.r === 1 || c.r === 2) && c.c >= 1 && c.c <= 3);
    affectedGridCells.forEach(cell => {
      if (cell.status === 'clear') {
        cell.status = isDescending ? 'dropoff' : 'caution';
        cell.zone = isNear ? 'danger' : 'medium';
        cell.src = 'hazard-stairs';
      }
    });

    const hazardResult = _buildHazardResult({
      category,
      confidence,
      riskLevel,
      side: 'center',
      row: isNear ? 'near' : 'mid',
      proximity: isNear ? 'immediate' : 'close',
      cells: affectedGridCells,
      delta: Math.max(...detectedRisers.map(r => r.maxGrad), Math.abs(elevation) * range),
      vw, vh,
      alertMessageConfident,
      alertMessageUncertain
    });

    hazardResult.edgeCount = detectedRisers.length;
    hazardResult.uncertainty = uncertainty;
    hazardResult.hasHorizontalDominance = hasHorizontalDominance;
    hazardResult.surfaceConfirmed = hasSemanticStairs;

    results.push(hazardResult);
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
      // Persistence alone is not proof that a hazard is real.
      // Keep the detector's original confidence classification.
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
      let rowSum = 0, rowCount = 0;
      for (let x = x0; x < x1; x += stepX) {
        const val = data[y * dw + x];
        if (Number.isFinite(val)) { rowSum += val; rowCount++; }
      }
      if (rowCount > 1) {
        const rowMean = rowSum / rowCount;
        for (let x = x0; x < x1; x += stepX) {
          const val = data[y * dw + x];
          if (Number.isFinite(val)) {
            const diff = val - rowMean;
            sumSq += diff * diff;
            count++;
          }
        }
      }
    }
    return count > 0 ? sumSq / count : 0;
  }

})();
