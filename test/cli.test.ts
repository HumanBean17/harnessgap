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

  it('4b. scan --repo <bogus> → stderr message, exit 1, no stdout leak (#29)', async () => {
    const { claudeDir } = setupFixture();
    const { stdout, stderr, code } = await runCli([
      'scan',
      '--repo',
      '/nonexistent/harnessgap/bogus-' + Date.now(),
      '--claude-dir',
      claudeDir,
    ]);

    expect(code).toBe(1);
    expect(stderr).toMatch(/does not resolve to a git repository/);
    // No sessions leaked onto stdout — the privacy bug #29 describes is gone.
    expect(stdout).toBe('');
    // No stack trace leaked.
    expect(stderr).not.toMatch(/at \w+ /);
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

  it('6b. --help description reflects closed-loop reality (not stale "Stateless detection-only")', async () => {
    // The CLI now ships `synthesize` (writes + shells out), so the old
    // "Stateless detection-only" framing was false. The corrected description
    // scopes statelessness to scan/reflect and names the closed-loop commands.
    const { stdout, code } = await runCli(['--help']);

    expect(code).toBe(0);
    expect(stdout).toContain('Detect harness gaps in agent transcripts');
    expect(stdout).toMatch(/scan\/reflect/);
    expect(stdout).toMatch(/synthesize\/review/);
    // The stale framing must not reappear.
    expect(stdout).not.toContain('Stateless detection-only');
  });

  // Slice 4 (Diagnoser) — Task 10 + Task 11: --diagnose flag is parsed and
  // threaded into runScan, and the JSON envelope carries a `diagnoses` array
  // (Task 11 wired JsonOutput.diagnoses into buildJsonEnvelope). Here we assert
  // what's true for the corpus fixture: the flag is accepted (exit 0, no
  // unknown-option error), the envelope is valid, and `diagnoses` is present
  // as an array (it may be empty for this thin corpus — that's fine, so we
  // assert defined + Array.isArray, not a specific length). Byte-identical
  // default (no --diagnose ⇒ JSON has no `diagnoses` key) is covered by test 8.

  it('7. scan --diagnose --json over corpus → exits 0, flag accepted, diagnoses array present', async () => {
    const { repo, claudeDir } = setupFixture();
    const { stdout, stderr, code } = await runCli([
      'scan',
      '--repo',
      repo,
      '--claude-dir',
      claudeDir,
      '--diagnose',
      '--json',
    ]);

    expect(code).toBe(0);
    expect(stderr).toBe('');
    const parsed = JSON.parse(stdout) as JsonOutput;
    expect(parsed.schema_version).toBe(1);
    expect(parsed.session_count).toBe(2);
    // Task 11: the envelope carries a `diagnoses` array. The corpus is thin
    // (≤1 session per area, scores below floor), so it may be empty — assert
    // shape only, not length.
    expect(parsed.diagnoses).toBeDefined();
    expect(Array.isArray(parsed.diagnoses)).toBe(true);
  });

  it('8. scan --json (no --diagnose) → JSON has no `diagnoses` key (byte-identical default)', async () => {
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
    expect(parsed).not.toHaveProperty('diagnoses');
  });

  it('9. scan --help → lists --diagnose with its description', async () => {
    const { stdout, code } = await runCli(['scan', '--help']);

    expect(code).toBe(0);
    expect(stdout).toContain('--diagnose');
    expect(stdout).toContain('Classify each flagged area into a typed cause');
  });
});

// Task 13: closed-loop command wiring (synthesize / review / explain).
// Spawn-based, mirrors the scan tests above. --help asserts the option surface
// for each new command; a dispatch test per command confirms opts route to the
// right runner and the runner's `output` lands on stdout via the flush-callback
// exit. The conflict case on explain re-asserts `validateHarnessFlags` is
// reused by the harness-bearing commands.

describe('harnessgap CLI closed-loop commands (Task 13)', () => {
  it('10. synthesize --help → lists --unit, --harness, --harness-dir, --claude-dir, --yes, --config', async () => {
    const { stdout, code } = await runCli(['synthesize', '--help']);

    expect(code).toBe(0);
    expect(stdout).toContain('--unit');
    expect(stdout).toContain('--harness');
    expect(stdout).toContain('--harness-dir');
    expect(stdout).toContain('--claude-dir');
    expect(stdout).toContain('--yes');
    expect(stdout).toContain('--config');
  });

  it('11. review --help → lists --repo, --json, --yes, --config', async () => {
    const { stdout, code } = await runCli(['review', '--help']);

    expect(code).toBe(0);
    expect(stdout).toContain('--repo');
    expect(stdout).toContain('--json');
    expect(stdout).toContain('--yes');
    expect(stdout).toContain('--config');
  });

  it('12. explain --help → shows <area> positional + --repo, --harness, --harness-dir, --claude-dir, --config', async () => {
    const { stdout, code } = await runCli(['explain', '--help']);

    expect(code).toBe(0);
    // Commander renders the required positional as `<area>` in usage + help.
    expect(stdout).toContain('<area>');
    expect(stdout).toContain('--repo');
    expect(stdout).toContain('--harness');
    expect(stdout).toContain('--harness-dir');
    expect(stdout).toContain('--claude-dir');
    expect(stdout).toContain('--config');
  });

  it('13. synthesize dispatch → routes opts to runSynthesize, summary on stdout, exit 0', async () => {
    // Fixture: empty git repo + empty claudeDir → 0 sessions → 0 diagnoses.
    // runSynthesize renders its summary "Synthesized 0 proposal(s)…" and the
    // CLI writes result.output + '\n' via the flush callback. Asserting the
    // summary reaches stdout proves the CLI threads opts into runSynthesize
    // and uses the established write+exit path.
    const repoDir = makeTempDir('cli-syn-repo');
    execFileSync('git', ['init', repoDir], { stdio: 'ignore' });
    const repo = realpathSync(repoDir);
    const claudeDir = makeTempDir('cli-syn-claude');

    const { stdout, stderr, code } = await runCli([
      'synthesize',
      '--repo',
      repo,
      '--claude-dir',
      claudeDir,
      '--yes',
    ]);

    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('Synthesized');
  });

  it('14. review dispatch → routes opts to runReview, list on stdout, exit 0', async () => {
    // Fixture: repo with no docs/_proposals/ dir → runReview returns the empty
    // list "No proposals pending review." Confirms the CLI routes opts into
    // runReview and writes result.output on stdout.
    const repoDir = makeTempDir('cli-rev-repo');
    execFileSync('git', ['init', repoDir], { stdio: 'ignore' });
    const repo = realpathSync(repoDir);

    const { stdout, stderr, code } = await runCli(['review', '--repo', repo]);

    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('No proposals pending review');
  });

  it('15. explain dispatch → routes <area> + opts to runExplain, diagnosis line on stdout, exit 0', async () => {
    // Fixture: repo with no transcripts → no flagged areas → runExplain's null
    // branch: "explain: no diagnosis for `<area>` (it is not a flagged area)."
    // The unit key echoing back in the message is load-bearing — it proves the
    // <area> positional reached runExplain as opts.unit (not dropped, not
    // mis-named).
    const repoDir = makeTempDir('cli-exp-repo');
    execFileSync('git', ['init', repoDir], { stdio: 'ignore' });
    const repo = realpathSync(repoDir);
    const claudeDir = makeTempDir('cli-exp-claude');

    const { stdout, stderr, code } = await runCli([
      'explain',
      'src/billing',
      '--repo',
      repo,
      '--claude-dir',
      claudeDir,
    ]);

    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('src/billing');
    expect(stdout).toMatch(/no diagnosis|not a flagged area/);
  });

  it('16. explain --claude-dir X --harness qwen-code → conflict error, non-zero exit (validateHarnessFlags reused)', async () => {
    // Regression guard: explain (a harness-bearing command) must reuse the
    // same validateHarnessFlags conflict rule as scan/reflect. Combining the
    // --claude-dir alias with a non-claude --harness is a hard error.
    const repoDir = makeTempDir('cli-exp-conflict');
    const claudeDir = makeTempDir('cli-exp-conflict-claude');

    const { stdout, stderr, code } = await runCli([
      'explain',
      'src/anything',
      '--repo',
      repoDir,
      '--claude-dir',
      claudeDir,
      '--harness',
      'qwen-code',
    ]);

    expect(code).not.toBe(0);
    // No explain output leaked before the conflict is surfaced.
    expect(stdout).toBe('');
    expect(stderr).toMatch(/conflict/i);
    expect(stderr).toMatch(/--claude-dir/);
    expect(stderr).toMatch(/--harness/);
  });
});
