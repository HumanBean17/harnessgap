import { describe, it, expect } from 'vitest';
import { computePreEditOrientation } from '../src/detector/orientation.js';
import type { NormalizedEvent, ToolKind } from '../src/types.js';

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

/** Convenience: read tool_call with files. */
function read(t: string, ...files: string[]): NormalizedEvent {
  return toolCall(t, 'read', { files });
}

/** Convenience: edit tool_call with files. */
function edit(t: string, ...files: string[]): NormalizedEvent {
  return toolCall(t, 'edit', { files });
}

describe('computePreEditOrientation', () => {
  it('counts distinct read files and distinct depth-2 dir prefixes before first edit', () => {
    const events: NormalizedEvent[] = [
      read('t1', 'src/a/x.ts'),
      read('t2', 'src/a/y.ts'),
      read('t3', 'src/b/z.ts'),
      edit('t4', 'src/a/x.ts'),
    ];
    expect(computePreEditOrientation(events)).toEqual({
      dirBreadth: 2,
      fileDepth: 3,
    });
  });

  it('excludes reads that happen after the first edit', () => {
    const events: NormalizedEvent[] = [
      read('t1', 'src/a/x.ts'),
      edit('t2', 'src/a/x.ts'),
      read('t3', 'src/c/q.ts'),
      read('t4', 'src/c/r.ts'),
    ];
    expect(computePreEditOrientation(events)).toEqual({
      dirBreadth: 1,
      fileDepth: 1,
    });
  });

  it('returns null for a zero-edit session (reads only)', () => {
    const events: NormalizedEvent[] = [
      read('t1', 'src/a/x.ts'),
      read('t2', 'src/b/y.ts'),
    ];
    expect(computePreEditOrientation(events)).toBeNull();
  });

  it('returns {0,0} when an edit has no preceding reads', () => {
    const events: NormalizedEvent[] = [edit('t1', 'src/a/x.ts')];
    expect(computePreEditOrientation(events)).toEqual({
      dirBreadth: 0,
      fileDepth: 0,
    });
  });

  it('uses the whole segment for single-segment paths (e.g. README.md)', () => {
    const events: NormalizedEvent[] = [
      read('t1', 'README.md'),
      edit('t2', 'README.md'),
    ];
    expect(computePreEditOrientation(events)).toEqual({
      dirBreadth: 1,
      fileDepth: 1,
    });
  });

  it('collapses 4 files in the same depth-2 dir to dirBreadth=1, fileDepth=4', () => {
    const events: NormalizedEvent[] = [
      read('t1', 'src/a/1.ts'),
      read('t2', 'src/a/2.ts'),
      read('t3', 'src/a/3.ts'),
      read('t4', 'src/a/4.ts'),
      edit('t5', 'src/a/1.ts'),
    ];
    expect(computePreEditOrientation(events)).toEqual({
      dirBreadth: 1,
      fileDepth: 4,
    });
  });

  it('does not mutate the input array', () => {
    const events: NormalizedEvent[] = [
      read('t1', 'src/a/x.ts'),
      edit('t2', 'src/a/x.ts'),
    ];
    const snapshot = JSON.parse(JSON.stringify(events));
    computePreEditOrientation(events);
    expect(events).toEqual(snapshot);
  });

  it('returns null for an empty event stream', () => {
    expect(computePreEditOrientation([])).toBeNull();
  });
});
