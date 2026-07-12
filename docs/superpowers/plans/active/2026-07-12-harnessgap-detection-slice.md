# harnessgap Detection Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `harnessgap scan` — a stateless, detection-only CLI that walks Claude Code transcripts, normalizes them through a secret-scrubbed event schema, runs seven deterministic struggle signals, scores them as a percentile of composites (with an absolute-threshold bootstrap for thin history), localizes struggle to path-prefix areas, and prints a leaderboard.

**Architecture:** A pure, stateless batch pipeline: transcript walk → Claude Code adapter (scrub + normalize) → detector (signals + scoring) → area localization → aggregator → output. The normalized-event schema (v1) is the deliberate reuse seam for later ingest/diagnosis slices. Every stage is a pure function of its inputs except the thin I/O shell (walk, stream, git, cli).

**Tech Stack:** Node.js ≥22, TypeScript ≥5.5 (strict, ESM, `NodeNext`), vitest ≥2, `commander` (CLI parsing), `yaml` (config). Build via `tsc` → `dist/`; dev run via `tsx`. No other runtime deps — no network libraries.

## Global Constraints

(Copied from spec `docs/superpowers/specs/active/2026-07-12-harnessgap-detection-slice-design.md`. Every task implicitly inherits these.)

- **Runtime:** Node ≥22 + TypeScript, npm-distributed (`npx harnessgap`), ESM (`"type": "module"`). Bun single-binary deferred.
- **No network:** no `http`/`https`/`net`/`fetch`/`undici` imports in `src/`; a dependency audit confirms no egress (§11).
- **Stateless:** `scan` writes nothing to disk (§1, §11).
- **Scrubbing is pattern-catalog only** — no high-entropy catch-all (§4). Catalog reused verbatim for slice-2 persistence, so coverage must be correct now.
- **fail-open:** malformed line / oversized line / symlink / unresolvable-cwd → skip + increment warning, never abort (§9).
- **Exit codes:** `0` for success incl. "no sessions"; non-zero only for genuine misconfiguration (unreadable/invalid config, missing runtime prerequisites) (§9).
- **Warnings are integer counts only** — never line content, offsets, or prose (§4, §9).
- **No raw message text in any output path** — stdout, `--json`, `--calibrate`, warnings (§4, §10). The adapter may read raw prose internally to derive a `correction` flag, but never emits it.
- **Defaults (§7):** `flag_pct=90`, `bootstrap_session_floor` (K)=`30`, `bootstrap_flag_pct=70`, `reread_threshold=5`, `correction_window_ms=120000`, signal_weights `abandonment=0.5` / `oscillation=1.2` / others `1.0`.
- **Git sandboxed (§4):** `git -C <cwd> rev-parse --show-toplevel` only, via `execFile` (no shell), with env `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, and args `-c core.fsmonitor= -c core.pager=cat -c core.hooksPath=`. No `status`/`diff`/`log`. Command never lands in shell history.
- **Transcript walk safety (§4):** reject symlinks via `lstat`; every resolved path must stay under `~/.claude/projects/`.
- **Size caps (§4):** input JSONL line cap 1 MB (skip + `oversized_lines`); output `cmd`/`query` ≤512 chars, `files` ≤50, events ≤5000/session (drop tail, tag `truncated:true`), per-session byte cap 50 MB.

---

## File Structure

```
package.json, tsconfig.json, vitest.config.ts, .gitignore, README.md
src/
  types.ts                 # shared types: NormalizedEvent/Envelope, StruggleRecord, Config, Warnings, JsonOutput, SignalName, etc.
  config.ts                # DEFAULT_CONFIG, loadConfig(path), parseDuration("30d"), validateConfig
  git.ts                   # resolveToplevel(cwd, cache) — sandboxed rev-parse, execFile, no shell
  walk.ts                  # discoverTranscripts(claudeDir, repoFilter?) → {path}[] + symlinks_rejected
  adapter/
    scrub.ts               # scrubCmd/scrubQuery/scrubFiles — pattern-catalog, pure
    correction.ts          # detectCorrection(prevToolCall, userText) → {matched, shape}, pure heuristic
    taxonomy.ts            # mapToolKind(ccToolName) → ToolKind, pure
    parse.ts               # normalizeRecord(raw, ctx) → NormalizedEvent | null  (digest, caps, ok/interrupted, correction)
    stream.ts              # streamSession(path, caps) → { events: NormalizedEvent[], envelope-meta, warnings }  (I/O)
  detector/
    signals.ts             # 7 pure computers: computeSignals(events, cfg) → SignalValues
    scoring.ts             # scoreSessions(records' signals, cfg) → per-session {composite, score_pct, mode, flagged}; pure
    areas.ts               # localizeAreas(events, cfg) → {key, weight}[]; pure
    record.ts              # assembleStruggleRecord(envelope, signals, score, areas) → StruggleRecord; pure
    index.ts               # runDetector(envelopes, cfg) → StruggleRecord[] (needs full set for percentile)
  aggregate/
    leaderboard.ts         # aggregateAreas(records, cfg) → AreaRow[]; topSignals; sort; pure
  output/
    json.ts                # buildJsonEnvelope(...) → JsonOutput; pure
    human.ts               # formatHuman(envelope-summary, areas) → string; pure
    calibrate.ts           # buildCalibrateObject / formatCalibrateTable; pure, aggregate-only
  pipeline.ts              # orchestrate(opts) → {json | human | calibrate}; ties walk→stream→detect→aggregate
  cli.ts                   # bin entry: commander, flags, exit codes, egress guard
test/
  fixtures/                # *.jsonl transcripts + labels (built incrementally; full corpus in Task 18)
  *.test.ts                # vitest unit/integration tests per module
```

Each module is one responsibility; pure logic (`scrub`, `correction`, `taxonomy`, `parse`, `signals`, `scoring`, `areas`, `record`, `leaderboard`, `output/*`) is isolated from I/O (`walk`, `stream`, `git`, `pipeline`, `cli`) so TDD applies cleanly.

---

### Task 1: Project scaffolding + toolchain smoke test

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `src/index.ts` (temporary smoke), `test/smoke.test.ts`

**Interfaces:**
- Produces: a buildable, testable ESM TypeScript project. `npm test` runs vitest; `npm run build` emits `dist/`; `npm run typecheck` runs `tsc --noEmit`. `package.json` declares `"type": "module"`, `"bin": {"harnessgap": "dist/cli.js"}` (bin target created in Task 17; file need not exist yet), scripts `build`/`dev`/`test`/`typecheck`. Runtime deps exactly: `commander`, `yaml`. Dev deps: `typescript`, `vitest`, `@types/node`, `tsx`. `.gitignore` ignores `dist/`, `node_modules/`, `.DS_Store`.
- Produces `src/index.ts` exporting a single function `export function ping(): string` (temporary — replaced in Task 17). `test/smoke.test.ts` asserts `ping() === "harnessgap"`.

- [ ] **Step 1: Write the failing test**

`test/smoke.test.ts` verifies the toolchain end-to-end: import `ping` from `../src/index.js` (ESM `.js` import in TS under NodeNext), assert it returns the exact string `"harnessgap"`. This proves: TS compiles, ESM resolves, vitest runs.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/smoke.test.ts`
Expected: FAIL — module `../src/index.js` not found (no `src/index.ts` yet) or `ping` undefined.

- [ ] **Step 3: Write minimal implementation**

Create `package.json` with the exact deps/scripts/bin above (`"type":"module"`, `engines.node: ">=22"`). Create `tsconfig.json`: `target ES2023`, `module NodeNext`, `moduleResolution NodeNext`, `strict true`, `outDir dist`, `rootDir src`, `declaration true`, `sourceMap true`. Create `vitest.config.ts` default (no special config needed; ESM). Create `.gitignore`. Create `src/index.ts` with `ping()` returning `"harnessgap"`. Run `npm install`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/smoke.test.ts` then `npm run typecheck` then `npm run build` (confirm `dist/index.js` emitted).
Expected: test PASS; typecheck clean; build emits `dist/`.

- [ ] **Step 5: Commit**

Run: `git add -A && git commit -m "chore: scaffold typescript+vitest esm project"`

---

### Task 2: Shared types + config loader

**Files:**
- Create: `src/types.ts`, `src/config.ts`, `test/config.test.ts`

**Interfaces:**
- Produces `src/types.ts` with these exact types (implementer writes them verbatim):
  - `ToolKind = "read" | "search" | "list" | "edit" | "exec" | "other"`
  - `EventKind = "user_msg" | "assistant_msg" | "tool_call"`
  - `SignalName = "explore_ratio" | "reread" | "failure_streak" | "corrections" | "abandonment" | "oscillation" | "wall_clock_per_line"`
  - `ScoringMode = "percentile" | "bootstrap"`
  - `InputDigest { files: string[]; cmd: string|null; query: string|null; lines_changed: number|null }`
  - `Correction { matched: boolean; shape: string|null }`
  - `NormalizedEvent { t: string; kind: EventKind; tool: ToolKind|null; input_digest: InputDigest; ok: boolean; interrupted: boolean; duration_ms: number; correction: Correction|null }`
  - `NormalizedEnvelope { schema_version: 1; session_id: string; agent: "claude-code"; repo: string; started_at: string; duration_ms: number; events: NormalizedEvent[]; truncated: boolean; event_count: number }`
  - `SignalValues { explore_ratio: number|null; reread: number; failure_streak: number; corrections: number; abandonment: boolean; oscillation: number; wall_clock_per_line_ms: number|null }` (null = not computable e.g. no edits)
  - `StruggleRecord { session_id: string; repo: string; started_at: string; duration_ms: number; score_pct: number; mode: ScoringMode; flagged: boolean; truncated: boolean; event_count: number; areas: {key:string; weight:number}[]; signals: SignalValues }`
  - `Warnings { malformed_lines: number; oversized_lines: number; skipped_sessions: number; truncated_sessions: number; symlinks_rejected: number; unresolvable_cwd: number }` (all default 0)
  - `AreaRow { key: string; sessions_total: number; sessions_flagged: number; mean_score: number; top_signals: {name:SignalName; value:number|boolean; display:string}[] }`
  - `JsonOutput { schema_version: 1; repo: string; mode: ScoringMode; session_count: number; warnings: Warnings; sessions: StruggleRecord[]; areas: AreaRow[] }`
  - `Config { detector: { thresholds_as: "percentile"|"absolute"; flag_pct: number; bootstrap_session_floor: number; bootstrap_flag_pct: number; reread_threshold: number; correction_window_ms: number; signal_weights: Record<SignalName, number>; bootstrap_thresholds: { explore_ratio:number; reread:number; failure_streak:number; corrections:number; abandonment:boolean; oscillation:number; wall_clock_per_line_ms:number } }; areas: { ignore: string[]; min_weight: number; min_depth: number; touch_weights: {edit:number; read:number; exec:number}; tail_fraction: number; explore_ratio_min: number; suppress_abandonment_when_no_exec: boolean; test_cmd_patterns: string[] } }`
- Produces `src/config.ts`:
  - `DEFAULT_CONFIG: Config` — the exact §7 values: `flag_pct:90`, `bootstrap_session_floor:30`, `bootstrap_flag_pct:70`, `reread_threshold:5`, `correction_window_ms:120000`, `signal_weights {explore_ratio:1, reread:1, failure_streak:1, corrections:1, abandonment:0.5, oscillation:1.2, wall_clock_per_line:1}`, `bootstrap_thresholds {explore_ratio:10, reread:5, failure_streak:3, corrections:2, abandonment:true, oscillation:2, wall_clock_per_line_ms:300000}`, `areas.ignore [node_modules,build,target,dist,.git,.next,vendor]`, `min_weight:0.40`, `min_depth:2`, `touch_weights {edit:3,read:2,exec:1}`, `tail_fraction:0.25`, `explore_ratio_min:0.8`, `suppress_abandonment_when_no_exec:true`, `test_cmd_patterns [test,spec,pytest,"npm test","npm run test",make,"cargo test","go test",jest,vitest]`, `thresholds_as:"percentile"`.
  - `loadConfig(path?: string): Config` — deep-merges a `.harnessgap.yml` over `DEFAULT_CONFIG` (arrays replace, not concat). If `path` omitted, looks for `.harnessgap.yml` in cwd; if absent, returns `DEFAULT_CONFIG`. Throws a typed `ConfigError` (message only, no stack leaking paths) on: unreadable file, YAML parse error, unknown top-level keys, or out-of-range numeric fields (`flag_pct` not in [0,100], `bootstrap_session_floor` <1, weights negative, `min_weight` not in [0,1]).
  - `parseDuration(s: string): number` — `"30d"`→ms, supports `d`/`h`/`m`/`s`; throws `ConfigError` on unparseable input; empty/undefined → `Infinity` (no window).

- [ ] **Step 1: Write the failing tests**

Tests in `test/config.test.ts`:
1. `DEFAULT_CONFIG` has `flag_pct === 90` and `areas.touch_weights.edit === 3`.
2. `loadConfig()` with no file present returns `DEFAULT_CONFIG` (deep-equal).
3. `loadConfig(path)` where the YAML sets `detector.flag_pct: 75` returns a config with `flag_pct===75` and all other defaults intact (deep-merge).
4. `loadConfig(path)` with an array override `areas.ignore: [foo]` replaces (not concats) → `areas.ignore` is exactly `["foo"]`.
5. `loadConfig(path)` with `flag_pct: 150` throws `ConfigError`.
6. `loadConfig(path)` with an unknown key `bogus: 1` throws `ConfigError`.
7. `parseDuration("30d") === 30*24*60*60*1000`; `parseDuration("12h") === 12*3600*1000`; `parseDuration(undefined) === Infinity`; `parseDuration("abc")` throws.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/types.ts` with the types above. Create `src/config.ts`: define `ConfigError` (subclass of Error), `DEFAULT_CONFIG`, `parseDuration` (regex `^(\d+)([dhms])$`), `loadConfig` (read file via `fs.readFileSync`; parse via `yaml`'s `parse`; deep-merge; validate ranges + known keys; throw `ConfigError` on any violation). Deep-merge: objects merge recursively, arrays/primitives replace.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/config.test.ts` and `npm run typecheck`
Expected: all PASS; typecheck clean.

- [ ] **Step 5: Commit**

Run: `git add src/types.ts src/config.ts test/config.test.ts && git commit -m "feat: add shared types and config loader with defaults"`

---

### Task 3: Secret scrubber (pattern-catalog)

**Files:**
- Create: `src/adapter/scrub.ts`, `test/scrub.test.ts`

**Interfaces:**
- Consumes: none (pure string/file transforms).
- Produces `src/adapter/scrub.ts`:
  - `scrubCmd(cmd: string): string` — applies the catalog to an exec command string, ≤512 chars after scrubbing (truncate with no marker). Replacements use a fixed sentinel `***REDACTED***` (exact literal).
  - `scrubQuery(q: string): string` — same catalog, ≤512 chars.
  - `scrubFiles(files: string[]): string[]` — replaces any file path matching a credential-file glob with the sentinel; leaves others unchanged; result length ≤50 (drop excess, no marker).
  - The pattern catalog (applied in this order): (1) heredoc/inline private keys — replace content between `-----BEGIN … PRIVATE KEY-----` and `-----END …-----` (inclusive) with sentinel; (2) env-var assignments `KEY=…` incl. `export`/`set`/`env` prefixes → `KEY=***REDACTED***` (KEY kept if it is an UPPERCASE_WITH_UNDERSCORES identifier; otherwise leave token alone); (3) `Authorization: …` / `Bearer …` headers → sentinel; (4) URL-embedded creds `://user:pass@host` (incl `postgres://`,`redis://`, git `https://token@host`) → `://***REDACTED***@host` (host kept); (5) flag/positional secrets `-p <val>`, `--password`, `--secret`, `--token`, `--api-key`, `--access-key`, `-u <user:pass>` → replace the value with sentinel, keep the flag; (6) credential-file path globs `**/.env`, `**/*.pem`, `**/*.key`, `**/.aws/credentials`, `**/.npmrc`, `**/id_rsa*`, `**/.pgpass`, `**/.htpasswd`, `**/service-account*.json`, `**/credentials.json` → sentinel; (7) known-format tokens — AWS `AKIA[0-9A-Z]{16}`, GitHub `gh[oprs]_[A-Za-z0-9]{36}`, Slack `xox[baprs]-[A-Za-z0-9-]+`, JWT `eyJ…\.…\.…` → sentinel.
  - **Explicit non-goals (asserted by test):** 40-hex git SHAs, UUIDs, and base64-looking hashes must NOT be altered (no entropy heuristic).

- [ ] **Step 1: Write the failing tests**

`test/scrub.test.ts` — one assertion per pattern, each: input string → expected output contains `***REDACTED***` and does NOT contain the secret substring. Cases:
1. Env var: `"export API_KEY=sk-1234567890"` → secret gone, `API_KEY=` retained.
2. Bearer: `"curl -H 'Authorization: Bearer abc.def.ghi'"` → token gone.
3. URL creds: `"git clone https://token@github.com/o/r"` → `token` gone, host `github.com` retained.
4. Flag secret: `"psql -h host -p 5432 -U admin:secretpw"` and `"npm config set //reg/:_authToken=ghp_x"` style `--token ghp_..."` → value gone, flag retained.
5. Heredoc key: a multi-line string containing `-----BEGIN RSA PRIVATE KEY-----\n....\n-----END RSA PRIVATE KEY-----` → body replaced.
6. Credential file in `scrubFiles`: `["src/index.ts",".env","id_rsa","deploy/service-account.json"]` → `.env`,`id_rsa`,`service-account.json` become sentinel; `src/index.ts` unchanged.
7. Known-format: AWS `AKIAIOSFODNN7EXAMPLE`, GitHub `ghp_`+36 chars, Slack `xoxb-`+chars, a JWT → each gone.
8. **Anti-false-positive:** `"commit d0d3b1f2a4c5e6f7a8b9c0d1e2f3a4b5c6d7e8f9"` (40-hex SHA), `"550e8400-e29b-41d4-a716-446655440000"` (UUID), a 32-hex md5 → each UNCHANGED.
9. Length cap: a 600-char `cmd` with no secrets → truncated to 512 chars.
10. `scrubFiles` with 60 files → result length 50.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/scrub.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Implement each pattern as a separate regex transform composed in a single pass (apply in the documented order so heredoc blocks don't get partially mangled by the env-var rule). For env-var, only redact the value when the key matches `^[A-Z][A-Z0-9_]*=`. Truncate `cmd`/`query` to 512 after scrubbing. Slice `files` to 50. No entropy computation anywhere.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/scrub.test.ts` and `npm run typecheck`
Expected: all PASS; typecheck clean.

- [ ] **Step 5: Commit**

Run: `git add src/adapter/scrub.ts test/scrub.test.ts && git commit -m "feat: pattern-catalog secret scrubber for adapter"`

---

### Task 4: Correction detector

**Files:**
- Create: `src/adapter/correction.ts`, `test/correction.test.ts`

**Interfaces:**
- Consumes: `NormalizedEvent` (the preceding assistant `tool_call`, if any) and raw user message text (read internally, never emitted).
- Produces `src/adapter/correction.ts`:
  - `detectCorrection(prevToolCall: {tool: ToolKind} | null, userText: string): Correction` — returns `{matched: true, shape}` when the user message looks like a course-correction of the immediately preceding tool call; else `{matched: false, shape: null}`.
  - Shape catalog (string tags): `"negation"` (starts with `no`/`no,`/`don't`/`do not`/`stop`/`wait`/`hold on`/`that's wrong`/`not that`), `"undo"` (contains `undo`/`revert`/`roll back`/`put it back`), `"redirect"` (contains `instead`/`actually`/`rather`/`try the other`), `"retry-different"` (contains `try again`/`differently`/`another approach`). First match wins, in this order.
  - Case-insensitive matching; trims leading whitespace; ignores messages shorter than 3 chars (returns not-matched).
  - This is a heuristic priors catalog (spec §12.5 open question); the function is pure and trivially tunable.

- [ ] **Step 1: Write the failing tests**

`test/correction.test.ts`:
1. `detectCorrection({tool:"edit"}, "no, don't change that file")` → `{matched:true, shape:"negation"}`.
2. `detectCorrection({tool:"exec"}, "wait, stop")` → `{matched:true, shape:"negation"}`.
3. `detectCorrection({tool:"edit"}, "undo that last change")` → `{matched:true, shape:"undo"}`.
4. `detectCorrection({tool:"exec"}, "actually use the other approach")` → `{matched:true, shape:"redirect"}`.
5. `detectCorrection({tool:"exec"}, "try again differently")` → `{matched:true, shape:"retry-different"}`.
6. `detectCorrection({tool:"read"}, "what does this file do")` → `{matched:false, shape:null}` (genuine question).
7. `detectCorrection(null, "no stop")` → `{matched:true, shape:"negation"}` (works without a prior tool call).
8. `detectCorrection({tool:"edit"}, "ok")` → `{matched:false, shape:null}` (too short / not a correction).
9. Ordering: `"undo that, no wait"` → `"undo"` wins (undo before negation? — confirm: negation checked first, but `undo` keyword present → per the documented order negation is checked first; this string lacks a leading negation token so it falls through to undo). Document the expected result for this exact string in the test: `{matched:true, shape:"undo"}`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/correction.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Trim + lowercase the text; if length <3 return not-matched. Check shape patterns in order (negation → undo → redirect → retry-different), returning the first match. Negation is checked against the *start* of the trimmed message; undo/redirect/retry-different against `includes`. Return `{matched:false, shape:null}` if none match.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/correction.test.ts` and `npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

Run: `git add src/adapter/correction.ts test/correction.test.ts && git commit -m "feat: content-based correction detector for user messages"`

---

### Task 5: Tool taxonomy + adapter parse/normalize

**Files:**
- Create: `src/adapter/taxonomy.ts`, `src/adapter/parse.ts`, `test/parse.test.ts`

**Interfaces:**
- Consumes: `NormalizedEvent`, `InputDigest`, `Correction` types (Task 2); `scrubCmd/scrubQuery/scrubFiles` (Task 3); `detectCorrection` (Task 4).
- Produces:
  - `taxonomy.ts`: `mapToolKind(ccToolName: string): ToolKind` — `Read`→`read`; `Grep`,`Glob`→`search`; `LS`→`list`; `Edit`,`Write`,`NotebookEdit`→`edit`; `Bash`→`exec`; everything else (incl. `Task*`, `WebSearch`, `WebFetch`, `mcp__*`)→`other`. Unknown/empty → `other`.
  - `parse.ts`: `normalizeRecord(raw: unknown, ctx: { prevToolCall: {tool:ToolKind}|null }): NormalizedEvent | null` — converts one parsed JSONL record (a Claude Code transcript entry object) into a `NormalizedEvent`, or returns `null` when the record carries no usable event (e.g. a pure system entry).
    - Record shape assumptions (Claude Code JSONL): each line is an object with a `type` (`user`|`assistant`|`tool_result`-ish) and `message` content; tool calls appear as content items with `type:"tool_use"` and `name`; tool results with `is_error`/`interrupted`. The implementer inspects a sample transcript to confirm exact field names and records them as constants in `parse.ts`. **Behavioral contract regardless of exact field names:** map `user`→`user_msg`, `assistant`→`assistant_msg`, tool-use→`tool_call`.
    - `tool`: `mapToolKind(name)` for tool_use, else `null`.
    - `input_digest`: for exec → `{files:[], cmd: scrubCmd(extractedCommand), query:null, lines_changed:null}`; read/list/edit → `{files: scrubFiles(extractedPaths), cmd:null, query:null, lines_changed: edit ? changedLineCount : null}`; search → `{files:[], cmd:null, query: scrubQuery(pattern), lines_changed:null}`; other/user_msg/assistant_msg → all-empty digest.
    - `lines_changed` for edit: number of lines in the changed region (from the edit's `old_string`/`new_string` or `content` — exact source confirmed from a sample; contract: a non-negative integer, 0 if uncomputable).
    - `ok`: for exec tool results, `ok = !is_error`; for everything else `ok = true`.
    - `interrupted`: the transcript's interrupt flag (boolean; default `false` if absent).
    - `duration_ms`: from the record if present, else `0`.
    - `correction`: only for `user_msg` — `detectCorrection(ctx.prevToolCall, userText)`; for non-user_msg, `null`. `ctx.prevToolCall` is updated by the caller (stream) between records.
    - `t`: ISO8601 timestamp from the record.
  - **No raw text is emitted:** `userText` is consumed by `detectCorrection` and discarded; it never appears on the returned event.

- [ ] **Step 1: Write the failing tests**

`test/parse.test.ts` uses small synthetic raw-record objects (the exact field names confirmed from one real `~/.claude/projects/*/*.jsonl` sample, captured as a constant in the test). Cases:
1. A `user` record with text `"no, stop"` following a tool_call context → `NormalizedEvent` with `kind:"user_msg"`, `correction.matched===true`, and **no field on the event contains `"no, stop"`** (assert by JSON.stringify not including the substring).
2. An `assistant` tool_use `Bash` with `command:"export TOKEN=ghp_x"` → `kind:"tool_call"`, `tool:"exec"`, `input_digest.cmd` contains `***REDACTED***` and not the token.
3. An `Edit` tool_use with a 10-line change → `tool:"edit"`, `input_digest.lines_changed===10`, `files` populated.
4. A `Grep` tool_use → `tool:"search"`, `input_digest.query` scrubbed.
5. A `tool_result` for exec with `is_error:true` → `ok===false`, `interrupted===false`.
6. A `tool_result` with `interrupted:true` → `interrupted===true`.
7. An unknown tool name `mcp__foo__bar` → `tool:"other"`.
8. A record with no recognizable event → `normalizeRecord` returns `null`.
9. `cmd` exceeding 512 chars after scrub → truncated to 512.
10. `files` with 60 paths → 50 in digest.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/parse.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write minimal implementation**

Inspect one real transcript line to confirm field names; encode them as constants. Implement `mapToolKind` (lookup table). Implement `normalizeRecord`: switch on record type, extract digest fields per tool, call scrubbers, compute `ok`/`interrupted`/`correction`, cap lengths, return the event or `null`. Keep it pure (no I/O).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/parse.test.ts` and `npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

Run: `git add src/adapter/taxonomy.ts src/adapter/parse.ts test/parse.test.ts && git commit -m "feat: claude-code transcript normalizer + tool taxonomy"`

---

### Task 6: Adapter stream (caps + warnings)

**Files:**
- Create: `src/adapter/stream.ts`, `test/stream.test.ts`, `test/fixtures/stream/*.jsonl`

**Interfaces:**
- Consumes: `normalizeRecord` (Task 5), `NormalizedEnvelope`/`Warnings` types (Task 2).
- Produces `src/adapter/stream.ts`:
  - `streamSession(path: string): { envelope: NormalizedEnvelope, cwd: string, warnings: Pick<Warnings,"malformed_lines"|"oversized_lines"|"truncated_sessions"> }` — reads the `.jsonl` file line-by-line (never `slurp`), enforcing:
    - **Input line cap 1 MB:** lines >1,048,576 bytes are skipped (not parsed), `oversized_lines++`.
    - **Malformed line:** `JSON.parse` throws → skip, `malformed_lines++`. Never throws.
    - **Event cap 5000:** once 5000 events are collected, drop the rest, set `envelope.truncated=true`, `warnings.truncated_sessions=1` (0 otherwise).
    - **Per-session byte cap 50 MB:** stop reading once cumulative bytes read ≥50*1024*1024 (treat as truncated).
    - `envelope.event_count` = number of events actually kept (≤5000).
    - `envelope.session_id` derived from the filename stem; `started_at` = first event `t`; `duration_ms` = last-kept `t` − first `t`; `agent:"claude-code"`; `schema_version:1`; `repo` left empty here (filled by pipeline via git, Task 16).
    - `cwd` (returned alongside the envelope, NOT stored on it — the envelope schema carries only `repo`): the session's representative cwd = the `cwd` field from the first transcript record that contains one. The pipeline uses it to resolve `repo`.
    - `ctx.prevToolCall` threaded through `normalizeRecord` calls in order.
  - Pure I/O: reads one file, returns one envelope. Deterministic given the file.

- [ ] **Step 1: Write the failing tests**

`test/stream.test.ts` writes temp `.jsonl` fixture files (via `fs.writeFileSync` to `test/fixtures/stream/`):
1. A 3-line well-formed file → `envelope.events.length===3`, `event_count===3`, `truncated===false`, all warning counts 0, `duration_ms` = last−first.
2. A file where line 2 is invalid JSON → `malformed_lines===1`, the other 2 events still parsed.
3. A file with one 1.2 MB line → `oversized_lines===1`, that line not parsed.
4. A file with 5001 events → `event_count===5000`, `truncated===true`, `truncated_sessions===1`.
5. A file totaling >50 MB (synthetic: one line of ~49 MB of valid JSON + more) → `truncated===true`, reading stopped.
6. `session_id` equals the filename without extension.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/stream.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Open the file with `fs.createReadStream` + a line-splitting transform (or `readline`), accumulating bytes; for each line: check byte length against 1 MB, `JSON.parse` in try/catch, call `normalizeRecord`, push if non-null, stop at 5000 or 50 MB. Compute envelope meta. Never throw on bad input.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/stream.test.ts` and `npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

Run: `git add src/adapter/stream.ts test/stream.test.ts test/fixtures/stream/ && git commit -m "feat: streaming transcript reader with caps and warnings"`

---

### Task 7: Sandboxed git toplevel resolver

**Files:**
- Create: `src/git.ts`, `test/git.test.ts`

**Interfaces:**
- Consumes: none (Node `child_process.execFile`).
- Produces `src/git.ts`:
  - `resolveToplevel(cwd: string, cache?: Map<string,string|null>): string | null` — returns the git toplevel for `cwd`, or `null` if `cwd` is not a git repo / git unavailable / cwd doesn't exist. Memoized by `cwd` when a cache Map is passed.
  - **Sandbox (structural, asserted by test):** invokes `execFile("git", ["-C", cwd, "-c","core.fsmonitor=","-c","core.pager=cat","-c","core.hooksPath=","rev-parse","--show-toplevel"], { env: { ...process.env, GIT_CONFIG_NOSYSTEM:"1", GIT_CONFIG_GLOBAL:"/dev/null" }, windowsHide:true })` — no shell, no `status`/`diff`/`log`. Trims stdout; returns `null` on any non-zero exit or thrown error.

- [ ] **Step 1: Write the failing tests**

`test/git.test.ts` (uses a temp dir; spawn real git — git is a runtime prerequisite):
1. In a temp dir initialized with `git init`, `resolveToplevel(tempDir)` returns the temp dir path (resolved/realpath).
2. In a non-git temp dir, `resolveToplevel` returns `null` (no throw).
3. **Sandbox assertion:** spy on `child_process.execFile` (vitest `vi.spyOn`); call `resolveToplevel`; assert the spy was called with argv beginning `["-C", cwd, "-c","core.fsmonitor=", ...]` and args including `rev-parse`,`--show-toplevel` (never `status`/`diff`/`log`), and env containing `GIT_CONFIG_NOSYSTEM==="1"` and `GIT_CONFIG_GLOBAL==="/dev/null"`.
4. Cache: two calls with the same cwd invoke `execFile` once.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/git.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Implement exactly the `execFile` call above; wrap in try/catch; on error or non-zero code return `null`. Memoize via the optional cache Map. Use `node:child_process` `execFile` (promise-wrapped or callback).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/git.test.ts` and `npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

Run: `git add src/git.ts test/git.test.ts && git commit -m "feat: sandboxed git toplevel resolver"`

---

### Task 8: Transcript walk (discovery + symlink rejection)

**Files:**
- Create: `src/walk.ts`, `test/walk.test.ts`

**Interfaces:**
- Consumes: `Warnings` type (Task 2).
- Produces `src/walk.ts`:
  - `discoverTranscripts(claudeDir: string): { files: string[]; symlinks_rejected: number }` — lists every `*.jsonl` under `claudeDir/projects/*/*.jsonl` (one level of session-dir under `projects/`).
  - **Symlink rejection:** `lstat` each candidate; if `isSymbolicLink()`, skip and `symlinks_rejected++`. Also reject any path whose real resolved location escapes `claudeDir` (defensive: confirm the discovered file's directory starts with the `projects/` prefix).
  - Does not read file contents (stream does that). Does not follow symlinks for directory traversal either.
  - `defaultClaudeDir()` helper: returns `path.join(os.homedir(), ".claude")`.

- [ ] **Step 1: Write the failing tests**

`test/walk.test.ts` builds a temp tree `tmpDir/projects/<slug>/a.jsonl`, `b.jsonl`, and a symlink `c.jsonl → /etc/passwd` (or another outside file):
1. `discoverTranscripts(tmpDir)` returns the two real `.jsonl` files, NOT the symlink; `symlinks_rejected===1`.
2. A `.txt` file is ignored (not returned).
3. A nested symlinked directory is not traversed (rejected/ignored).
4. `defaultClaudeDir()` returns `<homedir>/.claude`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/walk.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Use `fs.readdir` (with `withFileTypes`) on `projects/`, then on each session subdir; `lstat` each `.jsonl`; skip symlinks; collect real files. No `fs.realpath` following into arbitrary locations.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/walk.test.ts` and `npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

Run: `git add src/walk.ts test/walk.test.ts && git commit -m "feat: transcript discovery with symlink rejection"`

---

### Task 9: Detector signals — part 1 (explore_ratio, reread, failure_streak, corrections)

**Files:**
- Create: `src/detector/signals.ts` (partial — four signals), `test/signals.part1.test.ts`

**Interfaces:**
- Consumes: `NormalizedEvent[]`, `Config` (Task 2). Pure.
- Produces `src/detector/signals.ts` with `computeSignals(events: NormalizedEvent[], cfg: Config): SignalValues` (this task implements four of the seven fields; part 2 fills the rest). Field contracts:
  - `explore_ratio: number | null` — `(count of events with tool in {search,read,list}) / max(totalEditedLines, 1)`. `totalEditedLines` = sum of `input_digest.lines_changed` over `edit` events. **Returns `null` when `totalEditedLines === 0`** (does not contribute to scoring).
  - `reread: number` — count of distinct file paths (from `input_digest.files` of `read` events) that were read ≥ `cfg.detector.reread_threshold` times. Distinct = unique repo-relative path string.
  - `failure_streak: number` — length of the longest run of consecutive `exec` events with `ok === false`. 0 if none.
  - `corrections: number` — count of `user_msg` events whose `correction.matched === true` AND whose timestamp `t` is within `cfg.detector.correction_window_ms` after the most recent preceding `assistant` `tool_call`, OR before the next `assistant_msg`. (I.e. a correction counts if it lands in the window after a tool call, or before the assistant speaks again.)
  - The other three fields (`abandonment`, `oscillation`, `wall_clock_per_line_ms`) are stubbed to `false`/`0`/`null` in this task (part 2 overwrites).

- [ ] **Step 1: Write the failing tests**

`test/signals.part1.test.ts` — synthetic `NormalizedEvent[]` arrays:
1. 3 search + 5 read + 2 list calls, total edited lines 10 → `explore_ratio === 1.0` (10/10). 
2. Zero edits → `explore_ratio === null`.
3. File `src/a.ts` read 5 times, `src/b.ts` read 2 times, `reread_threshold=5` → `reread === 1`.
4. exec sequence ok:[T,F,F,F,T] → `failure_streak === 3`.
5. A `user_msg` with `correction.matched:true` 60s after an assistant tool_call, `correction_window_ms=120000` → counted; a correction 200s after → not counted.
6. A correction before the next `assistant_msg` (no intervening tool call within window) → counted.
7. Mixed: `corrections` total correct for a 6-event sequence.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/signals.part1.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Pure functions over the events array. For `explore_ratio`: count explore-tool events and sum edit lines. For `reread`: build a `Map<path, count>` from read events' files, count entries ≥ threshold. For `failure_streak`: single pass tracking current run and max. For `corrections`: track last assistant tool_call timestamp; for each user_msg correction, check window-to-last-tool-call OR no assistant_msg since. Stub the three part-2 fields.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/signals.part1.test.ts` and `npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

Run: `git add src/detector/signals.ts test/signals.part1.test.ts && git commit -m "feat: detector signals (explore_ratio, reread, failure_streak, corrections)"`

---

### Task 10: Detector signals — part 2 (abandonment, oscillation, wall_clock_per_line)

**Files:**
- Modify: `src/detector/signals.ts` (fill the three remaining fields)
- Create: `test/signals.part2.test.ts`

**Interfaces:**
- Consumes: same as Task 9. Pure.
- Produces (completes `computeSignals`):
  - `abandonment: boolean` — **true** when the last `cfg.areas.tail_fraction` (default 0.25) of events have an explore-ratio ≥ `cfg.areas.explore_ratio_min` (0.8) AND zero edit events in that tail. **Suppressed (forced false)** when `cfg.areas.suppress_abandonment_when_no_exec` is true AND the *whole session* has zero edits AND zero test/build exec calls (a research signature). A "test/build exec" = an `exec` event whose scrubbed `cmd` contains any token from `cfg.areas.test_cmd_patterns` (substring match, case-insensitive).
  - `oscillation: number` — count of cycles matching `edit → test/build-exec(ok=false) → edit-same-file` per file. "Same-file" = exact path string match on `input_digest.files`. A cycle for file F: an `edit` touching F, followed (possibly with other events) by a test/build `exec` with `ok===false`, followed by another `edit` touching F. Count distinct completed cycles per file. **TDD guard:** a red-green sequence `edit → test(ok=false) → test(ok=true)` with no second edit on the same file does NOT count as a cycle (requires the second edit). Test/build exec = `exec` whose `cmd` matches `test_cmd_patterns`.
  - `wall_clock_per_line_ms: number | null` — `(last event `t` − first event `t`) in ms / max(totalEditedLines, 1)` (this equals `envelope.duration_ms` by Task 6's construction, so `computeSignals` can derive it from `events` alone — no envelope arg needed); **null when `totalEditedLines === 0`**.

- [ ] **Step 1: Write the failing tests**

`test/signals.part2.test.ts`:
1. Tail of 4 events (of 16 total, tail_fraction 0.25): 3 read + 1 search, 0 edits → `abandonment === true`.
2. Same but one edit in the tail → `abandonment === false`.
3. Whole session: 0 edits, 0 test/build exec (e.g. only `grep`/`ls`) → `abandonment === false` (suppressed research signature).
4. Whole session: 0 edits but a `npm test` exec present → suppression does NOT apply (test exec present), and if the tail is explore-only → `abandonment === true`.
5. `edit src/a.ts → npm test(ok=false) → edit src/a.ts` → `oscillation === 1`.
6. TDD red-green: `edit src/a.ts → npm test(ok=false) → npm test(ok=true)` (no second edit) → `oscillation === 0`.
7. Two cycles on the same file → `oscillation === 2`.
8. `edit a → test fail → edit b` (different file) → `oscillation === 0` for that cycle.
9. Session duration 600000 ms, 10 edited lines → `wall_clock_per_line_ms === 60000`. Zero edits → `null`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/signals.part2.test.ts`
Expected: FAIL (stubs return wrong values).

- [ ] **Step 3: Write minimal implementation**

Implement the three fields, replacing the Task 9 stubs. For `abandonment`: slice the tail by `Math.floor(events.length * tail_fraction)`; compute tail explore-ratio and edit count; apply whole-session suppression. For `oscillation`: single pass per file tracking pending `edit` awaiting a failed test/build then a re-edit. For `wall_clock_per_line`: simple ratio with null guard. Re-run part-1 tests to ensure no regression.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/signals.part2.test.ts test/signals.part1.test.ts` and `npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

Run: `git add src/detector/signals.ts test/signals.part2.test.ts && git commit -m "feat: detector signals (abandonment, oscillation, wall_clock_per_line)"`

---

### Task 11: Scoring — percentile of composites + bootstrap

**Files:**
- Create: `src/detector/scoring.ts`, `test/scoring.test.ts`

**Interfaces:**
- Consumes: `SignalValues[]` (one per session), `Config`, and a `forceBootstrap: boolean` (from `--bootstrap`).
- Produces `src/detector/scoring.ts`:
  - `scoreSessions(input: { signals: SignalValues[]; cfg: Config; forceBootstrap: boolean }): { score_pct: number; mode: ScoringMode; flagged: boolean; composite: number }[]` — one result per session, in input order.
  - **Mode selection (precedence):** `forceBootstrap` → bootstrap; else `cfg.detector.thresholds_as === "absolute"` → bootstrap; else `signals.length < cfg.detector.bootstrap_session_floor` → bootstrap; else percentile. Both auto-thin-history and user-forced absolute report `mode:"bootstrap"`.
  - **Percentile mode:**
    1. For each numeric signal across sessions, compute a percentile rank 0–100 for each session (share of sessions with a strictly lower value; ties get the average rank — define exactly: rank = (count strictly less) / (n−1) * 100 when n>1, else 0).
    2. `abandonment` (boolean) contributes `0` (false) / `100` (true).
    3. `explore_ratio` and `wall_clock_per_line_ms` that are `null` for a session are **excluded** from that session's composite, and the remaining weights are renormalized to sum 1. If all weighted signals are null/absent, composite = 0.
    4. `composite` = Σ(signal_contribution × normalized_weight).
    5. `score_pct` = percentile rank of the session's `composite` across all sessions (same rank formula).
    6. `flagged = score_pct >= cfg.detector.flag_pct`.
  - **Bootstrap mode:**
    1. Each numeric signal **trips** (1) if its value ≥ the corresponding `cfg.detector.bootstrap_thresholds` entry (for `wall_clock_per_line_ms` compare the ms value; null → does not trip); `abandonment` trips if `true`.
    2. `composite` = weighted mean of tripped signals (weights from `signal_weights`, renormalized over non-null signals; tripped=1, not-tripped=0).
    3. `flagged = composite >= cfg.detector.bootstrap_flag_pct` OR count of tripped signals ≥ 2.
    4. `score_pct = composite` (not a percentile); `mode:"bootstrap"`.

- [ ] **Step 1: Write the failing tests**

`test/scoring.test.ts`:
1. **Percentile rank:** 5 sessions with `reread` values [0,1,2,3,10], all other signals null/zero and `abandonment=false`. Composite tracks `reread` rank. The session with 10 has `score_pct === 100` and is flagged (if `flag_pct=90`).
2. **Null renormalization:** a session where `explore_ratio` and `wall_clock_per_line_ms` are null — its composite equals the weighted contribution of the remaining signals (weights renormalized).
3. **All-null session:** composite === 0, not flagged.
4. **Bootstrap auto:** 5 sessions (< K=30) → `mode==="bootstrap"` for all.
5. **Bootstrap force:** 100 sessions + `forceBootstrap:true` → `mode==="bootstrap"`.
6. **Bootstrap tripping:** a session tripping `reread` (5) and `failure_streak` (3) only → flagged (≥2 trips) even if composite < 70.
7. **Bootstrap composite gate:** a session tripping one high-weight signal such that composite ≥ 70 → flagged.
8. **Mode precedence:** `thresholds_as:"absolute"` with 100 sessions + `forceBootstrap:false` → bootstrap.
9. **Boolean contribution:** percentile mode, a session with `abandonment=true` gets +100×(weight) contribution.
10. **Percentile of composite:** construct 30 sessions whose composites are 0..29; the top one has `score_pct===100`, flagged at 90.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/scoring.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Implement percentile-rank helper, mode selection, percentile-mode composite (with null renormalization), bootstrap-mode trip+composite+flag. All pure. No floating-point surprises: use simple arithmetic; tests use values that avoid ambiguous ties.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/scoring.test.ts` and `npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

Run: `git add src/detector/scoring.ts test/scoring.test.ts && git commit -m "feat: percentile-of-composites scorer with bootstrap mode"`

---

### Task 12: Area localization (path-prefix clustering)

**Files:**
- Create: `src/detector/areas.ts`, `test/areas.test.ts`

**Interfaces:**
- Consumes: `NormalizedEvent[]`, `Config`. Pure.
- Produces `src/detector/areas.ts`:
  - `localizeAreas(events: NormalizedEvent[], cfg: Config): { key: string; weight: number }[]`:
    1. Accumulate **touch-weight** per file: each event adds `cfg.areas.touch_weights[tool]` to each file in `input_digest.files` (edit→3, read→2, exec→1; other/user_msg/assistant_msg → 0).
    2. Roll up to ancestor directories: each directory's weight = sum of weights of all files beneath it (transitively). Ignore any path whose first segment is in `cfg.areas.ignore`.
    3. Candidate areas = directories at depth ≥ `cfg.areas.min_depth` (default 2; depth = number of `/`-separated segments from repo root) capturing ≥ `cfg.areas.min_weight` (0.40) of the session's total touch-weight.
    4. A session maps to its **deepest** qualifying directory/directories; if a deeper qualifying dir is a descendant of a shallower one, keep only the deepest. Each returned area's `weight` = (its weight / total) ∈ [0,1].
    5. **Fallback:** if no directory qualifies → return `[]` (the session is `(unlocalized)`; the pipeline records this separately — see Task 14).

- [ ] **Step 1: Write the failing tests**

`test/areas.test.ts`:
1. Files `src/billing/charge.ts` (edit,3) and `src/billing/refund.ts` (edit,3), total 6 → `src/billing` (depth 2) qualifies with weight 1.0; result `[{key:"src/billing", weight:1.0}]`.
2. Files under `src/billing/charge/a.ts` and `src/billing/refund/b.ts` → deepest qualifying dirs are `src/billing/charge` and `src/billing/refund` (each 0.5 ≥ 0.40); `src/billing` is a shallower ancestor and is dropped.
3. A file under `node_modules/pkg/x.ts` → ignored entirely; if that's the only file → `[]` (unlocalized).
4. A single file at depth 1 (`README.md`) → `[]` (below min_depth 2).
5. A dir capturing only 0.30 of weight → not in result; if none qualify → `[]`.
6. `exec` touching `cmd`-derived files: exec events contribute weight 1 to each file in their digest.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/areas.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Build a `Map<file, weight>`; derive directory weights by prefix-summing; filter by depth + min_weight; prune non-deepest. Paths normalized to forward slashes, repo-relative.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/areas.test.ts` and `npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

Run: `git add src/detector/areas.ts test/areas.test.ts && git commit -m "feat: path-prefix area localization with touch-weights"`

---

### Task 13: Struggle record assembly + detector orchestration

**Files:**
- Create: `src/detector/record.ts`, `src/detector/index.ts`, `test/detector.test.ts`

**Interfaces:**
- Consumes: `computeSignals` (Task 9/10), `scoreSessions` (Task 11), `localizeAreas` (Task 12), `NormalizedEnvelope`, `Config`.
- Produces:
  - `record.ts`: `assembleStruggleRecord(envelope: NormalizedEnvelope, signals: SignalValues, score: {score_pct;mode;flagged;composite}, areas: {key;weight}[]): StruggleRecord` — pure projection; `signals` field stores **raw** values (the `SignalValues` as-is, including nulls/booleans); `score_pct`,`mode`,`flagged` from `score`; `truncated`/`event_count`/`started_at`/`duration_ms`/`session_id`/`repo` from `envelope`.
  - `index.ts`: `runDetector(envelopes: NormalizedEnvelope[], cfg: Config, forceBootstrap: boolean): StruggleRecord[]` — for each envelope compute signals; collect all `SignalValues`; call `scoreSessions` once with the full array (percentile needs the whole set); for each envelope compute areas and assemble the record. Returns records in envelope order.
  - `runDetector` also returns (or the pipeline tracks) the `mode` chosen — exposed via the first record's `mode` (all records share one mode).

- [ ] **Step 1: Write the failing tests**

`test/detector.test.ts`:
1. 3 envelopes (one heavy-struggle, one clean, one mid). `runDetector` returns 3 records, each with `signals` = raw values, `mode` consistent across all, `flagged` consistent with `scoreSessions`.
2. A record's `signals.explore_ratio` is `null` when its envelope had no edits.
3. `truncated`/`event_count` propagate from the envelope.
4. `areas` populated from `localizeAreas` (or `[]` for unlocalized).
5. `mode` is `bootstrap` when `envelopes.length < K` (3 < 30), `percentile` when given ≥30 envelopes (use a generator/synthetic 30-envelope fixture).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/detector.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write minimal implementation**

`assembleStruggleRecord` is a pure object build. `runDetector`: map envelopes→signals; `scoreSessions({signals, cfg, forceBootstrap})`; zip envelopes×signals×scores×areas → records. No I/O.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/detector.test.ts` and `npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

Run: `git add src/detector/record.ts src/detector/index.ts test/detector.test.ts && git commit -m "feat: struggle record assembly and detector orchestration"`

---

### Task 14: Aggregation / leaderboard

**Files:**
- Create: `src/aggregate/leaderboard.ts`, `test/leaderboard.test.ts`

**Interfaces:**
- Consumes: `StruggleRecord[]`, `Config`. Pure.
- Produces `src/aggregate/leaderboard.ts`:
  - `aggregateAreas(records: StruggleRecord[], cfg: Config): { rows: AreaRow[]; summary: { flagged: number; unflagged: number; unlocalized: number } }`:
    1. For each record, for each of its `areas`, add the record (weighted by `area.weight`) to that area's `sessions_total`; if the record is `flagged`, add to `sessions_flagged` (weighted).
    2. `mean_score` = average of `score_pct` over **flagged** records touching the area (0 if none flagged).
    3. `top_signals` (per area, max 3): for percentile mode, the signals ranked by their per-session percentile rank (passed in via an extension — see note); for bootstrap mode / booleans, by raw value. **Simplest deterministic v1:** for each area, take the median raw `signals` values across its flagged sessions, pick the top 3 by magnitude, format `display` per the rule below.
    4. Sort `rows` by `sessions_flagged` desc, then `mean_score` desc.
    5. `summary.unlocalized` = count of records with empty `areas`; `flagged`/`unflagged` = counts of records (excluding unlocalized from the area list but included in totals).
  - **`display` formatting rule:** counts → `name(N)` e.g. `reread(7)`; percentile ranks → `name(Nth)` e.g. `explore_ratio(95th)`; durations ms → seconds `wall_clock_per_line(540s)` (or `Nms` if <1000); booleans → `abandonment(yes)` / `abandonment(no)`.
  - Note on percentile-rank top_signals: to avoid threading percentile ranks through records (spec says percentile ranks are internal to scoring and not stored per signal), the v1 `top_signals` selection uses **raw signal values** uniformly (median across flagged sessions), with `display` still distinguishing kind for readability. This is a documented v1 simplification; open question §12.2 covers oscillation fidelity, and top-signal ranking fidelity is folded there.

- [ ] **Step 1: Write the failing tests**

`test/leaderboard.test.ts`:
1. 3 records touching `src/billing` (2 flagged with scores 90, 80; 1 unflagged). Row `src/billing`: `sessions_total===3` (weighted—confirm exact weighted values in test), `sessions_flagged===2`, `mean_score===85`, `top_signals` length ≤3, sorted first.
2. A record with `[]` areas → counted in `summary.unlocalized`, not in any row.
3. Sort: two areas, one with more flagged → first; tie → higher `mean_score` first.
4. `display`: a count signal value 7 → `reread(7)`; a duration 540000 ms → `wall_clock_per_line(540s)`; `abandonment===true` → `abandonment(yes)`.
5. `summary` counts correct over a 5-record mixed set.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/leaderboard.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Group records by area key; accumulate weighted totals; compute mean_score over flagged; pick top 3 median signals; format display per kind; sort; compute summary. Pure.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/leaderboard.test.ts` and `npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

Run: `git add src/aggregate/leaderboard.ts test/leaderboard.test.ts && git commit -m "feat: area aggregation and leaderboard formatting"`

---

### Task 15: Output formatters (json, human, calibrate)

**Files:**
- Create: `src/output/json.ts`, `src/output/human.ts`, `src/output/calibrate.ts`, `test/output.test.ts`

**Interfaces:**
- Consumes: `StruggleRecord[]`, `AreaRow[]`, `Warnings`, `Config`, `ScoringMode`. Pure.
- Produces:
  - `json.ts`: `buildJsonEnvelope(input: { repo: string; mode: ScoringMode; session_count: number; warnings: Warnings; sessions: StruggleRecord[]; areas: AreaRow[] }): JsonOutput` — assembles the `JsonOutput` (Task 2 type). `schema_version:1`.
  - `human.ts`: `formatHuman(input: { repo: string; mode: ScoringMode; sessionCount: number; areas: AreaRow[]; summary: {flagged;unflagged;unlocalized}; warnings: Warnings }): string` — the §8 table: a header line `harnessgap scan — repo: <repo> · <N> sessions · mode: <mode>`, a column-aligned table (`AREA | FLAGGED | MEAN SCORE | TOP SIGNALS`), a summary line `… areas flagged · … unflagged · … unlocalized · bootstrap: <N> sessions` (bootstrap count = number of sessions when mode is bootstrap, else 0), and a warnings line (only integer counts, omit categories that are 0).
  - `calibrate.ts`: two exports — `buildCalibrateObject(input: { mode; session_count; flag_pct; signals: SignalValues[]; bootstrap_thresholds: Config["detector"]["bootstrap_thresholds"] }): { mode; session_count; flag_pct; signals: Record<SignalName, {min;p50;p90;max;active_threshold}> }` and `formatCalibrateTable(obj): string` (human table). **Aggregate statistics only** — no per-session values, no commands, no prose. `active_threshold` = the `bootstrap_thresholds[name]` value (bootstrap mode), or the `flag_pct`-percentile value of that signal across sessions (percentile mode). For boolean `abandonment`, min/p50/p90/max are 0/1.

- [ ] **Step 1: Write the failing tests**

`test/output.test.ts`:
1. `buildJsonEnvelope` returns an object matching `JsonOutput` shape; `schema_version===1`; `warnings` integer counts only; no record's `signals` or any field contains raw user text (assert: scan JSON.stringify for a known prose fixture string → absent).
2. `formatHuman` output contains the header, the column headers, one row per area, the summary line, and (when present) a warnings line with integer counts; **no prose from fixtures appears**.
3. `formatHuman` with zero areas → prints a clear "no flagged areas" line, exit-friendly.
4. `buildCalibrateObject` has exactly the 7 signal keys, each with `min,p50,p90,max,active_threshold`; for `abandonment` all are 0/1.
5. `formatCalibrateTable` contains no per-session examples, no commands, no prose — only aggregate numbers and signal names.
6. Warnings line omits zero-count categories.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/output.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write minimal implementation**

Pure builders. `buildJsonEnvelope` is a direct assembly. `formatHuman` uses fixed column widths (pad/truncate area key to e.g. 32 chars). `calibrate` computes min/p50/p90/max over the signals array per signal (p50/p90 via sorted-index interpolation), `active_threshold` from config or percentile. No prose anywhere.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/output.test.ts` and `npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

Run: `git add src/output/json.ts src/output/human.ts src/output/calibrate.ts test/output.test.ts && git commit -m "feat: json/human/calibrate output formatters"`

---

### Task 16: Pipeline orchestration

**Files:**
- Create: `src/pipeline.ts`, `test/pipeline.test.ts`

**Interfaces:**
- Consumes: `discoverTranscripts` (Task 8), `streamSession` (Task 6), `resolveToplevel` (Task 7), `runDetector` (Task 13), `aggregateAreas` (Task 14), `Config`, `loadConfig`, `parseDuration`.
- Produces `src/pipeline.ts`:
  - `export interface ScanOptions { repo?: string; since?: string; limit?: number; json?: boolean; calibrate?: boolean; bootstrap?: boolean; configPath?: string; claudeDir?: string }`
  - `export interface ScanResult { output: string; mode: ScoringMode; sessionCount: number; warnings: Warnings; exitCode: 0|1 }`
  - `runScan(opts: ScanOptions): ScanResult` — orchestrates: load config; `discoverTranscripts`; for each file `streamSession` → `{ envelope, cwd, warnings }`; resolve `repo` via `resolveToplevel(cwd)` (cache) and set `envelope.repo`; if `cwd` is unresolvable (`resolveToplevel` returns null) skip the session (`warnings.unresolvable_cwd++`, `skipped_sessions++`); filter envelopes to `opts.repo` (exact toplevel match) when given, else to `resolveToplevel(process.cwd())`; apply `--since` (filter by `started_at` ≥ now−duration) and `--limit` (cap count, after filtering); `runDetector(envelopes, cfg, opts.bootstrap)`; `aggregateAreas`; build the appropriate output (`--calibrate` → `buildCalibrateObject({mode, session_count, flag_pct, signals, bootstrap_thresholds: cfg.detector.bootstrap_thresholds})` then `formatCalibrateTable` (or JSON-stringify the object with `--json`); `--json` (without calibrate) → `buildJsonEnvelope`; else `formatHuman`). `--calibrate --json` → the calibrate object JSON-stringified (NOT the scan envelope). `exitCode` 0 always (genuine misconfig raises — caught in cli.ts → non-zero).
  - **No disk writes.** No network.

- [ ] **Step 1: Write the failing tests**

`test/pipeline.test.ts` builds a temp `claudeDir/projects/<slug>/*.jsonl` with 2 well-formed transcripts whose `cwd` resolves to a temp git repo (init one). Cases:
1. `runScan({ repo: tempRepo, claudeDir })` → `sessionCount===2`, `exitCode===0`, `output` is a human table containing both areas or a "no flagged" line.
2. `runScan({ repo: tempRepo, claudeDir, json:true })` → `output` parses as JSON matching `JsonOutput`, `mode` reflects session count (2 → bootstrap).
3. `runScan({ claudeDir, bootstrap:true })` → `mode==="bootstrap"`.
4. `runScan({ repo: tempRepo, claudeDir, limit:1 })` → `sessionCount===1`.
5. A transcript with unresolvable cwd (cwd points at a non-existent dir) → `warnings.unresolvable_cwd===1`, that session skipped, others scanned.
6. Empty `claudeDir` → `sessionCount===0`, `exitCode===0`, output says no sessions.
7. `--calibrate` → `output` is the calibrate table (or JSON object with `--json`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pipeline.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Compose the modules in order. Thread the git cache. Apply filters. Branch output by flags. Catch nothing here (let misconfig throw to cli). No `fs.writeFile`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/pipeline.test.ts` and `npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

Run: `git add src/pipeline.ts test/pipeline.test.ts && git commit -m "feat: stateless scan pipeline orchestration"`

---

### Task 17: CLI entry + exit codes + egress guard

**Files:**
- Create: `src/cli.ts`, `test/cli.test.ts`, `test/egress.test.ts`
- Modify: `package.json` (confirm `bin` target `dist/cli.js`); delete `src/index.ts` smoke stub (replace bin with cli).

**Interfaces:**
- Consumes: `runScan` (Task 16), `commander`, `ConfigError`.
- Produces `src/cli.ts` (the bin entry, with `#!/usr/bin/env node` shebang):
  - `commander` program `harnessgap scan` with flags: `--repo <path>`, `--since <dur>`, `--limit <n>` (int), `--json`, `--calibrate`, `--bootstrap`, `--config <path>`, `--claude-dir <path>`, plus global `--version` (from `package.json`) and `--help`.
  - Calls `runScan` with the parsed options; writes `result.output` to stdout; `process.exit(result.exitCode)`.
  - Error handling: catch `ConfigError` (and any thrown error from `runScan`) → print a short message to stderr (no stack, no leaking of transcript paths beyond what's needed), `process.exit(1)`.
  - `--version` prints the `package.json` version. Default invocation (no subcommand) runs `scan` with defaults.
- Produces `test/egress.test.ts`:
  - A test that scans `src/**/*.ts` (via `fs` glob/readdir) and asserts **no file imports** `http`, `https`, `net`, `node:net`, `undici`, `fetch` (as a module import). This is the §11 egress audit, automated.

- [ ] **Step 1: Write the failing tests**

`test/cli.test.ts` spawns the built CLI (`node dist/cli.js`) (or uses `runScan` directly for the non-IO parts); for the spawn-based tests, build first via `npm run build`:
1. `node dist/cli.js scan --repo <tempRepo> --claude-dir <tempClaude>` on a 2-fixture corpus → stdout is a human table, exit code 0.
2. `--json` → stdout is valid JSON matching `JsonOutput`.
3. No sessions (`--claude-dir <empty>`) → stdout says no sessions, exit 0.
4. Bad config (`--config <bad.yml>`) → stderr message, exit 1.
5. `--version` → prints version, exit 0.
6. `--help` → prints usage, exit 0.

`test/egress.test.ts`:
7. The egress scan passes (no forbidden imports in `src/`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cli.test.ts test/egress.test.ts`
Expected: FAIL — `src/cli.ts` not found; egress test fails until cli exists and is clean.

- [ ] **Step 3: Write minimal implementation**

Implement `src/cli.ts` with commander. Delete `src/index.ts`. Update `package.json` `bin` to `dist/cli.js` and ensure `npm run build` emits it. Keep imports to `commander`, `./pipeline.js`, `./config.js`, `node:process`, `node:path`, `node:fs` only.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && npx vitest run test/cli.test.ts test/egress.test.ts` and `npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

Run: `git add src/cli.ts test/cli.test.ts test/egress.test.ts package.json && git rm src/index.ts && git commit -m "feat: cli entry with flags, exit codes, and egress guard"`

---

### Task 18: Labeled fixture corpus + snapshot + cross-cutting privacy/safety assertions

**Files:**
- Create: `test/fixtures/corpus/*.jsonl` with `test/fixtures/corpus/labels.json`, `test/fixtures/secret-shape/*.jsonl`, `test/fixtures/malformed/*.jsonl`, `test/fixtures/safety/*`, `test/corpus.test.ts`, `test/privacy.test.ts`, `test/snapshot.test.ts`

**Interfaces:**
- Consumes: the full pipeline (Task 16).
- Produces:
  - **Labeled corpus** (`test/fixtures/corpus/`): 10–20 anonymized transcripts, each a `.jsonl` file plus a `labels.json` entry `{ file, expected_flagged: boolean, expected_top_signals: string[] }`. Coverage: clean-quick, heavy-exploration, oscillation, failure-streak, abandonment (incl. one suppressed research session), TDD red-green (must NOT flag oscillation). Fixtures are synthetic-but-realistic (hand-authored JSONL matching the Claude Code record shape confirmed in Task 5); no real secrets.
  - **Secret-shape fixture** (`test/fixtures/secret-shape/`): transcripts containing each scrubber pattern (one per pattern); asserts none survive into normalized events.
  - **Malformed-transcript fixture** (`test/fixtures/malformed/`): a transcript with garbage lines + raw prose; asserts no raw prose appears in any output path (stdout, `--json`, `--calibrate`, warnings).
  - **Safety fixtures** (`test/fixtures/safety/`): a symlinked transcript (rejected), an unresolvable-cwd session (skipped), an oversized line (skipped).
  - `test/corpus.test.ts`: runs the pipeline over the corpus; for each fixture asserts `flagged === expected_flagged` (allow ≥80% match — document exact pass bar in the test; failures listed by file).
  - `test/privacy.test.ts`: (a) runs the secret-shape corpus through `scan --json` and asserts `***REDACTED***` present / original secrets absent in the full output; (b) runs the malformed fixture through all three output modes and asserts a set of known prose substrings are absent everywhere; (c) asserts `warnings` fields are integers and contain no path/prose.
  - `test/snapshot.test.ts`: runs `scan` (human) over the fixed corpus and snapshots the output via `expect(...).toMatchSnapshot()`; future scoring/format drift updates the snapshot deliberately.

- [ ] **Step 1: Write the failing tests**

Write `corpus.test.ts`, `privacy.test.ts`, `snapshot.test.ts` with the assertions above (fixtures created in this step). Use the labeled expectations as the source of truth.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/corpus.test.ts test/privacy.test.ts test/snapshot.test.ts`
Expected: FAIL — fixtures/labels missing or pipeline output mismatched (snapshot first run writes a `.snap`).

- [ ] **Step 3: Write minimal implementation**

Author the fixtures + `labels.json`. Adjust any signal threshold *defaults in the config* only if a fixture reveals a genuine defect (not to game expectations) — record any adjustment in the commit message. Re-run until corpus expectations pass (≥80% match bar), privacy assertions pass, snapshot is written.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/corpus.test.ts test/privacy.test.ts test/snapshot.test.ts` and `npm run typecheck`
Expected: all PASS; snapshot committed.

- [ ] **Step 5: Commit**

Run: `git add test/fixtures test/corpus.test.ts test/privacy.test.ts test/snapshot.test.ts && git commit -m "test: labeled fixture corpus, privacy assertions, leaderboard snapshot"`

---

### Task 19: Packaging, README, dependency egress audit

**Files:**
- Create: `README.md`
- Modify: `package.json` (final fields: `name`, `version`, `description`, `engines`, `files`, `bin`, `publishConfig` optional), `.gitignore`

**Interfaces:**
- Produces:
  - `package.json` finalized: `name:"harnessgap"`, `version:"0.1.0"`, `description`, `engines.node:">=22"`, `bin:{"harnessgap":"dist/cli.js"}`, `files:["dist"]`, scripts `build`/`dev`/`test`/`typecheck`.
  - `README.md`: short — what it is (detection-only), install (`npx harnessgap`), `scan` usage with every flag, the `.harnessgap.yml` subset, the success-criterion explanation, and a **Privacy** section stating: no network, no disk writes, pattern-catalog scrubbing, no raw prose in output, sandboxed git. Link to the spec.
  - A manual dependency audit documented in the README: `npm ls --all` output reviewed; confirm runtime deps are exactly `commander` + `yaml` (both no-egress); the `test/egress.test.ts` gate runs in CI.
  - `.gitignore` ensures `dist/` and `node_modules/` are not committed.

- [ ] **Step 1: Write the failing test**

A `test/packaging.test.ts` (or fold into `egress.test.ts`): asserts `package.json` `bin.harnessgap === "dist/cli.js"`, `engines.node >= 22`, `files` includes `dist`, and `npm ls --all --omit=dev` (run via execFile, no shell) lists exactly `commander` and `yaml` as runtime deps (parse `npm ls --json`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/packaging.test.ts`
Expected: FAIL — README/fields missing.

- [ ] **Step 3: Write minimal implementation**

Finalize `package.json`, write `README.md`, run `npm run build`, run `npm ls --all --json` and confirm the runtime dep tree.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/packaging.test.ts test/egress.test.ts && npm run typecheck && npm run build && npm test`
Expected: all PASS; full suite green; build clean.

- [ ] **Step 5: Commit**

Run: `git add README.md package.json .gitignore test/packaging.test.ts && git commit -m "chore: finalize packaging, readme, and dependency egress audit"`

---

## Self-Review (run by planner)

1. **Code scan:** No method bodies, algorithms, or test/impl code in this plan — only type signatures, data shapes, behavior descriptions, and expected test results. ✓
2. **Self-containment:** Each task restates the contracts it consumes/produces (types re-declared where used). A zero-context implementer can write each task from its own text. ✓
3. **Spec coverage:** §1 purpose → Task 18 success gate (corpus expectations proxy the precision/recall gate for automated regression; the real dogfood gate is manual, run by the user post-build). §2 scope → Tasks 1–19 cover in-scope items; deferred items absent. §3 data flow → Tasks 8→6→13→14→15. §4 schema + scrubbing + caps + git/walk safety → Tasks 2,3,5,6,7,8. §5 seven signals + scoring + areas + struggle record → Tasks 9,10,11,12,13. §6 CLI + `--json`/`--calibrate` → Tasks 15,16,17. §7 config → Task 2. §8 human output → Task 14/15. §9 fail-open + exit codes → Tasks 6,8,16,17. §10 testing → Tasks 18 (+unit tests throughout). §11 privacy → Tasks 3,15,17,18,19. §12 open questions → noted in Tasks 4,10,14 (heuristic priors, tunable). §13 deferred → none implemented. ✓
4. **Placeholder scan:** No "TBD"/"handle edge cases"/"similar to" — each test names scenario+expected result; each impl names behavior. ✓
5. **Type consistency:** `SignalValues`, `StruggleRecord`, `AreaRow`, `JsonOutput`, `Config`, `Warnings`, `ScoringMode` used consistently across tasks; `runScan`/`ScanOptions`/`ScanResult` defined in Task 16 and consumed by Task 17; `resolveToplevel`/`discoverTranscripts`/`streamSession`/`runDetector`/`aggregateAreas` signatures match across producer/consumer tasks. ✓

## TL;DR

Nineteen bite-sized TDD tasks build the detection slice bottom-up from a greenfield repo: scaffold → types/config → scrubber → correction detector → adapter parse/stream → sandboxed git + transcript walk → seven signals (split across two tasks) → percentile/bootstrap scorer → area localization → struggle records + detector → leaderboard → output formatters → pipeline → CLI (with egress guard) → labeled fixture corpus + snapshot + privacy/safety assertions → packaging/README. Every task is self-contained (exact types, signatures, data shapes, test scenarios, and expected results) and ends with a green test + commit. Pure logic is isolated from I/O so TDD applies throughout. No code lives in this plan — only design.
