import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { resolveToplevel } from '../src/git.js';

// Wrap execFile in a vi.fn that calls through to the real implementation.
// This is the spy-able surface: src/git.ts calls child_process.execFile (this
// mock), so we can inspect argv/env. Real execFile still runs — tests 1, 2, 4
// need real git; test 3 only inspects the call shape.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: vi.fn(actual.execFile) as unknown as typeof actual.execFile,
  };
});

const execFileMock = vi.mocked(execFile);

const tmpDirs: string[] = [];

/** Create a temp dir, tracked for cleanup. */
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `harnessgap-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  execFileMock.mockClear();
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveToplevel', () => {
  it('returns the toplevel for a real git repo (realpath)', async () => {
    const dir = makeTempDir('git');
    execFileSync('git', ['init', dir], { stdio: 'ignore' });
    const result = await resolveToplevel(dir);
    // git resolves symlinks (macOS /var -> /private/var), so compare via realpath
    expect(result).toBe(realpathSync(dir));
  });

  it('returns null for a non-git temp dir (no throw)', async () => {
    const dir = makeTempDir('nongit');
    const result = await resolveToplevel(dir);
    expect(result).toBeNull();
  });

  it('invokes execFile with the sandboxed argv and env (no shell, rev-parse only)', async () => {
    const dir = makeTempDir('sandbox');
    // mock calls through to real execFile; result is null (non-git dir), but
    // we only assert the call shape here.
    await resolveToplevel(dir);

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [cmd, argv, opts] = execFileMock.mock.calls[0] as unknown as [
      string,
      string[],
      { env: Record<string, string>; windowsHide: boolean },
      unknown,
    ];

    expect(cmd).toBe('git');
    // argv begins with -C <cwd> then the -c sandbox flags
    expect(argv.slice(0, 2)).toEqual(['-C', dir]);
    expect(argv).toContain('core.fsmonitor=');
    expect(argv).toContain('core.pager=cat');
    expect(argv).toContain('core.hooksPath=');
    expect(argv).toContain('rev-parse');
    expect(argv).toContain('--show-toplevel');
    // never invoke status/diff/log
    expect(argv).not.toContain('status');
    expect(argv).not.toContain('diff');
    expect(argv).not.toContain('log');

    // env sandbox
    expect(opts.env.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(opts.env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(opts.windowsHide).toBe(true);
  });

  it('memoizes by cwd when a cache Map is passed (execFile invoked once)', async () => {
    const dir = makeTempDir('cache');
    execFileSync('git', ['init', dir], { stdio: 'ignore' });
    const real = realpathSync(dir);

    const cache = new Map<string, string | null>();
    const r1 = await resolveToplevel(dir, cache);
    const r2 = await resolveToplevel(dir, cache);

    expect(r1).toBe(real);
    expect(r2).toBe(real);
    expect(cache.get(dir)).toBe(real);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });
});
