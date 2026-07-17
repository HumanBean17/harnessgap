# Diagnoser (Slice 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in `scan --diagnose` that classifies each flagged area into a typed cause (`doc | config-doc | test-gap | refactor-flag | inherent-complexity | unclassified`) with a derived-only rationale, grounded by signal profile + doc-existence + a new opt-in evidence projection.

**Architecture:** A new pure `src/diagnoser/` stage runs after `runDetector`/`aggregateAreas` in `runScan`, only under `--diagnose`. It consumes flagged `StruggleRecord[]` (grouped by area) + a doc-existence repo-context read. A new `computeEvidence` projection (failed-exec cmd-class + edited-file type buckets) is computed in the detector alongside signals, populated only under the flag. Default output is byte-identical (Slice 1/2/3 invariant); no LLM, no network, no `git`, no raw prose.

**Tech Stack:** TypeScript (Node >= 22.12), vitest, commander, yaml. No new runtime deps.

## Global Constraints

(carried from the spec §9 + project contracts; every task's requirements include these)

- **Node >= 22.12**; `"type": "module"` (ESM) — use `.js` import specifiers in TS.
- **Runtime deps exactly `commander` + `yaml`.** No new deps. `test/packaging.test.ts` must stay green.
- **No network.** No `fetch`/`http`/`https`/`net`/`undici` imports and no `fetch()` calls in `src/`. `test/egress.test.ts` must stay green.
- **No `git` invocation.** Repo resolution stays stat-based; doc-existence uses local fs reads only, path-confined to the repo root.
- **No raw prose in any output path.** `Diagnosis.rationale` and every `evidence_refs` leaf are derived-only (signal values, integer counts, ratios, doc paths). Scrubbing/size caps reused upstream.
- **Byte-identical default.** `scan` without `--diagnose` produces output identical to Slice 3 (existing snapshot unchanged). The `evidence` field and `diagnoses` output exist only under `--diagnose`.
- **Config deep-merge over defaults; arrays replace; unknown top-level keys rejected** (now `docs_dirs` + `diagnose` accepted).
- **Fail-open.** A thrown classify step, missing `docs_dirs`, or unreadable doc path degrades that unit to `unclassified` / omits its diagnosis — never aborts the scan.
- **DRY, YAGNI, TDD, frequent commits.** One commit per task; each task leaves the tree green (`npm run typecheck && npm test`).

## File Structure

**New files (pure unless marked):**
- `src/diagnoser/classify-util.ts` — `classifyCmd`, `classifyFile` over fixed catalogs. Pure.
- `src/diagnoser/evidence.ts` — `computeEvidence(events, testCmdPatterns)`. Pure. (Lives under `diagnoser/` not `detector/` to keep the detector slice-agnostic; the detector *calls* it under the flag — see Task 5. If the implementer prefers `src/detector/evidence.ts`, that is acceptable as long as the export and call site match.)
- `src/diagnoser/profile.ts` — group flagged records by area → `UnitProfile[]`. Pure.
- `src/diagnoser/repo-context.ts` — `gatherRepoContext(unitKey, repoRoot, docsDirs)`. **I/O** (the only new I/O); path-confined, fail-open.
- `src/diagnoser/classify.ts` — `classify(profile, repoContext, cfg)`. Pure rule engine.
- `src/diagnoser/index.ts` — `diagnoseUnits(records, cfg, repoRoot)`. Thin orchestration.

**Modified files:**
- `src/types.ts` — new types; `StruggleRecord.evidence?`; `JsonOutput.diagnoses?`.
- `src/config.ts` — accept + validate `docs_dirs` + `diagnose`; defaults; deep-merge.
- `src/detector/index.ts` — `runDetector` gains an options arg to collect evidence; passes it to `assembleStruggleRecord`.
- `src/detector/record.ts` — `assembleStruggleRecord` gains optional `evidence?`.
- `src/pipeline.ts` — `ScanOptions.diagnose?`; `ScanResult.diagnoses?`; `runScan` threads the flag and calls `diagnoseUnits`.
- `src/cli.ts` — `--diagnose` flag on `scan`.
- `src/output/human.ts` — `cause` column when diagnoses present.
- `src/output/json.ts` — `diagnoses` field when diagnoses present.

**New/modified tests:** `test/classify-util.test.ts`, `test/evidence.test.ts`, `test/diagnose-profile.test.ts`, `test/repo-context.test.ts`, `test/classify.test.ts`, `test/diagnose.test.ts` (integration); extend `test/config.test.ts`, `test/output.test.ts`, `test/snapshot.test.ts`, `test/privacy.test.ts`, `test/pipeline.test.ts`, `test/cli.test.ts`.

---

## Shared contracts (defined in Task 1, referenced by all later tasks)

```ts
type Cause = 'doc' | 'config-doc' | 'test-gap' | 'refactor-flag' | 'inherent-complexity' | 'unclassified';
type CmdClass = 'config' | 'test' | 'build' | 'other';
type FileClass = 'test' | 'code' | 'other';

interface SessionEvidence {
  failures: { config: number; test: number; build: number; other: number }; // failed-exec counts by cmd-class
  edit_kinds: { test: number; code: number; other: number };                // edited-file counts by file-class
}

type EvidenceRef =
  | { kind: 'signal'; name: SignalName; value: number | boolean }
  | { kind: 'doc_absent'; checked: string[] }
  | { kind: 'doc_present'; path: string }
  | { kind: 'failure_profile'; config: number; test: number; build: number; other: number }
  | { kind: 'edit_profile'; test: number; code: number; other: number };

interface Diagnosis {
  unit: { kind: 'area'; key: string };
  cause: Cause;
  confidence: number;        // 0..1
  rationale: string;         // derived-only
  evidence_refs: EvidenceRef[];
}
```

**Elevation yardstick (mode-independent).** A signal is *elevated* for a unit when its median across the unit's flagged sessions meets the matching `cfg.detector.bootstrap_thresholds` entry: numbers `>=` the threshold; nullable `explore_ratio`/`wall_clock_per_line_ms` elevated only when the median is non-null and meets the threshold; boolean `abandonment` elevated when the strict-majority median is `true`. (Defaults: explore_ratio 10, reread 5, failure_streak 3, corrections 2, abandonment true, oscillation 2, wall_clock_per_line_ms 300000.)

---

### Task 1: Types + config foundation

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces: `Cause`, `CmdClass`, `FileClass`, `SessionEvidence`, `EvidenceRef`, `Diagnosis` types in `src/types.ts`; `StruggleRecord.evidence?: SessionEvidence`; `JsonOutput.diagnoses?: Diagnosis[]`. `Config` gains `docs_dirs: string[]` and `diagnose: { confidence_floor: number; config_share_floor: number; test_share_floor: number; code_share_floor: number; score_floor: number }`. `DEFAULT_CONFIG.docs_dirs = ['docs']`; `DEFAULT_CONFIG.diagnose = { confidence_floor: 0.5, config_share_floor: 0.5, test_share_floor: 0.5, code_share_floor: 0.5, score_floor: 70 }`.

- [ ] **Step 1: Write failing tests** — `test/config.test.ts`: (a) a `.harnessgap.yml` with `docs_dirs: [doc, docs/arch]` parses to those paths; (b) a `diagnose: { confidence_floor: 0.6 }` deep-merges over defaults (other diagnose keys remain at defaults); (c) default config (no file) has `docs_dirs == ['docs']` and `diagnose.confidence_floor == 0.5`; (d) an unknown top-level key (e.g. `synthesizer:`) is still rejected with `ConfigError`; (e) validation: a `diagnose.confidence_floor` of `1.5` throws `ConfigError` (must be in `[0,1]`), and a `diagnose.config_share_floor` of `-0.1` throws; `score_floor` of `200` throws (must be in `[0,100]`); the three share-floors must be in `[0,1]`.

- [ ] **Step 2: Run tests — FAIL** — `npm test -- config` → config tests fail (keys rejected / undefined).

- [ ] **Step 3: Implement** — Add the types to `src/types.ts`. In `src/config.ts`: extend the accepted schema and `DEFAULT_CONFIG` with `docs_dirs` + `diagnose`; deep-merge them like existing keys; add range validation for the five `diagnose` numbers (confidence_floor and the three share-floors in `[0,1]`; score_floor in `[0,100]`) throwing `ConfigError` on violation; keep rejecting all other unknown top-level keys.

- [ ] **Step 4: Run tests — PASS** — `npm test -- config` → all green. `npm run typecheck` → clean.

- [ ] **Step 5: Commit** — `git add src/types.ts src/config.ts test/config.test.ts && git commit -m "feat(diagnoser): types + docs_dirs/diagnose config"`

---

### Task 2: `classify-util.ts` — cmd-class and file-class classifiers

**Files:**
- Create: `src/diagnoser/classify-util.ts`
- Test: `test/classify-util.test.ts`

**Interfaces:**
- Produces: `classifyCmd(cmd: string, testCmdPatterns: string[]): CmdClass` and `classifyFile(path: string): FileClass`. Both pure.
  - `classifyCmd` precedence: **test > config > build > other**. `test` = `cmd` contains any `testCmdPatterns` substring (reuses `cfg.areas.test_cmd_patterns`). `config` = `cmd` contains one of: `install`, `migrate`, `seed`, `db:`, `docker compose`, `docker-compose`, `psql`, `mysql`, `createdb`, `alembic`, `prisma`, `setup`, `configure`, `:env`, `env `, `dotenv`. `build` = `cmd` contains one of: `tsc`, `webpack`, `esbuild`, `vite build`, `rollup`, `cargo build`, `go build`, `npm run build`, `yarn build`, `pnpm build`, `mvn`, `gradle`, `make build`. Empty/whitespace `cmd` → `other`.
  - `classifyFile` precedence: **test > other > code**. `test` = path matches a test-file shape: contains `.test.`, `.spec.`, `_test.`, `test_`, `__tests__`, `.tests.`, or has a path segment `test`/`tests`/`__tests__`. `other` = config/doc/lockfile: extension in `.json .yml .yaml .toml .env .lock .md .txt .rst .ini .conf .cfg`, or basename in `Dockerfile`, `Makefile`, `package.json`, `package-lock.json`, `.env`, `.gitignore`. Otherwise → `code`.

- [ ] **Step 1: Write failing tests** — `test/classify-util.test.ts`: `classifyCmd('npm test', [...defaults])` → `test`; `classifyCmd('npm install', _)` → `config`; `classifyCmd('npm run build', _)` → `build`; `classifyCmd('grep foo', _)` → `other`; `classifyCmd('', _)` → `other`; precedence `classifyCmd('npm run build', _with 'build' in testCmdPatterns_)` → `test` (test wins over build). `classifyFile('src/billing/charge.test.ts')` → `test`; `classifyFile('src/billing/charge.ts')` → `code`; `classifyFile('package.json')` → `other`; `classifyFile('config/app.yml')` → `other`; `classifyFile('README.md')` → `other`; precedence `classifyFile('foo.test.json')` → `test` (test wins over other).

- [ ] **Step 2: Run tests — FAIL** — `npm test -- classify-util` → module not found.

- [ ] **Step 3: Implement** — `src/diagnoser/classify-util.ts`: implement the two pure classifiers with the catalogs and precedence above. Export `CmdClass`, `FileClass` (re-exported from `types.ts`).

- [ ] **Step 4: Run tests — PASS** — `npm test -- classify-util` → green. `npm run typecheck` → clean.

- [ ] **Step 5: Commit** — `git add src/diagnoser/classify-util.ts test/classify-util.test.ts && git commit -m "feat(diagnoser): cmd/file classifier utilities"`

---

### Task 3: `computeEvidence` — the opt-in evidence projection

**Files:**
- Create: `src/diagnoser/evidence.ts`
- Test: `test/evidence.test.ts`

**Interfaces:**
- Consumes: `NormalizedEvent[]`, `testCmdPatterns: string[]` (from `cfg.areas.test_cmd_patterns`); `classifyCmd`/`classifyFile` from Task 2.
- Produces: `computeEvidence(events: NormalizedEvent[], testCmdPatterns: string[]): SessionEvidence`. Pure. Iteration rules: a `tool_call` with `tool === 'exec' && ok === false` → `failures[classifyCmd(cmd, testCmdPatterns)]++` (skip if `cmd` null). A `tool_call` with `tool === 'edit'` → for each file in `input_digest.files`, `edit_kinds[classifyFile(file)]++`. All other events contribute nothing. Returns integer bucket counts (zero-filled).

- [ ] **Step 1: Write failing tests** — `test/evidence.test.ts`: (a) two failed execs (`npm test` fail, `npm install` fail) + one successful exec → `failures == { config:1, test:1, build:0, other:0 }`; (b) one edit touching `a.ts` (code) and `b.test.ts` (test) → `edit_kinds == { test:1, code:1, other:0 }`; (c) a `read`/`search` event contributes nothing; (d) a failed exec with `cmd === null` is skipped (counted nowhere); (e) empty events → all buckets `0`.

- [ ] **Step 2: Run tests — FAIL** — `npm test -- evidence` → module not found.

- [ ] **Step 3: Implement** — `src/diagnoser/evidence.ts`: `computeEvidence` per the rules above; zero-fill all seven buckets.

- [ ] **Step 4: Run tests — PASS** — `npm test -- evidence` → green. `npm run typecheck` → clean.

- [ ] **Step 5: Commit** — `git add src/diagnoser/evidence.ts test/evidence.test.ts && git commit -m "feat(diagnoser): computeEvidence projection"`

---

### Task 4: Thread evidence through the detector (opt-in, byte-identical default)

**Files:**
- Modify: `src/detector/record.ts`
- Modify: `src/detector/index.ts`
- Test: `test/pipeline.test.ts` (extend) — or a focused `test/detector-evidence.test.ts`

**Interfaces:**
- Consumes: `computeEvidence` (Task 3), `assembleStruggleRecord`/`runDetector` (existing).
- Produces: `assembleStruggleRecord(envelope, signals, score, areas, evidence?: SessionEvidence)` — when `evidence` provided, the returned `StruggleRecord.evidence` is set; when omitted, the field is **unset** (so JSON omits it). `runDetector(envelopes, cfg, forceBootstrap, opts?: { collectEvidence?: boolean })` — when `opts?.collectEvidence` is true, compute `computeEvidence(env.events, cfg.areas.test_cmd_patterns)` per envelope and pass it to `assembleStruggleRecord`; when false/absent, omit it. Existing 3-arg callers (`runScan`, `runReflect`) unchanged in behavior (default `collectEvidence: false`).

- [ ] **Step 1: Write failing tests** — (a) `assembleStruggleRecord(..., evidence)` yields a record whose `evidence` equals the passed object; `assembleStruggleRecord(... )` (no evidence) yields a record with `evidence` undefined and whose `JSON.stringify` output contains no `"evidence"` key. (b) `runDetector([env], cfg, false, { collectEvidence: true })` returns a record with `.evidence` populated; `runDetector([env], cfg, false)` (no opts) returns a record with `.evidence` undefined. (c) The default-path record serializes byte-identically to the pre-change shape (assert `evidence` absent from `JSON.stringify(record)`).

- [ ] **Step 2: Run tests — FAIL** — new behavior absent.

- [ ] **Step 3: Implement** — add the optional `evidence?` param to `assembleStruggleRecord` (set on the returned object only when defined). Add `opts?: { collectEvidence?: boolean }` to `runDetector`; in the per-envelope map, compute and pass `evidence` only when `collectEvidence` is true. Do not change `runReflect`'s call (it stays 3-arg → no evidence → byte-identical reflect output).

- [ ] **Step 4: Run tests — PASS** — `npm test` → green (existing detector tests unaffected). `npm run typecheck` → clean.

- [ ] **Step 5: Commit** — `git add src/detector/record.ts src/detector/index.ts test/ && git commit -m "feat(diagnoser): opt-in evidence collection in runDetector"`

---

### Task 5: `profile.ts` — per-unit signal profile + evidence sums

**Files:**
- Create: `src/diagnoser/profile.ts`
- Test: `test/diagnose-profile.test.ts`

**Interfaces:**
- Consumes: `StruggleRecord[]` (only flagged records are profiled), `Config`.
- Produces: `interface UnitProfile { key: string; flaggedCount: number; meanScore: number; medians: Record<SignalName, number | boolean | null>; elevated: Record<SignalName, boolean>; evidence: SessionEvidence }`. `buildProfiles(records: StruggleRecord[], cfg: Config): UnitProfile[]`. Pure. Behavior: group records by each `area.key` they touch (a record touching 2 areas contributes to both); per group, `flaggedCount` = count of flagged records, `meanScore` = mean of their `score_pct`; `medians[signal]` = median across the group's flagged records (nullable signals median over non-null values, `null` if all null; `abandonment` uses strict-majority). `evidence` = element-wise sum of each record's `evidence` buckets (treat missing `evidence` as zero buckets). `elevated[signal]` per the Shared Contracts yardstick vs `cfg.detector.bootstrap_thresholds`. Result sorted by `key` ascending (deterministic).

- [ ] **Step 1: Write failing tests** — (a) two flagged records touching `src/billing`, with reread `[5,7]` → `medians.reread == 6`, `elevated.reread === true` (>=5); one with reread `[2]` alone → median `2`, `elevated.reread === false`. (b) nullable `explore_ratio` `[null, 12, null]` → median `12` (non-null only), elevated true (>=10); all-null `[null,null]` → median `null`, elevated false. (c) `abandonment` `[true,true,false]` → median true (majority), elevated true; `[true,false,false]` → false. (d) evidence sums: two records with `failures.config` 2 and 3 → summed `failures.config == 5`. (e) a record touching two areas appears in both profiles. (f) output sorted by key ascending.

- [ ] **Step 2: Run tests — FAIL** — module not found.

- [ ] **Step 3: Implement** — `src/diagnoser/profile.ts`: grouping, median/elevation, evidence sum, sort. No I/O.

- [ ] **Step 4: Run tests — PASS** — `npm test -- diagnose-profile` → green. `npm run typecheck` → clean.

- [ ] **Step 5: Commit** — `git add src/diagnoser/profile.ts test/diagnose-profile.test.ts && git commit -m "feat(diagnoser): per-unit signal profile + evidence aggregation"`

---

### Task 6: `repo-context.ts` — doc-existence (the only new I/O)

**Files:**
- Create: `src/diagnoser/repo-context.ts`
- Test: `test/repo-context.test.ts`

**Interfaces:**
- Produces: `interface RepoContext { docExists: boolean; matchedPath: string | null; checked: string[] }`. `gatherRepoContext(unitKey: string, repoRoot: string, docsDirs: string[]): RepoContext`. Behavior: the unit's **leaf token** = the last `/`-separated segment of `unitKey` (e.g. `src/billing` → `billing`). For each `docsDir`, resolve `<repoRoot>/<docsDir>`; **path-confine** — reject (skip) any resolved path that escapes `repoRoot` (contains `..` traversal beyond root) and do not follow symlinks (use `Dirent`/`lstat`, mirroring `src/walk.ts`). Recursively list files under each confined dir; a doc **matches** if any file's path has the leaf token as a path segment or as a substring of its filename stem. On first match → `{ docExists: true, matchedPath: <repo-relative matched path>, checked: <all dirs actually searched> }`. On no match → `{ docExists: false, matchedPath: null, checked: <searched dirs> }`. **Fail-open:** a missing/unreadable dir or any thrown error → treated as "searched, no match" for that dir (never throws); it still appears in `checked`.

- [ ] **Step 1: Write failing tests** — use `mkdtempSync` to make a tmp repo: (a) `docs/architecture/billing.md` exists → `gatherRepoContext('src/billing', tmp, ['docs']).docExists === true` and `matchedPath` endswith `billing.md`; (b) no matching doc → `docExists === false`, `matchedPath === null`, `checked` includes `docs`; (c) `docs` dir missing entirely → no throw, `docExists === false`, `checked` includes `docs`; (d) a symlinked doc file is **not** followed (treated as no match); (e) path-confinement: a `docsDir` of `../escape` is rejected (not searched past root) and produces no match without throwing; (f) leaf-token substring: `docs/notes/billing-overview.md` matches unit `src/billing`.

- [ ] **Step 2: Run tests — FAIL** — module not found.

- [ ] **Step 3: Implement** — `src/diagnoser/repo-context.ts`: confined, no-symlink recursive listing; token match; fail-open. Only `node:fs` + `node:path`.

- [ ] **Step 4: Run tests — PASS** — `npm test -- repo-context` → green. `npm run typecheck` → clean. `npm test -- egress` → still green (no network imports).

- [ ] **Step 5: Commit** — `git add src/diagnoser/repo-context.ts test/repo-context.test.ts && git commit -m "feat(diagnoser): doc-existence repo context (path-confined, fail-open)"`

---

### Task 7: `classify.ts` — the pure rule engine

**Files:**
- Create: `src/diagnoser/classify.ts`
- Test: `test/classify.test.ts`

**Interfaces:**
- Consumes: `UnitProfile` (Task 5), `RepoContext` (Task 6), `Config`.
- Produces: `classify(profile, repoContext, cfg): Diagnosis`. Pure. Selection (deterministic):

  **Specific causes — gating conditions (each must hold for the cause to be eligible):**
  - `doc`: `elevated.explore_ratio && elevated.reread && !repoContext.docExists`.
  - `config-doc`: `elevated.failure_streak && totalFailures > 0 && (failures.config / totalFailures) >= cfg.diagnose.config_share_floor` where `totalFailures = failures.config+test+build+other`.
  - `test-gap`: `elevated.oscillation && elevated.failure_streak && totalEdits > 0 && (edit_kinds.test / totalEdits) >= cfg.diagnose.test_share_floor && !elevated.corrections` where `totalEdits = edit_kinds.test+code+other`.
  - `refactor-flag`: `elevated.oscillation && elevated.corrections && totalEdits > 0 && (edit_kinds.code / totalEdits) >= cfg.diagnose.code_share_floor`.

  **Score & selection:** each eligible specific cause gets a score in `[0,1]` proportional to how many of its signature signals are elevated (and, for refactor-flag, boosted when `repoContext.docExists`). Pick the highest score; **ties broken by fixed precedence `doc > config-doc > test-gap > refactor-flag`**. If the winner's score `>= cfg.diagnose.confidence_floor` → that cause. Else if `elevated.wall_clock_per_line && profile.meanScore >= cfg.diagnose.score_floor` → `inherent-complexity`. Else → `unclassified`.

  `confidence` = the winner's score for a specific cause; for `inherent-complexity` a value proportional to expense clamped to `[0,1]`; for `unclassified`, `0`. `rationale` is one derived-only line naming the deciding signals/values and the grounding fact (e.g. `"explore_ratio(11.2) elevated + reread(6) elevated; no doc under docs/"`, `"oscillation(4) + corrections(3); code-share 0.82; doc exists"`). `evidence_refs` lists the elevated signals (as `{kind:'signal',...}`), the failure/edit profile when used, and `{kind:'doc_absent'|'doc_present', ...}`.

- [ ] **Step 1: Write failing tests** — construct `UnitProfile`/`RepoContext` directly: (a) explore+reread elevated, no doc → `cause == 'doc'`, `confidence >= 0.5`, rationale mentions doc absence, an `evidence_refs` entry has `kind:'doc_absent'`. (b) Same profile but `docExists:true` → `doc` **not** selected (gated off); with oscillation+corrections+code-share eligible → `refactor-flag`. (c) failure_streak elevated, failures `{config:4,test:1,build:0,other:1}` (config-share 0.66 ≥ 0.5) → `config-doc`. (d) oscillation+failure_streak elevated, edits `{test:6,code:2,other:0}` (test-share 0.75), corrections not elevated → `test-gap`. (e) wall_clock elevated, meanScore 80, no specific cause eligible → `inherent-complexity`. (f) nothing elevated but flagged → `unclassified`, confidence 0. (g) tie-break: a profile eligible for both `doc` and `refactor-flag` with equal score → `doc`. (h) confidence floor: a specific cause scoring `0.4` (< default 0.5) with no expense → `unclassified` (not the weak specific cause).

- [ ] **Step 2: Run tests — FAIL** — module not found.

- [ ] **Step 3: Implement** — `src/diagnoser/classify.ts`: gating + scoring + selection per above; build `rationale`/`evidence_refs` from derived values only. No prose from records.

- [ ] **Step 4: Run tests — PASS** — `npm test -- classify` → green. `npm run typecheck` → clean.

- [ ] **Step 5: Commit** — `git add src/diagnoser/classify.ts test/classify.test.ts && git commit -m "feat(diagnoser): pure cause-classification rule engine"`

---

### Task 8: `index.ts` — orchestration

**Files:**
- Create: `src/diagnoser/index.ts`
- Test: `test/diagnose.test.ts`

**Interfaces:**
- Consumes: `buildProfiles`, `gatherRepoContext`, `classify`.
- Produces: `diagnoseUnits(records: StruggleRecord[], cfg: Config, repoRoot: string): Diagnosis[]`. Behavior: take **flagged** records only; `buildProfiles` → for each `UnitProfile`, `gatherRepoContext(profile.key, repoRoot, cfg.docs_dirs)` → `classify(profile, ctx, cfg)`; collect `Diagnosis[]` sorted by `profile.key` ascending. **Fail-open:** if `gatherRepoContext` or `classify` throws for a unit, that unit becomes `{ unit:{kind:'area',key}, cause:'unclassified', confidence:0, rationale:'diagnosis unavailable', evidence_refs:[] }` and processing continues (never aborts). Empty flagged set → `[]`.

- [ ] **Step 1: Write failing tests** — `test/diagnose.test.ts` with a tmp repo + docs dir: (a) a flagged record (doc-shaped, no doc present) → one `Diagnosis` with `cause:'doc'`; (b) with a matching doc created → `cause:'refactor-flag'` when oscillation/corrections/code-share hold; (c) unflagged records produce no diagnoses; (d) two flagged areas → two diagnoses sorted by key; (e) fail-open: monkeypatch/stub a throwing `classify` path is not required — instead assert that a unit whose `docsDirs` points at an unreadable path still yields a `Diagnosis` (cause `unclassified` or `doc` depending on fail-open), not a throw.

- [ ] **Step 2: Run tests — FAIL** — module not found.

- [ ] **Step 3: Implement** — `src/diagnoser/index.ts`: the orchestration + try/catch fail-open per unit.

- [ ] **Step 4: Run tests — PASS** — `npm test -- diagnose` → green. `npm run typecheck` → clean.

- [ ] **Step 5: Commit** — `git add src/diagnoser/index.ts test/diagnose.test.ts && git commit -m "feat(diagnoser): diagnoseUnits orchestration with fail-open"`

---

### Task 9: Wire `--diagnose` through `runScan`

**Files:**
- Modify: `src/pipeline.ts` (lines ~55-76, ~178-181)
- Test: `test/pipeline.test.ts` (extend)

**Interfaces:**
- Produces: `ScanOptions.diagnose?: boolean`; `ScanResult.diagnoses?: Diagnosis[]`. In `runScan`: pass `{ collectEvidence: opts.diagnose === true }` to `runDetector`; after `aggregateAreas`, when `opts.diagnose`, call `diagnoseUnits(records, cfg, outputRepo)` and set `result.diagnoses` (empty array is fine when none flagged); when not `opts.diagnose`, `diagnoses` is **unset** and the output string is byte-identical to Slice 3. `outputRepo` = the filtered repo root already resolved in `runScan` (the existing `--repo` resolution); if empty/unresolved, skip diagnosis (set `diagnoses: []`).

- [ ] **Step 1: Write failing tests** — `test/pipeline.test.ts`: (a) `runScan({ ..., diagnose: true })` over the corpus returns `result.diagnoses` as an array (possibly empty) and each item matches `Diagnosis` shape; (b) `runScan({ ... })` (no diagnose) returns a result with `diagnoses === undefined` AND `result.output` string equals the Slice-3 output exactly (byte-identical); (c) the records in the diagnose run carry `.evidence` only when diagnose is true.

- [ ] **Step 2: Run tests — FAIL** — `diagnose` option / `diagnoses` field absent.

- [ ] **Step 3: Implement** — thread `diagnose` through `ScanOptions`/`ScanResult`/`runScan`; call `diagnoseUnits`; leave the non-diagnose path untouched (same branches, same output string).

- [ ] **Step 4: Run tests — PASS** — `npm test -- pipeline` → green. `npm run typecheck` → clean.

- [ ] **Step 5: Commit** — `git add src/pipeline.ts test/pipeline.test.ts && git commit -m "feat(diagnoser): wire --diagnose through runScan (byte-identical default)"`

---

### Task 10: CLI `--diagnose` flag

**Files:**
- Modify: `src/cli.ts`
- Test: `test/cli.test.ts` (extend)

**Interfaces:**
- Produces: a `--diagnose` boolean flag on the `scan` command that sets `ScanOptions.diagnose`. Help text: `"Classify each flagged area into a typed cause (doc/config-doc/test-gap/refactor-flag/inherent-complexity). Reads docs/ for grounding."`

- [ ] **Step 1: Write failing tests** — `test/cli.test.ts`: (a) `scan --diagnose --json` over the corpus parses and the JSON envelope contains a `diagnoses` key; (b) `scan --json` (no diagnose) JSON envelope has **no** `diagnoses` key; (c) `scan --help` lists `--diagnose`.

- [ ] **Step 2: Run tests — FAIL** — unknown flag / no diagnoses key.

- [ ] **Step 3: Implement** — add the `--diagnose` option in `src/cli.ts` `scan` command; pass through to `runScan`.

- [ ] **Step 4: Run tests — PASS** — `npm test -- cli` → green. `npm run typecheck` → clean.

- [ ] **Step 5: Commit** — `git add src/cli.ts test/cli.test.ts && git commit -m "feat(diagnoser): scan --diagnose CLI flag"`

---

### Task 11: Output — `cause` column + `diagnoses` JSON field

**Files:**
- Modify: `src/output/human.ts`
- Modify: `src/output/json.ts`
- Test: `test/output.test.ts` (extend)

**Interfaces:**
- Produces: `formatHuman` accepts the optional `diagnoses: Diagnosis[]` (or the rows are annotated) and, when present, renders a `cause` cell on each flagged area row as `cause(confidence)` (e.g. `doc(0.78)`; `unclassified` rendered as `-`). `buildJsonEnvelope` includes `diagnoses` in the envelope **only when** the passed-in value is non-empty/defined (absent otherwise → default `--json` byte-identical). Match the cause to a row by `unit.key == row.key`; a flagged row with no matching diagnosis shows `-`.

- [ ] **Step 1: Write failing tests** — `test/output.test.ts`: (a) human table with one diagnosis `doc(0.78)` for `src/billing` → table contains `doc(0.78)` on that row; (b) a flagged row with no diagnosis → `-`; (c) JSON envelope with diagnoses → contains `diagnoses[0].cause == 'doc'`; (d) JSON envelope built with no diagnoses → **no** `diagnoses` key in output (byte-identical default).

- [ ] **Step 2: Run tests — FAIL** — new rendering/field absent.

- [ ] **Step 3: Implement** — extend `formatHuman` (cause column) and `buildJsonEnvelope` (conditional `diagnoses`). Keep default path (no diagnoses) byte-identical.

- [ ] **Step 4: Run tests — PASS** — `npm test -- output` → green. `npm run typecheck` → clean.

- [ ] **Step 5: Commit** — `git add src/output/human.ts src/output/json.ts test/output.test.ts && git commit -m "feat(diagnoser): cause column + diagnoses JSON field (opt-in)"`

---

### Task 12: Snapshot + privacy guards

**Files:**
- Modify: `test/snapshot.test.ts`
- Modify: `test/privacy.test.ts`

**Interfaces:**
- Produces: (a) the **existing** snapshot (default `scan`) is asserted unchanged — the byte-identical invariant. (b) A **second** snapshot locks the `scan --diagnose` human table (including the cause column). (c) A privacy case: seed a prose marker in a user-message/cmd/file field through the pipeline; assert the marker is absent from every `Diagnosis` leaf (rationale + every `evidence_refs` member), and every leaf is a primitive/enum/closed-union value.

- [ ] **Step 1: Write failing tests** — (a) extend `snapshot.test.ts` to assert the default snapshot file is byte-identical to the committed one (it already is; this step adds the `--diagnose` snapshot and a guard that the default did not change). (b) Add the privacy assertion in `privacy.test.ts`.

- [ ] **Step 2: Run tests — FAIL** — new `--diagnose` snapshot absent / privacy case fails until wired.

- [ ] **Step 3: Implement** — add the `--diagnose` snapshot (vitest writes it on first run); confirm the default snapshot is unchanged; make the privacy test pass (it should, given the Diagnoser emits derived-only values — if it fails, that is a real prose-leak bug to fix in `classify.ts`).

- [ ] **Step 4: Run tests — PASS** — `npm test -- snapshot privacy` → green. `npm run typecheck` → clean.

- [ ] **Step 5: Commit** — `git add test/snapshot.test.ts test/__snapshots__/ test/privacy.test.ts && git commit -m "test(diagnoser): byte-identical default snapshot + --diagnose snapshot + privacy"`

---

### Task 13: Docs

**Files:**
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/CONSUMER_GUIDE.md`

**Interfaces:**
- Produces: README — add `--diagnose` to the flags table and a short "Diagnoser" subsection (5 causes + grounding + opt-in + byte-identical default + the deferred list). ARCHITECTURE — add the `src/diagnoser/*` modules to the module map (§2), add `SessionEvidence`/`Diagnosis` to the type list, add a numbered Diagnoser section describing the pipeline seam + the opt-in projection + fail-open + privacy. CONSUMER_GUIDE — a "Diagnoser" entry: what the causes mean, how to read the column, the `docs_dirs`/`diagnose` config, the honest caveats (fuzzy doc-match, session→area attribution, no git churn, calibration is dogfood).

- [ ] **Step 1: Write the doc changes** — describe behavior and contracts only; no invented APIs. Keep the existing tone/structure.

- [ ] **Step 2: Verify** — `npm test` (docs sometimes asserted by tests; packaging test unaffected). `npm run typecheck`.

- [ ] **Step 3: Commit** — `git add README.md docs/ARCHITECTURE.md docs/CONSUMER_GUIDE.md && git commit -m "docs(diagnoser): flag, causes, config, caveats"`

---

### Task 14: Full-suite green + final verification

**Files:** none (verification only).

- [ ] **Step 1:** `npm run typecheck` → clean.
- [ ] **Step 2:** `npm test` → all green (existing 285 + new tests; corpus ≥80% bar unaffected; egress/packaging/privacy green).
- [ ] **Step 3:** `npm run build` → clean.
- [ ] **Step 4:** Manual spot-check — `node dist/cli.js scan --diagnose --limit 5 --json` over a real `~/.claude/projects` (if available) shows `diagnoses`; without `--diagnose` the output is unchanged. (Skip if no local transcripts; the snapshot covers the deterministic case.)
- [ ] **Step 5:** No commit (verification only) — unless docs-watcher or review surfaces changes.

---

## Self-Review (completed during authoring)

- **Code scan:** no method bodies / algorithms / test code — every step states behavior + expected results + signatures only. ✓
- **Self-containment:** every task lists Consumes/Produces with exact signatures/types/shapes; the Shared Contracts block is referenced, not "see spec." ✓
- **Spec coverage:** types (T1), config (T1), classifiers (T2), evidence (T3,T4), profile (T5), repo-context (T6), classify (T7), orchestration (T8), pipeline (T9), cli (T10), output (T11), byte-identical+privacy (T12), docs (T13), verify (T14) — covers spec §4–§10. Calibration is issue #15 (dogfood), out of code scope. ✓
- **Placeholder scan:** no TBD/TODO; every gate and expected result is concrete. ✓
- **Type consistency:** `SessionEvidence`/`Diagnosis`/`EvidenceRef`/`UnitProfile`/`RepoContext` names match across tasks; `classifyCmd`/`classifyFile`/`computeEvidence`/`buildProfiles`/`gatherRepoContext`/`classify`/`diagnoseUnits` signatures consistent. `runDetector`/`assembleStruggleRecord`/`ScanOptions`/`ScanResult` extensions match existing signatures read from source. ✓
