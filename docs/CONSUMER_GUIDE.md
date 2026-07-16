# harnessgap — Consumer Guide

A stateless, detection-only CLI that reads Claude Code transcript logs and
produces a **struggle leaderboard** — the areas of a repo where Claude Code
sessions show deterministic signals of friction (rereads, failure streaks,
oscillating edits, abandonment, and more).

This is Slice 1: it **writes nothing, installs nothing, persists nothing**. It
reads transcripts under `~/.claude/projects/` and prints a leaderboard to stdout.
Diagnosis, synthesis, routing, and measurement are deferred to later slices.

For a one-page summary see [README.md](../README.md). For internals see
[ARCHITECTURE.md](ARCHITECTURE.md).

---

## Install

### Run without installing

```
npx harnessgap
```

### Build from source

```
git clone <repo>
cd harnessgap
npm install
npm run build
node dist/cli.js scan
```

Requires **Node >= 22.12** (the `commander` 15 dependency requires it).

---

## Quick start

From inside a git repository that you work on with Claude Code:

```
harnessgap scan
```

This walks every Claude Code session whose resolved main-repo root matches the
current repo, runs the detector, and prints a leaderboard of struggle areas.

---

## The `scan` command

```
harnessgap scan [options]
```

`scan` is the default command.

### Flags

| Flag | Default | Description |
| --- | --- | --- |
| `--repo <path>` | main repo of the cwd | Filter to sessions whose resolved main-repo root matches this path. The path is itself resolved to the project's main repo, so `--repo <worktree>` or `--repo <subdir>` matches the whole project (main checkout + all worktrees). |
| `--since <dur>` | all sessions | Only sessions started within this lookback: `30d`, `12h`, `5m`, `10s`. |
| `--limit <n>` | none | Cap the number of sessions scanned. Useful for fast iteration. |
| `--json` | off | Emit the JSON envelope instead of the human-readable table. |
| `--calibrate` | off | Print per-signal distributions + active thresholds + scoring mode. Aggregate only — no per-session detail. |
| `--bootstrap` | off | Force bootstrap (absolute-threshold) scoring instead of percentile. |
| `--config <path>` | `.harnessgap.yml` in cwd | Path to a config file. |
| `--claude-dir <path>` | `~/.claude` | Claude Code config directory (contains `projects/`). |
| `--version` | — | Print the harnessgap version and exit. |
| `--help` | — | Print help and exit. |

### Examples

```
# scan the current repo, last 30 days
harnessgap scan --since 30d

# scan a different repo
harnessgap scan --repo ~/projects/myapp

# pipe the full envelope to jq
harnessgap scan --json | jq '.areas[0:5'

# inspect signal distributions before trusting the leaderboard
harnessgap scan --calibrate

# fast iteration on a large history
harnessgap scan --limit 50
```

---

## Configuration (`.harnessgap.yml`)

Optional. `scan` runs with built-in defaults if no file is present. The file is a
YAML object with two top-level keys — `detector` and `areas`. Anything else is
**rejected**. Values are deep-merged over the defaults (arrays replace, they do
not concatenate).

```yaml
detector:
  thresholds_as: percentile        # percentile (default) | absolute
  flag_pct: 90                     # percentile mode: flag the top (100 - flag_pct)% of composites
  bootstrap_session_floor: 30      # below this session count, bootstrap mode is automatic
  bootstrap_flag_pct: 70           # bootstrap mode: flag if composite >= this OR >= 2 signals trip
  reread_threshold: 5              # a file read count at/above this counts as a reread
  correction_window_ms: 120000     # window after an edit in which a follow-up edit counts as a correction
  signal_weights:                  # composite weights per signal
    explore_ratio: 1.0
    reread: 1.0
    failure_streak: 1.0
    corrections: 1.0
    abandonment: 0.5               # low until task fingerprinting lands
    oscillation: 1.2
    wall_clock_per_line: 1.0
  bootstrap_thresholds:            # conservative absolute priors used in bootstrap mode
    explore_ratio: 10
    reread: 5
    failure_streak: 3
    corrections: 2
    abandonment: true
    oscillation: 2
    wall_clock_per_line_ms: 300000

areas:
  ignore: [node_modules, build, target, dist, .git, .next, vendor]  # path prefixes excluded from area clustering
  min_weight: 0.40                 # minimum cumulative touch weight for an area to appear
  min_depth: 2                     # minimum path depth for an area key
  touch_weights: { edit: 3, read: 2, exec: 1 }  # weight of each touch kind
  tail_fraction: 0.25              # fraction of a session's events that defines the abandonment tail
  explore_ratio_min: 0.8           # abandonment explore-ratio gate
  suppress_abandonment_when_no_exec: true
  test_cmd_patterns: [test, spec, pytest, "npm test", "npm run test", make, "cargo test", "go test", jest, vitest]
```

Keys not shown here (`docs_dirs`, `synthesizer`, `router`, `tasks`, `repo`) are
**not** part of Slice 1 and will be rejected.

---

## Output formats

### Human-readable leaderboard (default)

A column-aligned table:

```
harnessgap scan — repo: /home/me/myapp · 142 sessions · mode: percentile
AREA                                | FLAGGED | MEAN SCORE | TOP SIGNALS
src/billing                         |       7 |       82.4 | failure_streak, reread
src/auth                            |       5 |       74.1 | oscillation, corrections
src/api                             |       4 |       68.9 | reread, explore_ratio
...
7 areas flagged · 3 unflagged · 1 unlocalized · bootstrap: 0 sessions
warnings: 2 malformed lines, 1 symlinks rejected
```

Columns:

- **AREA** — the path-prefix cluster key (truncated with `...` if longer than the column).
- **FLAGGED** — number of flagged sessions touching this area (an integer count; a session touches an area or it doesn't).
- **MEAN SCORE** — mean `score_pct` over flagged sessions only.
- **TOP SIGNALS** — up to 3 top contributing signals, formatted `name(value)`: counts as the raw count (`reread(7)`), `explore_ratio` as its repo percentile in percentile mode (`explore_ratio(95th)`) or raw in bootstrap mode, `wall_clock_per_line` as a duration (`540s`), `abandonment` as `yes`/`no`.

The summary line reports flagged / unflagged / unlocalized area counts and the
bootstrap session count (equal to `session_count` only in bootstrap mode). The
warnings line appears only when at least one warning category is non-zero.

### JSON envelope (`--json`)

A single JSON object on stdout, `schema_version: 1`:

```jsonc
{
  "schema_version": 1,
  "repo": "/home/me/myapp",
  "mode": "percentile",            // "percentile" | "bootstrap"
  "session_count": 142,
  "warnings": {
    "malformed_lines": 2,
    "oversized_lines": 0,
    "skipped_sessions": 0,
    "truncated_sessions": 0,
    "symlinks_rejected": 1,
    "unresolvable_cwd": 0
  },
  "sessions": [
    {
      "session_id": "...",
      "repo": "/home/me/myapp",
      "started_at": "2026-07-10T13:22:01.000Z",
      "duration_ms": 1842000,
      "score_pct": 82.4,
      "mode": "percentile",
      "flagged": true,
      "truncated": false,
      "event_count": 311,
      "areas": [ { "key": "src/billing", "weight": 3.0 } ],
      "signals": {
        "explore_ratio": 0.62,
        "reread": 4,
        "failure_streak": 2,
        "corrections": 1,
        "abandonment": false,
        "oscillation": 1,
        "wall_clock_per_line_ms": 412000.0
      }
    }
    // ...
  ],
  "areas": [
    {
      "key": "src/billing",
      "sessions_total": 9,
      "sessions_flagged": 7,
      "mean_score": 82.4,
      "top_signals": [
        { "name": "failure_streak", "value": 2, "display": "failure_streak=2" }
      ]
    }
    // ...
  ]
}
```

Notes:

- `signals.explore_ratio` and `signals.wall_clock_per_line_ms` are `null` when not computable (e.g. no edits → `wall_clock_per_line_ms` is null; no exec/read → `explore_ratio` is null).
- `signals.abandonment` is a boolean.
- Sessions and areas are passed through verbatim (already scrubbed of prose upstream). No raw message text, commands, or transcript content appears anywhere in the envelope.

### Calibrate (`--calibrate`)

Per-signal aggregate statistics across sessions — for judging whether the
defaults fit your history before trusting the leaderboard:

```
harnessgap calibrate — mode: percentile · 142 sessions · flag_pct: 90
SIGNAL                |        MIN |        P50 |        P90 |        MAX |  THRESHOLD
explore_ratio         |       0.12 |       0.55 |       0.81 |       0.97 |        0.9
reread                |          0 |          2 |          6 |         19 |          5
failure_streak        |          0 |          0 |          2 |          8 |          3
corrections           |          0 |          0 |          1 |          5 |          2
abandonment           |          0 |          0 |          1 |          1 |          1
oscillation           |          0 |          0 |          1 |          4 |          2
wall_clock_per_line   |      12000 |     180000 |     640000 |    3200000 |     300000
```

- **MIN / P50 / P90 / MAX** — distribution of each signal across sessions (R-7 linear interpolation).
- **THRESHOLD** (`active_threshold`) — the value a signal is currently judged against: in bootstrap mode, the configured `bootstrap_thresholds` value; in percentile mode, the `flag_pct`-percentile of that signal across sessions.
- `abandonment` is boolean; its row is uniformly 0/1.

The JSON form of `--calibrate` is `{mode, session_count, flag_pct, signals: {<name>: {min, p50, p90, max, active_threshold}}}`. No per-session values.

---

## Scoring modes

harnessgap scores each session on a 0–100 composite of its 7 signals, then flags
the top strugglers. Two modes:

- **Percentile** (default when history is sufficient) — a session is flagged if its composite is in the top `(100 - flag_pct)%` of all sessions. The composite is a weighted sum of each signal's percentile rank (rank = fraction of sessions strictly below it). Requires enough sessions to be meaningful.
- **Bootstrap** (automatic below `bootstrap_session_floor`, or forced with `--bootstrap`) — uses conservative absolute thresholds (`bootstrap_thresholds`) instead of relative percentiles. A session is flagged if its composite >= `bootstrap_flag_pct` **or** >= 2 signals trip their absolute threshold.

Mode precedence: `--bootstrap` > `thresholds_as: absolute` > `n < bootstrap_session_floor` > percentile.

Use `--calibrate` to see which mode is active and the distributions behind it.

---

## Session-end reflect (`reflect` + `init claude`, Slice 3)

Slice 3 adds an **event-driven** entry to the detector: instead of a batch
leaderboard, `harnessgap reflect` runs the detector on a **single** session and
emits a `ReflectFinding` whose `trip = flagged && !zero_edit` decides whether to
prompt reflection. `harnessgap init claude` wires it into a trip-gated Claude
Code `Stop` hook so reflection happens automatically when a session ends.

The detection core is unchanged — `reflect` reuses the same detector and
bootstrap mode as `scan`. No new config keys, no new dependencies.

### Install the hook

```
harnessgap init claude
```

Writes three artifacts under `<cwd>/.claude/` (idempotent — safe to re-run):

- **fail-open Stop-hook wrapper** (`harnessgap-stop-hook.js`) — on every stop it
  runs `harnessgap reflect --transcript <just-finished> --format hook-stop`. Any
  fault (missing transcript, spawn error, non-zero exit) short-circuits to `{}` —
  the hook never blocks on a harnessgap error.
- **`settings.json` merge** — appends the harnessgap command to `hooks.Stop`
  exactly once (deduped by command string); all your existing hooks and keys are
  preserved.
- **`/reflect` command** (`commands/reflect.md`) — agent guidance, not detection.

### What happens on stop

The hook blocks the stop **only when `trip` is true**, returning
`{ "decision": "block", "reason": … }`. The `reason` is a static reflection
prompt plus a derived-only summary (up to 3 top area keys + active signals) —
**no transcript prose**. Otherwise it returns `{}` and the session ends normally.
`stop_hook_active` guards against loops.

When blocked, the `/reflect` command (or the agent directly) reads the finding
and fills one **`ReflectFrame`**:

| Field | Meaning |
| --- | --- |
| `cost` | The friction cost this session, tied to the finding's top signal. |
| `missing` | The context that would have helped (a doc, a type, a missing test). |
| `change.target_path` | A repo-relative path to add or improve. |
| `change.kind` | `add` \| `improve` \| `none`. |
| `change.rationale` | Why this change targets the observed cost. |
| `path_verified` | `true` only if `target_path` (or its parent dir for an `add`) was confirmed to exist. |

The agent presents the recommendation in-session and the user acts on it —
**nothing is auto-written to the repo**, and a clean session emits
`change.kind: "none"`.

### `reflect` flags

| Flag | Default | Description |
| --- | --- | --- |
| `--transcript <path>` | — | Reflect on one given transcript file (the per-stop hook path; cheap). |
| `--latest` | off | Reflect on the most-recent finished session for `--repo` (the manual `/reflect` path). |
| `--repo <path>` | main repo of the cwd | Target repo toplevel, used with `--latest` (resolved to the project's main repo). |
| `--exclude-session <id>` | — | Exclude a session id, used with `--latest`. |
| `--stop-hook-active` | off | Mark the Claude Code Stop hook as already active (short-circuit to allow). |
| `--format <json\|hook-stop>` | `json` | Output form: the json `ReflectFinding` or the `Stop` hook payload. |
| `--config <path>` | `.harnessgap.yml` in cwd | Path to a config file. |
| `--claude-dir <path>` | `~/.claude` | Claude Code config directory (contains `projects/`). |

### `ReflectFinding` (`--format json`)

```jsonc
{
  "schema_version": 1,
  "session_id": "...",
  "repo": "/home/me/myapp",
  "mode": "bootstrap",
  "record": { /* the full StruggleRecord — derived signals/areas only, no prose */ },
  "trip": true,          // = record.flagged && !zero_edit
  "zero_edit": false     // no edits this session → trip forced false
}
```

### Calibration notes (dogfood, not promises)

`trip = flagged && !zero_edit` reuses the bootstrap flag — calibrated for the
*batch* leaderboard, not a per-session *interruption*. At n=1 it may fire on
ordinary sessions (e.g. one debug loop hitting `reread` + `wall_clock`).
Trip-gate sensitivity is the top open question for this slice: measure how often
the hook fires on clean sessions, and if too often, tighten it via one of:

- drop the `≥ 2 signals` disjunction and require `composite ≥ bootstrap_flag_pct`;
- raise the trip requirement to `≥ k` signals (e.g. k=3);
- add a dedicated `detector.reflect` config block.

The `ReflectFrame` is LLM-generated and advisory — structure + `path_verified`
mitigate but do not eliminate generic advice, and `path_verified` is
self-attested. The slice ships the mechanism + a deterministic spine; quality is
bounded by the model.

---

## Privacy

harnessgap runs offline on private transcripts. Five guarantees:

1. **No network.** No `fetch` / `http` / `https` / `net` / `undici` imports and no `fetch()` calls anywhere in `src/`. Transcripts never leave the machine. Enforced by `test/egress.test.ts`.
2. **No disk writes (detection path).** `scan` and `reflect` write nothing to disk — they read transcripts and print to stdout. (`harnessgap init claude` is the one exception: an explicit opt-in installer that writes the Stop-hook wrapper, a `settings.json` merge, and the `/reflect` command under `.claude/`.) (OS-level page cache/swap are out of scope and common to any process that reads files.)
3. **Pattern-catalog scrubbing.** Secrets are scrubbed in the adapter, before events enter the pipeline, using a fixed pattern catalog (API keys, bearer tokens, private keys, URL-embedded credentials, credential-file paths, known-format tokens). No entropy heuristic — nothing is guessed.
4. **No raw prose in output.** Only derived signal values, scores, counts, paths, and integer warning counts are emitted. Raw message text, commands, and transcript line content never appear in any output path (human table, `--json`, `--calibrate`, warnings).
5. **Stat-based repo resolution (no git invocation).** The repo for each session is found by walking up from its cwd and `stat`-ing `<ancestor>/.git` — no `git` process is spawned at all (so nothing lands in shell history, and the earlier sandbox/env-var concerns are moot). Worktree checkouts (`.git` file) resolve up to the main repo (`.git` directory), so a project's main checkout and all worktrees aggregate together; sessions whose cwd was a since-deleted worktree are recovered the same way. Symlinks in transcript directories are rejected via `lstat`.

---

## Dependency egress audit

Runtime dependencies are exactly two, both no-egress (neither performs network I/O):

- [`commander`](https://www.npmjs.com/package/commander) — CLI argument parsing.
- [`yaml`](https://www.npmjs.com/package/yaml) — `.harnessgap.yml` parsing.

Dev dependencies (`typescript`, `vitest`, `tsx`, `@types/node`) are never shipped
and excluded from the published `files` set (`["dist"]`). The audit is locked by
`test/packaging.test.ts` (asserts runtime deps are exactly `commander` + `yaml`)
and `test/egress.test.ts` (no `src/` file imports a network module or calls
`fetch()`).

---

## Validating on your repo (the dogfood gate)

Slice 1 is validated by a **manual dogfood gate**, not an automated test. On a
real repo with rich Claude Code session history, prepare in advance:

- **>= 5 areas you recall as struggle**, and
- **>= 5 areas you recall as non-struggle.**

Then `harnessgap scan` must satisfy all three against its leaderboard:

- **Precision** — of the tool's top 5 flagged areas, >= 3 are in your struggle set (>= 60%).
- **Recall** — of your >= 5 struggle areas, >= 3 are flagged (>= 60%).
- **No false positives in the top 5** — none of your non-struggle areas appear in the top 5 flagged.

The labeled fixture corpus and snapshot test (`test/corpus.test.ts`,
`test/snapshot.test.ts`) serve as the automated regression proxy for this gate.

---

## FAQ

**"No sessions found" / `session_count: 0`**
Check `--repo` (it's resolved to the project's main repo, so a worktree path or
subdirectory also works — but a path in a totally different project won't match),
`--claude-dir` (must be the Claude Code config dir containing
`projects/`, default `~/.claude`), and `--since` (too short a window excludes
older sessions). Run `harnessgap scan --calibrate` to confirm the session count
and mode.

**Scores look wrong / everything flagged or nothing flagged**
Inspect the distributions with `--calibrate`. If you have fewer than
`bootstrap_session_floor` (default 30) sessions, scoring is automatically in
bootstrap mode (absolute thresholds) — tune `bootstrap_thresholds` if needed.
With enough history, percentile mode flags the top `(100 - flag_pct)%`.

**An area I expected isn't in the leaderboard**
It may be below `min_weight` (default 0.40 cumulative touch weight), shallower
than `min_depth` (default 2), or under an `ignore` prefix. Adjust `areas` in
`.harnessgap.yml`.

**`wall_clock_per_line` or `explore_ratio` is null**
`wall_clock_per_line_ms` is null when a session produced no edits;
`explore_ratio` is null when there were no exec/read touches. These are
not-computable, not zero.

**Warnings line reports `malformed lines` or `skipped sessions`**
These are integer counts of inputs harnessgap skipped to stay fail-open (a
malformed transcript line, an oversized line, an unresolvable `cwd`, a symlink).
The scan continues; the counts tell you how much was dropped. No prose is
included.

---

## See also

- [README.md](../README.md) — one-page summary (install, flags, config, privacy).
- [ARCHITECTURE.md](ARCHITECTURE.md) — module map, pipeline, normalized event schema, scoring, security model.
- [Design spec](superpowers/specs/archive/2026-07-12-harnessgap-detection-slice-design.md)
- [Implementation plan](superpowers/plans/archive/2026-07-12-harnessgap-detection-slice.md)
