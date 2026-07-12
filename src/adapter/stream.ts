// Streaming transcript reader — the only I/O in the adapter. Reads one .jsonl
// transcript file line-by-line (never slurps the whole file), enforces size
// caps, calls normalizeRecord per parsed line, threads ctx.prevToolCall through
// records in order, merges tool_use + tool_result pairs into single tool_call
// events (see mergeToolCalls), and returns a NormalizedEnvelope + the session's
// representative cwd + warning counts. Fail-open: never throws on bad input
// (malformed/oversized/truncated); skips and counts instead.
//
// Field paths: `cwd` is a top-level string on most user/assistant records
// (confirmed from real transcripts; documented in test/parse.test.ts). We read
// it from the raw parsed record BEFORE normalizeRecord (which does not emit it).

import { createReadStream } from 'node:fs';
import * as readline from 'node:readline';
import * as path from 'node:path';
import type { NormalizedEnvelope, NormalizedEvent, ToolKind, Warnings } from '../types.js';
import { normalizeRecord } from './parse.js';

// --- Caps (verbatim from the task brief) ---
const LINE_CAP = 1_048_576; // 1 MB: lines over this are skipped (oversized_lines++)
const EVENT_CAP = 5000; // once 5000 events collected, drop the rest (truncated)
const BYTE_CAP = 52_428_800; // 50 MB: stop reading once cumulative bytes ≥ this (truncated)

type StreamWarnings = Pick<Warnings, 'malformed_lines' | 'oversized_lines' | 'truncated_sessions'>;

/**
 * Stream one .jsonl transcript → { envelope, cwd, warnings }. Reads line-by-line
 * via node:readline (never slurps). Enforces 1 MB line / 5000 event / 50 MB byte
 * caps. Fail-open: malformed JSON and oversized lines are skipped + counted,
 * never thrown. Deterministic given the file.
 */
export async function streamSession(
  filePath: string,
): Promise<{ envelope: NormalizedEnvelope; cwd: string; warnings: StreamWarnings }> {
  const events: NormalizedEvent[] = [];
  let malformed_lines = 0;
  let oversized_lines = 0;
  let truncated = false;
  let cumulativeBytes = 0;
  let cwd = '';
  // Session span tracked across ALL parsed records (for envelope.duration_ms /
  // started_at), regardless of whether they became kept events. Result records'
  // timestamps are included so the span reflects the full session end-to-end.
  let firstRecordT: number | null = null;
  let firstRecordTs: string | null = null;
  let lastRecordT: number | null = null;
  const ctx: { prevToolCall: { tool: ToolKind } | null } = { prevToolCall: null };

  // session_id = filename stem (basename without the last extension).
  const session_id = path.basename(filePath).replace(/\.[^.]+$/, '');

  try {
    const rl = readline.createInterface({
      input: createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    try {
      for await (const line of rl) {
        // Bytes read for this line (UTF-8) + 1 for the stripped newline.
        const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
        cumulativeBytes += lineBytes;

        if (lineBytes > LINE_CAP) {
          oversized_lines++;
        } else {
          let parsed: unknown;
          let parseOk = true;
          try {
            parsed = JSON.parse(line);
          } catch {
            parseOk = false;
          }
          if (parseOk) {
            if (parsed !== null && typeof parsed === 'object') {
              const rec = parsed as { cwd?: unknown; timestamp?: unknown };
              // Extract cwd from the first record that carries a non-empty one.
              if (cwd === '') {
                const c = rec.cwd;
                if (typeof c === 'string' && c.length > 0) cwd = c;
              }
              // Track session span across ALL parsed records (system records,
              // tool_use, tool_result — regardless of whether they became kept
              // events), so duration_ms reflects the full session.
              const ts = rec.timestamp;
              if (typeof ts === 'string') {
                const ms = Date.parse(ts);
                if (!Number.isNaN(ms)) {
                  if (firstRecordT === null) {
                    firstRecordT = ms;
                    firstRecordTs = ts;
                  }
                  lastRecordT = ms;
                }
              }
            }
            const ev = normalizeRecord(parsed, ctx);
            if (ev !== null) {
              if (events.length < EVENT_CAP) {
                events.push(ev);
                // Thread prevToolCall: the most recent assistant tool_use (non-null
                // tool) is what the next user_msg sees.
                if (ev.kind === 'tool_call' && ev.tool !== null) {
                  ctx.prevToolCall = { tool: ev.tool };
                }
              } else {
                truncated = true;
              }
            }
          } else {
            malformed_lines++;
          }
        }

        // Stop conditions (checked after each line).
        if (events.length >= EVENT_CAP) {
          truncated = true;
          break;
        }
        if (cumulativeBytes >= BYTE_CAP) {
          truncated = true;
          break;
        }
      }
    } finally {
      rl.close();
    }
  } catch {
    // Stream/read error (missing/unreadable file, etc.) — fail open: return
    // whatever was collected so far, no throw.
  }

  // Merge tool_use + tool_result pairs into single tool_call events so downstream
  // signals can see tool + ok on the same event (see mergeToolCalls docs).
  const merged = mergeToolCalls(events);

  const started_at = firstRecordTs ?? (merged.length > 0 ? merged[0]!.t : '');
  const envelope: NormalizedEnvelope = {
    schema_version: 1,
    session_id,
    agent: 'claude-code',
    repo: '',
    started_at,
    duration_ms:
      firstRecordT !== null && lastRecordT !== null ? lastRecordT - firstRecordT : 0,
    events: merged,
    truncated,
    event_count: merged.length,
  };
  return {
    envelope,
    cwd,
    warnings: {
      malformed_lines,
      oversized_lines,
      truncated_sessions: truncated ? 1 : 0,
    },
  };
}

/**
 * Post-process: merge each tool_use + tool_result pair into ONE tool_call event.
 *
 * `normalizeRecord` (pure, single-record) emits two events per tool invocation:
 *   - tool_use    → tool_call (tool !== null, ok=true placeholder, interrupted=false)
 *   - tool_result → tool_call (tool=null, ok=!is_error, interrupted=result)
 * Downstream signals need tool + ok on the SAME event (e.g. failure_streak filters
 * `tool==='exec' && ok===false`). This merge closes that gap.
 *
 * Pairing: each tool_result is paired with the most recent unresolved tool_use
 * (stack — correct for Claude Code's sequential tool_use→result ordering, where
 * each call is immediately followed by its own result). The result's
 * ok/interrupted/duration_ms/t are merged onto the tool_use event; the result
 * event is dropped from the list.
 *
 * Orphan results (no preceding unresolved tool_use) → dropped.
 * Tool_uses with no result (session interrupted before result arrived) → kept
 * with the placeholder ok=true, interrupted=false.
 *
 * Time handling: when paired, the merged event's `t` is set to the RESULT's `t`
 * (not the tool_use's `t`). This keeps the session span correct for the
 * wall_clock_per_line signal (which uses `events[last].t − events[0].t`): the
 * last result's time is preserved on the merged event even though the result
 * event itself is removed. Without this, dropping result events would shrink the
 * computed span. When unpaired (no result), `t` stays the tool_use's time.
 */
function mergeToolCalls(events: NormalizedEvent[]): NormalizedEvent[] {
  const result: NormalizedEvent[] = [];
  // Stack of indices into `result` pointing at unresolved tool_use events.
  const unresolved: number[] = [];

  for (const ev of events) {
    if (ev.kind === 'tool_call' && ev.tool === null) {
      // tool_result event: merge onto the most recent unresolved tool_use.
      const idx = unresolved.pop();
      if (idx === undefined) continue; // orphan result → drop
      const use = result[idx]!;
      result[idx] = {
        ...use,
        ok: ev.ok,
        interrupted: ev.interrupted,
        duration_ms: ev.duration_ms,
        t: ev.t, // result time preserves the session span
      };
    } else {
      result.push(ev);
      if (ev.kind === 'tool_call' && ev.tool !== null) {
        // tool_use event: track for later merging with its result.
        unresolved.push(result.length - 1);
      }
    }
  }
  // Unresolved tool_uses remain with ok=true placeholder, interrupted=false.
  return result;
}
