import { describe, it, expect } from 'vitest';
import { buildJsonEnvelope } from '../src/output/json.js';
import { formatHuman } from '../src/output/human.js';
import {
  buildCalibrateObject,
  formatCalibrateTable,
} from '../src/output/calibrate.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import type {
  AreaRow,
  SignalName,
  SignalValues,
  StruggleRecord,
  Warnings,
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

/** Build a StruggleRecord with defaults; overrides applied on top. */
function mkRecord(overrides: Partial<StruggleRecord> = {}): StruggleRecord {
  return {
    session_id: 's',
    repo: 'r',
    started_at: '2024-01-01T00:00:00Z',
    duration_ms: 0,
    score_pct: 0,
    mode: 'bootstrap',
    flagged: false,
    truncated: false,
    event_count: 0,
    areas: [],
    signals: zeroSignals(),
    ...overrides,
  };
}

const PROSE = 'please help me fix the broken auth login flow';

const SIGNAL_NAMES: SignalName[] = [
  'explore_ratio',
  'reread',
  'failure_streak',
  'corrections',
  'abandonment',
  'oscillation',
  'wall_clock_per_line',
];

const BOOTSTRAP_THRESHOLDS = DEFAULT_CONFIG.detector.bootstrap_thresholds;

describe('output formatters', () => {
  it('1. buildJsonEnvelope — JsonOutput shape, schema_version=1, integer warnings, no prose', () => {
    const warnings: Warnings = {
      malformed_lines: 3,
      oversized_lines: 1,
      skipped_sessions: 0,
      truncated_sessions: 2,
      symlinks_rejected: 0,
      unresolvable_cwd: 0,
    };
    const sessions: StruggleRecord[] = [
      mkRecord({
        session_id: 's1',
        repo: 'myrepo',
        score_pct: 92,
        mode: 'bootstrap',
        flagged: true,
        areas: [{ key: 'src/billing', weight: 1 }],
        signals: zeroSignals({ reread: 7 }),
      }),
      mkRecord({
        session_id: 's2',
        repo: 'myrepo',
        score_pct: 40,
        mode: 'bootstrap',
        flagged: false,
        areas: [],
        signals: zeroSignals(),
      }),
    ];
    const areas: AreaRow[] = [
      {
        key: 'src/billing',
        sessions_total: 1,
        sessions_flagged: 1,
        mean_score: 92,
        top_signals: [{ name: 'reread', value: 7, display: 'reread(7)' }],
      },
    ];

    const out = buildJsonEnvelope({
      repo: 'myrepo',
      mode: 'bootstrap',
      session_count: 2,
      warnings,
      sessions,
      areas,
    });

    expect(out.schema_version).toBe(1);
    expect(out.repo).toBe('myrepo');
    expect(out.mode).toBe('bootstrap');
    expect(out.session_count).toBe(2);
    expect(out.sessions).toBe(sessions);
    expect(out.areas).toBe(areas);
    // warnings are integer counts (pass-through, no floats introduced)
    expect(out.warnings).toEqual(warnings);
    for (const v of Object.values(out.warnings)) {
      expect(Number.isInteger(v)).toBe(true);
    }
    // no raw user prose anywhere in the envelope
    expect(JSON.stringify(out).includes(PROSE)).toBe(false);
  });

  it('2. formatHuman — header, column headers, one row per area, summary, warnings, no prose', () => {
    const areas: AreaRow[] = [
      {
        key: 'src/billing',
        sessions_total: 3,
        sessions_flagged: 2,
        mean_score: 85,
        top_signals: [
          { name: 'reread', value: 7, display: 'reread(7)' },
          { name: 'wall_clock_per_line', value: 540000, display: 'wall_clock_per_line(540s)' },
        ],
      },
      {
        key: 'src/auth',
        sessions_total: 2,
        sessions_flagged: 1,
        mean_score: 70,
        top_signals: [{ name: 'abandonment', value: true, display: 'abandonment(yes)' }],
      },
    ];
    const warnings: Warnings = {
      malformed_lines: 2,
      oversized_lines: 0,
      skipped_sessions: 0,
      truncated_sessions: 1,
      symlinks_rejected: 0,
      unresolvable_cwd: 0,
    };

    const out = formatHuman({
      repo: 'myrepo',
      mode: 'bootstrap',
      sessionCount: 5,
      areas,
      summary: { flagged: 3, unflagged: 2, unlocalized: 1 },
      warnings,
    });

    // header line
    expect(out).toContain('harnessgap scan — repo: myrepo · 5 sessions · mode: bootstrap');
    // column headers
    expect(out).toContain('AREA');
    expect(out).toContain('FLAGGED');
    expect(out).toContain('MEAN SCORE');
    expect(out).toContain('TOP SIGNALS');
    // one row per area (both area keys appear)
    expect(out).toContain('src/billing');
    expect(out).toContain('src/auth');
    // top signal displays appear
    expect(out).toContain('reread(7)');
    expect(out).toContain('abandonment(yes)');
    // summary line (bootstrap count = sessionCount when bootstrap)
    expect(out).toContain(
      '3 areas flagged · 2 unflagged · 1 unlocalized · bootstrap: 5 sessions',
    );
    // warnings line with integer counts
    expect(out).toContain('warnings:');
    expect(out).toContain('2 malformed lines');
    expect(out).toContain('1 truncated sessions');
    // no prose
    expect(out.includes(PROSE)).toBe(false);
  });

  it('3. formatHuman — zero areas prints a clear "no flagged areas" line, exit-friendly', () => {
    const out = formatHuman({
      repo: 'myrepo',
      mode: 'percentile',
      sessionCount: 0,
      areas: [],
      summary: { flagged: 0, unflagged: 0, unlocalized: 0 },
      warnings: {
        malformed_lines: 0,
        oversized_lines: 0,
        skipped_sessions: 0,
        truncated_sessions: 0,
        symlinks_rejected: 0,
        unresolvable_cwd: 0,
      },
    });

    const lines = out.split('\n');
    // header still present
    expect(lines[0]).toBe('harnessgap scan — repo: myrepo · 0 sessions · mode: percentile');
    // a clear no-flagged-areas line
    expect(out.toLowerCase()).toContain('no flagged areas');
    // summary line with bootstrap: 0 (percentile mode)
    expect(out).toContain(
      '0 areas flagged · 0 unflagged · 0 unlocalized · bootstrap: 0 sessions',
    );
    // no warnings line when all zero
    expect(out.includes('warnings:')).toBe(false);
  });

  it('4. buildCalibrateObject — 7 signal keys, each stat present; abandonment all 0/1; percentile math', () => {
    const signals: SignalValues[] = [
      zeroSignals({
        explore_ratio: 0.5,
        reread: 2,
        failure_streak: 1,
        corrections: 0,
        abandonment: false,
        oscillation: 1,
        wall_clock_per_line_ms: 10000,
      }),
      zeroSignals({
        explore_ratio: 1.5,
        reread: 4,
        failure_streak: 2,
        corrections: 1,
        abandonment: true,
        oscillation: 2,
        wall_clock_per_line_ms: 20000,
      }),
      zeroSignals({
        explore_ratio: 2.5,
        reread: 6,
        failure_streak: 3,
        corrections: 2,
        abandonment: true,
        oscillation: 3,
        wall_clock_per_line_ms: 30000,
      }),
      zeroSignals({
        explore_ratio: 3.5,
        reread: 8,
        failure_streak: 4,
        corrections: 3,
        abandonment: true,
        oscillation: 4,
        wall_clock_per_line_ms: 40000,
      }),
    ];

    const obj = buildCalibrateObject({
      mode: 'percentile',
      session_count: 4,
      flag_pct: 90,
      signals,
      bootstrap_thresholds: BOOTSTRAP_THRESHOLDS,
    });

    expect(obj.mode).toBe('percentile');
    expect(obj.session_count).toBe(4);
    expect(obj.flag_pct).toBe(90);

    const keys = Object.keys(obj.signals);
    expect(keys).toHaveLength(7);
    for (const name of SIGNAL_NAMES) {
      expect(keys).toContain(name);
      const s = obj.signals[name];
      expect(s).toHaveProperty('min');
      expect(s).toHaveProperty('p50');
      expect(s).toHaveProperty('p90');
      expect(s).toHaveProperty('max');
      expect(s).toHaveProperty('active_threshold');
    }

    // percentile math for reread [2,4,6,8], flag_pct=90 → active_threshold = p90
    const reread = obj.signals.reread;
    expect(reread.min).toBe(2);
    expect(reread.max).toBe(8);
    expect(reread.p50).toBe(5); // median of [2,4,6,8] = 5
    expect(reread.p90).toBeCloseTo(7.4, 2); // 6 + 0.7*(8-6) = 7.4
    expect(reread.active_threshold).toBeCloseTo(7.4, 2); // flag_pct=90 percentile

    // abandonment: all stats are 0 or 1
    const ab = obj.signals.abandonment;
    for (const v of [ab.min, ab.p50, ab.p90, ab.max, ab.active_threshold]) {
      expect(v === 0 || v === 1).toBe(true);
    }
    // [false,true,true,true] → min=0, max=1, p50=1 (majority true), p90=1
    expect(ab.min).toBe(0);
    expect(ab.max).toBe(1);
    expect(ab.p50).toBe(1);
    expect(ab.p90).toBe(1);
    expect(ab.active_threshold).toBe(1); // bootstrap_thresholds.abandonment=true → 1
  });

  it('5. formatCalibrateTable — aggregate numbers + signal names only; no per-session, commands, or prose', () => {
    const signals: SignalValues[] = [
      zeroSignals({ reread: 2, abandonment: false }),
      zeroSignals({ reread: 4, abandonment: true }),
      zeroSignals({ reread: 6, abandonment: true }),
      zeroSignals({ reread: 8, abandonment: true }),
    ];

    const obj = buildCalibrateObject({
      mode: 'percentile',
      session_count: 4,
      flag_pct: 90,
      signals,
      bootstrap_thresholds: BOOTSTRAP_THRESHOLDS,
    });
    const table = formatCalibrateTable(obj);

    // all 7 signal names appear
    for (const name of SIGNAL_NAMES) {
      expect(table).toContain(name);
    }
    // aggregate numbers appear (reread min/max)
    expect(table).toContain('2');
    expect(table).toContain('8');
    // no prose, no commands, no per-session examples
    expect(table.includes(PROSE)).toBe(false);
    expect(table.toLowerCase()).not.toContain('session_id');
    expect(table.toLowerCase()).not.toContain('npm');
    expect(table.toLowerCase()).not.toContain('claude');
    // each line is a single table row (no multi-line per-session dumps)
    const rows = table.split('\n');
    expect(rows.length).toBeGreaterThanOrEqual(8); // 1 header + 7 signal rows
  });

  it('6. warnings line omits zero-count categories, keeps non-zero', () => {
    const warnings: Warnings = {
      malformed_lines: 3,
      oversized_lines: 0,
      skipped_sessions: 0,
      truncated_sessions: 2,
      symlinks_rejected: 0,
      unresolvable_cwd: 0,
    };
    const out = formatHuman({
      repo: 'r',
      mode: 'bootstrap',
      sessionCount: 4,
      areas: [
        {
          key: 'src/x',
          sessions_total: 1,
          sessions_flagged: 1,
          mean_score: 90,
          top_signals: [{ name: 'reread', value: 3, display: 'reread(3)' }],
        },
      ],
      summary: { flagged: 1, unflagged: 0, unlocalized: 0 },
      warnings,
    });

    // non-zero categories appear
    expect(out).toContain('3 malformed lines');
    expect(out).toContain('2 truncated sessions');
    // zero-count categories are omitted
    expect(out).not.toContain('oversized');
    expect(out).not.toContain('skipped');
    expect(out).not.toContain('symlink');
    expect(out).not.toContain('unresolvable');
  });
});
