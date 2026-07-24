// Tests for src/router/pointer.ts

import { describe, it, expect } from 'vitest';
import { renderPointer } from '../src/router/pointer.js';

describe('renderPointer', () => {
  it('should include backticked area key and doc path when doc is provided', () => {
    const result = renderPointer(
      { kind: 'area', key: 'src/billing' },
      'docs/architecture/billing.md',
    );
    expect(result).toContain('`src/billing/`');
    expect(result).toContain('docs/architecture/billing.md');
  });

  it('should include area key and synthesize suggestion when docPath is null', () => {
    const result = renderPointer({ kind: 'area', key: 'src/billing' }, null);
    expect(result).toContain('src/billing');
    expect(result).toContain('synthesize');
  });
});
