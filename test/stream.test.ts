import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { streamSession } from '../src/adapter/stream.js';
import { computeSignals } from '../src/detector/signals.js';
import { DEFAULT_CONFIG } from '../src/config.js';

// Real Claude Code transcripts carry `cwd` as a top-level string field on most
// user/assistant records (confirmed at ~/.claude/projects/.../*.jsonl and
// documented in test/parse.test.ts line 15). streamSession must extract the
// first non-empty one and return it alongside the envelope (NOT on it).

const TS1 = '2026-07-12T12:00:00.000Z';
const TS2 = '2026-07-12T12:01:00.000Z'; // +60s
const TS3 = '2026-07-12T12:02:30.000Z'; // +90s (150s after TS1)

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harnessgap-stream-'));
}

function writeJsonl(dir: string, name: string, lines: string[]): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, lines.join('\n') + '\n', 'utf8');
  return p;
}

/** A user text record (produces a user_msg event via normalizeRecord). */
function userRecord(ts: string, text = 'hello', cwd = '/repo'): string {
  return JSON.stringify({
    type: 'user',
    timestamp: ts,
    cwd,
    message: { role: 'user', content: text },
  });
}

/** An assistant tool_use record (produces a tool_call event with tool+ok=true). */
function toolUseRecord(ts: string, name: string, input: Record<string, unknown>, cwd = '/repo'): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    cwd,
    message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] },
  });
}

/** A user tool_result record (produces a tool_call event with tool=null+ok). */
function toolResultRecord(ts: string, isError = false, cwd = '/repo'): string {
  return JSON.stringify({
    type: 'user',
    timestamp: ts,
    cwd,
    message: { role: 'user', content: [{ type: 'tool_result', is_error: isError }] },
  });
}

describe('streamSession', () => {
  it('1. 3-line well-formed file → 3 events, no truncation, duration = last−first', async () => {
    const dir = tmpDir();
    const p = writeJsonl(dir, 'sess1.jsonl', [
      userRecord(TS1),
      userRecord(TS2),
      userRecord(TS3),
    ]);
    const { envelope, cwd, warnings } = await streamSession(p);

    expect(envelope.events.length).toBe(3);
    expect(envelope.event_count).toBe(3);
    expect(envelope.truncated).toBe(false);
    expect(envelope.schema_version).toBe(1);
    expect(envelope.agent).toBe('claude-code');
    expect(envelope.repo).toBe('');
    expect(envelope.session_id).toBe('sess1');
    expect(envelope.started_at).toBe(TS1);
    expect(envelope.duration_ms).toBe(150_000); // TS3 - TS1 = 150s
    expect(cwd).toBe('/repo');
    expect(warnings.malformed_lines).toBe(0);
    expect(warnings.oversized_lines).toBe(0);
    expect(warnings.truncated_sessions).toBe(0);
  });

  it('2. line 2 invalid JSON → malformed_lines===1, other 2 events still parsed', async () => {
    const dir = tmpDir();
    const p = writeJsonl(dir, 'sess2.jsonl', [
      userRecord(TS1),
      '{ this is not valid json',
      userRecord(TS3),
    ]);
    const { envelope, warnings } = await streamSession(p);

    expect(envelope.events.length).toBe(2);
    expect(envelope.event_count).toBe(2);
    expect(warnings.malformed_lines).toBe(1);
    expect(warnings.oversized_lines).toBe(0);
    expect(warnings.truncated_sessions).toBe(0);
    expect(envelope.truncated).toBe(false);
    expect(envelope.started_at).toBe(TS1);
  });

  it('3. one 1.2 MB line → oversized_lines===1, that line not parsed', async () => {
    const dir = tmpDir();
    // 1.2 MB = 1,258,291 bytes > 1,048,576 cap. Valid JSON, but oversized.
    const big = JSON.stringify({
      type: 'user',
      timestamp: TS2,
      cwd: '/repo',
      message: { role: 'user', content: 'x'.repeat(1_258_000) },
    });
    expect(Buffer.byteLength(big, 'utf8')).toBeGreaterThan(1_048_576);
    const p = writeJsonl(dir, 'sess3.jsonl', [
      userRecord(TS1),
      big,
      userRecord(TS3),
    ]);
    const { envelope, warnings } = await streamSession(p);

    expect(warnings.oversized_lines).toBe(1);
    expect(warnings.malformed_lines).toBe(0);
    // The oversized line was skipped: only TS1 and TS3 events remain.
    expect(envelope.events.length).toBe(2);
    expect(envelope.event_count).toBe(2);
    expect(envelope.events.map((e) => e.t)).toEqual([TS1, TS3]);
    expect(envelope.truncated).toBe(false);
  });

  it('4. 5001 events → event_count===5000, truncated===true, truncated_sessions===1', async () => {
    const dir = tmpDir();
    const lines: string[] = [];
    for (let i = 0; i < 5001; i++) {
      // distinct timestamps so duration is well-defined
      lines.push(userRecord(`2026-07-12T12:00:${String(i % 60).padStart(2, '0')}.${String(i).padStart(3, '0')}Z`));
    }
    const p = writeJsonl(dir, 'sess4.jsonl', lines);
    const { envelope, warnings } = await streamSession(p);

    expect(envelope.event_count).toBe(5000);
    expect(envelope.events.length).toBe(5000);
    expect(envelope.truncated).toBe(true);
    expect(warnings.truncated_sessions).toBe(1);
    expect(warnings.malformed_lines).toBe(0);
    expect(warnings.oversized_lines).toBe(0);
  });

  it('5. file >50 MB → truncated===true, reading stopped before the late event', async () => {
    const dir = tmpDir();
    const TS_LATE = '2026-07-12T23:59:59.999Z';
    // Each big line is a valid JSON system record (normalizeRecord → null, so
    // the 5000-event cap never triggers). ~1,000,000 bytes each, under the 1 MB
    // line cap. 60 of them ≈ 60 MB > 50 MB (52,428,800), so the byte cap fires.
    const bigSystem = JSON.stringify({
      type: 'system',
      timestamp: 'T0',
      cwd: '/r',
      pad: 'x'.repeat(999_950),
    });
    expect(Buffer.byteLength(bigSystem, 'utf8')).toBeLessThan(1_048_576);
    expect(Buffer.byteLength(bigSystem, 'utf8')).toBeGreaterThan(900_000);

    const lines: string[] = [];
    lines.push(userRecord(TS1)); // early event, before the cap
    for (let i = 0; i < 60; i++) lines.push(bigSystem);
    lines.push(userRecord(TS_LATE)); // late event, after the cap — must be absent
    const p = writeJsonl(dir, 'sess5.jsonl', lines);

    const { envelope, warnings } = await streamSession(p);

    expect(envelope.truncated).toBe(true);
    expect(warnings.truncated_sessions).toBe(1);
    expect(warnings.oversized_lines).toBe(0); // each big line < 1 MB
    expect(warnings.malformed_lines).toBe(0);
    // The early event was kept; the late event (past the 50 MB cap) was never read.
    expect(envelope.events.some((e) => e.t === TS1)).toBe(true);
    expect(envelope.events.some((e) => e.t === TS_LATE)).toBe(false);
  });

  it('6. session_id equals the filename without extension', async () => {
    const dir = tmpDir();
    const p = writeJsonl(dir, 'abc-123-def.jsonl', [userRecord(TS1)]);
    const { envelope } = await streamSession(p);
    expect(envelope.session_id).toBe('abc-123-def');
  });

  it('7. empty file → 0 events, no truncation, empty cwd/started_at, never throws', async () => {
    const dir = tmpDir();
    const p = writeJsonl(dir, 'empty.jsonl', []);
    const { envelope, cwd, warnings } = await streamSession(p);
    expect(envelope.events).toEqual([]);
    expect(envelope.event_count).toBe(0);
    expect(envelope.truncated).toBe(false);
    expect(envelope.started_at).toBe('');
    expect(envelope.duration_ms).toBe(0);
    expect(cwd).toBe('');
    expect(warnings.truncated_sessions).toBe(0);
  });

  // --- tool_use + tool_result merge (spec §4: one tool_call event per invocation) ---

  it('8. tool_use + failed tool_result → ONE merged event with tool AND ok=false', async () => {
    const dir = tmpDir();
    const p = writeJsonl(dir, 'merge-fail.jsonl', [
      toolUseRecord(TS1, 'Bash', { command: 'npm test' }),
      toolResultRecord(TS2, true), // is_error: true → ok=false
    ]);
    const { envelope } = await streamSession(p);

    // ONE event (not two): the tool_use + tool_result are merged.
    expect(envelope.events.length).toBe(1);
    expect(envelope.event_count).toBe(1);
    // The merged event carries tool from the tool_use AND ok from the result.
    expect(envelope.events[0]!.kind).toBe('tool_call');
    expect(envelope.events[0]!.tool).toBe('exec');
    expect(envelope.events[0]!.ok).toBe(false);
    // Merged event's t = result's t (preserves session span for wall_clock).
    expect(envelope.events[0]!.t).toBe(TS2);
    // started_at = first record's timestamp; duration = full session span.
    expect(envelope.started_at).toBe(TS1);
    expect(envelope.duration_ms).toBe(60_000); // TS2 - TS1
  });

  it('9. tool_use + passing tool_result → merged event with ok=true', async () => {
    const dir = tmpDir();
    const p = writeJsonl(dir, 'merge-pass.jsonl', [
      toolUseRecord(TS1, 'Bash', { command: 'npm test' }),
      toolResultRecord(TS2, false),
    ]);
    const { envelope } = await streamSession(p);
    expect(envelope.events.length).toBe(1);
    expect(envelope.events[0]!.tool).toBe('exec');
    expect(envelope.events[0]!.ok).toBe(true);
  });

  it('10. orphan tool_result (no preceding tool_use) → dropped', async () => {
    const dir = tmpDir();
    const p = writeJsonl(dir, 'orphan.jsonl', [
      toolResultRecord(TS1, true), // orphan — no preceding tool_use
      userRecord(TS2),
    ]);
    const { envelope } = await streamSession(p);
    // Orphan result dropped; only the user_msg remains.
    expect(envelope.events.length).toBe(1);
    expect(envelope.events[0]!.kind).toBe('user_msg');
  });

  it('11. tool_use with no result (interrupted) → kept with ok=true placeholder', async () => {
    const dir = tmpDir();
    const p = writeJsonl(dir, 'interrupted.jsonl', [
      toolUseRecord(TS1, 'Bash', { command: 'npm test' }),
      // no tool_result follows
    ]);
    const { envelope } = await streamSession(p);
    expect(envelope.events.length).toBe(1);
    expect(envelope.events[0]!.tool).toBe('exec');
    expect(envelope.events[0]!.ok).toBe(true); // placeholder
    expect(envelope.events[0]!.interrupted).toBe(false);
    // t stays the tool_use's t (no result to merge).
    expect(envelope.events[0]!.t).toBe(TS1);
  });

  it('12. real exec-failure pattern → failure_streak and oscillation non-zero (integration lock)', async () => {
    // This is the integration-level lock for the fix: a real tool_use+result
    // pair through streamSession produces a merged event with tool='exec' AND
    // ok=false, so failure_streak and oscillation compute non-zero.
    const dir = tmpDir();
    let ms = 0;
    const step = (): string => {
      const t = new Date(ms).toISOString();
      ms += 1000;
      return t;
    };
    const exec = (ok: boolean): string[] => [
      toolUseRecord(step(), 'Bash', { command: 'npm test' }),
      toolResultRecord(step(), !ok),
    ];
    const edit = (file: string): string[] => [
      toolUseRecord(step(), 'Edit', { file_path: file, old_string: 'x', new_string: 'y' }),
      toolResultRecord(step(), false),
    ];

    // edit(a) → exec(fail) → exec(fail) → edit(a) → exec(pass)
    // Two consecutive exec fails → failure_streak=2 (no intervening events).
    // edit→fail→edit(same file) → oscillation=1.
    const p = writeJsonl(dir, 'real-fail.jsonl', [
      ...edit('src/a.ts'),
      ...exec(false),
      ...exec(false),
      ...edit('src/a.ts'),
      ...exec(true),
    ]);
    const { envelope } = await streamSession(p);

    // 5 tool invocations → 5 merged events (result events merged in, not separate).
    expect(envelope.events.length).toBe(5);
    expect(envelope.events.every((e) => e.kind === 'tool_call')).toBe(true);
    // The failed execs carry ok=false on the SAME event as tool='exec'.
    const execEvents = envelope.events.filter((e) => e.tool === 'exec');
    expect(execEvents.map((e) => e.ok)).toEqual([false, false, true]);

    // Run the real signal computation on the streamed events.
    const signals = computeSignals(envelope.events, DEFAULT_CONFIG);
    expect(signals.failure_streak).toBe(2); // two consecutive exec fails
    expect(signals.oscillation).toBe(1); // edit→fail→edit(same file) = 1 cycle
  });
});
