import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveMainRepo, walkToMainRepo } from '../src/git.js';

const tmpDirs: string[] = [];

/** Create a temp dir, tracked for cleanup. */
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `harnessgap-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe('resolveMainRepo / walkToMainRepo', () => {
  it('returns the repo root for a real git repo (realpath)', () => {
    const dir = makeTempDir('repo');
    execFileSync('git', ['init', dir], { stdio: 'ignore' });
    const result = resolveMainRepo(dir);
    expect(result).toBe(realpathSync(dir));
  });

  it('returns null for a non-git temp dir (no throw)', () => {
    const dir = makeTempDir('nongit');
    expect(resolveMainRepo(dir)).toBeNull();
  });

  it('finds the repo from a subdirectory (walks up)', () => {
    const dir = makeTempDir('repo');
    execFileSync('git', ['init', dir], { stdio: 'ignore' });
    const sub = join(dir, 'src', 'deep', 'nested');
    mkdirSync(sub, { recursive: true });
    const real = realpathSync(dir);
    expect(resolveMainRepo(sub)).toBe(real);
  });

  it('returns null for empty cwd (never falls back to process.cwd)', () => {
    // Guard: streamSession returns cwd='' when no record carries one. An empty
    // cwd must NOT resolve to the harness's own repo.
    expect(resolveMainRepo('')).toBeNull();
    expect(walkToMainRepo('')).toBeNull();
  });

  it('skips a worktree `.git` FILE and walks up to the main repo `.git` dir', () => {
    // Simulate a worktree checkout: a `.git` *file* (gitfile) at the checkout,
    // and a real `.git` *directory* at the main repo root.
    const main = makeTempDir('main');
    mkdirSync(join(main, '.git'), { recursive: true }); // main repo .git dir
    const worktree = join(main, '.claude', 'worktrees', 'feat-x', 'src');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(main, '.claude', 'worktrees', 'feat-x', '.git'), 'gitdir: ../../.git/worktrees/feat-x');

    const real = realpathSync(main);
    // Resolving from inside the worktree returns the MAIN repo, not the worktree.
    expect(resolveMainRepo(worktree)).toBe(real);
  });

  it('recovers the main repo when the worktree cwd has been DELETED', () => {
    // The real failure mode: the worktree dir is gone, but its path is still in
    // the transcript. Walk-up stat-checks ancestors of the path string and finds
    // the main repo's `.git` dir.
    const main = makeTempDir('main');
    mkdirSync(join(main, '.git'), { recursive: true });
    const deletedWorktree = join(main, '.claude', 'worktrees', 'gone', 'src');

    const real = realpathSync(main);
    expect(resolveMainRepo(deletedWorktree)).toBe(real);
  });

  it('memoizes by cwd when a cache Map is passed (stat invoked once)', () => {
    const dir = makeTempDir('cache');
    execFileSync('git', ['init', dir], { stdio: 'ignore' });
    const real = realpathSync(dir);

    const cache = new Map<string, string | null>();
    const r1 = resolveMainRepo(dir, cache);
    const r2 = resolveMainRepo(dir, cache);

    expect(r1).toBe(real);
    expect(r2).toBe(real);
    expect(cache.get(dir)).toBe(real);
  });

  it('caches null results too (non-repo cwd)', () => {
    const dir = makeTempDir('norepo');
    const cache = new Map<string, string | null>();
    expect(resolveMainRepo(dir, cache)).toBeNull();
    expect(cache.get(dir)).toBeNull();
  });
});
