// Review (Curator lite) — closed-loop MVP Task 12. `runReview` lists the
// synthesized new-doc proposals under `docs/_proposals/` (excluding
// `_digest.md`), parses each file's YAML frontmatter → { path, cause,
// confidence, evidence_refs?, verification }, and offers accept / reject.
// Accept moves the file to its frontmatter `path` (validated to be under a
// configured `docs_dir`); reject deletes the file. `--yes` accepts all
// non-interactively; `--json` emits the parsed list without a TTY. Fail-open.
//
// Fixture style: a plain temp dir (NOT a git repo — review does no git or
// network I/O) with a `docs/_proposals/` folder of hand-authored proposal
// markdown files. Frontmatter is emitted via `yaml.stringify` so the parser is
// guaranteed to round-trip it. `acceptProposal` / `rejectProposal` are also
// exercised directly to cover the per-proposal programmatic path required by
// the brief (testable without a TTY).

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';

const tmpDirs: string[] = [];

/** Create a temp dir, tracked for cleanup. */
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `harnessgap-review-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

/** Frontmatter shape written by the synthesizer / read by review. */
interface Fm {
  path: string;
  cause: string;
  confidence: number;
  evidence_refs?: unknown[];
  verification: {
    cited_symbols_resolved: boolean;
    paths_resolved: boolean;
    shas_valid: boolean;
  };
}

/**
 * Write one proposal markdown file under `<repo>/docs/_proposals/<filename>`.
 * The frontmatter block is emitted via `yaml.stringify` so the review parser
 * is guaranteed to round-trip it. Returns the absolute path to the file.
 */
function writeProposalFile(
  repo: string,
  filename: string,
  fm: Fm,
  body = '## Draft\n\nSynthesized doc body.',
): string {
  const dir = join(repo, 'docs', '_proposals');
  mkdirSync(dir, { recursive: true });
  const yamlBlock = stringify(fm).trimEnd();
  const content = `---\n${yamlBlock}\n---\n\n${body}\n`;
  const abs = join(dir, filename);
  writeFileSync(abs, content, 'utf8');
  return abs;
}

/** Baseline frontmatter for a doc-cause proposal that targets `targetPath`. */
function docFm(targetPath: string, opts: Partial<Fm> = {}): Fm {
  return {
    path: targetPath,
    cause: 'doc',
    confidence: 0.72,
    evidence_refs: [
      { kind: 'signal', name: 'reread', value: 5 },
      { kind: 'doc_absent', checked: ['docs/billing.md'] },
    ],
    verification: {
      cited_symbols_resolved: true,
      paths_resolved: true,
      shas_valid: true,
    },
    ...opts,
  };
}

describe('runReview — --json lists parsed frontmatter', () => {
  it('emits cause, confidence, and the three verification booleans; excludes _digest.md', async () => {
    const { runReview } = await import('../src/review.js');
    const repo = makeTempDir('repo');
    writeProposalFile(repo, 'src-billing-doc-abcd1234.md', docFm('docs/architecture/billing.md'));
    writeProposalFile(repo, 'src-billing-config-doc-efgh5678.md', {
      ...docFm('docs/config/billing.md'),
      cause: 'config-doc',
      confidence: 0.55,
      verification: {
        cited_symbols_resolved: true,
        paths_resolved: false,
        shas_valid: true,
      },
    });
    // _digest.md must be excluded even though it is a .md file in _proposals/.
    writeFileSync(
      join(repo, 'docs', '_proposals', '_digest.md'),
      '## src/billing\ncause: doc\nstatus: skipped\n',
      'utf8',
    );

    const result = await runReview({ repo, json: true });

    expect(result.exitCode).toBe(0);
    const arr = JSON.parse(result.output) as Array<Record<string, unknown>>;
    expect(arr).toHaveLength(2);
    const causes = arr.map((p) => p.cause).sort();
    expect(causes).toEqual(['config-doc', 'doc']);
    const first = arr.find((p) => p.cause === 'doc')!;
    expect(first.path).toBe('docs/architecture/billing.md');
    expect(first.confidence).toBe(0.72);
    expect(first.verification).toEqual({
      cited_symbols_resolved: true,
      paths_resolved: true,
      shas_valid: true,
    });
    // evidence_refs carried through so reviewers can sanity-check the rationale.
    expect(Array.isArray(first.evidence_refs)).toBe(true);
    expect((first.evidence_refs as unknown[]).length).toBe(2);
  });
});

describe('runReview --yes — accept moves file to frontmatter path', () => {
  it('moves a valid proposal under docs/ (source removed, target exists)', async () => {
    const { runReview } = await import('../src/review.js');
    const repo = makeTempDir('repo');
    const src = writeProposalFile(repo, 'src-billing-doc-abcd1234.md', docFm('docs/architecture/billing.md'));

    const result = await runReview({ repo, yes: true });

    expect(result.exitCode).toBe(0);
    // Source proposal file is gone from _proposals/.
    expect(existsSync(src)).toBe(false);
    // Target doc now exists at the frontmatter path under docs/.
    const target = join(repo, 'docs', 'architecture', 'billing.md');
    expect(existsSync(target)).toBe(true);
    // The body (not just frontmatter) was carried into the target file.
    expect(readFileSync(target, 'utf8')).toContain('## Draft');
  });
});

describe('acceptProposal — path outside docs_dirs is refused', () => {
  it('does not move the file and reports a confinement error', async () => {
    const { acceptProposal, listProposals } = await import('../src/review.js');
    const repo = makeTempDir('repo');
    // path resolves OUTSIDE docs/ (the default docs_dirs is ['docs']).
    const abs = writeProposalFile(repo, 'evil-escape.md', docFm('../etc/passwd'));
    const repoRoot = repo;
    const docsDirs = ['docs'];

    const [parsed] = listProposals(repoRoot);
    expect(parsed).toBeDefined();
    const res = acceptProposal({ proposal: parsed!, repoRoot, docsDirs });

    expect(res.ok).toBe(false);
    // Either confinement check may fire first (repo-root escape OR docs-dir
    // confinement); both are valid clear refusals for a path outside docs_dirs.
    expect(res.message).toMatch(/docs_dirs|docs dir|escapes repo root/i);
    // The proposal file is untouched (not moved, not deleted).
    expect(existsSync(abs)).toBe(true);
    // No file was created at the escaped target.
    expect(existsSync(join(repo, '..', 'etc', 'passwd'))).toBe(false);
  });
});

describe('acceptProposal — target already exists is refused', () => {
  it('does not move or delete; message mentions already exists / refusing', async () => {
    const { acceptProposal, listProposals } = await import('../src/review.js');
    const repo = makeTempDir('repo');
    const src = writeProposalFile(
      repo,
      'src-billing-doc-abcd1234.md',
      docFm('docs/architecture/billing.md'),
    );
    // Pre-create the target doc — accept must NOT silently clobber it.
    const target = join(repo, 'docs', 'architecture', 'billing.md');
    mkdirSync(join(repo, 'docs', 'architecture'), { recursive: true });
    writeFileSync(target, '# Existing billing doc\n', 'utf8');

    const [parsed] = listProposals(repo);
    expect(parsed).toBeDefined();
    const res = acceptProposal({ proposal: parsed!, repoRoot: repo, docsDirs: ['docs'] });

    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/already exists|refusing/i);
    // Source proposal is untouched (still in docs/_proposals/).
    expect(existsSync(src)).toBe(true);
    // Target content is unchanged — NOT overwritten with the proposal body.
    expect(readFileSync(target, 'utf8')).toContain('Existing billing doc');
    expect(readFileSync(target, 'utf8')).not.toContain('## Draft');
  });
});

describe('rejectProposal — deletes the file', () => {
  it('removes the proposal from docs/_proposals/', async () => {
    const { rejectProposal, listProposals } = await import('../src/review.js');
    const repo = makeTempDir('repo');
    const abs = writeProposalFile(repo, 'src-billing-doc-abcd1234.md', docFm('docs/architecture/billing.md'));

    const [parsed] = listProposals(repo);
    expect(parsed).toBeDefined();
    const res = rejectProposal({ absPath: parsed!.absPath });

    expect(res.ok).toBe(true);
    expect(existsSync(abs)).toBe(false);
  });
});

describe('runReview — numbered list (no flags)', () => {
  it('prints a numbered list with cause + confidence + verification; excludes _digest.md', async () => {
    const { runReview } = await import('../src/review.js');
    const repo = makeTempDir('repo');
    writeProposalFile(repo, 'src-billing-doc-abcd1234.md', docFm('docs/architecture/billing.md'));
    writeFileSync(
      join(repo, 'docs', '_proposals', '_digest.md'),
      '## src/billing\ncause: doc\nstatus: skipped\n',
      'utf8',
    );

    const result = await runReview({ repo });

    expect(result.exitCode).toBe(0);
    // Numbered list rendering.
    expect(result.output).toMatch(/1\.\s/);
    // Cause + confidence surface in the human view.
    expect(result.output).toContain('doc');
    expect(result.output).toContain('0.72');
    // Verification surfaced so a reviewer can spot a failed fact-check.
    expect(result.output).toMatch(/verif/i);
    // _digest.md excluded — its content does not leak into the list.
    expect(result.output).not.toContain('status: skipped');
  });
});

describe('runReview — empty / missing _proposals directory', () => {
  it('returns a clean empty message (exitCode 0) when no proposals exist', async () => {
    const { runReview } = await import('../src/review.js');
    const repo = makeTempDir('repo');
    // No docs/_proposals/ created at all.

    const result = await runReview({ repo, json: true });

    expect(result.exitCode).toBe(0);
    const arr = JSON.parse(result.output) as unknown[];
    expect(arr).toEqual([]);
  });
});

describe('runReview --yes — mixed batch (one valid, one escaped)', () => {
  it('accepts the valid proposal and refuses the escaped one; both reported', async () => {
    const { runReview } = await import('../src/review.js');
    const repo = makeTempDir('repo');
    const validSrc = writeProposalFile(
      repo,
      'src-billing-doc-abcd1234.md',
      docFm('docs/architecture/billing.md'),
    );
    const evilSrc = writeProposalFile(repo, 'evil-escape.md', docFm('../etc/passwd'));

    const result = await runReview({ repo, yes: true });

    expect(result.exitCode).toBe(0);
    // Valid proposal moved.
    expect(existsSync(validSrc)).toBe(false);
    expect(existsSync(join(repo, 'docs', 'architecture', 'billing.md'))).toBe(true);
    // Escaped proposal refused (file stays, no target created).
    expect(existsSync(evilSrc)).toBe(true);
    expect(result.output).toMatch(/docs_dirs|docs dir|refus/i);
  });
});
