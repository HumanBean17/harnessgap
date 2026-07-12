# docgap — turn agent struggle into team documentation

**Design doc, v0.1 — July 2026**

## 1. Problem

Experienced agent users develop an intuition: when the agent burns a lot of time exploring or
misunderstanding a part of the codebase, they write a small markdown file into
`docs/architecture/`, `docs/workflows/`, etc. Future sessions get measurably better.

The technique doesn't transfer, because it's packaged as a feeling:
*"self-reflect on your agentic sessions and improve the harness."* Teammates can't act on that.
Three things are missing:

1. **Detection** — a repeatable way to notice "the agent struggled here", instead of gut feeling.
2. **Synthesis** — a repeatable way to turn a struggle into a doc that actually helps.
3. **Evidence** — numbers showing the docs work, so adoption doesn't depend on trust in one person.

## 2. What exists already (and why it's not this)

| Prior art | What it does | Gap |
|---|---|---|
| `continuous-learning` (everything-claude-code) | Stop hook + `/learn` extract patterns into personal `~/.claude/skills/learned/` | Claude-Code-only, personal skills, no struggle detection, no metrics |
| `/wrap` session-wrap plugins | End-of-session pipeline proposing CLAUDE.md updates, TILs | Claude-Code-only, session-scoped, no cross-session recurrence analysis |
| `Learnings.md` pattern | Agent appends observations to a repo file | No detection, unbounded append-only file, no curation |
| claude-mem / Continuous-Claude | Personal memory layers over transcripts | Memory, not shareable team docs |

**Differentiation:** docgap is (a) agent-agnostic, (b) produces *repo-committed, PR-reviewed team
docs*, not personal memory, (c) driven by explicit struggle signals with evidence attached, and
(d) measures whether docs reduce struggle over time.

## 3. Core insight: recurrence is the filter

One painful session is noise — maybe the task was just hard. The distributable signal is:
**the same area of the codebase generating struggle across multiple sessions (and multiple
teammates)**. That is, by definition, a documentation gap.

So the unit of analysis is not "session" but **(repo area × time window)**, where an *area* is a
cluster of directories/modules the agent touched while struggling. This is what replaces
"my feelings" with something a team can adopt.

## 4. Architecture

```
                ┌────────────────────────────────────────────────┐
                │                    docgap CLI                  │
                │                                                │
 transcripts ──►│  Adapters ──► Normalized events ──► Detector   │──► candidates queue
 (per agent)    │                (common schema)      (heuristic)│    (.docgap/queue/)
                │                                                │
   /reflect ───►│  Synthesizer (LLM via claude -p, pluggable) ───│──► docs/_proposals/*.md
   hook/batch   │                                                │
                │  Curator (dedupe, index, PR flow)  ────────────│──► docs/** + PR
                │                                                │
                │  Metrics (per area, per session)  ─────────────│──► .docgap/metrics.jsonl
                └────────────────────────────────────────────────┘
```

Five components, strictly layered so each is useful alone.

### 4.1 Adapters — agent-agnostic ingestion

Every supported agent already writes machine-readable transcripts:

| Agent | Transcript location | Hooks? |
|---|---|---|
| Claude Code | `~/.claude/projects/<slug>/*.jsonl` (`transcript_path` in hook input) | Yes: `Stop`, `SessionEnd`, `PreCompact`, `PostToolUse` |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | No session-end hook → batch mode only (or shell wrapper) |
| OpenCode | local session storage; plugin API with `session.idle`, `tool.execute.after` events | Yes: TS plugins in `.opencode/plugin/` |
| Qwen Code | `.qwen` logs / checkpoints; hook events mirror Claude Code | Yes: `SessionEnd`, `Stop`, `PostToolUse(Failure)` in `.qwen/settings.json` |

Each adapter parses its native format into a **normalized event schema**:

```jsonc
{ "session_id": "...", "agent": "claude-code|codex|opencode|qwen",
  "repo": "/path", "started_at": "...", "events": [
    { "t": "...", "kind": "user_msg" | "assistant_msg" | "tool_call",
      "tool": "Read|Grep|Bash|Edit|...",           // normalized tool taxonomy
      "input_digest": {"files": [...], "cmd": "..."},
      "ok": true, "duration_ms": 1234, "tokens": {"in": 0, "out": 0} }
  ]}
```

Tool names are mapped into a small taxonomy: `read`, `search`, `list`, `edit`, `exec`,
`other`. That's all the detector needs, and it's what makes agent-agnosticism cheap.

**Fallback adapter:** for any future agent with hooks but awkward transcripts, ship a tiny
`docgap emit` hook command that appends normalized events directly. Adapters are the only
per-agent code in the system.

### 4.2 Detector — deterministic heuristics, no LLM

Runs locally, fast, on every ingested session. Proprietary code never leaves the machine at
this stage. Signals per session:

- **Exploration ratio** — `search+read+list` calls before the first `edit`; and total
  explore-calls per edited line.
- **Re-reads / re-greps** — same file read N≥3 times, or similar search patterns repeated
  (normalized-query Jaccard similarity).
- **Failure streaks** — consecutive non-zero-exit `exec` calls, same-command retries.
- **User corrections** — user messages matching correction shapes ("no,", "that's wrong",
  "actually", "не туда", interrupt events), especially shortly after assistant actions.
- **Context thrash** — compaction events (`PreCompact` count), token burn vs. diff size.
- **Abandonment** — session ends with explore-heavy tail and no edits.

Each flagged session yields a **struggle record**: score, evidence snippets (the specific
tool-call runs), and the **area** — top directories by touch-weight. Areas are clustered
across sessions (path-prefix clustering is enough for v1).

Thresholds live in `.docgap.yml` and default to conservative values; everything is tunable
because "struggle" differs per repo.

### 4.3 Synthesizer — LLM pass via the agent you already trust

Triggered when an area crosses the recurrence threshold (e.g., ≥3 flagged sessions in 30 days),
or manually. Default backend: `claude -p` headless under the same enterprise account — **no new
data path, no new vendor**. Pluggable: `codex exec`, `opencode run`, any command taking a prompt
on stdin.

Input to the LLM pass:
1. Evidence bundle: the struggle records for the area (what was searched, what failed, what the
   user corrected).
2. Existing docs inventory: file list + first heading of everything under `docs/`.
3. The repo files in the area (heads only, size-capped).

Output contract (enforced via prompt + schema check):
- **Either** a new doc proposal → `docs/_proposals/<area>-<slug>.md`,
- **or** an edit proposal against an existing doc (dedupe-first is mandatory),
- with frontmatter: `derived_from: [session ids]`, `area:`, `struggle_score:`,
  `source_files: [paths@commit]`, `created:`.

Doc style guide baked into the prompt: short (≤120 lines), answers "what an agent wastes time
discovering", not general prose. Structure: *what this is → how it's wired → gotchas →
where to look*. This encodes your empirical doc-writing taste as an explicit, shareable spec.

### 4.4 Curator — humans stay in the loop

- Nothing auto-commits. Proposals land in `docs/_proposals/`; `docgap review` opens an
  interactive accept/edit/reject flow, or `docgap pr` opens a branch + PR via `gh` so teammates
  review doc changes like code.
- **Discoverability is half the value**: a doc no agent routes to is dead weight. docgap
  maintains one generated index block (title + one-line "read this when...") inside
  `CLAUDE.md`, `AGENTS.md`, and `QWEN.md` between markers:
  `<!-- docgap:index:start -->…<!-- docgap:index:end -->`.
- **Staleness check**: each doc records `source_files@commit`. `docgap stale` flags docs whose
  source files have significantly changed since — the classic failure mode of doc-driven
  harnesses.

### 4.5 Metrics — the sales pitch (nice-to-have, phase 3)

Per-session, per-area records appended to `.docgap/metrics.jsonl` (gitignored; optionally
synced to a shared location for team aggregates):

- explore-calls-to-first-edit, tokens per edited line, failure-streak count, correction count.

`docgap stats --area src/billing` renders before/after timelines around the date a doc landed.
That chart — "exploration cost in the billing module dropped 40% after
`docs/architecture/billing.md` merged" — is the artifact that convinces a team, replacing
"trust my feelings."

Honest caveat surfaced in the README: this is observational, not an A/B test (task mix varies).
Recurrence + trend is still vastly better evidence than intuition.

## 5. Trigger modes (all three, independently toggleable)

| Mode | Mechanism | What runs |
|---|---|---|
| **Hook** | Claude Code `SessionEnd`/`Stop` → `docgap ingest --transcript $TRANSCRIPT_PATH`; Qwen `SessionEnd` hook; OpenCode plugin on `session.idle` | Adapter + detector only (fast, silent). Flags accumulate in the queue. |
| **Slash command** | `/reflect [hint]` shipped as Claude Code command + plugin, OpenCode command, Qwen custom command | Detector + synthesizer on the *current* session, with the human hint as extra evidence ("I saw it struggle with X"). Highest-signal path. |
| **Batch** | `docgap scan [--since 30d] [--all-agents]` | Walks every adapter's storage, ingests unseen sessions, prints the ranked doc-gap leaderboard: `area · sessions flagged · top signals · proposed action`. Codex is covered here despite having no hooks. |

`docgap init <agent>` installs the right hook/command/plugin files for each agent, so teammate
onboarding is: `npm i -g docgap && docgap init claude` (or committed repo-local config —
`.claude/settings.json` hooks, `.opencode/plugin/docgap.ts`, `.qwen/settings.json` — so the
whole team gets it via git pull).

## 6. Repo & config layout

```
your-repo/
├── .docgap.yml            # thresholds, docs dirs, synthesizer backend, area rules
├── .docgap/               # gitignored: queue/, metrics.jsonl, seen-sessions index
├── docs/
│   ├── _proposals/        # synthesized candidates awaiting review
│   ├── architecture/      # your existing habit, now systematized
│   └── workflows/
├── CLAUDE.md / AGENTS.md  # contain the generated docgap index block
```

```yaml
# .docgap.yml
docs_dirs: [docs/architecture, docs/workflows, docs/gotchas]
synthesizer: { backend: "claude -p", model: default }
detector:
  min_explore_ratio: 12      # explore calls before first edit
  reread_threshold: 3
  recurrence: { sessions: 3, window_days: 30 }
areas:
  cluster: path_prefix       # v1; embeddings later
  ignore: [node_modules, build, target]
```

## 7. Packaging & language

- **Single CLI, npm-distributed** (`npx docgap`) — TypeScript. Rationale: every target agent's
  user base already has Node; OpenCode plugins are TS anyway; hook scripts can shell out to the
  same binary. (Alternative: Python + uvx — fine, but adds a runtime assumption for OpenCode users.)
- Additionally packaged as a **Claude Code plugin** (marketplace entry bundling
  hooks + `/reflect` command + skill) that wraps the CLI — this is the discovery channel for
  the largest audience.
- License: MIT/Apache-2. No telemetry. All data stays local unless the team opts into a shared
  metrics location.

## 8. Privacy model

- Detection: pure local heuristics; transcripts never leave the machine.
- Synthesis: goes through the *same* agent CLI and account the code already flows through
  (`claude -p` under the enterprise plan) — introduces zero new data paths.
- Proposals are human-reviewed before entering the repo; frontmatter never embeds transcript
  text, only session IDs.

## 9. Roadmap

**Phase 1 — prove the loop (1–2 weekends)**
Claude Code adapter → normalized schema → detector → `docgap scan` leaderboard →
`/reflect` + synthesis via `claude -p` → proposals in `docs/_proposals/`.
*Dogfood on your enterprise repo: does the leaderboard match your gut? That's the calibration test.*

**Phase 2 — agent-agnostic + hooks**
Codex + OpenCode adapters, `docgap init` installers, SessionEnd/idle hook mode, dedupe-first
synthesis, index block generation, `docgap pr`.

**Phase 3 — evidence & polish**
Metrics + `docgap stats`, staleness checks, Qwen Code support, Claude Code plugin packaging,
public release with a writeup ("systematizing harness engineering") — the writeup *is* the
distribution strategy for the technique itself.

## 10. Open questions

1. **Area clustering quality** — path prefixes will mis-cluster monorepos with cross-cutting
   concerns; may need import-graph or embedding clustering in v2.
2. **Signal calibration** — thresholds that work for a Java enterprise monolith will differ from
   a small TS repo; ship a `docgap calibrate` that suggests thresholds from the repo's own
   session history.
3. **Doc type routing** — architecture vs. workflow vs. gotcha: let the synthesizer choose from
   the configured `docs_dirs` with per-dir descriptions, or keep a single inbox and let humans
   file? (v1: synthesizer chooses, human corrects in review.)
4. **Subagent transcripts** — Claude Code exposes `agent_transcript_path`; struggle inside
   subagents is real but noisier. Punt to phase 3.
5. **Multi-repo / team aggregation** — shared metrics store (a repo? object storage?) once
   single-repo works.
