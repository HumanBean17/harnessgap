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

// Multi-harness dispatch seam (Qwen Code + GigaCode slice, Task 1). The
// contracts below are pinned verbatim against the slice spec; later tasks
// consume them via the HarnessSpec registry and adapter selectors. Field
// names are contracts — do not rename.

/** The closed set of harness backends harnessgap can read transcripts from. */
export type HarnessId = 'claude-code' | 'qwen-code' | 'gigacode';

/**
 * On-disk transcript layout for a harness. `projectsSegment` is the literal
 * directory name; `sessionSubdir` is optional (present for Claude Code's
 * `projects/<proj>/chats` layout, absent for flatter layouts); `extension`
 * is pinned to `.jsonl` for v1.
 */
export interface TranscriptLayout {
  projectsSegment: 'projects';
  sessionSubdir?: 'chats';
  extension: '.jsonl';
}

/**
 * Closed enumeration of the seven behavioral axes a harness may or may not
 * support. Keys are contracts — later tasks index `CapabilityMatrix` by them.
 */
export type CapabilityKey =
  | 'sessionDiscovery'
  | 'streamFormat'
  | 'finalizationSignal'
  | 'interruption'
  | 'fileChangeEvidence'
  | 'resume'
  | 'perPromptContextInjection';

/** Per-harness capability state; every `CapabilityKey` must be present. */
export type CapabilityMatrix = Record<CapabilityKey, 'supported' | 'pending'>;

/**
 * Return value of `HarnessSpec.installHook`. `artifacts` are the repo-relative
 * (or absolute) paths of files written during install; `settingsBackupPath`
 * is present only when an existing settings file was backed up; `degraded`
 * flags environments where the hook cannot be installed (e.g. unsupported
 * harness); `message` is a single-line human-readable status.
 */
export interface InitResult {
  harness: HarnessId;
  artifacts: string[];
  settingsBackupPath?: string;
  degraded: boolean;
  message: string;
}

/**
 * The dispatch seam: each harness backend implements this interface. The
 * registry (added in a later task) selects a spec by `id`. `defaultRootDir`
 * is a function so the spec can defer filesystem/env reads until invoked
 * (no I/O at module load). Stream/install are stubs filled in by later
 * tasks — declared here so consumers can program against the seam today.
 *
 * `streamSession` is async because every real implementation reads a file
 * (Claude's `src/adapter/stream.ts`, Qwen/GigaCode's `src/adapter/qwen/stream.ts`).
 * The Task-1 contract wrote `: NormalizedEnvelope` (sync); Task 7 widens it to
 * `Promise<NormalizedEnvelope>` so the existing async readers attach to the
 * spec without a redundant sync wrapper. The return is the envelope alone —
 * Claude's richer `{envelope, cwd, cwds, warnings}` shape is reduced to the
 * envelope by the spec (the cwd/warnings path is still available via the
 * underlying `streamSession` import for `src/pipeline.ts` until Task 10
 * migrates it to program against the spec).
 */
export interface HarnessSpec {
  id: HarnessId;
  displayName: string;
  defaultRootDir(): string;
  layout: TranscriptLayout;
  streamSession(filePath: string): Promise<NormalizedEnvelope>;
  installHook(opts: { cwd: string }): InitResult;
  capabilities: CapabilityMatrix;
}

export interface NormalizedEnvelope {
  schema_version: 1;
  session_id: string;
  agent: HarnessId;
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
  // Slice 4 (Diagnoser): populated only under `--diagnose`; absent otherwise
  // so default output stays byte-identical.
  evidence?: SessionEvidence;
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
  // Slice 4 (Diagnoser): emitted only under `--diagnose`; absent otherwise so
  // default output stays byte-identical.
  diagnoses?: Diagnosis[];
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
  // Slice 4 (Diagnoser) config. `docs_dirs` is the list of repo-relative
  // paths searched for doc-existence grounding; `diagnose` holds the rule
  // floors used by the classifier (§5.4, §6).
  docs_dirs: string[];
  diagnose: {
    confidence_floor: number;
    config_share_floor: number;
    test_share_floor: number;
    code_share_floor: number;
    score_floor: number;
  };
}

// Diagnoser (Slice 4) foundation types. Field names are contracts pinned to
// the §5 design spec; later tasks import these verbatim. Populated only under
// `scan --diagnose`; absent otherwise so default output stays byte-identical.

/** Failed-exec bucket key (cmd-class) used by `SessionEvidence.failures`. */
export type CmdClass = 'config' | 'test' | 'build' | 'other';

/** Edited-file bucket key (file-class) used by `SessionEvidence.edit_kinds`. */
export type FileClass = 'test' | 'code' | 'other';

/** The closed cause taxonomy emitted by the Diagnoser rule engine (§6). */
export type Cause =
  | 'doc'
  | 'config-doc'
  | 'test-gap'
  | 'refactor-flag'
  | 'inherent-complexity'
  | 'unclassified';

/**
 * Failed-exec counts by cmd-class and edited-file counts by file-class.
 * Computed in the detector alongside the signals; populated only under
 * `--diagnose`. Counts are integers; scrubbing and size caps are reused
 * (cmds/files are already scrubbed/capped in the adapter).
 */
export interface SessionEvidence {
  failures: { config: number; test: number; build: number; other: number };
  edit_kinds: { test: number; code: number; other: number };
}

/**
 * Closed union of evidence pointers a `Diagnosis` may cite (§5.2). Every leaf
 * is derived-only — signal values, integer counts, ratios, doc paths — never
 * transcript prose, file bodies, or commands.
 */
export type EvidenceRef =
  | { kind: 'signal'; name: SignalName; value: number | boolean }
  | { kind: 'doc_absent'; checked: string[] }
  | { kind: 'doc_present'; path: string }
  | {
      kind: 'failure_profile';
      config: number;
      test: number;
      build: number;
      other: number;
    }
  | { kind: 'edit_profile'; test: number; code: number; other: number };

/**
 * One Diagnoser output per flagged area (§5.2). `unit.kind` is `'area'` for
 * the v1 batch classifier; `confidence` is in [0,1]; `rationale` and every
 * `evidence_refs` leaf are derived-only.
 */
export interface Diagnosis {
  unit: { kind: 'area'; key: string };
  cause: Cause;
  confidence: number;
  rationale: string;
  evidence_refs: EvidenceRef[];
}

/**
 * Session-end reflect finding: the pure decision artifact built from one
 * `StruggleRecord`. `trip` is the derived block decision; the record reference
 * is carried through unchanged. schema_version is pinned to 1.
 */
export interface ReflectFinding {
  schema_version: 1;
  session_id: string;
  repo: string;
  mode: ScoringMode;
  record: StruggleRecord;
  trip: boolean;
  zero_edit: boolean;
}

/**
 * The payload a Claude Code `Stop` hook accepts. Two forms: the block form
 * `{ decision: 'block', reason }` asks the agent to reflect; the allow form is
 * a literal empty object `{}`. Expressed with optional fields so both shapes
 * are assignable — callers must return either `{}` or a fully-populated block
 * object, never a partial block.
 */
export interface StopHookOutput {
  decision?: 'block';
  reason?: string;
}

/**
 * Documented contract for the `/reflect` command's manual frame — produced by
 * the agent, never emitted by the binary. Defined here so the command and tests
 * share one shape.
 */
export interface ReflectFrame {
  cost: string;
  missing: string;
  change: {
    target_path: string;
    kind: 'add' | 'improve' | 'none';
    rationale: string;
  };
  path_verified: boolean;
}
