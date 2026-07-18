// Pure file-path relativization. The spec contract (§4) makes
// `input_digest.files` repo-relative, but the adapter parses records before the
// repo is resolved, so paths are left verbatim — in real Claude Code transcripts
// that means absolute paths under the session's cwd. This module rewrites them
// to repo-relative form once the repo root is known, and collapses git-worktree
// checkout prefixes so the same file edited across worktrees + the main
// checkout aggregates into one area. Pure string ops: no I/O, no network.

import type { NormalizedEnvelope } from './types.js';

// A repo-relative path whose first segment is a hidden tooling dir
// (`.claude`, `.agents`, `.git`, …) immediately followed by `worktrees/<name>/`
// is a worktree checkout prefix. The `<rest>` after the worktree name is the
// canonical repo-relative path. Conservative on purpose: a leading dot-segment
// is required, so a real source directory named `worktrees` is never touched.
const WORKTREE_RE = /^\.[^/]+\/worktrees\/[^/]+\/(.+)$/;

/**
 * Strip a worktree checkout prefix from a repo-relative path.
 * `.claude/worktrees/feat-xyz/src/foo.ts` → `src/foo.ts`.
 * `.agents/worktrees/dev-deps-guard/src/x` → `src/x`.
 * Paths that are not under a `<hidden>/worktrees/<name>/` prefix pass through.
 */
export function stripWorktreePrefix(relPath: string): string {
  const m = WORKTREE_RE.exec(relPath);
  return m ? m[1] : relPath;
}

/**
 * Rewrite a single file path to its canonical repo-relative form.
 *
 * - If `worktreeCheckoutRoot` is set (cwd lived in a SIBLING worktree) and the
 *   file lives under it, strip that checkout root first — sibling-worktree files
 *   are absolute and sit OUTSIDE the main-repo prefix, so without this they'd
 *   survive as absolute area keys instead of aggregating with the main checkout.
 * - Else if it is absolute and lives under `repoRoot`, strip the `repoRoot` prefix
 *   (the main checkout + nested worktrees, whose files DO live under the repo root).
 * - Then strip any worktree checkout prefix (see `stripWorktreePrefix`).
 * - Paths that are already relative (no leading `/`) get worktree-stripped only.
 * - Absolute paths outside both roots pass through unchanged (area localization's
 *   ignore list + depth filter usually discards them).
 *
 * `repoRoot` may be `''` (session with no resolved repo); then only checkout-root
 * / worktree stripping applies and other absolutes pass through.
 */
export function relativizeFilePath(
  file: string,
  repoRoot: string,
  worktreeCheckoutRoot?: string | null,
): string {
  // Sibling-worktree checkout root is outside the main repo, so try it first.
  let rel = worktreeCheckoutRoot ? stripRootPrefix(file, worktreeCheckoutRoot) : file;
  if (rel === file && repoRoot !== '') {
    // Not under the checkout root — strip the main-repo root instead.
    rel = stripRootPrefix(file, repoRoot);
  }
  if (rel === '') rel = file; // degenerate: file was a root itself
  return stripWorktreePrefix(rel);
}

/**
 * Remove `root` (and its trailing slash) from `p` when `p` is `root` or lives
 * under it; return `p` unchanged otherwise. Pure string ops.
 */
function stripRootPrefix(p: string, root: string): string {
  const prefix = root.endsWith('/') ? root : root + '/';
  if (p === root) return '';
  if (p.startsWith(prefix)) return p.slice(prefix.length);
  return p;
}

/**
 * Relativize every file in every event's `input_digest.files` against
 * `repoRoot` (and `worktreeCheckoutRoot` for sibling-worktree sessions), in place.
 * Mutates `envelope.events[*].input_digest.files` (the pipeline's established
 * pattern — `envelope.repo` is set the same way). Pure with respect to the
 * filesystem: no I/O, no network.
 */
export function relativizeEnvelopeFiles(
  envelope: NormalizedEnvelope,
  repoRoot: string,
  worktreeCheckoutRoot?: string | null,
): void {
  for (const ev of envelope.events) {
    if (ev.input_digest.files.length === 0) continue;
    ev.input_digest.files = ev.input_digest.files.map((f) =>
      relativizeFilePath(f, repoRoot, worktreeCheckoutRoot),
    );
  }
}
