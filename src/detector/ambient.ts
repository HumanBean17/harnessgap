// Ambient baseline assessor (Slice 2, Task 4).
//
// Pure function: no I/O, no mutation of inputs. Decides whether a repo shows
// elevated baseline orientation overhead by combining two independent signals:
//
//   - orientation path: median pre-edit dir-breadth / file-depth across
//     with-edit sessions exceeds a floor (the agent dives in too often without
//     scoping the surrounding code).
//   - acute path: bootstrap struggle_rate ≥ threshold (too many individual
//     sessions flag as a struggle even when orientation looks normal).
//
// Contract pinned to the §7 design spec; the detector wiring task consumes
// the `RepoFinding` / `BaselineAssessment` this emits verbatim.

import type {
  BaselineAssessment,
  BaselinePath,
  BaselineState,
  Config,
  RepoFinding,
  ScoringMode,
  Severity,
} from '../types.js';
import type { PreEditOrientation } from './orientation.js';

export interface AmbientSession {
  orientation: PreEditOrientation | null;
  bootstrap_composite: number;
  bootstrap_flagged: boolean;
}

export interface AmbientResult {
  finding: RepoFinding | null;
  baseline: BaselineAssessment;
}

/**
 * Median of a numeric array: sort ascending; middle element if odd length;
 * mean of the two middle elements if even; `0` for empty input.
 */
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Assess the ambient baseline over a batch of per-session ambient metrics.
 *
 * Returns `{ finding, baseline }`. `baseline` is always populated. `finding`
 * is non-null only when `baseline.state === 'elevated'`. The two-path decision
 * (orientation, acute) and severity bands follow the §7 contract verbatim.
 */
export function assessAmbient(input: {
  sessions: AmbientSession[];
  cfg: Config;
  scoringMode: ScoringMode;
}): AmbientResult {
  const { sessions, cfg, scoringMode } = input;
  const {
    breadth_floor,
    file_depth_floor,
    struggle_rate_threshold,
    min_sessions,
    severity_min_sessions,
  } = cfg.detector.ambient;

  // Step 1 — counts.
  const n = sessions.length;
  const withEdit = sessions.filter((s) => s.orientation !== null);
  const zero_edit_fraction = n > 0 ? (n - withEdit.length) / n : 0;

  // Step 2 — acute struggle rate.
  const struggle_rate =
    n > 0 ? sessions.filter((s) => s.bootstrap_flagged).length / n : 0;

  // Step 3 — median_composite intentionally omitted: no downstream field on
  // RepoFinding / BaselineAssessment consumes it (controller resolution).

  // Step 4 — orientation medians (only when ≥1 with-edit session).
  let median_dir_breadth: number | undefined;
  let median_file_depth: number | undefined;
  if (withEdit.length >= 1) {
    median_dir_breadth = median(
      withEdit.map((s) => (s.orientation as PreEditOrientation).dirBreadth),
    );
    median_file_depth = median(
      withEdit.map((s) => (s.orientation as PreEditOrientation).fileDepth),
    );
  }

  // Step 6 — path firing.
  const orientationPath =
    withEdit.length >= 1 &&
    (median_dir_breadth! >= breadth_floor ||
      median_file_depth! >= file_depth_floor);
  const acutePath = struggle_rate >= struggle_rate_threshold;

  // Step 7 — baseline state.
  let state: BaselineState;
  if (n < min_sessions) {
    state = 'too-few-sessions';
  } else if (orientationPath || acutePath) {
    state = 'elevated';
  } else if (withEdit.length === 0) {
    state = 'orientation-undefined';
  } else {
    state = 'within-norms';
  }

  // Shared orientation block: null only when there are zero with-edit sessions.
  const orientationBlock =
    median_dir_breadth !== undefined && median_file_depth !== undefined
      ? {
          median_dir_breadth,
          median_file_depth,
          breadth_floor,
          file_depth_floor,
          with_edit_sessions: withEdit.length,
        }
      : null;

  const acuteBlock = { struggle_rate, struggle_rate_threshold };

  // Step 8 — finding (only when elevated).
  let finding: RepoFinding | null = null;
  if (state === 'elevated') {
    // paths: orientation first, acute second.
    const paths: BaselinePath[] = [];
    if (orientationPath) paths.push('orientation');
    if (acutePath) paths.push('acute');

    let severity: Severity;
    if (n < severity_min_sessions) {
      severity = 'unrated';
    } else {
      const orientationRatio =
        withEdit.length >= 1
          ? Math.max(
              median_dir_breadth! / breadth_floor,
              median_file_depth! / file_depth_floor,
            )
          : 0;
      if (orientationRatio >= 1.5 || struggle_rate >= 0.6) {
        severity = 'high';
      } else if (orientationRatio >= 1.2 || struggle_rate >= 0.45) {
        severity = 'medium';
      } else {
        severity = 'low';
      }
    }

    finding = {
      kind: 'elevated-baseline',
      severity,
      paths,
      sessions_sampled: n,
      scoring_mode: scoringMode,
      orientation: orientationBlock,
      zero_edit_fraction,
      acute: acuteBlock,
    };
  }

  // Step 9 — baseline (always built).
  const baseline: BaselineAssessment = {
    state,
    sessions_sampled: n,
    scoring_mode: scoringMode,
    orientation: orientationBlock,
    zero_edit_fraction,
    acute: acuteBlock,
  };

  return { finding, baseline };
}
