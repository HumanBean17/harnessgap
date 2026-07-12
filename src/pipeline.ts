// Stateless scan pipeline — the thin I/O shell that orchestrates walk → stream
// → git-resolve → detect → aggregate → output. All pure logic lives in the
// modules it composes; this file threads them together, applies filters, and
// branches the output form. No disk writes, no network. Async because
// streamSession and resolveToplevel are async.
//
// Filter / mode / output-branching choices (documented here, pinned to the
// task-16 brief + resolution notes):
//
// - repo filter when opts.repo is unset: resolve `resolveToplevel(process.cwd())`.
//   If it resolves, filter envelopes to that toplevel; if it does NOT resolve
//   (process.cwd() is not a repo), keep ALL envelopes with a non-empty repo.
// - mode when no records: "bootstrap" (consistent with scoreSessions: 0 sessions
//   < bootstrap_session_floor → bootstrap).
// - repo for output: the filtered repo (opts.repo, or the resolved process.cwd()
//   toplevel, or "" if neither resolves).
// - --since: parseDuration(opts.since) → ms (Infinity → no filter). Filter:
//   Date.parse(started_at) >= now − sinceMs. Empty/unparseable started_at →
//   excluded (can't date it).
// - --limit: applied AFTER all filtering. Negative limits are ignored.
// - empty cwd (streamSession returned cwd=''): treated as unresolvable
//   (unresolvable_cwd++, skipped) — resolveToplevel('') would wrongly resolve
//   process.cwd()'s repo.
// - ConfigError from loadConfig / parseDuration is NOT caught here — it
//   propagates to the CLI for non-zero exit. runScan's exitCode is always 0.

import { loadConfig, parseDuration } from './config.js';
import { discoverTranscripts, defaultClaudeDir } from './walk.js';
import { streamSession } from './adapter/stream.js';
import { resolveToplevel } from './git.js';
import { runDetector } from './detector/index.js';
import { aggregateAreas } from './aggregate/leaderboard.js';
import { buildJsonEnvelope } from './output/json.js';
import { formatHuman } from './output/human.js';
import { buildCalibrateObject, formatCalibrateTable } from './output/calibrate.js';
import type {
  NormalizedEnvelope,
  ScoringMode,
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
    const { envelope, cwd, warnings: streamWarnings } = await streamSession(file);
    warnings.malformed_lines += streamWarnings.malformed_lines;
    warnings.oversized_lines += streamWarnings.oversized_lines;
    warnings.truncated_sessions += streamWarnings.truncated_sessions;

    // Empty cwd → can't resolve a repo (resolveToplevel('') would resolve
    // process.cwd()'s repo, which is wrong). Skip as unresolvable.
    if (cwd === '') {
      warnings.unresolvable_cwd += 1;
      warnings.skipped_sessions += 1;
      continue;
    }

    const toplevel = await resolveToplevel(cwd, cache);
    if (!toplevel) {
      warnings.unresolvable_cwd += 1;
      warnings.skipped_sessions += 1;
      continue;
    }
    envelope.repo = toplevel;
    envelopes.push(envelope);
  }

  // 4. Filter by repo.
  let filterRepo: string;
  if (opts.repo !== undefined) {
    filterRepo = opts.repo;
  } else {
    const cwdToplevel = await resolveToplevel(process.cwd(), cache);
    filterRepo = cwdToplevel ?? '';
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
