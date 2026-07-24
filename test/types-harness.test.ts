// Type-level + runtime smoke for the shared dispatch seam introduced in
// Task 1 (Qwen Code + GigaCode slice), plus the closed-loop MVP types
// (Synthesizer + Review foundation). These contracts live in `src/types.ts`
// and are consumed by later tasks (HarnessSpec registry, adapter selectors,
// Proposal synthesis, fact-check).
//
// Enforcement note (read before relying on this file):
//   - The `// @ts-expect-error` directives below are NOT enforced by
//     `npm test` (vitest's esbuild transform strips them without type-checking)
//     nor by `npm run typecheck` (tsconfig.json has `include: ["src"]` and
//     `rootDir: "src"`, so this file is outside its graph). They are enforced
//     only by IDE type-checking or a direct `tsc --noEmit` on this file.
//   - The `HarnessId` / `HarnessSpec` contracts themselves ARE enforced
//     transitively by `npm run typecheck` via `src/` consumers in later tasks.
//   - The closed-loop `Proposal` / `StruggleRecord.docs_read` /
//     `docs_injected` contracts are enforced the same way once later tasks
//     in the plan consume them from `src/`.
//   - The runtime `it()` blocks below carry the CI-enforced coverage for this
//     file: they genuinely exercise the contracts (HarnessId exhaustiveness,
//     CapabilityMatrix key set, TranscriptLayout optionality, closed-loop
//     field presence/optionality) so a regression at runtime breaks the suite.

import { describe, it, expect } from 'vitest';
import type {
  HarnessId,
  TranscriptLayout,
  CapabilityKey,
  CapabilityMatrix,
  DocRead,
  DocInjection,
  StruggleRecord,
  Proposal,
  FactCheckFailure,
  FactCheckResult,
  Config,
} from '../src/types.js';

describe('shared dispatch types (Task 1)', () => {
  it('HarnessId admits exactly the three pinned literals', () => {
    // The `: HarnessId[]` annotation gives compile-time checking in IDE; the
    // runtime length + equality assertions catch a union member being
    // added/removed, which would require this literal array to change
    // in lockstep.
    // @ts-expect-error — unknown literal must be rejected by the union
    const bad: HarnessId = 'foo';
    const HARNESS_IDS: HarnessId[] = ['claude-code', 'qwen-code', 'gigacode'];
    expect(HARNESS_IDS).toHaveLength(3);
    expect(HARNESS_IDS).toEqual(['claude-code', 'qwen-code', 'gigacode']);
    // Reference `bad` so the binding is not elided and the
    // `@ts-expect-error` above stays meaningful under direct tsc.
    expect(bad).toBe('foo');
  });

  it('TranscriptLayout.sessionSubdir is optional', () => {
    const withChats: TranscriptLayout = {
      projectsSegment: 'projects',
      sessionSubdir: 'chats',
      extension: '.jsonl',
    };
    const withoutChats: TranscriptLayout = {
      projectsSegment: 'projects',
      extension: '.jsonl',
    };
    expect(withChats.sessionSubdir).toBe('chats');
    expect('sessionSubdir' in withoutChats).toBe(false);
    expect(withoutChats.sessionSubdir).toBeUndefined();
  });

  it('CapabilityMatrix keys exactly match the seven CapabilityKey literals', () => {
    const full: CapabilityMatrix = {
      sessionDiscovery: 'supported',
      streamFormat: 'supported',
      finalizationSignal: 'pending',
      interruption: 'supported',
      fileChangeEvidence: 'pending',
      resume: 'supported',
      perPromptContextInjection: 'pending',
    };
    // @ts-expect-error — missing `resume` property must be rejected
    const missingResume: CapabilityMatrix = {
      sessionDiscovery: 'supported',
      streamFormat: 'supported',
      finalizationSignal: 'pending',
      interruption: 'supported',
      fileChangeEvidence: 'pending',
      perPromptContextInjection: 'pending',
    };
    const EXPECTED_KEYS: CapabilityKey[] = [
      'sessionDiscovery',
      'streamFormat',
      'finalizationSignal',
      'interruption',
      'fileChangeEvidence',
      'resume',
      'perPromptContextInjection',
    ];
    expect(Object.keys(full).sort()).toEqual([...EXPECTED_KEYS].sort());
    // Reference `missingResume` so the binding is not elided and the
    // `@ts-expect-error` above stays meaningful under direct tsc; it should
    // hold exactly the six non-`resume` keys at runtime.
    expect(Object.keys(missingResume).sort()).toEqual(
      [...EXPECTED_KEYS].filter((k) => k !== 'resume').sort(),
    );
  });
});

describe('closed-loop types (Task 1: synthesizer + review foundation)', () => {
  // A minimal but fully-populated `StruggleRecord` literal used by the
  // docs_read/docs_injected-required assertions below. Constructed without
  // the new always-on fields on the `@ts-expect-error` lines to prove they
  // are required (not optional).
  function baseRecord(): StruggleRecord {
    return {
      session_id: 's1',
      repo: 'r',
      started_at: '2026-07-24T00:00:00Z',
      duration_ms: 0,
      score_pct: 0,
      mode: 'percentile',
      flagged: false,
      truncated: false,
      event_count: 0,
      areas: [],
      signals: {
        explore_ratio: null,
        reread: 0,
        failure_streak: 0,
        corrections: 0,
        abandonment: false,
        oscillation: 0,
        wall_clock_per_line_ms: null,
      },
      docs_read: [],
      docs_injected: [],
    };
  }

  it('StruggleRecord.docs_read and docs_injected are required (always-on)', () => {
    const full: StruggleRecord = {
      ...baseRecord(),
      docs_read: [{ path: 'docs/x.md', t: '2026-07-24T00:00:00Z' }],
      docs_injected: [
        { path: 'docs/x.md', t: '2026-07-24T00:00:00Z', trigger: 'edit' },
      ],
    };
    expect(full.docs_read).toHaveLength(1);
    expect(full.docs_injected[0]?.trigger).toBe('edit');

    // Omitting both new fields must be a type error. TS2739 (missing required
    // property on a top-level literal) reports on the `const` declaration, so
    // the directive sits directly above it.
    // @ts-expect-error — missing docs_read and docs_injected must be rejected
    const missingBoth: StruggleRecord = {
      session_id: 's1',
      repo: 'r',
      started_at: '2026-07-24T00:00:00Z',
      duration_ms: 0,
      score_pct: 0,
      mode: 'percentile',
      flagged: false,
      truncated: false,
      event_count: 0,
      areas: [],
      signals: {
        explore_ratio: null,
        reread: 0,
        failure_streak: 0,
        corrections: 0,
        abandonment: false,
        oscillation: 0,
        wall_clock_per_line_ms: null,
      },
    };
    // Reference `missingBoth` so the binding is not elided and the
    // `@ts-expect-error` above stays meaningful under direct tsc.
    expect(missingBoth.session_id).toBe('s1');

    // Assigning `undefined` to a required (non-optional) field must also be
    // rejected. The offending property is nested under a spread, so TS2322
    // reports on the property line — the directive sits directly above it.
    const missingInj: StruggleRecord = {
      ...baseRecord(),
      // @ts-expect-error — undefined is not assignable to DocInjection[]
      docs_injected: undefined,
    };
    expect(missingInj.session_id).toBe('s1');
  });

  it('DocRead and DocInjection shapes (trigger is a closed literal)', () => {
    const dr: DocRead = { path: 'docs/x.md', t: '2026-07-24T00:00:00Z' };
    const diEdit: DocInjection = {
      path: 'docs/x.md',
      t: '2026-07-24T00:00:00Z',
      trigger: 'edit',
    };
    const diStart: DocInjection = {
      path: 'docs/x.md',
      t: '2026-07-24T00:00:00Z',
      trigger: 'start',
    };
    expect(dr.path).toBe('docs/x.md');
    expect(diEdit.trigger).toBe('edit');
    expect(diStart.trigger).toBe('start');

    // `trigger` must reject literals outside the closed union. The bad value
    // is a nested property, so the directive sits directly above it (not
    // above the `const`).
    const badTrigger: DocInjection = {
      path: 'docs/x.md',
      t: '2026-07-24T00:00:00Z',
      // @ts-expect-error — trigger:'manual' is not in 'edit' | 'start'
      trigger: 'manual',
    };
    expect(badTrigger.trigger).toBe('manual');
  });

  it('Proposal (kind: new-doc) literal type-checks with all required blocks', () => {
    const p: Proposal = {
      kind: 'new-doc',
      path: 'docs/areas/cli-friction.md',
      frontmatter: {
        derived_from: ['s1'],
        unit: { kind: 'area', key: 'src/cli' },
        struggle_score: 0.72,
        cause: 'doc',
        source_files: ['src/cli.ts'],
        created: '2026-07-24T00:00:00Z',
      },
      body: '# CLI friction\n\nDraft body.',
      cited_symbols: ['parseArgs'],
      referenced_paths: ['src/cli.ts'],
      dedupe: {
        nearest_existing: null,
        similarity: 0.1,
        decision_rationale: 'no near-duplicate above floor',
      },
      verification: {
        cited_symbols_resolved: true,
        paths_resolved: true,
        shas_valid: true,
      },
    };
    expect(p.kind).toBe('new-doc');
    expect(p.frontmatter.unit.key).toBe('src/cli');
    expect(p.dedupe.nearest_existing).toBeNull();
    expect(p.verification.shas_valid).toBe(true);

    // `kind` is the discriminant and must reject other literals.
    // @ts-expect-error — kind:'edit' is not assignable to 'new-doc'
    const badKind: Proposal = { ...p, kind: 'edit' };
    expect(badKind.kind).toBe('edit');

    // `dedupe.decision_rationale` is required (not optional). The bad value
    // is a nested property (under a spread), so the directive sits directly
    // above the `dedupe:` line.
    const noRationale: Proposal = {
      ...p,
      // @ts-expect-error — missing dedupe.decision_rationale must be rejected
      dedupe: { nearest_existing: null },
    };
    expect(noRationale.path).toBe(p.path);
  });

  it('FactCheckFailure and FactCheckResult shapes', () => {
    const symbolFail: FactCheckFailure = {
      assertion: 'parseArgs exists',
      kind: 'symbol',
      resolved: false,
    };
    const pathFailWithDetail: FactCheckFailure = {
      assertion: 'docs/foo.md exists',
      kind: 'path',
      resolved: true,
      detail: 'resolved after regenerate',
    };
    const result: FactCheckResult = { failures: [symbolFail, pathFailWithDetail] };
    expect(result.failures).toHaveLength(2);
    expect(result.failures[1]?.detail).toBe('resolved after regenerate');

    // `kind` is a closed literal union. The bad value is a nested property,
    // so the directive sits directly above it.
    const badKind: FactCheckFailure = {
      assertion: 'a',
      // @ts-expect-error — kind:'lint' is not in 'symbol' | 'path' | 'sha'
      kind: 'lint',
      resolved: false,
    };
    expect(badKind.kind).toBe('lint');
  });

  it('Config.synthesizer block + Config.diagnose.confidence_floor_for_prose', () => {
    const synthesizer: Config['synthesizer'] = {
      backend: 'claude-code',
      model: 'sonnet',
      structure_only: false,
      max_file_head_bytes: 8192,
      dedupe: 'tfidf',
      top_n: 3,
    };
    expect(synthesizer.structure_only).toBe(false);
    expect(synthesizer.dedupe).toBe('tfidf');

    // `dedupe` is a closed literal union.
    // @ts-expect-error — dedupe:'semantic' is not in 'none' | 'tfidf'
    const badDedupe: Config['synthesizer'] = { ...synthesizer, dedupe: 'semantic' };
    expect(badDedupe.dedupe).toBe('semantic');

    // `diagnose.confidence_floor_for_prose` is a number on Config.diagnose.
    const diagnose: Config['diagnose'] = {
      confidence_floor: 0.4,
      confidence_floor_for_prose: 0.6,
      config_share_floor: 0.5,
      test_share_floor: 0.5,
      code_share_floor: 0.5,
      score_floor: 60,
    };
    expect(diagnose.confidence_floor_for_prose).toBe(0.6);

    // Omitting confidence_floor_for_prose must be a type error.
    // @ts-expect-error — missing confidence_floor_for_prose must be rejected
    const missingProseFloor: Config['diagnose'] = {
      confidence_floor: 0.4,
      config_share_floor: 0.5,
      test_share_floor: 0.5,
      code_share_floor: 0.5,
      score_floor: 60,
    };
    expect(missingProseFloor.confidence_floor).toBe(0.4);
  });
});
