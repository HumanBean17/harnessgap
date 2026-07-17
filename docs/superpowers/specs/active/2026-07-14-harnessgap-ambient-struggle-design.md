# harnessgap — Behavioral Baseline / Orientation Detection (Phase 1, Slice 2)

**Status:** approved design → implementation planning (rev 2: incorporates a 4-agent spec review + empirical grounding on a brownfield repo)
**Date:** 2026-07-14
**Parent design:** `docs/DESIGN.md` (v0.2)
**Prior slice:** `docs/superpowers/specs/archive/2026-07-12-harnessgap-detection-slice-design.md` (Slice 1, shipped v0.1.1)
**Runtime:** Node + TypeScript, `npx harnessgap`; still stateless and offline.

## 1. Purpose

Close the gap Slice 1's dogfood exposed, on **brownfield repos with many sessions** (the primary
target), not only greenfield/blank-paper ones. On such repos the seven per-session signals are
**structurally near-zero at the median** because they measure *acute* struggle events (failures,
corrections, oscillation, rereads) while real friction is **diffuse orientation overhead** — the
agent reads widely to reconstruct a map a harness would have provided — and that overhead is
**diluted by productive output** (the ratio signals divide by edited lines). Percentile scoring
then has nothing to rank, so the leaderboard flags near-arbitrarily and surfaces no ambient signal.

This slice adds a **behavioral baseline finding** that detects elevated orientation overhead
across a repo's sessions, **without prescribing files, without assuming struggle from absence,
and without corrupting Slice 1's validated per-session/per-area output.**

### Empirical grounding (brownfield reference: `java-enterprise-codebase-rag`)

613 tracked files (198 Java / 173 md / 167 py), **has `CLAUDE.md` + `README.md` + `docs/`**, 85
sessions resolved (percentile mode). `harnessgap scan --calibrate`:

| signal | P50 | P90 | bootstrap threshold |
|---|---|---|---|
| `explore_ratio` | **0.07** | 1.00 | 10 |
| `reread` | 0 | 1 | 5 |
| `failure_streak` | 0 | 1 | 3 |
| `corrections` | 0 | 1 | 2 |
| `oscillation` | 0 | 0 | 2 |
| `wall_clock_per_line` | 43087 ms | 189779 ms | 300000 ms |

Every acute signal medians zero; `explore_ratio` median is **~100× under** its absolute threshold.
The "absolute struggle rate" of rev-1 would be ≈0 → no finding. **36% of sessions (31/85) are
zero-edit Q&A/exploration-only.** This grounds every decision below.

### Success criterion

Validated by manual dogfood across **two repo classes** (no single-class pass is accepted):

1. **Unharnessed repo** (the user's "battle project," no harness) → the baseline finding **fires**,
   severity matching felt pain.
2. **Brownfield repo** (`java-enterprise-codebase-rag`, has a harness, many sessions) → the finding
   reflects the user's gut on where orientation is genuinely costly, and **does not false-fire
   merely because the codebase is large**.
3. **Held-out well-harnessed repo** → **no finding** (or low/unrated).

Plus an invariant: **zero-edit Q&A sessions never inflate the metric**, and a pure-Q&A repo
produces an honest "no actionable signal" message, not silence or a false finding.

## 2. Scope

**In scope**
- A behavioral **baseline finding** (`kind: "elevated-baseline"`) that fires on elevated
  *orientation overhead* across sessions — the signal the seven acute signals cannot see.
- A new **pre-edit orientation metric**: distinct directory breadth (primary, size-robust) +
  distinct file depth (corroborator) read before the first edit, computed per session.
- **Zero-edit session handling**: Q&A/exploration-only sessions are excluded from the orientation
  median and reported as a population fraction.
- A secondary **absolute-struggle-rate** trigger (reuses the existing bootstrap trip logic) for
  repos that *are* acutely struggling.
- New `RepoFinding` contract + `repo_findings` in `--json`; a baseline block in the human table and
  a verdict in `--calibrate`; new `detector.ambient` config.

**Out of scope (deferred)**
- **Structural-absence / canonical-file checks — rejected** (§3). The reference brownfield repo
  *has* `CLAUDE.md` + docs yet can still have area-level gaps; file presence would say "fine" and
  miss them.
- **The absolute-flag overlay — dropped** (rev-1 proposed it; the 4-agent review showed it corrupts
  Slice 1's validated `mean_score`/`top_signals`/sort by broadening `flagged`). Orientation is the
  non-corrupting cure, so the overlay is unnecessary. Dropping it leaves `StruggleRecord`,
  `flagged`, and the scorer **untouched**.
- A per-session scored 8th signal. The orientation metric is computed for the baseline finding
  only, not threaded through the per-session composite.
- Diagnoser (cause attribution), Synthesizer, Curator, Router, Measurement, persistence,
  multi-agent adapters — unchanged from Slice 1's deferrals.

## 3. Principle — behavioral detection, not prescription; observation, not verdict

Two rules, both reinforced by the review:

1. **Measure behavior; never prescribe files or infer struggle from absence.** A repo can have a
   `CLAUDE.md` and still leave the agent orienting slowly in specific areas. File-presence checks
   would declare it "fine." Detection must read *what the agent did*, not *what files exist*. This
   is a deliberate divergence from `docs/DESIGN.md` §4.2's structural-absence prong: the `repo`
   unit is detected **behaviorally** (elevated orientation across sessions), and self-suppression
   is behavioral (a fluent repo → low orientation → no finding), not a file checklist.

2. **Observe, don't verdict.** Elevated orientation is a *symptom* with several causes (missing
   harness, large codebase, inherent complexity, genuinely cross-cutting work). This slice reports
   the symptom and refuses to render a cause. Per `docs/DESIGN.md` §3 ("recurrence is a symptom,
   not a verdict"), cause attribution is the Diagnoser's job (later slice). The finding says
   "the typical session orients broadly here — worth investigating," **never** "write a doc."

## 4. The orientation metric

The one addition that can see diffuse orientation overhead where the seven acute signals cannot.
Computed from existing `NormalizedEvent` fields only (`kind`, `tool`, `input_digest.files`,
ordering); one pure pass per session.

### Definition (per session)

Let `firstEditIdx` = index of the first event with `kind === "tool_call" && tool === "edit"`, or
`events.length` if none. Let `readFilesBeforeEdit` = distinct file paths from events with
`tool === "read"` and index `< firstEditIdx`.

- **`pre_edit_dir_breadth`** (primary) = number of distinct **depth-2 directory prefixes** over
  `readFilesBeforeEdit` (e.g. `src/billing`, `tests/api`). A path with fewer than two segments
  contributes its existing prefix. **Size-robust**: a focused task on a large repo touches 1–2
  dirs even across many files; a lost agent scatters across many.
- **`pre_edit_file_depth`** (corroborator) = `|readFilesBeforeEdit|` (distinct files).

**Why not diluted by edits (the failure that killed `explore_ratio`):** both stop accruing at the
first edit. Everything after — the productive output that dragged `explore_ratio` to 0.07 — never
enters the computation.

**Zero-edit sessions:** the metric is **undefined** (no first edit). These sessions are excluded
from the repo-level median and counted separately (§5). This is mandatory: on the reference repo
36% of sessions are zero-edit; including them would count the entire session as "pre-edit" and
destroy the signal.

### Repo-level aggregation

Over the **with-edit** sessions only: `median_breadth`, `median_file_depth`. The zero-edit
fraction (`zero_edit_sessions / sessions_sampled`) is carried as population context. If there are
no with-edit sessions, the orientation metric is undefined (§9).

## 5. Detection mechanism — two-path trigger

The finding fires when `sessions_sampled ≥ ambient.min_sessions` AND **either** path holds:

1. **Orientation path (primary):** `median_breadth ≥ ambient.breadth_floor` **OR**
   `median_file_depth ≥ ambient.file_depth_floor`. Independent of the seven acute signals; fires
   on diffuse-orientation repos where acute signals are all ~0.
2. **Acute path (secondary):** `struggle_rate ≥ ambient.struggle_rate_threshold`, where
   `struggle_rate` = share of sessions meeting the existing bootstrap flag condition (composite ≥
   `bootstrap_flag_pct` OR ≥2 signals trip the absolute `bootstrap_thresholds`). Reuses Slice 1's
   trip logic, computed for all sessions regardless of scoring mode. Catches repos that *are*
   acutely struggling.

**Mode independence.** The orientation path is computed from events, not scoring mode, so it is
meaningful in both percentile and bootstrap mode. This resolves rev-1's tautology concern: the
finding's value comes from the orientation path, which is never a relabel of the flag rate.

**Severity.** Scaled by how far the firing metric exceeds its floor (and the struggle rate, on the
acute path). Bands `high` / `medium` / `low`. Severity is **suppressed (reported as `unrated`)** when
`sessions_sampled < ambient.severity_min_sessions` (a higher bar than `min_sessions`), because a
median over very few sessions is not statistically stable and rev-1's small-`n` severity wobble is
unacceptable.

**Self-suppression is behavioral, not guaranteed by mechanism.** A fluent repo produces low
orientation → no finding. This is a *calibration requirement* (asserted by the held-out gate, §10),
not a structural claim — it depends on the floors sitting above a fluent repo's orientation, which
is why the floors are pinned and gated, not left as "conservative priors."

## 6. Calibration

The floors and thresholds are **pinned in this spec as priors** (not "implementation output" — they
are part of the contract now, since the finding is wholly defined by them). They are validated by a
**two-repo-class gate** (§10):

| parameter | prior | meaning |
|---|---|---|
| `breadth_floor` | 4 | median with-edit session touches ≥4 distinct depth-2 dirs before first edit |
| `file_depth_floor` | 12 | median with-edit session reads ≥12 distinct files before first edit |
| `struggle_rate_threshold` | 0.30 | acute path: ≥30% of sessions meet the bootstrap flag condition |
| `min_sessions` | 10 | below this, no finding (a median over fewer is noise) |
| `severity_min_sessions` | 20 | below this, finding may fire but severity is `unrated` |

Priors are candidates grounded in the review's reasoning (harnessed ≈ 3–8 files / 1–2 dirs;
unharnessed ≈ 15–40 files / many dirs). Final values are fixed by the gate, and the spec is updated
to the fixed values before merge. Sensitivity is documented: moving any floor by ±20% must not flip
the dogfood repos across the fire/no-fire line.

## 7. Contracts (minimal, additive — `StruggleRecord`/`flagged`/scoring semantics untouched)

Dropping the overlay (§2) means **no change** to `StruggleRecord`, `flagged`, the area
aggregator, or Slice 1's scoring semantics (`mean_score` / `top_signals` / sort, and the four
existing `SessionScore` fields `score_pct` / `mode` / `flagged` / `composite`). Two additive,
behavior-preserving exceptions: `SessionScore` is **extended** with always-populated
`bootstrap_composite` / `bootstrap_flagged` (so the acute path has its input in percentile mode
too — §5), and the scorer now **always computes** the bootstrap trip via a shared helper; the
four old fields compute identically to before (locked by `test/scoring.test.ts`).

### 7.1 `RepoFinding` (new; 0 or 1 per scan)

```jsonc
{ "kind": "elevated-baseline",
  "severity": "high" | "medium" | "low" | "unrated",
  "paths": [ "orientation" ],                 // which trigger paths fired: subset of {"orientation","acute"}
  "sessions_sampled": 85,
  "scoring_mode": "percentile",               // the scan's actual mode, for context
  "orientation": {                            // present when ≥1 with-edit session
    "median_dir_breadth": 5,
    "median_file_depth": 18,
    "breadth_floor": 4,
    "file_depth_floor": 12,
    "with_edit_sessions": 54 },
  "zero_edit_fraction": 0.36,                 // Q&A/exploration-only share, population context
  "acute": {                                  // present always (secondary path context)
    "struggle_rate": 0.04,
    "struggle_rate_threshold": 0.30 } }
```

No raw prose: signal-derived numbers, ratios, a severity label, and a `paths` set only. The
interpretation is deliberately absent — cause is undiagnosed (§3).

Note: this `RepoFinding` (repo-level, in the scan `--json` envelope — this slice) is distinct from
Slice 3's `ReflectFinding` (session-end, the `/reflect` + Stop-hook path). Separate CLI surfaces and
separate types — they share no field and do not interact.

### 7.2 `JsonOutput`

Adds `repo_findings: RepoFinding[]` (`[]` when none). Additive; nothing else changes.

### 7.3 Config (`.harnessgap.yml`, one new nested block under existing `detector:`)

```yaml
detector:
  ambient:                          # NEW
    breadth_floor: 4                # orientation path: median depth-2 dirs read before first edit
    file_depth_floor: 12            # orientation path: median distinct files read before first edit
    struggle_rate_threshold: 0.30   # acute path: share of sessions meeting the bootstrap flag condition
    min_sessions: 10                # below this, no finding
    severity_min_sessions: 20       # below this, finding fires but severity is "unrated"
```

No new top-level key; `.harnessgap.yml` still accepts only `detector` and `areas`. `scan` runs with
no config using these defaults. New nested keys are range-validated
(`breadth_floor`/`file_depth_floor`/`min_sessions`/`severity_min_sessions` ≥ 1;
`struggle_rate_threshold` ∈ [0,1]; `severity_min_sessions ≥ min_sessions`). The `Config` type and
`DEFAULT_CONFIG` are extended (§8). Note: the current `validateConfig` is a hand-coded field
checker and silently accepts unknown *nested* keys; this slice adds explicit range checks for the
new keys (a nested-key whitelist is noted as future hardening, §13).

## 8. CLI & output

No new command or flag. The baseline finding surfaces through existing outputs:

- **Human table.** A one-line baseline summary is **always printed** (orientation medians,
  zero-edit fraction, struggle rate); it expands to a finding block when a path fires. Placed above
  the area leaderboard. Static-literal interpretation only (no session content). Example:
  ```
  BASELINE — elevated (orientation) · severity: high
    median pre-edit orientation: 5 dirs / 18 files (floors 4 / 12) · over 54 with-edit sessions
    zero-edit (Q&A) sessions: 36% · acute struggle rate: 4% (threshold 30%)
    the typical session orients broadly before acting — worth investigating (cause undiagnosed)
  ```
  When no path fires: `BASELINE — within norms · orientation 2 dirs / 6 files · zero-edit 36% · acute 4%`.
  When there are too few sessions: `BASELINE — too few sessions (N) to assess`.
- **`--json`.** Emits `repo_findings` per §7.2.
- **`--calibrate`.** Adds the baseline assessment (orientation medians, zero-edit fraction,
  struggle rate) and marks each against its floor. Aggregate statistics only.

## 9. Module / data-flow placement

All additions are pure functions; the new files are `src/detector/orientation.ts` and `src/detector/ambient.ts`. No new I/O, no new
dependencies. The orientation metric needs event-level data, so it is computed in the detector stage
and surfaced to the ambient assessor — **not** read from `StruggleRecord` alone (which carries only
`.signals`, not events). This corrects rev-1's inaccurate data-flow claim.

| Change | Location | Responsibility |
|---|---|---|
| `computePreEditOrientation(envelope) → {breadth, fileDepth} \| null` | `src/detector/signals.ts` (or a new `src/detector/orientation.ts`) | Pure, per-session, from events. `null` for zero-edit sessions. |
| Surface per-session orientation + the existing bootstrap trip/composite | `src/detector/scoring.ts` + `src/detector/index.ts` | The scorer computes the bootstrap trip for **all** sessions (cheap, pure) so the acute path has its inputs in percentile mode too; `runDetector` threads per-session orientation + bootstrap trip to the ambient assessor. |
| `assessAmbient(perSession, cfg) → RepoFinding \| null` | **`src/detector/ambient.ts` (new)** | Pure: medians, zero-edit fraction, struggle rate, path firing, severity (with `unrated` below `severity_min_sessions`); null below `min_sessions` or when orientation undefined and acute path cold. |
| Thread finding into output | `src/pipeline.ts` | Call `assessAmbient` after `runDetector`; pass to formatters. |
| `repo_findings` in envelope | `src/output/json.ts` | Additive. |
| Baseline block in table | `src/output/human.ts` | Always-printed summary; finding block when a path fires. Static literals only. |
| Baseline assessment + floors in calibrate | `src/output/calibrate.ts` | Additive. |
| Defaults + validation | `src/config.ts` | New `ambient` block; range checks; `Config`/`DEFAULT_CONFIG` extended. |
| Types | `src/types.ts` | `RepoFinding`, `BaselinePath`, `Severity`; extend `JsonOutput`, `Config`. **`StruggleRecord` unchanged.** |

The normalized-event schema (Slice 1 spec §4) is untouched.

## 10. Error handling — fail-open (all Slice 1 guarantees preserved)

- **No network, no disk writes.** Still true; orientation + ambient are pure computation over
  already-computed events/signals. A bug's worst case is a wrong finding, never a broken session.
- **Zero-edit sessions** excluded from the orientation median; counted in `zero_edit_fraction`.
- **All sessions zero-edit** (pure-Q&A repo) → orientation undefined; acute path evaluated alone;
  if acute is also cold → no finding + the always-printed summary states "all sessions are
  exploration-only; orientation metric undefined."
- **Too few sessions** (`< min_sessions`) → no finding; summary states "too few sessions to assess."
- **Severity at small n** → finding may fire at `min_sessions` but severity is `unrated` until
  `severity_min_sessions`.
- **Exit codes unchanged.** No new non-zero path; "no sessions" still exits 0.

## 11. Testing

- **Orientation unit (pure):** a session reads files across N dirs then edits → correct
  `breadth`/`fileDepth`; reads after first edit excluded; zero-edit session → `null`; files with
  fewer than two segments handled.
- **`assessAmbient` unit (pure):** orientation path fires above floor; acute path fires on a
  high-struggle synthetic set; two-path OR semantics; zero-edit sessions excluded from median but
  counted; all-zero-edit → orientation undefined; below `min_sessions` → null; severity `unrated`
  below `severity_min_sessions`; severity bands at boundaries.
- **Config unit:** new keys range-validated; defaults applied; out-of-range rejected;
  `severity_min_sessions < min_sessions` rejected.
- **Two-repo-class calibration gate (the success criterion, automated where possible):**
  - Unharnessed fixture set → finding fires (orientation path).
  - Well-harnessed held-out fixture set → no finding.
  - A brownfield-shaped fixture (large, has-docs, mixed edit/Q&A) → deterministic result; severity
    stable under ±20% floor perturbation.
- **Zero-edit robustness:** a fixture with 36% zero-edit sessions → median computed over with-edit
  only; `zero_edit_fraction` correct; result identical to the same set with zero-edit sessions
  removed (they don't move the median).
- **Privacy / egress / packaging (new surfaces explicitly covered):** a ≥`min_sessions` fixture
  seeded with prose markers in user messages/commands that triggers the finding → assert the
  populated `RepoFinding`, the human baseline block, and the `--calibrate` verdict contain no
  marker, and that every emitted value is a number or a closed-enum/literal. Egress + packaging
  tests pass unmodified (no new deps, no new I/O).
- **Non-corruption regression:** corpus ≥80% bar and leaderboard snapshot **unchanged**. The
  snapshot baseline is the CURRENT one (post the worktree-aggregation slice, #4) — this slice must
  not change it. Scorer/aggregator untouched; this is itself the assertion that the slice is
  non-corrupting.

## 12. Open questions (slice-specific)

1. **Breadth vs file-depth as the dominant signal.** Breadth is size-robust (favored for
   brownfield); file-depth is the clearer separator on small repos. Final primacy settled by the
   two-repo-class gate; both are emitted regardless.
2. **Per-repo-class thresholds vs a single floor.** A single floor is the v1 contract; if the gate
   shows brownfield and greenfield need different floors, a `repo_class` heuristic or per-repo
   override is a fast-follow (not v1).
3. **Zero-edit (Q&A) sessions as a positive signal.** v1 treats them as out-of-metric population
   context only. A high Q&A fraction *might* itself indicate "agents ask because no doc answers,"
   but it is confounded with legitimate research; deferred.
4. **Interpretation of an elevated baseline.** Deliberately undiagnosed here; the Diagnoser slice
   must separate missing-harness from large-codebase from inherent-complexity before any action is
   recommended.
5. **`min_sessions`/`severity_min_sessions` defaults (10/20).** Priors; confirm against the dogfood
   repos' session counts.

## 13. Relation to parent design

Implements the **`repo` localization unit** from DESIGN.md §4.2 **behaviorally** (elevated
orientation across sessions) rather than by structural absence (rejected, §3). Advances detection
only; the Diagnoser/Synthesizer/Router/Measurement closed loop remains in later slices. The
normalized-event schema and the seven per-session signals are reused verbatim — no wasted Slice 1
work, and Slice 1's per-session/per-area output is preserved unchanged.

## TL;DR

Slice 2 makes harnessgap **see diffuse orientation overhead** that the seven acute signals
structurally cannot (on the brownfield reference, every acute signal medians 0 and `explore_ratio`
medians 0.07 — ~100× under threshold — because productive output dilutes the ratios). It adds a
**pre-edit orientation metric** — distinct directory **breadth** (size-robust, primary) + distinct
file **depth** (corroborator), counted only **before the first edit** so productivity never dilutes
it, and **zero-edit Q&A sessions (36% on the reference) are excluded** from the median. A
**two-path baseline finding** fires on elevated orientation (primary) **or** an absolute struggle
rate (secondary); it **observes but does not verdict** (no "gap"/"write a doc" — cause is the
Diagnoser's job, later), and **never prescribes files** — a deliberate divergence from DESIGN.md
§4.2. The rev-1 **absolute-flag overlay is dropped** (it corrupted Slice 1's validated leaderboard),
so `StruggleRecord`/`flagged`/scoring stay untouched and the only contract additions are
`RepoFinding` + `repo_findings` + a `detector.ambient` block. Thresholds are **pinned and gated
across two repo classes** (unharnessed fires; held-out well-harnessed stays silent; brownfield
matches gut and is stable under ±20% perturbation). Still stateless, offline, pure, no new
dependencies, no new I/O.
