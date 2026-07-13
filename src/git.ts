import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Resolve the MAIN repo root for a path, by walking up the filesystem to the
 * nearest ancestor whose `.git` is a directory.
 *
 * Why a directory `.git`: a worktree checkout holds a `.git` *file* (a gitfile
 * pointing into the main repo's `.git/worktrees/`), while the main repo holds a
 * `.git` *directory*. Walking up to the first directory `.git` therefore returns
 * the main repo root uniformly for:
 *   - the main checkout           → `<main>/.git` (dir)
 *   - a live worktree checkout    → its own `.git` is a file; walks up to main
 *   - a DELETED worktree          → ancestor dirs may be gone, but the walk
 *                                   stat-checks each ancestor of the path string
 *                                   and still finds the main repo's `.git`
 *
 * This replaces an earlier `git rev-parse --show-toplevel` call. That returned
 * the *worktree* root for worktree sessions (so `--repo <main>` excluded them)
 * and failed outright for deleted worktree cwds — which dropped ~74% of sessions
 * on a worktree-heavy repo. Stat-walk fixes both and spawns no process at all,
 * so the previous git-sandbox concerns (env, hooks, fsmonitor) are moot.
 *
 * `cwd` originates from transcripts (untrusted). This function only `stat`s
 * `<ancestor>/.git` paths; it never invokes git, never shells out, never reads
 * file contents, never writes. Returns `null` (never throws) when no ancestor
 * has a directory `.git` (including empty/missing `cwd`). Memoized by `cwd`.
 */
export function resolveMainRepo(
  cwd: string,
  cache?: Map<string, string | null>,
): string | null {
  if (cache?.has(cwd)) return cache.get(cwd) ?? null;

  const result = walkToMainRepo(cwd);
  cache?.set(cwd, result);
  return result;
}

/**
 * Pure walk-up (no memoization). Exported for direct unit testing.
 * Resolves `cwd` to an absolute path, then climbs ancestor directories until
 * one has a `.git` entry that is a directory.
 */
export function walkToMainRepo(cwd: string): string | null {
  if (cwd === '') return null;

  // path.resolve('') === process.cwd(); guard explicitly so an empty cwd never
  // resolves to the harness's own repo.
  let dir = path.resolve(cwd);
  const root = path.parse(dir).root;

  // Climb until we hit the filesystem root. `path.dirname(root) === root`.
  for (;;) {
    if (hasGitDir(dir)) {
      // Canonicalize (resolve symlinks) so repo filtering matches across
      // callers regardless of how each path was spelled. macOS `/var` →
      // `/private/var` is the common case; git rev-parse did this implicitly.
      try {
        return fs.realpathSync(dir);
      } catch {
        return dir;
      }
    }
    if (dir === root) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // defensive: no infinite loop
    dir = parent;
  }
}

/** True iff `<dir>/.git` exists and is a directory (the main-repo marker). */
function hasGitDir(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, '.git')).isDirectory();
  } catch {
    return false;
  }
}
