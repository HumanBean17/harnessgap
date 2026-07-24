// Integration (e2e) test for the closed loop: runSynthesize writes a proposal,
// then runReview reads it back. Proves the on-disk frontmatter carries the
// REAL diagnoser-derived `cause` / `confidence` / `evidence_refs` plus the
// proposal's `path` and `verification` — the fields Review (Task 12) parses.
//
// Before the integration fix (Task 10 → Task 12), `writeProposal` emitted only
// `derived_from / unit / struggle_score / cause / source_files / created /
// verification`, so Review saw `path: ''`, `confidence: 0`, and no
// `evidence_refs` — breaking the wrong-cause mitigation (review is supposed to
// surface the diagnosis's evidence_refs so a human sanity-checks the rationale).
// This test guards that contract: the same Diagnosis the diagnoser produced is
// the one whose confidence/evidence_refs surface in Review's --json output.
//
// Fixture style mirrors test/synthesize.test.ts: a REAL temp git repo with a
// committed source file (so HEAD is a real sha the fact-checker accepts) plus a
// real claudeDir transcript that flags src/billing with a doc-cause mix. The
// only seam substituted is `runBackendFn` — NO real model call fires.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, execFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync as execFile } from 'node:child_process';
import {
  setupTempRepo,
  writeTranscript,
  mkSession,
  cleanupTempDirs,
  readsMulti,
} from './helpers/builder.js';
import type { Proposal } from '../src/types.js';

const tmpDirs: string[] = [];

/** Create a temp dir, tracked for cleanup. */
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `harnessgap-e2e-${prefix}-`));
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
 * Build a temp git repo with `src/billing/charge.ts` committed (so HEAD is a
 * real sha and the symbol `charge` resolves). No `docs/` created → doc absent →
 * cause=doc. Mirrors makeRepoWithSource in synthesize.test.ts.
 */
function makeRepoWithSource(): { repo: string; headSha: string; sourcePath: string } {
  const { repo } = setupTempRepo();
  mkdirSync(join(repo, 'src', 'billing'), { recursive: true });
  writeFileSync(
    join(repo, 'src', 'billing', 'charge.ts'),
    'export function charge(n: number): number {\n  return n;\n}\n',
  );
  execFile('git', ['-C', repo, 'add', 'src/billing/charge.ts'], { stdio: 'ignore' });
  execFile(
    'git',
    ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'],
    { stdio: 'ignore' },
  );
  const headSha = execFile('git', ['-C', repo, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  return { repo, headSha, sourcePath: 'src/billing/charge.ts' };
}

/**
 * Write a transcript that flags `src/billing` with a doc-cause signal mix
 * (explore_ratio high, reread=5, corrections=2, failure_streak=3). 4/5 signals
 * elevated → doc wins (explore+reread, doc absent, precedence).
 */
function writeBillingSession(repo: string, claudeDir: string): void {
  const jsonl = mkSession(repo, {
    name: 'session-billing',
    events: [
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
      { kind: 'edit', file: 'src/billing/f0.ts', newString: 'y' },
      { kind: 'user_text', text: 'no, that is wrong' },
      { kind: 'edit', file: 'src/billing/f0.ts', newString: 'z' },
      { kind: 'user_text', text: 'wait, revert' },
      { kind: 'edit', file: 'src/billing/f0.ts', newString: 'y' },
      { kind: 'exec', cmd: 'npm test', ok: false },
      { kind: 'exec', cmd: 'npm test', ok: false },
      { kind: 'exec', cmd: 'npm test', ok: false },
    ],
  });
  writeTranscript(claudeDir, 'proj', 'session-billing', jsonl);
}

/** Build a valid new-doc Proposal citing the fixture's charge.ts. */
function validProposal(opts: { headSha: string; sourcePath: string }): Proposal {
  return {
    kind: 'new-doc',
    path: 'docs/billing.md',
    frontmatter: {
      derived_from: ['session-billing'],
      unit: { kind: 'area', key: 'src/billing' },
      struggle_score: 0.42,
      cause: 'doc',
      source_files: [`${opts.sourcePath}@${opts.headSha}`],
      created: '2026-07-24T10:00:00Z',
    },
    body: '## Billing\n\nThe charge pipeline.',
    cited_symbols: ['charge'],
    referenced_paths: [opts.sourcePath],
    dedupe: { nearest_existing: null, decision_rationale: 'no near-duplicate found' },
    verification: {
      cited_symbols_resolved: true,
      paths_resolved: true,
      shas_valid: true,
    },
  };
}

/** Wrap a Proposal as the claude print-mode stdout envelope. */
function claudeEnvelope(proposal: Proposal): string {
  return JSON.stringify({ type: 'result', result: JSON.stringify(proposal) });
}

describe('closed loop: runSynthesize → runReview (integration)', () => {
  it('review sees the real cause, confidence>0, evidence_refs, verification, and path', async () => {
    const { runSynthesize } = await import('../src/synthesizer/index.js');
    const { runReview } = await import('../src/review.js');
    const { repo, headSha, sourcePath } = makeRepoWithSource();
    const claudeDir = makeTempDir('claude');
    writeBillingSession(repo, claudeDir);

    // 1. Synthesize with a stubbed backend returning a valid new-doc Proposal.
    const synResult = await runSynthesize({
      repo,
      harness: 'claude-code',
      claudeDir,
      runBackendFn: async () => claudeEnvelope(validProposal({ headSha, sourcePath })),
    });
    expect(synResult.exitCode).toBe(0);
    expect(synResult.proposals).toHaveLength(1);

    // 2. Review the synthesized proposal via --json (no TTY required).
    const revResult = await runReview({ repo, json: true });
    expect(revResult.exitCode).toBe(0);

    const arr = JSON.parse(revResult.output) as Array<Record<string, unknown>>;
    expect(arr).toHaveLength(1);
    const fm = arr[0]!;

    // The REAL cause from the diagnoser (not 'unknown').
    expect(fm.cause).toBe('doc');
    // The REAL confidence from the diagnoser — strictly > 0 (proves the field
    // was threaded from Diagnosis, not defaulted to 0 by normalizeFrontmatter).
    expect(typeof fm.confidence).toBe('number');
    expect(fm.confidence as number).toBeGreaterThan(0);
    // The REAL evidence_refs from the diagnoser — non-empty array (proves the
    // wrong-cause mitigation has rationale to surface). Each leaf is a
    // derived-only EvidenceRef (signal / doc_absent / failure_profile / ...).
    expect(Array.isArray(fm.evidence_refs)).toBe(true);
    expect((fm.evidence_refs as unknown[]).length).toBeGreaterThan(0);
    // Verification carried through from the pre-write fact-check (all-true for
    // a proposal citing the fixture's real charge.ts @ HEAD sha).
    expect(fm.verification).toEqual({
      cited_symbols_resolved: true,
      paths_resolved: true,
      shas_valid: true,
    });
    // The proposal's target path (Review's accept moves the file here).
    expect(fm.path).toBe('docs/billing.md');
  });
});
