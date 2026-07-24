import { describe, it, expect } from 'vitest';
import { assertNewDocProposal, isEditProposal } from '../src/synthesizer/proposal.js';
import type { Proposal } from '../src/types.js';

/**
 * A complete, well-formed new-doc proposal object (every field populated with a
 * valid value). Each mutation test clones this via `valid()` and pokes one
 * field so the assertion under test is isolated.
 */
function valid(): Record<string, unknown> {
  return {
    kind: 'new-doc',
    path: 'docs/architecture.md',
    frontmatter: {
      derived_from: ['session-001', 'session-002'],
      unit: { kind: 'area', key: 'src/billing' },
      struggle_score: 0.42,
      cause: 'doc',
      source_files: ['src/billing/charge.ts'],
      created: '2026-07-24T10:00:00Z',
    },
    body: '## Billing architecture\n\nExplains the charge pipeline.',
    cited_symbols: ['charge'],
    referenced_paths: ['src/billing/charge.ts'],
    dedupe: {
      nearest_existing: null,
      similarity: 0.1,
      decision_rationale: 'no near-duplicate found',
    },
    verification: {
      cited_symbols_resolved: true,
      paths_resolved: true,
      shas_valid: true,
    },
  };
}

describe('assertNewDocProposal — happy path', () => {
  it('returns a Proposal for a fully-populated new-doc object', () => {
    const obj = valid();
    const p = assertNewDocProposal(obj);
    // Typed return: the validator narrows unknown -> Proposal.
    const _static: Proposal = p;
    expect(_static).toBe(p);
    expect(p.kind).toBe('new-doc');
    expect(p.path).toBe('docs/architecture.md');
    expect(p.frontmatter.cause).toBe('doc');
    expect(p.frontmatter.unit.key).toBe('src/billing');
    expect(p.dedupe.decision_rationale).toBe('no near-duplicate found');
    expect(p.verification.shas_valid).toBe(true);
  });

  it('accepts a proposal with empty arrays for the string-array fields', () => {
    const obj = valid();
    obj.cited_symbols = [];
    obj.referenced_paths = [];
    obj.frontmatter.derived_from = [];
    obj.frontmatter.source_files = [];
    // Empty body is allowed by the type but the rule says non-empty — so set a
    // real body and only empty the arrays here.
    expect(() => assertNewDocProposal(obj)).not.toThrow();
  });

  it('accepts dedupe without optional similarity (dedupe:"none" shape)', () => {
    const obj = valid();
    delete (obj.dedupe as Record<string, unknown>).similarity;
    expect(() => assertNewDocProposal(obj)).not.toThrow();
  });

  it('accepts dedupe with nearest_existing as a string path', () => {
    const obj = valid();
    obj.dedupe = {
      nearest_existing: 'docs/existing.md',
      similarity: 0.9,
      decision_rationale: 'near-duplicate of docs/existing.md',
    };
    expect(() => assertNewDocProposal(obj)).not.toThrow();
  });
});

describe('assertNewDocProposal — kind + top-level shape', () => {
  it('throws when kind is missing', () => {
    const obj = valid();
    delete obj.kind;
    expect(() => assertNewDocProposal(obj)).toThrow(/kind/i);
  });

  it('throws when kind is "edit-proposal"', () => {
    const obj = valid();
    obj.kind = 'edit-proposal';
    expect(() => assertNewDocProposal(obj)).toThrow(/kind/i);
  });

  it('throws when input is not an object', () => {
    expect(() => assertNewDocProposal(null)).toThrow();
    expect(() => assertNewDocProposal('nope')).toThrow();
    expect(() => assertNewDocProposal(undefined)).toThrow();
  });

  it('throws when path is missing', () => {
    const obj = valid();
    delete obj.path;
    expect(() => assertNewDocProposal(obj)).toThrow(/path/i);
  });

  it('throws when path is an empty string', () => {
    const obj = valid();
    obj.path = '';
    expect(() => assertNewDocProposal(obj)).toThrow(/path/i);
  });
});

describe('assertNewDocProposal — frontmatter fields', () => {
  it('throws when frontmatter is missing', () => {
    const obj = valid();
    delete obj.frontmatter;
    expect(() => assertNewDocProposal(obj)).toThrow(/frontmatter/i);
  });

  it('throws when derived_from is missing', () => {
    const obj = valid();
    delete (obj.frontmatter as Record<string, unknown>).derived_from;
    expect(() => assertNewDocProposal(obj)).toThrow(/derived_from/i);
  });

  it('throws when derived_from contains a non-string', () => {
    const obj = valid();
    obj.frontmatter.derived_from = ['ok', 7];
    expect(() => assertNewDocProposal(obj)).toThrow(/derived_from/i);
  });

  it('throws when unit.key is missing', () => {
    const obj = valid();
    delete (obj.frontmatter as Record<string, unknown>).unit;
    expect(() => assertNewDocProposal(obj)).toThrow(/unit/i);
  });

  it('throws when unit.key is an empty string', () => {
    const obj = valid();
    obj.frontmatter.unit = { kind: 'area', key: '' };
    expect(() => assertNewDocProposal(obj)).toThrow(/unit/i);
  });

  it('throws when struggle_score is missing', () => {
    const obj = valid();
    delete (obj.frontmatter as Record<string, unknown>).struggle_score;
    expect(() => assertNewDocProposal(obj)).toThrow(/struggle_score/i);
  });

  it('throws when struggle_score is a string, not a number', () => {
    const obj = valid();
    obj.frontmatter.struggle_score = '0.42';
    expect(() => assertNewDocProposal(obj)).toThrow(/struggle_score/i);
  });

  it('throws when cause is "nonsense" (not in Cause taxonomy)', () => {
    const obj = valid();
    obj.frontmatter.cause = 'nonsense';
    expect(() => assertNewDocProposal(obj)).toThrow(/cause/i);
  });

  it('throws when cause is missing', () => {
    const obj = valid();
    delete (obj.frontmatter as Record<string, unknown>).cause;
    expect(() => assertNewDocProposal(obj)).toThrow(/cause/i);
  });

  it('accepts every member of the Cause taxonomy', () => {
    for (const cause of [
      'doc',
      'config-doc',
      'test-gap',
      'refactor-flag',
      'inherent-complexity',
      'unclassified',
    ]) {
      const obj = valid();
      obj.frontmatter.cause = cause;
      expect(() => assertNewDocProposal(obj)).not.toThrow();
    }
  });

  it('throws when source_files contains a non-string', () => {
    const obj = valid();
    obj.frontmatter.source_files = ['ok', null];
    expect(() => assertNewDocProposal(obj)).toThrow(/source_files/i);
  });

  it('throws when created is an empty string', () => {
    const obj = valid();
    obj.frontmatter.created = '';
    expect(() => assertNewDocProposal(obj)).toThrow(/created/i);
  });
});

describe('assertNewDocProposal — body + citation arrays', () => {
  it('throws when body is missing', () => {
    const obj = valid();
    delete obj.body;
    expect(() => assertNewDocProposal(obj)).toThrow(/body/i);
  });

  it('throws when body is an empty string', () => {
    const obj = valid();
    obj.body = '';
    expect(() => assertNewDocProposal(obj)).toThrow(/body/i);
  });

  it('throws when cited_symbols is missing', () => {
    const obj = valid();
    delete obj.cited_symbols;
    expect(() => assertNewDocProposal(obj)).toThrow(/cited_symbols/i);
  });

  it('throws when cited_symbols contains a non-string', () => {
    const obj = valid();
    obj.cited_symbols = ['ok', 3];
    expect(() => assertNewDocProposal(obj)).toThrow(/cited_symbols/i);
  });

  it('throws when referenced_paths contains a non-string', () => {
    const obj = valid();
    obj.referenced_paths = [true];
    expect(() => assertNewDocProposal(obj)).toThrow(/referenced_paths/i);
  });
});

describe('assertNewDocProposal — dedupe + verification', () => {
  it('throws when dedupe is missing', () => {
    const obj = valid();
    delete obj.dedupe;
    expect(() => assertNewDocProposal(obj)).toThrow(/dedupe/i);
  });

  it('throws when dedupe.decision_rationale is missing', () => {
    const obj = valid();
    delete (obj.dedupe as Record<string, unknown>).decision_rationale;
    expect(() => assertNewDocProposal(obj)).toThrow(/decision_rationale/i);
  });

  it('throws when dedupe.nearest_existing is a number (not string|null)', () => {
    const obj = valid();
    obj.dedupe.nearest_existing = 5;
    expect(() => assertNewDocProposal(obj)).toThrow(/nearest_existing/i);
  });

  it('throws when dedupe.similarity is a string (not number)', () => {
    const obj = valid();
    obj.dedupe.similarity = '0.5';
    expect(() => assertNewDocProposal(obj)).toThrow(/similarity/i);
  });

  it('accepts dedupe.nearest_existing === null', () => {
    const obj = valid();
    obj.dedupe.nearest_existing = null;
    expect(() => assertNewDocProposal(obj)).not.toThrow();
  });

  it('throws when verification is missing', () => {
    const obj = valid();
    delete obj.verification;
    expect(() => assertNewDocProposal(obj)).toThrow(/verification/i);
  });

  it('throws when verification.cited_symbols_resolved is missing', () => {
    const obj = valid();
    delete (obj.verification as Record<string, unknown>).cited_symbols_resolved;
    expect(() => assertNewDocProposal(obj)).toThrow(/cited_symbols_resolved/i);
  });

  it('throws when verification.paths_resolved is not a boolean', () => {
    const obj = valid();
    obj.verification.paths_resolved = 'yes';
    expect(() => assertNewDocProposal(obj)).toThrow(/paths_resolved/i);
  });

  it('throws when verification.shas_valid is not a boolean', () => {
    const obj = valid();
    obj.verification.shas_valid = 1;
    expect(() => assertNewDocProposal(obj)).toThrow(/shas_valid/i);
  });
});

describe('isEditProposal', () => {
  it('returns true when kind === "edit-proposal"', () => {
    expect(isEditProposal({ kind: 'edit-proposal' })).toBe(true);
  });

  it('returns false when kind === "new-doc"', () => {
    expect(isEditProposal(valid())).toBe(false);
  });

  it('returns false when kind is missing', () => {
    expect(isEditProposal({})).toBe(false);
  });

  it('returns false for non-object input', () => {
    expect(isEditProposal(null)).toBe(false);
    expect(isEditProposal('edit-proposal')).toBe(false);
    expect(isEditProposal(undefined)).toBe(false);
  });
});
