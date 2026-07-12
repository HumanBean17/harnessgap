// Pure JSON envelope assembler. Turns the detector + aggregator outputs into
// the `JsonOutput` shape consumed by the `--json` CLI flag. No I/O, no
// transformation beyond direct field projection: sessions and areas are passed
// through as-is (already scrubbed of prose upstream), warnings are integer
// counts. schema_version is pinned to 1.

import type {
  AreaRow,
  JsonOutput,
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
}

/**
 * Assemble the `JsonOutput` envelope. Pure: returns a new object whose fields
 * are the inputs plus `schema_version: 1`. Does not clone `sessions`/`areas`
 * (callers may share references; the envelope is read-only by contract).
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
  };
}
