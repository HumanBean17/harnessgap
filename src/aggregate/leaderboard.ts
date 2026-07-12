// Pure area aggregation: rolls per-session StruggleRecords up into per-area
// AreaRows (weighted counting, mean_score, top_signals) plus a summary.
// No I/O, no mutation of inputs.

import type {
  AreaRow,
  Config,
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
 * 1. For each record, for each of its `areas`, add the record (weighted by
 *    `area.weight`) to that area's `sessions_total`; if `flagged`, add to
 *    `sessions_flagged` (weighted).
 * 2. `mean_score` = average of `score_pct` over flagged records touching the
 *    area (0 if none flagged).
 * 3. `top_signals` (per area, max 3): median raw signal value across the area's
 *    flagged sessions, top 3 by value desc, `display` formatted per kind.
 * 4. Sort rows by `sessions_flagged` desc, then `mean_score` desc.
 * 5. `summary.unlocalized` = count of records with empty `areas`;
 *    `flagged`/`unflagged` = counts of all records (unlocalized included).
 *
 * `cfg` is part of the signature contract but unused in v1 (raw medians; no
 * weighting knobs read). Reserved for future ranking configuration.
 */
export function aggregateAreas(
  records: StruggleRecord[],
  cfg: Config,
): { rows: AreaRow[]; summary: { flagged: number; unflagged: number; unlocalized: number } } {
  void cfg; // reserved; v1 does not read cfg

  const byArea = new Map<string, AreaAccum>();
  let flagged = 0;
  let unflagged = 0;
  let unlocalized = 0;

  for (const rec of records) {
    if (rec.flagged) flagged += 1;
    else unflagged += 1;
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
      acc.sessionsTotal += area.weight;
      if (rec.flagged) {
        acc.sessionsFlagged += area.weight;
        acc.flaggedScores.push(rec.score_pct);
        acc.flaggedSignals.push(rec.signals);
      }
    }
  }

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
      top_signals: topSignalsForArea(acc.flaggedSignals),
    });
  }

  rows.sort((a, b) => {
    if (b.sessions_flagged !== a.sessions_flagged) {
      return b.sessions_flagged - a.sessions_flagged;
    }
    return b.mean_score - a.mean_score;
  });

  return { rows, summary: { flagged, unflagged, unlocalized } };
}

/**
 * Pick up to 3 top signals for an area from its flagged sessions' signals.
 *
 * For each signal spec: compute the median of its raw value across the flagged
 * sessions (booleans use majority; nullable signals skip when all null). Rank
 * by median value descending (higher = more struggle; `abandonment: true`
 * counts as 1). Take the top 3. Ties preserve `SIGNAL_SPECS` order (stable).
 * An area with no flagged sessions yields `[]`.
 */
function topSignalsForArea(
  flaggedSignals: SignalValues[],
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
        display: formatDisplay(spec, med),
        sortKey: med ? 1 : 0,
      });
      continue;
    }
    const values = flaggedSignals
      .map((s) => s[spec.field] as number | null)
      .filter((v): v is number => v !== null);
    if (values.length === 0) continue; // all null → skip this signal
    const med = median(values);
    if (med === null) continue; // unreachable when values.length > 0
    candidates.push({
      name: spec.name,
      value: med,
      display: formatDisplay(spec, med),
      sortKey: med,
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

/** Format a signal median per its kind for the `display` string. */
function formatDisplay(spec: SignalSpec, value: number | boolean): string {
  switch (spec.kind) {
    case 'count':
      return `${spec.name}(${Math.round(value as number)})`;
    case 'ratio':
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
