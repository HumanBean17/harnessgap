// Pure struggle-record projection. Assembles a StruggleRecord from its inputs
// without transformation: `signals` stored as-is (raw, including nulls/booleans);
// envelope fields copied verbatim; score fields projected (composite dropped —
// not on StruggleRecord). No I/O, no mutation of inputs.

import type {
  NormalizedEnvelope,
  ScoringMode,
  SessionEvidence,
  SignalValues,
  StruggleRecord,
} from '../types.js';

/** Score shape produced by `scoreSessions` (composite accepted, not stored). */
interface SessionScore {
  score_pct: number;
  mode: ScoringMode;
  flagged: boolean;
  composite: number;
}

/** Area shape produced by `localizeAreas`. */
interface Area {
  key: string;
  weight: number;
}

/**
 * Assemble a `StruggleRecord` by pure projection.
 *
 * - `signals`: raw `SignalValues` as-is (including nulls/booleans/raw counts).
 * - `score_pct`/`mode`/`flagged`: from `score` (composite is NOT stored).
 * - `truncated`/`event_count`/`started_at`/`duration_ms`/`session_id`/`repo`:
 *   from `envelope`.
 * - `areas`: from the `areas` arg.
 * - `evidence` (Slice 4, opt-in): included on the returned record ONLY when
 *   defined, so the default path serializes byte-identically (no `"evidence"`
 *   key in `JSON.stringify`). The detector passes it only under
 *   `collectEvidence: true`.
 */
export function assembleStruggleRecord(
  envelope: NormalizedEnvelope,
  signals: SignalValues,
  score: SessionScore,
  areas: Area[],
  evidence?: SessionEvidence,
): StruggleRecord {
  // Conditional spread: when `evidence` is undefined, the key is not set on
  // the returned object at all (so JSON.stringify omits it). Avoid
  // `evidence: evidence ?? undefined` — that writes the key with value
  // undefined, which JSON.stringify also drops, but the explicit conditional
  // makes the byte-identical intent unambiguous and resilient to future
  // serializer changes.
  if (evidence !== undefined) {
    return {
      session_id: envelope.session_id,
      repo: envelope.repo,
      started_at: envelope.started_at,
      duration_ms: envelope.duration_ms,
      score_pct: score.score_pct,
      mode: score.mode,
      flagged: score.flagged,
      truncated: envelope.truncated,
      event_count: envelope.event_count,
      areas,
      signals,
      evidence,
    };
  }
  return {
    session_id: envelope.session_id,
    repo: envelope.repo,
    started_at: envelope.started_at,
    duration_ms: envelope.duration_ms,
    score_pct: score.score_pct,
    mode: score.mode,
    flagged: score.flagged,
    truncated: envelope.truncated,
    event_count: envelope.event_count,
    areas,
    signals,
  };
}
