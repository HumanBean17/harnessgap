// Streaming transcript reader — the only I/O in the adapter. Reads one .jsonl
// transcript file line-by-line (never slurps the whole file), enforces size
// caps, calls normalizeRecord per parsed line, threads ctx.prevToolCall through
// records in order, and returns a NormalizedEnvelope + the session's
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
            // Extract cwd from the first record that carries a non-empty one.
            if (cwd === '' && parsed !== null && typeof parsed === 'object') {
              const c = (parsed as { cwd?: unknown }).cwd;
              if (typeof c === 'string' && c.length > 0) cwd = c;
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

  const started_at = events.length > 0 ? events[0]!.t : '';
  const envelope: NormalizedEnvelope = {
    schema_version: 1,
    session_id,
    agent: 'claude-code',
    repo: '',
    started_at,
    duration_ms: computeDurationMs(events),
    events,
    truncated,
    event_count: events.length,
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

/** duration_ms = last kept t − first kept t (parsed as ISO ms). 0 if <2 events or unparseable. */
function computeDurationMs(events: NormalizedEvent[]): number {
  if (events.length < 2) return 0;
  const first = Date.parse(events[0]!.t);
  const last = Date.parse(events[events.length - 1]!.t);
  if (Number.isNaN(first) || Number.isNaN(last)) return 0;
  return last - first;
}
