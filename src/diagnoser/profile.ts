// Pure per-unit profile builder for the Diagnoser (Slice 4, Task 5). Groups
// flagged `StruggleRecord`s by area key and emits one `UnitProfile` per area:
// per-signal medians, elevated-flags vs `cfg.detector.bootstrap_thresholds`,
// and element-wise evidence sums. No I/O, no mutation of inputs. Output is
// sorted by `key` ascending (deterministic) so downstream rule ordering is stable.

import type {
  Config,
  SessionEvidence,
  SignalName,
  SignalValues,
  StruggleRecord,
} from '../types.js';

/** Per-area profile consumed by the rule engine (Task 7). */
export interface UnitProfile {
  key: string;
  flaggedCount: number;
  meanScore: number;
  medians: Record<SignalName, number | boolean | null>;
  elevated: Record<SignalName, boolean>;
  evidence: SessionEvidence;
}

type SignalKind = 'count' | 'ratio' | 'duration' | 'boolean';

interface SignalSpec {
  /** `SignalName` (display name; note `wall_clock_per_line` has no `_ms`). */
  name: SignalName;
  /**
   * Field on `SignalValues`. Also serves as the `bootstrap_thresholds` key —
   * those two objects share the same key set (both use `wall_clock_per_line_ms`
   * with the `_ms` suffix), so a single index resolves both lookups.
   */
  field: keyof SignalValues;
  kind: SignalKind;
}

// The seven signals in canonical order. Matches the precedent in
// `aggregate/leaderboard.ts` so medians/elevation stay aligned with the
// already-shown top_signals.
const SIGNAL_SPECS: readonly SignalSpec[] = [
  { name: 'explore_ratio', field: 'explore_ratio', kind: 'ratio' },
  { name: 'reread', field: 'reread', kind: 'count' },
  { name: 'failure_streak', field: 'failure_streak', kind: 'count' },
  { name: 'corrections', field: 'corrections', kind: 'count' },
  { name: 'abandonment', field: 'abandonment', kind: 'boolean' },
  { name: 'oscillation', field: 'oscillation', kind: 'count' },
  { name: 'wall_clock_per_line', field: 'wall_clock_per_line_ms', kind: 'duration' },
];

const ZERO_EVIDENCE: SessionEvidence = {
  failures: { config: 0, test: 0, build: 0, other: 0 },
  edit_kinds: { test: 0, code: 0, other: 0 },
};

const FAILURE_KEYS = ['config', 'test', 'build', 'other'] as const;
const EDIT_KEYS = ['test', 'code', 'other'] as const;

interface AreaAccum {
  key: string;
  flaggedScores: number[];
  flaggedSignals: SignalValues[];
  evidence: SessionEvidence;
}

/**
 * Build a `UnitProfile` per area touched by any flagged record.
 *
 * Grouping: a flagged record touching N areas contributes to all N profiles
 * (counted once per area). `flaggedCount` = number of flagged records touching
 * the area; `meanScore` = mean of their `score_pct`. Unflagged records are
 * skipped entirely.
 *
 * Per-signal medians match `aggregateAreas`: numbers use the standard median;
 * nullable signals (`explore_ratio`, `wall_clock_per_line_ms`) median over
 * non-null values and yield `null` when all values are null; `abandonment`
 * uses strict majority (more than half `true` → `true`).
 *
 * Elevation (mode-aware, issue #32): in bootstrap mode, numbers `>=` the
 * configured `bootstrap_thresholds` (a median exactly at threshold is elevated).
 * In percentile mode, a number is elevated when the area's median is STRICTLY
 * greater than the COHORT median across all records — i.e. the area expresses
 * the signal more than a typical session in this repo. The absolute floors are
 * miscalibrated for real percentile-mode data (they were never reached, so every
 * flagged area fell to `unclassified`); the cohort median lets the area's
 * expressed signals elevate so the rule engine's specific-cause gates can fire.
 * Nullable signals are never elevated on a null median; `abandonment` uses
 * absolute-threshold elevation in both modes (majority `true` AND threshold true).
 *
 * Evidence: element-wise sum of each flagged record's `evidence` buckets;
 * records with no `evidence` contribute zero. Result always carries all 7
 * buckets (zero-filled), so downstream rules can rely on the full shape.
 *
 * `cfg` is read only for `detector.bootstrap_thresholds`. No I/O, no mutation.
 */
export function buildProfiles(
  records: StruggleRecord[],
  cfg: Config,
): UnitProfile[] {
  const thresholds = cfg.detector.bootstrap_thresholds;
  // Elevation yardstick is mode-aware (issue #32): bootstrap mode uses the
  // absolute `bootstrap_thresholds` floors (unchanged); percentile mode compares
  // each area's median to the COHORT median across all records — "this area
  // expresses the signal more than a typical session in this repo." The absolute
  // floors are miscalibrated for real percentile-mode data (reread≥5, oscillation≥2
  // are almost never reached), so every flagged area collapsed to `unclassified`.
  // The cohort median lets a flagged area's expressed signals actually elevate,
  // so the rule engine's specific-cause gates can fire. `mode` is consistent
  // across the batch (the scorer picks one); default to bootstrap on empty input.
  const mode = records[0]?.mode ?? 'bootstrap';
  const cohortMedians =
    mode === 'percentile' ? computeCohortMedians(records) : null;
  const byArea = new Map<string, AreaAccum>();

  for (const rec of records) {
    if (!rec.flagged) continue;
    for (const area of rec.areas) {
      let acc = byArea.get(area.key);
      if (acc === undefined) {
        acc = {
          key: area.key,
          flaggedScores: [],
          flaggedSignals: [],
          // Fresh bucket objects per area — input records' `evidence` is never
          // aliased into the output (purity).
          evidence: {
            failures: { ...ZERO_EVIDENCE.failures },
            edit_kinds: { ...ZERO_EVIDENCE.edit_kinds },
          },
        };
        byArea.set(area.key, acc);
      }
      acc.flaggedScores.push(rec.score_pct);
      acc.flaggedSignals.push(rec.signals);
      const ev = rec.evidence;
      if (ev) {
        for (const k of FAILURE_KEYS) acc.evidence.failures[k] += ev.failures[k];
        for (const k of EDIT_KEYS) acc.evidence.edit_kinds[k] += ev.edit_kinds[k];
      }
    }
  }

  const profiles: UnitProfile[] = [];
  for (const acc of byArea.values()) {
    const n = acc.flaggedSignals.length;
    const meanScore =
      n > 0 ? acc.flaggedScores.reduce((a, b) => a + b, 0) / n : 0;

    const medians = {} as Record<SignalName, number | boolean | null>;
    const elevated = {} as Record<SignalName, boolean>;

    for (const spec of SIGNAL_SPECS) {
      if (spec.kind === 'boolean') {
        const bools = acc.flaggedSignals.map((s) => s[spec.field] as boolean);
        const med = medianBoolean(bools);
        medians[spec.name] = med;
        // Abandonment elevated iff majority is true AND the threshold is true
        // (default). A threshold of false disables the elevation.
        elevated[spec.name] = med && thresholds.abandonment;
        continue;
      }
      const values = acc.flaggedSignals
        .map((s) => s[spec.field] as number | null)
        .filter((v): v is number => v !== null);
      if (values.length === 0) {
        // All null → null median, never elevated.
        medians[spec.name] = null;
        elevated[spec.name] = false;
        continue;
      }
      const med = median(values);
      // `values` is non-empty here, so med is non-null; guard keeps TS happy.
      if (med === null) {
        medians[spec.name] = null;
        elevated[spec.name] = false;
        continue;
      }
      medians[spec.name] = med;
      if (mode === 'percentile' && cohortMedians !== null) {
        // Elevate when the area's median is STRICTLY above the cohort median:
        // the area expresses this signal more than a typical session in this
        // repo. A sparse cohort (median 0) therefore elevates any area that
        // actually has the signal (median > 0) — the right call, since "more
        // than typical" is "present at all" when typical is 0. The cohort median
        // is guaranteed non-null here (the area's records are a subset of the
        // cohort, so a non-null area median implies a non-null cohort median);
        // the `null` guard is defensive and degrades to no elevation.
        const cohort = cohortMedians[spec.field];
        elevated[spec.name] = cohort === null ? false : med > cohort;
      } else {
        // Bootstrap mode: absolute floor (unchanged from pre-#32 behaviour).
        const threshold = thresholds[spec.field] as number;
        elevated[spec.name] = med >= threshold;
      }
    }

    profiles.push({
      key: acc.key,
      flaggedCount: n,
      meanScore,
      medians,
      elevated,
      evidence: acc.evidence,
    });
  }

  // Deterministic ordering: key ascending (lexical).
  profiles.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return profiles;
}

/**
 * Per-signal cohort medians across ALL records (the repo's sessions — the same
 * set the scorer ranked), for percentile-mode elevation (#32). Numeric signals
 * median over non-null values (null when every record is null); abandonment is
 * excluded (it keeps absolute-threshold elevation in both modes). The result is
 * keyed by `SignalValues` field (e.g. `wall_clock_per_line_ms`), matching
 * `SIGNAL_SPECS[*].field` so the elevation loop can look it up directly.
 */
function computeCohortMedians(
  records: StruggleRecord[],
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const spec of SIGNAL_SPECS) {
    if (spec.kind === 'boolean') continue; // abandonment: absolute threshold, not cohorted
    const values = records
      .map((r) => r.signals[spec.field] as number | null)
      .filter((v): v is number => v !== null);
    out[spec.field] = median(values);
  }
  return out;
}

/** Median of a numeric array. Returns null only for empty input. */
function median(values: number[]): number | null {
  const n = values.length;
  if (n === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Median of booleans as strict majority: more than half true → true. */
function medianBoolean(values: boolean[]): boolean {
  const trues = values.filter(Boolean).length;
  return trues * 2 > values.length;
}
