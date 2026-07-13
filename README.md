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
2. **No disk writes.** harnessgap writes nothing to disk. It reads transcripts
   and prints to stdout. (OS-level page cache/swap are out of scope and common
   to any process that reads files.)
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
