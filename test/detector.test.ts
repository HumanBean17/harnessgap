import { describe, it, expect, afterEach } from 'vitest';
import { runDetector } from '../src/detector/index.js';
import { computeSignals } from '../src/detector/signals.js';
import { scoreSessions } from '../src/detector/scoring.js';
import { runReflect } from '../src/pipeline.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import {
  setupTempRepo,
  cleanupTempDirs,
} from './helpers/builder.js';
import type {
  NormalizedEnvelope,
  NormalizedEvent,
  ReflectFinding,
  ToolKind,
} from '../src/types.js';

afterEach(cleanupTempDirs);

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

/** Build a NormalizedEnvelope with sensible defaults derived from events. */
function envelope(
  session_id: string,
  events: NormalizedEvent[],
  opts: {
    truncated?: boolean;
    event_count?: number;
    repo?: string;
    started_at?: string;
    duration_ms?: number;
  } = {},
): NormalizedEnvelope {
  const duration =
    opts.duration_ms ??
    (events.length > 0
      ? Date.parse(events[events.length - 1].t) - Date.parse(events[0].t)
      : 0);
  return {
    schema_version: 1,
    session_id,
    agent: 'claude-code',
    repo: opts.repo ?? 'test/repo',
    started_at: opts.started_at ?? (events.length > 0 ? events[0].t : iso(0)),
    duration_ms: duration,
    events,
    truncated: opts.truncated ?? false,
    event_count: opts.event_count ?? events.length,
  };
}

describe('runDetector + assembleStruggleRecord', () => {
  it('1. 3 envelopes (heavy/clean/mid): raw signals, consistent mode, flagged matches scoreSessions', () => {
    // Empty envelopes → no records, no finding, too-few-sessions baseline.
    // n=0 trace: state='too-few-sessions' (0 < min_sessions=10); orientation
    // null (no with-edit sessions); zero_edit_fraction 0; acute.struggle_rate
    // 0; scoring_mode 'bootstrap' via the scores[0]?.mode ?? 'bootstrap' fallback.
    expect(runDetector([], DEFAULT_CONFIG, false)).toEqual({
      records: [],
      finding: null,
      baseline: {
        state: 'too-few-sessions',
        sessions_sampled: 0,
        scoring_mode: 'bootstrap',
        orientation: null,
        zero_edit_fraction: 0,
        acute: { struggle_rate: 0, struggle_rate_threshold: 0.3 },
      },
    });

    // Heavy: reread=5, failure_streak=3, corrections=2 → 3 tripped → flagged.
    const heavyEvents: NormalizedEvent[] = [];
    for (let f = 0; f < 5; f++) {
      const file = `src/billing/f${f}.ts`;
      for (let r = 0; r < 5; r++) {
        heavyEvents.push(toolCall(iso(heavyEvents.length * 1000), 'read', { files: [file] }));
      }
    }
    heavyEvents.push(toolCall(iso(heavyEvents.length * 1000), 'exec', { cmd: 'npm test', ok: false }));
    heavyEvents.push(toolCall(iso(heavyEvents.length * 1000), 'exec', { cmd: 'npm test', ok: false }));
    heavyEvents.push(toolCall(iso(heavyEvents.length * 1000), 'exec', { cmd: 'npm test', ok: false }));
    heavyEvents.push(userMsg(iso(heavyEvents.length * 1000), true));
    heavyEvents.push(userMsg(iso(heavyEvents.length * 1000), true));
    heavyEvents.push(
      toolCall(iso(heavyEvents.length * 1000), 'edit', {
        files: ['src/billing/f0.ts'],
        lines_changed: 10,
      }),
    );

    // Clean: single edit → all signals 0/false → not flagged.
    const cleanEvents = [
      toolCall(iso(0), 'edit', { files: ['src/app/main.ts'], lines_changed: 10 }),
    ];

    // Mid: failure_streak=3 → 1 tripped → not flagged, non-zero score.
    const midEvents = [
      toolCall(iso(0), 'edit', { files: ['src/app/util.ts'], lines_changed: 5 }),
      toolCall(iso(1000), 'exec', { cmd: 'npm test', ok: false }),
      toolCall(iso(2000), 'exec', { cmd: 'npm test', ok: false }),
      toolCall(iso(3000), 'exec', { cmd: 'npm test', ok: false }),
    ];

    const envelopes = [
      envelope('heavy', heavyEvents),
      envelope('clean', cleanEvents),
      envelope('mid', midEvents),
    ];
    const { records } = runDetector(envelopes, DEFAULT_CONFIG, false);

    expect(records).toHaveLength(3);

    // Expected signals + scores computed independently.
    const expectedSignals = envelopes.map((e) => computeSignals(e.events, DEFAULT_CONFIG));
    const expectedScores = scoreSessions({
      signals: expectedSignals,
      cfg: DEFAULT_CONFIG,
      forceBootstrap: false,
    });

    // Per-record: raw signals + score fields match independent computation.
    for (let i = 0; i < 3; i++) {
      expect(records[i].signals).toEqual(expectedSignals[i]); // raw, as-is
      expect(records[i].score_pct).toBe(expectedScores[i].score_pct);
      expect(records[i].mode).toBe(expectedScores[i].mode);
      expect(records[i].flagged).toBe(expectedScores[i].flagged);
      expect(records[i].session_id).toBe(envelopes[i].session_id);
      expect(records[i].repo).toBe(envelopes[i].repo);
      // composite is NOT on StruggleRecord.
      expect(records[i]).not.toHaveProperty('composite');
    }

    // Mode is consistent across all records (3 < 30 → bootstrap).
    const modes = new Set(records.map((r) => r.mode));
    expect(modes.size).toBe(1);
    expect(records[0].mode).toBe('bootstrap');

    // Targeted raw-value assertions.
    expect(records[0].signals.reread).toBe(5);
    expect(records[0].signals.failure_streak).toBe(3);
    expect(records[0].signals.corrections).toBe(2);
    expect(records[0].flagged).toBe(true);
    expect(records[1].signals.reread).toBe(0);
    expect(records[1].signals.failure_streak).toBe(0);
    expect(records[1].flagged).toBe(false);
    expect(records[2].signals.failure_streak).toBe(3);
    expect(records[2].flagged).toBe(false);
    expect(records[2].score_pct).toBeGreaterThan(0);
  });

  it('2. signals.explore_ratio is null when the envelope had no edits', () => {
    const events = [
      toolCall(iso(0), 'search', { query: 'foo' }),
      toolCall(iso(1000), 'read', { files: ['src/a.ts'] }),
      toolCall(iso(2000), 'list'),
    ];
    const { records } = runDetector([envelope('no-edits', events)], DEFAULT_CONFIG, false);
    expect(records[0].signals.explore_ratio).toBeNull();
    expect(records[0].signals.wall_clock_per_line_ms).toBeNull();
  });

  it('3. truncated/event_count propagate from the envelope', () => {
    const events = [
      toolCall(iso(0), 'edit', { files: ['src/a.ts'], lines_changed: 5 }),
      toolCall(iso(1000), 'edit', { files: ['src/b.ts'], lines_changed: 5 }),
    ];
    const env = envelope('trunc', events, { truncated: true, event_count: 500 });
    const { records } = runDetector([env], DEFAULT_CONFIG, false);
    expect(records[0].truncated).toBe(true);
    expect(records[0].event_count).toBe(500);
    // event_count can differ from events.length (truncated session).
    expect(records[0].event_count).not.toBe(events.length);
  });

  it('4. areas populated from localizeAreas (or [] for unlocalized)', () => {
    const localized = [
      toolCall(iso(0), 'edit', { files: ['src/billing/a.ts'], lines_changed: 5 }),
      toolCall(iso(1000), 'edit', { files: ['src/billing/b.ts'], lines_changed: 5 }),
    ];
    const unlocalized = [
      toolCall(iso(0), 'edit', { files: ['README.md'], lines_changed: 5 }),
    ];
    const { records } = runDetector(
      [envelope('loc', localized), envelope('unloc', unlocalized)],
      DEFAULT_CONFIG,
      false,
    );
    expect(records[0].areas).toEqual([{ key: 'src/billing', weight: 1.0 }]);
    expect(records[1].areas).toEqual([]);
  });

  it('5. mode is bootstrap when envelopes.length < 30, percentile when >= 30', () => {
    // 3 envelopes → bootstrap (3 < 30).
    const three = Array.from({ length: 3 }, (_, i) =>
      envelope(`s${i}`, [
        toolCall(iso(0), 'edit', { files: [`src/f${i}.ts`], lines_changed: 1 }),
      ]),
    );
    const { records: threeRecords } = runDetector(three, DEFAULT_CONFIG, false);
    expect(threeRecords[0].mode).toBe('bootstrap');
    expect(new Set(threeRecords.map((r) => r.mode)).size).toBe(1);

    // 30 envelopes → percentile (30 is not < 30).
    const thirty = Array.from({ length: 30 }, (_, i) =>
      envelope(`p${i}`, [
        toolCall(iso(0), 'edit', { files: [`src/p${i}.ts`], lines_changed: 1 }),
      ]),
    );
    const { records: thirtyRecords } = runDetector(thirty, DEFAULT_CONFIG, false);
    expect(thirtyRecords).toHaveLength(30);
    expect(thirtyRecords[0].mode).toBe('percentile');
    expect(new Set(thirtyRecords.map((r) => r.mode)).size).toBe(1);

    // forceBootstrap=true overrides even with 30 envelopes.
    const { records: forced } = runDetector(thirty, DEFAULT_CONFIG, true);
    expect(forced[0].mode).toBe('bootstrap');
  });
});

// Task 4: docs_read / docs_injected collection. docs_read is the distinct
// {path, t} of read-events (tool==='read') whose file lives under any
// cfg.docs_dirs entry (default ['docs']), deduped by path keeping the EARLIEST
// t; docs_injected is reserved for routing (deferred) and stays [] on every
// record. The degenerate reflect fail-open record also yields both as [].
describe('runDetector + assembleStruggleRecord — docs_read / docs_injected', () => {
  it('6. docs_read collects distinct read-events under any docs_dirs entry; earliest t wins; src and edits excluded; docs_injected is []', () => {
    // DEFAULT_CONFIG.docs_dirs === ['docs']. Two reads of the same doc path →
    // deduped to one entry with the FIRST event's t; src/... is not under
    // 'docs/' so excluded; an edit of a docs file is not a read → excluded.
    const events: NormalizedEvent[] = [
      toolCall(iso(0), 'read', { files: ['docs/architecture/billing.md'] }),
      toolCall(iso(1000), 'read', { files: ['docs/architecture/billing.md'] }),
      toolCall(iso(2000), 'read', { files: ['src/billing/charge.ts'] }),
      toolCall(iso(3000), 'edit', { files: ['docs/notes.md'], lines_changed: 1 }),
    ];
    const { records } = runDetector([envelope('s1', events)], DEFAULT_CONFIG, false);
    expect(records[0].docs_read).toEqual([
      { path: 'docs/architecture/billing.md', t: iso(0) },
    ]);
    expect(records[0].docs_injected).toEqual([]);
  });

  it('7. docs_read dedupes by path keeping the earliest t across multiple docs (first-seen order preserved)', () => {
    // Two distinct docs, the second one read at t=5000 then again at t=4000
    // (out-of-order) → the earlier t (4000) must win. The first-seen order
    // puts docs/a.md before docs/b.md.
    const events: NormalizedEvent[] = [
      toolCall(iso(0), 'read', { files: ['docs/a.md'] }),
      toolCall(iso(5000), 'read', { files: ['docs/b.md'] }),
      toolCall(iso(4000), 'read', { files: ['docs/b.md'] }),
    ];
    const { records } = runDetector([envelope('s2', events)], DEFAULT_CONFIG, false);
    expect(records[0].docs_read).toEqual([
      { path: 'docs/a.md', t: iso(0) },
      { path: 'docs/b.md', t: iso(4000) },
    ]);
  });

  it('8. no doc reads observed → docs_read: [], docs_injected: []', () => {
    const events: NormalizedEvent[] = [
      toolCall(iso(0), 'read', { files: ['src/billing/charge.ts'] }),
      toolCall(iso(1000), 'edit', { files: ['src/billing/charge.ts'], lines_changed: 1 }),
    ];
    const { records } = runDetector([envelope('s3', events)], DEFAULT_CONFIG, false);
    expect(records[0].docs_read).toEqual([]);
    expect(records[0].docs_injected).toEqual([]);
  });

  it('9. degenerateRecord (reflect fail-open path: --latest with no matching session) yields docs_read: [], docs_injected: []', async () => {
    // --latest with no matching session must fail open to a trip:false finding
    // whose record is produced by degenerateRecord (no detection is run). The
    // always-on docs_read / docs_injected fields must both be [] on that record.
    const { repo, claudeDir } = setupTempRepo();
    const result = await runReflect({
      latest: true,
      repo,
      claudeDir,
      format: 'json',
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.output) as ReflectFinding;
    expect(parsed.trip).toBe(false);
    expect(parsed.record.docs_read).toEqual([]);
    expect(parsed.record.docs_injected).toEqual([]);
  });
});
