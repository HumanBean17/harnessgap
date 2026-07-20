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
import { runScan, runReflect } from '../src/pipeline.js';
import type { JsonOutput, ReflectFinding } from '../src/types.js';

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

/**
 * git-init a repo WITH a commit (needed for `git worktree add`), then add a real
 * SIBLING worktree checkout beside it. Returns the canonical main repo, the
 * sibling checkout path, and a claudeDir. The sibling layout is what
 * `git worktree add <beside-repo>` produces and what issue #3 recovers.
 */
function setupSiblingWorktree(): { repo: string; sibling: string; claudeDir: string } {
  const parent = makeTempDir('parent');
  const mainDir = join(parent, 'myrepo');
  execFileSync('git', ['init', '-q', mainDir], { stdio: 'ignore' });
  execFileSync(
    'git',
    ['-C', mainDir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'],
    { stdio: 'ignore' },
  );
  const repo = realpathSync(mainDir);
  const sibling = join(parent, 'myrepo-wt-cli');
  execFileSync('git', ['-C', mainDir, 'worktree', 'add', '-q', sibling], { stdio: 'ignore' });
  const claudeDir = makeTempDir('claude');
  return { repo, sibling, claudeDir };
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

  it('collapses a .worktrees/<name>/ checkout and the main checkout into ONE area (issue #30)', async () => {
    const { repo, claudeDir } = setup();

    // A live worktree checkout under `.worktrees/feat-add` (the hidden checkout
    // dir named `worktrees` itself — the layout real transcripts use that the
    // old WORKTREE_RE missed).
    const wt = join(repo, '.worktrees', 'feat-add');
    mkdirSync(join(wt, 'src', 'billing'), { recursive: true });
    writeFileSync(join(wt, '.git'), 'gitdir: ../../.git/worktrees/feat-add');

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

    expect(parsed.session_count).toBe(2);
    // Exactly ONE area row — the `.worktrees/feat-add/` prefix collapsed.
    const areas = parsed.areas.filter((a) => a.key === 'src/billing');
    expect(areas).toHaveLength(1);
    expect(areas[0]!.sessions_total).toBe(2);
    // No area key carries a `.worktrees` prefix.
    for (const a of parsed.areas) {
      expect(a.key).not.toContain('.worktrees');
      expect(a.key).not.toContain('worktrees/');
    }
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

  // --- sibling worktrees (issue #3): the checkout is BESIDE the main repo ---

  it('recovers a SIBLING-worktree session and aggregates it with the main checkout', async () => {
    const { repo, sibling, claudeDir } = setupSiblingWorktree();

    // Session A: run from the main repo, edit the main copy.
    writeSession(claudeDir, 'main', transcript(repo, join(repo, 'src', 'billing', 'a.ts')));
    // Session B: run from the SIBLING worktree, edit the sibling copy of the SAME
    // file. Its paths are absolute and OUTSIDE the repo prefix, so without the
    // checkout-root strip they would fragment into an absolute-path area.
    writeSession(
      claudeDir,
      'sibling',
      transcript(sibling, join(sibling, 'src', 'billing', 'a.ts')),
    );

    const parsed = await scanJson(repo, claudeDir);

    // Both sessions scanned — the sibling-worktree session was RECOVERED, not dropped.
    expect(parsed.session_count).toBe(2);
    expect(parsed.warnings.unresolvable_cwd).toBe(0);
    // Exactly ONE area row — the sibling file collapsed onto the main checkout's area.
    const areas = parsed.areas.filter((a) => a.key === 'src/billing');
    expect(areas).toHaveLength(1);
    expect(areas[0]!.sessions_total).toBe(2);
    // No area key leaked the sibling-worktree prefix or stayed absolute.
    for (const a of parsed.areas) {
      expect(a.key.startsWith('/')).toBe(false);
      expect(a.key).not.toContain('-wt-cli');
    }
  });

  it('recovers a session whose cwd was a since-deleted SIBLING worktree (the dogfood case)', async () => {
    const { repo, sibling, claudeDir } = setupSiblingWorktree();

    // A session referencing the sibling checkout, then DELETE the checkout. Its
    // `gitdir` registration in the main repo outlives it — the only evidence left.
    writeSession(
      claudeDir,
      'deleted-sibling',
      transcript(sibling, join(sibling, 'src', 'billing', 'c.ts')),
    );
    rmSync(sibling, { recursive: true, force: true });
    // One healthy session in the main checkout alongside it.
    writeSession(claudeDir, 'main', transcript(repo, join(repo, 'src', 'billing', 'd.ts')));

    const parsed = await scanJson(repo, claudeDir);

    // The deleted-sibling session was RECOVERED, not counted as unresolvable.
    expect(parsed.session_count).toBe(2);
    expect(parsed.warnings.unresolvable_cwd).toBe(0);
    // Its file relativized (via the recovered checkout root) to the canonical area.
    const area = parsed.areas.find((a) => a.key === 'src/billing');
    expect(area).toBeDefined();
    expect(area!.sessions_total).toBe(2);
    for (const a of parsed.areas) {
      expect(a.key.startsWith('/')).toBe(false);
    }
  });

  it('runReflect --transcript: a sibling-worktree session relativizes onto the main repo areas', async () => {
    // Guards the reflect path's checkout-root threading (buildFindingFromEnvelope
    // resolves checkoutRoot from cwds and passes it to relativize). Without it the
    // sibling file would survive as an absolute area key.
    const { sibling, claudeDir } = setupSiblingWorktree();
    writeSession(
      claudeDir,
      'sib',
      transcript(sibling, join(sibling, 'src', 'billing', 'a.ts')),
    );
    const file = join(claudeDir, 'projects', 'slug', 'sib.jsonl');

    const result = await runReflect({ transcript: file, format: 'json' });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.output) as ReflectFinding;

    // The sibling-worktree file relativized (via the recovered checkout root) to a
    // repo-relative area — NOT an absolute path leaking the sibling-worktree prefix.
    const keys = parsed.record.areas.map((a) => a.key);
    expect(keys).toContain('src/billing');
    for (const k of keys) {
      expect(k.startsWith('/')).toBe(false);
      expect(k).not.toContain('-wt-cli');
    }
  });
});
