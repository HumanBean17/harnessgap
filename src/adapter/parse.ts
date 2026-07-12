// Claude Code transcript-record normalizer. Pure function: takes one already-
// parsed JSONL record object and returns a NormalizedEvent (or null when the
// record carries no usable event). No I/O, no network. Scrubbing, caps, and the
// correction flag are applied here so downstream stages never see raw prose.
//
// Field-name constants below were confirmed by inspecting real transcripts at
// ~/.claude/projects/-Users-dmitry-Desktop-CursorProjects-harnessgap/*.jsonl
// (one JSON object per line). Behavioral contract is pinned to the task-5 brief
// regardless of upstream schema drift.

import type { InputDigest, NormalizedEvent, ToolKind } from '../types.js';
import { scrubCmd, scrubFiles, scrubQuery } from './scrub.js';
import { detectCorrection } from './correction.js';
import { mapToolKind } from './taxonomy.js';

// --- Confirmed Claude Code transcript field paths (encoded as constants) ---

const RECORD_TYPE = {
  USER: 'user',
  ASSISTANT: 'assistant',
} as const;

const FIELD = {
  TYPE: 'type',
  MESSAGE: 'message',
  CONTENT: 'content',
  TIMESTAMP: 'timestamp',
  DURATION_MS: 'duration_ms',
} as const;

const CONTENT_TYPE = {
  TOOL_USE: 'tool_use',
  TEXT: 'text',
  TOOL_RESULT: 'tool_result',
} as const;

// Tool-use input field names (confirmed: Bash.command, Read.file_path,
// Edit.{file_path,old_string,new_string}, Write.{file_path,content},
// Grep/Glob.pattern, LS.path).
const TOOL_INPUT = {
  COMMAND: 'command',
  FILE_PATH: 'file_path',
  PATH: 'path',
  FILES: 'files',
  PATTERN: 'pattern',
  OLD_STRING: 'old_string',
  NEW_STRING: 'new_string',
  CONTENT: 'content',
} as const;

// tool_result content-item field names (confirmed: is_error present on real
// records; interrupted absent in sample but part of the contract — default false).
const RESULT_FIELD = {
  IS_ERROR: 'is_error',
  INTERRUPTED: 'interrupted',
} as const;

// --- Typed view of a parsed JSONL record (only the fields we read) ---

interface ContentItem {
  type?: string;
  name?: string;
  input?: Record<string, unknown>;
  text?: string;
  is_error?: boolean;
  interrupted?: boolean;
}

interface TranscriptMessage {
  role?: string;
  content?: string | ContentItem[];
}

interface TranscriptRecord {
  type?: string;
  timestamp?: string;
  message?: TranscriptMessage;
  duration_ms?: number;
}

// --- Helpers (module-private; only normalizeRecord is exported) ---

function emptyDigest(): InputDigest {
  return { files: [], cmd: null, query: null, lines_changed: null };
}

function findContentItem(content: unknown, type: string): ContentItem | null {
  if (!Array.isArray(content)) return null;
  for (const item of content) {
    if (item && typeof item === 'object' && (item as ContentItem).type === type) {
      return item as ContentItem;
    }
  }
  return null;
}

/** Extract user/assistant prose text from a message content field. */
function extractText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') {
        const ci = item as ContentItem;
        if (ci.type === CONTENT_TYPE.TEXT && typeof ci.text === 'string') return ci.text;
      }
    }
  }
  return null;
}

/**
 * Extract file paths from a tool-use input. If `input.files` is a non-empty
 * array of strings, use it (multi-file case); otherwise collect the single
 * `file_path` / `path` fields present.
 */
function extractPaths(input: Record<string, unknown>): string[] {
  const filesRaw = input[TOOL_INPUT.FILES];
  if (Array.isArray(filesRaw)) {
    const files = filesRaw.filter((f): f is string => typeof f === 'string');
    if (files.length > 0) return files;
  }
  const paths: string[] = [];
  const fp = input[TOOL_INPUT.FILE_PATH];
  if (typeof fp === 'string') paths.push(fp);
  const p = input[TOOL_INPUT.PATH];
  if (typeof p === 'string') paths.push(p);
  return paths;
}

/**
 * Count lines in the "new content" of an edit, as a proxy for the amount of
 * code touched (feeds explore_ratio and wall_clock_per_line). For Edit →
 * new_string; for Write/NotebookEdit → content. Counts `\n`-separated lines;
 * returns 0 if the field is absent or empty. A consistent "amount of new code"
 * proxy is what matters downstream.
 */
function countNewLines(input: Record<string, unknown>): number {
  const ns = input[TOOL_INPUT.NEW_STRING];
  const s =
    typeof ns === 'string'
      ? ns
      : typeof input[TOOL_INPUT.CONTENT] === 'string'
        ? (input[TOOL_INPUT.CONTENT] as string)
        : null;
  if (s === null || s === '') return 0;
  return s.split('\n').length;
}

/** Build the InputDigest for a tool_use event based on its ToolKind. */
function digestForTool(tool: ToolKind, input: Record<string, unknown>): InputDigest {
  switch (tool) {
    case 'exec': {
      const cmd = input[TOOL_INPUT.COMMAND];
      return {
        files: [],
        cmd: scrubCmd(typeof cmd === 'string' ? cmd : ''),
        query: null,
        lines_changed: null,
      };
    }
    case 'read':
    case 'list':
      return {
        files: scrubFiles(extractPaths(input)),
        cmd: null,
        query: null,
        lines_changed: null,
      };
    case 'edit':
      return {
        files: scrubFiles(extractPaths(input)),
        cmd: null,
        query: null,
        lines_changed: countNewLines(input),
      };
    case 'search': {
      const pattern = input[TOOL_INPUT.PATTERN];
      return {
        files: [],
        cmd: null,
        query: scrubQuery(typeof pattern === 'string' ? pattern : ''),
        lines_changed: null,
      };
    }
    case 'other':
    default:
      return emptyDigest();
  }
}

function isRecord(raw: unknown): raw is TranscriptRecord {
  return raw !== null && typeof raw === 'object';
}

// --- Public API ---

/**
 * Convert one parsed Claude Code JSONL record into a NormalizedEvent, or return
 * null when the record carries no usable event (system entries, ai-title, etc.).
 *
 * Mapping:
 *   - assistant tool_use      → tool_call (tool + digest from input; ok=true)
 *   - user-record tool_result → tool_call (tool=null; ok=!is_error; interrupted)
 *   - user text               → user_msg (correction via detectCorrection; no raw text)
 *   - assistant text          → assistant_msg
 *   - anything else           → null
 *
 * `ctx.prevToolCall` is passed to detectCorrection for user messages; it is NOT
 * mutated here (the stream layer updates it between records). No raw prose is
 * emitted: userText is consumed by detectCorrection and discarded.
 */
export function normalizeRecord(
  raw: unknown,
  ctx: { prevToolCall: { tool: ToolKind } | null },
): NormalizedEvent | null {
  if (!isRecord(raw)) return null;
  const rec: TranscriptRecord = raw;
  const t = typeof rec[FIELD.TIMESTAMP] === 'string' ? rec[FIELD.TIMESTAMP]! : '';
  const duration_ms =
    typeof rec[FIELD.DURATION_MS] === 'number' ? rec[FIELD.DURATION_MS]! : 0;
  const msg = rec[FIELD.MESSAGE];

  // --- User record: may carry a tool_result (nested) or plain text ---
  if (rec[FIELD.TYPE] === RECORD_TYPE.USER && msg && typeof msg === 'object') {
    const content = msg[FIELD.CONTENT];

    // tool_result nested in a user message → tool_call result event.
    const toolResult = findContentItem(content, CONTENT_TYPE.TOOL_RESULT);
    if (toolResult) {
      return {
        t,
        kind: 'tool_call',
        tool: null, // result records carry no tool name
        input_digest: emptyDigest(),
        ok: toolResult[RESULT_FIELD.IS_ERROR] !== true,
        interrupted: toolResult[RESULT_FIELD.INTERRUPTED] === true,
        duration_ms,
        correction: null,
      };
    }

    // Plain text → user_msg (run correction detection; discard the text).
    const userText = extractText(content);
    if (userText !== null) {
      const correction = detectCorrection(ctx.prevToolCall, userText);
      return {
        t,
        kind: 'user_msg',
        tool: null,
        input_digest: emptyDigest(),
        ok: true,
        interrupted: false,
        duration_ms,
        correction,
      };
    }
    return null;
  }

  // --- Assistant record: tool_use or text ---
  if (rec[FIELD.TYPE] === RECORD_TYPE.ASSISTANT && msg && typeof msg === 'object') {
    const content = msg[FIELD.CONTENT];

    // tool_use → tool_call event with digest extracted from input.
    const toolUse = findContentItem(content, CONTENT_TYPE.TOOL_USE);
    if (toolUse) {
      const name = typeof toolUse.name === 'string' ? toolUse.name : '';
      const input =
        toolUse.input && typeof toolUse.input === 'object'
          ? (toolUse.input as Record<string, unknown>)
          : {};
      const tool = mapToolKind(name);
      return {
        t,
        kind: 'tool_call',
        tool,
        input_digest: digestForTool(tool, input),
        ok: true, // ok is determined by the later tool_result, not the call
        interrupted: false,
        duration_ms,
        correction: null,
      };
    }

    // Text only → assistant_msg.
    const text = extractText(content);
    if (text !== null) {
      return {
        t,
        kind: 'assistant_msg',
        tool: null,
        input_digest: emptyDigest(),
        ok: true,
        interrupted: false,
        duration_ms,
        correction: null,
      };
    }
    return null;
  }

  // Unknown record type (ai-title, summary, system entry, etc.) → skip.
  return null;
}
