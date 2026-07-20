# harnessgap — Architecture (detection + opt-in diagnosis)

Internal reference for contributors. Covers the `harnessgap scan` pipeline as
implemented in `src/`. For user-facing usage see [`../README.md`](../README.md);
for the design contract see the
[spec](superpowers/specs/archive/2026-07-12-harnessgap-detection-slice-design.md).

## 1. Overview

The **default `scan` path is a stateless, detection-only pipeline** (Slice 1);
the opt-in `scan --diagnose` flag (Slice 4) layers cause attribution on top.
`harnessgap scan` reads Claude Code transcript logs from
`~/.claude/projects/`, normalizes them into a versioned event schema, runs
seven deterministic struggle signals, scores sessions as a percentile of
composites (with an absolute-threshold bootstrap for thin history), localizes
struggle to repo areas, and prints a leaderboard to stdout.

The contract is **stateless + offline**:

- **No network.** No `fetch`/`http`/`https`/`net`/`undici` imports and no
  `fetch()` calls anywhere in `src/`. Enforced by `test/egress.test.ts` via
  the patterns in `src/egress.ts`. Transcripts never leave the machine.
- **No disk writes.** harnessgap reads transcripts and prints to stdout. It
  creates no files, writes no state, persists nothing. (OS page cache/swap are
  out of scope and common to any process that reads files.)

All pipeline stages are pure functions of their inputs; the only I/O lives in
`src/walk.ts`, `src/adapter/stream.ts`, `src/git.ts`, and `src/cli.ts`. The
normalized-event schema is the deliberate seam: the next slice's ingest hook
reuses the adapter and detector verbatim and only adds persistence.

## 2. Module map

| File | Responsibility | Key exports |
| --- | --- | --- |
| `src/types.ts` | Shared type catalog. Field names/shapes are contracts pinned to the spec. | `NormalizedEvent`, `NormalizedEnvelope`, `SignalValues`, `StruggleRecord`, `AreaRow`, `JsonOutput`, `Config`, `Warnings`, `SignalName`, `ScoringMode`, `Severity`, `BaselinePath`, `BaselineState`, `BaselineAssessment`, `RepoFinding`, `ToolKind`, `EventKind`, `ReflectFinding`, `StopHookOutput`, `ReflectFrame`, `Cause`, `SessionEvidence`, `EvidenceRef`, `Diagnosis`, `CmdClass`, `FileClass` |
| `src/config.ts` | Load + validate `.harnessgap.yml`; deep-merge over defaults; parse `--since` durations. | `loadConfig`, `parseDuration`, `DEFAULT_CONFIG`, `ConfigError` |
| `src/git.ts` | Stat-based MAIN-repo resolver. Walks up from a cwd to the nearest directory `.git` (the main repo; worktrees only hold a `.git` file); also recovers SIBLING worktrees by scanning candidate siblings' `.git/worktrees/<name>/gitdir` registrations, returning the recovered checkout root alongside the repo. No git invocation, no shell. Memoized by cwd. | `resolveRepo`, `RepoResolution`, `resolveMainRepo`, `walkToRepo` |
| `src/walk.ts` | Discover `.jsonl` transcripts under `<claudeDir>/projects/*/*.jsonl`. Rejects symlinks. | `discoverTranscripts`, `defaultClaudeDir` |
| `src/relativize.ts` | Pure file-path relativization: strip the repo-root prefix, then collapse worktree checkout prefixes — `.<hidden>/worktrees/<name>/` (Claude Code's `.claude/worktrees/…`) OR `.worktrees/<name>/` (a hidden checkout dir named `worktrees` itself) — so the same file across the main checkout and nested worktrees aggregates into one area; also strips a sibling-worktree checkout root (`worktreeCheckoutRoot`, passed by the resolver) so sibling-worktree files collapse onto the same repo-relative areas as the main checkout. | `relativizeFilePath`, `stripWorktreePrefix`, `relativizeEnvelopeFiles` |
| `src/pipeline.ts` | Thin I/O shell: orchestrates walk → stream → resolve-main-repo → relativize → detect → aggregate → output. Also hosts `runReflect`, the n=1 session-end analog (see §10). | `runScan`, `ScanOptions`, `ScanResult`, `runReflect`, `ReflectOptions`, `ReflectResult` |
| `src/cli.ts` | commander bin entry. Parses args, awaits `runScan`/`runReflect`/`initClaude`, writes stdout, exits. | `program` (`scan` default, `reflect`, `init` commands) |
| `src/egress.ts` | §11 no-network guard: regexes for forbidden imports + `fetch()` calls. Single source of truth shared by the egress audit. | `FORBIDDEN_IMPORT`, `FORBIDDEN_FETCH_CALL`, `hasForbiddenImport`, `hasFetchCall`, `hasForbiddenEgress` |
| `src/adapter/scrub.ts` | Pattern-catalog secret scrubber (7 rules). No entropy heuristic. | `scrubCmd`, `scrubQuery`, `scrubFiles` |
| `src/adapter/taxonomy.ts` | Claude Code tool-name → `ToolKind` map. | `mapToolKind` |
| `src/adapter/parse.ts` | Per-record normalizer: one parsed JSONL record → one `NormalizedEvent` (or null). Scrubbing + correction flag applied here. | `normalizeRecord` |
| `src/adapter/stream.ts` | Streaming JSONL reader (the only adapter I/O). Size caps, `mergeToolCalls`, envelope assembly. | `streamSession` |
| `src/adapter/correction.ts` | Content-based correction detector: classifies a user message as a course-correction over an additive per-language keyword catalog (EN+RU, Cyrillic-normalized). Emits `{matched, shape}` only — never raw text. | `detectCorrection` |
| `src/detector/signals.ts` | Pure signal computation: 7 signals from a normalized event stream. | `computeSignals` |
| `src/detector/scoring.ts` | Pure scorer: percentile-of-composites and bootstrap modes. | `scoreSessions` |
| `src/detector/areas.ts` | Pure area localization: path-prefix clustering, deepest-pruning. | `localizeAreas` |
| `src/detector/record.ts` | Pure projection: assembles a `StruggleRecord` from envelope + signals + score + areas. | `assembleStruggleRecord` |
| `src/detector/orientation.ts` | Pure pre-edit orientation metric: distinct depth-2 dir prefixes + distinct read files before the first edit. `null` for zero-edit sessions. | `computePreEditOrientation` |
| `src/detector/ambient.ts` | Pure ambient baseline assessor: combines orientation + acute struggle-rate paths into a `RepoFinding` (null unless elevated) + always-populated `BaselineAssessment`. | `assessAmbient` |
| `src/detector/index.ts` | Detector orchestration: signals → score (once, whole batch) → ambient baseline → areas → record. Returns `{records, finding, baseline}`. Under `--diagnose`, also runs the opt-in `computeEvidence` projection per envelope (the only detector call site for the Diagnoser; absent by default so `StruggleRecord.evidence` is unset and default output stays byte-identical). | `runDetector` |
| `src/diagnoser/classify-util.ts` | Pure cmd/file classifiers over fixed catalogs. `classifyCmd` reuses `cfg.areas.test_cmd_patterns` for the `test` bucket. | `classifyCmd`, `classifyFile` |
| `src/diagnoser/evidence.ts` | Pure evidence projection: buckets failed execs by cmd-class + edited files by file-class. Single pass; zero-filled buckets. | `computeEvidence` |
| `src/diagnoser/profile.ts` | Pure per-area profile builder: groups flagged records by area, derives per-signal medians, elevation flags (mode-aware: bootstrap → `bootstrap_thresholds`; percentile → strictly above the cohort median), and element-wise evidence sums. | `buildProfiles`, `UnitProfile` |
| `src/diagnoser/repo-context.ts` | Doc-existence grounding — the only new I/O in the slice. Recursively lists files under `cfg.docs_dirs`, path-confined to the repo root, never follows symlinks, fail-open. | `gatherRepoContext`, `RepoContext` |
| `src/diagnoser/classify.ts` | Pure cause-classification rule engine: picks one `Cause` per unit from `{profile, repoContext, cfg}` and emits a derived-only `Diagnosis`. | `classify` |
| `src/diagnoser/index.ts` | Thin orchestration: `buildProfiles` → per-unit `gatherRepoContext` → `classify`. Two fail-open layers: outer batch-level try/catch (degrades to `[]`) + per-unit try/catch (degrades to one `unclassified` Diagnosis); never throws. | `diagnoseUnits` |
| `src/aggregate/leaderboard.ts` | Pure aggregation: per-session records → per-area `AreaRow`s + summary. | `aggregateAreas` |
| `src/output/json.ts` | Pure `JsonOutput` envelope assembler for `--json`. | `buildJsonEnvelope` |
| `src/output/human.ts` | Pure human-readable leaderboard formatter (the default table). | `formatHuman` |
| `src/output/calibrate.ts` | Pure calibrate builders: per-signal min/p50/p90/max + active threshold, for `--calibrate`. | `buildCalibrateObject`, `formatCalibrateTable` |
| `src/output/hook.ts` | Pure session-end reflect builders: a `StruggleRecord` → `ReflectFinding` decision + the Claude Code `Stop` hook payload. No I/O, no node builtins; the only Claude-Code-specific code in the tree. | `buildReflectFinding`, `formatStopHookOutput` |
| `src/init/claude.ts` | `harnessgap init claude` installer: writes the fail-open Stop-hook wrapper, idempotently merges `hooks.Stop` in `.claude/settings.json`, writes the `/reflect` command. Only `node:fs` + `node:path` (the wrapper's `child_process` lives in the emitted runtime artifact under `.claude/`, not in `src/`). | `initClaude` |

## 3. Pipeline

`runScan` (`src/pipeline.ts:66`) threads the stages together. Async because
`streamSession` is async.

1. **Config** — `loadConfig(opts.configPath)` (`src/pipeline.ts:68`). `ConfigError`
   propagates to the CLI (non-zero exit); `runScan` never catches it.
2. **Walk** — `discoverTranscripts(claudeDir)` (`src/pipeline.ts:72`) returns
   sorted `.jsonl` paths + `symlinks_rejected` count. Consumes a claude dir;
   produces file paths (no contents read).
3. **Adapter** — per file, `streamSession(file)` (`src/pipeline.ts`) reads
   line-by-line, applies size caps, calls `normalizeRecord` per line, threads
   `ctx.prevToolCall`, and runs `mergeToolCalls`. Produces a
   `NormalizedEnvelope` + the session's **distinct `cwds` list** + warning
   counts. The adapter stage bundles three sub-steps: **scrub** (in
   `normalizeRecord` via `scrubCmd`/`scrubQuery`/`scrubFiles`), **parse**
   (`normalizeRecord`), and **stream** (`streamSession` + `mergeToolCalls`).
4. **Repo resolve** — each distinct cwd is tried in turn through
   `resolveRepo(cwd, cache)` (`src/git.ts`) until one resolves to a main
   repo; the first success wins. `envelope.repo` is set to the MAIN repo root
   (so a project's main checkout + all worktrees share one repo value and
   aggregate), recovering nested and SIBLING worktrees alike (see §8).
   Unresolved → stashed for scoped `unresolvable_cwd` counting (below),
   session skipped (counted once — not double-counted under
   `skipped_sessions`). A single cache Map is threaded across all sessions.
5. **Relativize** — `relativizeEnvelopeFiles(envelope, repo, checkoutRoot)`
   rewrites every `input_digest.files` path to canonical repo-relative form
   (strip repo prefix, then collapse worktree checkout prefixes, and strip the
   sibling-worktree checkout root when present). This is what makes area keys
   real code areas instead of filesystem paths.
6. **Filter** — by repo (`--repo` is itself normalized through
   `resolveMainRepo`, so `--repo <worktree>` or `<subdir>` matches the whole
   project), then `--since` (`started_at >= now − duration`), then `--limit`
   (applied last, after all filtering). An explicit `--repo <path>` that does
   NOT resolve (typo, stale path, deleted project, non-git dir) throws a
   `ConfigError` → CLI exits 1; it never silently falls back to a machine-wide
   scan (issue #29). `unresolvable_cwd` is scoped here: when a repo resolved,
   only sessions whose cwd lived under that repo count (a since-deleted nested
   worktree); with no repo context (machine-wide scan) every unresolved session
   counts (issue #31 — previously the machine-wide total leaked into a
   single-repo scan's warnings line).
7. **Detector** — `runDetector(filtered, cfg, forceBootstrap)` computes signals
   per envelope, scores the whole batch once, assesses the ambient baseline
   once over the batch, localizes areas, and returns
   `{records, finding, baseline}` (`finding` is the elevated-baseline
   `RepoFinding` or null; `baseline` is always populated).
8. **Aggregate** — `aggregateAreas(records, cfg)` rolls per-session records
   into per-area `AreaRow[]` + a summary.
9. **Diagnose (opt-in, Slice 4)** — only when `opts.diagnose === true`,
   `diagnoseUnits(records, cfg, outputRepo)` produces one `Diagnosis` per flagged
   area (empty `[]` when nothing is flagged or the repo root is unresolved).
   Skipped entirely by default, so `ScanResult.diagnoses` is **unset** (key
   absent, not just `undefined`) and default output stays byte-identical to
   Slice 3. See §11.
10. **Output** — branch by `--calibrate` / `--json` / human. `mode` is read from
    the first record (or `'bootstrap'` when there are none); `outputRepo` is the
    filtered repo (or `''`).

## 4. Normalized event schema v1

The boundary contract (`src/types.ts:31`). The next slice persists this
verbatim. Envelope:

```jsonc
{ "schema_version": 1,
  "session_id": "...", "agent": "claude-code",
  "repo": "/abs/path/to/repo",          // MAIN repo root, filled at scan time
  "started_at": "ISO8601", "duration_ms": 1234567,
  "events": [ /* NormalizedEvent[] */ ],
  "truncated": false, "event_count": 412 }
```

`NormalizedEvent` (`src/types.ts:31`):

```jsonc
{ "t": "ISO8601",
  "kind": "user_msg" | "assistant_msg" | "tool_call",
  "tool": "read" | "search" | "list" | "edit" | "exec" | "other" | null,
  "input_digest": { "files": ["rel/path"],        // scrubbed, ≤50
                    "cmd":   "scrubbed string",    // exec only, ≤512 chars
                    "query": "scrubbed string",    // search only, ≤512 chars
                    "lines_changed": 12 },         // edit only
  "ok": true, "interrupted": false, "duration_ms": 1234,
  "correction": { "matched": true, "shape": "negation" } | null  // user_msg only
}
```

### The merge invariant

`normalizeRecord` is pure and sees one record at a time, so it emits **two**
events per tool invocation: a `tool_use` → `tool_call` (with `tool` + digest,
`ok=true` placeholder), and a `tool_result` → `tool_call` (with `tool=null`,
`ok=!is_error`, `interrupted`). Downstream signals need `tool` and `ok` on the
**same** event.

`mergeToolCalls` (`src/adapter/stream.ts:186`) closes that gap. Each
`tool_result` is paired with the most recent unresolved `tool_use` (stack —
correct for Claude Code's sequential call→result ordering). The result's
`ok`, `interrupted`, `duration_ms`, and `t` are merged onto the `tool_use`
event; the result event is dropped. Orphan results (no preceding `tool_use`)
are dropped; unresolved `tool_use`s (session interrupted before the result
arrived) are kept with the `ok=true` placeholder.

When paired, the merged event's `t` is set to the **result's** timestamp
(`src/adapter/stream.ts:197-203`), not the `tool_use`'s. This keeps the session
span correct for `wall_clock_per_line`, which uses `events[last].t −
events[0].t`: the last result's time survives even though the result event
itself is removed.

**Why this matters:** signals like `failure_streak` filter on
`e.tool === 'exec' && e.ok === false` (`src/detector/signals.ts:65`). Without
the merge, `tool` and `ok` would never co-occur on a single event and every
failure streak would compute as 0. The same is true for `oscillation`, which
keys on `e.tool === 'exec' && e.ok === false` and a `cmd` pattern
(`src/detector/signals.ts:181-190`).

## 5. The 7 signals

Computed by `computeSignals` (`src/detector/signals.ts:12`). Each is a cheap
heuristic over normalized events. Two deferred signals (`context_thrash`,
`expensive_success`) are out of scope for slice 1 — see spec §2.

| Signal | Detects |
| --- | --- |
| `explore_ratio` | Exploration pressure: `(search+read+list calls) / edited_lines`. `null` (does not contribute) when no edit lines. |
| `reread` | Distinct files read `≥ reread_threshold` times (default 5). |
| `failure_streak` | Longest run of consecutive `exec` calls with `ok === false`. |
| `corrections` | User course-corrections landing within `correction_window_ms` after a `tool_call`, or before the next `assistant_msg`. |
| `abandonment` | Last `tail_fraction` of events is explore-heavy with zero edits; suppressed when the whole session is a research signature (zero edits AND zero test/build exec). Boolean. |
| `oscillation` | Completed `edit → test/build-exec(ok=false) → edit-same-file` cycles, counted per file (exact path match). |
| `wall_clock_per_line` | `(last event t − first event t) / edited_lines`, winsorized at `bootstrap_thresholds.wall_clock_per_line_ms`. `null` when no edit lines. The cap bounds near-zero-edit sessions over long spans that would otherwise inflate p90/max and swing the composite (issue #33); the bootstrap trip is preserved exactly (`raw >= threshold` iff `min(raw, threshold) >= threshold`). |

`failure_streak` uses `ok` broadly (any exec failure); `oscillation` is
cmd-aware — it only counts an exec as failure when `cmd` matches a
`test_cmd_patterns` entry, avoiding TDD red-green false positives and `grep`
no-match `is_error` (`src/detector/signals.ts:216-220`).

## 6. Scoring

`scoreSessions` (`src/detector/scoring.ts:44`). Pure: no I/O, no mutation.
Returns one `SessionScore` per session in input order.

**Mode precedence** (`selectMode`, `src/detector/scoring.ts:57`):

1. `forceBootstrap` (the `--bootstrap` flag) → bootstrap
2. `cfg.detector.thresholds_as === 'absolute'` → bootstrap
3. `n < cfg.detector.bootstrap_session_floor` (default 30) → bootstrap
4. otherwise → percentile

The chosen mode is consistent across all records for a scan.

**Percentile rank** (`percentileRank`, `src/detector/scoring.ts:69`):

```
rank = (count strictly less than v) / (n − 1) × 100   when n > 1, else 0
```

Tied values each get `(count strictly less) / (n − 1) × 100`.

**Percentile mode** (`percentileModeScore`, `src/detector/scoring.ts:80`):

- Each numeric signal → a percentile rank (0–100) within the repo's session
  set. Nullable signals (`explore_ratio`, `wall_clock_per_line_ms`) are ranked
  only among sessions with non-null values; null sessions get no rank entry and
  are excluded from that signal's composite contribution (weight renormalized).
- Boolean `abandonment` contributes 0 (absent) / 100 (present) directly.
- `composite` = weighted mean of signal contributions, scaled 0–100
  (weights in `cfg.detector.signal_weights`, default in `src/config.ts:28`).
- `score_pct` = percentile rank of the session's `composite` within the repo.
- Flagged when `score_pct >= flag_pct` (default 90 → genuinely the top 10%).

**Bootstrap mode** (`bootstrapScore`, `src/detector/scoring.ts:133`):

- Each numeric signal **trips** (1) or not (0) against a conservative absolute
  threshold (`cfg.detector.bootstrap_thresholds`); booleans trip on `true`.
  Tripped contributes `100 × weight`; untripped contributes 0. `composite` =
  weighted mean, scaled 0–100.
- Flagged when `composite >= bootstrap_flag_pct` (default 70) **or** `≥ 2`
  signals trip.
- `score_pct` = the composite (not a percentile); `mode: "bootstrap"` tags it
  as un-percentile-calibrated.

## 7. Area localization

`localizeAreas` (`src/detector/areas.ts:19`). Pure. Five steps:

1. **Accumulate touch-weight per non-ignored file.** Each `tool_call`'s files
   are weighted by `areas.touch_weights` (default `edit:3, read:2, exec:1`;
   `search`/`list`/`other` contribute 0). Files whose first path segment is in
   `areas.ignore` (default `node_modules, build, target, dist, .git, .next,
   vendor`) contribute 0 weight — to the file and to the session total
   (`src/detector/areas.ts:101-105`).
2. **Roll up to ancestor directories.** Each ancestor dir's weight = sum of
   weights of all files beneath it (transitively). For a file with segments
   `[s0, …, sN]`, ancestors are `s0`, `s0/s1`, …, `s0/…/s(N-1)`.
3. **Candidates** = dirs at depth `>= areas.min_depth` (default 2) capturing
   `>= areas.min_weight` (default 0.40) of total touch-weight. Depth = number
   of `/`-separated segments from repo root.
4. **Deepest pruning** — drop any candidate whose key is a prefix of another
   candidate's key (`src/detector/areas.ts:67-78`). A descendant of `D` is any
   other candidate whose key starts with `D + '/'`. Siblings (no ancestor
   relationship) are both kept.
5. **Sort** lexicographically by key. Each result carries `weight` = dir
   weight / total touch-weight, in `[0,1]`.

A session with no qualifying directory returns `[]` and is counted as
`unlocalized` in the aggregator summary. Import-graph/embeddings clustering is
explicitly v2.

## 8. Security & privacy model

Five guarantees (spec §11), each pinned to its enforcing file.

**No network.** No `fetch`/`http`/`https`/`net`/`undici` imports and no
`fetch()` calls. `src/egress.ts` is the single source of truth:
`FORBIDDEN_IMPORT` (`src/egress.ts:18`) matches static, side-effect, dynamic,
and `require` imports of `http`/`https`/`net`/`undici`/`fetch` (the `node:`
prefix optional); `FORBIDDEN_FETCH_CALL` (`src/egress.ts:27`) is
`/\bfetch\s*\(/`, catching the global `fetch` (a Node global since 18, so no
import is required to egress). Both err toward flagging (matches inside
comments/strings too) — acceptable for a security control. Enforced by
`test/egress.test.ts`, which scans every `src/**/*.ts` and asserts zero
offenders.

**Pattern-catalog scrubbing (no entropy heuristic).** `src/adapter/scrub.ts`
applies seven fixed rules in order (heredoc keys → env-vars → auth headers →
URL creds → flag secrets → credential-file paths → known-format tokens) using
the literal sentinel `***REDACTED***`. High-entropy detection is deliberately
not used — it produces false positives (commit SHAs, UUIDs, hashes corrupt
`failure_streak`/`oscillation` command comparison) and false negatives. Applied
to `input_digest.cmd`, `input_digest.query`, and `input_digest.files` inside
`normalizeRecord`, before events enter the pipeline.

**No raw prose in any output path.** User/assistant text never enters the
contract: `normalizeRecord` classifies correction shapes and emits only the
`correction` flag — the sentence is consumed and discarded
(`src/adapter/parse.ts:244-257`). Warnings are integer counts only
(`src/types.ts:79`); `--calibrate` emits aggregate statistics only; `--json`
carries only derived signal values and integer counts. Enforced by
`test/privacy.test.ts` (malformed-prose and secret-shape fixtures through all
three output modes).

**Repo resolution (stat-based, no git invocation).** `resolveRepo`
(`src/git.ts`, with `resolveMainRepo` a thin wrapper that returns just the repo)
walks up from a session cwd, `stat`-ing `<ancestor>/.git`, and returns the first
ancestor whose `.git` is a **directory** (the main-repo marker). A worktree checkout's `.git` is a *file* (gitfile), so the walk skips
it and continues to the main repo — which means a project's main checkout and
every worktree all resolve to the same main-repo root and aggregate together.
The same walk recovers sessions whose cwd was a since-deleted worktree: the dir
is gone but ancestor `.git` directories are `stat`-checked along the path string
regardless, so the main repo is still found. **Sibling worktrees** — a session
whose cwd lived in a worktree whose checkout was a SIBLING of the main repo
(not nested under it), the layout `git worktree add …` produces for a sibling
clone — are recovered too: at each ancestor the resolver also scans SIBLING
directories for a directory `.git` and reads that candidate's
`.git/worktrees/<name>/gitdir`; if any registered worktree checkout path equals
or is an ancestor of the cwd, that sibling is the main repo. This attributes
sibling worktrees regardless of naming convention (no `-wt-` heuristic); without
it, ~29% of sessions on a worktree-heavy repo were dropped as `unresolvable_cwd`.
When this path fires, the resolver also returns the recovered sibling-worktree
checkout root (as `RepoResolution.checkoutRoot`), which relativization strips so
sibling-worktree files collapse onto the main checkout's repo-relative areas —
without it they'd survive as absolute paths outside the repo prefix and fragment
the leaderboard.
Empty cwd → `null` (never falls back to the harness's own repo). This replaced
an earlier sandboxed `git rev-parse --show-toplevel`, which returned the
*worktree* root (excluding worktree sessions from `--repo <main>`) and failed
outright for deleted cwds (dropping ~74% of sessions on a worktree-heavy repo).
Stat-walk spawns no process at all, so the previous git-sandbox concerns (env
vars, hooks, fsmonitor, shell history) are moot; `cwd` is untrusted and only
`stat`'d / `readdir`'d, with only tiny `gitdir` text files read under candidate
`.git/worktrees/`, never executed. Never throws — returns `null` on missing cwd
or no repo ancestor. `--repo` is normalized through the same resolver so
`--repo <worktree>` or `--repo <subdir>` matches the whole project.

**Symlink rejection.** `discoverTranscripts` (`src/walk.ts:37`) never follows
symlinks two ways: `Dirent.isDirectory()` is false for symlinks-to-dirs, so
symlinked session-dirs are skipped at the directory level without traversal
(`src/walk.ts:54-58`); and each `.jsonl` candidate is `lstatSync`'d (not
`statSync`), so a symlink `.jsonl` is rejected and counted in
`symlinks_rejected` regardless of target (`src/walk.ts:74-83`). A defensive
prefix-confinement check rejects any resolved path escaping
`<claudeDir>/projects/` (`src/walk.ts:89-90`).

**Size caps.** All enforced in `src/adapter/stream.ts` and `src/adapter/scrub.ts`:

| Cap | Value | Enforcing file |
| --- | --- | --- |
| JSONL line | 1 MB (`1_048_576` bytes); over → `oversized_lines++`, skipped | `src/adapter/stream.ts:20` |
| `cmd` / `query` length | 512 chars (truncated, no marker) | `src/adapter/scrub.ts:7` |
| files per digest | 50 (dropped beyond, no marker) | `src/adapter/scrub.ts:8` |
| events per session | 5000 (tail dropped, `truncated: true`) | `src/adapter/stream.ts:21` |
| cumulative bytes per session | 50 MB (`52_428_800` bytes); stop reading | `src/adapter/stream.ts:22` |

Fail-open throughout: malformed JSON, oversized lines, unreadable dirs, and
stream errors are skipped and counted, never thrown (`src/adapter/stream.ts:127`).

## 9. Testing strategy

- **Unit tests on pure functions** — per-record parse (`test/parse.test.ts`),
  scrubber patterns (`test/scrub.test.ts`), each signal computer
  (`test/signals.part1.test.ts`, `test/signals.part2.test.ts`), percentile/bootstrap
  scorer (`test/scoring.test.ts`), area clustering (`test/areas.test.ts`),
  correction detection (`test/correction.test.ts`), config
  (`test/config.test.ts`), git sandbox (`test/git.test.ts`), walk
  (`test/walk.test.ts`), stream/merge (`test/stream.test.ts`), output formatters
  (`test/output.test.ts`). All pure; TDD applies naturally.
- **Corpus integration test** (`test/corpus.test.ts`) — 12 labeled fixtures run
  through the **real** pipeline (real filesystem, real git, real streaming,
  real detection — no mocking). Pass bar: `≥ 80%` of fixtures match their
  `expected_flagged` label (`≥ 10` of 12). Also asserts each labeled session's
  `expected_top_signals` are a subset of the flagged area's top signals. This
  is the regression proxy that would catch a signal-always-0 bug: a broken
  signal drops the match rate below the bar.
- **Snapshot test** (`test/snapshot.test.ts`) — runs `runScan` (human output)
  over the fixed corpus and snapshots the leaderboard. Scoring or format drift
  updates the snapshot deliberately. The temp repo path is normalized to
  `<REPO>`; everything else is deterministic.
- **Packaging test** (`test/packaging.test.ts`) — locks `package.json` shape
  (`bin.harnessgap` → `dist/cli.js`, `engines.node >= 22.12`, `files` includes
  `dist`) and asserts the runtime dependency tree is exactly `commander` +
  `yaml` via `npm ls --all --omit=dev --json` (run through `execFile`, no
  shell).
- **Egress audit** (`test/egress.test.ts`) — scans every `src/**/*.ts` file for
  forbidden network imports and `fetch()` calls using `src/egress.ts`. Also
  locks the regex behavior against string fixtures (multi-line imports,
  side-effect imports, dynamic imports, `require`, `undici`, and the
  `WebFetch` vs `fetch` word-boundary distinction).
- **Privacy + safety test** (`test/privacy.test.ts`) — five sections: (a)
  secret-shape fixtures through `streamSession` → `***REDACTED***` present and
  original secret absent from `--json`; (b) malformed-transcript prose absent
  from human / `--json` / `--calibrate` / warnings; (c) safety fixtures —
  symlinked transcript rejected, unresolvable cwd skipped, oversized line
  skipped, and all `warnings` fields are integers; (d) baseline / `repo_findings`
  / calibrate surfaces prose-free at ≥ `min_sessions` (forces the ambient finding
  to fire, then asserts no prose marker reaches those surfaces); (e)
  `--diagnose` leaves prose-free (forces a `Diagnosis` to fire, then asserts no
  marker reaches `rationale` or any `evidence_refs` leaf, and every leaf is a
  primitive / enum / closed-union literal).
- **Reflect + init tests** (Slice 3) — `test/hook.test.ts` (pure
  `buildReflectFinding` + `formatStopHookOutput`, incl. a prose-absent /
  primitives-only privacy case); `test/reflect.test.ts` (`runReflect`
  end-to-end over fixtures in both output forms, incl. an end-to-end no-prose
  privacy case that seeds a marker in a user-message field and asserts it absent
  + every output leaf is a primitive/enum); `test/init.test.ts` (fail-open
  wrapper, idempotent settings merge, `/reflect` command); `test/cli.reflect.test.ts`
  (the `reflect` / `init` CLI wiring).
- **Diagnoser tests** (Slice 4) — `test/classify-util.test.ts` (cmd/file
  catalogs + precedence); `test/evidence.test.ts` + `test/detector-evidence.test.ts`
  (bucketing + opt-in wiring in the detector); `test/diagnose-profile.test.ts`
  (grouping, medians, mode-independent elevation, evidence sums);
  `test/repo-context.test.ts` (doc-match hit/miss, missing dir fail-open,
  path-confinement, symlink rejection); `test/classify.test.ts` (each cause's
  gate + the selection order + tie-break + confidence floor + doc-boost);
  `test/diagnose.test.ts` (per-unit fail-open + deterministic sort); plus
  `test/snapshot.test.ts` (byte-identical default snapshot + an opt-in
  `--diagnose` snapshot) and the §9 privacy case (e) for `--diagnose`.

## 10. Session-end reflect (`reflect` + `init claude`, Slice 3)

Slice 3 reframes the detector from **batch** to **event-driven**. `harnessgap
reflect` runs the **single-session** pipeline and emits a `ReflectFinding` (or
the Claude Code `Stop` hook payload); `harnessgap init claude` installs a
trip-gated Stop hook + a `/reflect` command. It reuses Slice 1's detector +
bootstrap mode verbatim — **`StruggleRecord`, the scorer (`scoreSessions`), the
aggregator (`aggregateAreas`), and `runScan` are untouched, so Slice 1/2
leaderboard output is byte-identical.** No new config keys, no new runtime deps,
no new network surface.

### `runReflect` (`src/pipeline.ts`)

The n=1 analog of `runScan`. Two resolution modes feed one shared detect+format
step:

- **`--transcript <path>`** — stream one given file (the per-stop hook path; cheap).
- **`--latest --repo <path>`** — discover every transcript under `claudeDir`,
  keep those whose resolved main repo matches, drop `--exclude-session`, and pick
  the max-`started_at` (the manual `/reflect` path; same order of cost as scan).

The picked envelope is relativized and run through `runDetector([envelope], cfg,
true)` (bootstrap forced at n=1), producing one `StruggleRecord`.
`buildReflectFinding` derives **`trip = record.flagged && !zero_edit`** (`zero_edit`
= no edit tool call this session) and pins `schema_version: 1`.

Fail-open throughout: a null envelope (`--latest` found nothing), an unresolvable
repo, **or** a thrown detect step all degrade to a degenerate `trip:false` finding
— the hook-stop formatter renders `{}`, so the Stop hook never reads a wrapper
error as a block. Only `loadConfig`/arg errors throw.

### Output forms (`src/output/hook.ts`)

- **`--format json`** — the `ReflectFinding`: `{ schema_version, session_id, repo,
  mode, record, trip, zero_edit }` (the full `StruggleRecord` is carried through;
  derived values only — no transcript prose).
- **`--format hook-stop`** — the Claude Code `Stop` payload: `stop_hook_active`
  → `{}` (never re-block an active hook); `trip` → `{ decision: "block", reason }`
  where `reason` is a static reflection prompt + up to 3 top area keys + active
  signal `name(value)` pairs (derived only); otherwise `{}` (allow the stop).

### `init claude` (`src/init/claude.ts`)

Writes three artifacts under `<cwd>/.claude/`:

1. a **fail-open wrapper** (`harnessgap-stop-hook.js`) — reads stdin,
   short-circuits on `stop_hook_active` or an empty `transcript_path`, spawns
   `node <cli> reflect --transcript <tp> --format hook-stop`, and synthesizes `{}`
   on any fault (a non-zero exit blocks in Claude Code, so every error path must
   allow). This wrapper is the only place `node:child_process` appears — an
   emitted runtime artifact under `.claude/`, **not** a file in `src/`, so
   `test/egress.test.ts` and `test/packaging.test.ts` hold.
2. an **idempotent `settings.json` merge** — appends `hooks.Stop` with the
   harnessgap command exactly once (deduped by command string), preserving every
   other top-level key and Stop entry.
3. the **`/reflect` command** (`commands/reflect.md`) — agent guidance to fill one
   `ReflectFrame` (cost / missing context / one change with a path-verified
   repo-relative `target_path`) from a finding, present it, and emit
   `change.kind: "none"` when clean. The binary never authors a frame.

### Trip-gate sensitivity (dogfood, not a promise)

`trip = flagged && !zero_edit` reuses the bootstrap flag, which is calibrated for
the *batch* leaderboard, not a per-session *interruption*. At n=1 it may fire on
ordinary sessions (e.g. one debug loop hitting `reread` + `wall_clock`). This is
the top open question (spec §11.1) and a **dogfood gate**: measure trip frequency
on clean sessions; if too high, tighten via one of the spec's levers (drop the
`≥ 2 signals` disjunction / raise to `≥ k` signals / a dedicated
`detector.reflect` block). See [`CONSUMER_GUIDE.md`](CONSUMER_GUIDE.md)
"Session-end reflect".

## 11. Diagnoser (`scan --diagnose`, Slice 4)

Slice 4 adds **grounded cause attribution** as an opt-in pass **after** the
detection core. The pipeline seam is deliberate: `runDetector`, `scoreSessions`,
`localizeAreas`, `aggregateAreas`, `assembleStruggleRecord`, scrubbing, size
caps, and `resolveMainRepo` are all reused verbatim. With `--diagnose` off,
`StruggleRecord.evidence` is unset, `ScanResult.diagnoses` is unset, and the
human / `--json` / `--calibrate` outputs are byte-identical to Slice 3.

The pipeline seam (in `runScan`, `src/pipeline.ts`):

1. **`runDetector(…, { collectEvidence: opts.diagnose === true })`** — when
   `--diagnose` is on, the detector additionally calls
   `computeEvidence(env.events, cfg.areas.test_cmd_patterns)` per envelope
   (`src/diagnoser/evidence.ts`, the only call site) and attaches the result to
   `StruggleRecord.evidence?`. The projection is a single pass that buckets
   failed-exec cmds (via `classifyCmd` → `config | test | build | other`) and
   edited files (via `classifyFile` → `test | code | other`); zero-filled
   buckets; reuses upstream scrubbing + size caps. Off by default → `evidence`
   is absent.
2. **`diagnoseUnits(records, cfg, outputRepo)`** (`src/diagnoser/index.ts`) —
   runs only under `--diagnose`; skipped when the filtered repo root is
   unresolved (`outputRepo === ''`), in which case `diagnoses = []`. Produces
   one `Diagnosis` per area touched by at least one flagged record (unflagged
   records are skipped at the source in `buildProfiles`).

Inside `diagnoseUnits`, per unit: `buildProfiles` groups flagged records by area
and derives per-signal medians, elevation flags, and element-wise evidence sums;
`gatherRepoContext` probes `cfg.docs_dirs` for an existing doc; `classify` picks
the cause. Output is sorted by `unit.key` ascending (deterministic).

### Elevation yardstick (mode-aware)

`buildProfiles` flags a signal **elevated** differently by scoring mode
(issue #32 — the absolute floors below were miscalibrated for real
percentile-mode data, where `reread`/`oscillation` almost never reached them, so
every flagged area collapsed to `unclassified`):

- **Bootstrap mode:** the unit's per-signal median meets
  `cfg.detector.bootstrap_thresholds` (`>=` for numbers; majority-`true` AND
  threshold `true` for `abandonment`; nullable signals elevated only when the
  median is non-null and meets threshold) — unchanged.
- **Percentile mode:** a number is elevated when the unit's per-signal median is
  **strictly greater than the cohort median** across all records in the batch
  (the repo's sessions — the same set the scorer ranked); i.e. the area
  expresses the signal more than a typical session. A sparse cohort (median 0)
  therefore elevates any area that actually has the signal. `abandonment` keeps
  absolute-threshold elevation in both modes; nullable signals never elevate on
  a null median.

The cohort median lets a flagged area's expressed signals actually elevate, so
the specific-cause gates below can fire on real data.

### Cause selection (pure rule engine, `src/diagnoser/classify.ts`)

`classify(profile, repoContext, cfg) → Diagnosis` is pure. Selection order:

1. Compute the four specific causes' eligibility + score (each cause's score is
   the fraction of the 5 signature signals
   `{explore_ratio, reread, failure_streak, corrections, oscillation}` currently
   elevated; `refactor-flag`'s score is boosted by `0.2` when `repoContext.docExists`).
   Gates (verbatim from §6 of the spec):

   | Cause | Gate |
   | --- | --- |
   | `doc` | `explore_ratio` + `reread` elevated AND `!docExists` |
   | `config-doc` | `failure_streak` elevated AND `config-failures / total-failures >= config_share_floor` |
   | `test-gap` | `oscillation` + `failure_streak` elevated AND `test-file-edits / total-edits >= test_share_floor` AND `!corrections` elevated |
   | `refactor-flag` | `oscillation` + `corrections` elevated AND `code-file-edits / total-edits >= code_share_floor` (docExists boosts score) |

2. Highest score wins; ties broken by fixed precedence
   `doc > config-doc > test-gap > refactor-flag`.
3. If the winner's score `>= cfg.diagnose.confidence_floor` → that cause.
4. Else if `wall_clock_per_line` elevated AND `meanScore >= cfg.diagnose.score_floor`
   → `inherent-complexity` (the "capable model, high cost, quiet signals"
   residual).
5. Else → `unclassified`.

`confidence` for a specific cause is the signature score (the doc boost applies
to `refactor-flag` only); for `inherent-complexity` it is proportional to
`wall_clock_per_line_ms` capped at `2 × bootstrap_thresholds.wall_clock_per_line_ms`;
for `unclassified` it is `0`.

### Fail-open

Two layers in `src/diagnoser/index.ts`:

1. **Outer (batch-level):** `diagnoseUnits` wraps `buildProfiles` + the per-unit
   loop in a try/catch that returns `[]` on any throw. `buildProfiles` can't
   throw on detector-produced records, but `runScan` calls `diagnoseUnits`
   unguarded, so this makes the "never throws / never aborts the scan" contract
   unconditional.
2. **Inner (per-unit):** `diagnoseOne` wraps `gatherRepoContext` + `classify`
   in a per-unit try/catch. Any throw degrades that one unit to a derived-only
   `{ cause: 'unclassified', confidence: 0, rationale: 'diagnosis unavailable',
   evidence_refs: [] }`; the batch continues.

`diagnoseUnits` itself never throws. Only `loadConfig`/arg errors throw
(unchanged from Slice 1). `gatherRepoContext` is also internally fail-open: a
missing/unreadable/escaping `docs_dirs` entry or any read error →
`docExists: false` for that unit, never thrown (every attempted dir still
appears in `checked`).

### Privacy contract (derived-only)

`Diagnosis.rationale` and every `evidence_refs` leaf are derived-only — signal
medians, integer counts, ratios, doc paths. No transcript prose, commands, or
file bodies. `gatherRepoContext` reads `docs/` but emits only matched paths
(repo-relative) or the list of dirs checked. The `--json` `diagnoses` field
carries the same derived values. The cmd/file catalogs are fixed literals
(`src/diagnoser/classify-util.ts`); no record string is copied into a
`Diagnosis`. Enforced by `test/privacy.test.ts` (e): seeds a prose marker in a
user-message/cmd/file field under `--diagnose`, then asserts it is absent from
`rationale` and every `evidence_refs` leaf, and every leaf is a primitive / enum
/ closed-union literal.

### No new egress, no new deps

The Diagnoser imports only `node:fs` + `node:path` (in `repo-context.ts`) and
its own pure modules. No network, no `git`, no new runtime dependencies, so
`test/egress.test.ts` and `test/packaging.test.ts` pass unmodified. The only new
I/O is the local doc-existence read, path-confined to the repo root and never
following symlinks (mirrors `src/walk.ts`).

## 12. Pointers

- [Spec (authoritative)](superpowers/specs/archive/2026-07-12-harnessgap-detection-slice-design.md) — §5 scoring, §11 privacy are the contract.
- [Diagnoser spec (Slice 4)](superpowers/specs/active/2026-07-18-harnessgap-diagnoser-design.md) — §5 contracts, §6 cause taxonomy, §11 open questions.
- [Plan](superpowers/plans/archive/2026-07-12-harnessgap-detection-slice.md) — implementation plan.
- [README](../README.md) — user-facing usage, flags, config defaults, privacy summary.
- [Consumer guide](CONSUMER_GUIDE.md) — consumer-facing docs.

## TL;DR

`harnessgap scan` is a stateless, offline, detection-only pipeline: **walk**
`~/.claude/projects/*/*.jsonl` → **adapter** (scrub + parse + stream, merging
`tool_use`+`tool_result` into one `tool_call` event so `tool` and `ok`
co-occur) → **resolve main repo** (stat-walk to directory `.git`; no git
invocation — unifies main + worktrees + deleted-worktree +
sibling-worktree recovery) →
**relativize** (repo-root prefix strip + worktree-prefix collapse, so areas are
real code areas) → **detector** (7 pure signals + percentile-of-composites
scoring with a bootstrap fallback for thin history + path-prefix area
localization) → **aggregate** (integer session counts; percentile-rank
top-signals) → **output** (human table — flagged areas only, aligned — /
`--json` / `--calibrate`). No network, no disk writes, no raw prose in any
output. Stat-based repo resolution, symlink rejection, and
1 MB / 512 / 50 / 5000 / 50 MB size caps throughout. The normalized-event
schema and pure detector are zero wasted work when
ingest/diagnosis/routing land in later slices.
