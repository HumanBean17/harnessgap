# Session-End Reflect (Slice 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an event-driven `harnessgap reflect` command (+ `init claude` installer + `/reflect` command) that produces an ephemeral, in-session harness recommendation at session end, from session 1, without writing anything or touching Slice 1/2 outputs.

**Architecture:** Reframe the existing single-session detector as event-driven. `runReflect` (a thin n=1 analog of `runScan` in `src/pipeline.ts`) streams one transcript through the reused `streamSession → resolveMainRepo → relativizeEnvelopeFiles → runDetector(forceBootstrap=true)` path, wraps the unchanged `StruggleRecord` in a `ReflectFinding` (`trip = flagged && !zero_edit`), and renders it either as JSON or as a Claude Code `Stop`-hook result. A pure `src/output/hook.ts` holds the finding-builder + hook renderer (the only Claude-Code-specific code). `harnessgap init claude` emits a fail-open Node wrapper + appends a `Stop` hook to `.claude/settings.json` + writes a `/reflect` command.

**Tech Stack:** Node ≥ 22.12, TypeScript, commander (existing), vitest (existing). No new runtime dependencies.

## Global Constraints

- **No new runtime dependencies.** Runtime deps stay exactly `commander` + `yaml` (locked by `test/packaging.test.ts`). New code uses only Node builtins (`node:fs`, `node:path`, `node:os`, `node:child_process` only inside the *emitted wrapper*, never in `src/`).
- **No network.** No `fetch`/`http`/`https`/`net`/`undici` imports or `fetch()` calls in `src/` (locked by `test/egress.test.ts`).
- **Detection path writes nothing.** `reflect` reads one transcript and prints to stdout only. Only `init` writes files (explicit installer), and only under `<cwd>/.claude/`.
- **Slice 1/2 outputs byte-identical.** `StruggleRecord`, `scoreSessions`, `aggregateAreas`, `runScan`, and the `scan` CLI path are not modified. `scan` corpus + snapshot tests must stay green unchanged.
- **Fail-open everywhere.** `reflect --format hook-stop` and the wrapper must never block the session: any error → `{}` + exit 0.
- **Config unchanged.** No new `.harnessgap.yml` keys; `Config` and `DEFAULT_CONFIG` are not extended.
- **Test commands:** `npx vitest run <file>` (unit), `npm run build` then `node dist/cli.js …` (CLI integration), `npm run typecheck` (types), `npm test` (full suite).

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/types.ts` | Modify | Add `ReflectFinding`, `StopHookOutput`, `ReflectFrame`. `StruggleRecord` untouched. |
| `src/output/hook.ts` | Create | Pure `buildReflectFinding` + `formatStopHookOutput`. The only Claude-Code-specific renderer. |
| `src/pipeline.ts` | Modify | Add `runReflect` + `ReflectOptions`/`ReflectResult`. Reuses every existing stage; does not touch `runScan`. |
| `src/cli.ts` | Modify | Add `reflect` and `init` subcommands. Does not touch the `scan` action. |
| `src/init/claude.ts` | Create | `initClaude(opts)` — resolves binary path, emits wrapper, merges settings, writes command. Pure fs/JSON only. |
| `test/hook.test.ts` | Create | Unit tests for the two pure functions. |
| `test/reflect.test.ts` | Create | Unit tests for `runReflect` (both modes). |
| `test/init.test.ts` | Create | Unit tests for `initClaude` (idempotency, merge, wrapper emit). |
| `README.md`, `docs/ARCHITECTURE.md`, `docs/CONSUMER_GUIDE.md` | Modify | Document `reflect` + `init`; add module rows. |

---

### Task 1: Pure finding-builder + Stop-hook renderer

**Files:**
- Create: `src/output/hook.ts`
- Modify: `src/types.ts` (append three interfaces; do not alter existing ones)
- Test: `test/hook.test.ts`

**Interfaces:**
- Consumes: `StruggleRecord`, `ScoringMode`, `SignalName` from `src/types.ts` (existing, unchanged). `StruggleRecord.signals` is `SignalValues` (existing). `StruggleRecord.areas` is `{ key: string; weight: number }[]` (existing).
- Produces (add to `src/types.ts`):
  - `ReflectFinding` — `{ schema_version: 1; session_id: string; repo: string; mode: ScoringMode; record: StruggleRecord; trip: boolean; zero_edit: boolean }`.
  - `StopHookOutput` — the union a Claude Code `Stop` hook accepts: `{ decision: 'block'; reason: string }` OR `{}` (empty object = allow stop). Express as `{ decision?: 'block'; reason?: string }` with the rule that the allow form is a literal empty object.
  - `ReflectFrame` — `{ cost: string; missing: string; change: { target_path: string; kind: 'add' | 'improve' | 'none'; rationale: string }; path_verified: boolean }`. (Documented contract only — never emitted by the binary; produced by the agent. Defined here so the `/reflect` command and tests share one shape.)
- Produces (in `src/output/hook.ts`):
  - `buildReflectFinding(input: { record: StruggleRecord; zero_edit: boolean }): ReflectFinding` — pure. Derives `trip = input.record.flagged && !input.zero_edit`; copies `session_id`, `repo`, `mode` from the record; pins `schema_version: 1`.
  - `formatStopHookOutput(finding: ReflectFinding, stopHookActive: boolean): StopHookOutput` — pure. Returns `{}` when `stopHookActive` is true (never re-block). Otherwise returns `{ decision: 'block', reason }` when `finding.trip` is true, else `{}`. The `reason` is a **static literal prompt** concatenated with a **derived-only summary** of the finding: the top area keys (from `finding.record.areas`, up to 3) and the non-zero/non-null signal names with their values (from `finding.record.signals`). The reason must contain **no transcript prose** — only the static prompt string, repo-relative area keys, signal names, and numeric/boolean values.

- [ ] **Step 1: Write the failing tests** (`test/hook.test.ts`)

  Define each scenario + exact expected result (implementer writes the vitest code from these):
  - `buildReflectFinding` with a record where `flagged: true`, `zero_edit: false` → `finding.trip === true`, `finding.mode === record.mode`, `finding.schema_version === 1`, `finding.record === record` (same reference).
  - `buildReflectFinding` with `flagged: true`, `zero_edit: true` → `finding.trip === false` (zero-edit forces trip off even when flagged).
  - `buildReflectFinding` with `flagged: false`, `zero_edit: false` → `finding.trip === false`.
  - `formatStopHookOutput(finding, true)` (any finding) → deep-equals `{}` (stop_hook_active never re-blocks).
  - `formatStopHookOutput(finding, false)` with `finding.trip === true` → object with `decision === 'block'` and a `reason` string that contains the top area key (e.g. `src/billing`) and at least one signal name; **and** `JSON.stringify(output)` has exactly the keys `decision` and `reason` (strict — no extra fields).
  - `formatStopHookOutput(finding, false)` with `finding.trip === false` → deep-equals `{}`.
  - **Privacy:** build a finding whose `record` is seeded with a prose marker string in `areas[0].key` is impossible (keys are paths) — instead seed the marker into a hypothetical field and assert the `reason` output does not contain a supplied `PROSE` constant; assert every value reachable in the output is a string/number/boolean (no object holding raw message text). Mirror the `PROSE`-absence pattern in `test/output.test.ts`.

- [ ] **Step 2: Run tests to verify they fail**

  Run: `npx vitest run test/hook.test.ts`
  Expected: FAIL — `buildReflectFinding` / `formatStopHookOutput` not exported (module not found).

- [ ] **Step 3: Write the minimal implementation**

  Add the three interfaces to `src/types.ts` (append only). Create `src/output/hook.ts` exporting the two pure functions with the behavior above. The `reason` string: a fixed leading sentence instructing reflection (e.g. `"Struggle detected this session — reflect on the friction and propose one harness change (fill the ReflectFrame; verify the target path exists). Friction: "` + a comma-joined list of `"<areaKey>"` then `"; signals: "` + `name(value)` pairs for non-zero/non-null signals + `"."`. Use only fields present on `StruggleRecord`. Do not import any node builtin (pure module).

- [ ] **Step 4: Run tests to verify they pass**

  Run: `npx vitest run test/hook.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**

  Run: `git add src/types.ts src/output/hook.ts test/hook.test.ts`
  Run: `git commit -m "feat(reflect): pure ReflectFinding builder + Stop-hook renderer"`

---

### Task 2: `runReflect` — `--transcript` mode

**Files:**
- Modify: `src/pipeline.ts` (add `runReflect` + option/result types; do not alter `runScan`)
- Test: `test/reflect.test.ts`

**Interfaces:**
- Consumes (existing, unchanged): `streamSession(filePath): Promise<{ envelope: NormalizedEnvelope; cwd: string; cwds: string[]; warnings: ... }>` (`src/adapter/stream.ts`); `resolveMainRepo(cwd, cache?): string | null` (`src/git.ts`); `relativizeEnvelopeFiles(envelope, repoRoot): void` (`src/relativize.ts`); `runDetector(envelopes, cfg, forceBootstrap): StruggleRecord[]` (`src/detector/index.ts`); `loadConfig(configPath?)` + `DEFAULT_CONFIG` (`src/config.ts`); `defaultClaudeDir()` (`src/walk.ts`); `buildReflectFinding` + `formatStopHookOutput` (Task 1).
- Produces (in `src/pipeline.ts`):
  - `ReflectOptions` — `{ transcript?: string; latest?: boolean; repo?: string; excludeSession?: string; stopHookActive?: boolean; format?: 'json' | 'hook-stop'; configPath?: string; claudeDir?: string }`.
  - `ReflectResult` — `{ output: string; exitCode: 0 }` (exitCode always 0; the CLI/wrapper handle user-facing failure).
  - `runReflect(opts: ReflectOptions): Promise<ReflectResult>` — resolves one transcript, runs the n=1 detector, returns the formatted output string. Behavior:
    1. `const cfg = loadConfig(opts.configPath)` (ConfigError propagates to CLI).
    2. Resolve the target transcript path. In this task: only `opts.transcript` is honored (`--latest` is Task 3; if neither given, throw an `Error` with a clear message).
    3. `const { envelope, cwds } = await streamSession(path)`. If `cwds.length === 0` or no cwd resolves via `resolveMainRepo`, produce a degenerate finding with `trip:false` (the formatter then yields `{}` for hook-stop). Otherwise set `envelope.repo`, `relativizeEnvelopeFiles(envelope, repo)`.
    4. `const records = runDetector([envelope], cfg, true)` (forceBootstrap=true). Take `records[0]` if present; else degenerate finding.
    5. `zero_edit` = true iff the envelope has **no** event with `kind === 'tool_call' && tool === 'edit'`.
    6. `const finding = buildReflectFinding({ record, zero_edit })`.
    7. Format: if `opts.format === 'hook-stop'` → `JSON.stringify(formatStopHookOutput(finding, opts.stopHookActive ?? false))`; else (default `json`) → `JSON.stringify(finding)`.
    8. Return `{ output, exitCode: 0 }`. Never throws for streaming/resolution failures — degrade to a `trip:false` finding; only `loadConfig`/arg errors throw.

- [ ] **Step 1: Write the failing tests** (`test/reflect.test.ts`)

  Build transcript fixtures by writing minimal `.jsonl` files to a temp dir (follow the line-record shape used in `test/parse.test.ts` and `test/corpus.test.ts` — real Claude Code jsonl records with `type`, `timestamp`, `cwd`, tool_use/tool_result pairs). Scenarios + expected results:
  - A transcript whose normalized events include a failed `exec` streak ≥ 3 (bootstrap `failure_streak` trips) + at least one `edit` → `runReflect({transcript, format:'json'})` returns JSON whose parsed `trip === true`, `zero_edit === false`, `mode === 'bootstrap'`, and `record.flagged === true`.
  - A zero-edit transcript (only reads, 6 reads of one file so `reread` would trip, no edits) → parsed `zero_edit === true` and `trip === false` (even though `record.flagged` may be true).
  - Same tripping transcript, `format:'hook-stop'`, `stopHookActive:false` → output parses to `{ decision:'block', reason: <string> }` with exactly keys `decision`,`reason`.
  - Same, `stopHookActive:true` → output parses to `{}` (empty object).
  - A clean transcript (a couple reads, one edit, no failures) → `trip === false`; `format:'hook-stop'` → `{}`.
  - Missing/unresolvable cwd (transcript with `cwd` set to a path with no ancestor `.git`) → `format:'hook-stop'` returns `{}` (fail-open, no throw).

- [ ] **Step 2: Run tests to verify they fail**

  Run: `npx vitest run test/reflect.test.ts`
  Expected: FAIL — `runReflect` not exported.

- [ ] **Step 3: Write the minimal implementation**

  Add `runReflect` and its option/result types to `src/pipeline.ts`, composing the consumed functions exactly as in the behavior spec. Reuse a single `resolveMainRepo` cache `Map`. Mirror `runScan`'s cwd-resolution loop (try each cwd in `cwds` until one resolves).

- [ ] **Step 4: Run tests to verify they pass**

  Run: `npx vitest run test/reflect.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**

  Run: `git add src/pipeline.ts test/reflect.test.ts`
  Run: `git commit -m "feat(reflect): runReflect --transcript single-session detection"`

---

### Task 3: `runReflect` — `--latest --repo` mode

**Files:**
- Modify: `src/pipeline.ts` (extend `runReflect`'s transcript-resolution step)
- Test: `test/reflect.test.ts` (extend)

**Interfaces:**
- Consumes: `discoverTranscripts(claudeDir): { files: string[]; symlinks_rejected: number }` (`src/walk.ts`); everything from Task 2.
- Produces: extends `runReflect` — when `opts.latest === true` and `opts.transcript` is unset:
  1. `const targetRepo = resolveMainRepo(opts.repo ?? process.cwd(), cache)` (normalize the repo filter through the resolver, like `runScan`).
  2. Discover transcripts under `opts.claudeDir ?? defaultClaudeDir()`.
  3. For each file: `streamSession` → resolve its repo via its `cwds`; keep envelopes whose resolved repo === `targetRepo`. (Thread one cache across all.)
  4. Exclude the running session: drop any envelope whose `session_id === opts.excludeSession` when that option is set.
  5. Pick the kept envelope with the **maximum** `Date.parse(started_at)`; ignore envelopes with empty/unparseable `started_at`.
  6. If none remain → degenerate `trip:false` finding. Else run steps 3–8 from Task 2 on that envelope (no re-stream — the envelope is already in hand).
  - Note for the implementer: this streams every transcript for the repo (same order of cost as `scan`). Acceptable for the on-demand manual path; the per-stop hook path uses `--transcript` and never pays this.

- [ ] **Step 1: Write the failing tests** (extend `test/reflect.test.ts`)

  Scenarios + expected:
  - A temp claude-dir with 3 transcripts for the same repo, distinct `started_at` values (one newest), one transcript for a *different* repo → `runReflect({latest:true, repo:<targetRepo>, format:'json'})` returns the finding whose `session_id` is the newest transcript of the target repo (not the other repo's, not an older one).
  - Same set + `excludeSession: <newest session_id>` → returns the *second*-newest session's finding.
  - A claude-dir with no transcripts for the target repo → `format:'hook-stop'` returns `{}` (no throw).

- [ ] **Step 2: Run tests to verify they fail**

  Run: `npx vitest run test/reflect.test.ts`
  Expected: FAIL on the new `--latest` cases (not yet implemented).

- [ ] **Step 3: Write the minimal implementation**

  Extend `runReflect`'s resolution branch to implement the `--latest` algorithm above, then feed the chosen envelope into the existing detect/format steps.

- [ ] **Step 4: Run tests to verify they pass**

  Run: `npx vitest run test/reflect.test.ts`
  Expected: PASS (all cases).

- [ ] **Step 5: Commit**

  Run: `git add src/pipeline.ts test/reflect.test.ts`
  Run: `git commit -m "feat(reflect): --latest --repo most-recent-finished-session resolution"`

---

### Task 4: `reflect` CLI subcommand

**Files:**
- Modify: `src/cli.ts` (add a `reflect` `program.command(...)` block; do not alter the `scan` action)
- Test: `test/cli.reflect.test.ts`

**Interfaces:**
- Consumes: `runReflect` + `ReflectOptions` (Task 2/3).
- Produces:
  - `reflect` subcommand: options `--transcript <path>`, `--latest`, `--repo <path>`, `--exclude-session <id>`, `--stop-hook-active` (boolean), `--format <json|hook-stop>` (default `json`), `--config <path>`, `--claude-dir <path>`. Action: build `ReflectOptions`, `await runReflect(opts)`, write `result.output + '\n'` to stdout, exit 0. On thrown error → stderr `error: <msg>`, exit 1 (the wrapper converts this to `{}` for hook-stop).
  - (The `init` subcommand is wired in Task 5, which owns `initClaude`.)

- [ ] **Step 1: Write the failing tests** (`test/cli.reflect.test.ts`)

  Build first (`npm run build`). Scenarios + expected (invoke the built binary via `node` + `execFile`, no shell):
  - `node dist/cli.js reflect --transcript <fixture> --json` → stdout is valid JSON; parsed `schema_version === 1` and has `record`, `trip`, `zero_edit`.
  - `node dist/cli.js reflect --transcript <fixture> --format hook-stop` (tripping fixture) → parsed `{ decision:'block', reason }` with exactly keys `decision`,`reason`.
  - `node dist/cli.js reflect --transcript <fixture> --format hook-stop` (clean fixture) → parsed `{}`.
  - `node dist/cli.js reflect` (no target) → non-zero exit, stderr mentions the missing-target error.
  - `node dist/cli.js --help` mentions `reflect`.

- [ ] **Step 2: Run tests to verify they fail**

  Run: `npx vitest run test/cli.reflect.test.ts`
  Expected: FAIL — unknown command / not wired.

- [ ] **Step 3: Write the minimal implementation**

  Add the `reflect` subcommand to `src/cli.ts` mirroring the existing `scan` block (option chain + async action + the same stdout-then-exit-in-flush-callback pattern). Keep imports within the existing allowlist (commander, pipeline, config, node:process, node:fs).

- [ ] **Step 4: Run tests to verify they pass**

  Run: `npx vitest run test/cli.reflect.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**

  Run: `git add src/cli.ts test/cli.reflect.test.ts`
  Run: `git commit -m "feat(cli): reflect subcommand"`

---

### Task 5: `init claude` — wrapper, settings merge, `/reflect` command

**Files:**
- Create: `src/init/claude.ts`
- Modify: `src/cli.ts` (add the `init` subcommand)
- Test: `test/init.test.ts`

**Interfaces:**
- Consumes: Node builtins (`node:fs`, `node:path`). Resolves the absolute binary path the same way `src/cli.ts` resolves `../package.json` (`new URL` against `import.meta.url`): the published bin is `dist/cli.js` relative to the package root, so compute the absolute path to the installed/working `dist/cli.js`.
- Produces:
  - `initClaude(opts: { cwd: string }): { wrapperPath: string; settingsPath: string; commandPath: string }` — writes three things under `opts.cwd/.claude/`, idempotently:
    1. **Wrapper** at `.claude/harnessgap-stop-hook.js` — a Node script (emitted verbatim by the implementer from the behavior spec below; it is a runtime artifact, not part of `src/`'s egress surface). Behavior: read all of stdin → `JSON.parse`; if `stop_hook_active === true` → write `{}` to stdout, exit 0 (short-circuit; do not spawn). Otherwise read `transcript_path`; spawn `${process.execPath} <absCliPath> reflect --transcript <transcript_path> --format hook-stop` capturing stdout; on spawn failure, non-zero exit, or empty stdout → write `{}` to stdout, exit 0; otherwise forward the binary's stdout verbatim, exit 0. The wrapper must `try/catch` top-level so any throw → `{}` + exit 0.
    2. **Settings merge** at `.claude/settings.json` — read existing if present (parse; on missing/invalid, start from `{}`), ensure a `hooks` object with a `Stop` array exists, and ensure exactly one entry whose command is `node <absWrapperPath>`. The Claude Code shape:
       ```
       { "hooks": { "Stop": [ { "matcher": "", "hooks": [ { "type": "command", "command": "node <absWrapperPath>" } ] } ] } }
       ```
       Preserve every other key and every other Stop entry the user already had (append, never clobber). Write back pretty-printed JSON.
    3. **Command** at `.claude/commands/reflect.md` — the `/reflect` prompt (agent guidance only, no detection logic). Content behavior: instruct the agent to (a) run `harnessgap reflect --latest --repo . --json` (or, when triggered by a Stop-hook block reason, use the finding summary already in context instead of re-invoking); (b) read the `ReflectFinding`; (c) fill a `ReflectFrame` — `cost` (tied to a top signal), `missing` (context that would have helped), one `change` (`target_path` repo-relative, `kind` ∈ add|improve|none, `rationale`), and `path_verified` (confirm the target path — or its parent for `add` — exists via a read/glob before presenting); (d) present the recommendation concisely and offer to draft the change in-session if the user wants; (e) if `trip === false` or the session was clean, say so and emit `kind:"none"`.
    - Idempotency: re-running `initClaude` rewrites the wrapper + command (refresh) and ensures the Stop entry exists exactly once (no duplication), preserving all other settings.
  - `init` CLI subcommand (wired in `src/cli.ts` by this task): one positional `<agent>` (only `claude` accepted this slice). Action calls `initClaude({ cwd: process.cwd() })`, prints a one-line summary of the paths written, exit 0. Unknown agent → stderr, exit 1.

- [ ] **Step 1: Write the failing tests** (`test/init.test.ts`)

  Use a temp dir as `cwd`. Scenarios + expected:
  - After `initClaude({cwd})`: `.claude/harnessgap-stop-hook.js` exists; `.claude/commands/reflect.md` exists; `.claude/settings.json` parses as JSON and contains a `hooks.Stop` array with one entry whose `command` starts with `node ` and ends with `harnessgap-stop-hook.js`.
  - The emitted wrapper, executed with stdin `{"stop_hook_active": true, ...}` → stdout `{}`, exit 0 (assert via `execFile node <wrapper>`).
  - The wrapper, executed with stdin `{"stop_hook_active": false, "transcript_path": "<clean fixture>"}` → stdout `{}`, exit 0 (the binary computes `trip:false`).
  - The wrapper, executed with stdin pointing at a **nonexistent** transcript_path → stdout `{}`, exit 0 (fail-open — binary errors, wrapper swallows).
  - Pre-seed `.claude/settings.json` with an existing user `Stop` hook entry + an unrelated top-level key; run `initClaude`; assert the user's Stop entry and the unrelated key are both still present, and the harnessgap entry is appended (two Stop entries total).
  - Run `initClaude` twice → still exactly one harnessgap Stop entry (idempotent), wrapper + command refreshed.
  - CLI wiring: `node dist/cli.js --help` mentions `init`; `node dist/cli.js init claude` run with `cwd` changed to a temp dir (the test may `process.chdir`) exits 0 and creates `<temp>/.claude/settings.json` + wrapper + command.

- [ ] **Step 2: Run tests to verify they fail**

  Run: `npx vitest run test/init.test.ts`
  Expected: FAIL — `initClaude` not exported.

- [ ] **Step 3: Write the minimal implementation**

  Create `src/init/claude.ts` exporting `initClaude` per the behavior above. Resolve the absolute `dist/cli.js` path via `import.meta.url`. Emit the wrapper as a template string (the implementer authors the Node script text to the behavior spec). Merge settings defensively (read → parse-or-default → ensure structure → dedupe by command string → write). No network, no deps beyond builtins. Then wire the `init` subcommand in `src/cli.ts` (import `./init/claude.js`) per the Produces bullet above.

- [ ] **Step 4: Run tests to verify they pass**

  Run: `npx vitest run test/init.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**

  Run: `git add src/init/claude.ts test/init.test.ts`
  Run: `git commit -m "feat(init): init claude — fail-open wrapper, settings merge, /reflect command"`

---

### Task 6: Privacy/egress/packaging regression + docs + dogfood notes

**Files:**
- Modify: none in `src/` (verification task) unless a gate fails
- Modify: `README.md`, `docs/ARCHITECTURE.md`, `docs/CONSUMER_GUIDE.md`
- Test: extend `test/hook.test.ts` / `test/reflect.test.ts` privacy assertions if not already present

**Interfaces:**
- Consumes: all prior tasks.
- Produces: green full suite; updated docs.

- [ ] **Step 1: Write/extend the privacy assertions**

  Add (if not already in Tasks 1–2) a test that seeds a transcript fixture with a prose marker in a user-message field, runs `runReflect` in both `--json` and `--format hook-stop`, and asserts the marker string is absent from `result.output`, and that every value in the parsed output is a string/number/boolean/closed-enum (mirror `test/privacy.test.ts`).

- [ ] **Step 2: Run the full gate**

  Run: `npm test`
  Expected: PASS — including `test/egress.test.ts` (no forbidden imports in new `src/output/hook.ts`, `src/init/claude.ts`, or the `src/pipeline.ts`/`src/cli.ts` additions), `test/packaging.test.ts` (runtime deps still exactly `commander`+`yaml`), and the Slice 1/2 **corpus + snapshot tests unchanged** (the non-corruption assertion).
  Run: `npm run typecheck`
  Expected: PASS.

- [ ] **Step 3: Update docs**

  - `docs/ARCHITECTURE.md`: add module-map rows for `src/output/hook.ts`, `src/init/claude.ts`, and the `runReflect` orchestration; note the `reflect`/`init` CLI commands; state that `StruggleRecord`/scorer/aggregator/`runScan` are untouched.
  - `README.md` + `docs/CONSUMER_GUIDE.md`: add `harnessgap reflect` and `harnessgap init claude` to the command/flags tables; add a short "Session-end reflect" section describing the trip-gated Stop hook + `/reflect` and the ephemeral recommendation; note the §11 open questions (esp. trip-gate sensitivity) as dogfood calibration.

- [ ] **Step 4: Verify docs build cleanly + final full run**

  Run: `npm test && npm run typecheck`
  Expected: PASS.

- [ ] **Step 5: Commit**

  Run: `git add README.md docs/ARCHITECTURE.md docs/CONSUMER_GUIDE.md test/`
  Run: `git commit -m "docs(reflect): reflect/init commands + regression gates green"`

---

## Notes for the implementer

- **Trip-gate sensitivity is a dogfood item, not a blocker** (spec §11.1). Implement `trip = flagged && !zero_edit` as specified; if dogfood shows the hook fires on too many clean sessions, tighten via one of the spec's levers (drop the `≥2 signals` disjunction / raise to `≥k` / a `detector.reflect` block) — but that is a follow-up, not part of these tasks.
- **Never modify** `runScan`, `scoreSessions`, `aggregateAreas`, `assembleStruggleRecord`, `StruggleRecord`, `Config`, or `DEFAULT_CONFIG`. If a task seems to require it, stop — the design reuses them as-is.
- **The wrapper is the only place `node:child_process` appears**, and it is an emitted runtime artifact under `.claude/`, not a file in `src/`. `src/` must stay free of it so `test/egress.test.ts` and `test/packaging.test.ts` pass unmodified.
