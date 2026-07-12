import { describe, it, expect } from 'vitest';
import { ping } from '../src/index.js';

describe('smoke', () => {
  it('ping() returns "harnessgap"', () => {
    expect(ping()).toBe('harnessgap');
  });
});
