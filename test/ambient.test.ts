import { describe, it, expect } from 'vitest';
import { assessAmbient, type AmbientSession } from '../src/detector/ambient.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import type { Config } from '../src/types.js';
import type { PreEditOrientation } from '../src/detector/orientation.js';

/**
 * Build N identical AmbientSession literals. Keeps the per-case fixtures
 * terse without hiding the shape under a factory abstraction.
 */
function buildSessions(
  n: number,
  spec: {
    orientation?: PreEditOrientation | null;
    bootstrap_composite?: number;
    bootstrap_flagged?: boolean;
  },
): AmbientSession[] {
  const out: AmbientSession[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      orientation: spec.orientation === undefined ? null : spec.orientation,
      bootstrap_composite: spec.bootstrap_composite ?? 0,
      bootstrap_flagged: spec.bootstrap_flagged ?? false,
    });
  }
  return out;
}

function cfg(): Config {
  return structuredClone(DEFAULT_CONFIG);
}

describe('assessAmbient', () => {
  it('orientation path fires, acute cold → paths=["orientation"], severity high at ratio 1.5', () => {
    // Controller resolution: 20 sessions (≥ severity_min_sessions 20) so the
    // 'high' severity band actually computes instead of being 'unrated'.
    const sessions = buildSessions(20, {
      orientation: { dirBreadth: 6, fileDepth: 18 },
      bootstrap_flagged: false,
    });
    const { finding, baseline } = assessAmbient({
      sessions,
      cfg: cfg(),
      scoringMode: 'bootstrap',
    });

    expect(finding).not.toBeNull();
    expect(finding!.paths).toEqual(['orientation']);
    expect(finding!.severity).toBe('high'); // max(6/4, 18/12) = 1.5 ≥ 1.5
    expect(finding!.kind).toBe('elevated-baseline');
    expect(finding!.sessions_sampled).toBe(20);
    expect(finding!.scoring_mode).toBe('bootstrap');
    expect(finding!.zero_edit_fraction).toBe(0);
    expect(finding!.orientation).not.toBeNull();
    expect(finding!.orientation!.median_dir_breadth).toBe(6);
    expect(finding!.orientation!.median_file_depth).toBe(18);
    expect(finding!.orientation!.with_edit_sessions).toBe(20);

    expect(baseline.state).toBe('elevated');
  });

  it('acute path fires, orientation cold → paths=["acute"], severity high at struggle_rate 1.0', () => {
    // Controller resolution: 20 sessions so severity computes (not unrated).
    const sessions = buildSessions(20, {
      orientation: { dirBreadth: 1, fileDepth: 1 }, // below floors
      bootstrap_flagged: true,
    });
    const { finding, baseline } = assessAmbient({
      sessions,
      cfg: cfg(),
      scoringMode: 'bootstrap',
    });

    expect(finding).not.toBeNull();
    expect(finding!.paths).toEqual(['acute']);
    expect(finding!.severity).toBe('high'); // struggle_rate 1.0 ≥ 0.60
    expect(finding!.acute.struggle_rate).toBe(1);
    expect(finding!.acute.struggle_rate_threshold).toBe(0.3);

    expect(baseline.state).toBe('elevated');
  });

  it('both paths fire → paths=["orientation","acute"] in that order', () => {
    // Brief keeps n=10 here — severity is not asserted, only paths ordering.
    const sessions = buildSessions(10, {
      orientation: { dirBreadth: 6, fileDepth: 18 }, // above floors
      bootstrap_flagged: true, // struggle_rate 1.0
    });
    const { finding, baseline } = assessAmbient({
      sessions,
      cfg: cfg(),
      scoringMode: 'bootstrap',
    });

    expect(finding).not.toBeNull();
    expect(finding!.paths).toEqual(['orientation', 'acute']);
    expect(baseline.state).toBe('elevated');
  });

  it('neither path fires → finding null, state within-norms', () => {
    const sessions = buildSessions(10, {
      orientation: { dirBreadth: 1, fileDepth: 1 }, // below floors
      bootstrap_flagged: false,
    });
    const { finding, baseline } = assessAmbient({
      sessions,
      cfg: cfg(),
      scoringMode: 'bootstrap',
    });

    expect(finding).toBeNull();
    expect(baseline.state).toBe('within-norms');
  });

  it('below min_sessions → finding null even if orientation above floors, state too-few-sessions', () => {
    const sessions = buildSessions(5, {
      orientation: { dirBreadth: 6, fileDepth: 18 },
      bootstrap_flagged: false,
    });
    const { finding, baseline } = assessAmbient({
      sessions,
      cfg: cfg(),
      scoringMode: 'bootstrap',
    });

    expect(finding).toBeNull();
    expect(baseline.state).toBe('too-few-sessions');
  });

  it('zero-edit sessions excluded from orientation median', () => {
    // 6 with-edit (above floors) + 4 zero-edit (orientation null).
    const withEdit = buildSessions(6, {
      orientation: { dirBreadth: 6, fileDepth: 18 },
      bootstrap_flagged: false,
    });
    const zeroEdit = buildSessions(4, {
      orientation: null,
      bootstrap_flagged: false,
    });
    const { finding, baseline } = assessAmbient({
      sessions: [...withEdit, ...zeroEdit],
      cfg: cfg(),
      scoringMode: 'bootstrap',
    });

    expect(finding).not.toBeNull();
    // Median of 6 with-edit values [6,6,6,6,6,6] is 6 — nulls must not corrupt it.
    expect(finding!.orientation!.median_dir_breadth).toBe(6);
    expect(finding!.orientation!.median_file_depth).toBe(18);
    expect(finding!.orientation!.with_edit_sessions).toBe(6);
    expect(finding!.zero_edit_fraction).toBe(0.4);
    expect(baseline.zero_edit_fraction).toBe(0.4);
    expect(baseline.state).toBe('elevated');
  });

  it('all zero-edit → finding null, state orientation-undefined, baseline.orientation null', () => {
    const sessions = buildSessions(10, {
      orientation: null,
      bootstrap_flagged: false,
    });
    const { finding, baseline } = assessAmbient({
      sessions,
      cfg: cfg(),
      scoringMode: 'bootstrap',
    });

    expect(finding).toBeNull();
    expect(baseline.state).toBe('orientation-undefined');
    expect(baseline.orientation).toBeNull();
    expect(baseline.zero_edit_fraction).toBe(1);
  });

  it('severity unrated when n is ≥ min_sessions but < severity_min_sessions', () => {
    // 12 sessions: ≥ 10 (min) but < 20 (severity_min). Orientation above floors.
    const sessions = buildSessions(12, {
      orientation: { dirBreadth: 6, fileDepth: 18 },
      bootstrap_flagged: false,
    });
    const { finding, baseline } = assessAmbient({
      sessions,
      cfg: cfg(),
      scoringMode: 'bootstrap',
    });

    expect(finding).not.toBeNull();
    expect(finding!.severity).toBe('unrated');
    expect(baseline.state).toBe('elevated');
  });

  it('severity medium at orientationRatio 1.25 (dirBreadth 5, floor 4)', () => {
    // 20 sessions; dirBreadth 5 → 5/4 = 1.25, ≥1.2 and <1.5; fileDepth 1 below floor.
    const sessions = buildSessions(20, {
      orientation: { dirBreadth: 5, fileDepth: 1 },
      bootstrap_flagged: false,
    });
    const { finding } = assessAmbient({
      sessions,
      cfg: cfg(),
      scoringMode: 'bootstrap',
    });

    expect(finding).not.toBeNull();
    expect(finding!.severity).toBe('medium');
  });

  it('severity low at orientationRatio 1.0 (dirBreadth 4 fires at floor, <1.2)', () => {
    const sessions = buildSessions(20, {
      orientation: { dirBreadth: 4, fileDepth: 1 },
      bootstrap_flagged: false,
    });
    const { finding } = assessAmbient({
      sessions,
      cfg: cfg(),
      scoringMode: 'bootstrap',
    });

    expect(finding).not.toBeNull();
    expect(finding!.severity).toBe('low');
  });

  it('acute path fires alone when all sessions are zero-edit + acute-hot (spec §10)', () => {
    // All zero-edit (orientation null) + all bootstrap-flagged → the acute path
    // is evaluated alone; the orientation path is cold (no with-edit sessions).
    const sessions = buildSessions(20, {
      orientation: null,
      bootstrap_flagged: true,
    });
    const { finding, baseline } = assessAmbient({
      sessions,
      cfg: cfg(),
      scoringMode: 'bootstrap',
    });

    expect(baseline.state).toBe('elevated');
    expect(finding).not.toBeNull();
    expect(finding!.paths).toEqual(['acute']);
    expect(finding!.severity).toBe('high'); // struggle_rate 1.0 ≥ 0.60
    expect(finding!.orientation).toBeNull();
    expect(finding!.zero_edit_fraction).toBe(1);
  });
});
