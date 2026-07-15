# harnessgap — Session-End Reflect (Slice 3: event-driven detection + in-session recommendation)

**Status:** approved design (brainstormed) → spec review → implementation planning
**Date:** 2026-07-15
**Parent design:** `docs/DESIGN.md` (v0.2) — implements the Ingest + `/reflect` trigger modes (§5) in event-driven form.
**Prior slices:** Slice 1 detection (`specs/archive/2026-07-12-harnessgap-detection-slice-design.md`, shipped v0.1.1); Slice 2 ambient (`specs/active/2026-07-14-harnessgap-ambient-struggle-design.md`, approved, not yet implemented).
**Runtime:** Node + TypeScript, `npx harnessgap`; the detection path remains stateless and offline.

## 1. Purpose

Slices 1/2 detect struggle only in **batch** — `harnessgap scan` walks `~/.claude/projects/`,
needs ≥30 sessions for percentile mode and ≥10 for the ambient finding. On a fresh or
thin-history repo there is no signal until sessions accumulate. This slice closes that
**temporal bootstrap gap**: produce a harness-improvement recommendation at **session end, from
session 1**, by reframing the existing detector from batch to **event-driven** and adding a
lightweight in-session reflection.

It does **not** author or persist docs. The recommendation is **ephemeral, in-session**: the
agent presents it, the user acts or not, nothing is written. Diagnosis, synthesis, routing,
measurement, and team recurrence remain deferred (as in Slices 1/2). The structural/`repo`
reasoning rejected in the ambient spec (§3) stays rejected — detection remains behavioral.

### Success criterion (manual dogfood)

On a real repo, across the first few sessions (n < `bootstrap_session_floor`):

1. After a genuinely struggling session, the Stop hook trips and the agent presents a
   **non-generic** recommendation — a real `target_path` that exists, tied to the session's top
   signals.
2. After a clean / Q&A session, the hook stays **silent** (`trip:false`) — no forced reflection,
   no noise.
3. Zero disruption: a broken/missing transcript or a detector error never blocks the session
   (fail-open to `approve`).
4. Slice 1/2 outputs unchanged (the `scan` leaderboard and snapshot are byte-identical).

## 2. Scope

**In scope**

- A `harnessgap reflect --transcript <path>` command: the single-session slice of the detection
  pipeline (no walk, no repo filter, no aggregation), bootstrap-forced at n=1.
- A `--format hook-stop` output formatter: renders the finding as a Claude Code `Stop`-hook
  result (`block`+reason on trip, else `approve`).
- A `harnessgap init claude` installer: writes the trip-gated `Stop` hook into
  `.claude/settings.json` and the `/reflect` skill, idempotently.
- A `/reflect` skill (agent guidance): consume the finding, fill a small reflection frame,
  fact-check the suggested path, present in-session.
- New `ReflectFinding` + `ReflectFrame` contracts; a `StopHookOutput` shape.

**Out of scope (deferred)**

- **Doc authoring / synthesis / curation / routing / measurement** — unchanged from Slice 1/2
  deferrals. The recommendation is advisory and ephemeral; no `docs/_proposals/`, no Curator, no
  Router, no read-vs-not-read delta.
- **Persistence / team recurrence** — nothing is written by the detection path; `init` writes
  only hook/skill config on explicit request.
- **Structural-absence / file-presence checks** — rejected (ambient spec §3). Detection stays
  behavioral.
- **The Diagnoser** — cause attribution is not attempted; the frame's `change.kind` /
  `rationale` are the agent's, presented as a suggestion, not a typed cause.
- **Non-Claude-Code agents** — the hook/skill UX is Claude-Code-only this slice; the `reflect`
  core is agent-agnostic and future adapters (Codex/OpenCode) slot alongside
  `src/output/hook.ts` + `src/init/`.

## 3. Principle — event-driven detection + reflection as presented evidence

1. **Reframe, don't reinvent.** The detector already handles n=1 (bootstrap mode: `flagged =
   composite ≥ bootstrap_flag_pct OR ≥ 2 signals trip`). This slice runs that path on the
   just-finished transcript. The **trip gate reuses `flagged`** — no new threshold, no new
   signal.
2. **Separation of concerns.** Binary = deterministic data (`reflect`); adapter = Claude-Code
   rendering (`--format hook-stop`, `init`, skill). The skill contains **agent guidance, not
   detection logic**.
3. **Reflection is presented evidence, not a verdict or an artifact.** The agent fills a small
   frame tied to the deterministic finding; the user decides. It is never persisted and never
   auto-applied. This keeps the "observe, don't verdict" stance (ambient spec §3) while adding
   the qualitative "why" the detector cannot produce.
4. **Force when warranted, not always.** The Stop hook blocks reflection **only on trip**
   (`stop_hook_active` guards the loop); clean sessions are silent. A manual `/reflect` remains
   available.

## 4. The `reflect` command

`harnessgap reflect --transcript <path> [--config <path>] [--claude-dir <path>] [--format json|hook-stop]`.

Single-session pipeline (the n=1 slice of `runScan` — no walk, no filter, no aggregate):

> `streamSession(path)` → `resolveMainRepo` (first distinct cwd) → `relativizeEnvelopeFiles`
> → `runDetector([envelope], cfg, forceBootstrap=true)` → one `StruggleRecord`.

- `forceBootstrap` is forced (n=1 < `bootstrap_session_floor`), so scoring is the validated
  bootstrap path.
- `trip = record.flagged` (bootstrap). A zero-edit Q&A session yields no tripping signals →
  `trip:false`, `zero_edit:true`.
- Default `--format json` emits `ReflectFinding`; `--format hook-stop` emits the Stop-hook
  result.
- Reads only the given transcript; writes nothing.

## 5. Contracts

### 5.1 `ReflectFinding` (`reflect --json`)

Wraps the existing `StruggleRecord` **unchanged**; adds two derived fields:

```jsonc
{ "schema_version": 1,
  "session_id": "...", "repo": "/abs/path", "mode": "bootstrap",
  "record": { /* StruggleRecord: score_pct, flagged, signals, areas, … */ },
  "trip": true,            // = record.flagged — the gate the hook acts on
  "zero_edit": false }     // no edits this session
```

No raw prose; only derived signal values, paths, integer counts (privacy preserved).

### 5.2 `ReflectFrame` (agent-filled; ephemeral, never persisted)

The recommendation's logical shape, filled by the agent from the finding:

```jsonc
{ "cost":      "…",                       // one line, tied to a top signal
  "missing":   "…",                       // one line: context that would have helped
  "change": { "target_path": "docs/…",    // repo-relative
              "kind": "add" | "improve" | "none",
              "rationale": "…" },         // one line
  "path_verified": true }                 // agent confirmed the path (or its parent) exists
```

`kind:"none"` is the honest "nothing to add" exit. `path_verified` is the light fact-check.

### 5.3 Stop-hook output (`--format hook-stop`, new `src/output/hook.ts`)

```jsonc
// trip && !stop_hook_active:
{ "decision": "block", "reason": "<reflection prompt + finding summary>" }
// otherwise:
{ "decision": "approve" }
```

The `reason` carries the finding summary (areas, top signals) so the agent need not re-invoke
`reflect`. `stop_hook_active` (from Claude Code's hook input) is the loop guard.

## 6. Trigger & data flow

**Auto (Stop hook).** Agent stops → Claude Code calls the hook with `transcript_path` +
`stop_hook_active` → `harnessgap reflect --transcript <path> --format hook-stop` → on
`trip && !stop_hook_active`, emits `block` + reason (finding summary + reflection prompt) →
agent continues one turn, fills the frame, verifies the path, presents, offers to act → stops
(next Stop: `stop_hook_active` true → `approve`). Nothing written.

**Manual (`/reflect` skill).** User invokes `/reflect` → agent runs
`harnessgap scan --repo . --limit 1 --since 1h --json` (reusing `scan` to fetch the most recent
session — the skill does not reliably receive `transcript_path`) → reads the record → fills the
frame → presents. The hook path uses `reflect --transcript` since it has the path for free.

## 7. `init claude`

`harnessgap init claude` writes, idempotently (merge, never clobber):

- a `Stop` hook entry in `.claude/settings.json` invoking
  `harnessgap reflect --format hook-stop`, with the resolved absolute binary path baked in;
- the `/reflect` skill file.

It must not assume a global npm install (bakes the absolute path). Re-running merges; existing
user hooks are preserved.

## 8. Module / data-flow placement

All detection additions are pure or thin-orchestration; the only new I/O is reading one
transcript (already in `streamSession`) and `init`'s explicit config writes.

| Change | Location | Responsibility |
|---|---|---|
| `reflect` + `init` subcommands | `src/cli.ts` | commander wiring. |
| `runReflect(transcriptPath, cfg) → ReflectFinding` | `src/pipeline.ts` (new thin orchestrator) | `streamSession` → resolve → relativize → `runDetector(forceBootstrap)`. The n=1 analog of `runScan`; reuses every stage. |
| `formatStopHookOutput(finding, stopHookActive)` | **`src/output/hook.ts` (new)** | `block`+reason / `approve`. The only Claude-Code-specific renderer. |
| Installer + skill template | **`src/init/` (new)** | idempotent `settings.json` merge; skill file; absolute-path resolution. |
| `ReflectFinding`, `ReflectFrame`, `StopHookOutput` | `src/types.ts` | new types; **`StruggleRecord` unchanged.** |

Reused verbatim: `streamSession`, `resolveMainRepo`, `relativizeEnvelopeFiles`, `runDetector`,
`scoreSessions`, `localizeAreas`, `assembleStruggleRecord`, scrubbing, size caps,
`loadConfig` / `DEFAULT_CONFIG`. **No new config keys; no new runtime dependencies.**

## 9. Error handling — fail-open (all Slice 1/2 guarantees preserved)

- **Never disrupts the session.** Any failure (missing/malformed/unreadable transcript,
  unresolvable cwd, detector error) → `--format hook-stop` emits `approve`, exit 0. A wrong
  finding is the worst case, never a broken session.
- **Missing/broken binary at hook time** → the hook entry resolves to `approve` (absolute path
  baked by `init`; entry constructed so a failed invocation fails open).
- **No network, no detection-path writes.** Still true; `reflect` only reads one transcript and
  prints. `init` is an explicit installer that writes hook/skill config — the only new write
  surface, outside the detection contract.
- **Privacy.** `ReflectFinding`, the hook `reason`, and `--json` carry only derived
  values/paths/counts (scrubbing + size caps reused). The `ReflectFrame` is the agent's own text
  in its own session — no new egress surface.
- **`init` safety.** Idempotent; merges into existing `.claude/settings.json`; preserves other
  hooks.

## 10. Testing

- **`reflect` integration:** corpus fixture → correct `ReflectFinding`; `trip` true/false at
  boundaries; bootstrap forced at n=1; zero-edit session → `trip:false, zero_edit:true`. Real
  pipeline, no mocking.
- **`--format hook-stop` unit:** `block`+reason on trip; `approve` otherwise; respects
  `stop_hook_active`; `reason` carries the finding summary and no raw prose.
- **`init` unit:** writes settings + skill; idempotent; merges without clobbering; bakes
  absolute path.
- **Privacy / egress / packaging:** prose-marker fixture → no marker in finding / `reason` /
  `--json`; all values numbers/paths/closed-enums. Egress + packaging tests pass unmodified (no
  new deps/I/O).
- **Fail-open:** missing/malformed transcript → `approve`, exit 0, no throw.
- **Slice 1/2 regression:** `scan` corpus (≥80% bar) and leaderboard snapshot **unchanged**
  (scorer/aggregator/`runScan` untouched) — the non-corruption assertion.

## 11. Open questions (slice-specific)

1. **Manual-path input.** Leaned `scan --repo . --limit 1 --since 1h` (reuses `scan`, avoids
   transcript-path discovery in the skill). Confirm vs. having the skill discover the latest
   `.jsonl` itself.
2. **Per-stop latency.** Computing `trip` runs the detector on every stop (cheap, size-capped,
   fail-open, bounded to ~one meaningful run by `stop_hook_active`). Accept for v1; a cheap
   pre-check is a fast-follow if felt.
3. **Reflection quality.** The frame's prose is LLM-generated; structure + `path_verified`
   mitigate but don't eliminate generic/wrong advice. The slice ships the mechanism + a
   deterministic spine; recommendation quality is bounded by the model.
4. **Block-reason content.** Leaned embedding the finding summary in `reason` (avoids a
   re-invoke). Confirm.
5. **`init` fail-open construction.** The exact form of the `settings.json` entry that fails
   open on a missing binary is a packaging detail to pin during implementation.

## 12. Relation to parent design

Implements the **Ingest + `/reflect` trigger modes** (`DESIGN.md` §5) in **event-driven**
(single-session) form rather than batch. Advances only the loop's *entry* (detect + reflect at
session end); the Diagnoser/Synthesizer/Router/Measurement closed loop remains deferred.
Detection stays behavioral; the rejected structural-absence prong (ambient spec §3) stays
rejected. Complements Slice 2 (ambient) without depending on it — `reflect` needs only Slice 1's
detector + bootstrap mode.

## TL;DR

Slice 3 reframes harnessgap's detector from **batch** to **event-driven**: a
`harnessgap reflect --transcript <path>` command runs the existing single-session pipeline
(bootstrap-forced at n=1) and emits a `ReflectFinding` whose **`trip = flagged`** reuses the
bootstrap gate with no new threshold. A `--format hook-stop` renderer (new `src/output/hook.ts`,
the only Claude-Code-specific code) turns it into a `Stop`-hook result that **blocks reflection
only on trip** (`stop_hook_active` guards the loop; clean sessions stay silent), and
`harnessgap init claude` installs the hook + a `/reflect` skill. The agent fills a small
`ReflectFrame` (cost / missing-context / one suggested change with a **fact-checked target
path**), presents it in-session, and the user acts — **nothing is written**, no doc authoring,
no persistence. `StruggleRecord` / scorer / aggregator / `runScan` are untouched (Slice 1/2
outputs byte-identical); no new config, no new deps, no new network. It closes the temporal
bootstrap gap (signal from session 1, not session 30) while preserving every Slice 1/2
guarantee; diagnosis/synthesis/routing/measurement stay deferred.
