// Transcript discovery — finds every *.jsonl under
// <claudeDir>/projects/*/*.jsonl (exactly one session-dir level under
// projects/). Security-critical: NEVER follows symlinks.
//
// - Directory traversal uses readdir(withFileTypes): Dirent.isDirectory() is
//   false for symlinks (even symlinks-to-dirs), so symlinked session-dirs are
//   skipped at the directory level — never entered, never realpath'd.
// - Each .jsonl candidate is lstat'd (not stat'd): a symlink .jsonl is rejected
//   and counted in symlinks_rejected regardless of where it points.
// - A defensive prefix-confinement check rejects any resolved path that escapes
//   <claudeDir>/projects/ (guards against `..`-style traversal in dir names,
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

/** Default Claude config directory: `~/.claude`. */
export function defaultClaudeDir(): string {
  return path.join(os.homedir(), '.claude');
}

/**
 * Discover all .jsonl transcripts under <claudeDir>/projects/<slug>/<file>.jsonl
 * (exactly one session-dir level under projects/). Rejects symlinks (lstat,
 * never followed) and confines results to the projects/ prefix. Fail-open on
 * missing projects/ dir.
 */
export function discoverTranscripts(
  claudeDir: string,
): { files: string[]; symlinks_rejected: number } {
  const files: string[] = [];
  let symlinks_rejected = 0;

  const projectsDir = path.resolve(claudeDir, 'projects');
  const prefix = projectsDir + path.sep;

  let topEntries: fs.Dirent[];
  try {
    topEntries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    // Missing or unreadable projects/ dir — fail open.
    return { files, symlinks_rejected };
  }

  for (const dirent of topEntries) {
    // Exactly one session-dir level under projects/. isDirectory() is false
    // for symlinks, so symlinked session-dirs are skipped here without being
    // traversed or realpath'd.
    if (!dirent.isDirectory()) continue;

    const sessionDir = path.join(projectsDir, dirent.name);
    let sessionEntries: fs.Dirent[];
    try {
      sessionEntries = fs.readdirSync(sessionDir, { withFileTypes: true });
    } catch {
      continue; // unreadable session-dir — skip
    }

    for (const fe of sessionEntries) {
      if (!fe.name.endsWith('.jsonl')) continue;

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
