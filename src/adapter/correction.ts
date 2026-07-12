// Content-based correction detector — a heuristic priors catalog that
// classifies whether a user message is a course-correction of the preceding
// tool call. Pure function: reads userText internally, emits ONLY
// {matched, shape}. Never returns the raw text. Spec §12.5 open question
// (whether interrupts are recorded in transcripts); this is the
// content-based fallback.

import type { Correction, ToolKind } from '../types.js';

// Negation tokens are start-anchored: checked against the start of the trimmed
// lowercased message, with a word boundary so "no" does not match "note".
const NEGATION_TOKENS = [
  'no',
  'no,',
  "don't",
  'do not',
  'stop',
  'wait',
  'hold on',
  "that's wrong",
  'not that',
];

// undo / redirect / retry-different use substring includes (case-insensitive).
const UNDO_TOKENS = ['undo', 'revert', 'roll back', 'put it back'];
const REDIRECT_TOKENS = ['instead', 'actually', 'rather', 'try the other'];
const RETRY_DIFFERENT_TOKENS = ['try again', 'differently', 'another approach'];

const NOT_MATCHED: Correction = { matched: false, shape: null };

function isLetter(code: number): boolean {
  return code >= 97 && code <= 122; // a-z (text is already lowercased)
}

/**
 * Test whether `text` starts with `token` followed by a word boundary
 * (non-letter or end-of-string). Prevents "no" from matching "note".
 */
function startsWithToken(text: string, token: string): boolean {
  if (!text.startsWith(token)) return false;
  if (text.length === token.length) return true;
  return !isLetter(text.charCodeAt(token.length));
}

/**
 * Detect whether a user message is a course-correction of the immediately
 * preceding tool call. Returns `{matched, shape}` — never the raw text.
 *
 * Shape catalog (first match wins): negation → undo → redirect → retry-different.
 * Negation is start-anchored (with a word boundary); the other three use
 * substring `includes`. Messages shorter than 3 chars are not matched.
 * `prevToolCall` is part of the interface contract but not used by this
 * content-based heuristic.
 */
export function detectCorrection(
  prevToolCall: { tool: ToolKind } | null,
  userText: string,
): Correction {
  void prevToolCall; // interface contract; not used by this heuristic
  const text = userText.trim().toLowerCase();
  if (text.length < 3) return NOT_MATCHED;

  if (NEGATION_TOKENS.some((t) => startsWithToken(text, t))) {
    return { matched: true, shape: 'negation' };
  }
  if (UNDO_TOKENS.some((t) => text.includes(t))) {
    return { matched: true, shape: 'undo' };
  }
  if (REDIRECT_TOKENS.some((t) => text.includes(t))) {
    return { matched: true, shape: 'redirect' };
  }
  if (RETRY_DIFFERENT_TOKENS.some((t) => text.includes(t))) {
    return { matched: true, shape: 'retry-different' };
  }
  return NOT_MATCHED;
}
