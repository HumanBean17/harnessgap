// Corpus fixture definitions: 12 synthetic-but-realistic Claude Code sessions
// covering all 6 required categories. Each SessionSpec is a compact event-list
// that mkSession (test/helpers/builder.ts) converts to valid JSONL at test time.
//
// Categories covered:
//   1. clean-quick (×3: clean-quick, clean-build, clean-quick-2) — NOT flagged
//   2. heavy-exploration — flagged [explore_ratio, reread]
//   3. oscillation — flagged [corrections, wall_clock_per_line] *
//   4. failure-streak — flagged [corrections, wall_clock_per_line] *
//   5. abandonment — flagged [explore_ratio, abandonment]
//   5b. abandonment suppressed (research) — NOT flagged
//   6. tdd-red-green — NOT flagged (oscillation must be 0)
//
// Plus: reread-heavy, corrections-heavy, slow-wall-clock (extra signal coverage).
//
// * NOTE: oscillation and failure_streak signals are always 0 through the real
// pipeline due to a known detector bug (the exec tool_use event has ok=true;
// the result event has tool=null — so `e.tool === 'exec' && e.ok === false`
// never matches). These fixtures still exercise the intended behavioral
// patterns (edit→test-fail→edit-same-file; consecutive exec fails) and are
// flagged via working signals. When the bug is fixed, expected_top_signals can
// be updated to include oscillation / failure_streak.

import type { SessionSpec, EventSpec } from '../../helpers/builder.js';
import { reads, readsMulti } from '../../helpers/builder.js';

export const corpusSlug = 'corpus-sessions';

export interface Label {
  file: string;
  expected_flagged: boolean;
  expected_top_signals: string[];
}

export const corpusSessions: SessionSpec[] = [
  // 1. clean-quick — NOT flagged. 1 read + 1 edit (5 lines). No signals trip.
  {
    name: 'clean-quick',
    events: [
      { kind: 'user_text', text: 'read and update the main file' },
      { kind: 'read', file: 'src/app/main.ts' },
      { kind: 'edit', file: 'src/app/main.ts', newString: 'a\nb\nc\nd\ne' },
    ],
  },

  // 2. clean-build — NOT flagged. 1 read + 1 edit (10 lines) + passing test.
  {
    name: 'clean-build',
    events: [
      { kind: 'user_text', text: 'update util and run tests' },
      { kind: 'read', file: 'src/app/util.ts' },
      {
        kind: 'edit',
        file: 'src/app/util.ts',
        newString: 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj',
      },
      { kind: 'exec', cmd: 'npm test', ok: true },
    ],
  },

  // 3. heavy-exploration — flagged [explore_ratio, reread].
  // 5 files × 5 reads = 25 reads + 1 edit (1 line). explore_ratio=25, reread=5.
  {
    name: 'heavy-exploration',
    events: [
      ...readsMulti(
        ['src/billing/f0.ts', 'src/billing/f1.ts', 'src/billing/f2.ts', 'src/billing/f3.ts', 'src/billing/f4.ts'],
        5,
      ),
      { kind: 'edit', file: 'src/billing/f0.ts', newString: 'y' },
    ],
  },

  // 4. reread-heavy — flagged [reread, corrections].
  // 5 files × 5 reads = 25 reads + 1 edit (5 lines) + 2 corrections.
  // explore_ratio=25/5=5 (no trip), reread=5 (trip), corrections=2 (trip).
  {
    name: 'reread-heavy',
    stepMs: 1000,
    events: [
      ...readsMulti(
        ['src/config/f0.ts', 'src/config/f1.ts', 'src/config/f2.ts', 'src/config/f3.ts', 'src/config/f4.ts'],
        5,
      ),
      { kind: 'edit', file: 'src/config/f0.ts', newString: 'a\nb\nc\nd\ne' },
      { kind: 'user_text', text: 'no, that is wrong' },
      { kind: 'edit', file: 'src/config/f0.ts', newString: 'a\nb\nc\nd\nf' },
      { kind: 'user_text', text: 'wait, actually revert' },
      { kind: 'edit', file: 'src/config/f0.ts', newString: 'a\nb\nc\nd\ne' },
    ],
  },

  // 5. oscillation — flagged [corrections, wall_clock_per_line] (* signal bug).
  // edit→test-fail→edit→test-fail→edit→test-pass. 3 edits (1 line each).
  // stepMs=130000 → wall_clock=1690000/3≈563333 (trip). corrections=2 (late, trip).
  {
    name: 'oscillation',
    stepMs: 130000,
    events: [
      { kind: 'edit', file: 'src/auth/a.ts', newString: 'y' },
      { kind: 'exec', cmd: 'npm test', ok: false },
      { kind: 'user_text', text: 'no, try again' },
      { kind: 'edit', file: 'src/auth/a.ts', newString: 'z' },
      { kind: 'exec', cmd: 'npm test', ok: false },
      { kind: 'user_text', text: 'wait, different approach' },
      { kind: 'edit', file: 'src/auth/a.ts', newString: 'w' },
      { kind: 'exec', cmd: 'npm test', ok: true },
    ],
  },

  // 6. failure-streak — flagged [corrections, wall_clock_per_line] (* signal bug).
  // 3 consecutive exec fails + 1 pass. 1 edit (1 line).
  // stepMs=130000 → wall_clock=1430000/1=1430000 (trip). corrections=2 (late, trip).
  {
    name: 'failure-streak',
    stepMs: 130000,
    events: [
      { kind: 'edit', file: 'src/payments/a.ts', newString: 'y' },
      { kind: 'exec', cmd: 'npm test', ok: false },
      { kind: 'user_text', text: 'wait, what went wrong' },
      { kind: 'exec', cmd: 'npm test', ok: false },
      { kind: 'user_text', text: 'no, stop' },
      { kind: 'exec', cmd: 'npm test', ok: false },
      { kind: 'exec', cmd: 'npm test', ok: true },
    ],
  },

  // 7. abandonment — flagged [explore_ratio, abandonment].
  // 1 edit (1 line) + 25 reads of DIFFERENT files (reread=0 so abandonment
  // makes the top-3 signals). Tail is explore-heavy, 0 edits → abandonment.
  // explore_ratio=25/1=25 (trip), abandonment=true (trip, not suppressed: has edit).
  {
    name: 'abandonment',
    events: [
      { kind: 'edit', file: 'src/api/a.ts', newString: 'y' },
      ...readsMulti(
        Array.from({ length: 25 }, (_, i) => `src/api/r${i}.ts`),
        1,
      ),
    ],
  },

  // 8. abandonment-suppressed — NOT flagged. Research session: 0 edits, 0 exec.
  // 8 reads (different files) + 2 searches. Abandonment suppressed (no edit/exec).
  {
    name: 'abandonment-suppressed',
    events: [
      { kind: 'read', file: 'src/research/a.ts' },
      { kind: 'read', file: 'src/research/b.ts' },
      { kind: 'read', file: 'src/research/c.ts' },
      { kind: 'read', file: 'src/research/d.ts' },
      { kind: 'search', pattern: 'interface' },
      { kind: 'read', file: 'src/research/e.ts' },
      { kind: 'read', file: 'src/research/f.ts' },
      { kind: 'search', pattern: 'export' },
      { kind: 'read', file: 'src/research/g.ts' },
      { kind: 'read', file: 'src/research/h.ts' },
    ],
  },

  // 9. tdd-red-green — NOT flagged. edit→test(fail)→test(pass). NO second edit.
  // oscillation=0 (no second edit; also signal bug). No other signals trip.
  {
    name: 'tdd-red-green',
    events: [
      { kind: 'user_text', text: 'write the test first' },
      { kind: 'edit', file: 'src/tdd/a.ts', newString: 'y' },
      { kind: 'exec', cmd: 'npm test', ok: false },
      { kind: 'exec', cmd: 'npm test', ok: true },
    ],
  },

  // 10. corrections-heavy — flagged [corrections, wall_clock_per_line].
  // 10 reads + 3 edits (1 line each) + 2 corrections. stepMs=130000.
  // corrections=2 (trip), wall_clock≈563333 (trip).
  {
    name: 'corrections-heavy',
    stepMs: 130000,
    events: [
      ...reads(10, 'src/util/a.ts'),
      { kind: 'edit', file: 'src/util/a.ts', newString: 'y' },
      { kind: 'user_text', text: 'no, wrong approach' },
      { kind: 'edit', file: 'src/util/a.ts', newString: 'z' },
      { kind: 'user_text', text: 'wait, try differently' },
      { kind: 'edit', file: 'src/util/a.ts', newString: 'w' },
    ],
  },

  // 11. slow-wall-clock — flagged [explore_ratio, wall_clock_per_line].
  // 10 reads + 1 edit (1 line). stepMs=60000 → wall_clock=1260000 (trip).
  // explore_ratio=10/1=10 (trip).
  {
    name: 'slow-wall-clock',
    stepMs: 60000,
    events: [
      ...reads(10, 'src/db/a.ts'),
      { kind: 'edit', file: 'src/db/a.ts', newString: 'y' },
    ],
  },

  // 12. clean-quick-2 — NOT flagged. 2 reads + 2 edits (10 lines each).
  {
    name: 'clean-quick-2',
    events: [
      { kind: 'user_text', text: 'update config and helpers' },
      { kind: 'read', file: 'src/app/config.ts' },
      { kind: 'read', file: 'src/app/helpers.ts' },
      {
        kind: 'edit',
        file: 'src/app/config.ts',
        newString: 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj',
      },
      {
        kind: 'edit',
        file: 'src/app/helpers.ts',
        newString: 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj',
      },
    ],
  },
];

export const corpusLabels: Label[] = [
  { file: 'clean-quick', expected_flagged: false, expected_top_signals: [] },
  { file: 'clean-build', expected_flagged: false, expected_top_signals: [] },
  { file: 'heavy-exploration', expected_flagged: true, expected_top_signals: ['explore_ratio', 'reread'] },
  { file: 'reread-heavy', expected_flagged: true, expected_top_signals: ['reread', 'corrections'] },
  { file: 'oscillation', expected_flagged: true, expected_top_signals: ['corrections', 'wall_clock_per_line'] },
  { file: 'failure-streak', expected_flagged: true, expected_top_signals: ['corrections', 'wall_clock_per_line'] },
  { file: 'abandonment', expected_flagged: true, expected_top_signals: ['explore_ratio', 'abandonment'] },
  { file: 'abandonment-suppressed', expected_flagged: false, expected_top_signals: [] },
  { file: 'tdd-red-green', expected_flagged: false, expected_top_signals: [] },
  { file: 'corrections-heavy', expected_flagged: true, expected_top_signals: ['corrections', 'wall_clock_per_line'] },
  { file: 'slow-wall-clock', expected_flagged: true, expected_top_signals: ['explore_ratio', 'wall_clock_per_line'] },
  { file: 'clean-quick-2', expected_flagged: false, expected_top_signals: [] },
];
