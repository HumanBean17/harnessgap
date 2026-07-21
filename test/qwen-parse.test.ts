// Qwen on-disk record parser — pure `(raw record) → 0..N intermediate items` mapping.
// Field shapes confirmed from real Qwen Code transcripts at
// ~/.qwen/projects/-Users-Desktop-*/chats/*.jsonl (Gemini-style `message.parts[]`
// carrying `text` / `functionCall` / `functionResponse`, plus `system` records
// with `subtype:'ui_telemetry'`/`'slash_command'`/`'attribution_snapshot'`/
// `'file_history_snapshot'`). Records are synthetic; no real transcript data.

import { describe, it, expect } from 'vitest';
import { parseQwenRecord } from '../src/adapter/qwen/parse.js';
import type { InputDigest } from '../src/types.js';

const TS = '2026-07-21T04:21:39.396Z';
const CWD = '/repo';

// Treat the parsed item union as opaque; narrow with `kind` and read fields by
// key. Avoids leaning on the exact exported TS shape inside the test bodies.
type AnyItem = ReturnType<typeof parseQwenRecord>[number];

describe('parseQwenRecord — the 9 brief mappings', () => {
  it('1. type:user with a text part → exactly one user_msg', () => {
    const items = parseQwenRecord({
      type: 'user',
      timestamp: TS,
      cwd: CWD,
      message: { role: 'user', parts: [{ text: 'hello' }] },
    });
    expect(items).toEqual([{ kind: 'user_msg', text: 'hello', t: TS, cwd: CWD }]);
  });

  it('2. type:user whose only part is a functionResponse → zero items', () => {
    const items = parseQwenRecord({
      type: 'user',
      timestamp: TS,
      cwd: CWD,
      message: {
        role: 'user',
        parts: [
          { functionResponse: { id: 'call_A', name: 'read_file', response: { output: 'x' } } },
        ],
      },
    });
    expect(items).toEqual([]);
  });

  it('3. assistant text part thought:false → one assistant_msg; thought:true → zero', () => {
    const visible = parseQwenRecord({
      type: 'assistant',
      timestamp: TS,
      cwd: CWD,
      message: { role: 'model', parts: [{ text: 'ok', thought: false }] },
    });
    expect(visible).toEqual([{ kind: 'assistant_msg', text: 'ok', t: TS, cwd: CWD }]);

    const reasoning = parseQwenRecord({
      type: 'assistant',
      timestamp: TS,
      cwd: CWD,
      message: { role: 'model', parts: [{ text: 'thinking', thought: true }] },
    });
    expect(reasoning).toEqual([]);
  });

  it('4. assistant with two functionCall parts → two tool_call items with correct digest', () => {
    const items = parseQwenRecord({
      type: 'assistant',
      timestamp: TS,
      cwd: CWD,
      message: {
        role: 'model',
        parts: [
          { functionCall: { id: 'call_A', name: 'read_file', args: { file_path: '/x' } } },
          { functionCall: { id: 'call_B', name: 'run_shell_command', args: { command: 'ls -la' } } },
        ],
      },
    });
    expect(items.map((i) => (i as { kind: string }).kind)).toEqual(['tool_call', 'tool_call']);
    const a = items[0] as Extract<AnyItem, { kind: 'tool_call' }>;
    const b = items[1] as Extract<AnyItem, { kind: 'tool_call' }>;
    expect(a).toMatchObject({
      kind: 'tool_call',
      callId: 'call_A',
      toolName: 'read_file',
      inputDigest: { files: ['/x'], cmd: null, query: null, lines_changed: null },
      t: TS,
      cwd: CWD,
    });
    expect(b).toMatchObject({
      kind: 'tool_call',
      callId: 'call_B',
      toolName: 'run_shell_command',
      inputDigest: { files: [], cmd: 'ls -la', query: null, lines_changed: null },
      t: TS,
      cwd: CWD,
    });
  });

  it('5. type:tool_result status:success → ok:true; non-success → ok:false', () => {
    const ok = parseQwenRecord({
      type: 'tool_result',
      timestamp: TS,
      cwd: CWD,
      toolCallResult: { callId: 'call_A', status: 'success' },
    });
    expect(ok).toEqual([{ kind: 'tool_result', callId: 'call_A', ok: true, t: TS }]);

    const fail = parseQwenRecord({
      type: 'tool_result',
      timestamp: TS,
      cwd: CWD,
      toolCallResult: { callId: 'call_A', status: 'error' },
    });
    expect(fail).toEqual([{ kind: 'tool_result', callId: 'call_A', ok: false, t: TS }]);
  });

  it('6. ui_telemetry qwen-code.tool_call → telemetry_tool with matching argsKey', () => {
    const items = parseQwenRecord({
      type: 'system',
      subtype: 'ui_telemetry',
      timestamp: TS,
      cwd: CWD,
      systemPayload: {
        uiEvent: {
          'event.name': 'qwen-code.tool_call',
          function_name: 'read_file',
          function_args: { file_path: '/x' },
          duration_ms: 22,
          status: 'success',
          success: true,
          decision: 'auto_accept',
        },
      },
    });
    expect(items).toHaveLength(1);
    const tel = items[0] as Extract<AnyItem, { kind: 'telemetry_tool' }>;
    expect(tel.kind).toBe('telemetry_tool');
    expect(tel.toolName).toBe('read_file');
    expect(tel.durationMs).toBe(22);
    expect(tel.success).toBe(true);
    expect(typeof tel.argsKey).toBe('string');

    // The telemetry argsKey must equal the argsKey of the matching tool_call
    // from case 4 (same args shape) — this is the Task-5 merge contract.
    const callItems = parseQwenRecord({
      type: 'assistant',
      timestamp: TS,
      cwd: CWD,
      message: {
        role: 'model',
        parts: [{ functionCall: { id: 'call_A', name: 'read_file', args: { file_path: '/x' } } }],
      },
    });
    const call = callItems[0] as Extract<AnyItem, { kind: 'tool_call' }>;
    expect(call.argsKey).toBe(tel.argsKey);
  });

  it('7. ui_telemetry api_error APIUserAbortError → interrupt; non-abort → zero', () => {
    const abort = parseQwenRecord({
      type: 'system',
      subtype: 'ui_telemetry',
      timestamp: TS,
      cwd: CWD,
      systemPayload: {
        uiEvent: {
          'event.name': 'qwen-code.api_error',
          error_type: 'APIUserAbortError',
          error_message: 'Request was aborted.',
        },
      },
    });
    expect(abort).toEqual([{ kind: 'interrupt', t: TS }]);

    const rateLimit = parseQwenRecord({
      type: 'system',
      subtype: 'ui_telemetry',
      timestamp: TS,
      cwd: CWD,
      systemPayload: {
        uiEvent: {
          'event.name': 'qwen-code.api_error',
          error_type: 'RateLimitError',
          error_message: '429 quota exceeded',
        },
      },
    });
    expect(rateLimit).toEqual([]);
  });

  it('8. system slash_command / attribution_snapshot / file_history_snapshot → zero items', () => {
    for (const subtype of ['slash_command', 'attribution_snapshot', 'file_history_snapshot']) {
      const items = parseQwenRecord({
        type: 'system',
        subtype,
        timestamp: TS,
        cwd: CWD,
        systemPayload: { phase: 'invocation' },
      });
      expect(items).toEqual([]);
    }
  });

  it('9. malformed / non-object input → zero items (no throw)', () => {
    expect(parseQwenRecord(null)).toEqual([]);
    expect(parseQwenRecord(undefined)).toEqual([]);
    expect(parseQwenRecord('string')).toEqual([]);
    expect(parseQwenRecord(42)).toEqual([]);
    expect(parseQwenRecord([])).toEqual([]);
    expect(parseQwenRecord({})).toEqual([]);
    expect(parseQwenRecord({ type: 'user', message: {} })).toEqual([]);
    expect(parseQwenRecord({ type: 'user', message: { parts: 'not-an-array' } })).toEqual([]);
  });
});

describe('parseQwenRecord — argsKey matching contract (Task 5 merge seam)', () => {
  it('telemetry_tool argsKey equals tool_call argsKey for identical args regardless of key order', () => {
    const callItems = parseQwenRecord({
      type: 'assistant',
      timestamp: TS,
      cwd: CWD,
      message: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'call_X',
              name: 'edit',
              args: { file_path: '/a.ts', old_string: 'x', new_string: 'y\nz' },
            },
          },
        ],
      },
    });
    const call = callItems[0] as Extract<AnyItem, { kind: 'tool_call' }>;

    // Same args, different key insertion order — must still produce equal keys.
    const telItems = parseQwenRecord({
      type: 'system',
      subtype: 'ui_telemetry',
      timestamp: TS,
      cwd: CWD,
      systemPayload: {
        uiEvent: {
          'event.name': 'qwen-code.tool_call',
          function_name: 'edit',
          function_args: { new_string: 'y\nz', old_string: 'x', file_path: '/a.ts' },
          duration_ms: 7,
          success: true,
        },
      },
    });
    const tel = telItems[0] as Extract<AnyItem, { kind: 'telemetry_tool' }>;
    expect(tel.argsKey).toBe(call.argsKey);
  });
});

describe('parseQwenRecord — inputDigest extraction (spec §5.3 table)', () => {
  const call = (name: string, args: Record<string, unknown>): InputDigest => {
    const items = parseQwenRecord({
      type: 'assistant',
      timestamp: TS,
      cwd: CWD,
      message: { role: 'model', parts: [{ functionCall: { id: 'c', name, args } }] },
    });
    return (items[0] as Extract<AnyItem, { kind: 'tool_call' }>).inputDigest;
  };

  it('read_file: file_path → files (scrubbed)', () => {
    expect(call('read_file', { file_path: '/x' })).toEqual({
      files: ['/x'],
      cmd: null,
      query: null,
      lines_changed: null,
    });
    // credential-file path is redacted by scrubFiles
    expect(call('read_file', { file_path: '/repo/.env' }).files).toEqual(['***REDACTED***']);
  });

  it('list_directory: path → files', () => {
    expect(call('list_directory', { path: '/x' })).toEqual({
      files: ['/x'],
      cmd: null,
      query: null,
      lines_changed: null,
    });
  });

  it('edit: file_path → files + lines_changed from new_string', () => {
    const ns = ['a', 'b', 'c'].join('\n');
    expect(call('edit', { file_path: '/f', old_string: 'x', new_string: ns })).toEqual({
      files: ['/f'],
      cmd: null,
      query: null,
      lines_changed: 3,
    });
  });

  it('write_file: file_path → files + lines from content', () => {
    expect(call('write_file', { file_path: '/f', content: ['l1', 'l2'].join('\n') })).toEqual({
      files: ['/f'],
      cmd: null,
      query: null,
      lines_changed: 2,
    });
  });

  it('run_shell_command: command → cmd (scrubbed)', () => {
    expect(call('run_shell_command', { command: 'ls -la' })).toEqual({
      files: [],
      cmd: 'ls -la',
      query: null,
      lines_changed: null,
    });
    // bearer secret is scrubbed by scrubCmd
    const secret = 'Bearer ghp_' + 'x'.repeat(36);
    expect(call('run_shell_command', { command: `curl -H "${secret}"` }).cmd).toContain(
      '***REDACTED***',
    );
  });

  it('grep_search / glob: pattern → query (scrubbed)', () => {
    expect(call('grep_search', { pattern: 'TODO' })).toEqual({
      files: [],
      cmd: null,
      query: 'TODO',
      lines_changed: null,
    });
    expect(call('glob', { pattern: '**/*.ts' }).query).toBe('**/*.ts');
  });

  it('unknown tool / missing args → empty digest; absent fields are null (files is [])', () => {
    expect(call('agent', {})).toEqual({ files: [], cmd: null, query: null, lines_changed: null });
    // read_file with missing file_path → empty files array
    expect(call('read_file', {}).files).toEqual([]);
    // run_shell_command with missing command → cmd:null
    expect(call('run_shell_command', {}).cmd).toBeNull();
    // grep_search with missing pattern → query:null
    expect(call('grep_search', {}).query).toBeNull();
    // edit with missing new_string → lines_changed:0
    expect(call('edit', { file_path: '/f' }).lines_changed).toBe(0);
  });
});
