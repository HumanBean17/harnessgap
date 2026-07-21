// Transcript discovery — finds every *.jsonl session file under a harness
// root. The default (Claude) layout reads `<rootDir>/projects/<slug>/*.jsonl`
// (exactly one session-dir level under projects/). The Qwen/GigaCode layout
// adds an extra `chats/` subdir: `<rootDir>/projects/<slug>/chats/*.jsonl`.
// Security-critical: NEVER follows symlinks.
//
// - Directory traversal uses readdir(withFileTypes): Dirent.isDirectory() is
//   false for symlinks (even symlinks-to-dirs), so symlinked slug-dirs and
//   symlinked session-subdirs are skipped at the directory level — never
//   entered, never realpath'd.
// - Each .jsonl candidate is lstat'd (not stat'd): a symlink .jsonl is rejected
//   and counted in symlinks_rejected regardless of where it points.
// - A defensive prefix-confinement check rejects any resolved path that escapes
//   <rootDir>/projects/ (guards against `..`-style traversal in dir names,
//   which readdir itself never produces but we verify anyway).
//
// Does NOT read file contents (streamSession in adapter/stream.ts does that).
// Fail-open: a missing or unreadable projects/ dir yields an empty result,
// never a throw.
//
// Sync I/O is chosen deliberately: the pipeline walks a bounded number of
// files and sync code avoids an await at every call site. Output is sorted
// lexicographically so the pipeline sees a stable input order.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { HarnessId, TranscriptLayout } from './types.js';

/** Default per-harness config directory under the user's home. */
export function defaultRootDir(id: HarnessId): string {
  const sub =
    id === 'claude-code' ? '.claude'
    : id === 'qwen-code' ? '.qwen'
    : '.gigacode'; // gigacode
  return path.join(os.homedir(), sub);
}

/**
 * @deprecated Thin alias for `defaultRootDir('claude-code')`. Retained so
 * existing single-layout callers (src/pipeline.ts) keep working until the
 * multi-harness dispatch lands (Task 10).
 */
export function defaultClaudeDir(): string {
  return defaultRootDir('claude-code');
}

const CLAUDE_LAYOUT: TranscriptLayout = {
  projectsSegment: 'projects',
  extension: '.jsonl',
};

/**
 * Discover all .jsonl transcripts under
 * `<rootDir>/projects/<slug>/<file>.jsonl` (Claude layout, the default) or
 * `<rootDir>/projects/<slug>/<sessionSubdir>/<file>.jsonl` when
 * `layout.sessionSubdir` is present (Qwen/GigaCode). Rejects symlinks (lstat,
 * never followed) and confines results to the projects/ prefix. Fail-open on
 * missing projects/ dir.
 *
 * `layout` defaults to the Claude layout so existing single-argument callers
 * keep working unchanged.
 */
export function discoverTranscripts(
  rootDir: string,
  layout: TranscriptLayout = CLAUDE_LAYOUT,
): { files: string[]; symlinks_rejected: number } {
  const files: string[] = [];
  let symlinks_rejected = 0;

  const projectsDir = path.resolve(rootDir, layout.projectsSegment);
  const prefix = projectsDir + path.sep;
  const extension = layout.extension;

  let topEntries: fs.Dirent[];
  try {
    topEntries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    // Missing or unreadable projects/ dir — fail open.
    return { files, symlinks_rejected };
  }

  for (const dirent of topEntries) {
    // Slug-dir level. isDirectory() is false for symlinks, so symlinked
    // slug-dirs are skipped here without being traversed or realpath'd.
    if (!dirent.isDirectory()) continue;

    const slugDir = path.join(projectsDir, dirent.name);
    // When sessionSubdir is set (Qwen/GigaCode), session files live one level
    // deeper under `<slugDir>/<sessionSubdir>/`; otherwise they sit directly
    // under `<slugDir>/` (Claude layout). The session-subdir — when present —
    // must itself be a real directory (Dirent.isDirectory() is false for
    // symlinks), so a symlinked `chats/` is rejected here without traversal.
    let sessionDir: string;
    if (layout.sessionSubdir) {
      const subdirPath = path.join(slugDir, layout.sessionSubdir);
      let subdirDirent: fs.Dirent | undefined;
      try {
        // readdir the slug to read the subdir entry as a Dirent — this lets us
        // apply the same isDirectory() (not symlink) invariant used at the
        // slug level. A missing or unreadable slug-dir is skipped.
        const slugEntries = fs.readdirSync(slugDir, { withFileTypes: true });
        subdirDirent = slugEntries.find((e) => e.name === layout.sessionSubdir);
      } catch {
        continue; // unreadable slug-dir — skip
      }
      if (!subdirDirent || !subdirDirent.isDirectory()) continue; // missing or symlinked/regular-file sessionSubdir
      sessionDir = subdirPath;
    } else {
      sessionDir = slugDir;
    }

    let sessionEntries: fs.Dirent[];
    try {
      sessionEntries = fs.readdirSync(sessionDir, { withFileTypes: true });
    } catch {
      continue; // unreadable session-dir — skip
    }

    for (const fe of sessionEntries) {
      if (!fe.name.endsWith(extension)) continue;

      const candidate = path.join(sessionDir, fe.name);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(candidate);
      } catch {
        continue; // unreadable entry — skip
      }
      // lstat (not stat): never follows symlinks. A symlink .jsonl is rejected
      // and counted, regardless of its target.
      if (st.isSymbolicLink()) {
        symlinks_rejected++;
        continue;
      }
      if (!st.isFile()) continue; // dirs / sockets / fifos named *.jsonl

      // Defensive confinement: the resolved absolute path must live under
      // projects/. Belt-and-suspenders against path-traversal via `..` in dir
      // names (readdir never emits such names, but we verify anyway).
      const resolved = path.resolve(candidate);
      if (!resolved.startsWith(prefix)) continue;

      files.push(resolved);
    }
  }

  files.sort();
  return { files, symlinks_rejected };
}
