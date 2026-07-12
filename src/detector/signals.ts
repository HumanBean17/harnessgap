// Pure detector signal computation. Task 9 implements four of the seven
// SignalValues fields; the remaining three are stubbed and overwritten by
// Task 10. Each field is computed by a small named helper so Task 10 can
// swap implementations without touching the others.

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
    // Stubs — Task 10 overwrites these.
    abandonment: false,
    oscillation: 0,
    wall_clock_per_line_ms: null,
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
