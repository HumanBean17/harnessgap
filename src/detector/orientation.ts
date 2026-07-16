// Pre-edit orientation metric (Slice 2, Task 2).
//
// Pure function: no I/O, no mutation of input. Measures how much file-system
// reconnaissance the agent performed before its first edit. Low breadth AND
// low depth is the cheapest "ambient struggle" signal — the agent dived into
// an edit without scoping the surrounding code.
//
// Contract pinned to the §7 design spec; later tasks (assessAmbient, detector
// wiring) consume this verbatim.

import type { NormalizedEvent } from '../types.js';

export interface PreEditOrientation {
  /** Distinct non-empty depth-2 directory prefixes over pre-edit read files. */
  dirBreadth: number;
  /** Distinct pre-edit read files. */
  fileDepth: number;
}

/**
 * Compute the pre-edit orientation for a single normalized session.
 *
 * - `firstEditIdx` = smallest index where
 *   `events[i].kind === 'tool_call' && events[i].tool === 'edit'`.
 *   If none exists, returns `null` (zero-edit / Q&A session — metric
 *   undefined).
 * - `readFiles` = every string in `events[i].input_digest.files` for `i <
 *   firstEditIdx` where `events[i]` is a read tool_call. Duplicates collected
 *   then deduped.
 * - `fileDepth` = count of distinct strings in `readFiles`.
 * - Depth-2 prefix of a path `p`: split on `'/'`; ≥2 segments →
 *   `segments[0] + '/' + segments[1]`; exactly 1 segment → that segment;
 *   empty → no prefix (skipped). `dirBreadth` = count of distinct non-empty
 *   depth-2 prefixes over `readFiles`.
 */
export function computePreEditOrientation(
  events: NormalizedEvent[],
): PreEditOrientation | null {
  let firstEditIdx = -1;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.kind === 'tool_call' && e.tool === 'edit') {
      firstEditIdx = i;
      break;
    }
  }

  if (firstEditIdx === -1) return null;

  const readFileSet = new Set<string>();
  const prefixSet = new Set<string>();

  for (let i = 0; i < firstEditIdx; i++) {
    const e = events[i];
    if (e.kind !== 'tool_call' || e.tool !== 'read') continue;
    for (const file of e.input_digest.files) {
      readFileSet.add(file);
      const prefix = depthTwoPrefix(file);
      if (prefix !== null) prefixSet.add(prefix);
    }
  }

  return { dirBreadth: prefixSet.size, fileDepth: readFileSet.size };
}

/**
 * Depth-2 directory prefix of a path.
 * - ≥2 segments → `segments[0] + '/' + segments[1]`.
 * - exactly 1 segment → that segment.
 * - empty string → `null` (no prefix, caller skips).
 */
function depthTwoPrefix(p: string): string | null {
  if (p === '') return null;
  const segments = p.split('/');
  if (segments.length >= 2) return segments[0] + '/' + segments[1];
  return segments[0]; // exactly one segment
}
