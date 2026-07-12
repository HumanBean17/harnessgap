import * as child_process from 'node:child_process';

/**
 * Sandboxed git toplevel resolver.
 *
 * Resolves the git toplevel for `cwd` via a locked-down
 * `git rev-parse --show-toplevel`. Returns `null` (never throws) when `cwd` is
 * not a repo, git is unavailable, or `cwd` is missing.
 *
 * Security: `cwd` originates from transcripts (untrusted). The sandbox — env
 * vars (`GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL`), `-c` overrides
 * (`core.fsmonitor`, `core.pager`, `core.hooksPath`), `execFile` (no shell),
 * and rev-parse only — prevents git from invoking external programs via
 * repo-local config. Do not relax these.
 *
 * Memoized by `cwd` when a `cache` Map is passed.
 */
export function resolveToplevel(
  cwd: string,
  cache?: Map<string, string | null>,
): Promise<string | null> {
  if (cache?.has(cwd)) {
    return Promise.resolve(cache.get(cwd) ?? null);
  }

  return new Promise((resolve) => {
    try {
      child_process.execFile(
        'git',
        [
          '-C',
          cwd,
          '-c',
          'core.fsmonitor=',
          '-c',
          'core.pager=cat',
          '-c',
          'core.hooksPath=',
          'rev-parse',
          '--show-toplevel',
        ],
        {
          env: {
            ...process.env,
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
          },
          windowsHide: true,
        },
        (err, stdout) => {
          if (err) {
            // non-zero exit, git missing (ENOENT), cwd missing, etc.
            cache?.set(cwd, null);
            return resolve(null);
          }
          const toplevel = String(stdout).trim();
          cache?.set(cwd, toplevel);
          resolve(toplevel);
        },
      );
    } catch {
      // synchronous throw (invalid args, etc.) — never propagate
      cache?.set(cwd, null);
      resolve(null);
    }
  });
}
