# harnessgap — Detection Slice (Phase 1, Slice 1)

**Status:** approved design → implementation planning
**Date:** 2026-07-12
**Parent design:** `docs/DESIGN.md` (v0.2)
**Runtime:** Node + TypeScript, npm-distributed (`npx harnessgap`); Bun single-binary deferred to a later packaging step.

## 1. Purpose

Validate the core hypothesis of harnessgap: that deterministic signals over agent transcripts, scored with percentile thresholds, produce a struggle leaderboard that matches an experienced user's gut on a repo they know well.

This slice is **detection-only**. It writes no docs, installs no hooks, persists no state. Its output is a leaderboard printed to stdout. Everything downstream in the parent design — diagnosis, synthesis, routing, measurement — waits until detection is proven.

### Success criterion

On a real repo with rich Claude Code session history, `harnessgap scan` produces a leaderboard whose top flagged areas and top signals correspond to where the user felt the agent struggle. Concretely:

- The user can name ≥5 struggle areas in advance; the leaderboard's top flagged areas overlap by **≥3/5**.
- No top-flagged area is an obvious false positive dismissible as "just a big file" — believable precision, even if recall is incomplete.
- Per-signal breakdown and `mode` (percentile vs bootstrap) make the *why* of each flag inspectable, so the mechanism is sanity-checkable, not just the ranking.

This is a qualitative gut-check bar, appropriate to a validation slice. The quantitative ≥25% read-vs-not-read struggle-delta target in the parent design requires routing + measurement and is out of scope here.

## 2. Scope

**In scope**
- `harnessgap scan` CLI: walks Claude Code transcripts, filters to a target repo, runs the pipeline, prints a leaderboard. Stateless — writes nothing to disk.
- Claude Code adapter: transcript JSONL → normalized event schema v1 (secret-scrubbed, size-capped streaming, `schema_version`'d).
- Detector: nine deterministic signals → percentile composite score (absolute-threshold bootstrap when in-repo history is thin) → per-session struggle records keyed by area.
- Area localization: path-prefix clustering with ignore list.
- Minimal `.harnessgap.yml` (detector thresholds + areas only); `scan` works with no config.
- Tests: small labeled fixture corpus + unit tests on pure functions + leaderboard snapshot.

**Out of scope (deferred to later slices)**
- Task-unit fingerprinting (next slice, still pre-diagnosis).
- Ambient `repo` unit + structural-absence detection.
- Diagnoser, Synthesizer, Curator/review, proposals, any doc writing.
- Router / injection hooks; Measurement (doc-read consumption + read-vs-not-read delta).
- Ingest hooks (`SessionEnd`/`Stop`), `.harnessgap/` persistent state, seen-sessions idempotency, team `struggle.jsonl`.
- Other agents (Codex/OpenCode/Qwen) — Claude Code only.
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
stdout   (nothing persisted)
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
      "ok": true, "exit": 0, "duration_ms": 1234,
      "correction": { "matched": true, "shape": "negation" }  // user_msg only
    }
  ]
}
```

The detector consumes, per event, only: `t`, `kind`, `tool`, `input_digest.files`, `input_digest.cmd` (exec), `input_digest.lines_changed` (edit), `ok`/`exit`, `duration_ms`, and the `correction` flag. Keeping this surface minimal is what makes the detector pure and testable.

### Secret scrubbing — in the adapter

Events are clean by construction: scrubbing happens in the adapter, before the event enters the pipeline. Although slice 1 writes nothing to disk, scrubbing here means (a) no secrets reach debug/leaderboard output, and (b) slice 2 persistence inherits it for free. Strips, from `input_digest.cmd` and file paths: env-var assignments (`KEY=…`), `Authorization`/`Bearer` headers, reads of `.env`/`*.pem`/`*.key`, and high-entropy tokens.

### No raw message text

User/assistant prose never enters the contract. The adapter classifies correction shapes (negation, "actually", "that's wrong", interrupt events, etc.) and emits only the `correction` flag — not the sentence. This matches the parent design's "never transcript text" ethos and minimizes the privacy surface. (Task-fingerprinting, which will need a "leading user message" bucket, is a later slice's concern.)

### Size-capped streaming

Transcripts are parsed line-by-line (JSONL), never slurped. Caps: `cmd`/`query` length ≤ 512 chars; files per digest ≤ 50; events per session ≤ 5000 (tail summarized, record tagged `truncated`). The detector only needs tool-call shape + timings, so capping is aggressive and lossless for detection.

### Tool taxonomy mapping

Claude Code tool → normalized: `Read`→read · `Grep`/`Glob`→search · `LS`→list · `Edit`/`Write`/`NotebookEdit`→edit · `Bash`→exec · everything else (`Task`, `WebSearch`, `WebFetch`, MCP tools)→other. Six values; this is all the detector needs and what makes later per-agent adapters cheap.

### Repo derivation

`repo` = git toplevel of the session's `cwd` (read from transcript events). `scan --repo <path>` filters envelopes to that toplevel. Sessions whose `cwd` can't be resolved to a git repo are skipped with a warning.

## 5. Detector

### Signals (nine)

Each is a cheap heuristic over normalized events. Slice 1 keeps all nine so the leaderboard can reveal which actually correlate with felt struggle.

| Signal | v1 definition | Inputs |
|---|---|---|
| `explore_ratio` | `search+read+list` calls before first `edit`; explore-calls per edited line | tool kinds, edit count, `lines_changed` |
| `reread` | count of distinct files read ≥ `reread_threshold` times | file paths |
| `failure_streak` | longest run of consecutive non-zero-exit `exec`; same-`cmd` retries | exec exit codes, `cmd` |
| `corrections` | count of `correction` flags arriving shortly after an assistant action | `correction` flag, timestamps |
| `context_thrash` | `PreCompact` event count | compaction events |
| `abandonment` | explore-heavy tail with zero edits *(boolean regime)* | tool kinds, edit count |
| `oscillation` | `edit → exec(fail) → edit-same-file` cycles *(v1: no full revert detection)* | edit+exec sequencing per file |
| `wall_clock_per_line` | `duration_ms / edited_lines` | duration, `lines_changed` |
| `expensive_success` | derived regime: high `wall_clock_per_line` **and** zero `corrections`/`failure_streak`/`oscillation` *(boolean regime)* | the above |

`expensive_success` is the headline capable-model signal: the case where a strong model "saves" the outcome but not the cost — tests green, no corrections, yet disproportionate effort. Per the parent design it carries the most composite weight for capable-model users.

### Scoring — percentile with absolute bootstrap

- Each signal yields a raw value per session (a ratio, count, duration, or boolean).
- When the repo's session count ≥ `bootstrap_session_floor` (K, default 12), each numeric signal value is converted to a **percentile rank (0–100) within the repo's session set**.
- **Boolean regime signals** (`abandonment`, `expensive_success`) contribute **0** (absent) or **100** (present) to the composite — they are not percentile-ranked.
- `score_pct` = **weighted mean of signal contributions**, plus a flat `expensive_success_boost` when that regime matches. Weights and boost are configurable (see §7).
- A session is **flagged** when `score_pct ≥ flag_pct` (default 90 → top 10%).
- **Bootstrap mode** (session count < K): each numeric signal falls back to a conservative absolute threshold and contributes 0/100 based on whether it crosses; the record's `mode` is `bootstrap` and the leaderboard tags affected rows so the user knows scoring isn't percentile-calibrated. With rich history this rarely triggers; it exists for thin repos and the first few sessions of any repo.

### Area localization (path-prefix, v1)

- Per session, accumulate **touch-weight** per file (edits weighted above reads above exec references), roll up to ancestor directories, apply `areas.ignore`.
- The session's area(s) = the deepest directory/directories each capturing ≥ `areas.min_weight` (default 0.40) of touch-weight, with depth ≥ `areas.min_depth` (default 2). A session may map to multiple areas, each with a `weight`.
- Import-graph/embeddings clustering is explicitly v2 (per parent design §12.6).

### Struggle record (per session, in-memory only in slice 1)

```jsonc
{ "session_id": "…", "repo": "…", "started_at": "…", "duration_ms": 1234567,
  "score_pct": 93, "mode": "percentile",           // or "bootstrap"
  "flagged": true,
  "areas": [ { "key": "src/billing", "weight": 0.82 } ],
  "signals": { "explore_ratio": 14.2, "reread": 7, "failure_streak": 2,
               "corrections": 3, "context_thrash": 1, "abandonment": false,
               "oscillation": 4, "wall_clock_per_line_ms": 540000,
               "expensive_success": false } }
```

`signals` holds **raw** values (ratios, counts, durations, booleans); percentile ranks are internal to scoring and not stored per signal. `evidence_refs`, `docs_read`, `docs_injected` are absent — they belong to diagnosis/measurement slices. `mode` makes the bootstrap-vs-percentile distinction honest in output.

## 6. CLI

One command; no `init` or `calibrate` subcommands in slice 1 (calibrate is a flag).

```
harnessgap scan [--repo <path>] [--since 30d] [--limit N] [--json] [--calibrate] [--bootstrap]
```

- `--repo` — filter to a repo's sessions; defaults to git toplevel of `cwd`.
- `--since` — time window (e.g. `30d`); default: all.
- `--limit` — cap sessions scanned, for fast iteration.
- `--json` — emit struggle records + aggregated areas as JSON for piping.
- `--calibrate` — print the repo's signal distributions + current thresholds instead of the leaderboard (the parent design's "reporting, not prerequisite" calibration).
- `--bootstrap` — force absolute-threshold mode (for testing).
- `--version`, `--help` — standard.

## 7. Config (`.harnessgap.yml`, slice-1 subset)

```yaml
detector:
  thresholds_as: percentile        # percentile (default) | absolute
  flag_pct: 90
  bootstrap_session_floor: 12      # K
  reread_threshold: 3
  signal_weights:
    explore_ratio: 1.0
    reread: 1.0
    failure_streak: 1.0
    corrections: 1.0
    context_thrash: 0.8
    abandonment: 0.7
    oscillation: 1.2
    wall_clock_per_line: 1.0
  expensive_success_boost: 15      # flat score_pct boost when regime matches
areas:
  ignore: [node_modules, build, target, dist, .git, .next, vendor]
  min_weight: 0.40
  min_depth: 2
# docs_dirs / synthesizer / router / tasks / repo — NOT in slice 1
```

`scan` runs with no config file using these defaults. The file is optional overrides.

## 8. Output (leaderboard)

Human form:

```
harnessgap scan — repo: ~/code/billing-api · 142 sessions · mode: percentile

AREA                        FLAGGED  MEAN SCORE  TOP SIGNALS
src/billing/charge                 7        93    reread(7) oscillation(4) corrections(3)
src/billing/refund                 4        81    failure_streak(3) explore_ratio(95th)
src/api/routes                     3        76    wall_clock_per_line(540s) abandonment(2)
…
12 areas flagged · 7 unflagged · bootstrap: 0 sessions
```

Sorted by flagged-count desc, then mean score desc. `--json` emits the struggle records and aggregated area summary.

## 9. Error handling — fail-open

Slice 1 is stateless batch: no hooks in the agent's hot path, no disk writes, no network. A bug's worst case is "wrong leaderboard," never "broke a session."

- Malformed transcript line → skip the line, count in a `warnings` summary, continue. Never abort on one bad line.
- No sessions found → clear message, exit 0.
- Session over the event cap → summarize tail, tag record `truncated`.
- Repo auto-detect fails (no git / no `cwd`) → warn, skip the session, suggest `--repo`.
- Only genuine misconfiguration (e.g. unreadable config file) exits non-zero.

## 10. Testing

- **Labeled fixture corpus** — 10–20 anonymized transcripts, each tagged expected-flagged + expected-top-signals, covering: clean-quick, heavy-exploration, oscillation, failure-streak, abandonment, expensive-success. Doubles as the regression suite and the seed for later percentile bootstrapping ("build once, use twice").
- **Unit tests on pure functions** — per-line adapter parse, scrubber (secret shapes), each signal computer, percentile/bootstrap scorer, area clustering. All pure; TDD applies naturally at implementation time.
- **Snapshot test** — leaderboard output on the fixed fixture set, catching scoring and format regressions.

## 11. Privacy

- Detection is pure local heuristics; transcripts never leave the machine.
- Secret scrubbing happens in the adapter, before events enter the pipeline.
- No raw message text is stored — only derived flags.
- Nothing is persisted or transmitted in slice 1.

## 12. Open questions (slice-specific)

1. **Signal weights** — the defaults in §7 are a prior; the slice's job is to learn which weights reflect felt struggle. Expect revision after dogfood.
2. **Bootstrap absolute thresholds** — the conservative thresholds for thin-history mode need to be chosen so they neither fire on everything nor stay silent.
3. **`expensive_success` regime cutoff** — what `wall_clock_per_line` threshold counts as "high" before the regime (and its boost) applies? Needs a percentile or absolute cutoff decided during implementation.
4. **Oscillation v1 fidelity** — without full revert detection, how many real oscillation struggles does the `edit→exec(fail)→edit-same-file` proxy miss? Quantify against the fixture corpus.
5. **Area clustering in monorepos** — path-prefix will mis-cluster some monorepos (parent design §12.6); acceptable for v1, but note where it misleads the leaderboard.
6. **K=12 floor** — is 12 sessions the right percentile/bootstrap switch, or does calibration need more history to be meaningful?

## 13. Out of scope / deferred

Task-unit fingerprinting · ambient `repo` unit · Diagnoser · Synthesizer · Curator/review · proposals/docs · Router/injection · Measurement (consumption + read-vs-not-read delta) · ingest hooks + `.harnessgap/` state + team `struggle.jsonl` · Codex/OpenCode/Qwen adapters · corpus-seeded percentiles · Bun single-binary packaging.

## TL;DR

Slice 1 is a **stateless, detection-only** CLI: `harnessgap scan` reads Claude Code transcripts, normalizes them through a **versioned, secret-scrubbed event schema** (the reuse seam for later hooks), runs **nine deterministic signals** scored with **percentile thresholds** (absolute-threshold bootstrap when history is thin), localizes struggle to **areas** via path-prefix clustering, and prints a **leaderboard**. No hooks, no state, no docs, no diagnosis — just the cheapest end-to-end test of whether transcript signals match felt struggle. Success is a qualitative gut-check on a rich-history repo (≥3/5 overlap of top flagged areas with recalled struggle, believable precision). The normalized-event schema and pure detector are zero wasted work when ingest/diagnosis/routing land in later slices.
