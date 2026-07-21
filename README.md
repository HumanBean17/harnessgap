# harnessgap

A **stateless, detection-only** CLI that reads agent transcript logs —
**Claude Code**, **Qwen Code**, and **GigaCode** — and produces a
*struggle leaderboard* — the areas of a repo where sessions show the
deterministic signals of friction (rereads, failure streaks, oscillating edits,
abandonment, etc.).

The **default `scan` path is detection-only**: it writes nothing, installs
nothing, persists nothing — it only prints a leaderboard to stdout. Cause
attribution is available as an opt-in via `scan --diagnose` (Slice 4);
synthesis, routing, and measurement are deferred to later slices.

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

`scan` is the default command. By default it walks Claude Code transcripts under
`~/.claude/projects/`; `--harness <id>` selects Qwen Code or GigaCode (see
[Supported harnesses](#supported-harnesses) below). It filters to a repo, runs
the detector, and prints a leaderboard of struggle areas. A bare `scan` with no
flags is unchanged from prior releases (Claude Code, `~/.claude`).

### Flags

| Flag | Description |
| --- | --- |
| `--repo <path>` | Filter to sessions whose resolved main-repo root matches this path. The path itself is resolved to the project's main repo, so `--repo <worktree>` or `--repo <subdir>` matches the whole project (main checkout + all worktrees). Defaults to the main repo of the current working directory. |
| `--since <dur>` | Only sessions started within this lookback, e.g. `30d`, `12h`, `5m`, `10s`. Default: all sessions. |
| `--limit <n>` | Cap the number of sessions scanned. Useful for fast iteration. |
| `--json` | Emit the JSON envelope (for piping) instead of the human-readable leaderboard table. |
| `--calibrate` | Print per-signal distributions (min / p50 / p90 / max) plus active thresholds and scoring mode. Aggregate statistics only — no per-session detail. |
| `--bootstrap` | Force bootstrap (absolute-threshold) scoring mode instead of percentile. |
| `--diagnose` | Classify each flagged area into a typed cause (`doc` / `config-doc` / `test-gap` / `refactor-flag` / `inherent-complexity`) or `unclassified`, grounded by signal profile + doc-existence under `docs_dirs`. Opt-in; adds a `CAUSE` column to the table and a `diagnoses` field to `--json`. Default output is byte-identical to Slice 3 when off. Reads `docs/` (local fs, path-confined, no symlinks). |
| `--config <path>` | Path to a `.harnessgap.yml` config file. Default: looks for `.harnessgap.yml` in the cwd. |
| `--harness <id>` | Harness backend to scan: `claude-code` (default) \| `qwen-code` \| `gigacode`. Selects the transcript layout + parser. |
| `--harness-dir <path>` | Harness config directory (contains `projects/`). Default: `~/.claude` \| `~/.qwen` \| `~/.gigacode` per `--harness`. |
| `--claude-dir <path>` | **Deprecated alias** for `--harness claude-code --harness-dir <path>`. Conflicts with `--harness qwen-code\|gigacode`. Retained for backward compatibility. |
| `--version` | Print the harnessgap version and exit. |
| `--help` | Print help and exit. |

## Supported harnesses

Three harness backends ship, all at full scan + init + reflect parity:

| Harness | `--harness` id | Transcript path | Default root |
| --- | --- | --- | --- |
| Claude Code | `claude-code` (default) | `~/.claude/projects/<slug>/*.jsonl` | `~/.claude` |
| Qwen Code | `qwen-code` | `~/.qwen/projects/<slug>/chats/*.jsonl` | `~/.qwen` |
| GigaCode | `gigacode` | `~/.gigacode/projects/<slug>/chats/*.jsonl` | `~/.gigacode` |

Qwen Code and GigaCode transcripts use a Gemini-style `message.parts[]` record
shape and live under a `chats/` subdir; GigaCode is a Qwen clone (same parser,
different `agent` stamp). `scan`/`reflect` honor `--harness` + `--harness-dir`
or the `harness:` config key; `reflect` also auto-detects the harness from the
transcript shape when `--harness` is omitted. `init qwen` and `init gigacode`
install the same fail-open Stop hook + `/reflect` command as `init claude`,
under `.qwen/` or `.gigacode/` (Qwen Code's Stop registration shape and payload
are byte-identical to Claude's).

## Session-end reflect (Slice 3)

`harnessgap reflect` runs the detector on a **single** session (the one just
finished) and emits a `ReflectFinding` whose `trip = flagged && !zero_edit`
decides whether to prompt reflection. `harnessgap init claude` wires that into a
trip-gated Claude Code `Stop` hook so reflection happens automatically at session
end. The detection core is unchanged from Slice 1/2 — `reflect` reuses the same
detector + bootstrap mode.

### `init claude` / `init qwen` / `init gigacode`

```
harnessgap init claude    # default; installs under <cwd>/.claude/
harnessgap init qwen      # installs under <cwd>/.qwen/
harnessgap init gigacode  # installs under <cwd>/.gigacode/
```

Installs three artifacts under the chosen harness dir (idempotent — re-run to refresh):

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
| `--harness <id>` | Harness backend: `claude-code` (default) \| `qwen-code` \| `gigacode`. When omitted, `reflect` auto-detects from the transcript shape. |
| `--harness-dir <path>` | Harness config directory (contains `projects/`). Default per `--harness`. |
| `--claude-dir <path>` | **Deprecated alias** for `--harness claude-code --harness-dir <path>`. |

### Calibration notes (dogfood, not promises)

`trip = flagged && !zero_edit` reuses the bootstrap flag — calibrated for the
*batch* leaderboard, not a per-session *interruption*. At n=1 it may fire on
ordinary sessions (e.g. a single debug loop hitting `reread` + `wall_clock`).
Trip-gate sensitivity is the top open question for this slice: measure how often
the hook fires on clean sessions, and if too often, tighten it (drop the
`≥ 2 signals` disjunction, require `≥ k`, or add a `detector.reflect` block). The
`ReflectFrame` recommendation is advisory and human-reviewed; `path_verified` is
self-attested.

## Diagnoser (`scan --diagnose`, Slice 4)

`harnessgap scan --diagnose` adds **grounded cause attribution** on top of the
leaderboard. For each flagged area it picks one cause from a closed taxonomy,
grounded in (a) the area's signal profile, (b) whether a doc for the area
already exists under `docs_dirs`, and (c) an opt-in evidence projection (failed
exec counts by cmd-class + edited-file counts by file-class). It is a pure rule
engine — no LLM, no network, no git.

| Cause | Plain meaning | Grounding |
| --- | --- | --- |
| `doc` | Missing or undiscoverable doc — the agent explores and re-reads the same files. | `explore_ratio` + `reread` elevated **and** no doc found under `docs_dirs`. |
| `config-doc` | Setup/config friction — failures concentrate on config-class commands. | `failure_streak` elevated **and** config-failures share ≥ `config_share_floor`. |
| `test-gap` | Missing or weak tests — the agent rewrites tests as behavior keeps failing, with no user corrections. | `oscillation` + `failure_streak` elevated, test-file edit share ≥ `test_share_floor`, `corrections` **not** elevated. |
| `refactor-flag` | Code-structure problem — the agent is corrected while editing code; an existing doc makes this stronger. | `oscillation` + `corrections` elevated, code-file edit share ≥ `code_share_floor`; doc-existence boosts confidence. |
| `inherent-complexity` | Genuinely hard — expensive per line, no specific signature fit. | `wall_clock_per_line` elevated **and** mean score ≥ `score_floor`. |
| `unclassified` | Nothing decisive. | Best cause below `confidence_floor`, and the inherent-complexity residual did not fire. |

Opt-in and byte-identical when off: the `CAUSE` column and the `--json`
`diagnoses` field appear only under `--diagnose`. Evidence collection runs only
under `--diagnose`; with it off, `StruggleRecord.evidence` is absent and default
output matches Slice 3 exactly.

### Honest caveats (read before trusting a cause)

- **Fuzzy doc-match.** A doc matches an area if the area's leaf segment (e.g.
  `billing`) appears as a path segment or filename stem under any `docs_dirs`
  entry. Token match will miss differently-named docs and over-match common
  tokens (`utils`, `common`).
- **Session→area evidence attribution.** A session's evidence buckets map to
  every area the session touches; v1 does not attribute files to specific areas.
  This blurs `config-doc` / `test-gap` / `refactor-flag` on sessions touching
  many areas.
- **No git churn.** Code-stability is grounded by signals + doc-existence, not
  churn (deferred).
- **Calibration is dogfood, not a promise.** The five floors
  (`confidence_floor`, the three share floors, `score_floor`) are v1 priors.
  They must be pinned on a real repo before trusting individual causes — see
  [issue #15](https://github.com/HumanBean17/harnessgap/issues/15).

See [docs/CONSUMER_GUIDE.md](docs/CONSUMER_GUIDE.md) "Diagnoser" for how to read
the CAUSE column, and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) "Diagnoser"
for the pipeline seam + fail-open + privacy contract.

## Configuration (`.harnessgap.yml`)

Optional. `scan` runs with built-in defaults if no file is present. The file is
a YAML object with five top-level keys — `harness`, `detector`, `areas`,
`docs_dirs`, and `diagnose`. Anything else is rejected. Deep-merged over the
defaults (arrays replace, they do not concatenate).

```yaml
harness: claude-code                 # claude-code (default) | qwen-code | gigacode; --harness flag overrides
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

docs_dirs: [docs]                    # repo-relative dirs searched for doc-existence grounding under --diagnose
diagnose:                            # cause-rule floors (Slice 4); v1 priors, calibrate via dogfood (issue #15)
  confidence_floor: 0.5              # min score for a specific cause to win
  config_share_floor: 0.5            # config-failures / total-failures bar for config-doc
  test_share_floor: 0.5              # test-file-edits / total-edits bar for test-gap
  code_share_floor: 0.5              # code-file-edits / total-edits bar for refactor-flag
  score_floor: 70                    # mean-score bar for the inherent-complexity residual
```

Keys not shown here (`synthesizer`, `router`, `tasks`, `repo`) are **not**
shipped and will be rejected.

## Success criterion

The detection leaderboard is validated by a **manual dogfood gate**, not an
automated test. On a real repo with rich Claude Code session history, the user
prepares, in advance:

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
   Sibling worktrees (a checkout beside, not nested under, the main repo) are
   recovered by scanning candidate siblings' `.git/worktrees/<name>/gitdir`
   registrations — still only `stat` / `readdir` / tiny text-file reads, with no
   naming-convention heuristic. The recovered checkout root relativizes those
   sessions' file paths, so sibling-worktree sessions aggregate under the same
   areas as the main checkout. Symlinks in transcript directories are rejected.

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
Diagnoser (Slice 4): [`docs/superpowers/specs/active/2026-07-18-harnessgap-diagnoser-design.md`](docs/superpowers/specs/active/2026-07-18-harnessgap-diagnoser-design.md).
