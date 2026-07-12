import { describe, it, expect } from 'vitest';
import { localizeAreas } from '../src/detector/areas.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import type { Config, NormalizedEvent, ToolKind } from '../src/types.js';

/** Build a tool_call event with the given files in its digest. */
function toolCall(
  tool: ToolKind,
  files: string[],
  opts: { ok?: boolean; cmd?: string | null } = {},
): NormalizedEvent {
  return {
    t: '2024-01-01T00:00:00Z',
    kind: 'tool_call',
    tool,
    input_digest: {
      files,
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

/** Config with overridden areas fields; defaults for everything else. */
function cfg(overrides: Partial<Config['areas']> = {}): Config {
  return { ...DEFAULT_CONFIG, areas: { ...DEFAULT_CONFIG.areas, ...overrides } };
}

describe('localizeAreas — path-prefix area clustering', () => {
  it('1. two edit files under src/billing → src/billing qualifies at weight 1.0', () => {
    const events = [
      toolCall('edit', ['src/billing/charge.ts']),
      toolCall('edit', ['src/billing/refund.ts']),
    ];
    expect(localizeAreas(events, cfg())).toEqual([
      { key: 'src/billing', weight: 1.0 },
    ]);
  });

  it('2. deeper qualifying dirs shadow their shallower ancestor', () => {
    const events = [
      toolCall('edit', ['src/billing/charge/a.ts']),
      toolCall('edit', ['src/billing/refund/b.ts']),
    ];
    expect(localizeAreas(events, cfg())).toEqual([
      { key: 'src/billing/charge', weight: 0.5 },
      { key: 'src/billing/refund', weight: 0.5 },
    ]);
  });

  it('3. ignored path (node_modules) contributes no weight; alone → []', () => {
    const events = [toolCall('edit', ['node_modules/pkg/x.ts'])];
    expect(localizeAreas(events, cfg())).toEqual([]);
  });

  it('4. a single depth-1 file (README.md) → [] (below min_depth)', () => {
    const events = [toolCall('edit', ['README.md'])];
    expect(localizeAreas(events, cfg())).toEqual([]);
  });

  it('5. a dir capturing 0.30 of weight is excluded; none qualify → []', () => {
    // src/a captures 3 of 10 total = 0.30 < 0.40; remaining weight is in
    // depth-1 files (no qualifying directory).
    const events = [
      toolCall('edit', ['src/a/x.ts']), // 3
      toolCall('edit', ['top1.ts']), // 3, depth-1 file (no ancestor dir)
      toolCall('read', ['top2.ts']), // 2, depth-1 file
      toolCall('read', ['top3.ts']), // 2, depth-1 file
    ];
    expect(localizeAreas(events, cfg())).toEqual([]);
  });

  it('6. exec contributes touch_weights.exec (1) per file in its digest', () => {
    // edit(3) under src/edit + exec(1) under src/run; total 4.
    // src/edit = 0.75 (qualifies); src/run = 0.25 (< 0.40, excluded).
    // If exec wrongly applied weight 3, src/run would be 0.5 and qualify too.
    const events = [
      toolCall('edit', ['src/edit/x.ts']),
      toolCall('exec', ['src/run/y.sh']),
    ];
    expect(localizeAreas(events, cfg())).toEqual([
      { key: 'src/edit', weight: 0.75 },
    ]);
  });
});
