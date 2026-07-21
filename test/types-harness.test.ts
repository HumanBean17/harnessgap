// Type-level + runtime smoke for the shared dispatch seam introduced in
// Task 1 (Qwen Code + GigaCode slice). These contracts live in `src/types.ts`
// and are consumed by later tasks (HarnessSpec registry, adapter selectors).
//
// Compile-time assertions:
//   (a) `HarnessId` admits exactly the three pinned literals — 'qwen-code'
//       is assignable, 'foo' is a type error.
//   (b) `TranscriptLayout` is satisfied both with and without the optional
//       `sessionSubdir: 'chats'` field.
//   (c) `CapabilityMatrix` requires all seven `CapabilityKey` entries —
//       constructing one missing `resume` is a type error.
// The runtime `it()` constructs one valid value and deep-equals itself so
// vitest has a runnable test (otherwise the file would be skipped).

import { describe, it, expect } from 'vitest';
import type {
  HarnessId,
  TranscriptLayout,
  CapabilityKey,
  CapabilityMatrix,
} from '../src/types.js';

describe('shared dispatch types (Task 1)', () => {
  it('HarnessId, TranscriptLayout, CapabilityMatrix compile and round-trip', () => {
    // (a) HarnessId admits exactly the three pinned ids.
    const claude: HarnessId = 'claude-code';
    const qwen: HarnessId = 'qwen-code';
    const giga: HarnessId = 'gigacode';
    // @ts-expect-error — unknown literal must be rejected by the union
    const bad: HarnessId = 'foo';

    // (b) TranscriptLayout is satisfied with and without sessionSubdir.
    const withChats: TranscriptLayout = {
      projectsSegment: 'projects',
      sessionSubdir: 'chats',
      extension: '.jsonl',
    };
    const withoutChats: TranscriptLayout = {
      projectsSegment: 'projects',
      extension: '.jsonl',
    };

    // (c) CapabilityMatrix requires all seven CapabilityKey entries.
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

    // Sanity: CapabilityKey enumerates exactly the seven keys.
    const keys: CapabilityKey[] = [
      'sessionDiscovery',
      'streamFormat',
      'finalizationSignal',
      'interruption',
      'fileChangeEvidence',
      'resume',
      'perPromptContextInjection',
    ];

    // Use every binding so they are not elided; deep-equal a constructed
    // value against itself to give vitest a runnable assertion.
    expect([claude, qwen, giga, bad]).toEqual([
      'claude-code',
      'qwen-code',
      'gigacode',
      'foo',
    ]);
    expect(withChats).toEqual(withChats);
    expect(withoutChats).toEqual(withoutChats);
    expect(full).toEqual(full);
    expect(missingResume).toEqual(missingResume);
    expect(keys).toHaveLength(7);
  });
});
