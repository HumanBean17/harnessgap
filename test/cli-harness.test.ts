// Task 9 of the Qwen+GigaCode slice: CLI harness flags + widened init.
//
// Spawn-based tests (mirrors cli.test.ts / cli.reflect.test.ts): build
// dist/cli.js once, then exercise the real bin via `node <cli> ...`. Asserts
// the Task-9 surface only — flag parsing, harness resolution precedence,
// `--claude-dir` alias + conflict rule, and the widened `init <agent>`. The
// full end-to-end qwen transcript dispatch (chats/ discovery + qwen parser)
// lands in Task 10; here we assert that `--harness qwen-code` is ACCEPTED and
// RESOLVED (exit 0, no conflict), even though the legacy discovery path still
// walks the Claude layout and reports 0 sessions for a chats/ fixture.
//
// Five cases per the task brief:
//   1. `scan --harness qwen-code --harness-dir <tmpQwen>` → exit 0, flag
//      accepted (Task 10 wires chats/ dispatch end-to-end).
//   2. `scan --claude-dir <tmpClaude>` (alias) → exit 0, Claude layout
//      discovered, leaderboard shows the seeded area.
//   3. `scan --claude-dir X --harness qwen-code` → non-zero exit + conflict
//      error in stderr.
//   4. `scan` + config `harness: qwen-code` (no flag) → exit 0, config-resolved
//      harness accepted.
//   5. `init qwen` writes under `.qwen/`; `init gigacode` under `.gigacode/`;
//      `init wat` exits non-zero with "unsupported agent".

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { execFileSync, execFile } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_PATH = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

const tmpDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `harnessgap-cli-harness-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

// Build once before the suite. If tsc fails, every test fails loudly here.
beforeAll(() => {
  execFileSync('npm', ['run', 'build'], { stdio: 'pipe' });
}, 30_000);

// --- Timestamps ---
const TS1 = '2026-07-12T12:00:00.000Z';
const TS2 = '2026-07-12T12:00:01.000Z';
const TS3 = '2026-07-12T12:00:02.000Z';
const TS4 = '2026-07-12T12:00:03.000Z';
const TS5 = '2026-07-12T12:00:04.000Z';

// --- Claude-shape transcript helpers (matches cli.test.ts shapes) ---

function claudeUserText(ts: string, cwd: string, text: string): string {
  return JSON.stringify({
    type: 'user',
    timestamp: ts,
    cwd,
    message: { role: 'user', content: text },
  });
}

function claudeToolUse(
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

/** 5-line Claude transcript: user text → Read → result → Edit → result. */
function claudeTranscript(cwd: string, filePath: string): string {
  return [
    claudeUserText(TS1, cwd, 'read and edit the file'),
    claudeToolUse(TS2, cwd, 'Read', { file_path: filePath }),
    claudeToolResult(TS3, cwd, false),
    claudeToolUse(TS4, cwd, 'Edit', {
      file_path: filePath,
      old_string: 'x',
      new_string: 'y\nz',
    }),
    claudeToolResult(TS5, cwd, false),
  ].join('\n') + '\n';
}

// --- Qwen-shape transcript helpers (matches qwen-stream.test.ts shapes) ---

function qwenUserText(ts: string, cwd: string, text: string): string {
  return JSON.stringify({
    type: 'user',
    timestamp: ts,
    cwd,
    message: { role: 'user', parts: [{ text }] },
  });
}

function qwenToolResult(ts: string, callId: string): string {
  return JSON.stringify({
    type: 'tool_result',
    timestamp: ts,
    toolCallResult: { callId, status: 'success' },
  });
}

function qwenTelemetry(
  ts: string,
  toolName: string,
  argsKey: string,
  durationMs: number,
): string {
  return JSON.stringify({
    type: 'system',
    subtype: 'ui_telemetry',
    timestamp: ts,
    systemPayload: {
      uiEvent: {
        'event.name': 'qwen-code.tool_call',
        function_name: toolName,
        function_args: argsKey,
        duration_ms: durationMs,
        success: true,
      },
    },
  });
}

/**
 * Minimal qwen-shape transcript: user text → assistant read+edit (each with
 * telemetry + tool_result). Writes to one file path → area src/billing.
 */
function qwenTranscript(cwd: string, filePath: string): string {
  const readCall = 'call_R';
  const editCall = 'call_E';
  const readFileArgs = JSON.stringify({ file_path: filePath });
  const editFileArgs = JSON.stringify({
    file_path: filePath,
    old_string: 'x',
    new_string: 'y\nz',
  });
  return [
    qwenUserText(TS1, cwd, 'read and edit the file'),
    JSON.stringify({
      type: 'assistant',
      timestamp: TS2,
      cwd,
      message: {
        role: 'model',
        parts: [
          { text: 'reading now', thought: false },
          {
            functionCall: {
              id: readCall,
              name: 'read_file',
              args: { file_path: filePath },
            },
          },
        ],
      },
    }),
    qwenTelemetry(TS2, 'read_file', readFileArgs, 12),
    qwenToolResult(TS2, readCall),
    JSON.stringify({
      type: 'assistant',
      timestamp: TS4,
      cwd,
      message: {
        role: 'model',
        parts: [
          { text: 'editing now', thought: false },
          {
            functionCall: {
              id: editCall,
              name: 'edit_file',
              args: {
                file_path: filePath,
                old_string: 'x',
                new_string: 'y\nz',
              },
            },
          },
        ],
      },
    }),
    qwenTelemetry(TS4, 'edit_file', editFileArgs, 20),
    qwenToolResult(TS4, editCall),
  ].join('\n') + '\n';
}

// --- Fixtures ---

/** Temp git repo + claudeDir containing one Claude-shape transcript. */
function setupClaudeFixture(): { repo: string; claudeDir: string } {
  const repoDir = makeTempDir('cli-repo');
  execFileSync('git', ['init', repoDir], { stdio: 'ignore' });
  const repo = realpathSync(repoDir);

  const claudeDir = makeTempDir('claude');
  const slug = join(claudeDir, 'projects', 'slug');
  mkdirSync(slug, { recursive: true });
  writeFileSync(
    join(slug, 'sess1.jsonl'),
    claudeTranscript(repoDir, 'src/billing/a.ts'),
    'utf8',
  );

  return { repo, claudeDir };
}

/** Temp git repo + qwenDir containing one qwen-shape transcript under chats/. */
function setupQwenFixture(): { repo: string; qwenDir: string } {
  const repoDir = makeTempDir('qwen-repo');
  execFileSync('git', ['init', repoDir], { stdio: 'ignore' });
  const repo = realpathSync(repoDir);

  const qwenDir = makeTempDir('qwen');
  const chats = join(qwenDir, 'projects', 'slug', 'chats');
  mkdirSync(chats, { recursive: true });
  writeFileSync(
    join(chats, 'a.jsonl'),
    qwenTranscript(repoDir, 'src/billing/a.ts'),
    'utf8',
  );
  return { repo, qwenDir };
}

/** Spawn the built CLI with given args + optional cwd; resolve stdout/stderr/code. */
function runCli(
  args: string[],
  opts: { cwd?: string } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      'node',
      [CLI_PATH, ...args],
      { maxBuffer: 1e7, cwd: opts.cwd },
      (err, stdout, stderr) => {
        const code = err ? ((err as { code?: number }).code ?? 1) : 0;
        resolve({ stdout, stderr, code });
      },
    );
  });
}

describe('harnessgap CLI harness flags + widened init (Task 9)', () => {
  it('1. scan --harness qwen-code --harness-dir <root> → exit 0, flag accepted, chats/ dispatch yields the seeded session', async () => {
    const { repo, qwenDir } = setupQwenFixture();
    const { stdout, stderr, code } = await runCli([
      'scan',
      '--repo',
      repo,
      '--harness',
      'qwen-code',
      '--harness-dir',
      qwenDir,
    ]);

    // Task 9 surface: flag is accepted (no unknown-option exit), no conflict
    // false-positive. Task 10 wires chats/ discovery + qwen streamSession; the
    // chats/-layout fixture yields exactly the one seeded session. (Pre-Task-10
    // this case reported 0 sessions because the legacy Claude-layout discovery
    // does not enter chats/.)
    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('1 sessions');
  });

  it('2. scan --claude-dir <root> (alias) → exit 0, Claude layout discovered, leaderboard shows src/billing', async () => {
    const { repo, claudeDir } = setupClaudeFixture();
    const { stdout, code } = await runCli([
      'scan',
      '--repo',
      repo,
      '--claude-dir',
      claudeDir,
    ]);

    expect(code).toBe(0);
    expect(stdout).toContain('harnessgap scan');
    expect(stdout).toMatch(/src\/billing|No flagged areas/);
  });

  it('3. scan --claude-dir X --harness qwen-code → non-zero exit + conflict error in stderr', async () => {
    const { repo, claudeDir } = setupClaudeFixture();
    const { stdout, stderr, code } = await runCli([
      'scan',
      '--repo',
      repo,
      '--claude-dir',
      claudeDir,
      '--harness',
      'qwen-code',
    ]);

    expect(code).not.toBe(0);
    // No scan output leaked before the conflict is surfaced.
    expect(stdout).toBe('');
    // Clear, actionable conflict message.
    expect(stderr).toMatch(/conflict/i);
    expect(stderr).toMatch(/--claude-dir/);
    expect(stderr).toMatch(/--harness/);
  });

  it('4. scan with config harness:qwen-code (no flag) → exit 0, config-resolved harness accepted', async () => {
    const { repo, qwenDir } = setupQwenFixture();
    const cfgDir = makeTempDir('cfg');
    const cfgPath = join(cfgDir, '.harnessgap.yml');
    writeFileSync(cfgPath, 'harness: qwen-code\n', 'utf8');

    const { stdout, stderr, code } = await runCli([
      'scan',
      '--repo',
      repo,
      '--config',
      cfgPath,
      '--harness-dir',
      qwenDir,
    ]);

    // Task 9 surface: precedence resolves harness from config (no flag, no
    // conflict). Task 10 wires chats/ dispatch; the chats/-layout fixture
    // yields exactly the one seeded session.
    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('1 sessions');
  });

  it('5. init qwen / init gigacode / init wat — writes + unsupported-agent error', async () => {
    // init qwen writes under <cwd>/.qwen/ (non-degraded verified branch).
    const qwenCwd = makeTempDir('init-qwen');
    const qwenRes = await runCli(['init', 'qwen'], { cwd: qwenCwd });
    expect(qwenRes.code).toBe(0);
    expect(qwenRes.stdout).toMatch(/installed harnessgap/i);
    expect(existsSync(join(qwenCwd, '.qwen', 'harnessgap-stop-hook.js'))).toBe(true);
    expect(existsSync(join(qwenCwd, '.qwen', 'settings.json'))).toBe(true);
    expect(existsSync(join(qwenCwd, '.qwen', 'commands', 'reflect.md'))).toBe(true);

    // init gigacode writes under <cwd>/.gigacode/.
    const gigaCwd = makeTempDir('init-gigacode');
    const gigaRes = await runCli(['init', 'gigacode'], { cwd: gigaCwd });
    expect(gigaRes.code).toBe(0);
    expect(gigaRes.stdout).toMatch(/installed harnessgap/i);
    expect(existsSync(join(gigaCwd, '.gigacode', 'harnessgap-stop-hook.js'))).toBe(true);
    expect(existsSync(join(gigaCwd, '.gigacode', 'settings.json'))).toBe(true);
    expect(existsSync(join(gigaCwd, '.gigacode', 'commands', 'reflect.md'))).toBe(true);

    // init wat → non-zero exit + "unsupported agent" message naming the agent.
    const watCwd = makeTempDir('init-wat');
    const watRes = await runCli(['init', 'wat'], { cwd: watCwd });
    expect(watRes.code).not.toBe(0);
    expect(watRes.stderr).toMatch(/unsupported agent/i);
    expect(watRes.stderr).toContain('wat');
  });
});
