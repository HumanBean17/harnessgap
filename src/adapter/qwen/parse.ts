// Qwen Code on-disk record parser. Pure function: takes one already-parsed
// JSONL record object (Gemini-style `message.parts[]` carrying `text` /
// `functionCall` / `functionResponse`, plus `system` records with `subtype`:
// `ui_telemetry` / `slash_command` / `attribution_snapshot` /
// `file_history_snapshot`) and returns 0..N intermediate items consumed by the
// Task-5 merge. No I/O, no network. Scrubbing (the existing 7-rule catalog) and
// size caps are reused unchanged via `scrubCmd` / `scrubQuery` / `scrubFiles`.
//
// Field-name constants below were confirmed by inspecting real transcripts at
// ~/.qwen/projects/-Users-dmitry-Desktop-*/chats/*.jsonl (one JSON object per
// line). Behavioral contract pinned to spec §5.3 and the task-4 brief.

import type { InputDigest } from '../../types.js';
import { scrubCmd, scrubFiles, scrubQuery } from '../scrub.js';

// --- Confirmed Qwen record field paths (encoded as constants) ---

const RECORD_TYPE = {
  SYSTEM: 'system',
  USER: 'user',
  ASSISTANT: 'assistant',
  TOOL_RESULT: 'tool_result',
} as const;

const SYSTEM_SUBTYPE = {
  UI_TELEMETRY: 'ui_telemetry',
} as const;

const UI_EVENT_NAME = {
  TOOL_CALL: 'qwen-code.tool_call',
  API_ERROR: 'qwen-code.api_error',
} as const;

const ERROR_TYPE = {
  USER_ABORT: 'APIUserAbortError',
} as const;

const TOOL_STATUS = {
  SUCCESS: 'success',
} as const;

// tool-name → inputDigest extraction is keyed off these literal Qwen tool names.
const QWEN_TOOL = {
  READ_FILE: 'read_file',
  LIST_DIRECTORY: 'list_directory',
  EDIT: 'edit',
  WRITE_FILE: 'write_file',
  RUN_SHELL_COMMAND: 'run_shell_command',
  GREP_SEARCH: 'grep_search',
  GLOB: 'glob',
} as const;

// --- Exported intermediate-item union (consumed by Task 5's merge) ---
//
// NOTE: `argsKey` is carried on BOTH `tool_call` and `telemetry_tool` so the
// merge can match a telemetry record to its originating call by stable args
// serialization (see `stableArgsKey` below). The union listing in the task
// brief showed `argsKey` only on `telemetry_tool`; the brief's Step-1 case 6
// and the dispatcher's clarifying note both require it on `tool_call` too.

export type QwenParsedItem =
  | { kind: 'user_msg'; text: string; t: string; cwd: string }
  | { kind: 'assistant_msg'; text: string; t: string; cwd: string }
  | {
      kind: 'tool_call';
      callId: string;
      toolName: string;
      argsKey: string;
      inputDigest: InputDigest;
      t: string;
      cwd: string;
    }
  | { kind: 'tool_result'; callId: string; ok: boolean; t: string }
  | {
      kind: 'telemetry_tool';
      toolName: string;
      argsKey: string;
      durationMs: number;
      success: boolean;
      t: string;
    }
  | { kind: 'interrupt'; t: string };

// --- Typed views of a parsed JSONL record (only the fields we read) ---

interface QwenPart {
  text?: string;
  thought?: boolean;
  functionCall?: {
    id?: string;
    name?: string;
    args?: Record<string, unknown> | null;
  };
  functionResponse?: unknown;
}

interface QwenMessage {
  role?: string;
  parts?: QwenPart[];
}

interface QwenUiEvent {
  'event.name'?: string;
  function_name?: string;
  function_args?: Record<string, unknown> | null;
  duration_ms?: number;
  success?: boolean;
  error_type?: string;
}

interface QwenSystemPayload {
  uiEvent?: QwenUiEvent;
}

interface QwenToolCallResult {
  callId?: string;
  status?: string;
}

interface QwenRecord {
  type?: string;
  subtype?: string;
  timestamp?: string;
  cwd?: string;
  message?: QwenMessage;
  systemPayload?: QwenSystemPayload;
  toolCallResult?: QwenToolCallResult;
}

// --- Helpers (module-private; only parseQwenRecord is exported) ---

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Deterministic JSON serialization of an `args`-shaped value: object keys are
 * sorted recursively, arrays preserve order, primitives pass through `JSON
 * .stringify`. Both `functionCall.args` and `uiEvent.function_args` run through
 * this — so two records carrying the same args (in any key order) produce the
 * SAME `argsKey`, which is the contract the Task-5 merge matches on. The merge
 * never inspects the args values; only the key string is compared.
 */
function stableArgsKey(args: unknown): string {
  return serialize(args);
  function serialize(v: unknown): string {
    if (Array.isArray(v)) return '[' + v.map(serialize).join(',') + ']';
    if (isObject(v)) {
      const keys = Object.keys(v).sort();
      return '{' + keys.map((k) => `${JSON.stringify(k)}:${serialize(v[k])}`).join(',') + '}';
    }
    return JSON.stringify(v);
  }
}

function emptyDigest(): InputDigest {
  return { files: [], cmd: null, query: null, lines_changed: null };
}

/** Count `\n`-separated lines of the "new content" of an edit / write (>=0). */
function countLines(s: unknown): number {
  if (typeof s !== 'string' || s === '') return 0;
  return s.split('\n').length;
}

/**
 * Build the InputDigest for a Qwen tool call per spec §5.3's table. Extracted
 * strings pass through the existing scrubbers. `cmd`/`query`/`lines_changed`
 * are `null` when absent; `files` is `[]` when absent. Unknown tools → empty
 * digest.
 */
function digestForTool(
  toolName: string,
  args: Record<string, unknown>,
): InputDigest {
  switch (toolName) {
    case QWEN_TOOL.READ_FILE:
    case QWEN_TOOL.EDIT:
    case QWEN_TOOL.WRITE_FILE: {
      const fp = args.file_path;
      const files = typeof fp === 'string' ? scrubFiles([fp]) : [];
      const digest: InputDigest = { files, cmd: null, query: null, lines_changed: null };
      if (toolName === QWEN_TOOL.EDIT) {
        digest.lines_changed = countLines(args.new_string);
      } else if (toolName === QWEN_TOOL.WRITE_FILE) {
        digest.lines_changed = countLines(args.content);
      }
      return digest;
    }
    case QWEN_TOOL.LIST_DIRECTORY: {
      const p = args.path;
      return {
        files: typeof p === 'string' ? scrubFiles([p]) : [],
        cmd: null,
        query: null,
        lines_changed: null,
      };
    }
    case QWEN_TOOL.RUN_SHELL_COMMAND: {
      const cmd = args.command;
      return {
        files: [],
        cmd: typeof cmd === 'string' ? scrubCmd(cmd) : null,
        query: null,
        lines_changed: null,
      };
    }
    case QWEN_TOOL.GREP_SEARCH:
    case QWEN_TOOL.GLOB: {
      const q = args.pattern;
      return {
        files: [],
        cmd: null,
        query: typeof q === 'string' ? scrubQuery(q) : null,
        lines_changed: null,
      };
    }
    default:
      return emptyDigest();
  }
}

// --- Public API ---

/**
 * Convert one parsed Qwen Code JSONL record into 0..N intermediate items, or
 * return `[]` for malformed / non-object input (never throws). Mapping per
 * spec §5.3 and the task-4 brief:
 *
 *   - system + ui_telemetry + qwen-code.tool_call   → telemetry_tool
 *   - system + ui_telemetry + qwen-code.api_error   → interrupt (only on
 *                                                       error_type === 'APIUserAbortError')
 *   - system (any other subtype)                    → ignored
 *   - user with text parts (no functionResponse)    → one user_msg per text part
 *   - user carrying functionResponse                → result carrier, no user_msg
 *   - assistant text part (thought !== true)        → assistant_msg
 *   - assistant functionCall part                   → tool_call
 *   - tool_result                                   → tool_result (ok = status==='success')
 *   - anything else / malformed                     → []
 *
 * No raw prose is emitted beyond what the union contract carries (user/assistant
 * text is retained on the intermediate item; the Task-5 merge consumes it for
 * correction detection and discards it before the final NormalizedEvent, which
 * never carries prose).
 */
export function parseQwenRecord(raw: unknown): QwenParsedItem[] {
  if (!isObject(raw)) return [];
  const rec = raw as QwenRecord;
  const type = typeof rec.type === 'string' ? rec.type : '';
  const subtype = typeof rec.subtype === 'string' ? rec.subtype : '';
  const t = typeof rec.timestamp === 'string' ? rec.timestamp : '';
  const cwd = typeof rec.cwd === 'string' ? rec.cwd : '';

  if (type === RECORD_TYPE.SYSTEM) {
    if (subtype !== SYSTEM_SUBTYPE.UI_TELEMETRY) return [];
    const ui = rec.systemPayload?.uiEvent;
    if (!isObject(ui)) return [];
    const name = typeof ui['event.name'] === 'string' ? ui['event.name'] : '';
    if (name === UI_EVENT_NAME.TOOL_CALL) {
      const toolName = typeof ui.function_name === 'string' ? ui.function_name : '';
      const argsKey = stableArgsKey(ui.function_args ?? null);
      const durationMs = typeof ui.duration_ms === 'number' ? ui.duration_ms : 0;
      const success = ui.success === true;
      return [{ kind: 'telemetry_tool', toolName, argsKey, durationMs, success, t }];
    }
    if (name === UI_EVENT_NAME.API_ERROR) {
      if (ui.error_type === ERROR_TYPE.USER_ABORT) return [{ kind: 'interrupt', t }];
      return [];
    }
    return [];
  }

  if (type === RECORD_TYPE.USER) {
    const parts = rec.message?.parts;
    if (!Array.isArray(parts)) return [];
    // A user record carrying any functionResponse is a tool-result carrier,
    // not a user message — skip emitting user_msg for it.
    if (parts.some((p) => p != null && typeof p === 'object' && 'functionResponse' in p)) {
      return [];
    }
    const items: QwenParsedItem[] = [];
    for (const p of parts) {
      if (p != null && typeof p === 'object' && typeof p.text === 'string') {
        items.push({ kind: 'user_msg', text: p.text, t, cwd });
      }
    }
    return items;
  }

  if (type === RECORD_TYPE.ASSISTANT) {
    const parts = rec.message?.parts;
    if (!Array.isArray(parts)) return [];
    const items: QwenParsedItem[] = [];
    for (const p of parts) {
      if (p == null || typeof p !== 'object') continue;
      if (p.functionCall && typeof p.functionCall === 'object') {
        const fc = p.functionCall;
        const callId = typeof fc.id === 'string' ? fc.id : '';
        const toolName = typeof fc.name === 'string' ? fc.name : '';
        const args = isObject(fc.args) ? fc.args : {};
        const argsKey = stableArgsKey(args);
        const inputDigest = digestForTool(toolName, args);
        items.push({ kind: 'tool_call', callId, toolName, argsKey, inputDigest, t, cwd });
      } else if (typeof p.text === 'string' && p.thought !== true) {
        items.push({ kind: 'assistant_msg', text: p.text, t, cwd });
      }
    }
    return items;
  }

  if (type === RECORD_TYPE.TOOL_RESULT) {
    const tcr = rec.toolCallResult;
    if (!isObject(tcr)) return [];
    const callId = typeof tcr.callId === 'string' ? (tcr.callId as string) : '';
    const ok = tcr.status === TOOL_STATUS.SUCCESS;
    return [{ kind: 'tool_result', callId, ok, t }];
  }

  return [];
}
