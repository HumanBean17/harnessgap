// Task 5: per-unit signal profile + evidence aggregation. Validates the pure
// `buildProfiles` projection — flagged records grouped by area, per-signal
// medians (nullable-over-non-null, abandonment strict-majority), elevated-flag
// yardstick vs cfg.detector.bootstrap_thresholds, and element-wise evidence
// sums. Output sorted by `key` ascending (deterministic).

import { describe, it, expect } from 'vitest';
import { buildProfiles } from '../src/diagnoser/profile.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import type {
  Config,
  SessionEvidence,
  SignalValues,
  StruggleRecord,
} from '../src/types.js';

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

/** Build a flagged StruggleRecord with defaults; overrides applied on top. */
function mkRecord(overrides: Partial<StruggleRecord> = {}): StruggleRecord {
  return {
    session_id: 's',
    repo: 'r',
    started_at: '2024-01-01T00:00:00Z',
    duration_ms: 0,
    score_pct: 0,
    mode: 'bootstrap',
    flagged: true,
    truncated: false,
    event_count: 0,
    areas: [],
    signals: zeroSignals(),
    ...overrides,
  };
}

const CFG: Config = DEFAULT_CONFIG;

describe('buildProfiles', () => {
  it('(a) reread median [5,7] -> 6 elevated true; reread [2] alone -> 2 elevated false', () => {
    const records = [
      mkRecord({
        session_id: 's1',
        areas: [{ key: 'src/billing', weight: 1 }],
        signals: zeroSignals({ reread: 5 }),
      }),
      mkRecord({
        session_id: 's2',
        areas: [{ key: 'src/billing', weight: 1 }],
        signals: zeroSignals({ reread: 7 }),
      }),
    ];
    const profiles = buildProfiles(records, CFG);
    expect(profiles).toHaveLength(1);
    const p = profiles[0];
    expect(p.key).toBe('src/billing');
    expect(p.flaggedCount).toBe(2);
    expect(p.medians.reread).toBe(6);
    expect(p.elevated.reread).toBe(true);

    // Single-record case with reread 2 (< 5 threshold) -> not elevated.
    const lone = buildProfiles(
      [
        mkRecord({
          areas: [{ key: 'src/billing', weight: 1 }],
          signals: zeroSignals({ reread: 2 }),
        }),
      ],
      CFG,
    );
    expect(lone[0].medians.reread).toBe(2);
    expect(lone[0].elevated.reread).toBe(false);
  });

  it('(b) nullable explore_ratio: [null,12,null] -> 12 elevated true; [null,null] -> null elevated false', () => {
    const mixed = [
      mkRecord({
        session_id: 'a',
        areas: [{ key: 'src/x', weight: 1 }],
        signals: zeroSignals({ explore_ratio: null }),
      }),
      mkRecord({
        session_id: 'b',
        areas: [{ key: 'src/x', weight: 1 }],
        signals: zeroSignals({ explore_ratio: 12 }),
      }),
      mkRecord({
        session_id: 'c',
        areas: [{ key: 'src/x', weight: 1 }],
        signals: zeroSignals({ explore_ratio: null }),
      }),
    ];
    const p1 = buildProfiles(mixed, CFG)[0];
    expect(p1.medians.explore_ratio).toBe(12);
    expect(p1.elevated.explore_ratio).toBe(true);

    const allNull = [
      mkRecord({
        session_id: 'a',
        areas: [{ key: 'src/x', weight: 1 }],
        signals: zeroSignals({ explore_ratio: null }),
      }),
      mkRecord({
        session_id: 'b',
        areas: [{ key: 'src/x', weight: 1 }],
        signals: zeroSignals({ explore_ratio: null }),
      }),
    ];
    const p2 = buildProfiles(allNull, CFG)[0];
    expect(p2.medians.explore_ratio).toBe(null);
    expect(p2.elevated.explore_ratio).toBe(false);
  });

  it('(b2) nullable explore_ratio below threshold is non-elevated even when non-null', () => {
    // explore_ratio 5 (< 10 threshold) -> median 5, not elevated.
    const records = [
      mkRecord({
        areas: [{ key: 'src/x', weight: 1 }],
        signals: zeroSignals({ explore_ratio: 5 }),
      }),
    ];
    const p = buildProfiles(records, CFG)[0];
    expect(p.medians.explore_ratio).toBe(5);
    expect(p.elevated.explore_ratio).toBe(false);
  });

  it('(c) abandonment strict-majority: [T,T,F] -> true elevated; [T,F,F] -> false not elevated', () => {
    const majority = [
      mkRecord({
        session_id: 'a',
        areas: [{ key: 'src/x', weight: 1 }],
        signals: zeroSignals({ abandonment: true }),
      }),
      mkRecord({
        session_id: 'b',
        areas: [{ key: 'src/x', weight: 1 }],
        signals: zeroSignals({ abandonment: true }),
      }),
      mkRecord({
        session_id: 'c',
        areas: [{ key: 'src/x', weight: 1 }],
        signals: zeroSignals({ abandonment: false }),
      }),
    ];
    const p1 = buildProfiles(majority, CFG)[0];
    expect(p1.medians.abandonment).toBe(true);
    expect(p1.elevated.abandonment).toBe(true);

    const minority = [
      mkRecord({
        session_id: 'a',
        areas: [{ key: 'src/x', weight: 1 }],
        signals: zeroSignals({ abandonment: true }),
      }),
      mkRecord({
        session_id: 'b',
        areas: [{ key: 'src/x', weight: 1 }],
        signals: zeroSignals({ abandonment: false }),
      }),
      mkRecord({
        session_id: 'c',
        areas: [{ key: 'src/x', weight: 1 }],
        signals: zeroSignals({ abandonment: false }),
      }),
    ];
    const p2 = buildProfiles(minority, CFG)[0];
    expect(p2.medians.abandonment).toBe(false);
    expect(p2.elevated.abandonment).toBe(false);
  });

  it('(c2) abandonment 50/50 split is NOT a majority -> false', () => {
    const tie = [
      mkRecord({
        areas: [{ key: 'src/x', weight: 1 }],
        signals: zeroSignals({ abandonment: true }),
      }),
      mkRecord({
        areas: [{ key: 'src/x', weight: 1 }],
        signals: zeroSignals({ abandonment: false }),
      }),
    ];
    const p = buildProfiles(tie, CFG)[0];
    expect(p.medians.abandonment).toBe(false);
    expect(p.elevated.abandonment).toBe(false);
  });

  it('(d) evidence element-wise sum: failures.config 2 + 3 -> 5', () => {
    const ev = (config: number): SessionEvidence => ({
      failures: { config, test: 0, build: 0, other: 0 },
      edit_kinds: { test: 0, code: 0, other: 0 },
    });
    const records = [
      mkRecord({
        session_id: 's1',
        areas: [{ key: 'src/api', weight: 1 }],
        evidence: ev(2),
      }),
      mkRecord({
        session_id: 's2',
        areas: [{ key: 'src/api', weight: 1 }],
        evidence: ev(3),
      }),
    ];
    const p = buildProfiles(records, CFG)[0];
    expect(p.evidence.failures.config).toBe(5);
    // Untouched buckets stay at zero.
    expect(p.evidence.failures.test).toBe(0);
    expect(p.evidence.failures.build).toBe(0);
    expect(p.evidence.failures.other).toBe(0);
    expect(p.evidence.edit_kinds.code).toBe(0);
  });

  it('(d2) record with missing evidence contributes zero buckets', () => {
    const ev = (config: number): SessionEvidence => ({
      failures: { config, test: 0, build: 0, other: 0 },
      edit_kinds: { test: 0, code: 0, other: 0 },
    });
    const records = [
      mkRecord({
        session_id: 's1',
        areas: [{ key: 'src/api', weight: 1 }],
        evidence: ev(7),
      }),
      // No evidence field -> contributes zero to every bucket but still
      // counts toward flaggedCount and meanScore.
      mkRecord({
        session_id: 's2',
        areas: [{ key: 'src/api', weight: 1 }],
        score_pct: 50,
      }),
    ];
    const p = buildProfiles(records, CFG)[0];
    expect(p.evidence.failures.config).toBe(7);
    expect(p.flaggedCount).toBe(2);
    expect(p.meanScore).toBe(25); // (0 + 50) / 2 — first record keeps default 0
  });

  it('(d3) evidence sums across all 7 buckets simultaneously', () => {
    const ev1: SessionEvidence = {
      failures: { config: 1, test: 2, build: 3, other: 4 },
      edit_kinds: { test: 5, code: 6, other: 7 },
    };
    const ev2: SessionEvidence = {
      failures: { config: 10, test: 20, build: 30, other: 40 },
      edit_kinds: { test: 50, code: 60, other: 70 },
    };
    const records = [
      mkRecord({ session_id: 's1', areas: [{ key: 'src/api', weight: 1 }], evidence: ev1 }),
      mkRecord({ session_id: 's2', areas: [{ key: 'src/api', weight: 1 }], evidence: ev2 }),
    ];
    const p = buildProfiles(records, CFG)[0];
    expect(p.evidence).toEqual({
      failures: { config: 11, test: 22, build: 33, other: 44 },
      edit_kinds: { test: 55, code: 66, other: 77 },
    });
  });

  it('(e) a record touching two areas appears in both profiles', () => {
    const records = [
      mkRecord({
        session_id: 's1',
        areas: [
          { key: 'src/a', weight: 1 },
          { key: 'src/b', weight: 1 },
        ],
        signals: zeroSignals({ reread: 5 }),
      }),
    ];
    const profiles = buildProfiles(records, CFG);
    expect(profiles.map((p) => p.key)).toEqual(['src/a', 'src/b']);
    for (const p of profiles) {
      expect(p.flaggedCount).toBe(1);
      expect(p.medians.reread).toBe(5);
      expect(p.elevated.reread).toBe(true);
    }
  });

  it('(f) output sorted by key ascending', () => {
    const records = [
      mkRecord({ session_id: 's1', areas: [{ key: 'src/zeta', weight: 1 }] }),
      mkRecord({ session_id: 's2', areas: [{ key: 'src/alpha', weight: 1 }] }),
      mkRecord({ session_id: 's3', areas: [{ key: 'src/mike', weight: 1 }] }),
    ];
    const profiles = buildProfiles(records, CFG);
    expect(profiles.map((p) => p.key)).toEqual([
      'src/alpha',
      'src/mike',
      'src/zeta',
    ]);
  });

  it('only flagged records are profiled (unflagged ignored)', () => {
    const records = [
      mkRecord({
        session_id: 's1',
        flagged: true,
        score_pct: 80,
        areas: [{ key: 'src/a', weight: 1 }],
      }),
      mkRecord({
        session_id: 's2',
        flagged: false,
        score_pct: 50,
        areas: [{ key: 'src/a', weight: 1 }],
      }),
      mkRecord({
        session_id: 's3',
        flagged: false,
        areas: [{ key: 'src/b', weight: 1 }],
      }),
    ];
    const profiles = buildProfiles(records, CFG);
    // src/b has no flagged records -> not profiled.
    expect(profiles.map((p) => p.key)).toEqual(['src/a']);
    expect(profiles[0].flaggedCount).toBe(1);
    expect(profiles[0].meanScore).toBe(80);
  });

  it('meanScore is the mean of flagged records touching the area', () => {
    const records = [
      mkRecord({
        session_id: 's1',
        score_pct: 90,
        areas: [{ key: 'src/a', weight: 1 }],
      }),
      mkRecord({
        session_id: 's2',
        score_pct: 70,
        areas: [{ key: 'src/a', weight: 1 }],
      }),
    ];
    const profiles = buildProfiles(records, CFG);
    expect(profiles[0].meanScore).toBe(80);
  });

  it('medians/elevated carry all 7 signals', () => {
    const records = [mkRecord({ areas: [{ key: 'src/a', weight: 1 }] })];
    const { medians, elevated } = buildProfiles(records, CFG)[0];
    expect(Object.keys(medians).sort()).toEqual(
      [
        'abandonment',
        'corrections',
        'explore_ratio',
        'failure_streak',
        'oscillation',
        'reread',
        'wall_clock_per_line',
      ],
    );
    expect(Object.keys(elevated).sort()).toEqual(
      [
        'abandonment',
        'corrections',
        'explore_ratio',
        'failure_streak',
        'oscillation',
        'reread',
        'wall_clock_per_line',
      ],
    );
  });

  it('wall_clock_per_line_ms: [null, 600000] -> median 600000 elevated true (>=300000)', () => {
    const records = [
      mkRecord({
        session_id: 's1',
        areas: [{ key: 'src/a', weight: 1 }],
        signals: zeroSignals({ wall_clock_per_line_ms: null }),
      }),
      mkRecord({
        session_id: 's2',
        areas: [{ key: 'src/a', weight: 1 }],
        signals: zeroSignals({ wall_clock_per_line_ms: 600000 }),
      }),
    ];
    const p = buildProfiles(records, CFG)[0];
    expect(p.medians.wall_clock_per_line).toBe(600000);
    expect(p.elevated.wall_clock_per_line).toBe(true);
  });

  it('pure: does not mutate input records or their evidence objects', () => {
    const ev: SessionEvidence = {
      failures: { config: 2, test: 0, build: 0, other: 0 },
      edit_kinds: { test: 0, code: 0, other: 0 },
    };
    const evSnapshot = JSON.parse(JSON.stringify(ev));
    const rec = mkRecord({
      session_id: 's1',
      areas: [{ key: 'src/a', weight: 1 }],
      evidence: ev,
    });
    const recSnapshot = JSON.parse(JSON.stringify(rec));
    buildProfiles([rec], CFG);
    expect(JSON.parse(JSON.stringify(rec))).toEqual(recSnapshot);
    expect(ev).toEqual(evSnapshot);
  });

  it('returns empty array when no records are flagged', () => {
    const records = [
      mkRecord({ flagged: false, areas: [{ key: 'src/a', weight: 1 }] }),
    ];
    expect(buildProfiles(records, CFG)).toEqual([]);
  });

  it('numeric elevation boundary: median exactly at threshold is elevated (>=)', () => {
    // reread threshold is 5; medians [5,5] -> 5 should be elevated.
    const records = [
      mkRecord({
        areas: [{ key: 'src/a', weight: 1 }],
        signals: zeroSignals({ reread: 5 }),
      }),
      mkRecord({
        areas: [{ key: 'src/a', weight: 1 }],
        signals: zeroSignals({ reread: 5 }),
      }),
    ];
    const p = buildProfiles(records, CFG)[0];
    expect(p.medians.reread).toBe(5);
    expect(p.elevated.reread).toBe(true);
  });
});
