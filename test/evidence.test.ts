import { describe, it, expect } from 'vitest';
import { computeEvidence } from '../src/diagnoser/evidence.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import type { NormalizedEvent, ToolKind } from '../src/types.js';

// Verbatim from `cfg.areas.test_cmd_patterns` (src/config.ts). Imported here so
// the "defaults" cases stay grounded to the real configuration the detector
// uses, rather than a hand-maintained duplicate.
const DEFAULTS = DEFAULT_CONFIG.areas.test_cmd_patterns;

/** Build a tool_call event with a normalized shape and per-tool digest fields. */
function toolCall(
  t: string,
  tool: ToolKind,
  opts: {
    files?: string[];
    cmd?: string | null;
    ok?: boolean;
  } = {},
): NormalizedEvent {
  return {
    t,
    kind: 'tool_call',
    tool,
    input_digest: {
      files: opts.files ?? [],
      cmd: opts.cmd ?? null,
      query: null,
      lines_changed: null,
    },
    ok: opts.ok ?? true,
    interrupted: false,
    duration_ms: 0,
    correction: null,
  };
}

const ZERO_EVIDENCE = {
  failures: { config: 0, test: 0, build: 0, other: 0 },
  edit_kinds: { test: 0, code: 0, other: 0 },
};

describe('computeEvidence — pure evidence projection', () => {
  it('(a) failed npm test + failed npm install + successful exec → failures {config:1, test:1, build:0, other:0}', () => {
    const events: NormalizedEvent[] = [
      toolCall('t0', 'exec', { cmd: 'npm test', ok: false }),
      toolCall('t1', 'exec', { cmd: 'npm install', ok: false }),
      toolCall('t2', 'exec', { cmd: 'npm test', ok: true }), // success → ignored
    ];
    const result = computeEvidence(events, DEFAULTS);
    expect(result.failures).toStrictEqual({
      config: 1,
      test: 1,
      build: 0,
      other: 0,
    });
    // No edits → edit_kinds fully zero-filled.
    expect(result.edit_kinds).toStrictEqual({ test: 0, code: 0, other: 0 });
  });

  it('(b) one edit touching a.ts (code) + b.test.ts (test) → edit_kinds {test:1, code:1, other:0}', () => {
    const events: NormalizedEvent[] = [
      toolCall('t0', 'edit', { files: ['src/a.ts', 'src/b.test.ts'] }),
    ];
    const result = computeEvidence(events, DEFAULTS);
    expect(result.edit_kinds).toStrictEqual({ test: 1, code: 1, other: 0 });
    // No failed execs → failures fully zero-filled.
    expect(result.failures).toStrictEqual({
      config: 0,
      test: 0,
      build: 0,
      other: 0,
    });
  });

  it('(c) read/search events contribute nothing', () => {
    const events: NormalizedEvent[] = [
      toolCall('t0', 'read', { files: ['src/a.ts'] }),
      toolCall('t1', 'search', { cmd: 'npm test' }), // search has no failure bucket
      toolCall('t2', 'read', { files: ['README.md'] }),
    ];
    const result = computeEvidence(events, DEFAULTS);
    expect(result).toStrictEqual(ZERO_EVIDENCE);
  });

  it('(d) failed exec with cmd === null is skipped (counted nowhere)', () => {
    const events: NormalizedEvent[] = [
      toolCall('t0', 'exec', { cmd: null, ok: false }),
      // Sanity: a real failed exec next to it still counts.
      toolCall('t1', 'exec', { cmd: 'npm test', ok: false }),
    ];
    const result = computeEvidence(events, DEFAULTS);
    expect(result.failures).toStrictEqual({
      config: 0,
      test: 1,
      build: 0,
      other: 0,
    });
  });

  it('(e) empty events → all buckets zero', () => {
    const result = computeEvidence([], DEFAULTS);
    expect(result).toStrictEqual(ZERO_EVIDENCE);
  });

  it('does not mutate inputs', () => {
    const events: NormalizedEvent[] = [
      toolCall('t0', 'exec', { cmd: 'npm test', ok: false }),
      toolCall('t1', 'edit', { files: ['a.ts'] }),
    ];
    const snapshot = JSON.parse(JSON.stringify(events));
    computeEvidence(events, DEFAULTS);
    expect(JSON.parse(JSON.stringify(events))).toStrictEqual(snapshot);
  });
});
