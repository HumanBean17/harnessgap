// Synthesizer orchestration (Task 10). `runSynthesize` composes the full closed
// loop: collectEnvelopes → runDetector (collect docs_read + evidence) →
// diagnoseUnits → per-unit { buildBundle → resolveBackend → runBackend →
// extractProposal → normalize → assertNewDocProposal/isEditProposal → factCheck
// → write }. Fail-open throughout.
//
// Fixture style mirrors test/pipeline.test.ts + test/factcheck.test.ts: a REAL
// temp git repo with a committed source file (so HEAD is a real sha the
// fact-checker accepts and the cited symbol resolves against real content) plus
// a real claudeDir with a real .jsonl transcript that flags the src/billing
// area with a doc-cause signal mix. The only seam substituted is `runBackendFn`
// — it returns a canned claude envelope wrapping a Proposal object, so NO real
// model call ever fires.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  setupTempRepo,
  writeTranscript,
  writeQwenTranscript,
  mkSession,
  mkQwenSession,
  cleanupTempDirs,
  readsMulti,
} from './helpers/builder.js';
import type { Proposal } from '../src/types.js';

const tmpDirs: string[] = [];

/** Create a temp dir, tracked for cleanup. */
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `harnessgap-synth-${prefix}-`));
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
 * real sha and the symbol `charge` resolves). Returns the repo path + HEAD sha.
 * No `docs/` is created → gatherRepoContext reports doc absent → cause=doc.
 */
function makeRepoWithSource(): { repo: string; headSha: string; sourcePath: string } {
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
  const headSha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  return { repo, headSha, sourcePath: 'src/billing/charge.ts' };
}

/**
 * Write a transcript that flags `src/billing` with a doc-cause signal mix:
 *  - 5 files × 7 reads = 35 reads, 3 edit-lines → explore_ratio ≈ 11.7 (≥10)
 *  - 5 files each read 7× (≥5) → reread = 5
 *  - 2 user_msg corrections after edits → corrections = 2
 *  - 3 consecutive failed execs → failure_streak = 3
 * 4/5 signature signals elevated → score 0.8 ≥ floor; doc wins (explore+reread,
 * doc absent, precedence). The transcript's file paths do NOT need to exist on
 * disk — the detector counts events, not file contents.
 */
function writeBillingSession(repo: string, claudeDir: string, slug: string, name: string): void {
  const jsonl = mkSession(repo, {
    name,
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
  writeTranscript(claudeDir, slug, name, jsonl);
}

/**
 * Same signal mix as writeBillingSession, but emitted as Qwen-shaped JSONL
 * (functionCall/ui_telemetry/tool_result triples) and laid out under the
 * Qwen `<rootDir>/projects/<slug>/chats/` level the qwen-code dispatcher's
 * TranscriptLayout requires.
 */
function writeBillingQwenSession(repo: string, rootDir: string, slug: string, name: string): void {
  const jsonl = mkQwenSession(repo, {
    name,
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
  writeQwenTranscript(rootDir, slug, name, jsonl);
}

/** Build a valid new-doc Proposal object citing the fixture's charge.ts. */
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

/**
 * Wrap a Proposal object as the claude print-mode stdout envelope:
 * `{"type":"result","result":"<JSON string of proposal>"}`. This is the shape
 * `extractProposal(stdout, 'claude-code')` unwraps (outer parse → `.result`
 * string → inner parse → proposal object).
 */
function claudeEnvelope(proposal: Proposal): string {
  return JSON.stringify({ type: 'result', result: JSON.stringify(proposal) });
}

/**
 * Wrap a Proposal as the qwen-code print-mode stdout envelope: a JSON ARRAY of
 * records (system / assistant / result). The `result` record's `.result` is a
 * JSON STRING of the proposal payload — which `extractProposal(stdout,
 * 'qwen-code')` returns AS A STRING (not parsed), forcing the caller's
 * `typeof unwrapped === 'string'` normalize branch to JSON.parse it. This is
 * the dead-in-suite path Finding 2 targets. gigacode shares this shape.
 */
function qwenEnvelope(proposal: Proposal): string {
  return JSON.stringify([
    { type: 'system', content: 'qwen boot' },
    { type: 'assistant', content: 'thinking...' },
    { type: 'result', subtype: 'success', result: JSON.stringify(proposal) },
  ]);
}

/** Read every file under `docs/_proposals/`, indexed by basename. */
function readProposals(repo: string): Record<string, string> {
  const dir = join(repo, 'docs', '_proposals');
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    out[name] = readFileSync(join(dir, name), 'utf8');
  }
  return out;
}

describe('runSynthesize — happy path', () => {
  it('writes exactly one proposal under docs/_proposals/ with correct frontmatter (exitCode 0)', async () => {
    const { runSynthesize } = await import('../src/synthesizer/index.js');
    const { repo, headSha, sourcePath } = makeRepoWithSource();
    const claudeDir = makeTempDir('claude');
    writeBillingSession(repo, claudeDir, 'proj', 'session-billing');

    let backendCalls = 0;
    const result = await runSynthesize({
      repo,
      harness: 'claude-code',
      claudeDir,
      runBackendFn: async () => {
        backendCalls += 1;
        return claudeEnvelope(validProposal({ headSha, sourcePath }));
      },
    });

    expect(backendCalls).toBe(1);
    expect(result.exitCode).toBe(0);
    expect(result.proposals).toHaveLength(1);

    const files = readProposals(repo);
    const proposalNames = Object.keys(files).filter((n) =>
      /src-billing-doc-[0-9a-f]{8}\.md$/.test(n),
    );
    expect(proposalNames).toHaveLength(1);
    const written = files[proposalNames[0]!];

    // Frontmatter carries cause/unit/verification all-true.
    expect(written).toContain('cause: doc');
    expect(written).toContain('unit: src/billing');
    expect(written).toContain('cited_symbols_resolved: true');
    expect(written).toContain('paths_resolved: true');
    expect(written).toContain('shas_valid: true');
    // The synthesized body is carried through.
    expect(written).toContain('## Billing');
  });
});

describe('runSynthesize — fact-check failure', () => {
  it('writes a needs-human note naming the failing symbol; no doc proposal (exitCode 0)', async () => {
    const { runSynthesize } = await import('../src/synthesizer/index.js');
    const { repo, headSha, sourcePath } = makeRepoWithSource();
    const claudeDir = makeTempDir('claude');
    writeBillingSession(repo, claudeDir, 'proj', 'session-billing');

    // Proposal cites a symbol that does NOT appear in charge.ts → symbol check
    // fails → needs-human note, no doc.
    const proposal = validProposal({ headSha, sourcePath });
    proposal.cited_symbols = ['totallyMissingSymbol'];

    const result = await runSynthesize({
      repo,
      harness: 'claude-code',
      claudeDir,
      runBackendFn: async () => claudeEnvelope(proposal),
    });

    expect(result.exitCode).toBe(0);
    expect(result.proposals).toEqual([]);

    const files = readProposals(repo);
    const docProposals = Object.keys(files).filter((n) =>
      /src-billing-doc-[0-9a-f]{8}\.md$/.test(n),
    );
    expect(docProposals).toHaveLength(0);
    // A needs-human note exists naming the failing symbol.
    const needsHumanBodies = Object.values(files).filter((b) => /needs human/i.test(b));
    expect(needsHumanBodies.length).toBeGreaterThanOrEqual(1);
    expect(needsHumanBodies.some((b) => b.includes('totallyMissingSymbol'))).toBe(true);
  });
});

describe('runSynthesize — non-qualifying unit (cause not doc/config-doc)', () => {
  it('does NOT call the backend and appends a digest entry', async () => {
    const { runSynthesize } = await import('../src/synthesizer/index.js');
    const { repo, headSha, sourcePath } = makeRepoWithSource();
    // Create docs/billing.md → gatherRepoContext reports doc present → the doc
    // cause is gated off. The remaining signal mix yields a non-doc cause
    // (test-gap / refactor-flag), which is not in {doc, config-doc} → the unit
    // is routed to the digest and the backend is never invoked.
    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'billing.md'), '# billing\n');

    const claudeDir = makeTempDir('claude');
    writeBillingSession(repo, claudeDir, 'proj', 'session-billing');

    let backendCalls = 0;
    const result = await runSynthesize({
      repo,
      harness: 'claude-code',
      claudeDir,
      runBackendFn: async () => {
        backendCalls += 1;
        return claudeEnvelope(validProposal({ headSha, sourcePath }));
      },
    });

    expect(backendCalls).toBe(0);
    expect(result.exitCode).toBe(0);
    expect(result.proposals).toEqual([]);

    const files = readProposals(repo);
    // A digest was appended naming the src/billing unit.
    expect(files['_digest.md']).toBeDefined();
    expect(files['_digest.md']).toContain('src/billing');
    // No successful proposal file was written.
    const docProposals = Object.keys(files).filter((n) =>
      /src-billing-doc-[0-9a-f]{8}\.md$/.test(n),
    );
    expect(docProposals).toHaveLength(0);
  });
});

describe('runSynthesize — backend throw (fail-open)', () => {
  it('appends a digest entry and returns exitCode 0 (never crashes)', async () => {
    const { runSynthesize } = await import('../src/synthesizer/index.js');
    const { repo } = makeRepoWithSource();
    const claudeDir = makeTempDir('claude');
    writeBillingSession(repo, claudeDir, 'proj', 'session-billing');

    const result = await runSynthesize({
      repo,
      harness: 'claude-code',
      claudeDir,
      runBackendFn: async () => {
        throw new Error('backend exploded: rate limited');
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.proposals).toEqual([]);

    const files = readProposals(repo);
    expect(files['_digest.md']).toBeDefined();
    // The digest surfaces the failure (not silently swallowed).
    expect(files['_digest.md']).toContain('src/billing');
  });
});

describe('runSynthesize — qwen-code envelope (string→object normalize)', () => {
  it('parses a qwen array envelope and writes the proposal (exercises the string normalize branch)', async () => {
    const { runSynthesize } = await import('../src/synthesizer/index.js');
    const { repo, headSha, sourcePath } = makeRepoWithSource();
    const qwenDir = makeTempDir('qwen');
    writeBillingQwenSession(repo, qwenDir, 'proj', 'session-billing');

    // qwen-code/gigacode: extractProposal returns the `.result` field AS A
    // STRING (the inner JSON of the Proposal). The normalize branch
    // (`typeof unwrapped === 'string' → JSON.parse`) must turn it into the
    // object the validator expects. With a claude envelope this branch is
    // dead (extractProposal returns a parsed object), so this is the only
    // coverage of that path.
    const result = await runSynthesize({
      repo,
      harness: 'qwen-code',
      harnessDir: qwenDir,
      runBackendFn: async () => qwenEnvelope(validProposal({ headSha, sourcePath })),
    });

    expect(result.exitCode).toBe(0);
    expect(result.proposals).toHaveLength(1);

    const files = readProposals(repo);
    const proposalNames = Object.keys(files).filter((n) =>
      /src-billing-doc-[0-9a-f]{8}\.md$/.test(n),
    );
    expect(proposalNames).toHaveLength(1);
    const written = files[proposalNames[0]!];

    // Same load-bearing frontmatter + body assertions as the claude happy path,
    // proving the normalized proposal survived validation/fact-check/write.
    expect(written).toContain('cause: doc');
    expect(written).toContain('unit: src/billing');
    expect(written).toContain('cited_symbols_resolved: true');
    expect(written).toContain('paths_resolved: true');
    expect(written).toContain('shas_valid: true');
    expect(written).toContain('## Billing');
  });
});
