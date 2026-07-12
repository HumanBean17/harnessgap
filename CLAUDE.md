# harnessgap

Stateless, detection-only CLI: reads Claude Code transcripts, emits a struggle
leaderboard (repo areas with friction signals — rereads, failure streaks,
oscillating edits, abandonment). Slice 1: no writes, no network.

## Documentation

### Consumer

- [README.md](README.md) — install, flags, config, privacy
- [Consumer guide](docs/CONSUMER_GUIDE.md) — full manual: output formats, scoring, calibration, FAQ

### Internal

- [Architecture](docs/ARCHITECTURE.md) — modules, pipeline, event schema, scoring, security
- [Spec](docs/superpowers/specs/active/2026-07-12-harnessgap-detection-slice-design.md)
- [Plan](docs/superpowers/plans/active/2026-07-12-harnessgap-detection-slice.md)

## Session end

If the session touched `src/`, `test/`, or any `*.md` file, dispatch the
`docs-watcher` subagent with the list of changed files before ending. Skip
otherwise.
