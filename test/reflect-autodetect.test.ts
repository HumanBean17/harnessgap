// Task 11: runReflect harness auto-detect. When `reflect --transcript <path>`
// is called WITHOUT `--harness`, runReflect sniffs the transcript's shape
// (qwen gemini `message.parts`+`functionCall` vs claude `message.content`+
// `tool_use`) and dispatches through the matching adapter. `--harness <id>`
// overrides the sniff. GigaCode is indistinguishable from qwen by content, so
// auto-detect resolves to `qwen-code` (the shared parser); `--harness
// gigacode` overrides to stamp `agent:'gigacode'`.
//
// These tests drive runReflect directly (real streaming, real detection) over
// hand-written qwen + claude fixtures. The qwen fixture is identical in shape
// to the one in test/pipeline-harness.test.ts (user text → assistant
// functionCall → tool_result); the claude fixture mirrors test/cli.test.ts
// shapes (user text → tool_use/tool_result pairs).
//
// The agent stamp on the returned `ReflectFinding` is the load-bearing
// assertion: it equals the resolved harness id, threaded from runReflect
// through buildReflectFinding. Pre-Task-11 the agent lived only on the parsed
// NormalizedEnvelope (verified at the adapter boundary in
// qwen-stream.test.ts / harness-dispatch.test.ts); Task 11 surfaces it on
// ReflectFinding so reflect callers can identify the detected harness from
// the finding alone.
//
// Precedence pinned by this suite (Task 11):
//   --harness flag → sniff(transcript) → 'claude-code' fallback.
// Config `harness:` is NOT consulted for --transcript (the file is
// authoritative). For --latest (no transcript in hand), config preserves its
// Task-10 role; that path is not exercised here (see test/reflect.test.ts).

import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runReflect } from '../src/pipeline.js';
import { setupTempRepo, cleanupTempDirs } from './helpers/builder.js';
import type { ReflectFinding } from '../src/types.js';

afterEach(cleanupTempDirs);

// --- tmp dir for shape fixtures (qwen + malformed; not builder-managed) ---
const fixtureDirs: string[] = [];

function makeFixtureDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `hg-reflect-auto-${prefix}-`));
  fixtureDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (fixtureDirs.length) {
    rmSync(fixtureDirs.pop()!, { recursive: true, force: true });
  }
});

/** Write a string to a temp .jsonl file under a fresh fixture dir; return path. */
function writeTranscriptFile(prefix: string, jsonl: string): string {
  const dir = makeFixtureDir(prefix);
  const file = join(dir, `${prefix}.jsonl`);
  writeFileSync(file, jsonl, 'utf8');
  return file;
}

/**
 * git-init a temp repo and return its realpath (matches builder.setupTempRepo
 * semantics, without the unused claudeDir side effect). realpath resolves
 * through macOS /tmp → /private/tmp so the repo root matches the resolver's
 * walk-up.
 */
function makeTempRepo(prefix: string): string {
  const dir = makeFixtureDir(prefix);
  execFileSync('git', ['init', dir], { stdio: 'ignore' });
  return realpathSync(dir);
}

// --- Qwen-shape transcript helpers (mirrors pipeline-harness.test.ts) ---

const TS1 = '2026-07-21T05:00:00.000Z';
const TS2 = '2026-07-21T05:00:10.000Z';
const TS3 = '2026-07-21T05:00:20.000Z';

function qwenUserText(ts: string, cwd: string, text: string): string {
  return JSON.stringify({
    type: 'user',
    timestamp: ts,
    cwd,
    message: { role: 'user', parts: [{ text }] },
  });
}

function qwenAssistantToolCall(
  ts: string,
  cwd: string,
  callId: string,
  toolName: string,
  args: Record<string, unknown>,
): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    cwd,
    message: {
      role: 'model',
      parts: [{ functionCall: { id: callId, name: toolName, args } }],
    },
  });
}

function qwenToolResult(ts: string, cwd: string, callId: string, ok: boolean): string {
  return JSON.stringify({
    type: 'tool_result',
    timestamp: ts,
    cwd,
    toolCallResult: { callId, status: ok ? 'success' : 'error' },
  });
}

/**
 * Minimal qwen-shape transcript (3 records): user text → assistant read_file
 * functionCall → tool_result. The first line is a qwen user-text record (no
 * discriminator: parts exists but no functionCall) so the sniff walks forward
 * to line 2 (the assistant functionCall) to identify qwen-code. cwd points at
 * a real git repo so repo resolution succeeds and the finding is non-empty.
 */
function qwenShapedTranscript(cwd: string, filePath: string): string {
  return [
    qwenUserText(TS1, cwd, 'please read the file'),
    qwenAssistantToolCall(TS2, cwd, 'call_R', 'read_file', { file_path: filePath }),
    qwenToolResult(TS3, cwd, 'call_R', true),
  ].join('\n') + '\n';
}

// --- Claude-shape transcript helpers (mirrors cli.test.ts shapes) ---

function claudeUserText(ts: string, cwd: string, text: string): string {
  return JSON.stringify({
    type: 'user',
    timestamp: ts,
    cwd,
    message: { role: 'user', content: text },
  });
}

function claudeAssistantToolUse(
  ts: string,
  cwd: string,
  name: string,
  input: Record<string, unknown>,
): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    cwd,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', name, input }],
    },
  });
}

function claudeToolResult(ts: string, cwd: string, isError = false): string {
  return JSON.stringify({
    type: 'user',
    timestamp: ts,
    cwd,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', is_error: isError }],
    },
  });
}

/**
 * Minimal claude-shape transcript (3 records): user text → assistant Read
 * tool_use → tool_result. The first line is plain user text (content is a
 * string, not an array of items) so the sniff walks forward to line 2 (the
 * assistant tool_use) to identify claude-code.
 */
function claudeShapedTranscript(cwd: string, filePath: string): string {
  return [
    claudeUserText(TS1, cwd, 'please read the file'),
    claudeAssistantToolUse(TS2, cwd, 'Read', { file_path: filePath }),
    claudeToolResult(TS3, cwd, false),
  ].join('\n') + '\n';
}

describe('runReflect — harness auto-detect from transcript shape (Task 11)', () => {
  it('1. qwen-shaped file, no --harness → sniff resolves qwen-code; finding.agent === "qwen-code"', async () => {
    const { repo } = setupTempRepo();
    const file = writeTranscriptFile('qwen', qwenShapedTranscript(repo, 'src/billing/a.ts'));

    const result = await runReflect({ transcript: file, format: 'json' });
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.output) as ReflectFinding;
    // Load-bearing: the agent stamp proves the sniff routed through QWEN_SPEC
    // (whose streamSession stamps envelope.agent = 'qwen-code'). A claude-code
    // fallback would have produced agent = 'claude-code' here AND zero parsed
    // events (the claude parser doesn't read parts/functionCall), so this
    // assertion is non-vacuous.
    expect(parsed.agent).toBe('qwen-code');
    expect(parsed.record.event_count).toBeGreaterThan(0);
  });

  it('2. claude-shaped file, no --harness → sniff resolves claude-code; finding.agent === "claude-code"', async () => {
    const { repo } = setupTempRepo();
    const file = writeTranscriptFile('claude', claudeShapedTranscript(repo, 'src/billing/a.ts'));

    const result = await runReflect({ transcript: file, format: 'json' });
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.output) as ReflectFinding;
    expect(parsed.agent).toBe('claude-code');
    // The claude parser actually ran: events were parsed from the claude
    // fixture (a qwen-code fallback would parse 0 events because the qwen
    // parser doesn't read message.content arrays).
    expect(parsed.record.event_count).toBeGreaterThan(0);
  });

  it('3. --harness gigacode --transcript <qwen file> → override wins; finding.agent === "gigacode"', async () => {
    const { repo } = setupTempRepo();
    const file = writeTranscriptFile('gc', qwenShapedTranscript(repo, 'src/billing/a.ts'));

    const result = await runReflect({
      transcript: file,
      format: 'json',
      harness: 'gigacode',
    });
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.output) as ReflectFinding;
    // Load-bearing: gigacode overrides the sniff. The shared qwen parser runs
    // (events parse identically to case 1), but GIGACODE_SPEC.streamSession
    // rewrites envelope.agent from 'qwen-code' to 'gigacode'. The finding
    // carries 'gigacode' — not 'qwen-code' (which the sniff alone would have
    // produced) — proving the flag overrode the sniff.
    expect(parsed.agent).toBe('gigacode');
    expect(parsed.record.event_count).toBeGreaterThan(0);
  });

  it('4. empty/malformed first line → sniff is inconclusive, falls back to claude-code; never throws', async () => {
    // (a) empty file: 0 bytes. Sniff finds no lines → returns null → harness
    //     falls back to claude-code. Streaming yields an empty envelope; the
    //     finding is a degenerate trip:false stub stamped with the resolved
    //     harness id.
    const emptyFile = writeTranscriptFile('empty', '');
    const emptyResult = await runReflect({ transcript: emptyFile, format: 'json' });
    expect(emptyResult.exitCode).toBe(0);
    const emptyParsed = JSON.parse(emptyResult.output) as ReflectFinding;
    expect(emptyParsed.agent).toBe('claude-code');
    expect(emptyParsed.trip).toBe(false);

    // (b) malformed first line (not JSON), no discriminative content anywhere
    //     in the first lines. Sniff returns null → claude-code fallback. The
    //     streamSession counts malformed_lines (claude spec) and yields an
    //     empty envelope; runReflect fails open without throwing.
    const malformedFile = writeTranscriptFile(
      'malformed',
      'this is not json\nneither is this\n',
    );
    const malformedResult = await runReflect({
      transcript: malformedFile,
      format: 'json',
    });
    expect(malformedResult.exitCode).toBe(0);
    const malformedParsed = JSON.parse(malformedResult.output) as ReflectFinding;
    expect(malformedParsed.agent).toBe('claude-code');
    expect(malformedParsed.trip).toBe(false);
  });
});
