// Qwen Code transcript stream + merge — Task 5 of the Qwen+GigaCode slice.
//
// Two exports:
//   - mergeQwenItems(items, meta): NormalizedEvent[]  — PURE. Assembles parsed
//     Qwen items into harness-agnostic NormalizedEvents per the matching
//     contract pinned in the task-5 brief:
//       * tool_call.ok          : callId-matched tool_result authority (true iff
//                                 a matching result has ok:true; false if the
//                                 matching result is ok:false OR no match).
//       * tool_call.duration_ms : (toolName, argsKey)-matched telemetry_tool
//                                 authority, searching items AFTER the call
//                                 (0 if none).
//       * tool_call.interrupted : true if an interrupt item occurs BEFORE this
//                                 call (and after the most recent user_msg);
//                                 the interrupt taints subsequent calls until
//                                 the next user_msg clears it.
//       * user_msg / assistant_msg : empty input_digest, ok:true, duration_ms:0.
//     Resolution precision: `ok` resolves INDEPENDENTLY by callId (each call
//     finds its own result). `duration_ms` resolves by `(toolName, argsKey)`
//     with consumption tracking — multiple calls sharing the same
//     `(toolName, argsKey)` (e.g., two read_file calls with identical args but
//     distinct callIds in one turn) pair to DISTINCT telemetry items in
//     encounter order; calls with different `(toolName, argsKey)` consume from
//     their own group.
//
//   - streamQwenSession(filePath): StreamResult  — I/O: readline + size
//     caps + envelope assembly. Reuses the SAME cap values as Claude's
//     streamSession (1 MB line / 5000 events / 50 MB file). The emitted
//     envelope is shape-indistinguishable from a Claude session's, so the
//     detector remains harness-agnostic. `agent` is pinned to the literal
//     `'qwen-code'` here; the Task-7 dispatcher stamps gigacode separately.
//     Returns the same `StreamResult` shape as Claude's `streamSession`
//     ({envelope, cwd, cwds, warnings}) so the pipeline (Task 10) can program
//     against `spec.streamSession` uniformly across harnesses.
//
// Privacy: scrubbing already happened in the parser (Task 4); the merge consumes
// user_msg/assistant_msg text for correction detection only and does NOT emit
// the text — NormalizedEvent carries no prose.
//
// No network, no detection-path writes, no git, no new runtime deps.

import { createReadStream, readFileSync } from 'node:fs';
import * as readline from 'node:readline';
import * as path from 'node:path';
import type {
  Correction,
  InputDigest,
  NormalizedEnvelope,
  NormalizedEvent,
  StreamResult,
  ToolKind,
} from '../../types.js';
import { detectCorrection } from '../correction.js';
import { parseQwenRecord, type QwenParsedItem } from './parse.js';
import { mapQwenToolKind } from './taxonomy.js';

// --- Caps (verbatim values, reused from src/adapter/stream.ts) ---

const LINE_CAP = 1_048_576; // 1 MB: lines over this are skipped (oversized++).
const EVENT_CAP = 5000; // once 5000 events worth of items collected, drop rest.
const BYTE_CAP = 52_428_800; // 50 MB: stop reading once cumulative bytes >= this.

interface MergeMeta {
  session_id: string;
  started_at: string;
  duration_ms: number;
}

const EMPTY_DIGEST: InputDigest = {
  files: [],
  cmd: null,
  query: null,
  lines_changed: null,
};

// --- mergeQwenItems (pure) ---

/**
 * Assemble parsed Qwen items into NormalizedEvents per the matching contract.
 * See the file-level docstring for the contract. `meta` carries session-level
 * data (currently unused by the merge — NormalizedEvent has no session_id /
 * started_at fields — but required by the brief for symmetry with future uses).
 */
export function mergeQwenItems(
  items: QwenParsedItem[],
  meta: MergeMeta,
): NormalizedEvent[] {
  void meta; // session-level metadata, not used in event construction.
  const events: NormalizedEvent[] = [];
  // Most-recent tool_call tool seen before the next user_msg — threaded into
  // detectCorrection exactly as Claude's parser threads prevToolCall.
  let prevTool: { tool: ToolKind } | null = null;
  // Indices of telemetry_tool items already bound to a tool_call's duration, so
  // that two calls sharing `(toolName, argsKey)` pair to DISTINCT telemetries
  // in encounter order (first call → first telemetry, second call → second).
  // See findDurationForCall.
  const consumedTelemetry = new Set<number>();
  // Interrupt taint: set by an `interrupt` item, cleared by the next user_msg.
  // A tool_call inherits the current flag — i.e., an interrupt marks all
  // SUBSEQUENT tool_calls as interrupted until the user re-engages. This matches
  // the real Qwen shape (the api_error abort fires between assistant turns) and
  // the task-5 brief's scenario 4 (interrupt at index 2 → call_B at index 3 is
  // interrupted; call_A at index 0 is not). The brief's prose wording ("at or
  // after this tool_call") is inverted relative to the scenario; the scenario
  // is treated as authoritative.
  //
  // ADJUDICATION (review round 1): `NormalizedEvent.interrupted` is currently
  // NOT read by any detector signal (`grep -rn "\\.interrupted" src/detector/`
  // is empty; `abandonment` is computed from explore/edit tail patterns in
  // src/detector/signals.ts, not from this field) — the field is set here for
  // schema completeness only, so the current forward-taint reading has zero
  // output impact. The forward-taint mechanism is preserved unchanged and
  // matches test/qwen-stream.test.ts scenario 4. The correct semantic for
  // Qwen's turn-level aborts is deferred as an open question (spec §11:
  // "User interrupts may not be recorded in transcripts ... the interrupt
  // channel is best-effort"). Do not alter the forward-taint logic without
  // revisiting the detector's consumption of this field.
  let interruptedFlag = false;

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (item.kind === 'user_msg') {
      interruptedFlag = false; // clear on user_msg boundary
      const correction: Correction = detectCorrection(prevTool, item.text);
      events.push({
        t: item.t,
        kind: 'user_msg',
        tool: null,
        input_digest: EMPTY_DIGEST,
        ok: true,
        interrupted: false,
        duration_ms: 0,
        correction,
      });
      continue;
    }
    if (item.kind === 'assistant_msg') {
      events.push({
        t: item.t,
        kind: 'assistant_msg',
        tool: null,
        input_digest: EMPTY_DIGEST,
        ok: true,
        interrupted: false,
        duration_ms: 0,
        correction: null,
      });
      continue;
    }
    if (item.kind === 'tool_call') {
      const tool = mapQwenToolKind(item.toolName);
      const ok = findOkForCall(items, item.callId);
      const duration_ms = findDurationForCall(
        items,
        i,
        item.toolName,
        item.argsKey,
        consumedTelemetry,
      );
      events.push({
        t: item.t,
        kind: 'tool_call',
        tool,
        input_digest: item.inputDigest,
        ok,
        interrupted: interruptedFlag,
        duration_ms,
        correction: null,
      });
      prevTool = { tool };
      continue;
    }
    if (item.kind === 'interrupt') {
      interruptedFlag = true;
      continue;
    }
    // tool_result / telemetry_tool items are merge inputs only; they do not
    // produce NormalizedEvents directly.
  }
  return events;
}

/**
 * Scan all items for a tool_result with matching callId. Returns its `ok` value,
 * or false if none exists (unresolved → not-ok per the contract). The contract
 * pins callId as the authority for ok.
 */
function findOkForCall(items: QwenParsedItem[], callId: string): boolean {
  for (const it of items) {
    if (it.kind === 'tool_result' && it.callId === callId) return it.ok;
  }
  return false;
}

/**
 * Find the durationMs of the first UNCONSUMED telemetry_tool AFTER index `i`
 * whose (toolName, argsKey) matches this call; mark it consumed so the next
 * call with the same (toolName, argsKey) binds to the subsequent telemetry.
 * Returns 0 if none. The contract pins (toolName, argsKey) as the authority
 * for duration, scanning forward only — matches the real-data interleaving
 * (call → telemetry, in that order). Consumption tracking is what makes two
 * identical-args calls pair to DISTINCT telemetries in order rather than both
 * binding to the first.
 */
function findDurationForCall(
  items: QwenParsedItem[],
  i: number,
  toolName: string,
  argsKey: string,
  consumedTelemetry: Set<number>,
): number {
  for (let j = i + 1; j < items.length; j++) {
    if (consumedTelemetry.has(j)) continue;
    const it = items[j]!;
    if (
      it.kind === 'telemetry_tool' &&
      it.toolName === toolName &&
      it.argsKey === argsKey
    ) {
      consumedTelemetry.add(j);
      return it.durationMs;
    }
  }
  return 0;
}

// --- streamQwenSession (I/O) ---

/**
 * Stream one Qwen Code .jsonl transcript → StreamResult. Reads line-by-line
 * via node:readline (never slurps). Enforces the SAME cap values as Claude's
 * streamSession (1 MB line / 5000 events / 50 MB file). Fail-open: malformed
 * JSON lines are silently skipped; oversized lines are skipped+counted; never
 * throws on bad input.
 *
 * `truncated` is flagged true when ANY data was dropped (an oversized line, the
 * 5000-event cap, or the 50 MB byte cap). This is a deliberate divergence from
 * Claude's streamSession, which only flags event/byte cap: a Qwen session with
 * a dropped oversized line has still lost data, which downstream signals must
 * be able to see. The detector already treats `truncated` as a confidence damp.
 *
 * Returns the SAME `StreamResult` shape as Claude's `streamSession`
 * ({envelope, cwd, cwds, warnings}) so the pipeline (Task 10) can program
 * against `spec.streamSession` uniformly:
 *  - `cwd` is the first record carrying it, else the sibling
 *    `<sessionId>.runtime.json` `work_dir`, else ''.
 *  - `cwds` is the distinct set of cwds seen across records (deduped,
 *    first-seen order), mirroring Claude's collection. When only the
 *    runtime.json fallback resolves a cwd, that value is the sole cwds entry.
 *  - `warnings` carries the per-session counters Qwen already tracks
 *    (`malformed_lines`, `oversized_lines`, `truncated_sessions`); the
 *    remaining `Warnings` fields are pipeline-level aggregates the caller
 *    computes across the whole scan, not per-file.
 */
export async function streamQwenSession(filePath: string): Promise<StreamResult> {
  const session_id = path.basename(filePath).replace(/\.[^.]+$/, '');
  const items: QwenParsedItem[] = [];
  let oversized_lines = 0;
  let malformed_lines = 0;
  let truncated = false;
  let cumulativeBytes = 0;
  let cwd = '';
  // Distinct cwds seen across records, in first-seen order — mirrors Claude's
  // streamSession. The pipeline tries each for repo/worktree resolution so a
  // session that started in a live dir and later moved into a since-deleted
  // worktree still resolves.
  const cwds: string[] = [];
  // Session span tracked across ALL parsed records (not just items that became
  // events), exactly mirroring Claude's streamSession. Used for envelope
  // started_at / duration_ms.
  let firstRecordT: number | null = null;
  let firstRecordTs: string | null = null;
  let lastRecordT: number | null = null;
  // Approximate event count, incremented for each item kind that produces a
  // NormalizedEvent (user_msg / assistant_msg / tool_call). Used to enforce the
  // 5000-event cap BEFORE the merge (items → events is 1:1 for these kinds, so
  // the count is exact — not an approximation).
  let projectedEventCount = 0;

  try {
    const rl = readline.createInterface({
      input: createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    try {
      for await (const line of rl) {
        // Bytes for this line (UTF-8) + 1 for the stripped newline — counted
        // BEFORE the size check, so an oversized line still consumes its byte
        // budget (mirrors Claude's streamSession).
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
              // Collect EVERY distinct non-empty cwd across records (mirrors
              // Claude's streamSession). The representative `cwd` (first one)
              // preserves the old contract; the full `cwds` list lets the
              // pipeline recover a repo when the representative points at a
              // since-deleted worktree.
              const c = rec.cwd;
              if (typeof c === 'string' && c.length > 0) {
                if (cwd === '') cwd = c;
                if (!cwds.includes(c)) cwds.push(c);
              }
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
            // parseQwenRecord returns [] for non-object / malformed input;
            // it never throws.
            const recItems = parseQwenRecord(parsed);
            for (const it of recItems) {
              if (projectedEventCount >= EVENT_CAP) {
                truncated = true;
                break;
              }
              items.push(it);
              if (
                it.kind === 'user_msg' ||
                it.kind === 'assistant_msg' ||
                it.kind === 'tool_call'
              ) {
                projectedEventCount++;
              }
            }
          } else {
            malformed_lines++;
          }
        }

        // Stop conditions (checked after each line) — mirror Claude's streamSession.
        if (projectedEventCount >= EVENT_CAP) {
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

  // Qwen-specific truncation rule: an oversized line means data was dropped.
  // The detector treats `truncated` as a confidence damp; flagging it here
  // surfaces the data loss rather than silently undercounting the session.
  if (oversized_lines > 0) truncated = true;

  // runtime.json work_dir fallback — only when no record carried cwd. The
  // resolved value is also pushed into `cwds` so cwd === cwds[0] invariant
  // holds (the pipeline treats cwds.length === 0 as unresolvable; without this
  // push, a session whose cwd was recovered only via runtime.json would be
  // miscategorized as unresolved).
  if (cwd === '') {
    try {
      const runtimePath = path.join(
        path.dirname(filePath),
        `${session_id}.runtime.json`,
      );
      const content = readFileSync(runtimePath, 'utf8');
      const rt = JSON.parse(content) as { work_dir?: unknown };
      if (typeof rt.work_dir === 'string') {
        cwd = rt.work_dir;
        cwds.push(cwd);
      }
    } catch {
      // No runtime.json or malformed — leave cwd as ''.
    }
  }

  const started_at = firstRecordTs ?? '';
  const duration_ms =
    firstRecordT !== null && lastRecordT !== null ? lastRecordT - firstRecordT : 0;

  const events = mergeQwenItems(items, {
    session_id,
    started_at,
    duration_ms,
  });

  const envelope: NormalizedEnvelope = {
    schema_version: 1,
    session_id,
    agent: 'qwen-code',
    repo: '',
    started_at,
    duration_ms,
    events,
    truncated,
    event_count: events.length,
  };
  return {
    envelope,
    cwd,
    cwds,
    warnings: {
      malformed_lines,
      oversized_lines,
      truncated_sessions: truncated ? 1 : 0,
    },
  };
}
