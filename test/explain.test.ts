// Explain (routing lite) — closed-loop MVP Task 11. `runExplain` composes
// collectEnvelopes → runDetector (collectEvidence) → diagnoseUnits, finds the
// diagnosis whose unit.key === opts.unit, and renders a routing pointer + the
// doc body + a docs_read consultation count. Fail-open throughout.
//
// Fixture style mirrors test/synthesize.test.ts: a REAL temp git repo with a
// committed source file (so src/billing is a real flagged area) plus a real
// claudeDir with a real .jsonl transcript that flags src/billing. No seams are
// substituted — explain is pure read-only composition.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  setupTempRepo,
  writeTranscript,
  mkSession,
  cleanupTempDirs,
  readsMulti,
  type EventSpec,
} from './helpers/builder.js';

const tmpDirs: string[] = [];

/** Create a temp dir, tracked for cleanup. */
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `harnessgap-explain-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
  cleanupTempDirs();
});

/**
 * Build a temp git repo with `src/billing/charge.ts` committed so `src/billing`
 * is a real, resolvable flagged area. Returns the repo path. Mirrors
 * makeRepoWithSource in test/synthesize.test.ts.
 */
function makeRepoWithSource(): string {
  const { repo } = setupTempRepo();
  mkdirSync(join(repo, 'src', 'billing'), { recursive: true });
  writeFileSync(
    join(repo, 'src', 'billing', 'charge.ts'),
    'export function charge(n: number): number {\n  return n;\n}\n',
  );
  execFileSync('git', ['-C', repo, 'add', 'src/billing/charge.ts'], { stdio: 'ignore' });
  execFileSync(
    'git',
    ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'],
    { stdio: 'ignore' },
  );
  return repo;
}

/**
 * Write a transcript that flags `src/billing` with the same signal mix as the
 * synthesize test (explore_ratio ≥ 10, reread ≥ 5, corrections ≥ 2,
 * failure_streak ≥ 3). When `docReadPath` is given, the session ALSO reads that
 * doc so its always-on docs_read rollup contains the path (the doc must live
 * under a docs_dirs entry — default `docs` — for collectDocsRead to capture it).
 */
function writeBillingSession(
  repo: string,
  claudeDir: string,
  slug: string,
  name: string,
  docReadPath?: string,
): void {
  const events: EventSpec[] = [
    ...readsMulti(
      [
        'src/billing/f0.ts',
        'src/billing/f1.ts',
        'src/billing/f2.ts',
        'src/billing/f3.ts',
        'src/billing/f4.ts',
      ],
      7,
    ),
  ];
  if (docReadPath !== undefined) {
    events.push({ kind: 'read', file: docReadPath });
  }
  events.push(
    { kind: 'edit', file: 'src/billing/f0.ts', newString: 'y' },
    { kind: 'user_text', text: 'no, that is wrong' },
    { kind: 'edit', file: 'src/billing/f0.ts', newString: 'z' },
    { kind: 'user_text', text: 'wait, revert' },
    { kind: 'edit', file: 'src/billing/f0.ts', newString: 'y' },
    { kind: 'exec', cmd: 'npm test', ok: false },
    { kind: 'exec', cmd: 'npm test', ok: false },
    { kind: 'exec', cmd: 'npm test', ok: false },
  );
  const jsonl = mkSession(repo, { name, events });
  writeTranscript(claudeDir, slug, name, jsonl);
}

describe('runExplain — doc exists + prior session read it', () => {
  it('renders pointer, doc body, and "N prior sessions consulted" with N >= 1 (exitCode 0)', async () => {
    const { runExplain } = await import('../src/explain.js');
    const repo = makeRepoWithSource();
    // Create the doc the diagnoser + explain will match (leaf token `billing`).
    // gatherRepoContext matches `billing` against the filename stem.
    mkdirSync(join(repo, 'docs', 'architecture'), { recursive: true });
    writeFileSync(
      join(repo, 'docs', 'architecture', 'billing.md'),
      '# Billing Architecture\n\nDescribes the charge pipeline.\n',
    );
    const claudeDir = makeTempDir('claude');
    writeBillingSession(
      repo,
      claudeDir,
      'proj',
      'session-billing',
      'docs/architecture/billing.md',
    );

    const result = await runExplain({
      unit: 'src/billing',
      repo,
      harness: 'claude-code',
      claudeDir,
    });

    expect(result.exitCode).toBe(0);
    // Pointer: backticked area key (trailing slash) + the matched doc path.
    expect(result.output).toContain('`src/billing/`');
    expect(result.output).toContain('docs/architecture/billing.md');
    // Doc body's first line is carried through verbatim.
    expect(result.output).toContain('# Billing Architecture');
    // Consultation line: N >= 1 distinct sessions read this doc.
    expect(result.output).toMatch(/[1-9]\d* prior sessions? consulted/);
    expect(result.output).toContain('docs/architecture/billing.md');
  });
});

describe('runExplain — no doc → synthesize suggestion', () => {
  it('renders the null-branch pointer mentioning synthesize (exitCode 0)', async () => {
    const { runExplain } = await import('../src/explain.js');
    const repo = makeRepoWithSource();
    // No docs/ created → gatherRepoContext reports doc absent → null branch.
    const claudeDir = makeTempDir('claude');
    writeBillingSession(repo, claudeDir, 'proj', 'session-billing');

    const result = await runExplain({
      unit: 'src/billing',
      repo,
      harness: 'claude-code',
      claudeDir,
    });

    expect(result.exitCode).toBe(0);
    // Null-branch pointer proposes synthesis.
    expect(result.output).toContain('synthesize');
    expect(result.output).toContain('src/billing');
    // No consultation line when no doc matched.
    expect(result.output).not.toMatch(/prior sessions? consulted/);
  });
});

describe('runExplain — unknown unit', () => {
  it('returns a clean "no diagnosis" message naming the unit (exitCode 0)', async () => {
    const { runExplain } = await import('../src/explain.js');
    const repo = makeRepoWithSource();
    const claudeDir = makeTempDir('claude');
    writeBillingSession(repo, claudeDir, 'proj', 'session-billing');

    const result = await runExplain({
      unit: 'src/totally-unknown',
      repo,
      harness: 'claude-code',
      claudeDir,
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('no diagnosis');
    expect(result.output).toContain('src/totally-unknown');
  });
});

describe('runExplain — fail-open', () => {
  it('returns exitCode 1 with a clean message on a thrown ConfigError (bogus --repo)', async () => {
    const { runExplain } = await import('../src/explain.js');
    const repo = makeRepoWithSource();
    const claudeDir = makeTempDir('claude');
    writeBillingSession(repo, claudeDir, 'proj', 'session-billing');

    // An explicit --repo that does not resolve to a git repo throws ConfigError
    // out of collectEnvelopes (issue #29). runExplain must catch it and return
    // exitCode 1 rather than rejecting.
    const bogus = join(tmpdir(), 'harnessgap-explain-missing-' + process.pid);
    const result = await runExplain({
      unit: 'src/billing',
      repo: bogus,
      harness: 'claude-code',
      claudeDir,
    });

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('explain:');
  });
});
