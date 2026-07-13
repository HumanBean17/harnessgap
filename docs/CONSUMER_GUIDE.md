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

This walks every Claude Code session whose resolved repo toplevel matches the
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
| `--repo <path>` | git toplevel of the cwd | Filter to sessions whose resolved repo toplevel matches this path. |
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
- **FLAGGED** — number of flagged sessions touching this area (weighted; may be fractional when area weights differ).
- **MEAN SCORE** — mean `score_pct` over flagged sessions only.
- **TOP SIGNALS** — the top contributing signals for that area.

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

## Privacy

harnessgap runs offline on private transcripts. Five guarantees:

1. **No network.** No `fetch` / `http` / `https` / `net` / `undici` imports and no `fetch()` calls anywhere in `src/`. Transcripts never leave the machine. Enforced by `test/egress.test.ts`.
2. **No disk writes.** harnessgap writes nothing to disk — it reads transcripts and prints to stdout. (OS-level page cache/swap are out of scope and common to any process that reads files.)
3. **Pattern-catalog scrubbing.** Secrets are scrubbed in the adapter, before events enter the pipeline, using a fixed pattern catalog (API keys, bearer tokens, private keys, URL-embedded credentials, credential-file paths, known-format tokens). No entropy heuristic — nothing is guessed.
4. **No raw prose in output.** Only derived signal values, scores, counts, paths, and integer warning counts are emitted. Raw message text, commands, and transcript line content never appear in any output path (human table, `--json`, `--calibrate`, warnings).
5. **Sandboxed git.** `git` is invoked via `execFile` with no shell (so no command lands in shell history), with `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, and rev-parse only. Symlinks in transcript directories are rejected via `lstat`.

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
Check `--repo` (it must match the resolved git toplevel of the sessions, not a
subdirectory), `--claude-dir` (must be the Claude Code config dir containing
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
