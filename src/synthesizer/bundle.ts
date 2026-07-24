// Evidence bundle / prompt assembly (Synthesizer, Task 9). Composes the prompt
// string the orchestrator (Task 10) hands to `runBackend`. Pure string assembly
// over bounded `node:fs` reads — the ONLY I/O is walking the docs dirs and the
// area-prefix subtree, reading each file once, and capping per file. No
// `child_process`, no network, no git (the fact-checker, not the bundle, owns
// sha pinning).
//
// The prompt MUST surface enough grounding for the backend to draft a new-doc
// Proposal whose `cited_symbols` and `referenced_paths` survive the Task-7
// fact-check gate: the diagnosed cause + confidence + rationale + evidence
// pointers, the unit's rolled-up struggle signals, the docs inventory (paths
// AND size-capped bodies so the backend can reuse phrasing), and source
// file-heads under the area prefix (capped + scrubbed). The output explicitly
// tells the backend which JSON shape to return.
//
// Security: every file head runs through `scrubContent` (the same 7-rule
// pattern catalog as `scrubCmd`, without the 512 truncation) so a stray AWS
// key, Bearer token, or `export SECRET=...` in a source file never reaches the
// backend. Doc bodies are scrubbed too — strictly safer, and the catalog was
// designed for general text, not just commands. File discovery never follows
// symlinks and is path-confined to the repo root (mirrors
// src/diagnoser/repo-context.ts and src/walk.ts).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { scrubContent } from '../adapter/scrub.js';
import type {
  Config,
  Diagnosis,
  EvidenceRef,
  SignalName,
  SignalValues,
  StruggleRecord,
} from '../types.js';

// Re-export so callers can import the consumed types alongside the builder.
export type { Config, Diagnosis, StruggleRecord };

/** Argument bundle for {@link buildBundle}. */
export interface BuildBundleArgs {
  diagnosis: Diagnosis;
  records: StruggleRecord[];
  unitKey: string;
  repoRoot: string;
  cfg: Config;
}

/** One file's repo-relative path and its size-capped, scrubbed body/head. */
interface FileChunk {
  rel: string;
  body: string;
}

/**
 * Build the evidence prompt string for one diagnosed unit. The returned string
 * is what the orchestrator writes to the backend's stdin. Composition
 * (sections appear in this order):
 *
 *   1. Role + the output contract (a JSON object matching the new-doc Proposal
 *      schema, including `cited_symbols` and `referenced_paths`).
 *   2. The area key (`unitKey`).
 *   3. The diagnosis: `cause`, `confidence`, `rationale`, every `evidence_refs`
 *      leaf rendered readably.
 *   4. The unit's aggregate signals, rolled up across `records` (mean of
 *      numeric signals over their non-null values; any-true for booleans).
 *   5. The docs inventory: every regular file under any `cfg.docs_dirs` entry,
 *      each with its path and a size-capped, scrubbed body. Sent regardless of
 *      `structure_only` — the backend needs existing phrasing to dedupe.
 *   6. Source file-heads: every regular file under the area prefix
 *      (`<repoRoot>/<unitKey>/...`), each capped at
 *      `cfg.synthesizer.max_file_head_bytes` and scrubbed. When
 *      `structure_only` is true, a note says no full bodies will be provided
 *      (heads remain); when false, the note is omitted but heads are STILL
 *      capped (heads-only is the default behavior).
 *
 * Fail-open: a missing repo root, missing area dir, unreadable file, or
 * unexpected throw contributes no chunk and never propagates — the prompt is
 * always returned, even if some sections are empty.
 */
export function buildBundle(args: BuildBundleArgs): string {
  const { diagnosis, records, unitKey, repoRoot, cfg } = args;
  const cap = Math.max(1, Math.floor(cfg.synthesizer.max_file_head_bytes));
  const out: string[] = [];

  out.push('You are a documentation synthesizer for an agentic CLI harness.');
  out.push(
    'Return ONLY a single JSON object matching the new-doc Proposal schema:',
  );
  out.push('{');
  out.push('  "kind": "new-doc",');
  out.push('  "path": "<repo-relative path under a docs dir>",');
  out.push('  "frontmatter": {');
  out.push('    "derived_from": ["<session-id>", ...],');
  out.push('    "unit": { "kind": "area", "key": "<area-key>" },');
  out.push('    "struggle_score": <number 0..1>,');
  out.push('    "cause": "<doc|config-doc|test-gap|refactor-flag|inherent-complexity|unclassified>",');
  out.push('    "source_files": ["<repo-relative path@sha>", ...],');
  out.push('    "created": "<ISO8601 timestamp>"');
  out.push('  },');
  out.push('  "body": "<markdown prose grounded ONLY in the evidence below>",');
  out.push('  "cited_symbols": ["<code identifier>", ...],');
  out.push('  "referenced_paths": ["<repo-relative path>", ...],');
  out.push('  "dedupe": {');
  out.push('    "nearest_existing": "<path or null>",');
  out.push('    "similarity": <optional number>,');
  out.push('    "decision_rationale": "<string>"');
  out.push('  },');
  out.push('  "verification": {');
  out.push('    "cited_symbols_resolved": false,');
  out.push('    "paths_resolved": false,');
  out.push('    "shas_valid": false');
  out.push('  }');
  out.push('}');
  out.push(
    'Every symbol you mention in `body` MUST be listed in `cited_symbols` (the fact-checker resolves each against the source files).',
  );
  out.push(
    'Every path you mention in `body` MUST be listed in `referenced_paths` (the fact-checker checks each exists under the repo root).',
  );
  out.push('Do not include any prose outside the JSON object.');
  out.push('');

  out.push(`AREA: ${unitKey}`);
  out.push('');

  out.push('DIAGNOSIS:');
  out.push(`cause: ${diagnosis.cause}`);
  out.push(`confidence: ${diagnosis.confidence}`);
  out.push(`rationale: ${diagnosis.rationale}`);
  out.push('evidence_refs:');
  if (diagnosis.evidence_refs.length === 0) {
    out.push('  (none)');
  } else {
    for (const ref of diagnosis.evidence_refs) {
      out.push(`  ${renderEvidenceRef(ref)}`);
    }
  }
  out.push('');

  out.push('AGGREGATE_SIGNALS:');
  const agg = aggregateSignals(records);
  for (const [name, value] of agg) {
    out.push(`  ${name}: ${value}`);
  }
  out.push(`  records_consulted: ${records.length}`);
  out.push('');

  out.push('DOCS_INVENTORY:');
  const docChunks = collectDocs(repoRoot, cfg.docs_dirs, cap);
  if (docChunks.length === 0) {
    out.push('  (no docs found under configured docs_dirs)');
  } else {
    for (const chunk of docChunks) {
      out.push(`--- ${chunk.rel} ---`);
      out.push(chunk.body);
    }
  }
  out.push('');

  out.push('SOURCE_FILES:');
  if (cfg.synthesizer.structure_only) {
    out.push(
      'NOTE: structure_only mode — no full bodies will be provided; file heads below are size-capped and redacted.',
    );
  }
  const srcChunks = collectSourceHeads(repoRoot, unitKey, cap);
  if (srcChunks.length === 0) {
    out.push('  (no source files found under the area prefix)');
  } else {
    for (const chunk of srcChunks) {
      out.push(`--- ${chunk.rel} ---`);
      out.push(chunk.body);
    }
  }

  return out.join('\n');
}

/**
 * Render one {@link EvidenceRef} leaf as a single readable line. Derived-only:
 * the value is a signal name + scalar, a doc path, or an integer count profile.
 */
function renderEvidenceRef(ref: EvidenceRef): string {
  switch (ref.kind) {
    case 'signal':
      return `signal ${ref.name}=${ref.value}`;
    case 'doc_absent':
      return `doc_absent (checked: ${ref.checked.join(', ') || '(none)'})`;
    case 'doc_present':
      return `doc_present ${ref.path}`;
    case 'failure_profile':
      return `failure_profile config=${ref.config} test=${ref.test} build=${ref.build} other=${ref.other}`;
    case 'edit_profile':
      return `edit_profile test=${ref.test} code=${ref.code} other=${ref.other}`;
  }
}

/**
 * Roll the records' signals up to a stable insertion-ordered list of
 * `[name, display]` pairs. Numeric signals (incl. nullable ones) are averaged
 * over their non-null values; `abandonment` (boolean) is any-true. Records with
 * no contributing value for a nullable signal are skipped for that signal only.
 */
function aggregateSignals(records: StruggleRecord[]): [string, string][] {
  // SignalName uses `wall_clock_per_line` (no `_ms` suffix); SignalValues uses
  // `wall_clock_per_line_ms`. The Record is keyed by SignalName, so the `_ms`
  // value is read off the record via its own field name (see loop below).
  const sums: Record<SignalName, number> = {
    explore_ratio: 0,
    reread: 0,
    failure_streak: 0,
    corrections: 0,
    abandonment: 0,
    oscillation: 0,
    wall_clock_per_line: 0,
  };
  const counts: Record<SignalName, number> = {
    explore_ratio: 0,
    reread: 0,
    failure_streak: 0,
    corrections: 0,
    abandonment: 0,
    oscillation: 0,
    wall_clock_per_line: 0,
  };
  let anyAbandonment = false;

  for (const r of records) {
    const s: SignalValues = r.signals;
    if (s.explore_ratio !== null) {
      sums.explore_ratio += s.explore_ratio;
      counts.explore_ratio += 1;
    }
    sums.reread += s.reread;
    counts.reread += 1;
    sums.failure_streak += s.failure_streak;
    counts.failure_streak += 1;
    sums.corrections += s.corrections;
    counts.corrections += 1;
    if (s.abandonment) anyAbandonment = true;
    counts.abandonment += 1;
    sums.oscillation += s.oscillation;
    counts.oscillation += 1;
    if (s.wall_clock_per_line_ms !== null) {
      sums.wall_clock_per_line += s.wall_clock_per_line_ms;
      counts.wall_clock_per_line += 1;
    }
  }

  const mean = (name: SignalName): string =>
    counts[name] > 0 ? formatNum(sums[name] / counts[name]) : 'n/a';

  return [
    ['explore_ratio', mean('explore_ratio')],
    ['reread', mean('reread')],
    ['failure_streak', mean('failure_streak')],
    ['corrections', mean('corrections')],
    ['abandonment', String(anyAbandonment)],
    ['oscillation', mean('oscillation')],
    ['wall_clock_per_line', mean('wall_clock_per_line')],
  ];
}

/** Format a number compactly: integers without a trailing `.0`, else 4 dp. */
function formatNum(n: number): string {
  if (Number.isFinite(n) && Math.round(n) === n) return String(n);
  return String(Number(n.toFixed(4)));
}

/**
 * Read a file, cap its content to `cap` characters, scrub via the catalog.
 * Returns null on missing/unreadable file. The cap is applied to the raw utf8
 * head BEFORE scrubbing so the bound reflects bytes read from disk; scrubbing
 * only ever replaces text with the fixed sentinel (never expands it).
 */
function readCappedScrubbed(abs: string, cap: number): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
  const head = raw.length > cap ? raw.slice(0, cap) : raw;
  return scrubContent(head);
}

/**
 * Recursively collect regular files (never symlinks) under `dirAbs`, confined
 * to `prefix` (= `rootAbs + path.sep`). Mirrors the collection walker in
 * src/diagnoser/repo-context.ts: Dirent.isDirectory() is false for
 * symlinked dirs (so they are skipped), every candidate file is lstatSync'd
 * (NOT statSync'd) so symlink files are rejected, and a prefix-confinement
 * check rejects any path that escapes `rootAbs`. Fail-open at every level.
 */
function collectFilesUnder(
  dirAbs: string,
  prefix: string,
  rootAbs: string,
  out: string[],
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return;
  }

  for (const ent of entries) {
    if (ent.isDirectory()) {
      const sub = path.resolve(path.join(dirAbs, ent.name));
      if (sub !== rootAbs && !sub.startsWith(prefix)) continue;
      collectFilesUnder(sub, prefix, rootAbs, out);
      continue;
    }
    const candidate = path.join(dirAbs, ent.name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(candidate);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (!st.isFile()) continue;
    const resolved = path.resolve(candidate);
    if (resolved !== rootAbs && !resolved.startsWith(prefix)) continue;
    out.push(path.relative(rootAbs, resolved));
  }
}

/**
 * Gather size-capped, scrubbed bodies for every regular file under each
 * `docsDirs` entry. Returns chunks sorted by repo-relative path for stable
 * prompt output. Fail-open: a missing/unreadable docsDir or escaping entry
 * contributes nothing. Each docsDir is confined to `rootAbs`.
 */
function collectDocs(
  repoRoot: string,
  docsDirs: string[],
  cap: number,
): FileChunk[] {
  const rootAbs = path.resolve(repoRoot);
  const prefix = rootAbs + path.sep;
  const rels: string[] = [];
  for (const d of docsDirs) {
    if (d === '') continue;
    const dirAbs = path.resolve(rootAbs, d);
    if (dirAbs !== rootAbs && !dirAbs.startsWith(prefix)) continue;
    try {
      if (fs.lstatSync(dirAbs).isSymbolicLink()) continue;
    } catch {
      continue;
    }
    collectFilesUnder(dirAbs, prefix, rootAbs, rels);
  }
  return toChunks(rootAbs, rels, cap);
}

/**
 * Gather size-capped, scrubbed heads for every regular file under the area
 * prefix `<repoRoot>/<unitKey>`. The unitKey is treated as a POSIX repo-relative
 * path; files whose path does not start with `<unitKey>/` are excluded (the
 * area prefix is the scoping boundary). Fail-open: a missing area dir
 * contributes nothing.
 */
function collectSourceHeads(
  repoRoot: string,
  unitKey: string,
  cap: number,
): FileChunk[] {
  const rootAbs = path.resolve(repoRoot);
  const prefix = rootAbs + path.sep;
  // An empty unitKey is meaningless as a prefix and would otherwise collapse
  // to rootAbs (walking the whole repo, including docs, as "source heads").
  // Reject it up front.
  if (unitKey.trim() === '') return [];
  const areaDir = path.resolve(rootAbs, toOsPath(unitKey));
  // Path-confine: an area key like `../escape` resolves outside rootAbs and is
  // rejected before any filesystem read.
  if (areaDir !== rootAbs && !areaDir.startsWith(prefix)) return [];
  // An empty unitKey collapses to rootAbs (the repo root) — still confined,
  // and collectFilesUnder walks the whole repo. An explicit non-prefix check is
  // not needed: rootAbs === rootAbs passes the confinement guard above.
  const rels: string[] = [];
  collectFilesUnder(areaDir, prefix, rootAbs, rels);
  return toChunks(rootAbs, rels, cap);
}

/** Convert repo-relative paths to FileChunks (read + cap + scrub), sorted. */
function toChunks(rootAbs: string, rels: string[], cap: number): FileChunk[] {
  // De-dup + stable sort so the prompt is deterministic regardless of docsDirs
  // overlap or readdir ordering. POSIX-relative for stable keys.
  const uniq = Array.from(
    new Set(rels.map((r) => r.split(path.sep).join('/'))),
  ).sort();
  const chunks: FileChunk[] = [];
  for (const rel of uniq) {
    const abs = path.resolve(rootAbs, toOsPath(rel));
    const body = readCappedScrubbed(abs, cap);
    if (body === null) continue;
    chunks.push({ rel, body });
  }
  return chunks;
}

/** Convert a POSIX (`/`-separated) repo-relative path to an OS-native path. */
function toOsPath(p: string): string {
  return p.split('/').join(path.sep);
}
