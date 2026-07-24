# harnessgap

CLI that reads Claude Code, Qwen Code, and GigaCode transcripts
(`--harness <id>` selects; default `claude-code`), emits a struggle leaderboard
(repo areas with friction signals — rereads, failure streaks, oscillating edits,
abandonment), and optionally closes the loop on the top friction areas.

**Default path is stateless, detection-only:** `scan` / `reflect` write nothing,
hit no network, and never shell out — transcripts never leave the machine. Cause
attribution is opt-in via `scan --diagnose`.

**Opt-in closed loop (Phase 2 MVP):** `synthesize` → `review` → `explain` crosses
the write + subprocess boundary. `synthesize` writes new-doc proposals under
`docs/_proposals/` and shells out to the agent's own print-mode CLI
(`claude -p` / `qwen -p` / `gigacode -p`) to draft them — so derived evidence +
size-capped repo file-heads leave the machine via that trusted subprocess, not
via a network import in harnessgap (there are none). Every proposal is
fact-checked against HEAD and human-reviewed before it lands in `docs/`.

## Documentation

### Consumer

- [README.md](README.md) — install, flags, config, privacy
- [Consumer guide](docs/CONSUMER_GUIDE.md) — full manual: output formats, scoring, calibration, FAQ
- [Calibration](docs/CALIBRATION.md) — accepted-risk record (precision unvalidated; recall-substitute plan)

### Internal

- [Architecture](docs/ARCHITECTURE.md) — modules, pipeline, event schema, scoring, security
- [Closed-loop MVP spec](docs/superpowers/specs/active/2026-07-24-mvp-closed-loop-design.md) — synthesize / review / explain + deferred items
- [Detection spec (archived)](docs/superpowers/specs/archive/2026-07-12-harnessgap-detection-slice-design.md)
- [Detection plan (archived)](docs/superpowers/plans/archive/2026-07-12-harnessgap-detection-slice.md)

## Session end

- If the session touched `src/`, `test/`, or any `*.md` file, dispatch the
`docs-watcher` subagent with the list of changed files before ending. Skip
otherwise.
- Not a single follow up or deferred item should be just mentioned in the mid of the conversation and then die in it. This leads to re-explore or just re-discover same items again and again. If you have follow up or deferred item - open github issue or leave a note in design doc (if you're on a greenfield project and implementing a big design doc).
