import { describe, it, expect } from 'vitest';
import { scoreSessions } from '../src/detector/scoring.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import type { Config, SignalValues } from '../src/types.js';

/** A session with every signal null/zero/false; overrides applied on top. */
function zeroSignals(overrides: Partial<SignalValues> = {}): SignalValues {
  return {
    explore_ratio: null,
    reread: 0,
    failure_streak: 0,
    corrections: 0,
    abandonment: false,
    oscillation: 0,
    wall_clock_per_line_ms: null,
    ...overrides,
  };
}

/** Build a config from defaults with selective `detector` overrides (deep-merging
 *  the nested `signal_weights` and `bootstrap_thresholds` objects). */
function cfgWith(detectorOverrides: Partial<Config['detector']> = {}): Config {
  const detector = { ...DEFAULT_CONFIG.detector, ...detectorOverrides };
  if (detectorOverrides.signal_weights) {
    detector.signal_weights = {
      ...DEFAULT_CONFIG.detector.signal_weights,
      ...detectorOverrides.signal_weights,
    };
  }
  if (detectorOverrides.bootstrap_thresholds) {
    detector.bootstrap_thresholds = {
      ...DEFAULT_CONFIG.detector.bootstrap_thresholds,
      ...detectorOverrides.bootstrap_thresholds,
    };
  }
  return { ...DEFAULT_CONFIG, detector };
}

describe('scoreSessions', () => {
  it('1. percentile rank: top session gets score_pct 100 and is flagged', () => {
    // 5 sessions with distinct reread values; lower the floor so percentile
    // mode engages. Only reread varies, so composite tracks reread rank.
    const c = cfgWith({ bootstrap_session_floor: 1 });
    const signals = [0, 1, 2, 3, 10].map((r) => zeroSignals({ reread: r }));
    const results = scoreSessions({ signals, cfg: c, forceBootstrap: false });

    expect(results[4].mode).toBe('percentile');
    expect(results[4].score_pct).toBe(100);
    expect(results[4].flagged).toBe(true);
    // composite is monotonic in reread
    for (let i = 0; i < 4; i++) {
      expect(results[i].composite).toBeLessThan(results[i + 1].composite);
    }
  });

  it('2. null signals are excluded and remaining weights renormalized', () => {
    // All weights = 1. Target session has reread=10 (rank 100) with
    // explore_ratio and wall_clock null. The 5 present signals (reread,
    // failure_streak, corrections, abandonment, oscillation) each carry weight
    // 1/5 = 0.2, so composite = 100 * 0.2 = 20. If the two nulls were wrongly
    // included, the weight would be 1/7 and composite ≈ 14.28.
    const c = cfgWith({
      signal_weights: {
        explore_ratio: 1,
        reread: 1,
        failure_streak: 1,
        corrections: 1,
        abandonment: 1,
        oscillation: 1,
        wall_clock_per_line: 1,
      },
    });
    const sessions: SignalValues[] = Array.from({ length: 30 }, () => zeroSignals());
    sessions[0] = zeroSignals({ reread: 10 });
    const results = scoreSessions({ signals: sessions, cfg: c, forceBootstrap: false });

    expect(results[0].mode).toBe('percentile');
    expect(results[0].composite).toBeCloseTo(20, 10);
  });

  it('3. all-null/zero session has composite 0 and is not flagged', () => {
    const sessions: SignalValues[] = Array.from({ length: 30 }, () => zeroSignals());
    const results = scoreSessions({ signals: sessions, cfg: DEFAULT_CONFIG, forceBootstrap: false });

    expect(results[0].composite).toBe(0);
    expect(results[0].score_pct).toBe(0);
    expect(results[0].flagged).toBe(false);
  });

  it('4. bootstrap auto: fewer than K=30 sessions → mode bootstrap', () => {
    const sessions: SignalValues[] = Array.from({ length: 5 }, () => zeroSignals());
    const results = scoreSessions({ signals: sessions, cfg: DEFAULT_CONFIG, forceBootstrap: false });

    expect(results).toHaveLength(5);
    for (const r of results) expect(r.mode).toBe('bootstrap');
  });

  it('5. bootstrap force: forceBootstrap true → mode bootstrap even with 100 sessions', () => {
    const sessions: SignalValues[] = Array.from({ length: 100 }, () => zeroSignals());
    const results = scoreSessions({ signals: sessions, cfg: DEFAULT_CONFIG, forceBootstrap: true });

    expect(results).toHaveLength(100);
    for (const r of results) expect(r.mode).toBe('bootstrap');
  });

  it('6. bootstrap: ≥2 tripped signals flags even when composite < 70', () => {
    // reread=5 (≥5) and failure_streak=3 (≥3) both trip; nothing else does.
    const session = zeroSignals({ reread: 5, failure_streak: 3 });
    const results = scoreSessions({ signals: [session], cfg: DEFAULT_CONFIG, forceBootstrap: true });

    expect(results[0].mode).toBe('bootstrap');
    expect(results[0].flagged).toBe(true);
    expect(results[0].composite).toBeLessThan(70);
    expect(results[0].score_pct).toBe(results[0].composite);
  });

  it('7. bootstrap: composite ≥ 70 via one high-weight signal flags', () => {
    // oscillation weight 10 vs others 1/0.5 → renormalized to 10/13.5 ≈ 0.74.
    // Only oscillation trips (value 2 ≥ 2): composite = 100 * 10/13.5 ≈ 74.07.
    const c = cfgWith({
      signal_weights: {
        explore_ratio: 1,
        reread: 1,
        failure_streak: 1,
        corrections: 1,
        abandonment: 0.5,
        oscillation: 10,
        wall_clock_per_line: 1,
      },
    });
    const session = zeroSignals({ oscillation: 2 });
    const results = scoreSessions({ signals: [session], cfg: c, forceBootstrap: true });

    expect(results[0].composite).toBeCloseTo((100 * 10) / 13.5, 10);
    expect(results[0].composite).toBeGreaterThanOrEqual(70);
    expect(results[0].flagged).toBe(true);
  });

  it('8. mode precedence: thresholds_as absolute → bootstrap even with 100 sessions', () => {
    const c = cfgWith({ thresholds_as: 'absolute' });
    const sessions: SignalValues[] = Array.from({ length: 100 }, () => zeroSignals());
    const results = scoreSessions({ signals: sessions, cfg: c, forceBootstrap: false });

    for (const r of results) expect(r.mode).toBe('bootstrap');
  });

  it('9. abandonment=true contributes 100×weight in percentile mode', () => {
    // 30 sessions; one has abandonment=true, everything else null/zero.
    // abandonment weight 0.5; non-null weight sum = 1+1+1+0.5+1.2 = 4.7.
    // contribution = 100 * (0.5 / 4.7).
    const sessions: SignalValues[] = Array.from({ length: 30 }, () => zeroSignals());
    sessions[0] = zeroSignals({ abandonment: true });
    const results = scoreSessions({ signals: sessions, cfg: DEFAULT_CONFIG, forceBootstrap: false });

    expect(results[0].mode).toBe('percentile');
    expect(results[0].composite).toBeCloseTo((100 * 0.5) / 4.7, 10);
    expect(results[0].score_pct).toBe(100);
    expect(results[0].flagged).toBe(true);
  });

  it('10. percentile of composite: top session gets score_pct 100, flagged at 90', () => {
    // 30 sessions with reread 0..29 → 30 strictly increasing composites. The
    // largest composite (reread=29) ranks 100 across the set.
    const sessions: SignalValues[] = Array.from({ length: 30 }, (_, i) =>
      zeroSignals({ reread: i }),
    );
    const results = scoreSessions({ signals: sessions, cfg: DEFAULT_CONFIG, forceBootstrap: false });

    expect(results[29].mode).toBe('percentile');
    expect(results[29].score_pct).toBe(100);
    expect(results[29].flagged).toBe(true);
  });
});
