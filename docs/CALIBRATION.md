# Calibration — accepted-risk record

harnessgap's detection and cause-attribution are **not precision-validated**.
This page is the honest, written-down record of that gap: what is and isn't
mitigated, what ships anyway, and the concrete plan to close the gap later. It
exists so the gap does not die silently in a conversation (per the repo rule:
*deferred items get tracked in the spec / a doc, not dropped mid-thread*).

Per the closed-loop MVP spec
([§11](superpowers/specs/active/2026-07-24-mvp-closed-loop-design.md)) and the
detection spec (§11), calibration of detector + Diagnoser precision/recall is
**deferred as an accepted risk** for the MVP slice. Issue
[#34](https://github.com/HumanBean17/harnessgap/issues/34) tracks it.

## What is unvalidated

- **Detector precision/recall** (issue #34 Phase 1) — no blind,
  pre-registered measurement of how often the top-N flagged areas match a
  user's recalled struggle set on a real repo. The dogfood gate in
  [README.md](../README.md) is the manual substitute; it has not been run
  against a published, scored corpus.
- **Cause-vs-memory** (issue #34 Phase 3) — no measurement of whether the
  Diagnoser's `cause` labels agree with a human reading the same transcripts.
  The cause taxonomy is a v1 rule engine with five hand-set floors
  (`confidence_floor`, three share floors, `score_floor`); the floors are priors,
  not tuned values.

The detector's *signal* correctness (each of the 7 signals fires on the events
it claims to count) **is** tested — `test/signals.part1.test.ts`,
`test/signals.part2.test.ts`, `test/corpus.test.ts` (the labeled fixture corpus,
≥ 80% match bar). What is unvalidated is the *aggregate* decision: given correct
signals, are the right areas flagged and the right causes assigned?

## Why this is an acceptable risk for the MVP

Two reasons, one structural and one procedural:

1. **The closed loop gates every artifact on human review.** `synthesize`
   produces a proposal only under a prose gate, fact-checks it against HEAD, and
   writes it to `docs/_proposals/`; nothing lands in `docs/` until a human runs
   `review`. A false-positive cause yields a proposal a human rejects — cheap and
   correct. There is no auto-merge, no auto-PR.
2. **Detection sensitivity is deliberately favored over precision.** Lowering
   `detector.flag_pct` is a config knob with no code. FPs are tolerated because
   every artifact is reviewed.

## Mitigations in place (FPs cheap-and-correct)

| Mitigation | What it does | Where |
| --- | --- | --- |
| **Percentile auto-calibration** | Scoring is relative to the repo's own session cohort (percentile-of-composites), so the flag threshold self-tunes to whatever "struggle" looks like *for this repo* — no absolute floor to miscalibrate. Bootstrap mode (absolute thresholds) is automatic only below `bootstrap_session_floor`. | `src/detector/scoring.ts`; spec §5 |
| **Prose gate** | `synthesize` drafts prose only for `cause ∈ {doc, config-doc}` at or above `diagnose.confidence_floor_for_prose` (default 0.6). Below floor or non-prose causes collapse into one digest card — no backend call, no proposal to review. | `src/synthesizer/index.ts`; spec §5.2 |
| **Confidence floor** | A specific cause must score `≥ confidence_floor` (default 0.5) to win; otherwise the area is `unclassified` rather than mislabeled. `confidence_floor_for_prose` further raises the bar for anything that becomes prose. | `src/diagnoser/classify.ts`; spec §9 |
| **Pre-write fact-check** | Every proposal is checked against HEAD before it is written: cited symbols resolve in `source_files`, referenced paths resolve on disk, and every `source_files@<sha>` pins a real commit. A factually-wrong doc is caught here, not in review. (Note: this catches *factually-wrong* docs, not *wrong-cause* docs — see below.) | `src/synthesizer/factcheck.ts`; spec §5.4 |

### Honest caveat the gates do **not** close

**Wrong-cause prose.** The fact-check catches factually-wrong docs, not
wrong-cause docs, and the Diagnoser is uncalibrated. Misclassifying a
`refactor-flag` area as `doc` yields plausible prose that passes every gate.
Residual mitigations: `review` surfaces `evidence_refs` so a human sanity-checks
the *rationale*, not just the label; the demo path uses a user-selected `--unit`
so it cannot accidentally ship a mis-classification; and
`confidence_floor_for_prose` downgrades low-confidence causes to rationale cards.

## Recall substitute — the plan to close #34 Phases 1 & 3

Issue [#34](https://github.com/HumanBean17/harnessgap/issues/34) defines "Done"
as a blind precision/recall measurement. That full measurement is deferred, but
the **substitute that makes it cheap later** ships now and is itself a form of
partial validation:

- **Labeled fixture corpus** (`test/fixtures/corpus/labels.json` +
  `test/corpus.test.ts`) — real-shape transcripts with `expected_flagged` +
  `expected_top_signals` labels, run through the real pipeline at an ≥ 80% match
  bar. This is the regression proxy that catches signal regressions and is the
  seed for the larger labeled set a Phase 1 measurement needs.
- **Read-the-transcript labeling** — the labeling methodology for Phase 1/3 is
  "read each transcript, decide whether the agent struggled and why, then check
  whether harnessgap agrees." The corpus already uses this method on a small
  scale; scaling it is mechanical, not a research problem.

**Status of #34:** deferred-with-decision. Phases 1 (blind precision/recall) and
3 (cause-vs-memory) are postponed until post-MVP; Phase 0 (eyeball one real
`scan`) and the corpus extension ship now. The drafted comment below is the
notice to post on #34 so its "Done means" is satisfied-by-decision rather than
silently skipped.

---

## Drafted comment for GitHub issue #34 (post manually)

> **Do not auto-post.** The text below is a draft for a maintainer to review and
> post with `gh issue comment 34 --repo HumanBean17/harnessgap`. It is kept here,
> not in the issue thread, so the accepted-risk record and the issue status stay
> in sync via this doc.

```text
Closing the loop on #34 for the closed-loop MVP slice (not closing the issue — recording a deferred-with-decision status so its "Done means" is satisfied-by-decision rather than skipped).

**What "Done" meant here:** a blind, pre-registered precision/recall measurement of the detector (Phase 1) and a cause-vs-memory measurement of the Diagnoser (Phase 3).

**Decision: defer Phases 1 & 3 to post-MVP.** Accepted as a risk because the closed loop gates every artifact on human review — synthesize prose-gates + fact-checks against HEAD + writes to docs/_proposals/ for review; nothing auto-merges. A false-positive cause becomes a proposal a human rejects (cheap and correct). Mitigations in place: percentile auto-calibration, the prose gate (confidence_floor_for_prose), the confidence floor, and the pre-write fact-check.

**What ships now as the recall substitute (and the seed for the later measurement):**
- Phase 0 (eyeball one real `scan`) — done as part of slice dogfooding.
- The labeled fixture corpus (test/fixtures/corpus/labels.json + test/corpus.test.ts, ≥80% match bar) — the regression proxy and the seed for the larger labeled set a Phase 1 run needs. The labeling method (read-the-transcript → decide struggled/why → check agreement) is the same one Phase 1/3 will scale.

**Where this is written down:** docs/CALIBRATION.md (accepted-risk record + mitigations + recall-substitute plan) and the closed-loop MVP spec §11.

Leaving this issue open as the tracker for Phases 1 & 3. When work resumes, scale the corpus, run the blind measurement against a pre-registered struggle/non-struggle set, and report precision/recall + cause agreement numbers here.
```

---

## See also

- [Closed-loop MVP spec §11](superpowers/specs/active/2026-07-24-mvp-closed-loop-design.md) — the accepted-risk section this record elaborates.
- [Detection spec §11](superpowers/specs/archive/2026-07-12-harnessgap-detection-slice-design.md) — the original calibration open question.
- [Diagnoser spec §11](superpowers/specs/active/2026-07-18-harnessgap-diagnoser-design.md) — Diagnoser open questions.
- [Consumer guide "Honest caveats"](CONSUMER_GUIDE.md) — the user-facing version of these caveats.
- Issue [#15](https://github.com/HumanBean17/harnessgap/issues/15) — the five Diagnoser floor priors (related, narrower).
