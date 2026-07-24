# Closed-Loop MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the minimal closed loop — `synthesize` → `review` → `explain` (+ timing-bearing doc-read consumption) — so the loop runs end-to-end on one example for the MVP demo.

**Architecture:** Opt-in loop commands compose the existing detect+diagnose pipeline (extracted into a shared `collectEnvelopes` helper) and add a prose-gated, fact-checked, multi-harness Synthesizer. The default `scan`/`reflect` path stays stateless/no-network/no-writes; only the new opt-in commands cross the write + subprocess boundary, delegating network to the trusted agent CLI via `child_process`.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node ≥ 22.12, commander, yaml, vitest. No new runtime deps — the synthesizer uses only built-in `node:child_process` / `node:fs`.

**Spec:** `docs/superpowers/specs/active/2026-07-24-mvp-closed-loop-design.md` (authoritative for design; this plan carries the per-task contracts).

## Global Constraints

- Node ≥ 22.12; TypeScript ESM; all intra-`src` imports use the `.js` specifier.
- **Egress:** no `src/` file may import a network module (`http`/`https`/`net`/`undici`/`fetch`) or call global `fetch(`. `node:child_process` imports are allowed **only** under `src/synthesizer/*` (enforced by `test/egress.test.ts`, Task 14). Prompt-template strings must not contain the literal `fetch(`.
  > **Refinement note (Task 7, 2026-07-24):** the Task 7 brief deliberately widened the `child_process` allow-scope to also include `src/git.ts`. `isValidSha(repoRoot, sha)` — the sandboxed `git cat-file -e <sha>^{commit}` helper consumed by the fact-check gate — lives in `src/git.ts` (not `src/synthesizer/*`), consolidating all repo/git invocation in the existing repo-interaction module and keeping `factcheck.ts` free of `child_process`. **Action for Task 14:** the egress test's child_process-scoping assertion must permit `src/git.ts` in addition to `src/synthesizer/*`. The intent ("no `child_process` in `src/pipeline.ts` / `src/detector/*` / `src/adapter/*`") is preserved — only the allowlist grows by one module. Flagged for the user because this loosens a security-adjacent invariant the original spec §4 / plan Task 14 scoped tightly to `src/synthesizer/*`.
- **Byte-identity** is relaxed **only** for `docs_read`/`docs_injected`; the `evidence`/`diagnoses` opt-in conditional-spread stays.
- **Fail-open** throughout: every new command degrades to a clean message + exit, never throws past the CLI boundary.
- **Secret scrubbing:** any repo content read at runtime and sent to a backend is scrubbed via the existing `src/adapter/scrub.ts`.
- New top-level config keys are rejected unless allowlisted (closed enumeration in `KNOWN_TOP_KEYS`).
- Test framework: vitest (`npm test` = `vitest run`; single file: `npx vitest run <path>`). Typecheck: `npm run typecheck`. TDD: failing test first.
- Conventional commits (`feat`/`fix`/`docs`/`test`/`refactor`/`chore`); commit per task.

## File Structure

**New files**
- `src/synthesizer/proposal.ts` — `Proposal` type + schema validator.
- `src/synthesizer/factcheck.ts` — `factCheck()` + `verificationFrom()`.
- `src/synthesizer/backend.ts` — `resolveBackend()` + `runBackend()` + per-harness `extractProposal()`.
- `src/synthesizer/bundle.ts` — `buildBundle()` (evidence-bundle → prompt string).
- `src/synthesizer/index.ts` — `runSynthesize()` orchestration.
- `src/router/pointer.ts` — pure pointer renderer.
- `src/explain.ts` — `runExplain()`.
- `src/review.ts` — `runReview()`.
- `docs/CALIBRATION.md` — accepted-risk / recall-substitute record.

**Modified files**
- `src/types.ts` — new types + `StruggleRecord` fields + `Config` fields.
- `src/config.ts` — `DEFAULT_CONFIG`, `KNOWN_TOP_KEYS`, `validateConfig`.
- `src/pipeline.ts` — extract `collectEnvelopes`; `degenerateRecord` gets the new fields; add `runSynthesize`/`runExplain`/`runReview` wiring seam (or keep those in their own modules — see tasks).
- `src/detector/index.ts`, `src/detector/record.ts` — `docs_read`/`docs_injected` collection + threading.
- `src/cli.ts` — `synthesize`/`review`/`explain` commands.
- `src/egress.ts`, `test/egress.test.ts` — scope `child_process`; docstring updates.
- `test/fixtures/corpus/labels.json`, `test/corpus.test.ts` — corpus extension.
- `CLAUDE.md`, `package.json`, `README.md`, `docs/CONSUMER_GUIDE.md`, `docs/ARCHITECTURE.md` — identity/privacy/scope updates (Task 16).

## Dependency Graph

```
1 types ──┬─► 2 config ──┬─► 8 backend ──┐
          ├─► 4 docs_read │   6 proposal │
          ├─► 6 proposal ─┴─► 7 factcheck │
          └─► 9 bundle ──────────────────┤
3 collectEnvelopes ──┬─► 10 synthesize ◄──┘ ──► 13 cli ──► 16 docs
4 docs_read ─────────┤    11 explain
5 pointer ───────────┘    12 review ◄── 6
15 corpus (independent)
14 egress (after 8)
```

Critical path: 1 → 2 → 8 → 10 → 13. Parallelizable early: 3, 5, 6, 15 (after 1 where applicable).

---

### Task 1: Types — record fields, Proposal, FactCheckResult, config shapes

**Files:**
- Modify: `src/types.ts`

**Interfaces:**
- Produces (exact shapes later tasks import verbatim):
  - `DocRead = { path: string; t: string }` (ISO8601 event timestamp).
  - `DocInjection = { path: string; t: string; trigger: 'edit' | 'start' }`.
  - `StruggleRecord` gains two **required** fields: `docs_read: DocRead[]` and `docs_injected: DocInjection[]` (always-on; no `?`).
  - `Proposal` (new-doc only):
    `{ kind: 'new-doc'; path: string; frontmatter: { derived_from: string[]; unit: { kind: 'area'; key: string }; struggle_score: number; cause: Cause; source_files: string[]; created: string }; body: string; cited_symbols: string[]; referenced_paths: string[]; dedupe: { nearest_existing: string | null; similarity?: number; decision_rationale: string }; verification: { cited_symbols_resolved: boolean; paths_resolved: boolean; shas_valid: boolean } }`.
  - `FactCheckFailure = { assertion: string; kind: 'symbol' | 'path' | 'sha'; resolved: boolean; detail?: string }`.
  - `FactCheckResult = { failures: FactCheckFailure[] }`.
  - `Config` gains `synthesizer: { backend: string | null; model: string | null; structure_only: boolean; max_file_head_bytes: number; dedupe: 'none' | 'tfidf'; top_n: number }` and `diagnose` gains `confidence_floor_for_prose: number`.

- [ ] **Step 1: Write the failing test**
  Test verifies the type module compiles and the new shapes are exported/assignable: constructing a `StruggleRecord` literal **without** `docs_read`/`docs_injected` is a type error (use a `// @ts-expect-error` assertion, or a types-harness test like `test/types-harness.test.ts`). Constructing a minimal valid `Proposal` literal with `kind:'new-doc'`, `cited_symbols: []`, `referenced_paths: []`, the `dedupe`/`verification` blocks type-checks. Expected: the test file asserts the shapes exist and the `@ts-expect-error` lines fire (proving the fields are required).
- [ ] **Step 2: Run test to verify it fails**
  Run: `npm run typecheck`
  Expected: FAIL — `DocRead`, `DocInjection`, `Proposal`, `FactCheckResult` undefined; `StruggleRecord` missing fields.
- [ ] **Step 3: Implement**
  Add the types/shapes above to `src/types.ts`. Do **not** remove or rename any existing export. Add a doc-comment on `docs_dirs` stating it is consumed by both the Diagnoser (`gatherRepoContext`) and the detector (doc-read scoping).
- [ ] **Step 4: Run typecheck to verify it passes**
  Run: `npm run typecheck`
  Expected: PASS. (`npm test` will still fail elsewhere — that is later tasks' concern; this task's gate is typecheck + the types-harness test.)
- [ ] **Step 5: Commit**
  `git add src/types.ts test/types-harness.test.ts && git commit -m "feat(types): add docs_read/docs_injected, Proposal, FactCheckResult, synthesizer config shapes"`

---

### Task 2: Config — synthesizer block + confidence floor + validation

**Files:**
- Modify: `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: `Config` shape from Task 1.
- Produces: `DEFAULT_CONFIG.synthesizer = { backend: null; model: null; structure_only: false; max_file_head_bytes: 4096; dedupe: 'none'; top_n: 3 }`; `DEFAULT_CONFIG.diagnose.confidence_floor_for_prose = 0.6`; `KNOWN_TOP_KEYS` includes `'synthesizer'`. `validateConfig` enforces: `synthesizer.dedupe ∈ {'none','tfidf'}`; `synthesizer.max_file_head_bytes >= 1`; `synthesizer.top_n >= 1`; `synthesizer.backend` is `string | null`; `diagnose.confidence_floor_for_prose ∈ [0,1]`. Each violation throws `ConfigError` with a message naming the field and the bad value.

- [ ] **Step 1: Write the failing tests** (in `test/config.test.ts`)
  - `loadConfig()` (no file) returns defaults including `synthesizer.top_n === 3`, `synthesizer.dedupe === 'none'`, `diagnose.confidence_floor_for_prose === 0.6`.
  - A YAML with `synthesizer: { dedupe: embeddings }` throws `ConfigError` whose message contains `dedupe`.
  - `synthesizer: { max_file_head_bytes: 0 }` throws (message contains `max_file_head_bytes`).
  - `synthesizer: { top_n: 0 }` throws.
  - `diagnose: { confidence_floor_for_prose: 1.5 }` throws.
  - An unknown top-level key `foo: bar` still throws `Unknown config key`.
- [ ] **Step 2: Run tests to verify failure**
  Run: `npx vitest run test/config.test.ts`
  Expected: the new cases FAIL (defaults absent / no validation).
- [ ] **Step 3: Implement**
  Add the defaults, the `KNOWN_TOP_KEYS` entry, and the validation rules exactly as specified. Mirror the existing per-field `ConfigError` pattern.
- [ ] **Step 4: Run tests to verify pass**
  Run: `npx vitest run test/config.test.ts`
  Expected: PASS (all new + existing config cases).
- [ ] **Step 5: Commit**
  `git add src/config.ts test/config.test.ts && git commit -m "feat(config): synthesizer block + confidence_floor_for_prose + validation"`

---

### Task 3: Refactor — extract `collectEnvelopes` from `runScan`

**Files:**
- Modify: `src/pipeline.ts`
- Test: `test/pipeline.test.ts`, `test/__snapshots__/` (must remain unchanged)

**Interfaces:**
- Produces: `collectEnvelopes(opts: { repo?: string; since?: string; limit?: number; harness: HarnessId; harnessDir?: string; claudeDir?: string; configPath?: string }): Promise<{ envelopes: NormalizedEnvelope[]; warnings: Warnings; filterRepo: string }>`. It performs walk → stream → resolve-main-repo → relativize → `--since`/`--limit` filtering and computes the scoped `unresolvable_cwd` warning, returning the resolved output repo as `filterRepo`. `runScan` is rewritten to call `collectEnvelopes`, then run detect → aggregate → diagnose → output (its observable output is byte-identical). The bogus-`--repo` `ConfigError` still throws out of `collectEnvelopes`.
- Consumes: existing `resolveHarness`, `discoverForSpec`, `resolveRepo`/`resolveMainRepo`, `relativizeEnvelopeFiles` (unchanged).

- [ ] **Step 1: Write the failing tests**
  - A golden/snapshot assertion that `runScan` output for an existing fixture is **byte-identical** before vs after (the existing `snapshot.test.ts` / `pipeline-harness.test.ts` serve this — they must still pass unchanged).
  - A new unit test: `collectEnvelopes({...})` on a fixture dir returns the expected `envelopes.length`, a `filterRepo` equal to the resolved repo, and a `warnings` object. Expected: the count matches the fixture's session count; `filterRepo` is the fixture repo root.
- [ ] **Step 2: Run tests to verify failure**
  Run: `npx vitest run test/pipeline.test.ts`
  Expected: the new `collectEnvelopes` case FAILS (not exported).
- [ ] **Step 3: Implement**
  Move the I/O + filtering block of `runScan` (transcript discovery, streaming, repo resolution, relativization, `--since`/`--limit`, scoped `unresolvable_cwd`) into `collectEnvelopes` with the signature above. `runScan` calls it, then proceeds to `runDetector` → `aggregateAreas` → diagnose → output formatting. Keep the `--repo`-resolution `ConfigError`. Do not alter any output string.
- [ ] **Step 4: Run tests to verify pass**
  Run: `npx vitest run test/pipeline.test.ts test/snapshot.test.ts test/pipeline-harness.test.ts`
  Expected: PASS — snapshots unchanged, new `collectEnvelopes` case passes.
- [ ] **Step 5: Commit**
  `git add src/pipeline.ts test/pipeline.test.ts && git commit -m "refactor(pipeline): extract collectEnvelopes shared by scan/synthesize/explain"`

---

### Task 4: Detector — collect `docs_read` / `docs_injected`

**Files:**
- Modify: `src/detector/record.ts`, `src/detector/index.ts`, `src/pipeline.ts` (`degenerateRecord`)
- Test: `test/detector.test.ts`

**Interfaces:**
- Consumes: `DocRead`/`DocInjection`/`StruggleRecord` from Task 1; `NormalizedEvent` (has `t`, `kind`, `tool`, `input_digest.files`); `Config.docs_dirs`.
- Produces: every `StruggleRecord` carries `docs_read` (distinct `{ path, t }` for read-events whose file is under any `docs_dirs` entry, `t` = the event's `t`) and `docs_injected: []` (reserved). `assembleStruggleRecord` gains `docs_read: DocRead[]` and `docs_injected: DocInjection[]` params (both required). `degenerateRecord` returns `docs_read: []`, `docs_injected: []`.

- [ ] **Step 1: Write the failing tests** (in `test/detector.test.ts`)
  - A session envelope that contains read-events on `docs/architecture/billing.md` (twice) and `src/billing/charge.ts` → the record's `docs_read` contains exactly one entry `{ path: 'docs/architecture/billing.md', t: <first such event's t> }`; `src/...` is excluded; `docs_injected` is `[]`.
  - A session with no doc reads → `docs_read: []`, `docs_injected: []`.
  - `degenerateRecord(...)` (via the reflect fail-open path) yields `docs_read: []`, `docs_injected: []`.
- [ ] **Step 2: Run tests to verify failure**
  Run: `npx vitest run test/detector.test.ts`
  Expected: FAIL — fields absent.
- [ ] **Step 3: Implement**
  In the detector, compute `docs_read` from the envelope's read-events (tool === 'read', file under a `docs_dirs` entry), dedupe by path keeping the earliest `t`. Thread `docs_read`/`docs_injected` through `assembleStruggleRecord`; update its call site in `runDetector`; set both fields on `degenerateRecord`.
- [ ] **Step 4: Run tests to verify pass**
  Run: `npx vitest run test/detector.test.ts && npm run typecheck`
  Expected: PASS; typecheck clean (all `StruggleRecord` construction sites updated).
- [ ] **Step 5: Commit**
  `git add src/detector/record.ts src/detector/index.ts src/pipeline.ts test/detector.test.ts && git commit -m "feat(detector): collect timing-bearing docs_read/docs_injected"`

---

### Task 5: Router — pure pointer renderer

**Files:**
- Create: `src/router/pointer.ts`
- Test: `test/pointer.test.ts`

**Interfaces:**
- Produces: `renderPointer(unit: { kind: 'area'; key: string }, docPath: string | null): string`. With a doc: returns a string containing the backticked area key and the doc path, e.g. `` "Before editing `src/billing/`, read `docs/architecture/billing.md`." ``. With `docPath === null`: returns a suggestion string naming the unit and proposing `synthesize`. Pure (no I/O).

- [ ] **Step 1: Write the failing test**
  - `renderPointer({kind:'area',key:'src/billing'}, 'docs/architecture/billing.md')` returns a string that includes both `` `src/billing/` `` and `docs/architecture/billing.md`.
  - `renderPointer({kind:'area',key:'src/billing'}, null)` returns a string that includes `src/billing` and the word `synthesize`.
- [ ] **Step 2: Run test to verify failure**
  Run: `npx vitest run test/pointer.test.ts`
  Expected: FAIL (module missing).
- [ ] **Step 3: Implement**
  Create `src/router/pointer.ts` exporting `renderPointer` with the behavior above. No I/O, no imports beyond types.
- [ ] **Step 4: Run test to verify pass**
  Run: `npx vitest run test/pointer.test.ts`
  Expected: PASS.
- [ ] **Step 5: Commit**
  `git add src/router/pointer.ts test/pointer.test.ts && git commit -m "feat(router): pure pointer renderer shared by explain + future hook"`

---

### Task 6: Proposal schema + validator

**Files:**
- Create: `src/synthesizer/proposal.ts`
- Test: `test/proposal.test.ts`

**Interfaces:**
- Consumes: `Proposal`, `Cause` from Task 1.
- Produces: `assertNewDocProposal(obj: unknown): Proposal` — validates a parsed object is a well-formed new-doc proposal, else throws `Error` with a message naming the first missing/wrong field. Validation rules: `kind === 'new-doc'`; `path` is a non-empty string; `frontmatter.derived_from` is a string array; `frontmatter.unit.key` non-empty string; `frontmatter.struggle_score` a number; `frontmatter.cause` is a `Cause`; `frontmatter.source_files` string array; `frontmatter.created` non-empty string; `body` non-empty string; `cited_symbols` string array; `referenced_paths` string array; `dedupe` is an object with `decision_rationale` string (`nearest_existing` string|null, `similarity` optional number); `verification` is an object with the three booleans. Also export `isEditProposal(obj): boolean` (true iff `obj.kind === 'edit-proposal'`) so the orchestrator can route those to a "needs human" note.

- [ ] **Step 1: Write the failing tests**
  - A valid new-doc object (all fields populated) → `assertNewDocProposal` returns a `Proposal` with those fields.
  - Object missing `cited_symbols` → throws (message references the field).
  - Object with `kind: 'edit-proposal'` → `isEditProposal` returns `true`; `assertNewDocProposal` throws.
  - `frontmatter.cause: 'nonsense'` → throws.
- [ ] **Step 2: Run tests to verify failure**
  Run: `npx vitest run test/proposal.test.ts`
  Expected: FAIL (module missing).
- [ ] **Step 3: Implement**
  Create `src/synthesizer/proposal.ts` with the validator + `isEditProposal`. Validate field-by-field; throw on the first problem with a precise message.
- [ ] **Step 4: Run tests to verify pass**
  Run: `npx vitest run test/proposal.test.ts`
  Expected: PASS.
- [ ] **Step 5: Commit**
  `git add src/synthesizer/proposal.ts test/proposal.test.ts && git commit -m "feat(synthesizer): Proposal schema validator (new-doc)"`

---

### Task 7: Fact-check

**Files:**
- Create: `src/synthesizer/factcheck.ts`
- Test: `test/factcheck.test.ts`

**Interfaces:**
- Consumes: `Proposal`, `FactCheckResult`, `FactCheckFailure` from Task 1; the repo at HEAD.
- Produces:
  - `factCheck(proposal: Proposal, repoRoot: string, docsDirs: string[]): FactCheckResult` — returns `{ failures: [...] }`. For each symbol in `proposal.cited_symbols`: resolved = the symbol appears as a token in the concatenated content of the files in `proposal.frontmatter.source_files` (path part before `@`); on miss, push a `{ assertion: <symbol>, kind: 'symbol', resolved: false, detail: 'not found in cited source files' }`. For each path in `proposal.referenced_paths`: resolved = the path exists under `repoRoot`; the proposal's own `path` is **exempt** from existence but must resolve **under a configured docs dir** (else a `kind:'path'` failure). For each `source_files` entry of form `path@sha`: resolved = `sha` is a valid commit (via git, sandboxed like `src/git.ts`); on miss, `kind:'sha'` failure.
  - `verificationFrom(result: FactCheckResult): { cited_symbols_resolved: boolean; paths_resolved: boolean; shas_valid: boolean }` — each boolean is `!result.failures.some(f => f.kind === <that kind> && !f.resolved)`.

- [ ] **Step 1: Write the failing tests** (use a fixture repo dir with known files)
  - A proposal whose `cited_symbols` are present in the cited fixture file, whose `referenced_paths` exist, whose `path` is under `docs/`, and whose `source_files@sha` is HEAD → `failures` is empty; `verificationFrom(result)` is all-`true`.
  - A proposal citing a symbol absent from the fixture file → one `kind:'symbol'` failure with `resolved:false`; `verificationFrom` → `cited_symbols_resolved:false`, others true.
  - A `source_files` entry with a bogus sha → a `kind:'sha'` failure.
  - A `path` outside all `docs_dirs` → a `kind:'path'` failure.
- [ ] **Step 2: Run tests to verify failure**
  Run: `npx vitest run test/factcheck.test.ts`
  Expected: FAIL (module missing).
- [ ] **Step 3: Implement**
  Create `src/synthesizer/factcheck.ts`. Read the cited files (heads only is fine — full file content for symbol match is acceptable in MVP), check path existence with `fs`, validate SHAs via sandboxed git (`git -C <repo> cat-file -e <sha>` style, mirroring `src/git.ts` sandbox flags). Build the `failures` array; never throw (return a result with failures).
- [ ] **Step 4: Run tests to verify pass**
  Run: `npx vitest run test/factcheck.test.ts`
  Expected: PASS.
- [ ] **Step 5: Commit**
  `git add src/synthesizer/factcheck.ts test/factcheck.test.ts && git commit -m "feat(synthesizer): deterministic fact-check gate"`

---

### Task 8: Backend adapter — resolve + run + per-harness unwrap

**Files:**
- Create: `src/synthesizer/backend.ts`
- Test: `test/backend.test.ts`

**Interfaces:**
- Consumes: `HarnessId`, `Config` from earlier tasks.
- Produces:
  - `resolveBackend(harness: HarnessId, cfg: Config): { cmd: string; args: string[] }` — if `cfg.synthesizer.backend` is non-null, it wins (split on spaces into cmd + args); else the per-harness default: `claude-code` → `{cmd:'claude', args:['-p','--output-format','json']}`; `qwen-code` → `{cmd:'qwen', args:['-p','-o','json']}`; `gigacode` → `{cmd:'gigacode', args:['-p','-o','json']}`. A non-null `cfg.synthesizer.model` appends `-m <model>` (or the harness-appropriate model flag — for defaults use `-m`).
  - `runBackend({ cmd, args, prompt, cwd }: { cmd: string; args: string[]; prompt: string; cwd: string }): Promise<string>` — spawns `cmd` with `args` via `node:child_process` (no shell), writes `prompt` to stdin, returns stdout. **Throws** an `Error` on non-zero exit, missing binary (ENOENT), or empty stdout. The orchestrator catches and degrades. `child_process` is imported here (inside `src/synthesizer/*`, satisfying egress).
  - `extractProposal(stdout: string, harness: HarnessId): unknown` — per-harness envelope unwrap: `claude-code` → `JSON.parse(stdout)` then take `.result` (a JSON string) and `JSON.parse` it again; `qwen-code` → parse the Gemini-lineage envelope and extract the model text field (then the caller JSON-parses it as the proposal object); `gigacode` → same path as `qwen-code` (unverified; documented).

- [ ] **Step 1: Write the failing tests**
  - `resolveBackend('claude-code', defaultCfg)` → `{ cmd:'claude', args:['-p','--output-format','json'] }`; `resolveBackend('qwen-code', defaultCfg)` → qwen defaults; override `cfg.synthesizer.backend='codex -p'` → `{cmd:'codex', args:['-p', ...json args?] }` (override replaces cmd/args base; document exact split behavior).
  - `extractProposal(claudeEnvelope, 'claude-code')` where `claudeEnvelope = JSON.stringify({ type:'result', result: JSON.stringify({kind:'new-doc', ...}) })` → returns the inner `{kind:'new-doc',...}` object.
  - `extractProposal(qwenEnvelope, 'qwen-code')` with a fixture gemini-lineage envelope → returns the inner proposal object.
  - `runBackend` with a stubbed spawner (inject a `spawn` seam — design `runBackend` to accept an optional `spawnFn` for testing) returning non-zero → throws; returning stdout → returns it.
- [ ] **Step 2: Run tests to verify failure**
  Run: `npx vitest run test/backend.test.ts`
  Expected: FAIL (module missing).
- [ ] **Step 3: Implement**
  Create `src/synthesizer/backend.ts`. `runBackend` takes an injectable `spawnFn` (defaulting to the real `child_process.spawn`) so it is unit-testable without firing a model call. Implement unwrap per harness. Import `child_process` here only.
- [ ] **Step 4: Run tests to verify pass**
  Run: `npx vitest run test/backend.test.ts && npx vitest run test/egress.test.ts`
  Expected: PASS; egress test still green (`child_process` only in `src/synthesizer/*`).
- [ ] **Step 5: Commit**
  `git add src/synthesizer/backend.ts test/backend.test.ts && git commit -m "feat(synthesizer): per-harness backend adapter + envelope unwrap"`

---

### Task 9: Evidence bundle (prompt assembly)

**Files:**
- Create: `src/synthesizer/bundle.ts`
- Test: `test/bundle.test.ts`

**Interfaces:**
- Consumes: `Diagnosis`, `StruggleRecord`, `Config`, `Proposal` contract (so the prompt asks for the right fields), `src/adapter/scrub.ts`.
- Produces: `buildBundle({ diagnosis, records, unitKey, repoRoot, cfg }: { diagnosis: Diagnosis; records: StruggleRecord[]; unitKey: string; repoRoot: string; cfg: Config }): string`. The returned string is the prompt sent to the backend. It MUST contain: the area key; the diagnosed `cause` + `confidence` + `rationale` + `evidence_refs`; the unit's aggregate signals; the docs inventory (paths **and size-capped bodies** under `cfg.docs_dirs`, sent regardless of `structure_only`); repo file-heads under the area prefix (capped at `cfg.synthesizer.max_file_head_bytes` per file, scrubbed; when `structure_only` is true, source files are heads-only — the default behavior — and a note says no full bodies). It MUST instruct the backend to return a JSON object matching the new-doc `Proposal` schema (including `cited_symbols` and `referenced_paths`). It MUST NOT contain the literal `fetch(`.

- [ ] **Step 1: Write the failing tests**
  - `buildBundle(...)` output includes the `unitKey`, the `cause` string, each doc path from the inventory, and the instruction to populate `cited_symbols`.
  - With `structure_only: false` vs `true`, the source-file portion differs as specified (heads-only in both for MVP, but `structure_only:true` adds the "no full bodies" note) — assert the note presence/absence.
  - A doc body larger than the cap is truncated (output length bounded).
  - The output does not contain the substring `fetch(`.
- [ ] **Step 2: Run test to verify failure**
  Run: `npx vitest run test/bundle.test.ts`
  Expected: FAIL (module missing).
- [ ] **Step 3: Implement**
  Create `src/synthesizer/bundle.ts`. Read doc bodies + source heads via `node:fs`, cap per file, scrub via `scrub.ts`. Compose the prompt string. No `child_process` (pure string assembly + bounded reads).
- [ ] **Step 4: Run test to verify pass**
  Run: `npx vitest run test/bundle.test.ts`
  Expected: PASS.
- [ ] **Step 5: Commit**
  `git add src/synthesizer/bundle.ts test/bundle.test.ts && git commit -m "feat(synthesizer): evidence-bundle prompt assembly"`

---

### Task 10: Synthesizer orchestration — `runSynthesize`

**Files:**
- Create: `src/synthesizer/index.ts`
- Modify: `src/pipeline.ts` (export seam if needed)
- Test: `test/synthesize.test.ts`

**Interfaces:**
- Consumes: `collectEnvelopes` (T3), `runDetector` + `diagnoseUnits` (existing), `buildBundle` (T9), `resolveBackend`/`runBackend`/`extractProposal` (T8), `assertNewDocProposal`/`isEditProposal` (T6), `factCheck`/`verificationFrom` (T7), `Config` (T2).
- Produces:
  - `SynthesizeOptions = { repo?: string; unit?: string; harness?: HarnessId; harnessDir?: string; claudeDir?: string; configPath?: string; yes?: boolean; runBackendFn?: typeof runBackend }` (the injectable backend lets tests avoid a real model call).
  - `SynthesizeResult = { output: string; exitCode: 0 | 1; proposals: string[] }` (`proposals` = written proposal paths).
  - `runSynthesize(opts: SynthesizeOptions): Promise<SynthesizeResult>` — pipeline: `collectEnvelopes` → `runDetector` (collect `docs_read`) → `diagnoseUnits`; select units: if `opts.unit` set, target it; else the top `cfg.synthesizer.top_n` units with `cause ∈ {doc,config-doc}` AND `confidence ≥ cfg.diagnose.confidence_floor_for_prose`. For each selected unit: `buildBundle` → `resolveBackend` → `runBackend` (try/catch → on throw, append a digest entry + continue) → `extractProposal`; if `isEditProposal` → write a "needs human" note (no doc); else `assertNewDocProposal` → `factCheck`; if `factCheck` has unresolved failures → write a "needs human" note listing them; else write the new-doc proposal to `docs/_proposals/<safeArea>-<cause>-<shortHash>.md` with frontmatter (`derived_from`, `unit`, `struggle_score`, `cause`, `source_files@sha`, `created`, `verification`). Non-qualifying units → appended to a single `docs/_proposals/_digest.md`. Fail-open: any unexpected throw → clean `output` message + `exitCode: 1`, never crashes.

- [ ] **Step 1: Write the failing tests** (inject `runBackendFn` returning a canned new-doc JSON)
  - Given a fixture repo + a stubbed backend returning a valid new-doc Proposal whose cited symbols/paths/shas all resolve → `runSynthesize` writes exactly one file under `docs/_proposals/`, returns its path in `proposals`, `exitCode: 0`; the file's frontmatter has the correct `cause`/`unit`/`verification` all-true.
  - Stubbed backend returning a Proposal whose `cited_symbols` do NOT resolve → no doc file; a "needs human" note is written naming the failing symbol; `exitCode: 0`.
  - A unit whose `cause` is `refactor-flag` (or confidence below floor) → no backend call (assert the injected `runBackendFn` was not called for it); a digest entry is written.
  - `runBackendFn` that throws → a digest entry + `exitCode: 0` (fail-open).
- [ ] **Step 2: Run tests to verify failure**
  Run: `npx vitest run test/synthesize.test.ts`
  Expected: FAIL (module missing).
- [ ] **Step 3: Implement**
  Create `src/synthesizer/index.ts` composing the pipeline above. Write proposals/notes/digest via `node:fs`. Never throw past a try/catch that yields a `SynthesizeResult`.
- [ ] **Step 4: Run tests to verify pass**
  Run: `npx vitest run test/synthesize.test.ts && npm run typecheck`
  Expected: PASS; typecheck clean.
- [ ] **Step 5: Commit**
  `git add src/synthesizer/index.ts test/synthesize.test.ts && git commit -m "feat(synthesizer): runSynthesize orchestration (prose gate, fact-check, write)"`

---

### Task 11: `explain` (routing lite)

**Files:**
- Create: `src/explain.ts`
- Test: `test/explain.test.ts`

**Interfaces:**
- Consumes: `collectEnvelopes` (T3), `runDetector` (with `docs_read`, T4), `diagnoseUnits`, `renderPointer` (T5), `Config`.
- Produces: `ExplainOptions = { unit: string; repo?: string; harness?: HarnessId; harnessDir?: string; claudeDir?: string; configPath?: string }`; `ExplainResult = { output: string; exitCode: 0 | 1 }`. `runExplain(opts): Promise<ExplainResult>` — `collectEnvelopes` → `runDetector` → `diagnoseUnits`; find the diagnosis whose `unit.key === opts.unit`; render: the cause + `renderPointer(unit, docPath)` + the body of the doc if one exists under a `docs_dir` matching the unit + a line "N prior sessions consulted `<docPath>`" derived from the records' `docs_read` (count of distinct sessions whose `docs_read` contains that path). If no doc exists, pointer's null-branch + suggestion. Fail-open on any throw.

- [ ] **Step 1: Write the failing tests**
  - A fixture where the unit has a doc at `docs/architecture/<x>.md` and ≥1 prior session read it → output contains the pointer (area key + doc path), the doc body's first line, and `"N prior sessions consulted"` with N ≥ 1.
  - A unit with no doc → output contains the suggestion mentioning `synthesize`.
  - Unknown unit → a clean "no diagnosis for <unit>" message, `exitCode: 0`.
- [ ] **Step 2: Run test to verify failure**
  Run: `npx vitest run test/explain.test.ts`
  Expected: FAIL (module missing).
- [ ] **Step 3: Implement**
  Create `src/explain.ts`. Compose detect+diagnose via `collectEnvelopes`+`runDetector`+`diagnoseUnits`; read the doc body with `node:fs` if present; compute the consultation count from records; format with `renderPointer`.
- [ ] **Step 4: Run test to verify pass**
  Run: `npx vitest run test/explain.test.ts`
  Expected: PASS.
- [ ] **Step 5: Commit**
  `git add src/explain.ts test/explain.test.ts && git commit -m "feat(explain): routing-lite command with docs_read surface"`

---

### Task 12: `review` (Curator lite)

**Files:**
- Create: `src/review.ts`
- Test: `test/review.test.ts`

**Interfaces:**
- Consumes: `Proposal` (T1) for the frontmatter/path contract; `Config` (`docs_dirs` for path validation).
- Produces: `ReviewOptions = { repo?: string; configPath?: string; json?: boolean; yes?: boolean }`; `ReviewResult = { output: string; exitCode: 0 | 1 }`. `runReview(opts): Promise<ReviewResult>` — lists `docs/_proposals/*.md` (excluding `_digest.md`), parses each file's YAML frontmatter → `{ path, cause, confidence, evidence_refs?, verification }`; `--json` emits that list as JSON; otherwise prints a numbered list showing cause + confidence + verification + the evidence_refs summary. Accept (interactive or `--yes`) moves the file to its frontmatter `path` (validated to be under a `docs_dir`; on violation, error + do not move). Reject deletes the file. `--yes` accepts all non-interactively. Fail-open.

- [ ] **Step 1: Write the failing tests** (use a temp `docs/_proposals/` fixture)
  - `runReview({ json:true })` lists a fixture proposal with its `cause`, `confidence`, and `verification` booleans.
  - `runReview({ yes:true })` on a fixture proposal whose `path` is under `docs/` moves the file to that path (source removed from `_proposals/`, target exists).
  - A proposal whose `path` is outside `docs_dirs` → accept is refused with a clear message, file stays.
  - Reject removes the file.
- [ ] **Step 2: Run test to verify failure**
  Run: `npx vitest run test/review.test.ts`
  Expected: FAIL (module missing).
- [ ] **Step 3: Implement**
  Create `src/review.ts`. Parse frontmatter (the `yaml` dep already in tree). Move/delete via `node:fs`. Validate the destination path is under a `docs_dir`.
- [ ] **Step 4: Run test to verify pass**
  Run: `npx vitest run test/review.test.ts`
  Expected: PASS.
- [ ] **Step 5: Commit**
  `git add src/review.ts test/review.test.ts && git commit -m "feat(review): accept/reject proposals, surface cause+evidence+verification"`

---

### Task 13: CLI wiring — `synthesize` / `review` / `explain` commands

**Files:**
- Modify: `src/cli.ts`
- Test: `test/cli.test.ts` (or `test/cli-harness.test.ts`)

**Interfaces:**
- Consumes: `runSynthesize` (T10), `runReview` (T12), `runExplain` (T11); existing `validateHarnessFlags` / harness resolution.
- Produces: three new `program.command(...)` entries mirroring the existing `scan`/`reflect` structure (load config, resolve harness flags, call the runner, write `result.output` + exit via the flush callback, catch → `error: <msg>` + exit 1). `synthesize` takes `--repo`, `--unit`, `--harness`, `--harness-dir`, `--claude-dir`, `--yes`, `--config`. `review` takes `--repo`, `--json`, `--yes`, `--config`. `explain` takes `<area>` positional + `--repo`, `--harness`, `--harness-dir`, `--claude-dir`, `--config`.

- [ ] **Step 1: Write the failing tests**
  - `harnessgap synthesize --help` lists `--unit`, `--harness`, `--yes`.
  - `harnessgap review --help` lists `--json`, `--yes`.
  - `harnessgap explain --help` shows the `<area>` positional.
  - A dispatch test (stubbed runners or fixture) confirms each command routes opts to the right runner and prints its `output`.
- [ ] **Step 2: Run tests to verify failure**
  Run: `npx vitest run test/cli.test.ts`
  Expected: FAIL (commands absent).
- [ ] **Step 3: Implement**
  Add the three commands to `src/cli.ts` following the existing action/exit/flush pattern. Reuse `validateHarnessFlags` for the harness-bearing commands.
- [ ] **Step 4: Run tests to verify pass**
  Run: `npx vitest run test/cli.test.ts && npm run build`
  Expected: PASS; build clean.
- [ ] **Step 5: Commit**
  `git add src/cli.ts test/cli.test.ts && git commit -m "feat(cli): synthesize/review/explain commands"`

---

### Task 14: Egress test extension + docstrings

**Files:**
- Modify: `test/egress.test.ts`, `src/egress.ts`
- Test: the egress test itself.

**Interfaces:**
- Consumes: `src/synthesizer/*` now exists (T8–T10) and imports `child_process`.
- Produces: `test/egress.test.ts` additionally asserts (a) any `import ... from 'node:child_process'` (or `require('child_process')`) in `src/` occurs **only** in files under `src/synthesizer/` **or** in `src/git.ts` (see the Global Constraint refinement note — Task 7 placed `isValidSha` there); (b) no file in `src/` imports `node:http` / `node:https` / `undici` or calls global `fetch(`. The `src/egress.ts` header comment + the test's docstring state the gate guards the **default path only** — opt-in `synthesize` egress is bounded by `child_process` + the trusted agent CLI.

- [ ] **Step 1: Write the failing test** (the new child_process-scoping assertion)
  Expected initially: PASS if `child_process` is currently only in `src/synthesizer/*` (it is, after T8) — so frame the test as a guard that a stray `child_process` import outside `src/synthesizer/` fails the suite (seed a negative case mentally; the assertion is "no offender paths"). Add the docstring updates.
- [ ] **Step 2: Run test**
  Run: `npx vitest run test/egress.test.ts`
  Expected: PASS (guards in place). If it fails, a `child_process` import leaked outside `src/synthesizer/` — fix the offender.
- [ ] **Step 3: Implement** (docstring/comment updates in `src/egress.ts` + test)
  State the default-path-only scope verbatim.
- [ ] **Step 4: Run full egress + typecheck**
  Run: `npx vitest run test/egress.test.ts && npm run typecheck`
  Expected: PASS.
- [ ] **Step 5: Commit**
  `git add test/egress.test.ts src/egress.ts && git commit -m "test(egress): scope child_process to src/synthesizer; default-path-only gate"`

---

### Task 15: Corpus extension (detector correctness fixtures)

**Files:**
- Modify: `test/fixtures/corpus/labels.json`, `test/fixtures/corpus/sessions.ts`, `test/corpus.test.ts`
- Test: `test/corpus.test.ts`

**Interfaces:**
- Consumes: existing corpus schema (struggle/clean labels).
- Produces: ≥2 new labeled fixture sessions (one clear struggle, one clean) covering the loop-relevant shapes (e.g. a session with heavy re-reads of an undoc'd area → struggle/doc; a short clean edit session → clean), and `corpus.test.ts` asserts the detector flags/doesn't-flag them correctly. This doubles as #34's recall-substitute seed.

- [ ] **Step 1: Write the failing test**
  - The new struggle fixture is flagged (`record.flagged === true`) and localizes to the intended area; the new clean fixture is not flagged.
- [ ] **Step 2: Run test to verify failure**
  Run: `npx vitest run test/corpus.test.ts`
  Expected: FAIL (fixtures absent / assertions new).
- [ ] **Step 3: Implement**
  Add the two fixture sessions + labels; ensure `corpus.test.ts` covers them.
- [ ] **Step 4: Run test to verify pass**
  Run: `npx vitest run test/corpus.test.ts`
  Expected: PASS.
- [ ] **Step 5: Commit**
  `git add test/fixtures/corpus test/corpus.test.ts && git commit -m "test(corpus): add struggle/clean loop-relevant fixtures (recall-substitute seed)"`

---

### Task 16: Doc / identity / calibration updates (slice exit-criteria)

**Files:**
- Modify: `CLAUDE.md`, `package.json`, `README.md`, `docs/CONSUMER_GUIDE.md`, `docs/ARCHITECTURE.md`
- Create: `docs/CALIBRATION.md`
- (Issue #34 comment — manual/`gh`)

**Interfaces:**
- Consumes: §13.5 of the spec (the full list).
- Produces:
  - `CLAUDE.md` + `package.json` description: "detection-only / no writes / no network" → the loop now writes + shells out (default path stays pure; opt-in commands cross the boundary). Scope the "no network" claim to the default path.
  - README + CONSUMER_GUIDE: "synthesis/routing/measurement deferred to later slices" → synthesis ships; "`synthesizer` key rejected / five top-level keys" → accepted / six; privacy sections state evidence + file-heads leave via the agent CLI subprocess; "byte-identical when off" → "human table byte-identical; `--json` gains `docs_read`/`docs_injected`".
  - ARCHITECTURE: module map + §3 pipeline gain `synthesize`/`review`/`explain`/`Proposal`/`synthesizer` config.
  - `docs/CALIBRATION.md`: accepted-risk record — precision unvalidated; mitigations (percentile auto-calibration + prose-gate + confidence floor + fact-check); recall-substitute (labeled fixtures + read-the-transcript labeling) to close #34 Phases 1 & 3 later.
  - Comment on issue #34 (via `gh issue comment 34 --repo HumanBean17/harnessgap`): deferred-with-reason + what ships instead + recall-substitute plan.

- [ ] **Step 1: Write the failing test** (a docs-link/claim grep test, or fold into existing `test/packaging.test.ts`)
  - Assert no remaining occurrence of the now-false strings in README/CONSUMER_GUIDE/CLAUDE.md/package.json (e.g. "detection-only" standing alone, "synthesizer.*rejected", "five top-level keys") — or, where the claim is intentionally scoped, that it now mentions the opt-in loop.
- [ ] **Step 2: Run test to verify failure**
  Run: `npx vitest run test/packaging.test.ts` (or the docs test)
  Expected: FAIL (stale claims present).
- [ ] **Step 3: Implement**
  Apply every §13.5 update; create `docs/CALIBRATION.md`. Post the #34 comment last (manual confirmation step — surface it, don't auto-post if uncertain).
- [ ] **Step 4: Run test + full suite**
  Run: `npm test && npm run typecheck && npm run build`
  Expected: all PASS.
- [ ] **Step 5: Commit**
  `git add CLAUDE.md package.json README.md docs/ && git commit -m "docs: closed-loop identity/privacy/scope updates + calibration accepted-risk record"`

---

## Self-Review

**1. Code scan:** No method bodies, algorithms, or test code in any task — only signatures, types, data shapes, behavior descriptions, and expected test results. (Validator/fact-check/backend steps describe *what* is checked/run, not the loop body.) ✅
**2. Self-containment:** Each task's Consumes/Produces repeats the exact shapes (e.g. `DocRead`, `Proposal`, `FactCheckResult`, `resolveBackend` return) so an implementer never leaves the task. ✅ (Task 10 re-states the pipeline inputs it composes.)
**3. Spec coverage:** §2 in-scope → T1–T14; §2 out-of-scope explicitly avoided (no edit-proposal apply, no TF-IDF, no live hook, no stats, no team jsonl, no pr, no index block, no `--dry-run`/`--keep`/`--structure-only` flag); §13.5 docs → T16; corpus → T15; egress extension → T14; collectEnvelopes → T3; pointer pure-fn → T5. Gap check: `confidence_floor_for_prose` gating → T10 consumes it (T2 defines it). ✅
**4. Placeholder scan:** no TBD/TODO/"add error handling" — each validation rule, failure kind, and test assertion is named. ✅
**5. Type consistency:** `DocRead`/`DocInjection` (T1) used identically in T4/T10/T11; `Proposal` (T1) used identically in T6/T7/T10/T12; `factCheck`→`FactCheckResult` (T7) consumed in T10; `resolveBackend`/`runBackend`/`extractProposal` (T8) consumed in T10; `renderPointer` (T5) consumed in T11; `collectEnvelopes` (T3) consumed in T10/T11. ✅

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/active/2026-07-24-mvp-closed-loop.md`. Per the user's directive, execution is **subagent-driven** (superpowers:subagent-driven-development) — fresh subagent per task with review between tasks, following the dependency graph above.
