// Explain (routing lite) — closed-loop MVP Task 11. Composes detect + diagnose
// for ONE unit and renders a routing pointer + the doc body + a docs_read
// consultation count. Read-only: no writes, no network, no subprocess.
//
// Pipeline:
//   collectEnvelopes → runDetector (collectEvidence) → diagnoseUnits →
//     find the diagnosis whose unit.key === opts.unit →
//       gatherRepoContext (locate the doc) → render.
//
// Doc-match heuristic (documented): re-uses the diagnoser's own
// `gatherRepoContext` — a doc matches the unit when the unit's leaf token
// (last `/`-segment) appears as any doc path segment OR as a substring of the
// filename stem (e.g. `src/billing` → `billing` → `docs/architecture/billing.md`).
// This keeps explain's "which doc to show" decision identical to the grounding
// the diagnoser used to attribute the cause, so the pointer never cites a doc
// the classifier disagreed with. When no doc matches, the pointer's null branch
// runs (suggesting `synthesize`).
//
// Consultation count: the count of DISTINCT sessions whose always-on `docs_read`
// rollup contains the matched doc path (exact repo-relative string match). The
// detector populates `docs_read` on every record (closed-loop MVP, always-on),
// so this is a pure filter over records — no extra I/O.
//
// Fail-open contract: any unexpected throw (ConfigError for a bogus --repo,
// latent error in a pure stage) → clean message + exitCode 1, NEVER rejects.
// Unknown unit OR no resolvable repo → clean message + exitCode 0 (not an
// error — there is simply nothing to explain).
//
// Harness-agnostic output: the rendered string never names the harness backend
// (claude-code/qwen-code/gigacode); the same explanation renders regardless of
// which adapter supplied the transcripts.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig } from './config.js';
import { collectEnvelopes } from './pipeline.js';
import { runDetector } from './detector/index.js';
import { diagnoseUnits } from './diagnoser/index.js';
import { gatherRepoContext } from './diagnoser/repo-context.js';
import { renderPointer } from './router/pointer.js';
import type { HarnessId } from './types.js';

export interface ExplainOptions {
  unit: string;
  repo?: string;
  harness?: HarnessId;
  harnessDir?: string;
  claudeDir?: string;
  configPath?: string;
}

export interface ExplainResult {
  output: string;
  exitCode: 0 | 1;
}

/**
 * Compose detect + diagnose for one unit and render a routing pointer + doc
 * body + docs_read consultation count. Async (awaits collectEnvelopes). NEVER
 * rejects — every failure path degrades to an {@link ExplainResult}. See the
 * module docstring for the full pipeline and the doc-match heuristic.
 */
export async function runExplain(opts: ExplainOptions): Promise<ExplainResult> {
  try {
    // 1. Config + harness resolution (flag → config → 'claude-code'). loadConfig
    //    can throw ConfigError; the outer catch turns it into exitCode 1.
    const cfg = loadConfig(opts.configPath);
    const harnessId: HarnessId = opts.harness ?? cfg.harness ?? 'claude-code';

    // 2. I/O preamble (shared with runScan/runSynthesize): discover → stream →
    //    resolve repo → filter. ConfigError for a bogus --repo propagates to
    //    the outer catch (exitCode 1).
    const { envelopes, filterRepo } = await collectEnvelopes({
      repo: opts.repo,
      harness: harnessId,
      harnessDir: opts.harnessDir,
      claudeDir: opts.claudeDir,
      configPath: opts.configPath,
    });

    // No resolvable repo → cannot ground doc-existence lookups (gatherRepoContext
    // needs a real repoRoot to read the docs tree). Clean exit, not an error.
    if (filterRepo === '') {
      return {
        output: `explain: no resolvable repository for the filtered sessions; cannot ground a diagnosis for \`${opts.unit}\`.`,
        exitCode: 0,
      };
    }

    // 3. Detect (collect evidence so the classifier can attribute a cause from
    //    failure/edit profiles; docs_read is always-on regardless).
    const { records } = runDetector(envelopes, cfg, false, { collectEvidence: true });

    // 4. Diagnose (never throws — per-unit fail-open inside diagnoseUnits).
    const diagnoses = diagnoseUnits(records, cfg, filterRepo);

    // 5. Find the target diagnosis. Unflagged areas never appear in `diagnoses`
    //    (buildProfiles skips them at the source), so an unknown / unflagged
    //    unit cleanly resolves to "no diagnosis" here.
    const diagnosis = diagnoses.find((d) => d.unit.key === opts.unit);
    if (diagnosis === undefined) {
      return {
        output: `explain: no diagnosis for \`${opts.unit}\` (it is not a flagged area).`,
        exitCode: 0,
      };
    }

    // 6. Locate the doc using the SAME leaf-token heuristic the diagnoser used
    //    to ground the cause (see gatherRepoContext). docPath is repo-relative
    //    POSIX, or null when no doc matched → pointer's null branch.
    const ctx = gatherRepoContext(opts.unit, filterRepo, cfg.docs_dirs);
    const docPath = ctx.matchedPath;

    // 7. Render. Cause header + rationale always; pointer branches on doc
    //    existence; doc body + consultation line only when a doc matched.
    const lines: string[] = [];
    lines.push(`cause: ${diagnosis.cause} (confidence ${diagnosis.confidence.toFixed(2)})`);
    if (diagnosis.rationale !== '') {
      lines.push('');
      lines.push(diagnosis.rationale);
    }
    lines.push('');
    lines.push(renderPointer(diagnosis.unit, docPath));

    if (docPath !== null) {
      // Consultation count: distinct sessions whose docs_read contains the path.
      // docs_read is always-on (detector populates it on every record), so this
      // is a pure filter — no extra I/O. Exact repo-relative string match.
      const n = records.filter((r) => r.docs_read.some((d) => d.path === docPath)).length;
      lines.push('');
      lines.push(`${n} prior session${n === 1 ? '' : 's'} consulted \`${docPath}\`.`);

      // Doc body. gatherRepoContext already confirmed a regular (non-symlink)
      // file exists at this path, so read should succeed — but wrap it so an
      // EACCES/ENOSPC between the stat and the read fails open (pointer still
      // cited the doc; the body is best-effort). Raw read: frontmatter is NOT
      // stripped (explain is a routing pointer, not a doc renderer).
      try {
        const body = fs.readFileSync(path.resolve(filterRepo, docPath), 'utf8');
        if (body !== '') {
          lines.push('');
          lines.push(body.replace(/\n+$/, ''));
        }
      } catch {
        // best-effort — the pointer is the load-bearing part of explain.
      }
    }

    return { output: lines.join('\n'), exitCode: 0 };
  } catch (e) {
    // Outer fail-open: any unexpected throw → clean message, exitCode 1, never
    // reject. Covers ConfigError (bogus --repo / config) and any latent throw
    // from the pure stages. Mirrors runSynthesize's fail-open boundary.
    const msg = e instanceof Error ? e.message : String(e);
    return {
      output: `explain: aborted — ${msg}`,
      exitCode: 1,
    };
  }
}
