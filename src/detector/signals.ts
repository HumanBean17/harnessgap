// Pure detector signal computation. Each SignalValues field is computed by a
// small named helper; `computeSignals` assembles them. No I/O, no mutation.

import type { Config, NormalizedEvent, SignalValues, ToolKind } from '../types.js';

const EXPLORE_TOOLS: ReadonlySet<ToolKind> = new Set<ToolKind>(['search', 'read', 'list']);

/**
 * Compute all detector signals for a normalized event stream. Pure: no I/O,
 * no mutation of inputs. See field contracts in `types.ts` / the design spec.
 */
export function computeSignals(events: NormalizedEvent[], cfg: Config): SignalValues {
  return {
    explore_ratio: computeExploreRatio(events),
    reread: computeReread(events, cfg),
    failure_streak: computeFailureStreak(events),
    corrections: computeCorrections(events, cfg),
    abandonment: computeAbandonment(events, cfg),
    oscillation: computeOscillation(events, cfg),
    wall_clock_per_line_ms: computeWallClockPerLine(events, cfg),
  };
}

/**
 * (search + read + list tool_calls) / totalEditedLines. `null` when no edit
 * lines were produced (does not contribute to scoring).
 */
function computeExploreRatio(events: NormalizedEvent[]): number | null {
  let exploreCount = 0;
  let totalEditedLines = 0;
  for (const e of events) {
    if (e.kind !== 'tool_call' || e.tool === null) continue;
    if (EXPLORE_TOOLS.has(e.tool)) {
      exploreCount += 1;
    } else if (e.tool === 'edit') {
      totalEditedLines += e.input_digest.lines_changed ?? 0;
    }
  }
  if (totalEditedLines === 0) return null;
  return exploreCount / totalEditedLines;
}

/** Distinct file paths read >= `reread_threshold` times across read tool_calls. */
function computeReread(events: NormalizedEvent[], cfg: Config): number {
  const threshold = cfg.detector.reread_threshold;
  const counts = new Map<string, number>();
  for (const e of events) {
    if (e.kind !== 'tool_call' || e.tool !== 'read') continue;
    for (const f of e.input_digest.files) {
      counts.set(f, (counts.get(f) ?? 0) + 1);
    }
  }
  let reread = 0;
  for (const c of counts.values()) {
    if (c >= threshold) reread += 1;
  }
  return reread;
}

/** Longest run of consecutive `exec` tool_calls with `ok === false`. 0 if none. */
function computeFailureStreak(events: NormalizedEvent[]): number {
  let max = 0;
  let cur = 0;
  for (const e of events) {
    if (e.kind === 'tool_call' && e.tool === 'exec' && e.ok === false) {
      cur += 1;
      if (cur > max) max = cur;
    } else {
      cur = 0;
    }
  }
  return max;
}

/**
 * Count `user_msg` corrections tied to the most recent preceding `tool_call`.
 * A correction counts if:
 *   - it lands within `correction_window_ms` after the last tool_call, OR
 *   - it is late but no `assistant_msg` intervened between that tool_call and
 *     the correction (still the user's direct response to that tool_call).
 * A new `tool_call` resets the window; an `assistant_msg` marks intervention.
 */
function computeCorrections(events: NormalizedEvent[], cfg: Config): number {
  const windowMs = cfg.detector.correction_window_ms;
  let count = 0;
  let lastToolCallTime: number | null = null;
  let sawAssistantMsgSinceToolCall = false;

  for (const e of events) {
    if (e.kind === 'tool_call') {
      lastToolCallTime = Date.parse(e.t);
      sawAssistantMsgSinceToolCall = false;
    } else if (e.kind === 'assistant_msg') {
      sawAssistantMsgSinceToolCall = true;
    } else if (e.kind === 'user_msg' && e.correction?.matched === true) {
      if (lastToolCallTime !== null) {
        const dt = Date.parse(e.t) - lastToolCallTime;
        if (dt <= windowMs) {
          count += 1;
        } else if (!sawAssistantMsgSinceToolCall) {
          count += 1;
        }
      }
    }
  }
  return count;
}

/**
 * True when the last `tail_fraction` of events is explore-heavy (explore-ratio
 * ≥ `explore_ratio_min`) with zero edit events. Suppressed (forced false) when
 * `suppress_abandonment_when_no_exec` is set and the whole session is a
 * research signature (zero edits AND zero test/build exec calls).
 */
function computeAbandonment(events: NormalizedEvent[], cfg: Config): boolean {
  if (events.length === 0) return false;
  const tailSize = Math.floor(events.length * cfg.areas.tail_fraction);
  if (tailSize === 0) return false;
  const tail = events.slice(events.length - tailSize);

  let tailExploreCount = 0;
  let tailEditedLines = 0;
  let tailEditCount = 0;
  for (const e of tail) {
    if (e.kind !== 'tool_call' || e.tool === null) continue;
    if (EXPLORE_TOOLS.has(e.tool)) {
      tailExploreCount += 1;
    } else if (e.tool === 'edit') {
      tailEditCount += 1;
      tailEditedLines += e.input_digest.lines_changed ?? 0;
    }
  }
  const tailExploreRatio = tailExploreCount / Math.max(tailEditedLines, 1);
  let abandonment = tailExploreRatio >= cfg.areas.explore_ratio_min && tailEditCount === 0;

  if (abandonment && cfg.areas.suppress_abandonment_when_no_exec) {
    let wholeSessionEdits = 0;
    let wholeSessionTestExec = false;
    for (const e of events) {
      if (e.kind !== 'tool_call' || e.tool === null) continue;
      if (e.tool === 'edit') {
        wholeSessionEdits += 1;
      } else if (
        e.tool === 'exec' &&
        isTestBuildExec(e.input_digest.cmd, cfg.areas.test_cmd_patterns)
      ) {
        wholeSessionTestExec = true;
      }
    }
    if (wholeSessionEdits === 0 && !wholeSessionTestExec) {
      abandonment = false;
    }
  }
  return abandonment;
}

/**
 * Count completed `edit → test/build-exec(ok=false) → edit-same-file` cycles
 * per file. Tracks two sets per file: `pending` (edit seen, awaiting a failed
 * test) and `failedTestPending` (edit + failed test seen, awaiting a re-edit).
 * On a failed test/build exec, all pending files move to failedTestPending.
 * On an edit touching F: if F is in failedTestPending a cycle completes; F then
 * re-enters pending (a new potential cycle). Exact path-string match.
 */
function computeOscillation(events: NormalizedEvent[], cfg: Config): number {
  const patterns = cfg.areas.test_cmd_patterns;
  const pending = new Set<string>();
  const failedTestPending = new Set<string>();
  let cycles = 0;

  for (const e of events) {
    if (e.kind !== 'tool_call' || e.tool === null) continue;
    if (e.tool === 'edit') {
      for (const f of e.input_digest.files) {
        if (failedTestPending.has(f)) {
          cycles += 1;
          failedTestPending.delete(f);
        }
        pending.add(f);
      }
    } else if (
      e.tool === 'exec' &&
      e.ok === false &&
      isTestBuildExec(e.input_digest.cmd, patterns)
    ) {
      for (const f of pending) {
        failedTestPending.add(f);
      }
      pending.clear();
    }
  }
  return cycles;
}

/**
 * `(last event t − first event t)` in ms / totalEditedLines, winsorized at the
 * bootstrap threshold. `null` only when no edit lines were produced. Derived
 * from event timestamps only; this can diverge from `envelope.duration_ms`,
 * which the adapter derives from raw record timestamps (first..last record).
 * After the tool_use/result merge a merged tool_call's `t` is the result's
 * timestamp, so the two spans are not guaranteed equal.
 *
 * The value is clamped to `cfg.detector.bootstrap_thresholds.wall_clock_per_line_ms`
 * (issue #33): a near-zero-edit session over a long span yields a raw per-line
 * value in the minutes- or years-per-line range that would single-handedly
 * inflate p90/max and swing the percentile composite / the inherent-complexity
 * cause. Capping bounds that outlier. The cap preserves the bootstrap trip
 * exactly — `raw >= threshold` iff `min(raw, threshold) >= threshold` — so
 * flagging behavior is unchanged; only the magnitude is bounded.
 */
function computeWallClockPerLine(events: NormalizedEvent[], cfg: Config): number | null {
  let totalEditedLines = 0;
  for (const e of events) {
    if (e.kind === 'tool_call' && e.tool === 'edit') {
      totalEditedLines += e.input_digest.lines_changed ?? 0;
    }
  }
  if (totalEditedLines === 0) return null;
  const durationMs = Date.parse(events[events.length - 1].t) - Date.parse(events[0].t);
  const raw = durationMs / totalEditedLines;
  const cap = cfg.detector.bootstrap_thresholds.wall_clock_per_line_ms;
  return Math.min(raw, cap);
}

/** Case-insensitive substring match of any pattern against a scrubbed cmd. */
function isTestBuildExec(cmd: string | null, patterns: string[]): boolean {
  if (cmd === null) return false;
  const lower = cmd.toLowerCase();
  return patterns.some((p) => lower.includes(p.toLowerCase()));
}
