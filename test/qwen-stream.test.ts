// Qwen merge + stream — Task 5.
// `mergeQwenItems`: pure items → NormalizedEvent[] assembler pinned to the
// matching contract from the task-5 brief (ok by callId from tool_result;
// duration_ms by (toolName,argsKey) from telemetry_tool searching AFTER the
// call; interrupted by an interrupt item at/after the call before the next
// user_msg). `streamQwenSession`: readline + size caps + envelope assembly,
// mirrors Claude's streamSession invariants. Records are synthetic; no real
// transcript data.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { mergeQwenItems, streamQwenSession } from '../src/adapter/qwen/stream.js';
import type { QwenParsedItem } from '../src/adapter/qwen/parse.js';
import type { InputDigest } from '../src/types.js';

const TS1 = '2026-07-21T04:22:16.401Z';
const TS2 = '2026-07-21T04:22:26.401Z'; // +10s
const TS3 = '2026-07-21T04:22:36.401Z'; // +20s
const TS4 = '2026-07-21T04:22:46.401Z'; // +30s
const CWD = '/repo';
const SESSION_ID = 'sess-test';
const META = { session_id: SESSION_ID, started_at: TS1, duration_ms: 30_000 };

const EMPTY_DIGEST: InputDigest = {
  files: [],
  cmd: null,
  query: null,
  lines_changed: null,
};

// --- Item builders mirroring the QwenParsedItem union (hand-written; the union
//     is the contract surface, the builder keeps test bodies terse). ---

const userMsg = (text: string, t = TS1, cwd = CWD): QwenParsedItem => ({
  kind: 'user_msg',
  text,
  t,
  cwd,
});
const assistantMsg = (text: string, t = TS1, cwd = CWD): QwenParsedItem => ({
  kind: 'assistant_msg',
  text,
  t,
  cwd,
});
const toolCall = (
  callId: string,
  toolName: string,
  argsKey: string,
  inputDigest: InputDigest = EMPTY_DIGEST,
  t = TS1,
  cwd = CWD,
): QwenParsedItem => ({
  kind: 'tool_call',
  callId,
  toolName,
  argsKey,
  inputDigest,
  t,
  cwd,
});
const telemetryTool = (
  toolName: string,
  argsKey: string,
  durationMs: number,
  success: boolean,
  t = TS1,
): QwenParsedItem => ({
  kind: 'telemetry_tool',
  toolName,
  argsKey,
  durationMs,
  success,
  t,
});
const toolResult = (callId: string, ok: boolean, t = TS1): QwenParsedItem => ({
  kind: 'tool_result',
  callId,
  ok,
  t,
});
const interruptItem = (t = TS1): QwenParsedItem => ({ kind: 'interrupt', t });

// --- mergeQwenItems: 5 pure cases ---

describe('mergeQwenItems — matching contract', () => {
  it('1. single resolved call → tool_call event with ok+duration from telemetry, interrupted:false', () => {
    const items: QwenParsedItem[] = [
      toolCall(
        'call_A',
        'read_file',
        'K1',
        { files: ['/x'], cmd: null, query: null, lines_changed: null },
        TS1,
      ),
      telemetryTool('read_file', 'K1', 22, true, TS2),
      toolResult('call_A', true, TS3),
    ];
    const events = mergeQwenItems(items, META);
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.kind).toBe('tool_call');
    expect(ev.tool).toBe('read');
    expect(ev.ok).toBe(true);
    expect(ev.duration_ms).toBe(22);
    expect(ev.interrupted).toBe(false);
    expect(ev.input_digest.files).toEqual(['/x']);
    expect(ev.t).toBe(TS1);
    // No raw prose leaks onto a tool_call event (only scrubbed metadata).
    expect(JSON.stringify(ev)).not.toContain('please');
    expect(JSON.stringify(ev)).not.toContain('thought');
  });

  it('2. parallel calls in one assistant turn → each resolves independently by callId', () => {
    // Real-data shape: one assistant turn yields 2 functionCall parts, then 2
    // telemetries (in call order), then 2 results (in call order). Each call
    // must resolve independently — A to its own result+telemetry, B to its own.
    const items: QwenParsedItem[] = [
      toolCall('call_A', 'read_file', 'Kread', EMPTY_DIGEST, TS1),
      toolCall('call_B', 'run_shell_command', 'Kcmd', EMPTY_DIGEST, TS1),
      telemetryTool('read_file', 'Kread', 30, true, TS2),
      telemetryTool('run_shell_command', 'Kcmd', 12, false, TS2),
      toolResult('call_A', true, TS3),
      toolResult('call_B', false, TS3),
    ];
    const events = mergeQwenItems(items, META);
    expect(events).toHaveLength(2);
    const [a, b] = events;
    expect(a!.tool).toBe('read');
    expect(a!.ok).toBe(true);
    expect(a!.duration_ms).toBe(30);
    expect(a!.interrupted).toBe(false);
    expect(b!.tool).toBe('exec');
    expect(b!.ok).toBe(false);
    expect(b!.duration_ms).toBe(12);
    expect(b!.interrupted).toBe(false);
  });

  it('2b. identical-args parallel calls → DISTINCT durations in encounter order (consumption tracking)', () => {
    // Regression for review round 1 finding 1: two tool_calls sharing the SAME
    // (toolName, argsKey) but different callIds, plus two telemetries (30ms then
    // 40ms). Without consumption tracking both calls bound to the FIRST
    // telemetry (30ms). The contract requires distinct pairing in order.
    const items: QwenParsedItem[] = [
      toolCall('call_A', 'read_file', 'K', EMPTY_DIGEST, TS1),
      toolCall('call_B', 'read_file', 'K', EMPTY_DIGEST, TS1),
      telemetryTool('read_file', 'K', 30, true, TS2),
      telemetryTool('read_file', 'K', 40, true, TS2),
      toolResult('call_A', true, TS3),
      toolResult('call_B', true, TS3),
    ];
    const events = mergeQwenItems(items, META);
    expect(events).toHaveLength(2);
    const [a, b] = events;
    expect(a!.tool).toBe('read');
    expect(a!.ok).toBe(true);
    expect(a!.duration_ms).toBe(30); // first call → first telemetry
    expect(a!.interrupted).toBe(false);
    expect(b!.tool).toBe('read');
    expect(b!.ok).toBe(true);
    expect(b!.duration_ms).toBe(40); // second call → second telemetry (DISTINCT)
    expect(b!.interrupted).toBe(false);
  });

  it('3. unresolved call (no matching tool_result) → ok:false, duration_ms:0', () => {
    const items: QwenParsedItem[] = [
      toolCall('call_C', 'read_file', 'K', EMPTY_DIGEST, TS1),
      // no tool_result, no telemetry — session was cut off before resolution
    ];
    const events = mergeQwenItems(items, META);
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.kind).toBe('tool_call');
    expect(ev.tool).toBe('read');
    expect(ev.ok).toBe(false); // unresolved → not-ok per contract
    expect(ev.duration_ms).toBe(0); // no telemetry → 0
    expect(ev.interrupted).toBe(false);
  });

  it('4. interrupt between calls → call before interrupt interrupted:false, call after interrupted:true', () => {
    const items: QwenParsedItem[] = [
      toolCall('call_A', 'read_file', 'KA', EMPTY_DIGEST, TS1),
      toolResult('call_A', true, TS2),
      interruptItem(TS2),
      toolCall('call_B', 'read_file', 'KB', EMPTY_DIGEST, TS3),
      toolResult('call_B', true, TS4),
    ];
    const events = mergeQwenItems(items, META);
    expect(events).toHaveLength(2);
    expect(events[0]!.tool).toBe('read'); // call_A
    expect(events[0]!.interrupted).toBe(false);
    expect(events[1]!.tool).toBe('read'); // call_B
    expect(events[1]!.interrupted).toBe(true);
  });

  it('5. user_msg + assistant_msg → two events; user_msg carries correction, no prose leaked', () => {
    const items: QwenParsedItem[] = [
      userMsg('no, stop doing that', TS1),
      assistantMsg('understood', TS2),
    ];
    const events = mergeQwenItems(items, META);
    expect(events).toHaveLength(2);
    expect(events[0]!.kind).toBe('user_msg');
    expect(events[0]!.tool).toBeNull();
    expect(events[0]!.ok).toBe(true);
    expect(events[0]!.interrupted).toBe(false);
    expect(events[0]!.duration_ms).toBe(0);
    expect(events[0]!.input_digest).toEqual(EMPTY_DIGEST);
    expect(events[0]!.correction?.matched).toBe(true);
    expect(events[0]!.correction?.shape).toBe('negation');
    // Privacy: the raw prose must NOT be carried onto the NormalizedEvent.
    expect(JSON.stringify(events[0]!)).not.toContain('no, stop');
    expect(events[1]!.kind).toBe('assistant_msg');
    expect(events[1]!.tool).toBeNull();
    expect(events[1]!.correction).toBeNull();
    expect(JSON.stringify(events[1]!)).not.toContain('understood');
  });
});

// --- streamQwenSession: 2 I/O cases ---

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harnessgap-qwen-stream-'));
}

function writeJsonl(dir: string, name: string, lines: string[]): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, lines.join('\n') + '\n', 'utf8');
  return p;
}

describe('streamQwenSession — I/O', () => {
  it('6. real-shaped file → envelope agent:qwen-code, ok+duration from telemetry, truncated:false', async () => {
    const dir = tmpDir();
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    // Real interleaving per Qwen transcripts: user text → assistant with one
    // functionCall → ui_telemetry tool_call → tool_result. Synthetic content.
    const lines = [
      JSON.stringify({
        type: 'user',
        timestamp: TS1,
        cwd: CWD,
        message: { role: 'user', parts: [{ text: 'please read the file' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: TS2,
        cwd: CWD,
        message: {
          role: 'model',
          parts: [
            { text: 'reading now', thought: false },
            {
              functionCall: {
                id: 'call_X',
                name: 'read_file',
                args: { file_path: '/x' },
              },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'system',
        subtype: 'ui_telemetry',
        timestamp: TS2,
        cwd: CWD,
        systemPayload: {
          uiEvent: {
            'event.name': 'qwen-code.tool_call',
            function_name: 'read_file',
            function_args: { file_path: '/x' },
            duration_ms: 18,
            success: true,
          },
        },
      }),
      JSON.stringify({
        type: 'tool_result',
        timestamp: TS2,
        cwd: CWD,
        toolCallResult: { callId: 'call_X', status: 'success' },
      }),
    ];
    const p = writeJsonl(dir, sessionId + '.jsonl', lines);
    const { envelope, cwd, cwds, warnings } = await streamQwenSession(p);

    expect(envelope.schema_version).toBe(1);
    expect(envelope.agent).toBe('qwen-code');
    expect(envelope.session_id).toBe(sessionId);
    expect(envelope.repo).toBe('');
    expect(envelope.truncated).toBe(false);
    expect(envelope.started_at).toBe(TS1);
    // TS2 - TS1 = 10_000 ms; duration tracked across ALL records w/ timestamps.
    expect(envelope.duration_ms).toBe(10_000);
    // Events: user_msg + assistant_msg + tool_call (in order).
    expect(envelope.events.map((e) => e.kind)).toEqual([
      'user_msg',
      'assistant_msg',
      'tool_call',
    ]);
    const tc = envelope.events[2]!;
    expect(tc.tool).toBe('read');
    expect(tc.ok).toBe(true);
    expect(tc.duration_ms).toBe(18); // from telemetry
    expect(tc.interrupted).toBe(false);
    expect(envelope.event_count).toBe(3);
    // StreamResult: cwd is the first record carrying it (CWD); cwds contains
    // every distinct cwd seen across records (here all four carry the same
    // CWD, so the deduped list is the singleton).
    expect(cwd).toBe(CWD);
    expect(cwds).toEqual([CWD]);
    // StreamResult.warnings: per-session counters, all zero on a clean file.
    expect(warnings.malformed_lines).toBe(0);
    expect(warnings.oversized_lines).toBe(0);
    expect(warnings.truncated_sessions).toBe(0);
  });

  it('7. caps & malformed: >1 MB line skipped+counted → truncated:true; non-JSON line skipped (no throw)', async () => {
    const dir = tmpDir();
    // 1.2 MB line — valid JSON, over the 1 MB line cap. Real-shaped user record.
    const big = JSON.stringify({
      type: 'user',
      timestamp: TS2,
      cwd: CWD,
      message: {
        role: 'user',
        parts: [{ text: 'x'.repeat(1_258_000) }],
      },
    });
    expect(Buffer.byteLength(big, 'utf8')).toBeGreaterThan(1_048_576);
    const valid = JSON.stringify({
      type: 'user',
      timestamp: TS1,
      cwd: CWD,
      message: { role: 'user', parts: [{ text: 'ok' }] },
    });
    const malformed = '{ this is not valid json';
    // Order: valid (parsed), big (oversized→truncated), malformed (skipped, no throw).
    const p = writeJsonl(dir, 'caps.jsonl', [valid, big, malformed]);

    const { envelope, cwd, cwds, warnings } = await streamQwenSession(p);
    // The valid line was parsed; the oversized line was NOT (it was skipped).
    expect(envelope.events.length).toBe(1);
    expect(envelope.events[0]!.kind).toBe('user_msg');
    // Data was dropped (oversized line) → truncated flags the loss.
    expect(envelope.truncated).toBe(true);
    expect(envelope.event_count).toBe(1);
    // No throw — the malformed line was silently skipped.
    // StreamResult: cwd from the valid line (the only parsed record carrying
    // one — the oversized + malformed lines did not contribute).
    expect(cwd).toBe(CWD);
    expect(cwds).toEqual([CWD]);
    // StreamResult.warnings: the oversized line incremented oversized_lines;
    // the malformed line incremented malformed_lines; truncated was flagged
    // (oversized-line data loss) → truncated_sessions === 1.
    expect(warnings.oversized_lines).toBe(1);
    expect(warnings.malformed_lines).toBe(1);
    expect(warnings.truncated_sessions).toBe(1);
  });
});
