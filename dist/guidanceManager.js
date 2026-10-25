// ═══════════════════════════════════════════════════════════════════
//  VisionGuide — Intelligent Guidance & Spoken Alert Manager
//
//  Prioritizes critical hazards, prevents repetition fatigue,
//  protects urgent warnings from lower-priority interruptions,
//  and notifies users of visibility and system health issues.
//
//  Alert Hierarchy:
//    • 110–120 : CRITICAL HAZARDS (Confident drop-offs, descending stairs,
//                uncovered drains, immediate collision risk, system failure)
//    •  90–105 : URGENT WARNINGS (Uncertain drop-offs/stairs, stop commands,
//                GPS navigation turns)
//    •  80–89  : CAUTION ALERTS (Potholes, curbs, raised surfaces, poor visibility)
//    •  60–79  : USER INTERACTIONS & NORMAL GUIDANCE (Voice commands, clear path)
//    •  40–55  : OCR READINGS (Signboards, packaging text)
//    •  20–39  : SCENE OBJECTS (Routine object descriptions, e.g. bench on right)
//
//  Exposes: window.guidanceAPI
// ═══════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  const CFG = window.VisionGuideConfig?.guidance || {};
  const MAX_QUEUE = CFG.queueLimit || 8;
  const MAX_AGE_MS = CFG.maxAgeMs || 5000;
  const QUIET_WINDOW_MS = CFG.quietWindowMs || 3000;
  const URGENT_THRESHOLD = CFG.urgentThreshold || 85;
  const CRITICAL_THRESHOLD = CFG.criticalThreshold || 100;
  const BACKOFF_INTERVALS = CFG.backoffIntervalsMs || [5000, 12000, 25000, 45000];

  /* ─── State ─────────────────────────────────────────────────── */
  let queue = [];
  let active = null;
  let player = null;
  let cancelPlayer = null;
  let sequence = 0;
  let lastUrgentTime = 0;

  // Semantic alert history & adaptive repetition tracking
  // Map<key, { count, firstSpoken, lastSpoken, lastPriority, backoffIndex }>
  const _alertTrackers = new Map();

  // System health & visibility state
  // Map<type, { status, level, message, reportedAt }>
  const _systemHealth = new Map();

  /* ─── Public API ─────────────────────────────────────────────── */
  window.guidanceAPI = {
    configure,
    announce,
    clear,
    stop,
    reportSystemStatus,
    getSystemHealth,
    reset,
    getState: () => ({
      speaking: Boolean(active),
      queued: queue.length,
      activePriority: active?.priority || null,
      activeKey: active?.key || null,
      lastUrgentTime,
      quietWindowActive: (Date.now() - lastUrgentTime) < QUIET_WINDOW_MS,
      activeTrackersCount: _alertTrackers.size
    })
  };

  /* ═══════════════════════════════════════════════════════════════
     CONFIGURATION
  ═══════════════════════════════════════════════════════════════ */
  function configure(options) {
    if (!options) return;
    player = options.player || player;
    cancelPlayer = options.cancel || cancelPlayer;
    _pump();
  }

  /* ═══════════════════════════════════════════════════════════════
     ANNOUNCEMENT DISPATCHER & PRIORITIZATION
  ═══════════════════════════════════════════════════════════════ */
  /**
   * Enqueues or immediately plays a guidance message according to priority,
   * deduplication, and suppression rules.
   *
   * @param {string} text
   * @param {Object} [options]
   *   @param {number}  [options.priority=50] — Alert urgency (0-120)
   *   @param {string}  [options.key]         — Semantic deduplication signature
   *   @param {number}  [options.cooldownMs]  — Minimum repeat cooldown override
   *   @param {boolean} [options.interrupt]   — Whether to interrupt active speech
   *   @param {number}  [options.maxAgeMs]    — Discard threshold if queued
   * @returns {Promise<boolean>} Resolves true if spoken, false if discarded
   */
  function announce(text, options = {}) {
    text = String(text || '').trim();
    if (!text) return Promise.resolve(false);

    const now = Date.now();
    const priority = Number(options.priority) || 50;
    const key = String(options.key || text.toLowerCase());
    const isUrgent = priority >= URGENT_THRESHOLD;

    // ── Rule 1: Quiet buffer after urgent safety warnings ─────────
    // Prevent non-critical chatter (e.g. routine objects, OCR) from
    // immediately drowning out surroundings after a safety alert.
    const inQuietWindow = (now - lastUrgentTime) < QUIET_WINDOW_MS;
    if (inQuietWindow && priority < URGENT_THRESHOLD) {
      return Promise.resolve(false);
    }

    // ── Rule 2: Urgent Warning Protection ─────────────────────────
    // If an urgent safety alert is currently being spoken, reject any
    // incoming message with lower priority.
    if (active && active.priority >= URGENT_THRESHOLD && priority < active.priority) {
      return Promise.resolve(false);
    }

    // ── Rule 3: Avoid redundant queuing ───────────────────────────
    if (active?.key === key || queue.some(item => item.key === key)) {
      return Promise.resolve(false);
    }

    // ── Rule 4: Adaptive Deduplication & Repetition Backoff ────────
    const tracker = _alertTrackers.get(key);
    if (tracker) {
      let minCooldown = Number(options.cooldownMs);
      if (!Number.isFinite(minCooldown) || minCooldown <= 0) {
        // Use progressive backoff for repeated identical detections
        const idx = Math.min(tracker.backoffIndex, BACKOFF_INTERVALS.length - 1);
        minCooldown = BACKOFF_INTERVALS[idx];
      }

      if (now - tracker.lastSpoken < minCooldown) {
        return Promise.resolve(false);
      }
    }

    return new Promise(resolve => {
      const item = {
        text,
        key,
        priority,
        interrupt: Boolean(options.interrupt),
        maxAgeMs: Number(options.maxAgeMs) || MAX_AGE_MS,
        createdAt: now,
        sequence: sequence++,
        resolve
      };

      queue.push(item);
      // Sort highest priority first; tie-break by insertion order
      queue.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);

      // Trim queue to prevent buildup of stale alerts
      if (queue.length > MAX_QUEUE) {
        const dropped = queue.pop();
        dropped.resolve(false);
      }

      // ── Rule 5: Priority Interruption ─────────────────────────────
      // Interrupt active speech only if incoming priority is strictly higher
      // and interrupt is requested.
      if (active && item.interrupt && item.priority > active.priority) {
        // Purge queued items lower than the new interrupt priority
        const retained = [];
        queue.forEach(pending => {
          if (pending.priority >= item.priority || pending === item) {
            retained.push(pending);
          } else {
            pending.resolve(false);
          }
        });
        queue = retained;
        cancelPlayer?.();
      }

      _pump();
    });
  }

  /* ═══════════════════════════════════════════════════════════════
     SPEECH EXECUTION PUMP
  ═══════════════════════════════════════════════════════════════ */
  async function _pump() {
    if (active || !player) return;

    const now = Date.now();

    // Evict expired queue items
    while (queue.length && (now - queue[0].createdAt) > queue[0].maxAgeMs) {
      const expired = queue.shift();
      expired.resolve(false);
    }

    const item = queue.shift();
    if (!item) return;

    active = item;

    // Update alert repetition tracker
    const existing = _alertTrackers.get(item.key);
    if (existing) {
      existing.count++;
      existing.lastSpoken = now;
      existing.lastPriority = item.priority;
      existing.backoffIndex = Math.min(existing.backoffIndex + 1, BACKOFF_INTERVALS.length - 1);
    } else {
      _alertTrackers.set(item.key, {
        count: 1,
        firstSpoken: now,
        lastSpoken: now,
        lastPriority: item.priority,
        backoffIndex: 0
      });
    }

    if (item.priority >= URGENT_THRESHOLD) {
      lastUrgentTime = now;
    }

    let played = false;
    try {
      played = await player(item.text);
    } catch (err) {
      if (window.VisionGuideConfig?.debug) {
        console.warn('[VisionGuide guidance]', err);
      }
    }

    if (active === item) {
      active = null;
    }

    if (item.priority >= URGENT_THRESHOLD) {
      lastUrgentTime = Date.now();
    }

    item.resolve(Boolean(played));
    _pruneTrackers(Date.now());
    _pump();
  }

  /* ═══════════════════════════════════════════════════════════════
     QUEUE CONTROL & CANCELLATION
  ═══════════════════════════════════════════════════════════════ */
  function clear(options = {}) {
    const below = Number.isFinite(options.belowPriority) ? options.belowPriority : Infinity;
    const retained = [];

    queue.forEach(item => {
      if (item.priority < below) {
        item.resolve(false);
      } else {
        retained.push(item);
      }
    });

    queue = retained;

    if (options.cancelActive && active && active.priority < below) {
      cancelPlayer?.();
    }
  }

  function stop() {
    clear();
    cancelPlayer?.();
    active = null;
  }

  function reset() {
    stop();
    _alertTrackers.clear();
    _systemHealth.clear();
    lastUrgentTime = 0;
    sequence = 0;
  }

  /* ═══════════════════════════════════════════════════════════════
     SYSTEM HEALTH & VISIBILITY MONITORING
  ═══════════════════════════════════════════════════════════════ */
  /**
   * Notifies the guidance manager of sensor, camera, or model status.
   * Emits concise spoken alerts when visibility or operations are compromised.
   *
   * @param {Object} status
   *   @param {string} status.type    — 'camera' | 'depth' | 'surface' | 'visibility' | 'model'
   *   @param {string} status.level   — 'ok' | 'warning' | 'error'
   *   @param {string} [status.message]
   */
  function reportSystemStatus(status) {
    if (!status || !status.type) return;

    const now = Date.now();
    const type = status.type;
    const level = status.level || 'ok';
    const message = status.message || '';

    _systemHealth.set(type, { level, message, reportedAt: now });

    if (level === 'error') {
      const alertText = message || 'Live visual analysis is unavailable. Do not rely on camera guidance.';
      return announce(alertText, {
        priority: 95,
        key: `health:error:${type}`,
        interrupt: true,
        cooldownMs: 25000
      });
    } else if (type === 'visibility' && level === 'poor') {
      const alertText = message || 'Surface visibility is limited. Proceed with caution.';
      return announce(alertText, {
        priority: 85,
        key: 'health:visibility:poor',
        interrupt: true,
        cooldownMs: 20000
      });
    } else if (type === 'depth_stale') {
      const alertText = message || 'Depth estimation is delayed. Proceed with extra caution.';
      return announce(alertText, {
        priority: 85,
        key: 'health:depth:stale',
        cooldownMs: 25000
      });
    }
    return Promise.resolve(false);
  }

  function getSystemHealth() {
    const health = {};
    _systemHealth.forEach((val, key) => { health[key] = { ...val }; });
    return health;
  }

  /* ─── Cleanup Helpers ────────────────────────────────────────── */
  function _pruneTrackers(now) {
    const cutoff = now - 90000; // retain deduplication state for 90 seconds
    for (const [key, tr] of _alertTrackers.entries()) {
      if (tr.lastSpoken < cutoff) {
        _alertTrackers.delete(key);
      }
    }
  }

})();
