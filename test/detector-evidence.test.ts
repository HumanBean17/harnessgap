// Task 4: opt-in evidence collection through the detector. Validates the
// byte-identical default invariant — `StruggleRecord.evidence` is present ONLY
// when `collectEvidence: true` is passed; otherwise the field is absent from
// the serialized JSON (not undefined-as-a-key, not null — absent).

import { describe, it, expect } from 'vitest';
import { runDetector } from '../src/detector/index.js';
import { assembleStruggleRecord } from '../src/detector/record.js';
import { computeEvidence } from '../src/diagnoser/evidence.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import type {
  NormalizedEnvelope,
  NormalizedEvent,
  SessionEvidence,
  SignalValues,
} from '../src/types.js';

/** Build a tool_call event with a normalized shape. */
function toolCall(
  t: string,
  events: { tool: 'edit' | 'exec'; files?: string[]; cmd?: string | null; ok?: boolean },
): NormalizedEvent {
  return {
    t,
    kind: 'tool_call',
    tool: events.tool,
    input_digest: {
      files: events.files ?? [],
      cmd: events.cmd ?? null,
      query: null,
      lines_changed: null,
    },
    ok: events.ok ?? true,
    interrupted: false,
    duration_ms: 0,
    correction: null,
  };
}

/** Build a NormalizedEnvelope with sensible defaults. */
function envelope(session_id: string, events: NormalizedEvent[]): NormalizedEnvelope {
  return {
    schema_version: 1,
    session_id,
    agent: 'claude-code',
    repo: 'test/repo',
    started_at: events.length > 0 ? events[0].t : '2026-07-12T12:00:00.000Z',
    duration_ms: 0,
    events,
    truncated: false,
    event_count: events.length,
  };
}

/** Zero signal values used as input to assembleStruggleRecord in unit tests. */
const ZERO_SIGNALS: SignalValues = {
  explore_ratio: null,
  reread: 0,
  failure_streak: 0,
  corrections: 0,
  abandonment: false,
  oscillation: 0,
  wall_clock_per_line_ms: null,
};

const SAMPLE_EVIDENCE: SessionEvidence = {
  failures: { config: 1, test: 2, build: 0, other: 0 },
  edit_kinds: { test: 1, code: 3, other: 0 },
};

describe('assembleStruggleRecord — evidence projection', () => {
  it('(a) when evidence is passed, record.evidence equals it', () => {
    const env = envelope('s1', []);
    const record = assembleStruggleRecord(
      env,
      ZERO_SIGNALS,
      { score_pct: 0, mode: 'bootstrap', flagged: false, composite: 0 },
      [],
      // Closed-loop MVP: docs_read/docs_injected now sit between `areas` and
      // `evidence` on assembleStruggleRecord's signature. Both required; pass
      // empty arrays here (this unit test is about evidence projection).
      [],
      [],
      SAMPLE_EVIDENCE,
    );
    expect(record.evidence).toStrictEqual(SAMPLE_EVIDENCE);
  });

  it('(b) when evidence is omitted, record.evidence is undefined AND JSON.stringify has no "evidence" key', () => {
    const env = envelope('s1', []);
    const record = assembleStruggleRecord(
      env,
      ZERO_SIGNALS,
      { score_pct: 0, mode: 'bootstrap', flagged: false, composite: 0 },
      [],
      [],
      [],
    );
    expect(record.evidence).toBeUndefined();
    const json = JSON.stringify(record);
    expect(json).not.toContain('"evidence"');
    // Stronger: parsing the JSON yields an object without the key at all.
    expect(JSON.parse(json)).not.toHaveProperty('evidence');
  });
});

describe('runDetector — collectEvidence opt-in', () => {
  // Events: one failed npm test (test-class failure) + one edit touching two
  // code files → evidence has test:1 failure and code:2 edits.
  const events: NormalizedEvent[] = [
    toolCall('2026-07-12T12:00:00.000Z', { tool: 'exec', cmd: 'npm test', ok: false }),
    toolCall('2026-07-12T12:00:01.000Z', { tool: 'edit', files: ['src/a.ts', 'src/b.ts'] }),
  ];
  const env = envelope('s1', events);

  it('(b1) with opts.collectEvidence === true → record.evidence is populated and matches computeEvidence', () => {
    const expected = computeEvidence(events, DEFAULT_CONFIG.areas.test_cmd_patterns);
    const { records } = runDetector([env], DEFAULT_CONFIG, false, { collectEvidence: true });
    expect(records[0].evidence).toStrictEqual(expected);
    // Targeted spot-checks so a future computeEvidence regression is caught.
    expect(records[0].evidence?.failures.test).toBe(1);
    expect(records[0].evidence?.edit_kinds.code).toBe(2);
  });

  it('(b2) with no opts → record.evidence is undefined (default path)', () => {
    const { records } = runDetector([env], DEFAULT_CONFIG, false);
    expect(records[0].evidence).toBeUndefined();
  });

  it('(b3) with opts.collectEvidence === false → record.evidence is undefined', () => {
    const { records } = runDetector([env], DEFAULT_CONFIG, false, { collectEvidence: false });
    expect(records[0].evidence).toBeUndefined();
  });

  it('(c) default-path record serializes without an "evidence" key (byte-identical invariant)', () => {
    const { records } = runDetector([env], DEFAULT_CONFIG, false);
    const json = JSON.stringify(records[0]);
    expect(json).not.toContain('"evidence"');
    expect(JSON.parse(json)).not.toHaveProperty('evidence');
  });

  it('(c2) collectEvidence:true record DOES serialize with an "evidence" key', () => {
    const { records } = runDetector([env], DEFAULT_CONFIG, false, { collectEvidence: true });
    const json = JSON.stringify(records[0]);
    expect(json).toContain('"evidence"');
    expect(JSON.parse(json)).toHaveProperty('evidence');
  });

  it('multiple envelopes: evidence is computed per-envelope (not shared)', () => {
    const envA = envelope(
      'a',
      [toolCall('2026-07-12T12:00:00.000Z', { tool: 'exec', cmd: 'npm test', ok: false })],
    );
    const envB = envelope(
      'b',
      [toolCall('2026-07-12T12:00:00.000Z', { tool: 'edit', files: ['src/x.ts'] })],
    );
    const { records } = runDetector([envA, envB], DEFAULT_CONFIG, false, {
      collectEvidence: true,
    });
    expect(records[0].evidence?.failures.test).toBe(1);
    expect(records[0].evidence?.edit_kinds.code).toBe(0);
    expect(records[1].evidence?.failures.test).toBe(0);
    expect(records[1].evidence?.edit_kinds.code).toBe(1);
  });
});
