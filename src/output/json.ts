// Pure JSON envelope assembler. Turns the detector + aggregator outputs into
// the `JsonOutput` shape consumed by the `--json` CLI flag. No I/O, no
// transformation beyond direct field projection: sessions and areas are passed
// through as-is (already scrubbed of prose upstream), warnings are integer
// counts. schema_version is pinned to 1.

import type {
  AreaRow,
  Diagnosis,
  JsonOutput,
  RepoFinding,
  ScoringMode,
  StruggleRecord,
  Warnings,
} from '../types.js';

/** Inputs to `buildJsonEnvelope`; all fields projected verbatim onto JsonOutput. */
interface JsonEnvelopeInput {
  repo: string;
  mode: ScoringMode;
  session_count: number;
  warnings: Warnings;
  sessions: StruggleRecord[];
  areas: AreaRow[];
  repo_findings: RepoFinding[];
  /**
   * Diagnoser output (Slice 4). When `undefined`, the `diagnoses` key is ABSENT
   * from the returned envelope (default `--json` byte-identical to Slice 3).
   * When defined (even empty), the key is present — opt-in via `--diagnose`.
   */
  diagnoses?: Diagnosis[];
}

/**
 * Assemble the `JsonOutput` envelope. Pure: returns a new object whose fields
 * are the inputs plus `schema_version: 1`. Does not clone `sessions`/`areas`
 * (callers may share references; the envelope is read-only by contract).
 *
 * `diagnoses` is spread in ONLY when defined, so the default-path envelope has
 * no `diagnoses` key at all (not just `undefined`) — byte-identical to Slice 3.
 */
export function buildJsonEnvelope(input: JsonEnvelopeInput): JsonOutput {
  return {
    schema_version: 1,
    repo: input.repo,
    mode: input.mode,
    session_count: input.session_count,
    warnings: input.warnings,
    sessions: input.sessions,
    areas: input.areas,
    repo_findings: input.repo_findings,
    ...(input.diagnoses !== undefined ? { diagnoses: input.diagnoses } : {}),
  };
}
