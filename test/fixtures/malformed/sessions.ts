// Malformed-transcript fixture: garbage JSON lines + raw prose in a user message.
// The adapter reads prose to derive correction flags (detectCorrection) but must
// NOT emit it into any output path. The privacy test asserts the recognizable
// prose marker is absent from all 3 output modes (human, json, calibrate) and
// from warnings.
//
// This module exports a function that returns the raw .jsonl string (not a
// SessionSpec) because the malformed fixture intentionally includes invalid
// lines that the builder cannot produce.

import type { EventSpec } from '../../helpers/builder.js';

export const malformedSlug = 'malformed-slug';

// Recognizable prose marker that must NOT appear in any output.
export const PROSE_MARKER = 'SUPERSECRETPROSEMARKER123';

// A second prose marker in a user message (not a correction token).
export const PROSE_MARKER_2 = 'ANOTHERSECRETPROSEMARKER456';

// Build the malformed .jsonl: valid records with prose + garbage lines.
// `cwd` is the temp repo path (so the session resolves to the repo).
export function malformedTranscript(cwd: string): string {
  const ts = (ms: number) => new Date(ms).toISOString();
  const lines: string[] = [];

  // Garbage line 1 (not valid JSON).
  lines.push('this is not json garbage line {{{');
  // Garbage line 2.
  lines.push('&&& not json either &&&');

  // Valid user record with prose containing the marker (NOT a correction token).
  // detectCorrection will scan this and return not-matched, but the raw text
  // must not appear in any output.
  lines.push(
    JSON.stringify({
      type: 'user',
      timestamp: ts(1000),
      cwd,
      message: { role: 'user', content: `Please help me with ${PROSE_MARKER} and also ${PROSE_MARKER_2}` },
    }),
  );

  // Valid assistant tool_use (Edit) to give the session an area + edit line.
  lines.push(
    JSON.stringify({
      type: 'assistant',
      timestamp: ts(2000),
      cwd,
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'Edit', input: { file_path: 'src/malformed/a.ts', old_string: 'x', new_string: 'y\nz' } },
        ],
      },
    }),
  );
  // Valid tool_result.
  lines.push(
    JSON.stringify({
      type: 'user',
      timestamp: ts(3000),
      cwd,
      message: { role: 'user', content: [{ type: 'tool_result', is_error: false }] },
    }),
  );

  // More garbage.
  lines.push('{"broken": json missing closing');
  lines.push('   ');

  return lines.join('\n') + '\n';
}
