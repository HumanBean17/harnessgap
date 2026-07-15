// Stateless scan pipeline — the thin I/O shell that orchestrates walk → stream
// → resolve-main-repo → relativize → detect → aggregate → output. All pure
// logic lives in the modules it composes; this file threads them together,
// applies filters, and branches the output form. No disk writes, no network.
// Async only because streamSession is async (repo resolution is now stat-based).
//
// Filter / mode / output-branching choices (documented here, pinned to the
// task-16 brief + resolution notes):
//
// - repo resolution: `resolveMainRepo` walks up from a session cwd to the
//   nearest directory `.git` (the main repo; worktrees only hold a `.git`
//   file). Every session's repo is normalized to its MAIN repo root, so a
//   project's main checkout and all its worktrees share one repo value and
//   aggregate together. The session's full `cwds` list is tried in order, so a
//   session whose representative cwd was a since-deleted worktree still resolves
//   via an ancestor.
// - repo filter: `opts.repo` (or process.cwd()'s main repo when unset) is itself
//   normalized through `resolveMainRepo`, so `--repo <worktree>` or
//   `--repo <subdir>` matches the whole project.
// - mode when no records: "bootstrap" (consistent with scoreSessions: 0 sessions
//   < bootstrap_session_floor → bootstrap).
// - repo for output: the filtered repo (opts.repo, or the resolved process.cwd()
//   repo, or "" if neither resolves).
// - --since: parseDuration(opts.since) → ms (Infinity → no filter). Filter:
//   Date.parse(started_at) >= now − sinceMs. Empty/unparseable started_at →
//   excluded (can't date it).
// - --limit: applied AFTER all filtering. Negative limits are ignored.
// - empty / unresolvable cwd: counted ONLY under `unresolvable_cwd` (the
//   specific reason), not double-counted under `skipped_sessions`.
// - ConfigError from loadConfig / parseDuration is NOT caught here — it
//   propagates to the CLI for non-zero exit. runScan's exitCode is always 0.

import { loadConfig, parseDuration } from './config.js';
import { discoverTranscripts, defaultClaudeDir } from './walk.js';
import { streamSession } from './adapter/stream.js';
import { resolveMainRepo } from './git.js';
import { relativizeEnvelopeFiles } from './relativize.js';
import { runDetector } from './detector/index.js';
import { aggregateAreas } from './aggregate/leaderboard.js';
import { buildJsonEnvelope } from './output/json.js';
import { formatHuman } from './output/human.js';
import { buildCalibrateObject, formatCalibrateTable } from './output/calibrate.js';
import { buildReflectFinding, formatStopHookOutput } from './output/hook.js';
import type {
  Config,
  NormalizedEnvelope,
  ReflectFinding,
  ScoringMode,
  StruggleRecord,
  Warnings,
} from './types.js';

export interface ScanOptions {
  repo?: string;
  since?: string;
  limit?: number;
  json?: boolean;
  calibrate?: boolean;
  bootstrap?: boolean;
  configPath?: string;
  claudeDir?: string;
}

export interface ScanResult {
  output: string;
  mode: ScoringMode;
  sessionCount: number;
  warnings: Warnings;
  exitCode: 0 | 1;
}

/**
 * Orchestrate the full harnessgap scan. Async (awaits streamSession +
 * resolveToplevel). Returns the output string, mode, session count, aggregated
 * warnings, and exitCode (always 0 — misconfig throws propagate to the CLI).
 */
export async function runScan(opts: ScanOptions): Promise<ScanResult> {
  // 1. Load config (ConfigError propagates — not caught here).
  const cfg = loadConfig(opts.configPath);

  // 2. Discover transcripts.
  const claudeDir = opts.claudeDir ?? defaultClaudeDir();
  const { files, symlinks_rejected } = discoverTranscripts(claudeDir);

  const warnings: Warnings = {
    malformed_lines: 0,
    oversized_lines: 0,
    skipped_sessions: 0,
    truncated_sessions: 0,
    symlinks_rejected,
    unresolvable_cwd: 0,
  };

  // 3. Stream each file, resolve repo, accumulate warnings. Thread a single
  //    git-cache across all sessions (cwd repeats are common across transcripts).
  const cache = new Map<string, string | null>();
  const envelopes: NormalizedEnvelope[] = [];

  for (const file of files) {
    const { envelope, cwds, warnings: streamWarnings } = await streamSession(file);
    warnings.malformed_lines += streamWarnings.malformed_lines;
    warnings.oversized_lines += streamWarnings.oversized_lines;
    warnings.truncated_sessions += streamWarnings.truncated_sessions;

    // No cwd at all → can't resolve a repo. Count under unresolvable_cwd only
    // (not double-counted under skipped_sessions).
    if (cwds.length === 0) {
      warnings.unresolvable_cwd += 1;
      continue;
    }

    // Try each distinct cwd in order until one resolves to a main repo. The
    // representative cwd is first; if it was a since-deleted worktree, a later
    // cwd (or the walk-up from the first) usually still finds the main repo.
    let repo: string | null = null;
    for (const c of cwds) {
      repo = resolveMainRepo(c, cache);
      if (repo !== null) break;
    }
    if (repo === null) {
      warnings.unresolvable_cwd += 1;
      continue;
    }

    envelope.repo = repo;
    // Now that the main repo is known, rewrite file paths to canonical
    // repo-relative form (strips the repo prefix + collapses worktree checkout
    // prefixes) so areas are real code areas, not filesystem paths.
    relativizeEnvelopeFiles(envelope, repo);
    envelopes.push(envelope);
  }

  // 4. Filter by repo. Normalize the filter through resolveMainRepo too, so
  //    `--repo <worktree>` or `--repo <subdir>` resolves to the project's main
  //    repo and matches every session in it (main + worktrees).
  let filterRepo: string;
  if (opts.repo !== undefined) {
    filterRepo = resolveMainRepo(opts.repo, cache) ?? '';
  } else {
    filterRepo = resolveMainRepo(process.cwd(), cache) ?? '';
  }

  let filtered: NormalizedEnvelope[];
  if (filterRepo !== '') {
    filtered = envelopes.filter((e) => e.repo === filterRepo);
  } else {
    // process.cwd() didn't resolve and no opts.repo — keep all envelopes with
    // a non-empty repo.
    filtered = envelopes.filter((e) => e.repo !== '');
  }

  // 5. Apply --since (filter by started_at ≥ now − duration).
  if (opts.since !== undefined) {
    const sinceMs = parseDuration(opts.since);
    if (sinceMs !== Infinity) {
      const cutoff = Date.now() - sinceMs;
      filtered = filtered.filter((e) => {
        if (e.started_at === '') return false;
        const t = Date.parse(e.started_at);
        return !Number.isNaN(t) && t >= cutoff;
      });
    }
  }

  // Apply --limit (cap count, AFTER all filtering).
  if (opts.limit !== undefined && opts.limit >= 0) {
    filtered = filtered.slice(0, opts.limit);
  }

  // 6. Run detector.
  const forceBootstrap = opts.bootstrap ?? false;
  const records = runDetector(filtered, cfg, forceBootstrap);

  // 7. Aggregate areas.
  const { rows, summary } = aggregateAreas(records, cfg);

  // 8. Determine mode (consistent across all records; default bootstrap when
  //    no records — matches scoreSessions' selectMode for n=0).
  const mode: ScoringMode = records.length > 0 ? records[0]!.mode : 'bootstrap';

  // repo for output: the repo envelopes were filtered to (or "" if none).
  const outputRepo = filterRepo;

  // 9. Build output — branch by --calibrate / --json / human.
  let output: string;
  if (opts.calibrate) {
    const calObj = buildCalibrateObject({
      mode,
      session_count: records.length,
      flag_pct: cfg.detector.flag_pct,
      signals: records.map((r) => r.signals),
      bootstrap_thresholds: cfg.detector.bootstrap_thresholds,
    });
    output = opts.json ? JSON.stringify(calObj) : formatCalibrateTable(calObj);
  } else if (opts.json) {
    output = JSON.stringify(
      buildJsonEnvelope({
        repo: outputRepo,
        mode,
        session_count: records.length,
        warnings,
        sessions: records,
        areas: rows,
      }),
    );
  } else {
    output = formatHuman({
      repo: outputRepo,
      mode,
      sessionCount: records.length,
      areas: rows,
      summary,
      warnings,
    });
  }

  return {
    output,
    mode,
    sessionCount: records.length,
    warnings,
    exitCode: 0,
  };
}

// --- runReflect: session-end n=1 detection (--transcript / --latest) -------
//
// The single-session analog of runScan. Composes the same stages (stream →
// resolve-main-repo → relativize → detect) for ONE session and renders a
// `ReflectFinding` (json) or the Claude Code `Stop` hook payload (hook-stop).
// Two resolution modes feed one shared detect+format step:
//  - --transcript <path>: stream one given file (the per-stop hook path — cheap).
//  - --latest --repo: discover every transcript under claudeDir, keep those
//    whose main repo === targetRepo, drop --exclude-session, pick the
//    max-started_at one (the manual path — same order of cost as scan).
// Fail-open throughout: streaming/resolution failures, and a --latest that finds
// nothing, degrade to a trip:false finding (the hook-stop formatter yields `{}`);
// only `loadConfig`/arg errors throw.

export interface ReflectOptions {
  transcript?: string;
  latest?: boolean;
  repo?: string;
  excludeSession?: string;
  stopHookActive?: boolean;
  format?: 'json' | 'hook-stop';
  configPath?: string;
  claudeDir?: string;
}

export interface ReflectResult {
  output: string;
  /** Always 0 — the CLI/wrapper own user-facing failure. */
  exitCode: 0;
}

/**
 * Orchestrate single-session reflect. Resolves one transcript, runs the n=1
 * detector (forceBootstrap), and returns the formatted output string. Async
 * (awaits streamSession). Never throws for streaming/resolution failures —
 * degrades to a trip:false finding; only `loadConfig`/arg errors throw.
 */
export async function runReflect(opts: ReflectOptions): Promise<ReflectResult> {
  // 1. Load config (ConfigError propagates — not caught here).
  const cfg = loadConfig(opts.configPath);

  // One git-cache threaded across every resolution in this call (mirrors
  // runScan): repo lookups repeat across transcripts and the target filter.
  const cache = new Map<string, string | null>();

  // 2. Resolve the single envelope to reflect on. --transcript wins (the
  //    per-stop hook path — cheap, one file); --latest discovers the most-recent
  //    session for the repo; neither → nothing to reflect on.
  let envelope: NormalizedEnvelope | null;
  let cwds: string[];
  if (opts.transcript !== undefined) {
    const streamed = await streamSession(opts.transcript);
    envelope = streamed.envelope;
    cwds = streamed.cwds;
  } else if (opts.latest) {
    const picked = await pickLatestEnvelope(opts, cache);
    envelope = picked.envelope;
    cwds = picked.cwds;
  } else {
    throw new Error(
      'runReflect: a transcript path is required (pass --transcript <path>)',
    );
  }

  // 3. Detect + build the finding (shared by both resolution modes), then
  //    format. Fail-open: a null envelope (--latest found nothing) or an
  //    unresolvable repo yields a trip:false finding, which the hook-stop
  //    formatter renders as `{}`.
  const finding = buildFindingFromEnvelope(envelope, cwds, cfg, cache);

  let output: string;
  if (opts.format === 'hook-stop') {
    output = JSON.stringify(
      formatStopHookOutput(finding, opts.stopHookActive ?? false),
    );
  } else {
    output = JSON.stringify(finding);
  }

  return { output, exitCode: 0 };
}

/**
 * --latest resolution: discover every transcript under claudeDir, keep those
 * whose main repo === targetRepo, drop the running session (--exclude-session),
 * and return the one with the maximum `Date.parse(started_at)`. Async (streams
 * every file). Returns a null envelope when nothing matches (the caller degrades
 * to a trip:false finding). Streams every transcript for the repo (same order of
 * cost as scan) — acceptable for the on-demand manual path; the per-stop hook
 * uses --transcript and never pays this.
 */
async function pickLatestEnvelope(
  opts: ReflectOptions,
  cache: Map<string, string | null>,
): Promise<{ envelope: NormalizedEnvelope | null; cwds: string[] }> {
  // targetRepo: normalize the filter through the resolver (like runScan) so
  // --repo <worktree> or --repo <subdir> matches the whole project. null when
  // neither opts.repo nor process.cwd() resolves → nothing can match.
  const targetRepo = resolveMainRepo(opts.repo ?? process.cwd(), cache);

  const claudeDir = opts.claudeDir ?? defaultClaudeDir();
  const { files } = discoverTranscripts(claudeDir);

  // discoverTranscripts sorts lexicographically (NOT by recency), so max
  // started_at is selected here; on ties the first-seen (smallest path) wins.
  let best:
    | { envelope: NormalizedEnvelope; cwds: string[]; repo: string; started: number }
    | null = null;

  for (const file of files) {
    const { envelope, cwds } = await streamSession(file);

    // Resolve this session's main repo (try each cwd in order, like runScan).
    let repo: string | null = null;
    for (const c of cwds) {
      repo = resolveMainRepo(c, cache);
      if (repo !== null) break;
    }
    if (repo === null) continue; // unresolvable cwd → can't match
    if (repo !== targetRepo) continue; // different project → skip

    // Exclude the running session when requested.
    if (
      opts.excludeSession !== undefined &&
      envelope.session_id === opts.excludeSession
    ) {
      continue;
    }

    // Need a parseable started_at to rank by recency; otherwise skip.
    if (envelope.started_at === '') continue;
    const started = Date.parse(envelope.started_at);
    if (Number.isNaN(started)) continue;

    if (best === null || started > best.started) {
      best = { envelope, cwds, repo, started };
    }
  }

  if (best === null) return { envelope: null, cwds: [] };

  // Stamp the resolved repo so buildFindingFromEnvelope reuses it (no
  // re-resolution, no re-stream — the envelope is already in hand).
  best.envelope.repo = best.repo;
  return { envelope: best.envelope, cwds: best.cwds };
}

/**
 * Shared detect+build step for both resolution modes. Given the streamed
 * envelope (or null when --latest found nothing): resolve its main repo if not
 * already stamped, run the n=1 detector (forceBootstrap), and build the
 * ReflectFinding. Fail-open: a null envelope or an unresolvable cwd yields a
 * degenerate trip:false finding.
 */
function buildFindingFromEnvelope(
  envelope: NormalizedEnvelope | null,
  cwds: string[],
  cfg: Config,
  cache: Map<string, string | null>,
): ReflectFinding {
  // --latest found no session for the repo → safe trip:false stub.
  if (envelope === null) {
    return buildReflectFinding({
      record: degenerateRecord(emptyEnvelope()),
      zero_edit: true,
    });
  }

  const zero_edit = !envelope.events.some(
    (e) => e.kind === 'tool_call' && e.tool === 'edit',
  );

  // Resolve the main repo if not already stamped (--latest stamps it during
  // discovery; --transcript resolves here from cwds). Mirror runScan: try each
  // cwd in order, thread the cache. No resolvable cwd → degenerate stub.
  let repo = envelope.repo;
  if (repo === '') {
    for (const c of cwds) {
      const r = resolveMainRepo(c, cache);
      if (r !== null) {
        repo = r;
        break;
      }
    }
  }

  if (repo === '') {
    return buildReflectFinding({ record: degenerateRecord(envelope), zero_edit });
  }

  envelope.repo = repo;
  relativizeEnvelopeFiles(envelope, repo);
  const records = runDetector([envelope], cfg, true);
  const record = records[0] ?? degenerateRecord(envelope);
  return buildReflectFinding({ record, zero_edit });
}

/** Minimal empty envelope for the no-session fail-open path (no records). */
function emptyEnvelope(): NormalizedEnvelope {
  return {
    schema_version: 1,
    session_id: '',
    agent: 'claude-code',
    repo: '',
    started_at: '',
    duration_ms: 0,
    events: [],
    truncated: false,
    event_count: 0,
  };
}

/**
 * Build a degenerate `StruggleRecord` for the fail-open paths (no resolvable
 * repo, or no detector record). flagged=false so the resulting finding's
 * `trip` is false. Carries the envelope's identity fields; zeroes everything
 * else. No detection is run to produce it.
 */
function degenerateRecord(envelope: NormalizedEnvelope): StruggleRecord {
  return {
    session_id: envelope.session_id,
    repo: '',
    started_at: envelope.started_at,
    duration_ms: envelope.duration_ms,
    score_pct: 0,
    mode: 'bootstrap',
    flagged: false,
    truncated: envelope.truncated,
    event_count: envelope.event_count,
    areas: [],
    signals: {
      explore_ratio: null,
      reread: 0,
      failure_streak: 0,
      corrections: 0,
      abandonment: false,
      oscillation: 0,
      wall_clock_per_line_ms: null,
    },
  };
}
