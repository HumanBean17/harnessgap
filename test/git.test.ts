import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveMainRepo, resolveRepo, walkToRepo, isValidSha } from '../src/git.js';
import type { RepoResolution } from '../src/git.js';

const tmpDirs: string[] = [];

/** Create a temp dir, tracked for cleanup. */
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `harnessgap-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}

/** `git init` a repo at `dir` and add an empty commit (so `worktree add` works). */
function initRepoWithCommit(dir: string): void {
  execFileSync('git', ['init', '-q', dir], { stdio: 'ignore' });
  execFileSync(
    'git',
    ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'],
    { stdio: 'ignore' },
  );
}

afterEach(() => {
  while (tmpDirs.length) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe('resolveMainRepo / resolveRepo / walkToRepo', () => {
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
    expect(walkToRepo('')).toBeNull();
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

  it('recovers the main repo when a NESTED worktree cwd has been DELETED', () => {
    // The real failure mode: the worktree dir is gone, but its path is still in
    // the transcript. Walk-up stat-checks ancestors of the path string and finds
    // the main repo's `.git` dir.
    const main = makeTempDir('main');
    mkdirSync(join(main, '.git'), { recursive: true });
    const deletedWorktree = join(main, '.claude', 'worktrees', 'gone', 'src');

    const real = realpathSync(main);
    expect(resolveMainRepo(deletedWorktree)).toBe(real);
  });

  // --- sibling worktrees: the checkout is a SIBLING of the main repo, not nested ---

  it('recovers a live SIBLING worktree via git registration (real `git worktree add`)', () => {
    // The layout `git worktree add` produces for a sibling clone: the main repo
    // and the worktree checkout share a PARENT, so the main repo is a SIBLING of
    // the cwd, not an ancestor. The plain walk-up misses it; we recover it by
    // reading the main repo's `.git/worktrees/<name>/gitdir` registration. The
    // gitdir file holds `<checkout>/.git` (NOT the checkout root), so this also
    // pins the trailing-`/.git` strip in the resolver.
    const parent = makeTempDir('parent');
    const main = join(parent, 'java-enterprise-codebase-rag');
    const sibling = join(parent, 'java-enterprise-codebase-rag-wt-cli');
    initRepoWithCommit(main);
    execFileSync('git', ['-C', main, 'worktree', 'add', '-q', sibling], { stdio: 'ignore' });

    const real = realpathSync(main);
    // cwd at the sibling root and nested — both resolve to the MAIN repo.
    expect(resolveMainRepo(sibling)).toBe(real);
    expect(resolveMainRepo(join(sibling, 'src', 'deep'))).toBe(real);

    // The resolver also surfaces the worktree checkout root (in the cwd's form)
    // so relativization can strip it. Null for the main checkout, non-null here.
    expect(resolveRepo(main)?.checkoutRoot).toBeNull();
    expect(resolveRepo(sibling)?.checkoutRoot).toBe(sibling);
    expect(resolveRepo(join(sibling, 'src', 'deep'))?.checkoutRoot).toBe(sibling);
  });

  it('recovers a sibling worktree after its checkout is DELETED (the dogfood case)', () => {
    // The real dogfood case: the checkout was deleted, but `gitdir` outlives it.
    // The cwd path no longer exists on disk; the walk-up is purely string-based,
    // and canonicalization maps the deleted cwd onto the realpath git stored.
    const parent = makeTempDir('parent');
    const main = join(parent, 'repo');
    const sibling = join(parent, 'repo-wt-cli');
    initRepoWithCommit(main);
    execFileSync('git', ['-C', main, 'worktree', 'add', '-q', sibling], { stdio: 'ignore' });

    const real = realpathSync(main);
    rmSync(sibling, { recursive: true, force: true }); // checkout gone, gitdir remains

    expect(resolveMainRepo(sibling)).toBe(real);
    expect(resolveMainRepo(join(sibling, 'src', 'deep'))).toBe(real);
    expect(resolveRepo(sibling)?.checkoutRoot).toBe(sibling);
  });

  it('does NOT match a sibling repo whose worktree registration points elsewhere', () => {
    // No false positives: a sibling main repo exists and has a worktree entry,
    // but its `gitdir` does not claim our cwd → no match, falls through to null.
    const parent = makeTempDir('parent');
    const main = join(parent, 'repo');
    const claimed = join(parent, 'repo-wt-other');
    initRepoWithCommit(main);
    execFileSync('git', ['-C', main, 'worktree', 'add', '-q', claimed], { stdio: 'ignore' });
    const cwd = join(parent, 'orphan-session', 'src');
    mkdirSync(cwd, { recursive: true });

    expect(resolveMainRepo(cwd)).toBeNull();
  });

  it('does NOT match when a registered checkout is a string-prefix of the cwd but not a path ancestor', () => {
    // Guards isAncestorOrEqual against a naive startsWith: a worktree registered
    // at <parent>/repo-wt must NOT claim a cwd at <parent>/repo-wt-extra/... .
    const parent = makeTempDir('parent');
    const main = join(parent, 'repo');
    const claimed = join(parent, 'repo-wt'); // registered checkout root
    initRepoWithCommit(main);
    execFileSync('git', ['-C', main, 'worktree', 'add', '-q', claimed], { stdio: 'ignore' });
    const cwd = join(parent, 'repo-wt-extra', 'src'); // string-extends the prefix
    mkdirSync(cwd, { recursive: true });

    expect(resolveMainRepo(cwd)).toBeNull();
  });

  it('memoizes by cwd when a cache Map is passed', () => {
    const dir = makeTempDir('cache');
    execFileSync('git', ['init', dir], { stdio: 'ignore' });
    const real = realpathSync(dir);

    const cache = new Map<string, RepoResolution | null>();
    const r1 = resolveMainRepo(dir, cache);
    const r2 = resolveMainRepo(dir, cache);

    expect(r1).toBe(real);
    expect(r2).toBe(real);
    expect(cache.get(dir)?.repo).toBe(real);
    expect(cache.get(dir)?.checkoutRoot).toBeNull(); // main checkout → no checkout root
  });

  it('caches null results too (non-repo cwd)', () => {
    const dir = makeTempDir('norepo');
    const cache = new Map<string, RepoResolution | null>();
    expect(resolveMainRepo(dir, cache)).toBeNull();
    expect(cache.get(dir)).toBeNull();
  });
});

// isValidSha (Task 7 fact-check helper): sandboxed, read-only commit
// verification. Runs `git cat-file -e <sha>^{commit}` with system/global config
// suppressed so a malformed sha or a non-commit object returns false, never
// throws. The fact-check gate (src/synthesizer/factcheck.ts) consumes this.
describe('isValidSha', () => {
  it('returns true for a real HEAD commit', () => {
    const dir = makeTempDir('sha');
    initRepoWithCommit(dir);
    const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    expect(isValidSha(dir, head)).toBe(true);
  });

  it('returns true for HEAD (ref resolves to a commit)', () => {
    const dir = makeTempDir('sha-ref');
    initRepoWithCommit(dir);
    expect(isValidSha(dir, 'HEAD')).toBe(true);
  });

  it('returns false for a bogus sha', () => {
    const dir = makeTempDir('sha-bogus');
    initRepoWithCommit(dir);
    expect(isValidSha(dir, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).toBe(false);
  });

  it('returns false for an empty string', () => {
    const dir = makeTempDir('sha-empty');
    initRepoWithCommit(dir);
    expect(isValidSha(dir, '')).toBe(false);
  });

  it('returns false (never throws) when repoRoot does not exist', () => {
    expect(isValidSha('/nonexistent/repo/path', 'HEAD')).toBe(false);
  });

  it('returns false for a short/non-existent ref string', () => {
    const dir = makeTempDir('sha-short');
    initRepoWithCommit(dir);
    expect(isValidSha(dir, 'not-a-real-ref')).toBe(false);
  });
});
