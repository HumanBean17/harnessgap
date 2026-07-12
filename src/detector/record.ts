// Pure struggle-record projection. Assembles a StruggleRecord from its inputs
// without transformation: `signals` stored as-is (raw, including nulls/booleans);
// envelope fields copied verbatim; score fields projected (composite dropped —
// not on StruggleRecord). No I/O, no mutation of inputs.

import type {
  NormalizedEnvelope,
  ScoringMode,
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
 */
export function assembleStruggleRecord(
  envelope: NormalizedEnvelope,
  signals: SignalValues,
  score: SessionScore,
  areas: Area[],
): StruggleRecord {
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
