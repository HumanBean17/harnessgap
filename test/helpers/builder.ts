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

/** Remove all tracked temp dirs. Call in afterEach. */
export function cleanupTempDirs(): void {
  while (tmpDirs.length) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
}
