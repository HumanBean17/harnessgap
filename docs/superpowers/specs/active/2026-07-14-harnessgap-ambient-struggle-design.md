# harnessgap — Behavioral Ambient Struggle Detection (Phase 1, Slice 2)

**Status:** approved design → implementation planning
**Date:** 2026-07-14
**Parent design:** `docs/DESIGN.md` (v0.2)
**Prior slice:** `docs/superpowers/specs/archive/2026-07-12-harnessgap-detection-slice-design.md` (Slice 1, shipped v0.1.1)
**Runtime:** Node + TypeScript, `npx harnessgap`; still stateless and offline.

## 1. Purpose

Close the gap Slice 1's dogfood exposed. On a repo with **no harness at all** (every session
starts blank), `harnessgap scan` flagged only ~3 sessions — because **percentile scoring is
structurally blind to a uniformly-elevated baseline** (the "boiling frog": when every session
struggles, none is an outlier). The dominant pain — *systemic/ambient* — went unsurfaced.

This slice makes harnessgap detect ambient struggle **behaviorally**, as a distinct named
finding, without prescribing files and without assuming struggle from absence.

### Success criterion

On the dogfood "battle project" (no harness, blank-paper sessions), `harnessgap scan` emits a
**repo-level ambient finding** whose severity reflects the felt pain, and the area leaderboard
**flags more honestly** (sessions that trip absolute thresholds flag even in percentile mode).
On a repo where the agent is fluent ("miracle model" — low-struggle behavior), **no ambient
finding fires** and the leaderboard is not noisier than today.

This is validated by the same manual dogfood gate as Slice 1, plus a new judgment: does the
ambient finding appear on the no-harness repo and **not** appear on a fluent repo?

## 2. Scope

**In scope**
- Behavioral **ambient/repo finding**: a distinct finding that fires when the repo's *typical*
  session is at struggle-level by **absolute** terms.
- **Absolute-flag overlay**: sessions tripping absolute thresholds flag even in percentile mode.
- **Threshold calibration**: the bootstrap absolute thresholds — now the shared absolute
  reference for both bootstrap mode and the ambient finding — are revised from corpus + dogfood.
- New `RepoFinding` contract; `flag_reason` on `StruggleRecord`; `repo_findings` in `--json`;
  ambient block in the human table and verdict in `--calibrate`; new `detector.absolute_overlay`
  and `detector.ambient` config.

**Out of scope (deferred)**
- **Structural-absence / canonical-file checks — explicitly rejected** (§3). The `repo` unit is
  redefined as *behavioral ambient struggle*, not file-presence.
- A new per-session "re-learning tax" signal. The aggregate view added here is itself the
  diagnostic: if absolute medians are low yet the user still feels pain, *then* add a signal.
- Diffuseness analysis (does ambient pain concentrate in flagged areas vs spread?) — reported as
  an attribute at most; not a gate (§11).
- Diagnoser, Synthesizer, Curator, Router, Measurement, persistence, multi-agent adapters —
  unchanged from Slice 1's deferrals.

## 3. Principle — behavioral detection, not prescription

Detection measures **behavior against absolute references**. It never prescribes files and never
infers struggle from the absence of a doc. Rationale, from the dogfood review:

- harnessgap's contract is *deterministic signals over transcripts*. A "missing CLAUDE.md"
  check is prescriptive ("here is what you should have") and is a different product.
- A file-presence check false-positives the **miracle-model** case: an agent that already knows
  the repo produces low-struggle behavior, yet the tool would still nag. Wrong by construction.

**Divergence from the parent design.** `docs/DESIGN.md` §4.2 defines the `repo` unit as detected
by "structural absence (canonical docs/config missing) combined with uniformly-elevated cost."
This slice **rejects the structural-absence prong** and detects the `repo` unit purely by
behavior: absolute aggregate struggle across the session set. The self-suppression DESIGN.md
§12.9 worries about ("avoid nagging lightweight repos") is achieved *behaviorally* — a
non-struggling repo yields low signals → no finding — not by a file checklist.

## 4. Detection mechanism — "absolute struggle rate"

The ambient signal is *the typical session struggles by absolute terms*. Percentile ranking
cannot see a uniform baseline; absolute comparison can. The mechanism reuses the existing
bootstrap trip logic, applied to every session regardless of scoring mode. **No new signal, no
new per-session math.**

1. **Per-session absolute trip profile.** For each session, determine which signals trip their
   absolute (`bootstrap_`) threshold and whether the session meets the bootstrap flag condition
   (composite ≥ `bootstrap_flag_pct` **or** ≥2 signals trip). This is the computation Slice 1's
   `bootstrapScore` already performs; it is now produced for *all* sessions, not only when the
   scan is in bootstrap mode.
2. **Absolute struggle rate** = share of sessions meeting the bootstrap flag condition. 0.60
   means the typical session struggles by absolute terms — systemic, not outlier.
3. **Systemic signals** = signals whose *median* across the session set is ≥ their absolute
   threshold ("more than half the repo struggles on this dimension"). Nullable signals
   (`explore_ratio`, `wall_clock_per_line_ms`) are medianed over non-null sessions only.
4. **Trigger + severity.** The finding fires when `struggle_rate ≥ ambient.struggle_rate_threshold`
   (default 0.30) **and** `sessions_sampled ≥ ambient.min_sessions` (default 5). Severity scales
   with the rate: high ≥ `severity_high` (default 0.60); medium ≥ `severity_medium` (default
   0.45); otherwise low. Defaults are chosen so all three bands are reachable
   (low ∈ [0.30, 0.45)). Below the threshold or below `min_sessions` → **no finding**.
5. **Self-suppression is built in.** A fluent repo (miracle model) → few sessions trip absolute
   thresholds → low rate → no finding. No file checks, no prescription.

**Why this fits the dogfood:** on the no-harness repo, the absolute struggle rate is high (every
blank-paper session trips absolute thresholds) → a high-severity finding, *even though* percentile
mode flagged only ~3. The delta between "~3 percentile-flagged" and "e.g. 60%
absolute-struggling" *is* the ambient blindness, now surfaced.

## 5. Detection tuning

### 5.1 Absolute-flag overlay

A session's `flagged` becomes the union: `percentileFlag || (absolute_overlay && absoluteFlag)`.
A `flag_reason` records which route fired. This propagates to the area leaderboard (an area
flags when its sessions flag by either route), so systemic-but-diffuse pain gets area-level
representation too. Configurable via `detector.absolute_overlay` (default on). In bootstrap mode
the overlay is a no-op (absolute flags already apply).

### 5.2 Threshold calibration

The `bootstrap_thresholds` become the shared absolute reference for bootstrap mode, the overlay,
and the ambient finding — so they must be honest. They are revised against the labeled corpus
(Slice 1's 12 fixtures) and the dogfood during implementation. The spec fixes the *mechanism and
calibration process*; the exact revised numbers are an implementation output. Candidates under
review: `explore_ratio` (today 10, likely too high for blank-paper sessions) and
`wall_clock_per_line_ms` (today 300000). This is the "priors → learned" step Slice 1's open
question §12.1 anticipated.

## 6. Contracts (additive — existing fields untouched)

### 6.1 `RepoFinding` (new; emitted 0 or 1 per scan in this slice; array for future kinds)

```jsonc
{ "kind": "ambient-struggle",
  "severity": "high" | "medium" | "low",
  "struggle_rate": 0.62,              // share of sessions absolute-struggling, 0–1
  "sessions_sampled": 87,
  "median_composite": 74,             // median across sessions of each session's bootstrap composite, 0–100
  "systemic_signals": [               // median ≥ absolute threshold, sorted by median/threshold desc
    { "name": "explore_ratio", "median": 14.2, "threshold": 10 },
    { "name": "wall_clock_per_line_ms", "median": 612000, "threshold": 300000 } ],
  "scoring_mode": "percentile" }      // the scan's actual mode, for context
```

No raw prose: signal names, numbers, and a severity label only.

### 6.2 `StruggleRecord` (one field added; `flagged` semantics broaden to the union)

```jsonc
flagged: boolean;                          // percentileFlag || (absolute_overlay && absoluteFlag)
flag_reason: "percentile" | "absolute" | "both" | null   // NEW
```

### 6.3 `JsonOutput`

Adds `repo_findings: RepoFinding[]` (additive; `[]` when no finding).

### 6.4 Config (`.harnessgap.yml`, new keys under existing `detector:`)

```yaml
detector:
  absolute_overlay: true            # NEW — flag sessions tripping absolute thresholds in percentile mode
  ambient:                          # NEW
    struggle_rate_threshold: 0.30   # finding fires when ≥ this share are absolute-struggling
    severity_high: 0.60
    severity_medium: 0.45
    min_sessions: 5                 # below this, too few to call "systemic" → no finding
  bootstrap_thresholds:             # REVISED values from calibration (mechanism unchanged)
    explore_ratio: 8                # candidate, not pinned — finalized in calibration
    wall_clock_per_line_ms: 240000  # candidate, not pinned
    # …other thresholds reviewed against corpus + dogfood
```

No new top-level key; `.harnessgap.yml` still accepts only `detector` and `areas`. `scan` runs
with no config using these defaults. New nested keys are validated
(`struggle_rate_threshold`/`severity_*` ∈ [0,1]; `min_sessions` ≥ 1).

## 7. CLI & output

No new command or flag in this slice. The ambient finding surfaces through the existing outputs:

- **Human table.** A one-line ambient summary is always printed (the struggle rate); it expands
  to a finding block (severity, `systemic_signals`, one-line interpretation) when a finding
  fires. Placed above the area leaderboard. Example:
  ```
  AMBIENT / REPO-LEVEL FINDING — severity: high
    62% of 87 sessions show absolute struggle (median composite 74)
    systemically elevated: explore_ratio (median 14.2 vs 10), wall_clock/line (median 612s vs 300s)
    → the typical session struggles; a baseline/ambient gap, not a single bad area
  ```
- **`--json`.** Emits `repo_findings` per §6.3. Records carry `flag_reason` per §6.2.
- **`--calibrate`.** Adds the ambient verdict (struggle rate, systemic signals) and marks the
  absolute-reference line against each signal distribution. Aggregate statistics only.

`--bootstrap` (force bootstrap) is unchanged; in bootstrap mode the overlay is a no-op and the
ambient finding still computes (struggle rate = share bootstrap-flagged).

## 8. Module / data-flow placement

All additions are pure functions over already-computed signals; the only new file is
`src/detector/ambient.ts`. No new I/O, no new dependencies.

| Change | Location | Responsibility |
|---|---|---|
| Surface absolute trip result + derive `flag_reason` | `src/detector/scoring.ts` | `SessionScore` exposes the bootstrap trip profile; `flagged` = union; `flag_reason` derived. Single source of truth for trip logic. |
| `assessAmbient(sessionSet, cfg) → RepoFinding \| null` | **`src/detector/ambient.ts` (new)** | Pure: consumes each session's raw signal values and the scorer's absolute-trip/composite results to compute struggle rate, systemic signals, median composite, severity; null below threshold or `min_sessions`. |
| Project `flag_reason` onto records | `src/detector/record.ts` | Carries the scorer's reason onto `StruggleRecord`. |
| Thread finding into output | `src/pipeline.ts` | Call `assessAmbient` after `runDetector`; pass to formatters. |
| `repo_findings` in envelope | `src/output/json.ts` | Additive. |
| Ambient block in table | `src/output/human.ts` | Always-printed summary line; finding block when it fires. |
| Ambient verdict + absolute reference | `src/output/calibrate.ts` | Additive. |
| Defaults + validation | `src/config.ts` | New keys validated; defaults applied. |
| Types | `src/types.ts` | `RepoFinding`, `FlagReason`; extend `StruggleRecord`, `JsonOutput`, `Config`. |

The normalized-event schema (§4 of the Slice 1 spec) is untouched — ambient detection consumes
detector outputs, not raw events.

## 9. Error handling — fail-open (all Slice 1 guarantees preserved)

- **No network, no disk writes.** Still true; ambient assessment and the overlay are pure
  computation. A bug's worst case is a wrong finding, never a broken session.
- **Too few sessions** (`sessions_sampled < min_sessions`) → no finding; summary notes "too few
  sessions to assess ambient."
- **All-null signal** (e.g. no edits → `explore_ratio` null for all) → skipped from
  `systemic_signals`; if no signal has a computable median → no finding.
- **Bootstrap mode** → overlay is a no-op; ambient still computes.
- **Exit codes unchanged.** No new non-zero path; "no sessions" still exits 0.

## 10. Testing

- **`assessAmbient` unit (pure):** high-rate synthetic set → finding + correct severity +
  correct `systemic_signals`; low-rate (miracle) set → null; below `min_sessions` → null;
  all-null signals → null; severity-band boundaries.
- **Overlay unit (scorer):** below-percentile but ≥2 absolute trips → `flagged:true,
  flag_reason:'absolute'`; both routes → `'both'`; overlay off → percentile-only (back-compat).
- **Config unit:** new keys validated; defaults applied; out-of-range values rejected.
- **Pipeline integration:** a synthetic no-harness fixture set (high baseline, no outlier) → one
  high-severity finding + absolute-flagged sessions in the area leaderboard; a fluent-agent set →
  no finding.
- **Corpus + snapshot:** re-run; assert determinism; update the snapshot for the new ambient block.
- **Privacy / egress / packaging:** unchanged — no new I/O, no new dependencies, no prose in any
  finding (names + numbers + severity only). Existing `test/egress.test.ts`,
  `test/packaging.test.ts`, `test/privacy.test.ts` continue to pass unmodified.

## 11. Open questions (slice-specific)

1. **Revised absolute-threshold values** — finalized in calibration (§5.2).
2. **`struggle_rate_threshold` (0.30), severity bands, `min_sessions` (5)** — priors; revise
   after dogfood.
3. **Diffuseness** — should the finding report whether systemic pain concentrates in flagged
   areas vs spreads? Deferred as a gate; may surface as an attribute.
4. **Overlay default on/off** — tied to threshold calibration; "on" can make percentile
   leaderboards noisier until thresholds settle.
5. **Ambient on small real repos** — does `min_sessions=5` fire too eagerly or too reluctantly
   on the dogfood repo?

## 12. Relation to parent design

Implements the **`repo` localization unit** from DESIGN.md §4.2, but **behaviorally** (absolute
aggregate struggle) rather than by structural absence (§3). Advances the detection layer only;
Diagnoser/Synthesizer/Router/Measurement and the closed loop remain in later slices. The
normalized-event schema and the seven signals are reused verbatim — no wasted Slice 1 work.

## TL;DR

Slice 2 makes harnessgap **see ambient pain** that percentile scoring is blind to. It detects a
**behavioral repo-level finding** — "the typical session struggles by absolute terms" — measured
as the **absolute struggle rate** (share of sessions that trip the existing bootstrap absolute
thresholds), with **systemic signals** (median ≥ threshold) as evidence. It **self-suppresses**
for fluent repos (miracle model → low signals → no finding), with **no file checks and no
prescription** — a deliberate divergence from DESIGN.md §4.2's structural-absence prong. An
**absolute-flag overlay** makes sessions flag by absolute terms even in percentile mode (fixing
the dogfood's "~3 flagged" on a no-harness repo), and the **absolute thresholds are recalibrated**
from corpus + dogfood. Contracts are additive: a new `RepoFinding`, a `flag_reason` on
`StruggleRecord`, `repo_findings` in `--json`, an ambient block in the table, and
`detector.absolute_overlay` / `detector.ambient` config. Still stateless, offline, pure, no new
dependencies. No new signal — the aggregate view is itself the diagnostic that decides whether a
"re-learning tax" signal is ever needed.
