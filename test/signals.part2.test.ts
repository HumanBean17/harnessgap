import { describe, it, expect } from 'vitest';
import { computeSignals } from '../src/detector/signals.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import type { Config, NormalizedEvent, ToolKind } from '../src/types.js';

/** ms-since-epoch → ISO string; round-trips through Date.parse. */
function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Build a tool_call event with a normalized shape and per-tool digest fields. */
function toolCall(
  t: string,
  tool: ToolKind,
  opts: {
    files?: string[];
    cmd?: string | null;
    query?: string | null;
    lines_changed?: number | null;
    ok?: boolean;
    duration_ms?: number;
  } = {},
): NormalizedEvent {
  return {
    t,
    kind: 'tool_call',
    tool,
    input_digest: {
      files: opts.files ?? [],
      cmd: opts.cmd ?? null,
      query: opts.query ?? null,
      lines_changed: opts.lines_changed ?? null,
    },
    ok: opts.ok ?? true,
    interrupted: false,
    duration_ms: opts.duration_ms ?? 0,
    correction: null,
  };
}

/** Config with overridden detector and/or areas fields; defaults for the rest. */
function cfg(
  overrides: { detector?: Partial<Config['detector']>; areas?: Partial<Config['areas']> } = {},
): Config {
  return {
    ...DEFAULT_CONFIG,
    detector: { ...DEFAULT_CONFIG.detector, ...overrides.detector },
    areas: { ...DEFAULT_CONFIG.areas, ...overrides.areas },
  };
}

describe('computeSignals — part 2 (abandonment, oscillation, wall_clock_per_line)', () => {
  it('1. abandonment: tail of 4/16 events is 3 read + 1 search, 0 edits → true', () => {
    // 16 events; tail_fraction 0.25 → tail = last 4.
    // First 12 include one edit (so whole-session suppression does not apply).
    const events: NormalizedEvent[] = [
      // first 12
      toolCall(iso(0), 'edit', { files: ['x.ts'], lines_changed: 10 }),
      toolCall(iso(1), 'read', { files: ['x.ts'] }),
      toolCall(iso(2), 'read', { files: ['x.ts'] }),
      toolCall(iso(3), 'read', { files: ['x.ts'] }),
      toolCall(iso(4), 'read', { files: ['x.ts'] }),
      toolCall(iso(5), 'read', { files: ['x.ts'] }),
      toolCall(iso(6), 'read', { files: ['x.ts'] }),
      toolCall(iso(7), 'read', { files: ['x.ts'] }),
      toolCall(iso(8), 'read', { files: ['x.ts'] }),
      toolCall(iso(9), 'read', { files: ['x.ts'] }),
      toolCall(iso(10), 'read', { files: ['x.ts'] }),
      toolCall(iso(11), 'read', { files: ['x.ts'] }),
      // tail: 3 read + 1 search, 0 edits
      toolCall(iso(12), 'read', { files: ['a.ts'] }),
      toolCall(iso(13), 'read', { files: ['b.ts'] }),
      toolCall(iso(14), 'read', { files: ['c.ts'] }),
      toolCall(iso(15), 'search', { query: 'q' }),
    ];
    const result = computeSignals(events, cfg());
    expect(result.abandonment).toBe(true);
  });

  it('2. abandonment: one edit in the tail → false', () => {
    // Same as test 1 but the tail includes an edit.
    const events: NormalizedEvent[] = [
      // first 12
      toolCall(iso(0), 'edit', { files: ['x.ts'], lines_changed: 10 }),
      toolCall(iso(1), 'read', { files: ['x.ts'] }),
      toolCall(iso(2), 'read', { files: ['x.ts'] }),
      toolCall(iso(3), 'read', { files: ['x.ts'] }),
      toolCall(iso(4), 'read', { files: ['x.ts'] }),
      toolCall(iso(5), 'read', { files: ['x.ts'] }),
      toolCall(iso(6), 'read', { files: ['x.ts'] }),
      toolCall(iso(7), 'read', { files: ['x.ts'] }),
      toolCall(iso(8), 'read', { files: ['x.ts'] }),
      toolCall(iso(9), 'read', { files: ['x.ts'] }),
      toolCall(iso(10), 'read', { files: ['x.ts'] }),
      toolCall(iso(11), 'read', { files: ['x.ts'] }),
      // tail: 2 read + 1 search + 1 edit → has an edit
      toolCall(iso(12), 'read', { files: ['a.ts'] }),
      toolCall(iso(13), 'read', { files: ['b.ts'] }),
      toolCall(iso(14), 'search', { query: 'q' }),
      toolCall(iso(15), 'edit', { files: ['c.ts'], lines_changed: 5 }),
    ];
    const result = computeSignals(events, cfg());
    expect(result.abandonment).toBe(false);
  });

  it('3. abandonment: whole session 0 edits, 0 test/build exec → suppressed (false)', () => {
    // Only grep/ls (search/list); no edits, no test exec.
    // Tail is explore-only (would be true without suppression).
    const events: NormalizedEvent[] = [
      toolCall(iso(0), 'search', { query: 'a' }),
      toolCall(iso(1), 'list'),
      toolCall(iso(2), 'search', { query: 'b' }),
      toolCall(iso(3), 'list'),
      toolCall(iso(4), 'search', { query: 'c' }),
      toolCall(iso(5), 'list'),
      // tail: 2 reads
      toolCall(iso(6), 'read', { files: ['a.ts'] }),
      toolCall(iso(7), 'read', { files: ['b.ts'] }),
    ];
    const result = computeSignals(events, cfg());
    expect(result.abandonment).toBe(false);
  });

  it('4. abandonment: 0 edits but npm test exec present → suppression does NOT apply → true', () => {
    // Whole session has 0 edits but a `npm test` exec → not a pure-research signature.
    // Tail is explore-only → abandonment true.
    const events: NormalizedEvent[] = [
      // first 12: includes npm test exec, no edits
      toolCall(iso(0), 'read', { files: ['x.ts'] }),
      toolCall(iso(1), 'read', { files: ['x.ts'] }),
      toolCall(iso(2), 'read', { files: ['x.ts'] }),
      toolCall(iso(3), 'exec', { cmd: 'npm test', ok: true }),
      toolCall(iso(4), 'read', { files: ['x.ts'] }),
      toolCall(iso(5), 'read', { files: ['x.ts'] }),
      toolCall(iso(6), 'read', { files: ['x.ts'] }),
      toolCall(iso(7), 'read', { files: ['x.ts'] }),
      toolCall(iso(8), 'read', { files: ['x.ts'] }),
      toolCall(iso(9), 'read', { files: ['x.ts'] }),
      toolCall(iso(10), 'read', { files: ['x.ts'] }),
      toolCall(iso(11), 'read', { files: ['x.ts'] }),
      // tail: 4 explore events, 0 edits
      toolCall(iso(12), 'read', { files: ['a.ts'] }),
      toolCall(iso(13), 'read', { files: ['b.ts'] }),
      toolCall(iso(14), 'read', { files: ['c.ts'] }),
      toolCall(iso(15), 'search', { query: 'q' }),
    ];
    const result = computeSignals(events, cfg());
    expect(result.abandonment).toBe(true);
  });

  it('5. oscillation: edit a → npm test(ok=false) → edit a → 1', () => {
    const events: NormalizedEvent[] = [
      toolCall(iso(0), 'edit', { files: ['src/a.ts'], lines_changed: 5 }),
      toolCall(iso(1), 'exec', { cmd: 'npm test', ok: false }),
      toolCall(iso(2), 'edit', { files: ['src/a.ts'], lines_changed: 3 }),
    ];
    const result = computeSignals(events, cfg());
    expect(result.oscillation).toBe(1);
  });

  it('6. oscillation: TDD red-green with no second edit → 0', () => {
    const events: NormalizedEvent[] = [
      toolCall(iso(0), 'edit', { files: ['src/a.ts'], lines_changed: 5 }),
      toolCall(iso(1), 'exec', { cmd: 'npm test', ok: false }),
      toolCall(iso(2), 'exec', { cmd: 'npm test', ok: true }),
    ];
    const result = computeSignals(events, cfg());
    expect(result.oscillation).toBe(0);
  });

  it('7. oscillation: two cycles on the same file → 2', () => {
    const events: NormalizedEvent[] = [
      toolCall(iso(0), 'edit', { files: ['src/a.ts'], lines_changed: 5 }),
      toolCall(iso(1), 'exec', { cmd: 'npm test', ok: false }),
      toolCall(iso(2), 'edit', { files: ['src/a.ts'], lines_changed: 3 }),
      toolCall(iso(3), 'exec', { cmd: 'npm test', ok: false }),
      toolCall(iso(4), 'edit', { files: ['src/a.ts'], lines_changed: 2 }),
    ];
    const result = computeSignals(events, cfg());
    expect(result.oscillation).toBe(2);
  });

  it('8. oscillation: edit a → test fail → edit b (different file) → 0', () => {
    const events: NormalizedEvent[] = [
      toolCall(iso(0), 'edit', { files: ['src/a.ts'], lines_changed: 5 }),
      toolCall(iso(1), 'exec', { cmd: 'npm test', ok: false }),
      toolCall(iso(2), 'edit', { files: ['src/b.ts'], lines_changed: 3 }),
    ];
    const result = computeSignals(events, cfg());
    expect(result.oscillation).toBe(0);
  });

  it('9. wall_clock_per_line_ms: 600000ms / 10 lines → 60000; zero edits → null', () => {
    const withEdits: NormalizedEvent[] = [
      toolCall(iso(0), 'edit', { files: ['x.ts'], lines_changed: 10 }),
      toolCall(iso(600_000), 'read', { files: ['x.ts'] }),
    ];
    expect(computeSignals(withEdits, cfg()).wall_clock_per_line_ms).toBe(60_000);

    const noEdits: NormalizedEvent[] = [
      toolCall(iso(0), 'read', { files: ['x.ts'] }),
      toolCall(iso(600_000), 'search', { query: 'q' }),
    ];
    expect(computeSignals(noEdits, cfg()).wall_clock_per_line_ms).toBeNull();
  });
});
