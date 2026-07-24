// Synthesizer orchestration (closed-loop MVP, Task 10). The keystone that
// composes every earlier seam into one pipeline:
//
//   collectEnvelopes → runDetector (collect docs_read + evidence) →
//     diagnoseUnits → select units → per-unit {
//       buildBundle → resolveBackend → runBackend → extractProposal →
//       normalize (string → object) → isEditProposal / assertNewDocProposal →
//       factCheck → write
//     } → render summary.
//
// Selection (the prose gate): when `opts.unit` is set, target that one unit
// directly (the user asked for it); otherwise take the top
// `cfg.synthesizer.top_n` diagnoses whose `cause ∈ {doc, config-doc}` AND whose
// `confidence ≥ cfg.diagnose.confidence_floor_for_prose`, ranked by confidence
// descending. Non-qualifying units (and any backend/validation failure) are
// appended to `docs/_proposals/_digest.md` so nothing is silently lost.
//
// Fail-open contract: a per-unit try/catch turns any throw (backend explosion,
// envelope parse failure, malformed proposal) into a digest entry and the batch
// continues; an OUTER try/catch turns any unexpected throw into a clean
// `{ output, exitCode: 1, proposals: [] }` — `runSynthesize` NEVER rejects.
//
// I/O: the only writes are under `<repo>/docs/_proposals/`. No network — the
// sole egress is `runBackend` (src/synthesizer/backend.ts), which shells out to
// the agent print-mode CLI. Tests inject `runBackendFn` to avoid a real call.
// `child_process` is imported ONLY in backend.ts (the §11 egress guard allows
// it there); this file imports node:fs, node:path, node:crypto only.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { loadConfig } from '../config.js';
import { collectEnvelopes } from '../pipeline.js';
import { runDetector } from '../detector/index.js';
import { diagnoseUnits } from '../diagnoser/index.js';
import { buildBundle } from './bundle.js';
import { resolveBackend, runBackend, extractProposal } from './backend.js';
import { assertNewDocProposal, isEditProposal } from './proposal.js';
import { factCheck, verificationFrom } from './factcheck.js';
import type { Config, Diagnosis, HarnessId, Proposal, StruggleRecord } from '../types.js';

// Re-export so callers can import the option/result types alongside the entry.
export type { Config, Diagnosis, HarnessId, Proposal, StruggleRecord };

/**
 * Options for {@link runSynthesize}. Mirrors {@link ScanOptions} shape for the
 * shared fields so the CLI can thread the same flags. `runBackendFn` is the
 * injectable backend (defaults to the real {@link runBackend}); tests pass a
 * fake returning a canned envelope string to avoid firing a model call.
 */
export interface SynthesizeOptions {
  repo?: string;
  /** Target one unit by area key; bypasses the top-N cause/confidence filter. */
  unit?: string;
  harness?: HarnessId;
  harnessDir?: string;
  claudeDir?: string;
  configPath?: string;
  /**
   * Acknowledged by the library as "do not prompt"; the CLI owns any actual
   * confirmation prompt. The library always writes proposals when invoked —
   * `yes` does not gate writes here (it gates the CLI's pre-write prompt).
   */
  yes?: boolean;
  /** Injectable backend (defaults to the real {@link runBackend}). */
  runBackendFn?: typeof runBackend;
}

/**
 * Result of {@link runSynthesize}. `output` is a human-readable summary;
 * `exitCode` is 0 on any completed run (even partial) and 1 only on an
 * unexpected top-level throw; `proposals` lists the repo-relative paths of
 * successfully written new-doc proposals (needs-human notes and digest entries
 * are NOT included — they are surfaced via `output`).
 */
export interface SynthesizeResult {
  output: string;
  exitCode: 0 | 1;
  proposals: string[];
}

/** Directory under each repo where proposals/notes/digest are written. */
const PROPOSALS_DIR = 'docs/_proposals';

/** Causes eligible for prose synthesis (the prose gate). */
const PROSE_CAUSES: ReadonlySet<Diagnosis['cause']> = new Set(['doc', 'config-doc']);

/**
 * Orchestrate the full synthesizer closed loop. See module docstring for the
 * pipeline. Async (awaits collectEnvelopes + runBackend). NEVER rejects — every
 * failure path degrades to a {@link SynthesizeResult}.
 */
export async function runSynthesize(opts: SynthesizeOptions): Promise<SynthesizeResult> {
  try {
    // 1. Config + harness resolution (flag → config → 'claude-code'). loadConfig
    //    can throw ConfigError; the outer catch turns it into exitCode 1.
    const cfg = loadConfig(opts.configPath);
    const harnessId: HarnessId = opts.harness ?? cfg.harness ?? 'claude-code';

    // 2. I/O preamble (shared with runScan): discover → stream → resolve repo →
    //    filter. ConfigError for a bogus --repo / unparseable --since
    //    propagates to the outer catch (exitCode 1).
    const { envelopes, filterRepo } = await collectEnvelopes({
      repo: opts.repo,
      harness: harnessId,
      harnessDir: opts.harnessDir,
      claudeDir: opts.claudeDir,
      configPath: opts.configPath,
    });

    // No resolvable repo → cannot ground doc-existence or write proposals.
    if (filterRepo === '') {
      return {
        output:
          'synthesize: no resolvable repository for the filtered sessions; nothing to synthesize.',
        exitCode: 0,
        proposals: [],
      };
    }

    // 3. Detect (always collect evidence — the diagnoser needs failure/edit
    //    profiles to attribute causes; docs_read is always-on regardless).
    const { records } = runDetector(envelopes, cfg, false, { collectEvidence: true });

    // 4. Diagnose (never throws — per-unit fail-open inside diagnoseUnits).
    const diagnoses = diagnoseUnits(records, cfg, filterRepo);

    // 5. Select units (the prose gate).
    const selected = selectUnits(diagnoses, opts.unit, cfg);

    // Units that were diagnosed but NOT selected → digest (so the human sees
    // what was skipped and why). This is the "non-qualifying" path.
    const selectedKeys = new Set(selected.map((d) => d.unit.key));
    const skipped = diagnoses.filter((d) => !selectedKeys.has(d.unit.key));

    const proposalsDir = path.resolve(filterRepo, PROPOSALS_DIR);
    // Ensure the directory exists before any append/write. Cheap; runs once.
    fs.mkdirSync(proposalsDir, { recursive: true });

    for (const skip of skipped) {
      appendDigest(proposalsDir, skip, digestReason(skip, cfg));
    }

    // 6. Per-unit synthesis. Each unit is isolated: a throw becomes a digest
    //    entry and the batch continues.
    const writtenProposals: string[] = [];
    const digestNotes: string[] = [];
    const needsHumanNotes: string[] = [];

    for (const diagnosis of selected) {
      const unitRecords = records.filter((r) =>
        r.areas.some((a) => a.key === diagnosis.unit.key),
      );
      // Write-phase fail-open: synthesizeOne guards its own backend/unwrap/parse
      // stages, but buildBundle / factCheck / writeProposal's fs.writeFileSync
      // are NOT inside synthesizeOne's try/catches. A throw there (EACCES /
      // ENOSPC / EIO) would escape past the per-unit boundary and abort the
      // whole batch via the outer catch — discarding any proposals already
      // written. Wrap the whole call so a mid-batch write failure becomes a
      // digest entry and the batch continues to the next unit.
      let outcome: SynthesizeOutcome;
      try {
        outcome = await synthesizeOne({
          diagnosis,
          records: unitRecords,
          repoRoot: filterRepo,
          proposalsDir,
          cfg,
          harnessId,
          runBackendFn: opts.runBackendFn,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const reason = `unit synthesis error: ${msg}`;
        appendDigest(proposalsDir, diagnosis, reason);
        digestNotes.push(`${diagnosis.unit.key}: ${reason}`);
        continue;
      }
      if (outcome.kind === 'written') {
        writtenProposals.push(outcome.relPath);
      } else if (outcome.kind === 'needs-human') {
        // Materialize the note so the human can pick it up; also surface in output.
        writeNeedsHumanNote(proposalsDir, diagnosis, outcome.reason);
        needsHumanNotes.push(`${diagnosis.unit.key}: ${outcome.reason}`);
      } else {
        appendDigest(proposalsDir, diagnosis, outcome.reason);
        digestNotes.push(`${diagnosis.unit.key}: ${outcome.reason}`);
      }
    }

    // 7. Render summary.
    const output = renderSummary({
      writtenProposals,
      digestNotes,
      needsHumanNotes,
      skippedCount: skipped.length,
      selectedCount: selected.length,
    });

    return { output, exitCode: 0, proposals: writtenProposals };
  } catch (e) {
    // Outer fail-open: any unexpected throw → clean message, exitCode 1, never
    // reject. Includes ConfigError (bogus --repo / config) and any latent throw
    // from the pure stages.
    const msg = e instanceof Error ? e.message : String(e);
    return {
      output: `synthesize: aborted — ${msg}`,
      exitCode: 1,
      proposals: [],
    };
  }
}

/**
 * Select the units to synthesize. `opts.unit` targets one area by key directly
 * (it must still appear in `diagnoses`); otherwise the top-N diagnoses with a
 * prose-eligible cause AND confidence ≥ floor, ranked by confidence descending.
 * Ties break by unit.key ascending for determinism.
 */
function selectUnits(
  diagnoses: Diagnosis[],
  unit: string | undefined,
  cfg: Config,
): Diagnosis[] {
  if (unit !== undefined) {
    const found = diagnoses.find((d) => d.unit.key === unit);
    return found ? [found] : [];
  }
  return diagnoses
    .filter(
      (d) =>
        PROSE_CAUSES.has(d.cause) &&
        d.confidence >= cfg.diagnose.confidence_floor_for_prose,
    )
    .sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return a.unit.key < b.unit.key ? -1 : a.unit.key > b.unit.key ? 1 : 0;
    })
    .slice(0, Math.max(1, Math.floor(cfg.synthesizer.top_n)));
}

/** One unit's synthesis outcome (tagged union). */
type SynthesizeOutcome =
  | { kind: 'written'; relPath: string }
  | { kind: 'needs-human'; reason: string }
  | { kind: 'digest'; reason: string };

/**
 * Run the full per-unit flow: buildBundle → resolveBackend → runBackend →
 * extractProposal → normalize → validate → factCheck → write. Every failure
 * path returns a non-`written` outcome rather than throwing; the caller turns
 * those into digest/needs-human entries.
 */
async function synthesizeOne(args: {
  diagnosis: Diagnosis;
  records: StruggleRecord[];
  repoRoot: string;
  proposalsDir: string;
  cfg: Config;
  harnessId: HarnessId;
  runBackendFn?: typeof runBackend;
}): Promise<SynthesizeOutcome> {
  const { diagnosis, records, repoRoot, proposalsDir, cfg, harnessId, runBackendFn } = args;

  // Build the evidence prompt (pure string assembly + bounded file reads).
  const prompt = buildBundle({
    diagnosis,
    records,
    unitKey: diagnosis.unit.key,
    repoRoot,
    cfg,
  });

  // Resolve + run the backend. Injectable: tests pass runBackendFn.
  const { cmd, args: backendArgs } = resolveBackend(harnessId, cfg);
  let stdout: string;
  try {
    const fn = runBackendFn ?? runBackend;
    stdout = await fn({ cmd, args: backendArgs, prompt, cwd: repoRoot });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { kind: 'digest', reason: `backend error: ${msg}` };
  }

  // Per-harness envelope unwrap. Returns an OBJECT for claude-code but a TEXT
  // STRING for qwen-code/gigacode (the caller owns the final parse).
  let unwrapped: unknown;
  try {
    unwrapped = extractProposal(stdout, harnessId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { kind: 'digest', reason: `envelope unwrap error: ${msg}` };
  }

  // Normalize: qwen/gigacode return a JSON string here — parse it. A parse
  // failure (non-JSON assistant text) degrades to a digest entry.
  if (typeof unwrapped === 'string') {
    try {
      unwrapped = JSON.parse(unwrapped);
    } catch {
      return {
        kind: 'digest',
        reason: 'backend returned a non-JSON string (could not parse proposal)',
      };
    }
  }

  // Edit-proposal → needs human (v1 only produces new-doc).
  if (isEditProposal(unwrapped)) {
    return {
      kind: 'needs-human',
      reason: 'backend returned an edit-proposal (v1 only synthesizes new-doc); needs human review',
    };
  }

  // Structural validation (throws on first wrong field).
  let proposal: Proposal;
  try {
    proposal = assertNewDocProposal(unwrapped);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { kind: 'digest', reason: `invalid proposal: ${msg}` };
  }

  // Fact-check gate (deterministic, never throws).
  const fcResult = factCheck(proposal, repoRoot, cfg.docs_dirs);
  const unresolved = fcResult.failures.filter((f) => !f.resolved);
  if (unresolved.length > 0) {
    const failing = describeFailures(unresolved);
    return {
      kind: 'needs-human',
      reason: `fact-check unresolved (${failing})`,
    };
  }

  // Passed — write the new-doc proposal with authoritative verification.
  const verification = verificationFrom(fcResult);
  const relPath = writeProposal({
    proposal,
    proposalsDir,
    repoRoot,
    diagnosis,
    verification,
  });
  return { kind: 'written', relPath };
}

/**
 * Write one new-doc proposal to `<proposalsDir>/<safeArea>-<cause>-<shortHash>.md`
 * with YAML frontmatter (derived_from / unit / struggle_score / cause /
 * source_files@sha / created / verification) and the synthesized body. Returns
 * the repo-relative path.
 */
function writeProposal(args: {
  proposal: Proposal;
  proposalsDir: string;
  repoRoot: string;
  diagnosis: Diagnosis;
  verification: { cited_symbols_resolved: boolean; paths_resolved: boolean; shas_valid: boolean };
}): string {
  const { proposal, proposalsDir, repoRoot, verification } = args;
  const safeArea = safeFilename(args.diagnosis.unit.key);
  const cause = proposal.frontmatter.cause;
  const shortHash = shortHashOf(proposal);
  const filename = `${safeArea}-${cause}-${shortHash}.md`;
  const abs = path.join(proposalsDir, filename);

  const fm: string[] = ['---'];
  fm.push('derived_from:');
  for (const s of proposal.frontmatter.derived_from) fm.push(`  - ${s}`);
  fm.push(`unit: ${args.diagnosis.unit.key}`);
  fm.push(`struggle_score: ${proposal.frontmatter.struggle_score}`);
  fm.push(`cause: ${cause}`);
  fm.push('source_files:');
  for (const s of proposal.frontmatter.source_files) fm.push(`  - ${s}`);
  fm.push(`created: ${proposal.frontmatter.created}`);
  fm.push('verification:');
  fm.push(`  cited_symbols_resolved: ${verification.cited_symbols_resolved}`);
  fm.push(`  paths_resolved: ${verification.paths_resolved}`);
  fm.push(`  shas_valid: ${verification.shas_valid}`);
  fm.push('---');
  fm.push('');
  fm.push(proposal.body);
  fm.push('');

  fs.writeFileSync(abs, fm.join('\n'), 'utf8');
  return path.relative(repoRoot, abs);
}

/**
 * Append one entry to `<proposalsDir>/_digest.md`. Creates the file on first
 * append. The entry names the unit, its cause/confidence, and the reason it was
 * not synthesized (non-qualifying / backend error / invalid proposal).
 */
function appendDigest(
  proposalsDir: string,
  diagnosis: Diagnosis,
  reason: string,
): void {
  const abs = path.join(proposalsDir, '_digest.md');
  const lines: string[] = [`## ${diagnosis.unit.key}`];
  lines.push(`cause: ${diagnosis.cause}`);
  lines.push(`confidence: ${diagnosis.confidence}`);
  lines.push(`status: ${reason}`);
  lines.push('');
  // Append (not overwrite) so multiple units + multiple runs accumulate. The
  // file is created on first write via the 'a' flag.
  fs.appendFileSync(abs, lines.join('\n'), 'utf8');
}

/**
 * Write a needs-human note to `<proposalsDir>/<safeArea>-needs-human.md`. Used
 * when the backend returned an edit-proposal OR the fact-check gate found
 * unresolved failures (the proposal is too plausible to drop silently but too
 * unverified to write as-is). Overwrites any prior note for the same unit
 * within this run.
 */
function writeNeedsHumanNote(
  proposalsDir: string,
  diagnosis: Diagnosis,
  detail: string,
): void {
  const safeArea = safeFilename(diagnosis.unit.key);
  const abs = path.join(proposalsDir, `${safeArea}-needs-human.md`);
  const lines: string[] = [`# Needs human review: ${diagnosis.unit.key}`];
  lines.push('');
  lines.push(`cause: ${diagnosis.cause}`);
  lines.push(`confidence: ${diagnosis.confidence}`);
  lines.push('');
  lines.push(detail);
  lines.push('');
  fs.writeFileSync(abs, lines.join('\n'), 'utf8');
}

/** Map an area key to a filesystem-safe path segment (`/` → `-`). */
function safeFilename(areaKey: string): string {
  // Collapse path separators + any char unsafe across POSIX/Windows into '-'.
  return areaKey
    .split('/')
    .filter((s) => s !== '')
    .join('-')
    .replace(/[^A-Za-z0-9._-]+/g, '-');
}

/** Stable 8-hex short hash of a proposal's load-bearing content (dedup key). */
function shortHashOf(proposal: Proposal): string {
  const stable = [
    proposal.frontmatter.unit.key,
    proposal.frontmatter.derived_from.join(','),
    proposal.frontmatter.source_files.join(','),
    proposal.cited_symbols.join(','),
    proposal.body,
  ].join('\n');
  return createHash('sha256').update(stable, 'utf8').digest('hex').slice(0, 8);
}

/** Render the unresolved fact-check failures as a single readable line. */
function describeFailures(
  failures: { assertion: string; kind: string; detail?: string }[],
): string {
  return failures
    .map((f) => `${f.kind}:${f.assertion}${f.detail ? ` (${f.detail})` : ''}`)
    .join('; ');
}

/** Human-readable reason for a unit being skipped at the prose gate. */
function digestReason(diagnosis: Diagnosis, cfg: Config): string {
  if (!PROSE_CAUSES.has(diagnosis.cause)) {
    return `non-qualifying cause (${diagnosis.cause} not in {doc, config-doc})`;
  }
  if (diagnosis.confidence < cfg.diagnose.confidence_floor_for_prose) {
    return `confidence ${diagnosis.confidence} below prose floor ${cfg.diagnose.confidence_floor_for_prose}`;
  }
  return 'not selected (beyond top_n)';
}

/** Render the final human-readable summary line(s). */
function renderSummary(args: {
  writtenProposals: string[];
  digestNotes: string[];
  needsHumanNotes: string[];
  skippedCount: number;
  selectedCount: number;
}): string {
  const { writtenProposals, digestNotes, needsHumanNotes, skippedCount, selectedCount } = args;
  const lines: string[] = [];
  lines.push(
    `Synthesized ${writtenProposals.length} proposal(s) from ${selectedCount} unit(s); ${skippedCount} skipped.`,
  );
  if (writtenProposals.length > 0) {
    lines.push('Proposals:');
    for (const p of writtenProposals) lines.push(`  - ${p}`);
  }
  if (needsHumanNotes.length > 0) {
    lines.push('Needs human review:');
    for (const n of needsHumanNotes) lines.push(`  - ${n}`);
  }
  if (digestNotes.length > 0) {
    lines.push('Digest entries:');
    for (const d of digestNotes) lines.push(`  - ${d}`);
  }
  return lines.join('\n');
}
