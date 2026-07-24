# harnessgap — Closed-Loop MVP (Phase 2 lite: Synthesizer + Review + Routing-lite + Measurement-lite)

**Status:** approved design (post 3-agent adversarial review) → implementation planning
**Date:** 2026-07-24
**Parent design:** `docs/DESIGN.md` (v0.2) — §4.4 Synthesizer, §4.5 Curator, §4.6 Router, §4.7 Measurement, §5 Trigger modes, §8 Privacy.
**Builds on:** Slices 1–4 (Detector, ambient `repo` unit, session-end Reflect, Diagnoser) + the multi-harness adapters (Claude Code / Qwen Code / GigaCode) — all merged.

## 1. Purpose

Slices 1–4 proved **detection + diagnosis**. This slice makes the downstream half of the closed loop real — but **minimal per stage** — so the loop runs end-to-end on one example for the MVP demo:

> detect → diagnose → **synthesize** → **review** → (route via `explain`) → (measure doc-read consumption)

Each new stage is the thinnest version that is genuinely real (not a mockup), with the heavy machinery (live Router hook, read-vs-not-read delta, embeddings dedupe, team recurrence, `edit-proposal`) explicitly deferred (§2, §13). Calibration / validation of detection precision (issue #34, Phases 1 & 3) is **deferred as an accepted risk** (§11).

### Posture: favor recall, gate false-positives on correctness

Detector sensitivity is favored — lowering `detector.flag_pct` is a config knob, no code. False positives are tolerated because every artifact is human-reviewed. **But** this is only safe because of three controls, and the posture is honest about an aggregate + a wrong-cause risk the gates do *not* fully close:

1. **Diagnoser prose-gate (parent §4.3):** only `cause ∈ {doc, config-doc}` (and above a confidence floor, §5.2/§9) ever produces prose; other causes collapse into a single digest card.
2. **Synthesizer pre-review fact-check (parent §4.4):** cited symbols resolve, referenced paths resolve, `source_files@commit` SHAs are valid — checked against HEAD *before* a proposal is written.
3. **Aggregate throttle (§5.2):** `synthesize` caps to the top-N (default 3) `doc`/`config-doc` areas per run, so a recall-favored scan cannot bury the reviewer under 15–20 proposals. "FP is cheap" is true per-artifact *and* bounded in aggregate.

**Honest caveat — wrong-cause prose.** The fact-check catches *factually-wrong* docs, not *wrong-cause* docs, and the Diagnoser is uncalibrated (§11). Misclassifying a `refactor-flag` area as `doc` yields plausible prose that passes every gate (the §4.3 failure mode). Mitigations: `review` surfaces the `evidence_refs` so a human sanity-checks the *rationale*, not just the label (§6); the demo requires a **user-selected** `--unit` so it cannot accidentally ship a mis-classification; and a `confidence_floor_for_prose` knob downgrades low-confidence causes to rationale cards (§5.2/§9).

### Success criterion (MVP demo)

On a real repo with Claude Code history, the closed loop runs end-to-end and produces **≥1 fact-checked, reviewable new-doc proposal** (`cause = doc` or `config-doc`, confidence ≥ floor) from a **user-selected** unit, reviewable via `harnessgap review`, with **`docs_read` visible in the demo** (surfaced by `explain`, §8). The quantitative ≥25% read-vs-not-read struggle-delta target (parent §11) remains out of scope.

## 2. Scope

**In scope**

- `harnessgap synthesize` — opt-in; composes detect → diagnose → synthesize; **new-doc proposals only**; writes to `docs/_proposals/`.
- `harnessgap review` — lists `docs/_proposals/`; accept / reject; surfaces diagnosed cause + confidence + `evidence_refs` + fact-check status.
- `harnessgap explain <area>` — routing lite; pointer + doc body + a `docs_read` consultation count.
- `docs_read: { path, t }[]` + `docs_injected: { path, t, trigger }[]` on `StruggleRecord` — always-on, timing-bearing doc-read consumption (Measurement lite).
- `Proposal` contract (**new-doc only**, with `cited_symbols` + `referenced_paths`) + `synthesizer` config block + per-harness backend map **with envelope-unwrap adapters**.
- A shared `collectEnvelopes(opts)` helper **extracted from `runScan`** (§5.2 step 0), consumed by `runScan`, `synthesize`, and `explain`.
- A pure pointer renderer (`src/router/pointer.ts`) shared by `explain` and the future hook.
- Tests: corpus extension; `Proposal` + fact-check units; per-harness envelope-unwrap units; e2e `synthesize → review`; snapshot/test updates for the new record fields; **`test/egress.test.ts` extended** to scope `child_process` to `src/synthesizer/*`.

**Out of scope (deferred — see §11 / §13.3)**

- The `edit-proposal` Proposal variant (range-apply on accept, second fact-check path) — reserved as the §13.3 extension seam; MVP writes **new-doc only** and emits a "needs human" note if a backend returns `edit-proposal`.
- TF-IDF dedupe — ship `dedupe: 'none'` (the backend decides new/append/supersede; `similarity` left unset; the `dedupe` field remains as the stable seam).
- Live `PreToolUse` Router hook; read-vs-not-read `stats` delta + confidence band; team `.harnessgap/team/struggle.jsonl`; `harnessgap pr`; CLAUDE.md/AGENTS.md fallback index; #34 calibration.
- CLI flags dropped for MVP: `--dry-run`, `--keep`, `--structure-only` (the `structure_only` *config* key remains). `--yes` stays (useful for demo/CI).

## 3. Architecture & data flow

The existing scan pipeline's front (walk → stream → resolve → relativize → filter) is **extracted** into a shared `collectEnvelopes(opts) → NormalizedEnvelope[]` (§5.2 step 0). `runScan`, `synthesize`, and `explain` all compose it. The new stages attach after detect + diagnose:

```
collectEnvelopes(opts)                       ← NEW shared helper (extracted from runScan)
   │  (walk → stream → resolve-main-repo → relativize → filter)
   ▼
runDetector  → StruggleRecord[] (+ docs_read/docs_injected, always-on)
diagnoseUnits → Diagnosis[]
   │
   ▼  synthesize: pick top-N doc/config-doc areas (confidence ≥ floor); prose gate
   │      non-prose / below-floor causes → ONE digest card to docs/_proposals/  (no backend call)
   │      qualifying ▼
Assemble evidence bundle  (Diagnosis + evidence_refs + unit signals
   │   + docs inventory [paths + size-capped bodies, always sent]
   │   + repo file-heads under the area prefix [governed by structure_only], scrubbed)
   ▼
Backend subprocess  (claude -p / qwen -p / gigacode -p, JSON output)
   ▼
5a. per-harness envelope-unwrap adapter  (extractProposal(stdout, harness))
   ▼
5b. shared Proposal schema-validator
   ▼
factCheck(proposal, repoHead) → { failures[] }      (deterministic, against HEAD)
   │   cited_symbols_resolved · referenced_paths_resolved · shas_valid
   │      fail  → write "needs human" note (NO doc written)
   │      pass  ▼
Write NEW-DOC proposal  →  docs/_proposals/<area>-<cause>-<short>.md
   (path is authoritative; frontmatter: derived_from, unit, struggle_score, cause, source_files@sha, created, verification)

harnessgap review        →  docs/_proposals/  →  accept → move to Proposal.path
harnessgap explain <area> →  reads records + on-disk docs  (pointer [pure fn] + body + "N sessions consulted <doc>")
docs_read / docs_injected  ←  collected in the detector (read events + event timestamp t)
```

## 4. The scope-boundary invariant (egress)

The repo's identity is *"default path: stateless, no-network, no-writes"* (CLAUDE.md, `package.json`, `src/cli.ts`, `src/pipeline.ts`), enforced by `src/egress.ts` + `test/egress.test.ts` (audit every `src/` file for network-module imports and global `fetch(` calls; assert zero offenders).

- **Default `scan` / `reflect`: unchanged** — stateless, no-network, no-writes.
- **`synthesize` / `review`: opt-in commands that cross the write + subprocess boundaries.** Network is **delegated to the trusted agent CLI subprocess** (`child_process`) — neither a network-module import nor a `fetch` call, so harnessgap itself imports no network module. Matches parent §8.
- **`test/egress.test.ts` is EXTENDED**, not just re-checked: assert `child_process` imports live **only** in `src/synthesizer/*` (and any new loop-command modules), never in `src/pipeline.ts` / `src/detector/*` / `src/adapter/*`; and no `node:http(s)`/`undici` import lands anywhere in `src/`. The `src/egress.ts` + test docstrings are updated to state the gate guards the **default path only** (opt-in `synthesize` egress is bounded by `child_process` + the trusted agent CLI, not by this gate).
- **Byte-identity is relaxed ONLY for `docs_read` / `docs_injected`.** The `evidence` / `diagnoses` opt-in conditional-spread stays — it is load-bearing (6 tests + the spreads in `record.ts` / `json.ts` / `pipeline.ts`) and has real UX rationale (uncalibrated Diagnoser inputs would noisy up the default leaderboard). **Rule:** *a field is always-on iff it has no privacy/UX cost AND is consumed by a default-path consumer.* `docs_read` qualifies (doc paths, derived, consumed by `explain`/`--json`); `evidence` does not (only the Diagnoser consumes it; surfacing raw Diagnoser inputs by default is noise). Snapshots capture the human leaderboard only (no per-session record), so `docs_read` barely moves them — the real churn is key-absence assertions in the unit tests, which are updated.
- **`--diagnose` stays opt-in — for UX, not cost.** The real reason is that diagnosis adds a CAUSE column to default `scan` output and the cause labels are uncalibrated (§11); opt-in keeps the default leaderboard clean. (`synthesize` turns it on internally regardless, so "cost" would be an incoherent justification — `gatherRepoContext` is bounded `stat` calls + pure classification.)
- **Prompt-template hygiene:** the synthesis prompt is `.ts` source, and `FORBIDDEN_FETCH_CALL` flags `fetch(` even inside string literals. The prompt template must avoid the literal `fetch(` (or live in a non-`.ts` asset read at runtime).

## 5. Synthesizer

### 5.1 Command surface

`harnessgap synthesize --repo <path> --unit <area> [--harness <id>] [--yes] [--config <path>]`

- Composes detect → diagnose → synthesize. No state, no cache (detection is local/cheap; re-running preserves the stateless identity).
- `--unit <area>` is the demo path (user-selected, per §1 wrong-cause mitigation). Without it, the top-N `doc`/`config-doc` areas are synthesized (capped by `synthesizer.top_n`, default 3).
- Output: the written proposal path(s) on stdout; a `--json` envelope for scripting/tests.
- `--yes` is accepted but `synthesize` never auto-accepts into `docs/` — proposals always land in `docs/_proposals/` for `review`.

### 5.2 Pipeline (per selected unit)

0. **`collectEnvelopes(opts) → NormalizedEnvelope[]`** — the shared I/O preamble extracted from `runScan` (walk → stream → resolve-main-repo → relativize → filter). `runScan` is refactored to call it too.
1. `runDetector` (collecting `docs_read`/`docs_injected`) + `diagnoseUnits` → records + diagnoses.
2. **Prose gate:** a unit proceeds to a backend call iff `cause ∈ {doc, config-doc}` **and** `confidence ≥ diagnose.confidence_floor_for_prose` (default 0.6). Below floor, or non-prose cause → a short entry in a **single digest card** (`docs/_proposals/_digest.md`), no backend call.
3. **Assemble the evidence bundle** (derived-only / scrubbed): the `Diagnosis` (cause, confidence, rationale, `evidence_refs`); the unit's `StruggleRecord` signals + area key; docs inventory (paths **and size-capped bodies**, sent regardless of `structure_only`); repo file-heads under the area prefix (size-capped, scrubbed via `src/adapter/scrub.ts`, governed by `structure_only`).
4. **Backend subprocess (egress-safe):** shell out to the per-harness print-mode CLI, prompt on stdin, capture stdout (§9–§10). **Fail-open:** missing binary / non-zero exit / unparseable output → degrade to a digest entry + clean stderr, never crash.
5. **5a. per-harness envelope-unwrap adapter** `extractProposal(stdout, harness): unknown` — Claude and Qwen wrap results in *different* JSON envelopes (§10); the unwrap is per-harness. **5b. shared Proposal schema-validator** — one validator over the unwrapped object.
6. **Fact-check (deterministic, BEFORE write):** `factCheck(proposal, repoHead)` → `FactCheckResult` (§5.4). **Fail → do not write the doc**; write a "needs human" note listing the failed assertions.
7. **Write the new-doc proposal** to `docs/_proposals/`. If the (unexpected) `edit-proposal` variant comes back, write a "needs human" note instead — MVP does not apply edits.

### 5.3 Proposal contract (parent §4.4, **new-doc only**)

```jsonc
{
  "kind": "new-doc",                 // MVP emits/accepts new-doc only
  "path": "docs/architecture/<area>.md",   // AUTHORITATIVE — review accepts to this path
  "frontmatter": {
    "derived_from": ["<session-id>", "..."],
    "unit": { "kind": "area", "key": "src/billing" },
    "struggle_score": 93,
    "cause": "doc",
    "source_files": ["src/billing/charge.ts@<sha>"],
    "created": "2026-07-24"
  },
  "body": "...",
  "cited_symbols": ["charge", "computeFee"],     // backend MUST populate — fact-check input
  "referenced_paths": ["src/billing/charge.ts"], // backend MUST populate — fact-check input
  "dedupe": {                                     // dedupe:'none' → similarity left unset
    "nearest_existing": "docs/architecture/payments.md",
    "decision_rationale": "different module; new doc"
  },
  "verification": {                                // boolean projection of factCheck() failures
    "cited_symbols_resolved": true,
    "paths_resolved": true,
    "shas_valid": true
  }
}
```

`frontmatter` embeds session IDs only — never transcript text (parent §4.4). The `edit-proposal` variant (`target_doc`/`decision`/`ranges`) is reserved (§13.3) and not produced or applied in MVP.

### 5.4 Fact-check contract

A single swappable function whose contract includes **both extraction-from-structured-fields and resolution**:

```ts
factCheck(proposal: Proposal, repoHead: string): FactCheckResult
// where
FactCheckResult = {
  failures: { assertion: string; kind: 'symbol' | 'path' | 'sha'; resolved: boolean; detail?: string }[]
}
```

- `cited_symbols_resolved` — every entry in `Proposal.cited_symbols` resolves in the cited `source_files` (string match for MVP; AST-level resolution is a drop-in for the *resolution* step, §13.4).
- `paths_resolved` — every `referenced_paths` entry exists on disk; the proposal's own `path` is exempt (it is being created), but must resolve **under a configured `docs_dir`**.
- `shas_valid` — every `source_files@<sha>` pins a real commit.
- `verification` in §5.3 is the boolean projection (`!failures.some(f => !f.resolved)` per kind). A failed check writes a "needs human" note, never a doc.

### 5.5 Privacy

`structure_only` governs the **repo source-file content** sent to the backend: heads-only for MVP. **Loud note:** this is *not* the AST/path skeleton parent §8 describes — heads-only sends real (capped) source, which is *less* private than a skeleton; a full AST skeleton is the v2 upgrade behind the same flag. The docs inventory (for dedupe) sends doc **bodies**, size-capped, regardless of `structure_only`. `source_files@commit` SHAs are recorded for the later staleness check (parent §4.5). Prompt template avoids the literal `fetch(` (§4).

## 6. Review (Curator lite) — parent §4.5

`harnessgap review [--repo <path>] [--json] [--yes]`

- Lists new-doc proposals in `docs/_proposals/` and offers **accept / reject**.
- **Surfaces the diagnosed `cause` + `confidence` + the `evidence_refs` array + the fact-check `verification`** from frontmatter — so a reviewer sanity-checks the *rationale* (wrong-cause mitigation, §1), not just the label, and treats a low-confidence / thin-evidence `doc` differently from a high-confidence one.
- **accept** → moves the artifact to its authoritative `Proposal.path` (validated to be under a configured `docs_dir`). Closes the former open question on category derivation — the path is in the proposal, not derived from `docs_dirs`.
- **reject** → deletes the proposal.
- **edit** → opens `$EDITOR`; MVP trusts the human edit (no re-fact-check — the pre-write check already ran on the backend output; re-check is deferred).
- `--json` lists pending proposals without a TTY; `--yes` accepts non-interactively (demo/CI).

## 7. Doc-read consumption (Measurement lite) — parent §4.7

- Add `docs_read: { path: string; t: string }[]` and `docs_injected: { path: string; t: string; trigger: 'edit' | 'start' }[]` to `StruggleRecord` (both in the parent §4.2 sketch, absent from the implemented type).
- **Timing-bearing shape:** an honest read-vs-not-read delta needs to know whether a doc was read *before* or *after* the struggle event (therapeutic vs diagnostic); the detector already has event timestamps (`NormalizedEvent.t`), so `t` is captured now to avoid re-walking transcripts later. `docs_injected` is reserved empty until routing.
- Collected in the detector from the read-event stream it already walks, scoped to `docs_dirs`. Always-on (§4 rule). Surfaced in `--json` / `--calibrate` **and** by `explain` (consultation count, §8).
- **Layering note:** `docs_dirs` is a top-level `Config` key (already shared with the Diagnoser's `gatherRepoContext`); its doc-comment is updated to state it is consumed by *both* the Diagnoser (doc-existence grounding) and the detector (doc-read scoping). If the parent §6 `docs_dirs` map-shape ever lands, both consumers update together.
- Three construction sites get the new fields: `assembleStruggleRecord`, `degenerateRecord`, and `runDetector` (`tsc` surfaces them at build).

## 8. `explain` (Routing lite) — parent §4.6

`harnessgap explain <area> [--repo <path>] [--harness <id>]`

- Prints the diagnosed **cause** + a one-line **pointer** (*"Before editing `src/billing/`, read `docs/architecture/billing.md`."*) + the relevant **doc body** if one exists + **"N prior sessions consulted `docs/…`"** (derived from the records' `docs_read`, giving the measurement signal a demo surface).
- If no doc exists → points to any proposal in `docs/_proposals/`, or suggests `synthesize --unit <area>`.
- The pointer text is produced by a **pure function** `src/router/pointer.ts` — the one shared leaf the future live hook will also call.
- **Acknowledged divergence:** this is the *pure opt-in command* shape parent §4.6 explicitly **rejects** for v1 ("re-introduces the passivity problem"). It ships here as a **time-boxed demo stand-in** because the live `PreToolUse` hook is deferred (§13.3) and the demo needs *something* to show the routing concept. The pointer-rendering seam (above) is what keeps the eventual hook cheap.
- Stateless and local (composes detect + diagnose on the fly; no writes, no subprocess, no cache). Harness-agnostic in output.

## 9. Config additions — parent §6

New `synthesizer` block + one Diagnoser floor, added to `Config` (`src/config.ts`: `Config`, `DEFAULT_CONFIG`, `KNOWN_TOP_KEYS`, `validateConfig`):

```yaml
synthesizer:
  backend: null            # optional override; null → per-harness default (§10)
  model: null              # optional model override passed through to the backend
  structure_only: false    # heads-only for MVP (NOT the AST skeleton — see §5.5)
  max_file_head_bytes: 4096
  dedupe: none             # none | tfidf  (MVP ships none; field is the stable seam)
  top_n: 3                 # cap doc/config-doc areas synthesized per run (§1 throttle)
diagnose:
  confidence_floor_for_prose: 0.6   # below this, doc/config-doc → digest card, no prose (§1)
```

**Validation** (mirrors the existing `validateConfig` discipline — the spec's earlier "matches config.ts" claim required this): `dedupe ∈ {none, tfidf}`; `max_file_head_bytes ≥ 1`; `top_n ≥ 1`; `backend` is string-or-null; `confidence_floor_for_prose ∈ [0,1]`. `KNOWN_TOP_KEYS` grows by one (`synthesizer`); unknown keys still rejected.

## 10. Multi-harness backend resolution

Detection is already harness-pluggable via `HarnessSpec`; the loop inherits most of this for free (`synthesize`/`review`/`explain`/consumption operate on normalized `Diagnosis` / `StruggleRecord` / on-disk proposals). The one per-harness piece is the **backend + its output envelope**:

| Harness | Default backend | JSON flag | Envelope shape (unwrap adapter) |
|---|---|---|---|
| `claude-code` | `claude -p` | `--output-format json` | `{type:"result", result:"<string>", ...}` — `result` is a JSON *string* re-parsed |
| `qwen-code` | `qwen -p` | `-o json` | Gemini-lineage envelope (different field names/nesting) |
| `gigacode` | `gigacode -p` | `-o json` | **UNVERIFIED** — assumed Qwen parity (full Qwen fork); confirm on install |

- Resolution: explicit `synthesizer.backend` override wins; else the harness→default map. The Proposal *validator* is shared; the **envelope unwrap is a per-harness adapter** (`extractProposal`) — that is the real integration surface, *not* "just a config entry."
- The prompt itself is harness-agnostic (about the repo + diagnosis); only invocation + unwrap differ.
- `claude`/`qwen` confirmed locally; `gigacode` not installed — config-driven, activates on install (unwrap adapter added then).

## 11. Accepted risk: deferred calibration (issue #34)

Per the repo rule (*"not a single follow-up should just be mentioned mid-conversation and then die in it"*), deferred validation is a real plan, not a silent skip.

**In the MVP's tests (not deferred):** extend the labeled fixture corpus (`test/fixtures/corpus/labels.json` + `test/corpus.test.ts`); eyeball one real `scan` (#34 Phase 0).

**Deferred (recorded, not skipped):** #34 Phase 1 (blind precision/recall) + Phase 3 (cause-vs-memory), postponed until post-MVP. Recorded in **`docs/CALIBRATION.md`** (risk accepted; mitigations — percentile auto-calibration + prose-gate + confidence floor + fact-check ⇒ FPs cheap-and-correct; recall-substitute = fixtures + read-the-transcript labeling) and a **comment on issue #34** (deferred-with-reason → satisfies its *"Done means"*).

## 12. Open questions

1. **Backend I/O contract per harness** — exact stdin/stdout + envelope field names for `claude -p --output-format json` vs `qwen -p -o json` vs `gigacode -p` (confirm at implementation; flags + envelope divergence confirmed for claude/qwen).
2. **`structure_only` v2** — AST/path skeleton granularity (heads-only shipped first).
3. **`gigacode` parity** — confirm `-p` + `-o json` + envelope shape once a build is installed.

(Former #3 — proposal path/category derivation — **resolved**: `Proposal.path` is authoritative, §6.)

## 13. Forward-compatibility, status & what's next

*For the next agent: this section is the self-contained state of the closed loop once this slice lands. The full vision is `docs/DESIGN.md` (§4.4–§4.7, §10). Tracking lives here — no separate issues — so read this to know what is done and what to pick up next.*

### 13.1 Subset, not a fork

Every contract here is the DESIGN.md contract, minimally populated (`Proposal` = §4.4 new-doc; `docs_read`/`docs_injected` = §4.2; `synthesizer` config = §6). Each deferred item **extends a named slot**.

### 13.2 Delivered by this slice (DONE)

- `synthesize` — prose-gated (cause ∈ {doc, config-doc} **and** confidence ≥ floor), **new-doc only**, fact-checked, top-N throttled, multi-harness (claude/qwen/gigacode) via per-harness unwrap + shared validator; `structure_only` heads-only; `dedupe:'none'`.
- `review` — accept / reject; surfaces cause + confidence + `evidence_refs` + verification; accept → authoritative `Proposal.path`.
- `explain <area>` — pointer (pure fn) + doc body + `docs_read` consultation count.
- `docs_read {path,t}` + `docs_injected {path,t,trigger}` on `StruggleRecord`, always-on.
- `Proposal` (new-doc, with `cited_symbols`/`referenced_paths`), `synthesizer` config + `confidence_floor_for_prose`, per-harness backend map + unwrap adapters, `collectEnvelopes` shared helper.
- Tests: corpus extended; `Proposal`/fact-check/unwrap units; e2e synthesize→review; egress test extended to scope `child_process`; record-field tests updated.

### 13.3 Deferred — what "full" adds, the dependency, and where to extend

**Suggested next slice: the live Router hook** — it is what makes accepted docs and the collected `docs_read` actually *reduce* struggle (closes the loop's feedback edge). Depends on `review`-accepted docs existing in-repo + the pointer pure-fn.

| Component | This slice (MVP-lite) | Full version (next) | depends_on | How to extend (the seam) |
|---|---|---|---|---|
| Router | `explain` pointer (manual, pure fn) | live hook: Claude `PreToolUse` + Qwen/GigaCode equivalent (`init` wires per harness); pointer default, full-injection opt-in | accepted docs in repo; pointer fn | hook owns its **own** area-resolution (`(cwd,tool_input)→area`) + cache + JSON-payload format; it **calls** `pointer.ts` for the text — do **not** wrap `explain`'s CLI surface |
| Measurement | `docs_read`/`docs_injected` collected (timing-bearing) | read-vs-not-read `stats` delta + confidence band; team `.harnessgap/team/struggle.jsonl` | `docs_read` populated + docs consulted | `stats` consumes `docs_read` (the `t` enables before/after); team file aggregates already-scrubbed records |
| Synthesizer | `dedupe:'none'`; heads-only; new-doc only | embeddings dedupe; AST `structure_only`; `edit-proposal` (range-apply on accept + second fact-check path) | — | swap dedupe impl behind the stable `dedupe` field; AST replaces heads under the same flag; `edit-proposal` extends `Proposal` |
| Curator | accept-to-disk via `review` | `harnessgap pr` (gh); CLAUDE.md/AGENTS.md fallback index | — | new `pr` command; index block between markers `<!-- harnessgap:index:start -->` / `:end -->` (parent §4.5) |
| Calibration | #34 Phase 0 eyeball + corpus | #34 Phase 1 + Phase 3 | — | see §11 — recall-substitute (fixtures + read-the-transcript labeling) |

### 13.4 Forward-compat invariants (preserve these)

- `docs_read`/`docs_injected` are **timing-bearing** (`{path,t}` / `{path,t,trigger}`) — do not collapse to `string[]`; Measurement needs the `t`.
- Backend = **per-harness unwrap adapter + shared Proposal validator** — a new harness adds both a config row and an `extractProposal` case, not just a config entry.
- Fact-check = the **`factCheck(proposal, repoHead) → {failures[]}` contract** — extraction (from `cited_symbols`/`referenced_paths`) **and** resolution are both part of it; an AST upgrade replaces both, with `verification` as the stable boolean projection.
- `dedupe` field schema is stable; `Proposal.path` is authoritative for review accept.
- Pointer rendering is a **pure function** (`src/router/pointer.ts`) shared by `explain` and the future hook.

### 13.5 Doc / identity updates required before the slice is "done"

After merge these no longer match reality and must be updated (the `docs-watcher` session-end subagent handles drift, but make them exit-criteria):

- **Privacy (README / `docs/CONSUMER_GUIDE.md` / `docs/ARCHITECTURE.md`):** derived evidence + repo file-heads now leave the machine via the agent CLI subprocess (parent §8). Update every "no writes / no network / transcripts never leave the machine" claim to scope it to the **default path**.
- **Scope/identity (`CLAUDE.md`, `package.json`, README, CONSUMER_GUIDE, ARCHITECTURE):** "detection-only" → the loop now writes + shells out; "synthesis/routing/measurement deferred to later slices" → synthesis ships; "`synthesizer` key rejected / five top-level keys" → accepted / six; ARCHITECTURE module map + §3 pipeline gain `synthesize`/`review`/`explain`/`Proposal`/`synthesizer` config; "byte-identical when off" → "human table byte-identical; `--json` gains `docs_read`/`docs_injected`".
- **Egress:** extend `test/egress.test.ts` to scope `child_process` to `src/synthesizer/*`; update `src/egress.ts` + test docstrings to state the gate guards the **default path only** (§4).
