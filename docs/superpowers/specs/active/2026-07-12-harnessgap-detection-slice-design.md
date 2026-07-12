# harnessgap — Detection Slice (Phase 1, Slice 1)

**Status:** approved design → implementation planning (rev 2: incorporates 4-agent spec review)
**Date:** 2026-07-12
**Parent design:** `docs/DESIGN.md` (v0.2)
**Runtime:** Node + TypeScript, npm-distributed (`npx harnessgap`); Bun single-binary deferred to a later packaging step.

## 1. Purpose

Validate the core hypothesis of harnessgap: that deterministic signals over agent transcripts, scored with percentile thresholds, produce a struggle leaderboard that matches an experienced user's gut on a repo they know well.

This slice is **detection-only**. It writes no docs, installs no hooks, persists no state. Its output is a leaderboard printed to stdout. Everything downstream in the parent design — diagnosis, synthesis, routing, measurement — waits until detection is proven.

### Success criterion

On a real repo with rich Claude Code session history, `harnessgap scan` produces a leaderboard that discriminates struggle from non-struggle. The user prepares, in advance, **≥5 areas they recall as struggle** *and* **≥5 areas they recall as non-struggle**. The leaderboard must then satisfy all three:

- **Precision:** of the tool's top 5 flagged areas, ≥3 are in the user's struggle set (≥60%).
- **Recall:** of the user's ≥5 struggle areas, ≥3 are flagged (≥60%).
- **No false positives in the top 5:** none of the user's non-struggle areas appear in the top 5 flagged.

This is a real pass/fail gate on both dimensions, not a gut-feeling overlap. The quantitative ≥25% read-vs-not-read struggle-delta target in the parent design requires routing + measurement and remains out of scope.

## 2. Scope

**In scope**
- `harnessgap scan` CLI: walks Claude Code transcripts, filters to a target repo, runs the pipeline, prints a leaderboard. Stateless — writes nothing to disk.
- Claude Code adapter: transcript JSONL → normalized event schema v1 (secret-scrubbed, size-capped streaming, `schema_version`'d).
- Detector: **seven** deterministic signals → percentile composite score (absolute-threshold bootstrap when in-repo history is thin) → per-session struggle records keyed by area.
- Area localization: path-prefix clustering with ignore list.
- Minimal `.harnessgap.yml` (detector thresholds + areas only); `scan` works with no config.
- Tests: labeled fixture corpus (incl. secret-shape and malformed-transcript fixtures) + unit tests on pure functions + leaderboard snapshot.

**Out of scope (deferred to later slices)**
- `context_thrash` signal — its input (PreCompact) is a **hook-only** event, not present in transcript JSONL; returns when ingest hooks land.
- `expensive_success` signal — needs token-usage data, which the slice-1 schema does not surface; returns when token usage is wired in.
- Task-unit fingerprinting; ambient `repo` unit + structural-absence detection.
- Diagnoser, Synthesizer, Curator/review, proposals, any doc writing.
- Router / injection hooks; Measurement (doc-read consumption + read-vs-not-read delta).
- Ingest hooks (`SessionEnd`/`Stop`), `.harnessgap/` persistent state, seen-sessions idempotency, team `struggle.jsonl`.
- Other agents (Codex/OpenCode/Qwen) — Claude Code only.
- `--redact-paths` output mode (roadmap: needed before any team sharing of `--json` output).
- Corpus-seeded percentile bootstrapping (absolute-threshold bootstrap used instead).

## 3. Architecture & data flow

A pure, stateless batch pipeline. The normalized-event schema is the deliberate seam: the next slice's ingest hook reuses the adapter and detector verbatim and only adds persistence.

```
~/.claude/projects/<slug>/*.jsonl
   │   filter by repo path · stream line-by-line · size-cap per session
   ▼
Claude Code adapter  ── scrub ──►  Normalized events  (schema v1)
   ▼
Detector  ──►  per-session signals + composite score  (percentile | bootstrap)
   ▼
Area localization  ──►  struggle records keyed by area
   ▼
Aggregator  ──►  leaderboard:  area · sessions flagged · top signals · score
   ▼
stdout   (nothing written to disk)
```

All stages are pure functions of their inputs. The detector takes normalized events in and emits struggle records out — no I/O, no side effects — which makes it trivially unit-testable and reuse-ready.

## 4. Normalized event contract (schema v1)

The boundary contract. The next slice persists this verbatim, so it must be right now.

### Envelope + event

```jsonc
{ "schema_version": 1,
  "session_id": "...", "agent": "claude-code",
  "repo": "/abs/path/to/repo",          // git toplevel of the session's cwd
  "started_at": "ISO8601", "duration_ms": 1234567,
  "events": [
    { "t": "ISO8601",
      "kind": "user_msg" | "assistant_msg" | "tool_call",
      "tool": "read" | "search" | "list" | "edit" | "exec" | "other",
      "input_digest": { "files": ["rel/path"],        // relative to repo root, scrubbed
                        "cmd":   "scrubbed string",    // exec only, length-capped
                        "query": "scrubbed string",    // search only
                        "lines_changed": 12 },         // edit only
      "ok": true, "interrupted": false, "duration_ms": 1234,
      "correction": { "matched": true, "shape": "negation" }  // user_msg only
    }
  ]
}
```

The detector consumes, per event, only: `t`, `kind`, `tool`, `input_digest.files`, `input_digest.cmd` (exec), `input_digest.lines_changed` (edit), `ok`, `interrupted`, `duration_ms`, and the `correction` flag. Keeping this surface minimal is what makes the detector pure and testable.

**Note on `ok`/`interrupted`:** Claude Code transcripts expose, for `Bash` results, an `is_error` boolean and an `interrupted` boolean — **not** an exit code. `ok` is the inverse of `is_error` for exec tools; `interrupted` carries the interrupt flag. There is no `exit` field by design; failure-detection signals are defined on `ok`/`interrupted`, not exit codes.

### Secret scrubbing — in the adapter, pattern-catalog-based

Events are clean by construction: scrubbing happens in the adapter, before the event enters the pipeline. Although slice 1 writes nothing to disk, scrubbing here means (a) no secrets reach debug/leaderboard output, and (b) slice 2 persistence inherits it for free. **This scrubber is reused verbatim for slice 2's git-committed `struggle.jsonl`**, so its coverage must be correct now.

Scrubbing applies to `input_digest.cmd`, `input_digest.query`, and `input_digest.files`. The scrubber uses an **explicit pattern catalog** (not a catch-all entropy heuristic):

- Env-var assignments: `KEY=…`, including `export`/`set`/`env` prefixes.
- `Authorization` / `Bearer` headers.
- **URL-embedded credentials:** `://user:pass@host` (incl. `postgres://`, `redis://`, git remotes `https://token@host`).
- **Flag/positional secrets:** `-p <val>`, `-u <user:pass>`, `--password`, `--secret`, `--token`, `--api-key`, `--access-key`.
- **Heredoc / inline private keys:** content between `-----BEGIN … PRIVATE KEY-----` … `-----END …-----`.
- **Credential file reads:** paths matching `**/.env`, `**/*.pem`, `**/*.key`, `**/.aws/credentials`, `**/.npmrc`, `**/id_rsa*`, `**/.pgpass`, `**/.htpasswd`, `**/service-account*.json`, `**/credentials.json`.
- **Known-format tokens:** AWS `AKIA[0-9A-Z]{16}`, GitHub `gh[oprs]_[A-Za-z0-9]{36}`, Slack `xox[baprs]-[A-Za-z0-9-]+`, JWTs `eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`.

**High-entropy detection is deliberately NOT used as a catch-all** — it produces both false positives (commit SHAs, UUIDs, hashes — which corrupt `failure_streak`/`oscillation` command comparison) and false negatives (short/structured secrets). Entropy may be added later as a backstop with a defined metric, threshold, and SHA/UUID exclusions; until then the catalog above is the contract.

### No raw message text

User/assistant prose never enters the contract. The adapter classifies correction shapes and emits only the `correction` flag — not the sentence. **This is spec-enforced, not implementer discipline:** warning summaries contain only integer counts (§9); `--calibrate` output is aggregate statistics only (§6); and a test fixture with a malformed transcript asserts no raw prose appears in any output path (stdout, `--json`, `--calibrate`, warnings).

### Size-capped streaming

Transcripts are parsed line-by-line (JSONL), never slurped. Caps apply to **both input and output**:

- **Input:** each JSONL line is capped at 1 MB before `JSON.parse`; lines exceeding this are skipped and counted in `warnings.oversized_lines`. This prevents a single huge line from causing unbounded memory growth.
- **Output (normalized event):** `cmd`/`query` length ≤ 512 chars; files per digest ≤ 50; events per session ≤ 5000.
- **Tail truncation:** events beyond the 5000 cap are **dropped**; the record carries `truncated: true` and `event_count`. No synthetic summary event is fed to the detector (keeps detector input deterministic).
- A per-session byte cap (50 MB) bounds total work on pathological transcripts.

### Tool taxonomy mapping

Claude Code tool → normalized: `Read`→read · `Grep`/`Glob`→search · `LS`→list · `Edit`/`Write`/`NotebookEdit`→edit · `Bash`→exec · everything else (the `Task*` family, `WebSearch`, `WebFetch`, MCP tools `mcp__server__tool`)→other. Six values; this is all the detector needs and what makes later per-agent adapters cheap.

### Repo derivation & git safety

`repo` = git toplevel of the session's `cwd` (the `cwd` field is present per-event in transcripts; the toplevel is not, so it is computed at scan time). `scan --repo <path>` filters envelopes to that toplevel. Sessions whose `cwd` doesn't resolve to a real directory are skipped with a warning.

Because `cwd` is transcript-controlled (not trusted), git is invoked sandboxed: `git -C <cwd> rev-parse --show-toplevel` only, with `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, and `-c core.fsmonitor= -c core.pager=cat -c core.hooksPath=` to neutralize repo-local config that could invoke external programs. Git is called via `execFile` (no shell), so no command lands in shell history. Only `rev-parse` (or equivalent non-invoking commands) is permitted — no `status`/`diff`/`log` that could trigger fsmonitor/hooks.

### Transcript walk safety

The walk of `~/.claude/projects/*/*.jsonl` rejects symlinks (`lstat`) and verifies each resolved path stays under `~/.claude/projects/`, so a symlinked transcript cannot cause reads of arbitrary files.

## 5. Detector

### Signals (seven)

Each is a cheap heuristic over normalized events. `context_thrash` and `expensive_success` are deferred (§2).

| Signal | v1 definition | Inputs |
|---|---|---|
| `explore_ratio` | `(search+read+list calls) / max(edited_lines, 1)`; **null** (does not contribute) when `edited_lines = 0` | tool kinds, `lines_changed` |
| `reread` | count of distinct files read ≥ `reread_threshold` times | file paths |
| `failure_streak` | longest run of consecutive `exec` calls with `ok=false` | `ok` (exec) |
| `corrections` | count of `correction` flags arriving within `correction_window_ms` after an assistant `tool_call`, or before the next assistant message | `correction` flag, `t`, `kind` |
| `abandonment` | last `tail_fraction` of events is ≥ `explore_ratio_min` explore calls **and** zero edits; **suppressed** when the whole session has zero edits *and* zero test/build exec (a research signature) *(boolean regime)* | tool kinds, edit count, `cmd` |
| `oscillation` | ≥ `min_cycles` cycles of `edit → test/build-exec(ok=false) → edit-same-file` *(v1: no full revert detection; "same-file" = exact path match; "test/build-exec" = cmd matches `test_cmd_patterns`)* | edit+exec sequencing per file, `cmd`, `ok` |
| `wall_clock_per_line` | `duration_ms / max(edited_lines, 1)`; null when `edited_lines = 0` | duration, `lines_changed` |

**Why `failure_streak` uses `ok` broadly while `oscillation` is cmd-aware:** `failure_streak` catches general command failures (any exec `ok=false`); `oscillation` specifically catches the edit-test-loop struggle, so it only counts exec as "failure" when the command is a test/build (avoiding TDD red-green false positives and `grep` no-match `is_error`). `failure_streak`'s "same-command retry" clause is dropped from v1 (it needs command normalization, deferred — see §13).

### Scoring — percentile of composites, with absolute bootstrap

Two modes, selected by precedence: **`--bootstrap` flag > `thresholds_as: absolute` config > automatic** (`session_count < K` → bootstrap, else percentile). `mode` ∈ {`percentile`, `bootstrap`}; both auto-thin-history and user-forced absolute report `mode: "bootstrap"`.

**Percentile mode** (`session_count ≥ K`, default K=30):
1. Each numeric signal → a percentile rank (0–100) within the repo's session set.
2. Boolean regime signals (`abandonment`) contribute **0** (absent) / **100** (present); null signals (e.g. `explore_ratio` with no edits) are excluded from the mean and their weight renormalized.
3. `composite` = weighted mean of signal contributions (weights in §7).
4. `score_pct` = **percentile rank of the session's `composite` within the repo** — the share of sessions with a lower composite. (This makes `flag_pct` a true top-percentile.)
5. Flagged when `score_pct ≥ flag_pct` (default 90 → genuinely the top 10% of sessions by composite).

**Bootstrap mode** (`session_count < K`, or forced):
1. Each numeric signal **trips** (1) or not (0) against a conservative absolute threshold (`bootstrap_thresholds`, §7); booleans trip on `true`.
2. `composite` = weighted mean of tripped signals (0–100).
3. Flagged when `composite ≥ bootstrap_flag_pct` (default 70) **or** ≥2 signals trip.
4. `score_pct` = the composite (not a percentile); `mode: "bootstrap"` tags it as un-percentile-calibrated.

### Area localization (path-prefix, v1)

- Per session, accumulate **touch-weight** per file using `areas.touch_weights` (default `edit:3, read:2, exec:1`), roll up to ancestor directories, apply `areas.ignore`.
- The session's area(s) = the deepest directory/directories each capturing ≥ `areas.min_weight` (default 0.40) of touch-weight, with depth ≥ `areas.min_depth` (default 2). A session may map to multiple areas, each with a `weight`.
- **Fallback:** if no directory reaches `min_weight`, the session is `(unlocalized)` and excluded from the area leaderboard (counted separately in the summary line).
- Import-graph/embeddings clustering is explicitly v2 (per parent design §12.6).

### Struggle record (per session, in-memory only in slice 1)

```jsonc
{ "session_id": "…", "repo": "…", "started_at": "…", "duration_ms": 1234567,
  "score_pct": 93, "mode": "percentile",           // or "bootstrap"
  "flagged": true, "truncated": false, "event_count": 412,
  "areas": [ { "key": "src/billing", "weight": 0.82 } ],
  "signals": { "explore_ratio": 14.2, "reread": 7, "failure_streak": 2,
               "corrections": 3, "abandonment": false,
               "oscillation": 4, "wall_clock_per_line_ms": 540000 } }
```

`signals` holds **raw** values (ratios, counts, durations, booleans); percentile ranks are internal to scoring and not stored per signal. `mode` makes the bootstrap-vs-percentile distinction honest in output. `evidence_refs`, `docs_read`, `docs_injected` are absent — they belong to diagnosis/measurement slices.

## 6. CLI

One command; no `init` or `calibrate` subcommands in slice 1 (calibrate is a flag).

```
harnessgap scan [--repo <path>] [--since 30d] [--limit N] [--json] [--calibrate] [--bootstrap]
```

- `--repo` — filter to a repo's sessions; defaults to git toplevel of `cwd`.
- `--since` — time window (e.g. `30d`); default: all.
- `--limit` — cap sessions scanned, for fast iteration.
- `--json` — emit the JSON envelope below (for piping).
- `--calibrate` — print per-signal distributions (min / p50 / p90 / max) + active thresholds + mode, as a human table, or (with `--json`) an object `{ mode, session_count, flag_pct, signals: { <name>: {min,p50,p90,max,active_threshold} } }`. **Aggregate statistics only** — no per-session examples, no commands, no prose.
- `--bootstrap` — force bootstrap mode (for testing).
- `--version`, `--help` — standard.

`--redact-paths` (hash file paths, mask `repo` to basename) is **roadmap, not slice 1** — needed before any team sharing of `--json` output.

### `--json` output schema

```jsonc
{ "schema_version": 1, "repo": "...", "mode": "percentile",
  "session_count": 142,
  "warnings": { "malformed_lines": 3, "oversized_lines": 0, "skipped_sessions": 1,
                "truncated_sessions": 2, "symlinks_rejected": 0, "unresolvable_cwd": 0 },
  "sessions": [ /* struggle records (§5) */ ],
  "areas": [ { "key": "src/billing", "sessions_total": 12, "sessions_flagged": 7,
               "mean_score": 93,
               "top_signals": [ {"name":"reread","value":7,"display":"reread(7)"}, ... ] } ] }
```

A session mapping to multiple areas counts (weighted) toward each. `mean_score` is computed over flagged sessions touching the area. `warnings` is **integer counts only** — never line content or offsets.

## 7. Config (`.harnessgap.yml`, slice-1 subset)

```yaml
detector:
  thresholds_as: percentile        # percentile (default) | absolute
  flag_pct: 90                     # percentile mode: top (100-flag_pct)% of composites
  bootstrap_session_floor: 30      # K — below this, bootstrap mode is automatic
  bootstrap_flag_pct: 70           # bootstrap mode: flag if composite ≥ this OR ≥2 signals trip
  reread_threshold: 5
  correction_window_ms: 120000
  signal_weights:
    explore_ratio: 1.0
    reread: 1.0
    failure_streak: 1.0
    corrections: 1.0
    abandonment: 0.5               # low until task fingerprinting lands (research-session suppression also applies)
    oscillation: 1.2
    wall_clock_per_line: 1.0
  bootstrap_thresholds:            # conservative priors; configurable
    explore_ratio: 10
    reread: 5
    failure_streak: 3
    corrections: 2
    abandonment: true
    oscillation: 2
    wall_clock_per_line_ms: 300000
areas:
  ignore: [node_modules, build, target, dist, .git, .next, vendor]
  min_weight: 0.40
  min_depth: 2
  touch_weights: { edit: 3, read: 2, exec: 1 }
  tail_fraction: 0.25              # abandonment tail
  explore_ratio_min: 0.8           # abandonment explore-ratio gate
  suppress_abandonment_when_no_exec: true
  test_cmd_patterns: [test, spec, pytest, "npm test", "npm run test", make, "cargo test", "go test", jest, vitest]
# docs_dirs / synthesizer / router / tasks / repo — NOT in slice 1
```

`scan` runs with no config file using these defaults. The file is optional overrides.

## 8. Output (leaderboard, human)

```
harnessgap scan — repo: ~/code/billing-api · 142 sessions · mode: percentile

AREA                        FLAGGED  MEAN SCORE  TOP SIGNALS
src/billing/charge                 7        93    reread(7) oscillation(4) corrections(3)
src/billing/refund                 4        81    failure_streak(3) explore_ratio(95th)
src/api/routes                     3        76    wall_clock_per_line(540s) abandonment(yes)
…
12 areas flagged · 7 unflagged · 3 unlocalized · bootstrap: 0 sessions
warnings: 3 malformed lines, 2 truncated sessions
```

Sorted by flagged-count desc, then mean score desc. **`TOP SIGNALS` rule:** top 3 signals by percentile rank (percentile mode) or by raw value (bootstrap / booleans), formatted `name(value)` — value = raw count for counts, `Nth` for percentile ranks, `Ns`/`Nms` for durations, `yes`/`no` for booleans. `--json` emits the schema in §6.

## 9. Error handling — fail-open

Slice 1 is stateless batch: no hooks in the agent's hot path, no disk writes, no network. A bug's worst case is "wrong leaderboard," never "broke a session."

- Malformed transcript line → skip, increment `warnings.malformed_lines`, continue. Never abort on one bad line. **Warnings are integer counts only — never line content.**
- Oversized line (>1 MB) → skip, increment `warnings.oversized_lines`.
- No sessions found → clear message, exit 0.
- Session over the event cap → drop tail, tag record `truncated`, increment `warnings.truncated_sessions`.
- Symlink in transcript dir → reject, increment `warnings.symlinks_rejected`.
- `cwd` unresolvable → skip session, increment `warnings.unresolvable_cwd`, suggest `--repo`.
- Exit codes: `0` for success (incl. "no sessions"); non-zero only for genuine misconfiguration (unreadable/invalid config, missing runtime prerequisites).

## 10. Testing

- **Labeled fixture corpus** — 10–20 anonymized transcripts, each tagged expected-flagged + expected-top-signals, covering: clean-quick, heavy-exploration, oscillation, failure-streak, abandonment (incl. a suppressed research session), TDD red-green (must NOT flag oscillation). Doubles as the regression suite and the seed for later percentile bootstrapping.
- **Secret-shape fixture** — transcripts containing each scrubber pattern (§4); asserts none survive in normalized events. (This protects slice 2's `struggle.jsonl` reuse.)
- **Malformed-transcript fixture** — asserts no raw prose appears in any output path (stdout, `--json`, `--calibrate`, warnings).
- **Safety fixtures** — symlinked transcript (rejected), unresolvable `cwd` (skipped), oversized line (skipped).
- **Unit tests on pure functions** — per-line adapter parse, scrubber (each pattern), each signal computer, percentile/bootstrap scorer, area clustering, git-cwd sandboxing. All pure; TDD applies naturally at implementation time.
- **Snapshot test** — leaderboard output on the fixed fixture set, catching scoring and format regressions.

## 11. Privacy

- **No network.** No `fetch`/`http`/`https`/`net` imports; a dependency audit confirms no egress. Transcripts never leave the machine.
- Secret scrubbing happens in the adapter, before events enter the pipeline, using the pattern catalog in §4.
- No raw message text is stored — only derived flags; output paths are spec-enforced to carry no prose (§4, §9, §10).
- **Nothing is written to disk by harnessgap.** (OS-level page cache/swap are out of scope and common to any process that reads files; git is invoked via `execFile` with no shell, so no command lands in shell history.)
- User interrupts may not be recorded in transcripts; correction detection is therefore content-based and the interrupt channel is best-effort.

## 12. Open questions (slice-specific)

1. **Signal weights & bootstrap thresholds** — the §7 values are priors; the slice's job is to learn which reflect felt struggle. Expect revision after dogfood.
2. **Oscillation v1 fidelity** — without full revert detection, how many real oscillation struggles does the `edit→test-fail→edit-same-file` proxy miss? Quantify against the fixture corpus.
3. **Area clustering in monorepos** — path-prefix will mis-cluster some monorepos (parent design §12.6); acceptable for v1, but note where it misleads the leaderboard.
4. **K=30 floor** — is 30 the right percentile/bootstrap switch, or does calibration need more history to be meaningful at small n?
5. **Corrections interrupt channel** — are user interrupts actually recorded in transcript JSONL? If not, the `corrections` signal relies on content patterns alone; verify against real transcripts during implementation.
6. **Success-criterion calibration** — are precision ≥60% / recall ≥60% / zero-non-struggle-in-top-5 the right thresholds, or too strict/loose on the dogfood repo?

## 13. Out of scope / deferred

`context_thrash` (until ingest hooks) · `expensive_success` (until token-usage wiring) · `failure_streak` same-command-retry clause (until cmd normalization) · task-unit fingerprinting · ambient `repo` unit · Diagnoser · Synthesizer · Curator/review · proposals/docs · Router/injection · Measurement (consumption + read-vs-not-read delta) · ingest hooks + `.harnessgap/` state + team `struggle.jsonl` · Codex/OpenCode/Qwen adapters · corpus-seeded percentiles · `--redact-paths` output mode · Bun single-binary packaging.

## TL;DR

Slice 1 is a **stateless, detection-only** CLI: `harnessgap scan` reads Claude Code transcripts, normalizes them through a **versioned, secret-scrubbed event schema** (pattern-catalog scrubbing reused verbatim for slice 2 persistence), runs **seven deterministic signals** (down from nine — `context_thrash` is hook-only and `expensive_success` needs token data, both deferred), scores them as a **percentile of composites** (true top-10% flagging; absolute-threshold bootstrap when history is thin), localizes struggle to **areas** via path-prefix clustering, and prints a **leaderboard** with fully specified `--json`/`--calibrate`/warnings contracts. Hardened for safety (input line caps, symlink rejection, sandboxed git). Success is a real precision+recall gate on a rich-history repo. The normalized-event schema and pure detector are zero wasted work when ingest/diagnosis/routing land in later slices.
