# harnessgap — Diagnoser (Slice 4: grounded cause attribution for flagged areas)

**Status:** approved design (brainstormed) → spec
**Date:** 2026-07-18
**Parent design:** `docs/DESIGN.md` (v0.2) — implements the **Diagnoser** (§4.3), rule-based first pass.
**Prior slices:** Slice 1 detection (v0.1.1, shipped); Slice 2 ambient (`specs/archive/2026-07-14-…`); Slice 3 session-end reflect (`specs/archive/2026-07-15-…`). All archived.
**Runtime:** Node + TypeScript, `npx harnessgap`; the detection path stays stateless and offline.

## 1. Purpose

Slices 1–3 detect *that* an area struggles; they do not say *why*. The leaderboard and the
reflect recommendation both surface friction signals without classifying the cause, so a human
still guesses whether to write a doc, refactor code, fix a test, or fix config. This slice adds
the **Diagnoser** — the next component in DESIGN.md's closed loop — which turns each flagged area
into a **typed cause** with confidence and grounded rationale.

It **does not** author docs, persist anything, call an LLM, or touch the network. Cause
classification is **pure-rule**, grounded by the unit's signal profile plus a lightweight
**doc-existence** check (the only new repo context). It is **opt-in** (`scan --diagnose`); default
output is unchanged.

### Success criterion (manual dogfood, à la Slice 1)

On a real repo with ≥5 areas the user recalls as struggle (some doc-shaped, some code-shaped):

1. For a doc-shaped struggle (heavy exploration, no existing doc), the Diagnoser returns
   `cause: doc` with a rationale that names the exploration signals and the doc absence.
2. For a code-shaped struggle (oscillation + corrections, where a doc *already exists*), it returns
   `cause: refactor-flag`, not `doc` — i.e. it does **not** recommend a doc for a code problem.
3. For an expensive-but-unspecific session, it returns `inherent-complexity`.
4. The default `scan` leaderboard and `--json` are **byte-identical** to Slice 3 (the opt-in adds
   fields only under `--diagnose`).
5. No new network surface, no `git` invocation, no raw prose in any diagnosis field.

## 2. Scope

**In scope**

- A `scan --diagnose` flag that classifies each flagged area into one of five causes
  (`doc | config-doc | test-gap | refactor-flag | inherent-complexity`) or `unclassified`.
- A new **opt-in per-session `evidence` projection** (failed-exec cmd-class buckets + edited-file
  type buckets), computed in the detector, populated **only under `--diagnose`**.
- A **doc-existence** repo-context read (local `docs/` only, path-confined) — the grounding that
  distinguishes `doc` (no doc) from `refactor-flag` (doc exists).
- Two small **pure classifiers**: cmd-class (`config | test | build | other`) and file-class
  (`test | code | other`) over fixed catalogs.
- New `Diagnosis` + `SessionEvidence` contracts; new `docs_dirs` + `diagnose` config keys.
- A `cause` column in the human table and a `diagnoses` field in `--json` (both `--diagnose`-only).

**Out of scope (deferred — see §11 / open issues)**

- **LLM refinement** of the cause — belongs with the Synthesizer, which gets network via `claude -p`.
- **git churn / blame** for code-stability grounding — re-opens the `git`-invocation surface Slice 1
  deliberately removed. `refactor-flag` leans on corrections + code-file-share + doc-existence instead.
- **Per-area evidence precision** — v1 attributes session-level evidence to each area the session
  touches; true file→area attribution is a follow-up.
- **`reflect` integration** — v1 diagnoses `scan` (batch) areas only; surfacing a cause in the
  session-end recommendation is a follow-up.
- **Configurable classifier catalogs** — fixed patterns in v1.
- **`docs_dirs` map-with-purpose form** — arrives with the Synthesizer.
- **Structural-absence `repo` unit** — the canonical-docs checklist (DESIGN.md §4.2); current ambient
  detection stays behavioral.
- **Synthesis / routing / measurement / team recurrence** — unchanged from Slice 1–3 deferrals.

## 3. Principle — grounded cause attribution, pure-rule, opt-in projection

1. **Cause before artifact.** A recurring struggle has one of several causes; only some are fixed by
   a doc. The Diagnoser's job is to stop the tool from manufacturing docs for code/test/env
   problems. The unit of work it produces is a **diagnosed gap**, not a doc.
2. **Grounding is what makes it diagnosis, not guessing.** Signal counts alone say *how much*
   struggle, not *what kind*. The single most valuable new fact is **doc-existence**: it is what
   separates `doc` (write one) from `refactor-flag` (a doc already exists → the code is the problem).
   The `evidence` projection adds the failure-cmd and edit-file-type mix that grounds
   `config-doc` / `test-gap` / `refactor-flag`.
3. **Pure-rule, mode-independent.** No LLM, no network. A signal is *elevated* for a unit when its
   median across the unit's flagged sessions meets `cfg.detector.bootstrap_thresholds` — a
   conservative absolute prior used as the yardstick in **both** scoring modes, so diagnosis is
   stable whether the scan ran percentile or bootstrap.
4. **Opt-in, byte-identical default.** The `evidence` projection and the `diagnoses` output exist
   only under `--diagnose`. `StruggleRecord`, the scorer, the aggregator, and default output are
   untouched — the Slice 1/2/3 invariant holds.
5. **Observe, don't verdict.** A diagnosis is advisory evidence with a confidence; low confidence
   degrades to `unclassified` rather than a confident wrong cause. No prose is synthesized.

## 4. The diagnose flow

`scan --diagnose` runs the existing `runScan` stages unchanged, then adds two steps after
`runDetector` produces records and before output:

> **profile** — group flagged records by area key; for each unit, take each signal's **median**
> across its flagged sessions and the summed `evidence` buckets. → **repo-context** — for each
> flagged unit, read doc-existence under `docs_dirs` (local fs, path-confined, fail-open). →
> **classify** — pure rule engine over `(profile, repoContext, cfg)` → one `Diagnosis` per unit.

Only **flagged** areas are diagnosed (an unflagged area has no struggle to explain). A scan with
no flagged areas emits `diagnoses: []`.

## 5. Contracts

### 5.1 `SessionEvidence` (new optional field on `StruggleRecord`)

Computed in the detector alongside the signals; populated **only under `--diagnose`**:

```jsonc
{ "evidence": {
    "failures":   { "config": 3, "test": 5, "build": 1, "other": 0 }, // failed-exec counts by cmd-class
    "edit_kinds": { "test": 2, "code": 9, "other": 0 }                // edited-file counts by file-class
  } }
```

`StruggleRecord.evidence?: SessionEvidence`. When `--diagnose` is absent the field is unset and the
JSON builder omits it — default `--json` is byte-identical. Counts are integers; scrubbing and size
caps are reused (cmds/files are already scrubbed/capped in the adapter).

### 5.2 `Diagnosis` (new; one per flagged area)

```jsonc
{ "unit": { "kind": "area", "key": "src/billing" },
  "cause": "doc",                 // doc | config-doc | test-gap | refactor-flag | inherent-complexity | unclassified
  "confidence": 0.78,             // 0..1
  "rationale": "explore_ratio(11.2) + reread(6); no doc under docs/ for this unit",
  "evidence_refs": [              // pointers only — signal values, shares, doc paths; never prose
    { "kind": "signal", "name": "explore_ratio", "value": 11.2 },
    { "kind": "doc_absent", "checked": ["docs/architecture", "docs/gotchas"] } ] }
```

`evidence_refs` is a closed union:

```jsonc
type EvidenceRef =
  | { kind: "signal",        name: SignalName, value: number | boolean }
  | { kind: "doc_absent",    checked: string[] }            // docs_dirs searched, no match
  | { kind: "doc_present",   path: string }                  // matched doc path
  | { kind: "failure_profile", config: number, test: number, build: number, other: number }
  | { kind: "edit_profile",    test: number, code: number, other: number };
```

`rationale` and every `evidence_refs` leaf are **derived-only** (signal values, integer counts,
ratios, doc paths). No transcript prose, no file bodies, no commands.

### 5.3 `JsonOutput` addition

```jsonc
{ /* …existing fields… */ "diagnoses": Diagnosis[] }   // present only under --diagnose
```

Absent otherwise → default `--json` byte-identical.

### 5.4 Config additions (`docs_dirs` + `diagnose`)

Both are currently **rejected** by `loadConfig`; this slice **accepts** them. Deep-merged over
defaults like the rest of the config.

```yaml
docs_dirs: [docs]                 # dirs searched for doc-existence grounding (paths, repo-relative)
diagnose:
  confidence_floor: 0.50          # a specific cause below this → inherent-complexity / unclassified
  config_share_floor: 0.50        # config-failures / total-failures  for config-doc
  test_share_floor: 0.50          # test-file-edits / total-edits      for test-gap
  code_share_floor: 0.50          # code-file-edits / total-edits      for refactor-flag
  score_floor: 70                 # mean_score floor for inherent-complexity
```

The `docs_dirs` map-with-purpose form (DESIGN.md §6) is deferred; v1 takes a list of paths.

## 6. Cause taxonomy & rules

The classifier is a **pure function** `(profile, repoContext, cfg) → Diagnosis`. *Elevated(X)* means
the unit's median for signal X meets `cfg.detector.bootstrap_thresholds.X`. Causes are scored; the
selection order is fixed and deterministic.

**Specific causes (scored first):**

| Cause | Predicate | Grounding |
|---|---|---|
| `doc` | Elevated(explore_ratio) ∧ Elevated(reread) ∧ **¬docExists(unit)** | doc absence |
| `config-doc` | Elevated(failure_streak) ∧ **config-failures / total-failures ≥ config_share_floor** | failure cmd-class profile |
| `test-gap` | Elevated(oscillation) ∧ Elevated(failure_streak) ∧ **test-file-edits / total-edits ≥ test_share_floor** ∧ ¬Elevated(corrections) | edit file-type mix + low corrections |
| `refactor-flag` | Elevated(oscillation) ∧ Elevated(corrections) ∧ **code-file-edits / total-edits ≥ code_share_floor** | high corrections + code-heavy edits; **docExists(unit) boosts confidence** |

**Selection / residual:**

1. Compute the four specific-cause scores (each a function of how many signature signals are
   elevated and the grounding fact).
2. If the max specific score ≥ `confidence_floor` → that cause.
3. Else if Elevated(wall_clock_per_line) ∧ mean_score ≥ `score_floor` → `inherent-complexity`
   (expensive but no specific signature fit — the "capable model, high cost, quiet signals" case).
4. Else → `unclassified`.

`confidence` reflects signature strength + grounding (doc absence/presence is strong; file/cmd-share
is medium). The runner-up is named in `rationale` when within a small margin. `doc` and
`inherent-complexity` are the high-confidence causes; `config-doc` / `test-gap` / `refactor-flag`
are documented as medium-confidence (their file/cmd attribution is session-profile-mapped-to-area,
§11.3).

## 7. Module / data-flow placement

All additions are pure or thin-orchestration; the only new I/O is the doc-existence read under
`docs_dirs` (local fs, path-confined).

| Change | Location | Responsibility |
|---|---|---|
| `--diagnose` flag | `src/cli.ts` | commander wiring; threads a `diagnose: boolean` into `runScan`. |
| Diagnose step in `runScan` | `src/pipeline.ts` | after `runDetector`, when `diagnose`: build profiles → gather repo-context → classify → attach `diagnoses`. Off by default; `runScan` output unchanged otherwise. |
| `computeEvidence(events) → SessionEvidence` | **`src/detector/evidence.ts` (new)** | buckets failed execs by cmd-class and edited files by file-class while the detector walks events. Populated only when `--diagnose`. |
| `classifyCmd(cmd)`, `classifyFile(path)` | **`src/diagnoser/classify-util.ts` (new)** | pure classifiers over fixed catalogs; `classifyCmd` reuses `cfg.areas.test_cmd_patterns` for `test`. |
| `gatherRepoContext(unitKey, repoRoot, docsDirs)` | **`src/diagnoser/repo-context.ts` (new)** | the only new I/O: doc-existence under `docs_dirs`, path-confined to the repo root, fail-open. |
| `classify(profile, repoContext, cfg) → Diagnosis` | **`src/diagnoser/classify.ts` (new)** | the pure rule engine (§6). |
| `diagnoseUnits(records, cfg, repoRoot) → Diagnosis[]` | **`src/diagnoser/index.ts` (new)** | thin orchestration: profile → context → classify. |
| `cause` column | `src/output/human.ts` | flagged rows gain a `cause(confidence)` cell when `--diagnose`. |
| `diagnoses` field | `src/output/json.ts` | emits `diagnoses` only when `--diagnose`. |
| `Diagnosis`, `SessionEvidence`, `EvidenceRef`, `Cause` | `src/types.ts` | new types; **`StruggleRecord` gains only an optional `evidence?`** (unset by default). |
| `docs_dirs` + `diagnose` | `src/config.ts` | accept + validate + deep-merge; default `docs_dirs: ["docs"]`. |

Reused verbatim: `runDetector`, `scoreSessions`, `localizeAreas`, `aggregateAreas`,
`assembleStruggleRecord`, scrubbing, size caps, `resolveMainRepo`, `loadConfig`. **No new runtime
dependencies; no new network surface; no `git` invocation.**

## 8. Doc-existence & repo context

`gatherRepoContext` answers one question per unit: **does a doc for this unit already exist?**

- **Doc-matching rule (v1, fuzzy, documented):** a doc matches unit `src/billing` if any file under
  any `docs_dirs` dir has the unit's leaf segment (`billing`) as a filename stem or a path segment.
  Simple token match; may miss differently-named docs or over-match common tokens (§11.2).
- **Path confinement:** reads are confined to `<repoRoot>/<docs_dir>`; any resolved path escaping the
  repo root is rejected (mirrors `walk.ts`'s prefix-confinement check). Symlinks under `docs/` are
  not followed.
- **Fail-open:** a missing/unreadable `docs_dirs` entry or any read error → `docExists: false` for
  that unit, never thrown. A unit whose doc status is uncertain is not promoted to `doc` on absence
  alone beyond the normal rule.

## 9. Error handling — fail-open (all Slice 1–3 guarantees preserved)

- **Never aborts the scan.** A thrown classify step, a missing `docs_dirs`, or an unreadable doc
  path degrades that unit to `unclassified` (or omits its diagnosis); the scan still prints its
  leaderboard. `loadConfig`/arg errors still throw as today.
- **No network, no detection-path writes.** Still true; the Diagnoser only reads `docs/` and prints.
  The `evidence` projection reads no files — it buckets events already in memory.
- **No `git` invocation.** Doc-existence uses local fs reads only; code-stability is grounded by
  signals + doc-existence, not churn (deferred).
- **Privacy.** `Diagnosis.rationale`, `evidence_refs`, and the `--json` `diagnoses` carry only
  derived values/paths/integer counts/ratios. No transcript prose, no commands, no file bodies —
  scrubbing and size caps are reused upstream. No new egress channel or vendor.
- **Egress / packaging unchanged.** No new network imports (pure-rule, no LLM) and no new runtime
  deps → `test/egress.test.ts` and `test/packaging.test.ts` pass unmodified.

## 10. Testing

- **`classify` unit (pure):** each of the five causes fires on its signature and not on others; the
  selection order (specific → inherent-complexity → unclassified); the `confidence_floor` gate;
  tie-breaking and the runner-up-in-rationale rule; doc-exists boosting `refactor-flag`.
- **`profile` unit (pure):** grouping flagged records by area; per-signal median; the elevated
  yardstick matches `bootstrap_thresholds` in both scoring modes; evidence-bucket sums.
- **`classify-util` unit (pure):** `classifyCmd` / `classifyFile` over the fixed catalogs and edge
  cases (empty cmd, non-code/non-test paths).
- **`computeEvidence` unit (pure):** failed-exec and edited-file bucketing; populated only under the
  diagnose flag.
- **`repo-context` unit:** doc-match hit/miss; missing `docs_dirs` → fail-open (`docExists:false`);
  path-confinement rejection of escaping paths; no symlink following.
- **Integration (real fs fixtures):** a flagged area with a doc present → `refactor-flag`-eligible;
  same profile with the doc removed → `doc`. End-to-end through `runScan --diagnose`.
- **Privacy:** a prose marker seeded in a user-message/cmd/file field is absent from every
  `Diagnosis` leaf; every leaf is a primitive/enum/closed-union member.
- **Byte-identical default:** the existing leaderboard snapshot is **unchanged** without `--diagnose`;
  a second snapshot locks the `--diagnose` table + `diagnoses` shape.
- **Corpus:** the labeled fixtures get a light "causes are sensible" assertion (advisory, not a
  gate — cause is human-judged, à la Slice 1).
- **Config:** `docs_dirs` + `diagnose` accepted, deep-merged, and validated; unknown keys still
  rejected.

## 11. Open questions (slice-specific)

1. **Cause-rule calibration (top risk).** The floors (`confidence_floor`, the three share floors,
   `score_floor`) are v1 priors. They must be pinned via a dogfood pass (§1) before merge, à la the
   ambient/reflect calibration levers. If `doc` over-fires on code problems, raise the
   explore/reread bar or require doc-absence more strictly.
2. **Doc-matching fuzziness.** Token-match will miss docs named differently and over-match common
   tokens (`utils`, `common`). Acceptable for v1 (grounding is advisory); an index/embeddings match
   is a follow-up.
3. **Session-evidence → area attribution.** v1 maps a session's evidence buckets to every area the
   session touches. True per-area attribution (file→area via the area localization) is a follow-up
   and would sharpen `config-doc` / `test-gap` / `refactor-flag`.
4. **`test-gap` vs `refactor-flag` separation.** Both key on oscillation; `corrections` is the main
   differentiator (agent corrected → code/approach wrong; not corrected → tests/env). Without git
   churn the split is imperfect and stays medium-confidence.
5. **`reflect` integration.** v1 is `scan`-only. Surfacing a cause in the session-end reflect
   recommendation (and whether `reflect` should populate `evidence`) is a follow-up.
6. **Classifier configurability.** The cmd/file catalogs are fixed in v1; teams with unusual
   conventions will want them configurable.

## 12. Relation to parent design

Implements the **Diagnoser** (DESIGN.md §4.3) — the rule-based first pass. The spec's LLM
refinement ("one LLM call when confidence is low") is deferred to the Synthesizer (§4.4), which is
the first component permitted network (via `claude -p`); keeping the Diagnoser pure preserves the
no-network contract that is the project's defining property. This picks up exactly what Slice 3
(§2, out-of-scope) explicitly deferred: *"the Diagnoser — cause attribution is not attempted."*

Advances the loop one step — **detect → diagnose** — without touching the detection core:
`StruggleRecord`, `scoreSessions`, `localizeAreas`, `aggregateAreas`, and default output are
unchanged (Slice 1/2/3 byte-identical). Synthesis, routing, measurement, and team recurrence remain
deferred; detection stays behavioral.

## TL;DR

Slice 4 adds the **Diagnoser**: `scan --diagnose` classifies each flagged area into one of five
typed causes — `doc | config-doc | test-gap | refactor-flag | inherent-complexity` (or
`unclassified`) — with a confidence and a derived-only rationale. It is **pure-rule, mode-independent**
(a signal is *elevated* when its unit median meets `bootstrap_thresholds`), grounded by the unit's
signal profile plus a **doc-existence** check (the fact that separates `doc` from `refactor-flag`)
and a new **opt-in `evidence` projection** (failed-exec cmd-class + edited-file type buckets,
computed in the detector, populated only under `--diagnose`). Two pure classifiers (`classifyCmd`,
`classifyFile`) feed it. New `Diagnosis` / `SessionEvidence` contracts; new `docs_dirs` + `diagnose`
config keys; a `cause` column in the human table and `diagnoses` in `--json`, both `--diagnose`-only.
**Default output is byte-identical** (the projection and the diagnoses exist only opt-in); `StruggleRecord`,
scorer, aggregator, and `runScan` are untouched. No LLM, no network, no `git`, no raw prose, fail-open
throughout — every Slice 1–3 guarantee holds. Diagnosis/synthesis/routing/measurement stay deferred;
this is detect → diagnose, one step along the loop.
