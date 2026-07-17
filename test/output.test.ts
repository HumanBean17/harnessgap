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
  BaselineAssessment,
  Diagnosis,
  RepoFinding,
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

/** A populated orientation block; overrides applied on top. */
function mkOrientation(overrides: Partial<NonNullable<BaselineAssessment['orientation']>> = {}) {
  return {
    median_dir_breadth: 2,
    median_file_depth: 5,
    breadth_floor: 4,
    file_depth_floor: 12,
    with_edit_sessions: 18,
    ...overrides,
  };
}

/** Build a BaselineAssessment with defaults; overrides applied on top. */
function mkBaseline(overrides: Partial<BaselineAssessment> = {}): BaselineAssessment {
  return {
    state: 'within-norms',
    sessions_sampled: 20,
    scoring_mode: 'percentile',
    orientation: mkOrientation(),
    zero_edit_fraction: 0.1,
    acute: { struggle_rate: 0.1, struggle_rate_threshold: 0.3 },
    ...overrides,
  };
}

/** Build a RepoFinding with defaults; overrides applied on top. */
function mkFinding(overrides: Partial<RepoFinding> = {}): RepoFinding {
  return {
    kind: 'elevated-baseline',
    severity: 'high',
    paths: ['orientation'],
    sessions_sampled: 20,
    scoring_mode: 'percentile',
    orientation: mkOrientation(),
    zero_edit_fraction: 0.1,
    acute: { struggle_rate: 0.1, struggle_rate_threshold: 0.3 },
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
      repo_findings: [],
    });

    expect(out.schema_version).toBe(1);
    expect(out.repo).toBe('myrepo');
    expect(out.mode).toBe('bootstrap');
    expect(out.session_count).toBe(2);
    expect(out.sessions).toBe(sessions);
    expect(out.areas).toBe(areas);
    expect(out.repo_findings).toEqual([]);
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
      baseline: mkBaseline(),
      finding: null,
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
      baseline: mkBaseline({ state: 'too-few-sessions', sessions_sampled: 0 }),
      finding: null,
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
      baseline: mkBaseline(),
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
      baseline: mkBaseline(),
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
      baseline: mkBaseline(),
      finding: null,
    });

    // non-zero categories appear
    expect(out).toContain('3 malformed lines');
    expect(out).toContain('2 truncated sessions');
    // zero-count categories are omitted
    expect(out).not.toContain('oversized');
    expect(out).not.toContain('symlink');
    expect(out).not.toContain('skipped');
    expect(out).not.toContain('unresolvable');
  });

  it('7. buildJsonEnvelope — repo_findings: [] is projected verbatim onto the envelope', () => {
    const warnings: Warnings = {
      malformed_lines: 0,
      oversized_lines: 0,
      skipped_sessions: 0,
      truncated_sessions: 0,
      symlinks_rejected: 0,
      unresolvable_cwd: 0,
    };
    const sessions: StruggleRecord[] = [mkRecord()];
    const areas: AreaRow[] = [];

    const out = buildJsonEnvelope({
      repo: 'r',
      mode: 'bootstrap',
      session_count: 1,
      warnings,
      sessions,
      areas,
      repo_findings: [],
    });

    expect(out.repo_findings).toEqual([]);
  });

  it('8. buildJsonEnvelope — repo_findings: [<finding>] projected with schema_version=1 and other fields unchanged', () => {
    const warnings: Warnings = {
      malformed_lines: 1,
      oversized_lines: 0,
      skipped_sessions: 0,
      truncated_sessions: 0,
      symlinks_rejected: 0,
      unresolvable_cwd: 0,
    };
    const sessions: StruggleRecord[] = [
      mkRecord({ session_id: 's1', score_pct: 50 }),
    ];
    const areas: AreaRow[] = [
      {
        key: 'src/x',
        sessions_total: 1,
        sessions_flagged: 1,
        mean_score: 50,
        top_signals: [{ name: 'reread', value: 3, display: 'reread(3)' }],
      },
    ];
    const finding: RepoFinding = {
      kind: 'elevated-baseline',
      severity: 'high',
      paths: ['orientation'],
      sessions_sampled: 20,
      scoring_mode: 'percentile',
      orientation: {
        median_dir_breadth: 6,
        median_file_depth: 18,
        breadth_floor: 4,
        file_depth_floor: 12,
        with_edit_sessions: 20,
      },
      zero_edit_fraction: 0,
      acute: { struggle_rate: 0, struggle_rate_threshold: 0.3 },
    };

    const out = buildJsonEnvelope({
      repo: 'r',
      mode: 'percentile',
      session_count: 1,
      warnings,
      sessions,
      areas,
      repo_findings: [finding],
    });

    // schema_version pinned to 1
    expect(out.schema_version).toBe(1);
    // repo_findings carries the projected finding verbatim
    expect(out.repo_findings).toHaveLength(1);
    expect(out.repo_findings[0]).toEqual(finding);
    // other existing fields unchanged
    expect(out.sessions).toBe(sessions);
    expect(out.areas).toBe(areas);
    expect(out.warnings).toEqual(warnings);
    expect(out.repo).toBe('r');
    expect(out.mode).toBe('percentile');
    expect(out.session_count).toBe(1);
  });

  // --- Task 7: baseline line + elevated-baseline block ---

  it('9. formatHuman — elevated + orientation path emits BASELINE line and all three detail lines', () => {
    const out = formatHuman({
      repo: 'r',
      mode: 'percentile',
      sessionCount: 30,
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
      baseline: mkBaseline({ state: 'elevated', sessions_sampled: 30 }),
      finding: mkFinding({
        severity: 'high',
        paths: ['orientation'],
        orientation: mkOrientation({
          median_dir_breadth: 7,
          median_file_depth: 20,
          breadth_floor: 4,
          file_depth_floor: 12,
          with_edit_sessions: 27,
        }),
        zero_edit_fraction: 0.1,
        acute: { struggle_rate: 0.2, struggle_rate_threshold: 0.3 },
      }),
    });

    // The BASELINE elevated line with closed-enum severity.
    expect(out).toContain('BASELINE — elevated (orientation) · severity: high');
    // The orientation detail line (present because finding.orientation !== null).
    expect(out).toContain(
      '  orientation 7 dirs / 20 files (floors 4 / 12) · over 27 with-edit sessions',
    );
    // The zero-edit / acute detail line.
    expect(out).toContain(
      '  zero-edit (Q&A) sessions: 10% · acute struggle rate: 20% (threshold 30%)',
    );
    // The fixed interpretation literal (em-dash included).
    expect(out).toContain(
      '  the typical session orients broadly before acting — worth investigating (cause undiagnosed)',
    );
  });

  it('10. formatHuman — elevated + acute-only path (orientation null) omits orientation detail line', () => {
    const out = formatHuman({
      repo: 'r',
      mode: 'percentile',
      sessionCount: 30,
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
      baseline: mkBaseline({
        state: 'elevated',
        sessions_sampled: 30,
        orientation: null,
      }),
      finding: mkFinding({
        severity: 'medium',
        paths: ['acute'],
        orientation: null,
        zero_edit_fraction: 0.5,
        acute: { struggle_rate: 0.6, struggle_rate_threshold: 0.3 },
      }),
    });

    // Acute-only BASELINE line names the acute path.
    expect(out).toContain('BASELINE — elevated (acute) · severity: medium');
    // The orientation detail line is ABSENT (finding.orientation === null).
    expect(out).not.toContain('dirs /');
    // The zero-edit / acute detail line still prints.
    expect(out).toContain(
      '  zero-edit (Q&A) sessions: 50% · acute struggle rate: 60% (threshold 30%)',
    );
    // Fixed interpretation literal still prints.
    expect(out).toContain('(cause undiagnosed)');
  });

  it('11. formatHuman — within-norms emits the within-norms BASELINE line with orientation numbers', () => {
    const out = formatHuman({
      repo: 'r',
      mode: 'percentile',
      sessionCount: 20,
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
      baseline: mkBaseline({
        state: 'within-norms',
        orientation: mkOrientation({ median_dir_breadth: 3, median_file_depth: 8 }),
        zero_edit_fraction: 0.25,
        acute: { struggle_rate: 0.1, struggle_rate_threshold: 0.3 },
      }),
      finding: null,
    });

    expect(out).toContain(
      'BASELINE — within norms · orientation 3 dirs / 8 files · zero-edit 25% · acute 10%',
    );
    // No detail block in within-norms state.
    expect(out).not.toContain('(cause undiagnosed)');
  });

  it('12. formatHuman — too-few-sessions emits the too-few BASELINE line with sessions_sampled', () => {
    const out = formatHuman({
      repo: 'r',
      mode: 'bootstrap',
      sessionCount: 5,
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
      baseline: mkBaseline({ state: 'too-few-sessions', sessions_sampled: 5 }),
      finding: null,
    });

    expect(out).toContain('BASELINE — too few sessions (5) to assess');
  });

  it('13. formatHuman — orientation-undefined emits the within-norms / exploration-only line', () => {
    const out = formatHuman({
      repo: 'r',
      mode: 'percentile',
      sessionCount: 12,
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
      baseline: mkBaseline({
        state: 'orientation-undefined',
        orientation: null,
        zero_edit_fraction: 1,
        acute: { struggle_rate: 0.08, struggle_rate_threshold: 0.3 },
      }),
      finding: null,
    });

    expect(out).toContain(
      'BASELINE — within norms · all sessions exploration-only; orientation metric undefined · acute 8%',
    );
  });

  it('14. formatHuman — baseline line never leaks area keys / session content (fixed literals only)', () => {
    // Place a distinctive sentinel as an area key. It legitimately appears in
    // the area table, but it must NOT leak into the fixed baseline line/block.
    const SENTINEL = 'src/SECRET_session_content_xyz';
    const out = formatHuman({
      repo: 'r',
      mode: 'percentile',
      sessionCount: 30,
      areas: [
        {
          key: SENTINEL,
          sessions_total: 1,
          sessions_flagged: 1,
          mean_score: 90,
          top_signals: [{ name: 'reread', value: 3, display: 'reread(3)' }],
        },
      ],
      summary: { flagged: 1, unflagged: 0, unlocalized: 0 },
      warnings: {
        malformed_lines: 0,
        oversized_lines: 0,
        skipped_sessions: 0,
        truncated_sessions: 0,
        symlinks_rejected: 0,
        unresolvable_cwd: 0,
      },
      baseline: mkBaseline({ state: 'elevated', sessions_sampled: 30 }),
      finding: mkFinding({ paths: ['orientation'] }),
    });

    // The sentinel DOES appear in the area table.
    expect(out).toContain(SENTINEL);
    // But every BASELINE / detail line must be free of the sentinel.
    const lines = out.split('\n');
    for (const line of lines) {
      if (
        line.startsWith('BASELINE —') ||
        line.startsWith('  orientation ') ||
        line.startsWith('  zero-edit ') ||
        line.startsWith('  the typical session ')
      ) {
        expect(line).not.toContain(SENTINEL);
      }
    }
    // Blank line separates baseline block from the area table.
    const baselineEnd = lines.indexOf(
      '  the typical session orients broadly before acting — worth investigating (cause undiagnosed)',
    );
    expect(baselineEnd).toBeGreaterThan(-1);
    expect(lines[baselineEnd + 1]).toBe('');
  });

  it('15. formatHuman — within-norms with null orientation prints "orientation n/a"', () => {
    // Edge: within-norms but orientation block is null (defensive — assessAmbient
    // would normally emit orientation-undefined here, but the formatter must not
    // crash or print "undefined" if handed this combination).
    const out = formatHuman({
      repo: 'r',
      mode: 'percentile',
      sessionCount: 20,
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
      baseline: mkBaseline({
        state: 'within-norms',
        orientation: null,
        zero_edit_fraction: 0,
        acute: { struggle_rate: 0, struggle_rate_threshold: 0.3 },
      }),
      finding: null,
    });

    expect(out).toContain(
      'BASELINE — within norms · orientation n/a · zero-edit 0% · acute 0%',
    );
  });

  // --- Task 8: baseline assessment in --calibrate ---

  it('16. buildCalibrateObject — baseline is projected verbatim onto the returned object', () => {
    const baseline: BaselineAssessment = {
      state: 'within-norms',
      sessions_sampled: 20,
      scoring_mode: 'percentile',
      orientation: {
        median_dir_breadth: 2,
        median_file_depth: 6,
        breadth_floor: 4,
        file_depth_floor: 12,
        with_edit_sessions: 18,
      },
      zero_edit_fraction: 0.1,
      acute: { struggle_rate: 0.05, struggle_rate_threshold: 0.3 },
    };

    const obj = buildCalibrateObject({
      mode: 'percentile',
      session_count: 20,
      flag_pct: 90,
      signals: [],
      bootstrap_thresholds: BOOTSTRAP_THRESHOLDS,
      baseline,
    });

    expect(obj.baseline).toEqual(baseline);
  });

  it('17. formatCalibrateTable — emits BASELINE line with state, orientation fragment, zero-edit pct, acute rate and threshold pct (whole percent)', () => {
    const baseline = mkBaseline({
      state: 'within-norms',
      orientation: mkOrientation({ median_dir_breadth: 2, median_file_depth: 6 }),
      zero_edit_fraction: 0.1,
      acute: { struggle_rate: 0.05, struggle_rate_threshold: 0.3 },
    });

    const obj = buildCalibrateObject({
      mode: 'percentile',
      session_count: 20,
      flag_pct: 90,
      signals: [],
      bootstrap_thresholds: BOOTSTRAP_THRESHOLDS,
      baseline,
    });
    const table = formatCalibrateTable(obj);

    // state enum appears
    expect(table).toContain('BASELINE — within-norms');
    // orientation medians fragment
    expect(table).toContain('orientation 2 dirs / 6 files');
    // whole-percent zero-edit and acute rate
    expect(table).toContain('zero-edit 10%');
    expect(table).toContain('acute struggle rate 5%');
    // acute threshold whole-percent
    expect(table).toContain('(threshold 30%)');
  });

  it('18. formatCalibrateTable — BASELINE line shows "orientation n/a" when baseline.orientation is null', () => {
    const baseline = mkBaseline({
      state: 'within-norms',
      orientation: null,
      zero_edit_fraction: 0.1,
      acute: { struggle_rate: 0.05, struggle_rate_threshold: 0.3 },
    });

    const obj = buildCalibrateObject({
      mode: 'percentile',
      session_count: 20,
      flag_pct: 90,
      signals: [],
      bootstrap_thresholds: BOOTSTRAP_THRESHOLDS,
      baseline,
    });
    const table = formatCalibrateTable(obj);

    expect(table).toContain('BASELINE — within-norms');
    expect(table).toContain('orientation n/a');
    // The medians fragment must not appear when orientation is null.
    expect(table).not.toContain('dirs /');
    // Acute numbers still render.
    expect(table).toContain('zero-edit 10%');
    expect(table).toContain('(threshold 30%)');
  });

  // --- Task 11: cause column (human) + diagnoses field (JSON) — opt-in ---

  /** Build a Diagnosis with defaults; overrides applied on top. */
  function mkDiagnosis(overrides: Partial<Diagnosis> = {}): Diagnosis {
    return {
      unit: { kind: 'area', key: 'src/billing' },
      cause: 'doc',
      confidence: 0.78,
      rationale: 'doc path absent + reread signal',
      evidence_refs: [{ kind: 'doc_absent', checked: ['docs/billing.md'] }],
      ...overrides,
    };
  }

  it('19. formatHuman — diagnoses present renders a CAUSE column with cause(confidence) per flagged row', () => {
    const areas: AreaRow[] = [
      {
        key: 'src/billing',
        sessions_total: 3,
        sessions_flagged: 2,
        mean_score: 85,
        top_signals: [{ name: 'reread', value: 7, display: 'reread(7)' }],
      },
    ];
    const out = formatHuman({
      repo: 'r',
      mode: 'bootstrap',
      sessionCount: 5,
      areas,
      summary: { flagged: 1, unflagged: 0, unlocalized: 0 },
      warnings: {
        malformed_lines: 0,
        oversized_lines: 0,
        skipped_sessions: 0,
        truncated_sessions: 0,
        symlinks_rejected: 0,
        unresolvable_cwd: 0,
      },
      baseline: mkBaseline(),
      finding: null,
      diagnoses: [mkDiagnosis()],
    });

    // The CAUSE column header appears.
    expect(out).toContain('CAUSE');
    // The src/billing row carries `doc(0.78)` as its cause cell.
    expect(out).toContain('doc(0.78)');
  });

  it('20. formatHuman — flagged row with no matching diagnosis renders `-` in the cause cell', () => {
    const areas: AreaRow[] = [
      {
        key: 'src/billing',
        sessions_total: 3,
        sessions_flagged: 2,
        mean_score: 85,
        top_signals: [{ name: 'reread', value: 7, display: 'reread(7)' }],
      },
      {
        key: 'src/auth',
        sessions_total: 2,
        sessions_flagged: 1,
        mean_score: 70,
        top_signals: [{ name: 'abandonment', value: true, display: 'abandonment(yes)' }],
      },
    ];
    // Only src/billing has a diagnosis; src/auth should render `-`.
    const out = formatHuman({
      repo: 'r',
      mode: 'bootstrap',
      sessionCount: 5,
      areas,
      summary: { flagged: 2, unflagged: 0, unlocalized: 0 },
      warnings: {
        malformed_lines: 0,
        oversized_lines: 0,
        skipped_sessions: 0,
        truncated_sessions: 0,
        symlinks_rejected: 0,
        unresolvable_cwd: 0,
      },
      baseline: mkBaseline(),
      finding: null,
      diagnoses: [mkDiagnosis()],
    });

    const lines = out.split('\n');
    // Find the src/auth row and confirm its cause cell is `-`.
    const authLine = lines.find((l) => l.startsWith('src/auth'));
    expect(authLine).toBeDefined();
    // The cause column appears after the TOP SIGNALS content separator on that row.
    // Use a regex that anchors to the row: columns are AREA | FLAGGED | MEAN SCORE | CAUSE | TOP SIGNALS.
    // The `doc` diagnosis must NOT bleed into the unmatched row.
    expect(authLine!).not.toContain('doc(');
    // The src/auth row's cause cell is `-`.
    const billingLine = lines.find((l) => l.startsWith('src/billing'));
    expect(billingLine).toBeDefined();
    expect(billingLine!).toContain('doc(0.78)');
    // Verify auth row has a standalone `-` cause cell: split on ` | ` and inspect the cell.
    // Column order: [AREA, FLAGGED, MEAN SCORE, CAUSE, TOP SIGNALS] (5 cols → 4 separators).
    const authCells = authLine!.split(' | ');
    expect(authCells.length).toBe(5);
    expect(authCells[3]!.trim()).toBe('-');
  });

  it('21. formatHuman — `unclassified` cause renders as `-` in the cause cell', () => {
    const areas: AreaRow[] = [
      {
        key: 'src/legacy',
        sessions_total: 2,
        sessions_flagged: 1,
        mean_score: 60,
        top_signals: [{ name: 'reread', value: 4, display: 'reread(4)' }],
      },
    ];
    const out = formatHuman({
      repo: 'r',
      mode: 'bootstrap',
      sessionCount: 3,
      areas,
      summary: { flagged: 1, unflagged: 0, unlocalized: 0 },
      warnings: {
        malformed_lines: 0,
        oversized_lines: 0,
        skipped_sessions: 0,
        truncated_sessions: 0,
        symlinks_rejected: 0,
        unresolvable_cwd: 0,
      },
      baseline: mkBaseline(),
      finding: null,
      diagnoses: [
        mkDiagnosis({ unit: { kind: 'area', key: 'src/legacy' }, cause: 'unclassified', confidence: 0.3 }),
      ],
    });

    const lines = out.split('\n');
    const legacyLine = lines.find((l) => l.startsWith('src/legacy'));
    expect(legacyLine).toBeDefined();
    const cells = legacyLine!.split(' | ');
    expect(cells[3]!.trim()).toBe('-');
  });

  it('22. formatHuman — NO diagnoses passed → byte-identical default (no CAUSE column at all)', () => {
    const areas: AreaRow[] = [
      {
        key: 'src/billing',
        sessions_total: 3,
        sessions_flagged: 2,
        mean_score: 85,
        top_signals: [{ name: 'reread', value: 7, display: 'reread(7)' }],
      },
    ];
    const warnings: Warnings = {
      malformed_lines: 1,
      oversized_lines: 0,
      skipped_sessions: 0,
      truncated_sessions: 0,
      symlinks_rejected: 0,
      unresolvable_cwd: 0,
    };
    const commonInput = {
      repo: 'r',
      mode: 'bootstrap',
      sessionCount: 5,
      areas,
      summary: { flagged: 1, unflagged: 0, unlocalized: 0 },
      warnings,
      baseline: mkBaseline(),
      finding: null,
    };

    // Three ways the default path can call formatHuman: omit `diagnoses`,
    // pass `undefined`, or pass an empty array (still treat as "off" per spec:
    // the column exists only when diagnoses are present). All three MUST be
    // byte-identical to the pre-change Slice 3 output.
    const omitted = formatHuman(commonInput);
    const passedUndefined = formatHuman({ ...commonInput, diagnoses: undefined });

    // No CAUSE column header, no cause cell content.
    expect(omitted).not.toContain('CAUSE');
    expect(omitted).not.toContain('doc(');
    // Both invocation styles produce identical output.
    expect(passedUndefined).toBe(omitted);

    // Column header is the Slice 3 layout (4 columns: AREA, FLAGGED, MEAN SCORE, TOP SIGNALS).
    const headerLine = omitted.split('\n').find((l) => l.startsWith('AREA'));
    expect(headerLine).toBeDefined();
    expect(headerLine!.split(' | ').length).toBe(4);
    // Row layout matches header (4 cells per row).
    const billingLine = omitted.split('\n').find((l) => l.startsWith('src/billing'));
    expect(billingLine).toBeDefined();
    expect(billingLine!.split(' | ').length).toBe(4);
  });

  it('23. buildJsonEnvelope — diagnoses passed → projected onto envelope with cause field', () => {
    const warnings: Warnings = {
      malformed_lines: 0,
      oversized_lines: 0,
      skipped_sessions: 0,
      truncated_sessions: 0,
      symlinks_rejected: 0,
      unresolvable_cwd: 0,
    };
    const diagnosis: Diagnosis = mkDiagnosis();

    const out = buildJsonEnvelope({
      repo: 'r',
      mode: 'bootstrap',
      session_count: 2,
      warnings,
      sessions: [mkRecord()],
      areas: [],
      repo_findings: [],
      diagnoses: [diagnosis],
    });

    expect(out.diagnoses).toBeDefined();
    expect(out.diagnoses).toHaveLength(1);
    expect(out.diagnoses![0]!.cause).toBe('doc');
    expect(out.diagnoses![0]!.unit).toEqual({ kind: 'area', key: 'src/billing' });
    expect(out.diagnoses![0]!.confidence).toBeCloseTo(0.78, 2);
  });

  it('24. buildJsonEnvelope — NO diagnoses passed → envelope has NO diagnoses key (byte-identical default)', () => {
    const warnings: Warnings = {
      malformed_lines: 0,
      oversized_lines: 0,
      skipped_sessions: 0,
      truncated_sessions: 0,
      symlinks_rejected: 0,
      unresolvable_cwd: 0,
    };

    const out = buildJsonEnvelope({
      repo: 'r',
      mode: 'bootstrap',
      session_count: 1,
      warnings,
      sessions: [mkRecord()],
      areas: [],
      repo_findings: [],
    });

    // Key is ABSENT (not just undefined). The serialized JSON must not contain
    // the `diagnoses` key at all.
    expect(out).not.toHaveProperty('diagnoses');
    expect(JSON.stringify(out)).not.toContain('diagnoses');
  });
});
