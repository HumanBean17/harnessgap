# harnessgap — Qwen Code + GigaCode adapter support

**Status:** approved design (brainstormed) → spec
**Date:** 2026-07-21
**Parent design:** `docs/DESIGN.md` §4.1 / §5; roadmap issue [#23 — Agent adapters: Codex / OpenCode / Qwen](https://github.com/HumanBean17/harnessgap/issues/23).
**Prior slices:** Slice 1 detection, Slice 2 ambient, Slice 3 session-end reflect, Slice 4 Diagnoser (all archived except Diagnoser).
**Runtime:** Node + TypeScript, `npx harnessgap`; the detection path stays stateless and offline.

## 1. Purpose

harnessgap today reads only Claude Code transcripts. This slice adds **Qwen Code**
and **GigaCode** (a Qwen Code fork: identical transcript format, `~/.gigacode`
directory, `GIGACODE.md` project memory) as first-class sources with **the same
functionality Claude has**: `scan` (discover + parse → leaderboard), `init`
(install a session-end reflect hook), and `reflect` (render the hook payload).

Qwen Code's transcript format is **Gemini-CLI-style**, structurally different
from Claude's: `message.parts[]` (not `content[]`), `functionCall` /
`functionResponse` (not `tool_use` / `tool_result`), **multiple parallel tool
calls per assistant turn** paired **by call id**, and per-tool duration / success
/ interruption carried in `ui_telemetry` system records. A dedicated parser and
merge strategy are required; Claude's `mergeToolCalls` stack cannot be reused.

The detector, scorer, area localizer, ambient assessor, aggregator, Diagnoser,
and the `human` / `json` / `calibrate` output formatters are pure functions of
`NormalizedEvent[]` / `StruggleRecord[]` and are **untouched**. All per-harness
code lives behind a new adapter seam.

### Success criterion (manual dogfood)

1. On a real Qwen project dir (e.g. `~/.qwen/projects/-Users-…-agenttest`),
   `harnessgap scan --harness qwen` discovers `chats/*.jsonl`, parses them, and
   emits a leaderboard whose top areas and active signals match what a developer
   recalls as the friction spots — same shape and semantics as a Claude leaderboard.
2. `harnessgap scan --harness gigacode` does the same against `~/.gigacode/…/chats/`,
   with no code path unique to gigacode beyond the directory + memory-file name.
3. `harnessgap init qwen` installs a session-end hook under `.qwen/` such that, on
   session end, `harnessgap reflect` runs against the just-finished transcript and
   returns a block payload when the session tripped — mirroring `init claude`.
4. Default behavior is unchanged: bare `harnessgap scan` still scans `~/.claude`
   and produces byte-identical output to today; `--claude-dir` still works.
5. No new network surface, no `git` invocation, no raw transcript prose in any
   output field. Scrubbing, size caps, symlink rejection, and prefix confinement
   all hold for the new sources.

## 2. Scope

**In scope**

- A `HarnessId` union (`claude-code | qwen-code | gigacode`) and a widened
  `NormalizedEnvelope.agent`.
- A **`HarnessSpec`** data object + thin dispatcher resolving, per harness: default
  root dir, transcript **layout descriptor**, stream/parse entry point, and hook
  installer.
- Generalized discovery (`walk.ts`) driven by the layout descriptor, preserving
  every existing invariant.
- A self-contained **`src/adapter/qwen/`** (parse, taxonomy, stream/merge) for the
  Gemini-style format. GigaCode reuses it via spec parameters.
- CLI: `--harness <id>`, `--harness-dir <path>` (with `--claude-dir` retained as a
  deprecated alias), and `init qwen | gigacode`.
- Config: a top-level `harness:` key.
- `init qwen` / `init gigacode` hook installers and a harness-parameterized
  `reflect` hook renderer.
- A per-harness **capability matrix** documented on each spec (advisory; not
  runtime degraded-mode machinery).

**Out of scope (deferred)**

- **Codex CLI / OpenCode** adapters (the other two in issue #23) — separate slices;
  this one establishes the seam they will slot into.
- **Multi-harness aggregation in one run** (one leaderboard across Claude + Qwen +
  GigaCode transcripts for a repo touched by several agents) — adds cross-harness
  session dedup; deferred. v1 is one harness per invocation.
- **Auto-detection of installed harnesses** (probing `~/.claude`, `~/.qwen`,
  `~/.gigacode` and scanning all that exist) — deferred; v1 selects explicitly via
  `--harness` / config, defaulting to `claude-code`.
- **Qwen subagent transcripts** (`<project>/subagents/<id>/`) and Qwen API logs
  (`~/.qwen/logs/openai/`) — not read in v1; only `<project>/chats/*.jsonl`.
- **A `harnessgap emit` universal-hook escape hatch** (issue #23 fallback) — deferred.

## 3. Principle — adapter seam, not a Claude shim

1. **One normalized contract, many parsers.** `NormalizedEvent` is already
   harness-agnostic. Each adapter is a `(on-disk record) → NormalizedEvent`
   translation plus a merge strategy. Nothing downstream knows which harness
   produced the events.
2. **Parallel modules over branched parsers (Approach C).** The Qwen format differs
   enough (Gemini parts, parallel calls, telemetry-backed results) to deserve its
   own well-bounded module rather than a branch inside Claude's `parse.ts`. Claude's
   adapter is repackaged behind the same shape with near-zero logic change, leaving
   the 40 existing test files undisturbed.
3. **GigaCode is a parameter, not an adapter.** It is a full Qwen clone: same record
   schema, same tool names, same merge. It differs only in root dir (`~/.gigacode`)
   and project-memory file (`GIGACODE.md`). One spec, two parameter sets.
4. **Parity, declared honestly.** Each spec carries a capability matrix
   (session-discovery, stream-format, finalization-signal, interruption,
   file-change-evidence, resume, per-prompt-context-injection). Cells are `supported`
   or `pending` (where the Qwen hook contract is unverified) — documented, not
   enforced at runtime. This adopts the framing of the
   [issue #23 comment](https://github.com/HumanBean17/harnessgap/issues/23#issuecomment-5024469638)
   without the degraded-mode machinery the user did not request.
5. **Backward compatibility is a hard constraint.** Bare invocation and `--claude-dir`
   are unchanged; Claude output is byte-identical.

## 4. The multi-harness flow

Selection resolves in this precedence (highest first):

1. `--harness <id>` CLI flag.
2. `harness:` key in `.harnessgap.yml`.
3. Default `claude-code`.

The selected `HarnessId` resolves a `HarnessSpec`. `runScan` and `runReflect` then:

> **discover** — `discoverTranscripts(layout, rootDirOverride)` → transcript paths,
> using the spec's layout descriptor (Section 5.2). → **stream+parse+merge** —
> `spec.streamSession(path)` → `NormalizedEnvelope` (agent stamped from the spec).
> → **resolve → relativize → detect → score → areas → ambient → diagnose →
> aggregate → output** — **unchanged**.

`reflect --transcript <path>` parses a single file. It **auto-detects** the harness
by sniffing the first record's shape (`message.parts` + `functionCall` →
`qwen-code`/`gigacode`; `message.content` + `tool_use` → `claude-code`), with an
optional `--harness` override. This keeps emitted hook wrappers harness-agnostic.

## 5. Contracts

### 5.1 `HarnessId` and the widened `agent` field

```ts
type HarnessId = 'claude-code' | 'qwen-code' | 'gigacode';
```

`NormalizedEnvelope.agent: 'claude-code'` → `agent: HarnessId` (string union,
exhaustiveness-checked). This is the only type-level blocker today
(`src/types.ts:90`); it is stamped verbatim from the resolved spec.

### 5.2 `HarnessSpec` and `TranscriptLayout`

A plain data object resolved by id (new `src/adapter/index.ts`):

```ts
interface TranscriptLayout {
  projectsSegment: 'projects';     // the dir under root that holds per-project slugs
  sessionSubdir?: 'chats';         // optional extra level between slug and *.jsonl
  extension: '.jsonl';
}

interface HarnessSpec {
  id: HarnessId;
  displayName: string;
  defaultRootDir(): string;        // ~/.claude | ~/.qwen | ~/.gigacode
  layout: TranscriptLayout;
  streamSession(filePath: string): NormalizedEnvelope;   // delegates to the adapter
  installHook(opts: { cwd: string }): InitResult;         // delegates to init/<harness>.ts
  capabilities: CapabilityMatrix;                        // documented table (§3.4)
}
```

The three specs:

| id | root | layout.sessionSubdir | parser | hook installer |
|---|---|---|---|---|
| `claude-code` | `~/.claude` | — | existing `adapter/parse.ts` + `taxonomy.ts` + `stream.ts` | `init/claude.ts` |
| `qwen-code` | `~/.qwen` | `chats` | `adapter/qwen/*` | `init/qwen.ts` |
| `gigacode` | `~/.gigacode` | `chats` | `adapter/qwen/*` (reused) | `init/qwen.ts` parameterized |

`pipeline.ts` stops importing `defaultClaudeDir` / `discoverTranscripts` /
`streamSession` directly and goes through the resolved spec.

**`CapabilityMatrix`** is an advisory, static per-spec table (documented, not
enforced at runtime — §3.4). Its keys are the seven axes from the issue #23
comment; each cell is `supported` or `pending`:

```ts
type CapabilityMatrix = Record<
  | 'sessionDiscovery' | 'streamFormat' | 'finalizationSignal'
  | 'interruption' | 'fileChangeEvidence' | 'resume' | 'perPromptContextInjection',
  'supported' | 'pending'
>;
```

| Capability | claude-code | qwen-code | gigacode |
|---|---|---|---|
| sessionDiscovery | supported | supported | supported |
| streamFormat | supported | supported | supported |
| finalizationSignal | supported | pending (§8.1) | pending (§8.1) |
| interruption | supported | supported (`api_error`/`APIUserAbortError`) | supported |
| fileChangeEvidence | supported | supported | supported |
| resume | supported | supported (`parentUuid`/`sessionId`) | supported |
| perPromptContextInjection | supported (reflect/Stop) | pending (§8.2–8.3) | pending (§8.2–8.3) |

The two `pending` columns collapse to `supported` once the §8 known unknowns are
resolved at implementation time.

### 5.3 Qwen record schema (the on-disk contract)

Each line of `~/.qwen/projects/<slug>/chats/<uuid>.jsonl` is one JSON record.
Top-level fields carried on (almost) every record:

```jsonc
{
  "uuid": "…", "parentUuid": "…"|null, "sessionId": "<uuid>",
  "timestamp": "2026-07-21T04:21:39.396Z",
  "type": "system" | "user" | "assistant" | "tool_result",
  "cwd": "/abs/repo/path", "gitBranch": "main", "version": "0.20.0",
  "model": "glm-5.2",                      // assistant records
  "message": { "role": "user"|"model", "parts": Part[] },
  "subtype": "slash_command"|"ui_telemetry"|"attribution_snapshot"|"file_history_snapshot", // system
  "systemPayload": { … },                  // system records
  "toolCallResult": { "callId": "…", "status": "success"|…, "resultDisplay": … }, // tool_result
  "usageMetadata": { … }                   // assistant records
}
```

`message.parts[]` is a Gemini-style array; each element is one of:

```jsonc
{ "text": "…" }                                              // text (optional "thought": true = reasoning)
{ "functionCall": { "id": "call_…", "name": "read_file", "args": { … } } }   // tool call
{ "functionResponse": { "id": "call_…", "name": "read_file", "response": { "output": "…" } } } // tool result
```

`subtype: "ui_telemetry"` records carry the gold for tool outcome and interruption:

```jsonc
{ "subtype": "ui_telemetry", "systemPayload": { "uiEvent": {
    "event.name": "qwen-code.tool_call",
    "function_name": "read_file", "function_args": { "file_path": "…" },
    "duration_ms": 22, "status": "success", "success": true, "decision": "auto_accept"
}}}
{ "subtype": "ui_telemetry", "systemPayload": { "uiEvent": {
    "event.name": "qwen-code.api_error",
    "error_type": "APIUserAbortError", "error_message": "Request was aborted."
}}}
```

Sibling files `<uuid>.runtime.json` (`{schema_version, pid, session_id, work_dir,
hostname, started_at, qwen_version}`), `meta.json`, and `memory/` are **excluded**
by the `.jsonl` extension filter. `work_dir` may be used as a `cwd` fallback.

**Record → `NormalizedEvent` mapping (contract):**

| Source | Produces | Field sources |
|---|---|---|
| `type:"user"` with text parts (no `functionResponse`) | `user_msg` | text → correction detection; `cwd` |
| `type:"user"` carrying `functionResponse` (and `tool_result` records) | *(result carrier — consumed by merge, not emitted as user_msg)* | — |
| `type:"assistant"` text part, `thought:false` | `assistant_msg` | text; `cwd` |
| `type:"assistant"` text part, `thought:true` | *(reasoning — not emitted as a visible assistant_msg)* | — |
| `type:"assistant"` `functionCall` part | `tool_call` (pending result) | `name`→taxonomy; `args`→input_digest; `cwd` |
| `type:"tool_result"` + matching `functionResponse` | resolves the pending `tool_call` | `toolCallResult.status`→`ok` |
| `ui_telemetry` `qwen-code.tool_call` | resolves the pending `tool_call` | `duration_ms`; `success`→`ok`; `decision` |
| `ui_telemetry` `qwen-code.api_error` (`APIUserAbortError`) | marks the in-flight turn `interrupted: true` | error_type |
| `system` `slash_command` / `attribution_snapshot` / `file_history_snapshot` | ignored | — |

`input_digest` extraction from `functionCall.args`:

| tool | args field → digest |
|---|---|
| `read_file` | `file_path` → files |
| `list_directory` | `path` → files |
| `edit` | `file_path` → files; `old_string`/`new_string` → lines_changed |
| `write_file` | `file_path` → files; `content` → lines |
| `run_shell_command` | `command` → cmd |
| `grep_search` | `pattern` → query |
| `glob` | `pattern` → query |

Scrubbing (the existing 7-rule catalog) and size caps (1 MB line / 5000 events /
50 MB file) are reused unchanged.

### 5.4 Qwen tool taxonomy

New `src/adapter/qwen/taxonomy.ts`, `mapQwenToolKind(name) → ToolKind`, observed
across real transcripts:

| Qwen tool | ToolKind |
|---|---|
| `read_file` | `read` |
| `list_directory` | `list` |
| `edit`, `write_file` | `edit` |
| `run_shell_command` | `exec` |
| `grep_search`, `glob` | `search` |
| `agent`, `todo_write`, `ask_user_question`, `skill` | `other` |
| *(unknown)* | `other` |

### 5.5 Config addition

A new top-level key (currently rejected by `loadConfig`'s allowlist; this slice
accepts it), deep-merged over the default:

```yaml
harness: claude-code      # claude-code | qwen-code | gigacode
```

Unknown values are rejected with a `ConfigError`, as today. No other config shape
changes.

### 5.6 CLI additions

- `scan --harness <id>` (and `reflect --harness <id>` override) — selects the spec;
  default follows §4 precedence.
- `scan --harness-dir <path>` — overrides the resolved spec's root dir.
- `--claude-dir <path>` — **retained as a deprecated alias** equivalent to
  `--harness claude-code --harness-dir <path>`. Passing `--claude-dir` together with
  a non-claude `--harness` is a hard error.
- `init <agent>` widened to accept `claude | qwen | gigacode` (today it rejects all
  but `claude`). `init claude` is unchanged.

## 6. The Qwen parse + merge contract

The adapter produces a `NormalizedEnvelope` whose `events` satisfy the same
invariants Claude's do — the detector cannot tell them apart. Behavior required
(described, not algorithmic):

- **Emit** one `user_msg` per genuine user text turn; one `assistant_msg` per
  visible (non-thought) assistant text; one `tool_call` per `functionCall`.
- **Pair each `tool_call` to its outcome by call id**, not by stack order, because
  one assistant turn may carry several `functionCall` parts resolved by several
  later `tool_result` / `functionResponse` records. A call's `ok`, `duration_ms`,
  and `interrupted` are populated from the matched `toolCallResult.status`, the
  matching `ui_telemetry` `qwen-code.tool_call` (`duration_ms`, `success`), and any
  `qwen-code.api_error` (`APIUserAbortError`) on the in-flight turn. Unresolved
  calls (truncated file, missing result) degrade to `ok:false`-unknown rather than
  drop.
- **`started_at` / `duration_ms` / `session_id`** for the envelope come from the
  records' `timestamp` / `sessionId` (the `<uuid>` filename), matching Claude's
  envelope semantics.
- **`truncated` / size caps / event_count** behave exactly as Claude's stream.

`cwd` is taken from the per-record `cwd` field (present on every record); the
`runtime.json` `work_dir` is a fallback when a record lacks `cwd`.

## 7. Module / data-flow placement

| Change | Location | Responsibility |
|---|---|---|
| `HarnessId`, widened `agent` | `src/types.ts` | new union; widen the literal at line 90. |
| `HarnessSpec`, `TranscriptLayout`, `resolveHarness(id)` | **`src/adapter/index.ts` (new)** | the dispatcher; resolves spec by id; houses the capability matrices. |
| Generalized discovery | `src/walk.ts` | `discoverTranscripts(layout, rootDir?)`; `defaultRootDir(id)`; preserve all invariants. |
| Qwen parser | **`src/adapter/qwen/parse.ts` (new)** | one record → intermediate; the gemini-parts mapping (§5.3). |
| Qwen taxonomy | **`src/adapter/qwen/taxonomy.ts` (new)** | `mapQwenToolKind` (§5.4). |
| Qwen stream + merge | **`src/adapter/qwen/stream.ts` (new)** | `streamQwenSession`; id-based pairing; telemetry extraction; same size caps. |
| Claude adapter repackaged | `src/adapter/{parse,taxonomy,stream}.ts` | expose `streamSession`/`mapToolKind` behind the spec shape; logic unchanged. |
| Pipeline dispatch | `src/pipeline.ts` | `runScan`/`runReflect` resolve the spec and route discovery/stream through it; `agent` stamped from spec. |
| CLI flags | `src/cli.ts` | `--harness`, `--harness-dir`, deprecated `--claude-dir`, widened `init`. |
| Config | `src/config.ts`, `src/types.ts` | accept + validate `harness:`; default `claude-code`. |
| `init qwen` / `init gigacode` | **`src/init/qwen.ts` (new)** | writes `.qwen/` (or `.gigacode/`) artifacts; reused by gigacode via params. |
| Hook renderer | `src/output/hook.ts` | `formatStopHookOutput` gains a harness parameter if Qwen's Stop payload differs from Claude's. |
| Reflect auto-detect | `src/pipeline.ts` (`runReflect`) | sniff first record → harness; `--harness` override. |

Reused verbatim: `runDetector`, `scoreSessions`, `localizeAreas`, `aggregateAreas`,
`assembleStruggleRecord`, scrubbing, size caps, `resolveMainRepo`, `loadConfig`,
the Diagnoser, and the `human` / `json` / `calibrate` renderers. **No new runtime
dependencies; no new network surface; no `git` invocation.**

## 8. init / reflect parity

`init claude` today writes, under `<cwd>/.claude/`: a fail-open wrapper
(`harnessgap-stop-hook.js`) that spawns
`node <cli> reflect --transcript <tp> --format hook-stop`, an idempotent
`hooks.Stop` settings.json merge, and a `/reflect` command. `init qwen` mirrors
this against `.qwen/`:

- a fail-open wrapper spawning `reflect --transcript <tp> --format hook-stop`
  (reflect auto-detects qwen from the transcript);
- an idempotent merge of the Qwen session-end hook into `.qwen/settings.json`;
- a reflect prompt/command appropriate to the harness.

GigaCode reuses `init/qwen.ts` with the `.gigacode` root and `GIGACODE.md`.

**Known unknowns (resolve against Qwen Code docs/source during implementation; not
design blockers):**

1. The exact Qwen hook registration shape in `settings.json` (issue #23 names
   `SessionEnd` / `Stop` / `PostToolUse(Failure)`). The merge must be idempotent and
   preserve user keys, mirroring `mergeStopHook`.
2. The stdin payload Qwen hands the hook (does it carry a transcript/session path
   the way Claude's carries `transcript_path`?) and the payload Qwen expects back.
   If Qwen's Stop payload differs from `{decision?:'block', reason?}`, the hook
   renderer is parameterized by harness; otherwise it is reused as-is.
3. How Qwen surfaces the session transcript path at session end (filename vs. the
   `<uuid>.runtime.json` `session_id`).

Until (1)–(3) are confirmed, `init qwen` / `init gigacode` ship behind the
verified scan path; if the hook contract cannot be confirmed, the hook installer
degrades to a documented manual-setup printout rather than writing an unverified
hook. Scan parity is not blocked.

## 9. Error handling — fail-open, privacy, backward compatibility

- **Discovery invariants preserved.** Symlink rejection (`Dirent.isDirectory` +
  `lstatSync`), prefix confinement to `<root>/projects/`, fail-open on
  missing/unreadable dirs (→ empty, never throw), and lexicographic sort all hold
  for the generalized `discoverTranscripts`. The `.runtime.json` / `meta.json` /
  `memory/` siblings are excluded by the `.jsonl` filter.
- **Parse fail-open.** Malformed lines, oversized lines, and unknown record
  `type`/`subtype` are skipped/counted as today; the session still emits with
  `truncated`/warnings. Unresolved tool calls degrade rather than drop.
- **No network, no detection-path writes, no `git`.** Still true; the Qwen adapter
  only reads local `.jsonl`.
- **Privacy.** Only derived values reach output — scrubbing and size caps are
  reused upstream; `ui_telemetry` token/latency fields are not emitted. No new
  egress channel or vendor.
- **Egress / packaging unchanged.** No new network imports and no new runtime deps
  → `test/egress.test.ts` and `test/packaging.test.ts` pass (the wrapper's
  `child_process` use stays inside the emitted artifact string, as today).
- **Backward compatibility.** Bare `harnessgap scan` and `--claude-dir` are
  unchanged; Claude `--json` and human output are byte-identical (snapshot-locked).

## 10. Testing

- **Qwen parse unit (pure):** each record `type`/part kind maps per §5.3; thought
  parts excluded; `tool_result`-as-user-role not emitted as `user_msg`; telemetry
  fields extracted.
- **Qwen merge unit (pure):** id-based pairing of `functionCall` →
  `tool_result`/`functionResponse`/telemetry; **multiple parallel calls in one
  turn** each resolve independently; `ok`/`duration_ms`/`interrupted` populated;
  unresolved-call degradation; size caps and `truncated`.
- **Qwen taxonomy unit:** the §5.4 map incl. unknown → `other`.
- **Discovery unit:** the `chats` subdir layout; `.runtime.json`/`meta.json`
  excluded; symlink rejection + prefix confinement + fail-open reused.
- **Auto-detect unit:** reflect sniffs `message.parts`+`functionCall` → qwen,
  `message.content`+`tool_use` → claude; `--harness` overrides.
- **`init qwen` unit:** writes `.qwen/` artifacts; idempotent settings merge
  preserves user keys; gigacode variant targets `.gigacode`/`GIGACODE.md`. (Hook
  payload assertions follow the §8 known-unknowns resolution.)
- **Integration (real fs fixtures):** scan a redacted real Qwen transcript fixture
  end-to-end through `runScan`; leaderboard shape matches a Claude run's shape.
- **Builder extension:** `test/helpers/builder.ts` gains a gemini-shaped emitter (a
  harness/format parameter or a parallel builder) so synthetic qwen fixtures share
  the existing fixture pipeline.
- **Privacy:** a prose marker seeded in a user text part / `functionCall.args` /
  `functionResponse.response` is absent from every output field.
- **Byte-identical default:** the existing Claude leaderboard snapshot is unchanged.
- **Config:** `harness:` accepted + validated; unknown values rejected; existing
  keys unaffected.
- **CLI:** `--harness`/`--harness-dir` select correctly; `--claude-dir` alias works
  and conflicts with `--harness qwen`.

## 11. Open questions (slice-specific)

1. **Qwen hook contract (top risk).** The settings.json hook shape, the hook stdin
   payload, and the expected return payload (§8) must be confirmed against Qwen
   Code's docs/source before `init qwen` writes a hook. Scan parity does not depend
   on this.
2. **GigaCode format identity.** Assumed byte-identical to Qwen (user reports a full
   clone). Confirm against a real `~/.gigacode` sample during implementation; if any
   field differs, gigacode gets its own taxonomy/parser constants rather than
   reusing qwen's verbatim.
3. **Tool-call outcome authority.** Both `toolCallResult.status` and the
   `ui_telemetry` `qwen-code.tool_call` event carry success/duration. Decide the
   precedence (telemetry is richer; `toolCallResult` is always present) and pin it
   with tests.
4. **Auto-detection of installed harnesses.** Deferred (§2). A future `scan` with no
   `--harness` could probe known roots; cross-harness dedup is the precondition.
5. **Qwen subagent + API-log transcripts.** Whether `subagents/` and
   `~/.qwen/logs/openai/` carry useful struggle signal is unexplored; deferred.

## 12. Relation to parent design

Implements the **Qwen Code** arm of issue #23 (agent adapters) and establishes the
adapter seam the issue describes: *"Each adapter parses native transcripts into the
normalized event schema; `harnessgap init` installs the right hook/command/plugin.
Adapters are the only per-agent code; the detector + Diagnoser are agent-agnostic."*
GigaCode rides along as a parameterized Qwen. Codex CLI and OpenCode (the issue's
other two adapters) remain deferred and will slot into the same `HarnessSpec` seam.

The detection core (`NormalizedEvent`, `StruggleRecord`, `scoreSessions`,
`localizeAreas`, `aggregateAreas`, the Diagnoser, default output) is unchanged —
the Slice 1–4 invariants hold. This broadens the input surface (more harnesses)
without altering the loop: detect → (diagnose) → reflect.

## TL;DR

This slice makes harnessgap read **Qwen Code** and **GigaCode** transcripts with
full Claude parity — `scan`, `init`, `reflect`. Qwen's format is Gemini-style
(`message.parts[]`, `functionCall`/`functionResponse`, **parallel calls paired by
call id**, outcomes in `ui_telemetry`), so it gets its own well-bounded
`src/adapter/qwen/` (parse + taxonomy + stream/merge) behind a new
**`HarnessSpec` + dispatcher** seam; GigaCode reuses the Qwen adapter with
`~/.gigacode` + `GIGACODE.md`. Discovery generalizes to a layout descriptor
(`projects/` + optional `chats/`), preserving every symlink/confinement/fail-open
invariant. `NormalizedEnvelope.agent` widens to a `HarnessId` union. CLI gains
`--harness` / `--harness-dir` (with `--claude-dir` kept as a deprecated alias) and
`init qwen|gigacode`; config gains `harness:`. The detector, scorer, areas,
ambient, aggregator, Diagnoser, and `human`/`json`/`calibrate` output are
**untouched** — Claude output stays byte-identical. Scan parity is high-confidence;
`init qwen`/`init gigacode` hook parity is design-now with the exact Qwen hook
contract flagged as the one implementation-time unknown. No new network, no `git`,
no raw prose in any output; Codex/OpenCode and multi-harness aggregation stay
deferred.
