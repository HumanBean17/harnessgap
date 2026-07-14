# Behavioral Baseline / Orientation Detection (Slice 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a behavioral repo-level "elevated-baseline" finding that detects diffuse orientation overhead the seven acute signals cannot see, without changing Slice 1's per-session/per-area output.

**Architecture:** Purely additive. A new pre-edit orientation metric (dir breadth + file depth, counted only before the first edit, null for zero-edit sessions) and an always-computed bootstrap trip feed a new pure `assessAmbient` function that emits a `RepoFinding` (0-or-1) plus an always-present `BaselineAssessment`. `StruggleRecord`, `flagged`, the scorer's existing fields, and the area aggregator are untouched; the finding threads through the detector → pipeline → output formatters.

**Tech Stack:** Node ≥ 22.12, TypeScript (ESM, `.js` import specifiers), vitest, commander, yaml. No new dependencies.

## Global Constraints

Copied verbatim from the spec; every task's requirements include these:

- Runtime dependencies stay exactly `commander` + `yaml`. Add no dependencies. Locked by `test/packaging.test.ts`.
- No network: no `fetch`/`http`/`https`/`net`/`undici` imports and no `fetch()` calls anywhere in `src/`. Locked by `test/egress.test.ts` (auto-scans every `src/**/*.ts`, so new files are covered).
- No disk writes. The slice is pure computation over already-streamed events/signals. No new I/O.
- No raw prose in any output path: only numbers, closed enums, and fixed literals. New surfaces (`RepoFinding`, baseline block, calibrate assessment) must be prose-free — locked by new tests in Task 9.
- `StruggleRecord`, `SessionScore`'s existing fields (`score_pct`, `mode`, `flagged`, `composite`), and `aggregateAreas` must stay unchanged. Slice 1's corpus ≥80% bar and leaderboard snapshot must still pass unmodified — locked by Task 11.
- TDD: write the failing test first, watch it fail, implement, watch it pass, commit. Frequent commits with conventional-commit messages.
- ESM imports use the `.js` extension (e.g. `from '../types.js'`), matching every existing file.
- Today's date for any new doc/commit referencing a date is 2026-07-15.

## File Structure

**Create:**
- `src/detector/orientation.ts` — pure `computePreEditOrientation(events)` (Task 2).
- `src/detector/ambient.ts` — pure `assessAmbient(...)` (Task 4).
- `test/orientation.test.ts`, `test/ambient.test.ts` — unit tests.
- `test/fixtures/baseline/sessions.ts` — calibration-gate fixtures (Task 10).

**Modify:**
- `src/types.ts` — add `Severity`, `BaselinePath`, `BaselineAssessment`, `RepoFinding`; extend `JsonOutput`, `Config` (Task 1).
- `src/config.ts` — `DEFAULT_CONFIG.detector.ambient` + validation (Task 1).
- `src/detector/scoring.ts` — extend `SessionScore` with always-computed bootstrap trip (Task 3).
- `src/detector/index.ts` — `runDetector` returns `{ records, finding, baseline }` (Task 5).
- `src/pipeline.ts` — thread finding/baseline to output; extend `ScanResult` (Task 5).
- `src/output/json.ts` — `repo_findings` in the envelope (Task 6).
- `src/output/human.ts` — always-printed baseline line + finding block (Task 7).
- `src/output/calibrate.ts` — baseline assessment line (Task 8).
- `test/config.test.ts`, `test/scoring.test.ts`, `test/output.test.ts`, `test/pipeline.test.ts` — extend (Tasks 1, 3, 6, 5).
- `test/privacy.test.ts` — new-surface prose-leak assertions (Task 9).

---

### Task 1: Foundation types + ambient config

**Files:**
- Modify: `src/types.ts` (after `SignalName`/`ScoringMode`, and the `JsonOutput`, `Config` interfaces).
- Modify: `src/config.ts` (`DEFAULT_CONFIG`, `validateConfig`).
- Modify: `test/config.test.ts` (add ambient validation cases).

**Interfaces:**

This task defines types consumed by every later task. Add to `src/types.ts`:

- `export type Severity = 'high' | 'medium' | 'low' | 'unrated';`
- `export type BaselinePath = 'orientation' | 'acute';`
- `export type BaselineState = 'elevated' | 'within-norms' | 'too-few-sessions' | 'orientation-undefined';`
- `BaselineAssessment` interface with fields: `state: BaselineState`; `sessions_sampled: number`; `scoring_mode: ScoringMode`; `orientation: { median_dir_breadth: number; median_file_depth: number; breadth_floor: number; file_depth_floor: number; with_edit_sessions: number } | null`; `zero_edit_fraction: number`; `acute: { struggle_rate: number; struggle_rate_threshold: number };`
- `RepoFinding` interface (this is the §7.1 contract, verbatim field names): `kind: 'elevated-baseline'`; `severity: Severity`; `paths: BaselinePath[]`; `sessions_sampled: number`; `scoring_mode: ScoringMode`; `orientation: { median_dir_breadth: number; median_file_depth: number; breadth_floor: number; file_depth_floor: number; with_edit_sessions: number } | null`; `zero_edit_fraction: number`; `acute: { struggle_rate: number; struggle_rate_threshold: number };`
- Extend `JsonOutput`: add `repo_findings: RepoFinding[];`
- Extend `Config['detector']`: add `ambient: { breadth_floor: number; file_depth_floor: number; struggle_rate_threshold: number; min_sessions: number; severity_min_sessions: number };`

`DEFAULT_CONFIG.detector.ambient` (in `src/config.ts`) verbatim:
`{ breadth_floor: 4, file_depth_floor: 12, struggle_rate_threshold: 0.30, min_sessions: 10, severity_min_sessions: 20 }`.

Validation rules added to `validateConfig` (throw `ConfigError` with the field path and bad value, matching the existing message style):
- `breadth_floor >= 1`
- `file_depth_floor >= 1`
- `struggle_rate_threshold` in `[0, 1]`
- `min_sessions >= 1`
- `severity_min_sessions >= min_sessions`

- [ ] **Step 1: Write failing tests in `test/config.test.ts`**

Add a `describe('detector.ambient validation')` block. Cases (each constructs a config via the existing `cfgWith`-style helper or by deep-cloning `DEFAULT_CONFIG` and mutating `detector.ambient`, then calls `loadConfig` with a written YAML file OR calls `validateConfig` directly if exported — note `validateConfig` is currently not exported; if the test drives through `loadConfig`, write a temp `.harnessgap.yml`). Expected results:
- Default config: `DEFAULT_CONFIG.detector.ambient` equals the verbatim object above.
- `struggle_rate_threshold: 1.5` → throws `ConfigError` whose message names `detector.ambient.struggle_rate_threshold`.
- `breadth_floor: 0` → throws.
- `min_sessions: 0` → throws.
- `severity_min_sessions: 5` (less than default `min_sessions: 10`) → throws.
- A valid override `breadth_floor: 8` deep-merges and loads without error, and the loaded `ambient.breadth_floor === 8`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL (TypeScript compile error: `Config['detector']` has no `ambient`; or runtime: defaults missing).

- [ ] **Step 3: Implement types + defaults + validation**

Add the types to `src/types.ts`, the `ambient` block to `DEFAULT_CONFIG`, and the five range checks to `validateConfig` in `src/config.ts`. Match the existing throw-message style (`detector.ambient.<field> must be ..., got <value>`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add src/types.ts src/config.ts test/config.test.ts`
Run: `git commit -m "feat(config): add detector.ambient block with defaults and validation"`

---

### Task 2: Pre-edit orientation metric

**Files:**
- Create: `src/detector/orientation.ts`
- Create: `test/orientation.test.ts`

**Interfaces:**
- Consumes: `NormalizedEvent` from `../types.js` (fields used: `kind`, `tool`, `input_digest.files`). A `NormalizedEvent` with `kind === 'tool_call'` and `tool === 'edit'` is an edit; `tool === 'read'` is a read.
- Produces:
  - `export interface PreEditOrientation { dirBreadth: number; fileDepth: number; }`
  - `export function computePreEditOrientation(events: NormalizedEvent[]): PreEditOrientation | null`
  - Returns `null` when the session has **no edit event at all** (zero-edit / Q&A session → metric undefined).
  - Otherwise returns `{ dirBreadth, fileDepth }` (both possibly 0).

**Definitions (the contract the implementer codes to):**
- `firstEditIdx` = the smallest index `i` where `events[i].kind === 'tool_call' && events[i].tool === 'edit'`. If none exists, return `null`.
- `readFiles` = the multiset (collect with duplicates, then dedupe) of every string in `events[i].input_digest.files` for each `i < firstEditIdx` where `events[i].kind === 'tool_call' && events[i].tool === 'read'`.
- `fileDepth` = count of **distinct** strings in `readFiles`.
- Depth-2 directory prefix of a path `p`: split `p` on `'/'`; if ≥2 segments, the prefix is `segments[0] + '/' + segments[1]`; if exactly 1 segment, the prefix is that segment; if empty, it has no prefix (skip it). `dirBreadth` = count of **distinct** non-empty depth-2 prefixes over `readFiles`.

- [ ] **Step 1: Write failing tests in `test/orientation.test.ts`**

Cases with hand-built `NormalizedEvent[]` (each event needs at minimum `kind`, `tool`, `input_digest: {files, cmd, query, lines_changed}`, `ok`, `interrupted`, `duration_ms`, `t`, `correction` — construct via a small local helper that fills defaults). Expected results:
- Session: read `src/a/x.ts`, `src/a/y.ts`, `src/b/z.ts`, then edit `src/a/x.ts` → `firstEditIdx` after the 3 reads; `fileDepth === 3`; depth-2 prefixes are `src/a`, `src/a` (dup), `src/b` → `dirBreadth === 2`.
- Reads after the first edit are excluded: read `src/a/x.ts`, edit `src/a/x.ts`, read `src/c/q.ts`, `src/c/r.ts` → `fileDepth === 1` (only `src/a/x.ts`), `dirBreadth === 1`.
- Zero-edit session (reads only, no edit event) → returns `null`.
- Session with an edit but no preceding reads → returns `{ dirBreadth: 0, fileDepth: 0 }`.
- A read of a single-segment path `README.md` then an edit → its prefix is `README.md` (one segment used whole); counts toward `dirBreadth`.
- Reads touching the same depth-2 dir via 4 distinct files (`src/a/1.ts`..`src/a/4.ts`) then edit → `dirBreadth === 1`, `fileDepth === 4`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/orientation.test.ts`
Expected: FAIL (module not found / function not defined).

- [ ] **Step 3: Implement `computePreEditOrientation`**

Create `src/detector/orientation.ts` exporting `PreEditOrientation` and `computePreEditOrientation` per the definitions above. Pure: no I/O, no mutation of input. Single pass to find `firstEditIdx`, a second pass to collect read files before it, then dedupe for `fileDepth` and dedupe depth-2 prefixes for `dirBreadth`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/orientation.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add src/detector/orientation.ts test/orientation.test.ts`
Run: `git commit -m "feat(detector): add pre-edit orientation metric (dir breadth + file depth)"`

---

### Task 3: Scorer always computes the bootstrap trip

**Files:**
- Modify: `src/detector/scoring.ts` (`SessionScore` interface; `scoreSessions`, `percentileModeScore`, `bootstrapScore`).
- Modify: `test/scoring.test.ts` (add bootstrap-trip-in-percentile-mode cases).

**Interfaces:**
- Consumes: existing `scoreSessions` input; `SignalValues`, `Config`, `SIGNAL_SPECS` (already in file).
- Produces: `SessionScore` gains two always-populated fields:
  - `bootstrap_composite: number` — the bootstrap composite (0–100) for the session, computed identically to `bootstrapScore`'s `composite`.
  - `bootstrap_flagged: boolean` — true when `bootstrap_composite >= cfg.detector.bootstrap_flag_pct || trippedCount >= 2` (the existing bootstrap flag condition).
  - The existing fields `score_pct`, `mode`, `flagged`, `composite` are UNCHANGED in value and meaning (percentile mode still ranks by composite; `flagged` is still the mode-specific flag).
- Note for the implementer: `src/detector/record.ts` declares its own local `SessionScore` interface that is a structural subset (the four old fields). Because TypeScript allows passing an object with extra fields to a parameter typed by a subset interface (excess-property checks only apply to object literals), `assembleStruggleRecord(env, signals[i], scores[i], areas)` continues to compile unchanged. Do NOT modify `record.ts`.

- [ ] **Step 1: Write failing tests in `test/scoring.test.ts`**

Add cases (build signals with the existing `zeroSignals` helper and `DEFAULT_CONFIG`/`cfgWith`):
- Percentile mode (≥30 sessions): a session with `reread: 5, failure_streak: 3` (both trip their bootstrap thresholds of 5 and 3) in a 30-session set. Expected: `results[i].mode === 'percentile'`, `results[i].bootstrap_flagged === true`, `results[i].bootstrap_composite` is a finite number > 0. (The percentile `flagged` may be true or false — do not assert it; assert only the new bootstrap fields.)
- Percentile mode: an all-zero session in a 30-session set → `bootstrap_composite === 0`, `bootstrap_flagged === false`.
- Bootstrap mode (force or <30 sessions): every result has `bootstrap_composite === composite` and `bootstrap_flagged === flagged` (the existing fields equal the new fields, since bootstrap IS the active mode).
- Existing tests 1–10 in the file still pass (non-regression): run the whole file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/scoring.test.ts`
Expected: FAIL (`bootstrap_composite`/`bootstrap_flagged` undefined).

- [ ] **Step 3: Implement always-computed bootstrap trip**

Refactor `bootstrapScore`'s trip math into a shared helper (e.g. a local `bootstrapTrip(s, cfg): { composite: number; flagged: boolean }`) and call it for every session inside both `percentileModeScore` (attach `bootstrap_composite`/`bootstrap_flagged` to each percentile result) and `bootstrapScore` (so its returned `composite`/`flagged` are reused as the bootstrap fields). Add the two fields to the `SessionScore` interface. Do not change how `composite`, `score_pct`, `mode`, or `flagged` are computed.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/scoring.test.ts`
Expected: PASS (all old + new cases).

- [ ] **Step 5: Commit**

Run: `git add src/detector/scoring.ts test/scoring.test.ts`
Run: `git commit -m "feat(scoring): always compute bootstrap trip on every SessionScore"`

---

### Task 4: Ambient assessor

**Files:**
- Create: `src/detector/ambient.ts`
- Create: `test/ambient.test.ts`

**Interfaces:**
- Consumes: `PreEditOrientation` (Task 2), `RepoFinding`/`BaselineAssessment`/`Severity`/`BaselinePath`/`BaselineState`/`Config`/`ScoringMode` (Task 1).
- Produces:
  - `export interface AmbientSession { orientation: PreEditOrientation | null; bootstrap_composite: number; bootstrap_flagged: boolean; }`
  - `export interface AmbientResult { finding: RepoFinding | null; baseline: BaselineAssessment; }`
  - `export function assessAmbient(input: { sessions: AmbientSession[]; cfg: Config; scoringMode: ScoringMode; }): AmbientResult`
  - A local `median(xs: number[]): number` helper (sort ascending; middle element if odd length; mean of the two middle elements if even; `0` for empty input).

**Behavior contract (the implementer codes exactly this):**
1. `n = sessions.length`. Compute `withEdit = sessions.filter(s => s.orientation !== null)`; `zero_edit_fraction = n > 0 ? (n - withEdit.length) / n : 0`.
2. `struggle_rate = n > 0 ? sessions.filter(s => s.bootstrap_flagged).length / n : 0`.
3. `median_composite = median(sessions.map(s => s.bootstrap_composite))`.
4. Orientation medians: if `withEdit.length >= 1`, `median_dir_breadth = median(withEdit.map(s => s.orientation!.dirBreadth))` and `median_file_depth = median(withEdit.map(s => s.orientation!.fileDepth))`; else both undefined (orientation block null).
5. Floors from `cfg.detector.ambient`: `breadth_floor`, `file_depth_floor`, `struggle_rate_threshold`, `min_sessions`, `severity_min_sessions`.
6. Path firing:
   - `orientationPath` = `withEdit.length >= 1 && (median_dir_breadth >= breadth_floor || median_file_depth >= file_depth_floor)`.
   - `acutePath` = `struggle_rate >= struggle_rate_threshold`.
7. `baseline.state`:
   - `'too-few-sessions'` if `n < min_sessions`.
   - else `'elevated'` if `orientationPath || acutePath`.
   - else `'orientation-undefined'` if `withEdit.length === 0`.
   - else `'within-norms'`.
8. `finding` is non-null iff `state === 'elevated'`. When elevated:
   - `paths` = `['orientation']` filtered by `orientationPath` concatenated with `['acute']` filtered by `acutePath` (order: orientation first, acute second).
   - `severity`: if `n < severity_min_sessions` → `'unrated'`. Else compute `orientationRatio = withEdit.length >= 1 ? Math.max(median_dir_breadth / breadth_floor, median_file_depth / file_depth_floor) : 0`; then `'high'` if `orientationRatio >= 1.5 || struggle_rate >= 0.60`; else `'medium'` if `orientationRatio >= 1.2 || struggle_rate >= 0.45`; else `'low'`.
   - `finding` fields: `kind: 'elevated-baseline'`, the `severity`, `paths`, `sessions_sampled: n`, `scoring_mode: scoringMode`, `orientation` block (`null` only when `withEdit.length === 0`), `zero_edit_fraction`, `acute: { struggle_rate, struggle_rate_threshold }`.
9. `baseline` is always built with the same `sessions_sampled`/`scoring_mode`/`orientation`/`zero_edit_fraction`/`acute` and the `state` from step 7.

- [ ] **Step 1: Write failing tests in `test/ambient.test.ts`**

Build `AmbientSession[]` literals directly. Use `cfg = structuredClone(DEFAULT_CONFIG)` (defaults: breadth_floor 4, file_depth_floor 12, struggle_rate_threshold 0.30, min_sessions 10, severity_min_sessions 20). Expected results:
- Orientation path fires, acute cold: 10 sessions, 10 with-edit, each `orientation { dirBreadth: 6, fileDepth: 18 }` (above both floors), all `bootstrap_flagged: false`. → `finding` non-null, `finding.paths === ['orientation']`, `finding.severity === 'high'` (6/4=1.5 ≥1.5), `baseline.state === 'elevated'`, `zero_edit_fraction === 0`.
- Acute path fires, orientation cold: 10 sessions, all `bootstrap_flagged: true` (struggle_rate 1.0 ≥0.30), `orientation { dirBreadth:1, fileDepth:1 }` (below floors). → `finding.paths === ['acute']`, `severity === 'high'` (struggle_rate ≥0.60).
- Both fire: 10 sessions, orientation above floors AND all bootstrap_flagged → `paths === ['orientation','acute']`.
- Neither fires: 10 sessions, orientation below floors, none bootstrap_flagged → `finding === null`, `baseline.state === 'within-norms'`.
- Below min_sessions: 5 sessions with orientation above floors → `finding === null`, `baseline.state === 'too-few-sessions'`.
- Zero-edit excluded from median: 10 sessions — 6 with-edit `orientation { dirBreadth: 6, fileDepth: 18 }`, 4 zero-edit `orientation: null`. → finding fires; `finding.orientation.median_dir_breadth === 6` (median of the 6 with-edit only, NOT corrupted by nulls); `zero_edit_fraction === 0.4`; `finding.orientation.with_edit_sessions === 6`.
- All zero-edit: 10 sessions all `orientation: null`, none bootstrap_flagged → `finding === null`, `baseline.state === 'orientation-undefined'`, `baseline.orientation === null`.
- Severity 'unrated': 12 sessions (≥min_sessions 10, <severity_min_sessions 20), orientation above floors → `finding` non-null, `severity === 'unrated'`.
- Severity boundary 'medium': 20 sessions, orientation `dirBreadth: 5` (5/4=1.25, ≥1.2 and <1.5), no acute → `severity === 'medium'`.
- Severity boundary 'low': 20 sessions, orientation `dirBreadth: 4` (4/4=1.0, fired at floor, <1.2), no acute → `severity === 'low'`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/ambient.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `assessAmbient`**

Create `src/detector/ambient.ts` with `AmbientSession`, `AmbientResult`, the `median` helper, and `assessAmbient` coding exactly the 9-step contract above. Pure: no I/O, no mutation. Build `finding` only when elevated; always build `baseline`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/ambient.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add src/detector/ambient.ts test/ambient.test.ts`
Run: `git commit -m "feat(detector): add assessAmbient — two-path baseline finding"`

---

### Task 5: Wire detector + pipeline

**Files:**
- Modify: `src/detector/index.ts` (`runDetector` signature + body).
- Modify: `src/pipeline.ts` (destructure new return; thread to outputs; extend `ScanResult`).
- Modify: `test/pipeline.test.ts` (smoke test of the new shape).

**Interfaces:**
- Consumes: `computePreEditOrientation` (Task 2), `assessAmbient`/`AmbientSession` (Task 4), the enriched `SessionScore` (Task 3), `RepoFinding`/`BaselineAssessment` (Task 1).
- Produces:
  - `runDetector(envelopes: NormalizedEnvelope[], cfg: Config, forceBootstrap: boolean): { records: StruggleRecord[]; finding: RepoFinding | null; baseline: BaselineAssessment; }` (was `StruggleRecord[]`).
  - `ScanResult` gains `finding: RepoFinding | null` and `baseline: BaselineAssessment`.

**Wiring contract:**
- In `runDetector`: compute `signals` (existing), `scores = scoreSessions(...)` (now carrying `bootstrap_composite`/`bootstrap_flagged`). Build `ambientSessions: AmbientSession[]` by zipping, per envelope index `i`: `orientation = computePreEditOrientation(envelopes[i].events)`; `{ orientation, bootstrap_composite: scores[i].bootstrap_composite, bootstrap_flagged: scores[i].bootstrap_flagged }`. Derive `scoringMode = scores[0]?.mode ?? 'bootstrap'`. Call `assessAmbient({ sessions: ambientSessions, cfg, scoringMode })` → `{ finding, baseline }`. Records are assembled exactly as before. Return `{ records, finding, baseline }`.
- In `runScan` (`src/pipeline.ts`): replace `const records = runDetector(...)` with `const { records, finding, baseline } = runDetector(filtered, cfg, forceBootstrap);`. Pass `finding`/`baseline` into the three output branches (Tasks 6–8 wire their consumption; for this task, pass them through and the existing branches still build output — `finding`/`baseline` may be unused by a branch until that branch's task). Set `ScanResult.finding`/`.baseline`.

- [ ] **Step 1: Write a failing test in `test/pipeline.test.ts`**

Add a test that builds `NormalizedEnvelope[]` directly (plain data per `src/types.ts`: each has `schema_version: 1`, `session_id`, `agent: 'claude-code'`, `repo`, `started_at`, `duration_ms`, `events: NormalizedEvent[]`, `truncated: false`, `event_count`). Construct 10 envelopes where each session reads files across 5 dirs then edits (high orientation). Call `runDetector(envelopes, structuredClone(DEFAULT_CONFIG), false)`. Expected: `result.records.length === 10`; `result.finding` is non-null with `finding.paths` containing `'orientation'`; `result.baseline.state === 'elevated'`. (This bypasses streaming/I/O — pure detector test.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pipeline.test.ts`
Expected: FAIL (`runDetector` returns an array, no `.finding`).

- [ ] **Step 3: Implement the wiring**

Change `runDetector` to the new return shape per the wiring contract. Update `runScan` to destructure and thread `finding`/`baseline`; add the two fields to `ScanResult`. Leave the output branches calling their builders with their current args for now (Tasks 6–8 add the new args). `npm run typecheck` (`tsc --noEmit`) must pass.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/pipeline.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add src/detector/index.ts src/pipeline.ts test/pipeline.test.ts`
Run: `git commit -m "feat(detector): runDetector emits finding + baseline; pipeline threads them"`

---

### Task 6: `repo_findings` in `--json`

**Files:**
- Modify: `src/output/json.ts` (`JsonEnvelopeInput`, `buildJsonEnvelope`).
- Modify: `src/pipeline.ts` (pass `finding` to the json branch).
- Modify: `test/output.test.ts` (add `repo_findings` cases).

**Interfaces:**
- Consumes: `RepoFinding` (Task 1), `finding` from Task 5.
- Produces: `JsonEnvelopeInput` gains `repo_findings: RepoFinding[]`. `buildJsonEnvelope` sets `repo_findings: input.repo_findings` on the envelope (additive; all other fields unchanged).

**Wiring:** In `runScan`'s `opts.json` branch, pass `repo_findings: finding ? [finding] : []` to `buildJsonEnvelope`.

- [ ] **Step 1: Write failing tests in `test/output.test.ts`**

Add cases calling `buildJsonEnvelope` directly with a minimal hand-built `RepoFinding`:
- `repo_findings: []` → output envelope has `repo_findings` deep-equal `[]`.
- `repo_findings: [<one finding>]` → envelope has `repo_findings` length 1, `schema_version === 1`, and the other existing fields (`sessions`, `areas`, `warnings`) unchanged.
Also add a pipeline-level assertion (in `test/pipeline.test.ts` or here): `runScan({..., json:true})` on a within-norms fixture → parsed `repo_findings` is `[]`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/output.test.ts`
Expected: FAIL (`repo_findings` missing / type error).

- [ ] **Step 3: Implement**

Add `repo_findings` to `JsonEnvelopeInput` and project it in `buildJsonEnvelope`. Thread `repo_findings: finding ? [finding] : []` in the `runScan` json branch.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/output.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add src/output/json.ts src/pipeline.ts test/output.test.ts`
Run: `git commit -m "feat(output): include repo_findings in the --json envelope"`

---

### Task 7: Baseline line + block in the human table

**Files:**
- Modify: `src/output/human.ts` (`HumanInput`, `formatHuman`).
- Modify: `src/pipeline.ts` (pass `baseline` + `finding` to the human branch).
- Modify: `test/output.test.ts` (human baseline-line cases).

**Interfaces:**
- Consumes: `BaselineAssessment`, `RepoFinding | null` (Tasks 1, 5).
- Produces: `HumanInput` gains `baseline: BaselineAssessment; finding: RepoFinding | null;` `minSessions` is read off `baseline` context where needed via the `sessions_sampled`/state (no cfg needed — the baseline already carries the floors and medians).

**Formatting contract (fixed literals only — no session content, no paths, no prose):**
- Immediately after the existing header line, emit exactly one baseline line, then (when elevated) a short detail block, then a blank line before the area table.
- When `baseline.state === 'elevated'` and `finding` is non-null:
  - Line: ``BASELINE — elevated (${finding.paths.join('/')}) · severity: ${finding.severity}``
  - Detail: ``  orientation ${o.median_dir_breadth} dirs / ${o.median_file_depth} files (floors ${o.breadth_floor} / ${o.file_depth_floor}) · over ${o.with_edit_sessions} with-edit sessions`` (omit this detail line when `finding.orientation === null`).
  - Detail: ``  zero-edit (Q&A) sessions: ${(finding.zero_edit_fraction*100).toFixed(0)}% · acute struggle rate: ${(finding.acute.struggle_rate*100).toFixed(0)}% (threshold ${(finding.acute.struggle_rate_threshold*100).toFixed(0)}%)``
  - Detail: ``  the typical session orients broadly before acting — worth investigating (cause undiagnosed)``
- When `baseline.state === 'within-norms'`: line ``BASELINE — within norms · orientation ${o.median_dir_breadth} dirs / ${o.median_file_depth} files · zero-edit ${(baseline.zero_edit_fraction*100).toFixed(0)}% · acute ${(baseline.acute.struggle_rate*100).toFixed(0)}%`` (when `baseline.orientation === null`, print `orientation n/a` in place of the dirs/files fragment).
- When `baseline.state === 'too-few-sessions'`: line ``BASELINE — too few sessions (${baseline.sessions_sampled}) to assess``.
- When `baseline.state === 'orientation-undefined'`: line ``BASELINE — within norms · all sessions exploration-only; orientation metric undefined · acute ${(baseline.acute.struggle_rate*100).toFixed(0)}%``.

- [ ] **Step 1: Write failing tests in `test/output.test.ts`**

Cases calling `formatHuman` directly with a hand-built `baseline` (and `finding`):
- Elevated + orientation: output contains the `BASELINE — elevated (orientation) · severity: high` line and the three detail lines, and the literal `(cause undiagnosed)`.
- Elevated + acute only (`finding.orientation === null`, `paths: ['acute']`): the orientation detail line is absent.
- Within-norms: output contains `BASELINE — within norms`.
- Too-few-sessions: output contains `BASELINE — too few sessions (5) to assess`.
- Orientation-undefined: output contains `all sessions exploration-only; orientation metric undefined`.
- No session content leaks: assert the output does NOT contain any string that would only appear in `input_digest` (e.g. assert a deliberately-placed fake path passed into a record's areas is the only non-baseline text — keep this case minimal; the thorough prose-leak test is Task 9).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/output.test.ts`
Expected: FAIL (`baseline`/`finding` not accepted by `formatHuman`).

- [ ] **Step 3: Implement**

Add `baseline`/`finding` to `HumanInput`; emit the baseline line + block per the formatting contract, between the header and the area table. Fixed literals only. Thread `baseline` and `finding` from `runScan` into the `formatHuman` call.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/output.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add src/output/human.ts src/pipeline.ts test/output.test.ts`
Run: `git commit -m "feat(output): always-print baseline line + elevated-baseline block"`

---

### Task 8: Baseline assessment in `--calibrate`

**Files:**
- Modify: `src/output/calibrate.ts` (`CalibrateInput`, `buildCalibrateObject`, `formatCalibrateTable`).
- Modify: `src/pipeline.ts` (pass `baseline` to the calibrate branch).
- Modify: `test/output.test.ts` (calibrate baseline cases).

**Interfaces:**
- Consumes: `BaselineAssessment` (Task 1, 5).
- Produces: `CalibrateInput` gains `baseline: BaselineAssessment`. `CalibrateObject` gains `baseline: BaselineAssessment`. `formatCalibrateTable` prints one baseline summary line after the existing signal table (fixed literals + numbers only).

**Formatting contract:** After the signal rows, emit:
``BASELINE — ${baseline.state} · orientation ${fragment} · zero-edit ${pct}% · acute struggle rate ${pct}% (threshold ${pct}%)``
where the orientation fragment is `${median_dir_breadth} dirs / ${median_file_depth} files` when `baseline.orientation !== null`, else `n/a`. (When state is `too-few-sessions`, still print the line with the medians if present, else `n/a`.)

- [ ] **Step 1: Write failing tests in `test/output.test.ts`**

Cases:
- `buildCalibrateObject` with a `baseline` → returned object's `baseline` deep-equals the input.
- `formatCalibrateTable` output contains a `BASELINE —` line with the state and the acute threshold percentage.
- Numbers are rounded consistently with the table (the acute rates may be shown to whole percent; keep it deterministic).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/output.test.ts`
Expected: FAIL (`baseline` not on `CalibrateInput`).

- [ ] **Step 3: Implement**

Add `baseline` to `CalibrateInput`/`CalibrateObject`; project it through `buildCalibrateObject`; append the baseline summary line in `formatCalibrateTable`. Thread `baseline` into the `runScan` calibrate branch (both the `opts.json` and table paths).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/output.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add src/output/calibrate.ts src/pipeline.ts test/output.test.ts`
Run: `git commit -m "feat(output): baseline assessment line in --calibrate"`

---

### Task 9: Prose-leak tests for the new output surfaces

**Files:**
- Modify: `test/privacy.test.ts` (add a section (d)).
- Create fixture content inline (reuse `mkSession` from `test/helpers/builder.ts`).

**Interfaces:** Consumes `runScan`, `mkSession`, `setupTempRepo`, `writeTranscript` (existing helpers), and a `PROSE_MARKER` string defined in this test.

**Why this task exists:** The existing privacy fixture writes ONE session, which can never trip the ambient finding (`min_sessions` default 10). The new `RepoFinding`, baseline block, and calibrate assessment are therefore unexercised by the current privacy suite. This task forces a ≥`min_sessions` fixture seeded with prose markers that DOES trip the finding, and asserts no marker reaches any output path.

- [ ] **Step 1: Write failing tests in `test/privacy.test.ts`**

Add `describe('privacy (d): baseline/finding surfaces carry no prose')`. Define `const PROSE_MARKER = 'Q9bKxe_secret_prose_marker';`. Build a fixture of ≥10 sessions (so `min_sessions` is met) where each session reads files across ≥5 distinct dirs then edits (high orientation → finding fires), and at least some sessions include the marker inside `user_text` events and inside an exec `cmd`. Write them via `writeTranscript(claudeDir, slug, name, mkSession(repo, spec))`. Then:
- `runScan({ repo, claudeDir, json: true })` → parse `JSON.parse(result.output)`; assert `repo_findings.length === 1` (the finding fired) AND `JSON.stringify(parsed.repo_findings).includes(PROSE_MARKER) === false` AND `JSON.stringify(parsed).includes(PROSE_MARKER) === false`.
- `runScan({ repo, claudeDir })` (human) → `result.output.includes(PROSE_MARKER) === false`.
- `runScan({ repo, claudeDir, calibrate: true })` → `result.output.includes(PROSE_MARKER) === false`.
- Positive enum check: every value of `parsed.repo_findings[0].severity` is one of `high|medium|low|unrated`, and every entry in `paths` is one of `orientation|acute`.

(These assertions initially pass only if the finding is prose-free by construction; if any marker leaks, they fail — which is the point.)

- [ ] **Step 2: Run tests to verify the behavior**

Run: `npx vitest run test/privacy.test.ts`
Expected: PASS (the surfaces are numbers/enums/literals by construction). If any assertion FAILS, a prose leak exists — fix the formatter (Task 7/8) before proceeding; do not weaken the assertion.

- [ ] **Step 3: (No new implementation unless a leak is found)**

If all pass, no code change. If a leak is found, fix the offending formatter to use fixed literals/numbers only.

- [ ] **Step 4: Run the full privacy suite**

Run: `npx vitest run test/privacy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add test/privacy.test.ts`
Run: `git commit -m "test(privacy): assert baseline/finding surfaces are prose-free"`

---

### Task 10: Two-repo-class calibration gate (synthetic fixtures)

**Files:**
- Create: `test/fixtures/baseline/sessions.ts` (fixture builders, mirroring the `test/fixtures/corpus/sessions.ts` pattern).
- Create: `test/baseline-gate.test.ts`.

**Interfaces:** Consumes `runScan`, the builder helpers, and `RepoFinding` (to assert on parsed `repo_findings`).

**Why this task exists:** The spec's success criterion requires the finding to fire on an unharnessed repo, stay silent on a well-harnessed repo, and be stable under ±20% floor perturbation on a brownfield-shaped repo. The real brownfield dogfood (`java-enterprise-codebase-rag`) is manual; this task encodes the automated synthetic proxy.

- [ ] **Step 1: Write failing tests in `test/baseline-gate.test.ts`**

Three fixture sets, each ≥10 sessions (to clear `min_sessions`), written via the helpers and scanned with `runScan({ repo, claudeDir, json: true })`:
- **Unharnessed:** each session reads files spread across ≥6 distinct depth-2 dirs then edits (broad orientation, well above `breadth_floor: 4`). Expected: `repo_findings.length === 1`, `severity` is `high` or `medium`, `paths` includes `'orientation'`.
- **Well-harnessed (held-out):** each session reads files in 1 dir (≤2 files) then edits (tight orientation, below floors). Expected: `repo_findings.length === 0`.
- **Brownfield-shaped + stability:** each session reads across ~5 dirs / ~14 files then edits (just above floors), AND include ~36% zero-edit Q&A sessions (mirroring the reference repo). Assert: (a) deterministic — two runs produce identical `repo_findings`; (b) the zero-edit sessions do not move the result — removing them yields the same fire/no-fire decision; (c) ±20% stability — scanning with a config override `ambient.breadth_floor` at `4`, then at `Math.ceil(4*0.8)=4` and `Math.floor(4*1.2)=4` (i.e. perturb `file_depth_floor` 12 → 10 and 14, and `breadth_floor` where the margin allows) does not flip the fire/no-fire outcome. (Pick fixture values so the median sits with ≥20% margin from the floor, making this assertable.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/baseline-gate.test.ts`
Expected: FAIL initially only if a fixture value is off; otherwise PASS once the implementation is correct (Tasks 2–8). If a gate FAILS on correct implementation, the fixture's orientation values need adjusting — not the code.

- [ ] **Step 3: Tune fixtures (not code) until the gate is green**

Adjust the synthetic fixture event lists so the unharnessed set fires, the harnessed set stays silent, and the brownfield set is stable. Do not change `assessAmbient` logic or default floors to make tests pass — that would defeat the gate.

- [ ] **Step 4: Run the gate**

Run: `npx vitest run test/baseline-gate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add test/fixtures/baseline/sessions.ts test/baseline-gate.test.ts`
Run: `git commit -m "test(baseline): two-repo-class calibration gate (fire/silent/stable)"`

---

### Task 11: Non-corruption verification + real-repo dogfood note

**Files:**
- No code changes. Optionally Modify: `docs/superpowers/specs/active/2026-07-14-harnessgap-ambient-struggle-design.md` (record finalized threshold values if calibration moved them — only if Task 10/real dogfood changed a prior).

**Why this task exists:** The slice must provably not change Slice 1's validated output. This is the assertion.

- [ ] **Step 1: Run the full suite**

Run: `npm test`
Expected: ALL PASS, including `test/corpus.test.ts` (≥80% label match) and `test/snapshot.test.ts` (leaderboard snapshot unchanged). If the snapshot diffs, that is a FAILURE — the slice corrupted per-session/per-area output; investigate (the only legitimate snapshot change would be none at all, since `StruggleRecord`/scorer/aggregator are untouched).

- [ ] **Step 2: Run typecheck + egress + packaging gates**

Run: `npm run typecheck && npx vitest run test/egress.test.ts test/packaging.test.ts`
Expected: PASS (no new deps, no new network surface).

- [ ] **Step 3: Manual brownfield dogfood (operator-run, not automated)**

Run (by the operator, against the real repo): `npm run dev -- scan --repo ~/Desktop/CursorProjects/java-enterprise-codebase-rag` and `... --calibrate` and `... --json`. Eyeball: the baseline line appears with the real orientation medians and the 36% zero-edit fraction; the finding fires (or not) in a way the user's gut endorses. Record the observed `repo_findings` severity and the orientation medians. If a default prior needs revising, update `DEFAULT_CONFIG.detector.ambient` and the spec's §6 table together, re-run Task 10.

- [ ] **Step 4: Commit any threshold finalization**

If Step 3 revised a prior: `git add src/config.ts <spec>` and `git commit -m "chore(calibrate): finalize ambient thresholds from dogfood"`. Otherwise no commit.

- [ ] **Step 5: (Plan complete — hand off to finishing-a-development-branch.)**

---

## Self-Review (run before saving — recorded here for the implementer)

1. **Code scan:** No method bodies, algorithms, or test/impl code appear above — only signatures, data shapes, behavior contracts, and expected test results. ✓
2. **Self-containment:** Each task's Consumes/Produces names exact types/signatures defined in earlier tasks; no "see spec." ✓
3. **Spec coverage:** orientation metric (T2), always-bootstrap-trip (T3), two-path assessor + zero-edit exclusion + severity/unrated (T4), detector+pipeline (T5), `repo_findings` json (T6), baseline human line (T7), calibrate assessment (T8), prose-leak for new surfaces (T9), two-repo-class gate (T10), non-corruption (T11), config+types (T1). Every spec §2 in-scope item and every §9 module-table row maps to a task. ✓
4. **Placeholders:** None — each test case states scenario + expected result; each impl step states exact behavior. ✓
5. **Type consistency:** `RepoFinding`/`BaselineAssessment` field names are identical in T1, T4, T6, T7, T8. `assessAmbient` returns `{ finding, baseline }` consistently in T4/T5. `runDetector` returns `{ records, finding, baseline }` consistently in T5. `computePreEditOrientation` returns `PreEditOrientation | null` consistently in T2/T4/T5. ✓
