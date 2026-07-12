// Detector orchestration: ties signals + scoring + areas together into one
// StruggleRecord per envelope. Pure: no I/O, no mutation of inputs.
//
// Orchestration order matters: percentile scoring needs the FULL signals set,
// so signals are computed for every envelope first, then `scoreSessions` is
// called ONCE with the whole array, then per-envelope areas + assembly run.

import type { Config, NormalizedEnvelope, StruggleRecord } from '../types.js';
import { computeSignals } from './signals.js';
import { scoreSessions } from './scoring.js';
import { localizeAreas } from './areas.js';
import { assembleStruggleRecord } from './record.js';

/**
 * Run the full detector pipeline over a batch of envelopes.
 *
 * 1. Compute signals per envelope (collect the full `SignalValues[]`).
 * 2. Call `scoreSessions` ONCE with the full array (percentile needs the whole
 *    set to rank sessions against each other).
 * 3. Per envelope: compute areas and assemble the `StruggleRecord`.
 *
 * Returns records in envelope order. The chosen `mode` is consistent across all
 * records (`scoreSessions` picks one mode for the whole set); read it from any
 * record's `mode` field. Empty envelopes → `[]` (no throw).
 */
export function runDetector(
  envelopes: NormalizedEnvelope[],
  cfg: Config,
  forceBootstrap: boolean,
): StruggleRecord[] {
  const signals = envelopes.map((e) => computeSignals(e.events, cfg));
  const scores = scoreSessions({ signals, cfg, forceBootstrap });

  return envelopes.map((env, i) => {
    const areas = localizeAreas(env.events, cfg);
    return assembleStruggleRecord(env, signals[i], scores[i], areas);
  });
}
