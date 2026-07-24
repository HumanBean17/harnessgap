// Fact-check gate (Synthesizer, Task 7). The gate runs AFTER the backend
// returns a proposal and BEFORE any doc is written. It is deterministic and
// fail-open: it returns `{ failures: [...] }` and never throws.
//
// Three check kinds, pinned to the FactCheckFailure taxonomy:
//   - symbol: each cited_symbol must appear as a word-bounded token in the
//     concatenated content of the source_files' path parts (before `@`).
//   - path: each referenced_path must exist under repoRoot; the proposal's own
//     `path` is exempt from existence but must resolve under a docs dir.
//   - sha: each source_files entry's `@sha` must be a valid commit.
//
// Fixture style mirrors test/git.test.ts: a real temp git repo with a committed
// source file, so HEAD is a real commit sha and symbol matching runs against
// real file content.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { factCheck, verificationFrom } from '../src/synthesizer/factcheck.js';
import type { Proposal, FactCheckFailure } from '../src/types.js';

const tmpDirs: string[] = [];

/** Create a temp dir, tracked for cleanup. */
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `harnessgap-factcheck-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}

/**
 * Build a temp git repo with one committed source file containing the symbol
 * `charge`. Returns the repo path, the real HEAD sha, and the repo-relative
 * source path so tests can build `path@sha` entries.
 */
function makeFixtureRepo(): {
  repo: string;
  headSha: string;
  sourcePath: string;
} {
  const repo = makeTempDir('repo');
  execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' });
  mkdirSync(join(repo, 'src', 'billing'), { recursive: true });
  writeFileSync(
    join(repo, 'src', 'billing', 'charge.ts'),
    'export function charge(amount: number): number {\n  return amount;\n}\n',
  );
  execFileSync('git', ['-C', repo, 'add', 'src/billing/charge.ts'], {
    stdio: 'ignore',
  });
  execFileSync(
    'git',
    [
      '-C',
      repo,
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'commit',
      '-q',
      '-m',
      'init',
    ],
    { stdio: 'ignore' },
  );
  const headSha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  return { repo, headSha, sourcePath: 'src/billing/charge.ts' };
}

/** A valid new-doc proposal pointing at the fixture repo's charge.ts. */
function validProposal(opts: {
  headSha: string;
  sourcePath: string;
}): Proposal {
  return {
    kind: 'new-doc',
    path: 'docs/architecture.md',
    frontmatter: {
      derived_from: ['session-001'],
      unit: { kind: 'area', key: 'src/billing' },
      struggle_score: 0.42,
      cause: 'doc',
      source_files: [`${opts.sourcePath}@${opts.headSha}`],
      created: '2026-07-24T10:00:00Z',
    },
    body: '## Billing\n\nThe charge pipeline.',
    cited_symbols: ['charge'],
    referenced_paths: [opts.sourcePath],
    dedupe: {
      nearest_existing: null,
      decision_rationale: 'no near-duplicate found',
    },
    verification: {
      cited_symbols_resolved: true,
      paths_resolved: true,
      shas_valid: true,
    },
  };
}

afterEach(() => {
  while (tmpDirs.length) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe('factCheck — happy path', () => {
  it('returns no failures when symbols resolve, paths exist, and sha is HEAD', () => {
    const { repo, headSha, sourcePath } = makeFixtureRepo();
    const p = validProposal({ headSha, sourcePath });
    const result = factCheck(p, repo, ['docs']);
    expect(result.failures).toEqual([]);
  });

  it('verificationFrom is all-true for a clean result', () => {
    const { repo, headSha, sourcePath } = makeFixtureRepo();
    const p = validProposal({ headSha, sourcePath });
    const result = factCheck(p, repo, ['docs']);
    expect(verificationFrom(result)).toEqual({
      cited_symbols_resolved: true,
      paths_resolved: true,
      shas_valid: true,
    });
  });

  it('accepts a proposal.path nested under a nested docs dir', () => {
    const { repo, headSha, sourcePath } = makeFixtureRepo();
    const p = validProposal({ headSha, sourcePath });
    p.path = 'docs/architecture/deep.md';
    const result = factCheck(p, repo, ['docs']);
    expect(result.failures.filter((f) => f.kind === 'path')).toEqual([]);
  });

  it('does not require proposal.path to exist on disk (exempt from existence)', () => {
    const { repo, headSha, sourcePath } = makeFixtureRepo();
    const p = validProposal({ headSha, sourcePath });
    // docs/architecture.md does NOT exist in the fixture repo — that's fine.
    const result = factCheck(p, repo, ['docs']);
    expect(result.failures).toEqual([]);
  });
});

describe('factCheck — cited_symbols (kind: symbol)', () => {
  it('pushes one symbol failure (resolved:false) for a symbol absent from sources', () => {
    const { repo, headSha, sourcePath } = makeFixtureRepo();
    const p = validProposal({ headSha, sourcePath });
    p.cited_symbols = ['charge', 'nonExistentSymbol'];
    const result = factCheck(p, repo, ['docs']);
    const symbolFailures = result.failures.filter((f) => f.kind === 'symbol');
    expect(symbolFailures).toHaveLength(1);
    expect(symbolFailures[0]).toMatchObject({
      assertion: 'nonExistentSymbol',
      kind: 'symbol',
      resolved: false,
      detail: 'not found in cited source files',
    });
  });

  it('uses word-boundary matching: substring inside another word does NOT resolve', () => {
    // `charge` must not match the word `discharge` — token semantics.
    const { repo, headSha, sourcePath } = makeFixtureRepo();
    const p = validProposal({ headSha, sourcePath });
    // Replace the source with content where `charge` only appears inside `discharge`.
    writeFileSync(
      join(repo, 'src', 'billing', 'charge.ts'),
      'export function discharge(amount: number): number { return amount; }\n',
    );
    p.cited_symbols = ['charge'];
    const result = factCheck(p, repo, ['docs']);
    const symbolFailures = result.failures.filter((f) => f.kind === 'symbol');
    expect(symbolFailures).toHaveLength(1);
    expect(symbolFailures[0].assertion).toBe('charge');
  });

  it('verificationFrom reports cited_symbols_resolved:false when a symbol misses', () => {
    const { repo, headSha, sourcePath } = makeFixtureRepo();
    const p = validProposal({ headSha, sourcePath });
    p.cited_symbols = ['absent'];
    const result = factCheck(p, repo, ['docs']);
    expect(verificationFrom(result).cited_symbols_resolved).toBe(false);
    expect(verificationFrom(result).paths_resolved).toBe(true);
    expect(verificationFrom(result).shas_valid).toBe(true);
  });

  it('reads the path part before @ for symbol matching', () => {
    const { repo, headSha, sourcePath } = makeFixtureRepo();
    const p = validProposal({ headSha, sourcePath });
    // Same path, pinned at HEAD — the @sha suffix must not corrupt the path read.
    p.frontmatter.source_files = [`${sourcePath}@${headSha}`];
    p.cited_symbols = ['charge'];
    expect(factCheck(p, repo, ['docs']).failures).toEqual([]);
  });
});

describe('factCheck — source_files@sha (kind: sha)', () => {
  it('pushes a sha failure for a bogus commit', () => {
    const { repo, sourcePath } = makeFixtureRepo();
    const p = validProposal({ headSha: 'deadbeefdeadbeef', sourcePath });
    const result = factCheck(p, repo, ['docs']);
    const shaFailures = result.failures.filter((f) => f.kind === 'sha');
    expect(shaFailures).toHaveLength(1);
    expect(shaFailures[0]).toMatchObject({
      kind: 'sha',
      resolved: false,
    });
    expect(shaFailures[0].assertion).toContain('deadbeef');
  });

  it('verificationFrom reports shas_valid:false on a bad sha', () => {
    const { repo, sourcePath } = makeFixtureRepo();
    const p = validProposal({ headSha: 'not-a-real-sha', sourcePath });
    const result = factCheck(p, repo, ['docs']);
    expect(verificationFrom(result).shas_valid).toBe(false);
    // Symbol + path checks are independent of sha validity: the path part
    // before @ is a real working-tree file, so charge still resolves.
    expect(verificationFrom(result).cited_symbols_resolved).toBe(true);
    expect(verificationFrom(result).paths_resolved).toBe(true);
  });

  it('validates a real commit sha (tree/blob rejected is out of scope — commit only)', () => {
    const { repo, headSha, sourcePath } = makeFixtureRepo();
    const p = validProposal({ headSha, sourcePath });
    const result = factCheck(p, repo, ['docs']);
    expect(result.failures.filter((f) => f.kind === 'sha')).toEqual([]);
  });
});

describe('factCheck — paths (kind: path)', () => {
  it('pushes a path failure when proposal.path is outside all docs_dirs', () => {
    const { repo, headSha, sourcePath } = makeFixtureRepo();
    const p = validProposal({ headSha, sourcePath });
    p.path = 'notes/plan.md'; // not under docs/
    const result = factCheck(p, repo, ['docs']);
    const pathFailures = result.failures.filter((f) => f.kind === 'path');
    expect(pathFailures).toHaveLength(1);
    expect(pathFailures[0].assertion).toBe('notes/plan.md');
    expect(pathFailures[0].resolved).toBe(false);
  });

  it('verificationFrom reports paths_resolved:false when proposal.path is outside docs', () => {
    const { repo, headSha, sourcePath } = makeFixtureRepo();
    const p = validProposal({ headSha, sourcePath });
    p.path = 'notes/plan.md';
    const result = factCheck(p, repo, ['docs']);
    expect(verificationFrom(result).paths_resolved).toBe(false);
  });

  it('pushes a path failure for a referenced_path that does not exist', () => {
    const { repo, headSha, sourcePath } = makeFixtureRepo();
    const p = validProposal({ headSha, sourcePath });
    p.referenced_paths = [sourcePath, 'src/billing/missing.ts'];
    const result = factCheck(p, repo, ['docs']);
    const pathFailures = result.failures.filter(
      (f) => f.kind === 'path' && f.assertion === 'src/billing/missing.ts',
    );
    expect(pathFailures).toHaveLength(1);
    expect(pathFailures[0].detail).toMatch(/does not exist/);
  });

  it('exempts proposal.path from existence when it appears in referenced_paths', () => {
    const { repo, headSha, sourcePath } = makeFixtureRepo();
    const p = validProposal({ headSha, sourcePath });
    // proposal.path is in referenced_paths but the file does not exist on disk.
    // That must NOT produce a path failure (only the docs-dir confinement check
    // applies, which passes since it is under docs/).
    p.referenced_paths = [sourcePath, p.path];
    const result = factCheck(p, repo, ['docs']);
    const pathFailures = result.failures.filter(
      (f) => f.kind === 'path' && f.assertion === p.path,
    );
    expect(pathFailures).toEqual([]);
  });

  it('treats an empty docs_dirs list as: no proposal.path is acceptable', () => {
    const { repo, headSha, sourcePath } = makeFixtureRepo();
    const p = validProposal({ headSha, sourcePath });
    const result = factCheck(p, repo, []);
    const pathFailures = result.failures.filter((f) => f.kind === 'path');
    expect(pathFailures).toHaveLength(1);
    expect(pathFailures[0].assertion).toBe(p.path);
  });
});

describe('factCheck — robustness', () => {
  it('never throws: returns a result (possibly with failures) for any input', () => {
    const { repo, headSha, sourcePath } = makeFixtureRepo();
    const p = validProposal({ headSha, sourcePath });
    // A repoRoot that does not exist must not throw.
    expect(() => factCheck(p, '/nonexistent/repo/path', ['docs'])).not.toThrow();
  });

  it('combines multiple failure kinds into one failures array', () => {
    const { repo, sourcePath } = makeFixtureRepo();
    const p = validProposal({ headSha: 'bogus', sourcePath });
    p.cited_symbols = ['absentSymbol'];
    p.path = 'notes/outside.md';
    p.referenced_paths = ['does/not/exist.ts'];
    const result = factCheck(p, repo, ['docs']);
    const kinds = new Set(result.failures.map((f: FactCheckFailure) => f.kind));
    expect(kinds.has('symbol')).toBe(true);
    expect(kinds.has('path')).toBe(true);
    expect(kinds.has('sha')).toBe(true);
  });
});
