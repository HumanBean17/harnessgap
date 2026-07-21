// Pipeline harness dispatch — Task 10 of the Qwen+GigaCode slice.
//
// Two cases per the task-10 brief:
//   1. Qwen end-to-end: seed a tmp repo + tmp qwen root with a hand-written
//      gemini transcript (read, failed exec, edit, user correction), then
//      runScan({harness:'qwen-code', harnessDir, repo}) yields 1 session with
//      non-empty areas, active failure_streak + corrections signals, and the
//      qwen parser was actually used (proven behaviorally: the Claude adapter
//      on the SAME fixture finds 0 transcripts because Claude's layout does
//      not enter chats/).
//   2. Claude byte-identical: the existing Claude corpus through runScan (no
//      harness flag) is byte-identical to the locked snapshot in
//      test/snapshot.test.ts (re-locked here via toMatchSnapshot), AND the
//      explicit harness:'claude-code' dispatch produces output identical to
//      the legacy no-flag path (proves spec.streamSession/discoverForSpec are
//      transparent for the Claude case — the load-bearing byte-identical
//      invariant).
//
// The agent stamp on the parsed envelope ('qwen-code' / 'claude-code' /
// 'gigacode') is set by the spec's streamSession and is verified at the
// adapter boundary in test/harness-dispatch.test.ts (case 3) and
// test/qwen-stream.test.ts (case 6). StruggleRecord — the only per-session
// shape surfaced in JsonOutput — does not carry an agent field, so the agent
// stamp is not directly visible in runScan's output. Dispatch is verified
// behaviorally here: qwen parser yields ≥1 session, Claude adapter on the same
// chats/-layout fixture yields 0.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runScan } from '../src/pipeline.js';
import {
  setupTempRepo,
  writeTranscript,
  mkSession,
  cleanupTempDirs,
} from './helpers/builder.js';
import { corpusSlug, corpusSessions } from './fixtures/corpus/sessions.js';
import type { JsonOutput } from '../src/types.js';

const tmpDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `hg-pipe-harness-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
  cleanupTempDirs();
});

// --- Qwen-shape transcript helpers (mirrors qwen-stream.test.ts shapes) ---
//
// One helper per Qwen record kind so the fixture reads as the events it seeds.

const TS1 = '2026-07-21T04:22:16.401Z';
const TS2 = '2026-07-21T04:22:26.401Z'; // +10s
const TS3 = '2026-07-21T04:22:36.401Z'; // +20s
const TS4 = '2026-07-21T04:22:46.401Z'; // +30s
const TS5 = '2026-07-21T04:22:56.401Z'; // +40s
const TS6 = '2026-07-21T04:23:06.401Z'; // +50s
const TS7 = '2026-07-21T04:23:16.401Z'; // +60s
const TS8 = '2026-07-21T04:23:26.401Z'; // +70s
const TS9 = '2026-07-21T04:23:36.401Z'; // +80s
const TS10 = '2026-07-21T04:23:46.401Z'; // +90s
const TS11 = '2026-07-21T04:23:56.401Z'; // +100s
const TS12 = '2026-07-21T04:24:06.401Z'; // +110s

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

function qwenTelemetry(
  ts: string,
  cwd: string,
  toolName: string,
  args: Record<string, unknown>,
  durationMs: number,
  success: boolean,
): string {
  return JSON.stringify({
    type: 'system',
    subtype: 'ui_telemetry',
    timestamp: ts,
    cwd,
    systemPayload: {
      uiEvent: {
        'event.name': 'qwen-code.tool_call',
        function_name: toolName,
        function_args: args,
        duration_ms: durationMs,
        success,
      },
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
 * Hand-written gemini transcript exercising every signal the brief asks for:
 * a read, a failed exec, an edit, and a user correction. cwd points at a real
 * git repo so the pipeline can resolve + relativize against it. Yields 6
 * NormalizedEvents: 3 user_msg + 3 tool_call (read, exec, edit). The
 * corrections signal fires on the third user message ("no, stop..."), and the
 * failure_streak signal fires on the failed exec.
 */
function qwenStruggleTranscript(cwd: string, filePath: string): string {
  return [
    qwenUserText(TS1, cwd, 'please read the file'),
    qwenAssistantToolCall(TS2, cwd, 'call_R', 'read_file', { file_path: filePath }),
    qwenTelemetry(TS3, cwd, 'read_file', { file_path: filePath }, 50, true),
    qwenToolResult(TS4, cwd, 'call_R', true),
    qwenUserText(TS5, cwd, 'now run the tests'),
    qwenAssistantToolCall(TS6, cwd, 'call_X', 'run_shell_command', { command: 'npm test' }),
    qwenTelemetry(TS7, cwd, 'run_shell_command', { command: 'npm test' }, 200, false),
    qwenToolResult(TS8, cwd, 'call_X', false),
    qwenUserText(TS9, cwd, 'no, stop running the tests, just edit the file'),
    qwenAssistantToolCall(TS10, cwd, 'call_E', 'edit', {
      file_path: filePath,
      new_string: 'foo\nbar\nbaz',
    }),
    qwenTelemetry(TS11, cwd, 'edit', { file_path: filePath, new_string: 'foo\nbar\nbaz' }, 30, true),
    qwenToolResult(TS12, cwd, 'call_E', true),
  ].join('\n') + '\n';
}

/** Temp git repo + qwen root with one struggle transcript under chats/. */
function setupQwenFixture(): { repo: string; qwenRoot: string } {
  const repoDir = makeTempDir('qwen-repo');
  execFileSync('git', ['init', repoDir], { stdio: 'ignore' });
  const repo = realpathSync(repoDir);

  const qwenRoot = makeTempDir('qwen-root');
  const chats = join(qwenRoot, 'projects', 'slug', 'chats');
  mkdirSync(chats, { recursive: true });
  writeFileSync(
    join(chats, 'sess1.jsonl'),
    qwenStruggleTranscript(repoDir, 'src/billing/a.ts'),
    'utf8',
  );

  return { repo, qwenRoot };
}

describe('runScan — harness dispatch (Task 10)', () => {
  it('1. qwen end-to-end: harness qwen-code → 1 session, src/billing area, failure_streak + corrections active', async () => {
    const { repo, qwenRoot } = setupQwenFixture();

    const result = await runScan({
      harness: 'qwen-code',
      harnessDir: qwenRoot,
      repo,
      json: true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.sessionCount).toBe(1);

    const parsed = JSON.parse(result.output) as JsonOutput;
    expect(parsed.session_count).toBe(1);
    expect(parsed.sessions).toHaveLength(1);

    // The session record carries the struggle signals seeded by the transcript.
    const record = parsed.sessions[0]!;
    // failure_streak: 1 (the failed npm test exec).
    expect(record.signals.failure_streak).toBeGreaterThanOrEqual(1);
    // corrections: 1 (the "no, stop..." user message after the failed exec).
    expect(record.signals.corrections).toBeGreaterThanOrEqual(1);

    // Area src/billing is non-empty — the read + edit touched src/billing/a.ts.
    expect(parsed.areas.length).toBeGreaterThan(0);
    const billingArea = parsed.areas.find((a) => a.key === 'src/billing');
    expect(billingArea).toBeDefined();
    expect(billingArea!.sessions_total).toBeGreaterThanOrEqual(1);

    // Behavioral proof of qwen dispatch: re-run the SAME fixture through the
    // Claude adapter and observe 0 sessions. Claude's layout does not enter
    // chats/ (CLAUDE_SPEC has no sessionSubdir), so discoverForSpec finds 0
    // transcripts under <qwenRoot>/projects/<slug>/chats/*.jsonl. A non-zero
    // qwen sessionCount above + zero Claude sessionCount here = the dispatch
    // routing actually went through QWEN_SPEC.
    const claudeOnQwenFixture = await runScan({
      harness: 'claude-code',
      harnessDir: qwenRoot,
      repo,
      json: true,
    });
    expect(claudeOnQwenFixture.sessionCount).toBe(0);

    // Agent stamp ('qwen-code') lives on the parsed NormalizedEnvelope and is
    // set by spec.streamSession. StruggleRecord does not surface it, so it is
    // verified at the adapter boundary (test/qwen-stream.test.ts case 6 +
    // test/harness-dispatch.test.ts case 3) rather than in runScan's output.
  });

  it('2. Claude byte-identical: corpus through runScan (no harness flag) matches snapshot; explicit harness:claude-code is identical', async () => {
    const { repo, claudeDir } = setupTempRepo();
    for (const spec of corpusSessions) {
      writeTranscript(claudeDir, corpusSlug, spec.name, mkSession(repo, spec));
    }

    // 2a. Default path (no harness flag) — byte-identical to the locked
    // snapshot in test/snapshot.test.ts. Re-normalize the temp repo path the
    // same way (the only run-to-run variable). This re-locks Claude output
    // under a separate snapshot key as a second guard alongside the existing
    // snapshot.test.ts lock.
    const defaultResult = await runScan({ repo, claudeDir });
    const defaultNormalized = defaultResult.output.replaceAll(repo, '<REPO>');
    expect(defaultNormalized).toMatchSnapshot();

    // 2b. Explicit harness:'claude-code' dispatches through CLAUDE_SPEC and
    // must produce byte-identical output to the legacy no-flag path. This is
    // the load-bearing assertion: spec.streamSession + discoverForSpec are
    // transparent for the Claude case (no envelope/cwds/warnings drift from
    // the StreamResult migration).
    const explicitResult = await runScan({ repo, claudeDir, harness: 'claude-code' });
    expect(explicitResult.output).toBe(defaultResult.output);
    expect(explicitResult.sessionCount).toBe(defaultResult.sessionCount);
    expect(explicitResult.mode).toBe(defaultResult.mode);
    expect(explicitResult.warnings).toEqual(defaultResult.warnings);

    // 2c. --json envelope: explicit harness path matches the no-flag path
    // byte-for-byte (the full JsonOutput including sessions + areas + warnings).
    const defaultJson = await runScan({ repo, claudeDir, json: true });
    const explicitJson = await runScan({
      repo,
      claudeDir,
      harness: 'claude-code',
      json: true,
    });
    expect(explicitJson.output).toBe(defaultJson.output);
  });
});
