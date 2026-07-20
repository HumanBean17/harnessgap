// Pure cause-classification rule engine (Slice 4, Task 7). Decides which typed
// cause from §6 best explains one unit's flagged profile, and emits a derived-
// only `Diagnosis`. No I/O, no mutation of inputs; deterministic (gates +
// fixed precedence → same inputs yield the same cause).
//
// Selection order (per the brief):
//   1. Compute the four specific-cause scores. Each cause is "eligible" only
//      when every gate condition holds; eligible causes then get a score in
//      [0,1] proportional to how many of the shared 5 signature signals
//      {explore_ratio, reread, failure_streak, corrections, oscillation} are
//      elevated. refactor-flag's score is boosted when repoContext.docExists
//      (doc existence is strong evidence for "the doc is wrong, not absent").
//   2. Pick the highest score; ties broken by fixed precedence
//      doc > config-doc > test-gap > refactor-flag.
//   3. If the winner's score >= cfg.diagnose.confidence_floor → that cause.
//      Else if elevated.wall_clock_per_line && profile.meanScore >=
//      cfg.diagnose.score_floor → inherent-complexity.
//      Else → unclassified.
//
// Privacy: `rationale` and every `evidence_refs` leaf are derived-only —
// signal medians, integer counts, ratios, doc paths. No transcript prose,
// commands, or file bodies. The Task 12 privacy test seeds a prose marker
// and asserts it is absent from every leaf, so this module must never copy a
// string from the records into rationale/evidence_refs.
//
// Style mirrors src/output/hook.ts (buildReason) and src/detector/ambient.ts
// (assessAmbient): a pure function over (inputs, cfg) → derived decision.

import type {
  Cause,
  Config,
  Diagnosis,
  EvidenceRef,
  SessionEvidence,
  SignalName,
} from '../types.js';
import type { UnitProfile } from './profile.js';
import type { RepoContext } from './repo-context.js';

/**
 * The shared 5-signal signature set used to score every specific cause. Each
 * specific cause's gate predicate requires some subset of these to be
 * elevated; once eligible, the cause's score reflects how broadly the
 * signature is expressed (a narrow gate firing on an otherwise quiet profile
 * is weaker than a broad signature fit). `abandonment` and
 * `wall_clock_per_line` are excluded — the former is a terminal indicator
 * shared across causes, the latter is the inherent-complexity residual.
 */
const SIGNATURE_SIGNALS: readonly SignalName[] = [
  'explore_ratio',
  'reread',
  'failure_streak',
  'corrections',
  'oscillation',
];

/** Fixed tie-break precedence (lower index = higher priority). */
const PRECEDENCE: readonly Cause[] = [
  'doc',
  'config-doc',
  'test-gap',
  'refactor-flag',
];

/** Score boost applied to refactor-flag when repoContext.docExists. */
const REFACTOR_DOC_BOOST = 0.2;

/**
 * The wall_clock_per_line bootstrap threshold also serves as the signal's
 * winsorization cap (issue #33), so a unit's median is always ≤ the threshold.
 * Dividing by the threshold (factor 1) maps that [0, threshold] range onto
 * inherent-complexity confidence [0, 1]: at the cap → 1.0.
 */
const EXPENSE_CONFIDENCE_CAP_FACTOR = 1;

/**
 * Pure entry point. Returns a `Diagnosis` for one unit. Selection order is
 * documented at the top of the file; the function never reads the filesystem,
 * never mutates `profile`/`repoContext`/`cfg`, and never copies record prose
 * into rationale/evidence_refs.
 */
export function classify(
  profile: UnitProfile,
  repoContext: RepoContext,
  cfg: Config,
): Diagnosis {
  const { elevated, evidence, meanScore } = profile;
  const { diagnose } = cfg;

  // --- Step 1: gate + score each specific cause.
  const scored = eligibleCauses(profile, repoContext, cfg);

  // --- Step 2: pick winner (highest score; precedence tie-break).
  let winner: { cause: Cause; score: number } | null = null;
  for (const c of scored) {
    if (
      winner === null ||
      c.score > winner.score ||
      // Strict > keeps the first-seen on equal scores. PRECEDENCE-ordered
      // iteration makes "first-seen" === precedence winner.
      (c.score === winner.score &&
        PRECEDENCE.indexOf(c.cause) < PRECEDENCE.indexOf(winner.cause))
    ) {
      winner = c;
    }
  }

  // --- Step 3: confidence floor → specific cause, else inherent-complexity,
  //     else unclassified.
  let cause: Cause;
  let confidence: number;
  if (winner !== null && winner.score >= diagnose.confidence_floor) {
    cause = winner.cause;
    confidence = winner.score;
  } else if (
    elevated.wall_clock_per_line &&
    meanScore >= diagnose.score_floor
  ) {
    cause = 'inherent-complexity';
    confidence = expenseConfidence(profile, cfg);
  } else {
    cause = 'unclassified';
    confidence = 0;
  }

  // --- Step 4: build derived-only rationale + evidence_refs.
  const evidence_refs = buildEvidenceRefs(
    cause,
    profile,
    repoContext,
  );
  const rationale = buildRationale(cause, profile, repoContext, cfg);

  return {
    unit: { kind: 'area', key: profile.key },
    cause,
    confidence,
    rationale,
    evidence_refs,
  };
}

/**
 * Compute the four specific causes' eligibility + scores. Returns only the
 * eligible ones, in PRECEDENCE order (so the winner-picking loop's
 * first-seen-on-tie is correct).
 */
function eligibleCauses(
  profile: UnitProfile,
  repoContext: RepoContext,
  cfg: Config,
): { cause: Cause; score: number }[] {
  const { elevated, evidence } = profile;
  const { diagnose } = cfg;
  const baseScore = signatureScore(elevated);

  const out: { cause: Cause; score: number }[] = [];

  // doc: explore_ratio + reread elevated AND no doc.
  if (elevated.explore_ratio && elevated.reread && !repoContext.docExists) {
    out.push({ cause: 'doc', score: baseScore });
  }

  // config-doc: failure_streak elevated AND config-share >= floor.
  const totalFailures =
    evidence.failures.config +
    evidence.failures.test +
    evidence.failures.build +
    evidence.failures.other;
  if (
    elevated.failure_streak &&
    totalFailures > 0 &&
    evidence.failures.config / totalFailures >= diagnose.config_share_floor
  ) {
    out.push({ cause: 'config-doc', score: baseScore });
  }

  // test-gap: oscillation + failure_streak elevated, test-share >= floor,
  // corrections NOT elevated.
  const totalEdits =
    evidence.edit_kinds.test +
    evidence.edit_kinds.code +
    evidence.edit_kinds.other;
  if (
    elevated.oscillation &&
    elevated.failure_streak &&
    totalEdits > 0 &&
    evidence.edit_kinds.test / totalEdits >= diagnose.test_share_floor &&
    !elevated.corrections
  ) {
    out.push({ cause: 'test-gap', score: baseScore });
  }

  // refactor-flag: oscillation + corrections elevated, code-share >= floor.
  // docExists boosts the score (cap 1.0).
  if (
    elevated.oscillation &&
    elevated.corrections &&
    totalEdits > 0 &&
    evidence.edit_kinds.code / totalEdits >= diagnose.code_share_floor
  ) {
    const score = repoContext.docExists
      ? Math.min(1, baseScore + REFACTOR_DOC_BOOST)
      : baseScore;
    out.push({ cause: 'refactor-flag', score });
  }

  return out;
}

/**
 * Fraction (in [0,1]) of the shared 5 signature signals currently elevated.
 * Always returns a multiple of 1/5 — so the minimum non-zero score is 0.2 and
 * the brief's "weak specific cause" scenario (2/5 = 0.4) is reachable.
 */
function signatureScore(elevated: Record<SignalName, boolean>): number {
  const total = SIGNATURE_SIGNALS.length;
  const up = SIGNATURE_SIGNALS.filter((s) => elevated[s]).length;
  return up / total;
}

/**
 * Confidence for the inherent-complexity cause: proportional to wall_clock
 * expense, clamped to [0,1]. Because `wall_clock_per_line_ms` is winsorized at
 * the bootstrap threshold (issue #33), a unit's median is always ≤ threshold;
 * dividing by the threshold maps that onto [0,1] — at the cap (threshold) →
 * 1.0, at 0 → 0. `wall_clock_per_line_ms` is null only when not elevated (and
 * the cause cannot fire then), so the null branch is defensive.
 */
function expenseConfidence(profile: UnitProfile, cfg: Config): number {
  const ms = profile.medians.wall_clock_per_line;
  if (typeof ms !== 'number') return 0;
  const threshold = cfg.detector.bootstrap_thresholds.wall_clock_per_line_ms;
  if (threshold <= 0) return 1;
  return Math.max(0, Math.min(1, ms / (EXPENSE_CONFIDENCE_CAP_FACTOR * threshold)));
}

/**
 * Build the derived-only evidence_refs list for a diagnosis. Always includes
 * every elevated signal (with its median value); adds doc_absent/doc_present,
 * failure_profile, edit_profile as the cause grounding requires. Every leaf
 * is a primitive, an enum, or a closed-union member — never record prose.
 */
function buildEvidenceRefs(
  cause: Cause,
  profile: UnitProfile,
  repoContext: RepoContext,
): EvidenceRef[] {
  const refs: EvidenceRef[] = [];

  // All elevated signals (numeric or boolean medians; null medians are not
  // elevated so they never reach this branch).
  for (const name of SIGNATURE_SIGNALS) {
    if (profile.elevated[name]) {
      refs.push({
        kind: 'signal',
        name,
        value: signalValue(profile.medians[name]),
      });
    }
  }
  if (
    profile.elevated.wall_clock_per_line &&
    typeof profile.medians.wall_clock_per_line === 'number'
  ) {
    refs.push({
      kind: 'signal',
      name: 'wall_clock_per_line',
      value: profile.medians.wall_clock_per_line,
    });
  }

  // Doc grounding — cited for every cause (presence/absence is always
  // relevant context, not just for doc / refactor-flag).
  if (repoContext.docExists) {
    refs.push({
      kind: 'doc_present',
      path: repoContext.matchedPath ?? '',
    });
  } else {
    refs.push({ kind: 'doc_absent', checked: repoContext.checked.slice() });
  }

  // Failure profile when the diagnosis consumes it.
  if (cause === 'config-doc' || cause === 'test-gap') {
    const f: SessionEvidence['failures'] = profile.evidence.failures;
    refs.push({
      kind: 'failure_profile',
      config: f.config,
      test: f.test,
      build: f.build,
      other: f.other,
    });
  }

  // Edit profile when the diagnosis consumes it.
  if (cause === 'test-gap' || cause === 'refactor-flag') {
    const e: SessionEvidence['edit_kinds'] = profile.evidence.edit_kinds;
    refs.push({
      kind: 'edit_profile',
      test: e.test,
      code: e.code,
      other: e.other,
    });
  }

  return refs;
}

/**
 * Render the one-line rationale from derived values only — signal medians,
 * share ratios, mean score, doc path. Never includes transcript prose,
 * commands, or file bodies. Each clause names the deciding signals/values +
 * the grounding fact.
 */
function buildRationale(
  cause: Cause,
  profile: UnitProfile,
  repoContext: RepoContext,
  cfg: Config,
): string {
  const m = profile.medians;
  const ev = profile.evidence;
  const totalFailures =
    ev.failures.config + ev.failures.test + ev.failures.build + ev.failures.other;
  const totalEdits =
    ev.edit_kinds.test + ev.edit_kinds.code + ev.edit_kinds.other;
  const checkedList = repoContext.checked.join(', ');

  switch (cause) {
    case 'doc': {
      return (
        `explore_ratio(${fmtVal(m.explore_ratio)}) + reread(${fmtVal(m.reread)}) elevated; ` +
        `no doc under ${checkedList}`
      );
    }
    case 'config-doc': {
      const share =
        totalFailures > 0 ? ev.failures.config / totalFailures : 0;
      return (
        `failure_streak(${fmtVal(m.failure_streak)}) elevated; ` +
        `config-share ${share.toFixed(2)}`
      );
    }
    case 'test-gap': {
      const share = totalEdits > 0 ? ev.edit_kinds.test / totalEdits : 0;
      return (
        `oscillation(${fmtVal(m.oscillation)}) + failure_streak(${fmtVal(m.failure_streak)}) elevated; ` +
        `test-share ${share.toFixed(2)}; corrections not elevated`
      );
    }
    case 'refactor-flag': {
      const share = totalEdits > 0 ? ev.edit_kinds.code / totalEdits : 0;
      const docClause = repoContext.docExists
        ? `doc ${repoContext.matchedPath ?? ''}`.trim()
        : `no doc under ${checkedList}`;
      return (
        `oscillation(${fmtVal(m.oscillation)}) + corrections(${fmtVal(m.corrections)}) elevated; ` +
        `code-share ${share.toFixed(2)}; ${docClause}`
      );
    }
    case 'inherent-complexity': {
      const ms = m.wall_clock_per_line;
      return (
        `wall_clock_per_line(${fmtVal(ms)}) elevated + mean_score ${profile.meanScore.toFixed(1)}; ` +
        `no specific signature`
      );
    }
    case 'unclassified': {
      // Nothing decisive — say so without inventing detail.
      const elevatedNames = SIGNATURE_SIGNALS.filter((s) => profile.elevated[s]);
      if (elevatedNames.length === 0 && !profile.elevated.wall_clock_per_line) {
        return 'no elevated signal matched a specific cause';
      }
      return `no specific cause reached confidence_floor ${cfg.diagnose.confidence_floor}`;
    }
  }
}

/** Format a median value for the rationale: numbers trimmed, booleans as-is. */
function fmtVal(v: number | boolean | null): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return String(v);
  // Numbers: trim to a sensible precision for display. The value is derived
  // (a median computed upstream), never prose.
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/** Coerce a median to the EvidenceRef `signal.value` numeric/boolean form. */
function signalValue(v: number | boolean | null): number | boolean {
  // Elevated signals cannot have null medians (upstream guarantees non-null
  // when elevated). Defensive: treat null as 0 so the union stays satisfied.
  if (v === null) return 0;
  return v;
}
