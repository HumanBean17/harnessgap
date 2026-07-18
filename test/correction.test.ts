import { describe, it, expect } from 'vitest';
import { detectCorrection } from '../src/adapter/correction.js';

describe('detectCorrection — content-based correction heuristic', () => {
  it('1. negation: "no, don\'t change that file" → negation', () => {
    expect(detectCorrection({ tool: 'edit' }, "no, don't change that file")).toEqual({
      matched: true,
      shape: 'negation',
    });
  });

  it('2. negation: "wait, stop" → negation', () => {
    expect(detectCorrection({ tool: 'exec' }, 'wait, stop')).toEqual({
      matched: true,
      shape: 'negation',
    });
  });

  it('3. undo: "undo that last change" → undo', () => {
    expect(detectCorrection({ tool: 'edit' }, 'undo that last change')).toEqual({
      matched: true,
      shape: 'undo',
    });
  });

  it('4. redirect: "actually use the other approach" → redirect', () => {
    expect(detectCorrection({ tool: 'exec' }, 'actually use the other approach')).toEqual({
      matched: true,
      shape: 'redirect',
    });
  });

  it('5. retry-different: "try again differently" → retry-different', () => {
    expect(detectCorrection({ tool: 'exec' }, 'try again differently')).toEqual({
      matched: true,
      shape: 'retry-different',
    });
  });

  it('6. genuine question: "what does this file do" → not matched', () => {
    expect(detectCorrection({ tool: 'read' }, 'what does this file do')).toEqual({
      matched: false,
      shape: null,
    });
  });

  it('7. null prevToolCall: "no stop" → negation', () => {
    expect(detectCorrection(null, 'no stop')).toEqual({
      matched: true,
      shape: 'negation',
    });
  });

  it('8. too short: "ok" → not matched', () => {
    expect(detectCorrection({ tool: 'edit' }, 'ok')).toEqual({
      matched: false,
      shape: null,
    });
  });

  it('9. ordering: "undo that, no wait" → undo (no leading negation)', () => {
    expect(detectCorrection({ tool: 'edit' }, 'undo that, no wait')).toEqual({
      matched: true,
      shape: 'undo',
    });
  });

  it('10. anti-false-positive: "no" does not match "note" / "nothing"', () => {
    expect(detectCorrection({ tool: 'edit' }, 'note that this is not a correction')).toEqual({
      matched: false,
      shape: null,
    });
    expect(detectCorrection({ tool: 'edit' }, 'nothing to see here')).toEqual({
      matched: false,
      shape: null,
    });
  });

  it('11. curly apostrophe U+2019: "no, don’t change that file" → negation', () => {
    expect(detectCorrection({ tool: 'edit' }, 'no, don’t change that file')).toEqual({
      matched: true,
      shape: 'negation',
    });
  });
});

describe('detectCorrection — Russian catalog (issue #6)', () => {
  // Negation: start-anchored, word-boundary.
  it('RU negation: «нет, не туда» → negation', () => {
    expect(detectCorrection({ tool: 'edit' }, 'нет, не туда')).toEqual({
      matched: true,
      shape: 'negation',
    });
  });

  it('RU negation: «стоп» → negation', () => {
    expect(detectCorrection({ tool: 'exec' }, 'стоп')).toEqual({
      matched: true,
      shape: 'negation',
    });
  });

  it('RU negation: «неправильно» → negation', () => {
    expect(detectCorrection({ tool: 'edit' }, 'неправильно')).toEqual({
      matched: true,
      shape: 'negation',
    });
  });

  // One-word synonym of «неправильно»; start-anchored, so it needs its own
  // token (the two-word «не верно» form does not cover it).
  it('RU negation: «неверно» (one word) → negation', () => {
    expect(detectCorrection({ tool: 'edit' }, 'неверно')).toEqual({
      matched: true,
      shape: 'negation',
    });
  });

  it('RU negation: «подожди, хватит» → negation', () => {
    expect(detectCorrection({ tool: 'exec' }, 'подожди, хватит')).toEqual({
      matched: true,
      shape: 'negation',
    });
  });

  // Undo.
  it('RU undo: «отмена, верни назад» → undo', () => {
    expect(detectCorrection({ tool: 'edit' }, 'отмена, верни назад')).toEqual({
      matched: true,
      shape: 'undo',
    });
  });

  it('RU undo: «откатить последнее изменение» → undo', () => {
    expect(detectCorrection({ tool: 'edit' }, 'откатить последнее изменение')).toEqual({
      matched: true,
      shape: 'undo',
    });
  });

  // Redirect.
  it('RU redirect: «лучше используй вместо этого» → redirect', () => {
    expect(detectCorrection({ tool: 'exec' }, 'лучше используй вместо этого')).toEqual({
      matched: true,
      shape: 'redirect',
    });
  });

  it('RU redirect: «на самом деле иначе» → redirect', () => {
    expect(detectCorrection({ tool: 'exec' }, 'на самом деле иначе')).toEqual({
      matched: true,
      shape: 'redirect',
    });
  });

  // Precedence lock: «по-другому» is home in redirect; it must resolve to
  // redirect, not retry-different.
  it('RU precedence: «по-другому» → redirect', () => {
    expect(detectCorrection({ tool: 'exec' }, 'по-другому')).toEqual({
      matched: true,
      shape: 'redirect',
    });
  });

  // Retry-different. (Use retry-only phrases; по-другому resolves to redirect.)
  it('RU retry-different: «заново, другой подход» → retry-different', () => {
    expect(detectCorrection({ tool: 'exec' }, 'заново, другой подход')).toEqual({
      matched: true,
      shape: 'retry-different',
    });
  });

  // ё→е cross-form unification: input WITHOUT ё («еще») must still match a
  // token authored WITH ё («ещё раз»). Both sides run through normalize(), so
  // the no-ё input is what actually exercises the fold.
  it('RU retry-different: ё→е fold «еще раз» (no ё) matches token «ещё раз»', () => {
    expect(detectCorrection({ tool: 'exec' }, 'еще раз попробуй')).toEqual({
      matched: true,
      shape: 'retry-different',
    });
  });

  // Affirmations must NOT match.
  // «да» is absent from every catalog (and below the 3-char floor), so it
  // cannot match — the floor is not the operative guard, catalog absence is.
  it('RU affirmation: «да» absent from catalogs → not matched', () => {
    expect(detectCorrection({ tool: 'edit' }, 'да')).toEqual({ matched: false, shape: null });
  });

  it('RU affirmation: «отлично, точно так» → not matched', () => {
    expect(detectCorrection({ tool: 'edit' }, 'отлично, точно так')).toEqual({
      matched: false,
      shape: null,
    });
  });

  // Cyrillic normalization: punctuation/quotes stripped, ё→е.
  it('RU normalize: ««нет,»» with guillemets → negation', () => {
    expect(detectCorrection({ tool: 'edit' }, '«нет,»')).toEqual({
      matched: true,
      shape: 'negation',
    });
  });

  it('RU normalize: «стоп!» with punctuation → negation', () => {
    expect(detectCorrection({ tool: 'exec' }, 'стоп!')).toEqual({
      matched: true,
      shape: 'negation',
    });
  });

  // Word boundary: «нет» must not match «нетворк» (network) / «неточный».
  it('RU anti-false-positive: «нетворк» / «неточный» → not matched', () => {
    expect(detectCorrection({ tool: 'edit' }, 'нетворк упал')).toEqual({
      matched: false,
      shape: null,
    });
    expect(detectCorrection({ tool: 'edit' }, 'неточный результат')).toEqual({
      matched: false,
      shape: null,
    });
  });

  // No cross-language bleed: an English correction still classifies via the EN
  // catalog (RU tokens don't perturb it); plain English prose stays unmatched.
  it('no cross-bleed: EN «stop that» → negation; plain prose → not matched', () => {
    expect(detectCorrection({ tool: 'exec' }, 'stop that')).toEqual({
      matched: true,
      shape: 'negation',
    });
    expect(detectCorrection({ tool: 'read' }, 'show me the result')).toEqual({
      matched: false,
      shape: null,
    });
  });

  // Privacy: the returned object carries no raw prose. Today this is a type
  // guardrail (Correction has no free-form string field), but it stays load-
  // bearing if a future field is ever added; the toEqual above confirms the
  // input was actually processed and classified.
  it('privacy: result carries no raw Russian prose', () => {
    const input = 'нет, это совершенно секретный маркер XYZ_PRIV_RU_9kq';
    const res = detectCorrection({ tool: 'edit' }, input);
    expect(res).toEqual({ matched: true, shape: 'negation' });
    expect(JSON.stringify(res).includes('секретный')).toBe(false);
    expect(JSON.stringify(res).includes('XYZ_PRIV_RU_9kq')).toBe(false);
  });
});
