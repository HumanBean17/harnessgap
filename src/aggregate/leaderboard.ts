// Pure area aggregation: rolls per-session StruggleRecords up into per-area
// AreaRows (integer session counts, mean_score, top_signals) plus a summary.
// No I/O, no mutation of inputs.

import type {
  AreaRow,
  Config,
  ScoringMode,
  SignalName,
  SignalValues,
  StruggleRecord,
} from '../types.js';

/** A signal's display kind, driving its `display` formatting. */
type SignalKind = 'count' | 'ratio' | 'duration' | 'boolean';

interface SignalSpec {
  /** `SignalName` used as the `display` name (note: `wall_clock_per_line`, no `_ms`). */
  name: SignalName;
  /** Field on `SignalValues` (note: `wall_clock_per_line_ms` has the `_ms` suffix). */
  field: keyof SignalValues;
  kind: SignalKind;
}

// The seven signals in a fixed canonical order. Ties in the top-signals ranking
// preserve this order (stable sort), so output is deterministic.
const SIGNAL_SPECS: readonly SignalSpec[] = [
  { name: 'explore_ratio', field: 'explore_ratio', kind: 'ratio' },
  { name: 'reread', field: 'reread', kind: 'count' },
  { name: 'failure_streak', field: 'failure_streak', kind: 'count' },
  { name: 'corrections', field: 'corrections', kind: 'count' },
  { name: 'abandonment', field: 'abandonment', kind: 'boolean' },
  { name: 'oscillation', field: 'oscillation', kind: 'count' },
  { name: 'wall_clock_per_line', field: 'wall_clock_per_line_ms', kind: 'duration' },
];

interface AreaAccum {
  key: string;
  sessionsTotal: number;
  sessionsFlagged: number;
  flaggedScores: number[];
  flaggedSignals: SignalValues[];
}

/**
 * Aggregate per-session `StruggleRecord`s into per-area `AreaRow`s plus a summary.
 *
 * 1. For each record, for each of its `areas`, count the session once toward
 *    that area's `sessions_total`; if `flagged`, count once toward
 *    `sessions_flagged`. Counts are INTEGERS (a session touches an area or it
 *    doesn't) — the spec's §6/§8 examples show integers, not weighted sums.
 * 2. `mean_score` = average of `score_pct` over flagged records touching the
 *    area (0 if none flagged).
 * 3. `top_signals` (per area, max 3): the area's representative (median) raw
 *    value per signal, ranked and formatted by mode (spec §8):
 *      - percentile mode: ranked by the repo-wide percentile rank of the
 *        median; `explore_ratio` renders as `<N>th`.
 *      - bootstrap mode: ranked by raw value; `explore_ratio` renders raw.
 *      Counts always render as raw, durations as `Ns`/`Nms`, booleans as
 *      `yes`/`no`.
 * 4. Sort rows by `sessions_flagged` desc, then `mean_score` desc.
 * 5. `summary.flagged`/`unflagged` = COUNTS OF AREA ROWS (flagged = any flagged
 *    session touches it; unflagged = touched only by unflagged sessions).
 *    `summary.unlocalized` = count of records with empty `areas` (session-level).
 *
 * `cfg` is part of the signature contract but unused in v1. Reserved for future
 * ranking configuration.
 */
export function aggregateAreas(
  records: StruggleRecord[],
  cfg: Config,
): { rows: AreaRow[]; summary: { flagged: number; unflagged: number; unlocalized: number } } {
  void cfg; // reserved; v1 does not read cfg

  const byArea = new Map<string, AreaAccum>();
  let unlocalized = 0;

  for (const rec of records) {
    if (rec.areas.length === 0) {
      unlocalized += 1;
      continue;
    }
    for (const area of rec.areas) {
      let acc = byArea.get(area.key);
      if (acc === undefined) {
        acc = {
          key: area.key,
          sessionsTotal: 0,
          sessionsFlagged: 0,
          flaggedScores: [],
          flaggedSignals: [],
        };
        byArea.set(area.key, acc);
      }
      acc.sessionsTotal += 1;
      if (rec.flagged) {
        acc.sessionsFlagged += 1;
        acc.flaggedScores.push(rec.score_pct);
        acc.flaggedSignals.push(rec.signals);
      }
    }
  }

  // Mode is consistent across all records (scoreSessions picks one for the
  // batch). Default bootstrap when there are none.
  const mode: ScoringMode = records[0]?.mode ?? 'bootstrap';
  // Repo-wide per-signal value arrays, used for percentile-rank selection +
  // explore_ratio display in percentile mode. Built once across all records.
  const repoValues = mode === 'percentile' ? buildRepoValueArrays(records) : null;

  const rows: AreaRow[] = [];
  for (const acc of byArea.values()) {
    const meanScore =
      acc.flaggedScores.length > 0
        ? acc.flaggedScores.reduce((a, b) => a + b, 0) / acc.flaggedScores.length
        : 0;
    rows.push({
      key: acc.key,
      sessions_total: acc.sessionsTotal,
      sessions_flagged: acc.sessionsFlagged,
      mean_score: meanScore,
      top_signals: topSignalsForArea(acc.flaggedSignals, mode, repoValues),
    });
  }

  rows.sort((a, b) => {
    if (b.sessions_flagged !== a.sessions_flagged) {
      return b.sessions_flagged - a.sessions_flagged;
    }
    return b.mean_score - a.mean_score;
  });

  // Summary counts AREAS (matching the table), not sessions: `flagged` = area
  // rows with ≥1 flagged session, `unflagged` = area rows touched only by
  // unflagged sessions. `unlocalized` stays session-level (sessions with no
  // area). This keeps the summary line honest about how many area rows the
  // reader is (not) seeing.
  const flaggedAreas = rows.filter((r) => r.sessions_flagged > 0).length;
  const unflaggedAreas = rows.length - flaggedAreas;

  return {
    rows,
    summary: { flagged: flaggedAreas, unflagged: unflaggedAreas, unlocalized },
  };
}

/**
 * Per non-boolean signal, the sorted non-null raw values across all records
 * (the repo session set). Percentile ranks are taken against this distribution.
 */
function buildRepoValueArrays(
  records: StruggleRecord[],
): Partial<Record<keyof SignalValues, number[]>> {
  const out: Partial<Record<keyof SignalValues, number[]>> = {};
  for (const spec of SIGNAL_SPECS) {
    if (spec.kind === 'boolean') continue;
    const vals: number[] = [];
    for (const r of records) {
      const v = r.signals[spec.field];
      if (v !== null) vals.push(v as number);
    }
    if (vals.length > 0) out[spec.field] = vals.sort((a, b) => a - b);
  }
  return out;
}

/**
 * Percentile rank of `v` within `values`: `(count strictly less than v) /
 * (n−1) × 100` when n>1, else 0. Matches scoring.ts' percentileRank semantics.
 */
function repoPercentileOf(values: number[] | undefined, v: number): number {
  if (!values) return 0;
  const n = values.length;
  if (n <= 1) return 0;
  let less = 0;
  for (const x of values) if (x < v) less += 1;
  return (less / (n - 1)) * 100;
}

/**
 * Pick up to 3 top signals for an area from its flagged sessions' signals.
 *
 * Representative value per signal = median across the area's flagged sessions
 * (booleans use majority; nullable signals skip when all null). Selection + the
 * `explore_ratio` display depend on `mode` (spec §8); counts/durations/booleans
 * render the same in both modes. Ties preserve `SIGNAL_SPECS` order (stable).
 * An area with no flagged sessions yields `[]`.
 */
function topSignalsForArea(
  flaggedSignals: SignalValues[],
  mode: ScoringMode,
  repoValues: Partial<Record<keyof SignalValues, number[]>> | null,
): AreaRow['top_signals'] {
  if (flaggedSignals.length === 0) return [];

  const candidates: Array<{
    name: SignalName;
    value: number | boolean;
    display: string;
    sortKey: number;
  }> = [];

  for (const spec of SIGNAL_SPECS) {
    if (spec.kind === 'boolean') {
      const values = flaggedSignals.map((s) => s[spec.field] as boolean);
      const med = medianBoolean(values);
      candidates.push({
        name: spec.name,
        value: med,
        display: formatDisplay(spec, med, mode, 0),
        sortKey: med ? 1 : 0, // booleans always rank by raw value (spec §8)
      });
      continue;
    }
    const values = flaggedSignals
      .map((s) => s[spec.field] as number | null)
      .filter((v): v is number => v !== null);
    if (values.length === 0) continue; // all null → skip this signal
    const med = median(values);
    if (med === null) continue; // unreachable when values.length > 0
    const pctile =
      mode === 'percentile' && repoValues
        ? repoPercentileOf(repoValues[spec.field], med)
        : 0;
    candidates.push({
      name: spec.name,
      value: med,
      display: formatDisplay(spec, med, mode, pctile),
      sortKey: mode === 'percentile' && repoValues ? pctile : med,
    });
  }

  candidates.sort((a, b) => b.sortKey - a.sortKey);
  return candidates.slice(0, 3).map(({ name, value, display }) => ({
    name,
    value,
    display,
  }));
}

/** Median of a non-empty numeric array. Returns null only for empty input. */
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

/** Ordinal suffix for an integer: 1→1st, 2→2nd, 3→3rd, 11→11th, 95→95th. */
function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

/**
 * Format a signal median per its kind for the `display` string.
 *
 * - count: `name(<rounded raw>)` (both modes)
 * - ratio (explore_ratio): percentile mode → `name(<pctile>th)`; bootstrap →
 *   `name(<raw, 1dp>)`
 * - duration: `name(<Ns>)` or `name(<Nms>)` (both modes)
 * - boolean: `name(yes|no)` (both modes)
 */
function formatDisplay(
  spec: SignalSpec,
  value: number | boolean,
  mode: ScoringMode,
  pctile: number,
): string {
  switch (spec.kind) {
    case 'count':
      return `${spec.name}(${Math.round(value as number)})`;
    case 'ratio':
      if (mode === 'percentile') return `${spec.name}(${ordinal(Math.round(pctile))})`;
      return `${spec.name}(${(value as number).toFixed(1)})`;
    case 'duration': {
      const ms = value as number;
      if (ms >= 1000) return `${spec.name}(${Math.round(ms / 1000)}s)`;
      return `${spec.name}(${Math.round(ms)}ms)`;
    }
    case 'boolean':
      return `${spec.name}(${value ? 'yes' : 'no'})`;
  }
}
