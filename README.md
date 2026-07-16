# harnessgap

A **stateless, detection-only** CLI that reads Claude Code transcript logs and
produces a *struggle leaderboard* — the areas of a repo where Claude Code
sessions show the deterministic signals of friction (rereads, failure streaks,
oscillating edits, abandonment, etc.).

This is **Slice 1**: it writes nothing, installs nothing, persists nothing. It
only prints a leaderboard to stdout. Diagnosis, synthesis, routing, and
measurement are deferred to later slices.

> **Full manual:** [docs/CONSUMER_GUIDE.md](docs/CONSUMER_GUIDE.md) — output formats, scoring modes, calibration, FAQ. **Internals:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Install

```
npx harnessgap
```

Or build from source:

```
npm install
npm run build
node dist/cli.js scan
```

Requires Node >= 22.12.

## Usage

```
harnessgap scan [options]
```

`scan` is the default command. It walks Claude Code transcripts under
`~/.claude/projects/`, filters to a repo, runs the detector, and prints a
leaderboard of struggle areas.

### Flags

| Flag | Description |
| --- | --- |
| `--repo <path>` | Filter to sessions whose resolved main-repo root matches this path. The path itself is resolved to the project's main repo, so `--repo <worktree>` or `--repo <subdir>` matches the whole project (main checkout + all worktrees). Defaults to the main repo of the current working directory. |
| `--since <dur>` | Only sessions started within this lookback, e.g. `30d`, `12h`, `5m`, `10s`. Default: all sessions. |
| `--limit <n>` | Cap the number of sessions scanned. Useful for fast iteration. |
| `--json` | Emit the JSON envelope (for piping) instead of the human-readable leaderboard table. |
| `--calibrate` | Print per-signal distributions (min / p50 / p90 / max) plus active thresholds and scoring mode. Aggregate statistics only — no per-session detail. |
| `--bootstrap` | Force bootstrap (absolute-threshold) scoring mode instead of percentile. |
| `--config <path>` | Path to a `.harnessgap.yml` config file. Default: looks for `.harnessgap.yml` in the cwd. |
| `--claude-dir <path>` | Claude Code config directory (contains `projects/`). Default: `~/.claude`. |
| `--version` | Print the harnessgap version and exit. |
| `--help` | Print help and exit. |

## Session-end reflect (Slice 3)

`harnessgap reflect` runs the detector on a **single** session (the one just
finished) and emits a `ReflectFinding` whose `trip = flagged && !zero_edit`
decides whether to prompt reflection. `harnessgap init claude` wires that into a
trip-gated Claude Code `Stop` hook so reflection happens automatically at session
end. The detection core is unchanged from Slice 1/2 — `reflect` reuses the same
detector + bootstrap mode.

### `init claude`

```
harnessgap init claude
```

Installs three artifacts under `<cwd>/.claude/` (idempotent — re-run to refresh):

- a **fail-open Stop-hook wrapper** — on every stop it runs
  `harnessgap reflect --transcript <just-finished> --format hook-stop`; any fault
  short-circuits to `{}` so the hook never blocks on a harnessgap error.
- an idempotent **`settings.json`** merge — appends the harnessgap command to
  `hooks.Stop` exactly once, preserving your existing hooks and keys.
- the **`/reflect` command** — guides filling one `ReflectFrame` (cost → missing
  context → one suggested change with a path-checked `target_path`).

The hook blocks the stop **only when `trip` is true**, returning
`{ "decision": "block", "reason": … }` (the `reason` carries the finding summary
— top friction areas + active signals; no transcript prose). Otherwise it returns
`{}` and the session ends normally. `stop_hook_active` guards against loops. The
agent presents the recommendation in-session and the user acts — **nothing is
auto-written to the repo**.

### `reflect` flags

| Flag | Description |
| --- | --- |
| `--transcript <path>` | Reflect on one given transcript file (the per-stop hook path). |
| `--latest` | Reflect on the most-recent finished session for `--repo` (the manual `/reflect` path). |
| `--repo <path>` | Target repo toplevel, used with `--latest` (resolved to the project's main repo, like `scan`). |
| `--exclude-session <id>` | Exclude a session id, used with `--latest`. |
| `--stop-hook-active` | Mark the Claude Code Stop hook as already active (short-circuit to allow). |
| `--format <json\|hook-stop>` | Output form: the json `ReflectFinding` (default) or the `Stop` hook payload. |
| `--config <path>` | Path to a `.harnessgap.yml` config file. |
| `--claude-dir <path>` | Claude Code config directory (contains `projects/`). Default: `~/.claude`. |

### Calibration notes (dogfood, not promises)

`trip = flagged && !zero_edit` reuses the bootstrap flag — calibrated for the
*batch* leaderboard, not a per-session *interruption*. At n=1 it may fire on
ordinary sessions (e.g. a single debug loop hitting `reread` + `wall_clock`).
Trip-gate sensitivity is the top open question for this slice: measure how often
the hook fires on clean sessions, and if too often, tighten it (drop the
`≥ 2 signals` disjunction, require `≥ k`, or add a `detector.reflect` block). The
`ReflectFrame` recommendation is advisory and human-reviewed; `path_verified` is
self-attested.

## Configuration (`.harnessgap.yml`)

Optional. `scan` runs with built-in defaults if no file is present. The file is
a YAML object with two top-level keys — `detector` and `areas`. Anything else is
rejected. Deep-merged over the defaults (arrays replace, they do not concatenate).

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
  ambient:                         # repo-level elevated-baseline assessment (always printed)
    breadth_floor: 4               # orientation path fires when median pre-edit dir-breadth >= this
    file_depth_floor: 12           # ...or when median pre-edit file-depth >= this
    struggle_rate_threshold: 0.30  # acute path fires when bootstrap struggle rate >= this
    min_sessions: 10               # below this session count, baseline is "too few sessions"
    severity_min_sessions: 20      # below this, an elevated finding is severity "unrated"

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

## Success criterion

Slice 1 is validated by a **manual dogfood gate**, not an automated test. On a
real repo with rich Claude Code session history, the user prepares, in advance:

- **>= 5 areas they recall as struggle**, and
- **>= 5 areas they recall as non-struggle.**

`harnessgap scan` must then satisfy all three against its leaderboard:

- **Precision** — of the tool's top 5 flagged areas, >= 3 are in the user's
  struggle set (>= 60%).
- **Recall** — of the user's >= 5 struggle areas, >= 3 are flagged (>= 60%).
- **No false positives in the top 5** — none of the user's non-struggle areas
  appear in the top 5 flagged.

The labeled fixture corpus and snapshot test (see `test/corpus.test.ts`,
`test/snapshot.test.ts`) serve as the automated regression proxy for this gate.

## Privacy

harnessgap is built to run offline on private transcripts. Five guarantees:

1. **No network.** No `fetch` / `http` / `https` / `net` / `undici` imports and
   no `fetch()` calls anywhere in `src/`. Transcripts never leave the machine.
   Enforced by `test/egress.test.ts`, which scans every `src/**/*.ts` file for
   forbidden network imports and fetch calls, and runs in CI.
2. **No disk writes (detection path).** `scan` and `reflect` write nothing to
   disk — they read transcripts and print to stdout. (`harnessgap init claude` is
   the one exception: an explicit opt-in installer that writes the Stop-hook
   wrapper, a `settings.json` merge, and the `/reflect` command under `.claude/`.)
   (OS-level page cache/swap are out of scope and common to any process that reads files.)
3. **Pattern-catalog scrubbing.** Secrets are scrubbed in the adapter, before
   events enter the pipeline, using a fixed pattern catalog (API keys, bearer
   tokens, private keys, connection strings, etc.).
4. **No raw prose in output.** Only derived signal values and integer warning
   counts are emitted. Raw message text, commands, and transcript line content
   never appear in any output path (human table, `--json`, `--calibrate`,
   warnings).
5. **Stat-based repo resolution (no git invocation).** The repo for each
   session is found by walking up from its cwd and `stat`-ing `<ancestor>/.git`
   — no `git` process is spawned at all, so nothing lands in shell history.
   Worktree checkouts (`.git` file) resolve up to the main repo (`.git`
   directory), so a project's main checkout and all worktrees aggregate
   together, and sessions whose cwd was a since-deleted worktree are recovered.
   Symlinks in transcript directories are rejected.

## Dependency egress audit

Runtime dependencies are exactly two, both no-egress (neither performs network
I/O):

- [`commander`](https://www.npmjs.com/package/commander) — CLI argument parsing.
- [`yaml`](https://www.npmjs.com/package/yaml) — `.harnessgap.yml` parsing.

Dev dependencies (`typescript`, `vitest`, `tsx`, `@types/node`) are never shipped
and excluded from the published `files` set (`["dist"]`).

The audit is locked by `test/packaging.test.ts`, which runs
`npm ls --all --omit=dev --json` (via `execFile`, no shell) and asserts the
runtime `dependencies` object has exactly the keys `commander` and `yaml`. The
`test/egress.test.ts` gate additionally asserts no `src/` file imports a network
module or calls `fetch()`. Both run in CI.

## Spec

Full design: [`docs/superpowers/specs/archive/2026-07-12-harnessgap-detection-slice-design.md`](docs/superpowers/specs/archive/2026-07-12-harnessgap-detection-slice-design.md).
