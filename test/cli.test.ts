// Spawn-based CLI tests: build dist/cli.js once, then exercise the real bin via
// `node <cliPath> <args>` (no shell). Asserts stdout shape, exit codes, and
// error handling. Mirrors the pipeline.test.ts fixture pattern (real temp git
// repo + real .jsonl transcripts) so the CLI is driven end-to-end.

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { execFileSync, execFile } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JsonOutput } from '../src/types.js';

// Absolute path to the built CLI. beforeAll builds dist/ first.
const CLI_PATH = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const PKG_PATH = fileURLToPath(new URL('../package.json', import.meta.url));
const PKG_VERSION = (
  JSON.parse(readFileSync(PKG_PATH, 'utf8')) as { version: string }
).version;

const tmpDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `harnessgap-cli-${prefix}-`));
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

// --- Transcript builders (valid Claude Code JSONL shapes) ---

const TS1 = '2026-07-12T12:00:00.000Z';
const TS2 = '2026-07-12T12:00:01.000Z';
const TS3 = '2026-07-12T12:00:02.000Z';
const TS4 = '2026-07-12T12:00:03.000Z';
const TS5 = '2026-07-12T12:00:04.000Z';

function userText(ts: string, cwd: string, text: string): string {
  return JSON.stringify({
    type: 'user',
    timestamp: ts,
    cwd,
    message: { role: 'user', content: text },
  });
}

function assistantToolUse(
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

function userToolResult(ts: string, cwd: string, isError = false): string {
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

/** 5-line transcript: user text → Read → result → Edit → result. */
function billingTranscript(cwd: string, filePath: string): string {
  return [
    userText(TS1, cwd, 'read and edit the file'),
    assistantToolUse(TS2, cwd, 'Read', { file_path: filePath }),
    userToolResult(TS3, cwd, false),
    assistantToolUse(TS4, cwd, 'Edit', {
      file_path: filePath,
      old_string: 'x',
      new_string: 'y\nz',
    }),
    userToolResult(TS5, cwd, false),
  ].join('\n') + '\n';
}

/** Fixture: temp git repo + claudeDir with 2 well-formed transcripts. */
function setupFixture(): { repo: string; claudeDir: string } {
  const repoDir = makeTempDir('cli-repo');
  execFileSync('git', ['init', repoDir], { stdio: 'ignore' });
  const repo = realpathSync(repoDir);

  const claudeDir = makeTempDir('cli-claude');
  const slug = join(claudeDir, 'projects', 'test-slug');
  mkdirSync(slug, { recursive: true });
  writeFileSync(
    join(slug, 'sess1.jsonl'),
    billingTranscript(repoDir, 'src/billing/a.ts'),
    'utf8',
  );
  writeFileSync(
    join(slug, 'sess2.jsonl'),
    billingTranscript(repoDir, 'src/billing/b.ts'),
    'utf8',
  );

  return { repo, claudeDir };
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

describe('harnessgap CLI (spawn-based)', () => {
  it('1. scan on 2-fixture corpus → human table on stdout, exit 0', async () => {
    const { repo, claudeDir } = setupFixture();
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

  it('2. scan --json → stdout is valid JsonOutput, exit 0', async () => {
    const { repo, claudeDir } = setupFixture();
    const { stdout, code } = await runCli([
      'scan',
      '--repo',
      repo,
      '--claude-dir',
      claudeDir,
      '--json',
    ]);

    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as JsonOutput;
    expect(parsed.schema_version).toBe(1);
    expect(parsed.repo).toBe(repo);
    expect(parsed.mode).toBe('bootstrap');
    expect(parsed.session_count).toBe(2);
    expect(Array.isArray(parsed.sessions)).toBe(true);
    expect(parsed.sessions.length).toBe(2);
    expect(Array.isArray(parsed.areas)).toBe(true);
  });

  it('3. scan with no sessions → stdout says "0 sessions", exit 0', async () => {
    const claudeDir = makeTempDir('cli-empty');
    const { stdout, code } = await runCli(['scan', '--claude-dir', claudeDir]);

    expect(code).toBe(0);
    expect(stdout).toContain('0 sessions');
  });

  it('4. scan --config <bad.yml> → stderr message, exit 1 (no stack)', async () => {
    const cfgDir = makeTempDir('cli-badcfg');
    const cfgPath = join(cfgDir, '.harnessgap.yml');
    writeFileSync(cfgPath, 'bogus: 1\n', 'utf8');

    const { stderr, stdout, code } = await runCli([
      'scan',
      '--config',
      cfgPath,
      '--claude-dir',
      makeTempDir('cli-badcfg-claude'),
    ]);

    expect(code).toBe(1);
    expect(stderr.length).toBeGreaterThan(0);
    // No stack trace leaked.
    expect(stderr).not.toMatch(/at \w+ /);
    expect(stderr).not.toContain('node:internal');
  });

  it('5. --version → prints version, exit 0', async () => {
    const { stdout, code } = await runCli(['--version']);

    expect(code).toBe(0);
    expect(stdout).toContain(PKG_VERSION);
  });

  it('6. --help → prints usage, exit 0', async () => {
    const { stdout, code } = await runCli(['--help']);

    expect(code).toBe(0);
    expect(stdout).toContain('Usage:');
    expect(stdout).toContain('scan');
  });
});
