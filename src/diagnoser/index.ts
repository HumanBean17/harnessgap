// Diagnoser orchestration (Slice 4, Task 8). Thin coordinator that ties the
// slice together: `diagnoseUnits(records, cfg, repoRoot) → Diagnosis[]`. For
// each flagged unit it gathers repo context (Task 6) and classifies the cause
// (Task 7). The only logic here is the per-unit fail-open boundary — a thrown
// context/classify step degrades that one unit to `unclassified` and the batch
// continues. Never throws.
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
// Fail-open boundary: gatherRepoContext and classify are both designed to be
// unthrowing, but a future change to either could regress. The per-unit try/
// catch here is the load-bearing guarantee that one bad unit never aborts the
// batch. On any throw the unit becomes a derived-only `unclassified` Diagnosis
// (no prose, no evidence — just "diagnosis unavailable").
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
 * unavailable', evidence_refs: [] }` and processing continues. The function
 * itself never throws.
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
  // buildProfiles internally skips unflagged records, so the flagged-only
  // contract holds without a redundant filter pass here.
  const profiles = buildProfiles(records, cfg);

  const out: Diagnosis[] = [];
  for (const profile of profiles) {
    out.push(diagnoseOne(profile, cfg, repoRoot));
  }

  // Defensive final sort by key ascending. buildProfiles already emits in this
  // order, but the fail-open substitution below is a per-unit concern and the
  // sort guarantee belongs to this orchestration layer, not its callers.
  out.sort((a, b) => (a.unit.key < b.unit.key ? -1 : a.unit.key > b.unit.key ? 1 : 0));
  return out;
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
