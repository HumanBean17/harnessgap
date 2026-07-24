// Proposal schema validator (Synthesizer, Task 6). The Synthesizer (Task 10)
// feeds a backend's parsed JSON through `assertNewDocProposal` BEFORE
// fact-checking, so a malformed backend response never reaches the review
// stage — it fails fast with a message naming the first wrong field.
//
// Style mirrors `src/diagnoser/classify-util.ts`: pure functions, no I/O, no
// mutation. Field order and rules are pinned to the Task 6 brief verbatim.

import type { Cause, Proposal } from '../types.js';

// Re-export so callers can import the validated types alongside the validator.
export type { Cause, Proposal };

/**
 * The closed {@link Cause} taxonomy (§6). A `frontmatter.cause` value is valid
 * iff it is a member of this set. Kept literal (not derived from the type) so
 * a runtime check can run against parsed JSON.
 */
const CAUSE_VALUES: ReadonlySet<Cause> = new Set<Cause>([
  'doc',
  'config-doc',
  'test-gap',
  'refactor-flag',
  'inherent-complexity',
  'unclassified',
]);

/** True iff `v` is a non-null, non-array object (a "record"). */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** True iff `v` is an array whose every element is a string. */
function isStringArray(v: unknown): boolean {
  return Array.isArray(v) && v.every((el) => typeof el === 'string');
}

/**
 * Validate a parsed object is a well-formed new-doc proposal, else throw an
 * `Error` whose message names the first missing/wrong field. On success the
 * value is returned narrowed to {@link Proposal}.
 *
 * Rules (brief, verbatim order): `kind === 'new-doc'`; `path` non-empty string;
 * `frontmatter.derived_from` string array; `frontmatter.unit.key` non-empty
 * string; `frontmatter.struggle_score` number; `frontmatter.cause` is a
 * {@link Cause}; `frontmatter.source_files` string array;
 * `frontmatter.created` non-empty string; `body` non-empty string;
 * `cited_symbols` string array; `referenced_paths` string array; `dedupe`
 * object with `decision_rationale` string (`nearest_existing` string|null,
 * `similarity` optional number); `verification` object with the three booleans.
 */
export function assertNewDocProposal(obj: unknown): Proposal {
  if (!isObject(obj)) {
    throw new Error('proposal must be a non-null object');
  }
  if (obj.kind !== 'new-doc') {
    throw new Error(
      `proposal.kind must be 'new-doc' (got ${JSON.stringify(obj.kind)})`,
    );
  }
  if (typeof obj.path !== 'string' || obj.path === '') {
    throw new Error('proposal.path must be a non-empty string');
  }
  const fm = obj.frontmatter;
  if (!isObject(fm)) {
    throw new Error('proposal.frontmatter must be a non-null object');
  }
  if (!isStringArray(fm.derived_from)) {
    throw new Error('proposal.frontmatter.derived_from must be a string array');
  }
  const unit = fm.unit;
  if (
    !isObject(unit) ||
    typeof unit.key !== 'string' ||
    unit.key === ''
  ) {
    throw new Error(
      'proposal.frontmatter.unit.key must be a non-empty string',
    );
  }
  if (typeof fm.struggle_score !== 'number') {
    throw new Error('proposal.frontmatter.struggle_score must be a number');
  }
  if (typeof fm.cause !== 'string' || !CAUSE_VALUES.has(fm.cause as Cause)) {
    throw new Error(
      `proposal.frontmatter.cause must be a Cause (got ${JSON.stringify(fm.cause)})`,
    );
  }
  if (!isStringArray(fm.source_files)) {
    throw new Error('proposal.frontmatter.source_files must be a string array');
  }
  if (typeof fm.created !== 'string' || fm.created === '') {
    throw new Error('proposal.frontmatter.created must be a non-empty string');
  }
  if (typeof obj.body !== 'string' || obj.body === '') {
    throw new Error('proposal.body must be a non-empty string');
  }
  if (!isStringArray(obj.cited_symbols)) {
    throw new Error('proposal.cited_symbols must be a string array');
  }
  if (!isStringArray(obj.referenced_paths)) {
    throw new Error('proposal.referenced_paths must be a string array');
  }
  const dedupe = obj.dedupe;
  if (!isObject(dedupe)) {
    throw new Error('proposal.dedupe must be a non-null object');
  }
  if (
    dedupe.nearest_existing !== null &&
    typeof dedupe.nearest_existing !== 'string'
  ) {
    throw new Error(
      'proposal.dedupe.nearest_existing must be a string or null',
    );
  }
  if (
    dedupe.similarity !== undefined &&
    typeof dedupe.similarity !== 'number'
  ) {
    throw new Error('proposal.dedupe.similarity must be a number when present');
  }
  if (typeof dedupe.decision_rationale !== 'string') {
    throw new Error('proposal.dedupe.decision_rationale must be a string');
  }
  const verification = obj.verification;
  if (!isObject(verification)) {
    throw new Error('proposal.verification must be a non-null object');
  }
  if (typeof verification.cited_symbols_resolved !== 'boolean') {
    throw new Error(
      'proposal.verification.cited_symbols_resolved must be a boolean',
    );
  }
  if (typeof verification.paths_resolved !== 'boolean') {
    throw new Error('proposal.verification.paths_resolved must be a boolean');
  }
  if (typeof verification.shas_valid !== 'boolean') {
    throw new Error('proposal.verification.shas_valid must be a boolean');
  }
  return obj as unknown as Proposal;
}

/**
 * True iff `obj` is an edit-proposal. The v1 closed loop only produces
 * new-doc proposals, so the orchestrator uses this to route an edit-proposal
 * to a "needs human" note rather than the new-doc pipeline.
 */
export function isEditProposal(obj: unknown): boolean {
  return isObject(obj) && obj.kind === 'edit-proposal';
}
