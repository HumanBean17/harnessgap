// Pure calibrate builders: turn per-session `SignalValues[]` into aggregate
// statistics (min/p50/p90/max/active_threshold per signal) and a human table.
// No I/O, no per-session values in the output, no commands, no prose.
//
// `active_threshold` semantics:
// - bootstrap mode → `bootstrap_thresholds[name]` (the configured absolute
//   threshold; for `wall_clock_per_line` this is `wall_clock_per_line_ms`).
// - percentile mode → the `flag_pct`-percentile value of that signal across
//   sessions (sorted-index linear interpolation).
// - `abandonment` (boolean): treated as 0/1 throughout. Its `active_threshold`
//   is `bootstrap_thresholds.abandonment` (true) represented as 1 for both
//   modes, so the entire abandonment entry stays uniformly 0/1.

import type {
  Config,
  ScoringMode,
  SignalName,
  SignalValues,
} from '../types.js';

/** Per-signal aggregate stats in the calibrate object. */
interface CalibrateSignalStat {
  min: number;
  p50: number;
  p90: number;
  max: number;
  active_threshold: number;
}

/** Inputs to `buildCalibrateObject`. */
interface CalibrateInput {
  mode: ScoringMode;
  session_count: number;
  flag_pct: number;
  signals: SignalValues[];
  bootstrap_thresholds: Config['detector']['bootstrap_thresholds'];
}

/** The calibrate aggregate-stats object (no per-session values). */
interface CalibrateObject {
  mode: ScoringMode;
  session_count: number;
  flag_pct: number;
  signals: Record<SignalName, CalibrateSignalStat>;
}

// SignalName → field on `SignalValues`. Only `wall_clock_per_line` differs
// (its field is `wall_clock_per_line_ms`).
const SIGNAL_FIELDS: Record<SignalName, keyof SignalValues> = {
  explore_ratio: 'explore_ratio',
  reread: 'reread',
  failure_streak: 'failure_streak',
  corrections: 'corrections',
  abandonment: 'abandonment',
  oscillation: 'oscillation',
  wall_clock_per_line: 'wall_clock_per_line_ms',
};

// SignalName → key on `bootstrap_thresholds`. Only `wall_clock_per_line` differs
// (its threshold key is `wall_clock_per_line_ms`).
const THRESHOLD_KEYS: Record<
  SignalName,
  keyof Config['detector']['bootstrap_thresholds']
> = {
  explore_ratio: 'explore_ratio',
  reread: 'reread',
  failure_streak: 'failure_streak',
  corrections: 'corrections',
  abandonment: 'abandonment',
  oscillation: 'oscillation',
  wall_clock_per_line: 'wall_clock_per_line_ms',
};

// Canonical signal order for deterministic output.
const SIGNAL_ORDER: readonly SignalName[] = [
  'explore_ratio',
  'reread',
  'failure_streak',
  'corrections',
  'abandonment',
  'oscillation',
  'wall_clock_per_line',
];

/**
 * Build the calibrate aggregate-stats object. Pure: no I/O, no per-session
 * values in the output (only min/p50/p90/max/active_threshold per signal).
 */
export function buildCalibrateObject(input: CalibrateInput): CalibrateObject {
  const { mode, session_count, flag_pct, signals, bootstrap_thresholds } = input;
  const out = {} as Record<SignalName, CalibrateSignalStat>;
  for (const name of SIGNAL_ORDER) {
    out[name] = computeStat(name, signals, mode, flag_pct, bootstrap_thresholds);
  }
  return { mode, session_count, flag_pct, signals: out };
}

/**
 * Compute min/p50/p90/max/active_threshold for one signal across all sessions.
 *
 * - `abandonment`: 0/1 stats (min = any false, max = any true, p50 = strict
 *   majority true, p90 = max, active_threshold = configured boolean → 1).
 * - numeric/nullable: filter nulls; min/max are extremes; p50/p90/active use
 *   sorted-index linear interpolation. Empty (all-null) → all zeros.
 */
function computeStat(
  name: SignalName,
  signals: SignalValues[],
  mode: ScoringMode,
  flag_pct: number,
  bootstrap_thresholds: Config['detector']['bootstrap_thresholds'],
): CalibrateSignalStat {
  if (name === 'abandonment') {
    return computeAbandonmentStat(signals, bootstrap_thresholds);
  }
  const field = SIGNAL_FIELDS[name];
  const raw = signals
    .map((s) => s[field] as number | null)
    .filter((v): v is number => v !== null);

  const bootThreshold = bootstrap_thresholds[THRESHOLD_KEYS[name]] as number;

  if (raw.length === 0) {
    // No non-null values: stats are 0; active_threshold is the configured boot
    // threshold in bootstrap mode, else 0 (no percentile of an empty set).
    return {
      min: 0,
      p50: 0,
      p90: 0,
      max: 0,
      active_threshold: mode === 'bootstrap' ? round(bootThreshold) : 0,
    };
  }

  const sorted = [...raw].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const p50 = percentile(sorted, 50);
  const p90 = percentile(sorted, 90);
  const active_threshold =
    mode === 'bootstrap' ? bootThreshold : percentile(sorted, flag_pct);

  return {
    min: round(min),
    p50: round(p50),
    p90: round(p90),
    max: round(max),
    active_threshold: round(active_threshold),
  };
}

/** Abandonment stats: booleans as 0/1, all outputs constrained to {0,1}. */
function computeAbandonmentStat(
  signals: SignalValues[],
  bootstrap_thresholds: Config['detector']['bootstrap_thresholds'],
): CalibrateSignalStat {
  if (signals.length === 0) {
    return { min: 0, p50: 0, p90: 0, max: 0, active_threshold: 0 };
  }
  const vals = signals.map((s) => (s.abandonment ? 1 : 0));
  const trues = vals.reduce<number>((acc, v) => acc + v, 0);
  const min = vals.includes(0) ? 0 : 1;
  const max = trues > 0 ? 1 : 0;
  // strict majority true (tie → 0), matching the leaderboard median-boolean rule
  const p50 = trues * 2 > vals.length ? 1 : 0;
  const p90 = max; // 90th percentile of 0/1: 1 if any session abandoned
  const active_threshold = bootstrap_thresholds.abandonment ? 1 : 0;
  return { min, p50, p90, max, active_threshold };
}

/**
 * Percentile via sorted-index linear interpolation (R-7 / numpy default).
 * `sorted` must be ascending and non-empty. `p` is in [0, 100].
 */
function percentile(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0];
  const rank = (p / 100) * (n - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (rank - lower) * (sorted[upper] - sorted[lower]);
}

/** Round to 2 decimal places to keep aggregate stats readable. */
function round(x: number): number {
  return Math.round(x * 100) / 100;
}

/**
 * Format the calibrate object as a human-readable table. Aggregate numbers +
 * signal names only — no per-session examples, no commands, no prose.
 */
export function formatCalibrateTable(obj: ReturnType<typeof buildCalibrateObject>): string {
  const lines: string[] = [];
  lines.push(
    `harnessgap calibrate — mode: ${obj.mode} · ${obj.session_count} sessions · flag_pct: ${obj.flag_pct}`,
  );
  lines.push(
    `${'SIGNAL'.padEnd(22)} | ${'MIN'.padStart(10)} | ${'P50'.padStart(10)} | ${'P90'.padStart(10)} | ${'MAX'.padStart(10)} | ${'THRESHOLD'.padStart(10)}`,
  );
  for (const name of SIGNAL_ORDER) {
    const s = obj.signals[name];
    lines.push(
      `${name.padEnd(22)} | ${String(s.min).padStart(10)} | ${String(s.p50).padStart(10)} | ${String(s.p90).padStart(10)} | ${String(s.max).padStart(10)} | ${String(s.active_threshold).padStart(10)}`,
    );
  }
  return lines.join('\n');
}
