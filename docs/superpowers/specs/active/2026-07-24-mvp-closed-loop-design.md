# harnessgap — Closed-Loop MVP (Phase 2 lite: Synthesizer + Review + Routing-lite + Measurement-lite)

**Status:** approved design → implementation planning
**Date:** 2026-07-24
**Parent design:** `docs/DESIGN.md` (v0.2) — §4.4 Synthesizer, §4.5 Curator, §4.6 Router, §4.7 Measurement, §5 Trigger modes, §8 Privacy.
**Builds on:** Slices 1–4 (Detector, ambient `repo` unit, session-end Reflect, Diagnoser) + the multi-harness adapters (Claude Code / Qwen Code / GigaCode) — all merged.

## 1. Purpose

Slices 1–4 proved **detection + diagnosis**. This slice makes the downstream half of the closed loop real — but **minimal per stage** — so the loop runs end-to-end on one example for the MVP demo:

> detect → diagnose → **synthesize** → **review** → (route via `explain`) → (measure doc-read consumption)

Each new stage is the thinnest version that is genuinely real (not a mockup), with the heavy machinery (live Router hook, read-vs-not-read delta, embeddings dedupe, team recurrence) explicitly deferred (§2, §11). Calibration / validation of detection precision (issue #34, Phases 1 & 3) is **deferred as an accepted risk** (§11).

### Posture: favor recall, gate false-positives on correctness

Detector sensitivity is favored — lowering `detector.flag_pct` is a config knob, no code. False positives are tolerated because every artifact is human-reviewed. **But** this is only safe because two gates make a false positive *correct-but-unnecessary* rather than *embarrassing*:

1. **Diagnoser prose-gate (parent §4.3):** only `cause ∈ {doc, config-doc}` ever produces prose downstream; `refactor-flag` / `test-gap` / `inherent-complexity` / `unclassified` become short rationale hand-offs.
2. **Synthesizer pre-review fact-check (parent §4.4):** cited symbols resolve, referenced paths resolve, `source_files@commit` SHAs are valid — checked against HEAD *before* a proposal is written.

Without those, over-proposing rationalizes good code (the failure mode parent §4.3 warns about).

### Success criterion (MVP demo)

On a real repo with Claude Code history, the closed loop runs end-to-end and produces **≥1 fact-checked, reviewable doc proposal** (`cause = doc` or `config-doc`) from a flagged area, reviewable via `harnessgap review`, with `docs_read` consumption recorded on the session record. The quantitative ≥25% read-vs-not-read struggle-delta target (parent §11) remains out of scope.

## 2. Scope

**In scope**

- `harnessgap synthesize` — opt-in command; composes detect → diagnose → synthesize; writes schema-checked proposals to `docs/_proposals/`.
- `harnessgap review` — lists `docs/_proposals/`; accept / edit / reject; surfaces diagnosed cause + confidence + fact-check status.
- `harnessgap explain <area>` — routing lite; prints diagnosed cause + a one-line pointer + the relevant doc body (or a proposal suggestion).
- `docs_read: string[]` on `StruggleRecord` — always-on doc-read consumption signal (Measurement lite), collected in the detector.
- `Proposal` contract (types) + `synthesizer` config block + per-harness backend defaults.
- Multi-harness synthesis backends: `claude -p` / `qwen -p` / `gigacode -p`, each requesting JSON output.
- Tests: extend the labeled fixture corpus; `Proposal` schema + fact-check unit tests; an e2e `synthesize → review` path on a fixture; updated snapshots for the new `docs_read` key.

**Out of scope (deferred — see §11)**

- Live `PreToolUse` Router hook (active injection). `explain` covers the routing concept for the demo.
- Read-vs-not-read `stats` delta + confidence band (the heavy Measurement).
- Embeddings-based dedupe. MVP provides the docs inventory to the backend and asks new/append/supersede; a TF-IDF similarity is computed for the `dedupe` field (or `dedupe: 'none'`).
- Team `.harnessgap/team/struggle.jsonl` + cross-teammate recurrence.
- `harnessgap pr` via `gh`. Accept-to-disk is the MVP bar.
- The CLAUDE.md / AGENTS.md static fallback-index update (parent §4.5) — stretch; accept-to-disk is the bar.
- Issue #34 Phase 1 (blind precision/recall) and Phase 3 (cause-vs-memory) validation.

## 3. Architecture & data flow

The existing scan pipeline (walk → stream → resolve → relativize → detect → aggregate → [diagnose] → output) is reused verbatim as the front of `synthesize`. The new stages attach after `diagnose`:

```
harnessgap synthesize --repo <path> [--unit <area>] [--harness <id>]
   │
   ▼  (reuse runScan internals: detect + diagnose)
StruggleRecord[]  +  Diagnosis[]   (existing contracts, unchanged)
   │
   ▼  pick unit (area); prose gate (cause ∈ {doc, config-doc}?)
   │      no  → write short rationale card to docs/_proposals/  (no backend call)
   │      yes ▼
Assemble evidence bundle  (Diagnosis + unit StruggleRecord signals
   │   + docs inventory [paths + bodies under docs_dirs]
   │   + repo file-heads under the area prefix, size-capped, scrubbed)
   ▼
Backend subprocess  (claude -p / qwen -p / gigacode -p,  --output-format/-o json)
   │   prompt on stdin → JSON Proposal on stdout   (fail-open on missing/non-zero/unparseable)
   ▼
Parse + schema-validate Proposal
   ▼
Fact-check gate  (deterministic, against HEAD)
   │   cited_symbols_resolved · paths_resolved · shas_valid
   │      fail  → write "needs human" note (NO doc written)
   │      pass  ▼
Write proposal  →  docs/_proposals/<area>-<cause>-<short>.md   (frontmatter: derived_from session ids, unit, struggle_score, cause, source_files@sha, created, verification)

harnessgap review        →  docs/_proposals/  →  accept → docs/<category>/
harnessgap explain <area> →  reads records + on-disk docs  (pointer + body)
docs_read                 ←  collected in the detector (read events under docs_dirs)
```

## 4. The scope-boundary invariant (egress)

The repo's identity is *"default path: stateless, no-network, no-writes"* (CLAUDE.md, `package.json`, `src/cli.ts`, `src/pipeline.ts`). It is **enforced by `src/egress.ts` + `test/egress.test.ts`**, which audit every file in `src/` for network-module imports and global `fetch(` calls and assert zero offenders.

- **Default `scan` / `reflect`: unchanged** — still stateless, no-network, no-writes. `egress.test.ts` continues to pass.
- **`synthesize` / `review`: opt-in commands that cross the write + subprocess boundaries.** Network is **delegated to the trusted agent CLI subprocess** (`child_process`), which is neither a network-module import nor a `fetch` call — so harnessgap itself imports no network module and the egress invariant holds. This is exactly parent §8's privacy argument ("same agent CLI and account the code already flows through — no new vendor").
- **The "byte-identical to Slice 3" transitional invariant is dropped as a governing constraint.** The tool is greenfield with no active users; backwards-compat / output-stability is an imagined constraint, not a real one. New fields land clean and snapshots are updated. Opt-in flags remain **only where there is a real cost or semantic reason** — e.g. `--diagnose` stays opt-in because running the classifier + reading `docs/` is genuine work, not to preserve byte-identity. (`docs_read`, by contrast, is nearly free, so it is always-on.)

## 5. Synthesizer

### 5.1 Command surface

`harnessgap synthesize --repo <path> [--unit <area>] [--harness <id>] [--structure-only] [--dry-run] [--config <path>]`

- Composes detect → diagnose → synthesize in one invocation. No state, no cache (detection is local and cheap; re-running preserves the stateless identity).
- `--unit <area>` targets one area; without it, the top flagged area whose cause ∈ `{doc, config-doc}` is chosen.
- `--dry-run` runs the pipeline and prints the Proposal without writing to disk.
- Output (non-dry-run): the written proposal path(s) on stdout; a `--json` envelope for scripting/tests.

### 5.2 Pipeline (per selected unit)

1. Reuse the scan pipeline to obtain `StruggleRecord[]` + `Diagnosis[]` for the repo (diagnosis on internally).
2. **Prose gate:** only `cause ∈ {doc, config-doc}` proceeds to a backend call. Any other cause → a short rationale card written to `docs/_proposals/`, **no backend call**.
3. **Assemble the evidence bundle** (all derived-only / scrubbed — no transcript prose, no raw file bodies beyond capped heads):
   - the `Diagnosis` (cause, confidence, rationale, `evidence_refs`);
   - the unit's `StruggleRecord` signals + area key;
   - docs inventory — file list **and bodies** under `docs_dirs` (for real dedupe context);
   - repo file-heads under the area prefix (size-capped, scrubbed via the existing `src/adapter/scrub.ts`).
4. **Backend subprocess (egress-safe):** shell out to the per-harness print-mode CLI, prompt on stdin, capture stdout (see §9–§10). **Fail-open:** missing binary / non-zero exit / unparseable output → degrade to a rationale card + a clean stderr message, never crash.
5. **Parse → schema-validate `Proposal`** (§5.3).
6. **Fact-check gate (deterministic, BEFORE write):** `cited_symbols_resolved`, `paths_resolved`, `shas_valid` checked against HEAD. **Fail → do not write the doc**; write a "needs human" note listing the failed assertions.

### 5.3 Proposal contract (parent §4.4)

The schema the backend must return and the Synthesizer validates:

```jsonc
{
  "kind": "new-doc" | "edit-proposal",
  // new-doc:
  "path": "docs/architecture/<area>.md",
  "frontmatter": {
    "derived_from": ["<session-id>", "..."],
    "unit": { "kind": "area", "key": "src/billing" },
    "struggle_score": 93,
    "cause": "doc",
    "source_files": ["src/billing/charge.ts@<sha>"],
    "created": "2026-07-24"
  },
  "body": "...",
  // edit-proposal instead carries:
  "target_doc": "docs/architecture/billing.md",
  "decision": "append" | "split" | "supersede",
  "ranges":  [ /* old/new string spans */ ],
  "rationale": "...",
  // always:
  "dedupe": {
    "nearest_existing": "docs/architecture/payments.md",
    "similarity": 0.41,
    "decision_rationale": "different module; new doc"
  },
  "verification": {
    "cited_symbols_resolved": true,
    "paths_resolved": true,
    "shas_valid": true
  }
}
```

`frontmatter` embeds session IDs only — never transcript text (parent §4.4).

### 5.4 Fact-check gate

Deterministic checks against the repo at HEAD, run after parsing and before any write:

- **`cited_symbols_resolved`** — every code symbol the proposal asserts exists (e.g. "the `charge()` function") resolves in the cited `source_files`.
- **`paths_resolved`** — every referenced path exists (or is the new-doc path being created).
- **`shas_valid`** — every `source_files@<sha>` pins a real commit.

Any failure → the proposal is **not** written as a doc; a "needs human" note records which assertions failed. This is the guard that makes a sensitive detector's false flag produce only a *correct* proposal, never an embarrassing one.

### 5.5 Privacy

`structure_only` governs the **repo source-file content** sent to the backend: heads-only for MVP (a full AST/path skeleton is v2). The docs inventory used for dedupe is always size-capped regardless. `source_files@commit` SHAs are recorded in frontmatter so the later staleness check (parent §4.5) works.

## 6. Review (Curator lite) — parent §4.5

`harnessgap review [--repo <path>] [--json] [--yes]`

- Lists proposals in `docs/_proposals/` and offers **accept / edit / reject**.
- **Surfaces the diagnosed `cause` + `confidence` + the fact-check `verification` status** from each proposal's frontmatter, so a reviewer does not rubber-stamp a `refactor-flag` rationale card like a `doc`.
- **accept** → moves the artifact to `docs/<category>/<name>.md` (category from the proposal target / `docs_dirs`).
- **reject** → deletes the proposal (or `--keep` archives it under `docs/_proposals/.rejected/`).
- **edit** → opens `$EDITOR` on the proposal, then **re-runs the fact-check** on the edited text before accept (a human edit citing a non-existent symbol is still caught).
- `--json` lists pending proposals for scripting/tests without a TTY; `--yes` accepts non-interactively (for demos/CI).
- The CLAUDE.md/AGENTS.md fallback-index update (parent §4.5) is a **stretch** here; accept-to-disk is the MVP bar.

## 7. Doc-read consumption (Measurement lite) — parent §4.7

- Add `docs_read: string[]` to `StruggleRecord` (present in the parent §4.2 sketch, absent from the implemented type).
- Populated **always** (nearly free): the distinct `docs/**` paths a session read, collected in the detector from the same read-event stream it already walks, gated by `docs_dirs`.
- Surfaced in `--json` output and the `--calibrate` view, so Measurement has data from day one. The heavy read-vs-not-read `stats` delta + confidence band is deferred.
- Privacy: doc **paths** only, no bodies — consistent with the existing derived-only posture.
- Snapshots are **updated**, not worked around (§4).

## 8. `explain` (Routing lite) — parent §4.6

`harnessgap explain <area> [--repo <path>] [--harness <id>]`

- Prints the diagnosed **cause** for the area + a one-line **pointer** (*"Before editing `src/billing/`, read `docs/architecture/billing.md`."*) + the relevant **doc body** if one exists for the unit.
- If no doc exists yet → points to any proposal in `docs/_proposals/`, or suggests `synthesize --unit <area>`.
- This is the pointer-mode Router (parent §4.6 default) as a manual command, standing in for the live `PreToolUse` hook in the demo.
- Stateless and local: composes detect + diagnose for the repo on the fly (no writes, no subprocess, no cache), then reads on-disk docs. Harness-agnostic.

## 9. Config additions — parent §6

New `synthesizer` block in `Config` (`src/config.ts`: add to `Config`, `DEFAULT_CONFIG`, `KNOWN_TOP_KEYS`, `validateConfig`):

```yaml
synthesizer:
  backend: null          # optional override; null → use the per-harness default (§10)
  model: null            # optional model override passed through to the backend
  structure_only: false  # strip file bodies for privacy-sensitive users
  max_file_head_bytes: 4096
  dedupe: tfidf          # tfidf | none
```

The closed set of top-level keys grows by one (`synthesizer`); unknown keys are still rejected (enumeration, not wildcard — matches existing `config.ts` discipline).

## 10. Multi-harness backend resolution

Synthesis backend is resolved per harness (detection is already harness-pluggable via `HarnessSpec`; the loop inherits most of this for free because `synthesize`/`review`/`explain`/consumption operate on normalized `Diagnosis` / `StruggleRecord` / on-disk proposals — not raw transcripts):

| Harness | Default backend | JSON output flag |
|---|---|---|
| `claude-code` | `claude -p` | `--output-format json` |
| `qwen-code` | `qwen -p` | `-o json` |
| `gigacode` | `gigacode -p` | `-o json` (full Qwen fork; same CLI shape) |

- Resolution: explicit `synthesizer.backend` override wins; else the harness→default map.
- The prompt itself is harness-agnostic (it is about the repo + the diagnosis); only the invocation differs.
- `qwen -p … -o json` and `claude -p --output-format json` confirmed present locally. `gigacode` is not installed on the dev machine; it is config-driven and activates when installed — no code change required.
- Requesting JSON output lets the Synthesizer validate the `Proposal` schema directly rather than parse prose.

## 11. Accepted risk: deferred calibration (issue #34)

Per the repo's own rule (*"not a single follow-up should just be mentioned mid-conversation and then die in it"*), the deferred validation becomes a real plan, not a silent skip.

**In the MVP's tests (not deferred):**

- Extend the labeled fixture corpus (`test/fixtures/corpus/labels.json` + `test/corpus.test.ts`) with known-struggle / known-clean synthetic sessions the detector must get right. This is **correctness**, and it doubles as issue #34's recall-*substitute* later.
- Eyeball one real `scan` (issue #34 Phase 0 — agent-runnable, no human recall needed).

**Deferred (recorded, not skipped):** issue #34 Phase 1 (blind precision/recall) + Phase 3 (cause-vs-memory), postponed until post-MVP. Recorded in two places:

1. **`docs/CALIBRATION.md`** — risk accepted (precision unvalidated → possible noise/misses); mitigations in place (percentile auto-calibration + prose-gate + fact-check ⇒ false positives are cheap-and-correct, not embarrassing); and the **recall-substitute** that closes it later (labeled fixtures + read-the-transcript labeling — since blind from-memory recall does not fit a history of many noisy parallel sessions).
2. **A comment on issue #34** (or a linked issue) — deferred-with-reason + what is done instead + the recall-substitute plan — turning #34 from "skipped" into "deferred-with-decision," satisfying its own *"Done means."*

## 12. Open questions

1. **Backend I/O contract per harness** — exact stdin/stdout shape for `claude -p --output-format json` vs `qwen -p -o json` vs `gigacode -p` (confirm at implementation; `-o json` / `--output-format json` presence confirmed for claude + qwen).
2. **`structure_only` MVP granularity** — heads-only vs a path/AST skeleton (heads-only shipped first).
3. **Proposal path / category derivation** — how `docs/<category>/` is chosen when the proposal does not specify (default by `docs_dirs` category; confirm mapping).
4. **Dedupe-lite approach** — TF-IDF similarity for the `dedupe` field vs backend-decided new/append/supersede with similarity left unset (`dedupe: 'none'`).
5. **`gigacode` verification** — confirm `-p` + `-o json` parity once a build is installed.
