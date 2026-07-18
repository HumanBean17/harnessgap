import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Resolve the MAIN repo root for a path — and, when the cwd lived in a SIBLING
 * worktree, recover that main repo via git's own worktree registration.
 *
 * Why a directory `.git`: a worktree checkout holds a `.git` *file* (a gitfile
 * pointing into the main repo's `.git/worktrees/`), while the main repo holds a
 * `.git` *directory*. Walking up to the first directory `.git` therefore returns
 * the main repo root uniformly for:
 *   - the main checkout           → `<main>/.git` (dir)
 *   - a live worktree checkout    → its own `.git` is a file; walks up to main
 *   - a DELETED worktree nested under the main repo → ancestor dirs may be gone,
 *                                   but the walk stat-checks each ancestor of the
 *                                   path string and still finds the main repo's `.git`
 *
 * Sibling worktrees (recovered): a session whose cwd lived in a worktree whose
 * checkout was a SIBLING of the main repo — e.g. `…/CursorProjects/<repo>-wt-cli`
 * sitting beside `…/CursorProjects/<repo>`, the layout `git worktree add …`
 * produces for a sibling clone — never hits the main repo's `.git` on the walk
 * up, because the main repo is a sibling, not an ancestor. (This dropped ~29% of
 * sessions on a worktree-heavy repo.) For these, at each ancestor the walk also
 * scans SIBLING dirs for a `.git` directory and reads that candidate's
 * `.git/worktrees/<name>/gitdir`; if any registered worktree checkout equals or is
 * an ancestor of the cwd, that sibling is the main repo. This attributes sibling
 * worktrees regardless of naming convention (no `-wt-` heuristic). When this path
 * fires, the recovered checkout root is returned alongside the repo so that
 * sibling-worktree file paths can be relativized onto the main checkout's areas.
 *
 * This replaces an earlier `git rev-parse --show-toplevel` call. That returned
 * the *worktree* root for worktree sessions (so `--repo <main>` excluded them)
 * and failed outright for deleted worktree cwds — which dropped ~74% of sessions
 * on a worktree-heavy repo. Stat-walk fixes both and spawns no process at all,
 * so the previous git-sandbox concerns (env, hooks, fsmonitor) are moot.
 *
 * `cwd` originates from transcripts (untrusted). This function only `stat`s and
 * `readdir`s ancestor/sibling paths and reads the tiny `gitdir` text files under
 * candidate `.git/worktrees/`; it never invokes git, never shells out, never
 * writes. Returns `null` (never throws) when no main repo can be attributed
 * (including empty/missing `cwd`). Memoized by `cwd`.
 */

/**
 * The result of resolving a cwd to its main repo.
 */
export interface RepoResolution {
  /** Main repo root, canonicalized (symlinks resolved). */
  repo: string;
  /**
   * The cwd's worktree CHECKOUT root, but ONLY when the cwd lived in a SIBLING
   * worktree (a checkout BESIDE the main repo, not nested under it). Relativization
   * strips this prefix so sibling-worktree files collapse onto the same repo-relative
   * areas as the main checkout. Null for the main checkout and for nested worktrees
   * (those relativize via the repo-root prefix + the `WORKTREE_RE` pattern).
   */
  checkoutRoot: string | null;
}

/** Resolve a cwd to its main repo (+ sibling-worktree checkout root if any). Memoized by `cwd`. */
export function resolveRepo(
  cwd: string,
  cache?: Map<string, RepoResolution | null>,
): RepoResolution | null {
  if (cache?.has(cwd)) return cache.get(cwd) ?? null;

  const result = walkToRepo(cwd);
  cache?.set(cwd, result);
  return result;
}

/** Convenience: just the main repo root, for callers that don't need the checkout root. */
export function resolveMainRepo(
  cwd: string,
  cache?: Map<string, RepoResolution | null>,
): string | null {
  return resolveRepo(cwd, cache)?.repo ?? null;
}

/**
 * Pure walk-up (no memoization). Exported for direct unit testing.
 * Resolves `cwd` to an absolute path, then climbs ancestor directories until one
 * has a `.git` directory (the main repo). At each ancestor that lacks one, also
 * scans SIBLING directories for a candidate main repo whose worktree registration
 * claims the cwd (recovers deleted sibling worktrees).
 */
export function walkToRepo(cwd: string): RepoResolution | null {
  if (cwd === '') return null;

  // path.resolve('') === process.cwd(); guard explicitly so an empty cwd never
  // resolves to the harness's own repo.
  const resolvedCwd = path.resolve(cwd);
  // Canonicalize for the sibling-worktree comparison: git stores realpath-resolved
  // paths in `gitdir` (e.g. `/private/var/...`), while a transcript cwd may be in
  // an un-resolved form (e.g. `/var/...`); the comparison is string-based, so both
  // sides must be canonicalized first. Best-effort: a deleted cwd can't be realpath'd,
  // so its deepest existing ancestor is canonicalized and the tail re-appended.
  const canonicalCwd = canonicalizeBestEffort(resolvedCwd);
  const root = path.parse(resolvedCwd).root;

  // Climb until we hit the filesystem root. `path.dirname(root) === root`.
  let dir = resolvedCwd;
  for (;;) {
    // Fast path: main repo is an ancestor (the common case — main checkout,
    // nested worktree, or a worktree deleted but still nested under the main repo).
    if (hasGitDir(dir)) {
      return { repo: realpathOrSelf(dir), checkoutRoot: null };
    }

    // Fallback: a since-deleted SIBLING worktree. The cwd lived in a worktree
    // whose checkout was a sibling of the main repo (not nested under it), so
    // the walk-up never reaches the main repo's `.git`. Scan `dir`'s siblings
    // for a candidate main repo whose `.git/worktrees/<name>/gitdir` claims our cwd.
    const sibling = findRegisteredSiblingRepo(dir, canonicalCwd);
    if (sibling !== null) {
      // The checkout root came back canonical (it matched git's gitdir). Map it
      // into the cwd's (possibly un-resolved) form so it matches the file paths
      // transcripts record under that cwd — lets relativization strip it even
      // when the project lives under a symlink (e.g. `/tmp` vs `/private/tmp`).
      const checkoutRoot = withInputForm(sibling.checkoutRoot, canonicalCwd, resolvedCwd);
      return { repo: sibling.repo, checkoutRoot };
    }

    if (dir === root) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // defensive: no infinite loop
    dir = parent;
  }
}

/**
 * Look among `dir`'s siblings for a main repo whose git worktree registration
 * claims a checkout path that equals or contains the cwd. Returns that sibling
 * repo (canonicalized) and the claimed checkout root on the first match, else
 * null. Used to recover sessions whose cwd lived in a since-deleted SIBLING
 * worktree (the main repo is a sibling of the cwd, not an ancestor, so the plain
 * walk-up misses it).
 *
 * Only `readdir`s the shared parent and reads tiny `gitdir` text files under
 * each candidate's `.git/worktrees/`; never invokes git.
 */
function findRegisteredSiblingRepo(
  dir: string,
  target: string,
): { repo: string; checkoutRoot: string } | null {
  const parent = path.dirname(dir);
  if (parent === dir) return null; // at the filesystem root: no siblings

  let siblings: string[];
  try {
    siblings = fs.readdirSync(parent);
  } catch {
    return null; // parent unreadable / missing
  }

  const self = path.basename(dir);
  for (const name of siblings) {
    if (name === self) continue; // `dir` itself is not its own sibling
    const candidate = path.join(parent, name);
    if (!hasGitDir(candidate)) continue; // only a directory `.git` marks a main repo
    const checkout = findClaimedCheckout(candidate, target);
    if (checkout !== null) {
      return { repo: realpathOrSelf(candidate), checkoutRoot: checkout };
    }
  }
  return null;
}

/**
 * Read `<repo>/.git/worktrees/<name>/gitdir` and return the canonical CHECKOUT
 * root of the first registered worktree whose path equals or contains `target`,
 * else null.
 *
 * `gitdir` holds the path to the worktree's `.git` *file* (`<checkout>/.git`), NOT
 * the checkout root — the trailing `/.git` is stripped to recover the root. Paths
 * are canonicalized (best-effort) before comparison because git stores
 * realpath-resolved paths (e.g. `/private/var/...`) that may differ from the
 * transcript cwd's form. The returned checkout root (canonical) is what the
 * caller passes to relativization.
 */
function findClaimedCheckout(repo: string, target: string): string | null {
  const worktreesDir = path.join(repo, '.git', 'worktrees');
  let names: string[];
  try {
    names = fs.readdirSync(worktreesDir);
  } catch {
    return null; // no worktrees registered
  }

  for (const name of names) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(worktreesDir, name, 'gitdir'), 'utf8');
    } catch {
      continue; // malformed / partial worktree entry — skip
    }
    const raw = content.trim();
    // gitdir points at `<checkout>/.git` — strip the trailing `/.git` to recover
    // the checkout root. (Defensive: only strip when the basename really is `.git`.)
    const checkout = path.basename(raw) === '.git' ? path.dirname(raw) : raw;
    const canonical = canonicalizeBestEffort(checkout);
    if (isAncestorOrEqual(canonical, target)) return canonical;
  }
  return null;
}

/**
 * Express `canonicalAncestor` (a canonical path that equals or is an ancestor of
 * `canonicalCwd`) in the possibly un-resolved form of `inputCwd`. A transcript's
 * cwd and its file paths share the same form, so returning the checkout root in
 * the cwd's form lets relativization strip it even when the project lives under
 * a symlink (cwd `/tmp/x` while git stored `/private/tmp/x`). Degenerates to the
 * canonical form when `inputCwd` is already canonical (no symlinks).
 */
function withInputForm(
  canonicalAncestor: string,
  canonicalCwd: string,
  inputCwd: string,
): string {
  const rel = path.relative(canonicalAncestor, canonicalCwd);
  if (rel === '') return inputCwd; // ancestor is the cwd itself
  if (rel.startsWith('..')) return canonicalAncestor; // not an ancestor (shouldn't happen) — fall back
  const tail = '/' + rel;
  return inputCwd.endsWith(tail)
    ? inputCwd.slice(0, inputCwd.length - tail.length)
    : canonicalAncestor;
}

/**
 * Best-effort canonicalize `p` (resolve symlinks). If `p` exists this is just
 * `realpathSync`. If not (a since-deleted worktree cwd), walk up to its deepest
 * existing ancestor, canonicalize that, and re-append the non-existent tail — so
 * `/tmp/x/wt` whose ancestor `/tmp/x` is a symlink to `/private/tmp/x` resolves to
 * `/private/tmp/x/wt`, matching the realpath git stored in `gitdir`.
 */
function canonicalizeBestEffort(p: string): string {
  const root = path.parse(p).root;
  let existing = p;
  const tail: string[] = [];
  // Climb to the deepest existing ancestor. The `tail.length < 64` bound is a
  // defensive guard against a pathological/non-existent path (real cwds are
  // shallow); if it ever trips, `p` is returned un-canonicalized and the caller
  // falls back to a literal string comparison.
  while (tail.length < 64) {
    try {
      const real = fs.realpathSync(existing);
      return tail.length === 0 ? real : path.join(real, ...tail);
    } catch {
      if (existing === root) return p; // nothing exists up to the root
      tail.unshift(path.basename(existing));
      const parent = path.dirname(existing);
      if (parent === existing) return p; // defensive: no infinite loop
      existing = parent;
    }
  }
  return p;
}

/**
 * Canonicalize (resolve symlinks) so repo filtering matches across callers
 * regardless of how each path was spelled. macOS `/var` → `/private/var` is the
 * common case; git rev-parse did this implicitly. Falls back to the literal path
 * if the target is unreadable.
 */
function realpathOrSelf(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
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

/** True iff `ancestor === target` or `target` lives inside `ancestor` (both absolute). */
function isAncestorOrEqual(ancestor: string, target: string): boolean {
  if (!path.isAbsolute(ancestor) || !path.isAbsolute(target)) return false;
  const rel = path.relative(ancestor, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
