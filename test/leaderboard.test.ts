import { describe, it, expect } from 'vitest';
import { aggregateAreas } from '../src/aggregate/leaderboard.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import type { Config, SignalValues, StruggleRecord } from '../src/types.js';

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

const CFG: Config = DEFAULT_CONFIG;

describe('aggregateAreas', () => {
  it('1. weighted totals, mean_score over flagged, top_signals<=3, sort first', () => {
    // 3 records touching src/billing (weight 1.0 each): 2 flagged (90, 80),
    // 1 unflagged. sessions_total = 3.0, sessions_flagged = 2.0,
    // mean_score = (90+80)/2 = 85. Only area → sorted first.
    const records = [
      mkRecord({
        session_id: 's1',
        flagged: true,
        score_pct: 90,
        areas: [{ key: 'src/billing', weight: 1.0 }],
        signals: zeroSignals({ reread: 7, wall_clock_per_line_ms: 540000, abandonment: true }),
      }),
      mkRecord({
        session_id: 's2',
        flagged: true,
        score_pct: 80,
        areas: [{ key: 'src/billing', weight: 1.0 }],
        signals: zeroSignals({ reread: 7, wall_clock_per_line_ms: 100000, abandonment: true }),
      }),
      mkRecord({
        session_id: 's3',
        flagged: false,
        score_pct: 50,
        areas: [{ key: 'src/billing', weight: 1.0 }],
        signals: zeroSignals(),
      }),
    ];
    const { rows, summary } = aggregateAreas(records, CFG);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.key).toBe('src/billing');
    expect(row.sessions_total).toBe(3);
    expect(row.sessions_flagged).toBe(2);
    expect(row.mean_score).toBe(85);
    expect(row.top_signals.length).toBeLessThanOrEqual(3);
    // Only area, so it is first by definition.
    expect(rows[0].key).toBe('src/billing');
    // Summary counts AREAS: src/billing has ≥1 flagged session → 1 flagged area,
    // 0 unflagged areas; no empty-area records → 0 unlocalized.
    expect(summary.flagged).toBe(1);
    expect(summary.unflagged).toBe(0);
    expect(summary.unlocalized).toBe(0);
  });

  it('2. empty-areas record counted as unlocalized, not in any row', () => {
    const records = [
      mkRecord({
        session_id: 's1',
        flagged: true,
        score_pct: 90,
        areas: [],
        signals: zeroSignals({ reread: 5 }),
      }),
    ];
    const { rows, summary } = aggregateAreas(records, CFG);
    expect(rows).toHaveLength(0);
    expect(summary.unlocalized).toBe(1);
    // No area rows → 0 flagged/unflagged AREAS (the flagged session has no area,
    // so it isn't represented in the area-level summary; it's in `unlocalized`).
    expect(summary.flagged).toBe(0);
    expect(summary.unflagged).toBe(0);
  });

  it('3. sort: more flagged first; tie → higher mean_score first', () => {
    // More flagged → first.
    const more = aggregateAreas(
      [
        mkRecord({
          session_id: 's1',
          flagged: true,
          score_pct: 70,
          areas: [{ key: 'src/a', weight: 1.0 }],
          signals: zeroSignals({ reread: 3 }),
        }),
        mkRecord({
          session_id: 's2',
          flagged: true,
          score_pct: 70,
          areas: [{ key: 'src/a', weight: 1.0 }],
          signals: zeroSignals({ reread: 3 }),
        }),
        mkRecord({
          session_id: 's3',
          flagged: true,
          score_pct: 70,
          areas: [{ key: 'src/b', weight: 1.0 }],
          signals: zeroSignals({ reread: 3 }),
        }),
      ],
      CFG,
    );
    expect(more.rows.map((r) => r.key)).toEqual(['src/a', 'src/b']);
    expect(more.rows[0].sessions_flagged).toBe(2);
    expect(more.rows[1].sessions_flagged).toBe(1);

    // Tie on sessions_flagged → higher mean_score first.
    const tie = aggregateAreas(
      [
        mkRecord({
          session_id: 's1',
          flagged: true,
          score_pct: 80,
          areas: [{ key: 'src/a', weight: 1.0 }],
          signals: zeroSignals({ reread: 3 }),
        }),
        mkRecord({
          session_id: 's2',
          flagged: true,
          score_pct: 90,
          areas: [{ key: 'src/b', weight: 1.0 }],
          signals: zeroSignals({ reread: 3 }),
        }),
      ],
      CFG,
    );
    expect(tie.rows.map((r) => r.key)).toEqual(['src/b', 'src/a']);
    expect(tie.rows[0].mean_score).toBe(90);
    expect(tie.rows[1].mean_score).toBe(80);
  });

  it('4. display: reread(7), wall_clock_per_line(540s), abandonment(yes)', () => {
    // Single flagged record: medians equal its own signal values. With
    // wall_clock=540000 (huge) > reread=7 > abandonment=true(1) > 0-counts,
    // the top 3 are exactly these three.
    const records = [
      mkRecord({
        session_id: 's1',
        flagged: true,
        score_pct: 90,
        areas: [{ key: 'src/x', weight: 1.0 }],
        signals: zeroSignals({
          reread: 7,
          wall_clock_per_line_ms: 540000,
          abandonment: true,
        }),
      }),
    ];
    const { rows } = aggregateAreas(records, CFG);
    const displays = rows[0].top_signals.map((t) => t.display);
    expect(displays).toContain('reread(7)');
    expect(displays).toContain('wall_clock_per_line(540s)');
    expect(displays).toContain('abandonment(yes)');
    // Confirm the matching name/value entries.
    const reread = rows[0].top_signals.find((t) => t.name === 'reread');
    expect(reread?.value).toBe(7);
    const wall = rows[0].top_signals.find((t) => t.name === 'wall_clock_per_line');
    expect(wall?.value).toBe(540000);
    expect(wall?.display).toBe('wall_clock_per_line(540s)');
    const ab = rows[0].top_signals.find((t) => t.name === 'abandonment');
    expect(ab?.value).toBe(true);
    expect(ab?.display).toBe('abandonment(yes)');
  });

  it('5. summary counts correct over a 5-record mixed set', () => {
    const records = [
      mkRecord({
        session_id: 's1',
        flagged: true,
        score_pct: 90,
        areas: [{ key: 'src/a', weight: 1.0 }],
        signals: zeroSignals({ reread: 5 }),
      }),
      mkRecord({
        session_id: 's2',
        flagged: false,
        score_pct: 40,
        areas: [{ key: 'src/a', weight: 1.0 }],
        signals: zeroSignals(),
      }),
      mkRecord({
        session_id: 's3',
        flagged: true,
        score_pct: 95,
        areas: [],
        signals: zeroSignals({ reread: 9 }),
      }),
      mkRecord({
        session_id: 's4',
        flagged: false,
        score_pct: 30,
        areas: [],
        signals: zeroSignals(),
      }),
      mkRecord({
        session_id: 's5',
        flagged: true,
        score_pct: 88,
        areas: [{ key: 'src/b', weight: 1.0 }],
        signals: zeroSignals({ reread: 6 }),
      }),
    ];
    const { rows, summary } = aggregateAreas(records, CFG);
    // Summary counts AREAS: src/a + src/b each have ≥1 flagged session → 2
    // flagged areas, 0 unflagged areas. 2 records have empty areas → 2
    // unlocalized sessions.
    expect(summary.flagged).toBe(2);
    expect(summary.unflagged).toBe(0);
    expect(summary.unlocalized).toBe(2);
    expect(rows).toHaveLength(2);
    // src/a: 2 total, 1 flagged, mean 90; src/b: 1 total, 1 flagged, mean 88.
    // Tie on flagged(1); higher mean_score first → src/a then src/b.
    expect(rows.map((r) => r.key)).toEqual(['src/a', 'src/b']);
    expect(rows[0].sessions_total).toBe(2);
    expect(rows[0].sessions_flagged).toBe(1);
    expect(rows[0].mean_score).toBe(90);
    expect(rows[1].sessions_total).toBe(1);
    expect(rows[1].sessions_flagged).toBe(1);
    expect(rows[1].mean_score).toBe(88);
  });

  it('6. empty records → empty rows and zeroed summary', () => {
    const { rows, summary } = aggregateAreas([], CFG);
    expect(rows).toEqual([]);
    expect(summary).toEqual({ flagged: 0, unflagged: 0, unlocalized: 0 });
  });

  it('7. area with no flagged records still appears with empty top_signals', () => {
    const records = [
      mkRecord({
        session_id: 's1',
        flagged: false,
        score_pct: 40,
        areas: [{ key: 'src/c', weight: 1.0 }],
        signals: zeroSignals({ reread: 5 }),
      }),
    ];
    const { rows } = aggregateAreas(records, CFG);
    expect(rows).toHaveLength(1);
    expect(rows[0].sessions_total).toBe(1);
    expect(rows[0].sessions_flagged).toBe(0);
    expect(rows[0].mean_score).toBe(0);
    expect(rows[0].top_signals).toEqual([]);
  });

  it('8. integer counts (not weighted-sum): non-unit weights still count 1 per session', () => {
    // A session touches an area or it doesn't — counts are integers regardless
    // of area.weight. A (flagged, w=2.0), B (flagged, w=0.5), C (unflagged,
    // w=1.0) all touch src/a → sessions_total=3, sessions_flagged=2; mean_score
    // =(90+70)/2 =80 (flagged only). Fails if `+= 1` ever becomes `+= weight`.
    const records = [
      mkRecord({
        session_id: 's1',
        flagged: true,
        score_pct: 90,
        areas: [{ key: 'src/a', weight: 2.0 }],
        signals: zeroSignals({ reread: 3 }),
      }),
      mkRecord({
        session_id: 's2',
        flagged: true,
        score_pct: 70,
        areas: [{ key: 'src/a', weight: 0.5 }],
        signals: zeroSignals({ reread: 3 }),
      }),
      mkRecord({
        session_id: 's3',
        flagged: false,
        score_pct: 50,
        areas: [{ key: 'src/a', weight: 1.0 }],
        signals: zeroSignals(),
      }),
    ];
    const { rows } = aggregateAreas(records, CFG);
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe('src/a');
    expect(rows[0].sessions_total).toBe(3);
    expect(rows[0].sessions_flagged).toBe(2);
    expect(rows[0].mean_score).toBe(80);
  });

  it('9. top_signals ordered by median value DESCENDING (toEqual, not contains)', () => {
    // Single flagged record: medians equal its own values. wall_clock=540000
    // > reread=7 > abandonment=true(1) > 0-counts. Top 3 in that exact order.
    // Asserts the ORDERED array (existing test 4 only checks presence).
    const records = [
      mkRecord({
        session_id: 's1',
        flagged: true,
        score_pct: 90,
        areas: [{ key: 'src/x', weight: 1.0 }],
        signals: zeroSignals({
          reread: 7,
          wall_clock_per_line_ms: 540000,
          abandonment: true,
        }),
      }),
    ];
    const { rows } = aggregateAreas(records, CFG);
    const displays = rows[0].top_signals.map((t) => t.display);
    expect(displays).toEqual([
      'wall_clock_per_line(540s)',
      'reread(7)',
      'abandonment(yes)',
    ]);
  });

  it('10. a record touching MULTIPLE areas contributes to EACH (integer count)', () => {
    // One flagged record with two areas. Both src/a (w=0.6) and src/b (w=0.4)
    // must appear as rows, each counting this one session once. Fails if only
    // the first area is processed, or if counts were weighted by area.weight.
    const records = [
      mkRecord({
        session_id: 's1',
        flagged: true,
        score_pct: 80,
        areas: [
          { key: 'src/a', weight: 0.6 },
          { key: 'src/b', weight: 0.4 },
        ],
        signals: zeroSignals({ reread: 2 }),
      }),
    ];
    const { rows } = aggregateAreas(records, CFG);
    const a = rows.find((r) => r.key === 'src/a');
    const b = rows.find((r) => r.key === 'src/b');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a?.sessions_total).toBe(1);
    expect(a?.sessions_flagged).toBe(1);
    expect(b?.sessions_total).toBe(1);
    expect(b?.sessions_flagged).toBe(1);
  });

  it('12. PERCENTILE mode: explore_ratio renders as <N>th repo percentile (spec §8)', () => {
    // 4 flagged records, percentile mode, all touching src/x. explore_ratio
    // values [null, 0.5, 2.0, 5.0] → area median of non-null = 2.0; repo-wide
    // percentile of 2.0 within [0.5,2.0,5.0] = (1 strictly less)/(3−1)*100 = 50
    // → display `explore_ratio(50th)`. Counts are all 0 so explore_ratio is the
    // top signal. value stored is the raw median (2.0).
    const records = [
      mkRecord({
        session_id: 's1',
        mode: 'percentile',
        flagged: true,
        score_pct: 90,
        areas: [{ key: 'src/x', weight: 1.0 }],
        signals: zeroSignals({ explore_ratio: null }),
      }),
      mkRecord({
        session_id: 's2',
        mode: 'percentile',
        flagged: true,
        score_pct: 90,
        areas: [{ key: 'src/x', weight: 1.0 }],
        signals: zeroSignals({ explore_ratio: 0.5 }),
      }),
      mkRecord({
        session_id: 's3',
        mode: 'percentile',
        flagged: true,
        score_pct: 90,
        areas: [{ key: 'src/x', weight: 1.0 }],
        signals: zeroSignals({ explore_ratio: 2.0 }),
      }),
      mkRecord({
        session_id: 's4',
        mode: 'percentile',
        flagged: true,
        score_pct: 90,
        areas: [{ key: 'src/x', weight: 1.0 }],
        signals: zeroSignals({ explore_ratio: 5.0 }),
      }),
    ];
    const { rows } = aggregateAreas(records, CFG);
    const explore = rows[0].top_signals.find((t) => t.name === 'explore_ratio');
    expect(explore).toBeDefined();
    expect(explore?.value).toBe(2.0); // raw median preserved on the entry
    expect(explore?.display).toBe('explore_ratio(50th)');
    // And it's the first top signal (highest percentile rank; others are 0).
    expect(rows[0].top_signals[0]?.name).toBe('explore_ratio');
  });

  it('11. partial-null nullable signal: median of non-null values (not skipped)', () => {
    // explore_ratio is nullable. Record P (null) + Record Q (0.5), both
    // flagged, touching src/x. With PARTIAL nulls the signal is NOT skipped —
    // median of [0.5] (null filtered) = 0.5, display `explore_ratio(0.5)`.
    // (Only ALL-null would skip it.) Other signals kept zero so explore_ratio
    // is the distinguishing top signal.
    const records = [
      mkRecord({
        session_id: 's1',
        flagged: true,
        score_pct: 80,
        areas: [{ key: 'src/x', weight: 1.0 }],
        signals: zeroSignals({ explore_ratio: null }),
      }),
      mkRecord({
        session_id: 's2',
        flagged: true,
        score_pct: 80,
        areas: [{ key: 'src/x', weight: 1.0 }],
        signals: zeroSignals({ explore_ratio: 0.5 }),
      }),
    ];
    const { rows } = aggregateAreas(records, CFG);
    const explore = rows[0].top_signals.find((t) => t.name === 'explore_ratio');
    expect(explore).toBeDefined();
    expect(explore?.value).toBe(0.5);
    expect(explore?.display).toBe('explore_ratio(0.5)');
  });
});
