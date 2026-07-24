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
 * directory name; `sessionSubdir` is optional (ABSENT for Claude Code's flat
 * `projects/<proj>/*.jsonl` layout, PRESENT for the Qwen/GigaCode
 * `projects/<proj>/chats/*.jsonl` layout); `extension` is pinned to `.jsonl`
 * for v1. See `src/adapter/index.ts` CLAUDE_LAYOUT vs CHATS_LAYOUT.
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
 * The Task-1 contract wrote `: NormalizedEnvelope` (sync); the original
 * Task-7 widening reduced it to `Promise<NormalizedEnvelope>`. The current
 * shape is `Promise<StreamResult>` — the full `{envelope, cwd, cwds, warnings}`
 * value the streaming readers already produce — so the pipeline can program
 * against `spec.streamSession` (Task 10) without a shape reduction and the
 * cwd/cwds/warnings paths stay available through the spec (not only via the
 * direct `streamSession` import).
 */
export interface HarnessSpec {
  id: HarnessId;
  displayName: string;
  defaultRootDir(): string;
  layout: TranscriptLayout;
  streamSession(filePath: string): Promise<StreamResult>;
  installHook(opts: { cwd: string }): InitResult;
  capabilities: CapabilityMatrix;
}

/**
 * Per-session streaming warnings — the subset of {@link Warnings} a single
 * `streamSession` call can compute. The remaining `Warnings` fields
 * (`skipped_sessions`, `symlinks_rejected`, `unresolvable_cwd`) are
 * pipeline-level aggregates computed by the caller across the whole scan,
 * not by any one stream. Field names/types are pinned verbatim to what
 * Claude's `src/adapter/stream.ts` emits.
 */
export type StreamWarnings = Pick<
  Warnings,
  'malformed_lines' | 'oversized_lines' | 'truncated_sessions'
>;

/**
 * Return value of `HarnessSpec.streamSession`. Mirrors Claude's
 * `src/adapter/stream.ts` streamSession shape verbatim — same field names and
 * types — so the Claude implementation conforms by construction and Task 10
 * can migrate the pipeline to `spec.streamSession` mechanically.
 *
 *  - `envelope`: the normalized session envelope (events, span, agent stamp).
 *  - `cwd`: representative cwd = first distinct cwd seen (empty when none).
 *  - `cwds`: all distinct cwds seen across records, in first-seen order. The
 *    pipeline tries each for repo/worktree resolution so a session that
 *    started in a live dir and later moved into a since-deleted worktree
 *    still resolves.
 *  - `warnings`: per-session counters (malformed/oversized lines, truncated).
 */
export interface StreamResult {
  envelope: NormalizedEnvelope;
  cwd: string;
  cwds: string[];
  warnings: StreamWarnings;
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
  // Closed-loop MVP (always-on): doc-read events and doc-injection events
  // observed in this session. Required (no `?`) — the detector populates
  // these on every record, empty when none were observed — so the
  // synthesizer/fact-check stages can rely on them without a sentinel. This
  // is deliberately NOT under the `evidence?`/`diagnoses?` conditional-opt
  // pattern: those remain absent in default output, while docs_read /
  // docs_injected are part of the always-emitted shape.
  docs_read: DocRead[];
  docs_injected: DocInjection[];
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
  // Multi-harness dispatch selector (Qwen+GigaCode slice Task 8). Selects
  // which HarnessSpec the pipeline resolves when streaming transcripts. The
  // default `'claude-code'` preserves pre-slice behavior; `'qwen-code'` and
  // `'gigacode'` opt into the new adapters. validated against the
  // {@link HarnessId} union in `validateConfig`.
  harness: HarnessId;
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
  //
  // Closed-loop MVP: `docs_dirs` is consumed by BOTH (a) the Diagnoser
  // (`gatherRepoContext`, which checks each path for doc-existence grounding
  // when attributing causes) AND (b) the detector's doc-read/doc-injection
  // scoping — a transcript read/edit whose normalized path falls under one of
  // these dirs is classified as a doc read / doc injection and rolled up into
  // `StruggleRecord.docs_read` / `docs_injected`. Keeping both consumers on
  // the same list means "what counts as a doc" stays consistent across the
  // diagnose and synthesize/fact-check stages.
  docs_dirs: string[];
  diagnose: {
    confidence_floor: number;
    config_share_floor: number;
    test_share_floor: number;
    code_share_floor: number;
    score_floor: number;
    // Closed-loop MVP: minimum classifier confidence required before the
    // synthesizer emits prose (frontmatter `body`) for a proposed doc. Causes
    // below this floor produce frontmatter-only proposals (no body) so the
    // review stage never sees low-confidence prose. Mirrors `confidence_floor`
    // in spirit but gated on prose emission specifically.
    confidence_floor_for_prose: number;
  };
  // Closed-loop MVP (Synthesizer) config. `backend`/`model` select the
  // generation backend (`null` = structure-only / no external call);
  // `structure_only` short-circuits to a frontmatter-only proposal with no
  // body regardless of confidence; `max_file_head_bytes` caps how many bytes
  // of a source file are fed to the synthesizer for grounding;
  // `dedupe` selects the near-duplicate strategy (`none` = skip,
  // `tfidf` = vectorize existing docs in `docs_dirs`); `top_n` bounds how
  // many existing docs are returned as `nearest_existing` candidates.
  synthesizer: {
    backend: string | null;
    model: string | null;
    structure_only: boolean;
    max_file_head_bytes: number;
    dedupe: 'none' | 'tfidf';
    top_n: number;
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

// Closed-loop MVP foundation types (Synthesizer + Review). Field names are
// contracts pinned to the closed-loop plan; later tasks import these verbatim.
// Unlike the Diagnoser `evidence?`/`diagnoses?` conditional-optional fields
// above, `StruggleRecord.docs_read` and `docs_injected` are ALWAYS-ON (the
// detector populates them on every record, even when empty) so the
// synthesizer/fact-check stages can rely on them without a sentinel.

/**
 * One observed doc-read event inside a session. `path` is repo-relative (or
 * absolute when the transcript did not resolve to a repo root); `t` is the
 * ISO8601 event timestamp from the normalized event stream. Always-on: the
 * detector emits an empty array when no doc reads were observed.
 */
export interface DocRead {
  path: string;
  t: string;
}

/**
 * One doc-injection event observed inside a session (an edit to a file under
 * a docs dir, or a session-start auto-injection). `trigger` is the closed
 * literal describing what caused the injection. Always-on: the detector
 * emits an empty array when no injections were observed.
 */
export interface DocInjection {
  path: string;
  t: string;
  trigger: 'edit' | 'start';
}

/**
 * Synthesizer output describing a doc to create. The v1 closed loop only
 * produces new-doc proposals (no edit/improve kind yet), so `kind` is pinned
 * to the literal `'new-doc'` as a discriminant for later task unions.
 *
 *  - `path`: target repo-relative path under a `docs_dirs` entry.
 *  - `frontmatter`: derived metadata block; `derived_from` is the list of
 *    session ids the proposal was synthesized from, `unit` mirrors the
 *    Diagnoser's `{kind:'area', key}` unit, `struggle_score` is the rolled-up
 *    score in [0,1], `cause` reuses the Diagnoser {@link Cause} taxonomy,
 *    `source_files` are the repo-relative paths used for grounding, and
 *    `created` is an ISO8601 timestamp.
 *  - `body`: the synthesized prose. May be empty when the synthesizer is in
 *    `structure_only` mode or when classifier confidence is below
 *    `diagnose.confidence_floor_for_prose`.
 *  - `cited_symbols` / `referenced_paths`: the symbols and paths the body
 *    actually cites (the fact-checker resolves these).
 *  - `dedupe`: the near-duplicate decision — `nearest_existing` is a
 *    repo-relative path or `null` when no candidate cleared the similarity
 *    floor; `similarity` is optional (absent under `dedupe:'none'`);
 *    `decision_rationale` is always present.
 *  - `verification`: the fact-check outcome for this proposal's citations,
 *    rolled up to three booleans. Populated by the Review stage.
 */
export interface Proposal {
  kind: 'new-doc';
  path: string;
  frontmatter: {
    derived_from: string[];
    unit: { kind: 'area'; key: string };
    struggle_score: number;
    cause: Cause;
    source_files: string[];
    created: string;
  };
  body: string;
  cited_symbols: string[];
  referenced_paths: string[];
  dedupe: {
    nearest_existing: string | null;
    similarity?: number;
    decision_rationale: string;
  };
  verification: {
    cited_symbols_resolved: boolean;
    paths_resolved: boolean;
    shas_valid: boolean;
  };
}

/**
 * One failed fact-check assertion against a {@link Proposal}. `kind` is the
 * closed literal describing what was checked; `resolved` flips to `true` once
 * the synthesizer regenerates the proposal so the assertion now holds;
 * `detail` is an optional human-readable note (e.g. why it failed or how it
 * was resolved).
 */
export interface FactCheckFailure {
  assertion: string;
  kind: 'symbol' | 'path' | 'sha';
  resolved: boolean;
  detail?: string;
}

/**
 * Fact-check outcome for a {@link Proposal}. `failures` lists every
 * assertion that did not hold; an empty array means the proposal passed
 * fact-check. Carried on the Review stage's result; later tasks consume this
 * to decide whether to accept, regenerate, or reject the proposal.
 */
export interface FactCheckResult {
  failures: FactCheckFailure[];
}

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
 *
 * `agent` (Qwen+GigaCode slice Task 11): the harness id that produced this
 * finding — either the `--harness` flag value or the auto-detected id (from
 * sniffing the transcript's shape when `reflect --transcript <path>` is called
 * without `--harness`). Mirrors `NormalizedEnvelope.agent` so reflect callers
 * can identify the detected harness from the finding alone (the underlying
 * `StruggleRecord` is harness-agnostic and does not surface it).
 */
export interface ReflectFinding {
  schema_version: 1;
  session_id: string;
  repo: string;
  mode: ScoringMode;
  agent: HarnessId;
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
