# harnessgap — Session-End Reflect (Slice 3: event-driven detection + in-session recommendation)

**Status:** approved design (brainstormed) → revised post-review (rev 2) → spec review → implementation planning
**Date:** 2026-07-15
**Parent design:** `docs/DESIGN.md` (v0.2) — implements the Ingest + `/reflect` trigger modes (§5) in event-driven form.
**Prior slices:** Slice 1 detection (`specs/archive/2026-07-12-harnessgap-detection-slice-design.md`, shipped v0.1.1); Slice 2 ambient (`specs/active/2026-07-14-harnessgap-ambient-struggle-design.md`, approved, not yet implemented).
**Rev 2:** incorporates a 3-agent review (hook-mechanics verification, adversarial, codebase-fit). Fixes: Stop allow-output is `{}` not `{"decision":"approve"}`; fail-open made concrete via an `init`-installed wrapper; manual path is `reflect --latest` (not `scan --limit 1`, which sorts lexicographically and includes in-progress sessions); `trip = flagged && !zero_edit`; trip-gate sensitivity flagged as the top dogfood risk.
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

### Success criterion (manual dogfood, à la Slice 1)

On a real repo, across the first few sessions (n < `bootstrap_session_floor`):

1. After a genuinely struggling session, the Stop hook trips and the agent presents a
   **non-generic** recommendation — a real `target_path` that exists, tied to the session's top
   signals. (Recommendation quality is human-judged, like Slice 1's dogfood gate.)
2. After a clean / Q&A session, the hook stays **silent** (`trip:false`) — no forced reflection,
   no noise.
3. **Trip frequency:** on a sequence of ordinary (non-struggling) sessions, the hook fires on a
   small minority — if it fires on most, the trip gate is too loose and must be tightened (§11.1)
   before merge.
4. Zero disruption: a broken/missing transcript, a detector error, or a missing binary never
   blocks the session (fail-open — silent allow).
5. Slice 1/2 outputs unchanged (the `scan` leaderboard and snapshot are byte-identical).

## 2. Scope

**In scope**

- A `harnessgap reflect --transcript <path>` command: the single-session slice of the detection
  pipeline (no walk, no repo filter, no aggregation), bootstrap-forced at n=1.
- A `--latest --repo <path>` mode on `reflect`: resolves the most recent **finished** session for
  a repo (used by the manual skill, which has no `transcript_path`).
- A `--format hook-stop` output formatter: renders the finding as a Claude Code `Stop`-hook
  result (`block`+reason on trip, else `{}`).
- A `harnessgap init claude` installer: appends a trip-gated `Stop` hook (via a fail-open
  wrapper) to `.claude/settings.json` and writes the `/reflect` skill, idempotently.
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

1. **Reframe, don't reinvent — but calibrate the gate.** The detector already handles n=1
   (bootstrap mode: `flagged = composite ≥ bootstrap_flag_pct OR ≥ 2 signals trip`). This slice
   runs that path on the just-finished transcript. The **v1 trip gate is `record.flagged &&
   !zero_edit`** — reusing the bootstrap flag with no new signal. **Honest caveat:** `flagged`
   was calibrated for the *batch* leaderboard (where relative scoring absorbs noise), not for a
   per-session *interruption*; at n=1 with absolute thresholds it may fire too often. Trip
   frequency is therefore a dogfood gate with a named tightening lever (§11.1).
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

`harnessgap reflect (--transcript <path> | --latest --repo <path>) [--config <path>] [--claude-dir <path>] [--format json|hook-stop]`.

Single-session pipeline (the n=1 slice of `runScan` — no walk, no filter, no aggregate):

> resolve the target transcript (`--transcript` directly, or `--latest --repo` → most recent
> finished session by `started_at`, excluding the running one) → `streamSession` →
> `resolveMainRepo` (first distinct cwd) → `relativizeEnvelopeFiles` →
> `runDetector([envelope], cfg, forceBootstrap=true)` → one `StruggleRecord`.

- `forceBootstrap` is forced (n=1 < `bootstrap_session_floor`), so scoring is the validated
  bootstrap path.
- `trip = record.flagged && !zero_edit`. Zero-edit (pure Q&A) sessions never trip, even when
  `reread ≥ 5`, so exploration-only sessions never force a reflection. `trip` is a v1 prior; its
  sensitivity is a dogfood gate (§11.1).
- Default `--format json` emits `ReflectFinding`; `--format hook-stop` emits the Stop-hook
  result.
- Reads only the target transcript; writes nothing.

## 5. Contracts

### 5.1 `ReflectFinding` (`reflect --json`)

Wraps the existing `StruggleRecord` **unchanged**; adds two derived fields:

```jsonc
{ "schema_version": 1,
  "session_id": "...", "repo": "/abs/path", "mode": "bootstrap",
  "record": { /* StruggleRecord: score_pct, flagged, signals, areas, … */ },
  "trip": true,            // = record.flagged && !zero_edit — the gate the hook acts on
  "zero_edit": false }     // no edits this session (Q&A) → trip forced false
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

`kind:"none"` is the honest "nothing to add" exit. `path_verified` is a self-attested light
fact-check — acceptable because the recommendation is advisory and human-reviewed (§11.4).

### 5.3 Stop-hook output (`--format hook-stop`, new `src/output/hook.ts`)

```jsonc
// trip && !stop_hook_active → force one reflection turn (reason is shown to Claude):
{ "decision": "block", "reason": "<reflection prompt + finding summary>" }
// otherwise → allow stop (empty object, OR exit 0 with no stdout):
{ }
```

Output is **strict-validated** by Claude Code: only `decision`, `reason`, `systemMessage` are
accepted — any other field fails with `JSON validation failed` — so the formatter emits exactly
these. (Rev-2 correction: the allow path is `{}`, **not** `{"decision":"approve"}`, which is not
a valid Stop decision.) The `reason` carries the finding summary (areas, top signals) so the
agent need not re-invoke `reflect`. `stop_hook_active` (from Claude Code's hook input) is the
loop guard.

## 6. Trigger & data flow

**Auto (Stop hook).** Agent stops → Claude Code calls the hook with `transcript_path` +
`stop_hook_active` → the `init`-installed wrapper runs
`harnessgap reflect --transcript <path> --format hook-stop` → on `trip && !stop_hook_active`,
emits `block` + reason (finding summary + reflection prompt) → agent continues one turn, fills
the frame, verifies the path, presents, offers to act → stops (next Stop: `stop_hook_active`
true → `{}`). Nothing written.

**Manual (`/reflect` skill).** User invokes `/reflect` → the skill calls
`harnessgap reflect --latest --repo . --json` (the skill has no `transcript_path`; `--latest`
resolves the most recent finished session by `started_at`, excluding the running one) → reads
the `ReflectFinding` → fills the frame → presents.

## 7. `init claude`

`harnessgap init claude` writes, idempotently:

- a `Stop` hook entry **appended** to the `Stop` hooks array in `.claude/settings.json`
  (existing user Stop hooks are preserved — never clobbered), invoking a small **fail-open
  wrapper** that runs `harnessgap reflect --format hook-stop`;
- the `/reflect` skill file.

The wrapper (not a bare `harnessgap` call) is **load-bearing**: Claude Code treats a non-zero
exit or a missing command as a hook error that **blocks and surfaces stderr** to the agent — the
opposite of fail-open. The wrapper guarantees any failure (missing binary, non-zero exit, thrown
error) resolves to exit 0 + `{}` (silent allow). It must not assume a global npm install (the
absolute binary path is baked in).

## 8. Module / data-flow placement

All detection additions are pure or thin-orchestration; the only new I/O is reading one
transcript (already in `streamSession`) and `init`'s explicit config writes.

| Change | Location | Responsibility |
|---|---|---|
| `reflect` + `init` subcommands | `src/cli.ts` | commander wiring. |
| `runReflect(target, cfg) → ReflectFinding` | `src/pipeline.ts` (new thin orchestrator) | `--transcript` uses the path directly; `--latest --repo` resolves the most recent finished session by `started_at` first. Then `streamSession` → resolve → relativize → `runDetector(forceBootstrap)`. The n=1 analog of `runScan`; reuses every stage. |
| `formatStopHookOutput(finding, stopHookActive)` | **`src/output/hook.ts` (new)** | `block`+reason / `{}`. Emits only `decision`/`reason`/`systemMessage` (strict validation). The only Claude-Code-specific renderer. |
| Installer + wrapper + skill template | **`src/init/` (new)** | idempotent append to the `settings.json` Stop hooks array; the fail-open wrapper; the skill file; absolute-path resolution. |
| `ReflectFinding`, `ReflectFrame`, `StopHookOutput` | `src/types.ts` | new types; **`StruggleRecord` unchanged.** |

Reused verbatim: `streamSession`, `resolveMainRepo`, `relativizeEnvelopeFiles`, `runDetector`,
`scoreSessions`, `localizeAreas`, `assembleStruggleRecord`, scrubbing, size caps,
`loadConfig` / `DEFAULT_CONFIG`. **No new config keys; no new runtime dependencies.**

## 9. Error handling — fail-open (all Slice 1/2 guarantees preserved)

- **Never disrupts the session.** Any failure (missing/malformed/unreadable transcript,
  unresolvable cwd, detector error) → `--format hook-stop` emits `{}` + exit 0. The binary itself
  guarantees exit 0 + valid JSON on every error path. A wrong finding is the worst case, never a
  broken session.
- **Missing/broken binary at hook time** → the `init`-installed wrapper (§7) catches it and emits
  `{}` + exit 0. Without that wrapper, Claude Code would treat the failed/missing command as a
  blocking hook error (non-zero exits block and surface stderr) — so the wrapper is load-bearing,
  not cosmetic.
- **No network, no detection-path writes.** Still true; `reflect` only reads one transcript and
  prints. `init` is an explicit installer that writes hook/skill config — the only new write
  surface, outside the detection contract.
- **Privacy.** `ReflectFinding`, the hook `reason`, and `--json` carry only derived
  values/paths/counts (scrubbing + size caps reused). The slice adds **no new egress channel or
  vendor** — no headless call, transcripts are not re-sent; the `reason` and the agent's
  `ReflectFrame` flow only within the already-egressing session (they do add in-session tokens,
  which is not a new data path).
- **`init` safety.** Idempotent; appends to the `Stop` hooks array in existing
  `.claude/settings.json`; preserves other hooks.

## 10. Testing

- **`reflect` integration:** corpus fixture → correct `ReflectFinding`; `trip` true/false at
  boundaries; bootstrap forced at n=1; zero-edit session → `trip:false, zero_edit:true` even with
  `reread ≥ 5`. Real pipeline, no mocking.
- **`--latest` resolution:** returns the most recent session by `started_at`; excludes the
  running session; deterministic on a multi-session fixture.
- **`--format hook-stop` unit:** `block`+reason on trip; `{}` otherwise; respects
  `stop_hook_active`; output contains only `decision`/`reason` (+ `systemMessage`); no raw prose.
- **`init` unit:** appends to the Stop hooks array; idempotent; preserves existing hooks; writes
  the wrapper + skill; bakes absolute path.
- **Fail-open wrapper:** missing binary / non-zero exit / thrown error → `{}` + exit 0.
- **Privacy / egress / packaging:** prose-marker fixture → no marker in finding / `reason` /
  `--json`; all values numbers/paths/closed-enums. Egress + packaging tests pass unmodified (no
  new deps/I/O).
- **Slice 1/2 regression:** `scan` corpus (≥80% bar) and leaderboard snapshot **unchanged**
  (scorer/aggregator/`runScan` untouched) — the non-corruption assertion.

## 11. Open questions (slice-specific)

1. **Trip-gate sensitivity (top risk).** `trip = flagged && !zero_edit` reuses the bootstrap
   flag, calibrated for the *batch* leaderboard, not a per-session *interruption*. At n=1 it may
   fire on ordinary sessions (e.g., one debug loop hitting `reread` + `wall_clock`). The dogfood
   gate (§1.3) must measure trip frequency on clean sessions; if too high, tighten via one of:
   (a) drop the `≥ 2 signals` disjunction and require `composite ≥ bootstrap_flag_pct`; (b) raise
   to `≥ k` signals (k=3); (c) a dedicated `detector.reflect` block. Pinned before merge, à la
   the ambient slice's calibration.
2. **`--latest` exclusion mechanism.** `reflect --latest --repo .` must exclude the
   currently-running session — confirm how (session_id passed by the skill vs. a completion
   heuristic) during implementation.
3. **Per-stop latency.** Computing `trip` runs the detector on every stop (cheap, size-capped,
   fail-open, bounded to ~one meaningful run by `stop_hook_active`). Accept for v1; a cheap
   pre-check is a fast-follow if felt.
4. **Reflection quality.** The frame's prose is LLM-generated; structure + `path_verified`
   mitigate but don't eliminate generic/wrong advice. `path_verified` is self-attested (agents
   hallucinate paths) — acceptable because the recommendation is advisory and human-reviewed. The
   slice ships the mechanism + a deterministic spine; quality is bounded by the model.
5. **Block-reason content.** Leaned embedding the finding summary in `reason` (avoids a
   re-invoke). Confirm.
6. **`init` wrapper form.** The exact wrapper (shell vs. a bundled JS shim emitted by `init`)
   that guarantees fail-open on missing binary is a packaging detail to pin during
   implementation.

## 12. Relation to parent design

Implements the **Ingest + `/reflect` trigger modes** (`DESIGN.md` §5) in **event-driven**
(single-session) form rather than batch. Advances only the loop's *entry* (detect + reflect at
session end); the Diagnoser/Synthesizer/Router/Measurement closed loop remains deferred.
Detection stays behavioral; the rejected structural-absence prong (ambient spec §3) stays
rejected. Complements Slice 2 (ambient) without depending on it — `reflect` needs only Slice 1's
detector + bootstrap mode.

## TL;DR

Slice 3 reframes harnessgap's detector from **batch** to **event-driven**: a
`harnessgap reflect (--transcript <path> | --latest --repo <path>)` command runs the existing
single-session pipeline (bootstrap-forced at n=1) and emits a `ReflectFinding` whose
**`trip = flagged && !zero_edit`** reuses the bootstrap gate (a v1 prior whose
interruption-sensitivity is a dogfood gate, §11.1). A `--format hook-stop` renderer (new
`src/output/hook.ts`, the only Claude-Code-specific code) turns it into a `Stop`-hook result
that **blocks reflection only on trip** — emitting `{ "decision":"block", "reason":… }`, else
`{}` — with `stop_hook_active` guarding the loop; clean sessions stay silent. `harnessgap init
claude` appends the hook via a **fail-open wrapper** (load-bearing: non-zero exits block in
Claude Code) and writes a `/reflect` skill. The agent fills a small `ReflectFrame` (cost /
missing-context / one suggested change with a **fact-checked target path**), presents it
in-session, and the user acts — **nothing is written**, no doc authoring, no persistence.
`StruggleRecord` / scorer / aggregator / `runScan` are untouched (Slice 1/2 outputs
byte-identical); no new config, no new deps, no new network. It closes the temporal bootstrap
gap (signal from session 1, not session 30) while preserving every Slice 1/2 guarantee;
diagnosis/synthesis/routing/measurement stay deferred.
