// Pure evidence projection for the Diagnoser (Slice 4, Task 3). Buckets a
// normalized event stream into the closed catalogs Task 4 / cause rules read:
//   - failed-exec counts by cmd-class (`failures`)
//   - edited-file counts by file-class (`edit_kinds`)
// Single pass, no I/O, no mutation of inputs. All seven buckets are zero-filled
// so downstream rules can rely on the full shape regardless of session content.

import type { NormalizedEvent, SessionEvidence } from '../types.js';
import { classifyCmd, classifyFile } from './classify-util.js';

/**
 * Compute `SessionEvidence` for one normalized event stream.
 *
 * Bucketing rules (brief, verbatim):
 *   - a `tool_call` with `tool === 'exec' && ok === false` →
 *     `failures[classifyCmd(cmd, testCmdPatterns)]++` (skipped when `cmd`
 *     is `null` — we cannot bucket a missing cmd).
 *   - a `tool_call` with `tool === 'edit'` → for each file in
 *     `input_digest.files`, `edit_kinds[classifyFile(file)]++`.
 *   - all other events contribute nothing.
 *
 * `testCmdPatterns` is forwarded unchanged from `cfg.areas.test_cmd_patterns`.
 * Returns integer bucket counts with every bucket present (zero-filled).
 */
export function computeEvidence(
  events: NormalizedEvent[],
  testCmdPatterns: string[],
): SessionEvidence {
  const failures = { config: 0, test: 0, build: 0, other: 0 };
  const edit_kinds = { test: 0, code: 0, other: 0 };

  for (const e of events) {
    if (e.kind !== 'tool_call' || e.tool === null) continue;

    if (e.tool === 'exec' && e.ok === false) {
      const cmd = e.input_digest.cmd;
      if (cmd === null) continue; // unbucketable — skip per spec
      failures[classifyCmd(cmd, testCmdPatterns)] += 1;
    } else if (e.tool === 'edit') {
      for (const f of e.input_digest.files) {
        edit_kinds[classifyFile(f)] += 1;
      }
    }
  }

  return { failures, edit_kinds };
}
