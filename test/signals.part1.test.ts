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

/** Build a user_msg event; when `correction` is true, marks a matched correction. */
function userMsg(t: string, correction: boolean): NormalizedEvent {
  return {
    t,
    kind: 'user_msg',
    tool: null,
    input_digest: { files: [], cmd: null, query: null, lines_changed: null },
    ok: true,
    interrupted: false,
    duration_ms: 0,
    correction: correction ? { matched: true, shape: 'negation' } : { matched: false, shape: null },
  };
}

/** Build an assistant_msg event. */
function assistantMsg(t: string): NormalizedEvent {
  return {
    t,
    kind: 'assistant_msg',
    tool: null,
    input_digest: { files: [], cmd: null, query: null, lines_changed: null },
    ok: true,
    interrupted: false,
    duration_ms: 0,
    correction: null,
  };
}

/** Config with overridden detector fields; defaults for everything else. */
function cfg(overrides: Partial<Config['detector']> = {}): Config {
  return { ...DEFAULT_CONFIG, detector: { ...DEFAULT_CONFIG.detector, ...overrides } };
}

describe('computeSignals — part 1 (explore_ratio, reread, failure_streak, corrections)', () => {
  it('1. explore_ratio: 3 search + 5 read + 2 list (10 explore), 10 edited lines → 1.0', () => {
    const events: NormalizedEvent[] = [
      toolCall(iso(0), 'search', { query: 'a' }),
      toolCall(iso(1), 'search', { query: 'b' }),
      toolCall(iso(2), 'search', { query: 'c' }),
      toolCall(iso(3), 'read', { files: ['x.ts'] }),
      toolCall(iso(4), 'read', { files: ['y.ts'] }),
      toolCall(iso(5), 'read', { files: ['z.ts'] }),
      toolCall(iso(6), 'read', { files: ['w.ts'] }),
      toolCall(iso(7), 'read', { files: ['v.ts'] }),
      toolCall(iso(8), 'list'),
      toolCall(iso(9), 'list'),
      toolCall(iso(10), 'edit', { files: ['x.ts'], lines_changed: 10 }),
    ];
    const result = computeSignals(events, cfg());
    expect(result.explore_ratio).toBe(1.0);
    // Stub fields (Task 10 overwrites).
    expect(result.abandonment).toBe(false);
    expect(result.oscillation).toBe(0);
    expect(result.wall_clock_per_line_ms).toBeNull();
  });

  it('2. explore_ratio: zero edits → null', () => {
    const events: NormalizedEvent[] = [
      toolCall(iso(0), 'search', { query: 'a' }),
      toolCall(iso(1), 'read', { files: ['x.ts'] }),
      toolCall(iso(2), 'list'),
    ];
    const result = computeSignals(events, cfg());
    expect(result.explore_ratio).toBeNull();
  });

  it('3. reread: src/a.ts read 5x, src/b.ts read 2x, threshold 5 → 1', () => {
    const events: NormalizedEvent[] = [
      toolCall(iso(0), 'read', { files: ['src/a.ts'] }),
      toolCall(iso(1), 'read', { files: ['src/a.ts'] }),
      toolCall(iso(2), 'read', { files: ['src/a.ts'] }),
      toolCall(iso(3), 'read', { files: ['src/a.ts'] }),
      toolCall(iso(4), 'read', { files: ['src/a.ts'] }),
      toolCall(iso(5), 'read', { files: ['src/b.ts'] }),
      toolCall(iso(6), 'read', { files: ['src/b.ts'] }),
    ];
    const result = computeSignals(events, cfg({ reread_threshold: 5 }));
    expect(result.reread).toBe(1);
  });

  it('4. failure_streak: exec ok [T,F,F,F,T] → 3', () => {
    const events: NormalizedEvent[] = [
      toolCall(iso(0), 'exec', { cmd: 'a', ok: true }),
      toolCall(iso(1), 'exec', { cmd: 'b', ok: false }),
      toolCall(iso(2), 'exec', { cmd: 'c', ok: false }),
      toolCall(iso(3), 'exec', { cmd: 'd', ok: false }),
      toolCall(iso(4), 'exec', { cmd: 'e', ok: true }),
    ];
    const result = computeSignals(events, cfg());
    expect(result.failure_streak).toBe(3);
  });

  it('5. corrections: 60s after tool_call within 120s window → counted; 200s after with intervening assistant_msg → not counted', () => {
    const events: NormalizedEvent[] = [
      toolCall(iso(0), 'exec', { cmd: 'a', ok: true }),
      userMsg(iso(60_000), true), // within 120s window → counted
      assistantMsg(iso(100_000)), // intervening assistant_msg
      userMsg(iso(200_000), true), // 200s after tool_call, assistant_msg intervened → not counted
    ];
    const result = computeSignals(events, cfg({ correction_window_ms: 120_000 }));
    expect(result.corrections).toBe(1);
  });

  it('6. corrections: late correction before next assistant_msg (no intervening assistant_msg) → counted', () => {
    const events: NormalizedEvent[] = [
      toolCall(iso(0), 'exec', { cmd: 'a', ok: true }),
      userMsg(iso(200_000), true), // 200s > 120s window, but no assistant_msg intervened → counted
    ];
    const result = computeSignals(events, cfg({ correction_window_ms: 120_000 }));
    expect(result.corrections).toBe(1);
  });

  it('7. corrections: mixed 6-event sequence → 2 counted', () => {
    const events: NormalizedEvent[] = [
      assistantMsg(iso(0)), // e1
      toolCall(iso(1_000), 'exec', { ok: true }), // e2: lastToolCallTime=1000, saw=false
      userMsg(iso(5_000), true), // e3: 4000 ≤ 120000 → counted (1)
      userMsg(iso(200_000), true), // e4: 199000 > 120000, saw=false → counted (2)
      assistantMsg(iso(250_000)), // e5: saw=true
      userMsg(iso(400_000), true), // e6: 399000 > 120000, saw=true → not counted
    ];
    const result = computeSignals(events, cfg({ correction_window_ms: 120_000 }));
    expect(result.corrections).toBe(2);
  });
});
