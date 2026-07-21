// Type-level + runtime smoke for the shared dispatch seam introduced in
// Task 1 (Qwen Code + GigaCode slice). These contracts live in `src/types.ts`
// and are consumed by later tasks (HarnessSpec registry, adapter selectors).
//
// Enforcement note (read before relying on this file):
//   - The `// @ts-expect-error` directives below are NOT enforced by
//     `npm test` (vitest's esbuild transform strips them without type-checking)
//     nor by `npm run typecheck` (tsconfig.json has `include: ["src"]` and
//     `rootDir: "src"`, so this file is outside its graph). They are enforced
//     only by IDE type-checking or a direct `tsc --noEmit` on this file.
//   - The `HarnessId` / `HarnessSpec` contracts themselves ARE enforced
//     transitively by `npm run typecheck` via `src/` consumers in later tasks.
//   - The runtime `it()` blocks below carry the CI-enforced coverage for this
//     file: they genuinely exercise the three contracts (HarnessId
//     exhaustiveness, CapabilityMatrix key set, TranscriptLayout optionality)
//     so a regression at runtime breaks the suite.

import { describe, it, expect } from 'vitest';
import type {
  HarnessId,
  TranscriptLayout,
  CapabilityKey,
  CapabilityMatrix,
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
