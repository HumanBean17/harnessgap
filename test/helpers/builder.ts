// Transcript builder helper for fixture authoring. Generates valid Claude Code
// JSONL from compact event-lists, matching the record shape confirmed in
// src/adapter/parse.ts (type/timestamp/cwd/message with content items).
//
// Each EventSpec maps to 1-2 JSONL records: tool events emit an assistant
// tool_use + a user tool_result pair; text events emit a single record.
// Timestamps increment by a fixed step per record so signal computations
// (duration, wall_clock_per_line, correction window) are predictable.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// --- EventSpec: compact event description (one per logical action) ---

export type EventSpec =
  | { kind: 'user_text'; text: string }
  | { kind: 'assistant_text'; text: string }
  | { kind: 'read'; file: string }
  | { kind: 'search'; pattern: string }
  | { kind: 'list'; path: string }
  | { kind: 'edit'; file: string; newString: string; oldString?: string }
  | { kind: 'write'; file: string; content: string }
  | { kind: 'exec'; cmd: string; ok?: boolean };

export interface SessionSpec {
  name: string;
  events: EventSpec[];
  /** Starting timestamp in ms-since-epoch (default 0). */
  startMs?: number;
  /** Per-record timestamp increment in ms (default 1000). */
  stepMs?: number;
}

// --- Helpers for generating repeated event lists ---

/** N reads of the same file. */
export function reads(n: number, file: string): EventSpec[] {
  return Array.from({ length: n }, () => ({ kind: 'read' as const, file }));
}

/** Each of `files` read `times` times (interleaved file-by-file). */
export function readsMulti(files: string[], times: number): EventSpec[] {
  const out: EventSpec[] = [];
  for (const f of files) {
    for (let i = 0; i < times; i++) {
      out.push({ kind: 'read', file: f });
    }
  }
  return out;
}

// --- mkSession: generate valid Claude Code JSONL from a SessionSpec ---

export function mkSession(cwd: string, spec: SessionSpec): string {
  const step = spec.stepMs ?? 1000;
  let ms = spec.startMs ?? 0;
  const lines: string[] = [];

  const ts = (): string => new Date(ms).toISOString();
  const advance = (): void => {
    ms += step;
  };

  // Emit an assistant tool_use + user tool_result pair.
  const toolPair = (name: string, input: Record<string, unknown>, ok: boolean): void => {
    lines.push(
      JSON.stringify({
        type: 'assistant',
        timestamp: ts(),
        cwd,
        message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] },
      }),
    );
    advance();
    lines.push(
      JSON.stringify({
        type: 'user',
        timestamp: ts(),
        cwd,
        message: { role: 'user', content: [{ type: 'tool_result', is_error: !ok }] },
      }),
    );
    advance();
  };

  for (const ev of spec.events) {
    switch (ev.kind) {
      case 'user_text':
        lines.push(
          JSON.stringify({
            type: 'user',
            timestamp: ts(),
            cwd,
            message: { role: 'user', content: ev.text },
          }),
        );
        advance();
        break;
      case 'assistant_text':
        lines.push(
          JSON.stringify({
            type: 'assistant',
            timestamp: ts(),
            cwd,
            message: { role: 'assistant', content: [{ type: 'text', text: ev.text }] },
          }),
        );
        advance();
        break;
      case 'read':
        toolPair('Read', { file_path: ev.file }, true);
        break;
      case 'search':
        toolPair('Grep', { pattern: ev.pattern }, true);
        break;
      case 'list':
        toolPair('LS', { path: ev.path }, true);
        break;
      case 'edit':
        toolPair(
          'Edit',
          {
            file_path: ev.file,
            old_string: ev.oldString ?? 'x',
            new_string: ev.newString,
          },
          true,
        );
        break;
      case 'write':
        toolPair('Write', { file_path: ev.file, content: ev.content }, true);
        break;
      case 'exec':
        toolPair('Bash', { command: ev.cmd }, ev.ok ?? true);
        break;
    }
  }
  return lines.join('\n') + '\n';
}

// --- Temp repo + claudeDir setup ---

const tmpDirs: string[] = [];

export function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `hg-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}

/** git init a temp repo + create a temp claudeDir. Returns realpaths. */
export function setupTempRepo(): { repo: string; claudeDir: string } {
  const repoDir = makeTempDir('repo');
  execFileSync('git', ['init', repoDir], { stdio: 'ignore' });
  const repo = realpathSync(repoDir);
  const claudeDir = makeTempDir('claude');
  return { repo, claudeDir };
}

/** Write a .jsonl transcript into <claudeDir>/projects/<slug>/<name>.jsonl. */
export function writeTranscript(
  claudeDir: string,
  slug: string,
  name: string,
  jsonl: string,
): string {
  const dir = join(claudeDir, 'projects', slug);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.jsonl`);
  writeFileSync(file, jsonl, 'utf8');
  return file;
}

// --- Qwen / Gemini-shape builder -------------------------------------------
//
// Emits gemini-style JSONL from the SAME compact EventSpec list mkSession
// consumes. Each EventSpec maps to 1-3 Qwen records per spec §5.3 and the
// task-12 brief:
//
//   user_text      → 1 user record (parts:[{text}]).
//   assistant_text → 1 assistant record (parts:[{text, thought:false}]).
//   tool event     → 3 records, in this exact order so the Task-5 merge
//                    resolves each one:
//                       (a) assistant record carrying a functionCall part
//                           (the call itself — `tool_call` item).
//                       (b) system record with subtype:'ui_telemetry' and a
//                           qwen-code.tool_call uiEvent (the `telemetry_tool`
//                           item; carries duration_ms/success).
//                       (c) tool_result record with matching callId (the
//                           `tool_result` item; status:'success'|'error').
//
// Tool-name mapping is the inverse of src/adapter/qwen/taxonomy.ts:
//   read → read_file, search → grep_search, list → list_directory,
//   edit → edit, write → write_file, exec → run_shell_command.
//
// Timestamps increment per record by `stepMs` (same step semantics as
// mkSession). Each tool call gets a unique callId (Qwen-merge authority for
// `ok`), and the (toolName, args) pair is identical between the functionCall
// and the telemetry uiEvent so the merge — which pairs by (toolName, argsKey)
// — binds duration_ms to the originating call.

const QWEN_TOOL_NAME: Record<
  Exclude<EventSpec, { kind: 'user_text' | 'assistant_text' }>['kind'],
  string
> = {
  read: 'read_file',
  search: 'grep_search',
  list: 'list_directory',
  edit: 'edit',
  write: 'write_file',
  exec: 'run_shell_command',
};

// Non-zero duration stamped on every telemetry item so the merge yields
// duration_ms > 0 on resolved tool calls (the contract: 0 only when no
// telemetry matches). 50ms is arbitrary but non-zero — matches the shape of
// real Qwen transcripts (tens to hundreds of ms per call).
const QWEN_TOOL_DURATION_MS = 50;

export function mkQwenSession(cwd: string, spec: SessionSpec): string {
  const step = spec.stepMs ?? 1000;
  let ms = spec.startMs ?? 0;
  let callCounter = 0;
  const lines: string[] = [];

  const ts = (): string => new Date(ms).toISOString();
  const advance = (): void => {
    ms += step;
  };

  // Emit the functionCall → telemetry → tool_result triple for one tool event.
  // args MUST be passed verbatim to both the functionCall and the telemetry
  // uiEvent so stableArgsKey produces the SAME argsKey on both item kinds
  // (otherwise the merge cannot pair duration to the call).
  const toolTriple = (
    toolKind: keyof typeof QWEN_TOOL_NAME,
    args: Record<string, unknown>,
    ok: boolean,
  ): void => {
    callCounter += 1;
    const callId = `call_${callCounter}`;
    const toolName = QWEN_TOOL_NAME[toolKind];
    // (a) assistant functionCall — the call itself.
    lines.push(
      JSON.stringify({
        type: 'assistant',
        timestamp: ts(),
        cwd,
        message: {
          role: 'model',
          parts: [{ functionCall: { id: callId, name: toolName, args } }],
        },
      }),
    );
    advance();
    // (b) system ui_telemetry — duration + success (drives duration_ms in merge).
    lines.push(
      JSON.stringify({
        type: 'system',
        subtype: 'ui_telemetry',
        timestamp: ts(),
        cwd,
        systemPayload: {
          uiEvent: {
            'event.name': 'qwen-code.tool_call',
            function_name: toolName,
            function_args: args,
            duration_ms: QWEN_TOOL_DURATION_MS,
            success: ok,
          },
        },
      }),
    );
    advance();
    // (c) tool_result — drives `ok` in merge (status:'success' ↔ ok:true).
    lines.push(
      JSON.stringify({
        type: 'tool_result',
        timestamp: ts(),
        cwd,
        toolCallResult: { callId, status: ok ? 'success' : 'error' },
      }),
    );
    advance();
  };

  for (const ev of spec.events) {
    switch (ev.kind) {
      case 'user_text':
        lines.push(
          JSON.stringify({
            type: 'user',
            timestamp: ts(),
            cwd,
            message: { role: 'user', parts: [{ text: ev.text }] },
          }),
        );
        advance();
        break;
      case 'assistant_text':
        lines.push(
          JSON.stringify({
            type: 'assistant',
            timestamp: ts(),
            cwd,
            message: {
              role: 'model',
              parts: [{ text: ev.text, thought: false }],
            },
          }),
        );
        advance();
        break;
      case 'read':
        toolTriple('read', { file_path: ev.file }, true);
        break;
      case 'search':
        toolTriple('search', { pattern: ev.pattern }, true);
        break;
      case 'list':
        toolTriple('list', { path: ev.path }, true);
        break;
      case 'edit':
        toolTriple(
          'edit',
          {
            file_path: ev.file,
            old_string: ev.oldString ?? 'x',
            new_string: ev.newString,
          },
          true,
        );
        break;
      case 'write':
        toolTriple('write', { file_path: ev.file, content: ev.content }, true);
        break;
      case 'exec':
        toolTriple('exec', { command: ev.cmd }, ev.ok ?? true);
        break;
    }
  }
  return lines.join('\n') + '\n';
}

/**
 * Write a .jsonl transcript into <rootDir>/projects/<slug>/chats/<name>.jsonl
 * (the Qwen `chats/` level, per spec §5.3). Mirrors writeTranscript's
 * `projects/<slug>/<name>.jsonl` Claude layout but adds the chats/ sublayer
 * the Qwen dispatcher's TranscriptLayout requires.
 */
export function writeQwenTranscript(
  rootDir: string,
  slug: string,
  name: string,
  jsonl: string,
): string {
  const dir = join(rootDir, 'projects', slug, 'chats');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.jsonl`);
  writeFileSync(file, jsonl, 'utf8');
  return file;
}

/** Remove all tracked temp dirs. Call in afterEach. */
export function cleanupTempDirs(): void {
  while (tmpDirs.length) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
}
