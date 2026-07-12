# harnessgap — Architecture (Slice 1, detection-only)

Internal reference for contributors. Covers the `harnessgap scan` pipeline as
implemented in `src/`. For user-facing usage see [`../README.md`](../README.md);
for the design contract see the
[spec](superpowers/specs/archive/2026-07-12-harnessgap-detection-slice-design.md).

## 1. Overview

Slice 1 is a **stateless, detection-only** CLI. `harnessgap scan` reads Claude
Code transcript logs from `~/.claude/projects/`, normalizes them into a
versioned event schema, runs seven deterministic struggle signals, scores
sessions as a percentile of composites (with an absolute-threshold bootstrap
for thin history), localizes struggle to repo areas, and prints a leaderboard
to stdout.

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
| `src/types.ts` | Shared type catalog. Field names/shapes are contracts pinned to the spec. | `NormalizedEvent`, `NormalizedEnvelope`, `SignalValues`, `StruggleRecord`, `AreaRow`, `JsonOutput`, `Config`, `Warnings`, `SignalName`, `ScoringMode`, `ToolKind`, `EventKind` |
| `src/config.ts` | Load + validate `.harnessgap.yml`; deep-merge over defaults; parse `--since` durations. | `loadConfig`, `parseDuration`, `DEFAULT_CONFIG`, `ConfigError` |
| `src/git.ts` | Sandboxed `git rev-parse --show-toplevel` resolver. Memoized by cwd. | `resolveToplevel` |
| `src/walk.ts` | Discover `.jsonl` transcripts under `<claudeDir>/projects/*/*.jsonl`. Rejects symlinks. | `discoverTranscripts`, `defaultClaudeDir` |
| `src/pipeline.ts` | Thin I/O shell: orchestrates walk → stream → git-resolve → detect → aggregate → output. | `runScan`, `ScanOptions`, `ScanResult` |
| `src/cli.ts` | commander bin entry. Parses args, awaits `runScan`, writes stdout, exits. | `program` (default `scan` command) |
| `src/egress.ts` | §11 no-network guard: regexes for forbidden imports + `fetch()` calls. Single source of truth shared by the egress audit. | `FORBIDDEN_IMPORT`, `FORBIDDEN_FETCH_CALL`, `hasForbiddenImport`, `hasFetchCall`, `hasForbiddenEgress` |
| `src/adapter/scrub.ts` | Pattern-catalog secret scrubber (7 rules). No entropy heuristic. | `scrubCmd`, `scrubQuery`, `scrubFiles` |
| `src/adapter/taxonomy.ts` | Claude Code tool-name → `ToolKind` map. | `mapToolKind` |
| `src/adapter/parse.ts` | Per-record normalizer: one parsed JSONL record → one `NormalizedEvent` (or null). Scrubbing + correction flag applied here. | `normalizeRecord` |
| `src/adapter/stream.ts` | Streaming JSONL reader (the only adapter I/O). Size caps, `mergeToolCalls`, envelope assembly. | `streamSession` |
| `src/adapter/correction.ts` | Content-based correction detector: classifies a user message as a course-correction. Emits `{matched, shape}` only — never raw text. | `detectCorrection` |
| `src/detector/signals.ts` | Pure signal computation: 7 signals from a normalized event stream. | `computeSignals` |
| `src/detector/scoring.ts` | Pure scorer: percentile-of-composites and bootstrap modes. | `scoreSessions` |
| `src/detector/areas.ts` | Pure area localization: path-prefix clustering, deepest-pruning. | `localizeAreas` |
| `src/detector/record.ts` | Pure projection: assembles a `StruggleRecord` from envelope + signals + score + areas. | `assembleStruggleRecord` |
| `src/detector/index.ts` | Detector orchestration: signals → score (once, whole batch) → areas → record. | `runDetector` |
| `src/aggregate/leaderboard.ts` | Pure aggregation: per-session records → per-area `AreaRow`s + summary. | `aggregateAreas` |
| `src/output/json.ts` | Pure `JsonOutput` envelope assembler for `--json`. | `buildJsonEnvelope` |
| `src/output/human.ts` | Pure human-readable leaderboard formatter (the default table). | `formatHuman` |
| `src/output/calibrate.ts` | Pure calibrate builders: per-signal min/p50/p90/max + active threshold, for `--calibrate`. | `buildCalibrateObject`, `formatCalibrateTable` |

## 3. Pipeline

`runScan` (`src/pipeline.ts:66`) threads the stages together. Async because
`streamSession` and `resolveToplevel` are async.

1. **Config** — `loadConfig(opts.configPath)` (`src/pipeline.ts:68`). `ConfigError`
   propagates to the CLI (non-zero exit); `runScan` never catches it.
2. **Walk** — `discoverTranscripts(claudeDir)` (`src/pipeline.ts:72`) returns
   sorted `.jsonl` paths + `symlinks_rejected` count. Consumes a claude dir;
   produces file paths (no contents read).
3. **Adapter** — per file, `streamSession(file)` (`src/pipeline.ts:89`) reads
   line-by-line, applies size caps, calls `normalizeRecord` per line, threads
   `ctx.prevToolCall`, and runs `mergeToolCalls`. Produces a
   `NormalizedEnvelope` + the session's representative `cwd` + warning counts.
   The adapter stage bundles three sub-steps: **scrub** (in `normalizeRecord`
   via `scrubCmd`/`scrubQuery`/`scrubFiles`), **parse** (`normalizeRecord`), and
   **stream** (`streamSession` + `mergeToolCalls`).
4. **Git-resolve** — `resolveToplevel(cwd, cache)` (`src/pipeline.ts:102`) tags
   each envelope with its repo toplevel. Empty cwd or unresolved toplevel →
   `unresolvable_cwd++`, session skipped. A single cache Map is threaded across
   all sessions (cwd repeats are common).
5. **Filter** — by repo (`src/pipeline.ts:113-128`), then `--since`
   (`started_at >= now − duration`), then `--limit` (applied last, after all
   filtering).
6. **Detector** — `runDetector(filtered, cfg, forceBootstrap)`
   (`src/pipeline.ts:150`) computes signals per envelope, scores the whole
   batch once, localizes areas, assembles `StruggleRecord[]`.
7. **Aggregate** — `aggregateAreas(records, cfg)` (`src/pipeline.ts:153`)
   rolls per-session records into per-area `AreaRow[]` + a summary.
8. **Output** — branch by `--calibrate` / `--json` / human
   (`src/pipeline.ts:163-193`). `mode` is read from the first record (or
   `'bootstrap'` when there are none); `outputRepo` is the filtered repo (or
   `''`).

## 4. Normalized event schema v1

The boundary contract (`src/types.ts:31`). The next slice persists this
verbatim. Envelope:

```jsonc
{ "schema_version": 1,
  "session_id": "...", "agent": "claude-code",
  "repo": "/abs/path/to/repo",          // git toplevel, filled at scan time
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
| `wall_clock_per_line` | `(last event t − first event t) / edited_lines`. `null` when no edit lines. |

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

**Sandboxed git.** `resolveToplevel` (`src/git.ts:18`) invokes
`git -C <cwd> rev-parse --show-toplevel` via `execFile` (no shell, so no
command lands in shell history), with:

- `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=/dev/null`
  (`src/git.ts:43-47`) — neutralize system/global config.
- `-c core.fsmonitor= -c core.pager=cat -c core.hooksPath=`
  (`src/git.ts:33-39`) — neutralize repo-local config that could invoke
  external programs.
- `rev-parse` only — no `status`/`diff`/`log` that could trigger fsmonitor or
  hooks.

`cwd` originates from transcripts (untrusted); the sandbox prevents git from
invoking external programs via repo-local config. Never throws — returns `null`
on missing git, missing cwd, or non-repo.

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
- **Privacy + safety test** (`test/privacy.test.ts`) — three sections: (a)
  secret-shape fixtures through `streamSession` → `***REDACTED***` present and
  original secret absent from `--json`; (b) malformed-transcript prose absent
  from human / `--json` / `--calibrate` / warnings; (c) safety fixtures —
  symlinked transcript rejected, unresolvable cwd skipped, oversized line
  skipped, and all `warnings` fields are integers.

## 10. Pointers

- [Spec (authoritative)](superpowers/specs/archive/2026-07-12-harnessgap-detection-slice-design.md) — §5 scoring, §11 privacy are the contract.
- [Plan](superpowers/plans/archive/2026-07-12-harnessgap-detection-slice.md) — implementation plan.
- [README](../README.md) — user-facing usage, flags, config defaults, privacy summary.
- [Consumer guide](CONSUMER_GUIDE.md) — consumer-facing docs.

## TL;DR

`harnessgap scan` is a stateless, offline, detection-only pipeline: **walk**
`~/.claude/projects/*/*.jsonl` → **adapter** (scrub + parse + stream, merging
`tool_use`+`tool_result` into one `tool_call` event so `tool` and `ok`
co-occur) → **detector** (7 pure signals + percentile-of-composites scoring
with a bootstrap fallback for thin history + path-prefix area localization) →
**aggregate** → **output** (human table / `--json` / `--calibrate`). No
network, no disk writes, no raw prose in any output. Sandboxed git, symlink
rejection, and 1 MB / 512 / 50 / 5000 / 50 MB size caps throughout. The
normalized-event schema and pure detector are zero wasted work when
ingest/diagnosis/routing land in later slices.
