// Shared type catalog for harnessgap. Every later task imports from here.
// Field names and shapes are contracts pinned to the design spec.

export type ToolKind = 'read' | 'search' | 'list' | 'edit' | 'exec' | 'other';

export type EventKind = 'user_msg' | 'assistant_msg' | 'tool_call';

export type SignalName =
  | 'explore_ratio'
  | 'reread'
  | 'failure_streak'
  | 'corrections'
  | 'abandonment'
  | 'oscillation'
  | 'wall_clock_per_line';

export type ScoringMode = 'percentile' | 'bootstrap';

// Ambient-struggle (Slice 2) foundation types. Field names are contracts pinned
// to the §7 design spec; later tasks import these verbatim.

export type Severity = 'high' | 'medium' | 'low' | 'unrated';

export type BaselinePath = 'orientation' | 'acute';

export type BaselineState =
  | 'elevated'
  | 'within-norms'
  | 'too-few-sessions'
  | 'orientation-undefined';

export interface BaselineAssessment {
  state: BaselineState;
  sessions_sampled: number;
  scoring_mode: ScoringMode;
  orientation: {
    median_dir_breadth: number;
    median_file_depth: number;
    breadth_floor: number;
    file_depth_floor: number;
    with_edit_sessions: number;
  } | null;
  zero_edit_fraction: number;
  acute: { struggle_rate: number; struggle_rate_threshold: number };
}

export interface RepoFinding {
  kind: 'elevated-baseline';
  severity: Severity;
  paths: BaselinePath[];
  sessions_sampled: number;
  scoring_mode: ScoringMode;
  orientation: {
    median_dir_breadth: number;
    median_file_depth: number;
    breadth_floor: number;
    file_depth_floor: number;
    with_edit_sessions: number;
  } | null;
  zero_edit_fraction: number;
  acute: { struggle_rate: number; struggle_rate_threshold: number };
}

export interface InputDigest {
  files: string[];
  cmd: string | null;
  query: string | null;
  lines_changed: number | null;
}

export interface Correction {
  matched: boolean;
  shape: string | null;
}

export interface NormalizedEvent {
  t: string;
  kind: EventKind;
  tool: ToolKind | null;
  input_digest: InputDigest;
  ok: boolean;
  interrupted: boolean;
  duration_ms: number;
  correction: Correction | null;
}

export interface NormalizedEnvelope {
  schema_version: 1;
  session_id: string;
  agent: 'claude-code';
  repo: string;
  started_at: string;
  duration_ms: number;
  events: NormalizedEvent[];
  truncated: boolean;
  event_count: number;
}

// null = not computable, e.g. no edits -> wall_clock_per_line_ms and explore_ratio
export interface SignalValues {
  explore_ratio: number | null;
  reread: number;
  failure_streak: number;
  corrections: number;
  abandonment: boolean;
  oscillation: number;
  wall_clock_per_line_ms: number | null;
}

export interface StruggleRecord {
  session_id: string;
  repo: string;
  started_at: string;
  duration_ms: number;
  score_pct: number;
  mode: ScoringMode;
  flagged: boolean;
  truncated: boolean;
  event_count: number;
  areas: { key: string; weight: number }[];
  signals: SignalValues;
}

export interface Warnings {
  malformed_lines: number;
  oversized_lines: number;
  skipped_sessions: number;
  truncated_sessions: number;
  symlinks_rejected: number;
  unresolvable_cwd: number;
}

export interface AreaRow {
  key: string;
  sessions_total: number;
  sessions_flagged: number;
  mean_score: number;
  top_signals: { name: SignalName; value: number | boolean; display: string }[];
}

export interface JsonOutput {
  schema_version: 1;
  repo: string;
  mode: ScoringMode;
  session_count: number;
  warnings: Warnings;
  sessions: StruggleRecord[];
  areas: AreaRow[];
  repo_findings: RepoFinding[];
}

export interface Config {
  detector: {
    thresholds_as: 'percentile' | 'absolute';
    flag_pct: number;
    bootstrap_session_floor: number;
    bootstrap_flag_pct: number;
    reread_threshold: number;
    correction_window_ms: number;
    signal_weights: Record<SignalName, number>;
    bootstrap_thresholds: {
      explore_ratio: number;
      reread: number;
      failure_streak: number;
      corrections: number;
      abandonment: boolean;
      oscillation: number;
      wall_clock_per_line_ms: number;
    };
    ambient: {
      breadth_floor: number;
      file_depth_floor: number;
      struggle_rate_threshold: number;
      min_sessions: number;
      severity_min_sessions: number;
    };
  };
  areas: {
    ignore: string[];
    min_weight: number;
    min_depth: number;
    touch_weights: { edit: number; read: number; exec: number };
    tail_fraction: number;
    explore_ratio_min: number;
    suppress_abandonment_when_no_exec: boolean;
    test_cmd_patterns: string[];
  };
}
