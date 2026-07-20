// Task 7: the pure cause-classification rule engine. `classify` takes a
// `UnitProfile` + `RepoContext` + `Config` and emits a `Diagnosis` — cause,
// confidence, derived-only rationale, derived-only evidence_refs.
//
// Scoring (per the brief): each eligible specific cause gets a score in [0,1]
// proportional to how many of the shared 5 signature signals
// {explore_ratio, reread, failure_streak, corrections, oscillation} are
// elevated; refactor-flag gets a +boost when repoContext.docExists. Pick the
// highest score; ties broken by fixed precedence doc > config-doc > test-gap
// > refactor-flag. If the winner's score < cfg.diagnose.confidence_floor, fall
// through to inherent-complexity (when wall_clock elevated + meanScore >=
// score_floor) else unclassified.
//
// The 8 cases mirror the brief verbatim:
//  (a) explore+reread elevated, no doc -> doc (score >= 0.5 needs >= 3 elevated)
//  (b) docExists gates doc off -> refactor-flag wins instead
//  (c) failure_streak elevated + config-share >= 0.5 -> config-doc
//  (d) oscillation+failure_streak + test-share, corrections low -> test-gap
//  (e) wall_clock elevated + meanScore 80, no specific -> inherent-complexity
//  (f) nothing elevated -> unclassified, confidence 0
//  (g) tie doc vs refactor-flag (equal score) -> doc by precedence
//  (h) weak doc (score 0.4 < 0.5 floor), no expense -> unclassified
//
// Pure: no I/O; constructed inputs are not mutated.

import { describe, it, expect } from 'vitest';
import { classify } from '../src/diagnoser/classify.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import type {
  Config,
  SessionEvidence,
  SignalName,
} from '../src/types.js';
import type { UnitProfile } from '../src/diagnoser/profile.js';
import type { RepoContext } from '../src/diagnoser/repo-context.js';

type Median = Record<SignalName, number | boolean | null>;
type Elevated = Record<SignalName, boolean>;

const ZERO_EVIDENCE: SessionEvidence = {
  failures: { config: 0, test: 0, build: 0, other: 0 },
  edit_kinds: { test: 0, code: 0, other: 0 },
};

/** Build a UnitProfile with all medians/elevated zeroed, overrides on top. */
function mkProfile(overrides: {
  key?: string;
  meanScore?: number;
  medians?: Partial<Median>;
  elevated?: Partial<Elevated>;
  evidence?: SessionEvidence;
  flaggedCount?: number;
}): UnitProfile {
  const medians: Median = {
    explore_ratio: null,
    reread: 0,
    failure_streak: 0,
    corrections: 0,
    abandonment: false,
    oscillation: 0,
    wall_clock_per_line: null,
    ...overrides.medians,
  };
  const elevated: Elevated = {
    explore_ratio: false,
    reread: false,
    failure_streak: false,
    corrections: false,
    abandonment: false,
    oscillation: false,
    wall_clock_per_line: false,
    ...overrides.elevated,
  };
  return {
    key: overrides.key ?? 'src/billing',
    flaggedCount: overrides.flaggedCount ?? 1,
    meanScore: overrides.meanScore ?? 50,
    medians,
    elevated,
    evidence: overrides.evidence ?? ZERO_EVIDENCE,
  };
}

/** Build a RepoContext; default is doc absent, checked ['docs']. */
function mkContext(overrides: Partial<RepoContext> = {}): RepoContext {
  return {
    docExists: false,
    matchedPath: null,
    checked: ['docs'],
    ...overrides,
  };
}

const CFG: Config = DEFAULT_CONFIG;

describe('classify', () => {
  it('(a) explore_ratio + reread (+oscillation) elevated, doc absent -> cause=doc, confidence >= 0.5', () => {
    // 3 of 5 signature signals elevated -> score 0.6 >= default floor 0.5.
    const profile = mkProfile({
      medians: { explore_ratio: 11.2, reread: 6, oscillation: 3 },
      elevated: {
        explore_ratio: true,
        reread: true,
        oscillation: true,
        // failure_streak, corrections NOT elevated -> no other cause eligible.
      },
    });
    const ctx = mkContext({ docExists: false, checked: ['docs'] });
    const d = classify(profile, ctx, CFG);
    expect(d.unit).toEqual({ kind: 'area', key: 'src/billing' });
    expect(d.cause).toBe('doc');
    expect(d.confidence).toBeGreaterThanOrEqual(0.5);
    // rationale mentions doc absence (derived-only — no prose from records).
    expect(d.rationale.toLowerCase()).toContain('doc');
    // evidence_refs carries a doc_absent entry with the checked dirs.
    const docAbsent = d.evidence_refs.find((r) => r.kind === 'doc_absent');
    expect(docAbsent).toBeDefined();
    expect((docAbsent as { checked: string[] }).checked).toEqual(['docs']);
    // elevated signals appear as signal refs with their median values.
    const sigRefs = d.evidence_refs.filter((r) => r.kind === 'signal');
    const names = sigRefs.map((r) => (r as { name: SignalName }).name);
    expect(names).toContain('explore_ratio');
    expect(names).toContain('reread');
    // No prose leaked: rationale is short, derived-only.
    expect(d.rationale.length).toBeLessThan(200);
  });

  it('(b) docExists=true gates doc off; refactor-flag wins with oscillation+corrections+code-share', () => {
    // Same elevated profile as (a) plus corrections; docExists gates doc off.
    const profile = mkProfile({
      medians: {
        explore_ratio: 11.2,
        reread: 6,
        oscillation: 4,
        corrections: 3,
      },
      elevated: {
        explore_ratio: true,
        reread: true,
        oscillation: true,
        corrections: true,
      },
      evidence: {
        failures: { config: 0, test: 0, build: 0, other: 0 },
        edit_kinds: { test: 1, code: 8, other: 1 }, // code-share 0.8 >= 0.5
      },
    });
    const ctx = mkContext({
      docExists: true,
      matchedPath: 'docs/billing.md',
      checked: ['docs'],
    });
    const d = classify(profile, ctx, CFG);
    expect(d.cause).toBe('refactor-flag');
    expect(d.confidence).toBeGreaterThanOrEqual(0.5);
    // refactor-flag evidence_refs include an edit_profile and doc_present.
    expect(d.evidence_refs.some((r) => r.kind === 'edit_profile')).toBe(true);
    expect(d.evidence_refs.some((r) => r.kind === 'doc_present')).toBe(true);
  });

  it('(c) failure_streak elevated + config-share 0.66 >= 0.5 -> config-doc', () => {
    // failure_streak is the only signature signal thematically required, but
    // the shared-5 scoring needs >= 3 elevated for score >= 0.5. Elevating
    // explore+reread would make doc eligible, so set docExists=true to gate
    // doc off and let config-doc win on its own.
    const profile = mkProfile({
      medians: {
        explore_ratio: 11.2,
        reread: 6,
        failure_streak: 4,
      },
      elevated: {
        explore_ratio: true,
        reread: true,
        failure_streak: true,
        // oscillation, corrections NOT elevated -> test-gap/refactor-flag off.
      },
      evidence: {
        // config 4 / (4+1+0+1) = 4/6 = 0.667 >= 0.5
        failures: { config: 4, test: 1, build: 0, other: 1 },
        edit_kinds: { test: 0, code: 0, other: 0 },
      },
    });
    const ctx = mkContext({ docExists: true, matchedPath: 'docs/billing.md' });
    const d = classify(profile, ctx, CFG);
    expect(d.cause).toBe('config-doc');
    // failure_profile is included as evidence.
    const fp = d.evidence_refs.find((r) => r.kind === 'failure_profile');
    expect(fp).toBeDefined();
    expect((fp as { config: number }).config).toBe(4);
    // rationale mentions config-share (derived ratio only, no commands).
    expect(d.rationale.toLowerCase()).toContain('config-share');
  });

  it('(d) oscillation+failure_streak elevated, test-share 0.75, corrections low -> test-gap', () => {
    // 3 of 5 signature signals elevated (oscillation, failure_streak,
    // explore_ratio) -> score 0.6. corrections NOT elevated keeps refactor-flag
    // off; explore_ratio without reread keeps doc off.
    const profile = mkProfile({
      medians: { explore_ratio: 11.2, oscillation: 3, failure_streak: 4 },
      elevated: {
        explore_ratio: true,
        oscillation: true,
        failure_streak: true,
        // reread, corrections NOT elevated.
      },
      evidence: {
        failures: { config: 0, test: 0, build: 0, other: 0 },
        // test 6 / (6+2+0) = 0.75 >= 0.5
        edit_kinds: { test: 6, code: 2, other: 0 },
      },
    });
    const d = classify(profile, mkContext(), CFG);
    expect(d.cause).toBe('test-gap');
    expect(d.evidence_refs.some((r) => r.kind === 'edit_profile')).toBe(true);
    expect(d.rationale.toLowerCase()).toContain('test-share');
  });

  it('(e) wall_clock elevated + meanScore 80, no specific eligible -> inherent-complexity', () => {
    const profile = mkProfile({
      meanScore: 80,
      medians: { wall_clock_per_line: 600000 },
      elevated: { wall_clock_per_line: true },
      // No signature signal elevated -> no specific cause eligible.
    });
    const d = classify(profile, mkContext(), CFG);
    expect(d.cause).toBe('inherent-complexity');
    expect(d.confidence).toBeGreaterThan(0);
    expect(d.confidence).toBeLessThanOrEqual(1);
    // rationale derived-only: mentions wall_clock/expense without prose.
    expect(d.rationale.length).toBeLessThan(200);
  });

  it("(e') realistic post-#33 path: median at the winsorization cap (threshold) -> conf 1.0", () => {
    // #33 winsorizes wall_clock_per_line_ms at the bootstrap threshold, so the
    // largest median the real pipeline can produce IS the threshold (300000).
    // expenseConfidence divides by the threshold (factor 1), so the cap maps to
    // confidence 1.0 — the full [0,1] range stays reachable post-cap (a prior
    // factor of 2 capped it at 0.5).
    const profile = mkProfile({
      meanScore: 80,
      medians: { wall_clock_per_line: 300000 },
      elevated: { wall_clock_per_line: true },
    });
    const d = classify(profile, mkContext(), CFG);
    expect(d.cause).toBe('inherent-complexity');
    expect(d.confidence).toBe(1);
  });

  it('(f) nothing elevated but flagged -> unclassified, confidence 0', () => {
    const profile = mkProfile({});
    const d = classify(profile, mkContext(), CFG);
    expect(d.cause).toBe('unclassified');
    expect(d.confidence).toBe(0);
  });

  it('(g) tie doc vs refactor-flag (equal score) -> doc by fixed precedence', () => {
    // 4 of 5 signature signals elevated (explore, reread, oscillation,
    // corrections) -> both doc and refactor-flag eligible with score 0.8.
    // docExists=false -> no refactor-flag boost -> scores equal -> doc wins.
    const profile = mkProfile({
      medians: {
        explore_ratio: 11.2,
        reread: 6,
        oscillation: 4,
        corrections: 3,
      },
      elevated: {
        explore_ratio: true,
        reread: true,
        oscillation: true,
        corrections: true,
      },
      evidence: {
        failures: { config: 0, test: 0, build: 0, other: 0 },
        edit_kinds: { test: 1, code: 8, other: 1 }, // code-share 0.8
      },
    });
    const ctx = mkContext({ docExists: false });
    const d = classify(profile, ctx, CFG);
    expect(d.cause).toBe('doc');
    expect(d.confidence).toBeCloseTo(0.8, 5);
  });

  it('(h) weak doc (score 0.4 < confidence_floor 0.5) + no expense -> unclassified', () => {
    // doc eligible by gate (explore + reread elevated, doc absent) but only
    // 2 of 5 signature signals elevated -> score 0.4 < 0.5 floor. wall_clock
    // NOT elevated -> inherent-complexity fallback also fails -> unclassified.
    const profile = mkProfile({
      medians: { explore_ratio: 11.2, reread: 6 },
      elevated: {
        explore_ratio: true,
        reread: true,
        // failure_streak, corrections, oscillation all false.
      },
    });
    const d = classify(profile, mkContext(), CFG);
    expect(d.cause).toBe('unclassified');
    expect(d.confidence).toBe(0);
  });

  it('does not mutate inputs (purity)', () => {
    const profile = mkProfile({
      medians: { explore_ratio: 11.2, reread: 6, oscillation: 3 },
      elevated: { explore_ratio: true, reread: true, oscillation: true },
      evidence: {
        failures: { config: 1, test: 0, build: 0, other: 0 },
        edit_kinds: { test: 0, code: 0, other: 0 },
      },
    });
    const ctx = mkContext();
    const profileSnap = JSON.parse(JSON.stringify(profile));
    const ctxSnap = JSON.parse(JSON.stringify(ctx));
    const cfgSnap = JSON.parse(JSON.stringify(CFG));
    classify(profile, ctx, CFG);
    expect(JSON.parse(JSON.stringify(profile))).toEqual(profileSnap);
    expect(JSON.parse(JSON.stringify(ctx))).toEqual(ctxSnap);
    expect(JSON.parse(JSON.stringify(CFG))).toEqual(cfgSnap);
  });

  it('deterministic: same inputs -> same output across repeated calls', () => {
    const profile = mkProfile({
      medians: {
        explore_ratio: 11.2,
        reread: 6,
        failure_streak: 4,
        oscillation: 3,
      },
      elevated: {
        explore_ratio: true,
        reread: true,
        failure_streak: true,
        oscillation: true,
      },
      evidence: {
        failures: { config: 4, test: 1, build: 0, other: 1 },
        edit_kinds: { test: 0, code: 0, other: 0 },
      },
    });
    const ctx = mkContext();
    const a = classify(profile, ctx, CFG);
    const b = classify(profile, ctx, CFG);
    expect(JSON.parse(JSON.stringify(a))).toEqual(JSON.parse(JSON.stringify(b)));
  });
});
