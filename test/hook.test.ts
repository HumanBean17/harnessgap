import { describe, it, expect } from 'vitest';
import { buildReflectFinding, formatStopHookOutput } from '../src/output/hook.js';
import type { SignalValues, StruggleRecord } from '../src/types.js';

/** A session with every signal null/zero/false; overrides applied on top. */
function zeroSignals(overrides: Partial<SignalValues> = {}): SignalValues {
  return {
    explore_ratio: null,
    reread: 0,
    failure_streak: 0,
    corrections: 0,
    abandonment: false,
    oscillation: 0,
    wall_clock_per_line_ms: null,
    ...overrides,
  };
}

/** Build a StruggleRecord with defaults; overrides applied on top. */
function mkRecord(overrides: Partial<StruggleRecord> = {}): StruggleRecord {
  return {
    session_id: 's',
    repo: 'r',
    started_at: '2024-01-01T00:00:00Z',
    duration_ms: 0,
    score_pct: 0,
    mode: 'bootstrap',
    flagged: false,
    truncated: false,
    event_count: 0,
    areas: [],
    signals: zeroSignals(),
    ...overrides,
  };
}

// A prose marker that must never leak into hook output (mirror output.test.ts).
const PROSE = 'please help me fix the broken auth login flow';

describe('reflect finding + stop-hook renderer', () => {
  it('1. buildReflectFinding — flagged + !zero_edit trips; copies mode; pins schema_version; keeps record ref', () => {
    const record = mkRecord({
      flagged: true,
      mode: 'bootstrap',
      session_id: 's1',
      repo: 'r1',
    });
    const finding = buildReflectFinding({ record, zero_edit: false });

    expect(finding.trip).toBe(true);
    expect(finding.mode).toBe(record.mode);
    expect(finding.schema_version).toBe(1);
    expect(finding.record).toBe(record); // same reference, not a clone
    expect(finding.session_id).toBe('s1');
    expect(finding.repo).toBe('r1');
    expect(finding.zero_edit).toBe(false);
  });

  it('2. buildReflectFinding — zero_edit forces trip off even when flagged', () => {
    const record = mkRecord({ flagged: true });
    const finding = buildReflectFinding({ record, zero_edit: true });

    expect(finding.trip).toBe(false);
    expect(finding.zero_edit).toBe(true);
  });

  it('3. buildReflectFinding — unflagged never trips', () => {
    const record = mkRecord({ flagged: false });
    const finding = buildReflectFinding({ record, zero_edit: false });

    expect(finding.trip).toBe(false);
  });

  it('4. formatStopHookOutput — stop_hook_active never re-blocks (returns {})', () => {
    const record = mkRecord({ flagged: true });
    const finding = buildReflectFinding({ record, zero_edit: false });
    expect(finding.trip).toBe(true); // precondition: would otherwise block

    const out = formatStopHookOutput(finding, true);
    expect(out).toEqual({});
  });

  it('5. formatStopHookOutput — trip + !active blocks; reason carries prompt + top area key + a signal name; strict keys', () => {
    const record = mkRecord({
      flagged: true,
      mode: 'bootstrap',
      areas: [
        { key: 'src/billing', weight: 2 },
        { key: 'src/auth', weight: 1 },
        { key: 'lib/x', weight: 0.5 },
        { key: 'docs/extra', weight: 0.1 }, // beyond top 3 — must not appear
      ],
      signals: zeroSignals({ reread: 7, abandonment: true }),
    });
    const finding = buildReflectFinding({ record, zero_edit: false });
    const out = formatStopHookOutput(finding, false);

    expect(out.decision).toBe('block');
    expect(typeof out.reason).toBe('string');
    // static reflection prompt is present
    expect(out.reason).toContain('Struggle detected this session');
    expect(out.reason).toContain('ReflectFrame');
    // top area key + a signal name + its value render
    expect(out.reason).toContain('src/billing');
    expect(out.reason).toContain('reread');
    expect(out.reason).toContain('reread(7)');
    // 4th area (outside top 3) is omitted
    expect(out.reason).not.toContain('docs/extra');
    // strict: exactly the keys decision + reason, nothing extra
    expect(Object.keys(out).sort()).toEqual(['decision', 'reason']);
  });

  it('6. formatStopHookOutput — no trip returns {} (allow stop)', () => {
    const record = mkRecord({ flagged: false });
    const finding = buildReflectFinding({ record, zero_edit: false });
    expect(finding.trip).toBe(false); // precondition

    const out = formatStopHookOutput(finding, false);
    expect(out).toEqual({});
  });

  it('7. privacy — reason carries no transcript prose; every output value is a primitive', () => {
    // Seed PROSE into record fields the reason builder must NOT echo: identity
    // fields and a 4th area key (outside the top-3 window).
    const record = mkRecord({
      flagged: true,
      session_id: PROSE,
      repo: PROSE,
      started_at: PROSE,
      areas: [
        { key: 'src/billing', weight: 2 },
        { key: 'src/auth', weight: 1 },
        { key: 'lib/x', weight: 0.5 },
        { key: PROSE, weight: 0.01 }, // 4th area — not in top 3, must not leak
      ],
      signals: zeroSignals({ reread: 7 }),
    });
    const finding = buildReflectFinding({ record, zero_edit: false });
    const out = formatStopHookOutput(finding, false);

    expect(out.decision).toBe('block');
    // no transcript prose anywhere in the reason
    expect(out.reason ?? '').not.toContain(PROSE);
    // a legit top-3 area key still appears (sanity — output is not empty)
    expect(out.reason).toContain('src/billing');
    // every value reachable in the hook output is a primitive
    // (no nested object holding raw message text)
    for (const v of Object.values(out)) {
      const t = typeof v;
      expect(t === 'string' || t === 'number' || t === 'boolean').toBe(true);
    }
  });

  it('8. buildReason — surfaces the 3 highest-WEIGHT area keys, not the alphabetically-first 3', () => {
    // record.areas arrives KEY-sorted (localeCompare) from localizeAreas; the
    // weight-desc sort lives only in the aggregator path reflect never sees.
    // Keys a/b/c/d in alphabetical order with NON-monotonic weights so the
    // heaviest (c, d) plus b are the top 3, leaving a (alphabetically first,
    // lowest weight) out.
    const record = mkRecord({
      flagged: true,
      mode: 'bootstrap',
      areas: [
        { key: 'a', weight: 1 }, // alphabetically first, but lowest weight → out
        { key: 'b', weight: 2 },
        { key: 'c', weight: 10 }, // heaviest
        { key: 'd', weight: 9 },
      ],
      signals: zeroSignals(), // isolate areas: no signal clause
    });
    const finding = buildReflectFinding({ record, zero_edit: false });
    const out = formatStopHookOutput(finding, false);

    expect(out.decision).toBe('block');
    // top 3 by weight: c(10), d(9), b(2) — all present (re-sorted by key)
    expect(out.reason).toContain('"b"');
    expect(out.reason).toContain('"c"');
    expect(out.reason).toContain('"d"');
    // the alphabetically-first area (a, lowest weight) is NOT surfaced
    expect(out.reason).not.toContain('"a"');
  });
});
