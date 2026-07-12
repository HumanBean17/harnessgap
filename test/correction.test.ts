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
