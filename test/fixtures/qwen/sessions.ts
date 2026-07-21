// Synthetic Qwen Code fixture exercising the four high-value signal patterns
// the Qwen+GigaCode slice cares about: a reread loop, a failed-exec streak,
// oscillating edits, and a user correction. mkQwenSession (test/helpers/
// builder.ts) converts this SessionSpec to gemini-shaped JSONL that the Qwen
// parser (src/adapter/qwen/parse.ts + stream.ts) reads back into a normalized
// event stream. The session is shaped so that, under default config:
//
//   - reread            = 1  (src/billing/a.ts is read 5 times; threshold 5).
//                          Active (>=1) but does not trip the bootstrap
//                          threshold (>=5 distinct files read >=threshold).
//   - failure_streak    = 3  (the three trailing `npm test` fails run
//                          consecutively with no other event between them;
//                          threshold 3 → trips).
//   - corrections       = 2  ("no, that broke the build" after exec1; "wait,
//                          try a different approach" after exec2; both within
//                          the 120s correction window of the preceding exec;
//                          threshold 2 → trips).
//   - oscillation       = 2  (edit1 → exec-fail → edit2 completes cycle 1;
//                          exec-fail → edit3 completes cycle 2 on the same
//                          file; threshold 2 → trips).
//   - explore_ratio     ≈ 0.33 (5 reads / 15 edited lines) — does not trip.
//   - wall_clock_per_line_ms ≈ 2733 (41 records × 1000ms step / 15 lines)
//                          — does not trip (cap 300000ms).
//   - abandonment        = false (tail is exec-heavy, not explore-heavy).
//
// Three bootstrap signals trip → session flagged = true. Areas derive from the
// seeded file path src/billing/a.ts (read + edit) → area key `src/billing`.

import type { SessionSpec } from '../../helpers/builder.js';
import { reads } from '../../helpers/builder.js';

export const qwenStruggleSlug = 'qwen-struggle-slug';

export const qwenStruggleSession: SessionSpec = {
  name: 'struggle',
  // stepMs default 1000 keeps all corrections within the 120s window.
  events: [
    // Reread loop: 5 reads of the same file (reread counts files read >=5 times).
    ...reads(5, 'src/billing/a.ts'),

    // Oscillation cycle 1: edit → failing test → correction → edit same file.
    { kind: 'edit', file: 'src/billing/a.ts', newString: 'a\nb\nc\nd\ne' },
    { kind: 'exec', cmd: 'npm test', ok: false },
    { kind: 'user_text', text: 'no, that broke the build' },
    { kind: 'edit', file: 'src/billing/a.ts', newString: 'a\nb\nc\nd\nf' },

    // Oscillation cycle 2: failing test → correction → edit same file.
    { kind: 'exec', cmd: 'npm test', ok: false },
    { kind: 'user_text', text: 'wait, try a different approach' },
    { kind: 'edit', file: 'src/billing/a.ts', newString: 'a\nb\nc\nd\ng' },

    // Failure streak: 3 consecutive failed execs (no intervening events).
    { kind: 'exec', cmd: 'npm test', ok: false },
    { kind: 'exec', cmd: 'npm test', ok: false },
    { kind: 'exec', cmd: 'npm test', ok: false },
  ],
};
