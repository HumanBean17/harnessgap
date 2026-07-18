// Content-based correction detector — a heuristic priors catalog that
// classifies whether a user message is a course-correction of the preceding
// tool call. Pure function: reads userText internally, emits ONLY
// {matched, shape}. Never returns the raw text. Spec §12.5 open question
// (whether interrupts are recorded in transcripts); this is the
// content-based fallback.
//
// Language catalogs are additive: adding a language = adding one entry to
// LANG_CATALOGS. The matching loop is language-agnostic (Latin and Cyrillic
// never cross-match, so per-shape token lists are merged across languages).

import type { Correction, ToolKind } from '../types.js';

type Shape = 'negation' | 'undo' | 'redirect' | 'retry-different';

interface LangCatalog {
  /** Start-anchored (word-boundary) tokens. */
  negation: readonly string[];
  /** Substring tokens. */
  undo: readonly string[];
  /** Substring tokens. */
  redirect: readonly string[];
  /** Substring tokens. */
  'retry-different': readonly string[];
}

// Per-language correction token catalogs, authored in natural lowercase form.
// Tokens are normalized at load time (see buildTokens), so ё/е and hyphens
// (по-другому) need no special authoring care. Shape precedence is fixed by
// the if-block order in detectCorrection below (negation → undo → redirect →
// retry-different), so give each token a single canonical shape home.
const LANG_CATALOGS: Readonly<Record<string, LangCatalog>> = {
  en: {
    negation: ['no', "don't", 'do not', 'stop', 'wait', 'hold on', "that's wrong", 'not that'],
    undo: ['undo', 'revert', 'roll back', 'put it back'],
    redirect: ['instead', 'actually', 'rather', 'try the other'],
    'retry-different': ['try again', 'differently', 'another approach'],
  },
  ru: {
    negation: ['нет', 'не то', 'не так', 'не туда', 'не надо', 'стоп', 'хватит', 'подожди', 'неправильно', 'неверно', 'не верно'],
    undo: ['отмена', 'верни', 'откат', 'откатить', 'вернуть назад'],
    redirect: ['вместо', 'на самом деле', 'лучше', 'по-другому', 'иначе'],
    'retry-different': ['ещё раз', 'заново', 'другой подход'],
  },
};

const SHAPES: readonly Shape[] = ['negation', 'undo', 'redirect', 'retry-different'];

const NOT_MATCHED: Correction = { matched: false, shape: null };

/**
 * Normalize input text and tokens through the same pipeline so matching is
 * script-agnostic and punctuation-neutral:
 *   - trim + lowercase
 *   - Cyrillic ё → е (so «ещё» and «еще» match)
 *   - curly/smart quotes → straight apostrophe (so “don’t” and “don't” match)
 *   - any other non-letter/non-digit/non-apostrophe → space (so «нет,» and
 *     «нет» match; hyphenated «по-другому» unifies with the two-word form)
 *   - collapse runs of whitespace
 */
function normalize(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[’‘‚′`]/g, "'")
    .replace(/[^\p{L}\p{N}']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when `ch` is a letter in any script (word-continuation). */
function isWordContinuation(ch: string): boolean {
  return /\p{L}/u.test(ch);
}

/**
 * Test whether `text` starts with `token` followed by a word boundary
 * (non-letter or end-of-string). Prevents "no" matching "note" and «нет»
 * matching «нетворк».
 */
function startsWithToken(text: string, token: string): boolean {
  if (!text.startsWith(token)) return false;
  if (text.length === token.length) return true;
  return !isWordContinuation(text.charAt(token.length));
}

// Precompute merged, normalized, de-duplicated token lists per shape across
// every language. Built once at load; detectCorrection does no allocation per
// call beyond the input normalization.
const TOKENS_BY_SHAPE: Readonly<Record<Shape, readonly string[]>> = (() => {
  const out = {} as Record<Shape, string[]>;
  for (const shape of SHAPES) {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const lang of Object.keys(LANG_CATALOGS)) {
      for (const raw of LANG_CATALOGS[lang][shape]) {
        const tok = normalize(raw);
        if (tok.length > 0 && !seen.has(tok)) {
          seen.add(tok);
          list.push(tok);
        }
      }
    }
    out[shape] = list;
  }
  return out;
})();

/**
 * Detect whether a user message is a course-correction of the immediately
 * preceding tool call. Returns `{matched, shape}` — never the raw text.
 *
 * Shape catalog (first match wins): negation → undo → redirect → retry-different.
 * Negation is start-anchored (with a word boundary); the other three use
 * substring `includes`. All four shapes scan every language's catalog. Messages
 * shorter than 3 chars (after normalization) are not matched. `prevToolCall`
 * is part of the interface contract but not used by this content-based
 * heuristic.
 */
export function detectCorrection(
  prevToolCall: { tool: ToolKind } | null,
  userText: string,
): Correction {
  void prevToolCall; // interface contract; not used by this heuristic
  const text = normalize(userText);
  if (text.length < 3) return NOT_MATCHED;

  if (TOKENS_BY_SHAPE.negation.some((t) => startsWithToken(text, t))) {
    return { matched: true, shape: 'negation' };
  }
  if (TOKENS_BY_SHAPE.undo.some((t) => text.includes(t))) {
    return { matched: true, shape: 'undo' };
  }
  if (TOKENS_BY_SHAPE.redirect.some((t) => text.includes(t))) {
    return { matched: true, shape: 'redirect' };
  }
  if (TOKENS_BY_SHAPE['retry-different'].some((t) => text.includes(t))) {
    return { matched: true, shape: 'retry-different' };
  }
  return NOT_MATCHED;
}
