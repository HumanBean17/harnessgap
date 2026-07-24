// Review (Curator lite) — closed-loop MVP Task 12. Lists the synthesized
// new-doc proposals under `<repo>/docs/_proposals/`, parses each file's YAML
// frontmatter → { path, cause, confidence, evidence_refs?, verification }, and
// offers accept / reject over the set.
//
//   - `--json` emits the parsed list as JSON (no TTY required).
//   - default (no flag, no TTY) prints a numbered list with cause + confidence
//     + verification + an evidence_refs summary (wrong-cause mitigation — the
//     reviewer sanity-checks the rationale, not just the label).
//   - `--yes` accepts every proposal non-interactively; each accept moves the
//     file to its frontmatter `path` (validated to be under a configured
//     `docs_dir`); a violation is reported and the file is NOT moved.
//   - `acceptProposal` / `rejectProposal` are exported so a programmatic caller
//     (or test) can target one proposal without a TTY.
//
// Fail-open contract: a missing `docs/_proposals/` dir is an empty list
// (exitCode 0); any unexpected throw (ConfigError, latent fs error) degrades to
// `{ output, exitCode: 1 }` and NEVER rejects. Mirrors runExplain/runSynthesize.
//
// I/O: reads + moves + deletes under `<repo>/docs/_proposals/` and `<docsDir>/`
// only. No network, no subprocess, no git. The only egress is local fs.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse } from 'yaml';
import { loadConfig } from './config.js';
import { isUnderDocsDir } from './synthesizer/factcheck.js';

// Re-export the docs-dir helper so callers reviewing a parsed proposal can
// reuse the same confinement check without importing from the synthesizer.
export { isUnderDocsDir };

/** Options for {@link runReview}, pinned to the Task 12 contract. */
export interface ReviewOptions {
  repo?: string;
  configPath?: string;
  json?: boolean;
  yes?: boolean;
}

/** Result of {@link runReview}, pinned to the Task 12 contract. */
export interface ReviewResult {
  output: string;
  exitCode: 0 | 1;
}

/**
 * Parsed frontmatter of one proposal file. The v1 closed loop's reviewer view:
 * `path` is the authoritative move target (repo-relative POSIX, under a
 * `docs_dir`); `cause` / `confidence` / `evidence_refs` come from the
 * diagnoser; `verification` is the boolean projection of the pre-write
 * fact-check. `evidence_refs` is optional (some proposals — e.g. needs-human
 * notes — omit it); review summarizes it but never blocks on its absence.
 */
export interface ProposalFrontmatter {
  path: string;
  cause: string;
  confidence: number;
  evidence_refs?: unknown[];
  verification: {
    cited_symbols_resolved: boolean;
    paths_resolved: boolean;
    shas_valid: boolean;
  };
}

/**
 * One parsed proposal on disk. `file` is the basename (e.g.
 * `src-billing-doc-abcd1234.md`); `absPath` is the absolute source path under
 * `docs/_proposals/`; `frontmatter` is the parsed YAML block; `body` is the
 * prose beneath the closing `---` (carried into the target on accept).
 */
export interface ParsedProposal {
  file: string;
  absPath: string;
  frontmatter: ProposalFrontmatter;
  body: string;
}

/** Outcome of accepting one proposal. */
export interface AcceptResult {
  ok: boolean;
  message: string;
  /** Repo-relative target path on success; unset when the accept was refused. */
  movedTo?: string;
}

/** Outcome of rejecting one proposal. */
export interface RejectResult {
  ok: boolean;
  message: string;
}

/** Directory under each repo where proposals/notes/digest are written. */
const PROPOSALS_DIR = 'docs/_proposals';

/** Basename excluded from the review list (the synthesizer's skip digest). */
const DIGEST_FILE = '_digest.md';

/**
 * Orchestrate the review listing / accept-all. See module docstring. Async
 * (mirrors the sibling command shapes) but does no awaited I/O today. NEVER
 * rejects — every failure path degrades to a {@link ReviewResult}.
 */
export async function runReview(opts: ReviewOptions): Promise<ReviewResult> {
  try {
    const repoRoot = opts.repo ?? process.cwd();
    // loadConfig can throw ConfigError; the outer catch turns it into exitCode 1.
    const cfg = loadConfig(opts.configPath);
    const proposalsDir = path.resolve(repoRoot, PROPOSALS_DIR);

    const parsed = listProposals(repoRoot);

    if (opts.json) {
      // JSON view: the parsed frontmatter array. The caller (CLI / test /
      // future `--json | jq`) consumes exactly the contract fields.
      const view = parsed.map((p) => p.frontmatter);
      return { output: JSON.stringify(view, null, 2), exitCode: 0 };
    }

    if (opts.yes) {
      const lines: string[] = [];
      let accepted = 0;
      let refused = 0;
      for (const p of parsed) {
        const res = acceptProposal({ proposal: p, repoRoot, docsDirs: cfg.docs_dirs });
        lines.push(`${p.file}: ${res.message}`);
        if (res.ok) {
          accepted += 1;
        } else {
          refused += 1;
        }
      }
      lines.push(
        `Reviewed ${parsed.length} proposal(s): ${accepted} accepted, ${refused} refused.`,
      );
      return { output: lines.join('\n'), exitCode: 0 };
    }

    // Default: numbered list. No TTY required — the CLI owns any interactive
    // prompt; the library always renders the list when neither --json nor --yes
    // is set. Renders cause + confidence + verification + evidence summary.
    return { output: renderList(parsed), exitCode: 0 };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      output: `review: aborted — ${msg}`,
      exitCode: 1,
    };
  }
}

/**
 * Enumerate and parse every proposal under `<repoRoot>/docs/_proposals/*.md`,
 * excluding `_digest.md`. Sorted by basename for deterministic output. Returns
 * an empty array when the directory is absent (not an error — clean empty
 * state). Files whose frontmatter fails to parse are skipped (best-effort);
 * they do not abort the batch.
 */
export function listProposals(repoRoot: string): ParsedProposal[] {
  const dir = path.resolve(repoRoot, PROPOSALS_DIR);
  let names: string[];
  try {
    names = fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
  const out: ParsedProposal[] = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    if (name === DIGEST_FILE) continue;
    const absPath = path.join(dir, name);
    let raw: string;
    try {
      raw = fs.readFileSync(absPath, 'utf8');
    } catch {
      continue;
    }
    const { fm, body } = splitFrontmatter(raw);
    if (fm === null) continue;
    let frontmatter: ProposalFrontmatter;
    try {
      frontmatter = normalizeFrontmatter(parse(fm));
    } catch {
      continue;
    }
    out.push({ file: name, absPath, frontmatter, body });
  }
  return out;
}

/**
 * Accept one proposal: validate its frontmatter `path` is confined to a
 * configured `docs_dir`, then move the file there (creating parent dirs). On
 * any validation failure (escaped path, empty docs_dirs, fs error) the source
 * file is NOT moved and a clear message is returned with `ok: false`. Never
 * throws.
 */
export function acceptProposal(args: {
  proposal: ParsedProposal;
  repoRoot: string;
  docsDirs: string[];
}): AcceptResult {
  const { proposal, repoRoot, docsDirs } = args;
  const relTarget = proposal.frontmatter.path;
  if (relTarget === '') {
    return { ok: false, message: 'refused — frontmatter has no `path`' };
  }
  // Resolve and confine: the target must live under <repoRoot>/<docsDir> AND
  // must not escape repoRoot via `..`. Both are covered by computing the
  // repo-relative target and reusing the fact-checker's confinement predicate
  // (single source of truth for the docs-dir contract).
  const targetAbs = path.resolve(repoRoot, relTarget);
  const relFromRoot = path.relative(repoRoot, targetAbs);
  if (relFromRoot === '' || relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
    return {
      ok: false,
      message: `refused — path \`${relTarget}\` escapes repo root`,
    };
  }
  if (!isUnderDocsDir(relFromRoot, docsDirs)) {
    return {
      ok: false,
      message: `refused — path \`${relTarget}\` not under any docs_dir [${docsDirs.join(', ')}]`,
    };
  }
  try {
    fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
    // rename overwrites on POSIX; explicit unlink first keeps the semantics
    // identical on hosts where rename-onto-existing is rejected.
    try {
      fs.rmSync(targetAbs, { force: true });
    } catch {
      // best-effort — rename below is the load-bearing step
    }
    fs.renameSync(proposal.absPath, targetAbs);
    return {
      ok: true,
      message: `accepted → ${relTarget}`,
      movedTo: relTarget,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, message: `refused — move failed: ${msg}` };
  }
}

/**
 * Reject one proposal: delete its source file under `docs/_proposals/`. Never
 * throws — a missing file or EACCES degrades to `ok: false` with a message.
 */
export function rejectProposal(args: { absPath: string }): RejectResult {
  const { absPath } = args;
  try {
    fs.rmSync(absPath, { force: true });
    return { ok: true, message: 'rejected' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, message: `reject failed: ${msg}` };
  }
}

/**
 * Split a `---\n<yaml>\n---\n<body>` proposal file into its YAML block and
 * body. Returns `{ fm: null, body: raw }` when there is no leading `---` fence
 * or the fence is unterminated (treated as no frontmatter). YAML document-end
 * `...` markers are also honored as the closing fence.
 */
function splitFrontmatter(raw: string): { fm: string | null; body: string } {
  const lines = raw.split('\n');
  if (lines[0] !== '---') return { fm: null, body: raw };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---' || lines[i] === '...') {
      end = i;
      break;
    }
  }
  if (end === -1) return { fm: null, body: raw };
  return {
    fm: lines.slice(1, end).join('\n'),
    body: lines.slice(end + 1).join('\n'),
  };
}

/**
 * Coerce a parsed YAML object into the {@link ProposalFrontmatter} contract,
 * tolerating missing fields rather than throwing (a proposal missing
 * `confidence` still lists; a missing `verification` defaults to all-false so
 * the reviewer sees a failed fact-check rather than a crash).
 */
function normalizeFrontmatter(v: unknown): ProposalFrontmatter {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  const verification = (() => {
    const raw = (typeof o.verification === 'object' && o.verification !== null
      ? o.verification
      : {}) as Record<string, unknown>;
    const b = (k: string): boolean => raw[k] === true;
    return {
      cited_symbols_resolved: b('cited_symbols_resolved'),
      paths_resolved: b('paths_resolved'),
      shas_valid: b('shas_valid'),
    };
  })();
  const evidenceRefs = Array.isArray(o.evidence_refs) ? o.evidence_refs : undefined;
  return {
    path: typeof o.path === 'string' ? o.path : '',
    cause: typeof o.cause === 'string' ? o.cause : 'unknown',
    confidence: typeof o.confidence === 'number' && Number.isFinite(o.confidence) ? o.confidence : 0,
    ...(evidenceRefs !== undefined ? { evidence_refs: evidenceRefs } : {}),
    verification,
  };
}

/** Render the numbered list view (default, no flags). */
function renderList(parsed: ParsedProposal[]): string {
  if (parsed.length === 0) {
    return 'No proposals pending review.';
  }
  const lines: string[] = [`Pending proposals (${parsed.length}):`];
  parsed.forEach((p, i) => {
    const fm = p.frontmatter;
    lines.push('');
    lines.push(`${i + 1}. ${fm.path || '(no path)'}`);
    lines.push(`   cause: ${fm.cause} (confidence ${fm.confidence.toFixed(2)})`);
    const v = fm.verification;
    lines.push(
      `   verification: symbols ${v.cited_symbols_resolved ? 'ok' : 'FAIL'}, paths ${v.paths_resolved ? 'ok' : 'FAIL'}, shas ${v.shas_valid ? 'ok' : 'FAIL'}`,
    );
    const n = fm.evidence_refs?.length ?? 0;
    lines.push(`   evidence: ${n} ref${n === 1 ? '' : 's'}`);
  });
  return lines.join('\n');
}
