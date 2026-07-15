// Pure session-end reflect builders. Turns a `StruggleRecord` into a
// `ReflectFinding` (the decision artifact) and renders the Claude Code `Stop`
// hook payload (`StopHookOutput`). No I/O, no node builtins. The `reason`
// string is a static reflection prompt concatenated with a derived-only summary
// — repo-relative area keys and signal name/value pairs. No transcript prose
// ever appears in the output.

import type {
  ReflectFinding,
  SignalValues,
  StopHookOutput,
  StruggleRecord,
} from '../types.js';

import { SIGNAL_FIELDS, SIGNAL_ORDER } from './calibrate.js';

/** Inputs to `buildReflectFinding`. */
interface ReflectFindingInput {
  record: StruggleRecord;
  zero_edit: boolean;
}

// Fixed leading sentence instructing reflection. Ends without a period so the
// derived clauses can be appended with clean punctuation.
const REFLECT_PROMPT =
  'Struggle detected this session — reflect on the friction and propose one harness change (fill the ReflectFrame; verify the target path exists)';

/**
 * Build the `ReflectFinding` from a record. Pure: derives `trip` as
 * `record.flagged && !zero_edit`, copies `session_id`/`repo`/`mode` from the
 * record, pins `schema_version: 1`, and carries the record reference through
 * as-is (not a clone).
 */
export function buildReflectFinding(input: ReflectFindingInput): ReflectFinding {
  const { record, zero_edit } = input;
  return {
    schema_version: 1,
    session_id: record.session_id,
    repo: record.repo,
    mode: record.mode,
    record,
    trip: record.flagged && !zero_edit,
    zero_edit,
  };
}

/**
 * Render the Claude Code `Stop` hook payload. Pure.
 *
 * - `stopHookActive` true -> `{}` (never re-block an already-active hook).
 * - `finding.trip` true -> `{ decision: 'block', reason }` where `reason` is the
 *   static reflection prompt plus a derived-only summary.
 * - Otherwise -> `{}` (allow the stop).
 */
export function formatStopHookOutput(
  finding: ReflectFinding,
  stopHookActive: boolean,
): StopHookOutput {
  if (stopHookActive) return {};
  if (!finding.trip) return {};
  return { decision: 'block', reason: buildReason(finding) };
}

/**
 * Compose the block `reason`. Static prompt + up to 3 highest-weight area keys
 * (quoted), then re-sorted by key for deterministic display, + active signal
 * name(value) pairs. No transcript prose — only the prompt literal, repo-relative
 * area keys, signal names, and numeric/boolean values.
 *
 * NOTE: `record.areas` arrives in key-sorted (lexicographic) order from
 * `localizeAreas` — NOT weight-desc — so "top" must be derived here by sorting
 * on `weight` before taking 3. The weight-desc sort in the aggregator path is
 * not visible to `reflect`.
 */
function buildReason(finding: ReflectFinding): string {
  const clauses: string[] = [];

  // Top 3 by weight, then re-sorted by key so the rendered clause is stable.
  const topAreas = finding.record.areas
    .slice()
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3)
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((a) => `"${a.key}"`);
  if (topAreas.length > 0) {
    clauses.push(`Friction: ${topAreas.join(', ')}`);
  }

  const active = activeSignalPairs(finding.record.signals);
  if (active.length > 0) {
    clauses.push(`signals: ${active.join(', ')}`);
  }

  const tail = clauses.join('; ');
  return tail ? `${REFLECT_PROMPT}. ${tail}.` : `${REFLECT_PROMPT}.`;
}

/**
 * Render the non-zero/non-null signals as `name(value)` pairs in canonical
 * order. `null` and numeric `0` are omitted; `abandonment` is included only
 * when `true`.
 */
function activeSignalPairs(signals: SignalValues): string[] {
  const pairs: string[] = [];
  for (const name of SIGNAL_ORDER) {
    const value = signals[SIGNAL_FIELDS[name]];
    if (isActive(value)) pairs.push(`${name}(${String(value)})`);
  }
  return pairs;
}

/** A signal counts when it is non-null and non-zero (booleans: true only). */
function isActive(value: number | boolean | null): boolean {
  if (value === null) return false;
  if (typeof value === 'boolean') return value;
  return value !== 0;
}
