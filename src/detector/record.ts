// Pure struggle-record projection. Assembles a StruggleRecord from its inputs
// without transformation: `signals` stored as-is (raw, including nulls/booleans);
// envelope fields copied verbatim; score fields projected (composite dropped —
// not on StruggleRecord). No I/O, no mutation of inputs.

import type {
  DocInjection,
  DocRead,
  NormalizedEnvelope,
  NormalizedEvent,
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
 * Collect the distinct `{ path, t }` for read-events whose file path lives
 * under any `docs_dirs` entry. Pure over the event stream + the dir list.
 *
 * - "Read-event" = `kind === 'tool_call' && tool === 'read'` with a non-empty
 *   `input_digest.files`. Each file is inspected independently (a multi-file
 *   read contributes one candidate per file under a docs dir).
 * - "Under a docs_dir" = path-prefix match on `dir + '/'`. A file equal to the
 *   dir name itself (a directory, not a file) is intentionally NOT matched;
 *   a sibling like `documentation/foo.md` is not under `docs/` either. Empty
 *   `docs_dirs` entries are skipped (no file matches the empty prefix).
 * - Dedupe by `path` keeping the EARLIEST `t`. Events are typically already
 *   chronological, but the min-comparison is robust to out-of-order timestamps
 *   (e.g. a clock-skewed transcript) so the contract holds regardless of input
 *   order. Output is in first-seen (insertion) order — the natural read order.
 * - `t` is copied verbatim from the winning event's `t` (already ISO8601 in
 *   the normalized stream).
 *
 * This is the doc-read half of the closed-loop MVP's always-on rollup. The
 * doc-injection half (`docs_injected`) is reserved for routing (a later task)
 * and the detector emits `[]` for it on every record today.
 */
export function collectDocsRead(
  events: NormalizedEvent[],
  docsDirs: string[],
): DocRead[] {
  if (docsDirs.length === 0) return [];
  // Precompute the `dir + '/'` prefixes once; skip empty dir entries (an
  // empty prefix would match every file, which is not the intent).
  const prefixes = docsDirs.filter((d) => d !== '').map((d) => (d.endsWith('/') ? d : d + '/'));
  if (prefixes.length === 0) return [];

  // Map preserves first-seen (insertion) order; value is the earliest t seen.
  const earliest = new Map<string, string>();
  for (const ev of events) {
    if (ev.kind !== 'tool_call' || ev.tool !== 'read') continue;
    if (ev.input_digest.files.length === 0) continue;
    for (const file of ev.input_digest.files) {
      if (file === '') continue;
      let under = false;
      for (const prefix of prefixes) {
        if (file.startsWith(prefix)) {
          under = true;
          break;
        }
      }
      if (!under) continue;
      const prev = earliest.get(file);
      if (prev === undefined || ev.t < prev) earliest.set(file, ev.t);
    }
  }

  return Array.from(earliest, ([path, t]) => ({ path, t }));
}

/**
 * Assemble a `StruggleRecord` by pure projection.
 *
 * - `signals`: raw `SignalValues` as-is (including nulls/booleans/raw counts).
 * - `score_pct`/`mode`/`flagged`: from `score` (composite is NOT stored).
 * - `truncated`/`event_count`/`started_at`/`duration_ms`/`session_id`/`repo`:
 *   from `envelope`.
 * - `areas`: from the `areas` arg.
 * - `docs_read`/`docs_injected` (closed-loop MVP, always-on): the doc-read /
 *   doc-injection rollups observed in this session. Both required — the
 *   detector computes `docs_read` from the envelope's read-events (see {@link
 *   collectDocsRead}) and passes `docs_injected: []` (reserved for routing,
 *   deferred to a later task). Empty arrays are honest "none observed" values
 *   so the synthesizer/fact-check stages can rely on the fields being present
 *   without a sentinel.
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
  docs_read: DocRead[],
  docs_injected: DocInjection[],
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
      docs_read,
      docs_injected,
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
    docs_read,
    docs_injected,
  };
}
