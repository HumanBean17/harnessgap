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
//     Parallel calls (multiple functionCall parts in one assistant turn — common
//     in real Qwen transcripts) resolve INDEPENDENTLY by callId; the argsKey
//     disambiguates same-tool calls within a turn.
//
//   - streamQwenSession(filePath): NormalizedEnvelope  — I/O: readline + size
//     caps + envelope assembly. Reuses the SAME cap values as Claude's
//     streamSession (1 MB line / 5000 events / 50 MB file). The emitted envelope
//     is shape-indistinguishable from a Claude session's, so the detector
//     remains harness-agnostic. `agent` is pinned to the literal `'qwen-code'`
//     here; the Task-7 dispatcher stamps gigacode separately.
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
  // Interrupt taint: set by an `interrupt` item, cleared by the next user_msg.
  // A tool_call inherits the current flag — i.e., an interrupt marks all
  // SUBSEQUENT tool_calls as interrupted until the user re-engages. This matches
  // the real Qwen shape (the api_error abort fires between assistant turns) and
  // the task-5 brief's scenario 4 (interrupt at index 2 → call_B at index 3 is
  // interrupted; call_A at index 0 is not). The brief's prose wording ("at or
  // after this tool_call") is inverted relative to the scenario; the scenario
  // is treated as authoritative.
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
      const duration_ms = findDurationForCall(items, i, item.toolName, item.argsKey);
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
 * Find the durationMs of the first telemetry_tool AFTER index `i` whose
 * (toolName, argsKey) matches this call. Returns 0 if none. The contract pins
 * (toolName, argsKey) as the authority for duration, scanning forward only —
 * matches the real-data interleaving (call → telemetry, in that order).
 */
function findDurationForCall(
  items: QwenParsedItem[],
  i: number,
  toolName: string,
  argsKey: string,
): number {
  for (let j = i + 1; j < items.length; j++) {
    const it = items[j]!;
    if (
      it.kind === 'telemetry_tool' &&
      it.toolName === toolName &&
      it.argsKey === argsKey
    ) {
      return it.durationMs;
    }
  }
  return 0;
}

// --- streamQwenSession (I/O) ---

/**
 * Stream one Qwen Code .jsonl transcript → NormalizedEnvelope. Reads line-by-line
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
 * `cwd` is extracted (first record carrying it, else the sibling
 * `<sessionId>.runtime.json` `work_dir`, else '') per the brief. The extracted
 * value is NOT surfaced on the envelope (NormalizedEnvelope has no cwd field);
 * the read is performed for contract fidelity and forward-looking use by the
 * Task-7 dispatcher.
 */
export async function streamQwenSession(filePath: string): Promise<NormalizedEnvelope> {
  const session_id = path.basename(filePath).replace(/\.[^.]+$/, '');
  const items: QwenParsedItem[] = [];
  let oversized_lines = 0;
  let malformed_lines = 0;
  let truncated = false;
  let cumulativeBytes = 0;
  let cwd = '';
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
              const c = rec.cwd;
              if (typeof c === 'string' && c.length > 0 && cwd === '') cwd = c;
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
  // extracted value is not surfaced on the envelope (NormalizedEnvelope has no
  // cwd field); this satisfies the contract for the Task-7 dispatcher, which
  // will re-extract cwd when assembling its own context.
  if (cwd === '') {
    try {
      const runtimePath = path.join(
        path.dirname(filePath),
        `${session_id}.runtime.json`,
      );
      const content = readFileSync(runtimePath, 'utf8');
      const rt = JSON.parse(content) as { work_dir?: unknown };
      if (typeof rt.work_dir === 'string') cwd = rt.work_dir;
    } catch {
      // No runtime.json or malformed — leave cwd as ''.
    }
  }
  void cwd; // not surfaced at this layer; consumed by the dispatcher (Task 7).
  void malformed_lines; // counted for parity with Claude; not surfaced here.

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
  return envelope;
}
