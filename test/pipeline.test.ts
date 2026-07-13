import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runScan } from '../src/pipeline.js';
import type { JsonOutput } from '../src/types.js';

// Pipeline orchestration tests: build a real temp claudeDir + temp git repo,
// write real .jsonl transcripts, and exercise runScan end-to-end. No mocking —
// real filesystem, real git, real streaming, real detection.

const TS1 = '2026-07-12T12:00:00.000Z';
const TS2 = '2026-07-12T12:00:01.000Z';
const TS3 = '2026-07-12T12:00:02.000Z';
const TS4 = '2026-07-12T12:00:03.000Z';
const TS5 = '2026-07-12T12:00:04.000Z';

const tmpDirs: string[] = [];

/** Create a temp dir, tracked for cleanup. */
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `harnessgap-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Transcript record builders (valid Claude Code JSONL shapes) ---

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

/**
 * Build a 5-line transcript: user text → Read → result → Edit → result.
 * Produces a read + edit under `src/billing/<file>`, giving the detector
 * an area (src/billing) and non-trivial signals.
 */
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
  const repoDir = makeTempDir('pipe-repo');
  execFileSync('git', ['init', repoDir], { stdio: 'ignore' });
  const repo = realpathSync(repoDir);

  const claudeDir = makeTempDir('pipe-claude');
  const slug = join(claudeDir, 'projects', 'test-slug');
  mkdirSync(slug, { recursive: true });
  writeFileSync(join(slug, 'sess1.jsonl'), billingTranscript(repoDir, 'src/billing/a.ts'), 'utf8');
  writeFileSync(join(slug, 'sess2.jsonl'), billingTranscript(repoDir, 'src/billing/b.ts'), 'utf8');

  return { repo, claudeDir };
}

/** Fixture: 1 valid + 1 unresolvable-cwd transcript. */
function setupUnresolvableFixture(): { repo: string; claudeDir: string } {
  const repoDir = makeTempDir('pipe-repo-bad');
  execFileSync('git', ['init', repoDir], { stdio: 'ignore' });
  const repo = realpathSync(repoDir);

  const claudeDir = makeTempDir('pipe-claude-bad');
  const slug = join(claudeDir, 'projects', 'mixed-slug');
  mkdirSync(slug, { recursive: true });
  // Valid session.
  writeFileSync(join(slug, 'good.jsonl'), billingTranscript(repoDir, 'src/billing/a.ts'), 'utf8');
  // Invalid session: cwd points at a non-existent directory.
  const badCwd = '/nonexistent/harnessgap/test-' + Date.now();
  writeFileSync(join(slug, 'bad.jsonl'), billingTranscript(badCwd, 'src/billing/b.ts'), 'utf8');

  return { repo, claudeDir };
}

describe('runScan (pipeline orchestration)', () => {
  it('1. basic scan → 2 sessions, exitCode 0, human output with areas', async () => {
    const { repo, claudeDir } = setupFixture();
    const result = await runScan({ repo, claudeDir });

    expect(result.exitCode).toBe(0);
    expect(result.sessionCount).toBe(2);
    expect(result.mode).toBe('bootstrap');
    expect(result.warnings.unresolvable_cwd).toBe(0);
    expect(result.warnings.skipped_sessions).toBe(0);
    expect(result.warnings.symlinks_rejected).toBe(0);
    expect(result.output).toContain('harnessgap scan');
    // Output includes the area or a "no flagged" line.
    expect(result.output).toMatch(/src\/billing|No flagged areas/);
  });

  it('2. --json → output parses as JsonOutput, mode reflects session count (2 → bootstrap)', async () => {
    const { repo, claudeDir } = setupFixture();
    const result = await runScan({ repo, claudeDir, json: true });

    expect(result.sessionCount).toBe(2);
    const parsed = JSON.parse(result.output) as JsonOutput;
    expect(parsed.schema_version).toBe(1);
    expect(parsed.repo).toBe(repo);
    expect(parsed.mode).toBe('bootstrap');
    expect(parsed.session_count).toBe(2);
    expect(Array.isArray(parsed.sessions)).toBe(true);
    expect(parsed.sessions.length).toBe(2);
    expect(Array.isArray(parsed.areas)).toBe(true);
    // Warnings are projected into the JSON envelope.
    expect(parsed.warnings).toEqual(result.warnings);
  });

  it('3. --bootstrap → mode==="bootstrap" (flag threaded, sessions scanned)', async () => {
    const { repo, claudeDir } = setupFixture();
    const result = await runScan({ repo, claudeDir, bootstrap: true });

    expect(result.mode).toBe('bootstrap');
    expect(result.sessionCount).toBe(2);
  });

  it('4. --limit 1 → sessionCount===1 (cap applied after filtering)', async () => {
    const { repo, claudeDir } = setupFixture();
    const result = await runScan({ repo, claudeDir, limit: 1 });

    expect(result.sessionCount).toBe(1);
    expect(result.exitCode).toBe(0);
  });

  it('5. unresolvable cwd → warnings.unresolvable_cwd===1, NOT double-counted in skipped_sessions', async () => {
    const { repo, claudeDir } = setupUnresolvableFixture();
    const result = await runScan({ repo, claudeDir });

    expect(result.warnings.unresolvable_cwd).toBe(1);
    // The specific reason is counted once; skipped_sessions is reserved for
    // other skip reasons and stays 0 (no double-count in the warnings line).
    expect(result.warnings.skipped_sessions).toBe(0);
    expect(result.sessionCount).toBe(1);
    expect(result.exitCode).toBe(0);
  });

  it('6. empty claudeDir → sessionCount===0, exitCode===0, output says no sessions', async () => {
    const claudeDir = makeTempDir('pipe-empty');
    const result = await runScan({ claudeDir });

    expect(result.sessionCount).toBe(0);
    expect(result.exitCode).toBe(0);
    expect(result.mode).toBe('bootstrap');
    expect(result.output).toContain('0 sessions');
  });

  it('7. --calibrate → calibrate table (and JSON object with --json)', async () => {
    const { repo, claudeDir } = setupFixture();

    // Human table.
    const tableResult = await runScan({ repo, claudeDir, calibrate: true });
    expect(tableResult.output).toContain('harnessgap calibrate');
    expect(tableResult.output).toContain('SIGNAL');
    expect(tableResult.output).toContain('reread');
    expect(tableResult.sessionCount).toBe(2);

    // JSON object (NOT the scan envelope).
    const jsonResult = await runScan({ repo, claudeDir, calibrate: true, json: true });
    const parsed = JSON.parse(jsonResult.output) as {
      mode: string;
      session_count: number;
      flag_pct: number;
      signals: Record<string, unknown>;
    };
    expect(parsed.mode).toBe('bootstrap');
    expect(parsed.session_count).toBe(2);
    expect(parsed.flag_pct).toBe(90);
    expect(parsed.signals).toBeDefined();
    expect(parsed.signals.reread).toBeDefined();
    // Must NOT be the scan envelope shape.
    expect(parsed).not.toHaveProperty('schema_version');
    expect(parsed).not.toHaveProperty('sessions');
    expect(parsed).not.toHaveProperty('areas');
  });
});
