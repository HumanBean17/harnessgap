// Doc-existence grounding for the Diagnoser (Slice 4, Task 6). The only new
// I/O in the slice: recursively list files under the configured `docs_dirs`,
// path-confined to the repo root, never following symlinks, fail-open.
//
// Security semantics mirror src/walk.ts deliberately:
//   - Directory traversal uses readdir(withFileTypes): Dirent.isDirectory()
//     is false for symlinks (even symlinks-to-dirs), so symlinked dirs are
//     skipped at the directory level — never entered, never realpath'd.
//   - Each candidate file is lstatSync'd (NOT statSync'd): a symlink doc file
//     is rejected regardless of where it points.
//   - A defensive prefix-confinement check rejects any resolved path that
//     escapes repoRoot (guards against `..`-style docsDirs like `../escape`).
//
// Fail-open: a missing/unreadable dir, an escaping docsDir, or any thrown
// error is treated as "searched, no match" for that dir; the function NEVER
// throws. Every docsDir appears in `checked` (in input order) regardless of
// whether it was readable, so callers can audit what was attempted.
//
// Doc-matching is v1 fuzzy (documented): the unit's leaf token (the last
// `/`-separated segment of `unitKey`) matches a doc if it appears as any path
// segment OR as a substring of the filename stem (name without extension).
// First match wins; ties broken lexicographically on the repo-relative path
// for deterministic output (mirrors src/walk.ts's stable sort).
//
// Sync I/O is chosen deliberately: the searched tree is bounded and sync code
// keeps every call site await-free. Only node:fs + node:path are used — no
// network, no git, no new deps (§11 egress).

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Result of probing the repo for an existing doc for one unit.
 * `matchedPath` is repo-relative (POSIX `/`-separated) or null.
 * `checked` lists every docsDir attempted, in input order — including
 * missing/unreadable/escaping ones — so the caller can cite what was tried.
 */
export interface RepoContext {
  docExists: boolean;
  matchedPath: string | null;
  checked: string[];
}

/**
 * The unit's leaf token: the last `/`-separated segment of `unitKey`.
 * `src/billing` → `billing`; `billing` → `billing`; `''` → `''` (unmatchable).
 */
function leafToken(unitKey: string): string {
  const segs = unitKey.split('/');
  return segs[segs.length - 1] ?? '';
}

/**
 * True if `filePath` (repo-relative, `/`-separated) matches `leaf`:
 *   - `leaf` equals any path segment, OR
 *   - `leaf` is a substring of the filename stem (basename without extension,
 *     computed via path.parse so `billing.md`→`billing`, `billing-overview.md`
 *     →`billing-overview`, `.hidden`→`.hidden`).
 * An empty `leaf` never matches (defensive — no caller should pass one).
 */
function matchesLeaf(filePath: string, leaf: string): boolean {
  if (leaf === '') return false;
  const segments = filePath.split('/');
  for (const seg of segments) {
    if (seg === leaf) return true;
  }
  const base = segments[segments.length - 1] ?? filePath;
  const stem = path.parse(base).name;
  return stem.includes(leaf);
}

/**
 * Recursively collect repo-relative paths of regular files (no symlinks) under
 * `dirAbs`, confined to `prefix` (= `rootAbs + path.sep`). Appends to `out`.
 * Fail-open at every level: a missing/unreadable subdir simply stops that
 * subtree; the caller still treats the docsDir as "searched, no match".
 */
function collectFiles(
  dirAbs: string,
  prefix: string,
  rootAbs: string,
  out: string[],
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return; // missing or unreadable — fail open
  }

  for (const ent of entries) {
    if (ent.isDirectory()) {
      // Dirent.isDirectory() is false for symlinks-to-dirs, so symlinked
      // subdirs are skipped here without traversal or realpath.
      const sub = path.join(dirAbs, ent.name);
      const subResolved = path.resolve(sub);
      // Belt-and-suspenders: never descend outside the root (readdir never
      // emits `..`, but we verify anyway — mirrors src/walk.ts).
      if (subResolved !== rootAbs && !subResolved.startsWith(prefix)) continue;
      collectFiles(subResolved, prefix, rootAbs, out);
      continue;
    }

    // Non-directory entry (file, symlink, socket, etc.). lstat decides.
    const candidate = path.join(dirAbs, ent.name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(candidate);
    } catch {
      continue; // unreadable entry — skip
    }
    // lstat (not stat): NEVER follows symlinks. A symlink doc is rejected
    // regardless of its target — mirrors src/walk.ts symlink handling.
    if (st.isSymbolicLink()) continue;
    if (!st.isFile()) continue; // sockets, fifos, devices named *.md, etc.

    const resolved = path.resolve(candidate);
    if (resolved !== rootAbs && !resolved.startsWith(prefix)) continue;

    out.push(path.relative(rootAbs, resolved));
  }
}

/**
 * Gather doc-existence context for one unit. For each docsDir: resolve
 * `<repoRoot>/<docsDir>`, path-confine (skip if it escapes root — e.g.
 * `../escape`), recursively list regular files (never following symlinks),
 * and return the first file whose path matches the unit's leaf token.
 *
 * Contract:
 *   - NEVER throws. Every error path (missing dir, unreadable dir, escaping
 *     docsDir, unexpected exception) → treated as "searched, no match" for
 *     that dir. The function returns a normal RepoContext in all cases.
 *   - `checked` lists every docsDir in input order — including ones that
 *     could not be searched — so callers can cite the attempt.
 *   - Only node:fs + node:path are imported (no network, no git, no deps).
 */
export function gatherRepoContext(
  unitKey: string,
  repoRoot: string,
  docsDirs: string[],
): RepoContext {
  const checked: string[] = [];
  const leaf = leafToken(unitKey);

  const rootAbs = path.resolve(repoRoot);
  const prefix = rootAbs + path.sep;

  const matches: string[] = [];

  for (const docsDir of docsDirs) {
    // Every attempted docsDir appears in checked — even if it is missing,
    // unreadable, or escapes the root. This is the fail-open audit trail.
    checked.push(docsDir);

    // An empty leaf cannot match anything; still record the dir as checked.
    if (leaf === '') continue;

    // Confinement: the resolved docsDir must be the root itself or live under
    // it. `../escape` resolves outside rootAbs and is rejected here without
    // reading the filesystem, so it cannot be probed even if it exists.
    const dirAbs = path.resolve(rootAbs, docsDir);
    if (dirAbs !== rootAbs && !dirAbs.startsWith(prefix)) continue;

    const files: string[] = [];
    try {
      collectFiles(dirAbs, prefix, rootAbs, files);
    } catch {
      // collectFiles is internally fail-open, but guard any residual throw so
      // the "never throws" contract holds unconditionally.
      continue;
    }

    for (const f of files) {
      if (matchesLeaf(f, leaf)) matches.push(f);
    }
  }

  if (matches.length === 0) {
    return { docExists: false, matchedPath: null, checked };
  }

  // Deterministic first-match: lexicographic on repo-relative path (mirrors
  // src/walk.ts, which sorts for stable input order).
  matches.sort();
  return { docExists: true, matchedPath: matches[0], checked };
}
