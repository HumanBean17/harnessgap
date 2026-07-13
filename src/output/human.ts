// Pure human-readable leaderboard formatter (the §8 table). Turns area rows +
// summary + warnings into a column-aligned string. No I/O, no raw prose — only
// area keys, counts, scores, and signal display strings appear in the output.

import * as os from 'node:os';
import type { AreaRow, ScoringMode, Warnings } from '../types.js';

/** Inputs to `formatHuman`. */
interface HumanInput {
  repo: string;
  mode: ScoringMode;
  sessionCount: number;
  areas: AreaRow[];
  summary: { flagged: number; unflagged: number; unlocalized: number };
  warnings: Warnings;
}

// Fixed column widths for the leaderboard table.
const AREA_W = 32;
const FLAGGED_W = 8;
const MEAN_W = 11;

// Fixed canonical order + human labels for the warnings line. Zero-count
// categories are omitted from the output.
const WARNING_PARTS: ReadonlyArray<{ key: keyof Warnings; label: string }> = [
  { key: 'malformed_lines', label: 'malformed lines' },
  { key: 'oversized_lines', label: 'oversized lines' },
  { key: 'skipped_sessions', label: 'skipped sessions' },
  { key: 'truncated_sessions', label: 'truncated sessions' },
  { key: 'symlinks_rejected', label: 'symlinks rejected' },
  { key: 'unresolvable_cwd', label: 'unresolvable cwd' },
];

/**
 * Format the scan leaderboard as a human-readable string. Pure.
 *
 * Layout: header line, column-aligned table (or a "no flagged areas" line when
 * empty), summary line, and a warnings line (only non-zero categories). The
 * bootstrap count in the summary line is `sessionCount` when mode is bootstrap,
 * else 0.
 */
export function formatHuman(input: HumanInput): string {
  const { repo, mode, sessionCount, areas, summary, warnings } = input;
  const lines: string[] = [];

  lines.push(
    `harnessgap scan — repo: ${tilde(repo)} · ${sessionCount} sessions · mode: ${mode}`,
  );

  // Only FLAGGED areas get table rows (spec §8). Unflagged areas are noise;
  // the summary line reports their count. When nothing is flagged, print a
  // clear no-flagged-areas line instead of an empty table.
  const flaggedAreas = areas.filter((a) => a.sessions_flagged > 0);
  if (flaggedAreas.length === 0) {
    lines.push('No flagged areas.');
  } else {
    lines.push(tableHeader());
    for (const area of flaggedAreas) {
      lines.push(tableRow(area));
    }
  }

  const bootCount = mode === 'bootstrap' ? sessionCount : 0;
  lines.push(
    `${summary.flagged} areas flagged · ${summary.unflagged} unflagged · ${summary.unlocalized} unlocalized · bootstrap: ${bootCount} sessions`,
  );

  const wLine = warningsLine(warnings);
  if (wLine !== null) lines.push(wLine);

  return lines.join('\n');
}

/** The column-header row, aligned to match the data rows. */
function tableHeader(): string {
  return `${'AREA'.padEnd(AREA_W)} | ${'FLAGGED'.padStart(FLAGGED_W)} | ${'MEAN SCORE'.padStart(MEAN_W)} | TOP SIGNALS`;
}

/** One area row, column-aligned. */
function tableRow(area: AreaRow): string {
  const areaCol = fit(area.key, AREA_W);
  const flaggedCol = String(area.sessions_flagged).padStart(FLAGGED_W);
  const meanCol = area.mean_score.toFixed(1).padStart(MEAN_W);
  const signalsCol = area.top_signals.map((t) => t.display).join(', ');
  return `${areaCol} | ${flaggedCol} | ${meanCol} | ${signalsCol}`;
}

/**
 * Fit a string to `width`: pad with spaces if shorter, truncate with "..." if
 * longer. Keeps the column alignment intact.
 */
function fit(s: string, width: number): string {
  if (s.length <= width) return s.padEnd(width);
  return s.slice(0, width - 3) + '...';
}

/** Replace a `$HOME` prefix with `~` for a shorter, readable repo header. */
function tilde(repo: string): string {
  if (repo === '') return '';
  const home = os.homedir();
  if (home !== '' && repo === home) return '~';
  if (home !== '' && repo.startsWith(home + '/')) return '~' + repo.slice(home.length);
  return repo;
}

/**
 * Build the warnings line as `warnings: <n> <label>, <n> <label>`, omitting any
 * category whose count is 0. Returns null when every category is 0 (line
 * omitted entirely).
 */
function warningsLine(warnings: Warnings): string | null {
  const parts: string[] = [];
  for (const { key, label } of WARNING_PARTS) {
    const count = warnings[key];
    if (count > 0) parts.push(`${count} ${label}`);
  }
  if (parts.length === 0) return null;
  return `warnings: ${parts.join(', ')}`;
}
