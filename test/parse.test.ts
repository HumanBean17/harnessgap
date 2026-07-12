import { describe, it, expect } from 'vitest';
import { normalizeRecord } from '../src/adapter/parse.js';
import { mapToolKind } from '../src/adapter/taxonomy.js';

// Field-name shape confirmed from a real Claude Code transcript at
// ~/.claude/projects/-Users-dmitry-Desktop-CursorProjects-harnessgap/0fefc1ca-*.jsonl
// (one JSON object per line):
//   record.type           : "user" | "assistant" | "ai-title" | ...
//   record.timestamp      : ISO8601 string
//   record.message.role   : "user" | "assistant"
//   record.message.content: string  OR  array of content items:
//     { type: "tool_use", id, name, input }            (assistant tool calls)
//     { type: "text", text }                            (prose)
//     { type: "tool_result", tool_use_id, content, is_error }  (nested in user msgs)
//   record.cwd, record.sessionId, record.uuid also present (not emitted on events).
// `interrupted` was not present on any sampled tool_result (defaults to false);
// `duration_ms` was not present on any sampled record (defaults to 0).
const TS = '2026-07-12T12:06:23.662Z';

describe('mapToolKind — tool-name → ToolKind lookup', () => {
  it('Read → read', () => {
    expect(mapToolKind('Read')).toBe('read');
  });
  it('Grep, Glob → search', () => {
    expect(mapToolKind('Grep')).toBe('search');
    expect(mapToolKind('Glob')).toBe('search');
  });
  it('LS → list', () => {
    expect(mapToolKind('LS')).toBe('list');
  });
  it('Edit, Write, NotebookEdit → edit', () => {
    expect(mapToolKind('Edit')).toBe('edit');
    expect(mapToolKind('Write')).toBe('edit');
    expect(mapToolKind('NotebookEdit')).toBe('edit');
  });
  it('Bash → exec', () => {
    expect(mapToolKind('Bash')).toBe('exec');
  });
  it('unknown / mcp__* / empty → other', () => {
    expect(mapToolKind('mcp__foo__bar')).toBe('other');
    expect(mapToolKind('TaskCreate')).toBe('other');
    expect(mapToolKind('WebSearch')).toBe('other');
    expect(mapToolKind('')).toBe('other');
  });
});

describe('normalizeRecord', () => {
  it('1. user text "no, stop" after a tool_call → user_msg with correction; no raw prose leaked', () => {
    const raw = {
      type: 'user',
      message: { role: 'user', content: 'no, stop' },
      timestamp: TS,
    };
    const ev = normalizeRecord(raw, { prevToolCall: { tool: 'exec' } });
    expect(ev).not.toBeNull();
    expect(ev!.kind).toBe('user_msg');
    expect(ev!.correction?.matched).toBe(true);
    expect(ev!.correction?.shape).toBe('negation');
    // No field on the event may contain the raw prose.
    expect(JSON.stringify(ev)).not.toContain('no, stop');
  });

  it('2. assistant Bash tool_use with "export TOKEN=ghp_x" → exec, cmd scrubbed', () => {
    const raw = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'export TOKEN=ghp_x' } },
        ],
      },
      timestamp: TS,
    };
    const ev = normalizeRecord(raw, { prevToolCall: null });
    expect(ev).not.toBeNull();
    expect(ev!.kind).toBe('tool_call');
    expect(ev!.tool).toBe('exec');
    expect(ev!.input_digest.cmd).toContain('***REDACTED***');
    expect(ev!.input_digest.cmd).not.toContain('ghp_x');
    expect(ev!.input_digest.files).toEqual([]);
    expect(ev!.input_digest.query).toBeNull();
    expect(ev!.input_digest.lines_changed).toBeNull();
  });

  it('3. Edit tool_use with a 10-line new_string → edit, lines_changed===10, files populated', () => {
    const newString = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9', 'l10'].join('\n');
    const raw = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'c2',
            name: 'Edit',
            input: { file_path: '/repo/src/foo.ts', old_string: 'a', new_string: newString },
          },
        ],
      },
      timestamp: TS,
    };
    const ev = normalizeRecord(raw, { prevToolCall: null });
    expect(ev).not.toBeNull();
    expect(ev!.tool).toBe('edit');
    expect(ev!.input_digest.lines_changed).toBe(10);
    expect(ev!.input_digest.files).toEqual(['/repo/src/foo.ts']);
  });

  it('4. Grep tool_use with a secret in pattern → search, query scrubbed', () => {
    const secret = 'Bearer ghp_' + 'x'.repeat(36);
    const raw = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'c3', name: 'Grep', input: { pattern: secret, path: '/repo' } },
        ],
      },
      timestamp: TS,
    };
    const ev = normalizeRecord(raw, { prevToolCall: null });
    expect(ev).not.toBeNull();
    expect(ev!.tool).toBe('search');
    expect(ev!.input_digest.query).toContain('***REDACTED***');
    expect(ev!.input_digest.query).not.toContain(secret);
    expect(ev!.input_digest.files).toEqual([]);
  });

  it('5. tool_result (nested in user msg) with is_error:true → ok===false, interrupted===false', () => {
    const raw = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'c1', content: 'boom', is_error: true },
        ],
      },
      timestamp: TS,
    };
    const ev = normalizeRecord(raw, { prevToolCall: { tool: 'exec' } });
    expect(ev).not.toBeNull();
    expect(ev!.kind).toBe('tool_call');
    expect(ev!.ok).toBe(false);
    expect(ev!.interrupted).toBe(false);
  });

  it('6. tool_result with interrupted:true → interrupted===true', () => {
    const raw = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'c2', content: '', is_error: false, interrupted: true },
        ],
      },
      timestamp: TS,
    };
    const ev = normalizeRecord(raw, { prevToolCall: null });
    expect(ev).not.toBeNull();
    expect(ev!.interrupted).toBe(true);
  });

  it('7. unknown tool name mcp__foo__bar → tool "other"', () => {
    const raw = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'c4', name: 'mcp__foo__bar', input: {} },
        ],
      },
      timestamp: TS,
    };
    const ev = normalizeRecord(raw, { prevToolCall: null });
    expect(ev).not.toBeNull();
    expect(ev!.tool).toBe('other');
    expect(ev!.input_digest.files).toEqual([]);
    expect(ev!.input_digest.cmd).toBeNull();
    expect(ev!.input_digest.query).toBeNull();
    expect(ev!.input_digest.lines_changed).toBeNull();
  });

  it('8. record with no recognizable event → null', () => {
    const raw = { type: 'ai-title', aiTitle: 'Proceed with implementation', sessionId: 's' };
    const ev = normalizeRecord(raw, { prevToolCall: null });
    expect(ev).toBeNull();
  });

  it('9. exec cmd exceeding 512 chars after scrub → truncated to 512', () => {
    const longCmd = 'echo ' + 'a'.repeat(600);
    const raw = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'c5', name: 'Bash', input: { command: longCmd } },
        ],
      },
      timestamp: TS,
    };
    const ev = normalizeRecord(raw, { prevToolCall: null });
    expect(ev).not.toBeNull();
    expect(ev!.input_digest.cmd!.length).toBe(512);
  });

  it('10. edit with 60 file paths → 50 in digest', () => {
    const files = Array.from({ length: 60 }, (_, i) => `/repo/file${i}.ts`);
    const raw = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'c6', name: 'Edit', input: { files, file_path: '/repo/main.ts' } },
        ],
      },
      timestamp: TS,
    };
    const ev = normalizeRecord(raw, { prevToolCall: null });
    expect(ev).not.toBeNull();
    expect(ev!.input_digest.files.length).toBe(50);
  });
});
