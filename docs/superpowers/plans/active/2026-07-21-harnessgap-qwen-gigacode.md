# Qwen Code + GigaCode Adapter Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Qwen Code and GigaCode as first-class harness sources with full Claude parity (scan + init + reflect), behind a `HarnessSpec` dispatcher seam, without changing the detector/scorer/output core.

**Architecture:** A new `src/adapter/index.ts` dispatcher resolves a `HarnessSpec` per `HarnessId`. Claude's existing parser/taxonomy/stream are repackaged behind the same shape; a new self-contained `src/adapter/qwen/` handles the Gemini-style format (`message.parts[]`, `functionCall`/`functionResponse`, parallel calls paired by call id, outcomes in `ui_telemetry`). GigaCode reuses the Qwen adapter with `~/.gigacode` + `GIGACODE.md`. Discovery generalizes to a `TranscriptLayout`. Everything downstream of `NormalizedEvent[]` is untouched.

**Tech Stack:** Node ≥ 22.12, TypeScript 7, ESM (`"type": "module"`), commander 15, yaml 2, vitest 4. Build `tsc`; test `vitest run`; typecheck `tsc --noEmit`.

## Global Constraints

- **No network, no detection-path writes, no `git` invocation** in any source under `src/`. (The emitted init wrapper's `child_process` use lives inside a generated artifact string under the target `.qwen/`/`.claude/` dir, as today — not in `src/`'s egress surface.)
- **No new runtime dependencies.** `test/egress.test.ts` and `test/packaging.test.ts` must pass unmodified.
- **Privacy / fail-open preserved:** symlink rejection, prefix confinement, fail-open on missing dirs, scrubbing, and size caps (1 MB line / 5000 events / 50 MB file) all hold for the new sources. No raw transcript prose, commands, or file bodies in any output field.
- **Backward compatibility is a hard constraint:** bare `harnessgap scan` scans `~/.claude`; `--claude-dir` still works; Claude `--json` and human output are byte-identical to today.
- **File naming / record-shape contracts** are pinned to the spec §5.3 (Qwen on-disk record) and `src/types.ts` (normalized schema). Field names are contracts.
- Commit messages follow the existing convention (`feat:`, `test:`, `docs:`, `refactor:`). End commit messages with `Co-Authored-By: Claude <noreply@anthropic.com>`.
- After the final task, dispatch the `docs-watcher` subagent with the changed-files list (project `CLAUDE.md` session-end rule).

---

## File Structure

**New files**

| Path | Responsibility |
|---|---|
| `src/adapter/index.ts` | `HarnessSpec` instances + `resolveHarness(id)` dispatcher; the three capability matrices. |
| `src/adapter/qwen/taxonomy.ts` | `mapQwenToolKind(name): ToolKind`. |
| `src/adapter/qwen/parse.ts` | `parseQwenRecord(raw): QwenParsedItem[]` — one on-disk record → intermediate items. |
| `src/adapter/qwen/stream.ts` | `mergeQwenItems(items, meta): NormalizedEvent[]` (pure) + `streamQwenSession(filePath): NormalizedEnvelope` (I/O). |
| `src/init/qwen.ts` | `initQwen(opts)` / `initGigacode(opts)` — installer for `.qwen`/`.gigacode`. |
| `test/qwen-taxonomy.test.ts` | taxonomy unit. |
| `test/qwen-parse.test.ts` | parser unit. |
| `test/qwen-stream.test.ts` | merge + stream unit. |
| `test/harness-dispatch.test.ts` | dispatcher unit. |
| `test/cli-harness.test.ts` | `--harness`/`--harness-dir`/`--claude-dir` + `init qwen\|gigacode`. |
| `test/pipeline-harness.test.ts` | end-to-end scan dispatch + claude byte-identical. |
| `test/reflect-autodetect.test.ts` | reflect harness sniffing. |

**Modified files**

| Path | Change |
|---|---|
| `src/types.ts` | add `HarnessId`, `TranscriptLayout`, `CapabilityKey`, `CapabilityMatrix`, `HarnessSpec`, `InitResult`; widen `NormalizedEnvelope.agent`. |
| `src/walk.ts` | `defaultRootDir(id)`; generalize `discoverTranscripts(rootDir, layout?)`; keep `defaultClaudeDir()` as deprecated alias. |
| `src/config.ts` | accept + validate `harness:`; add to `DEFAULT_CONFIG` + `KNOWN_TOP_KEYS`. |
| `src/cli.ts` | `--harness`, `--harness-dir`, deprecated `--claude-dir` alias + conflict; widen `init <agent>`. |
| `src/pipeline.ts` | `runScan`/`runReflect` resolve the spec and route discovery/stream through it; stamp `agent` from spec; reflect auto-detect. |
| `src/output/hook.ts` | `formatStopHookOutput` parameterized by harness only if Qwen's Stop payload differs (Task 6 decision). |
| `test/helpers/builder.ts` | add `mkQwenSession(cwd, spec)` + `writeQwenTranscript(rootDir, slug, name, jsonl)`. |

---

## Task 1: Shared dispatch types + widen `agent`

**Files:**
- Modify: `src/types.ts`
- Test: `test/types-harness.test.ts` (new — type-level + runtime smoke)

**Interfaces:**
- Consumes: existing `NormalizedEnvelope`, `NormalizedEvent`.
- Produces (exact — added to `src/types.ts`, exported):
  - `export type HarnessId = 'claude-code' | 'qwen-code' | 'gigacode';`
  - `export interface TranscriptLayout { projectsSegment: 'projects'; sessionSubdir?: 'chats'; extension: '.jsonl'; }`
  - `export type CapabilityKey = 'sessionDiscovery' | 'streamFormat' | 'finalizationSignal' | 'interruption' | 'fileChangeEvidence' | 'resume' | 'perPromptContextInjection';`
  - `export type CapabilityMatrix = Record<CapabilityKey, 'supported' | 'pending'>;`
  - `export interface InitResult { harness: HarnessId; artifacts: string[]; settingsBackupPath?: string; degraded: boolean; message: string; }`
  - `export interface HarnessSpec { id: HarnessId; displayName: string; defaultRootDir(): string; layout: TranscriptLayout; streamSession(filePath: string): NormalizedEnvelope; installHook(opts: { cwd: string }): InitResult; capabilities: CapabilityMatrix; }`
  - Widen `NormalizedEnvelope.agent` from the literal `'claude-code'` to `agent: HarnessId`. **Every existing call site that stamps `agent: 'claude-code'` (`src/adapter/stream.ts:154`, `src/pipeline.ts:550`) still typechecks because `'claude-code'` is a member of the union.**

- [ ] **Step 1: Write the failing test**

`test/types-harness.test.ts` verifies: (a) `HarnessId` accepts exactly the three ids — a `const h: HarnessId = 'qwen-code'` compiles, and assigning `'foo'` is a type error (asserted via a `// @ts-expect-error` line); (b) a `TranscriptLayout` with `sessionSubdir: 'chats'` and one without both satisfy the interface; (c) `CapabilityMatrix` requires all seven `CapabilityKey` entries (constructing one missing `resume` is a `@ts-expect-error`). These are compile-time assertions; the runtime `it()` just constructs a valid value and `expect`s it deep-equals itself so vitest has a runnable test.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/types-harness.test.ts`
Expected: FAIL — `Cannot find name 'HarnessId'` / module `../src/types.js` has no exported member `HarnessId` (tsc/vitest error).

- [ ] **Step 3: Write minimal implementation**

Add the six exported types above to `src/types.ts`. Widen `NormalizedEnvelope.agent` to `HarnessId`. Do not change any logic or any other field.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/types-harness.test.ts && npm run typecheck`
Expected: PASS; `tsc --noEmit` clean across the repo (existing `'claude-code'` literals still valid).

- [ ] **Step 5: Commit**

`git add src/types.ts test/types-harness.test.ts`
`git commit -m "feat(types): add HarnessId/HarnessSpec dispatch types, widen agent"`

---

## Task 2: Generalize discovery (`walk.ts`)

**Files:**
- Modify: `src/walk.ts`
- Test: `test/walk.test.ts` (extend — add a `chats/`-layout case; existing Claude-layout cases must still pass unchanged)

**Interfaces:**
- Consumes: `TranscriptLayout`, `HarnessId` (Task 1).
- Produces (exact):
  - `export function defaultRootDir(id: HarnessId): string` — returns `path.join(os.homedir(), '.claude' | '.qwen' | '.gigacode')` for the three ids respectively.
  - `export function discoverTranscripts(rootDir: string, layout?: TranscriptLayout): { files: string[]; symlinks_rejected: number }` — `layout` defaults to `{ projectsSegment: 'projects', extension: '.jsonl' }` (the Claude layout), so existing single-argument callers (`src/pipeline.ts`) keep working untouched until Task 10. When `layout.sessionSubdir` is present, the session files are read from `<rootDir>/projects/<slug>/<sessionSubdir>/*.jsonl`; otherwise from `<rootDir>/projects/<slug>/*.jsonl` (today's behavior).
  - `defaultClaudeDir()` kept as a thin deprecated alias returning `defaultRootDir('claude-code')`.
  - **Invariants preserved verbatim:** `readdir({withFileTypes})` + `Dirent.isDirectory()` (skip symlinked slug/session dirs), `lstatSync` (reject symlinked files — never `statSync`), prefix-confinement to `<rootDir>/projects/`, fail-open (missing/unreadable → `{files:[], symlinks_rejected:0}`, never throw), lexicographic sort, `.jsonl` extension filter (this excludes `<uuid>.runtime.json`, `meta.json`, and `memory/` contents).

- [ ] **Step 1: Write the failing test**

Add to `test/walk.test.ts` a describe block "discoverTranscripts — chats/ layout (Qwen/GigaCode)". Scenario: build a tmp tree `<root>/projects/<slug>/chats/<a>.jsonl` plus sibling `<a>.runtime.json`, `<slug>/meta.json`, and `<slug>/memory/MEMORY.md`. Call `discoverTranscripts(root, { projectsSegment: 'projects', sessionSubdir: 'chats', extension: '.jsonl' })`. Expected: `files` is exactly `[<a>.jsonl]` (runtime.json, meta.json, memory excluded), `symlinks_rejected === 0`. Second scenario: a symlinked `.jsonl` under `chats/` is rejected (`symlinks_rejected === 1`, not in `files`). Third scenario: missing `projects/` dir → `{files:[], symlinks_rejected:0}` (fail-open, no throw).

Also add: `defaultRootDir('qwen-code')` endsWith `/.qwen`; `defaultRootDir('gigacode')` endsWith `/.gigacode`; `defaultRootDir('claude-code')` endsWith `/.claude`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/walk.test.ts`
Expected: FAIL — `defaultRootDir is not defined` / new cases fail because today's code ignores `chats/`.

- [ ] **Step 3: Write minimal implementation**

Add `defaultRootDir(id)`. Change `discoverTranscripts` to accept the optional `layout` param (default Claude layout), and thread `layout.sessionSubdir` into the path resolution so the extra level is read when present. Keep the existing `claudeDir`-named internal behavior via the defaulted layout. Preserve every invariant listed in Produces. Keep `defaultClaudeDir()` returning `defaultRootDir('claude-code')`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/walk.test.ts`
Expected: PASS — new `chats/` cases pass AND every pre-existing Claude-layout case still passes unchanged.

- [ ] **Step 5: Commit**

`git add src/walk.ts test/walk.test.ts`
`git commit -m "feat(walk): generalize discovery via TranscriptLayout (Qwen chats/)"`

---

## Task 3: Qwen tool taxonomy

**Files:**
- Create: `src/adapter/qwen/taxonomy.ts`
- Test: `test/qwen-taxonomy.test.ts`

**Interfaces:**
- Consumes: `ToolKind` (`src/types.ts`).
- Produces: `export function mapQwenToolKind(name: string): ToolKind` — fixed map:

  | arg name | result |
  |---|---|
  | `read_file` | `read` |
  | `list_directory` | `list` |
  | `edit`, `write_file` | `edit` |
  | `run_shell_command` | `exec` |
  | `grep_search`, `glob` | `search` |
  | `agent`, `todo_write`, `ask_user_question`, `skill` | `other` |
  | any other / empty / undefined | `other` |

- [ ] **Step 1: Write the failing test**

`test/qwen-taxonomy.test.ts` asserts each row above (one `it` per group): `read_file→read`, `list_directory→list`, `edit→edit` and `write_file→edit`, `run_shell_command→exec`, `grep_search→search` and `glob→search`, `agent/todo_write/ask_user_question/skill→other`, and unknown (`'mcp__x'`, `''`) → `other`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/qwen-taxonomy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/adapter/qwen/taxonomy.ts` exporting `mapQwenToolKind` over a fixed lookup, defaulting unknown to `'other'`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/qwen-taxonomy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

`git add src/adapter/qwen/taxonomy.ts test/qwen-taxonomy.test.ts`
`git commit -m "feat(qwen): tool-name → ToolKind taxonomy"`

---

## Task 4: Qwen record parser (record → intermediate items)

**Files:**
- Create: `src/adapter/qwen/parse.ts`
- Test: `test/qwen-parse.test.ts`

**Interfaces:**
- Consumes: `InputDigest` (`src/types.ts`), `mapQwenToolKind` (Task 3). The on-disk record shape is the contract in spec §5.3 (top-level `type`/`cwd`/`timestamp`/`sessionId`/`message.{role,parts[]}`/`subtype`/`systemPayload`/`toolCallResult`).
- Produces:
  - A discriminated union of intermediate items (exported from this module):
    - `{ kind: 'user_msg'; text: string; t: string; cwd: string }`
    - `{ kind: 'assistant_msg'; text: string; t: string; cwd: string }`
    - `{ kind: 'tool_call'; callId: string; toolName: string; inputDigest: InputDigest; t: string; cwd: string }`
    - `{ kind: 'tool_result'; callId: string; ok: boolean; t: string }`
    - `{ kind: 'telemetry_tool'; toolName: string; argsKey: string; durationMs: number; success: boolean; t: string }`
    - `{ kind: 'interrupt'; t: string }`
  - `export function parseQwenRecord(raw: unknown): QwenParsedItem[]` — pure; returns 0..N items per record. `argsKey` is a stable serialization of the call's args (used by the merge to match telemetry to a call); for `tool_call` it is the same serialization of `functionCall.args`, for `telemetry_tool` of `uiEvent.function_args`.
  - `inputDigest` extraction (per spec §5.3 table): `read_file.args.file_path→files`; `list_directory.args.path→files`; `edit.args.file_path→files` + lines_changed from `old_string`/`new_string`; `write_file.args.file_path→files` + lines from `content`; `run_shell_command.args.command→cmd`; `grep_search.args.pattern→query`; `glob.args.pattern→query`. `cmd`/`query`/`lines_changed` are `null` when absent; `files` is `[]` when absent. All extracted strings pass through the existing scrubbers (`scrubCmd`/`scrubQuery`/`scrubFiles` from `src/adapter/scrub.ts`) — reuse, do not reimplement.

- [ ] **Step 1: Write the failing test**

`test/qwen-parse.test.ts`, hand-written records (style of `test/parse.test.ts`), one `it` per mapping:
  1. `type:'user'`, `message.parts:[{text:'hello'}]` → exactly one `user_msg` with that text.
  2. `type:'user'` whose only part is a `functionResponse` → **zero** items (it is a result carrier, not a user message).
  3. `type:'assistant'`, one part `{text:'ok', thought:false}` → one `assistant_msg`. Same record with `{text:'thinking', thought:true}` → zero items (reasoning excluded).
  4. `type:'assistant'`, two `functionCall` parts (ids `call_A`, `call_B`, names `read_file`, `run_shell_command`) → two `tool_call` items with correct `toolName`/`callId`/`inputDigest` (`read_file`→`files:['/x']`; `run_shell_command`→`cmd:'ls -la'`).
  5. `type:'tool_result'`, `toolCallResult:{callId:'call_A', status:'success'}` → one `tool_result{callId:'call_A', ok:true}`. `status` other than `'success'` → `ok:false`.
  6. `subtype:'ui_telemetry'`, `uiEvent.event.name==='qwen-code.tool_call'`, `function_name:'read_file'`, `function_args:{file_path:'/x'}`, `duration_ms:22`, `success:true` → one `telemetry_tool` with `durationMs:22, success:true` and `argsKey` equal to the `argsKey` of the matching `tool_call` from case 4.
  7. `subtype:'ui_telemetry'`, `uiEvent.event.name==='qwen-code.api_error'`, `error_type:'APIUserAbortError'` → one `interrupt`. A non-abort `api_error` → zero items.
  8. `subtype:'slash_command'` / `'attribution_snapshot'` / `'file_history_snapshot'` → zero items.
  9. Malformed/non-object `raw` → zero items (no throw).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/qwen-parse.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/adapter/qwen/parse.ts` exporting the `QwenParsedItem` union and `parseQwenRecord`. Implement the mapping above; reuse scrubbers; tolerate missing/malformed fields (return `[]` on non-object input).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/qwen-parse.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

`git add src/adapter/qwen/parse.ts test/qwen-parse.test.ts`
`git commit -m "feat(qwen): on-disk record → intermediate item parser"`

---

## Task 5: Qwen merge + stream

**Files:**
- Create: `src/adapter/qwen/stream.ts`
- Test: `test/qwen-stream.test.ts`

**Interfaces:**
- Consumes: `QwenParsedItem`/`parseQwenRecord` (Task 4), `NormalizedEvent`/`NormalizedEnvelope` (`src/types.ts`), the correction detector (`detectCorrection` from `src/adapter/correction.ts` — reuse), size caps constants (1 MB line / 5000 events / 50 MB file — reuse the same values as `src/adapter/stream.ts`).
- Produces:
  - `export function mergeQwenItems(items: QwenParsedItem[], meta: { session_id: string; started_at: string; duration_ms: number; }): NormalizedEvent[]` — pure. The matching contract:
    - Each `user_msg` → `NormalizedEvent{ kind:'user_msg', tool:null, input_digest:{files:[],cmd:null,query:null,lines_changed:null}, ok:true, interrupted:false, duration_ms:0, correction: detectCorrection(text) }`.
    - Each `assistant_msg` → `NormalizedEvent{ kind:'assistant_msg', tool:null, input_digest:empty, ok:true, interrupted:false, duration_ms:0, correction:null }`.
    - Each `tool_call` → `NormalizedEvent{ kind:'tool_call', tool: mapQwenToolKind(toolName), input_digest: inputDigest, ok, interrupted, duration_ms }` where:
      - **`ok`** = `true` iff a `tool_result` with the same `callId` has `ok:true`; `false` if a matching `tool_result` has `ok:false` OR no matching `tool_result` exists (unresolved → not-ok). *(callId is the authority for ok.)*
      - **`duration_ms`** = the `durationMs` of the `telemetry_tool` whose `(toolName, argsKey)` matches this call, searching items after the call; `0` if none. *(telemetry is the authority for duration.)*
      - **`interrupted`** = `true` if an `interrupt` item occurs at or after this `tool_call` and before the next `user_msg`. Otherwise `false`.
  - `export function streamQwenSession(filePath: string): NormalizedEnvelope` — I/O: read the file line-by-line (`node:readline`); enforce the size caps (skip+count oversized lines, stop at 5000 events, treat >50 MB as truncated); `parseQwenRecord` each line, flatten items in order; extract `cwd` from the first record carrying it (fall back to `<sessionId>.runtime.json` `work_dir` if present, else `''`); call `mergeQwenItems`; assemble the envelope `{ schema_version:1, session_id:<filename uuid>, agent:'qwen-code', repo:'', started_at, duration_ms, events, truncated, event_count }` (`repo`/`started_at`/`duration_ms` derived exactly as Claude's `streamSession` does from record timestamps; `agent` is the literal `'qwen-code'` here — the dispatcher stamps gigacode separately in Task 7).

- [ ] **Step 1: Write the failing test**

`test/qwen-stream.test.ts`:
  1. **merge — single resolved call:** items `[tool_call(call_A, read_file), telemetry_tool(read_file, argsKey K, 22, true), tool_result(call_A, ok:true)]` → one `tool_call` event with `tool:'read'`, `ok:true`, `duration_ms:22`, `interrupted:false`.
  2. **merge — parallel calls:** one assistant turn yields `tool_call(call_A, read_file)` + `tool_call(call_B, run_shell_command)`, then two telemetries (A:30ms, B:12ms) and two results (A ok, B fail) → two events; A `{ok:true,duration_ms:30}`, B `{ok:false,duration_ms:12}`. Each resolves independently by callId.
  3. **merge — unresolved call:** `tool_call(call_C, read_file)` with no matching result → `ok:false, duration_ms:0`.
  4. **merge — interrupt:** `[tool_call(call_A), tool_result(call_A, true), interrupt, tool_call(call_B), tool_result(call_B, true)]` → A `interrupted:false`, B `interrupted:true`.
  5. **merge — user/assistant msgs:** a `user_msg` then `assistant_msg` → two events with correct kinds and `correction` set on the user_msg by `detectCorrection`.
  6. **stream — real-shaped file:** write a tmp `.jsonl` of hand-written Qwen records (one user text, one assistant with one `read_file` call, the telemetry, the tool_result) via `writeFileSync`; `streamQwenSession(path)` returns an envelope with `agent:'qwen-code'`, `event_count` matching, the tool_call event `ok:true,duration_ms` from telemetry, `truncated:false`.
  7. **stream — caps & malformed:** a file with one >1 MB line and one valid line → valid line parsed, oversized counted, `truncated:true`. A non-JSON line is skipped (no throw).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/qwen-stream.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/adapter/qwen/stream.ts` with `mergeQwenItems` (pure, per the contract above) and `streamQwenSession` (readline + caps + envelope). Reuse `detectCorrection` and the scrubbed `inputDigest` already attached to `tool_call` items.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/qwen-stream.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

`git add src/adapter/qwen/stream.ts test/qwen-stream.test.ts`
`git commit -m "feat(qwen): id-based merge + streaming session reader"`

---

## Task 6: `init qwen` / `init gigacode` installer + hook-renderer decision

**Files:**
- Create: `src/init/qwen.ts`
- Modify (conditionally): `src/output/hook.ts`
- Test: `test/init-qwen.test.ts`

**Interfaces:**
- Consumes: `CLI_PATH` pattern from `src/init/claude.ts` (resolve `dist/cli.js` from package root — reuse the same anchor, do not duplicate the URL logic; export/import it), `InitResult`/`HarnessId` (Task 1).
- Produces:
  - `export function initQwen(opts: { cwd: string }): InitResult` and `export function initGigacode(opts: { cwd: string }): InitResult`. Both build a fail-open wrapper under `<cwd>/.qwen/` (or `<cwd>/.gigacode/`) that spawns `node <CLI_PATH> reflect --transcript <tp> --format hook-stop`, an idempotent settings-merge, and a reflect prompt — mirroring `initClaude`'s three artifacts and its `mergeStopHook` dedup-by-command + backup-on-unparseable behavior. `initGigacode` differs only in root (`.gigacode`) and the project-memory file name (`GIGACODE.md` vs `QWEN.md`) referenced in any emitted guidance text.

- [ ] **Step 1: Research the Qwen hook contract (decision input — no code)**

Before writing tests, determine from Qwen Code's source/docs: (a) the session-end hook registration shape in `settings.json` (issue #23 names `SessionEnd`/`Stop`/`PostToolUse(Failure)`); (b) the stdin payload the hook receives — specifically whether it carries a transcript or session path usable as `--transcript`; (c) the return payload Qwen expects from a blocking hook (compare to Claude's `{decision?:'block', reason?}`). Record the findings as a comment at the top of `src/init/qwen.ts`. This determines the branch in Step 3.

- [ ] **Step 2: Write the failing test**

`test/init-qwen.test.ts` asserts the `InitResult` contract for the path shipped in Step 3:
  - **If the contract is confirmed:** calling `initQwen({cwd})` writes the wrapper + settings + command under `<cwd>/.qwen/`, returns `{harness:'qwen-code', degraded:false, artifacts:[…three paths…], message}`. Calling it twice is idempotent (settings.json contains exactly one harnessgap entry; user keys preserved). A pre-existing unparseable settings.json is backed up to `.bak` before rewrite. `initGigacode({cwd})` writes under `<cwd>/.gigacode/` and references `GIGACODE.md`; `harness:'gigacode'`.
  - **If the contract is NOT confirmable:** `initQwen({cwd})` returns `{harness:'qwen-code', degraded:true, artifacts:[], message:<manual-setup instructions>}` and writes **no** settings hook. Same for gigacode.
  Write the assertions that match the branch taken; mark the unused branch's expectation in a skipped `it.todo` so the open question stays visible.

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- test/init-qwen.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write minimal implementation**

Create `src/init/qwen.ts`. If Step 1 confirmed a session-end hook with a transcript/session path and a block-style return: implement `initQwen`/`initGigacode` mirroring `initClaude` (wrapper + idempotent settings merge + reflect command), parameterized by root + memory-file name; reuse the existing `formatStopHookOutput` in `src/output/hook.ts` **as-is** (no change). If Qwen's expected return payload differs from Claude's, add a harness-parameterized renderer to `src/output/hook.ts` and have the qwen wrapper request it. If Step 1 could not confirm the contract: implement the degrade path (return `degraded:true`, write no hook, `message` documents manual setup). Scan parity is unaffected either way.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- test/init-qwen.test.ts`
Expected: PASS (for the shipped branch).

- [ ] **Step 6: Commit**

`git add src/init/qwen.ts src/output/hook.ts test/init-qwen.test.ts`
`git commit -m "feat(init): qwen/gigacode session-end hook installer"`

---

## Task 7: Harness dispatcher + the three specs

**Files:**
- Create: `src/adapter/index.ts`
- Test: `test/harness-dispatch.test.ts`

**Interfaces:**
- Consumes: `HarnessSpec`/`HarnessId`/`TranscriptLayout`/`CapabilityMatrix` (Task 1), `discoverTranscripts`/`defaultRootDir` (Task 2), Claude `streamSession` (`src/adapter/stream.ts`, existing), `streamQwenSession` (Task 5), `initClaude` (`src/init/claude.ts`), `initQwen`/`initGigacode` (Task 6).
- Produces:
  - `export const CLAUDE_SPEC: HarnessSpec`, `export const QWEN_SPEC: HarnessSpec`, `export const GIGACODE_SPEC: HarnessSpec` — each with `id`, `displayName`, `defaultRootDir()` (via Task 2's `defaultRootDir(id)`), `layout` (claude: no `sessionSubdir`; qwen/gigacode: `sessionSubdir:'chats'`), `streamSession` (claude → existing `streamSession`; qwen → `streamQwenSession`; **gigacode → `streamQwenSession` with the returned envelope's `agent` rewritten to `'gigacode'`** so the same parser serves both), `installHook` (claude → `initClaude` mapped to `InitResult`; qwen → `initQwen`; gigacode → `initGigacode`), and `capabilities` (the matrix from spec §5.2 — claude all-`supported`; qwen/gigacode `finalizationSignal`+`perPromptContextInjection` `pending`, rest `supported`).
  - `export function resolveHarness(id: HarnessId): HarnessSpec` — switch over the three ids; throws an `Error` with a clear message for an unknown id (unreachable given the union, but defensive at the runtime boundary where the id comes from CLI/config strings).
  - `export function discoverForSpec(spec: HarnessSpec, rootDirOverride?: string): { files: string[]; symlinks_rejected: number }` — thin wrapper calling `discoverTranscripts(rootDirOverride ?? spec.defaultRootDir(), spec.layout)`.

- [ ] **Step 1: Write the failing test**

`test/harness-dispatch.test.ts`:
  1. `resolveHarness('claude-code') === CLAUDE_SPEC`; same for qwen/gigacode. `CLAUDE_SPEC.layout.sessionSubdir` is `undefined`; `QWEN_SPEC.layout.sessionSubdir === 'chats'`; `GIGACODE_SPEC.layout.sessionSubdir === 'chats'`.
  2. `QWEN_SPEC.capabilities.finalizationSignal === 'pending'`; `CLAUDE_SPEC.capabilities` is all-`'supported'` (assert every key).
  3. `GIGACODE_SPEC.streamSession(path)` on a qwen-shaped file returns an envelope with `agent:'gigacode'` (rewritten from the quen parser's `'qwen-code'`).
  4. `resolveHarness('foo' as HarnessId)` throws.
  5. `discoverForSpec(QWEN_SPEC, rootOverride)` on a tmp `<root>/projects/<slug>/chats/a.jsonl` tree returns `[a.jsonl]`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/harness-dispatch.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/adapter/index.ts` with the three specs, `resolveHarness`, `discoverForSpec`. For gigacode's `streamSession`, delegate to `streamQwenSession` then override `agent` to `'gigacode'` on the returned envelope. Map `initClaude`'s `InitClaudeResult` → `InitResult` (`artifacts:[wrapper,settings,command]`, `settingsBackupPath`, `degraded:false`, `message`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/harness-dispatch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

`git add src/adapter/index.ts test/harness-dispatch.test.ts`
`git commit -m "feat(adapter): HarnessSpec dispatcher + claude/qwen/gigacode specs"`

---

## Task 8: Config `harness:` key

**Files:**
- Modify: `src/config.ts`, `src/types.ts` (the `Config` interface)
- Test: `test/config.test.ts` (extend)

**Interfaces:**
- Consumes: `HarnessId` (Task 1), `Config`/`DEFAULT_CONFIG`/`KNOWN_TOP_KEYS`/`validateConfig` (`src/config.ts`).
- Produces: `Config.harness: HarnessId` (new required field); `DEFAULT_CONFIG.harness === 'claude-code'`; `'harness'` added to `KNOWN_TOP_KEYS`; `validateConfig` rejects a `harness` value that is not one of the three ids with a `ConfigError`.

- [ ] **Step 1: Write the failing test**

Add to `test/config.test.ts`:
  1. `loadConfig` from a YAML string `harness: qwen-code` yields `cfg.harness === 'qwen-code'`.
  2. Default (no file / empty) yields `cfg.harness === 'claude-code'`.
  3. `harness: wat` → `loadConfig` throws `ConfigError` with a message naming the invalid value.
  4. An unknown top-level key is still rejected (existing behavior unchanged).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/config.test.ts`
Expected: FAIL — `Config` has no `harness`; `'harness'` rejected as unknown key.

- [ ] **Step 3: Write minimal implementation**

Add `harness: HarnessId` to the `Config` interface; `harness: 'claude-code'` to `DEFAULT_CONFIG`; `'harness'` to `KNOWN_TOP_KEYS`; a validation branch in `validateConfig` that throws `ConfigError` for values outside the union.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

`git add src/config.ts src/types.ts test/config.test.ts`
`git commit -m "feat(config): accept + validate harness: key (default claude-code)"`

---

## Task 9: CLI — `--harness`, `--harness-dir`, deprecated `--claude-dir`, widen `init`

**Files:**
- Modify: `src/cli.ts`
- Test: `test/cli-harness.test.ts`

**Interfaces:**
- Consumes: `resolveHarness` (Task 7), `HarnessId` (Task 1), existing `runScan`/`runReflect` option shapes.
- Produces (CLI surface):
  - `scan` gains `--harness <id>` (choices `claude-code|qwen-code|gigacode`) and `--harness-dir <path>`. `--claude-dir <path>` is retained; when present it is treated as `--harness claude-code --harness-dir <path>`. Passing `--claude-dir` together with `--harness qwen-code|gigacode` exits non-zero with a clear error (conflict). `reflect` gains the same `--harness <id>` override (optional; defaults to auto-detect in Task 11).
  - `init <agent>` accepts `claude | qwen | gigacode` (today it rejects all but `claude`). It maps `claude→'claude-code'`, `qwen→'qwen-code'`, `gigacode→'gigacode'`, resolves the spec, calls `spec.installHook({cwd: process.cwd()})`, and prints `result.message` (plus `result.settingsBackupPath` warning if set).
  - Harness resolution precedence for `scan`: `--harness` flag → `config.harness` → `'claude-code'`.

- [ ] **Step 1: Write the failing test**

`test/cli-harness.test.ts` (drive the CLI via the existing pattern used in `test/cli.test.ts`):
  1. `scan --harness qwen-code --harness-dir <tmpQwenRoot>` resolves the qwen spec and scans `<tmpQwenRoot>/projects/*/chats/*.jsonl` (assert it discovers a seeded `chats/a.jsonl` and produces a leaderboard with the expected area).
  2. `scan --claude-dir <tmpClaudeRoot>` still works (alias) and scans the Claude layout.
  3. `scan --claude-dir X --harness qwen-code` exits non-zero with an error mentioning the conflict.
  4. `scan` with no harness flags + a config file `harness: qwen-code` scans qwen.
  5. `init qwen` in a tmp cwd prints an `InitResult`-derived message and (non-degraded branch) writes under `.qwen/`; `init gigacode` under `.gigacode/`. `init wat` exits non-zero with "unsupported agent".

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/cli-harness.test.ts`
Expected: FAIL — flags/`init qwen` not implemented.

- [ ] **Step 3: Write minimal implementation**

Wire the flags into `src/cli.ts` per Produces. Implement the `--claude-dir` alias + conflict. Widen the `init <agent>` allowlist and route through `resolveHarness(...).installHook`. Keep all existing flags and help text working.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/cli-harness.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

`git add src/cli.ts test/cli-harness.test.ts`
`git commit -m "feat(cli): --harness/--harness-dir, deprecated --claude-dir, init qwen|gigacode"`

---

## Task 10: Pipeline dispatch + Claude byte-identical snapshot

**Files:**
- Modify: `src/pipeline.ts`
- Test: `test/pipeline-harness.test.ts`, and lock the existing Claude snapshot in `test/snapshot.test.ts` (must remain unchanged)

**Interfaces:**
- Consumes: `resolveHarness`/`discoverForSpec` (Task 7), harness resolution from `--harness`/config (Task 9), `discoverTranscripts` (Task 2).
- Produces:
  - `runScan` and `runReflect` resolve the harness (flag → config → default) once, call `resolveHarness(id)`, and route discovery through `discoverForSpec(spec, rootOverride)` and per-file parsing through `spec.streamSession`. The envelope `agent` is whatever the spec stamps (no hardcoded `'claude-code'` literal remains in `pipeline.ts`).
  - Remove the now-dead `defaultClaudeDir`/direct `discoverTranscripts` imports from `pipeline.ts` (they go through the dispatcher). `defaultClaudeDir` itself stays exported from `walk.ts` for any external callers.

- [ ] **Step 1: Write the failing test**

`test/pipeline-harness.test.ts`:
  1. End-to-end: seed a tmp repo + a tmp qwen root (`<root>/projects/<slug>/chats/<id>.jsonl` built from a hand-written gemini transcript with a read, a failed exec, an edit, and a user correction). `runScan({ harness:'qwen-code', harnessDir: root, repo })` returns records with `agent:'qwen-code'`, non-empty `areas`, and an active `failure_streak`/`corrections` signal reflecting the seeded events.
  2. **Byte-identical Claude:** run the existing Claude corpus through `runScan` with no harness flag and assert the `--json` output is byte-identical to the locked snapshot (same assertion `test/snapshot.test.ts` already makes — it must still pass).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/pipeline-harness.test.ts test/snapshot.test.ts`
Expected: FAIL — `runScan` does not yet accept/route `harness`/`harnessDir`.

- [ ] **Step 3: Write minimal implementation**

In `pipeline.ts`, resolve the spec at the top of `runScan`/`runReflect`; replace the direct `discoverTranscripts(claudeDir)` / `streamSession` calls with `discoverForSpec(spec, rootOverride)` / `spec.streamSession`; remove the hardcoded `agent:'claude-code'` stamp (the spec's `streamSession` already stamps `agent`). Do not touch detection/scoring/areas/output.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/pipeline-harness.test.ts test/snapshot.test.ts && npm run typecheck`
Expected: PASS — qwen end-to-end works; Claude snapshot unchanged.

- [ ] **Step 5: Commit**

`git add src/pipeline.ts test/pipeline-harness.test.ts`
`git commit -m "feat(pipeline): dispatch discovery/stream via HarnessSpec (claude byte-identical)"`

---

## Task 11: Reflect harness auto-detect

**Files:**
- Modify: `src/pipeline.ts` (`runReflect`)
- Test: `test/reflect-autodetect.test.ts`

**Interfaces:**
- Consumes: `resolveHarness` (Task 7), the `reflect --transcript <path>` path (existing).
- Produces: when `reflect --transcript <path>` is called without `--harness`, `runReflect` sniffs the first parseable line of the file: if it has `message.parts` and a part with `functionCall` (or `type:'tool_result'`/`subtype:'ui_telemetry'`) → harness is `qwen-code`; if it has `message.content` with a `tool_use`/`{type:'text'}` item → `claude-code`. (`gigacode` is indistinguishable from `qwen-code` by content — auto-detect resolves to `qwen-code`, which is correct since the parser is shared; the stamped `agent` is `qwen-code` unless `--harness gigacode` is passed explicitly.) `--harness <id>` overrides the sniff. The resolved spec drives parsing exactly as in Task 10.

- [ ] **Step 1: Write the failing test**

`test/reflect-autodetect.test.ts`:
  1. A qwen-shaped transcript file → `reflect --transcript <path> --format hook-stop` parses via the qwen adapter (the returned `ReflectFinding.record` has `agent:'qwen-code'`).
  2. A claude-shaped transcript file → parsed via the claude adapter (`agent:'claude-code'`).
  3. `--harness gigacode --transcript <qwen file>` → `agent:'gigacode'` (override wins).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/reflect-autodetect.test.ts`
Expected: FAIL — reflect does not sniff yet.

- [ ] **Step 3: Write minimal implementation**

Add the sniff helper in `pipeline.ts` (read the first non-empty line, JSON.parse, test the shape) and use it in `runReflect` when `--harness` is absent. Route through the resolved spec.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/reflect-autodetect.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

`git add src/pipeline.ts test/reflect-autodetect.test.ts`
`git commit -m "feat(reflect): auto-detect harness from transcript shape (--harness override)"`

---

## Task 12: Builder gemini emitter + Qwen integration fixture

**Files:**
- Modify: `test/helpers/builder.ts`
- Test: `test/fixtures/qwen/sessions.ts` (new synthetic SessionSpec), and extend `test/qwen-e2e.test.ts` (new)

**Interfaces:**
- Consumes: `EventSpec`/`SessionSpec` (`test/helpers/builder.ts`), the Qwen adapter (Tasks 3–5), `runScan` (Task 10).
- Produces:
  - `mkQwenSession(cwd: string, spec: SessionSpec): string` — emits gemini-shaped JSONL from the same compact `EventSpec` list, mapping each `EventSpec` to Qwen records: tool events → an `assistant` record with a `functionCall` part + a `ui_telemetry` `qwen-code.tool_call` (carrying `duration_ms`/`success`) + a `tool_result` record with matching `toolCallResult.callId`; `user_text`/`assistant_text` → user/assistant records with text parts. Tool-name mapping is the inverse of Task 3 (`read→read_file`, `search→grep_search`, `list→list_directory`, `edit→edit`, `write→write_file`, `exec→run_shell_command`). Timestamps increment per record (same step semantics as `mkSession`).
  - `writeQwenTranscript(rootDir: string, slug: string, name: string, jsonl: string): string` — writes `<rootDir>/projects/<slug>/chats/<name>.jsonl` (the `chats/` level).
  - A synthetic `SessionSpec` fixture under `test/fixtures/qwen/sessions.ts` exercising a reread loop, a failed-exec streak, oscillating edits, and a user correction — the four high-value signal patterns.

- [ ] **Step 1: Write the failing test**

`test/qwen-e2e.test.ts`:
  1. `mkQwenSession` output is round-trippable: feed it through `streamQwenSession` (write to tmp, read back) and assert the expected `NormalizedEvent` sequence (kinds, tools, ok flags) for a small `SessionSpec`.
  2. Integration: `setupTempRepo()` + `writeQwenTranscript(qwenRoot, slug, 's1', mkQwenSession(repo, fixture))`; `runScan({ harness:'qwen-code', harnessDir: qwenRoot, repo })` → the flagged session shows active `reread`/`failure_streak`/`corrections`/`oscillation` signals and areas derived from the seeded file paths; `agent:'qwen-code'`.
  3. Privacy: seed a prose marker in a `user_text`/tool-arg field; assert it is absent from every output field of the scan result (mirrors the existing privacy-test approach).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/qwen-e2e.test.ts`
Expected: FAIL — `mkQwenSession`/`writeQwenTranscript` not defined.

- [ ] **Step 3: Write minimal implementation**

Add `mkQwenSession` + `writeQwenTranscript` to `test/helpers/builder.ts` (reuse the timestamp-step + tmp-dir helpers already there). Add the synthetic fixture. Keep `mkSession`/`writeTranscript` (Claude) unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/qwen-e2e.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite green**

Run: `npm test && npm run typecheck`
Expected: entire suite PASS, typecheck clean (all prior tasks' tests + existing 40 files).

- [ ] **Step 6: Commit**

`git add test/helpers/builder.ts test/fixtures/qwen/sessions.ts test/qwen-e2e.test.ts`
`git commit -m "test(qwen): gemini builder emitter + synthetic integration fixture"`

---

## Task 13: Docs (README, ARCHITECTURE, CLAUDE.md) + docs-watcher

**Files:**
- Modify: `README.md`, `docs/ARCHITECTURE.md`, `CLAUDE.md`
- (No new tests — docs only; `test/packaging.test.ts` remains green.)

**Interfaces:**
- Consumes: the shipped surface (Tasks 1–12).
- Produces:
  - `README.md`: update the opener + Usage to state harnessgap reads Claude Code, **Qwen Code**, and **GigaCode** transcripts; document `--harness <id>`, `--harness-dir`, `init qwen|gigacode`, the `harness:` config key, and that bare `scan`/`--claude-dir` are unchanged. Add a short "Supported harnesses" subsection with the on-disk paths (`~/.qwen/projects/<slug>/chats/*.jsonl`, `~/.gigacode/…/chats/*.jsonl`) and the capability note (scan full parity; init/reflect hook parity pending Qwen contract confirmation where applicable).
  - `docs/ARCHITECTURE.md`: add the adapter seam to the module map (`src/adapter/index.ts` dispatcher; `src/adapter/qwen/`); note `taxonomy.ts`/`hook.ts` are no longer the only per-harness code; record the `HarnessSpec`/`TranscriptLayout`/capability-matrix design and the three layouts; state that the detector/scorer/output are harness-agnostic.
  - `CLAUDE.md`: add a one-line note that Qwen Code and GigaCode are supported sources (and how `--harness` selects them), keeping the file terse per the global rule.

- [ ] **Step 1: Write the failing test**

No automated test for prose. The "failure" is the doc/status mismatch: a reader of `README.md` today believes only Claude Code is supported. Verification is `grep -n` checks after editing.

- [ ] **Step 2: Run test to verify it fails**

Run: `grep -n "Qwen\|GigaCode\|qwen-code\|gigacode" README.md docs/ARCHITECTURE.md CLAUDE.md`
Expected: no matches (docs still Claude-only).

- [ ] **Step 3: Write minimal implementation**

Apply the edits above. Keep copy tight and consistent with the spec (§5 layouts, §8 capability caveat). Do not invent features beyond the shipped surface.

- [ ] **Step 4: Run test to verify it passes**

Run: `grep -n "Qwen\|GigaCode" README.md docs/ARCHITECTURE.md CLAUDE.md && npm test`
Expected: matches present; full suite still PASS (docs don't break tests).

- [ ] **Step 5: Commit**

`git add README.md docs/ARCHITECTURE.md CLAUDE.md`
`git commit -m "docs: Qwen Code + GigaCode support (--harness, layouts, capability note)"`

- [ ] **Step 6: Dispatch docs-watcher**

Per the project `CLAUDE.md` session-end rule, dispatch the `docs-watcher` subagent with the full changed-files list (all `src/`, `test/`, and `*.md` files touched across Tasks 1–13) so it can sync any remaining stale signatures/links in the docs.

---

## Self-Review (run after writing — recorded here, not a task)

1. **Code scan:** No method bodies, algorithms, or test/implementation code in any task — only signatures, data shapes, behavior descriptions, and expected results. ✔
2. **Self-containment:** Each task's Consumes/Produces gives the exact contracts a fresh implementer needs; no "see spec" hand-waves for signatures. ✔
3. **Spec coverage:** §5.1 (HarnessId/agent) → T1; §5.2 (HarnessSpec/TranscriptLayout/CapabilityMatrix) → T1+T7; §5.3 (Qwen record mapping) → T4; §5.4 (taxonomy) → T3; §5.5 (config) → T8; §5.6 (CLI) → T9; §6 (merge contract) → T5; §7 (module table) → T1–T11; §8 (init/reflect) → T6+T11; §9 (error handling) → embedded in T2/T5/T6 invariants; §10 (testing) → every task + T12. ✔
4. **Placeholders:** No TBD/TODO; the only conditional branch (T6 init) spells out both outcomes with concrete expected results. ✔
5. **Type consistency:** `HarnessId`, `HarnessSpec`, `TranscriptLayout`, `CapabilityMatrix`, `InitResult`, `QwenParsedItem`, `mapQwenToolKind`, `parseQwenRecord`, `mergeQwenItems`, `streamQwenSession`, `resolveHarness`, `discoverForSpec`, `mkQwenSession`, `writeQwenTranscript`, `defaultRootDir`, `initQwen`, `initGigacode` — names match across all tasks. ✔
