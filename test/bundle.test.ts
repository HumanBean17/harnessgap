// Evidence bundle / prompt assembly (Synthesizer, Task 9). `buildBundle`
// composes the prompt string sent to the backend from: the diagnosis, the
// unit's struggle records, the docs inventory (paths + size-capped bodies),
// and source file-heads under the area prefix (capped + scrubbed). Pure string
// assembly + bounded node:fs reads — NO child_process.
//
// Fixture style mirrors test/factcheck.test.ts: a real temp repo with known
// doc + source files so file discovery, caps, and scrubbing all run against
// real disk. No git is required (unlike factcheck, bundle does not pin shas).

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBundle } from '../src/synthesizer/bundle.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import type { Cause, Config, Diagnosis, StruggleRecord } from '../src/types.js';

const tmpDirs: string[] = [];

/** Create a temp dir, tracked for cleanup in afterEach. */
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `harnessgap-bundle-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}

interface FixtureOpts {
  /** Write a large doc body (10_000 chars) to docs/billing.md for cap tests. */
  bigDoc?: boolean;
  /** Embed an AWS access-key id in src/billing/pricing.ts to exercise scrubbing. */
  secretInSource?: boolean;
}

/**
 * Build a temp repo with a known layout:
 *   docs/architecture.md           — small doc
 *   docs/billing.md                — 10_000-char body when bigDoc
 *   src/billing/charge.ts          — source under the area prefix
 *   src/billing/pricing.ts         — source under the area prefix (secret opt)
 *   src/other/unrelated.ts         — source NOT under the prefix (must be excluded)
 */
function makeFixtureRepo(opts: FixtureOpts = {}): string {
  const repo = makeTempDir('repo');
  mkdirSync(join(repo, 'docs'), { recursive: true });
  mkdirSync(join(repo, 'src', 'billing'), { recursive: true });
  mkdirSync(join(repo, 'src', 'other'), { recursive: true });

  writeFileSync(
    join(repo, 'docs', 'architecture.md'),
    '# Architecture\n\nBilling pipeline overview.\n',
  );
  writeFileSync(join(repo, 'docs', 'billing.md'), opts.bigDoc ? 'x'.repeat(10_000) : 'small billing doc\n');

  writeFileSync(
    join(repo, 'src', 'billing', 'charge.ts'),
    'export function charge(n: number): number { return n; }\n',
  );
  writeFileSync(
    join(repo, 'src', 'billing', 'pricing.ts'),
    opts.secretInSource
      ? 'const KEY = "AKIAIOSFODNN7EXAMPLE";\nexport function price(n: number): number { return n * 2; }\n'
      : 'export function price(n: number): number { return n * 2; }\n',
  );
  writeFileSync(join(repo, 'src', 'other', 'unrelated.ts'), 'export const unrelated = true;\n');
  return repo;
}

/** A minimal diagnosis for the src/billing unit. */
function baseDiagnosis(cause: Cause = 'doc'): Diagnosis {
  return {
    unit: { kind: 'area', key: 'src/billing' },
    cause,
    confidence: 0.82,
    rationale: 'Elevated reread signal and missing billing doc.',
    evidence_refs: [
      { kind: 'signal', name: 'reread', value: 4 },
      { kind: 'doc_absent', checked: ['docs'] },
    ],
  };
}

/** One struggle record for the src/billing unit. */
function baseRecords(): StruggleRecord[] {
  return [
    {
      session_id: 's1',
      repo: 'r',
      started_at: '2026-07-24T10:00:00Z',
      duration_ms: 600_000,
      score_pct: 72,
      mode: 'percentile',
      flagged: true,
      truncated: false,
      event_count: 50,
      areas: [{ key: 'src/billing', weight: 0.9 }],
      signals: {
        explore_ratio: 0.4,
        reread: 4,
        failure_streak: 2,
        corrections: 1,
        abandonment: false,
        oscillation: 3,
        wall_clock_per_line_ms: 120,
      },
      docs_read: [],
      docs_injected: [],
    },
  ];
}

/** Default config with synthesizer overrides. */
function cfg(overrides: Partial<Config['synthesizer']> = {}): Config {
  return {
    ...DEFAULT_CONFIG,
    synthesizer: { ...DEFAULT_CONFIG.synthesizer, ...overrides },
  };
}

afterEach(() => {
  while (tmpDirs.length) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe('buildBundle — required content', () => {
  it('includes the unitKey, cause, confidence, rationale, and doc paths', () => {
    const repo = makeFixtureRepo();
    const out = buildBundle({
      diagnosis: baseDiagnosis(),
      records: baseRecords(),
      unitKey: 'src/billing',
      repoRoot: repo,
      cfg: cfg(),
    });
    // unitKey (area) is present as a labeled field, not just as a path prefix.
    expect(out).toContain('src/billing');
    // cause label is rendered (literal cause, not just a substring of another word).
    expect(out.toLowerCase()).toContain('cause');
    expect(out).toMatch(/doc\b/);
    // confidence + rationale verbatim.
    expect(out).toContain('0.82');
    expect(out).toContain('Elevated reread signal and missing billing doc.');
    // both doc paths from the inventory appear.
    expect(out).toContain('docs/architecture.md');
    expect(out).toContain('docs/billing.md');
  });

  it('instructs the backend to populate cited_symbols and referenced_paths', () => {
    const repo = makeFixtureRepo();
    const out = buildBundle({
      diagnosis: baseDiagnosis(),
      records: baseRecords(),
      unitKey: 'src/billing',
      repoRoot: repo,
      cfg: cfg(),
    });
    expect(out.toLowerCase()).toContain('cited_symbols');
    expect(out.toLowerCase()).toContain('referenced_paths');
  });

  it('renders the evidence_refs (signal + doc_absent) in the prompt', () => {
    const repo = makeFixtureRepo();
    const out = buildBundle({
      diagnosis: baseDiagnosis(),
      records: baseRecords(),
      unitKey: 'src/billing',
      repoRoot: repo,
      cfg: cfg(),
    });
    expect(out.toLowerCase()).toContain('reread');
    expect(out.toLowerCase()).toContain('doc_absent');
  });

  it('rolls up the unit aggregate signals from records', () => {
    const repo = makeFixtureRepo();
    const out = buildBundle({
      diagnosis: baseDiagnosis(),
      records: baseRecords(),
      unitKey: 'src/billing',
      repoRoot: repo,
      cfg: cfg(),
    });
    // signals block is present and names at least one aggregated signal.
    expect(out.toLowerCase()).toContain('signal');
    expect(out).toContain('reread');
  });
});

describe('buildBundle — structure_only note', () => {
  it('structure_only:true adds the "no full bodies" note', () => {
    const repo = makeFixtureRepo();
    const out = buildBundle({
      diagnosis: baseDiagnosis(),
      records: baseRecords(),
      unitKey: 'src/billing',
      repoRoot: repo,
      cfg: cfg({ structure_only: true }),
    });
    expect(out.toLowerCase()).toContain('no full bodies');
  });

  it('structure_only:false omits the "no full bodies" note', () => {
    const repo = makeFixtureRepo();
    const out = buildBundle({
      diagnosis: baseDiagnosis(),
      records: baseRecords(),
      unitKey: 'src/billing',
      repoRoot: repo,
      cfg: cfg({ structure_only: false }),
    });
    expect(out.toLowerCase()).not.toContain('no full bodies');
  });
});

describe('buildBundle — size caps', () => {
  it('a doc body larger than max_file_head_bytes is truncated', () => {
    const repo = makeFixtureRepo({ bigDoc: true });
    const cap = 256;
    const out = buildBundle({
      diagnosis: baseDiagnosis(),
      records: baseRecords(),
      unitKey: 'src/billing',
      repoRoot: repo,
      cfg: cfg({ max_file_head_bytes: cap }),
    });
    // The 10_000-char run of 'x' must not survive intact.
    expect(out).not.toContain('x'.repeat(10_000));
    // Longest consecutive run of 'x' is bounded by the per-file cap.
    const runs = out.match(/x+/g);
    const longest = runs ? Math.max(...runs.map((r) => r.length)) : 0;
    expect(longest).toBeLessThanOrEqual(cap);
  });

  it('a source file head larger than max_file_head_bytes is truncated', () => {
    const repo = makeTempDir('repo-bigsrc');
    mkdirSync(join(repo, 'src', 'billing'), { recursive: true });
    writeFileSync(join(repo, 'src', 'billing', 'big.ts'), 'y'.repeat(10_000));
    const cap = 200;
    const out = buildBundle({
      diagnosis: baseDiagnosis(),
      records: baseRecords(),
      unitKey: 'src/billing',
      repoRoot: repo,
      cfg: cfg({ max_file_head_bytes: cap }),
    });
    const runs = out.match(/y+/g);
    const longest = runs ? Math.max(...runs.map((r) => r.length)) : 0;
    expect(longest).toBeLessThanOrEqual(cap);
  });
});

describe('buildBundle — egress guard', () => {
  it('does not contain the literal fetch(', () => {
    const repo = makeFixtureRepo();
    const out = buildBundle({
      diagnosis: baseDiagnosis(),
      records: baseRecords(),
      unitKey: 'src/billing',
      repoRoot: repo,
      cfg: cfg(),
    });
    expect(out).not.toContain('fetch(');
  });
});

describe('buildBundle — area-prefix file scoping', () => {
  it('includes source files under the area prefix and excludes others', () => {
    const repo = makeFixtureRepo();
    const out = buildBundle({
      diagnosis: baseDiagnosis(),
      records: baseRecords(),
      unitKey: 'src/billing',
      repoRoot: repo,
      cfg: cfg(),
    });
    // Under the prefix → included.
    expect(out).toContain('charge.ts');
    expect(out).toContain('pricing.ts');
    // NOT under the prefix → excluded.
    expect(out).not.toContain('unrelated.ts');
    expect(out).not.toContain('src/other');
  });
});

describe('buildBundle — scrubbing', () => {
  it('scrubs known-format secrets out of source file heads', () => {
    const repo = makeFixtureRepo({ secretInSource: true });
    const out = buildBundle({
      diagnosis: baseDiagnosis(),
      records: baseRecords(),
      unitKey: 'src/billing',
      repoRoot: repo,
      cfg: cfg(),
    });
    // Raw AWS access-key id must NOT survive; the redaction sentinel must.
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out).toContain('***REDACTED***');
  });
});

describe('buildBundle — robustness', () => {
  it('never throws when the repo root does not exist', () => {
    expect(() =>
      buildBundle({
        diagnosis: baseDiagnosis(),
        records: baseRecords(),
        unitKey: 'src/billing',
        repoRoot: '/nonexistent/harnessgap/bundle/repo',
        cfg: cfg(),
      }),
    ).not.toThrow();
  });

  it('never throws when the area prefix dir is missing', () => {
    const repo = makeTempDir('empty');
    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'only.md'), 'just a doc\n');
    expect(() =>
      buildBundle({
        diagnosis: baseDiagnosis(),
        records: baseRecords(),
        unitKey: 'src/billing',
        repoRoot: repo,
        cfg: cfg(),
      }),
    ).not.toThrow();
  });
});
