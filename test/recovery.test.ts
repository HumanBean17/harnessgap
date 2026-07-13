// End-to-end tests for the truthfulness track: repo resolution + path
// relativization over REAL transcripts with absolute paths (the shape real
// Claude Code transcripts have, which the synthetic corpus does not cover).
//
// Covers the two dogfood wins:
//   1. A file edited in a worktree checkout and in the main checkout aggregates
//      into ONE area (worktree prefix collapse + repo normalization).
//   2. A session whose cwd was a since-deleted worktree is RECOVERED (walk-up to
//      the main repo's `.git`) instead of dropped.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runScan } from '../src/pipeline.js';
import type { JsonOutput } from '../src/types.js';

const tmpDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `hg-recovery-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

const TS = ['2026-07-12T12:00:00.000Z', '2026-07-12T12:00:01.000Z'];

/** A minimal read+edit transcript touching `absFile`, run from `cwd`. */
function transcript(cwd: string, absFile: string): string {
  const lines = [
    JSON.stringify({
      type: 'user',
      timestamp: TS[0],
      cwd,
      message: { role: 'user', content: 'go' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: TS[0],
      cwd,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Read', input: { file_path: absFile } }],
      },
    }),
    JSON.stringify({
      type: 'user',
      timestamp: TS[1],
      cwd,
      message: { role: 'user', content: [{ type: 'tool_result', is_error: false }] },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: TS[1],
      cwd,
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            name: 'Edit',
            input: { file_path: absFile, old_string: 'x', new_string: 'y\nz' },
          },
        ],
      },
    }),
    JSON.stringify({
      type: 'user',
      timestamp: TS[1],
      cwd,
      message: { role: 'user', content: [{ type: 'tool_result', is_error: false }] },
    }),
  ];
  return lines.join('\n') + '\n';
}

function writeSession(claudeDir: string, name: string, jsonl: string): void {
  const slug = join(claudeDir, 'projects', 'slug');
  mkdirSync(slug, { recursive: true });
  writeFileSync(join(slug, `${name}.jsonl`), jsonl, 'utf8');
}

/** git-init a temp repo (realpath'd) + a temp claudeDir. */
function setup(): { repo: string; claudeDir: string } {
  const repoDir = makeTempDir('repo');
  execFileSync('git', ['init', repoDir], { stdio: 'ignore' });
  const repo = realpathSync(repoDir);
  const claudeDir = makeTempDir('claude');
  return { repo, claudeDir };
}

async function scanJson(repo: string, claudeDir: string): Promise<JsonOutput> {
  const result = await runScan({ repo, claudeDir, json: true });
  return JSON.parse(result.output) as JsonOutput;
}

describe('truthfulness: worktree aggregation + deleted-cwd recovery', () => {
  it('collapses a worktree checkout and the main checkout into ONE area', async () => {
    const { repo, claudeDir } = setup();

    // Live worktree checkout under .claude/worktrees/feat, with a `.git` FILE
    // (gitfile) — the way real git worktrees look on disk.
    const wt = join(repo, '.claude', 'worktrees', 'feat');
    mkdirSync(join(wt, 'src', 'billing'), { recursive: true });
    writeFileSync(join(wt, '.git'), 'gitdir: ../../../.git/worktrees/feat');

    // Session A: run from the main repo, edit the main copy.
    writeSession(
      claudeDir,
      'main',
      transcript(repo, join(repo, 'src', 'billing', 'a.ts')),
    );
    // Session B: run from the worktree, edit the worktree copy of the SAME file.
    writeSession(
      claudeDir,
      'worktree',
      transcript(wt, join(wt, 'src', 'billing', 'a.ts')),
    );

    const parsed = await scanJson(repo, claudeDir);

    // Both sessions scanned (no cwd losses).
    expect(parsed.session_count).toBe(2);
    expect(parsed.warnings.unresolvable_cwd).toBe(0);
    // Exactly ONE area row — the two sessions aggregated, not split.
    const areas = parsed.areas.filter((a) => a.key === 'src/billing');
    expect(areas).toHaveLength(1);
    expect(areas[0]!.sessions_total).toBe(2);
    // No area key carries a worktree prefix or absolute path.
    for (const a of parsed.areas) {
      expect(a.key).not.toContain('worktrees');
      expect(a.key.startsWith('/')).toBe(false);
    }
  });

  it('recovers a session whose cwd was a since-deleted worktree', async () => {
    const { repo, claudeDir } = setup();

    // A worktree path that does NOT exist on disk (deleted after merge). The
    // transcript still references it as cwd and in absolute file paths.
    const gone = join(repo, '.claude', 'worktrees', 'gone');
    writeSession(
      claudeDir,
      'deleted',
      transcript(gone, join(gone, 'src', 'billing', 'c.ts')),
    );
    // One healthy session alongside it.
    writeSession(
      claudeDir,
      'main',
      transcript(repo, join(repo, 'src', 'billing', 'd.ts')),
    );

    const parsed = await scanJson(repo, claudeDir);

    // The deleted-worktree session was RECOVERED, not dropped.
    expect(parsed.session_count).toBe(2);
    expect(parsed.warnings.unresolvable_cwd).toBe(0);
    // Its files relativized + worktree-stripped to the canonical area.
    const area = parsed.areas.find((a) => a.key === 'src/billing');
    expect(area).toBeDefined();
    expect(area!.sessions_total).toBe(2);
  });

  it('normalizes --repo <worktree path> to the whole project', async () => {
    const { repo, claudeDir } = setup();
    const wt = join(repo, '.claude', 'worktrees', 'feat');
    mkdirSync(join(wt, 'src', 'billing'), { recursive: true });
    writeFileSync(join(wt, '.git'), 'gitdir: ../../../.git/worktrees/feat');
    writeSession(
      claudeDir,
      'main',
      transcript(repo, join(repo, 'src', 'billing', 'a.ts')),
    );

    // Passing the worktree path as --repo still matches the main-repo session.
    const result = await runScan({ repo: wt, claudeDir, json: true });
    const parsed = JSON.parse(result.output) as JsonOutput;
    expect(parsed.session_count).toBe(1);
    expect(parsed.warnings.unresolvable_cwd).toBe(0);
  });
});
