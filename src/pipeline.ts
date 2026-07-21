// Stateless scan pipeline — the thin I/O shell that orchestrates walk → stream
// → resolve-main-repo → relativize → detect → aggregate → output. All pure
// logic lives in the modules it composes; this file threads them together,
// applies filters, and branches the output form. No disk writes, no network.
// Async only because streamSession is async (repo resolution is now stat-based).
//
// Filter / mode / output-branching choices (documented here, pinned to the
// task-16 brief + resolution notes):
//
// - repo resolution: `resolveRepo` walks up from a session cwd to the nearest
//   directory `.git` (the main repo; worktrees only hold a `.git` file). Every
//   session's repo is normalized to its MAIN repo root, so a project's main
//   checkout and all its worktrees share one repo value and aggregate together.
//   The session's full `cwds` list is tried in order, so a session whose
//   representative cwd was a since-deleted worktree still resolves via an
//   ancestor. Sibling worktrees (a since-deleted checkout that was a SIBLING of
//   the main repo, not nested under it) are recovered by reading candidate
//   siblings' `.git/worktrees/<name>/gitdir` registrations — see `src/git.ts`.
//   When that recovery fires, the resolver also returns the worktree CHECKOUT
//   root, which `relativizeEnvelopeFiles` strips so sibling-worktree file paths
//   collapse onto the main checkout's repo-relative areas (otherwise they are
//   absolute and outside the repo prefix, fragmenting the leaderboard).
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
//   specific reason), not double-counted under `skipped_sessions`. The count is
//   scoped to the requested repo when one resolved (sessions whose cwd lived
//   under it), else machine-wide — see the scoping note by `filterRepo`.
// - an explicit `--repo` that does not resolve throws `ConfigError` (issue #29):
//   never silently falls back to a machine-wide scan. ConfigError from
//   loadConfig / parseDuration / the bogus-`--repo` guard is NOT caught here —
//   it propagates to the CLI for non-zero exit. runScan's exitCode is always 0.

import { loadConfig, parseDuration, ConfigError } from './config.js';
import * as path from 'node:path';
import { openSync, readSync, closeSync } from 'node:fs';
import { resolveHarness, discoverForSpec } from './adapter/index.js';
import { resolveMainRepo, resolveRepo } from './git.js';
import type { RepoResolution } from './git.js';
import { relativizeEnvelopeFiles } from './relativize.js';
import { runDetector } from './detector/index.js';
import { aggregateAreas } from './aggregate/leaderboard.js';
import { diagnoseUnits } from './diagnoser/index.js';
import { buildJsonEnvelope } from './output/json.js';
import { formatHuman } from './output/human.js';
import { buildCalibrateObject, formatCalibrateTable } from './output/calibrate.js';
import { buildReflectFinding, formatStopHookOutput } from './output/hook.js';
import type {
  BaselineAssessment,
  Config,
  Diagnosis,
  HarnessId,
  HarnessSpec,
  NormalizedEnvelope,
  ReflectFinding,
  RepoFinding,
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
  /**
   * Slice 4 (Diagnoser): when true, collect per-session evidence in the detector
   * and run `diagnoseUnits` to produce `result.diagnoses`. When unset/false, the
   * detector skips evidence collection entirely and `result.diagnoses` is unset —
   * output stays byte-identical to Slice 3.
   */
  diagnose?: boolean;
  /**
   * Qwen+GigaCode slice Task 9: the resolved harness id (claude-code |
   * qwen-code | gigacode) the CLI wants the pipeline to dispatch through. The
   * CLI resolves this per the documented precedence (--harness flag →
   * config.harness → 'claude-code') BEFORE calling runScan; this field threads
   * the resolution through. Task 10 consumes it to pick the spec/streamSession.
   * When absent, runScan falls back to `config.harness` (itself defaulting to
   * 'claude-code'), so bare `harnessgap scan` is byte-identical to pre-slice
   * output.
   */
  harness?: HarnessId;
  /**
   * Qwen+GigaCode slice Task 9: the harness config directory to discover
   * transcripts under, when the user passed --harness-dir (or the equivalent
   * --claude-dir alias). Mirrors `claudeDir` for the new flag. Task 10 consumes
   * it via `discoverForSpec(spec, harnessDir ?? claudeDir)` — `harnessDir`
   * wins, the legacy `claudeDir` is the fallback so direct API callers
   * (tests, embeddings) that still pass `claudeDir` keep working unchanged.
   * When neither is set, the spec's defaultRootDir() applies.
   */
  harnessDir?: string;
}

export interface ScanResult {
  output: string;
  mode: ScoringMode;
  sessionCount: number;
  warnings: Warnings;
  exitCode: 0 | 1;
  /** Ambient repo-level finding (null unless baseline.state === 'elevated'). */
  finding: RepoFinding | null;
  /** Always-populated ambient baseline assessment. */
  baseline: BaselineAssessment;
  /**
   * Slice 4 (Diagnoser): one `Diagnosis` per flagged area. Populated ONLY under
   * `--diagnose`; unset otherwise so default output stays byte-identical to
   * Slice 3. Empty array when `--diagnose` is on but no areas are flagged, or
   * when the filtered repo root is unresolved (diagnosis is skipped).
   */
  diagnoses?: Diagnosis[];
}

/**
 * Orchestrate the full harnessgap scan. Async (awaits streamSession +
 * resolveToplevel). Returns the output string, mode, session count, aggregated
 * warnings, and exitCode (always 0 — misconfig throws propagate to the CLI).
 */
export async function runScan(opts: ScanOptions): Promise<ScanResult> {
  // 1. Load config (ConfigError propagates — not caught here).
  const cfg = loadConfig(opts.configPath);

  // 1b. Resolve the harness spec ONCE at the top — flag wins, else config
  //     (Task 8; defaults to 'claude-code' via DEFAULT_CONFIG), else the
  //     'claude-code' literal belt-and-suspenders (cfg.harness is typed as a
  //     required field but the belt keeps the contract if a future schema
  //     change makes it optional). The spec carries streamSession + layout
  //     so discovery and streaming both route through it. `cwd` is also
  //     surfaced on StreamResult but stays unused here (the pipeline resolves
  //     repos from the full `cwds` list so a since-deleted representative cwd
  //     does not lose the session).
  const harnessId: HarnessId = opts.harness ?? cfg.harness ?? 'claude-code';
  const spec = resolveHarness(harnessId);

  // 2. Discover transcripts via the spec — rootOverride is the unified dir
  //    resolution (harnessDir from --harness-dir, else the legacy claudeDir
  //    from --claude-dir). When neither is set, the spec's defaultRootDir()
  //    applies. This unifies the T9 dir-precedence minor at the pipeline layer
  //    (both flags' resolutions used to disagree in the CLI threading; now
  //    they collapse to harnessDir ?? claudeDir here, and the spec's layout
  //    decides the on-disk shape: chats/ subdir for qwen/gigacode, flat for
  //    claude).
  const rootOverride = opts.harnessDir ?? opts.claudeDir;
  const { files, symlinks_rejected } = discoverForSpec(spec, rootOverride);

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
  const cache = new Map<string, RepoResolution | null>();
  const envelopes: NormalizedEnvelope[] = [];
  // Sessions that could not be resolved to any repo, retained with their cwds so
  // `unresolvable_cwd` can be scoped to the requested repo after filtering (see
  // below). Not double-counted under skipped_sessions.
  const unresolved: { cwds: string[] }[] = [];

  for (const file of files) {
    const { envelope, cwds, warnings: streamWarnings } = await spec.streamSession(file);
    warnings.malformed_lines += streamWarnings.malformed_lines;
    warnings.oversized_lines += streamWarnings.oversized_lines;
    warnings.truncated_sessions += streamWarnings.truncated_sessions;

    // No cwd at all → can't resolve a repo. Stash for scoped counting below.
    if (cwds.length === 0) {
      unresolved.push({ cwds });
      continue;
    }

    // Try each distinct cwd in order until one resolves to a main repo. The
    // representative cwd is first; if it was a since-deleted worktree, a later
    // cwd (or the walk-up from the first) usually still finds the main repo.
    let repo: string | null = null;
    let checkoutRoot: string | null = null;
    for (const c of cwds) {
      const info = resolveRepo(c, cache);
      if (info !== null) {
        repo = info.repo;
        checkoutRoot = info.checkoutRoot; // set only for sibling-worktree recovery
        break;
      }
    }
    if (repo === null) {
      unresolved.push({ cwds });
      continue;
    }

    envelope.repo = repo;
    // Now that the main repo is known, rewrite file paths to canonical
    // repo-relative form (strips the repo prefix + collapses worktree checkout
    // prefixes, and strips a sibling-worktree checkout root) so areas are real
    // code areas, not filesystem paths.
    relativizeEnvelopeFiles(envelope, repo, checkoutRoot);
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

  // An explicit --repo that doesn't resolve (typo, stale path, deleted project,
  // non-git dir) is a user error — NOT a reason to fall back to a machine-wide
  // scan. Without this guard the `filterRepo === ''` fallthrough below would
  // silently mix every project's transcripts into one report (privacy +
  // correctness problem — see issue #29). Error loudly instead. The fallthrough
  // is reserved for "no --repo AND process.cwd() unresolved" (a genuine,
  // intentional machine-wide scan).
  if (opts.repo !== undefined && filterRepo === '') {
    throw new ConfigError(
      `--repo ${JSON.stringify(opts.repo)} does not resolve to a git repository`,
    );
  }

  // Scope `unresolvable_cwd` to the requested repo when one resolved: count only
  // sessions whose cwd lived UNDER that repo (e.g. a since-deleted nested
  // worktree). Sibling-worktree and other projects' unresolvable sessions are
  // out of scope — they never belonged to this repo by path, and recovering
  // them needs a naming heuristic the resolver deliberately avoids (issue #31:
  // the machine-wide count was being shown as if per-repo). With no repo context
  // (machine-wide scan, filterRepo === '') every unresolvable session is in scope.
  warnings.unresolvable_cwd =
    filterRepo === ''
      ? unresolved.length
      : unresolved.filter((s) => s.cwds.some((c) => isUnderRepo(c, filterRepo))).length;

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

  // 6. Run detector. Thread `collectEvidence` ONLY under --diagnose so the
  //    default path skips evidence work entirely (keeps StruggleRecord.evidence
  //    absent and scan output byte-identical to Slice 3).
  const forceBootstrap = opts.bootstrap ?? false;
  const { records, finding, baseline } = runDetector(filtered, cfg, forceBootstrap, {
    collectEvidence: opts.diagnose === true,
  });

  // 7. Aggregate areas.
  const { rows, summary } = aggregateAreas(records, cfg);

  // 8. Determine mode (consistent across all records; default bootstrap when
  //    no records — matches scoreSessions' selectMode for n=0).
  const mode: ScoringMode = records.length > 0 ? records[0]!.mode : 'bootstrap';

  // repo for output: the repo envelopes were filtered to (or "" if none).
  const outputRepo = filterRepo;

  // 7b. Diagnose (Slice 4). Run ONLY under --diagnose; populate `diagnoses`
  //     with one entry per flagged area (empty array when nothing is flagged).
  //     `diagnoseUnits` never throws (per-unit fail-open), so no try/catch here.
  //     When the filtered repo root is unresolved (`outputRepo === ''`), there
  //     is no repo to ground doc-existence lookups in — skip diagnosis and emit
  //     `[]` rather than running with an empty root.
  //     Default path (no --diagnose): `diagnoses` stays undefined and is spread
  //     into the result BELOW only when defined, so the default `ScanResult`
  //     shape matches Slice 3 exactly (key absent, not just undefined).
  let diagnoses: Diagnosis[] | undefined;
  if (opts.diagnose === true) {
    diagnoses = outputRepo !== '' ? diagnoseUnits(records, cfg, outputRepo) : [];
  }

  // 9. Build output — branch by --calibrate / --json / human.
  let output: string;
  if (opts.calibrate) {
    const calObj = buildCalibrateObject({
      mode,
      session_count: records.length,
      flag_pct: cfg.detector.flag_pct,
      signals: records.map((r) => r.signals),
      bootstrap_thresholds: cfg.detector.bootstrap_thresholds,
      baseline,
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
        repo_findings: finding ? [finding] : [],
        // Spread only when defined so the default `--json` envelope has NO
        // `diagnoses` key at all (byte-identical to Slice 3).
        ...(diagnoses !== undefined ? { diagnoses } : {}),
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
      baseline,
      finding,
      // Spread only when defined so the default human table has no CAUSE
      // column (byte-identical to Slice 3).
      ...(diagnoses !== undefined ? { diagnoses } : {}),
    });
  }

  // Spread `diagnoses` only when defined so the default-path `ScanResult` shape
  // matches Slice 3 exactly (key absent rather than `undefined`). When
  // `--diagnose` is on, the key is present — empty `[]` when nothing was flagged
  // or the repo root was unresolved.
  return {
    output,
    mode,
    sessionCount: records.length,
    warnings,
    exitCode: 0,
    finding,
    baseline,
    ...(diagnoses !== undefined ? { diagnoses } : {}),
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
  /**
   * Qwen+GigaCode slice Task 9/10: harness id + harness dir threaded from the
   * CLI (mirrors ScanOptions). Task 10 wires reflect dispatch through the spec
   * (discovery for --latest + streamSession for --transcript); the harness
   * resolution precedence matches runScan (flag → config → 'claude-code').
   */
  harness?: HarnessId;
  harnessDir?: string;
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

  // 1b. Resolve the harness spec ONCE at the top. Task 11 precedence:
  //       --harness flag → sniff(transcript) → 'claude-code' fallback.
  //     The sniff only fires for --transcript (the file is right there, so it
  //     is more authoritative than the config default). For --latest there is
  //     no single file in hand to sniff, so the Task-10 precedence is
  //     preserved (config → 'claude-code'). Config is NOT consulted for the
  //     --transcript path: the file's shape wins over a config-pinned
  //     default. `--harness <id>` always overrides the sniff.
  let harnessId: HarnessId;
  if (opts.harness !== undefined) {
    harnessId = opts.harness;
  } else if (opts.transcript !== undefined) {
    harnessId = sniffHarnessFromTranscript(opts.transcript) ?? 'claude-code';
  } else {
    // --latest without a flag: no file to sniff, preserve Task-10 precedence.
    // cfg.harness is always set (DEFAULT_CONFIG), the literal is belt-and-suspenders.
    harnessId = cfg.harness ?? 'claude-code';
  }
  const spec = resolveHarness(harnessId);

  // One git-cache threaded across every resolution in this call (mirrors
  // runScan): repo lookups repeat across transcripts and the target filter.
  const cache = new Map<string, RepoResolution | null>();

  // 2. Resolve the single envelope to reflect on. --transcript wins (the
  //    per-stop hook path — cheap, one file); --latest discovers the most-recent
  //    session for the repo; neither → nothing to reflect on.
  let envelope: NormalizedEnvelope | null;
  let cwds: string[];
  let stampedCheckoutRoot: string | null = null;
  if (opts.transcript !== undefined) {
    const streamed = await spec.streamSession(opts.transcript);
    envelope = streamed.envelope;
    cwds = streamed.cwds;
  } else if (opts.latest) {
    const picked = await pickLatestEnvelope(opts, spec, cache);
    envelope = picked.envelope;
    cwds = picked.cwds;
    stampedCheckoutRoot = picked.checkoutRoot;
  } else {
    throw new Error(
      'runReflect: a transcript path is required (pass --transcript <path>)',
    );
  }

  // 3. Detect + build the finding (shared by both resolution modes), then
  //    format. Fail-open: a null envelope (--latest found nothing) or an
  //    unresolvable repo yields a trip:false finding, which the hook-stop
  //    formatter renders as `{}`. The harnessId threads through to the
  //    degenerate empty-envelope stub so its agent stamp matches the resolved
  //    harness (no hardcoded 'claude-code' literal remains in this file).
  const finding = buildFindingFromEnvelope(envelope, cwds, cfg, cache, stampedCheckoutRoot, harnessId);

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
  spec: HarnessSpec,
  cache: Map<string, RepoResolution | null>,
): Promise<{ envelope: NormalizedEnvelope | null; cwds: string[]; checkoutRoot: string | null }> {
  // targetRepo: normalize the filter through the resolver (like runScan) so
  // --repo <worktree> or --repo <subdir> matches the whole project. null when
  // neither opts.repo nor process.cwd() resolves → nothing can match.
  const targetRepo = resolveMainRepo(opts.repo ?? process.cwd(), cache);

  // Discovery routes through the spec — same unified dir resolution as runScan
  // (harnessDir ?? claudeDir, else spec.defaultRootDir()). The spec's layout
  // selects chats/ vs flat.
  const rootOverride = opts.harnessDir ?? opts.claudeDir;
  const { files } = discoverForSpec(spec, rootOverride);

  // discoverForSpec sorts lexicographically (NOT by recency), so max
  // started_at is selected here; on ties the first-seen (smallest path) wins.
  let best:
    | { envelope: NormalizedEnvelope; cwds: string[]; repo: string; checkoutRoot: string | null; started: number }
    | null = null;

  for (const file of files) {
    const { envelope, cwds } = await spec.streamSession(file);

    // Resolve this session's main repo (try each cwd in order, like runScan).
    let repo: string | null = null;
    let checkoutRoot: string | null = null;
    for (const c of cwds) {
      const info = resolveRepo(c, cache);
      if (info !== null) {
        repo = info.repo;
        checkoutRoot = info.checkoutRoot;
        break;
      }
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
      best = { envelope, cwds, repo, checkoutRoot, started };
    }
  }

  if (best === null) return { envelope: null, cwds: [], checkoutRoot: null };

  // Stamp the resolved repo so buildFindingFromEnvelope reuses it (no
  // re-resolution, no re-stream — the envelope is already in hand).
  best.envelope.repo = best.repo;
  return { envelope: best.envelope, cwds: best.cwds, checkoutRoot: best.checkoutRoot };
}

/**
 * Shared detect+build step for both resolution modes. Given the streamed
 * envelope (or null when --latest found nothing): resolve its main repo if not
 * already stamped, run the n=1 detector (forceBootstrap), and build the
 * ReflectFinding. Fail-open: a null envelope, an unresolvable cwd, OR a thrown
 * error from the guarded detect step all yield a degenerate trip:false finding.
 */
function buildFindingFromEnvelope(
  envelope: NormalizedEnvelope | null,
  cwds: string[],
  cfg: Config,
  cache: Map<string, RepoResolution | null>,
  stampedCheckoutRoot: string | null = null,
  harnessId: HarnessId = 'claude-code',
): ReflectFinding {
  // --latest found no session for the repo → safe trip:false stub.
  if (envelope === null) {
    return buildReflectFinding({
      record: degenerateRecord(emptyEnvelope(harnessId)),
      zero_edit: true,
      agent: harnessId,
    });
  }

  const zero_edit = !envelope.events.some(
    (e) => e.kind === 'tool_call' && e.tool === 'edit',
  );

  // Resolve the main repo if not already stamped (--latest stamps it during
  // discovery; --transcript resolves here from cwds). Mirror runScan: try each
  // cwd in order, thread the cache. No resolvable cwd → degenerate stub.
  let repo = envelope.repo;
  let checkoutRoot = stampedCheckoutRoot;
  if (repo === '') {
    for (const c of cwds) {
      const info = resolveRepo(c, cache);
      if (info !== null) {
        repo = info.repo;
        checkoutRoot = info.checkoutRoot;
        break;
      }
    }
  }

  if (repo === '') {
    return buildReflectFinding({ record: degenerateRecord(envelope), zero_edit, agent: harnessId });
  }

  // Detect step is guarded: a throw from relativize/detect (latent today — both
  // are pure over current inputs) must fail open to a trip:false finding so the
  // Claude Code Stop hook still receives `{}` instead of a thrown rejection.
  // Degrade identically to the unresolvable-repo branch above (flagged:false
  // → trip:false). Shared by --transcript and --latest, so both modes are covered.
  try {
    envelope.repo = repo;
    relativizeEnvelopeFiles(envelope, repo, checkoutRoot);
    const { records } = runDetector([envelope], cfg, true);
    const record = records[0] ?? degenerateRecord(envelope);
    return buildReflectFinding({ record, zero_edit, agent: harnessId });
  } catch {
    return buildReflectFinding({ record: degenerateRecord(envelope), zero_edit, agent: harnessId });
  }
}

/**
 * Minimal empty envelope for the no-session fail-open path (no records). The
 * `harnessId` parameter threads the resolved harness through so the envelope's
 * agent stamp matches the harness the user asked reflect to use (no hardcoded
 * 'claude-code' literal — the spec's streamSession already stamps agent on
 * real envelopes, and this stub mirrors that contract for the degenerate path).
 */
function emptyEnvelope(harnessId: HarnessId = 'claude-code'): NormalizedEnvelope {
  return {
    schema_version: 1,
    session_id: '',
    agent: harnessId,
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

/**
 * True iff `cwd` lives under `repo` (i.e. `repo` is an ancestor directory).
 * Best-effort string check (no symlink resolution) — `repo` is already
 * canonical from the resolver, and a nested deleted-worktree cwd shares the
 * same on-disk ancestor prefix in the common case. Used only to scope the
 * `unresolvable_cwd` warnings count, so a miss merely under-counts a warning.
 */
function isUnderRepo(cwd: string, repo: string): boolean {
  if (cwd === '' || repo === '') return false;
  return path.resolve(cwd).startsWith(repo + '/');
}

// --- Task 11: harness shape sniff -------------------------------------------
//
// Cheap read-only shape detection on a transcript file. The first parseable
// non-empty line that carries a harness discriminator identifies the harness:
//
//   - Qwen signal (any of):
//       * top-level `type:'tool_result'`          (Qwen record kind)
//       * top-level `subtype:'ui_telemetry'`      (Qwen system record)
//       * `message.parts` (array) with a part that has `functionCall`
//   - Claude signal:
//       * `message.content` (array) with an item whose `type` is `'tool_use'`
//         or `'text'`
//
// `gigacode` is indistinguishable from `qwen-code` by content (the parser is
// shared), so a qwen-shaped file resolves to `'qwen-code'`. `--harness
// gigacode` overrides the sniff to stamp `agent:'gigacode'`.
//
// Iterates up to MAX_SNIFF_LINES non-empty lines so a transcript whose first
// record is plain user text (no discriminator on either side) still resolves
// once an assistant tool call appears a few lines in. Bounded — never slurps
// the whole file. Reads at most SNIFF_BYTE_CAP bytes from the start. Fail-open
// throughout: file-missing, empty, all-malformed, or no-discriminator → null
// (the caller falls back to 'claude-code' or whatever its precedence dictates).
// Never throws.

const MAX_SNIFF_LINES = 10;
const SNIFF_BYTE_CAP = 256 * 1024; // 256 KB — ample for 10+ records.

/**
 * Read-only sniff of a transcript file's first parseable lines to identify
 * the harness shape. Returns `'qwen-code'` for gemini/qwen-shaped records,
 * `'claude-code'` for claude-shaped records, or `null` if no scanned line
 * carries a discriminator (empty/unparseable/ambiguous file). Never throws.
 */
function sniffHarnessFromTranscript(filePath: string): 'qwen-code' | 'claude-code' | null {
  let raw: string;
  try {
    const fd = openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(SNIFF_BYTE_CAP);
      const bytes = readSync(fd, buf, 0, buf.length, 0);
      raw = buf.subarray(0, bytes).toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return null; // missing / unreadable → fail open
  }

  let scanned = 0;
  for (const line of raw.split('\n')) {
    if (scanned >= MAX_SNIFF_LINES) break;
    const trimmed = line.trim();
    if (trimmed === '') continue;
    scanned++;
    let rec: unknown;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue; // malformed line → skip, keep scanning
    }
    const verdict = classifyRecordShape(rec);
    if (verdict !== null) return verdict;
  }
  return null;
}

/**
 * Pure shape classifier for one parsed JSONL record. Returns `'qwen-code'` if
 * the record carries a Qwen-only discriminator, `'claude-code'` if it carries
 * a Claude-only discriminator, or `null` if the record is ambiguous (e.g. a
 * plain user-text record whose shape is shared across harnesses). Never
 * throws — bad input is treated as ambiguous.
 */
function classifyRecordShape(rec: unknown): 'qwen-code' | 'claude-code' | null {
  if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) return null;
  const r = rec as Record<string, unknown>;

  // Top-level Qwen-only discriminators.
  if (r['type'] === 'tool_result') return 'qwen-code';
  if (r['subtype'] === 'ui_telemetry') return 'qwen-code';

  const msg = r['message'];
  if (msg !== null && typeof msg === 'object' && !Array.isArray(msg)) {
    const m = msg as Record<string, unknown>;

    // Qwen: message.parts with a functionCall part.
    const parts = m['parts'];
    if (Array.isArray(parts)) {
      for (const p of parts) {
        if (
          p !== null &&
          typeof p === 'object' &&
          !Array.isArray(p) &&
          'functionCall' in (p as Record<string, unknown>)
        ) {
          return 'qwen-code';
        }
      }
    }

    // Claude: message.content with a tool_use or {type:'text'} item.
    const content = m['content'];
    if (Array.isArray(content)) {
      for (const item of content) {
        if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
          const t = (item as Record<string, unknown>)['type'];
          if (t === 'tool_use' || t === 'text') return 'claude-code';
        }
      }
    }
  }
  return null;
}
