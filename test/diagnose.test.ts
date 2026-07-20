// Task 8: diagnoseUnits orchestration. Thin coordinator that calls
// buildProfiles (Task 5) → gatherRepoContext (Task 6) → classify (Task 7) per
// unit, with two layers of fail-open: per-unit (a thrown classify/context step
// degrades that unit to `unclassified`, never aborts the batch) and outer
// batch-level (a thrown buildProfiles degrades the whole batch to `[]`).
//
// Cases (a)-(d) + (f) drive the REAL pipeline over a real tmp repo + docs dir
// (mirrors test/repo-context.test.ts). Case (e) verifies the bad-docsDir path
// still yields a Diagnosis (no throw). Cases (e') and (g) flip a hoisted
// vi.mock toggle to force `classify` to throw for one key — directly exercising
// the orchestrator's per-unit try/catch (mirrors the pattern in
// test/reflect.test.ts). Case (h) flips a second hoisted toggle to force
// `buildProfiles` to throw — exercising the OUTER batch-level fail-open. Both
// mocks delegate to the real implementation by default, so (a)-(g) are
// unaffected.

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { DEFAULT_CONFIG } from '../src/config.js';
import type {
  Config,
  SignalValues,
  StruggleRecord,
} from '../src/types.js';

// --- hoisted fail-open toggle for cases (e') and (g) -----------------------
// vi.mock is hoisted above every import, so when diagnoseUnits loads classify
// it gets this wrapper. Default behavior delegates to the real classify; setting
// `classifyThrows.onKey` to a string forces a throw for that one unit only
// (other units in the same batch still classify normally). The hoisted container
// survives module reloads.
const classifyThrows = vi.hoisted(() => ({ onKey: null as string | null }));
vi.mock('../src/diagnoser/classify.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/diagnoser/classify.js')>();
  return {
    ...actual,
    classify: (...args: Parameters<typeof actual.classify>) => {
      const profile = args[0];
      if (
        classifyThrows.onKey !== null &&
        profile.key === classifyThrows.onKey
      ) {
        throw new Error(`forced classify failure for ${profile.key}`);
      }
      return actual.classify(...args);
    },
  };
});

// --- hoisted fail-open toggle for case (h) ---------------------------------
// Same shape, but for buildProfiles. When `buildProfilesThrows.on` is true the
// wrapper throws unconditionally, exercising the OUTER batch-level try/catch
// in diagnoseUnits (the contract that runScan relies on: never throws).
const buildProfilesThrows = vi.hoisted(() => ({ on: false }));
vi.mock('../src/diagnoser/profile.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/diagnoser/profile.js')>();
  return {
    ...actual,
    buildProfiles: (...args: Parameters<typeof actual.buildProfiles>) => {
      if (buildProfilesThrows.on) {
        throw new Error('forced buildProfiles failure');
      }
      return actual.buildProfiles(...args);
    },
  };
});

// Importing AFTER vi.mock so the wrapper applies inside diagnoseUnits.
import { diagnoseUnits } from '../src/diagnoser/index.js';

// --- tmp repo helpers ------------------------------------------------------

const REPOS: string[] = [];

function makeRepo(): string {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'harnessgap-diagnose-'));
  REPOS.push(r);
  return r;
}

afterEach(() => {
  // Reset the fail-open toggles between tests so ordering never matters.
  classifyThrows.onKey = null;
  buildProfilesThrows.on = false;
  while (REPOS.length) {
    const r = REPOS.pop()!;
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

// --- record builders -------------------------------------------------------

function zeroSignals(overrides: Partial<SignalValues> = {}): SignalValues {
  return {
    explore_ratio: null,
    reread: 0,
    failure_streak: 0,
    corrections: 0,
    abandonment: false,
    oscillation: 0,
    wall_clock_per_line_ms: null,
    ...overrides,
  };
}

function mkRecord(overrides: Partial<StruggleRecord> = {}): StruggleRecord {
  return {
    session_id: 's',
    repo: 'r',
    started_at: '2024-01-01T00:00:00Z',
    duration_ms: 0,
    score_pct: 0,
    mode: 'bootstrap',
    flagged: true,
    truncated: false,
    event_count: 0,
    areas: [],
    signals: zeroSignals(),
    ...overrides,
  };
}

const CFG: Config = DEFAULT_CONFIG;

// --- tests -----------------------------------------------------------------

describe('diagnoseUnits', () => {
  it('(a) flagged doc-shaped record, no doc present → one Diagnosis cause=doc', () => {
    const repo = makeRepo();
    // No docs/ created → gatherRepoContext returns docExists=false. Three of
    // five signature signals elevated → score 0.6 >= confidence_floor 0.5, and
    // explore_ratio+reread elevated with doc absent → doc wins.
    const records = [
      mkRecord({
        session_id: 's1',
        areas: [{ key: 'src/billing', weight: 1 }],
        signals: zeroSignals({
          explore_ratio: 11.2, // >= 10 threshold
          reread: 6, // >= 5 threshold
          oscillation: 3, // >= 2 threshold
        }),
      }),
    ];
    const out = diagnoseUnits(records, CFG, repo);
    expect(out).toHaveLength(1);
    expect(out[0].unit).toEqual({ kind: 'area', key: 'src/billing' });
    expect(out[0].cause).toBe('doc');
    expect(out[0].confidence).toBeGreaterThanOrEqual(0.5);
    // doc_absent evidence cites the checked docsDirs (audited attempt).
    const docAbsent = out[0].evidence_refs.find((r) => r.kind === 'doc_absent');
    expect(docAbsent).toBeDefined();
  });

  it('(b) matching doc created → cause=refactor-flag (oscillation/corrections/code-share hold)', () => {
    const repo = makeRepo();
    // Create docs/billing.md → gatherRepoContext returns docExists=true → doc
    // is gated off; refactor-flag wins with the +doc boost.
    fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'docs', 'billing.md'), '# billing\n');

    const records = [
      mkRecord({
        session_id: 's1',
        areas: [{ key: 'src/billing', weight: 1 }],
        signals: zeroSignals({
          explore_ratio: 11.2,
          reread: 6,
          oscillation: 4, // >= 2 threshold
          corrections: 3, // >= 2 threshold
        }),
        evidence: {
          failures: { config: 0, test: 0, build: 0, other: 0 },
          // code-share 8/(8+1+1) = 0.8 >= 0.5
          edit_kinds: { test: 1, code: 8, other: 1 },
        },
      }),
    ];
    const out = diagnoseUnits(records, CFG, repo);
    expect(out).toHaveLength(1);
    expect(out[0].unit).toEqual({ kind: 'area', key: 'src/billing' });
    expect(out[0].cause).toBe('refactor-flag');
    // refactor-flag cites doc_present + edit_profile as grounding.
    expect(out[0].evidence_refs.some((r) => r.kind === 'doc_present')).toBe(true);
    expect(out[0].evidence_refs.some((r) => r.kind === 'edit_profile')).toBe(true);
  });

  it('(c) unflagged records produce no diagnoses', () => {
    const repo = makeRepo();
    const records = [
      mkRecord({
        flagged: false,
        areas: [{ key: 'src/a', weight: 1 }],
        signals: zeroSignals({ reread: 99 }), // would be elevated, but unflagged
      }),
      mkRecord({
        flagged: false,
        areas: [{ key: 'src/b', weight: 1 }],
      }),
    ];
    expect(diagnoseUnits(records, CFG, repo)).toEqual([]);
  });

  it('(d) two flagged areas → two diagnoses sorted by key ascending', () => {
    const repo = makeRepo();
    // Insert in non-sorted order to verify the orchestrator sorts the output.
    const records = [
      mkRecord({
        session_id: 's1',
        areas: [{ key: 'src/zeta', weight: 1 }],
        signals: zeroSignals({
          explore_ratio: 11.2,
          reread: 6,
          oscillation: 3,
        }),
      }),
      mkRecord({
        session_id: 's2',
        areas: [{ key: 'src/alpha', weight: 1 }],
        signals: zeroSignals({
          explore_ratio: 11.2,
          reread: 6,
          oscillation: 3,
        }),
      }),
    ];
    const out = diagnoseUnits(records, CFG, repo);
    expect(out.map((d) => d.unit.key)).toEqual(['src/alpha', 'src/zeta']);
    // Each diagnosis has the right unit shape; both cause=doc (doc absent,
    // three signature signals elevated → score 0.6).
    for (const d of out) {
      expect(d.unit.kind).toBe('area');
      expect(d.cause).toBe('doc');
    }
  });

  it('(e) fail-open: docsDirs pointing at an escaping path still yields a Diagnosis (no throw)', () => {
    const repo = makeRepo();
    // `../escape` resolves outside the repo root → gatherRepoContext rejects it
    // via path-confinement and returns docExists=false (its own fail-open). The
    // orchestrator must propagate that gracefully — no throw — and classify
    // normally (doc wins, since the signature matches and doc is "absent").
    const records = [
      mkRecord({
        session_id: 's1',
        areas: [{ key: 'src/billing', weight: 1 }],
        signals: zeroSignals({
          explore_ratio: 11.2,
          reread: 6,
          oscillation: 3,
        }),
      }),
    ];
    const cfg: Config = { ...CFG, docs_dirs: ['../escape'] };
    const out = diagnoseUnits(records, cfg, repo);
    expect(out).toHaveLength(1);
    expect(out[0].unit).toEqual({ kind: 'area', key: 'src/billing' });
    expect(out[0].cause).toBe('doc');
  });

  it("(e') fail-open: a thrown classify degrades that unit to 'unclassified' (no throw, exact fallback shape)", () => {
    const repo = makeRepo();
    // Force classify to throw for src/alpha. The orchestrator must catch,
    // substitute the exact derived-only fallback Diagnosis, and never throw.
    // (g) below extends this to a mixed batch; this case pins the fallback
    // shape itself.
    classifyThrows.onKey = 'src/alpha';
    try {
      const records = [
        mkRecord({
          session_id: 's1',
          areas: [{ key: 'src/alpha', weight: 1 }],
          signals: zeroSignals({ reread: 6 }),
        }),
      ];
      const out = diagnoseUnits(records, CFG, repo);
      expect(out).toHaveLength(1);
      expect(out[0].unit).toEqual({ kind: 'area', key: 'src/alpha' });
      expect(out[0].cause).toBe('unclassified');
      expect(out[0].confidence).toBe(0);
      expect(out[0].rationale).toBe('diagnosis unavailable');
      expect(out[0].evidence_refs).toEqual([]);
    } finally {
      classifyThrows.onKey = null;
    }
  });

  it('(g) fail-open: one unit throws, the other still classifies (mixed batch, sorted)', () => {
    // Stronger fail-open: a thrown classify for one unit must not poison the
    // batch — the other unit should still get its real Diagnosis, and the
    // combined output is sorted by key.
    const repo = makeRepo();
    fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'docs', 'billing.md'), '# billing\n');

    // src/alpha will throw; src/billing will classify normally.
    classifyThrows.onKey = 'src/alpha';
    try {
      const records = [
        mkRecord({
          session_id: 's1',
          areas: [{ key: 'src/alpha', weight: 1 }],
          signals: zeroSignals({ reread: 6 }),
        }),
        mkRecord({
          session_id: 's2',
          areas: [{ key: 'src/billing', weight: 1 }],
          signals: zeroSignals({
            explore_ratio: 11.2,
            reread: 6,
            oscillation: 4,
            corrections: 3,
          }),
          evidence: {
            failures: { config: 0, test: 0, build: 0, other: 0 },
            edit_kinds: { test: 1, code: 8, other: 1 },
          },
        }),
      ];
      const out = diagnoseUnits(records, CFG, repo);
      expect(out).toHaveLength(2);
      expect(out.map((d) => d.unit.key)).toEqual(['src/alpha', 'src/billing']);
      // src/alpha failed open.
      const alpha = out.find((d) => d.unit.key === 'src/alpha')!;
      expect(alpha.cause).toBe('unclassified');
      expect(alpha.rationale).toBe('diagnosis unavailable');
      expect(alpha.evidence_refs).toEqual([]);
      // src/billing was classified normally (refactor-flag, doc present).
      const billing = out.find((d) => d.unit.key === 'src/billing')!;
      expect(billing.cause).toBe('refactor-flag');
    } finally {
      classifyThrows.onKey = null;
    }
  });

  it('(f) empty input → empty output', () => {
    const repo = makeRepo();
    expect(diagnoseUnits([], CFG, repo)).toEqual([]);
  });

  it("(h) outer fail-open: a thrown buildProfiles degrades the whole batch to [] (no throw, never aborts the scan)", () => {
    // runScan calls diagnoseUnits unguarded, so the function itself must never
    // throw — even if buildProfiles somehow regresses (it can't throw on
    // detector-produced records, but the contract must hold unconditionally).
    // Force buildProfiles to throw; diagnoseUnits must catch and return [].
    const repo = makeRepo();
    const records = [
      mkRecord({
        session_id: 's1',
        areas: [{ key: 'src/billing', weight: 1 }],
        signals: zeroSignals({ reread: 6 }),
      }),
    ];
    buildProfilesThrows.on = true;
    try {
      const out = diagnoseUnits(records, CFG, repo);
      // No throw — empty array fallback. The whole batch degrades to nothing
      // rather than propagating the throw to runScan.
      expect(out).toEqual([]);
    } finally {
      buildProfilesThrows.on = false;
    }
  });

  it('(i) #32 percentile mode: above-cohort-median signals elevate → a specific cause fires (not unclassified)', () => {
    // 25 low-signal baseline sessions + 5 struggling sessions on 'src/x'. In
    // percentile mode the cohort median for every signal is driven down by the
    // baseline, so the struggling area's signals are all "above typical" and
    // elevate — letting the `doc` gate fire (explore_ratio + reread elevated,
    // no doc). Under bootstrap absolute floors (reread>=5, explore_ratio>=10)
    // these same signals would NOT elevate and the area collapses to
    // `unclassified` — the bug #32 describes. This test pins both outcomes.
    const repo = makeRepo(); // no docs/ → gatherRepoContext returns docExists=false
    const baseline = Array.from({ length: 25 }, (_, i) =>
      mkRecord({
        session_id: `base${i}`,
        flagged: false,
        signals: zeroSignals({
          explore_ratio: 0.1,
          wall_clock_per_line_ms: 10_000,
        }),
      }),
    );
    const struggling = Array.from({ length: 5 }, (_, i) =>
      mkRecord({
        session_id: `strug${i}`,
        areas: [{ key: 'src/x', weight: 1 }],
        signals: zeroSignals({
          explore_ratio: 1.0,
          reread: 2,
          failure_streak: 2,
          corrections: 3,
          oscillation: 2,
          wall_clock_per_line_ms: 50_000,
        }),
      }),
    );

    // Percentile mode: cohort-median elevation → doc fires (was unclassified).
    const pctRecords = [...baseline, ...struggling].map((r) => ({
      ...r,
      mode: 'percentile' as const,
    }));
    const pctOut = diagnoseUnits(pctRecords, CFG, repo);
    expect(pctOut).toHaveLength(1);
    expect(pctOut[0].unit.key).toBe('src/x');
    expect(pctOut[0].cause).toBe('doc');
    expect(pctOut[0].confidence).toBeGreaterThanOrEqual(0.5);

    // Bootstrap mode (same signals): absolute floors → reread 2 < 5 and
    // explore_ratio 1.0 < 10 do not elevate → doc gate closed → unclassified.
    // Kept as the bootstrap regression guard (bootstrap elevation is unchanged).
    const bootRecords = [...baseline, ...struggling].map((r) => ({
      ...r,
      mode: 'bootstrap' as const,
    }));
    const bootOut = diagnoseUnits(bootRecords, CFG, repo);
    expect(bootOut).toHaveLength(1);
    expect(bootOut[0].cause).toBe('unclassified');
  });
});
