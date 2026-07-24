// Spawn-based CLI tests for the `reflect` subcommand: build dist/cli.js once,
// then exercise the real bin via `node <cliPath> reflect ...` (no shell). Drives
// the CLI end-to-end over minimal .jsonl fixtures (real streaming, real git
// stat-walk, real detection). Mirrors cli.test.ts's spawn pattern and reuses the
// reflect.test.ts fixture shapes (TRIP_EVENTS / CLEAN_EVENTS).
//
// Signal trips for the tripping fixture (DEFAULT_CONFIG bootstrap thresholds):
// failure_streak >= 3 and wall_clock_per_line_ms >= 300000 both trip, so >= 2
// signals → flagged=true; the edit makes zero_edit=false → trip=true.

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { execFileSync, execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mkSession,
  setupTempRepo,
  makeTempDir,
  cleanupTempDirs,
  writeTranscript,
} from './helpers/builder.js';
import type { EventSpec } from './helpers/builder.js';
import type { ReflectFinding, StopHookOutput } from '../src/types.js';

// Absolute path to the built CLI. beforeAll builds dist/ first.
const CLI_PATH = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

afterEach(cleanupTempDirs);

// Build once before the suite. If tsc fails, every test fails loudly here.
beforeAll(() => {
  execFileSync('npm', ['run', 'build'], { stdio: 'pipe' });
}, 30_000);

// A tripping transcript: 1 edit (1 line) + 3 consecutive failed execs. The 3
// back-to-back failed execs give failure_streak=3 (bootstrap trip); the large
// step inflates wall_clock_per_line_ms over its threshold, so two signals trip
// and `flagged` is true. The edit makes zero_edit=false → trip=true.
const TRIP_EVENTS: EventSpec[] = [
  { kind: 'edit', file: 'src/x/a.ts', newString: 'y' },
  { kind: 'exec', cmd: './run.sh', ok: false },
  { kind: 'exec', cmd: './run.sh', ok: false },
  { kind: 'exec', cmd: './run.sh', ok: false },
];

// A clean transcript: one read + one multi-line edit. No signals trip →
// trip=false; the hook-stop formatter therefore yields {}.
const CLEAN_EVENTS: EventSpec[] = [
  { kind: 'read', file: 'src/app/main.ts' },
  { kind: 'edit', file: 'src/app/main.ts', newString: 'a\nb\nc' },
];

/** Write a .jsonl string to a temp file and return its path. */
function writeTempTranscript(jsonl: string, stem = 'session'): string {
  const dir = makeTempDir('cli-reflect');
  const file = join(dir, `${stem}.jsonl`);
  writeFileSync(file, jsonl, 'utf8');
  return file;
}

/** A tripping fixture over a fresh temp git repo; returns the transcript path. */
function tripFixture(): string {
  const { repo } = setupTempRepo();
  return writeTempTranscript(
    mkSession(repo, { name: 'trip', stepMs: 200_000, events: TRIP_EVENTS }),
  );
}

/** A clean fixture over a fresh temp git repo; returns the transcript path. */
function cleanFixture(): string {
  const { repo } = setupTempRepo();
  return writeTempTranscript(
    mkSession(repo, { name: 'clean', events: CLEAN_EVENTS }),
  );
}

/**
 * A tripping fixture laid out under the discovery tree
 * `<claudeDir>/projects/proj/<id>.jsonl` (not a flat temp file) so `--session`
 * can resolve it by filename stem. Returns the harness dir + the stem id.
 */
function tripSessionFixture(id = 'sess-trip'): { claudeDir: string; id: string } {
  const { repo, claudeDir } = setupTempRepo();
  writeTranscript(
    claudeDir,
    'proj',
    id,
    mkSession(repo, { name: id, stepMs: 200_000, events: TRIP_EVENTS }),
  );
  return { claudeDir, id };
}

/** Spawn the built CLI with given args; resolve stdout/stderr/exit code. */
function runCli(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      'node',
      [CLI_PATH, ...args],
      { maxBuffer: 1e7 },
      (err, stdout, stderr) => {
        const code = err
          ? ((err as { code?: number }).code ?? 1)
          : 0;
        resolve({ stdout, stderr, code });
      },
    );
  });
}

describe('harnessgap reflect CLI (spawn-based)', () => {
  it('1. reflect --transcript <fixture> --format json → valid ReflectFinding JSON, exit 0', async () => {
    const file = tripFixture();
    const { stdout, code } = await runCli([
      'reflect',
      '--transcript',
      file,
      '--format',
      'json',
    ]);

    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as ReflectFinding;
    expect(parsed.schema_version).toBe(1);
    expect(parsed).toHaveProperty('record');
    expect(parsed).toHaveProperty('trip');
    expect(parsed).toHaveProperty('zero_edit');
  });

  it('2. reflect --transcript <tripping> --format hook-stop → {decision:"block", reason}', async () => {
    const file = tripFixture();
    const { stdout, code } = await runCli([
      'reflect',
      '--transcript',
      file,
      '--format',
      'hook-stop',
    ]);

    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as StopHookOutput;
    expect(Object.keys(parsed).sort()).toEqual(['decision', 'reason']);
    expect(parsed.decision).toBe('block');
    expect(typeof parsed.reason).toBe('string');
    expect(parsed.reason!.length).toBeGreaterThan(0);
  });

  it('3. reflect --transcript <clean> --format hook-stop → {}', async () => {
    const file = cleanFixture();
    const { stdout, code } = await runCli([
      'reflect',
      '--transcript',
      file,
      '--format',
      'hook-stop',
    ]);

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({});
  });

  it('4. reflect (no target) → non-zero exit, stderr mentions the missing-target error', async () => {
    const { stderr, code } = await runCli(['reflect']);

    expect(code).not.toBe(0);
    expect(stderr.length).toBeGreaterThan(0);
    expect(stderr).toMatch(/transcript/i);
  });

  it('5. --help mentions reflect', async () => {
    const { stdout, code } = await runCli(['--help']);

    expect(code).toBe(0);
    expect(stdout).toContain('reflect');
  });

  it('6. reflect --session <id> --harness-dir <dir> → valid ReflectFinding JSON, session_id matches', async () => {
    const { claudeDir, id } = tripSessionFixture();
    const { stdout, code } = await runCli([
      'reflect',
      '--session',
      id,
      '--harness-dir',
      claudeDir,
      '--format',
      'json',
    ]);

    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as ReflectFinding;
    expect(parsed.session_id).toBe(id);
    // Non-vacuous: same tripping shape as test 1 → trip=true.
    expect(parsed.trip).toBe(true);
  });

  it('7. reflect --session <unknown-id> → non-zero exit, stderr mentions the id', async () => {
    const { claudeDir } = tripSessionFixture();
    const { stderr, code } = await runCli([
      'reflect',
      '--session',
      'nope',
      '--harness-dir',
      claudeDir,
      '--format',
      'json',
    ]);

    expect(code).not.toBe(0);
    expect(stderr).toMatch(/no transcript found with session id 'nope'/);
  });

  it('8. reflect --session + --transcript → non-zero exit, stderr mentions the conflict', async () => {
    const { claudeDir, id } = tripSessionFixture();
    const transcript = join(claudeDir, 'projects', 'proj', `${id}.jsonl`);
    const { stderr, code } = await runCli([
      'reflect',
      '--session',
      id,
      '--transcript',
      transcript,
      '--harness-dir',
      claudeDir,
      '--format',
      'json',
    ]);

    expect(code).not.toBe(0);
    expect(stderr).toMatch(/conflict/i);
    expect(stderr).toMatch(/--session/);
    expect(stderr).toMatch(/--transcript/);
  });
});
