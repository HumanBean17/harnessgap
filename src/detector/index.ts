// Detector orchestration: ties signals + scoring + areas + ambient baseline
// assessment together. Pure: no I/O, no mutation of inputs.
//
// Orchestration order matters: percentile scoring needs the FULL signals set,
// so signals are computed for every envelope first, then `scoreSessions` is
// called ONCE with the whole array, then per-envelope areas + assembly run,
// and finally the ambient baseline is assessed once over the whole batch.

import type {
  BaselineAssessment,
  Config,
  NormalizedEnvelope,
  RepoFinding,
  StruggleRecord,
} from '../types.js';
import { computeSignals } from './signals.js';
import { scoreSessions } from './scoring.js';
import { localizeAreas } from './areas.js';
import { assembleStruggleRecord } from './record.js';
import { computePreEditOrientation } from './orientation.js';
import { assessAmbient } from './ambient.js';
import type { AmbientSession } from './ambient.js';
import { computeEvidence } from '../diagnoser/evidence.js';

/**
 * Run the full detector pipeline over a batch of envelopes.
 *
 * 1. Compute signals per envelope (collect the full `SignalValues[]`).
 * 2. Call `scoreSessions` ONCE with the full array (percentile needs the whole
 *    set to rank sessions against each other).
 * 3. Build the per-session `AmbientSession` view (orientation + bootstrap
 *    composite/flag) and call `assessAmbient` ONCE over the whole batch to
 *    derive the ambient `RepoFinding` (null unless state==='elevated') and
 *    the always-populated `BaselineAssessment`.
 * 4. Per envelope: compute areas and assemble the `StruggleRecord`.
 *
 * Records are returned in envelope order, byte-identical to Slice 1 (the
 * ambient pass is additive — it neither mutates records nor changes their
 * assembly). The chosen `mode` is consistent across all records
 * (`scoreSessions` picks one mode for the whole set); read it from any record's
 * `mode` field. Empty envelopes → `{ records: [], finding: null, baseline }`
 * (no throw); the baseline for n=0 is `state: 'too-few-sessions'` with
 * `scoring_mode: 'bootstrap'` (the `scores[0]?.mode ?? 'bootstrap'` fallback).
 */
export function runDetector(
  envelopes: NormalizedEnvelope[],
  cfg: Config,
  forceBootstrap: boolean,
  opts?: { collectEvidence?: boolean },
): { records: StruggleRecord[]; finding: RepoFinding | null; baseline: BaselineAssessment } {
  const collectEvidence = opts?.collectEvidence === true;
  const signals = envelopes.map((e) => computeSignals(e.events, cfg));
  const scores = scoreSessions({ signals, cfg, forceBootstrap });

  // Ambient view: zip orientation + bootstrap composite/flag per session.
  // `bootstrap_composite` is accepted-but-not-read by assessAmbient today
  // (controller resolution); populate it anyway so later consumers can use it
  // without re-running the scorer.
  const ambientSessions: AmbientSession[] = envelopes.map((env, i) => ({
    orientation: computePreEditOrientation(env.events),
    bootstrap_composite: scores[i]!.bootstrap_composite,
    bootstrap_flagged: scores[i]!.bootstrap_flagged,
  }));

  // scoringMode is consistent across the batch (scoreSessions picks one mode
  // for the whole set). Fallback to 'bootstrap' on empty input — matches the
  // n=0 branch of selectMode.
  const scoringMode = scores[0]?.mode ?? 'bootstrap';
  const { finding, baseline } = assessAmbient({
    sessions: ambientSessions,
    cfg,
    scoringMode,
  });

  const records = envelopes.map((env, i) => {
    const areas = localizeAreas(env.events, cfg);
    // Evidence is computed and threaded through ONLY when explicitly opted in.
    // Default path (no opts / collectEvidence:false) skips the call entirely
    // so `StruggleRecord.evidence` is absent — keeps scan/reflect output
    // byte-identical when --diagnose is off.
    const evidence = collectEvidence
      ? computeEvidence(env.events, cfg.areas.test_cmd_patterns)
      : undefined;
    return assembleStruggleRecord(env, signals[i]!, scores[i]!, areas, evidence);
  });

  return { records, finding, baseline };
}
