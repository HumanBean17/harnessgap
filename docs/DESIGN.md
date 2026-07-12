# harnessgap — turn agent struggle into measurable harness improvements

**Design doc, v0.2 — July 2026**

> v0.1 (`docgap`) is archived at `docs/DESIGN-v0.1.md`. v0.2 changes three things: scope widens
> from "documentation gaps" to **harness gaps** (docs, confusing code, missing tests, config/env
> drift); knowledge is **routed actively** into context at need rather than indexed passively; and
> impact is measured as a **read-vs-not-read struggle delta**, making the feedback loop first-class.

## 1. Problem

Experienced agent users develop an intuition: when the agent burns time exploring or
misunderstanding a part of the codebase, they write a small markdown file into
`docs/architecture/`, `docs/workflows/`, etc. Future sessions get measurably better.

The technique doesn't transfer, because it's packaged as a feeling:
*"self-reflect on your agentic sessions and improve the harness."* Teammates can't act on that.
Four things are missing:

1. **Detection** — a repeatable way to notice "the agent struggled here", instead of gut feeling.
2. **Diagnosis** — knowing *why* it struggled (missing doc? bad code? missing test? env drift?),
   because the right fix depends on the cause.
3. **Routing** — getting the right knowledge into the agent's context *at the moment of need*, not
   hoping it reads an index.
4. **Evidence** — numbers showing the harness improvements actually reduced struggle, so adoption
   doesn't depend on trust in one person.

## 2. What exists already (and why it's not this)

| Prior art | What it does | Gap |
|---|---|---|
| `continuous-learning` (everything-claude-code) | Stop hook + `/learn` extract patterns into personal `~/.claude/skills/learned/` | Claude-Code-only, personal skills, no struggle detection, no diagnosis, no metrics |
| `/wrap` session-wrap plugins | End-of-session pipeline proposing CLAUDE.md updates, TILs | Claude-Code-only, session-scoped, no cross-session recurrence, no routing |
| `Learnings.md` pattern | Agent appends observations to a repo file | No detection, unbounded append-only file, no curation, no effect measurement |
| claude-mem / Continuous-Claude | Personal memory layers over transcripts | Memory, not shareable team docs; no closed loop |

**Differentiation:** harnessgap is (a) agent-agnostic, (b) produces *repo-committed, PR-reviewed team
harness improvements* (not personal memory), (c) **diagnoses cause** rather than only flagging
struggle, (d) **routes knowledge actively** into context at the moment of need, and (e) measures
impact as a **read-vs-not-read struggle delta**. The closed loop — not the code — is the moat.

## 3. Core insight: the closed loop, and recurrence as symptom (not verdict)

One painful session is noise. The distributable signal is **the same area or task generating
struggle across multiple sessions and teammates**. But that signal is a *symptom*, and the naive
reading of it ("→ write a doc") is wrong. Three corrections define the design:

1. **Recurrence is a symptom, not a verdict.** A recurring struggle has one of several causes: a
   missing/wrong doc, confusing code that needs a refactor, a missing test or unclear contract,
   environment/config drift, or genuine inherent complexity. Only some are fixed by a doc. A tool
   that emits prose for every signal rationalizes bad code instead of fixing it. The unit of work is
   a **diagnosed gap**, not a doc.

2. **The unit of analysis is dual, with an ambient fallback.** Struggle localizes two ways: *where*
   (an **area** — a cluster of directories/modules) and *what* (a **task** — a recurring shape of
   activity like "deploy" or "add an endpoint" that may span the whole repo). Area covers
   architecture/gotcha docs; task covers workflow docs. But some struggle does not localize at all —
   it is *ambient* (no onboarding doc, no conventions) — which a third **repo** unit catches by
   structural absence. Two localization units plus one ambient unit; a single unit is blind to most gaps.

3. **Knowledge that isn't routed isn't used.** A doc sitting in the repo that no agent consults at
   the moment of struggle is dead weight. Discoverability is not an index block — it is *injection
   at need*. And the only honest measure of "did this help" is **sessions that consulted the
   knowledge vs. comparable sessions that didn't** — not a calendar line drawn at the doc's merge
   date, which a landing-but-never-read doc would wrongly get credit for.

So harnessgap is a **closed feedback loop**:

> **detect** struggle (area + task + repo) → **diagnose** cause → **propose** the right intervention →
> **review/merge** → **route** into context at need → **measure** the read-vs-not-read struggle
> delta → feed back into detection's baseline.

## 4. Architecture

```
                ┌──────────────────────────────────────────────────────────────────┐
                │                          harnessgap CLI                          │
                │                                                                  │
 ingest hook ──►│  Adapters ──► Normalized events ──► Detector ──► struggle records│
 (SessionEnd)   │  (scrubbed,        (common         (percentile       (area+task, │
                │   versioned,        schema)         signals: explore,             docs_read, │
                │   size-capped)                       reread, fail-streak,        docs_injected)│
                │                                      corrections, oscillation,    │
                │                                      wall-clock/line)            │
                │                                              │                   │
                │                                              ▼                   │
                │   Diagnoser (cause → typed rec) ──► Synthesizer ──► proposals ──► │──► docs/_proposals/
                │                                      (schema'd, dedupe,           │      │
                │                                       fact-check)                  │      ▼
                │                                              │              Curator ──► docs/** + PR
                │                                              │                   │
 route hook ◄───│◄─── Router ◄──── (knowledge → context @ need) ◄──────────────────┘
 (PreToolUse /  │                                                                  │
  start)        │                                                                  ▼
                │   Measurement ──► doc-read consumption + read-vs-not-read struggle delta
                │                                                                  │
                │   shared: .harnessgap/team/struggle.jsonl  (team recurrence, committed, scrubbed)
                └──────────────────────────────────────────────────────────────────┘
```

Seven components, strictly layered. Two are new in v0.2 — **Diagnoser** and **Router** — and
**Measurement** is promoted from a phase-3 nice-to-have to the spine of the product.

### 4.1 Adapters — agent-agnostic ingestion

Every supported agent writes machine-readable transcripts:

| Agent | Transcript location | Hooks? |
|---|---|---|
| Claude Code | `~/.claude/projects/<slug>/*.jsonl` (`transcript_path` in hook input) | Yes: `Stop`, `SessionEnd`, `PreCompact`, `PostToolUse`, `PreToolUse`, `UserPromptSubmit` |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | No session-end hook → batch mode (or shell wrapper) |
| OpenCode | local session storage; plugin API with `session.idle`, `tool.execute.after` | Yes: TS plugins in `.opencode/plugin/` |
| Qwen Code | `.qwen` logs / checkpoints; hook events mirror Claude Code | Yes: `SessionEnd`, `Stop`, `PostToolUse(Failure)` in `.qwen/settings.json` |

Each adapter parses native input into a **normalized event schema** (versioned):

```jsonc
{ "schema_version": 1, "session_id": "...",
  "agent": "claude-code|codex|opencode|qwen",
  "repo": "/path", "started_at": "...",
  "events": [
    { "t": "...", "kind": "user_msg" | "assistant_msg" | "tool_call",
      "tool": "read|search|list|edit|exec|other",     // normalized taxonomy
      "input_digest": {"files": [...], "cmd": "..."}, // secret-scrubbed
      "ok": true, "exit": 0, "duration_ms": 1234,
      "tokens": {"in": 0, "out": 0} }
  ]
}
```

Three non-negotiable adapter duties, absent in v0.1:

- **Secret scrubbing** at the boundary — before anything is persisted or sent. Strips common secret
  shapes (env-var assignments, `Authorization`/`Bearer` headers, `.env`/`*.pem`/`*.key` file reads,
  high-entropy tokens) from `input_digest.cmd` and read contents. This is the omission that gets a
  tool banned inside an enterprise.
- **`schema_version`** on every persisted record, so state can migrate as the schema evolves.
- **Size-capped streaming** — a 50 MB transcript on `SessionEnd` must not stall ingest.

Tool names map into the small taxonomy `read | search | list | edit | exec | other`. That is all the
detector needs, and it is what makes agent-agnosticism cheap.

**Fallback adapter:** for any future agent with hooks but awkward transcripts, a tiny
`harnessgap emit` hook command appends normalized events directly. Adapters are the only per-agent
code in the system.

### 4.2 Detector — deterministic heuristics, no LLM

Runs locally, fast, on every ingested session. Proprietary code never leaves the machine at this
stage. Signals per session (additions in v0.2 marked **new**):

- **Exploration ratio** — `search+read+list` calls before the first `edit`; explore-calls per edited line.
- **Re-reads / re-greps** — same file read N≥3 times, or similar search patterns repeated (normalized-query Jaccard similarity).
- **Failure streaks** — consecutive non-zero-exit `exec` calls; same-command retries.
- **User corrections** — user messages matching correction shapes ("no,", "that's wrong", "actually", "не туда", interrupt events), especially shortly after assistant actions.
- **Context thrash** — compaction events (`PreCompact` count); token burn vs. diff size.
- **Abandonment** — session ends with an explore-heavy tail and no edits.
- **Oscillation / loops** *(new)* — `edit → test-fail → revert → edit-differently → fail` cycles;
  repeated test runs against the same file. One of the clearest struggle signatures, missing in v0.1.
- **Wall-clock per edited line** *(new)* — the signal most salient to humans ("this took forever").
  A 45-minute session producing five lines is struggle regardless of tool-call shape.
- **Expensive success** *(new)* — a regime signal, not a raw metric: high cost (wall-clock, tokens-out
  per edited line) on a session whose failure/correction/oscillation signals are *absent*. The
  signature of a capable model that "saves" the outcome but not the cost — no corrections, tests
  green, yet 500K tokens for a 20-line diff. Carries the most composite weight for capable-model
  users, because the louder signals are exactly what good models suppress. This is the case a human
  never feels — and therefore the highest-value detection target.

**Thresholds are percentiles, not absolutes** *(new)*. v0.1 shipped magic numbers
(`min_explore_ratio: 12`) and admitted "struggle differs per repo". The fix: every threshold is a
percentile *within the repo's own session history* ("flag the top 10% of explore-ratio sessions for
this repo"). This auto-calibrates, removes the dominant false-positive source, and means the phase-1
dogfood does not die on bad defaults. Absolute overrides remain available for power users.

**Caveat — percentiles can't see a uniformly-elevated baseline.** If *every* session is expensive
(no onboarding doc, no conventions, unclear structure), nothing is an outlier, so percentile
thresholds stay quiet — the "boiling frog". Relative-outlier detection is blind to ambient pain by
construction; that is why the `repo` unit (below) is detected by **structural absence** instead.

Each flagged session yields a **struggle record** keyed by **both** localization units (area + task),
with `repo` appended when the struggle is diffuse:

```jsonc
{ "session_id": "...", "repo": "...", "started_at": "...", "duration_ms": ...,
  "units": [
    { "kind": "area", "key": "src/billing", "weight": 0.82 },
    { "kind": "task", "key": "deploy-workflow", "fingerprint": "...", "weight": 0.61 }
  ],
  "score_pct": 93,                       // composite, percentile within repo
  "signals": { "explore_ratio_pct": 95, "reread": 7, "failure_streaks": 2,
               "corrections": 3, "oscillation": 4, "wall_clock_per_line_ms": 540000 },
  "evidence_refs": [ /* scrubbed pointers, no raw transcript text */ ],
  "docs_read":        [ "docs/architecture/billing.md" ],   // for Measurement
  "docs_injected":    [ "docs/architecture/billing.md" ]    // for Measurement
}
```

- **Area** = top directories by touch-weight, clustered by path-prefix (v1; import-graph/embeddings
  later).
- **Task** = intent fingerprint derived from the shape of the tool-call sequence plus the leading
  user messages. Two sessions running the same dance (`read config → edit config → run failing test
  → re-read config`) in different directories are the *same task gap*. A handful of canonical
  fingerprints gets most of the value before embeddings are warranted.
- **Repo** *(new)* = a synthetic unit for **diffuse/ambient** struggle that no area or task anchors —
  the agent pays a tax on every session, everywhere (no onboarding doc, no conventions, missing
  `CLAUDE.md`, unclear structure). Detected by **structural absence** (canonical docs/config missing)
  combined with uniformly-elevated cost signals across sessions — *not* by per-session percentiles,
  which cannot see a uniformly-high baseline. Typical cause: `doc` (overview/conventions) or
  `config-doc` (tooling setup). Self-suppresses once the canonical docs exist.

### 4.3 Diagnoser — cause before artifact *(new)*

Triggered when a unit crosses the recurrence threshold (≥N flagged sessions in W days across the
team — see §4.7), or manually. Takes the unit's struggle records and classifies the **likely cause**:

```
cause ∈ { doc, config-doc, refactor-flag, test-gap, inherent-complexity }
```

Output — a **typed recommendation**:

```jsonc
{ "unit": { "kind": "area", "key": "src/billing" },
  "cause": "doc", "confidence": 0.78,
  "rationale": "high explore-ratio + re-reads of billing/charge.ts; no doc exists; code is stable",
  "evidence_refs": [...] }
```

Rule-based first pass (signals → likely cause: heavy re-reads + stable code → `doc`; flaky-test
patterns → `test-gap`; high oscillation + recent churn → `refactor-flag`; env/exit-code patterns →
`config-doc`; high wall-clock with low signal specificity → `inherent-complexity`), refined by one
LLM call when confidence is low. Only `doc` and `config-doc` produce prose downstream; the others
become short rationale hand-offs to a human who decides the real fix. This is what stops the tool
from manufacturing docs that rationalize bad code.

### 4.4 Synthesizer — schema'd, dedupe-first, fact-checked

Consumes a typed recommendation and emits the matching artifact via the agent CLI you already trust
(default `claude -p` under the same account — no new vendor/data path; pluggable to `codex exec`,
`opencode run`, any stdin-prompt command).

Input to the LLM pass:
1. **Evidence bundle** — the unit's struggle records (what was searched, failed, corrected).
2. **Existing docs inventory** — file list *and bodies* under the configured `docs_dirs` (for real dedupe).
3. **Repo files in the unit** — heads only, size-capped, secret-scrubbed.

Output is a **schema-checked proposal** (the contract v0.1 called "enforced" without defining):

```jsonc
{ "kind": "new-doc" | "edit-proposal",
  // new-doc:
  "path": "docs/architecture/billing.md",
  "frontmatter": { "derived_from": ["sess-ids"], "unit": {...}, "struggle_score": 93,
                   "cause": "doc", "source_files": ["src/billing/charge.ts@<sha>"], "created": "..." },
  "body": "...",
  // edit-proposal instead carries:
  "target_doc": "docs/architecture/billing.md",
  "decision": "append" | "split" | "supersede",
  "ranges":  [ /* old/new string spans */ ],
  "rationale": "...",
  // always:
  "dedupe": { "nearest_existing": "docs/architecture/payments.md", "similarity": 0.41,
              "decision_rationale": "different module; new doc" },
  "verification": { "cited_symbols_resolved": true, "paths_resolved": true, "shas_valid": true } }
```

Two upgrades v0.1 only gestured at:

- **Real dedupe.** Similarity is computed between the *proposed content* and *existing doc bodies*
  (TF-IDF for v1, embeddings later), with an explicit decision: `new | append-to | split | supersede`.
  "File list + first heading" (v0.1) matches nothing useful.
- **Pre-review fact-check.** Before a proposal reaches a human, deterministic checks verify the
  doc's claims against HEAD: do cited symbols exist? Do referenced paths resolve? Are the
  `source_files@commit` SHAs valid? An LLM-synthesized doc that confidently asserts "the `charge()`
  function lives in `billing/charge.ts`" when it doesn't is worse than no doc. v0.1's staleness check
  runs *after* docs age; this runs *before* they enter the repo.

Doc style guide baked into the prompt: short (≤120 lines), answering "what an agent wastes time
discovering". Structure: *what this is → how it's wired → gotchas → where to look*. Frontmatter
embeds session IDs only — never transcript text.

### 4.5 Curator — humans stay in the loop

- Nothing auto-commits. Proposals land in `docs/_proposals/`; `harnessgap review` opens an
  interactive accept/edit/reject flow that **surfaces the diagnosed cause** so the reviewer brings
  the right lens (a `refactor-flag` is not rubber-stamped like a `doc`). `harnessgap pr` opens a
  branch + PR via `gh`.
- **Static fallback index.** harnessgap maintains one generated index block (title + one-line
  "read this when…") inside `CLAUDE.md`, `AGENTS.md`, `QWEN.md` between markers
  `<!-- harnessgap:index:start -->…<!-- harnessgap:index:end -->`. This is now a *fallback* for
  agents that read these files on startup; the **Router** (§4.6) is the primary discoverability path.
- **Staleness check.** Each doc records `source_files@commit`; `harnessgap stale` flags docs whose
  sources have significantly drifted since.

### 4.6 Router — knowledge into context at need *(new)*

The component v0.1 was missing entirely. Given the current working directory and recent tool calls,
the Router pulls the relevant knowledge into the agent's context **at the moment of need**, not at
session start and not via a 50-row index nobody scrolls. Mechanism: a `PreToolUse` / session-start
hook.

This is where the one open taste-call lives, and v0.2 ships a tunable default:

- **Default — pointers.** Before an edit in a flagged unit, inject a one-line pointer:
  *"Before editing `src/billing/`, read `docs/architecture/billing.md`."* Cheap, no context bloat,
  agent stays autonomous. Pairs with an on-demand `/harnessgap explain <unit>` for the full doc.
- **Opt-in — full injection.** For units above a high struggle percentile, `PreToolUse` injects the
  whole doc body before edits. Maximal effect, but eats context on every edit; off by default.
- *(Rejected for v1: pure opt-in command — it re-introduces the passivity problem for agents that
  don't ask.)*

Tuning lives in `.harnessgap.yml`. The Router is what converts "docs exist in the repo" into "docs
are in context at the right instant" — and it is what the Measurement layer instruments.

### 4.7 Measurement — the spine (was phase-3 nice-to-have)

Two instruments, both fed by the struggle record's `docs_read` / `docs_injected` fields:

1. **Consumption detection.** Read events on `docs/**` paths are recorded per session — so we know
   *which* knowledge a session actually consulted (or had injected), not merely what exists.
2. **Read-vs-not-read struggle delta.** For each unit, compare the struggle score of sessions that
   consulted/injected doc *X* against comparable sessions in the same window that did not.

```jsonc
// .harnessgap/metrics.jsonl  (local; team copy optionally synced)
{ "session_id": "...", "unit": "src/billing", "ts": "...",
  "consulted": ["docs/architecture/billing.md"], "injected": [...],
  "score_pct": 41, "signals": {...} }
```

`harnessgap stats --unit src/billing --doc docs/architecture/billing.md` renders the comparison.
The artifact — *"sessions that consulted `billing.md` had 40% lower explore-ratio in `billing/`
than comparable sessions that didn't"* — is the evidence that replaces "trust my feelings", and it
is strictly stronger than v0.1's "struggle dropped after the doc landed" (which credits docs that
were never read).

**Shared team recurrence.** Aggregated, scrubbed records append to a **git-committed**
`.harnessgap/team/struggle.jsonl`:

```jsonc
{ "window": "2026-06", "unit": {...}, "sessions_flagged": 7, "teammates": 3,
  "top_signals": {...}, "docs_in_unit": ["docs/architecture/billing.md"] }
```

No transcript text, no file contents, no author identity beyond an anonymized count. This is what
makes the headline differentiator — recurrence *across teammates* — real from phase 2 instead of
deferred to phase 5.

Honest caveat (surfaced in the README): read-vs-not-read is still quasi-experimental (task mix
varies; readers may self-select harder tasks). Recurrence + trend + consumption delta is nonetheless
vastly better evidence than intuition, and harnessgap surfaces a confidence band on every delta.

## 5. Trigger modes (four; Route is new)

| Mode | Mechanism | What runs |
|---|---|---|
| **Ingest** | Claude Code `SessionEnd`/`Stop` → `harnessgap ingest --transcript $TRANSCRIPT_PATH`; Qwen `SessionEnd`; OpenCode `session.idle` | Adapter + Detector only. **Fail-open, async, size-capped** — never disrupts the agent session. |
| **Route** *(new)* | Claude Code `PreToolUse`/session-start; Qwen/OpenCode equivalents | Router: inject relevant doc/pointer into context. Cheap, local, fail-open. |
| **/reflect** | `/reflect [hint]` as Claude Code command + plugin, OpenCode command, Qwen custom command | Detector + Diagnoser + Synthesizer on the *current* session, human hint as extra evidence. **Async** — writes proposals to disk and notifies; does not block the session. |
| **Batch** | `harnessgap scan [--since 30d] [--all-agents]` | Walks every adapter's storage, ingests unseen sessions, prints the ranked leaderboard: `unit · sessions flagged · top signals · diagnosed cause · proposed action`. Codex is covered here (no hooks). |

`harnessgap init <agent>` installs the right hook/command/plugin files for each agent. Onboarding is
`npm i -g harnessgap && harnessgap init claude`, or committed repo-local config
(`.claude/settings.json` hooks, `.opencode/plugin/harnessgap.ts`, `.qwen/settings.json`) so the whole
team gets it via git pull. The Claude Code plugin bundles (or gracefully prompts for) the CLI — it
must not assume a global npm install.

## 6. Repo & config layout

```
your-repo/
├── .harnessgap.yml            # thresholds, docs dirs, synthesizer backend, router, area/task rules  (committed)
├── .harnessgap/               # local state; .gitignore: ".harnessgap/" + "!.harnessgap/team/"
│   ├── queue/                 # candidate gaps + proposals in flight
│   ├── metrics.jsonl          # local per-session/unit metrics
│   ├── seen-sessions          # idempotency index
│   └── team/                  # COMMITTED (the gitignore exception above)
│       └── struggle.jsonl     # aggregated, scrubbed team recurrence
├── docs/
│   ├── _proposals/            # synthesized candidates awaiting review
│   ├── architecture/          # area docs
│   ├── workflows/             # task docs (now actually producible)
│   └── gotchas/
├── CLAUDE.md / AGENTS.md      # static fallback index block
```

```yaml
# .harnessgap.yml
docs_dirs:
  architecture: "how a module is wired"
  workflows:    "how to accomplish a recurring task"
  gotchas:      "non-obvious traps"
synthesizer: { backend: "claude -p", model: default, structure_only: false }  # structure_only strips file bodies for paranoid users
detector:
  thresholds_as: percentile        # v2 default; absolute values still allowed
  flag_pct: 90                     # top 10% of sessions for this repo
  reread_threshold: 3
  recurrence: { sessions: 3, window_days: 30, across_team: true }
router:
  mode: pointer                    # pointer (default) | full_injection
  full_injection_above_pct: 97     # opt-in auto-escalation for worst units
areas:  { cluster: path_prefix, ignore: [node_modules, build, target] }
tasks:  { fingerprints: canonical }  # v1; embeddings later
repo:   { canonical_docs: [CLAUDE.md, AGENTS.md, docs/architecture/overview.md, CONTRIBUTING.md] }  # structural-absence checklist for the repo unit
```

## 7. Calibration & testing

- **Labeled fixture corpus.** Anonymized real transcripts tagged struggled/didn't are (a) the
  detector/diagnoser regression test suite and (b) the seed for percentile thresholds when a repo's
  own history is thin. Build once, use twice.
- **`harnessgap calibrate`** is a *reporting* command ("here are your repo's percentiles and what
  they currently flag"), not a prerequisite — percentiles make startup self-calibrating.

## 8. Privacy model

- **Detection** — pure local heuristics; transcripts never leave the machine; **secret-scrubbed
  before persistence**.
- **Synthesis** — goes through the *same* agent CLI and account the code already flows through
  (`claude -p` under the enterprise plan) — no new vendor. **Honest qualification (new):** for an
  OSS user without a paid plan this still sends source to the model provider; a `structure_only`
  mode strips file bodies and sends evidence + an AST skeleton for the privacy-sensitive.
- **Proposals** are human-reviewed before entering the repo; frontmatter embeds session IDs only.
- **Team recurrence** (`.harnessgap/team/struggle.jsonl`) is scrubbed aggregates — no transcript
  text, no file contents, anonymized author counts.

## 9. Packaging & language

- **Single CLI, npm-distributed** (`npx harnessgap`) — TypeScript. Rationale: every target agent's
  user base already has Node; OpenCode plugins are TS; hook scripts shell out to the same binary.
  **Strongly consider Bun** for a single distributable binary — the `brew install` story matters for
  a CLI and removes the runtime-version friction TS-on-Node imposes.
- Additionally packaged as a **Claude Code plugin** (marketplace entry bundling hooks + `/reflect` +
  Router + skill) that wraps the CLI — the discovery channel for the largest audience. The plugin
  **bundles or gracefully installs** the CLI; it must not assume a global npm install.
- License: MIT/Apache-2. No telemetry. All data stays local unless the team opts into the committed
  `struggle.jsonl`.

## 10. Roadmap

**Phase 1 — the personal loop (2–3 weekends)**
Claude Code adapter (scrubbed, versioned, size-capped) → dual-unit Detector (percentile thresholds
+ oscillation + wall-clock) → Diagnoser (typed cause) → schema'd Synthesizer (dedupe + fact-check)
→ proposals + `harnessgap review`. **Instrument doc-read consumption from day one** (it is nearly
free — just another detector signal) so Measurement has data the moment routing lands.
*Dogfood calibration test: does the leaderboard + diagnosed causes match your gut?*

**Phase 2 — routing + measurement + team**
Router (active injection, pointer default), `harnessgap stats` read-vs-not-read deltas, shared
git-committed `.harnessgap/team/struggle.jsonl`, `harnessgap init` installers for Codex + OpenCode,
dedupe-via-embeddings upgrade.

**Phase 3 — evidence & polish**
Dashboards (both before/after *and* read-vs-not-read, with confidence bands), staleness checks,
Qwen Code support, Claude Code plugin packaging, public release with a writeup
("systematizing harness engineering") that **leads with the closed loop as the moat** — the writeup
*is* the distribution strategy for the technique itself.

## 11. Success criterion

In the dogfood repo, within one quarter: harnessgap surfaces **≥8 diagnosed harness gaps** across
**≥3 units**, spanning at least two cause types; addressing the `doc`/`config-doc` ones yields a
**measurable read-vs-not-read struggle delta** (target: ≥25% lower explore-ratio in consulting vs.
non-consulting sessions) in those units. Without a crisp target, the project drifts.

## 12. Open questions

1. **Task fingerprinting quality** — how many canonical workflow shapes before embeddings are warranted?
2. **Router aggressiveness** — pointer-default is conservative; measure when full injection actually pays.
3. **Diagnoser accuracy** — rule-based vs LLM; track false-cause rates against the fixture corpus.
4. **Team `struggle.jsonl` norms** — what is safe to commit? author anonymization? opt-in per teammate?
5. **Attribution confounds** — read-vs-not-read still has task-mix/self-selection bias; how prominently to surface confidence.
6. **Area clustering** — path-prefix will mis-cluster monorepos; import-graph/embeddings in v2.
7. **Subagent transcripts** — `agent_transcript_path` exposes subagent struggle (real but noisier); phase 3.
8. **Multi-repo aggregation** — shared store (repo? object storage?) once single-repo + team work.
9. **Repo-unit calibration** — every fresh repo lacks canonical docs, so the `repo` unit fires
   immediately; it must self-suppress once they exist and avoid nagging intentionally-lightweight repos.

## TL;DR

harnessgap (renamed from docgap) is a **closed feedback loop** for agent harness quality. It
**detects** struggle across **area + task** units (plus a `repo` unit for ambient pain) with
**percentile** thresholds and new oscillation/wall-clock/**expensive-success** signals; **diagnoses** the cause (`doc | config-doc | refactor-flag | test-gap
| inherent-complexity`) so it stops manufacturing docs for code/test/env problems; **synthesizes**
schema'd, **dedupe-first**, **fact-checked** proposals; **routes** the right knowledge into context
at need via a new **Router** (pointer default, full-injection opt-in); and **measures** impact as a
**read-vs-not-read struggle delta** with team recurrence via a committed `struggle.jsonl`. v0.1's
four structural holes — passive value chain, recurrence-as-verdict, single unit, deferred
team signal — are each closed. The moat is the loop + the labeled corpus, not the code.
