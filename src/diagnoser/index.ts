// Diagnoser orchestration (Slice 4, Task 8). Thin coordinator that ties the
// slice together: `diagnoseUnits(records, cfg, repoRoot) → Diagnosis[]`. For
// each flagged unit it gathers repo context (Task 6) and classifies the cause
// (Task 7). The only logic here is the fail-open boundary — a thrown
// context/classify step degrades that one unit to `unclassified` and the batch
// continues; a thrown buildProfiles (or any other top-level throw) degrades
// the whole batch to `[]`. Never throws.
//
// Pipeline:
//   buildProfiles(records, cfg)              // Task 5: groups flagged records
//                                            //   per area, derives medians
//                                            //   + elevation + evidence.
//     → for each UnitProfile:
//         gatherRepoContext(key, repoRoot,   // Task 6: probes docsDirs for an
//                           cfg.docs_dirs)   //   existing doc (fail-open).
//           → classify(profile, ctx, cfg)    // Task 7: picks the cause.
//     → collect Diagnosis[], sorted by key ascending.
//
// Fail-open boundary (two layers):
//   - OUTER (batch-level): wraps `buildProfiles` + the per-unit loop. On any
//     throw, the whole batch degrades to `[]`. On detector-produced
//     `StruggleRecord[]` buildProfiles can't throw, but runScan calls this
//     unguarded, so the outer guard makes the "never throws / never aborts the
//     scan" contract hold unconditionally — a future change to buildProfiles
//     (or a new caller passing pathological input) cannot take the scan down.
//   - INNER (per-unit): wraps gatherRepoContext + classify. On any throw the
//     unit becomes a derived-only `unclassified` Diagnosis (no prose, no
//     evidence — just "diagnosis unavailable") and the batch continues.
//
// Determinism: output is sorted by `profile.key` ascending (matches
// buildProfiles' own sort; we re-sort defensively in case the fail-open
// substitution ever reorders).
//
// No new I/O, no new deps, no network. The only I/O is inside gatherRepoContext.

import type { Config, Diagnosis, StruggleRecord } from '../types.js';
import { buildProfiles, type UnitProfile } from './profile.js';
import { gatherRepoContext } from './repo-context.js';
import { classify } from './classify.js';

/**
 * Explain every flagged area in `records`. One `Diagnosis` per area touched by
 * at least one flagged record; unflagged records contribute nothing (they have
 * no struggle to explain — buildProfiles skips them at the source).
 *
 * Per unit: gather repo doc-existence context, then classify the cause. Both
 * steps are wrapped in a per-unit try/catch — a thrown step degrades that unit
 * to `{ cause: 'unclassified', confidence: 0, rationale: 'diagnosis
 * unavailable', evidence_refs: [] }` and processing continues. The whole
 * batch (buildProfiles + the per-unit loop) is wrapped in an OUTER try/catch
 * that returns `[]` on any other throw, so the function itself NEVER throws —
 * the `runScan` call site is unguarded and relies on that contract.
 *
 * Output is sorted by `unit.key` ascending for deterministic downstream
 * consumption (stable diffs, stable CLI output).
 *
 * Empty flagged set → `[]`.
 */
export function diagnoseUnits(
  records: StruggleRecord[],
  cfg: Config,
  repoRoot: string,
): Diagnosis[] {
  try {
    // buildProfiles internally skips unflagged records, so the flagged-only
    // contract holds without a redundant filter pass here.
    const profiles = buildProfiles(records, cfg);

    const out: Diagnosis[] = [];
    for (const profile of profiles) {
      out.push(diagnoseOne(profile, cfg, repoRoot));
    }

    // Defensive final sort by key ascending. buildProfiles already emits in
    // this order, but the fail-open substitution below is a per-unit concern
    // and the sort guarantee belongs to this orchestration layer, not its
    // callers.
    out.sort((a, b) => (a.unit.key < b.unit.key ? -1 : a.unit.key > b.unit.key ? 1 : 0));
    return out;
  } catch {
    // Outer fail-open: never abort the scan. buildProfiles can't throw on
    // detector-produced records, but this guard makes the "never throws"
    // contract unconditional — a future regression or pathological input
    // degrades to `[]` (no diagnoses) instead of propagating to runScan.
    return [];
  }
}

/**
 * Diagnose one unit with fail-open. Any throw from gatherRepoContext or
 * classify becomes a derived-only `unclassified` Diagnosis — never propagates.
 * Kept as a private helper so the per-unit boundary is one named thing, not an
 * inline try/catch that could be missed in future edits.
 */
function diagnoseOne(
  profile: UnitProfile,
  cfg: Config,
  repoRoot: string,
): Diagnosis {
  try {
    const ctx = gatherRepoContext(profile.key, repoRoot, cfg.docs_dirs);
    return classify(profile, ctx, cfg);
  } catch {
    // Fail-open: never abort the batch. The unit still appears in the output
    // with a derived-only, prose-free fallback. `evidence_refs` is empty
    // because we cannot cite anything we trust after a throw.
    return {
      unit: { kind: 'area', key: profile.key },
      cause: 'unclassified',
      confidence: 0,
      rationale: 'diagnosis unavailable',
      evidence_refs: [],
    };
  }
}
