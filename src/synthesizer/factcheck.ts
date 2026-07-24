// Fact-check gate (Synthesizer, Task 7). Runs AFTER the backend returns a
// proposal and BEFORE any doc is written. Deterministic and fail-open: returns
// `{ failures: [...] }` and never throws.
//
// Three check kinds, pinned to the FactCheckFailure taxonomy:
//   - symbol: each cited_symbol must appear as a word-bounded token in the
//     concatenated content of the source_files' path parts (text before `@`).
//     Token = `\b<symbol>\b`, case-sensitive (a code identifier). This avoids
//     false positives like `discharge` matching `charge`.
//   - path: each referenced_path must exist under repoRoot; the proposal's own
//     `path` is exempt from existence (it is a NEW doc) but must resolve under
//     a configured docs dir (passed via `docsDirs`).
//   - sha: each source_files entry's `@sha` must be a valid commit, validated
//     via the sandboxed `isValidSha` helper in src/git.ts (keeps `child_process`
//     consolidated in git.ts — factcheck.ts imports only node:fs).
//
// Style mirrors src/synthesizer/proposal.ts: pure-ish functions over the
// Proposal contract; the only I/O is local file reads (node:fs) and the
// read-only git cat-file delegated to git.ts. Never throws.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Proposal, FactCheckResult, FactCheckFailure } from '../types.js';
import { isValidSha } from '../git.js';

// Re-export so callers can import the result types alongside the gate.
export type { Proposal, FactCheckResult, FactCheckFailure };

/** The three assertion kinds the gate can fail on (mirrors FactCheckFailure). */
type FailureKind = FactCheckFailure['kind'];

/** Escape regex metacharacters in a literal string for safe embedding in a RegExp. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True iff `symbol` appears as a word-bounded token in `content`. Word-boundary,
 * case-sensitive: `charge` matches `charge()` and `foo.charge` but NOT
 * `discharge` or `chargeback`. An empty symbol never matches.
 */
function symbolInContent(symbol: string, content: string): boolean {
  if (symbol === '') return false;
  try {
    const re = new RegExp(`\\b${escapeRegex(symbol)}\\b`);
    return re.test(content);
  } catch {
    return false;
  }
}

/**
 * Normalize a repo-relative path to POSIX form for comparison. Backslashes
 * (Windows) are converted to `/` so docs-dir confinement works cross-platform.
 */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * True iff `relPath` equals or lives inside one of `docsDirs` (both
 * repo-relative). Uses POSIX normalization so `docs/architecture.md` is
 * recognized as under `docs`. An empty docsDirs list matches nothing.
 *
 * Exported (Task 12) so the Review stage reuses the SAME docs-dir confinement
 * contract the fact-check gate applies pre-write — a proposal whose `path`
 * escapes every `docs_dir` is refused by both stages for the same reason,
 * with no logic drift.
 */
export function isUnderDocsDir(relPath: string, docsDirs: string[]): boolean {
  const norm = toPosix(path.posix.normalize(relPath));
  for (const d of docsDirs) {
    const normD = toPosix(path.posix.normalize(d));
    if (normD === '') continue;
    const rel = path.posix.relative(normD, norm);
    if (rel === '' || (!rel.startsWith('..') && !path.posix.isAbsolute(rel))) {
      return true;
    }
  }
  return false;
}

/**
 * Run the deterministic fact-check gate against `proposal` in the repo at
 * `repoRoot`. `docsDirs` are the repo-relative doc directories (from
 * `Config.docs_dirs`) used to confine `proposal.path`. Returns a
 * {@link FactCheckResult} whose `failures` array lists every assertion that did
 * not hold; an empty array means the proposal passed. Never throws — on any
 * internal error the gate still returns a result (with whatever failures were
 * collected up to that point, plus a best-effort entry for the failing check).
 */
export function factCheck(
  proposal: Proposal,
  repoRoot: string,
  docsDirs: string[],
): FactCheckResult {
  const failures: FactCheckFailure[] = [];
  const fail = (assertion: string, kind: FailureKind, detail: string): void => {
    failures.push({ assertion, kind, resolved: false, detail });
  };

  // --- path: proposal.path must resolve under a configured docs dir. ---
  // The proposal targets a NEW doc, so existence is NOT required — but the path
  // must be confined to a docs dir so the gate never endorses writing elsewhere.
  try {
    if (!isUnderDocsDir(proposal.path, docsDirs)) {
      fail(
        proposal.path,
        'path',
        `proposal.path not under any docs dir: [${docsDirs.join(', ')}]`,
      );
    }
  } catch {
    fail(proposal.path, 'path', 'failed to check docs-dir confinement');
  }

  // --- symbol: concatenate source_files content, match each cited symbol. ---
  // The path part before `@` is the file to read. Missing/unreadable files
  // contribute no content (so their cited symbols naturally miss).
  let concatenated = '';
  try {
    const parts: string[] = [];
    for (const entry of proposal.frontmatter.source_files) {
      const atIdx = entry.lastIndexOf('@');
      const filePath = atIdx >= 0 ? entry.slice(0, atIdx) : entry;
      if (filePath === '') continue;
      const abs = path.resolve(repoRoot, filePath);
      try {
        parts.push(fs.readFileSync(abs, 'utf8'));
      } catch {
        // unreadable/missing source file — contributes no content
      }
    }
    concatenated = parts.join('\n');
  } catch {
    // defensive: treat any unexpected error as empty content
  }

  for (const symbol of proposal.cited_symbols) {
    if (!symbolInContent(symbol, concatenated)) {
      fail(symbol, 'symbol', 'not found in cited source files');
    }
  }

  // --- path: each referenced_path must exist under repoRoot (proposal.path exempt). ---
  // proposal.path is exempt from existence (handled above by the docs-dir check);
  // if it appears in referenced_paths, skip its existence check here.
  for (const rel of proposal.referenced_paths) {
    if (rel === proposal.path) continue;
    try {
      const abs = path.resolve(repoRoot, rel);
      const relCheck = path.relative(repoRoot, abs);
      // path-confine: reject `..` escapes outside repoRoot.
      if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
        fail(rel, 'path', 'referenced path escapes repo root');
        continue;
      }
      fs.accessSync(abs, fs.constants.R_OK);
    } catch {
      fail(rel, 'path', 'referenced path does not exist under repo root');
    }
  }

  // --- sha: each source_files@sha entry must pin a valid commit. ---
  for (const entry of proposal.frontmatter.source_files) {
    const atIdx = entry.lastIndexOf('@');
    if (atIdx < 0) continue; // no @sha to validate — skip (path-only entry)
    const sha = entry.slice(atIdx + 1);
    if (!isValidSha(repoRoot, sha)) {
      fail(entry, 'sha', `invalid commit: ${sha || '(empty)'}`);
    }
  }

  return { failures };
}

/**
 * Roll a {@link FactCheckResult} up to the three verification booleans carried
 * on {@link Proposal.verification}. Each boolean is true iff NO failure of that
 * kind remains unresolved. The Review stage copies this into the proposal after
 * the gate runs (and after any regeneration pass that may have flipped
 * `resolved` to true).
 */
export function verificationFrom(result: FactCheckResult): {
  cited_symbols_resolved: boolean;
  paths_resolved: boolean;
  shas_valid: boolean;
} {
  const has = (kind: FailureKind): boolean =>
    !result.failures.some((f) => f.kind === kind && !f.resolved);
  return {
    cited_symbols_resolved: has('symbol'),
    paths_resolved: has('path'),
    shas_valid: has('sha'),
  };
}
