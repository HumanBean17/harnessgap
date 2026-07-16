// Pure scorer: percentile-of-composites and bootstrap modes. No I/O, no mutation.

import type { Config, ScoringMode, SignalName, SignalValues } from '../types.js';

interface SessionScore {
  score_pct: number;
  mode: ScoringMode;
  flagged: boolean;
  composite: number;
  /** Bootstrap composite (0–100) for the session — always populated, even in
   * percentile mode. Identical to `composite` when `mode === 'bootstrap'`. */
  bootstrap_composite: number;
  /** Bootstrap flag for the session — always populated. True when
   * `bootstrap_composite >= cfg.detector.bootstrap_flag_pct` or ≥2 signals
   * trip. Identical to `flagged` when `mode === 'bootstrap'`. */
  bootstrap_flagged: boolean;
}

interface SignalSpec {
  /** Field on `SignalValues`. */
  field: keyof SignalValues;
  /** Key into `cfg.detector.signal_weights` (note: `wall_clock_per_line`, no `_ms`). */
  weightKey: SignalName;
  /** Key into `cfg.detector.bootstrap_thresholds` (note: `wall_clock_per_line_ms`). */
  thresholdKey: keyof Config['detector']['bootstrap_thresholds'];
  /** Boolean signals contribute 0/100 (percentile) or trip on true (bootstrap). */
  boolean: boolean;
}

// The seven signals, mapped from their `SignalValues` field to the (differently
// named) weight and threshold keys. Only `explore_ratio` and
// `wall_clock_per_line_ms` are nullable.
const SIGNAL_SPECS: readonly SignalSpec[] = [
  { field: 'explore_ratio', weightKey: 'explore_ratio', thresholdKey: 'explore_ratio', boolean: false },
  { field: 'reread', weightKey: 'reread', thresholdKey: 'reread', boolean: false },
  { field: 'failure_streak', weightKey: 'failure_streak', thresholdKey: 'failure_streak', boolean: false },
  { field: 'corrections', weightKey: 'corrections', thresholdKey: 'corrections', boolean: false },
  { field: 'abandonment', weightKey: 'abandonment', thresholdKey: 'abandonment', boolean: true },
  { field: 'oscillation', weightKey: 'oscillation', thresholdKey: 'oscillation', boolean: false },
  { field: 'wall_clock_per_line_ms', weightKey: 'wall_clock_per_line', thresholdKey: 'wall_clock_per_line_ms', boolean: false },
];

/**
 * Score a batch of sessions. Pure: no I/O, no mutation of inputs. Returns one
 * result per session, in input order.
 *
 * Mode precedence: `forceBootstrap` → bootstrap; else
 * `thresholds_as === "absolute"` → bootstrap; else
 * `signals.length < bootstrap_session_floor` → bootstrap; else percentile.
 */
export function scoreSessions(input: {
  signals: SignalValues[];
  cfg: Config;
  forceBootstrap: boolean;
}): SessionScore[] {
  const { signals, cfg, forceBootstrap } = input;
  const mode = selectMode(signals.length, cfg, forceBootstrap);
  if (mode === 'bootstrap') {
    return signals.map((s) => bootstrapScore(s, cfg));
  }
  return percentileModeScore(signals, cfg);
}

function selectMode(n: number, cfg: Config, forceBootstrap: boolean): ScoringMode {
  if (forceBootstrap) return 'bootstrap';
  if (cfg.detector.thresholds_as === 'absolute') return 'bootstrap';
  if (n < cfg.detector.bootstrap_session_floor) return 'bootstrap';
  return 'percentile';
}

/**
 * Percentile rank of the value at `index` within `values`:
 * `(count strictly less than v) / (n−1) * 100` when n>1, else 0.
 * Tied values each get `(count strictly less) / (n−1) * 100`.
 */
function percentileRank(values: readonly number[], index: number): number {
  const n = values.length;
  if (n <= 1) return 0;
  const v = values[index];
  let less = 0;
  for (let i = 0; i < n; i++) {
    if (values[i] < v) less += 1;
  }
  return (less / (n - 1)) * 100;
}

function percentileModeScore(signals: SignalValues[], cfg: Config): SessionScore[] {
  const n = signals.length;
  const weights = cfg.detector.signal_weights;

  // Per-session percentile rank for each numeric signal. Nullable signals are
  // ranked only among sessions with non-null values; null sessions get no rank
  // entry and are excluded from that signal's composite contribution.
  const ranks: Array<Partial<Record<SignalName, number>>> = signals.map(() => ({}));

  for (const spec of SIGNAL_SPECS) {
    if (spec.boolean) continue; // abandonment contributes 0/100 directly
    const indices: number[] = [];
    const values: number[] = [];
    for (let i = 0; i < n; i++) {
      const v = signals[i][spec.field];
      if (v === null) continue;
      indices.push(i);
      values.push(v as number);
    }
    const m = values.length;
    if (m === 0) continue; // all null — no contribution from this signal
    for (let j = 0; j < m; j++) {
      ranks[indices[j]][spec.weightKey] = percentileRank(values, j);
    }
  }

  const composites = signals.map((s, i) => {
    let weightSum = 0;
    let weighted = 0;
    for (const spec of SIGNAL_SPECS) {
      const v = s[spec.field];
      if (v === null) continue;
      const w = weights[spec.weightKey];
      weightSum += w;
      const contribution = spec.boolean ? (v ? 100 : 0) : (ranks[i][spec.weightKey] ?? 0);
      weighted += contribution * w;
    }
    // Guard: if every weighted signal is null/absent, composite is 0.
    if (weightSum === 0) return 0;
    return weighted / weightSum;
  });

  return composites.map((composite, i) => {
    const scorePct = percentileRank(composites, i);
    const trip = bootstrapTrip(signals[i], cfg);
    return {
      score_pct: scorePct,
      mode: 'percentile',
      flagged: scorePct >= cfg.detector.flag_pct,
      composite,
      bootstrap_composite: trip.composite,
      bootstrap_flagged: trip.flagged,
    };
  });
}

/**
 * Compute the bootstrap trip (composite + flag) for a single session. Pure,
 * no I/O. Called for every session in both modes so `bootstrap_composite`
 * and `bootstrap_flagged` are always populated.
 *
 * Composite is on a 0–100 scale: each tripped signal contributes 100 × weight,
 * renormalized by the sum of weights of non-null signals. Flag is true when
 * `composite >= cfg.detector.bootstrap_flag_pct` OR at least two signals trip.
 */
function bootstrapTrip(
  s: SignalValues,
  cfg: Config,
): { composite: number; flagged: boolean } {
  const weights = cfg.detector.signal_weights;
  const thresholds = cfg.detector.bootstrap_thresholds;
  let weightSum = 0;
  let weighted = 0;
  let trippedCount = 0;

  for (const spec of SIGNAL_SPECS) {
    const v = s[spec.field];
    if (v === null) continue; // null signals neither trip nor count toward weights
    const w = weights[spec.weightKey];
    weightSum += w;
    const threshold = thresholds[spec.thresholdKey];
    const tripped = spec.boolean
      ? v === true && threshold === true
      : (v as number) >= (threshold as number);
    if (tripped) {
      trippedCount += 1;
      weighted += 100 * w;
    }
  }

  const composite = weightSum === 0 ? 0 : weighted / weightSum;
  const flagged =
    composite >= cfg.detector.bootstrap_flag_pct || trippedCount >= 2;

  return { composite, flagged };
}

function bootstrapScore(s: SignalValues, cfg: Config): SessionScore {
  const { composite, flagged } = bootstrapTrip(s, cfg);
  return {
    score_pct: composite,
    mode: 'bootstrap',
    flagged,
    composite,
    bootstrap_composite: composite,
    bootstrap_flagged: flagged,
  };
}
